// @ts-check
/**
 * Downloads for the finished capture (docs/contracts.md 7.9). The offscreen document makes blob URLs
 * (the service worker cannot: it has no `URL.createObjectURL`) and asks for them with `sw/download`.
 * This file starts the files one after the other with `chrome.downloads` and waits until each is
 * complete or interrupted.
 *
 * `chrome.downloads.download` with a blob URL of an extension page works (checked in Chromium 158:
 * a 60 MB file takes under a second). Chrome refuses a bad name with a rejected promise ("Invalid
 * filename"): that is `rejected`, and the caller may try another name.
 *
 * The `chrome.downloads.onChanged` listener exists only while the files are downloaded. The worker
 * is awake then (the message is open), and a listener at the top level would wake it for every
 * download of the browser.
 */

/** Longest wait for one file. A download that does not finish in this time counts as interrupted. */
export const DOWNLOAD_WAIT_MS = 120_000;

/**
 * Key in `chrome.storage.session` of the browser's ID for the first complete file of the last save
 * to Downloads. "Show in folder" reveals that file. It is a number: no name, no path and no image
 * data. The browser clears session storage when it closes.
 */
export const LAST_SAVE_DOWNLOAD_KEY = 'lastSaveDownloadId';

/** @typedef {Pick<chrome.storage.StorageArea, 'get' | 'set'>} SessionArea */

/**
 * Remembers the download ID of the last save. Never throws: a storage that fails only means that
 * "Show in folder" has nothing to reveal.
 * @param {number} id
 * @param {SessionArea} [area]  Default: chrome.storage.session.
 * @returns {Promise<void>}
 */
export async function rememberSaveDownload(id, area) {
  try {
    await (area ?? chrome.storage.session).set({ [LAST_SAVE_DOWNLOAD_KEY]: id });
  } catch {
    // Nothing to do.
  }
}

/**
 * The remembered download ID of the last save, or undefined. Never throws.
 * @param {SessionArea} [area]  Default: chrome.storage.session.
 * @returns {Promise<number | undefined>}
 */
export async function recallSaveDownload(area) {
  try {
    const got = await (area ?? chrome.storage.session).get(LAST_SAVE_DOWNLOAD_KEY);
    const id = got?.[LAST_SAVE_DOWNLOAD_KEY];
    return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : undefined;
  } catch {
    return undefined;
  }
}

/**
 * @typedef {Object} DownloadsApi  The part of `chrome.downloads` that this file uses.
 * @property {(options: any) => Promise<number>} download
 * @property {(query: any) => Promise<{ state?: string }[]>} search
 * @property {{ addListener: (fn: (delta: any) => void) => void, removeListener: (fn: (delta: any) => void) => void }} onChanged
 */

/**
 * @typedef {Object} DownloaderOptions
 * @property {DownloadsApi} [api]  Default: chrome.downloads.
 * @property {number} [waitMs]     Default: DOWNLOAD_WAIT_MS.
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]
 * @property {(handle: unknown) => void} [clearTimer]
 */

/**
 * @typedef {Object} DownloadOutcome
 * @property {number} saved        Files that are complete.
 * @property {number} rejected     Files that Chrome refused to start.
 * @property {number} interrupted  Files that started and did not finish (also a timeout).
 */

/**
 * @param {DownloaderOptions} [options]
 */
export function createDownloader(options = {}) {
  const waitMs = options.waitMs ?? DOWNLOAD_WAIT_MS;
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer =
    options.clearTimer ?? ((handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)));

  return Object.freeze({
    /**
     * Downloads the files in order. Never rejects.
     * @param {{ path: string, url: string }[]} files  Paths are relative to Downloads.
     * @param {(id: number) => void} [onComplete]  Called with the browser's ID of each file that
     *   is complete, in order. An error that it throws is ignored.
     * @returns {Promise<DownloadOutcome>}
     */
    async downloadFiles(files, onComplete) {
      const api = options.api ?? chrome.downloads;
      /** @type {Map<number, string>} Final state by download ID. */
      const finished = new Map();
      /** @type {Map<number, (state: string) => void>} */
      const waiting = new Map();
      /** @param {any} delta */
      const onChanged = (delta) => {
        const state = delta?.state?.current;
        if (typeof delta?.id !== 'number' || (state !== 'complete' && state !== 'interrupted')) return;
        finished.set(delta.id, state);
        waiting.get(delta.id)?.(state);
      };

      /** @type {DownloadOutcome} */
      const outcome = { saved: 0, rejected: 0, interrupted: 0 };

      /**
       * @param {number} id
       * @returns {Promise<string>}  'complete', 'interrupted' or 'timeout'.
       */
      async function stateOf(id) {
        const known = finished.get(id);
        if (known !== undefined) return known;
        try {
          const [item] = await api.search({ id });
          if (item?.state === 'complete' || item?.state === 'interrupted') return item.state;
        } catch {
          // The event below still tells.
        }
        return new Promise((resolve) => {
          const timer = setTimer(() => {
            waiting.delete(id);
            resolve('timeout');
          }, waitMs);
          waiting.set(id, (state) => {
            clearTimer(timer);
            waiting.delete(id);
            resolve(state);
          });
          // The download can have ended between the search and this line.
          const late = finished.get(id);
          if (late !== undefined) waiting.get(id)?.(late);
        });
      }

      api.onChanged.addListener(onChanged);
      try {
        for (const file of files) {
          /** @type {number} */
          let id;
          try {
            id = await api.download({
              url: file.url,
              filename: file.path,
              conflictAction: 'uniquify',
              saveAs: false,
            });
          } catch {
            outcome.rejected += 1;
            continue;
          }
          if ((await stateOf(id)) === 'complete') {
            outcome.saved += 1;
            try {
              onComplete?.(id);
            } catch {
              // The callback is the caller's business.
            }
          } else outcome.interrupted += 1;
        }
      } finally {
        api.onChanged.removeListener(onChanged);
      }
      return outcome;
    },
  });
}

/** The downloader that the service worker uses. */
export const downloader = createDownloader();
