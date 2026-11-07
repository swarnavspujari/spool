// @ts-check
/**
 * Session store of the offscreen document. Holds the cropped slices (PNG blobs) and their seam
 * data in memory, for the time between the first captured frame and the moment the result page
 * has read everything. The store writes nothing to any storage.
 *
 * Blob data belongs to the browser. Under memory pressure, Chromium may page Blob data to a
 * temporary file in the profile folder (`blob_storage`), and it deletes the file when the Blob is
 * freed. The extension cannot prevent or observe this. So "in memory" means that the store
 * writes nothing itself, not that the data never reaches the disk. The limits below (per session,
 * in total, and for the image height) keep the amount small and bounded.
 *
 * The store has no browser dependency. Image work goes through `imageOps` (see ImageOps), and
 * time goes through `now`, `setTimer` and `clearTimer`, so unit tests run it in Node with fakes.
 *
 * Units: `...Px` is device px (pixels of a captureVisibleTab image). `yPx` is the top row of a
 * slice in the assembled image. It can be negative while a capture grows upward; the manifest
 * normalizes it so that the first slice starts at 0.
 *
 * Frames of one session run one at a time (a queue per session), so the seam of a frame is
 * always checked against every earlier frame, also when the caller does not wait for replies.
 *
 * Limits, all of them checked in addFrame:
 *  - maxBytes: stored PNG bytes of one session (E_SESSION_TOO_LARGE).
 *  - totalMaxBytes: stored PNG bytes of all sessions together (E_SESSION_TOO_LARGE).
 *  - maxHeightPx: height of the assembled image (E_SESSION_TOO_LARGE).
 *  - A frame must overlap or touch the rows that the session covers. A page that jumps its
 *    scroll position gets E_CAPTURE_FAILED instead of a frame far away from the others.
 *
 * Every session has one timer at a time. An unfinished session has the idle timer: it starts at
 * open, restarts at every frame and drops the session after `idleMs` without one. Finish stops
 * the idle timer and starts the finished timer, which drops the session after `ttlMs` if no
 * result page took it earlier. Drop and expiry stop the timer.
 */

import { contentYToPx, cropRectPx } from '../lib/geometry.js';
import { matchSeam } from '../lib/seam.js';
import { planTiles } from '../lib/tiles.js';
import {
  MAX_TOTAL_HEIGHT_PX,
  SEAM,
  SESSION_IDLE_MS,
  SESSION_MAX_BYTES,
  SESSION_TTL_MS,
  TOTAL_MAX_BYTES,
} from '../shared/constants.js';
import { ERR, SpoolError } from '../shared/protocol.js';

/** @typedef {import('../shared/types.js').Direction} Direction */
/** @typedef {import('../shared/types.js').FrameMeta} FrameMeta */
/** @typedef {import('../shared/types.js').IntakeResult} IntakeResult */
/** @typedef {import('../shared/types.js').SeamResult} SeamResult */
/** @typedef {import('../shared/types.js').SeamStatus} SeamStatus */
/** @typedef {import('../shared/types.js').SessionManifest} SessionManifest */
/** @typedef {import('../shared/types.js').TileTier} TileTier */

/**
 * Pixels to copy out of a decoded frame. Device px, inside the bitmap.
 * @typedef {Object} CropBox
 * @property {number} sx
 * @property {number} sy
 * @property {number} sw
 * @property {number} sh
 */

/**
 * What a crop produces.
 * @typedef {Object} CropResult
 * @property {Blob} blob              PNG of the cropped pixels.
 * @property {Uint8Array} signature   rowSignature() of the cropped pixels (`height * cols`).
 * @property {number} cols            Values per signature row.
 * @property {number} width
 * @property {number} height
 */

/**
 * A decoded capture. `close()` frees the pixels. The store always calls it.
 * @typedef {Object} DecodedFrame
 * @property {number} widthPx   Width of the whole bitmap.
 * @property {number} heightPx  Height of the whole bitmap.
 * @property {(box: CropBox) => Promise<CropResult>} crop
 * @property {() => void} close
 */

/**
 * Image work that needs browser APIs. The browser version is in image-ops.js.
 * @typedef {Object} ImageOps
 * @property {(dataUrl: string) => Promise<DecodedFrame>} decode
 */

/**
 * @typedef {Object} StoreOptions
 * @property {ImageOps} imageOps
 * @property {() => number} [now]                      Epoch ms. Default: Date.now.
 * @property {(fn: () => void, ms: number) => unknown} [setTimer]   Default: setTimeout.
 * @property {(handle: unknown) => void} [clearTimer]  Default: clearTimeout.
 * @property {() => void} [onEmpty]                    Called when the last session is removed.
 * @property {number} [maxBytes]                       Default: SESSION_MAX_BYTES.
 * @property {number} [totalMaxBytes]                  Stored bytes of all sessions together.
 *                                                     Default: TOTAL_MAX_BYTES.
 * @property {() => number} [heldBytes]                Bytes that the offscreen document holds
 *                                                     outside the store (the outputs of the last
 *                                                     capture). They count in `totalMaxBytes`.
 *                                                     Default: 0.
 * @property {() => void} [releaseHeld]                Frees `heldBytes`. The store calls it
 *                                                     before it refuses a frame for the total
 *                                                     limit. Default: does nothing.
 * @property {number} [maxHeightPx]                    Height of one assembled image, device px.
 *                                                     Default: MAX_TOTAL_HEIGHT_PX.
 * @property {number} [ttlMs]                          Time to live of a finished session.
 *                                                     Default: SESSION_TTL_MS.
 * @property {number} [idleMs]                         Time without a frame that drops an
 *                                                     unfinished session. Default: SESSION_IDLE_MS.
 */

/**
 * @typedef {Object} Slice
 * @property {number} index         Stable insertion number. It never changes.
 * @property {number} yPx           Top row in the assembled image.
 * @property {number} heightPx
 * @property {Blob} blob
 * @property {Uint8Array} signature
 * @property {number} cols
 * @property {SeamStatus} seamStatus
 */

/**
 * @typedef {Object} Session
 * @property {string} id
 * @property {number} tabId
 * @property {string} title
 * @property {string} sourceHost   Host name of the captured page, or ''.
 * @property {TileTier} tileTier
 * @property {number} createdAt
 * @property {number} scale        Device px per CSS px. 0 until the first frame.
 * @property {number} widthPx      0 until the first frame.
 * @property {Slice[]} slices      Sorted by yPx.
 * @property {number} nextIndex
 * @property {number} storedBytes
 * @property {boolean} finished
 * @property {{ handle: unknown } | null} idle  The timer that drops an unfinished session.
 * @property {{ handle: unknown } | null} ttl   The timer that drops a finished session.
 * @property {Promise<void>} queue  Tail of the work in progress. It never rejects.
 */

/** Largest difference between the zoom of two frames of one session. */
const SCALE_TOLERANCE = 0.01;
/** Largest difference (device px) between the crop width of a frame and the session width. */
const WIDTH_TOLERANCE_PX = 2;
/** Two slices closer than this (device px) with the same height are the same capture. */
const DUPLICATE_TOLERANCE_PX = 1;
/** Most part numbers that one warning lists. */
const MAX_PARTS_LISTED = 8;

const MSG_NOT_FOUND = 'Capture not found. Start a new capture.';
const MSG_FINISHED = 'This capture is finished.';
const MSG_NOT_FINISHED = 'This capture is not finished.';
const MSG_EMPTY = 'Nothing was captured.';
const MSG_ZOOM = 'Page zoom changed. Finish now to keep what you have.';
const MSG_TOO_LARGE = 'This capture is too large. Finish now to keep what you have.';
const MSG_MEMORY = 'This capture is using too much memory. Finish now to keep what you have.';
const MSG_MAX_LENGTH = 'The capture reached its maximum length. Finish now to keep what you have.';
const MSG_JUMP = 'The page moved too far. Finish now to keep what you have.';
const MSG_IMAGE = 'Could not read the captured image. Try again.';

/** @type {SeamResult} */
const SEAM_FIRST = Object.freeze({ status: 'first', shiftPx: 0, meanDiff: 0 });
/** @type {SeamResult} */
const SEAM_DUPLICATE = Object.freeze({ status: 'duplicate', shiftPx: 0, meanDiff: 0 });
/**
 * @type {SeamResult} A slice that touches the covered rows without overlapping one: nothing to
 * compare, so the worst value. (A slice that does not touch them is rejected.)
 */
const SEAM_NO_NEIGHBOUR = Object.freeze({ status: 'unmatched', shiftPx: 0, meanDiff: 255 });

/** @returns {SpoolError} */
function notFound() {
  return new SpoolError(ERR.SESSION_NOT_FOUND, MSG_NOT_FOUND);
}

/** @returns {SpoolError} */
function zoomError() {
  return new SpoolError(ERR.CAPTURE_FAILED, MSG_ZOOM);
}

/**
 * Keeps an error that the store throws on purpose. Any other failure of the image code becomes a
 * plain capture error (the original stays in `cause` for debugging).
 * @param {unknown} e
 * @returns {SpoolError}
 */
function imageError(e) {
  if (e instanceof SpoolError) return e;
  const error = new SpoolError(ERR.CAPTURE_FAILED, MSG_IMAGE);
  error.cause = e;
  return error;
}

/**
 * @param {SeamStatus} status
 * @param {number} shiftPx
 * @param {number} meanDiff
 * @returns {SeamResult}
 */
function seamResult(status, shiftPx, meanDiff) {
  return { status, shiftPx, meanDiff };
}

/**
 * Puts the slice into the list, keeping it sorted by yPx. Equal positions keep arrival order.
 * @param {Slice[]} slices
 * @param {Slice} slice
 */
function insertSorted(slices, slice) {
  let i = slices.length;
  while (i > 0 && slices[i - 1].yPx > slice.yPx) i--;
  slices.splice(i, 0, slice);
}

/**
 * Top, bottom and height of the assembled image. `slices` is sorted by yPx.
 * @param {Slice[]} slices
 * @returns {{ top: number, heightPx: number }}
 */
function measure(slices) {
  if (slices.length === 0) return { top: 0, heightPx: 0 };
  let bottom = -Infinity;
  for (const s of slices) bottom = Math.max(bottom, s.yPx + s.heightPx);
  const top = slices[0].yPx;
  return { top, heightPx: bottom - top };
}

/**
 * True when a slice at [yPx, yPx + heightPx) overlaps or touches the rows that the stored slices
 * cover. The first slice of a session always does. `slices` is sorted by yPx.
 *
 * The covered rows have no gap: every stored slice joined the rows that were covered before it
 * (this rule), and a seam correction moves a slice only to a place where it overlaps the slice
 * that it was compared with. So the union of the slices is one stretch from the top of the first
 * to the bottom of the lowest, and one comparison with that stretch is enough.
 * @param {Slice[]} slices
 * @param {number} yPx
 * @param {number} heightPx
 * @returns {boolean}
 */
function joinsCoveredRows(slices, yPx, heightPx) {
  if (slices.length === 0) return true;
  const { top, heightPx: covered } = measure(slices);
  return yPx <= top + covered && yPx + heightPx >= top;
}

/**
 * Height of the assembled image when a slice at [yPx, yPx + heightPx) is added.
 * @param {Slice[]} slices  Sorted by yPx.
 * @param {number} yPx
 * @param {number} heightPx
 * @returns {number}
 */
function heightWith(slices, yPx, heightPx) {
  if (slices.length === 0) return heightPx;
  const { top, heightPx: covered } = measure(slices);
  return Math.max(top + covered, yPx + heightPx) - Math.min(top, yPx);
}

/**
 * @param {Slice[]} slices
 * @param {number} yPx
 * @param {number} heightPx
 * @returns {boolean}
 */
function isDuplicate(slices, yPx, heightPx) {
  return slices.some(
    (s) => Math.abs(s.yPx - yPx) <= DUPLICATE_TOLERANCE_PX && s.heightPx === heightPx,
  );
}

/**
 * The stored slice that the new one is compared with. For 'initial' and 'down' it is the slice
 * above that overlaps the new one, for 'up' the slice below. When only the other side overlaps
 * (for example a 'down' frame that lands above all slices) that side is used and the roles swap.
 * Among several candidates on a side, the nearest one wins.
 * @param {Slice[]} slices
 * @param {Direction} direction
 * @param {number} yPx
 * @param {number} heightPx
 * @returns {{ slice: Slice, newIsLower: boolean } | null}
 */
function findNeighbour(slices, direction, yPx, heightPx) {
  const endPx = yPx + heightPx;
  /** @type {Slice | null} */
  let above = null;
  /** @type {Slice | null} */
  let below = null;
  for (const s of slices) {
    if (!(s.yPx < endPx && yPx < s.yPx + s.heightPx)) continue;
    if (s.yPx <= yPx) {
      if (above === null || s.yPx >= above.yPx) above = s;
    } else if (below === null || s.yPx < below.yPx) {
      below = s;
    }
  }
  if (direction === 'up') {
    if (below !== null) return { slice: below, newIsLower: false };
    return above !== null ? { slice: above, newIsLower: true } : null;
  }
  if (above !== null) return { slice: above, newIsLower: true };
  return below !== null ? { slice: below, newIsLower: false } : null;
}

/**
 * Finds the final position of a new slice by comparing it with its neighbour.
 * `shiftPx` of the result is the change applied to the new slice's yPx.
 * @param {Slice[]} slices
 * @param {Direction} direction
 * @param {{ yPx: number, heightPx: number, signature: Uint8Array, cols: number }} candidate
 * @returns {{ yPx: number, seam: SeamResult }}
 */
function placeSlice(slices, direction, candidate) {
  if (slices.length === 0) return { yPx: candidate.yPx, seam: SEAM_FIRST };
  const neighbour = findNeighbour(slices, direction, candidate.yPx, candidate.heightPx);
  if (neighbour === null) return { yPx: candidate.yPx, seam: SEAM_NO_NEIGHBOUR };
  const { slice, newIsLower } = neighbour;
  if (slice.cols !== candidate.cols) {
    return { yPx: candidate.yPx, seam: seamResult('unmatched', 0, 255) };
  }
  const upper = newIsLower ? slice : candidate;
  const lower = newIsLower ? candidate : slice;
  const match = matchSeam({
    upper: upper.signature,
    lower: lower.signature,
    cols: candidate.cols,
    upperHeight: upper.heightPx,
    lowerHeight: lower.heightPx,
    expectedOffset: lower.yPx - upper.yPx,
    maxShift: SEAM.maxShiftRows,
    minOverlap: SEAM.minOverlapRows,
    threshold: SEAM.threshold,
    maxRowDiff: SEAM.maxRowDiff,
    flatStdDev: SEAM.flatStdDev,
  });
  // The match says how far the lower slice sits below its expected place. A new lower slice
  // moves down by that much. A new upper slice moves up by it (0 - x avoids a negative zero).
  const shiftPx = newIsLower ? match.shift : 0 - match.shift;
  return {
    yPx: candidate.yPx + shiftPx,
    seam: seamResult(match.status, shiftPx, match.meanDiff),
  };
}

/**
 * @param {number[]} parts  1-based part numbers.
 * @returns {string}
 */
function listParts(parts) {
  const shown = parts.slice(0, MAX_PARTS_LISTED).map(String);
  const more = parts.length - shown.length;
  if (more > 0) return `${shown.join(', ')} and ${more} more`;
  if (shown.length <= 1) return shown.join('');
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

/**
 * Warnings for the result page, in plain English. Parts are numbered from 1 in the order of the
 * manifest (top to bottom). A join that could not be checked is a seam with status 'unmatched'
 * or 'ambiguous'.
 *
 * There is no warning for a gap (rows that no slice covers). addFrame rejects every frame that
 * would leave one (see joinsCoveredRows), so the stored slices never have a gap.
 * @param {Slice[]} slices  Sorted by yPx. Not empty.
 * @returns {string[]}
 */
function buildWarnings(slices) {
  /** @type {number[]} */
  const unchecked = [];
  slices.forEach((s, pos) => {
    if (s.seamStatus === 'unmatched' || s.seamStatus === 'ambiguous') unchecked.push(pos + 1);
  });
  if (unchecked.length === 0) return [];
  if (unchecked.length === 1) {
    return [`Spool could not verify 1 seam, near step ${unchecked[0]}. Check that area.`];
  }
  return [
    `Spool could not verify ${unchecked.length} seams, near steps ${listParts(unchecked)}. ` +
      'Check those areas.',
  ];
}

/**
 * Creates a session store.
 * Methods that wait for image work return a promise (addFrame, finish). The others
 * return at once. Every failure is a SpoolError.
 * @param {StoreOptions} options
 */
export function createSessionStore(options) {
  const {
    imageOps,
    now = () => Date.now(),
    setTimer = (fn, ms) => setTimeout(fn, ms),
    clearTimer = (handle) => clearTimeout(/** @type {ReturnType<typeof setTimeout>} */ (handle)),
    onEmpty = () => {},
    maxBytes = SESSION_MAX_BYTES,
    totalMaxBytes = TOTAL_MAX_BYTES,
    heldBytes = () => 0,
    releaseHeld = () => {},
    maxHeightPx = MAX_TOTAL_HEIGHT_PX,
    ttlMs = SESSION_TTL_MS,
    idleMs = SESSION_IDLE_MS,
  } = options;

  /** @type {Map<string, Session>} */
  const sessions = new Map();

  /**
   * @param {string} sessionId
   * @param {number} [tabId]  When given, the session must belong to this tab.
   * @returns {Session}
   */
  function requireSession(sessionId, tabId) {
    const session = sessions.get(sessionId);
    if (session === undefined || (tabId !== undefined && session.tabId !== tabId)) {
      throw notFound();
    }
    return session;
  }

  /**
   * @param {string} sessionId
   * @returns {Session}
   */
  function requireFinished(sessionId) {
    const session = requireSession(sessionId);
    if (!session.finished) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_NOT_FINISHED);
    return session;
  }

  /**
   * The manifest of a finished session.
   * @param {Session} session
   * @returns {SessionManifest}
   */
  function manifestOf(session) {
    const { slices } = session;
    if (slices.length === 0) throw new SpoolError(ERR.CAPTURE_FAILED, MSG_EMPTY);
    const { top, heightPx } = measure(slices);
    return {
      sessionId: session.id,
      title: session.title,
      sourceHost: session.sourceHost,
      createdAt: session.createdAt,
      widthPx: session.widthPx,
      totalHeightPx: heightPx,
      scale: session.scale,
      slices: slices.map((s) => ({
        index: s.index,
        yPx: s.yPx - top,
        heightPx: s.heightPx,
        seamStatus: s.seamStatus,
      })),
      warnings: buildWarnings(slices),
    };
  }

  /** @returns {number} Stored PNG bytes of all sessions together. */
  function totalStoredBytes() {
    let total = 0;
    for (const session of sessions.values()) total += session.storedBytes;
    return total;
  }

  /**
   * Throws when the session was removed, or finished, while the caller waited.
   * @param {Session} session
   */
  function assertOpen(session) {
    if (sessions.get(session.id) !== session) throw notFound();
    if (session.finished) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_FINISHED);
  }

  /**
   * Runs `task` after all earlier work of the session. The result is the task's own outcome.
   * @template T
   * @param {Session} session
   * @param {() => Promise<T>} task
   * @returns {Promise<T>}
   */
  function enqueue(session, task) {
    const run = session.queue.then(task);
    session.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  /** @param {Session} session */
  function clearIdleTimer(session) {
    if (session.idle === null) return;
    clearTimer(session.idle.handle);
    session.idle = null;
  }

  /**
   * Starts the idle timer of an unfinished session again.
   * @param {Session} session
   */
  function restartIdleTimer(session) {
    clearIdleTimer(session);
    /** @type {{ handle: unknown }} */
    const timer = { handle: null };
    timer.handle = setTimer(() => {
      // A timer that was replaced or stopped does nothing, also if it had already fired.
      if (session.idle === timer) expire(session);
    }, idleMs);
    session.idle = timer;
  }

  /** @param {Session} session */
  function removeSession(session) {
    clearIdleTimer(session);
    if (session.ttl !== null) {
      clearTimer(session.ttl.handle);
      session.ttl = null;
    }
    sessions.delete(session.id);
    // Let go of the blobs now, also when a caller still holds the session object.
    session.slices = [];
    session.storedBytes = 0;
  }

  /** Call after a removal. */
  function notifyIfEmpty() {
    if (sessions.size > 0) return;
    try {
      onEmpty();
    } catch {
      // A failing callback must not break the store.
    }
  }

  /**
   * @param {Session} session
   * @param {number} index  Stored slice index, or -1 for a duplicate.
   * @param {SeamResult} seam
   * @returns {IntakeResult}
   */
  function buildIntake(session, index, seam) {
    const { heightPx } = measure(session.slices);
    return {
      index,
      sliceCount: session.slices.length,
      widthPx: session.widthPx,
      totalHeightPx: heightPx,
      tileCount: planTiles(session.widthPx, heightPx, session.tileTier).length,
      seam,
      storedBytes: session.storedBytes,
    };
  }

  /**
   * Decodes, crops, checks the seam and stores one frame. Runs inside the session queue.
   * @param {Session} session
   * @param {string} dataUrl
   * @param {FrameMeta} meta
   * @returns {Promise<IntakeResult>}
   */
  async function intake(session, dataUrl, meta) {
    assertOpen(session);
    /** @type {DecodedFrame} */
    let frame;
    try {
      frame = await imageOps.decode(dataUrl);
    } catch (e) {
      throw imageError(e);
    }
    try {
      assertOpen(session);
      const first = session.widthPx === 0;
      const box = cropRectPx(meta.rect, meta.viewport, frame.widthPx, frame.heightPx);
      let { sx, sw } = box;
      if (!first) {
        const sameZoom = Math.abs(box.scale - session.scale) <= SCALE_TOLERANCE;
        const sameWidth =
          Math.abs(box.sw - session.widthPx) <= WIDTH_TOLERANCE_PX &&
          session.widthPx <= frame.widthPx;
        if (!sameZoom || !sameWidth) throw zoomError();
        sw = session.widthPx;
        sx = Math.min(box.sx, frame.widthPx - sw);
      }
      const scale = first ? box.scale : session.scale;
      const yPx = contentYToPx(meta.contentY, scale);
      if (isDuplicate(session.slices, yPx, box.sh)) {
        return buildIntake(session, -1, SEAM_DUPLICATE);
      }
      // A page can jump its scroll position (a script, a virtual list). A slice far from the
      // others would leave a gap and could make the image very tall. Refuse it, before the crop.
      if (!joinsCoveredRows(session.slices, yPx, box.sh)) {
        throw new SpoolError(ERR.CAPTURE_FAILED, MSG_JUMP);
      }

      /** @type {CropResult} */
      let crop;
      try {
        crop = await frame.crop({ sx, sy: box.sy, sw, sh: box.sh });
      } catch (e) {
        throw imageError(e);
      }
      assertOpen(session);
      // The checks and the store below run without an await in between, so two sessions cannot
      // pass the total limit together.
      if (session.storedBytes + crop.blob.size > maxBytes) {
        throw new SpoolError(ERR.SESSION_TOO_LARGE, MSG_TOO_LARGE);
      }
      if (totalStoredBytes() + heldBytes() + crop.blob.size > totalMaxBytes) {
        // The outputs of the last capture are the first to go: a new capture is worth more.
        if (heldBytes() > 0) releaseHeld();
        if (totalStoredBytes() + heldBytes() + crop.blob.size > totalMaxBytes) {
          throw new SpoolError(ERR.SESSION_TOO_LARGE, MSG_MEMORY);
        }
      }

      const placed = placeSlice(session.slices, meta.direction, {
        yPx,
        heightPx: crop.height,
        signature: crop.signature,
        cols: crop.cols,
      });
      // Checked at the final place: a seam correction can move the slice by a few rows.
      if (heightWith(session.slices, placed.yPx, crop.height) > maxHeightPx) {
        throw new SpoolError(ERR.SESSION_TOO_LARGE, MSG_MAX_LENGTH);
      }
      /** @type {Slice} */
      const slice = {
        index: session.nextIndex,
        yPx: placed.yPx,
        heightPx: crop.height,
        blob: crop.blob,
        signature: crop.signature,
        cols: crop.cols,
        seamStatus: placed.seam.status,
      };
      session.nextIndex += 1;
      insertSorted(session.slices, slice);
      session.storedBytes += crop.blob.size;
      if (first) {
        session.scale = scale;
        session.widthPx = sw;
      }
      return buildIntake(session, slice.index, placed.seam);
    } finally {
      frame.close();
    }
  }

  /**
   * Drops a session whose idle timer or finished timer ran out.
   * @param {Session} session The session that expires.
   */
  function expire(session) {
    if (sessions.get(session.id) !== session) return;
    removeSession(session);
    notifyIfEmpty();
  }

  return Object.freeze({
    /**
     * Starts a session and its idle timer. The same id and tab again keeps the session as it is
     * and only restarts the idle timer (a finished session has no idle timer).
     * @param {string} sessionId
     * @param {number} tabId
     * @param {string} title
     * @param {TileTier} tileTier
     * @param {string} [sourceHost]  Host name of the captured page. The worker reads it from the
     *   sender.
     */
    open(sessionId, tabId, title, tileTier, sourceHost = '') {
      const existing = sessions.get(sessionId);
      if (existing !== undefined) {
        if (existing.tabId !== tabId) throw notFound();
        if (!existing.finished) restartIdleTimer(existing);
        return;
      }
      /** @type {Session} */
      const session = {
        id: sessionId,
        tabId,
        title,
        sourceHost,
        tileTier,
        createdAt: now(),
        scale: 0,
        widthPx: 0,
        slices: [],
        nextIndex: 0,
        storedBytes: 0,
        finished: false,
        idle: null,
        ttl: null,
        queue: Promise.resolve(),
      };
      sessions.set(sessionId, session);
      restartIdleTimer(session);
    },

    /**
     * Crops a captured frame, checks its seam and stores it. Every frame of a known session of
     * this tab restarts the idle timer, also one that fails.
     * @param {string} sessionId
     * @param {number} tabId
     * @param {string} dataUrl
     * @param {FrameMeta} meta
     * @returns {Promise<IntakeResult>}
     */
    async addFrame(sessionId, tabId, dataUrl, meta) {
      const session = requireSession(sessionId, tabId);
      if (session.finished) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_FINISHED);
      restartIdleTimer(session);
      return enqueue(session, () => intake(session, dataUrl, meta));
    },

    /**
     * Closes the session for new frames, after the frames in progress. Stops the idle timer and
     * starts the timer of the finished session. Calling it again does nothing.
     * @param {string} sessionId
     * @param {number} tabId
     * @returns {Promise<void>}
     */
    async finish(sessionId, tabId) {
      const session = requireSession(sessionId, tabId);
      await enqueue(session, async () => {
        if (sessions.get(session.id) !== session) throw notFound();
        if (session.finished) return;
        session.finished = true;
        clearIdleTimer(session);
        session.ttl = { handle: setTimer(() => expire(session), ttlMs) };
      });
    },

    /**
     * Cancels a capture: removes an UNFINISHED session of this tab. Any other case does nothing
     * and gives no error: an unknown id, a session of another tab, a finished session (its
     * result page owns it, see release). So a cancel can be repeated, and a page that knows a
     * session id of another tab or of a finished session cannot remove it.
     * @param {string} sessionId
     * @param {number} tabId
     * @returns {{ remaining: number }}
     */
    drop(sessionId, tabId) {
      const session = sessions.get(sessionId);
      if (session !== undefined && session.tabId === tabId && !session.finished) {
        removeSession(session);
        notifyIfEmpty();
      }
      return { remaining: sessions.size };
    },

    /**
     * The result page has read a session: removes a FINISHED session (of any tab). Any other case
     * does nothing and gives no error: an unknown id, or an unfinished session (a capture that
     * is still running is not for the result page to remove). So a release can be repeated.
     * @param {string} sessionId
     * @returns {{ remaining: number }}
     */
    release(sessionId) {
      const session = sessions.get(sessionId);
      if (session !== undefined && session.finished) {
        removeSession(session);
        notifyIfEmpty();
      }
      return { remaining: sessions.size };
    },

    /**
     * Removes the unfinished sessions of a tab. Finished sessions stay for their result page.
     * @param {number} tabId
     * @returns {{ remaining: number }}
     */
    dropTab(tabId) {
      let removed = 0;
      for (const session of [...sessions.values()]) {
        if (session.tabId === tabId && !session.finished) {
          removeSession(session);
          removed += 1;
        }
      }
      if (removed > 0) notifyIfEmpty();
      return { remaining: sessions.size };
    },

    /** @returns {{ sessions: number }} */
    ping() {
      return { sessions: sessions.size };
    },

    /**
     * What the finalize step needs from a FINISHED session of this tab: its manifest, the tile
     * tier, and the PNG blob of every slice by `SliceInfo.index`. The blobs stay in the session
     * until `release`. A session of another tab, an unfinished one and an unknown one give
     * `E_SESSION_NOT_FOUND`; a session with no slice gives `E_CAPTURE_FAILED`.
     * @param {string} sessionId
     * @param {number} tabId
     * @returns {{ manifest: SessionManifest, tileTier: TileTier, blobs: Map<number, Blob> }}
     */
    takeForAssembly(sessionId, tabId) {
      const session = requireFinished(sessionId);
      if (session.tabId !== tabId) throw notFound();
      return {
        manifest: manifestOf(session),
        tileTier: session.tileTier,
        blobs: new Map(session.slices.map((s) => [s.index, s.blob])),
      };
    },

    /**
     * The state of a session, for finalize: 'open', 'finished' or null (unknown or another tab).
     * @param {string} sessionId
     * @param {number} tabId
     * @returns {'open' | 'finished' | null}
     */
    stateOf(sessionId, tabId) {
      const session = sessions.get(sessionId);
      if (session === undefined || session.tabId !== tabId) return null;
      return session.finished ? 'finished' : 'open';
    },
  });
}
