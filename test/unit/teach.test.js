// @ts-check
/**
 * The toast of a long capture stays until the user dismisses it, for the first three long captures
 * (src/sw/teach.js, docs/contracts.md 7.10). Then it hides like any other toast.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MAX_STICKY_LONG_TOASTS } from '../../src/shared/constants.js';
import {
  LONG_TOASTS_KEY,
  longToastsSoFar,
  takeStickyToast,
  withLongCaptureTeaching,
} from '../../src/sw/teach.js';

/**
 * A storage area in memory. It can answer after a delay, and it can fail.
 * @param {Record<string, unknown>} [start]
 * @param {{ delay?: boolean, failGet?: boolean, failSet?: boolean }} [options]
 * @returns {any}
 */
function memoryArea(start = {}, options = {}) {
  /** @type {Record<string, unknown>} */
  const data = { ...start };
  const later = () => (options.delay ? new Promise((r) => setImmediate(r)) : undefined);
  return {
    data,
    async get(/** @type {string | string[]} */ keys) {
      await later();
      if (options.failGet) throw new Error('storage is gone');
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => Object.hasOwn(data, k)).map((k) => [k, data[k]]));
    },
    async set(/** @type {Record<string, unknown>} */ items) {
      await later();
      if (options.failSet) throw new Error('storage is full');
      Object.assign(data, items);
    },
  };
}

/** @param {number} tileCount */
const summary = (tileCount) => /** @type {any} */ ({ tileCount, save: {}, warnings: [] });

describe('the first three long captures keep their toast', () => {
  it('the number is three, and it is stored under one key of its own', () => {
    assert.equal(MAX_STICKY_LONG_TOASTS, 3);
    assert.equal(LONG_TOASTS_KEY, 'longToastsShown');
  });

  it('marks captures 1, 2 and 3, then never again', async () => {
    const area = memoryArea();
    const results = [];
    for (let i = 0; i < 6; i += 1) {
      results.push((await withLongCaptureTeaching(summary(5), area)).teach === true);
    }
    assert.deepEqual(results, [true, true, true, false, false, false]);
    assert.equal(area.data[LONG_TOASTS_KEY], 3, 'the count stops at three');
  });

  it('a capture of one tile does not count, and does not get the mark', async () => {
    const area = memoryArea();
    const one = await withLongCaptureTeaching(summary(1), area);
    assert.equal(one.teach, undefined);
    assert.equal(area.data[LONG_TOASTS_KEY], undefined, 'nothing was stored');
    assert.equal((await withLongCaptureTeaching(summary(2), area)).teach, true, 'two tiles do');
  });

  it('returns the same summary object', async () => {
    const info = summary(4);
    assert.equal(await withLongCaptureTeaching(info, memoryArea()), info);
  });

  it('two captures that finish together take two places, not one', async () => {
    const area = memoryArea({}, { delay: true });
    const marked = await Promise.all(
      Array.from({ length: 5 }, () => withLongCaptureTeaching(summary(3), area)),
    );
    assert.equal(marked.filter((s) => s.teach === true).length, 3);
    assert.equal(area.data[LONG_TOASTS_KEY], 3);
  });

  it('a storage that fails gives a toast that hides by itself, and never throws', async () => {
    for (const options of [{ failGet: true }, { failSet: true }]) {
      const area = memoryArea({}, options);
      assert.equal((await withLongCaptureTeaching(summary(5), area)).teach, undefined);
      assert.equal(await takeStickyToast(area), false);
    }
  });

  it('a count that is not a whole number counts as none', () => {
    for (const bad of [undefined, null, '2', -1, 1.5, Number.NaN, {}]) {
      assert.equal(longToastsSoFar({ [LONG_TOASTS_KEY]: bad }), 0, String(bad));
    }
    assert.equal(longToastsSoFar(undefined), 0);
    assert.equal(longToastsSoFar({ [LONG_TOASTS_KEY]: 2 }), 2);
  });

  it('stores one number and nothing else: no image data', async () => {
    const area = memoryArea();
    await withLongCaptureTeaching(summary(5), area);
    assert.deepEqual(Object.keys(area.data), [LONG_TOASTS_KEY]);
  });
});
