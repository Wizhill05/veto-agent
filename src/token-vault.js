/**
 * Auth0 Token Vault Client
 *
 * In Auth0, Token Vault enables applications to store and exchange third-party tokens
 * securely without exposing secrets to client apps.
 *
 * Supported mechanisms:
 * 1. Auth0 Token Exchange (RFC 8693) for Token Vault:
 *    POST https://{domain}/oauth/token
 *    grant_type: urn:ietf:params:oauth:grant-type:token-exchange
 *    subject_token: <Auth0 access token or ID token>
 *    subject_token_type: urn:ietf:params:oauth:token-type:access_token
 *    requested_token_type: http://auth0.com/oauth/token-type/federated-connection-access-token
 *    connection: <connection-name (e.g. github)>
 *
 * 2. Auth0 Management API fallback (identity provider access token from user profile):
 *    GET https://{domain}/api/v2/users/{id} -> user.identities[0].access_token
 *
 * 3. Mock Provider for offline / demo mode.
 */

export class TokenVaultClient {
  /**
   * @param {Object} options
   * @param {string} options.domain - Auth0 tenant domain
   * @param {string} options.clientId - Client ID
   * @param {string} options.clientSecret - Client Secret
   * @param {string} options.connection - Connection name (e.g. 'github')
   * @param {boolean} [options.isMock=false] - If true, run in offline mock mode
   * @param {Function} [options.fetchFn=fetch] - Custom fetch for testing
   */
  constructor(options = {}) {
    this.domain = options.domain || 'mock.auth0.local';
    this.clientId = options.clientId || 'mock-client-id';
    this.clientSecret = options.clientSecret || 'mock-client-secret';
    this.connection = options.connection || 'github';
    this.isMock = Boolean(options.isMock);
    this.fetchFn = options.fetchFn || globalThis.fetch;

    // In-memory cache for exchanged tokens
    this._tokenCache = new Map();
  }

  /**
   * Obtains a third-party access token (e.g. GitHub access token) via Auth0 Token Vault.
   *
   * @param {Object} params
   * @param {string} [params.subjectToken] - The agent's Auth0 access or ID token (required for live token exchange)
   * @param {string} [params.userId] - Auth0 User ID (used for Management API fallback or mock lookup)
   * @param {string} [params.connection] - Federated connection name (defaults to client configuration)
   * @param {string[]} [params.scopes] - Optional scopes requested on the third-party service
   * @returns {Promise<{ accessToken: string, tokenType: string, connection: string, expiresIn?: number, expiresAt?: number }>}
   */
  async getThirdPartyToken(params = {}) {
    const connection = params.connection || this.connection;
    const cacheKey = `${connection}:${params.userId || 'default'}`;

    const cached = this._tokenCache.get(cacheKey);
    if (cached && cached.expiresAt && cached.expiresAt > Date.now() + 30000) {
      return cached;
    }

    if (this.isMock) {
      return this._getMockToken(connection, params.userId);
    }

    // Try RFC 8693 Token Exchange against Auth0
    try {
      const token = await this._exchangeToken({
        subjectToken: params.subjectToken,
        connection,
        scopes: params.scopes
      });
      this._tokenCache.set(cacheKey, token);
      return token;
    } catch (exchangeError) {
      // If token exchange fails and a userId is provided, attempt management identity lookup fallback
      if (params.userId && this.clientSecret) {
        const fallbackToken = await this._getManagementIdentityToken(params.userId, connection);
        if (fallbackToken) {
          this._tokenCache.set(cacheKey, fallbackToken);
          return fallbackToken;
        }
      }
      throw new Error(`Token Vault failed to obtain token for connection '${connection}': ${exchangeError.message}`);
    }
  }

  /**
   * RFC 8693 Token Exchange implementation for Auth0 Token Vault
   */
  async _exchangeToken({ subjectToken, connection, scopes }) {
    if (!subjectToken && !this.clientSecret) {
      throw new Error('subjectToken or clientSecret required for token exchange');
    }

    const url = `https://${this.domain}/oauth/token`;
    const bodyParams = {
      grant_type: 'urn:ietf:params:oauth:grant-type:token-exchange',
      client_id: this.clientId,
      requested_token_type: 'http://auth0.com/oauth/token-type/federated-connection-access-token',
      connection: connection
    };

    if (this.clientSecret) {
      bodyParams.client_secret = this.clientSecret;
    }

    if (subjectToken) {
      bodyParams.subject_token = subjectToken;
      bodyParams.subject_token_type = 'urn:ietf:params:oauth:token-type:access_token';
    }

    if (scopes && scopes.length > 0) {
      bodyParams.scope = scopes.join(' ');
    }

    const res = await this.fetchFn(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams(bodyParams).toString()
    });

    if (!res.ok) {
      const errBody = await res.text();
      let parsed;
      try { parsed = JSON.parse(errBody); } catch { parsed = { error: errBody }; }
      throw new Error(parsed.error_description || parsed.error || `HTTP ${res.status}`);
    }

    const data = await res.json();
    return {
      accessToken: data.access_token,
      tokenType: data.token_type || 'Bearer',
      connection,
      expiresIn: data.expires_in,
      expiresAt: data.expires_in ? Date.now() + data.expires_in * 1000 : undefined
    };
  }

  /**
   * Fallback via Auth0 Management API
   */
  async _getManagementIdentityToken(userId, connection) {
    // 1. Get Management API M2M Token
    const mgmtTokenRes = await this.fetchFn(`https://${this.domain}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        audience: `https://${this.domain}/api/v2/`,
        grant_type: 'client_credentials'
      })
    });

    if (!mgmtTokenRes.ok) return null;
    const mgmtData = await mgmtTokenRes.json();
    const mgmtAccessToken = mgmtData.access_token;

    // 2. Fetch User Profile
    const userRes = await this.fetchFn(`https://${this.domain}/api/v2/users/${encodeURIComponent(userId)}`, {
      headers: {
        Authorization: `Bearer ${mgmtAccessToken}`
      }
    });

    if (!userRes.ok) return null;
    const userData = await userRes.json();

    const identity = (userData.identities || []).find(
      (id) => id.connection === connection || id.provider === connection
    );

    if (identity && identity.access_token) {
      return {
        accessToken: identity.access_token,
        tokenType: 'Bearer',
        connection,
        expiresIn: identity.expires_in,
        expiresAt: identity.expires_in ? Date.now() + identity.expires_in * 1000 : undefined
      };
    }

    return null;
  }

  /**
   * Mock Token Vault provider for offline testing and local demo
   */
  _getMockToken(connection, userId) {
    const mockToken = `mock_vault_token_${connection}_${userId || 'usr'}_${Date.now()}`;
    return {
      accessToken: mockToken,
      tokenType: 'Bearer',
      connection,
      expiresIn: 3600,
      expiresAt: Date.now() + 3600 * 1000,
      isMock: true
    };
  }
}
