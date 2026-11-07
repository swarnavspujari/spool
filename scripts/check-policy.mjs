// @ts-check
/**
 * Policy check: manifest baseline and the security rules for src/ (see CONTRIBUTING.md).
 * Prints `file:line: message` for each finding and exits with code 1 if there is any.
 * Run it with `npm run policy`.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve, sep } from 'node:path';
import {
  MANIFEST_FILE,
  SCANNED_EXTENSIONS,
  checkManifest,
  checkPackagedFileTypes,
  checkSourceFile,
  formatFinding,
  isPackagedSourceFile,
} from './lib/policy.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const BASELINE_FILE = 'scripts/permissions-baseline.json';

/** @param {string} path Relative to the repository root. @returns {any} */
function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

/** @param {string} path Relative to the repository root. @returns {boolean} */
function isFile(path) {
  try {
    return statSync(join(ROOT, path)).isFile();
  } catch {
    return false;
  }
}

/** @param {string} dir Relative to the repository root. @returns {string[]} Files, sorted. */
function listFiles(dir) {
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

function main() {
  const findings = checkManifest(readJson(MANIFEST_FILE), readJson(BASELINE_FILE), isFile);
  const all = listFiles('src');
  findings.push(...checkPackagedFileTypes(all.filter(isPackagedSourceFile)));
  const sources = all.filter((file) => SCANNED_EXTENSIONS.includes(extname(file).toLowerCase()));
  for (const file of sources) {
    findings.push(...checkSourceFile(file, readFileSync(join(ROOT, file), 'utf8')));
  }

  if (findings.length === 0) {
    console.log(`policy: ok (manifest and ${sources.length} source files)`);
    return;
  }
  findings.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : a.line - b.line));
  for (const finding of findings) console.error(formatFinding(finding));
  console.error(`policy: ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
  process.exitCode = 1;
}

try {
  main();
} catch (error) {
  console.error(`policy: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
