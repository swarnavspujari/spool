// @ts-check
/**
 * Checks and rebuilds a FinishSummary (docs/contracts.md 7.4) before the service worker gives it to
 * a page. The page agent is the least trusted context, so the worker passes on a copy that has
 * exactly the known fields with the right types and sizes, and never the raw reply of the offscreen
 * document. A reply that does not fit gives E_INTERNAL instead of a half answer.
 */

import { ERR, SpoolError, isNonNegativeInt, isSessionId, isSourceHost } from '../shared/protocol.js';

/** @typedef {import('../shared/types.js').FinishSummary} FinishSummary */
/** @typedef {import('../shared/types.js').SaveInfo} SaveInfo */

/** Longest thumbnail (base64 characters): 320 x 480 px of PNG stay far below this. */
const MAX_THUMBNAIL_BASE64_LENGTH = 4 * 1024 * 1024;
const MAX_TEXT_LENGTH = 512;
const MAX_WARNINGS = 20;
const SAVE_LOCATIONS = Object.freeze(['folder', 'downloads', 'none']);
const TILE_TIERS = Object.freeze(['high', 'standard']);

const MSG_UNEXPECTED = 'Something went wrong. Try again.';

/** @returns {SpoolError} */
function bad() {
  return new SpoolError(ERR.INTERNAL, MSG_UNEXPECTED);
}

/** @param {unknown} v @returns {v is string} */
function isText(v) {
  return typeof v === 'string' && v.length <= MAX_TEXT_LENGTH;
}

/** @param {unknown} v @returns {v is number} */
function isPositiveInt(v) {
  return isNonNegativeInt(v) && v >= 1;
}

/**
 * @param {unknown} raw
 * @returns {SaveInfo}
 */
function parseSave(raw) {
  const s = /** @type {any} */ (raw);
  if (
    typeof s !== 'object' ||
    s === null ||
    !SAVE_LOCATIONS.includes(s.location) ||
    !isText(s.label) ||
    !isNonNegativeInt(s.files) ||
    typeof s.needsPermission !== 'boolean' ||
    (s.error !== undefined && !isText(s.error)) ||
    (s.failed !== undefined && !isNonNegativeInt(s.failed)) ||
    (s.folderLabel !== undefined && !isText(s.folderLabel))
  ) {
    throw bad();
  }
  /** @type {SaveInfo} */
  const save = {
    location: s.location,
    label: s.label,
    files: s.files,
    needsPermission: s.needsPermission,
  };
  if (s.error !== undefined) save.error = s.error;
  if (s.failed !== undefined) save.failed = s.failed;
  if (s.folderLabel !== undefined) save.folderLabel = s.folderLabel;
  return save;
}

/**
 * @param {unknown} raw  The `summary` of an offscreen reply.
 * @returns {FinishSummary}  A copy with only the known fields.
 */
export function parseSummary(raw) {
  const s = /** @type {any} */ (raw);
  if (
    typeof s !== 'object' ||
    s === null ||
    !isSessionId(s.sessionId) ||
    !isText(s.title) ||
    typeof s.createdAt !== 'number' ||
    !Number.isFinite(s.createdAt) ||
    !isPositiveInt(s.widthPx) ||
    !isPositiveInt(s.heightPx) ||
    !isPositiveInt(s.tileCount) ||
    !TILE_TIERS.includes(s.tileTier) ||
    typeof s.fitsOneImage !== 'boolean' ||
    !isNonNegativeInt(s.fullBytes) ||
    typeof s.thumbnailPngBase64 !== 'string' ||
    s.thumbnailPngBase64.length === 0 ||
    s.thumbnailPngBase64.length > MAX_THUMBNAIL_BASE64_LENGTH ||
    !isPositiveInt(s.thumbnailWidthPx) ||
    !isPositiveInt(s.thumbnailHeightPx) ||
    !Array.isArray(s.warnings) ||
    s.warnings.length > MAX_WARNINGS ||
    !s.warnings.every(isText)
  ) {
    throw bad();
  }
  return {
    sessionId: s.sessionId,
    title: s.title,
    // A cosmetic field: a reply without a valid one shows no host, it does not fail the capture.
    sourceHost: isSourceHost(s.sourceHost) ? s.sourceHost : '',
    createdAt: s.createdAt,
    widthPx: s.widthPx,
    heightPx: s.heightPx,
    tileCount: s.tileCount,
    tileTier: s.tileTier,
    fitsOneImage: s.fitsOneImage,
    fullBytes: s.fullBytes,
    thumbnailPngBase64: s.thumbnailPngBase64,
    thumbnailWidthPx: s.thumbnailWidthPx,
    thumbnailHeightPx: s.thumbnailHeightPx,
    save: parseSave(s.save),
    warnings: [...s.warnings],
  };
}

/**
 * The part of a summary that the shelf gets. The shelf runs in any tab, not only in the tab that
 * was captured, so it gets only what it shows: size, age, the host name of the captured page, the
 * place of the saved files and the thumbnail. No title, session ID or warnings.
 * @param {FinishSummary} summary  A checked summary (from `parseSummary`).
 * @returns {import('../shared/types.js').ShelfSummary}
 */
export function toShelfSummary(summary) {
  return {
    tileCount: summary.tileCount,
    widthPx: summary.widthPx,
    heightPx: summary.heightPx,
    createdAt: summary.createdAt,
    sourceHost: summary.sourceHost,
    saveLabel: summary.save.location === 'none' ? '' : summary.save.label,
    thumbnailPngBase64: summary.thumbnailPngBase64,
    thumbnailWidthPx: summary.thumbnailWidthPx,
    thumbnailHeightPx: summary.thumbnailHeightPx,
  };
}

/**
 * The `pngBase64` of an offscreen reply. Throws E_INTERNAL when it is missing.
 * @param {unknown} reply
 * @returns {string}
 */
export function parsePngBase64(reply) {
  const v = /** @type {any} */ (reply)?.pngBase64;
  if (typeof v !== 'string' || v === '') throw bad();
  return v;
}
