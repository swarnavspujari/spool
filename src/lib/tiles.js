// @ts-check
/**
 * Tile sizes and tile plans for AI vision models. Pure functions, device px.
 * A tile that fits its tier is not downscaled by the model, so the model sees every pixel.
 * Invalid input throws TypeError or RangeError.
 */

import { PATCH_PX, TILE_OVERLAP_PX, TILE_TIERS } from '../shared/constants.js';

/** @typedef {import('../shared/types.js').TileTier} TileTier */
/** @typedef {import('../shared/types.js').TilePlan} TilePlan */

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function requirePositiveInteger(name, value) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${name} must be a positive whole number`);
  }
}

/**
 * @param {TileTier} tier
 * @returns {{ maxLongEdgePx: number, maxPatches: number }}
 */
function tierLimits(tier) {
  if (typeof tier !== 'string' || !Object.hasOwn(TILE_TIERS, tier)) {
    throw new RangeError(`tier must be one of: ${Object.keys(TILE_TIERS).join(', ')}`);
  }
  return TILE_TIERS[tier];
}

/**
 * Tile size for a full image of this width. Wider images are scaled down so the tile width fits
 * the long edge; the tile height is the largest one that stays inside both tier limits.
 * @param {number} widthPx  Width of the full image.
 * @param {TileTier} tier
 * @returns {{ outWidth: number, scale: number, tileHeightOut: number, tileHeightSrc: number }}
 *   `scale` is output px per source px. `tileHeightSrc` is the source rows that make one
 *   full-height output tile.
 */
export function tileGeometry(widthPx, tier) {
  requirePositiveInteger('widthPx', widthPx);
  const { maxLongEdgePx, maxPatches } = tierLimits(tier);
  const scale = Math.min(1, maxLongEdgePx / widthPx);
  const outWidth = Math.round(widthPx * scale);
  const patchColumns = Math.ceil(outWidth / PATCH_PX);
  const tileHeightOut = Math.min(maxLongEdgePx, Math.floor(maxPatches / patchColumns) * PATCH_PX);
  // Source rows of a full output tile: floor(tileHeightOut / scale), in exact integer arithmetic.
  // `scale` is maxLongEdgePx / widthPx, so this is floor(tileHeightOut * widthPx / maxLongEdgePx).
  // The float form `Math.floor(tileHeightOut / scale)` can come out 1 ulp below a whole number and
  // then loses one row (width 3174, high tier: 1793 instead of 1794). The product stays far below
  // 2^53 for every real width (device px, below 100,000). Not scaled: the tile is as tall as out.
  const tileHeightSrc =
    widthPx > maxLongEdgePx ? Math.floor((tileHeightOut * widthPx) / maxLongEdgePx) : tileHeightOut;
  return { outWidth, scale, tileHeightOut, tileHeightSrc };
}

/**
 * True when the tile is not the source rows 1:1 (it needs a scale step).
 * @param {TilePlan} plan
 * @param {number} widthPx  Width of the full image.
 * @returns {boolean}
 */
export function isScaledTile(plan, widthPx) {
  return plan.outWidth !== widthPx || plan.outHeight !== plan.srcHeight;
}

/**
 * True when the whole capture is one tile that is the full image 1:1. Then the tile and the full
 * image are the same picture and one file holds both. A single tile that is scaled is a
 * different picture (it is the size an AI reads), so it is not this case.
 * @param {readonly TilePlan[]} plans  The result of `planTiles`.
 * @param {number} widthPx  Width of the full image.
 * @returns {boolean}
 */
export function fitsOneImage(plans, widthPx) {
  const first = plans[0];
  return plans.length === 1 && first !== undefined && !isScaledTile(first, widthPx);
}

/**
 * Cuts a full image into tiles, top to bottom. Adjacent tiles share `overlapPx` rows (measured
 * in output px). The last tile is shorter and ends at `heightPx`. A tile is never empty.
 * @param {number} widthPx
 * @param {number} heightPx
 * @param {TileTier} tier
 * @param {number} [overlapPx]  Output px. 0 or more, and less than the tile height.
 * @returns {TilePlan[]}
 */
export function planTiles(widthPx, heightPx, tier, overlapPx = TILE_OVERLAP_PX) {
  requirePositiveInteger('heightPx', heightPx);
  if (typeof overlapPx !== 'number') throw new TypeError('overlapPx must be a number');
  if (!Number.isFinite(overlapPx) || overlapPx < 0) {
    throw new RangeError('overlapPx must be 0 or more');
  }
  const { outWidth, scale, tileHeightSrc } = tileGeometry(widthPx, tier);
  const stepSrc = tileHeightSrc - Math.round(overlapPx / scale);
  if (stepSrc < 1) throw new RangeError('overlapPx must be less than the tile height');

  /** @type {TilePlan[]} */
  const tiles = [];
  for (let srcY = 0; ; srcY += stepSrc) {
    const srcHeight = Math.min(tileHeightSrc, heightPx - srcY);
    // Rounding stays inside the tier limit: tileHeightSrc * scale <= tileHeightOut, an integer.
    // The floor of 1 is for a very short last tile of a strongly scaled image.
    const outHeight = Math.max(1, Math.round(srcHeight * scale));
    tiles.push({ index: tiles.length, srcY, srcHeight, outWidth, outHeight });
    if (srcY + srcHeight >= heightPx) return tiles;
  }
}
