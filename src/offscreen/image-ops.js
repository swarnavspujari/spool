// @ts-check
/**
 * Browser implementation of the store's ImageOps (see session-store.js).
 *
 * A frame arrives as a PNG data URL. It is decoded to an ImageBitmap without any network call
 * (the page CSP blocks connect-src), cropped on an OffscreenCanvas, summarized as a row
 * signature for the seam search, and encoded to a PNG blob. The bitmap and the canvas are
 * released as soon as they are not needed.
 *
 * Only this file touches createImageBitmap and OffscreenCanvas, so the store stays testable
 * in Node.
 */

import { rowSignature } from '../lib/seam.js';
import { SIGNATURE_MAX_COLS } from '../shared/constants.js';
import { ERR, SpoolError } from '../shared/protocol.js';

/** @typedef {import('./session-store.js').ImageOps} ImageOps */
/** @typedef {import('./session-store.js').DecodedFrame} DecodedFrame */
/** @typedef {import('./session-store.js').CropBox} CropBox */
/** @typedef {import('./session-store.js').CropResult} CropResult */

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

/**
 * Decodes a base64 PNG data URL to a Blob. It reads the bytes with atob(): no network call.
 * @param {string} dataUrl
 * @returns {Blob}
 */
export function dataUrlToBlob(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new SpoolError(ERR.CAPTURE_FAILED, 'Could not read the captured image. Try again.');
  }
  const binary = atob(dataUrl.slice(PNG_DATA_URL_PREFIX.length));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new Blob([bytes], { type: 'image/png' });
}

/**
 * Copies `box` out of the bitmap and builds its signature and PNG.
 * @param {ImageBitmap} bitmap
 * @param {CropBox} box
 * @returns {Promise<CropResult>}
 */
async function cropBitmap(bitmap, { sx, sy, sw, sh }) {
  const canvas = new OffscreenCanvas(sw, sh);
  try {
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (context === null) throw new Error('No 2D canvas context');
    // Same size on both sides: a pixel copy, no scaling.
    context.drawImage(bitmap, sx, sy, sw, sh, 0, 0, sw, sh);
    const cols = Math.min(SIGNATURE_MAX_COLS, sw);
    const signature = rowSignature(context.getImageData(0, 0, sw, sh).data, sw, sh, cols);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    return { blob, signature, cols, width: sw, height: sh };
  } finally {
    // Frees the canvas backing store now instead of at the next garbage collection.
    canvas.width = 0;
    canvas.height = 0;
  }
}

/** @returns {ImageOps} */
export function createImageOps() {
  return {
    async decode(dataUrl) {
      const bitmap = await createImageBitmap(dataUrlToBlob(dataUrl));
      return {
        widthPx: bitmap.width,
        heightPx: bitmap.height,
        crop: (box) => cropBitmap(bitmap, box),
        close: () => bitmap.close(),
      };
    },
  };
}
