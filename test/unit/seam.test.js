// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { matchSeam, rowSignature } from '../../src/lib/seam.js';
import { SEAM, SIGNATURE_MAX_COLS } from '../../src/shared/constants.js';

/**
 * Small seeded random generator (mulberry32), so every run sees the same images.
 * @param {number} seed
 * @returns {() => number}  Floats in [0, 1).
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const WIDTH = 96;
const COLS = Math.min(SIGNATURE_MAX_COLS, WIDTH);

/**
 * RGBA image of random colour noise.
 * @param {number} width
 * @param {number} height
 * @param {number} seed
 * @returns {Uint8Array}
 */
function noiseImage(width, height, seed) {
  const random = createRandom(seed);
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < rgba.length; i++) rgba[i] = i % 4 === 3 ? 255 : Math.floor(random() * 256);
  return rgba;
}

/**
 * RGBA image that looks like a page of text: white background, lines of dark "words" with
 * random widths and random gaps between the lines.
 * @param {number} width
 * @param {number} height
 * @param {number} seed
 * @returns {Uint8Array}
 */
function textImage(width, height, seed) {
  const random = createRandom(seed);
  const rgba = new Uint8Array(width * height * 4).fill(255);
  let y = 3 + Math.floor(random() * 10);
  while (y < height) {
    const lineHeight = 8 + Math.floor(random() * 7);
    const ink = 20 + Math.floor(random() * 80);
    let x = 2 + Math.floor(random() * 6);
    while (x < width - 4) {
      const end = Math.min(width - 2, x + 3 + Math.floor(random() * 18));
      for (let row = y; row < Math.min(height, y + lineHeight); row++) {
        for (let px = x; px < end; px++) {
          const i = (row * width + px) * 4;
          rgba[i] = rgba[i + 1] = rgba[i + 2] = ink;
        }
      }
      x = end + 2 + Math.floor(random() * 6);
    }
    y += lineHeight + 4 + Math.floor(random() * 20);
  }
  return rgba;
}

/**
 * Signature of rows `[top, top + rows)` of a WIDTH-wide RGBA page.
 * @param {Uint8Array} page
 * @param {number} top
 * @param {number} rows
 * @returns {Uint8Array}
 */
function signatureOf(page, top, rows) {
  const slice = page.subarray(top * WIDTH * 4, (top + rows) * WIDTH * 4);
  return rowSignature(slice, WIDTH, rows, COLS);
}

/** The production search settings (everything except the signatures and the geometry). */
const PRODUCTION = Object.freeze({
  maxShift: SEAM.maxShiftRows,
  minOverlap: SEAM.minOverlapRows,
  threshold: SEAM.threshold,
  maxRowDiff: SEAM.maxRowDiff,
  flatStdDev: SEAM.flatStdDev,
});

/**
 * Largest mean absolute difference of one row between two signatures of the same size.
 * @param {Uint8Array} a
 * @param {Uint8Array} b
 * @returns {number}
 */
function worstRowDiff(a, b) {
  let worst = 0;
  for (let r = 0; r < a.length / COLS; r++) {
    let sum = 0;
    for (let c = 0; c < COLS; c++) sum += Math.abs(a[r * COLS + c] - b[r * COLS + c]);
    worst = Math.max(worst, sum / COLS);
  }
  return worst;
}

/**
 * Runs matchSeam with the production thresholds on two slices of one page.
 * @param {Uint8Array} page
 * @param {{ upperHeight: number, lowerTop: number, lowerHeight: number,
 *   expectedOffset: number }} slices
 * @param {Partial<import('../../src/lib/seam.js').SeamParams>} [overrides]
 */
function seamOnPage(page, slices, overrides = {}) {
  const { upperHeight, lowerTop, lowerHeight, expectedOffset } = slices;
  return matchSeam({
    upper: signatureOf(page, 0, upperHeight),
    lower: signatureOf(page, lowerTop, lowerHeight),
    cols: COLS,
    upperHeight,
    lowerHeight,
    expectedOffset,
    ...PRODUCTION,
    ...overrides,
  });
}

describe('rowSignature', () => {
  /**
   * @param {number[][]} pixels  [r, g, b, a?] per pixel of a one-row image.
   * @returns {Uint8Array}
   */
  const oneRow = (pixels) => Uint8Array.from(pixels.flatMap(([r, g, b, a = 255]) => [r, g, b, a]));

  test('uses the luminance formula (77R + 150G + 29B) >> 8 and ignores alpha', () => {
    const pixels = [
      [255, 0, 0],
      [0, 255, 0],
      [0, 0, 255],
      [255, 255, 255],
      [0, 0, 0],
      [10, 20, 30],
      [200, 100, 50],
    ];
    const signature = rowSignature(oneRow(pixels), pixels.length, 1, pixels.length);
    assert.deepEqual([...signature], [76, 149, 28, 255, 0, 18, 124]);
    assert.equal(rowSignature(oneRow([[200, 100, 50, 0]]), 1, 1, 1)[0], 124);
    assert.equal(rowSignature(oneRow([[200, 100, 50, 77]]), 1, 1, 1)[0], 124);
  });

  test('a bin is the mean of its pixels, rounded to the nearest integer', () => {
    // 76 and 149 average to 112.5, which rounds up. 76 and 28 average to exactly 52.
    assert.equal(rowSignature(oneRow([[255, 0, 0], [0, 255, 0]]), 2, 1, 1)[0], 113);
    assert.equal(rowSignature(oneRow([[255, 0, 0], [0, 0, 255]]), 2, 1, 1)[0], 52);
    // 255 stays 255: the rounding term never carries a full bin over the top.
    const white = [255, 255, 255];
    assert.equal(rowSignature(oneRow([white, white, white]), 3, 1, 1)[0], 255);
  });

  test('lays out rows one after the other, `cols` values per row', () => {
    // 2 rows of 4 grey pixels, 2 bins per row.
    const grey = [10, 20, 30, 40, 100, 110, 120, 130];
    const rgba = Uint8Array.from(grey.flatMap((g) => [g, g, g, 255]));
    assert.deepEqual([...rowSignature(rgba, 4, 2, 2)], [15, 35, 105, 125]);
  });

  test('splits a width that is not a multiple of cols into bins that differ by one pixel', () => {
    // Pixel i is grey 10*i. Bins: [0,2) [2,5) [5,7) [7,10) -> 5, 30, 55, 80.
    const pixels = Array.from({ length: 10 }, (_, i) => [10 * i, 10 * i, 10 * i]);
    assert.deepEqual([...rowSignature(oneRow(pixels), 10, 1, 4)], [5, 30, 55, 80]);
  });

  test('gives every bin at least one pixel when width < cols', () => {
    const rgba = oneRow([
      [10, 10, 10],
      [100, 100, 100],
      [200, 200, 200],
    ]);
    assert.deepEqual([...rowSignature(rgba, 3, 1, 8)], [10, 10, 10, 100, 100, 100, 200, 200]);
    assert.deepEqual([...rowSignature(oneRow([[50, 50, 50]]), 1, 1, 4)], [50, 50, 50, 50]);
  });

  test('gives one value per pixel when cols equals width', () => {
    const rgba = oneRow([
      [0, 0, 0],
      [255, 255, 255],
      [90, 90, 90],
    ]);
    assert.deepEqual([...rowSignature(rgba, 3, 1, 3)], [0, 255, 90]);
  });

  test('accepts Uint8ClampedArray (ImageData.data) and typed array views', () => {
    const page = noiseImage(WIDTH, 40, 3);
    const expected = rowSignature(page.subarray(10 * WIDTH * 4, 30 * WIDTH * 4), WIDTH, 20, COLS);
    const clamped = new Uint8ClampedArray(page.buffer, 10 * WIDTH * 4, 20 * WIDTH * 4);
    assert.deepEqual(rowSignature(clamped, WIDTH, 20, COLS), expected);
  });

  test('rejects bad arguments', () => {
    const rgba = new Uint8Array(4 * 2 * 4);
    assert.throws(() => rowSignature(/** @type {any} */ ([...rgba]), 4, 2, 2), TypeError);
    assert.throws(() => rowSignature(rgba, 4, 3, 2), RangeError);
    assert.throws(() => rowSignature(rgba, 0, 2, 2), RangeError);
    assert.throws(() => rowSignature(rgba, 4, 2, 0), RangeError);
    assert.throws(() => rowSignature(rgba, 4, 2, 1.5), RangeError);
    assert.throws(() => rowSignature(rgba, 4, /** @type {any} */ ('2'), 2), TypeError);
  });

  test('rejects a width or a height of 0, also when the buffer is empty', () => {
    // 0 * height * 4 is 0 bytes, so the length check alone would let this pass.
    assert.throws(() => rowSignature(new Uint8Array(0), 0, 5, 2), /width must/);
    assert.throws(() => rowSignature(new Uint8Array(0), 5, 0, 2), /height must/);
    // The smallest valid image: 1 x 1.
    assert.deepEqual([...rowSignature(Uint8Array.of(0, 0, 0, 255), 1, 1, 1)], [0]);
  });

  test('rejects a width, a height or cols that is not a whole number, also when the bytes fit', () => {
    // '4' * 2 * 4 is 32 and 2.5 * 2 * 4 is 20, so the length check passes for these.
    assert.throws(
      () => rowSignature(new Uint8Array(32), /** @type {any} */ ('4'), 2, 2),
      /^TypeError: width must/,
    );
    assert.throws(() => rowSignature(new Uint8Array(20), 2.5, 2, 1), /^RangeError: width must/);
    assert.throws(() => rowSignature(new Uint8Array(20), 2, 2.5, 1), /^RangeError: height must/);
    assert.throws(
      () => rowSignature(new Uint8Array(32), 4, 2, /** @type {any} */ ('2')),
      /^TypeError: cols must/,
    );
    assert.throws(() => rowSignature(new Uint8Array(32), 4, 2, -1), /^RangeError: cols must/);
  });

  test('names the argument that does not match the byte count', () => {
    assert.throws(() => rowSignature(new Uint8Array(31), 4, 2, 2), /rgba must have .* 32 bytes/);
    assert.throws(
      () => rowSignature(/** @type {any} */ ('abc'), 4, 2, 2),
      /^TypeError: rgba must be a Uint8Array or a Uint8ClampedArray$/,
    );
  });
});

for (const [kind, makeImage] of /** @type {const} */ ([
  ['noise', noiseImage],
  ['text', textImage],
])) {
  describe(`matchSeam on ${kind} content`, () => {
    const page = makeImage(WIDTH, 800, 7);
    const base = { upperHeight: 300, lowerHeight: 300, expectedOffset: 150 };

    test('finds an exact match at the expected offset', () => {
      const match = seamOnPage(page, { ...base, lowerTop: 150 });
      assert.deepEqual(match, { status: 'exact', shift: 0, meanDiff: 0 });
    });

    test('corrects a true shift of +7 rows', () => {
      const match = seamOnPage(page, { ...base, lowerTop: 157 });
      assert.deepEqual(match, { status: 'corrected', shift: 7, meanDiff: 0 });
    });

    test('corrects a true shift of -12 rows', () => {
      const match = seamOnPage(page, { ...base, lowerTop: 138 });
      assert.deepEqual(match, { status: 'corrected', shift: -12, meanDiff: 0 });
    });

    test('corrects shifts at the edge of the search range', () => {
      const max = SEAM.maxShiftRows;
      for (const shift of [max, -max]) {
        const match = seamOnPage(makeImage(WIDTH, 1200, 11), {
          upperHeight: 600,
          lowerTop: 300 + shift,
          lowerHeight: 600,
          expectedOffset: 300,
        });
        assert.deepEqual(match, { status: 'corrected', shift, meanDiff: 0 });
      }
    });

    test('does not match unrelated images', () => {
      const other = makeImage(WIDTH, 800, 8);
      const match = matchSeam({
        upper: signatureOf(page, 0, 300),
        lower: signatureOf(other, 150, 300),
        cols: COLS,
        ...base,
        maxShift: SEAM.maxShiftRows,
        minOverlap: SEAM.minOverlapRows,
        threshold: SEAM.threshold,
        maxRowDiff: SEAM.maxRowDiff,
        flatStdDev: SEAM.flatStdDev,
      });
      assert.equal(match.status, 'unmatched');
      assert.equal(match.shift, 0);
      assert.ok(match.meanDiff > SEAM.threshold, `meanDiff ${match.meanDiff}`);
    });
  });
}

describe('matchSeam decisions', () => {
  const base = { upperHeight: 300, lowerHeight: 300, expectedOffset: 150 };

  test('reports a flat overlap as ambiguous', () => {
    const white = new Uint8Array(WIDTH * 500 * 4).fill(255);
    assert.deepEqual(seamOnPage(white, { ...base, lowerTop: 150 }), {
      status: 'ambiguous',
      shift: 0,
      meanDiff: 0,
    });
  });

  test('a nearly flat overlap (standard deviation below flatStdDev) is ambiguous too', () => {
    const random = createRandom(5);
    const page = new Uint8Array(WIDTH * 500 * 4);
    for (let i = 0; i < page.length; i++) page[i] = 250 + Math.floor(random() * 3);
    const match = seamOnPage(page, { ...base, lowerTop: 150 });
    assert.equal(match.status, 'ambiguous');
    assert.equal(match.shift, 0);
  });

  test('flat overlaps of different tones are not ambiguous', () => {
    const white = new Uint8Array(WIDTH * 300 * 4).fill(255);
    const black = new Uint8Array(WIDTH * 300 * 4).fill(0);
    const match = matchSeam({
      upper: rowSignature(white, WIDTH, 300, COLS),
      lower: rowSignature(black, WIDTH, 300, COLS),
      cols: COLS,
      ...base,
      maxShift: SEAM.maxShiftRows,
      minOverlap: SEAM.minOverlapRows,
      threshold: SEAM.threshold,
      maxRowDiff: SEAM.maxRowDiff,
      flatStdDev: SEAM.flatStdDev,
    });
    assert.deepEqual(match, { status: 'unmatched', shift: 0, meanDiff: 255 });
  });

  test('tolerates small differences and reports them in meanDiff', () => {
    const random = createRandom(9);
    const page = noiseImage(WIDTH, 800, 4);
    const lowerRows = page.slice(150 * WIDTH * 4, 450 * WIDTH * 4);
    for (let i = 0; i < lowerRows.length; i++) {
      if (i % 4 === 3) continue;
      const nudged = lowerRows[i] + Math.floor(random() * 5) - 2;
      lowerRows[i] = Math.max(0, Math.min(255, nudged));
    }
    const match = matchSeam({
      upper: signatureOf(page, 0, 300),
      lower: rowSignature(lowerRows, WIDTH, 300, COLS),
      cols: COLS,
      ...base,
      maxShift: SEAM.maxShiftRows,
      minOverlap: SEAM.minOverlapRows,
      threshold: SEAM.threshold,
      maxRowDiff: SEAM.maxRowDiff,
      flatStdDev: SEAM.flatStdDev,
    });
    assert.equal(match.status, 'exact');
    assert.ok(match.meanDiff > 0 && match.meanDiff <= SEAM.threshold, `meanDiff ${match.meanDiff}`);
  });

  test('respects minOverlap: a shift with too few overlapping rows is skipped', () => {
    const page = noiseImage(WIDTH, 400, 21);
    // Lower really starts at row 90, 10 rows below the expected 80: the overlap is 10 rows.
    const slices = { upperHeight: 100, lowerTop: 90, lowerHeight: 100, expectedOffset: 80 };
    assert.deepEqual(seamOnPage(page, slices, { minOverlap: 10 }), {
      status: 'corrected',
      shift: 10,
      meanDiff: 0,
    });
    assert.equal(seamOnPage(page, slices, { minOverlap: 11 }).status, 'unmatched');
  });

  test('respects minOverlap at the expected offset', () => {
    const page = noiseImage(WIDTH, 400, 22);
    const slices = { upperHeight: 100, lowerTop: 90, lowerHeight: 100, expectedOffset: 90 };
    assert.equal(seamOnPage(page, slices, { minOverlap: 10 }).status, 'exact');
    // 10 rows cannot be compared: nothing was compared, so meanDiff is the worst value.
    assert.deepEqual(seamOnPage(page, slices, { minOverlap: 11 }), {
      status: 'unmatched',
      shift: 0,
      meanDiff: 255,
    });
  });

  test('respects maxShift', () => {
    const page = noiseImage(WIDTH, 800, 23);
    for (const shift of [20, -20]) {
      const slices = { ...base, lowerTop: 150 + shift };
      assert.deepEqual(seamOnPage(page, slices, { maxShift: 20 }), {
        status: 'corrected',
        shift,
        meanDiff: 0,
      });
      assert.equal(seamOnPage(page, slices, { maxShift: 19 }).status, 'unmatched');
    }
    assert.equal(seamOnPage(page, { ...base, lowerTop: 157 }, { maxShift: 0 }).status, 'unmatched');
    assert.equal(seamOnPage(page, { ...base, lowerTop: 150 }, { maxShift: 0 }).status, 'exact');
  });

  test('compares only lowerHeight rows when the lower slice is shorter than the overlap', () => {
    const page = noiseImage(WIDTH, 600, 24);
    // The overlap at the expected offset is 200 rows, but `lower` has 50.
    const slices = { upperHeight: 300, lowerHeight: 50, expectedOffset: 100 };
    assert.deepEqual(seamOnPage(page, { ...slices, lowerTop: 100 }), {
      status: 'exact',
      shift: 0,
      meanDiff: 0,
    });
    assert.deepEqual(seamOnPage(page, { ...slices, lowerTop: 105 }), {
      status: 'corrected',
      shift: 5,
      meanDiff: 0,
    });
    assert.deepEqual(seamOnPage(page, { ...slices, lowerTop: 90 }), {
      status: 'corrected',
      shift: -10,
      meanDiff: 0,
    });
  });

  test('cannot compare when the lower slice is shorter than minOverlap', () => {
    const page = noiseImage(WIDTH, 600, 25);
    const slices = { upperHeight: 300, lowerTop: 100, lowerHeight: 15, expectedOffset: 100 };
    assert.deepEqual(seamOnPage(page, slices), { status: 'unmatched', shift: 0, meanDiff: 255 });
  });

  test('is unmatched when the lower slice starts below the upper slice', () => {
    const page = noiseImage(WIDTH, 600, 26);
    const slices = { upperHeight: 200, lowerTop: 250, lowerHeight: 200, expectedOffset: 250 };
    assert.deepEqual(seamOnPage(page, slices), { status: 'unmatched', shift: 0, meanDiff: 255 });
  });

  test('prefers the smaller |shift| when several shifts match equally', () => {
    // Rows repeat every 10 rows, so every shift that is 3 mod 10 is a perfect match.
    const rows = 500;
    const page = new Uint8Array(WIDTH * rows * 4);
    for (let y = 0; y < rows; y++) {
      page.fill(y % 10 < 5 ? 30 : 200, y * WIDTH * 4, (y + 1) * WIDTH * 4);
    }
    const slices = { upperHeight: 200, lowerHeight: 200, expectedOffset: 100 };
    // Lower at 103: candidates 3, -7, 13, -17, ... The smallest |d| is 3.
    assert.equal(seamOnPage(page, { ...slices, lowerTop: 103 }).shift, 3);
    // Lower at 96: candidates -4, 6, -14, ... The smallest |d| is -4.
    assert.equal(seamOnPage(page, { ...slices, lowerTop: 96 }).shift, -4);
    // Lower at 105: candidates 5 and -5 tie on |d|. The positive one wins.
    assert.equal(seamOnPage(page, { ...slices, lowerTop: 105 }).shift, 5);
  });

  test('does not accept a shift whose own overlap is flat', () => {
    // Rows 0-99 are noise and the rest is white, and `lower` is white. At the expected offset
    // the overlap holds 20 noise rows, so it does not match. From shift +20 on, the overlap is
    // white against white: a zero difference that proves nothing.
    const page = new Uint8Array(WIDTH * 600 * 4).fill(255);
    page.set(noiseImage(WIDTH, 100, 31));
    const slices = { upperHeight: 300, lowerTop: 300, lowerHeight: 300, expectedOffset: 80 };
    assert.equal(seamOnPage(page, slices, { threshold: 0.1 }).status, 'unmatched');
  });

  describe('per-row difference (maxRowDiff)', () => {
    test('a mostly blank overlap with 2 rows of strong difference is not exact', () => {
      // 300 overlapping rows. In `lower` the rows 40 and 41 are dark (55) and the rest is white.
      // The mean difference is 2 * 200 / 300 = 1.33, far below the threshold, but 2 rows differ
      // by 200 each. Those rows are not the same content.
      const upperImage = new Uint8Array(WIDTH * 600 * 4).fill(255);
      const lowerImage = new Uint8Array(WIDTH * 300 * 4).fill(255);
      lowerImage.fill(55, 40 * WIDTH * 4, 42 * WIDTH * 4);
      const params = {
        ...PRODUCTION,
        upper: rowSignature(upperImage, WIDTH, 600, COLS),
        lower: rowSignature(lowerImage, WIDTH, 300, COLS),
        cols: COLS,
        upperHeight: 600,
        lowerHeight: 300,
        expectedOffset: 150,
      };
      const match = matchSeam(params);
      assert.equal(match.status, 'unmatched');
      assert.equal(match.shift, 0);
      assert.ok(Math.abs(match.meanDiff - 400 / 300) < 1e-9, `meanDiff ${match.meanDiff}`);
      // Without the row rule the same overlap is exact: the rule alone makes the difference.
      assert.deepEqual(matchSeam({ ...params, maxRowDiff: 255 }), {
        status: 'exact',
        shift: 0,
        meanDiff: match.meanDiff,
      });
    });

    test('a text overlap with anti-alias noise on the glyph edges is exact', () => {
      const page = textImage(WIDTH, 800, 7);
      const random = createRandom(77);
      const rows = page.slice(150 * WIDTH * 4, 450 * WIDTH * 4);
      const clean = rows.slice();
      // Every pixel next to an ink/paper edge moves by 1 to 24 levels, up or down.
      for (let y = 0; y < 300; y++) {
        for (let x = 1; x < WIDTH; x++) {
          const i = (y * WIDTH + x) * 4;
          if (clean[i] === clean[i - 4]) continue;
          const nudge = (1 + Math.floor(random() * 24)) * (random() < 0.5 ? -1 : 1);
          rows.fill(Math.max(0, Math.min(255, clean[i] + nudge)), i, i + 3);
        }
      }
      const lower = rowSignature(rows, WIDTH, 300, COLS);
      const upper = signatureOf(page, 0, 300);
      const worst = worstRowDiff(upper.subarray(150 * COLS), lower.subarray(0, 150 * COLS));
      // The noise is real (some rows differ) and small (below the limits).
      assert.ok(worst > 1 && worst <= SEAM.maxRowDiff, `worst row ${worst}`);
      const match = matchSeam({
        ...PRODUCTION,
        upper,
        lower,
        cols: COLS,
        upperHeight: 300,
        lowerHeight: 300,
        expectedOffset: 150,
      });
      assert.equal(match.status, 'exact');
      assert.equal(match.shift, 0);
      const { meanDiff } = match;
      assert.ok(meanDiff > 0 && meanDiff <= SEAM.threshold, `meanDiff ${meanDiff}`);
    });

    test('accepts a row that differs by exactly maxRowDiff and rejects one level more', () => {
      const page = noiseImage(WIDTH, 600, 41);
      const upper = signatureOf(page, 0, 300);
      /** @param {number} level  Every value of row 10 of `lower` moves by this much. */
      const run = (level) => {
        const lower = signatureOf(page, 150, 300);
        for (let c = 0; c < COLS; c++) {
          const i = 10 * COLS + c;
          lower[i] = lower[i] + level <= 255 ? lower[i] + level : lower[i] - level;
        }
        return matchSeam({
          ...PRODUCTION,
          upper,
          lower,
          cols: COLS,
          upperHeight: 300,
          lowerHeight: 300,
          expectedOffset: 150,
        });
      };
      assert.equal(run(SEAM.maxRowDiff).status, 'exact');
      assert.equal(run(SEAM.maxRowDiff + 1).status, 'unmatched');
    });

    test('also applies to a corrected shift', () => {
      // The lower slice really sits 7 rows below its expected place. Two of its rows are
      // inverted (a difference of 127 or more per value): the mean stays under the threshold.
      const page = textImage(WIDTH, 800, 7);
      const upper = signatureOf(page, 0, 300);
      const lower = signatureOf(page, 67, 300);
      for (const row of [100, 101]) {
        for (let c = 0; c < COLS; c++) {
          const i = row * COLS + c;
          lower[i] = lower[i] < 128 ? 255 : 0;
        }
      }
      const params = {
        ...PRODUCTION,
        upper,
        lower,
        cols: COLS,
        upperHeight: 300,
        lowerHeight: 300,
        expectedOffset: 60,
      };
      const lenient = matchSeam({ ...params, maxRowDiff: 255 });
      assert.equal(lenient.status, 'corrected');
      assert.equal(lenient.shift, 7);
      assert.ok(lenient.meanDiff > 0 && lenient.meanDiff <= SEAM.threshold);
      const strict = matchSeam(params);
      assert.equal(strict.status, 'unmatched');
      assert.equal(strict.shift, 0);
    });
  });

  test('rejects bad arguments', () => {
    const page = noiseImage(WIDTH, 400, 27);
    const valid = {
      upper: signatureOf(page, 0, 100),
      lower: signatureOf(page, 50, 100),
      cols: COLS,
      upperHeight: 100,
      lowerHeight: 100,
      expectedOffset: 50,
      maxShift: 10,
      minOverlap: 16,
      threshold: 3,
      maxRowDiff: 24,
      flatStdDev: 2,
    };
    assert.equal(matchSeam(valid).status, 'exact');
    const bad = /** @param {Record<string, unknown>} change */ (change) =>
      () => matchSeam(/** @type {any} */ ({ ...valid, ...change }));
    assert.throws(() => matchSeam(/** @type {any} */ (null)), TypeError);
    assert.throws(bad({ upper: [...valid.upper] }), TypeError);
    assert.throws(bad({ upper: valid.upper.subarray(1) }), RangeError);
    assert.throws(bad({ lower: valid.lower.subarray(1) }), RangeError);
    assert.throws(bad({ cols: COLS + 1 }), RangeError);
    assert.throws(bad({ expectedOffset: -1 }), RangeError);
    assert.throws(bad({ expectedOffset: 1.5 }), RangeError);
    assert.throws(bad({ maxShift: -1 }), RangeError);
    assert.throws(bad({ minOverlap: 0 }), RangeError);
    assert.throws(bad({ threshold: -1 }), RangeError);
    assert.throws(bad({ threshold: Number.NaN }), RangeError);
    assert.throws(bad({ maxRowDiff: -1 }), RangeError);
    assert.throws(bad({ maxRowDiff: Number.NaN }), RangeError);
    assert.throws(bad({ maxRowDiff: Infinity }), RangeError);
    assert.throws(bad({ maxRowDiff: undefined }), TypeError);
    assert.throws(bad({ flatStdDev: Infinity }), RangeError);
    assert.throws(bad({ upperHeight: '100' }), TypeError);
  });
});

describe('matchSeam boundaries', () => {
  /**
   * Signatures with one value per row (cols = 1) from a list of levels.
   * @param {number[]} levels
   * @returns {Uint8Array}
   */
  const column = (levels) => Uint8Array.from(levels);
  /** @param {number} length @param {(row: number) => number} level @returns {Uint8Array} */
  const rows = (length, level) => column(Array.from({ length }, (_, row) => level(row)));

  /** @param {Partial<import('../../src/lib/seam.js').SeamParams>} change */
  const match = (change) =>
    matchSeam({
      upper: rows(4, () => 100),
      lower: rows(4, () => 102),
      cols: 1,
      upperHeight: 4,
      lowerHeight: 4,
      expectedOffset: 0,
      maxShift: 0,
      minOverlap: 4,
      threshold: 3,
      maxRowDiff: 24,
      flatStdDev: 2,
      ...change,
    });

  describe('flatStdDev', () => {
    // The overlap holds 4 values of 100 and 4 of 102: mean 101, standard deviation exactly 1.
    // All sums are small whole numbers, so the value is exact in floating point.
    test('an overlap is flat only when its standard deviation is below flatStdDev', () => {
      assert.equal(match({ flatStdDev: 1.0001 }).status, 'ambiguous');
      assert.deepEqual(match({ flatStdDev: 1 }), { status: 'exact', shift: 0, meanDiff: 2 });
      assert.equal(match({ flatStdDev: 0.9999 }).status, 'exact');
      assert.equal(match({ flatStdDev: 0 }).status, 'exact');
    });

    test('a constant overlap has the standard deviation 0, not 1', () => {
      const constant = { upper: rows(4, () => 100), lower: rows(4, () => 100) };
      assert.equal(match({ ...constant, flatStdDev: 1 }).status, 'ambiguous');
      assert.equal(match({ ...constant, flatStdDev: 0.001 }).status, 'ambiguous');
      assert.equal(match({ ...constant, flatStdDev: 0 }).status, 'exact');
    });

    test('the standard deviation does not depend on the level of the values', () => {
      // Same spread (1) at a high level and at a low level. A wrong mean would change it.
      for (const level of [0, 1, 50, 100, 253]) {
        const upper = rows(4, () => level);
        const lower = rows(4, () => level + 2);
        assert.equal(match({ upper, lower, flatStdDev: 1.0001 }).status, 'ambiguous', `${level}`);
        assert.equal(match({ upper, lower, flatStdDev: 0.9999 }).status, 'exact', `${level}`);
      }
    });

    test('a shift whose overlap has exactly flatStdDev is not flat', () => {
      // Both signatures alternate 100, 102. At the expected offset 1 the rows are out of step
      // (every difference is 2, over the threshold of 1). Shifts +1 and -1 line them up. The
      // standard deviation is 1 at every shift, so with flatStdDev 1 nothing is flat.
      const upper = rows(40, (row) => (row % 2 === 0 ? 100 : 102));
      const lower = rows(20, (row) => (row % 2 === 0 ? 100 : 102));
      const params = {
        upper,
        lower,
        upperHeight: 40,
        lowerHeight: 20,
        expectedOffset: 1,
        maxShift: 3,
        minOverlap: 4,
        threshold: 1,
      };
      assert.deepEqual(match({ ...params, flatStdDev: 1 }), {
        status: 'corrected',
        shift: 1,
        meanDiff: 0,
      });
      // A flatStdDev just above 1 makes every one of those overlaps flat: nothing can win.
      assert.equal(match({ ...params, flatStdDev: 1.0001 }).status, 'ambiguous');
    });
  });

  describe('maxRowDiff and threshold', () => {
    test('maxRowDiff 0 accepts rows that are identical', () => {
      const page = noiseImage(WIDTH, 400, 51);
      const slices = { upperHeight: 100, lowerTop: 50, lowerHeight: 100, expectedOffset: 50 };
      assert.deepEqual(seamOnPage(page, slices, { maxRowDiff: 0 }), {
        status: 'exact',
        shift: 0,
        meanDiff: 0,
      });
    });

    test('maxRowDiff 0 refuses rows that differ by one level', () => {
      const upper = rows(4, () => 100);
      const lower = rows(4, (row) => (row === 2 ? 101 : 100));
      // The mean is 0.25, within the threshold. The row rule alone refuses it.
      assert.equal(match({ upper, lower, flatStdDev: 0, maxRowDiff: 0 }).status, 'unmatched');
      assert.equal(match({ upper, lower, flatStdDev: 0, maxRowDiff: 1 }).status, 'exact');
    });

    test('threshold 0 accepts only an identical overlap', () => {
      const upper = rows(4, (row) => 100 + row);
      assert.equal(match({ upper, lower: upper, flatStdDev: 0, threshold: 0 }).status, 'exact');
      const off = rows(4, (row) => (row === 0 ? 101 : 100 + row));
      assert.equal(match({ upper, lower: off, flatStdDev: 0, threshold: 0 }).status, 'unmatched');
    });
  });

  describe('sizes', () => {
    test('accepts the smallest valid sizes', () => {
      const one = column([100]);
      assert.deepEqual(
        match({ upper: one, lower: one, upperHeight: 1, lowerHeight: 1, minOverlap: 1, flatStdDev: 0 }),
        { status: 'exact', shift: 0, meanDiff: 0 },
      );
    });

    test('rejects 0 rows and 0 columns, also when the signatures are empty', () => {
      const none = new Uint8Array(0);
      assert.throws(() => match({ upper: none, upperHeight: 0 }), /^RangeError: upperHeight must/);
      assert.throws(() => match({ lower: none, lowerHeight: 0 }), /^RangeError: lowerHeight must/);
      assert.throws(
        () => match({ upper: none, lower: none, cols: 0 }),
        /^RangeError: cols must/,
      );
    });

    test('rejects a fractional cols or row count, also when the lengths fit', () => {
      // 2 rows * 1.5 cols = 3 values, which is the length of both signatures here.
      const three = column([1, 2, 3]);
      const fractional = { upper: three, lower: three, upperHeight: 2, lowerHeight: 2 };
      assert.throws(() => match({ ...fractional, cols: 1.5 }), /^RangeError: cols must/);
      // 2 cols * 1.5 rows = 3 values.
      assert.throws(
        () => match({ upper: three, lower: three, cols: 2, upperHeight: 1.5, lowerHeight: 2 }),
        /^RangeError: upperHeight must/,
      );
      assert.throws(
        () => match({ upper: three, lower: three, cols: 2, upperHeight: 2, lowerHeight: 1.5 }),
        /^RangeError: lowerHeight must/,
      );
    });

    test('names the argument that is not valid', () => {
      const named = (/** @type {Partial<import('../../src/lib/seam.js').SeamParams>} */ change,
        /** @type {RegExp} */ pattern) =>
        assert.throws(
          () => match(/** @type {any} */ (change)),
          (error) => error instanceof Error && pattern.test(error.message),
        );
      named({ expectedOffset: -1 }, /^expectedOffset must be an integer >= 0$/);
      named({ maxShift: -1 }, /^maxShift must be an integer >= 0$/);
      named({ minOverlap: 0 }, /^minOverlap must be an integer >= 1$/);
      named({ threshold: -1 }, /^threshold must be a finite number >= 0$/);
      named({ maxRowDiff: -1 }, /^maxRowDiff must be a finite number >= 0$/);
      named({ flatStdDev: -1 }, /^flatStdDev must be a finite number >= 0$/);
      named({ upper: column([1, 2, 3]) }, /^upper must have height \* cols = 4 values$/);
      named({ lower: column([1, 2, 3]) }, /^lower must have height \* cols = 4 values$/);
      named({ upper: /** @type {any} */ ([1, 2, 3, 4]) }, /^upper must be a Uint8Array$/);
      named({ lower: /** @type {any} */ ('abcd') }, /^lower must be a Uint8Array$/);
    });

    test('rejects params that are not an object, with a clear message', () => {
      assert.throws(
        () => matchSeam(/** @type {any} */ (null)),
        /^TypeError: params must be an object$/,
      );
      assert.throws(() => matchSeam(/** @type {any} */ (5)), TypeError);
      assert.throws(() => matchSeam(/** @type {any} */ (undefined)), TypeError);
    });
  });
});

describe('matchSeam against a brute-force reference', () => {
  /**
   * Straightforward implementation of the decision rules: every shift is computed in full.
   * @param {import('../../src/lib/seam.js').SeamParams} p
   */
  function reference(p) {
    /** @param {number} d */
    const measure = (d) => {
      const start = p.expectedOffset + d;
      if (start < 0) return null;
      const rows = Math.min(p.upperHeight - start, p.lowerHeight);
      if (rows < p.minOverlap) return null;
      const n = rows * p.cols;
      let diff = 0;
      let sum = 0;
      let sumSquares = 0;
      for (let i = 0; i < n; i++) {
        const a = p.upper[start * p.cols + i];
        const b = p.lower[i];
        diff += Math.abs(a - b);
        sum += a + b;
        sumSquares += a * a + b * b;
      }
      const mean = sum / (2 * n);
      let worstRowDiff = 0;
      for (let r = 0; r < rows; r++) {
        let rowSum = 0;
        for (let c = 0; c < p.cols; c++) {
          rowSum += Math.abs(p.upper[(start + r) * p.cols + c] - p.lower[r * p.cols + c]);
        }
        worstRowDiff = Math.max(worstRowDiff, rowSum / p.cols);
      }
      return {
        meanDiff: diff / n,
        worstRowDiff,
        stdDev: Math.sqrt(Math.max(0, sumSquares / (2 * n) - mean * mean)),
      };
    };
    /** @param {{ meanDiff: number, worstRowDiff: number }} m */
    const acceptable = (m) => m.meanDiff <= p.threshold && m.worstRowDiff <= p.maxRowDiff;

    const zero = measure(0);
    if (zero) {
      const { meanDiff } = zero;
      if (zero.stdDev < p.flatStdDev) return { status: 'ambiguous', shift: 0, meanDiff };
      if (acceptable(zero)) return { status: 'exact', shift: 0, meanDiff };
    }
    /** @type {{ shift: number, meanDiff: number } | null} */
    let best = null;
    for (let k = 1; k <= p.maxShift; k++) {
      for (const d of [k, -k]) {
        const m = measure(d);
        if (!m || !acceptable(m) || m.stdDev < p.flatStdDev) continue;
        if (best === null || m.meanDiff < best.meanDiff) best = { shift: d, meanDiff: m.meanDiff };
      }
    }
    if (best) return { status: 'corrected', ...best };
    return { status: 'unmatched', shift: 0, meanDiff: zero ? zero.meanDiff : 255 };
  }

  test('gives the same result for 400 random cases (early exits change nothing)', () => {
    const random = createRandom(1234);
    /** @param {number} n @returns {number} */
    const int = (n) => Math.floor(random() * n);
    /** @param {number[]} list @returns {number} */
    const pick = (list) => list[int(list.length)];
    /** @type {Record<string, number>} */
    const seen = {};
    let rowRuleDecided = 0;
    for (let round = 0; round < 400; round++) {
      const cols = 1 + int(8);
      // Signature rows of one page. Cells come from 4 grey levels and some rows are constant.
      // Style 1 is nearly flat everywhere, style 2 is flat in its top half.
      const levels = [0, 85, 170, 255];
      const style = int(3);
      const pageRows = 160;
      const page = new Uint8Array(pageRows * cols);
      for (let y = 0; y < pageRows; y++) {
        const flat = style === 1 || (style === 2 && y < pageRows / 2);
        const rowLevel = random() < 0.2 ? pick(levels) : -1;
        for (let c = 0; c < cols; c++) {
          if (flat) page[y * cols + c] = 200 + int(2);
          else page[y * cols + c] = rowLevel >= 0 ? rowLevel : pick(levels);
        }
      }
      const upperHeight = 20 + int(50);
      const lowerHeight = 10 + int(60);
      const expectedOffset = int(upperHeight + 4);
      const lowerTop = Math.max(0, expectedOffset + int(15) - 7);
      const upper = page.slice(0, upperHeight * cols);
      const lower = page.slice(lowerTop * cols, (lowerTop + lowerHeight) * cols);
      for (const signature of [upper, lower]) {
        for (let i = 0; i < signature.length; i++) if (random() < 0.03) signature[i] = int(256);
      }
      const params = {
        upper,
        lower,
        cols,
        upperHeight,
        lowerHeight,
        expectedOffset,
        maxShift: int(14),
        minOverlap: 1 + int(12),
        threshold: pick([0, 1, 2.5, 5, 20, 60]),
        maxRowDiff: pick([4, 24, 24, 80, 255]),
        flatStdDev: pick([0, 2, 10, 60]),
      };
      const actual = matchSeam(params);
      assert.deepEqual(actual, reference(params), `round ${round}`);
      seen[actual.status] = (seen[actual.status] ?? 0) + 1;
      if (actual.status !== matchSeam({ ...params, maxRowDiff: 255 }).status) rowRuleDecided += 1;
    }
    assert.ok(rowRuleDecided >= 10, `the row rule decided only ${rowRuleDecided} cases`);
    for (const status of ['exact', 'corrected', 'ambiguous', 'unmatched']) {
      assert.ok((seen[status] ?? 0) >= 10, `too few ${status} cases: ${JSON.stringify(seen)}`);
    }
  });
});
