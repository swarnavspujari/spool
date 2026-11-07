// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { piecesForRange, planAssembly } from '../../src/lib/assemble.js';
import { planTiles } from '../../src/lib/tiles.js';

/** @typedef {import('../../src/shared/types.js').SliceInfo} SliceInfo */
/** @typedef {import('../../src/shared/types.js').Piece} Piece */
/** @typedef {import('../../src/lib/assemble.js').AssemblyPlan} AssemblyPlan */

const BASE_SEED = 20261106;

/**
 * Small seeded PRNG (mulberry32). Returns numbers in [0, 1).
 * @param {number} seed
 * @returns {() => number}
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), state | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Random whole number in [min, max].
 * @param {() => number} random
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function randomInt(random, min, max) {
  return min + Math.floor(random() * (max - min + 1));
}

/**
 * Runs `body` once per seed. A failure names its seed. To replay one case, set the environment
 * variable SPOOL_TEST_SEED to that seed.
 * @param {number} count
 * @param {(random: () => number) => void} body
 */
function forEachSeed(count, body) {
  const replay = process.env.SPOOL_TEST_SEED;
  const seeds =
    replay === undefined
      ? Array.from({ length: count }, (_, i) => BASE_SEED + i)
      : [Number(replay)];
  for (const seed of seeds) {
    try {
      body(createRandom(seed));
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Property failed with seed ${seed} (SPOOL_TEST_SEED=${seed}): ${reason}`, {
        cause: error,
      });
    }
  }
}

/**
 * @param {number} index
 * @param {number} yPx
 * @param {number} heightPx
 * @returns {SliceInfo}
 */
function slice(index, yPx, heightPx) {
  return { index, yPx, heightPx, seamStatus: 'exact' };
}

/**
 * @param {number} sliceIndex
 * @param {number} srcY
 * @param {number} dstY
 * @param {number} height
 * @returns {Piece}
 */
function piece(sliceIndex, srcY, dstY, height) {
  return { sliceIndex, srcY, dstY, height };
}

/**
 * Random slices with many overlaps, touching neighbours, gaps, nested slices and duplicates.
 * @param {() => number} random
 * @returns {SliceInfo[]}  In random order.
 */
function randomSlices(random) {
  const count = randomInt(random, 1, 12);
  const slices = [];
  for (let index = 0; index < count; index += 1) {
    slices.push(slice(index, randomInt(random, -100, 600), randomInt(random, 1, 300)));
  }
  return slices;
}

/** @param {SliceInfo[]} slices @returns {SliceInfo[]} */
function sortedByY(slices) {
  return [...slices].sort((a, b) => a.yPx - b.yPx);
}

/**
 * Rows of the full image (relative to the top) that at least one slice covers.
 * @param {SliceInfo[]} slices
 * @returns {Uint8Array}
 */
function coveredRows(slices) {
  const origin = Math.min(...slices.map((s) => s.yPx));
  const end = Math.max(...slices.map((s) => s.yPx + s.heightPx));
  const covered = new Uint8Array(end - origin);
  for (const s of slices) covered.fill(1, s.yPx - origin, s.yPx + s.heightPx - origin);
  return covered;
}

/**
 * Checks that the pieces draw each covered row exactly once, draw nothing else, and read from
 * the right row of a slice that has it. `offset` is the first row of the checked range.
 * @param {SliceInfo[]} slices
 * @param {Piece[]} pieces
 * @param {number} offset
 * @param {number} rangeHeight
 */
function assertPiecesDrawCoveredRows(slices, pieces, offset, rangeHeight) {
  const origin = Math.min(...slices.map((s) => s.yPx));
  const covered = coveredRows(slices);
  const bySliceIndex = new Map(slices.map((s) => [s.index, s]));
  const drawn = new Uint8Array(rangeHeight);

  for (const p of pieces) {
    const source = bySliceIndex.get(p.sliceIndex);
    assert.ok(source, `unknown slice ${p.sliceIndex}`);
    assert.ok(p.height >= 1, 'piece is not empty');
    assert.ok(p.srcY >= 0 && p.srcY + p.height <= source.heightPx, 'piece reads outside slice');
    assert.ok(p.dstY >= 0 && p.dstY + p.height <= rangeHeight, 'piece draws outside range');
    assert.equal(source.yPx + p.srcY, origin + offset + p.dstY, 'piece copies the wrong rows');
    for (let row = p.dstY; row < p.dstY + p.height; row += 1) drawn[row] += 1;
  }
  for (let row = 0; row < rangeHeight; row += 1) {
    const expected = covered[offset + row] ?? 0;
    assert.equal(drawn[row], expected, `row ${offset + row} drawn ${drawn[row]}x`);
  }
}

describe('planAssembly', () => {
  it('returns an empty plan for no slices', () => {
    assert.deepEqual(planAssembly([]), { totalHeight: 0, pieces: [] });
  });

  it('uses a single slice as it is', () => {
    assert.deepEqual(planAssembly([slice(0, 0, 800)]), {
      totalHeight: 800,
      pieces: [piece(0, 0, 0, 800)],
    });
  });

  it('cuts two overlapping slices in the middle of the overlap', () => {
    // Overlap is rows 700-799. Cut at 700 + floor(100 / 2) = 750.
    assert.deepEqual(planAssembly([slice(0, 0, 800), slice(1, 700, 800)]), {
      totalHeight: 1500,
      pieces: [piece(0, 0, 0, 750), piece(1, 50, 750, 750)],
    });
  });

  it('rounds the cut down for an odd overlap', () => {
    // Overlap is 99 rows (701-799). Cut at 701 + floor(99 / 2) = 750.
    assert.deepEqual(planAssembly([slice(0, 0, 800), slice(1, 701, 800)]), {
      totalHeight: 1501,
      pieces: [piece(0, 0, 0, 750), piece(1, 49, 750, 751)],
    });
  });

  it('gives an overlap of one row to the lower slice', () => {
    // Overlap is row 799 only. Cut at 799 + floor(1 / 2) = 799.
    assert.deepEqual(planAssembly([slice(0, 0, 800), slice(1, 799, 800)]), {
      totalHeight: 1599,
      pieces: [piece(0, 0, 0, 799), piece(1, 0, 799, 800)],
    });
  });

  it('joins touching slices without a cut inside either', () => {
    assert.deepEqual(planAssembly([slice(0, 0, 800), slice(1, 800, 800)]), {
      totalHeight: 1600,
      pieces: [piece(0, 0, 0, 800), piece(1, 0, 800, 800)],
    });
  });

  it('cuts three slices at both seams', () => {
    // Seams: 700 + 50 = 750 and 1400 + 50 = 1450.
    assert.deepEqual(planAssembly([slice(0, 0, 800), slice(1, 700, 800), slice(2, 1400, 800)]), {
      totalHeight: 2200,
      pieces: [piece(0, 0, 0, 750), piece(1, 50, 750, 700), piece(2, 50, 1450, 750)],
    });
  });

  it('plans five slices that overlap each other', () => {
    const slices = [0, 1, 2, 3, 4].map((i) => slice(i, i * 600, 800));
    const plan = planAssembly(slices);
    assert.equal(plan.totalHeight, 3200);
    assert.deepEqual(
      plan.pieces.map((p) => [p.sliceIndex, p.dstY, p.height]),
      [
        [0, 0, 700],
        [1, 700, 600],
        [2, 1300, 600],
        [3, 1900, 600],
        [4, 2500, 700],
      ],
    );
    assertPiecesDrawCoveredRows(slices, plan.pieces, 0, plan.totalHeight);
  });

  it('gives no piece to a slice inside another slice', () => {
    // Slice 1 lies inside slice 0. Slices 0 and 2 overlap in rows 900-999: cut at 950.
    assert.deepEqual(planAssembly([slice(0, 0, 1000), slice(1, 100, 200), slice(2, 900, 1000)]), {
      totalHeight: 1900,
      pieces: [piece(0, 0, 0, 950), piece(2, 50, 950, 950)],
    });
  });

  it('gives no piece to a slice that its neighbours cover together', () => {
    // Slice 1 (50-149) is covered by slice 0 (0-99) and slice 2 (100-199).
    assert.deepEqual(planAssembly([slice(0, 0, 100), slice(1, 50, 100), slice(2, 100, 100)]), {
      totalHeight: 200,
      pieces: [piece(0, 0, 0, 100), piece(2, 0, 100, 100)],
    });
  });

  it('drops covered slices one at a time and keeps the others', () => {
    // Slice 1 (50-149) is dropped: slice 0 (0-99) reaches slice 2 (90-199). Slice 2 stays: slices
    // 0 and 3 (140-249) do not reach each other, and rows 100-139 come from slice 2 only.
    assert.deepEqual(
      planAssembly([slice(0, 0, 100), slice(1, 50, 100), slice(2, 90, 110), slice(3, 140, 110)]),
      {
        totalHeight: 250,
        // Seams: 90 + floor(10 / 2) = 95 and 140 + floor(60 / 2) = 170.
        pieces: [piece(0, 0, 0, 95), piece(2, 5, 95, 75), piece(3, 30, 170, 80)],
      },
    );
  });

  it('leaves a gap between slices that do not touch', () => {
    assert.deepEqual(planAssembly([slice(0, 0, 100), slice(1, 150, 100)]), {
      totalHeight: 250,
      pieces: [piece(0, 0, 0, 100), piece(1, 0, 150, 100)],
    });
  });

  it('keeps the first of two identical slices', () => {
    assert.deepEqual(planAssembly([slice(0, 0, 500), slice(1, 0, 500)]), {
      totalHeight: 500,
      pieces: [piece(0, 0, 0, 500)],
    });
  });

  it('keeps the longer of two slices that start at the same row', () => {
    const expected = { totalHeight: 500, pieces: [piece(7, 0, 0, 500)] };
    assert.deepEqual(planAssembly([slice(3, 0, 300), slice(7, 0, 500)]), expected);
    assert.deepEqual(planAssembly([slice(7, 0, 500), slice(3, 0, 300)]), expected);
  });

  it('cuts correctly when a duplicate start sits beside a lower slice', () => {
    const slices = [slice(0, 0, 500), slice(1, 0, 400), slice(2, 400, 500)];
    assert.deepEqual(planAssembly(slices), {
      totalHeight: 900,
      pieces: [piece(0, 0, 0, 450), piece(2, 50, 450, 450)],
    });
  });

  it('starts the result at the smallest yPx', () => {
    // Seam: 1400 + floor(100 / 2) = 1450 -> 450 rows from the first slice's top.
    assert.deepEqual(planAssembly([slice(0, 1000, 500), slice(1, 1400, 500)]), {
      totalHeight: 900,
      pieces: [piece(0, 0, 0, 450), piece(1, 50, 450, 450)],
    });
  });

  it('accepts negative yPx', () => {
    assert.deepEqual(planAssembly([slice(0, -300, 200), slice(1, -150, 200)]), {
      totalHeight: 350,
      pieces: [piece(0, 0, 0, 175), piece(1, 25, 175, 175)],
    });
  });

  it('reports the index of the slice, not its position in the input', () => {
    const plan = planAssembly([slice(9, 0, 100), slice(4, 80, 100)]);
    assert.deepEqual(
      plan.pieces.map((p) => p.sliceIndex),
      [9, 4],
    );
  });

  it('sorts input that is not sorted and leaves the input as it was', () => {
    const slices = Object.freeze([slice(2, 1400, 800), slice(0, 0, 800), slice(1, 700, 800)]);
    const plan = planAssembly(/** @type {SliceInfo[]} */ (/** @type {unknown} */ (slices)));
    const sorted = [slice(0, 0, 800), slice(1, 700, 800), slice(2, 1400, 800)];
    assert.deepEqual(plan, planAssembly(sorted));
  });

  it('ignores seamStatus', () => {
    const odd = { ...slice(1, 700, 800), seamStatus: /** @type {const} */ ('unmatched') };
    assert.deepEqual(
      planAssembly([slice(0, 0, 800), odd]),
      planAssembly([slice(0, 0, 800), slice(1, 700, 800)]),
    );
  });

  it('rejects a value that only looks like an array of slices', () => {
    // These have a `map` method (or can be iterated), so code without a type check would not fail.
    const lookalike = { map: () => [] };
    // @ts-expect-error wrong type on purpose
    assert.throws(() => planAssembly(lookalike), /^TypeError: slices must be an array$/);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => planAssembly(new Set([slice(0, 0, 10)])), TypeError);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => planAssembly(new Uint8Array(4)), TypeError);
  });

  it('names the field that is not valid', () => {
    const named = (/** @type {SliceInfo} */ bad, /** @type {RegExp} */ pattern) =>
      assert.throws(() => planAssembly([bad]), (e) => e instanceof RangeError && pattern.test(e.message));
    named(slice(-1, 0, 10), /^slice\.index must be a whole number >= 0$/);
    named(slice(0, 0.5, 10), /^slice\.yPx must be a whole number$/);
    named(slice(0, 0, 0), /^slice\.heightPx must be a whole number >= 1$/);
    named(slice(0, 0, 10.5), /^slice\.heightPx must be a whole number >= 1$/);
    named(slice(0, Number.MAX_SAFE_INTEGER + 1, 10), /^slice\.yPx must be a whole number$/);
  });

  it('rejects input that is not valid', () => {
    // @ts-expect-error wrong type on purpose
    assert.throws(() => planAssembly(null), TypeError);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => planAssembly('slices'), TypeError);
    assert.throws(() => planAssembly([slice(0, 0, 0)]), RangeError);
    assert.throws(() => planAssembly([slice(0, 0, -5)]), RangeError);
    assert.throws(() => planAssembly([slice(0, 0.5, 100)]), RangeError);
    assert.throws(() => planAssembly([slice(0, 0, 100.5)]), RangeError);
    assert.throws(() => planAssembly([slice(0, NaN, 100)]), RangeError);
    assert.throws(() => planAssembly([slice(0, 0, Infinity)]), RangeError);
    assert.throws(() => planAssembly([slice(-1, 0, 100)]), RangeError);
    assert.throws(() => planAssembly([slice(0, 0, 100), slice(1.5, 50, 100)]), RangeError);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => planAssembly([{ index: 0, yPx: '0', heightPx: 100 }]), TypeError);
  });

  it('draws every covered row exactly once and never reads outside a slice (seeded)', () => {
    forEachSeed(2000, (random) => {
      const slices = randomSlices(random);
      const plan = planAssembly(sortedByY(slices));
      const covered = coveredRows(slices);
      assert.equal(plan.totalHeight, covered.length);
      assertPiecesDrawCoveredRows(slices, plan.pieces, 0, plan.totalHeight);

      let previousEnd = 0;
      const used = new Set();
      for (const p of plan.pieces) {
        assert.ok(p.dstY >= previousEnd, 'pieces are sorted and do not overlap');
        previousEnd = p.dstY + p.height;
        assert.ok(!used.has(p.sliceIndex), 'one piece per slice');
        used.add(p.sliceIndex);
      }
    });
  });

  it('gives the same plan for any input order when no two slices are identical (seeded)', () => {
    forEachSeed(500, (random) => {
      const slices = randomSlices(random);
      const keys = new Set(slices.map((s) => `${s.yPx}:${s.heightPx}`));
      if (keys.size !== slices.length) return;
      const reversed = [...slices].reverse();
      assert.deepEqual(planAssembly(reversed), planAssembly(sortedByY(slices)));
    });
  });
});

describe('piecesForRange', () => {
  // Plan of three slices: rows 0-749 from slice 0, 750-1449 from slice 1, 1450-2199 from slice 2.
  const pieces = planAssembly([slice(0, 0, 800), slice(1, 700, 800), slice(2, 1400, 800)]).pieces;

  it('returns the whole piece for a range that is inside one piece', () => {
    assert.deepEqual(piecesForRange(pieces, 100, 200), [piece(0, 100, 0, 200)]);
  });

  it('cuts at both range edges', () => {
    // Range 700-799: 50 rows of slice 0 (src 700-749) and 50 rows of slice 1 (src 50-99).
    assert.deepEqual(piecesForRange(pieces, 700, 100), [
      piece(0, 700, 0, 50),
      piece(1, 50, 50, 50),
    ]);
  });

  it('spans more than two pieces', () => {
    assert.deepEqual(piecesForRange(pieces, 740, 720), [
      piece(0, 740, 0, 10),
      piece(1, 50, 10, 700),
      piece(2, 50, 710, 10),
    ]);
  });

  it('starts at a piece boundary without an empty piece', () => {
    assert.deepEqual(piecesForRange(pieces, 750, 700), [piece(1, 50, 0, 700)]);
    assert.deepEqual(piecesForRange(pieces, 749, 1), [piece(0, 749, 0, 1)]);
    assert.deepEqual(piecesForRange(pieces, 750, 1), [piece(1, 50, 0, 1)]);
  });

  it('cuts a range that ends after the last row', () => {
    assert.deepEqual(piecesForRange(pieces, 2000, 500), [piece(2, 600, 0, 200)]);
  });

  it('returns the whole plan for a range that includes it', () => {
    assert.deepEqual(piecesForRange(pieces, 0, 5000), pieces);
  });

  it('gives an empty array for a range that no piece touches', () => {
    assert.deepEqual(piecesForRange(pieces, 2200, 100), []);
    assert.deepEqual(piecesForRange(pieces, 9000, 1), []);
    assert.deepEqual(piecesForRange([], 0, 100), []);
  });

  it('gives an empty array for a range inside a gap', () => {
    const gapped = planAssembly([slice(0, 0, 100), slice(1, 150, 100)]).pieces;
    assert.deepEqual(piecesForRange(gapped, 100, 50), []);
    assert.deepEqual(piecesForRange(gapped, 90, 70), [piece(0, 90, 0, 10), piece(1, 0, 60, 10)]);
  });

  it('does not change the pieces that it receives', () => {
    const frozen = Object.freeze(pieces.map((p) => Object.freeze({ ...p })));
    const input = /** @type {Piece[]} */ (/** @type {unknown} */ (frozen));
    const result = piecesForRange(input, 0, 5000);
    assert.deepEqual(result, pieces);
    assert.notEqual(result[0], frozen[0]);
  });

  it('rejects a value that can be iterated but is not an array of pieces', () => {
    // A Set or a string can be walked with `for...of`, so code without a type check would not
    // throw: it would return pieces made of undefined values.
    // @ts-expect-error wrong type on purpose
    assert.throws(() => piecesForRange(new Set(pieces), 0, 100), /^TypeError: pieces must be an array$/);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => piecesForRange('abc', 0, 100), TypeError);
  });

  it('names the argument that is not valid', () => {
    assert.throws(
      () => piecesForRange(pieces, -1, 10),
      /^RangeError: y must be a whole number >= 0$/,
    );
    assert.throws(
      () => piecesForRange(pieces, 0, 0),
      /^RangeError: height must be a whole number >= 1$/,
    );
  });

  it('rejects input that is not valid', () => {
    assert.throws(() => piecesForRange(pieces, 0, 0), RangeError);
    assert.throws(() => piecesForRange(pieces, 0, -10), RangeError);
    assert.throws(() => piecesForRange(pieces, -1, 10), RangeError);
    assert.throws(() => piecesForRange(pieces, 0.5, 10), RangeError);
    assert.throws(() => piecesForRange(pieces, 0, 10.5), RangeError);
    assert.throws(() => piecesForRange(pieces, NaN, 10), RangeError);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => piecesForRange(null, 0, 10), TypeError);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => piecesForRange(pieces, '0', 10), TypeError);
  });

  it('draws exactly the covered rows of any range, with relative positions (seeded)', () => {
    forEachSeed(2000, (random) => {
      const slices = randomSlices(random);
      const plan = planAssembly(sortedByY(slices));
      const y = randomInt(random, 0, plan.totalHeight + 50);
      const height = randomInt(random, 1, 400);
      const clipped = piecesForRange(plan.pieces, y, height);
      assertPiecesDrawCoveredRows(slices, clipped, y, height);

      const covered = coveredRows(slices);
      let expectedRows = 0;
      for (let row = y; row < Math.min(y + height, covered.length); row += 1) {
        expectedRows += covered[row] ?? 0;
      }
      assert.equal(
        clipped.reduce((sum, p) => sum + p.height, 0),
        expectedRows,
        'sum of piece heights equals the covered rows in the range',
      );
    });
  });
});

describe('planAssembly with planTiles', () => {
  it('fills every row of every tile when the slices leave no gap (seeded)', () => {
    forEachSeed(300, (random) => {
      // Each slice starts inside the one before it or right below it.
      const slices = [slice(0, 0, randomInt(random, 1, 400))];
      const count = randomInt(random, 1, 40);
      for (let index = 1; index <= count; index += 1) {
        const previous = slices[index - 1];
        const yPx = previous.yPx + randomInt(random, 1, previous.heightPx);
        slices.push(slice(index, yPx, randomInt(random, 1, 400)));
      }
      const plan = planAssembly(slices);
      const tiles = planTiles(1200, plan.totalHeight, 'standard');
      for (const tile of tiles) {
        const inTile = piecesForRange(plan.pieces, tile.srcY, tile.srcHeight);
        assert.equal(
          inTile.reduce((sum, p) => sum + p.height, 0),
          tile.srcHeight,
          `tile ${tile.index}`,
        );
        assertPiecesDrawCoveredRows(slices, inTile, tile.srcY, tile.srcHeight);
      }
    });
  });
});
