// @ts-check
/**
 * The "Save to Pictures › Screenshots?" question on the toast. A capture that Spool saves to
 * Downloads because no folder is chosen asks it, on the first MAX_SAVE_ASKS such captures. The
 * worker decides, because it sees every finished capture and has the storage.
 *
 * Why a count and not one question: the toast can be missed (the user closes the tab, or looks
 * at the page and not at the corner), and a question that is spent when it is handed out is gone
 * for good. Three asks give the user three chances. After that, the caption of a toast that went
 * to Downloads keeps the link "Change".
 *
 * `chrome.storage.local` holds the number of asks (`saveFolderAsks`). Nothing else is stored, and
 * never image data. Version 1.0.0 stored a boolean (`firstSavePrompted`): `true` counts as one ask.
 * A storage failure counts as "do not ask": a missing question is better than a question at every
 * capture. These functions never throw.
 */

export const SAVE_ASKS_KEY = 'saveFolderAsks';
/** The key of version 1.0.0: `true` once the one question had been handed out. */
export const LEGACY_FIRST_SAVE_KEY = 'firstSavePrompted';
/** How many captures ask. */
export const MAX_SAVE_ASKS = 3;

/** @typedef {import('../shared/types.js').FinishSummary} FinishSummary */
/** @typedef {Pick<chrome.storage.StorageArea, 'get' | 'set'>} AskArea */

/**
 * True when this capture went to Downloads only because no folder is chosen. A folder that was
 * chosen but needs permission has its own question ("Reconnect"), and a folder write that failed
 * leaves a warning in the summary.
 * @param {FinishSummary} summary
 * @returns {boolean}
 */
export function savedToDownloadsByDefault(summary) {
  const { save } = summary;
  return (
    save.location === 'downloads' &&
    save.files > 0 &&
    save.needsPermission === false &&
    save.error === undefined &&
    summary.warnings.length === 0
  );
}

/**
 * The number of asks so far, from what the storage holds.
 * @param {Record<string, unknown> | undefined} got
 * @returns {number}
 */
export function asksSoFar(got) {
  const count = got?.[SAVE_ASKS_KEY];
  if (typeof count === 'number' && Number.isInteger(count) && count >= 0) return count;
  return got?.[LEGACY_FIRST_SAVE_KEY] === true ? 1 : 0;
}

/**
 * Two captures that finish together run these steps one after the other, so they cannot both
 * read the same count.
 * @type {Promise<unknown>}
 */
let queue = Promise.resolve();

/**
 * Takes one ask: true while fewer than MAX_SAVE_ASKS were taken, false after. The count goes up
 * before this returns.
 * @param {AskArea | undefined} [area]
 * @returns {Promise<boolean>}
 */
export function takeFirstSaveQuestion(area) {
  const run = queue.then(async () => {
    try {
      const store = area ?? chrome.storage.local;
      const asks = asksSoFar(await store.get([SAVE_ASKS_KEY, LEGACY_FIRST_SAVE_KEY]));
      if (asks >= MAX_SAVE_ASKS) return false;
      await store.set({ [SAVE_ASKS_KEY]: asks + 1 });
      return true;
    } catch {
      return false;
    }
  });
  queue = run;
  return run;
}

/**
 * Ends the question for good: the user chose Downloads on purpose. Never throws.
 * @param {AskArea | undefined} [area]
 * @returns {Promise<void>}
 */
export async function silenceSaveQuestion(area) {
  try {
    await (area ?? chrome.storage.local).set({ [SAVE_ASKS_KEY]: MAX_SAVE_ASKS });
  } catch {
    // The question can come back at the next capture. That is not a failure for the user.
  }
}

/**
 * Marks the summary of a capture with `save.askFolder` when it is one that asks. The toast shows
 * the question for that flag only. Returns the same summary.
 * @param {FinishSummary} summary
 * @param {AskArea | undefined} [area]
 * @returns {Promise<FinishSummary>}
 */
export async function withFirstSaveQuestion(summary, area) {
  if (savedToDownloadsByDefault(summary) && (await takeFirstSaveQuestion(area))) {
    summary.save.askFolder = true;
  }
  return summary;
}
