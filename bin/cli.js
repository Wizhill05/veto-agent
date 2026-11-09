#!/usr/bin/env node

/**
 * Interactive CLI Chat Agent for Veto Agent
 */

import * as readline from 'node:readline';
import { VetoAgent } from '../src/veto-agent.js';
import { MockApproverServer } from '../src/mock-server.js';
import { config } from '../src/config.js';

let mockServer = null;

async function init() {
  const mode = process.env.MODE || config.mode || 'mock';

  console.log(`\n======================================================`);
  console.log(`🤖 Welcome to the VETO AGENT`);
  console.log(`   (Auth0 Token Vault & Out-of-Band CIBA Authorization)`);
  console.log(`======================================================`);
  console.log(`Mode: [${mode.toUpperCase()}]`);

  if (mode === 'mock') {
    mockServer = new MockApproverServer({
      port: config.mockServer.port,
      host: config.mockServer.host,
      defaultInterval: config.ciba.pollIntervalSeconds
    });
    try {
      const baseUrl = await mockServer.start();
      console.log(`📡 Mock CIBA Approver active at: ${baseUrl}/ui`);
      console.log(`   (Open that URL in your browser to approve or deny requests out-of-band!)`);
    } catch (e) {
      if (e.code === 'EADDRINUSE') {
        console.log(`📡 Mock CIBA Approver already running on port ${config.mockServer.port}`);
      } else {
        console.error('Failed to start mock server:', e);
      }
    }
  } else {
    console.log(`Connected to Auth0 tenant: ${config.auth0.domain}`);
  }

  const agent = new VetoAgent({
    mode,
    config
  });

  console.log(`\nType 'help' to view commands or 'exit' to quit.\n`);

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: '\x1b[36mveto-agent>\x1b[0m '
  });

  rl.prompt();

  rl.on('line', async (line) => {
    const text = line.trim();
    if (!text) {
      rl.prompt();
      return;
    }

    if (text.toLowerCase() === 'exit' || text.toLowerCase() === 'quit') {
      console.log('Shutting down Veto Agent. Goodbye!');
      if (mockServer) await mockServer.stop();
      process.exit(0);
    }

    try {
      const res = await agent.processCommand(text, {
        onStatus: (st) => {
          if (st.step === 'token_vault') {
            console.log(`\x1b[34m[Token Vault]\x1b[0m ${st.message}`);
          } else if (st.step === 'ciba_init') {
            console.log(`\n\x1b[33m[CIBA Triggered]\x1b[0m ${st.message}`);
          } else if (st.step === 'ciba_poll') {
            process.stdout.write(`\r\x1b[33m[Polling CIBA]\x1b[0m Attempt #${st.attempt} (${st.elapsedSeconds}s) - Waiting for approval at http://${config.mockServer.host}:${config.mockServer.port}/ui ...`);
          } else if (st.step === 'ciba_approved') {
            console.log(`\n\x1b[32m[CIBA Approved]\x1b[0m ${st.message}`);
          }
        }
      });

      console.log(`\n${res.output}\n`);
    } catch (err) {
      console.error(`\x1b[31mError:\x1b[0m ${err.message}\n`);
    }

    rl.prompt();
  });

  rl.on('close', async () => {
    if (mockServer) await mockServer.stop();
    process.exit(0);
  });
}

init().catch(console.error);
