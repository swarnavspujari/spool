// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fitsOneImage, isScaledTile, planTiles, tileGeometry } from '../../src/lib/tiles.js';
import { PATCH_PX, TILE_OVERLAP_PX, TILE_TIERS } from '../../src/shared/constants.js';

/**
 * Number of 28 px patches that a model needs for an image of this size (the oracle of the plan
 * tests: every tile must stay inside the patch budget of its tier).
 * @param {number} width
 * @param {number} height
 */
function patchCount(width, height) {
  return Math.ceil(width / PATCH_PX) * Math.ceil(height / PATCH_PX);
}

/** @typedef {import('../../src/shared/types.js').TileTier} TileTier */
/** @typedef {import('../../src/shared/types.js').TilePlan} TilePlan */

/** @type {readonly TileTier[]} */
const TIERS = ['high', 'standard'];
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
 * Checks every rule that a tile plan must keep.
 * @param {TilePlan[]} tiles
 * @param {number} widthPx
 * @param {number} heightPx
 * @param {TileTier} tier
 * @param {number} overlapPx
 */
function assertPlanIsValid(tiles, widthPx, heightPx, tier, overlapPx) {
  const { maxLongEdgePx, maxPatches } = TILE_TIERS[tier];
  const geometry = tileGeometry(widthPx, tier);
  const overlapSrc = Math.round(overlapPx / geometry.scale);
  assert.ok(tiles.length >= 1, 'at least one tile');

  let coveredUpTo = 0;
  for (const [i, tile] of tiles.entries()) {
    assert.equal(tile.index, i, 'index');
    assert.equal(tile.outWidth, geometry.outWidth, 'outWidth');
    assert.ok(tile.outWidth <= maxLongEdgePx, `outWidth ${tile.outWidth}`);
    assert.ok(tile.outHeight >= 1, `outHeight ${tile.outHeight}`);
    assert.ok(tile.outHeight <= maxLongEdgePx, `outHeight ${tile.outHeight}`);
    assert.ok(
      tile.outHeight <= geometry.tileHeightOut,
      `outHeight ${tile.outHeight} is above the tile height ${geometry.tileHeightOut}`,
    );
    assert.ok(
      patchCount(tile.outWidth, tile.outHeight) <= maxPatches,
      `patches for ${tile.outWidth}x${tile.outHeight}`,
    );
    assert.ok(tile.srcHeight >= 1, 'no empty tile');
    assert.ok(tile.srcY >= 0 && tile.srcY + tile.srcHeight <= heightPx, 'inside the image');
    assert.ok(tile.srcY <= coveredUpTo, 'no row is skipped');
    assert.ok(tile.srcY + tile.srcHeight > coveredUpTo, 'tile adds a row');
    coveredUpTo = tile.srcY + tile.srcHeight;

    const next = tiles[i + 1];
    if (next !== undefined) {
      assert.equal(tile.srcHeight, geometry.tileHeightSrc, 'every tile but the last is full');
      assert.equal(next.srcY, tile.srcY + tile.srcHeight - overlapSrc, 'tiles overlap evenly');
    }
  }
  assert.equal(tiles[0]?.srcY, 0, 'first tile starts at the top');
  assert.equal(coveredUpTo, heightPx, 'last tile ends at the bottom');
}

describe('tileGeometry', () => {
  it('width 1200 (high): full tiles of 1200 x 2576', () => {
    assert.deepEqual(tileGeometry(1200, 'high'), {
      outWidth: 1200,
      scale: 1,
      tileHeightOut: 2576,
      tileHeightSrc: 2576,
    });
  });

  it('width 1920 (high): tile height 1932', () => {
    assert.deepEqual(tileGeometry(1920, 'high'), {
      outWidth: 1920,
      scale: 1,
      tileHeightOut: 1932,
      tileHeightSrc: 1932,
    });
  });

  it('width 2400 (high): tile height 1540', () => {
    assert.equal(tileGeometry(2400, 'high').tileHeightOut, 1540);
  });

  it('width 3840 (high): scaled to 2576 wide', () => {
    const geometry = tileGeometry(3840, 'high');
    assert.equal(geometry.outWidth, 2576);
    assert.equal(geometry.scale, 2576 / 3840);
    assert.equal(geometry.tileHeightOut, 1456);
    // 1456 / (2576 / 3840) = 2170.4
    assert.equal(geometry.tileHeightSrc, 2170);
  });

  it('does not scale an image that already fits the long edge', () => {
    assert.equal(tileGeometry(2576, 'high').scale, 1);
    assert.equal(tileGeometry(2577, 'high').outWidth, 2576);
  });

  it('standard tier values', () => {
    assert.deepEqual(tileGeometry(800, 'standard'), {
      outWidth: 800,
      scale: 1,
      tileHeightOut: 1512,
      tileHeightSrc: 1512,
    });
    assert.equal(tileGeometry(1200, 'standard').tileHeightOut, 1008);
    assert.equal(tileGeometry(1568, 'standard').tileHeightOut, 784);
    assert.equal(tileGeometry(50, 'standard').tileHeightOut, 1568);
    const wide = tileGeometry(3136, 'standard');
    assert.equal(wide.outWidth, 1568);
    assert.equal(wide.scale, 0.5);
    assert.equal(wide.tileHeightOut, 784);
    assert.equal(wide.tileHeightSrc, 1568);
  });

  it('caps a narrow image at the long edge, not at the patch budget', () => {
    assert.equal(tileGeometry(50, 'high').tileHeightOut, 2576);
    assert.equal(tileGeometry(1, 'high').tileHeightOut, 2576);
  });

  it('gives a tile height that is a whole number of patches', () => {
    for (const tier of TIERS) {
      for (let width = 1; width <= 6000; width += 1) {
        assert.equal(tileGeometry(width, tier).tileHeightOut % PATCH_PX, 0, `${tier} ${width}`);
      }
    }
  });

  it('scales every width above the long edge to exactly the long edge', () => {
    // widthPx * (maxLongEdgePx / widthPx) is not always exactly maxLongEdgePx in floating point
    // (for 4148 it is 2575.9999999999995). The width must still come out as the long edge.
    for (const tier of TIERS) {
      const { maxLongEdgePx } = TILE_TIERS[tier];
      for (let width = 1; width <= 12_000; width += 1) {
        const expected = Math.min(width, maxLongEdgePx);
        assert.equal(tileGeometry(width, tier).outWidth, expected, `${tier} ${width}`);
      }
    }
  });

  it('never makes a source tile that is taller than a full output tile', () => {
    // scale = maxLongEdgePx / widthPx, so "tileHeightSrc * scale <= tileHeightOut" is the integer
    // test: tileHeightSrc * maxLongEdgePx <= tileHeightOut * widthPx.
    for (const tier of TIERS) {
      const { maxLongEdgePx } = TILE_TIERS[tier];
      for (let width = 1; width <= 12_000; width += 1) {
        const { tileHeightSrc, tileHeightOut } = tileGeometry(width, tier);
        if (width <= maxLongEdgePx) {
          assert.equal(tileHeightSrc, tileHeightOut, `${tier} ${width}: no scaling`);
        } else {
          assert.ok(tileHeightSrc * maxLongEdgePx <= tileHeightOut * width, `${tier} ${width}`);
        }
      }
    }
  });

  // Fixed defect found by mutation testing. `Math.floor(h / scale)` ran in
  // floating point. When h / scale is a whole number in exact arithmetic, the result could be 1
  // ulp below it, and the floor then lost one source row: for width 3174 (high tier) the exact
  // value is 1794 and the code gave 1793. The tile was valid, it only had 1 row fewer than the
  // largest one that fits.
  it('makes the source tile as tall as the tier allows (exact integer floor)', () => {
    for (const tier of TIERS) {
      const { maxLongEdgePx } = TILE_TIERS[tier];
      for (let width = maxLongEdgePx + 1; width <= 12_000; width += 1) {
        const { tileHeightSrc, tileHeightOut } = tileGeometry(width, tier);
        assert.equal(
          tileHeightSrc,
          Math.floor((tileHeightOut * width) / maxLongEdgePx),
          `${tier} ${width}`,
        );
      }
    }
  });

  it('rejects a width that is not a positive whole number', () => {
    assert.throws(() => tileGeometry(0, 'high'), RangeError);
    assert.throws(() => tileGeometry(-1200, 'high'), RangeError);
    assert.throws(() => tileGeometry(1200.5, 'high'), RangeError);
    assert.throws(() => tileGeometry(Infinity, 'high'), RangeError);
    assert.throws(() => tileGeometry(NaN, 'high'), RangeError);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => tileGeometry('1200', 'high'), TypeError);
  });

  it('rejects an unknown tier, also a name from the object prototype', () => {
    // @ts-expect-error wrong value on purpose
    assert.throws(() => tileGeometry(1200, 'ultra'), RangeError);
    // @ts-expect-error wrong value on purpose
    assert.throws(() => tileGeometry(1200, 'constructor'), RangeError);
    // @ts-expect-error wrong value on purpose
    assert.throws(() => tileGeometry(1200, undefined), RangeError);
  });
});

describe('planTiles', () => {
  it('uses one tile when the image is shorter than a tile', () => {
    assert.deepEqual(planTiles(1200, 1000, 'high'), [
      { index: 0, srcY: 0, srcHeight: 1000, outWidth: 1200, outHeight: 1000 },
    ]);
  });

  it('uses one tile when the image is as tall as a tile', () => {
    assert.deepEqual(planTiles(1200, 2576, 'high'), [
      { index: 0, srcY: 0, srcHeight: 2576, outWidth: 1200, outHeight: 2576 },
    ]);
    assert.equal(planTiles(1920, 1932, 'high').length, 1);
    assert.equal(planTiles(1200, 1, 'high').length, 1);
  });

  it('adds a second tile that holds the overlap and one new row', () => {
    assert.deepEqual(planTiles(1200, 2577, 'high'), [
      { index: 0, srcY: 0, srcHeight: 2576, outWidth: 1200, outHeight: 2576 },
      { index: 1, srcY: 2520, srcHeight: 57, outWidth: 1200, outHeight: 57 },
    ]);
  });

  it('makes the last tile shorter and ends it at the image height', () => {
    assert.deepEqual(planTiles(1200, 5000, 'high'), [
      { index: 0, srcY: 0, srcHeight: 2576, outWidth: 1200, outHeight: 2576 },
      { index: 1, srcY: 2520, srcHeight: 2480, outWidth: 1200, outHeight: 2480 },
    ]);
  });

  it('plans tiles of a 1920 px wide image', () => {
    // Tile height 1932, step 1932 - 56 = 1876.
    assert.deepEqual(planTiles(1920, 4000, 'high'), [
      { index: 0, srcY: 0, srcHeight: 1932, outWidth: 1920, outHeight: 1932 },
      { index: 1, srcY: 1876, srcHeight: 1932, outWidth: 1920, outHeight: 1932 },
      { index: 2, srcY: 3752, srcHeight: 248, outWidth: 1920, outHeight: 248 },
    ]);
  });

  it('scales source rows to output rows for a 3840 px wide image', () => {
    // scale 0.67083, source tile height 2170, overlap round(56 / scale) = 83, step 2087.
    assert.deepEqual(planTiles(3840, 6000, 'high'), [
      { index: 0, srcY: 0, srcHeight: 2170, outWidth: 2576, outHeight: 1456 },
      { index: 1, srcY: 2087, srcHeight: 2170, outWidth: 2576, outHeight: 1456 },
      { index: 2, srcY: 4174, srcHeight: 1826, outWidth: 2576, outHeight: 1225 },
    ]);
  });

  it('uses the standard tier limits', () => {
    // Tile height 1008, step 952.
    assert.deepEqual(planTiles(1200, 2000, 'standard'), [
      { index: 0, srcY: 0, srcHeight: 1008, outWidth: 1200, outHeight: 1008 },
      { index: 1, srcY: 952, srcHeight: 1008, outWidth: 1200, outHeight: 1008 },
      { index: 2, srcY: 1904, srcHeight: 96, outWidth: 1200, outHeight: 96 },
    ]);
  });

  it('puts adjacent tiles side by side when the overlap is 0', () => {
    assert.deepEqual(planTiles(1200, 5200, 'high', 0), [
      { index: 0, srcY: 0, srcHeight: 2576, outWidth: 1200, outHeight: 2576 },
      { index: 1, srcY: 2576, srcHeight: 2576, outWidth: 1200, outHeight: 2576 },
      { index: 2, srcY: 5152, srcHeight: 48, outWidth: 1200, outHeight: 48 },
    ]);
  });

  it('measures the overlap in output px', () => {
    // scale 0.5: an output overlap of 100 is 200 source rows.
    const [first, second] = planTiles(3136, 5000, 'standard', 100);
    assert.equal(first?.srcHeight, 1568);
    assert.equal(second?.srcY, 1568 - 200);
  });

  it('never gives a tile 0 output rows, also for a 1 row tile of a strongly scaled image', () => {
    const { tileHeightSrc, scale } = tileGeometry(12000, 'high');
    assert.ok(scale < 0.5);
    const tiles = planTiles(12000, tileHeightSrc + 1, 'high', 0);
    assert.equal(tiles.length, 2);
    assert.deepEqual(tiles[1], {
      index: 1,
      srcY: tileHeightSrc,
      srcHeight: 1,
      outWidth: 2576,
      outHeight: 1,
    });
  });

  it('defaults the overlap to TILE_OVERLAP_PX', () => {
    assert.deepEqual(planTiles(1200, 9000, 'high'), planTiles(1200, 9000, 'high', TILE_OVERLAP_PX));
  });

  it('rejects input that is not valid', () => {
    assert.throws(() => planTiles(0, 1000, 'high'), RangeError);
    assert.throws(() => planTiles(1200, 0, 'high'), RangeError);
    assert.throws(() => planTiles(1200, -5, 'high'), RangeError);
    assert.throws(() => planTiles(1200, 10.5, 'high'), RangeError);
    assert.throws(() => planTiles(1200, 1000, 'high', -1), RangeError);
    assert.throws(() => planTiles(1200, 1000, 'high', NaN), RangeError);
    assert.throws(() => planTiles(1200, 1000, 'high', Infinity), RangeError);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => planTiles(1200, 1000, 'high', '56'), TypeError);
    // @ts-expect-error wrong value on purpose
    assert.throws(() => planTiles(1200, 1000, 'tiny'), RangeError);
  });

  it('names the argument that is not valid', () => {
    const named = (/** @type {() => unknown} */ call, /** @type {RegExp} */ pattern) =>
      assert.throws(call, (error) => error instanceof Error && pattern.test(error.message));
    named(() => planTiles(0, 1000, 'high'), /^widthPx must be a positive whole number$/);
    named(() => planTiles(1200, 0, 'high'), /^heightPx must be a positive whole number$/);
    named(() => planTiles(1200, 1000, 'high', -1), /^overlapPx must be 0 or more$/);
    // @ts-expect-error wrong type on purpose
    named(() => planTiles(1200, 1000, 'high', '56'), /^overlapPx must be a number$/);
    // @ts-expect-error wrong value on purpose
    named(() => planTiles(1200, 1000, 'tiny'), /^tier must be one of: high, standard$/);
    named(
      () => planTiles(1200, 9000, 'high', 2576),
      /^overlapPx must be less than the tile height$/,
    );
  });

  it('rejects an overlap that leaves no step', () => {
    assert.throws(() => planTiles(1200, 9000, 'high', 2576), RangeError);
    assert.throws(() => planTiles(1200, 9000, 'high', 5000), RangeError);
    // The largest overlap that is allowed leaves a step of 1 row.
    const plan = planTiles(1200, 9000, 'high', 2575);
    assert.equal(plan.length, 9000 - 2576 + 1);
    assert.deepEqual(plan.slice(0, 2).map((tile) => tile.srcY), [0, 1]);
    assert.equal(plan.at(-1)?.srcY, 9000 - 2576);
    assert.equal((plan.at(-1)?.srcY ?? 0) + (plan.at(-1)?.srcHeight ?? 0), 9000);
  });

  it('keeps every rule for each width, with heights around the tile edges', () => {
    for (const tier of TIERS) {
      for (let width = 1; width <= 5200; width += 3) {
        const { tileHeightSrc } = tileGeometry(width, tier);
        const heights = [1, tileHeightSrc - 1, tileHeightSrc, tileHeightSrc + 1, 3 * tileHeightSrc];
        for (const height of heights.filter((h) => h >= 1)) {
          assertPlanIsValid(
            planTiles(width, height, tier),
            width,
            height,
            tier,
            TILE_OVERLAP_PX,
          );
        }
      }
    }
  });

  it('keeps every rule for random sizes (seeded)', () => {
    forEachSeed(3000, (random) => {
      const width = randomInt(random, 50, 5000);
      const height = randomInt(random, 1, 200000);
      const tier = /** @type {TileTier} */ (TIERS[randomInt(random, 0, 1)]);
      const overlapPx = random() < 0.2 ? randomInt(random, 0, 400) : TILE_OVERLAP_PX;
      assertPlanIsValid(
        planTiles(width, height, tier, overlapPx),
        width,
        height,
        tier,
        overlapPx,
      );
    });
  });
});

describe('fitsOneImage and isScaledTile', () => {
  it('is true for one tile that is the image 1:1', () => {
    const plans = planTiles(1000, 800, 'high');
    assert.equal(plans.length, 1);
    assert.equal(isScaledTile(/** @type {TilePlan} */ (plans[0]), 1000), false);
    assert.equal(fitsOneImage(plans, 1000), true);
  });

  it('is false for one tile that is scaled: a wide image still makes its own AI screenshot', () => {
    const widthPx = 2880;
    const plans = planTiles(widthPx, 1600, 'high');
    assert.equal(plans.length, 1);
    assert.equal(isScaledTile(/** @type {TilePlan} */ (plans[0]), widthPx), true);
    assert.equal(fitsOneImage(plans, widthPx), false);
  });

  it('is false for more than one tile and for no tile', () => {
    assert.equal(fitsOneImage(planTiles(1000, 20_000, 'high'), 1000), false);
    assert.equal(fitsOneImage([], 1000), false);
  });
});
