// @ts-check
/**
 * Finalize: from a finished capture session to its outputs (docs/contracts.md 7.9).
 *
 *   mark finished → plan the assembly and the tiles → render the tiles, the thumbnail and the full
 *   PNG → free the slices → keep the outputs as the last capture → save the files → summary.
 *
 * One finalize runs at a time, so the decoded bitmaps and the encoder of two captures never add
 * up. The same session asked twice gets the same summary (a second Done, or a retry after a lost
 * reply, does not build twice). The image work goes through `renderOps` (src/offscreen/render-ops.js
 * in the browser, a fake in the unit tests).
 *
 * Failure: any error while the images are built gives E_INTERNAL "Could not build the images. Try
 * again." The session stays finished (until SESSION_TTL_MS), so Done can try again. The save step
 * never fails the finalize: it reports its own error in `summary.save`.
 */

import { planAssembly } from '../lib/assemble.js';
import { fitsOneImage, planTiles } from '../lib/tiles.js';
import { blobToBase64Text, outputWarnings, thumbnailPlan } from '../render/util.js';
import { ERR, SpoolError } from '../shared/protocol.js';

/** @typedef {import('../shared/types.js').FinishSummary} FinishSummary */
/** @typedef {import('../shared/types.js').Piece} Piece */
/** @typedef {import('../shared/types.js').TilePlan} TilePlan */

/**
 * The image work of one finalize. `dispose` frees the decoded bitmaps and the slice data.
 * @typedef {Object} RenderPipeline
 * @property {(plan: TilePlan) => Promise<Blob>} renderTile
 * @property {() => Promise<Blob>} buildFullPng
 * @property {() => void} dispose
 */

/**
 * @typedef {Object} RenderOps
 * @property {(input: {
 *   blobs: Map<number, Blob>,
 *   pieces: Piece[],
 *   widthPx: number,
 *   totalHeight: number,
 * }) => RenderPipeline} open
 */

/**
 * @typedef {Object} FinalizeRequest
 * @property {string} sessionId
 * @property {number} tabId
 * @property {boolean} saveTiles
 * @property {boolean} saveFull
 * @property {string} folderName
 */

/**
 * @typedef {Object} FinalizerDeps
 * @property {ReturnType<typeof import('./session-store.js').createSessionStore>} store
 * @property {ReturnType<typeof import('./last-capture.js').createLastCapture>} last
 * @property {RenderOps} renderOps
 * @property {ReturnType<typeof import('./save.js').createSaver>} saver
 * @property {(message: string, error: unknown) => void} [log]  For the failures that the user
 *   message hides. It gets no image data.
 */

const MSG_ENDED = 'This capture has ended. Start a new capture.';
const MSG_BUILD_FAILED = 'Could not build the images. Try again.';
const MSG_SAVE_FAILED = 'Could not save the files.';
const WARN_NO_FULL = 'The full image could not be built. You can still use the AI screenshots.';

/**
 * @param {FinalizerDeps} deps
 */
export function createFinalizer(deps) {
  const { store, last, renderOps, saver } = deps;
  const log = deps.log ?? (() => {});

  /** Finalizes that wait or run, by session ID. The same session shares one promise. */
  /** @type {Map<string, Promise<FinishSummary>>} */
  const inFlight = new Map();
  /** End of the chain of finalizes. It never rejects. */
  let tail = Promise.resolve();

  /**
   * @param {FinalizeRequest} request
   * @returns {Promise<FinishSummary>}
   */
  async function run(request) {
    const { sessionId, tabId } = request;
    // A finalize that was queued behind another one of the same session finds the result here.
    const existing = last.latest();
    if (existing !== null && existing.sessionId === sessionId && existing.tabId === tabId) {
      return existing.summary;
    }
    if (store.stateOf(sessionId, tabId) === null) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_ENDED);

    await store.finish(sessionId, tabId);

    /** @type {ReturnType<typeof store.takeForAssembly>} */
    let taken;
    try {
      taken = store.takeForAssembly(sessionId, tabId);
    } catch (e) {
      // A capture with no slice has nothing to retry. Free the session.
      if (e instanceof SpoolError && e.code === ERR.CAPTURE_FAILED) store.release(sessionId);
      throw e;
    }
    // The old outputs go before the new ones are built: their memory is worth less than the new
    // capture's. Not before this point: a capture with nothing in it must not end the old one.
    last.clear();
    const { manifest, tileTier, blobs } = taken;
    const { widthPx } = manifest;
    const { pieces, totalHeight } = planAssembly(manifest.slices);
    const tilePlans = planTiles(widthPx, totalHeight, tileTier);
    const tileCount = tilePlans.length;
    // One tile that is the source 1:1 is the same picture as the full image: build it once, and
    // save one file. A single tile that is scaled is a different picture: it is built and saved
    // on its own.
    const sameAsFull = fitsOneImage(tilePlans, widthPx);
    const thumbPlan = thumbnailPlan(widthPx, totalHeight);

    /** @type {Blob[]} */
    const tiles = [];
    /** @type {Blob | null} */
    let full = null;
    /** @type {Blob | null} */
    let thumb = null;
    /** @type {string[]} */
    const warnings = [];
    const pipeline = renderOps.open({ blobs, pieces, widthPx, totalHeight });
    try {
      if (!sameAsFull) for (const plan of tilePlans) tiles.push(await pipeline.renderTile(plan));
      thumb = await pipeline.renderTile(thumbPlan);
      try {
        full = await pipeline.buildFullPng();
      } catch (e) {
        // The tiles are still good. Without them (one tile that is the full image) it is fatal.
        if (sameAsFull) throw e;
        log('Spool offscreen: the full image failed', e);
        warnings.push(WARN_NO_FULL);
      }
      if (sameAsFull && full !== null) tiles.push(full);
    } catch (e) {
      log('Spool offscreen: finalize failed', e);
      const error = new SpoolError(ERR.INTERNAL, MSG_BUILD_FAILED);
      error.cause = e;
      throw error;
    } finally {
      pipeline.dispose();
    }

    /** @type {FinishSummary} */
    const summary = {
      sessionId,
      title: manifest.title,
      sourceHost: manifest.sourceHost,
      createdAt: manifest.createdAt,
      widthPx,
      heightPx: totalHeight,
      tileCount,
      tileTier,
      fitsOneImage: sameAsFull,
      fullBytes: full === null ? 0 : full.size,
      thumbnailPngBase64: thumb === null ? '' : await blobToBase64Text(thumb),
      thumbnailWidthPx: thumbPlan.outWidth,
      thumbnailHeightPx: thumbPlan.outHeight,
      save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false },
      warnings: [
        ...outputWarnings({
          tileCount,
          widthPx,
          heightPx: totalHeight,
          fullBytes: full === null ? 0 : full.size,
          manifestWarnings: manifest.warnings,
        }),
        ...warnings,
      ],
    };

    // The outputs are complete: keep them for the toast and the shelf, and free the slices. The
    // capture is set first, so the document is never "empty" between the two steps.
    last.set({ sessionId, tabId, summary, tiles, full });
    store.release(sessionId);

    /** @type {Awaited<ReturnType<typeof saver.save>>} */
    let saved;
    try {
      saved = await saver.save({
        // The time of the start, as on the capture page: both save under the same names.
        date: new Date(manifest.createdAt),
        title: manifest.title,
        tileCount,
        fitsOneImage: sameAsFull,
        tiles,
        full,
        saveTiles: request.saveTiles,
        saveFull: request.saveFull,
        folderName: request.folderName,
      });
    } catch (e) {
      // The saver reports its own failures, so this is a bug. The capture is still good.
      log('Spool offscreen: the save step failed', e);
      saved = {
        save: {
          location: 'none',
          label: 'Not saved',
          files: 0,
          needsPermission: false,
          error: MSG_SAVE_FAILED,
        },
        warnings: [],
      };
    }
    /** @type {FinishSummary} */
    const finished = {
      ...summary,
      save: saved.save,
      warnings: [...summary.warnings, ...saved.warnings],
    };
    last.setSummary(finished);
    return finished;
  }

  return Object.freeze({
    /**
     * Builds the outputs of a session, keeps them as the last capture and saves the files.
     * @param {FinalizeRequest} request
     * @returns {Promise<FinishSummary>}
     */
    finalize(request) {
      const shared = inFlight.get(request.sessionId);
      if (shared !== undefined) return shared;
      const result = tail.then(() => run(request));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      const tracked = result.finally(() => {
        if (inFlight.get(request.sessionId) === tracked) inFlight.delete(request.sessionId);
      });
      inFlight.set(request.sessionId, tracked);
      return tracked;
    },
  });
}
