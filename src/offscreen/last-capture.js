// @ts-check
/**
 * The last finished capture (docs/contracts.md 7.6): its outputs (the tile PNGs, the full PNG and
 * the summary), kept in the memory of the offscreen document for the toast, the shelf and the
 * result page. One capture at a time. A new capture replaces it.
 *
 * The outputs are `Blob`s. The browser owns Blob storage, like the slices of a session: the
 * extension writes nothing to any storage here (see "Memory" in docs/contracts.md section 4).
 *
 * It ends: when `set` replaces it, when `clear` is called (the next capture starts to finalize, or
 * a new frame needs the memory), and `ttlMs` after `set`. Reading does not extend the time.
 *
 * No browser dependency: time goes through `setTimer` and `clearTimer`, so tests run in Node.
 */

import { LAST_CAPTURE_TTL_MS } from '../shared/constants.js';
import { ERR, SpoolError } from '../shared/protocol.js';

/** @typedef {import('../shared/types.js').FinishSummary} FinishSummary */

/**
 * @typedef {Object} LastCaptureEntry
 * @property {string} sessionId
 * @property {number} tabId        The tab of the page agent that finished the capture.
 * @property {FinishSummary} summary
 * @property {Blob[]} tiles        Tile PNGs by tile index. Entry 0 may be the same Blob as `full`.
 * @property {Blob | null} full    The full PNG, or null when it could not be built.
 */

/**
 * @typedef {Object} LastCaptureOptions
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]   Default: setTimeout.
 * @property {(handle: unknown) => void} [clearTimer]               Default: clearTimeout.
 * @property {number} [ttlMs]                                       Default: LAST_CAPTURE_TTL_MS.
 * @property {() => void} [onChange]  Called after the capture was set or ended (a failing callback
 *                                    is ignored).
 */

const MSG_NONE = 'This capture has ended. Start a new capture.';
const MSG_UNKNOWN_PART = 'Unknown part.';
const MSG_NO_FULL = 'The full image could not be built. Use the AI screenshots.';
const MSG_FULL_TOO_LARGE = 'This image is too large to copy. Use the AI screenshots.';
const MSG_TILE_TOO_LARGE = 'This screenshot is too large to copy.';

/**
 * @param {LastCaptureOptions} [options]
 */
export function createLastCapture(options = {}) {
  const {
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
    ttlMs = LAST_CAPTURE_TTL_MS,
    onChange = () => {},
  } = options;

  /** @type {LastCaptureEntry | null} */
  let entry = null;
  /** @type {{ handle: unknown } | null} */
  let timer = null;

  function changed() {
    try {
      onChange();
    } catch {
      // A failing callback must not break the capture.
    }
  }

  function stopTimer() {
    if (timer === null) return;
    clearTimer(timer.handle);
    timer = null;
  }

  /** Drops the capture without a callback. @returns {boolean} True when one existed. */
  function drop() {
    stopTimer();
    const had = entry !== null;
    entry = null;
    return had;
  }

  return Object.freeze({
    /**
     * Keeps `next` as the last capture and ends the one before. Starts the time limit.
     * @param {LastCaptureEntry} next
     */
    set(next) {
      drop();
      entry = next;
      /** @type {{ handle: unknown }} */
      const t = { handle: null };
      t.handle = setTimer(() => {
        // A timer that was replaced or stopped does nothing, also if it had already fired.
        if (timer === t && drop()) changed();
      }, ttlMs);
      timer = t;
      changed();
    },

    /** Ends the last capture. Does nothing when there is none. */
    clear() {
      if (drop()) changed();
    },

    /** Replaces the summary of the current capture (the save step finished). @param {FinishSummary} summary */
    setSummary(summary) {
      if (entry !== null && entry.summary.sessionId === summary.sessionId) entry.summary = summary;
    },

    /** @returns {boolean} */
    has() {
      return entry !== null;
    },

    /** @returns {LastCaptureEntry | null} The last capture of any session, for the shelf. */
    latest() {
      return entry;
    },

    /**
     * The last capture when it is the capture of this session (and of this tab, when `tabId` is
     * given). Else E_SESSION_NOT_FOUND. A session of another tab looks like an unknown one.
     * @param {string} sessionId
     * @param {number} [tabId]
     * @returns {LastCaptureEntry}
     */
    require(sessionId, tabId) {
      if (entry === null || entry.sessionId !== sessionId || (tabId !== undefined && entry.tabId !== tabId)) {
        throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_NONE);
      }
      return entry;
    },

    /**
     * Bytes that the outputs hold. A Blob that is in the list twice counts once.
     * @returns {number}
     */
    bytes() {
      if (entry === null) return 0;
      const blobs = new Set(entry.tiles);
      if (entry.full !== null) blobs.add(entry.full);
      let total = 0;
      for (const blob of blobs) total += blob.size;
      return total;
    },
  });
}

/**
 * The Blob of one output: a tile by index, or the full image. Fails with E_BAD_MESSAGE for a tile
 * that does not exist, E_INTERNAL when the full image was not built, and E_SESSION_TOO_LARGE when
 * the Blob is over `maxBytes` (it cannot travel in one message).
 * @param {LastCaptureEntry} entry
 * @param {number | 'full'} item
 * @param {number} maxBytes
 * @returns {Blob}
 */
export function pickOutput(entry, item, maxBytes) {
  if (item === 'full') {
    if (entry.full === null) throw new SpoolError(ERR.INTERNAL, MSG_NO_FULL);
    if (entry.full.size > maxBytes) throw new SpoolError(ERR.SESSION_TOO_LARGE, MSG_FULL_TOO_LARGE);
    return entry.full;
  }
  const tile = Number.isSafeInteger(item) ? entry.tiles[item] : undefined;
  if (tile === undefined) throw new SpoolError(ERR.BAD_MESSAGE, MSG_UNKNOWN_PART);
  if (tile.size > maxBytes) throw new SpoolError(ERR.SESSION_TOO_LARGE, MSG_TILE_TOO_LARGE);
  return tile;
}
