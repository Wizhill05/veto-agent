/**
 * Command Router and Intent Parser
 *
 * Distinguishes between:
 * - SAFE commands (reads): execute immediately using Token Vault credentials.
 * - SENSITIVE commands (high-impact writes): mandate out-of-band CIBA approval with binding_message.
 * - UNKNOWN / HELP commands.
 */

export const IMPACT_LEVELS = {
  SAFE: 'SAFE',
  SENSITIVE: 'SENSITIVE'
};

export const COMMAND_DEFINITIONS = [
  // --- Safe Read Commands ---
  {
    name: 'list_repos',
    impact: IMPACT_LEVELS.SAFE,
    description: 'List accessible repositories',
    patterns: [
      /^list\s+(?:my\s+)?repos(?:itories)?$/i,
      /^show\s+(?:my\s+)?repos(?:itories)?$/i,
      /^repos$/i
    ],
    parse: () => ({})
  },
  {
    name: 'list_issues',
    impact: IMPACT_LEVELS.SAFE,
    description: 'List open issues for a repository',
    patterns: [
      /^(?:list|show|get)\s+(?:open\s+)?issues(?:\s+(?:for|in)\s+([a-zA-Z0-9_\-./]+))?$/i,
      /^issues(?:\s+([a-zA-Z0-9_\-./]+))?$/i
    ],
    parse: (matches, defaultRepo) => ({
      repo: matches[1] || defaultRepo
    })
  },

  // --- Sensitive Write Commands (High Impact - Requires Out-of-Band CIBA Approval) ---
  {
    name: 'close_issue',
    impact: IMPACT_LEVELS.SENSITIVE,
    description: 'Close/delete an issue in a repository',
    patterns: [
      /^(?:delete|close|remove)\s+issue\s+#?(\d+)(?:\s+(?:in|from|for)\s+([a-zA-Z0-9_\-./]+))?$/i,
      /^(?:delete|close)\s+#?(\d+)(?:\s+(?:in|from|for)\s+([a-zA-Z0-9_\-./]+))?$/i
    ],
    parse: (matches, defaultRepo) => ({
      issueNumber: matches[1],
      repo: matches[2] || defaultRepo
    }),
    bindingMessage: (params) =>
      `CRITICAL APPROVAL: Agent requests to CLOSE/DELETE Issue #${params.issueNumber} in repository '${params.repo}'. Approve?`
  },
  {
    name: 'merge_pr',
    impact: IMPACT_LEVELS.SENSITIVE,
    description: 'Merge a pull request into the target branch',
    patterns: [
      /^merge\s+(?:pull\s+request|pr)\s+#?(\d+)(?:\s+(?:in|for)\s+([a-zA-Z0-9_\-./]+))?$/i,
      /^merge\s+#?(\d+)(?:\s+(?:in|for)\s+([a-zA-Z0-9_\-./]+))?$/i
    ],
    parse: (matches, defaultRepo) => ({
      prNumber: matches[1],
      repo: matches[2] || defaultRepo
    }),
    bindingMessage: (params) =>
      `CRITICAL APPROVAL: Agent requests to MERGE Pull Request #${params.prNumber} in repository '${params.repo}'. Approve?`
  },
  {
    name: 'delete_branch',
    impact: IMPACT_LEVELS.SENSITIVE,
    description: 'Delete a git branch from a repository',
    patterns: [
      /^delete\s+(?:git\s+)?branch\s+([a-zA-Z0-9_\-./]+)(?:\s+(?:in|from)\s+([a-zA-Z0-9_\-./]+))?$/i,
      /^remove\s+branch\s+([a-zA-Z0-9_\-./]+)(?:\s+(?:in|from)\s+([a-zA-Z0-9_\-./]+))?$/i
    ],
    parse: (matches, defaultRepo) => ({
      branchName: matches[1],
      repo: matches[2] || defaultRepo
    }),
    bindingMessage: (params) =>
      `CRITICAL APPROVAL: Agent requests to PERMANENTLY DELETE Branch '${params.branchName}' in repository '${params.repo}'. Approve?`
  }
];

export class CommandRouter {
  constructor(defaultRepo = 'octocat/veto-agent') {
    this.defaultRepo = defaultRepo;
  }

  /**
   * Matches input string to a command definition.
   *
   * @param {string} input - Raw user input from chat
   * @returns {{ command: string, impact: string, params: Object, bindingMessage?: string } | null}
   */
  route(input) {
    const text = (input || '').trim();
    if (!text) return null;

    for (const def of COMMAND_DEFINITIONS) {
      for (const pattern of def.patterns) {
        const matches = text.match(pattern);
        if (matches) {
          const params = def.parse(matches, this.defaultRepo);
          const bindingMessage = def.bindingMessage ? def.bindingMessage(params) : undefined;
          return {
            command: def.name,
            impact: def.impact,
            params,
            bindingMessage,
            rawInput: text
          };
        }
      }
    }

    return null;
  }

  getHelp() {
    return [
      'Available Commands:',
      '  Safe Commands (Runs immediately via Token Vault):',
      '    • list repos                 - List your GitHub repositories',
      '    • show issues [repo]         - Show open issues in repository',
      '',
      '  Sensitive High-Impact Commands (Requires out-of-band CIBA authorization):',
      '    • close issue <#id> [repo]   - Close an issue',
      '    • merge pr <#id> [repo]      - Merge a pull request',
      '    • delete branch <name> [repo]- Delete a branch',
      '',
      '  System:',
      '    • help                       - Show this menu',
      '    • exit / quit                - Exit the agent'
    ].join('\n');
  }
}
