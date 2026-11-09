/**
 * Third-Party Service Integration: GitHub Service
 *
 * Implements GitHub REST API v3 operations:
 * - Safe reads: list repositories, list issues, view repository details
 * - Sensitive writes: delete issue, close issue, merge PR, delete branch
 *
 * When using a mock token (e.g. 'mock_vault_token_...'), it operates against an
 * in-memory mock store so demos work flawlessly without internet or GitHub accounts.
 * When provided with a live token, it calls the official https://api.github.com.
 */

export class GitHubService {
  /**
   * @param {Object} options
   * @param {string} options.accessToken - GitHub personal access token or Token Vault token
   * @param {Function} [options.fetchFn=fetch] - Custom fetch
   */
  constructor(options = {}) {
    this.accessToken = options.accessToken;
    this.fetchFn = options.fetchFn || globalThis.fetch;
    this.isMock = !this.accessToken || this.accessToken.startsWith('mock_vault_token_') || this.accessToken === 'mock';

    // In-memory mock database for offline demo and tests
    this._mockState = {
      repos: [
        {
          id: 101,
          name: 'veto-agent',
          full_name: 'octocat/veto-agent',
          description: 'Auth0 Token Vault + CIBA Veto Agent Implementation',
          private: false,
          open_issues_count: 2,
          default_branch: 'main'
        },
        {
          id: 102,
          name: 'cloud-infrastructure',
          full_name: 'octocat/cloud-infrastructure',
          description: 'Production terraform & k8s deployment definitions',
          private: true,
          open_issues_count: 5,
          default_branch: 'main'
        }
      ],
      issues: [
        {
          id: 1,
          number: 1,
          repo: 'octocat/veto-agent',
          title: 'Implement CIBA out-of-band polling',
          state: 'open',
          user: { login: 'security-lead' },
          body: 'Ensure authorization_pending, slow_down and access_denied are handled.'
        },
        {
          id: 2,
          number: 2,
          repo: 'octocat/veto-agent',
          title: 'Vulnerability report: sanitize terminal output',
          state: 'open',
          user: { login: 'auditor' },
          body: 'Avoid terminal escape code injection in logs.'
        }
      ],
      pullRequests: [
        {
          id: 42,
          number: 42,
          repo: 'octocat/veto-agent',
          title: 'feat: add automated database migration to production',
          state: 'open',
          head: 'feat/db-migration',
          base: 'main',
          merged: false
        }
      ],
      branches: [
        { name: 'main', repo: 'octocat/veto-agent', protected: true },
        { name: 'feature/experimental-bypass', repo: 'octocat/veto-agent', protected: false },
        { name: 'hotfix/patch-001', repo: 'octocat/veto-agent', protected: false }
      ]
    };
  }

  setAccessToken(token) {
    this.accessToken = token;
    this.isMock = !this.accessToken || this.accessToken.startsWith('mock_vault_token_') || this.accessToken === 'mock';
  }

  // --- SAFE READ ACTIONS ---

  /**
   * List authenticated user's repositories
   */
  async listRepos() {
    if (this.isMock) {
      return this._mockState.repos;
    }

    const res = await this.fetchFn('https://api.github.com/user/repos?per_page=10&sort=updated', {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Veto-Agent/1.0'
      }
    });

    if (!res.ok) {
      throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
    }

    return await res.json();
  }

  /**
   * List open issues in a repository
   */
  async listIssues(repo) {
    if (this.isMock) {
      return this._mockState.issues.filter((i) => i.repo === repo || !repo);
    }

    const [owner, name] = (repo || '').split('/');
    if (!owner || !name) throw new Error('Repository must be in format owner/repo');

    const res = await this.fetchFn(`https://api.github.com/repos/${owner}/${name}/issues?state=open`, {
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'User-Agent': 'Veto-Agent/1.0'
      }
    });

    if (!res.ok) {
      throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
    }

    return await res.json();
  }

  // --- SENSITIVE WRITE ACTIONS (SUBJECT TO CIBA VETO) ---

  /**
   * Close or Delete an Issue
   */
  async closeIssue(repo, issueNumber) {
    if (this.isMock) {
      const idx = this._mockState.issues.findIndex(
        (i) => (i.repo === repo || !repo) && i.number === Number(issueNumber)
      );
      if (idx === -1) {
        throw new Error(`Issue #${issueNumber} not found in ${repo || 'default repo'}`);
      }
      this._mockState.issues[idx].state = 'closed';
      return {
        success: true,
        action: 'close_issue',
        repo: repo || 'octocat/veto-agent',
        issueNumber,
        status: 'closed',
        title: this._mockState.issues[idx].title
      };
    }

    const [owner, name] = (repo || '').split('/');
    const res = await this.fetchFn(`https://api.github.com/repos/${owner}/${name}/issues/${issueNumber}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Veto-Agent/1.0'
      },
      body: JSON.stringify({ state: 'closed' })
    });

    if (!res.ok) {
      throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    return {
      success: true,
      action: 'close_issue',
      repo,
      issueNumber,
      status: data.state,
      title: data.title
    };
  }

  /**
   * Merge a Pull Request
   */
  async mergePullRequest(repo, prNumber, commitTitle = 'Merged by Veto Agent') {
    if (this.isMock) {
      const pr = this._mockState.pullRequests.find(
        (p) => (p.repo === repo || !repo) && p.number === Number(prNumber)
      );
      if (!pr) {
        throw new Error(`Pull Request #${prNumber} not found in ${repo || 'default repo'}`);
      }
      pr.merged = true;
      pr.state = 'closed';
      return {
        success: true,
        action: 'merge_pull_request',
        repo: repo || 'octocat/veto-agent',
        prNumber,
        merged: true,
        message: 'Pull Request successfully merged into base branch'
      };
    }

    const [owner, name] = (repo || '').split('/');
    const res = await this.fetchFn(`https://api.github.com/repos/${owner}/${name}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      headers: {
        Authorization: `Bearer ${this.accessToken}`,
        Accept: 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'Veto-Agent/1.0'
      },
      body: JSON.stringify({
        commit_title: commitTitle,
        merge_method: 'merge'
      })
    });

    if (!res.ok) {
      throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
    }

    const data = await res.json();
    return {
      success: true,
      action: 'merge_pull_request',
      repo,
      prNumber,
      merged: data.merged,
      message: data.message
    };
  }

  /**
   * Delete a Git Branch
   */
  async deleteBranch(repo, branchName) {
    if (this.isMock) {
      const idx = this._mockState.branches.findIndex(
        (b) => (b.repo === repo || !repo) && b.name === branchName
      );
      if (idx === -1) {
        throw new Error(`Branch '${branchName}' not found in ${repo || 'default repo'}`);
      }
      if (this._mockState.branches[idx].protected) {
        throw new Error(`Cannot delete protected branch '${branchName}'`);
      }
      this._mockState.branches.splice(idx, 1);
      return {
        success: true,
        action: 'delete_branch',
        repo: repo || 'octocat/veto-agent',
        branchName,
        message: `Branch 'refs/heads/${branchName}' successfully deleted`
      };
    }

    const [owner, name] = (repo || '').split('/');
    const res = await this.fetchFn(
      `https://api.github.com/repos/${owner}/${name}/git/refs/heads/${encodeURIComponent(branchName)}`,
      {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/vnd.github.v3+json',
          'User-Agent': 'Veto-Agent/1.0'
        }
      }
    );

    if (!res.ok) {
      throw new Error(`GitHub API error (${res.status}): ${await res.text()}`);
    }

    return {
      success: true,
      action: 'delete_branch',
      repo,
      branchName,
      message: `Branch '${branchName}' successfully deleted`
    };
  }
}
