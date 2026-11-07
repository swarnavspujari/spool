// @ts-check
/**
 * Tests for .github/scripts/lockfile-rules.mjs, the rules of the lock file check. The check must link
 * the `resolved` URL of each package to the name of its path and to its version: the integrity value alone does not say which package a tarball is.
 * The last test runs the real script on the real lock file.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  REGISTRY,
  checkLockfile,
  expectedResolved,
  packageNameOfPath,
} from '../../.github/scripts/lockfile-rules.mjs';

const REPO = join(import.meta.dirname, '..', '..');
/** A valid sha512 integrity value: 64 bytes in base64. */
const SHA512 = `sha512-${'A'.repeat(86)}==`;

/**
 * A lock file with the given packages. Each package gets a valid entry unless `overrides` has it.
 * @param {Record<string, Record<string, unknown>>} packages  Path to the fields to change or add.
 * @returns {{ lockfileVersion: number, packages: Record<string, any> }}
 */
function lockWith(packages) {
  /** @type {Record<string, any>} */
  const out = { '': { name: 'spool', version: '1.0.0' } };
  for (const [path, fields] of Object.entries(packages)) {
    const name = packageNameOfPath(path) ?? 'x';
    const version = typeof fields['version'] === 'string' ? fields['version'] : '1.2.3';
    out[path] = {
      version,
      resolved: expectedResolved(name, version),
      integrity: SHA512,
      ...fields,
    };
  }
  return { lockfileVersion: 3, packages: out };
}

/** @param {unknown} lock @returns {string[]} */
function findingsOf(lock) {
  return checkLockfile(lock).findings;
}

describe('packageNameOfPath', () => {
  it('reads the name after the last node_modules/, scoped names included', () => {
    assert.equal(packageNameOfPath('node_modules/typescript'), 'typescript');
    assert.equal(packageNameOfPath('node_modules/@types/node'), '@types/node');
    assert.equal(packageNameOfPath('node_modules/a/node_modules/b'), 'b');
    assert.equal(packageNameOfPath('node_modules/@s/a/node_modules/@t/b'), '@t/b');
  });

  it('gives null for a path that is not a package path', () => {
    for (const path of [
      '',
      'packages/app',
      'node_modules',
      'node_modules/',
      'node_modules/a/b',
      'node_modules/@types',
      'node_modules/../x',
      'xnode_modules/a',
      'node_modules/A',
      'node_modules/a b',
    ]) {
      assert.equal(packageNameOfPath(path), null, JSON.stringify(path));
    }
  });
});

describe('expectedResolved', () => {
  it('builds the tarball URL of the registry', () => {
    assert.equal(
      expectedResolved('typescript', '7.0.2'),
      'https://registry.npmjs.org/typescript/-/typescript-7.0.2.tgz',
    );
  });

  it('uses the name without the scope in the file name', () => {
    assert.equal(
      expectedResolved('@types/node', '26.6.6'),
      'https://registry.npmjs.org/@types/node/-/node-26.6.6.tgz',
    );
  });

  it('keeps a pre-release version', () => {
    assert.equal(
      expectedResolved('a', '1.0.0-beta.1'),
      'https://registry.npmjs.org/a/-/a-1.0.0-beta.1.tgz',
    );
  });
});

describe('checkLockfile: a good lock file', () => {
  it('has no finding, and counts the packages but not the root', () => {
    const result = checkLockfile(
      lockWith({
        'node_modules/typescript': { version: '7.0.2' },
        'node_modules/@types/node': { version: '26.6.6' },
        'node_modules/a/node_modules/@scope/b': { version: '1.0.0-rc.1' },
      }),
    );
    assert.deepEqual(result.findings, []);
    assert.equal(result.count, 3);
    assert.deepEqual(result.installScripts, []);
  });

  it('lists a package with an install script as a notice, not as a finding', () => {
    const result = checkLockfile(lockWith({ 'node_modules/esbuild': { hasInstallScript: true } }));
    assert.deepEqual(result.findings, []);
    assert.deepEqual(result.installScripts, ['node_modules/esbuild']);
  });
});

describe('checkLockfile: resolved must be the tarball of the package at its path', () => {
  it('refuses the tarball of another package', () => {
    const lock = lockWith({
      'node_modules/typescript': {
        version: '7.0.2',
        resolved: 'https://registry.npmjs.org/evil-ts/-/evil-ts-7.0.2.tgz',
      },
    });
    const findings = findingsOf(lock);
    assert.equal(findings.length, 1);
    assert.match(findings[0] ?? '', /node_modules\/typescript: resolved is .*evil-ts.*expected .*typescript-7\.0\.2\.tgz/);
  });

  it('refuses the right package at another version', () => {
    const lock = lockWith({
      'node_modules/typescript': {
        version: '7.0.2',
        resolved: 'https://registry.npmjs.org/typescript/-/typescript-6.0.0.tgz',
      },
    });
    assert.equal(findingsOf(lock).length, 1);
  });

  it('refuses a scoped package that points to the tarball of an unscoped one', () => {
    const lock = lockWith({
      'node_modules/@types/node': {
        version: '26.6.6',
        resolved: 'https://registry.npmjs.org/node/-/node-26.6.6.tgz',
      },
    });
    assert.equal(findingsOf(lock).length, 1);
  });

  it('refuses a scope or a file name that does not match', () => {
    for (const resolved of [
      'https://registry.npmjs.org/@evil/node/-/node-26.6.6.tgz',
      'https://registry.npmjs.org/@types/node/-/other-26.6.6.tgz',
      'https://registry.npmjs.org/@types/node/-/@types/node-26.6.6.tgz',
    ]) {
      const lock = lockWith({ 'node_modules/@types/node': { version: '26.6.6', resolved } });
      assert.equal(findingsOf(lock).length, 1, resolved);
    }
  });

  it('refuses a query string, a fragment or any extra text on the URL', () => {
    const good = expectedResolved('a', '1.0.0');
    for (const resolved of [`${good}?x=1`, `${good}#sha1=ab`, `${good}/`, ` ${good}`, `${good} `]) {
      const lock = lockWith({ 'node_modules/a': { version: '1.0.0', resolved } });
      assert.equal(findingsOf(lock).length, 1, JSON.stringify(resolved));
    }
  });

  it('checks the name of the LAST node_modules folder of a nested path', () => {
    const lock = lockWith({
      'node_modules/a/node_modules/b': {
        version: '1.0.0',
        resolved: expectedResolved('a', '1.0.0'),
      },
    });
    assert.equal(findingsOf(lock).length, 1);
  });

  it('refuses another host, also one that starts like the registry', () => {
    for (const host of [
      'https://registry.npmjs.org.evil.example/',
      'http://registry.npmjs.org/',
      'https://registry.yarnpkg.com/',
      'git+https://github.com/a/b.git#abc',
      'file:../a.tgz',
    ]) {
      const lock = lockWith({
        'node_modules/a': { version: '1.0.0', resolved: `${host}a/-/a-1.0.0.tgz` },
      });
      const findings = findingsOf(lock);
      assert.equal(findings.length, 1, host);
      assert.match(findings[0] ?? '', /not a URL of https:\/\/registry\.npmjs\.org\//);
    }
  });

  it('refuses a missing or a non-text resolved', () => {
    for (const resolved of [undefined, null, 5, {}]) {
      const lock = lockWith({ 'node_modules/a': { version: '1.0.0' } });
      /** @type {any} */ (lock.packages['node_modules/a']).resolved = resolved;
      assert.equal(findingsOf(lock).length, 1, String(resolved));
    }
  });

  it('refuses a missing or a bad version', () => {
    for (const version of [undefined, null, 5, '', 'latest', '1.0', '1.0.0/../x', 'v1.0.0']) {
      const lock = lockWith({ 'node_modules/a': {} });
      /** @type {any} */ (lock.packages['node_modules/a']).version = version;
      const findings = findingsOf(lock);
      assert.ok(findings.length >= 1, String(version));
      assert.match(findings.join('\n'), /version is/);
    }
  });

  it('refuses an alias: an entry whose name differs from its path', () => {
    const lock = lockWith({
      'node_modules/typescript': {
        version: '7.0.2',
        name: 'evil-ts',
        resolved: expectedResolved('evil-ts', '7.0.2'),
      },
    });
    const findings = findingsOf(lock);
    assert.ok(findings.some((f) => /alias for "evil-ts"/.test(f)), findings.join('\n'));
  });

  it('accepts an entry whose name field equals its path name', () => {
    assert.deepEqual(findingsOf(lockWith({ 'node_modules/a': { name: 'a' } })), []);
  });

  it('refuses a link, and a path outside node_modules', () => {
    assert.match(
      findingsOf(lockWith({ 'node_modules/a': { link: true } })).join('\n'),
      /is a link/,
    );
    assert.match(
      findingsOf(lockWith({ 'packages/app': { version: '1.0.0' } })).join('\n'),
      /packages\/app: is not a package path/,
    );
  });
});

describe('checkLockfile: integrity must be one sha512 value', () => {
  it('accepts sha512 only', () => {
    assert.deepEqual(findingsOf(lockWith({ 'node_modules/a': { integrity: SHA512 } })), []);
  });

  it('refuses sha1, sha256, sha384, a short sha512, a missing value and several hashes', () => {
    const bad = [
      undefined,
      null,
      5,
      '',
      'sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=',
      `sha256-${'A'.repeat(43)}=`,
      `sha384-${'A'.repeat(64)}`,
      `sha512-${'A'.repeat(20)}`,
      `sha512-${'A'.repeat(86)}`, // No padding.
      `sha512-${'A'.repeat(86)}== `,
      `${SHA512} sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA=`,
      `sha1-AAAAAAAAAAAAAAAAAAAAAAAAAAA= ${SHA512}`,
      `SHA512-${'A'.repeat(86)}==`,
    ];
    for (const integrity of bad) {
      const lock = lockWith({ 'node_modules/a': {} });
      /** @type {any} */ (lock.packages['node_modules/a']).integrity = integrity;
      const findings = findingsOf(lock);
      assert.equal(findings.length, 1, String(integrity));
      assert.match(findings[0] ?? '', /not one sha512 value/);
    }
  });
});

describe('checkLockfile: bad input', () => {
  it('reports a lock file with no package', () => {
    assert.deepEqual(findingsOf({ lockfileVersion: 3, packages: { '': {} } }), ['no packages found']);
    assert.deepEqual(findingsOf({ lockfileVersion: 3 }), ['no packages found']);
    assert.deepEqual(findingsOf(null), ['no packages found']);
    assert.deepEqual(findingsOf('x'), ['no packages found']);
  });

  it('does not throw on an entry that is not an object', () => {
    const lock = { lockfileVersion: 3, packages: { 'node_modules/a': null, 'node_modules/b': 5 } };
    const findings = findingsOf(lock);
    assert.ok(findings.length >= 2);
  });

  it('collects every finding, one list entry for each problem', () => {
    const lock = lockWith({
      'node_modules/a': { resolved: 'https://example.com/a.tgz', integrity: 'sha1-x' },
      'node_modules/b': { version: '1.0.0', resolved: expectedResolved('c', '1.0.0') },
    });
    assert.equal(findingsOf(lock).length, 3);
  });
});

describe('check-lockfile.mjs', () => {
  const script = join(REPO, '.github', 'scripts', 'check-lockfile.mjs');

  /** @param {string} file */
  function run(file) {
    return spawnSync(process.execPath, [script, file], { encoding: 'utf8' });
  }

  it('passes for the lock file of this repository', () => {
    const result = run(join(REPO, 'package-lock.json'));
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /lockfile: ok \(\d+ packages/);
    assert.ok(result.stdout.includes(REGISTRY));
  });

  it('fails with a workflow error line for a lock file whose tarball belongs to another package', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-lockfile-'));
    try {
      const lock = JSON.parse(readFileSync(join(REPO, 'package-lock.json'), 'utf8'));
      lock.packages['node_modules/typescript'].resolved =
        'https://registry.npmjs.org/evil-ts/-/evil-ts-7.0.2.tgz';
      const file = join(dir, 'package-lock.json');
      writeFileSync(file, JSON.stringify(lock));
      const result = run(file);
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stderr, /::error title=package-lock\.json::node_modules\/typescript: resolved is/);
      assert.match(result.stderr, /lockfile: 1 finding/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('fails for a lock file that is not version 3', () => {
    const dir = mkdtempSync(join(tmpdir(), 'spool-lockfile-'));
    try {
      const file = join(dir, 'package-lock.json');
      writeFileSync(file, JSON.stringify({ lockfileVersion: 2, packages: {} }));
      const result = run(file);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /lockfileVersion is 2, expected 3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
