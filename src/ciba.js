/**
 * Auth0 Asynchronous Authorization Client (CIBA / Client Initiated Backchannel Authentication)
 *
 * Implements OpenID Connect Client-Initiated Backchannel Authentication (CIBA) Flow.
 *
 * Steps:
 * 1. POST /bc-authorize (or Auth0 equivalent backchannel authorization endpoint):
 *    - client_id, client_secret
 *    - binding_message: human-readable explanation shown on user's authenticator (e.g. Auth0 Guardian / mobile app)
 *    - login_hint or user identifier
 *    - scope: e.g. 'openid profile offline_access'
 *    Returns: { auth_req_id, expires_in, interval }
 *
 * 2. Poll POST /oauth/token:
 *    - grant_type: 'urn:openid:params:grant-type:ciba'
 *    - client_id, client_secret
 *    - auth_req_id
 *    Responses handled:
 *    - 200 OK -> { access_token, id_token, token_type } (Approved)
 *    - 400 Bad Request:
 *      * error: 'authorization_pending' -> Wait interval seconds and poll again
 *      * error: 'slow_down' -> Increase interval by 5s and poll again
 *      * error: 'access_denied' -> User explicitly vetoed/rejected the request
 *      * error: 'expired_token' -> Request expired before user responded
 */

export class CIBAError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'CIBAError';
    this.code = code;
    this.details = details;
  }
}

export class CIBAClient {
  /**
   * @param {Object} options
   * @param {string} options.domain - Auth0 tenant domain or mock server base URL
   * @param {string} options.clientId - Client ID
   * @param {string} [options.clientSecret] - Client Secret
   * @param {string} [options.audience] - Target API audience
   * @param {number} [options.defaultInterval=2] - Default polling interval in seconds
   * @param {number} [options.defaultTimeout=60] - Default timeout in seconds
   * @param {boolean} [options.isMock=false] - Whether running against offline mock
   * @param {string} [options.mockServerUrl] - Custom mock server URL if mock mode
   * @param {Function} [options.fetchFn=fetch] - Custom fetch for testing
   */
  constructor(options = {}) {
    this.domain = options.domain || 'mock.auth0.local';
    this.clientId = options.clientId || 'mock-client-id';
    this.clientSecret = options.clientSecret || 'mock-client-secret';
    this.audience = options.audience;
    this.defaultInterval = options.defaultInterval || 2;
    this.defaultTimeout = options.defaultTimeout || 60;
    this.isMock = Boolean(options.isMock);
    this.mockServerUrl = options.mockServerUrl;
    this.fetchFn = options.fetchFn || globalThis.fetch;
  }

  _getBaseUrl() {
    if (this.isMock && this.mockServerUrl) {
      return this.mockServerUrl.replace(/\/$/, '');
    }
    const cleanDomain = this.domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
    return `https://${cleanDomain}`;
  }

  /**
   * Initiates backchannel authorization request.
   *
   * @param {Object} params
   * @param {string} params.bindingMessage - Message explaining the sensitive action
   * @param {string} [params.userEmail] - User's email (login_hint)
   * @param {string} [params.userId] - User's ID
   * @param {string} [params.scope='openid'] - Requested scope
   * @param {Record<string, any>} [params.actionMetadata] - Additional metadata for the consent prompt
   * @returns {Promise<{ authReqId: string, expiresIn: number, interval: number }>}
   */
  async initiate({ bindingMessage, userEmail, userId, scope = 'openid', actionMetadata = {} }) {
    if (!bindingMessage) {
      throw new Error('bindingMessage is required for CIBA authorization');
    }

    const baseUrl = this._getBaseUrl();
    const url = `${baseUrl}/bc-authorize`;

    const bodyParams = {
      client_id: this.clientId,
      scope: scope,
      binding_message: bindingMessage
    };

    if (this.clientSecret) {
      bodyParams.client_secret = this.clientSecret;
    }

    if (userEmail) {
      bodyParams.login_hint = JSON.stringify({ email: userEmail });
    } else if (userId) {
      bodyParams.login_hint = JSON.stringify({ sub: userId });
    }

    if (this.audience) {
      bodyParams.audience = this.audience;
    }

    if (Object.keys(actionMetadata).length > 0) {
      bodyParams.binding_data = JSON.stringify(actionMetadata);
    }

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(bodyParams).toString()
    });

    if (!res.ok) {
      const errText = await res.text();
      let parsed;
      try { parsed = JSON.parse(errText); } catch { parsed = { error: errText }; }
      throw new CIBAError(
        parsed.error_description || parsed.error || `Failed to initiate CIBA: HTTP ${res.status}`,
        parsed.error || 'initiate_failed',
        parsed
      );
    }

    const data = await res.json();
    return {
      authReqId: data.auth_req_id,
      expiresIn: data.expires_in || 120,
      interval: data.interval || this.defaultInterval
    };
  }

  /**
   * Polls the token endpoint until the user approves, denies, or the request times out.
   *
   * @param {Object} params
   * @param {string} params.authReqId - The ID returned from initiate()
   * @param {number} [params.interval] - Polling interval in seconds
   * @param {number} [params.timeout] - Maximum waiting time in seconds
   * @param {Function} [params.onPoll] - Callback fired on every poll attempt
   * @returns {Promise<{ approved: boolean, tokenData: Object }>}
   */
  async waitForApproval({ authReqId, interval, timeout, onPoll }) {
    let currentInterval = (interval || this.defaultInterval) * 1000;
    const maxTimeout = (timeout || this.defaultTimeout) * 1000;
    const startTime = Date.now();
    const baseUrl = this._getBaseUrl();
    const tokenUrl = `${baseUrl}/oauth/token`;

    let attempt = 0;

    while (Date.now() - startTime < maxTimeout) {
      attempt++;
      if (onPoll) {
        onPoll({
          attempt,
          elapsedSeconds: Math.round((Date.now() - startTime) / 1000),
          intervalSeconds: currentInterval / 1000
        });
      }

      const bodyParams = {
        grant_type: 'urn:openid:params:grant-type:ciba',
        client_id: this.clientId,
        auth_req_id: authReqId
      };

      if (this.clientSecret) {
        bodyParams.client_secret = this.clientSecret;
      }

      let res;
      try {
        res = await this.fetchFn(tokenUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          },
          body: new URLSearchParams(bodyParams).toString()
        });
      } catch (networkErr) {
        throw new CIBAError(`Network error while polling CIBA token: ${networkErr.message}`, 'network_error');
      }

      if (res.ok) {
        const tokenData = await res.json();
        return {
          approved: true,
          tokenData
        };
      }

      const errText = await res.text();
      let errPayload;
      try {
        errPayload = JSON.parse(errText);
      } catch {
        errPayload = { error: 'unknown_error', error_description: errText };
      }

      const errorCode = errPayload.error;

      switch (errorCode) {
        case 'authorization_pending':
          // Standard CIBA status: waiting for out-of-band user interaction
          await this._sleep(currentInterval);
          break;

        case 'slow_down':
          // Standard CIBA instruction: increase polling interval by 5 seconds
          currentInterval += 5000;
          await this._sleep(currentInterval);
          break;

        case 'access_denied':
          // User explicitly vetoed the sensitive action!
          throw new CIBAError(
            'User denied the authorization request (VETOED out-of-band)',
            'access_denied',
            errPayload
          );

        case 'expired_token':
          // Out-of-band request expired before consent
          throw new CIBAError(
            'The authorization request expired before the user responded',
            'expired_token',
            errPayload
          );

        default:
          throw new CIBAError(
            errPayload.error_description || `CIBA polling error: ${errorCode}`,
            errorCode,
            errPayload
          );
      }
    }

    throw new CIBAError(
      `CIBA authorization timed out after ${timeout || this.defaultTimeout} seconds`,
      'timeout'
    );
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
