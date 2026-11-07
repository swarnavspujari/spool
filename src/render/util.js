// @ts-check
/**
 * Pure helpers of the image pipeline: row chunks for the streaming PNG, base64, a small async LRU
 * cache, the plan of the thumbnail and the warnings of a finished capture. No DOM and no chrome.*,
 * so Node unit tests import this file. The browser executors are in render.js.
 */

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION_PX,
  MAX_IMAGES_PER_MESSAGE,
  THUMBNAIL_MAX_HEIGHT_PX,
  THUMBNAIL_MAX_WIDTH_PX,
} from '../shared/constants.js';

/** @typedef {import('../shared/types.js').TilePlan} TilePlan */

// ---------------------------------------------------------------------------------------------
// Row chunks
// ---------------------------------------------------------------------------------------------

/**
 * Splits `totalRows` rows into consecutive chunks of at most `maxRows` rows.
 * @param {number} totalRows
 * @param {number} maxRows
 * @returns {{ y: number, height: number }[]}
 */
export function planRowChunks(totalRows, maxRows) {
  /** @type {{ y: number, height: number }[]} */
  const chunks = [];
  const step = Math.floor(maxRows);
  if (!(totalRows > 0) || !(step >= 1)) return chunks;
  for (let y = 0; y < totalRows; y += step) {
    chunks.push({ y, height: Math.min(step, totalRows - y) });
  }
  return chunks;
}

// ---------------------------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------------------------

/** Characters decoded per atob() call. A multiple of 4, so each chunk decodes on its own. */
const BASE64_CHUNK_CHARS = 1 << 20;

/**
 * Decodes base64 to bytes without a network call. Works in 1 Mi-character steps, so the
 * intermediate binary string stays small.
 * @param {string} base64
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function base64ToBytes(base64) {
  const length = base64.length;
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0;
  const bytes = new Uint8Array(Math.floor((length * 3) / 4) - padding);
  let offset = 0;
  for (let start = 0; start < length; start += BASE64_CHUNK_CHARS) {
    const binary = atob(base64.slice(start, start + BASE64_CHUNK_CHARS));
    for (let i = 0; i < binary.length; i += 1) bytes[offset++] = binary.charCodeAt(i);
  }
  return bytes;
}

const BASE64_ALPHABET = Uint8Array.from(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',
  (char) => char.charCodeAt(0),
);
const BASE64_PAD = 0x3d; // "="

/**
 * Standard base64 of the bytes. It writes into one byte buffer and decodes it once, so it needs
 * no call with a spread or `apply` on a big array and cannot overflow the call stack.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  const groups = Math.floor(bytes.length / 3);
  const rest = bytes.length - groups * 3;
  const out = new Uint8Array(4 * (groups + (rest > 0 ? 1 : 0)));
  let o = 0;
  for (let i = 0; i < groups * 3; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
    out[o++] = BASE64_ALPHABET[n >> 18];
    out[o++] = BASE64_ALPHABET[(n >> 12) & 63];
    out[o++] = BASE64_ALPHABET[(n >> 6) & 63];
    out[o++] = BASE64_ALPHABET[n & 63];
  }
  if (rest === 1) {
    const n = bytes[groups * 3] << 16;
    out[o++] = BASE64_ALPHABET[n >> 18];
    out[o++] = BASE64_ALPHABET[(n >> 12) & 63];
    out[o++] = BASE64_PAD;
    out[o++] = BASE64_PAD;
  } else if (rest === 2) {
    const n = (bytes[groups * 3] << 16) | (bytes[groups * 3 + 1] << 8);
    out[o++] = BASE64_ALPHABET[n >> 18];
    out[o++] = BASE64_ALPHABET[(n >> 12) & 63];
    out[o++] = BASE64_ALPHABET[(n >> 6) & 63];
    out[o++] = BASE64_PAD;
  }
  return new TextDecoder().decode(out);
}

/**
 * Base64 of a Blob (no data-URL prefix), without a FileReader, so it also works in Node.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
export async function blobToBase64Text(blob) {
  return bytesToBase64(new Uint8Array(await blob.arrayBuffer()));
}

// ---------------------------------------------------------------------------------------------
// Async LRU cache
// ---------------------------------------------------------------------------------------------

/**
 * Cache of values that load asynchronously and need cleanup (decoded images). It keeps at most
 * `max` entries. When the cache is full, `get` disposes the least recently used entry before
 * it starts a new load. Concurrent `get` calls for one key share one load. A failed load is not
 * cached.
 *
 * A value stays valid until a later `get` evicts it. Use each value before you call `get` again.
 * `max` must be 1 or more.
 *
 * @template K, V
 * @param {{
 *   max: number,
 *   load: (key: K) => Promise<V>,
 *   dispose: (value: V) => void,
 * }} options
 * @returns {{ get(key: K): Promise<V>, clear(): void, close(): void, readonly size: number }}
 */
export function createAsyncLru({ max, load, dispose }) {
  /** @type {Map<K, Promise<V>>} Insertion order is use order: oldest first. */
  const entries = new Map();
  let closed = false;

  /** @param {Promise<V>} promise */
  function release(promise) {
    // A load that failed has nothing to dispose.
    promise.then(dispose, () => {});
  }

  /**
   * Disposes the least recently used entries until at most `limit` remain.
   * @param {number} limit
   */
  function trim(limit) {
    while (entries.size > limit) {
      const oldest = entries.entries().next();
      if (oldest.done) return;
      const [key, promise] = oldest.value;
      entries.delete(key);
      release(promise);
    }
  }

  function clear() {
    for (const promise of entries.values()) release(promise);
    entries.clear();
  }

  return {
    get(key) {
      if (closed) return Promise.reject(new Error('The cache is closed.'));
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      // Make room first. A settled entry is disposed in a microtask that runs before the load
      // below starts, so the cache never holds more than `max` values, even for a moment.
      trim(max - 1);
      const promise = Promise.resolve().then(() => load(key));
      entries.set(key, promise);
      promise.catch(() => {
        if (entries.get(key) === promise) entries.delete(key);
      });
      return promise;
    },
    clear,
    close() {
      closed = true;
      clear();
    },
    get size() {
      return entries.size;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Thumbnail and warnings of a finished capture
// ---------------------------------------------------------------------------------------------

/**
 * The plan of the thumbnail: the top of the full image, scaled down so that it fits
 * THUMBNAIL_MAX_WIDTH_PX x THUMBNAIL_MAX_HEIGHT_PX, never scaled up. It has the shape of a tile
 * plan, so the renderer draws it like a tile.
 * @param {number} widthPx   Width of the full image.
 * @param {number} heightPx  Height of the full image.
 * @returns {TilePlan}
 */
export function thumbnailPlan(widthPx, heightPx) {
  if (!Number.isSafeInteger(widthPx) || widthPx < 1) throw new RangeError('widthPx must be >= 1');
  if (!Number.isSafeInteger(heightPx) || heightPx < 1) throw new RangeError('heightPx must be >= 1');
  const scale = Math.min(1, THUMBNAIL_MAX_WIDTH_PX / widthPx);
  // Exact integer arithmetic: a float division (MAX / scale) can land one row short.
  const srcHeight = Math.min(
    heightPx,
    scale < 1
      ? Math.floor((THUMBNAIL_MAX_HEIGHT_PX * widthPx) / THUMBNAIL_MAX_WIDTH_PX)
      : THUMBNAIL_MAX_HEIGHT_PX,
  );
  const outWidth = Math.max(1, Math.min(THUMBNAIL_MAX_WIDTH_PX, Math.round(widthPx * scale)));
  const outHeight = Math.max(1, Math.min(THUMBNAIL_MAX_HEIGHT_PX, Math.round(srcHeight * scale)));
  return { index: 0, srcY: 0, srcHeight, outWidth, outHeight };
}

/**
 * Warnings of a finished capture, in display order: tile count, full image size, then the lines of
 * the manifest (joins that could not be checked).
 * @param {{
 *   tileCount: number,
 *   widthPx: number,
 *   heightPx: number,
 *   fullBytes: number,
 *   manifestWarnings?: readonly string[] | null,
 * }} input
 * @returns {string[]}
 */
export function outputWarnings({ tileCount, widthPx, heightPx, fullBytes, manifestWarnings }) {
  /** @type {string[]} */
  const warnings = [];
  if (tileCount > MAX_IMAGES_PER_MESSAGE) {
    warnings.push(
      `More than ${MAX_IMAGES_PER_MESSAGE} screenshots. Send them in more than one message.`,
    );
  }
  if (widthPx > MAX_IMAGE_DIMENSION_PX || heightPx > MAX_IMAGE_DIMENSION_PX || fullBytes > MAX_IMAGE_BYTES) {
    warnings.push('The full image is too large for most chats. Use the AI screenshots.');
  }
  for (const line of manifestWarnings ?? []) {
    if (typeof line === 'string' && line.trim() !== '' && !warnings.includes(line)) {
      warnings.push(line);
    }
  }
  return warnings;
}
