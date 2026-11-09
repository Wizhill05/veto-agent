/**
 * Config module with environment variable loader and sensible defaults.
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

// Minimal .env parser without external dependencies
export function loadEnv(envPath = resolve(process.cwd(), '.env')) {
  if (existsSync(envPath)) {
    try {
      const content = readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx !== -1) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    } catch {
      // ignore read errors
    }
  }
}

// Auto load if present
loadEnv();

export const config = {
  mode: process.env.MODE || 'mock', // 'mock' | 'auth0'
  auth0: {
    domain: process.env.AUTH0_DOMAIN || 'mock.auth0.local',
    clientId: process.env.AUTH0_CLIENT_ID || 'mock-client-id',
    clientSecret: process.env.AUTH0_CLIENT_SECRET || 'mock-client-secret',
    audience: process.env.AUTH0_AUDIENCE || '',
    tokenVaultConnection: process.env.AUTH0_TOKEN_VAULT_CONNECTION || 'github',
    userId: process.env.AUTH0_USER_ID || 'github|mock-user-123'
  },
  ciba: {
    userEmail: process.env.CIBA_USER_EMAIL || 'security-officer@example.com',
    userId: process.env.CIBA_USER_ID,
    pollIntervalSeconds: Number(process.env.CIBA_POLL_INTERVAL_SECONDS) || 2,
    timeoutSeconds: Number(process.env.CIBA_TIMEOUT_SECONDS) || 60
  },
  github: {
    defaultRepo: process.env.GITHUB_DEFAULT_REPO || 'owner/repo',
    token: process.env.GITHUB_TOKEN
  },
  mockServer: {
    port: Number(process.env.MOCK_SERVER_PORT) || 4321,
    host: process.env.MOCK_SERVER_HOST || '127.0.0.1'
  }
};
