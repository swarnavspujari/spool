// @ts-check
/**
 * The rules of the lock file check (see check-lockfile.mjs). They are a pure function, so a unit
 * test can run them (test/unit/lockfile-rules.test.js).
 *
 * Every package in a lock file (version 3) must
 *  - come from the registry https://registry.npmjs.org/ (no git URL, no other host, no tarball
 *    on disk, no link to a folder),
 *  - have a `resolved` URL that is exactly the tarball of ITS OWN name and version on that
 *    registry: https://registry.npmjs.org/<name>/-/<basename>-<version>.tgz. The name comes from
 *    the path in the lock file (`node_modules/@scope/name`), not from a field of the entry,
 *  - have an `integrity` value that is one sha512 hash, and
 *  - not be an alias (an entry with a `name` that differs from its path). An alias lets a lock
 *    file install the tarball of one package under the name of another.
 *
 * Why the URL must match the path: the integrity value only says that the tarball has not
 * changed since the lock file was written. It does not say that the tarball belongs to the package
 * that the path names. `npm audit signatures` checks the signature of the package that
 * `package.json` and the install tree name, and it does not compare the installed hash with the
 * registry. A lock file whose entry `node_modules/typescript` points to the tarball of another
 * package would pass both checks without this rule.
 */

export const REGISTRY = 'https://registry.npmjs.org/';

/** One sha512 hash in the format of Subresource Integrity: 64 bytes in base64 (86 + "=="). */
const SHA512_INTEGRITY = /^sha512-[A-Za-z0-9+/]{86}==$/;

/** The versions that the registry has: SemVer, with a pre-release and build part. */
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** A package name as npm accepts it: `name` or `@scope/name`, in lower case, no path tricks. */
const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*$/;

const MODULES = 'node_modules/';

/**
 * The name of the package that a path of the lock file installs: the part after the LAST
 * `node_modules/`. Null when the path is not below a `node_modules` folder.
 * @param {string} path  For example `node_modules/a/node_modules/@types/node`.
 * @returns {string | null}  `@types/node` for that path.
 */
export function packageNameOfPath(path) {
  const at = path.lastIndexOf(MODULES);
  if (at < 0 || (at > 0 && path[at - 1] !== '/')) return null;
  const name = path.slice(at + MODULES.length);
  return PACKAGE_NAME.test(name) ? name : null;
}

/**
 * The tarball URL that the registry uses for a version of a package. The file name has the name
 * without the scope: `@types/node` 1.2.3 is `@types/node/-/node-1.2.3.tgz`.
 * @param {string} name     `lodash` or `@types/node`.
 * @param {string} version  `1.2.3`.
 * @returns {string}
 */
export function expectedResolved(name, version) {
  const base = name.slice(name.lastIndexOf('/') + 1);
  return `${REGISTRY}${name}/-/${base}-${version}.tgz`;
}

/**
 * Checks the packages of a parsed lock file.
 * @param {unknown} lock  The parsed `package-lock.json`.
 * @returns {{ findings: string[], installScripts: string[], count: number }}
 *   `count`: packages checked (the root project is not one). `installScripts`: paths of packages
 *   that declare an install script (a notice, not a finding).
 */
export function checkLockfile(lock) {
  const root = /** @type {Record<string, any>} */ (typeof lock === 'object' && lock !== null ? lock : {});
  /** @type {Record<string, any>} */
  const packages = typeof root.packages === 'object' && root.packages !== null ? root.packages : {};
  /** @type {string[]} */
  const findings = [];
  /** @type {string[]} */
  const installScripts = [];
  let count = 0;

  for (const [path, entry] of Object.entries(packages)) {
    if (path === '') continue; // The root project.
    count += 1;
    const info = /** @type {Record<string, any>} */ (typeof entry === 'object' && entry !== null ? entry : {});
    if (info.link === true) {
      findings.push(`${path}: is a link (a local folder), not a registry package`);
      continue;
    }

    const name = packageNameOfPath(path);
    if (name === null) {
      findings.push(`${path}: is not a package path (node_modules/<name>)`);
      continue;
    }
    if (info.name !== undefined && info.name !== name) {
      findings.push(
        `${path}: is an alias for ${JSON.stringify(info.name)}. ` +
          `Aliases can install one package under the name of another`,
      );
    }
    const versionOk = typeof info.version === 'string' && SEMVER.test(info.version);
    if (!versionOk) {
      findings.push(`${path}: version is ${JSON.stringify(info.version)}, not a version number`);
    }
    if (typeof info.resolved !== 'string' || !info.resolved.startsWith(REGISTRY)) {
      findings.push(`${path}: resolved is ${JSON.stringify(info.resolved)}, not a URL of ${REGISTRY}`);
    } else if (versionOk) {
      const expected = expectedResolved(name, info.version);
      if (info.resolved !== expected) {
        findings.push(
          `${path}: resolved is ${JSON.stringify(info.resolved)}, expected ${JSON.stringify(expected)} ` +
            `(the tarball of ${name} ${info.version})`,
        );
      }
    }
    if (typeof info.integrity !== 'string' || !SHA512_INTEGRITY.test(info.integrity)) {
      findings.push(`${path}: integrity is ${JSON.stringify(info.integrity)}, not one sha512 value`);
    }
    if (info.hasInstallScript === true) installScripts.push(path);
  }
  if (count === 0) findings.push('no packages found');
  return { findings, installScripts, count };
}
