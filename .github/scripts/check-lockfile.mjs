// @ts-check
/**
 * Checks package-lock.json before any package is installed.
 *
 * Usage: node .github/scripts/check-lockfile.mjs [path to package-lock.json]
 *
 * Every package in the lock file must
 *  - come from https://registry.npmjs.org/ (no git URL, no other host, no local tarball),
 *  - have a `resolved` URL that is the tarball of its own name and version on that registry
 *    (https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz, scoped names included), so an
 *    entry cannot point to the tarball of another package, and
 *  - have a sha512 integrity value.
 * The rules are in lockfile-rules.mjs (unit tests: test/unit/lockfile-rules.test.js).
 * A package that declares an install script is reported as a notice. CI installs with
 * --ignore-scripts, so such a script does not run, but a person must know that it exists.
 *
 * The script reads the file only. It uses no package and no network. Exit code 1 on a finding.
 */

import { readFileSync } from 'node:fs';

import { REGISTRY, checkLockfile } from './lockfile-rules.mjs';

/** @param {string} text @returns {string} Text for the data of a workflow command. */
function commandData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

function main() {
  const file = process.argv[2] ?? 'package-lock.json';
  const lock = JSON.parse(readFileSync(file, 'utf8'));
  if (lock.lockfileVersion !== 3) {
    throw new Error(`${file}: lockfileVersion is ${lock.lockfileVersion}, expected 3`);
  }
  const { findings, installScripts, count } = checkLockfile(lock);

  for (const path of installScripts) {
    console.log(`::notice title=Install script::${commandData(`${path} declares an install script. CI installs with --ignore-scripts, so it does not run.`)}`);
  }
  if (findings.length > 0) {
    for (const finding of findings) console.error(`::error title=package-lock.json::${commandData(finding)}`);
    console.error(`lockfile: ${findings.length} finding${findings.length === 1 ? '' : 's'}`);
    process.exitCode = 1;
    return;
  }
  console.log(`lockfile: ok (${count} packages, each from ${REGISTRY} with its own name and version, sha512 integrity)`);
}

try {
  main();
} catch (error) {
  console.error(`lockfile: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
