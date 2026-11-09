import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { VetoAgent } from '../src/veto-agent.js';
import { MockApproverServer } from '../src/mock-server.js';

describe('VetoAgent End-to-End Orchestrator', () => {
  let mockServer;
  let baseUrl;

  before(async () => {
    mockServer = new MockApproverServer({ port: 0 });
    baseUrl = await mockServer.start();
  });

  after(async () => {
    if (mockServer) await mockServer.stop();
  });

  function createTestAgent() {
    return new VetoAgent({
      mode: 'mock',
      config: {
        mockServer: {
          port: mockServer.port,
          host: mockServer.host
        },
        ciba: {
          pollIntervalSeconds: 0.1,
          timeoutSeconds: 3
        },
        github: {
          defaultRepo: 'octocat/veto-agent'
        }
      }
    });
  }

  test('Safe Command: "list repos" executes immediately without CIBA prompt', async () => {
    const agent = createTestAgent();
    const statuses = [];

    const result = await agent.processCommand('list repos', {
      onStatus: (st) => statuses.push(st.step)
    });

    assert.equal(result.success, true);
    assert.match(result.output, /Repositories:/);
    assert.ok(statuses.includes('token_vault'));
    assert.ok(statuses.includes('executing_safe'));
    // CIBA should NOT be initiated for safe commands
    assert.equal(statuses.includes('ciba_init'), false);
  });

  test('Safe Command: "show issues" executes immediately', async () => {
    const agent = createTestAgent();
    const statuses = [];

    const result = await agent.processCommand('show issues', {
      onStatus: (st) => statuses.push(st.step)
    });

    assert.equal(result.success, true);
    assert.match(result.output, /Open issues/);
    assert.equal(statuses.includes('ciba_init'), false);
  });

  test('Sensitive Command: "merge pr 42" triggers CIBA and halts until out-of-band APPROVAL', async () => {
    const agent = createTestAgent();
    const statuses = [];

    // Trigger execution
    const commandPromise = agent.processCommand('merge pr 42', {
      onStatus: (st) => {
        statuses.push(st.step);
        // When CIBA pending is detected, simulate out-of-band human approval
        if (st.step === 'ciba_pending' && st.authReqId) {
          setTimeout(() => {
            mockServer.approve(st.authReqId);
          }, 150);
        }
      }
    });

    const result = await commandPromise;

    assert.equal(result.success, true);
    assert.match(result.output, /MERGED/);
    assert.ok(statuses.includes('ciba_init'));
    assert.ok(statuses.includes('ciba_pending'));
    assert.ok(statuses.includes('ciba_approved'));
  });

  test('Sensitive Command: "delete branch feature/experimental-bypass" halts and is VETOED when user denies', async () => {
    const agent = createTestAgent();
    const statuses = [];

    const commandPromise = agent.processCommand('delete branch feature/experimental-bypass', {
      onStatus: (st) => {
        statuses.push(st.step);
        // When CIBA pending is detected, simulate user clicking DENY in approver UI
        if (st.step === 'ciba_pending' && st.authReqId) {
          setTimeout(() => {
            mockServer.deny(st.authReqId);
          }, 150);
        }
      }
    });

    const result = await commandPromise;

    assert.equal(result.success, false);
    assert.equal(result.vetoed, true);
    assert.match(result.output, /ACTION VETOED OUT-OF-BAND/);
    assert.ok(statuses.includes('ciba_init'));
    assert.ok(statuses.includes('ciba_pending'));
    assert.equal(statuses.includes('ciba_approved'), false);
  });

  test('Sensitive Command: halts and times out if user does not approve in time', async () => {
    const agent = new VetoAgent({
      mode: 'mock',
      config: {
        mockServer: {
          port: mockServer.port,
          host: mockServer.host
        },
        ciba: {
          pollIntervalSeconds: 0.1,
          timeoutSeconds: 0.3 // times out quickly
        }
      }
    });

    const result = await agent.processCommand('close issue 2');

    assert.equal(result.success, false);
    assert.equal(result.vetoed, true);
    assert.match(result.output, /AUTHORIZATION EXPIRED/);
  });

  test('Provides helpful response on unrecognized command', async () => {
    const agent = createTestAgent();
    const result = await agent.processCommand('deploy to production immediately');
    assert.equal(result.success, false);
    assert.match(result.output, /Unrecognized command/);
  });
});
