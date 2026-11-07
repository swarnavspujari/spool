// @ts-check
/**
 * `scripts/repo-settings.sh verify` compares the repository with the settings that the script
 * applies, prints what differs, and exits with 1. The test runs the real script with a fake `gh` in
 * front of it on the PATH. The fake answers from a state file, evaluates only the jq filters that
 * the script uses (it stops on any other, so a new filter has to be added here), and refuses every
 * call that is not a read. Nothing here reaches GitHub.
 *
 * The test needs bash. On Windows it runs only when SPOOL_TEST_BASH names a Git Bash (a bare
 * `bash` there can be the WSL launcher, which does not see the Windows PATH).
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

const SCRIPT = join(import.meta.dirname, '..', '..', 'scripts', 'repo-settings.sh').replaceAll('\\', '/');
const REPO = 'someone/spool';
const bash = process.env['SPOOL_TEST_BASH'] ?? (process.platform === 'win32' ? '' : 'bash');
const available = bash !== '' && spawnSync(bash, ['--version'], { stdio: 'ignore' }).status === 0;

const script = readFileSync(SCRIPT, 'utf8');
const TOPICS = /TOPICS=\(([^)]*)\)/.exec(script)?.[1]?.trim().split(/\s+/) ?? [];
const DESCRIPTION = /DESCRIPTION="([^"]*)"/.exec(script)?.[1] ?? '';

/** The fake `gh`. It reads the state from the file in SPOOL_FAKE_STATE and logs every call. */
const FAKE_GH = String.raw`
import fs from 'node:fs';

const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.SPOOL_FAKE_STATE, 'utf8'));
fs.appendFileSync(process.env.SPOOL_FAKE_LOG, JSON.stringify(args) + '\n');

function flag(name) {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function fail(message, code = 1) {
  process.stderr.write(message + '\n');
  process.exit(code);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const bypass = (j) => j.bypass_actors.map((b) => b.actor_type + ':' + b.actor_id + ':' + b.bypass_mode);
const rule = (j, type) => j.rules.find((r) => r.type === type);
const SPECIAL = new Map([
  ['.patterns_allowed | length', (j) => j.patterns_allowed.length],
  ['.conditions.ref_name.include | join(",")', (j) => j.conditions.ref_name.include.join(',')],
  ['[.rules[].type] | sort | join(",")', (j) => j.rules.map((r) => r.type).sort().join(',')],
  ['.bypass_actors[] | "\\(.actor_type):\\(.actor_id):\\(.bypass_mode)"', (j) => bypass(j).join('\n')],
  [
    '.rules[] | select(.type == "pull_request") | .parameters.allowed_merge_methods | join(",")',
    (j) => rule(j, 'pull_request').parameters.allowed_merge_methods.join(','),
  ],
  [
    '.rules[] | select(.type == "required_status_checks") | .parameters.required_status_checks[] | "\\(.context):\\(.integration_id)"',
    (j) =>
      rule(j, 'required_status_checks')
        .parameters.required_status_checks.map((c) => c.context + ':' + c.integration_id)
        .join('\n'),
  ],
  [
    '[.repositoryTopics[]? | (.name // .topic.name)] | sort | join(",")',
    (j) => (j.repositoryTopics ?? []).map((t) => t.name ?? t.topic.name).sort().join(','),
  ],
]);

function evaluate(json, filter) {
  const special = SPECIAL.get(filter);
  if (special) return special(json);
  if (/^\.[A-Za-z_][\w.]*$/.test(filter)) {
    let v = json;
    for (const part of filter.slice(1).split('.')) {
      if (v === null || typeof v !== 'object' || !(part in v)) fail('no field ' + part);
      v = v[part];
    }
    return v;
  }
  return fail('the fake gh does not know the jq filter: ' + filter, 99);
}
function print(value) {
  if (typeof value === 'string') console.log(value);
  else console.log(JSON.stringify(value));
}

const [command, sub] = args;
if (command === 'api') {
  if (args.includes('-X') || args.includes('--method') || args.includes('--input') || args.includes('-f') || args.includes('-F')) {
    fail('a write was attempted: ' + args.join(' '), 98);
  }
  const endpoint = args[1];
  const filter = flag('--jq');
  const listFilter = filter && /^\.\[\] \| select\(\.name == "(.*)"\) \| \.id$/.exec(filter);
  const body = state.api[endpoint];
  if (body === undefined) fail('HTTP 404: ' + endpoint);
  if (listFilter) {
    const found = body.find((r) => r.name === listFilter[1]);
    if (found) console.log(found.id);
  } else if (filter) print(evaluate(body, filter));
  else print(body);
} else if (command === 'repo' && sub === 'view') {
  const field = flag('--json');
  const filter = flag('--jq');
  if (!(field in state.view)) fail('Unknown JSON field: ' + field);
  print(evaluate({ [field]: state.view[field] }, filter));
} else if (command === 'variable' && sub === 'get') {
  const name = args[2];
  if (!(name in state.variables)) fail('HTTP 404: variable ' + name);
  console.log(state.variables[name]);
} else {
  fail('a call that is not a read: ' + args.join(' '), 98);
}
`;

/**
 * The state of a repository that matches what the script applies.
 * @returns {any}
 */
function goodState() {
  const rulesetMain = {
    id: 11,
    name: 'main',
    target: 'branch',
    enforcement: 'active',
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'pull_request' }],
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'required_linear_history' },
      { type: 'pull_request', parameters: { allowed_merge_methods: ['squash'] } },
      {
        type: 'required_status_checks',
        parameters: { required_status_checks: [{ context: 'CI result', integration_id: 15368 }] },
      },
    ],
  };
  const rulesetTags = {
    id: 12,
    name: 'release tags',
    target: 'tag',
    enforcement: 'active',
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    bypass_actors: [{ actor_id: 5, actor_type: 'RepositoryRole', bypass_mode: 'always' }],
    rules: [{ type: 'creation' }, { type: 'update' }, { type: 'deletion' }],
  };
  return {
    api: {
      [`repos/${REPO}`]: {
        squash_merge_commit_title: 'PR_TITLE',
        squash_merge_commit_message: 'BLANK',
        allow_auto_merge: false,
        security_and_analysis: {
          secret_scanning: { status: 'enabled' },
          secret_scanning_push_protection: { status: 'enabled' },
        },
      },
      [`repos/${REPO}/actions/permissions`]: {
        enabled: true,
        allowed_actions: 'selected',
        sha_pinning_required: true,
      },
      [`repos/${REPO}/actions/permissions/selected-actions`]: {
        github_owned_allowed: true,
        verified_allowed: false,
        patterns_allowed: [],
      },
      [`repos/${REPO}/actions/permissions/workflow`]: {
        default_workflow_permissions: 'read',
        can_approve_pull_request_reviews: false,
      },
      [`repos/${REPO}/actions/permissions/fork-pr-contributor-approval`]: {
        approval_policy: 'all_external_contributors',
      },
      [`repos/${REPO}/actions/permissions/artifact-and-log-retention`]: { days: 30 },
      [`repos/${REPO}/vulnerability-alerts`]: '',
      [`repos/${REPO}/automated-security-fixes`]: { enabled: true, paused: false },
      [`repos/${REPO}/private-vulnerability-reporting`]: { enabled: true },
      [`repos/${REPO}/immutable-releases`]: { enabled: true, enforced_by_owner: false },
      [`repos/${REPO}/rulesets`]: [
        { id: 11, name: 'main' },
        { id: 12, name: 'release tags' },
      ],
      [`repos/${REPO}/rulesets/11`]: rulesetMain,
      [`repos/${REPO}/rulesets/12`]: rulesetTags,
    },
    view: {
      description: DESCRIPTION,
      homepageUrl: `https://github.com/${REPO}#readme`,
      repositoryTopics: TOPICS.map((name) => ({ name })),
      hasIssuesEnabled: true,
      hasWikiEnabled: false,
      hasProjectsEnabled: false,
      hasDiscussionsEnabled: false,
      squashMergeAllowed: true,
      mergeCommitAllowed: false,
      rebaseMergeAllowed: false,
      deleteBranchOnMerge: true,
    },
    variables: { E2E_WORKERS: '3' },
  };
}

describe('scripts/repo-settings.sh verify', { skip: !available && 'bash is not available' }, () => {
  /** @type {string} */
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'spool-gh-'));
    writeFileSync(join(dir, 'fake-gh.mjs'), FAKE_GH);
    writeFileSync(
      join(dir, 'gh'),
      '#!/usr/bin/env bash\nexec node "$SPOOL_FAKE_GH_JS" "$@"\n',
    );
    chmodSync(join(dir, 'gh'), 0o755);
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  /**
   * Runs `verify` against a state.
   * @param {(state: any) => void} [change]
   */
  function run(change) {
    const state = goodState();
    change?.(state);
    const stateFile = join(dir, 'state.json');
    const logFile = join(dir, 'calls.log');
    writeFileSync(stateFile, JSON.stringify(state));
    writeFileSync(logFile, '');
    const result = spawnSync(bash, [SCRIPT, 'verify', REPO], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${dir}${delimiter}${process.env['PATH'] ?? ''}`,
        SPOOL_FAKE_STATE: stateFile.replaceAll('\\', '/'),
        SPOOL_FAKE_LOG: logFile.replaceAll('\\', '/'),
        SPOOL_FAKE_GH_JS: join(dir, 'fake-gh.mjs').replaceAll('\\', '/'),
      },
    });
    const calls = readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean);
    return { status: result.status, out: result.stdout, err: result.stderr, calls };
  }

  // Each run starts bash, which starts the fake gh about fifty times. The cases are grouped, so
  // that a run checks several differences and the suite stays short on a slow system.

  it('exits 0 and says so when every setting matches, and it only reads', () => {
    const r = run();
    assert.equal(r.status, 0, r.out + r.err);
    assert.match(r.out, /Every setting matches./);
    assert.doesNotMatch(r.out, /DIFF/);
    assert.ok(r.calls.length > 20, 'it read many settings');
    for (const call of r.calls) {
      const args = JSON.parse(call);
      assert.ok(['api', 'repo', 'variable'].includes(args[0]), call);
      if (args[0] === 'repo') assert.equal(args[1], 'view', call);
      if (args[0] === 'variable') assert.equal(args[1], 'get', call);
      for (const write of ['-X', '--method', '--input', '-f', '-F']) {
        assert.ok(!args.includes(write), call);
      }
    }
  });

  it('exits 1, names every setting that differs, and counts them', () => {
    /** @type {[(s: any) => void, RegExp][]} */
    const cases = [
      [(s) => { s.view.hasWikiEnabled = true; }, /DIFF {2}wiki: expected "false", found "true"/],
      [(s) => { s.view.mergeCommitAllowed = true; }, /DIFF {2}merge commit/],
      [(s) => { s.view.description = 'Other'; }, /DIFF {2}description/],
      [(s) => { s.view.repositoryTopics.pop(); }, /DIFF {2}topics/],
      [
        (s) => { s.api[`repos/${REPO}`].squash_merge_commit_title = 'COMMIT_OR_PR_TITLE'; },
        /DIFF {2}squash commit title/,
      ],
      [(s) => { s.api[`repos/${REPO}`].allow_auto_merge = true; }, /DIFF {2}auto-merge/],
      [
        (s) => { s.api[`repos/${REPO}/actions/permissions`].sha_pinning_required = false; },
        /DIFF {2}full-SHA pinning/,
      ],
      [
        (s) => {
          s.api[`repos/${REPO}/actions/permissions/workflow`].default_workflow_permissions = 'write';
        },
        /DIFF {2}default token/,
      ],
      [
        (s) => {
          s.api[`repos/${REPO}`].security_and_analysis.secret_scanning_push_protection.status = 'disabled';
        },
        /DIFF {2}push protection/,
      ],
      [
        (s) => { s.api[`repos/${REPO}/immutable-releases`].enabled = false; },
        /DIFF {2}immutable releases/,
      ],
      [(s) => { s.variables.E2E_WORKERS = '8'; }, /DIFF {2}variable E2E_WORKERS/],
      [
        (s) => { s.api[`repos/${REPO}/rulesets/11`].enforcement = 'disabled'; },
        /DIFF {2}ruleset "main" enforcement/,
      ],
      [
        (s) => {
          s.api[`repos/${REPO}/rulesets/11`].rules[3].parameters.allowed_merge_methods = ['squash', 'merge'];
        },
        /DIFF {2}ruleset "main" merge methods/,
      ],
      [
        (s) => {
          s.api[`repos/${REPO}/rulesets/11`].rules[4].parameters.required_status_checks[0].integration_id = 1;
        },
        /DIFF {2}ruleset "main" required check/,
      ],
      [
        (s) => { s.api[`repos/${REPO}/rulesets/12`].rules.pop(); },
        /DIFF {2}ruleset "release tags" rules/,
      ],
      [
        (s) => { delete s.api[`repos/${REPO}/vulnerability-alerts`]; },
        /DIFF {2}vulnerability alerts: expected "on", found "off"/,
      ],
      [
        (s) => { delete s.api[`repos/${REPO}/private-vulnerability-reporting`]; },
        /DIFF {2}private vulnerability reporting: .*(could not read)/,
      ],
    ];
    const r = run((state) => {
      for (const [change] of cases) change(state);
    });
    assert.equal(r.status, 1, r.out + r.err);
    for (const [, expected] of cases) assert.match(r.out, expected);
    assert.equal(r.out.match(/DIFF/g)?.length, cases.length, 'no difference more than the ones made');
    assert.ok(r.err.startsWith(`${cases.length} setting(s) differ`), r.err);
    assert.match(r.out, /ok {4}immutable releases|DIFF {2}immutable releases/, 'it went on to the end');
  });

  it('exits 1 when a ruleset does not exist', () => {
    const r = run((s) => {
      s.api[`repos/${REPO}/rulesets`] = [{ id: 11, name: 'main' }];
    });
    assert.equal(r.status, 1);
    assert.match(r.out, /DIFF {2}ruleset "release tags": expected it to exist/);
    assert.ok(r.err.startsWith('1 setting(s) differ'), r.err);
  });
});
