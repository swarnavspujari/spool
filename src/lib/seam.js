// @ts-check
/**
 * Seam search for two vertically overlapping slices. Pure functions: no DOM, no chrome.* APIs.
 *
 * A signature is a small luminance image of a slice: one value per row and per column bin.
 * It is much cheaper to compare than pixels and is enough to find the row offset between two
 * captures of the same content.
 */

/** @typedef {import('../shared/types.js').SeamMatch} SeamMatch */

/**
 * @typedef {Object} SeamParams
 * @property {Uint8Array} upper         Signature of the upper slice (output of rowSignature).
 * @property {Uint8Array} lower         Signature of the lower slice.
 * @property {number} cols              Values per signature row. Equal for both signatures.
 * @property {number} upperHeight       Rows in `upper`.
 * @property {number} lowerHeight       Rows in `lower`.
 * @property {number} expectedOffset    Rows from the top of `upper` to the top of `lower`.
 * @property {number} maxShift          Largest |shift| to try.
 * @property {number} minOverlap        Fewest overlapping rows that a comparison may use.
 * @property {number} threshold         Largest mean absolute difference (0-255) that is a match.
 * @property {number} maxRowDiff        Largest mean absolute difference (0-255) that any single
 *   overlap row may have. A blank overlap with a few completely different rows passes the
 *   mean threshold, but not this.
 * @property {number} flatStdDev        Overlaps with a smaller standard deviation are flat.
 */

/** Reported when the overlap at shift 0 has too few rows to compare: the worst possible value. */
const NO_COMPARISON_DIFF = 255;

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} min
 * @returns {asserts value is number}
 */
function assertInt(name, value, min) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isInteger(value) || value < min) {
    throw new RangeError(`${name} must be an integer >= ${min}`);
  }
}

/**
 * @param {string} name
 * @param {unknown} value
 * @returns {asserts value is number}
 */
function assertNonNegative(name, value) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite number >= 0`);
  }
}

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} length
 * @returns {asserts value is Uint8Array}
 */
function assertSignature(name, value, length) {
  if (!(value instanceof Uint8Array)) throw new TypeError(`${name} must be a Uint8Array`);
  if (value.length !== length) {
    throw new RangeError(`${name} must have height * cols = ${length} values`);
  }
}

/**
 * Builds the signature of an RGBA image: `height * cols` values, row by row. Each value is the
 * mean luminance (`(77R + 150G + 29B) >> 8` per pixel, alpha ignored, rounded to the nearest
 * integer) of one row inside one of `cols` column bins.
 *
 * Bin `k` covers pixel columns `[floor(k * width / cols), floor((k + 1) * width / cols))`.
 * When `width` is not a multiple of `cols` the bins differ by one pixel. When `width < cols`
 * every bin still covers at least one pixel, so neighbouring bins repeat the same pixel.
 *
 * @param {Uint8ClampedArray | Uint8Array} rgba  `width * height * 4` bytes.
 * @param {number} width
 * @param {number} height
 * @param {number} cols
 * @returns {Uint8Array}
 */
export function rowSignature(rgba, width, height, cols) {
  if (!(rgba instanceof Uint8Array || rgba instanceof Uint8ClampedArray)) {
    throw new TypeError('rgba must be a Uint8Array or a Uint8ClampedArray');
  }
  assertInt('width', width, 1);
  assertInt('height', height, 1);
  assertInt('cols', cols, 1);
  if (rgba.length !== width * height * 4) {
    throw new RangeError(`rgba must have width * height * 4 = ${width * height * 4} bytes`);
  }

  const first = new Int32Array(cols);
  const end = new Int32Array(cols);
  for (let k = 0; k < cols; k++) {
    first[k] = Math.floor((k * width) / cols);
    end[k] = Math.max(first[k] + 1, Math.floor(((k + 1) * width) / cols));
  }

  const signature = new Uint8Array(height * cols);
  for (let y = 0; y < height; y++) {
    const rowStart = y * width * 4;
    for (let k = 0; k < cols; k++) {
      let sum = 0;
      for (let x = first[k]; x < end[k]; x++) {
        const i = rowStart + x * 4;
        sum += (77 * rgba[i] + 150 * rgba[i + 1] + 29 * rgba[i + 2]) >> 8;
      }
      const count = end[k] - first[k];
      signature[y * cols + k] = Math.floor((sum + (count >> 1)) / count);
    }
  }
  return signature;
}

/**
 * Difference between `rows` rows of two signatures: the sum of absolute differences, and the
 * largest mean absolute difference of one row.
 *
 * Stops after the first row that pushes the sum over `limit` or whose own mean is over
 * `maxRowDiff`. The values are then only lower bounds, and at least one of them exceeds its
 * limit. Without a stop both values are exact. So a caller accepts an overlap when
 * `sum <= limit && worstRowDiff <= maxRowDiff`.
 * @param {Uint8Array} upper
 * @param {number} upperBase  Index in `upper` of the first compared value.
 * @param {Uint8Array} lower  Compared from its first value.
 * @param {number} rows
 * @param {number} cols
 * @param {number} limit
 * @param {number} maxRowDiff
 * @returns {{ sum: number, worstRowDiff: number }}
 */
function compareOverlap(upper, upperBase, lower, rows, cols, limit, maxRowDiff) {
  let sum = 0;
  let worstRowDiff = 0;
  for (let r = 0; r < rows; r++) {
    const u = upperBase + r * cols;
    const l = r * cols;
    let rowSum = 0;
    for (let c = 0; c < cols; c++) {
      const diff = upper[u + c] - lower[l + c];
      rowSum += diff < 0 ? -diff : diff;
    }
    sum += rowSum;
    const rowDiff = rowSum / cols;
    if (rowDiff > worstRowDiff) worstRowDiff = rowDiff;
    if (sum > limit || rowDiff > maxRowDiff) break;
  }
  return { sum, worstRowDiff };
}

/**
 * Standard deviation of all values of one overlap, upper and lower rows together.
 * @param {Uint8Array} upper
 * @param {number} upperBase
 * @param {Uint8Array} lower
 * @param {number} rows
 * @param {number} cols
 * @returns {number}
 */
function overlapStdDev(upper, upperBase, lower, rows, cols) {
  const n = rows * cols;
  let sum = 0;
  let sumSquares = 0;
  for (let i = 0; i < n; i++) {
    const a = upper[upperBase + i];
    const b = lower[i];
    sum += a + b;
    sumSquares += a * a + b * b;
  }
  const mean = sum / (2 * n);
  return Math.sqrt(Math.max(0, sumSquares / (2 * n) - mean * mean));
}

/**
 * Finds where `lower` really sits on `upper`. For a shift `d`, upper rows
 * `[expectedOffset + d, upperHeight)` are compared with lower rows from 0 (at most `lowerHeight`
 * rows). Shifts with fewer than `minOverlap` rows are skipped, and `|d| <= maxShift`.
 *
 * A shift is acceptable when the mean absolute difference of its overlap is within `threshold`
 * and no single row of the overlap has a mean absolute difference over `maxRowDiff`. The row
 * rule is for overlaps that are mostly blank: a few rows that differ completely hardly move the
 * mean, but they show that the two slices do not show the same content there.
 *
 * Decision order:
 * 1. `d = 0` overlap is flat (standard deviation below `flatStdDev`): `ambiguous`, shift 0.
 * 2. `d = 0` is acceptable: `exact`, shift 0.
 * 3. Otherwise the acceptable shift with the lowest mean difference: `corrected`.
 *    Ties go to the smallest |d|, then to the positive shift. A shift whose own overlap is flat
 *    never wins: a blank region matches any other blank region, so it proves nothing.
 * 4. Otherwise `unmatched`, shift 0.
 *
 * `meanDiff` is the mean at the reported shift (at `d = 0` for `unmatched`). For `unmatched` it is
 * 255 when the overlap at `d = 0` has fewer than `minOverlap` rows: nothing was compared there.
 * The work for a shift stops as soon as it cannot be acceptable or cannot beat the best
 * candidate.
 *
 * @param {SeamParams} params
 * @returns {SeamMatch}
 */
export function matchSeam(params) {
  if (params === null || typeof params !== 'object') {
    throw new TypeError('params must be an object');
  }
  const {
    upper,
    lower,
    cols,
    upperHeight,
    lowerHeight,
    expectedOffset,
    maxShift,
    minOverlap,
    threshold,
    maxRowDiff,
    flatStdDev,
  } = params;
  assertInt('cols', cols, 1);
  assertInt('upperHeight', upperHeight, 1);
  assertInt('lowerHeight', lowerHeight, 1);
  assertInt('expectedOffset', expectedOffset, 0);
  assertInt('maxShift', maxShift, 0);
  assertInt('minOverlap', minOverlap, 1);
  assertNonNegative('threshold', threshold);
  assertNonNegative('maxRowDiff', maxRowDiff);
  assertNonNegative('flatStdDev', flatStdDev);
  assertSignature('upper', upper, upperHeight * cols);
  assertSignature('lower', lower, lowerHeight * cols);

  /** Rows that two slices share when the top of `lower` sits on row `start` of `upper`. */
  const overlapRows = (/** @type {number} */ start) => Math.min(upperHeight - start, lowerHeight);

  let meanDiffAtZero = NO_COMPARISON_DIFF;
  const rowsAtZero = overlapRows(expectedOffset);
  if (rowsAtZero >= minOverlap) {
    const base = expectedOffset * cols;
    // No early stop here: `meanDiff` of an unmatched result is the value at `d = 0`.
    const atZero = compareOverlap(upper, base, lower, rowsAtZero, cols, Infinity, Infinity);
    meanDiffAtZero = atZero.sum / (rowsAtZero * cols);
    if (overlapStdDev(upper, base, lower, rowsAtZero, cols) < flatStdDev) {
      return { status: 'ambiguous', shift: 0, meanDiff: meanDiffAtZero };
    }
    if (meanDiffAtZero <= threshold && atZero.worstRowDiff <= maxRowDiff) {
      return { status: 'exact', shift: 0, meanDiff: meanDiffAtZero };
    }
  }

  let bestShift = 0;
  let bestMean = Infinity;
  for (let k = 1; k <= maxShift; k++) {
    // +k before -k, so equal means keep the positive shift.
    for (let d = k; d >= -k; d -= 2 * k) {
      const start = expectedOffset + d;
      if (start < 0) continue;
      const rows = overlapRows(start);
      if (rows < minOverlap) continue;
      const total = rows * cols;
      const limit = Math.min(threshold, bestMean) * total;
      const { sum, worstRowDiff } = compareOverlap(
        upper,
        start * cols,
        lower,
        rows,
        cols,
        limit,
        maxRowDiff,
      );
      if (sum > limit || worstRowDiff > maxRowDiff) continue;
      const mean = sum / total;
      // Only the rare candidates that pass the cheap checks get the flat test.
      if (mean < bestMean && overlapStdDev(upper, start * cols, lower, rows, cols) >= flatStdDev) {
        bestMean = mean;
        bestShift = d;
      }
    }
  }

  if (bestShift !== 0) return { status: 'corrected', shift: bestShift, meanDiff: bestMean };
  return { status: 'unmatched', shift: 0, meanDiff: meanDiffAtZero };
}
