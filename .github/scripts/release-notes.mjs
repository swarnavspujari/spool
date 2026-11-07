// @ts-check
/**
 * Writes the GitHub release notes for one version.
 *
 * Usage:
 *   node .github/scripts/release-notes.mjs <version> --repo <owner/name> --zip <file>
 *        [--sha256 <hex>] [--changelog CHANGELOG.md] [--template .github/RELEASE_TEMPLATE.md]
 *        [--out RELEASE_NOTES.md]
 *
 * The notes are the "## [<version>]" section of CHANGELOG.md, written by hand, plus the
 * template (install, verify, permissions, compare link). Nothing is generated from commit
 * messages. The script fails when the section is missing or empty, so a release cannot go out
 * without notes.
 *
 * Permissions are read from manifest.json of the tag and of the previous release tag
 * (`git show <prev>:manifest.json`), so the notes cannot disagree with the zip.
 * It uses Node built-ins and the git CLI only.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const SEMVER = /^\d+\.\d+\.\d+$/;

/**
 * @param {string} changelog Full text of CHANGELOG.md.
 * @param {string} version For example "1.2.0".
 * @returns {string} The text under "## [1.2.0] - date", without the heading. Trimmed.
 */
export function extractSection(changelog, version) {
  const lines = changelog.replace(/\r\n/g, '\n').split('\n');
  const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\](?:\\s|$)`);
  const start = lines.findIndex((line) => heading.test(line));
  if (start === -1) throw new Error(`CHANGELOG.md has no section "## [${version}]"`);
  let end = lines.findIndex((line, i) => i > start && /^## \[/.test(line));
  if (end === -1) end = lines.length;
  const body = lines.slice(start + 1, end).join('\n').trim();
  if (body === '') throw new Error(`The section "## [${version}]" in CHANGELOG.md is empty`);
  if (/unreleased/i.test(lines[start] ?? '')) {
    throw new Error(`The section "## [${version}]" is still marked Unreleased`);
  }
  return body;
}

/**
 * @param {string[] | null} before  Permissions of the previous release, or null for a first release.
 * @param {string[]} after
 * @returns {string} One line that says if the permissions changed. With no previous release there
 *   is nothing to compare, so it only lists them.
 */
export function permissionLine(before, after) {
  const list = after.map((p) => `\`${p}\``).join(', ') || 'none';
  if (before === null) return `Permissions: ${list}.`;
  const added = after.filter((p) => !before.includes(p));
  const removed = before.filter((p) => !after.includes(p));
  if (added.length === 0 && removed.length === 0) return `Permissions: ${list} (unchanged).`;
  const parts = [];
  if (added.length) parts.push(`added ${added.map((p) => `\`${p}\``).join(', ')}`);
  if (removed.length) parts.push(`removed ${removed.map((p) => `\`${p}\``).join(', ')}`);
  // Chrome does not prompt for a permission increase of an unpacked extension, so the notes do.
  const head = `**Permissions changed: ${parts.join('; ')}.**`;
  const note = 'Chrome does not ask you to approve this for an unpacked extension, so read it ' +
    'before you reload.';
  return `${head} ${note}\n\nAll permissions: ${list}.`;
}

/** @param {string[]} args @returns {string | null} Output of git, or null when it fails. */
function git(args) {
  try {
    /** @type {Array<'ignore' | 'pipe'>} */
    const stdio = ['ignore', 'pipe', 'ignore'];
    return execFileSync('git', args, { encoding: 'utf8', stdio }).trim();
  } catch {
    return null;
  }
}

/** @param {string} text @returns {string[]} */
function permissionsOf(text) {
  const manifest = JSON.parse(text);
  return Array.isArray(manifest.permissions) ? [...manifest.permissions].sort() : [];
}

function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      repo: { type: 'string' },
      zip: { type: 'string' },
      sha256: { type: 'string', default: '' },
      changelog: { type: 'string', default: 'CHANGELOG.md' },
      template: { type: 'string', default: '.github/RELEASE_TEMPLATE.md' },
      out: { type: 'string', default: 'RELEASE_NOTES.md' },
    },
  });
  const version = positionals[0] ?? '';
  if (!SEMVER.test(version)) throw new Error(`"${version}" is not a version like 1.2.3`);
  if (!values.repo || !values.zip) throw new Error('--repo and --zip are required');
  const tag = `v${version}`;

  const notes = extractSection(readFileSync(values.changelog, 'utf8'), version);

  // Previous release: the newest vX.Y.Z tag before this one (empty for the first release).
  const tags = (git(['tag', '--list', 'v[0-9]*.[0-9]*.[0-9]*', '--sort=-v:refname']) ?? '')
    .split('\n')
    .filter((t) => t !== '' && t !== tag);
  const older = tags.filter((t) => compare(t.slice(1), version) < 0);
  const previous = older[0] ?? null;

  const current = permissionsOf(readFileSync('manifest.json', 'utf8'));
  const old = previous ? git(['show', `${previous}:manifest.json`]) : null;
  const permissions = permissionLine(old ? permissionsOf(old) : null, current);

  const template = readFileSync(values.template, 'utf8');
  const fill = {
    notes,
    version,
    tag,
    repo: values.repo,
    zip: values.zip,
    sha256: values.sha256 || '(see the .sha256 file)',
    permissions,
    compare: previous
      ? `Full diff: https://github.com/${values.repo}/compare/${previous}...${tag}`
      : `All commits: https://github.com/${values.repo}/commits/${tag}`,
  };
  const text = template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    if (!(key in fill)) throw new Error(`The template uses an unknown field {{${key}}}`);
    return fill[/** @type {keyof typeof fill} */ (key)];
  });
  writeFileSync(values.out, text.endsWith('\n') ? text : `${text}\n`);
  console.log(
    `release notes for ${tag}: ${text.length} characters, previous release ${previous ?? 'none'}`,
  );
}

/** @param {string} a @param {string} b @returns {number} */
function compare(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return (x[i] ?? 0) - (y[i] ?? 0);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  try {
    main();
  } catch (error) {
    console.error(`release-notes: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
