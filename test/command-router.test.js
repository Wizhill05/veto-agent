import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { CommandRouter, IMPACT_LEVELS } from '../src/command-router.js';

describe('CommandRouter', () => {
  const router = new CommandRouter('octocat/default-repo');

  test('recognizes safe command: list repos', () => {
    const route = router.route('list my repos');
    assert.ok(route);
    assert.equal(route.command, 'list_repos');
    assert.equal(route.impact, IMPACT_LEVELS.SAFE);
  });

  test('recognizes safe command: show issues', () => {
    const route = router.route('show open issues for org/custom-repo');
    assert.ok(route);
    assert.equal(route.command, 'list_issues');
    assert.equal(route.impact, IMPACT_LEVELS.SAFE);
    assert.equal(route.params.repo, 'org/custom-repo');
  });

  test('falls back to default repo for show issues', () => {
    const route = router.route('show issues');
    assert.ok(route);
    assert.equal(route.command, 'list_issues');
    assert.equal(route.params.repo, 'octocat/default-repo');
  });

  test('recognizes sensitive command: close issue with binding message', () => {
    const route = router.route('close issue 42 in org/my-repo');
    assert.ok(route);
    assert.equal(route.command, 'close_issue');
    assert.equal(route.impact, IMPACT_LEVELS.SENSITIVE);
    assert.equal(route.params.issueNumber, '42');
    assert.equal(route.params.repo, 'org/my-repo');
    assert.match(route.bindingMessage, /CLOSE\/DELETE Issue #42/);
  });

  test('recognizes sensitive command: merge PR', () => {
    const route = router.route('merge pr #101');
    assert.ok(route);
    assert.equal(route.command, 'merge_pr');
    assert.equal(route.impact, IMPACT_LEVELS.SENSITIVE);
    assert.equal(route.params.prNumber, '101');
    assert.equal(route.params.repo, 'octocat/default-repo');
    assert.match(route.bindingMessage, /MERGE Pull Request #101/);
  });

  test('recognizes sensitive command: delete branch', () => {
    const route = router.route('delete branch feature/experimental from org/repo');
    assert.ok(route);
    assert.equal(route.command, 'delete_branch');
    assert.equal(route.impact, IMPACT_LEVELS.SENSITIVE);
    assert.equal(route.params.branchName, 'feature/experimental');
    assert.equal(route.params.repo, 'org/repo');
    assert.match(route.bindingMessage, /PERMANENTLY DELETE Branch 'feature\/experimental'/);
  });

  test('returns null for unknown inputs', () => {
    const route = router.route('bake me a cake');
    assert.equal(route, null);
  });

  test('provides help text with safe vs sensitive commands', () => {
    const help = router.getHelp();
    assert.match(help, /Safe Commands/);
    assert.match(help, /Sensitive High-Impact Commands/);
    assert.match(help, /CIBA/);
  });
});
