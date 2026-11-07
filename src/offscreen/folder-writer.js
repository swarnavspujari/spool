// @ts-check
/**
 * Writes the files of a finished capture into the folder that the user chose (docs/contracts.md
 * 7.3), with the File System Access API. It gets a `FileSystemDirectoryHandle` with write access;
 * it never asks for permission (only an extension page can, in a click).
 *
 * The API objects are used through three calls only (`getDirectoryHandle`, `getFileHandle` and
 * `createWritable`), so unit tests run it with fakes and the browser test with an OPFS directory.
 *
 * A name that exists is never replaced: `pickFreeBase` adds " (2)", " (3)" ... to the base name
 * until no file or folder of this capture exists. A write goes through `createWritable`, which
 * keeps the old state until `close()`, so a failed write leaves no half file under the final name.
 */

/** @typedef {import('../lib/names.js').CaptureFile} CaptureFile */

/** @typedef {CaptureFile & { blob: Blob }} CaptureFileData */

/** Most names that `pickFreeBase` tries. */
export const MAX_NAME_TRIES = 100;

/**
 * @param {unknown} e
 * @param {string} name  Error name, for example 'NotFoundError'.
 * @returns {boolean}
 */
function isDomError(e, name) {
  return typeof e === 'object' && e !== null && /** @type {{ name?: unknown }} */ (e).name === name;
}

/**
 * True when a file or a folder exists at the path (relative to `root`).
 * @param {FileSystemDirectoryHandle} root
 * @param {string[]} path  Folder names, then the name of a file or a folder.
 * @returns {Promise<boolean>}
 */
async function pathExists(root, path) {
  /** @type {FileSystemDirectoryHandle} */
  let dir = root;
  for (const [i, name] of path.entries()) {
    const isLast = i === path.length - 1;
    try {
      if (isLast) {
        try {
          await dir.getFileHandle(name);
          return true;
        } catch (e) {
          if (isDomError(e, 'NotFoundError')) {
            await dir.getDirectoryHandle(name);
            return true;
          }
          if (isDomError(e, 'TypeMismatchError')) return true; // It is a folder.
          throw e;
        }
      }
      dir = await dir.getDirectoryHandle(name);
    } catch (e) {
      if (isDomError(e, 'NotFoundError')) return false;
      if (isDomError(e, 'TypeMismatchError')) return true; // A file stands where a folder goes.
      throw e;
    }
  }
  return false;
}

/**
 * The first base name for which this capture writes no name that exists: `wanted`, then
 * `wanted (2)`, `wanted (3)` ... A file that goes into the tiles folder counts as its folder.
 * @param {FileSystemDirectoryHandle} root
 * @param {string} wanted
 * @param {(base: string) => CaptureFile[]} makeFiles  The files for one base name.
 * @returns {Promise<string>}
 */
export async function pickFreeBase(root, wanted, makeFiles) {
  for (let n = 1; n <= MAX_NAME_TRIES; n += 1) {
    const base = n === 1 ? wanted : `${wanted} (${n})`;
    const claims = new Map();
    for (const file of makeFiles(base)) {
      const claim = file.path.length > 1 ? file.path.slice(0, -1) : file.path;
      claims.set(claim.join('/'), claim);
    }
    let free = true;
    for (const claim of claims.values()) {
      if (await pathExists(root, claim)) {
        free = false;
        break;
      }
    }
    if (free) return base;
  }
  throw new Error('No free name in the folder.');
}

/**
 * Writes the files, one after the other. Throws at the first failure (the files before it stay).
 * @param {FileSystemDirectoryHandle} root
 * @param {CaptureFileData[]} files
 * @param {{ written: number }} [progress]  Counts the files that are complete. It is still right
 *   when this call throws, so the caller can say how many files stay in the folder.
 * @returns {Promise<number>}  Files written.
 */
export async function writeFiles(root, files, progress = { written: 0 }) {
  let written = 0;
  for (const file of files) {
    /** @type {FileSystemDirectoryHandle} */
    let dir = root;
    for (const name of file.path.slice(0, -1)) {
      dir = await dir.getDirectoryHandle(name, { create: true });
    }
    const fileName = file.path[file.path.length - 1] ?? '';
    const handle = await dir.getFileHandle(fileName, { create: true });
    const writable = await handle.createWritable();
    try {
      await writable.write(file.blob);
      await writable.close();
    } catch (e) {
      await writable.abort().catch(() => undefined);
      throw e;
    }
    written += 1;
    progress.written = written;
  }
  return written;
}

/**
 * True for the errors that mean "the browser has not given write access (now)".
 * @param {unknown} e
 * @returns {boolean}
 */
export function isAccessError(e) {
  return isDomError(e, 'NotAllowedError') || isDomError(e, 'SecurityError');
}

/**
 * True for "the folder is gone" (deleted, renamed, or on a drive that is not there). A write goes
 * through folders that it makes itself, so this error can only come from the chosen folder.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isMissingError(e) {
  return isDomError(e, 'NotFoundError');
}
