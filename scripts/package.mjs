// @ts-check
/**
 * Builds the install package: dist/spool-<version>.zip and its .sha256 file.
 * The zip holds manifest.json, LICENSE, NOTICE.md, icons/*.png and src/ (without .d.ts files).
 * It fails when src/ has a file type that the policy check does not scan.
 * The zip is reproducible: set SOURCE_DATE_EPOCH (seconds) to choose the file timestamp.
 * Run it with `npm run package`.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { PATHS } from '../src/shared/constants.js';
import {
  MANIFEST_FILE,
  checkPackagedFileTypes,
  formatFinding,
  isPackagedSourceFile,
  manifestReferencedFiles,
} from './lib/policy.mjs';
import { DOS_EPOCH, createZip } from './lib/zip.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const DIST_DIR = join(ROOT, 'dist');
const FIXED_FILES = [MANIFEST_FILE, 'LICENSE', 'NOTICE.md'];
const VERSION_PATTERN = /^\d+(?:\.\d+){0,3}$/;

/** @param {string} path Relative to the repository root. @returns {any} */
function readJson(path) {
  return JSON.parse(readFileSync(join(ROOT, path), 'utf8'));
}

/** @param {string} dir Relative to the repository root. @returns {string[]} Files, sorted. */
function listFiles(dir) {
  if (!existsSync(join(ROOT, dir))) return [];
  return readdirSync(join(ROOT, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(ROOT, join(entry.parentPath, entry.name)).split(sep).join('/'))
    .sort();
}

/**
 * @param {{ version?: unknown }} manifest
 * @returns {string} The version, after it matches in manifest.json and package.json.
 */
function readVersion(manifest) {
  const manifestVersion = manifest.version;
  const packageVersion = readJson('package.json').version;
  if (manifestVersion !== packageVersion) {
    throw new Error(
      `manifest.json version (${manifestVersion}) and package.json version ` +
        `(${packageVersion}) differ`,
    );
  }
  if (typeof manifestVersion !== 'string' || !VERSION_PATTERN.test(manifestVersion)) {
    throw new Error(`"${manifestVersion}" is not a valid extension version`);
  }
  return manifestVersion;
}

/** @returns {string[]} Every file that goes into the zip, sorted. Missing ones are not listed. */
function listPackageFiles() {
  const files = [
    ...FIXED_FILES.filter((file) => existsSync(join(ROOT, file))),
    ...listFiles('icons').filter((file) => file.endsWith('.png')),
    ...listFiles('src').filter(isPackagedSourceFile),
  ];
  return files.sort();
}

/**
 * Fails when a file that the extension needs is not in the package: the fixed files, the
 * files that the manifest points to, and every path in PATHS.
 * @param {string[]} files The files of the package.
 * @param {Record<string, any>} manifest
 */
function assertRequiredFiles(files, manifest) {
  const included = new Set(files);
  const required = [
    ...FIXED_FILES,
    ...manifestReferencedFiles(manifest),
    ...Object.values(PATHS).flat(),
  ];
  const missing = [...new Set(required)].filter((file) => !included.has(file));
  if (missing.length > 0) {
    throw new Error(`these files are required but not in the package:\n  ${missing.join('\n  ')}`);
  }
}

/** @returns {Date} SOURCE_DATE_EPOCH, or 1980-01-01 (the earliest ZIP timestamp). */
function buildTimestamp() {
  const epoch = process.env.SOURCE_DATE_EPOCH;
  if (epoch === undefined || epoch === '') return DOS_EPOCH;
  if (!/^\d+$/.test(epoch)) throw new Error('SOURCE_DATE_EPOCH must be whole seconds');
  return new Date(Number(epoch) * 1000);
}

function main() {
  const manifest = readJson(MANIFEST_FILE);
  const version = readVersion(manifest);
  const files = listPackageFiles();
  const unscanned = checkPackagedFileTypes(files.filter((file) => file.startsWith('src/')));
  if (unscanned.length > 0) throw new Error(unscanned.map(formatFinding).join('\n  '));
  assertRequiredFiles(files, manifest);

  const entries = files.map((name) => ({ name, data: readFileSync(join(ROOT, name)) }));
  const zip = createZip(entries, { modified: buildTimestamp() });
  const sha256 = createHash('sha256').update(zip).digest('hex');

  const zipName = `spool-${version}.zip`;
  mkdirSync(DIST_DIR, { recursive: true });
  writeFileSync(join(DIST_DIR, zipName), zip);
  writeFileSync(join(DIST_DIR, `${zipName}.sha256`), `${sha256}  ${zipName}\n`);

  console.log(`dist/${zipName}: ${entries.length} files, ${zip.length} bytes`);
  console.log(`SHA-256: ${sha256}`);
}

try {
  main();
} catch (error) {
  console.error(`package: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
