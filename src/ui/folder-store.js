// @ts-check
/**
 * The chosen save folder (docs/contracts.md section 7.5). The options page and the offscreen
 * document use it. IndexedDB holds the directory handle and the names of the folders below it,
 * never image data. This is the one file in src/ that may use IndexedDB (`npm run policy`).
 *
 * The save target is a handle plus a `subPath`: the user picks Pictures, and Spool writes into
 * `Pictures/Screenshots`. The browser grants access to the picked folder and everything below it,
 * so the picked handle stays the one that is stored and the sub folder is created again when it
 * is missing. A handle that was stored without a `subPath` (version 1.0.0) has the path `[]`: the
 * picked folder itself, as before.
 *
 * The page that picks the folder is an extension page, in a click. The offscreen document only
 * reads the target and the permission state (`getSaveTarget`, `folderPermission`). It never asks
 * for permission: `requestFolderPermission` needs a click, and only the options page and the
 * result page have one.
 *
 * `getSaveFolder`, `getSaveTarget` and `folderPermission` never throw. The pipeline treats a
 * failure as "no folder". The functions that change something (`setSaveFolder`, `clearSaveFolder`,
 * `pickSaveFolder`, `chooseScreenshotsFolder`) do throw, so the options page can tell the user.
 *
 * `createFolderStore` takes its environment as arguments, so Node tests can use a fake
 * IndexedDB and fake handles. The named exports use the real ones.
 */

import { sanitizePathSegment } from '../lib/names.js';
import { DEFAULT_SUBFOLDER, MAX_SUBPATH_SEGMENTS } from '../shared/constants.js';

const DB_NAME = 'spool-folder';
const DB_VERSION = 1;
const STORE = 'handles';
const KEY = 'saveFolder';
const SUBPATH_KEY = 'saveSubPath';
/** Longest folder name in `subPath`, in characters. */
const SUBPATH_SEGMENT_MAX = 60;

/**
 * The arguments of `showDirectoryPicker` for "Choose another folder". The id makes the browser
 * remember the last folder. `startIn: 'pictures'` opens the picker in the Pictures folder.
 */
export const PICKER_OPTIONS = Object.freeze({
  id: 'spool-shots',
  mode: 'readwrite',
  startIn: 'pictures',
});

/**
 * The arguments for "Save to Pictures › Screenshots". Another id than `PICKER_OPTIONS`: the
 * remembered folder of an id replaces `startIn`, and this picker must always open in Pictures.
 */
export const SETUP_PICKER_OPTIONS = Object.freeze({
  id: 'spool-pictures',
  mode: 'readwrite',
  startIn: 'pictures',
});

/** @typedef {'granted' | 'prompt' | 'denied'} FolderPermission */

/** @typedef {{ id: string, mode: string, startIn: string }} PickerOptions */

/**
 * Where Spool writes: the handle that the user picked, and the folders below it (at most
 * MAX_SUBPATH_SEGMENTS, each a clean name). `[]` means the handle itself.
 * @typedef {Object} SaveTarget
 * @property {FileSystemDirectoryHandle} handle
 * @property {string[]} subPath
 */

/**
 * @typedef {Object} FolderStoreEnv
 * @property {IDBFactory} [indexedDB]  The default is the real one, read at the time of the call.
 * @property {(value: unknown) => boolean} [isHandle]  Tells a directory handle from any other
 *   value. The default checks `instanceof FileSystemDirectoryHandle`.
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isDirectoryHandle(value) {
  return (
    typeof FileSystemDirectoryHandle !== 'undefined' &&
    value instanceof FileSystemDirectoryHandle &&
    value.kind === 'directory'
  );
}

/**
 * @param {unknown} state
 * @returns {FolderPermission}
 */
function toPermission(state) {
  return state === 'granted' || state === 'denied' ? state : 'prompt';
}

/**
 * A stored or given `subPath` as a safe list of folder names. A value that is not a list of at
 * most MAX_SUBPATH_SEGMENTS names that survive `sanitizePathSegment` unchanged gives `[]`: a
 * damaged value must never move the files to another place than the one that the user chose.
 * @param {unknown} value
 * @returns {string[]}
 */
export function cleanSubPath(value) {
  if (!Array.isArray(value) || value.length > MAX_SUBPATH_SEGMENTS) return [];
  /** @type {string[]} */
  const out = [];
  for (const segment of value) {
    const clean = sanitizePathSegment(segment, SUBPATH_SEGMENT_MAX, '');
    if (clean === '' || clean !== segment) return [];
    out.push(clean);
  }
  return out;
}

/**
 * The folder at the end of `subPath` below `root`. It makes each folder that is missing, so a
 * deleted or renamed `Screenshots` is made again on the next save, and the call also proves
 * that the browser lets Spool write. Throws what the browser throws: `NotAllowedError` without
 * write access, `NotFoundError` when `root` itself is gone.
 * @param {FileSystemDirectoryHandle} root
 * @param {readonly string[]} subPath
 * @returns {Promise<FileSystemDirectoryHandle>}
 */
export async function ensureSubPath(root, subPath) {
  /** @type {FileSystemDirectoryHandle} */
  let dir = root;
  for (const name of subPath) {
    dir = await dir.getDirectoryHandle(name, { create: true });
  }
  return dir;
}

/**
 * @param {FolderStoreEnv} [env]
 */
export function createFolderStore(env = {}) {
  const isHandle = env.isHandle ?? isDirectoryHandle;

  /** @returns {Promise<IDBDatabase>} */
  function openDb() {
    return new Promise((resolve, reject) => {
      const factory = env.indexedDB ?? globalThis.indexedDB;
      if (!factory) {
        reject(new Error('IndexedDB is not available.'));
        return;
      }
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        request.result.createObjectStore(STORE);
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error('IndexedDB failed.'));
      request.onblocked = () => reject(new Error('IndexedDB is blocked.'));
    });
  }

  /**
   * Runs the requests of `work` in one transaction and waits until the transaction is complete
   * (for a write, that is when every value is stored: all of them or none). Gives the results of
   * the requests, in order. The database is closed in every case.
   * @param {IDBTransactionMode} mode
   * @param {(store: IDBObjectStore) => IDBRequest[]} work
   * @returns {Promise<unknown[]>}
   */
  async function withStore(mode, work) {
    const db = await openDb();
    try {
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(STORE, mode);
        const requests = work(transaction.objectStore(STORE));
        /** @type {unknown[]} */
        const results = requests.map(() => undefined);
        requests.forEach((request, i) => {
          request.onsuccess = () => {
            results[i] = request.result;
          };
        });
        transaction.oncomplete = () => resolve(results);
        transaction.onerror = () =>
          reject(transaction.error ?? requests[0]?.error ?? new Error('IndexedDB failed.'));
        transaction.onabort = () =>
          reject(transaction.error ?? new Error('IndexedDB stopped the change.'));
      });
    } finally {
      db.close();
    }
  }

  /**
   * The folder to write in: the picked handle and its `subPath`, from one transaction. A handle
   * without a stored `subPath` gives `[]`. Null when there is no folder, the stored value is
   * not a handle, or the database fails. Never throws.
   * @returns {Promise<SaveTarget | null>}
   */
  async function getSaveTarget() {
    try {
      const [value, path] = await withStore('readonly', (store) => [
        store.get(KEY),
        store.get(SUBPATH_KEY),
      ]);
      return isHandle(value)
        ? { handle: /** @type {FileSystemDirectoryHandle} */ (value), subPath: cleanSubPath(path) }
        : null;
    } catch {
      return null;
    }
  }

  return {
    getSaveTarget,

    /**
     * The picked folder, or null when there is none, the stored value is not a handle, or the
     * database fails. Never throws. Use `getSaveTarget` to write: it adds the sub folders.
     * @returns {Promise<FileSystemDirectoryHandle | null>}
     */
    async getSaveFolder() {
      return (await getSaveTarget())?.handle ?? null;
    },

    /**
     * Stores the handle and its `subPath`, in place of an earlier target, in one transaction.
     * A `subPath` that is not valid is refused (the page decides it, never the user's input).
     * @param {FileSystemDirectoryHandle} handle
     * @param {readonly string[]} [subPath]
     * @returns {Promise<void>}
     */
    async setSaveFolder(handle, subPath = []) {
      if (!isHandle(handle)) throw new TypeError('The save folder must be a directory handle.');
      const clean = cleanSubPath(subPath);
      if (clean.length !== subPath.length) throw new TypeError('The sub folders are not valid.');
      await withStore('readwrite', (store) => [
        store.put(handle, KEY),
        store.put(clean, SUBPATH_KEY),
      ]);
    },

    /**
     * Forgets the folder and its sub folders. Spool then saves to Downloads.
     * @returns {Promise<void>}
     */
    async clearSaveFolder() {
      await withStore('readwrite', (store) => [store.delete(KEY), store.delete(SUBPATH_KEY)]);
    },
  };
}

const store = createFolderStore();

/** @returns {Promise<FileSystemDirectoryHandle | null>} */
export function getSaveFolder() {
  return store.getSaveFolder();
}

/** @returns {Promise<SaveTarget | null>} */
export function getSaveTarget() {
  return store.getSaveTarget();
}

/**
 * @param {FileSystemDirectoryHandle} handle
 * @param {readonly string[]} [subPath]
 * @returns {Promise<void>}
 */
export function setSaveFolder(handle, subPath = []) {
  return store.setSaveFolder(handle, subPath);
}

/** @returns {Promise<void>} */
export function clearSaveFolder() {
  return store.clearSaveFolder();
}

/**
 * The permission state of a folder, without a prompt. Never throws: a handle that the browser
 * cannot query (for example a folder that is gone) counts as 'denied'.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<FolderPermission>}
 */
export async function folderPermission(handle) {
  try {
    return toPermission(
      await /** @type {any} */ (handle).queryPermission({ mode: 'readwrite' }),
    );
  } catch {
    return 'denied';
  }
}

/**
 * Whether the folder is still there. The browser keeps the permission of a folder by its path, so a
 * folder that was deleted or moved can still read as 'granted'. Reading its first entry is the
 * check: only a `NotFoundError` says that the folder is gone, and any other failure (no read
 * access, an empty folder) does not. Never throws. Call it when the permission is 'granted'.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<boolean>}
 */
export async function folderExists(handle) {
  try {
    await /** @type {any} */ (handle).values()[Symbol.asyncIterator]().next();
    return true;
  } catch (e) {
    return nameOfError(e) !== 'NotFoundError';
  }
}

/** @param {unknown} e @returns {string} */
function nameOfError(e) {
  return typeof e === 'object' && e !== null ? String(/** @type {any} */ (e).name ?? '') : '';
}

/**
 * Asks for permission. This may show the browser prompt, so call it only in a click on an
 * extension page. Without a click the browser refuses; the answer is then the state as it is.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<FolderPermission>}
 */
export async function requestFolderPermission(handle) {
  try {
    return toPermission(
      await /** @type {any} */ (handle).requestPermission({ mode: 'readwrite' }),
    );
  } catch {
    return folderPermission(handle);
  }
}

/**
 * Opens the folder picker. Call it in a click handler, before any `await`: the picker needs the
 * click (user activation). `picker` is `showDirectoryPicker`; tests pass a fake one.
 * @param {(options: PickerOptions) => Promise<FileSystemDirectoryHandle>} [picker]
 * @param {PickerOptions} [options]
 * @returns {Promise<FileSystemDirectoryHandle | null>}  The folder, or null when the user
 *   closed the picker. Other failures throw.
 */
export async function pickSaveFolder(
  picker = /** @type {any} */ (globalThis).showDirectoryPicker,
  options = PICKER_OPTIONS,
) {
  if (typeof picker !== 'function') throw new Error('This browser cannot choose a folder.');
  try {
    return await picker.call(globalThis, options);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return null;
    throw error;
  }
}

/**
 * "Save to Pictures › Screenshots": opens the picker in Pictures and makes the `Screenshots`
 * folder in the folder that the user picks. Call it in a click handler, before any `await` (the
 * picker needs the click).
 *
 * The user picks Pictures, and Spool stores that handle with the sub folder `Screenshots`. A pick
 * that is already named Screenshots is used as it is: no `Screenshots/Screenshots`. Making the
 * folder at once proves that the browser lets Spool write, and shows the folder to the user.
 * @param {(options: PickerOptions) => Promise<FileSystemDirectoryHandle>} [picker]
 *   `showDirectoryPicker`; tests pass a fake one.
 * @returns {Promise<SaveTarget | null>}  Null when the user closed the picker. A blocked folder
 *   throws `SecurityError`, and a folder that cannot be written throws what the browser throws.
 */
export async function chooseScreenshotsFolder(
  picker = /** @type {any} */ (globalThis).showDirectoryPicker,
) {
  const handle = await pickSaveFolder(picker, SETUP_PICKER_OPTIONS);
  if (handle === null) return null;
  const name = typeof handle.name === 'string' ? handle.name : '';
  const subPath = name.toLowerCase() === DEFAULT_SUBFOLDER.toLowerCase() ? [] : [DEFAULT_SUBFOLDER];
  await ensureSubPath(handle, subPath);
  return { handle, subPath };
}
