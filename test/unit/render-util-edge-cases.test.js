// @ts-check
/**
 * Tests added by mutation testing for the pure helpers
 * of the image pipeline (src/render/util.js). Each pins a rule that a mutation run showed to be
 * unchecked: fractional chunk sizes, base64 without padding, every bit of the encoder, and the
 * exact numbers of the thumbnail plan.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  base64ToBytes,
  bytesToBase64,
  planRowChunks,
  thumbnailPlan,
} from '../../src/render/util.js';

describe('planRowChunks: sizes that are not whole or are 1', () => {
  it('rounds a fractional maxRows down (2.5 rows is 2 rows)', () => {
    assert.deepEqual(planRowChunks(5, 2.5), [
      { y: 0, height: 2 },
      { y: 2, height: 2 },
      { y: 4, height: 1 },
    ]);
  });

  it('accepts a chunk of exactly one row', () => {
    assert.deepEqual(planRowChunks(3, 1), [
      { y: 0, height: 1 },
      { y: 1, height: 1 },
      { y: 2, height: 1 },
    ]);
  });

  it('gives no chunk for less than one row per chunk', () => {
    assert.deepEqual(planRowChunks(3, 0.9), []);
  });
});

describe('base64ToBytes: input without padding', () => {
  // atob accepts base64 without "=" padding. The byte count is the floor of 3/4 of the length.
  for (const [text, bytes] of /** @type {[string, number[]][]} */ ([
    ['QQ', [0x41]],
    ['QUI', [0x41, 0x42]],
    ['QUJD', [0x41, 0x42, 0x43]],
    ['QUJDRA', [0x41, 0x42, 0x43, 0x44]],
  ])) {
    it(`decodes "${text}" to ${bytes.length} byte(s), with no extra zero byte`, () => {
      assert.deepEqual([...base64ToBytes(text)], bytes);
    });
  }
});

describe('bytesToBase64: every bit', () => {
  /** @param {number} seed */
  function prng(seed) {
    let s = seed >>> 0;
    return () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return s >>> 24;
    };
  }

  it('equals the base64 of Buffer for lengths 0 to 70 of pseudo-random bytes', () => {
    const next = prng(12345);
    for (let length = 0; length <= 70; length++) {
      const bytes = Uint8Array.from({ length }, () => next());
      assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'), `length ${length}`);
    }
  });

  it('encodes each of the 6-bit values in each of the four output positions', () => {
    // Three input bytes carry four 6-bit values. Put each value 0..63 into each position.
    for (let value = 0; value < 64; value++) {
      for (let position = 0; position < 4; position++) {
        const n = value << (18 - 6 * position);
        const bytes = Uint8Array.from([(n >> 16) & 255, (n >> 8) & 255, n & 255]);
        assert.equal(
          bytesToBase64(bytes),
          Buffer.from(bytes).toString('base64'),
          `value ${value} at position ${position}`,
        );
      }
    }
  });
});

describe('thumbnailPlan: exact numbers', () => {
  it('1000 px wide: scale 0.32, a source of 1500 rows, a thumbnail of 320 x 480', () => {
    assert.deepEqual(thumbnailPlan(1000, 20_000), {
      index: 0,
      srcY: 0,
      srcHeight: 1500,
      outWidth: 320,
      outHeight: 480,
    });
  });

  it('777 px wide: the source height is rounded down (1165.5), the thumbnail is 320 x 480', () => {
    const plan = thumbnailPlan(777, 20_000);
    assert.equal(plan.srcHeight, 1165);
    assert.equal(plan.outWidth, 320);
    assert.equal(plan.outHeight, 480);
  });

  it('keeps the shape of a short image: a 1000 x 300 image is 320 x 96', () => {
    assert.deepEqual(thumbnailPlan(1000, 300), {
      index: 0,
      srcY: 0,
      srcHeight: 300,
      outWidth: 320,
      outHeight: 96,
    });
  });

  it('never scales up and never makes a side 0: 200 x 100 stays, 4000 x 1 is 320 x 1', () => {
    assert.deepEqual(thumbnailPlan(200, 100), { index: 0, srcY: 0, srcHeight: 100, outWidth: 200, outHeight: 100 });
    const flat = thumbnailPlan(4000, 1);
    assert.equal(flat.outWidth, 320);
    assert.equal(flat.outHeight, 1);
  });

  it('rounds the output size to the nearest pixel (not down, not up)', () => {
    // 1001 px wide, 1 row high: 0.3197 px of height -> 1 (the floor of 0 is not allowed). 641 x 641
    // gives a scale of 0.49922: a 320.0 x 320.0 thumbnail that must round, not truncate.
    const plan = thumbnailPlan(641, 641);
    assert.equal(plan.outWidth, 320);
    assert.equal(plan.outHeight, 320);
    // 1500 x 2000: scale 0.21333, source height 2000 (< 2250), outHeight 426.67 -> 427.
    const tall = thumbnailPlan(1500, 2000);
    assert.equal(tall.srcHeight, 2000);
    assert.equal(tall.outHeight, 427);
    // 1500 x 1000: 213.33 -> 213.
    assert.equal(thumbnailPlan(1500, 1000).outHeight, 213);
  });

  it('rounds, not truncates, a width that the scale leaves just below 320 (581 * (320 / 581) is 319.99999999999994)', () => {
    for (const width of [581, 606, 616]) {
      assert.equal(thumbnailPlan(width, 5000).outWidth, 320, `width ${width}`);
    }
  });

  // Regression: the source height must not be one row short (float division of 480 by the scale).
  // The division of two floating point numbers is a hair below the whole value for 150 of the
  // widths from 1 to 6000 (for example 476: 713 instead of 714), so the thumbnail is one row
  // short and, at the same widths, its output height is 479 instead of 480. The thumbnail stays
  // valid. Fix: Math.floor((THUMBNAIL_MAX_HEIGHT_PX * widthPx) / THUMBNAIL_MAX_WIDTH_PX), exact
  // integer arithmetic (the same fix as for the tiles in src/lib/tiles.js).
  it(
    'the source height is exactly floor(480 * width / 320) for every width',
    () => {
      for (let width = 321; width <= 6000; width++) {
        const plan = thumbnailPlan(width, 100_000);
        assert.equal(plan.srcHeight, Math.floor((480 * width) / 320), `width ${width}`);
        assert.equal(plan.outHeight, 480, `width ${width}`);
      }
    },
  );
});
