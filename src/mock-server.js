/**
 * Mock Approver Server
 *
 * Runs a lightweight local HTTP server simulating Auth0 CIBA and Token Vault endpoints:
 *
 * 1. POST /bc-authorize
 *    Creates an authorization request with status 'pending'.
 *    Returns { auth_req_id, expires_in, interval }
 *
 * 2. POST /oauth/token
 *    - grant_type: 'urn:openid:params:grant-type:ciba'
 *      Checks the request status for auth_req_id:
 *      * 'pending' -> 400 { error: 'authorization_pending' }
 *      * 'slow_down' -> 400 { error: 'slow_down' }
 *      * 'approved' -> 200 { access_token, id_token, token_type: 'Bearer' }
 *      * 'denied' -> 400 { error: 'access_denied', error_description: 'Vetoed by security officer' }
 *      * 'expired' -> 400 { error: 'expired_token', error_description: 'Request timed out' }
 *    - grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange'
 *      Simulates Auth0 Token Vault token exchange.
 *
 * 3. Out-Of-Band Management Endpoints (for the user/human approver):
 *    - GET /pending
 *      Lists all requests pending human approval.
 *    - POST /approve/:id
 *      Approves request :id out-of-band.
 *    - POST /deny/:id
 *      Vetoes request :id out-of-band.
 *    - POST /expire/:id
 *      Marks request :id as expired (for timeout tests).
 *    - POST /slow_down/:id
 *      Marks request :id to return slow_down on next check.
 *    - GET /ui
 *      A lightweight HTML page allowing one-click approve/deny from any browser.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

export class MockApproverServer {
  /**
   * @param {Object} [options]
   * @param {number} [options.port=4321]
   * @param {string} [options.host='127.0.0.1']
   * @param {number} [options.defaultInterval=2]
   * @param {number} [options.defaultExpiresIn=120]
   */
  constructor(options = {}) {
    this.port = options.port !== undefined ? options.port : 4321;
    this.host = options.host || '127.0.0.1';
    this.defaultInterval = options.defaultInterval || 2;
    this.defaultExpiresIn = options.defaultExpiresIn || 120;

    /** @type {Map<string, { id: string, bindingMessage: string, client_id: string, status: 'pending'|'approved'|'denied'|'expired'|'slow_down', createdAt: number, expiresAt: number }>} */
    this.requests = new Map();
    this.server = null;
    this.autoApproveAfterMs = options.autoApproveAfterMs || null;
    this.autoDenyAfterMs = options.autoDenyAfterMs || null;
  }

  /**
   * Starts HTTP server
   * @returns {Promise<string>} Base URL of running server
   */
  async start() {
    return new Promise((resolve, reject) => {
      this.server = createServer((req, res) => this._handleRequest(req, res));
      this.server.on('error', reject);
      this.server.listen(this.port, this.host, () => {
        const addr = this.server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.port;
        this.port = actualPort;
        this.baseUrl = `http://${this.host}:${actualPort}`;
        resolve(this.baseUrl);
      });
    });
  }

  /**
   * Stops HTTP server
   */
  async stop() {
    return new Promise((resolve) => {
      if (this.server) {
        this.server.close(() => resolve());
      } else {
        resolve();
      }
    });
  }

  // --- Out-of-band programmatic controls for testing and demo ---

  approve(authReqId) {
    const req = this.requests.get(authReqId);
    if (!req) return false;
    req.status = 'approved';
    return true;
  }

  deny(authReqId) {
    const req = this.requests.get(authReqId);
    if (!req) return false;
    req.status = 'denied';
    return true;
  }

  expire(authReqId) {
    const req = this.requests.get(authReqId);
    if (!req) return false;
    req.status = 'expired';
    return true;
  }

  triggerSlowDown(authReqId) {
    const req = this.requests.get(authReqId);
    if (!req) return false;
    req.status = 'slow_down';
    return true;
  }

  getPendingRequests() {
    return Array.from(this.requests.values()).filter((r) => r.status === 'pending');
  }

  // --- Internal HTTP Handler ---

  async _handleRequest(req, res) {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const method = req.method;

    // CORS & JSON helpers
    const sendJson = (status, data) => {
      res.writeHead(status, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(JSON.stringify(data));
    };

    const sendHtml = (html) => {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
    };

    if (method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization'
      });
      return res.end();
    }

    // Read body helper
    const readBody = async () => {
      let data = '';
      for await (const chunk of req) {
        data += chunk;
      }
      const contentType = req.headers['content-type'] || '';
      if (contentType.includes('application/x-www-form-urlencoded')) {
        const params = new URLSearchParams(data);
        const obj = {};
        for (const [k, v] of params.entries()) obj[k] = v;
        return obj;
      }
      if (contentType.includes('application/json')) {
        try { return JSON.parse(data); } catch { return {}; }
      }
      return {};
    };

    // 1. CIBA Authorization Initiation: POST /bc-authorize
    if (method === 'POST' && url.pathname === '/bc-authorize') {
      const body = await readBody();
      const authReqId = `ciba_req_${randomUUID().slice(0, 8)}`;
      const item = {
        id: authReqId,
        bindingMessage: body.binding_message || 'Authorization requested by Veto Agent',
        clientId: body.client_id,
        loginHint: body.login_hint,
        scope: body.scope,
        status: 'pending',
        createdAt: Date.now(),
        expiresAt: Date.now() + this.defaultExpiresIn * 1000
      };

      this.requests.set(authReqId, item);

      // Auto-approve or auto-deny timers if configured for testing
      if (this.autoApproveAfterMs) {
        setTimeout(() => { item.status = 'approved'; }, this.autoApproveAfterMs);
      } else if (this.autoDenyAfterMs) {
        setTimeout(() => { item.status = 'denied'; }, this.autoDenyAfterMs);
      }

      return sendJson(200, {
        auth_req_id: authReqId,
        expires_in: this.defaultExpiresIn,
        interval: this.defaultInterval
      });
    }

    // 2. Token Endpoint: POST /oauth/token
    if (method === 'POST' && url.pathname === '/oauth/token') {
      const body = await readBody();

      // Case A: CIBA Grant
      if (body.grant_type === 'urn:openid:params:grant-type:ciba') {
        const item = this.requests.get(body.auth_req_id);
        if (!item) {
          return sendJson(400, {
            error: 'invalid_grant',
            error_description: 'auth_req_id not found or invalid'
          });
        }

        if (Date.now() > item.expiresAt || item.status === 'expired') {
          return sendJson(400, {
            error: 'expired_token',
            error_description: 'The authorization request has expired'
          });
        }

        if (item.status === 'pending') {
          return sendJson(400, {
            error: 'authorization_pending',
            error_description: 'The end-user authorization is still pending'
          });
        }

        if (item.status === 'slow_down') {
          // Reset to pending after issuing slow_down once
          item.status = 'pending';
          return sendJson(400, {
            error: 'slow_down',
            error_description: 'Please slow down polling requests'
          });
        }

        if (item.status === 'denied') {
          return sendJson(400, {
            error: 'access_denied',
            error_description: 'The end-user explicitly denied the authorization request'
          });
        }

        if (item.status === 'approved') {
          return sendJson(200, {
            access_token: `mock_ciba_access_token_${randomUUID().slice(0, 10)}`,
            id_token: `mock_ciba_id_token_${randomUUID().slice(0, 10)}`,
            token_type: 'Bearer',
            expires_in: 3600
          });
        }
      }

      // Case B: Token Vault RFC 8693 Token Exchange
      if (body.grant_type === 'urn:ietf:params:oauth:grant-type:token-exchange') {
        const connection = body.connection || 'github';
        return sendJson(200, {
          access_token: `mock_vault_token_${connection}_${randomUUID().slice(0, 8)}`,
          issued_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
          token_type: 'Bearer',
          expires_in: 3600
        });
      }

      return sendJson(400, { error: 'unsupported_grant_type' });
    }

    // 3. Out-Of-Band Approver Endpoints
    if (url.pathname === '/pending' && method === 'GET') {
      return sendJson(200, {
        pending: this.getPendingRequests()
      });
    }

    const approveMatch = url.pathname.match(/^\/approve\/([^/]+)$/);
    if (approveMatch && (method === 'POST' || method === 'GET')) {
      const id = approveMatch[1];
      const ok = this.approve(id);
      if (ok) {
        if (req.headers.accept?.includes('text/html')) {
          return sendHtml(`<h3>[APPROVED]</h3><p>Request <code>${id}</code> was APPROVED out-of-band.</p><p><a href="/ui">&larr; Back to Approver UI</a></p>`);
        }
        return sendJson(200, { success: true, id, status: 'approved' });
      }
      return sendJson(404, { error: 'Request not found' });
    }

    const denyMatch = url.pathname.match(/^\/deny\/([^/]+)$/);
    if (denyMatch && (method === 'POST' || method === 'GET')) {
      const id = denyMatch[1];
      const ok = this.deny(id);
      if (ok) {
        if (req.headers.accept?.includes('text/html')) {
          return sendHtml(`<h3>[VETOED / DENIED]</h3><p>Request <code>${id}</code> was DENIED out-of-band.</p><p><a href="/ui">&larr; Back to Approver UI</a></p>`);
        }
        return sendJson(200, { success: true, id, status: 'denied' });
      }
      return sendJson(404, { error: 'Request not found' });
    }

    const expireMatch = url.pathname.match(/^\/expire\/([^/]+)$/);
    if (expireMatch && (method === 'POST' || method === 'GET')) {
      const id = expireMatch[1];
      const ok = this.expire(id);
      if (ok) return sendJson(200, { success: true, id, status: 'expired' });
      return sendJson(404, { error: 'Request not found' });
    }

    const slowDownMatch = url.pathname.match(/^\/slow_down\/([^/]+)$/);
    if (slowDownMatch && (method === 'POST' || method === 'GET')) {
      const id = slowDownMatch[1];
      const ok = this.triggerSlowDown(id);
      if (ok) return sendJson(200, { success: true, id, status: 'slow_down' });
      return sendJson(404, { error: 'Request not found' });
    }

    // 4. Web UI for Out-of-band manual interaction in demo
    if (url.pathname === '/ui' || url.pathname === '/') {
      const pending = this.getPendingRequests();
      const listHtml = pending.length === 0
        ? '<p style="color:#666;">No pending authorization requests. The agent is idle or running safe commands.</p>'
        : pending.map((p) => `
            <div style="border:1px solid #dc2626; border-radius:8px; padding:16px; margin-bottom:16px; background:#fef2f2;">
              <h4 style="margin:0 0 8px 0; color:#991b1b;">High-Impact Action Pending Approval</h4>
              <p><strong>Request ID:</strong> <code>${p.id}</code></p>
              <p><strong>Binding Message:</strong></p>
              <blockquote style="background:#fff; border-left:4px solid #ef4444; margin:8px 0; padding:8px 12px; font-family:monospace;">
                ${p.bindingMessage}
              </blockquote>
              <div style="margin-top:12px;">
                <a href="/approve/${p.id}" style="background:#16a34a; color:#fff; padding:8px 16px; border-radius:4px; text-decoration:none; font-weight:bold; margin-right:12px;">Approve Action</a>
                <a href="/deny/${p.id}" style="background:#dc2626; color:#fff; padding:8px 16px; border-radius:4px; text-decoration:none; font-weight:bold;">VETO (Deny)</a>
              </div>
            </div>
          `).join('');

      return sendHtml(`
        <!DOCTYPE html>
        <html>
        <head>
          <title>Veto Agent - Out-of-Band Approver</title>
          <meta http-equiv="refresh" content="2">
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; max-width: 720px; margin: 40px auto; padding: 0 20px; line-height: 1.5; color: #1e293b; }
            header { border-bottom: 2px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 24px; }
            h1 { margin: 0; color: #0f172a; font-size: 24px; }
            .subtitle { color: #64748b; font-size: 14px; margin-top: 4px; }
          </style>
        </head>
        <body>
          <header>
            <h1>🛡️ Veto Agent - Out-of-Band Approver Console</h1>
            <div class="subtitle">Simulating Auth0 Guardian / Mobile Authenticator for CIBA Backchannel Authorization</div>
          </header>
          <p>This console polls every 2 seconds. When the CLI agent pauses on a sensitive operation (e.g. branch deletion, PR merge), it will show up below for decision.</p>
          ${listHtml}
        </body>
        </html>
      `);
    }

    sendJson(404, { error: 'Not found' });
  }
}
