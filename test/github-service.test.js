import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubService } from '../src/github-service.js';

describe('GitHubService', () => {
  describe('Mock Mode (Offline)', () => {
    const service = new GitHubService({ accessToken: 'mock_vault_token_github_123' });

    test('lists repositories', async () => {
      const repos = await service.listRepos();
      assert.ok(Array.isArray(repos));
      assert.ok(repos.length > 0);
      assert.equal(repos[0].name, 'veto-agent');
    });

    test('lists open issues', async () => {
      const issues = await service.listIssues('octocat/veto-agent');
      assert.ok(Array.isArray(issues));
      assert.ok(issues.length >= 2);
      assert.equal(issues[0].number, 1);
    });

    test('closes an issue', async () => {
      const res = await service.closeIssue('octocat/veto-agent', 1);
      assert.equal(res.success, true);
      assert.equal(res.status, 'closed');

      const issues = await service.listIssues('octocat/veto-agent');
      const closedIssue = issues.find((i) => i.number === 1);
      assert.equal(closedIssue.state, 'closed');
    });

    test('merges a pull request', async () => {
      const res = await service.mergePullRequest('octocat/veto-agent', 42);
      assert.equal(res.success, true);
      assert.equal(res.merged, true);
    });

    test('deletes a non-protected branch', async () => {
      const res = await service.deleteBranch('octocat/veto-agent', 'hotfix/patch-001');
      assert.equal(res.success, true);
      assert.match(res.message, /deleted/);
    });

    test('prevents deletion of protected branch', async () => {
      await assert.rejects(
        async () => {
          await service.deleteBranch('octocat/veto-agent', 'main');
        },
        /protected/i
      );
    });
  });

  describe('Live Mode (API calling with custom fetch)', () => {
    test('calls GitHub API with bearer token', async () => {
      let authHeader = '';
      const mockFetch = async (url, opts) => {
        authHeader = opts.headers.Authorization;
        return {
          ok: true,
          json: async () => [{ name: 'remote-repo', private: false, open_issues_count: 0 }]
        };
      };

      const liveService = new GitHubService({
        accessToken: 'ghp_liveRealGitHubToken',
        fetchFn: mockFetch
      });

      const repos = await liveService.listRepos();
      assert.equal(authHeader, 'Bearer ghp_liveRealGitHubToken');
      assert.equal(repos[0].name, 'remote-repo');
    });
  });
});
