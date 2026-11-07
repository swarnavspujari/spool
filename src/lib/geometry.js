// @ts-check
/**
 * Conversion from CSS px (viewport and content coordinates) to device px (bitmap pixels).
 * Pure functions. Invalid input throws TypeError or RangeError.
 */

/** @typedef {import('../shared/types.js').Rect} Rect */
/** @typedef {import('../shared/types.js').Size} Size */

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function requireFinite(name, value) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isFinite(value)) throw new RangeError(`${name} must be finite`);
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function requirePositive(name, value) {
  requireFinite(name, value);
  if (value <= 0) throw new RangeError(`${name} must be greater than 0`);
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function requirePositiveInteger(name, value) {
  requirePositive(name, value);
  if (!Number.isInteger(value)) throw new RangeError(`${name} must be a whole number`);
}

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/**
 * Tolerance (device px) of the edge rounding in `cropRectPx`.
 *
 * A device pixel belongs to the crop when at least 99% of it lies inside the rect. The margin
 * absorbs the floating-point error of `scale` and of `x + width`: 311 * (342 / 311) is
 * 341.99999999999994, and an edge that falls on a pixel boundary must stay on that boundary.
 * It is far below one pixel, so a pixel that the element only touches is never taken, and below
 * one layout unit (1/64 CSS px) at any scale of 1 or more, so real fractional edges still count.
 */
const EDGE_EPS = 0.01;

/**
 * Crop rectangle inside a captureVisibleTab bitmap for a CSS rect of the viewport.
 *
 * The scale comes from the bitmap width, not from `devicePixelRatio`: browser zoom and
 * fractional display scaling make the two differ.
 *
 * Rounding works on edges, and rounds inwards: the crop keeps only the device pixels that the
 * rect covers (see EDGE_EPS), so it never holds a row or a column that is outside the element.
 * Rounding the size instead would add a row when the size has a fraction of .5 or more (an
 * element of 882.5 device rows would give 883). The crop depends only on the arguments, so
 * every frame of a session (same rect, viewport and bitmap size) gets the same crop.
 *
 * The rect is expected to lie inside the viewport (the page agent clips it). If a bitmap that is
 * smaller than expected pushes it outside, the origin is moved into the bitmap and the size is
 * cut at its far edge.
 *
 * @param {Rect} rect       CSS px, viewport coordinates.
 * @param {Size} viewport   CSS px, `window.innerWidth` and `window.innerHeight`.
 * @param {number} bitmapWidth   Device px.
 * @param {number} bitmapHeight  Device px.
 * @returns {{ sx: number, sy: number, sw: number, sh: number, scale: number }}
 */
export function cropRectPx(rect, viewport, bitmapWidth, bitmapHeight) {
  requireFinite('rect.x', rect.x);
  requireFinite('rect.y', rect.y);
  requirePositive('rect.width', rect.width);
  requirePositive('rect.height', rect.height);
  requirePositive('viewport.width', viewport.width);
  requirePositive('viewport.height', viewport.height);
  requirePositiveInteger('bitmapWidth', bitmapWidth);
  requirePositiveInteger('bitmapHeight', bitmapHeight);

  const scale = bitmapWidth / viewport.width;
  // First pixel inside the bitmap, then the far edge at least 1 px after it and inside the bitmap.
  const sx = clamp(Math.ceil(rect.x * scale - EDGE_EPS), 0, bitmapWidth - 1);
  const sy = clamp(Math.ceil(rect.y * scale - EDGE_EPS), 0, bitmapHeight - 1);
  const ex = clamp(Math.floor((rect.x + rect.width) * scale + EDGE_EPS), sx + 1, bitmapWidth);
  const ey = clamp(Math.floor((rect.y + rect.height) * scale + EDGE_EPS), sy + 1, bitmapHeight);
  return { sx, sy, sw: ex - sx, sh: ey - sy, scale };
}

/**
 * Position of a content coordinate in device px.
 * @param {number} contentY  CSS px inside the scroll target.
 * @param {number} scale     Device px per CSS px (`cropRectPx(...).scale`).
 * @returns {number}
 */
export function contentYToPx(contentY, scale) {
  requireFinite('contentY', contentY);
  requirePositive('scale', scale);
  return Math.round(contentY * scale);
}
