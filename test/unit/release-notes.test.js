// @ts-check
/**
 * Tests for the pure parts of .github/scripts/release-notes.mjs, and a run of the script with
 * the real manifest.json and template and a CHANGELOG that has the manifest version. (The real
 * CHANGELOG.md is not read: a version bump must not fail an unrelated test.)
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { extractSection, permissionLine } from '../../.github/scripts/release-notes.mjs';

const REPO = join(import.meta.dirname, '..', '..');

const CHANGELOG = `# Changelog

## [Unreleased]

Nothing yet.

## [1.2.0] - 2026-02-01

Faster tiles.

### Fixed

- A crash.

## [1.1.0] - 2026-01-01

Older.
`;

describe('extractSection', () => {
  it('returns the text under the heading, without the heading', () => {
    assert.equal(extractSection(CHANGELOG, '1.2.0'), 'Faster tiles.\n\n### Fixed\n\n- A crash.');
  });

  it('reads the last section and CRLF files', () => {
    assert.equal(extractSection(CHANGELOG.replace(/\n/g, '\r\n'), '1.1.0'), 'Older.');
  });

  it('does not match a version that only starts the same way', () => {
    assert.throws(() => extractSection(CHANGELOG, '1.2'), /no section/);
    assert.throws(() => extractSection(CHANGELOG, '9.9.9'), /no section "## \[9\.9\.9\]"/);
  });

  it('fails on an empty section and on one marked Unreleased', () => {
    assert.throws(() => extractSection('## [1.0.0]\n\n## [0.9.0]\nx\n', '1.0.0'), /empty/);
    assert.throws(() => extractSection('## [1.0.0] - Unreleased\nx\n', '1.0.0'), /Unreleased/);
  });
});

describe('permissionLine', () => {
  it('says unchanged when the sets are equal', () => {
    assert.equal(permissionLine(['a', 'b'], ['a', 'b']), 'Permissions: `a`, `b` (unchanged).');
  });

  it('calls out added and removed permissions in bold', () => {
    const line = permissionLine(['a', 'b'], ['a', 'c']);
    assert.match(line, /^\*\*Permissions changed: added `c`; removed `b`\.\*\*/);
    assert.match(line, /All permissions: `a`, `c`\.$/);
  });

  it('only lists the permissions when there is no previous release', () => {
    assert.equal(permissionLine(null, ['a', 'b']), 'Permissions: `a`, `b`.');
    assert.equal(permissionLine(null, []), 'Permissions: none.');
  });

  it('handles an empty list', () => {
    assert.equal(permissionLine([], []), 'Permissions: none (unchanged).');
  });
});

describe('release-notes.mjs', () => {
  it('writes notes for the manifest version, or fails on a missing section', () => {
    const version = JSON.parse(readFileSync(join(REPO, 'manifest.json'), 'utf8')).version;
    const dir = mkdtempSync(join(tmpdir(), 'spool-notes-'));
    try {
      const out = join(dir, 'notes.md');
      const changelog = join(dir, 'CHANGELOG.md');
      writeFileSync(changelog, `## [${version}] - 2026-01-01\n\nHello.\n`);
      const run = (/** @type {string} */ v) =>
        spawnSync(
          process.execPath,
          [
            '.github/scripts/release-notes.mjs',
            v,
            '--repo',
            'owner/spool',
            '--zip',
            `spool-${v}.zip`,
            '--sha256',
            'abc',
            '--changelog',
            changelog,
            '--out',
            out,
          ],
          { cwd: REPO, encoding: 'utf8' },
        );
      const ok = run(version);
      assert.equal(ok.status, 0, ok.stderr);
      const text = readFileSync(out, 'utf8');
      assert.match(text, new RegExp(`spool-${version.replace(/\./g, '\\.')}\\.zip`));
      assert.match(text, /^Hello\./);
      assert.match(text, /Permissions:/);
      assert.doesNotMatch(text, /\{\{/);
      const bad = run('9.9.9');
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /no section "## \[9\.9\.9\]"/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
