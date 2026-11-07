// @ts-check
/**
 * Browser executors of the image pipeline: the slice store (PNG blobs with a small LRU of decoded
 * bitmaps), tile rendering with OffscreenCanvas, and the streaming build of the full PNG.
 * The offscreen document (finalize, docs/contracts.md 7.9) and the result page use them.
 * The plans come from src/lib. This file only runs them.
 *
 * Memory rules:
 * - Slices stay PNG-compressed. At most MAX_DECODED_SLICES decoded bitmaps exist at one time,
 *   and each one is closed when the cache drops it.
 * - The full PNG is built in chunks of at most FULL_CHUNK_ROWS rows. No canvas has the full
 *   image height.
 * - Rows that no piece covers stay white.
 */

import { piecesForRange } from '../lib/assemble.js';
import { createPngEncoder } from '../lib/png-stream.js';
import { base64ToBytes, createAsyncLru, planRowChunks } from './util.js';

/** @typedef {import('../shared/types.js').Piece} Piece */
/** @typedef {import('../shared/types.js').TilePlan} TilePlan */

/** Decoded slices kept in memory (about 2 adjacent slices are enough for sequential reads). */
export const MAX_DECODED_SLICES = 2;
/** Most rows of the full image that one canvas holds while the PNG is built. */
export const FULL_CHUNK_ROWS = 512;

const PNG_TYPE = 'image/png';

// ---------------------------------------------------------------------------------------------
// Conversions
// ---------------------------------------------------------------------------------------------

/**
 * Converts base64 to a PNG Blob without a network call.
 * @param {string} base64
 * @param {string} [type]
 * @returns {Blob}
 */
export function base64ToBlob(base64, type = PNG_TYPE) {
  return new Blob([base64ToBytes(base64)], { type });
}

// ---------------------------------------------------------------------------------------------
// Slice store
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} SliceStore
 * @property {(index: number, blob: Blob) => void} add  Stores the PNG of one slice.
 * @property {(index: number) => Promise<ImageBitmap>} get
 *   Decodes a slice. The bitmap stays valid until a later `get` evicts it from the LRU. Draw it
 *   before the next `get`.
 * @property {number} count  Number of stored slices.
 * @property {() => void} dispose  Closes every decoded bitmap and forgets all slices.
 */

/**
 * @param {{ maxDecoded?: number }} [options]
 * @returns {SliceStore}
 */
export function createSliceStore({ maxDecoded = MAX_DECODED_SLICES } = {}) {
  /** @type {Map<number, Blob>} */
  const blobs = new Map();
  const decoded = createAsyncLru({
    max: maxDecoded,
    /** @param {number} index */
    load: async (index) => {
      const blob = blobs.get(index);
      if (!blob) throw new Error(`Slice ${index} is missing.`);
      return createImageBitmap(blob);
    },
    /** @param {ImageBitmap} bitmap */
    dispose: (bitmap) => bitmap.close(),
  });

  return {
    add(index, blob) {
      blobs.set(index, blob);
    },
    get: (index) => decoded.get(index),
    get count() {
      return blobs.size;
    },
    dispose() {
      decoded.close();
      blobs.clear();
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------------------------

/**
 * @param {OffscreenCanvas} canvas
 * @param {CanvasRenderingContext2DSettings} settings
 * @returns {OffscreenCanvasRenderingContext2D}
 */
function context2d(canvas, settings) {
  const ctx = canvas.getContext('2d', settings);
  if (!ctx) throw new Error('The canvas is not available.');
  return ctx;
}

/**
 * Fills the top `height` rows with white. The PNG has no alpha, so unfilled rows would turn black.
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {number} width
 * @param {number} height
 */
function fillWhite(ctx, width, height) {
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, width, height);
}

/**
 * Draws pieces 1:1. Awaits each slice and draws it at once, before the next `get` can evict it.
 * @param {OffscreenCanvasRenderingContext2D} ctx
 * @param {SliceStore} store
 * @param {Piece[]} pieces  Sorted by dstY, relative to the canvas.
 */
async function drawPieces(ctx, store, pieces) {
  for (const piece of pieces) {
    const bitmap = await store.get(piece.sliceIndex);
    ctx.drawImage(
      bitmap,
      0,
      piece.srcY,
      bitmap.width,
      piece.height,
      0,
      piece.dstY,
      bitmap.width,
      piece.height,
    );
  }
}

/**
 * Lets the event loop run, so the page can paint progress between chunks.
 * @returns {Promise<void>}
 */
function nextTask() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * Runs tasks one after another, whether they succeed or fail. The renderer uses it so the
 * decoded-slice cache never serves two users at once.
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
function createSerialQueue() {
  /** @type {Promise<unknown>} */
  let tail = Promise.resolve();
  return (task) => {
    const result = tail.then(task);
    tail = result.catch(() => {});
    return result;
  };
}

/**
 * @typedef {Object} Renderer
 * @property {(plan: TilePlan) => Promise<Blob>} renderTile
 *   Renders one tile to a PNG Blob. Scales down with high-quality smoothing when the plan asks
 *   for a smaller size than the source rows.
 * @property {(onProgress?: (fraction: number) => void) => Promise<Blob>} buildFullPng
 *   Builds the full image as a PNG Blob. `onProgress` gets a number from 0 to 1.
 */

/**
 * @param {{ store: SliceStore, pieces: Piece[], widthPx: number, totalHeight: number }} input
 *   `pieces` and `totalHeight` come from planAssembly(). `widthPx` is the manifest width.
 * @returns {Renderer}
 */
export function createRenderer({ store, pieces, widthPx, totalHeight }) {
  const enqueue = createSerialQueue();

  /** @param {TilePlan} plan @returns {Promise<Blob>} */
  async function renderTileNow(plan) {
    const { srcY, srcHeight, outWidth, outHeight } = plan;
    const scaled = outWidth !== widthPx || outHeight !== srcHeight;

    // Draw the source rows 1:1 first. Scaling the finished rows in one step avoids seams at
    // piece borders that would appear if each piece were scaled on its own.
    const source = new OffscreenCanvas(widthPx, srcHeight);
    const sourceCtx = context2d(source, { alpha: false });
    sourceCtx.imageSmoothingEnabled = false;
    fillWhite(sourceCtx, widthPx, srcHeight);
    await drawPieces(sourceCtx, store, piecesForRange(pieces, srcY, srcHeight));
    if (!scaled) return source.convertToBlob({ type: PNG_TYPE });

    const target = new OffscreenCanvas(outWidth, outHeight);
    const targetCtx = context2d(target, { alpha: false });
    targetCtx.imageSmoothingEnabled = true;
    targetCtx.imageSmoothingQuality = 'high';
    targetCtx.drawImage(source, 0, 0, widthPx, srcHeight, 0, 0, outWidth, outHeight);
    // Release the source pixels now. The garbage collector may be slow to do it.
    source.width = 0;
    source.height = 0;
    return target.convertToBlob({ type: PNG_TYPE });
  }

  /** @param {((fraction: number) => void) | undefined} onProgress @returns {Promise<Blob>} */
  async function buildFullPngNow(onProgress) {
    const encoder = createPngEncoder({ width: widthPx, height: totalHeight });
    const chunks = planRowChunks(totalHeight, FULL_CHUNK_ROWS);
    const canvas = new OffscreenCanvas(widthPx, Math.min(FULL_CHUNK_ROWS, totalHeight));
    // This canvas is read back after every chunk, so ask for a CPU-backed one.
    const ctx = context2d(canvas, { alpha: false, willReadFrequently: true });
    ctx.imageSmoothingEnabled = false;

    let rowsDone = 0;
    onProgress?.(0);
    for (const chunk of chunks) {
      fillWhite(ctx, widthPx, chunk.height);
      await drawPieces(ctx, store, piecesForRange(pieces, chunk.y, chunk.height));
      const rgba = ctx.getImageData(0, 0, widthPx, chunk.height).data;
      await encoder.writeRows(rgba, chunk.height);
      rowsDone += chunk.height;
      onProgress?.(rowsDone / totalHeight);
      await nextTask();
    }
    canvas.width = 0;
    canvas.height = 0;
    return encoder.finish();
  }

  return {
    renderTile: (plan) => enqueue(() => renderTileNow(plan)),
    buildFullPng: (onProgress) => enqueue(() => buildFullPngNow(onProgress)),
  };
}
