// @ts-check
/**
 * What the buttons of the save location do: pick a folder, reconnect a folder that the browser
 * dropped, and use Downloads. The welcome page, the reconnect card and the Save location row share
 * them. Each action gives a plain result, and no DOM and no message: the page decides what to show.
 *
 * Every function that opens the picker or asks for permission needs the click that started it.
 * Call it first in the click handler, before any `await`: the browser checks the click when the
 * call starts, and a call that starts later is refused. Each of these functions starts that call
 * in its first statement.
 *
 * The browser calls are arguments (`deps`), so Node tests use fakes.
 */

import { silenceSaveQuestion } from '../sw/first-save.js';
import {
  chooseScreenshotsFolder,
  clearSaveFolder,
  ensureSubPath,
  folderPermission,
  pickSaveFolder,
  requestFolderPermission,
  setSaveFolder,
} from '../ui/folder-store.js';

/** @typedef {import('../ui/folder-store.js').SaveTarget} SaveTarget */
/** @typedef {import('../ui/folder-store.js').FolderPermission} FolderPermission */

/** The count of times that the user brought a folder back with the reconnect card. */
export const RECONNECTS_KEY = 'saveReconnects';

/**
 * @typedef {{ status: 'saved', handle: FileSystemDirectoryHandle, subPath: string[] }
 *   | { status: 'cancelled' } | { status: 'blocked' } | { status: 'no-picker' }
 *   | { status: 'failed' }} PickOutcome
 */

/**
 * @param {unknown} e
 * @returns {string}
 */
function nameOf(e) {
  return typeof e === 'object' && e !== null ? String(/** @type {any} */ (e).name ?? '') : '';
}

/**
 * Picks the folder and stores it. `pictures`: the picker opens in Pictures, and Spool makes the
 * `Screenshots` folder in it. `other`: the user picks the folder, and Spool writes in it.
 * @param {'pictures' | 'other'} kind
 * @param {{
 *   picker?: unknown,
 *   save?: (handle: FileSystemDirectoryHandle, subPath: string[]) => Promise<void>,
 * }} [deps]
 * @returns {Promise<PickOutcome>}
 */
export async function chooseFolder(kind, deps = {}) {
  const picker = deps.picker ?? /** @type {any} */ (globalThis).showDirectoryPicker;
  if (typeof picker !== 'function') return { status: 'no-picker' };
  try {
    /** @type {SaveTarget | null} */
    let target;
    if (kind === 'pictures') {
      target = await chooseScreenshotsFolder(/** @type {any} */ (picker));
    } else {
      const handle = await pickSaveFolder(/** @type {any} */ (picker));
      target = handle === null ? null : { handle, subPath: [] };
    }
    if (target === null) return { status: 'cancelled' };
    await (deps.save ?? setSaveFolder)(target.handle, target.subPath);
    return { status: 'saved', handle: target.handle, subPath: target.subPath };
  } catch (e) {
    return { status: nameOf(e) === 'SecurityError' ? 'blocked' : 'failed' };
  }
}

/**
 * @typedef {'granted' | 'prompt' | 'denied' | 'missing' | 'failed'} ReconnectOutcome
 *   `granted`: Spool can write again. `prompt` and `denied`: the user closed the prompt or said no.
 *   `missing`: the folder is gone. `failed`: another error.
 */

/**
 * Asks the browser for write access to the stored folder again, and makes the sub folder when it
 * is missing (which also shows that the picked folder still exists).
 * @param {SaveTarget} target
 * @param {{
 *   request?: (handle: FileSystemDirectoryHandle) => Promise<FolderPermission>,
 *   ensure?: (root: FileSystemDirectoryHandle, subPath: readonly string[]) => Promise<unknown>,
 * }} [deps]
 * @returns {Promise<ReconnectOutcome>}
 */
export async function reconnectFolder(target, deps = {}) {
  const asking = (deps.request ?? requestFolderPermission)(target.handle);
  const permission = await asking;
  if (permission !== 'granted') return permission;
  try {
    await (deps.ensure ?? ensureSubPath)(target.handle, target.subPath);
    return 'granted';
  } catch (e) {
    return nameOf(e) === 'NotFoundError' ? 'missing' : 'failed';
  }
}

/**
 * "Use Downloads": forgets the folder and ends the question on the toast (the user chose).
 * @param {{ clear?: () => Promise<void>, silence?: () => Promise<void> }} [deps]
 * @returns {Promise<void>}
 */
export async function useDownloads(deps = {}) {
  await (deps.clear ?? clearSaveFolder)();
  await (deps.silence ?? (() => silenceSaveQuestion()))();
}

/**
 * The permission of a stored target, for the page. A missing target is `prompt`: nothing to ask.
 * @param {SaveTarget | null} target
 * @param {(handle: FileSystemDirectoryHandle) => Promise<FolderPermission>} [read]
 * @returns {Promise<FolderPermission>}
 */
export async function permissionOf(target, read = folderPermission) {
  return target === null ? 'prompt' : read(target.handle);
}

/**
 * @typedef {Pick<chrome.storage.StorageArea, 'get' | 'set'>} CounterArea
 */

/**
 * How many times the reconnect card has brought the folder back. Never throws.
 * @param {CounterArea} [area]
 * @returns {Promise<number>}
 */
export async function readReconnects(area) {
  try {
    const got = await (area ?? chrome.storage.local).get(RECONNECTS_KEY);
    const n = got?.[RECONNECTS_KEY];
    return typeof n === 'number' && Number.isInteger(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

/**
 * Sets the count of reconnects. Never throws.
 * @param {number} count
 * @param {CounterArea} [area]
 * @returns {Promise<void>}
 */
export async function writeReconnects(count, area) {
  try {
    await (area ?? chrome.storage.local).set({ [RECONNECTS_KEY]: Math.max(0, Math.floor(count)) });
  } catch {
    // The card then shows its first text again. Nothing breaks.
  }
}
