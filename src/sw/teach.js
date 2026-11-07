// @ts-check
/**
 * The toast of a long capture teaches the two keys that put it into a chat: Ctrl+V for the full
 * image, and the shelf key for the AI screenshots. A toast that hides after 6 s teaches nothing to
 * a person who looks at the page, so the toast of the first MAX_STICKY_LONG_TOASTS long captures
 * stays until the user dismisses it. Then it hides like any other toast. The worker decides,
 * because it sees every finished capture and has the storage.
 *
 * `chrome.storage.local` holds one number (`longToastsShown`). Nothing else is stored, and never
 * image data. A storage failure counts as "do not keep the toast": a toast that goes away by
 * itself is better than one that cannot be counted. These functions never throw.
 */

import { MAX_STICKY_LONG_TOASTS } from '../shared/constants.js';

export const LONG_TOASTS_KEY = 'longToastsShown';

/** @typedef {import('../shared/types.js').FinishSummary} FinishSummary */
/** @typedef {Pick<chrome.storage.StorageArea, 'get' | 'set'>} CountArea */

/**
 * @param {Record<string, unknown> | undefined} got
 * @returns {number}  What the storage holds, 0 for anything that is not a whole number.
 */
export function longToastsSoFar(got) {
  const count = got?.[LONG_TOASTS_KEY];
  return typeof count === 'number' && Number.isInteger(count) && count >= 0 ? count : 0;
}

/**
 * Two captures that finish together run these steps one after the other, so they cannot both
 * read the same count.
 * @type {Promise<unknown>}
 */
let queue = Promise.resolve();

/**
 * Takes one of the sticky toasts: true while fewer than MAX_STICKY_LONG_TOASTS were taken. The
 * count goes up before this returns.
 * @param {CountArea | undefined} [area]
 * @returns {Promise<boolean>}
 */
export function takeStickyToast(area) {
  const run = queue.then(async () => {
    try {
      const store = area ?? chrome.storage.local;
      const shown = longToastsSoFar(await store.get(LONG_TOASTS_KEY));
      if (shown >= MAX_STICKY_LONG_TOASTS) return false;
      await store.set({ [LONG_TOASTS_KEY]: shown + 1 });
      return true;
    } catch {
      return false;
    }
  });
  queue = run;
  return run;
}

/**
 * Marks the summary of a long capture with `teach` while the toast is still sticky. Returns the
 * same summary. A capture of one tile does not count.
 * @param {FinishSummary} summary
 * @param {CountArea | undefined} [area]
 * @returns {Promise<FinishSummary>}
 */
export async function withLongCaptureTeaching(summary, area) {
  if (summary.tileCount > 1 && (await takeStickyToast(area))) summary.teach = true;
  return summary;
}
