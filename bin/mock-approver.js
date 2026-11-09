#!/usr/bin/env node

/**
 * Standalone Mock Approver Console Runner
 */

import { MockApproverServer } from '../src/mock-server.js';
import { config } from '../src/config.js';

const server = new MockApproverServer({
  port: config.mockServer.port,
  host: config.mockServer.host,
  defaultInterval: config.ciba.pollIntervalSeconds
});

const baseUrl = await server.start();
console.log(`\n======================================================`);
console.log(`🛡️  Veto Agent: Mock Out-of-Band Approver Server Active`);
console.log(`======================================================`);
console.log(`Web UI:           ${baseUrl}/ui`);
console.log(`Pending Requests: ${baseUrl}/pending`);
console.log(`Approve Hook:     POST ${baseUrl}/approve/:id`);
console.log(`Deny/Veto Hook:   POST ${baseUrl}/deny/:id`);
console.log(`\nPress Ctrl+C to stop.`);

process.on('SIGINT', async () => {
  console.log('\nStopping approver server...');
  await server.stop();
  process.exit(0);
});
