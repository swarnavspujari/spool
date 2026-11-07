// @ts-check
/**
 * Clipboard fallback of the service worker (docs/contracts.md 7.1, step 3). The page agent writes
 * the clipboard itself, in the Done gesture. When that fails, the worker writes the full image
 * with `navigator.clipboard`, which extension workers have (checked in Chromium 158): with the
 * `clipboardWrite` permission an image write needs no focus, no gesture and no tab.
 *
 * It is feature-detected: a browser without the API gives `false`, never an exception. The worker
 * only writes. Spool never reads the clipboard (`npm run policy` forbids it).
 */

import { base64ToBytes } from '../render/util.js';

/**
 * @typedef {Object} ClipboardEnv
 * @property {{ clipboard?: { write?: (items: any[]) => Promise<void> } }} [navigator]
 * @property {any} [ClipboardItem]
 */

/**
 * Writes a PNG to the clipboard.
 * @param {string} pngBase64  Standard base64, without a data-URL prefix.
 * @param {ClipboardEnv} [env]  Default: the worker global scope.
 * @returns {Promise<boolean>}  True when the write worked.
 */
export async function writeImageToClipboard(pngBase64, env = /** @type {any} */ (globalThis)) {
  const write = env.navigator?.clipboard?.write;
  const Item = env.ClipboardItem;
  if (typeof write !== 'function' || typeof Item !== 'function') return false;
  try {
    const blob = new Blob([base64ToBytes(pngBase64)], { type: 'image/png' });
    await write.call(env.navigator?.clipboard, [new Item({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}
