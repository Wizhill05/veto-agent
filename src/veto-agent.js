/**
 * Veto Agent Orchestrator
 *
 * Coordinates:
 * 1. Intent recognition (CommandRouter)
 * 2. Token Vault client for securely accessing third-party credentials (GitHub)
 * 3. CIBA client for out-of-band authorization when high-impact actions are detected
 * 4. GitHub REST service execution
 */

import { CommandRouter, IMPACT_LEVELS } from './command-router.js';
import { TokenVaultClient } from './token-vault.js';
import { CIBAClient, CIBAError } from './ciba.js';
import { GitHubService } from './github-service.js';

export class VetoAgent {
  /**
   * @param {Object} options
   * @param {string} [options.mode='mock'] - 'mock' | 'auth0'
   * @param {Object} [options.config] - Global configuration object
   * @param {Function} [options.logFn=console.log] - Logger
   * @param {Function} [options.fetchFn=fetch] - Custom fetch
   */
  constructor(options = {}) {
    this.mode = options.mode || 'mock';
    this.isMock = this.mode === 'mock';
    this.config = options.config || {};
    this.log = options.logFn || console.log;
    this.fetchFn = options.fetchFn || globalThis.fetch;

    const auth0Cfg = this.config.auth0 || {};
    const cibaCfg = this.config.ciba || {};
    const ghCfg = this.config.github || {};
    const mockCfg = this.config.mockServer || {};

    this.router = new CommandRouter(ghCfg.defaultRepo || 'octocat/veto-agent');

    this.tokenVault = new TokenVaultClient({
      domain: auth0Cfg.domain,
      clientId: auth0Cfg.clientId,
      clientSecret: auth0Cfg.clientSecret,
      connection: auth0Cfg.tokenVaultConnection || 'github',
      isMock: this.isMock,
      fetchFn: this.fetchFn
    });

    this.ciba = new CIBAClient({
      domain: auth0Cfg.domain,
      clientId: auth0Cfg.clientId,
      clientSecret: auth0Cfg.clientSecret,
      audience: auth0Cfg.audience,
      defaultInterval: cibaCfg.pollIntervalSeconds || 2,
      defaultTimeout: cibaCfg.timeoutSeconds || 60,
      isMock: this.isMock,
      mockServerUrl: `http://${mockCfg.host || '127.0.0.1'}:${mockCfg.port || 4321}`,
      fetchFn: this.fetchFn
    });

    this.github = new GitHubService({
      accessToken: ghCfg.token,
      fetchFn: this.fetchFn
    });

    this.cibaUserEmail = cibaCfg.userEmail;
    this.cibaUserId = cibaCfg.userId;
    this.auth0UserId = auth0Cfg.userId;
  }

  /**
   * Ensures the GitHub service has a valid token via Auth0 Token Vault
   */
  async ensureThirdPartyToken() {
    if (!this.github.accessToken) {
      const tokenResult = await this.tokenVault.getThirdPartyToken({
        userId: this.auth0UserId,
        connection: this.tokenVault.connection
      });
      this.github.setAccessToken(tokenResult.accessToken);
    }
  }

  /**
   * Main entry point to process a natural command.
   *
   * @param {string} input - User command
   * @param {Object} [callbacks] - Optional UI hooks
   * @param {Function} [callbacks.onStatus] - Called when state changes (e.g. CIBA initiated, polling)
   * @returns {Promise<{ success: boolean, output: string, data?: any, vetoed?: boolean }>}
   */
  async processCommand(input, callbacks = {}) {
    const onStatus = callbacks.onStatus || (() => {});
    const route = this.router.route(input);

    if (!route) {
      if (/^(?:help|\?)$/i.test(input.trim())) {
        return {
          success: true,
          output: this.router.getHelp()
        };
      }
      return {
        success: false,
        output: `Unrecognized command: "${input}". Type 'help' to view available commands.`
      };
    }

    // Step 1: Ensure we have the GitHub token from Auth0 Token Vault
    onStatus({ step: 'token_vault', message: 'Retrieving third-party token via Auth0 Token Vault...' });
    await this.ensureThirdPartyToken();

    // Step 2: Check Impact Level
    if (route.impact === IMPACT_LEVELS.SAFE) {
      onStatus({ step: 'executing_safe', message: `Executing safe command: ${route.command}` });
      return await this._executeCommand(route);
    }

    // Step 3: High-Impact Action: Mandate CIBA Asynchronous Authorization
    onStatus({
      step: 'ciba_init',
      message: `HIGH-IMPACT ACTION DETECTED: Mandating out-of-band authorization via CIBA...\nBinding Message: "${route.bindingMessage}"`
    });

    try {
      const authReq = await this.ciba.initiate({
        bindingMessage: route.bindingMessage,
        userEmail: this.cibaUserEmail,
        userId: this.cibaUserId,
        actionMetadata: {
          command: route.command,
          params: route.params
        }
      });

      const pollInterval = this.config.ciba?.pollIntervalSeconds || authReq.interval;

      onStatus({
        step: 'ciba_pending',
        authReqId: authReq.authReqId,
        message: `CIBA request created (${authReq.authReqId}). Polling out-of-band approval (interval: ${pollInterval}s)...`
      });

      const approval = await this.ciba.waitForApproval({
        authReqId: authReq.authReqId,
        interval: pollInterval,
        timeout: this.config.ciba?.timeoutSeconds || 60,
        onPoll: (info) => {
          onStatus({
            step: 'ciba_poll',
            authReqId: authReq.authReqId,
            attempt: info.attempt,
            elapsedSeconds: info.elapsedSeconds,
            message: `[Poll #${info.attempt}] Waiting for out-of-band user approval (${info.elapsedSeconds}s elapsed)...`
          });
        }
      });

      if (approval.approved) {
        onStatus({
          step: 'ciba_approved',
          message: 'Out-of-band approval GRANTED by user! Proceeding with high-impact execution.'
        });
        return await this._executeCommand(route);
      }
    } catch (err) {
      if (err instanceof CIBAError) {
        if (err.code === 'access_denied') {
          return {
            success: false,
            vetoed: true,
            output: `🚫 ACTION VETOED OUT-OF-BAND: The user denied authorization. The command '${route.command}' will NOT be executed.`
          };
        }
        if (err.code === 'expired_token' || err.code === 'timeout') {
          return {
            success: false,
            vetoed: true,
            output: `⏳ AUTHORIZATION EXPIRED: User did not approve the request within the time limit. Execution halted.`
          };
        }
        return {
          success: false,
          output: `CIBA Authorization failed (${err.code}): ${err.message}`
        };
      }
      return {
        success: false,
        output: `Unexpected error during authorization: ${err.message}`
      };
    }
  }

  /**
   * Executes the GitHub action once authorized
   */
  async _executeCommand(route) {
    const { command, params } = route;

    switch (command) {
      case 'list_repos': {
        const repos = await this.github.listRepos();
        const lines = repos.map(
          (r) => `  • ${r.full_name || r.name} (${r.private ? 'Private' : 'Public'}) - ${r.open_issues_count || 0} open issues`
        );
        return {
          success: true,
          output: `Repositories:\n${lines.join('\n')}`,
          data: repos
        };
      }

      case 'list_issues': {
        const issues = await this.github.listIssues(params.repo);
        if (issues.length === 0) {
          return {
            success: true,
            output: `No open issues in ${params.repo}.`,
            data: issues
          };
        }
        const lines = issues.map(
          (i) => `  • #${i.number}: ${i.title} (by @${i.user?.login || 'user'})`
        );
        return {
          success: true,
          output: `Open issues for ${params.repo}:\n${lines.join('\n')}`,
          data: issues
        };
      }

      case 'close_issue': {
        const result = await this.github.closeIssue(params.repo, params.issueNumber);
        return {
          success: true,
          output: `✅ Success: Issue #${params.issueNumber} in '${params.repo}' was closed.`,
          data: result
        };
      }

      case 'merge_pr': {
        const result = await this.github.mergePullRequest(params.repo, params.prNumber);
        return {
          success: true,
          output: `✅ Success: Pull Request #${params.prNumber} in '${params.repo}' has been MERGED.`,
          data: result
        };
      }

      case 'delete_branch': {
        const result = await this.github.deleteBranch(params.repo, params.branchName);
        return {
          success: true,
          output: `✅ Success: Branch '${params.branchName}' in '${params.repo}' has been DELETED.`,
          data: result
        };
      }

      default:
        throw new Error(`Handler for command '${command}' is not implemented.`);
    }
  }
}
