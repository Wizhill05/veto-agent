import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { CIBAClient, CIBAError } from '../src/ciba.js';
import { MockApproverServer } from '../src/mock-server.js';

describe('CIBA Client and Flow', () => {
  let server;
  let baseUrl;

  before(async () => {
    server = new MockApproverServer({ port: 0 }); // Random free port
    baseUrl = await server.start();
  });

  after(async () => {
    if (server) await server.stop();
  });

  test('initiates CIBA request with binding message', async () => {
    const client = new CIBAClient({
      isMock: true,
      mockServerUrl: baseUrl,
      defaultInterval: 1
    });

    const init = await client.initiate({
      bindingMessage: 'Confirm deletion of branch prod',
      userEmail: 'devops@example.com'
    });

    assert.ok(init.authReqId);
    assert.ok(init.interval >= 1);
    assert.ok(init.expiresIn > 0);

    const pending = server.getPendingRequests();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, init.authReqId);
    assert.equal(pending[0].bindingMessage, 'Confirm deletion of branch prod');
  });

  test('successfully resolves when approved out-of-band', async () => {
    const client = new CIBAClient({
      isMock: true,
      mockServerUrl: baseUrl,
      defaultInterval: 0.1, // rapid polling for fast tests
      defaultTimeout: 5
    });

    const init = await client.initiate({
      bindingMessage: 'Approve PR merge #55'
    });

    // Simulate human approving out-of-band after 150ms
    setTimeout(() => {
      server.approve(init.authReqId);
    }, 150);

    const result = await client.waitForApproval({
      authReqId: init.authReqId,
      interval: 0.1
    });

    assert.equal(result.approved, true);
    assert.ok(result.tokenData.access_token);
  });

  test('throws CIBAError(access_denied) when vetoed/denied out-of-band', async () => {
    const client = new CIBAClient({
      isMock: true,
      mockServerUrl: baseUrl,
      defaultInterval: 0.1,
      defaultTimeout: 5
    });

    const init = await client.initiate({
      bindingMessage: 'Critical delete branch main'
    });

    // Simulate human explicitly hitting VETO (deny)
    setTimeout(() => {
      server.deny(init.authReqId);
    }, 150);

    await assert.rejects(
      async () => {
        await client.waitForApproval({
          authReqId: init.authReqId,
          interval: 0.1
        });
      },
      (err) => {
        assert.ok(err instanceof CIBAError);
        assert.equal(err.code, 'access_denied');
        assert.match(err.message, /VETOED/i);
        return true;
      }
    );
  });

  test('handles slow_down response and backs off polling', async () => {
    const client = new CIBAClient({
      isMock: true,
      mockServerUrl: baseUrl,
      defaultInterval: 0.1,
      defaultTimeout: 10
    });

    const init = await client.initiate({
      bindingMessage: 'Test slow down handler'
    });

    // Trigger slow_down on the mock server
    server.triggerSlowDown(init.authReqId);

    // After slow_down is consumed, approve it
    setTimeout(() => {
      server.approve(init.authReqId);
    }, 400);

    const result = await client.waitForApproval({
      authReqId: init.authReqId,
      interval: 0.1
    });

    assert.equal(result.approved, true);
  });

  test('throws timeout when request expires before approval', async () => {
    const client = new CIBAClient({
      isMock: true,
      mockServerUrl: baseUrl,
      defaultInterval: 0.1,
      defaultTimeout: 0.4 // times out in 400ms
    });

    const init = await client.initiate({
      bindingMessage: 'Will time out'
    });

    await assert.rejects(
      async () => {
        await client.waitForApproval({
          authReqId: init.authReqId,
          interval: 0.1,
          timeout: 0.4
        });
      },
      (err) => {
        assert.ok(err instanceof CIBAError);
        assert.equal(err.code, 'timeout');
        return true;
      }
    );
  });

  test('throws expired_token when server marks authorization expired', async () => {
    const client = new CIBAClient({
      isMock: true,
      mockServerUrl: baseUrl,
      defaultInterval: 0.1,
      defaultTimeout: 5
    });

    const init = await client.initiate({
      bindingMessage: 'Immediate expiry'
    });

    setTimeout(() => {
      server.expire(init.authReqId);
    }, 150);

    await assert.rejects(
      async () => {
        await client.waitForApproval({
          authReqId: init.authReqId,
          interval: 0.1
        });
      },
      (err) => {
        assert.ok(err instanceof CIBAError);
        assert.equal(err.code, 'expired_token');
        return true;
      }
    );
  });
});
