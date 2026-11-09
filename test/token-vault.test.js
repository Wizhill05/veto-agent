import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TokenVaultClient } from '../src/token-vault.js';

describe('TokenVaultClient', () => {
  test('returns mock token when in mock mode', async () => {
    const client = new TokenVaultClient({ isMock: true, connection: 'github' });
    const token = await client.getThirdPartyToken({ userId: 'auth0|user1' });

    assert.ok(token);
    assert.equal(token.tokenType, 'Bearer');
    assert.equal(token.connection, 'github');
    assert.match(token.accessToken, /^mock_vault_token_github_/);
    assert.equal(token.isMock, true);
  });

  test('caches exchanged tokens until expiry', async () => {
    const client = new TokenVaultClient({ isMock: true, connection: 'github' });
    const t1 = await client.getThirdPartyToken({ userId: 'userA' });
    const t2 = await client.getThirdPartyToken({ userId: 'userA' });

    assert.equal(t1.accessToken, t2.accessToken);
  });

  test('performs RFC 8693 token exchange against live endpoint or mock fetch', async () => {
    let calledUrl = '';
    let calledBody = '';

    const mockFetch = async (url, opts) => {
      calledUrl = url;
      calledBody = opts.body;
      return {
        ok: true,
        json: async () => ({
          access_token: 'ghp_realExchangedToken12345',
          token_type: 'Bearer',
          expires_in: 3600
        })
      };
    };

    const client = new TokenVaultClient({
      domain: 'test-tenant.us.auth0.com',
      clientId: 'cid123',
      clientSecret: 'secret456',
      connection: 'github',
      isMock: false,
      fetchFn: mockFetch
    });

    const token = await client.getThirdPartyToken({
      subjectToken: 'agent_access_token'
    });

    assert.equal(token.accessToken, 'ghp_realExchangedToken12345');
    assert.equal(calledUrl, 'https://test-tenant.us.auth0.com/oauth/token');
    assert.match(calledBody, /grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Atoken-exchange/);
    assert.match(calledBody, /connection=github/);
    assert.match(calledBody, /subject_token=agent_access_token/);
  });

  test('falls back to Management API identity lookup when token exchange fails and userId is provided', async () => {
    const calls = [];
    const mockFetch = async (url, opts) => {
      calls.push({ url, opts });
      // First call: token exchange fails
      if (url.endsWith('/oauth/token') && opts?.body?.includes('token-exchange')) {
        return {
          ok: false,
          status: 400,
          text: async () => JSON.stringify({ error: 'invalid_grant', error_description: 'Exchange disabled' })
        };
      }
      // Second call: M2M token request for management API
      if (url.endsWith('/oauth/token') && opts?.body?.includes('client_credentials')) {
        return {
          ok: true,
          json: async () => ({ access_token: 'mgmt_token_999' })
        };
      }
      // Third call: user profile fetch
      if (url.includes('/api/v2/users/')) {
        return {
          ok: true,
          json: async () => ({
            user_id: 'oauth2|github|789',
            identities: [
              { connection: 'github', access_token: 'gho_from_identity_profile_abc', expires_in: 28800 }
            ]
          })
        };
      }
      return { ok: false, status: 404, text: async () => 'Not found' };
    };

    const client = new TokenVaultClient({
      domain: 'test-tenant.us.auth0.com',
      clientId: 'cid123',
      clientSecret: 'secret456',
      connection: 'github',
      isMock: false,
      fetchFn: mockFetch
    });

    const token = await client.getThirdPartyToken({
      userId: 'oauth2|github|789'
    });

    assert.equal(token.accessToken, 'gho_from_identity_profile_abc');
    assert.equal(token.connection, 'github');
  });
});
