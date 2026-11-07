// @ts-check
/**
 * The pure helpers of the image pipeline (src/render/util.js): row chunks, base64, the async LRU,
 * the thumbnail plan and the warnings of a finished capture.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  base64ToBytes,
  blobToBase64Text,
  bytesToBase64,
  createAsyncLru,
  outputWarnings,
  planRowChunks,
  thumbnailPlan,
} from '../../src/render/util.js';
import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION_PX,
  MAX_IMAGES_PER_MESSAGE,
  THUMBNAIL_MAX_HEIGHT_PX,
  THUMBNAIL_MAX_WIDTH_PX,
} from '../../src/shared/constants.js';

describe('planRowChunks', () => {
  it('splits into chunks of at most maxRows, the last one shorter', () => {
    assert.deepEqual(planRowChunks(1100, 512), [
      { y: 0, height: 512 },
      { y: 512, height: 512 },
      { y: 1024, height: 76 },
    ]);
  });

  it('gives one chunk for a small image and none for nothing', () => {
    assert.deepEqual(planRowChunks(10, 512), [{ y: 0, height: 10 }]);
    assert.deepEqual(planRowChunks(0, 512), []);
    assert.deepEqual(planRowChunks(-5, 512), []);
    assert.deepEqual(planRowChunks(10, 0), []);
  });
});

describe('base64', () => {
  it('round-trips random bytes of every length from 0 to 40', () => {
    for (let n = 0; n <= 40; n++) {
      const bytes = Uint8Array.from({ length: n }, (_, i) => (i * 37 + n) & 255);
      const text = bytesToBase64(bytes);
      assert.equal(text, Buffer.from(bytes).toString('base64'));
      assert.deepEqual(base64ToBytes(text), bytes);
    }
  });

  it('decodes a text that is longer than one decode step', () => {
    const bytes = Uint8Array.from({ length: 3 * 1024 * 1024 + 2 }, (_, i) => (i * 7) & 255);
    assert.deepEqual(base64ToBytes(bytesToBase64(bytes)), bytes);
  });

  it('blobToBase64Text encodes a Blob without a prefix', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47]);
    assert.equal(await blobToBase64Text(new Blob([bytes])), Buffer.from(bytes).toString('base64'));
  });
});

describe('createAsyncLru', () => {
  it('keeps at most max values and disposes the least recently used first', async () => {
    /** @type {string[]} */
    const disposed = [];
    const lru = createAsyncLru({
      max: 2,
      load: async (/** @type {number} */ k) => `v${k}`,
      dispose: (v) => void disposed.push(v),
    });
    await lru.get(1);
    await lru.get(2);
    await lru.get(1); // 1 is now the most recent
    await lru.get(3); // evicts 2
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(disposed, ['v2']);
    assert.equal(lru.size, 2);
  });

  it('shares one load between callers and does not cache a failure', async () => {
    let loads = 0;
    let fail = true;
    const lru = createAsyncLru({
      max: 2,
      load: async (/** @type {number} */ k) => {
        loads += 1;
        if (fail) throw new Error('no');
        return k;
      },
      dispose: () => {},
    });
    await assert.rejects(Promise.all([lru.get(1), lru.get(1)]));
    assert.equal(loads, 1);
    fail = false;
    assert.equal(await lru.get(1), 1);
    assert.equal(loads, 2);
  });

  it('close disposes everything and refuses later reads', async () => {
    /** @type {number[]} */
    const disposed = [];
    const lru = createAsyncLru({ max: 3, load: async (/** @type {number} */ k) => k, dispose: (v) => void disposed.push(v) });
    await lru.get(1);
    await lru.get(2);
    lru.close();
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(disposed.sort(), [1, 2]);
    await assert.rejects(lru.get(3), /closed/);
  });
});

describe('thumbnailPlan', () => {
  it('takes the top of the image, scaled down to the width limit', () => {
    const plan = thumbnailPlan(1500, 20_000);
    assert.equal(plan.index, 0);
    assert.equal(plan.srcY, 0);
    assert.equal(plan.outWidth, THUMBNAIL_MAX_WIDTH_PX);
    // 320 / 1500 = 0.2133; 480 / 0.2133 = 2250 source rows
    assert.equal(plan.srcHeight, 2250);
    assert.equal(plan.outHeight, 480);
  });

  it('never scales up, and never takes more rows than the image has', () => {
    const plan = thumbnailPlan(200, 100);
    assert.deepEqual(plan, { index: 0, srcY: 0, srcHeight: 100, outWidth: 200, outHeight: 100 });
  });

  it('keeps the thumbnail within 320 x 480 for any size', () => {
    for (const [w, h] of [
      [1, 1],
      [1, 100_000],
      [10_000, 1],
      [10_000, 300_000],
      [321, 481],
      [319, 20_000],
      [4000, 700],
    ]) {
      const plan = thumbnailPlan(/** @type {number} */ (w), /** @type {number} */ (h));
      assert.ok(plan.outWidth >= 1 && plan.outWidth <= THUMBNAIL_MAX_WIDTH_PX, `${w}x${h}`);
      assert.ok(plan.outHeight >= 1 && plan.outHeight <= THUMBNAIL_MAX_HEIGHT_PX, `${w}x${h}`);
      assert.ok(plan.srcHeight >= 1 && plan.srcHeight <= /** @type {number} */ (h), `${w}x${h}`);
    }
  });

  it('refuses a size that is not a whole number of at least 1', () => {
    assert.throws(() => thumbnailPlan(0, 10), RangeError);
    assert.throws(() => thumbnailPlan(10, 0), RangeError);
    assert.throws(() => thumbnailPlan(1.5, 10), RangeError);
    assert.throws(() => thumbnailPlan(10, NaN), RangeError);
  });
});

describe('outputWarnings', () => {
  const base = { tileCount: 2, widthPx: 1500, heightPx: 3000, fullBytes: 1000 };

  it('has no warning for a normal capture', () => {
    assert.deepEqual(outputWarnings(base), []);
  });

  it('warns about more tiles than a chat message takes', () => {
    assert.deepEqual(outputWarnings({ ...base, tileCount: MAX_IMAGES_PER_MESSAGE }), []);
    assert.deepEqual(outputWarnings({ ...base, tileCount: MAX_IMAGES_PER_MESSAGE + 1 }), [
      'More than 20 screenshots. Send them in more than one message.',
    ]);
  });

  it('warns when the full image is too wide, too tall or too big', () => {
    const line = 'The full image is too large for most chats. Use the AI screenshots.';
    assert.deepEqual(outputWarnings({ ...base, widthPx: MAX_IMAGE_DIMENSION_PX }), []);
    assert.deepEqual(outputWarnings({ ...base, widthPx: MAX_IMAGE_DIMENSION_PX + 1 }), [line]);
    assert.deepEqual(outputWarnings({ ...base, heightPx: MAX_IMAGE_DIMENSION_PX + 1 }), [line]);
    assert.deepEqual(outputWarnings({ ...base, fullBytes: MAX_IMAGE_BYTES }), []);
    assert.deepEqual(outputWarnings({ ...base, fullBytes: MAX_IMAGE_BYTES + 1 }), [line]);
  });

  it('adds the lines of the manifest after the others, without empty lines or repeats', () => {
    const join = 'Spool could not verify 1 seam, near step 3. Check that area.';
    assert.deepEqual(
      outputWarnings({
        ...base,
        tileCount: 30,
        manifestWarnings: [join, join, '  ', ''],
      }),
      ['More than 20 screenshots. Send them in more than one message.', join],
    );
  });
});
