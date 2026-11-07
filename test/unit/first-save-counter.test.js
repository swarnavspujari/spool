// @ts-check
/**
 * The question "Save to Pictures › Screenshots?" on the toast is asked on the first three captures
 * that go to Downloads because no folder is chosen (src/sw/first-save.js, docs/contracts.md 7.10).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LEGACY_FIRST_SAVE_KEY,
  MAX_SAVE_ASKS,
  SAVE_ASKS_KEY,
  asksSoFar,
  silenceSaveQuestion,
  takeFirstSaveQuestion,
  withFirstSaveQuestion,
} from '../../src/sw/first-save.js';

/**
 * A storage area in memory. It counts its calls, and can answer after a delay.
 * @param {Record<string, unknown>} [start]
 * @param {{ delay?: boolean }} [options]
 * @returns {any}
 */
function memoryArea(start = {}, options = {}) {
  /** @type {Record<string, unknown>} */
  const data = { ...start };
  const calls = { get: 0, set: 0 };
  const later = () => (options.delay ? new Promise((r) => setImmediate(r)) : undefined);
  return {
    data,
    calls,
    async get(/** @type {string | string[]} */ keys) {
      calls.get += 1;
      await later();
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => Object.hasOwn(data, k)).map((k) => [k, data[k]]));
    },
    async set(/** @type {Record<string, unknown>} */ items) {
      calls.set += 1;
      await later();
      Object.assign(data, items);
    },
  };
}

/** @param {Record<string, unknown>} [save] */
function summary(save = {}) {
  return /** @type {any} */ ({
    save: { location: 'downloads', label: 'Downloads/Spool', files: 4, needsPermission: false, ...save },
    warnings: [],
  });
}

describe('the question is asked on the first three captures, then never', () => {
  it('MAX_SAVE_ASKS is three, and the keys are the ones of the documents', () => {
    assert.equal(MAX_SAVE_ASKS, 3);
    assert.equal(SAVE_ASKS_KEY, 'saveFolderAsks');
    assert.equal(LEGACY_FIRST_SAVE_KEY, 'firstSavePrompted');
  });

  it('asks on 1, 2 and 3, and then never', async () => {
    const area = memoryArea();
    assert.deepEqual(
      [
        await takeFirstSaveQuestion(area),
        await takeFirstSaveQuestion(area),
        await takeFirstSaveQuestion(area),
        await takeFirstSaveQuestion(area),
        await takeFirstSaveQuestion(area),
      ],
      [true, true, true, false, false],
    );
    assert.equal(area.data[SAVE_ASKS_KEY], 3, 'the count stops at the limit');
  });

  it('stores the count before it answers, so a second capture sees the first one', async () => {
    const area = memoryArea();
    await takeFirstSaveQuestion(area);
    assert.equal(area.data[SAVE_ASKS_KEY], 1);
  });

  it('a flag of version 1.0.0 (true) counts as one ask', async () => {
    const area = memoryArea({ [LEGACY_FIRST_SAVE_KEY]: true });
    assert.equal(asksSoFar(area.data), 1);
    assert.equal(await takeFirstSaveQuestion(area), true, 'ask 2');
    assert.equal(await takeFirstSaveQuestion(area), true, 'ask 3');
    assert.equal(await takeFirstSaveQuestion(area), false);
  });

  it('the count wins over the old flag, and a value that is no count is ignored', () => {
    assert.equal(asksSoFar({ [SAVE_ASKS_KEY]: 2, [LEGACY_FIRST_SAVE_KEY]: true }), 2);
    assert.equal(asksSoFar({ [SAVE_ASKS_KEY]: 0, [LEGACY_FIRST_SAVE_KEY]: true }), 0);
    for (const value of ['2', -1, 1.5, NaN, null, {}, [1]]) {
      assert.equal(asksSoFar({ [SAVE_ASKS_KEY]: value }), 0, JSON.stringify(value));
    }
    assert.equal(asksSoFar({ [LEGACY_FIRST_SAVE_KEY]: 'yes' }), 0);
    assert.equal(asksSoFar(undefined), 0);
    assert.equal(asksSoFar({}), 0);
  });

  it('a storage that fails gives no question, and never throws', async () => {
    const noGet = {
      get: async () => {
        throw new Error('no');
      },
      set: async () => undefined,
    };
    assert.equal(await takeFirstSaveQuestion(/** @type {any} */ (noGet)), false);
    const noSet = {
      get: async () => ({}),
      set: async () => {
        throw new Error('no');
      },
    };
    assert.equal(await takeFirstSaveQuestion(/** @type {any} */ (noSet)), false);
    // The queue goes on after a failure.
    assert.equal(await takeFirstSaveQuestion(memoryArea()), true);
  });

  it('two captures that finish together do not read the same count', async () => {
    const area = memoryArea({}, { delay: true });
    const answers = await Promise.all(
      Array.from({ length: 5 }, () => takeFirstSaveQuestion(area)),
    );
    assert.deepEqual(answers, [true, true, true, false, false]);
    assert.equal(area.data[SAVE_ASKS_KEY], 3);
  });

  it('silenceSaveQuestion ends the question for good, and never throws', async () => {
    const area = memoryArea();
    await silenceSaveQuestion(area);
    assert.equal(area.data[SAVE_ASKS_KEY], MAX_SAVE_ASKS);
    assert.equal(await takeFirstSaveQuestion(area), false);
    const broken = {
      get: async () => ({}),
      set: async () => {
        throw new Error('no');
      },
    };
    await silenceSaveQuestion(/** @type {any} */ (broken));
  });
});

describe('withFirstSaveQuestion', () => {
  it('marks a capture that went to Downloads with no folder, up to three times', async () => {
    const area = memoryArea();
    for (let n = 1; n <= 3; n += 1) {
      const marked = await withFirstSaveQuestion(summary(), area);
      assert.equal(marked.save.askFolder, true, `capture ${n}`);
    }
    assert.equal((await withFirstSaveQuestion(summary(), area)).save.askFolder, undefined);
  });

  it('does not use an ask on a capture that has its own question or a problem', async () => {
    const area = memoryArea();
    for (const save of [
      { needsPermission: true },
      { error: 'Some files could not be saved.', failed: 1 },
      { location: 'folder', label: 'Pictures/Screenshots' },
      { location: 'none', files: 0 },
    ]) {
      assert.equal((await withFirstSaveQuestion(summary(save), area)).save.askFolder, undefined);
    }
    const warned = summary();
    warned.warnings = ['Could not write to the chosen folder. Saved to Downloads instead.'];
    assert.equal((await withFirstSaveQuestion(warned, area)).save.askFolder, undefined);
    assert.equal(area.calls.set, 0, 'nothing was stored');
  });
});
