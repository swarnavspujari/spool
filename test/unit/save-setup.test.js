// @ts-check
/**
 * The setup of the save location (docs/contracts.md 7.5 and 6.3): "Save to Pictures ›
 * Screenshots" (`chooseScreenshotsFolder`), and the actions of the buttons (`save-actions.js`).
 * The picker and the handles are fakes. What the real browser shows is in e2e/save-folder.spec.js
 * and in the manual checks.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  chooseFolder,
  permissionOf,
  readReconnects,
  reconnectFolder,
  useDownloads,
  writeReconnects,
} from '../../src/options/save-actions.js';
import { SETUP_PICKER_OPTIONS, chooseScreenshotsFolder } from '../../src/ui/folder-store.js';

/**
 * A directory handle that makes sub folders on request.
 * @param {string} name
 * @param {{ failMakeWith?: string }} [options]
 * @returns {any}
 */
function fakeDir(name, options = {}) {
  /** @type {Map<string, any>} */
  const dirs = new Map();
  return {
    kind: 'directory',
    name,
    dirs,
    /** @param {string} child @param {{ create?: boolean }} [o] */
    async getDirectoryHandle(child, o = {}) {
      if (options.failMakeWith) throw new DOMException('no', options.failMakeWith);
      const existing = dirs.get(child);
      if (existing) return existing;
      if (!o.create) throw new DOMException('not found', 'NotFoundError');
      const made = fakeDir(child);
      dirs.set(child, made);
      return made;
    },
  };
}

/**
 * A picker that gives `handle` (or throws `error`) and records its calls.
 * @param {unknown} result  A directory, or an Error to throw.
 */
function fakePicker(result) {
  /** @type {unknown[]} */
  const calls = [];
  const picker = async (/** @type {unknown} */ options) => {
    calls.push(options);
    if (result instanceof Error) throw result;
    return result;
  };
  return { picker: /** @type {any} */ (picker), calls };
}

describe('chooseScreenshotsFolder', () => {
  it('makes Screenshots below the folder that the user picked and keeps the picked one', async () => {
    const pictures = fakeDir('Pictures');
    const { picker, calls } = fakePicker(pictures);
    const target = await chooseScreenshotsFolder(picker);
    assert.ok(target);
    assert.equal(target.handle, pictures);
    assert.deepEqual(target.subPath, ['Screenshots']);
    assert.ok(pictures.dirs.has('Screenshots'), 'the folder exists now');
    assert.deepEqual(calls, [SETUP_PICKER_OPTIONS], 'the picker opens in Pictures');
  });

  it('uses a pick that is already named Screenshots as it is (no nesting)', async () => {
    for (const name of ['Screenshots', 'screenshots', 'SCREENSHOTS']) {
      const picked = fakeDir(name);
      const target = await chooseScreenshotsFolder(fakePicker(picked).picker);
      assert.ok(target, name);
      assert.deepEqual(target.subPath, [], name);
      assert.equal(picked.dirs.size, 0, `${name}: no sub folder is made`);
    }
  });

  it('uses a Screenshots folder that exists', async () => {
    const pictures = fakeDir('Pictures');
    const existing = fakeDir('Screenshots');
    pictures.dirs.set('Screenshots', existing);
    const target = await chooseScreenshotsFolder(fakePicker(pictures).picker);
    assert.deepEqual(target?.subPath, ['Screenshots']);
    assert.equal(pictures.dirs.get('Screenshots'), existing, 'it is not replaced');
  });

  it('gives null when the user closes the picker', async () => {
    const closed = new DOMException('The user aborted a request.', 'AbortError');
    assert.equal(await chooseScreenshotsFolder(fakePicker(closed).picker), null);
  });

  it('lets a blocked folder through as SecurityError', async () => {
    const blocked = new DOMException('System folder', 'SecurityError');
    await assert.rejects(() => chooseScreenshotsFolder(fakePicker(blocked).picker), {
      name: 'SecurityError',
    });
  });

  it('fails when the folder cannot be written, so the page can say so', async () => {
    const readOnly = fakeDir('Pictures', { failMakeWith: 'NotAllowedError' });
    await assert.rejects(() => chooseScreenshotsFolder(fakePicker(readOnly).picker), {
      name: 'NotAllowedError',
    });
  });

  it('calls the picker in the same task, before any await (the click is still fresh)', async () => {
    const { picker, calls } = fakePicker(fakeDir('Pictures'));
    const pending = chooseScreenshotsFolder(picker);
    assert.equal(calls.length, 1);
    await pending;
  });
});

describe('chooseFolder (the buttons)', () => {
  /** @type {(h: any, s: string[]) => Promise<void>} */
  const noSave = async () => undefined;

  it('"pictures" stores the picked folder and Screenshots below it', async () => {
    const pictures = fakeDir('Pictures');
    /** @type {unknown[]} */
    const saved = [];
    const outcome = await chooseFolder('pictures', {
      picker: fakePicker(pictures).picker,
      save: async (handle, subPath) => void saved.push([handle, subPath]),
    });
    assert.equal(outcome.status, 'saved');
    assert.deepEqual(saved, [[pictures, ['Screenshots']]]);
  });

  it('"other" stores the folder as it is, with no sub folder', async () => {
    const work = fakeDir('Work');
    /** @type {unknown[]} */
    const saved = [];
    const { picker, calls } = fakePicker(work);
    const outcome = await chooseFolder('other', {
      picker,
      save: async (handle, subPath) => void saved.push([handle, subPath]),
    });
    assert.equal(outcome.status, 'saved');
    assert.deepEqual(saved, [[work, []]]);
    assert.equal(work.dirs.size, 0, 'nothing is made in the folder');
    assert.equal(/** @type {any} */ (calls[0]).id, 'spool-shots');
  });

  it('starts the picker before any await, for both kinds', () => {
    for (const kind of /** @type {const} */ (['pictures', 'other'])) {
      const { picker, calls } = fakePicker(fakeDir('Pictures'));
      const pending = chooseFolder(kind, { picker, save: noSave });
      assert.equal(calls.length, 1, kind);
      void pending;
    }
  });

  it('says "cancelled", "blocked", "failed" and "no-picker" and stores nothing', async () => {
    let stored = 0;
    const save = async () => void (stored += 1);
    const closed = new DOMException('x', 'AbortError');
    const blocked = new DOMException('x', 'SecurityError');
    assert.deepEqual(await chooseFolder('pictures', { picker: fakePicker(closed).picker, save }), {
      status: 'cancelled',
    });
    assert.deepEqual(await chooseFolder('other', { picker: fakePicker(closed).picker, save }), {
      status: 'cancelled',
    });
    assert.deepEqual(await chooseFolder('pictures', { picker: fakePicker(blocked).picker, save }), {
      status: 'blocked',
    });
    assert.deepEqual(
      await chooseFolder('pictures', { picker: fakePicker(new Error('boom')).picker, save }),
      { status: 'failed' },
    );
    assert.deepEqual(await chooseFolder('pictures', { picker: undefined, save }), {
      status: 'no-picker',
    });
    assert.equal(stored, 0);
  });

  it('says "failed" when the folder cannot be stored', async () => {
    const outcome = await chooseFolder('other', {
      picker: fakePicker(fakeDir('Work')).picker,
      save: async () => {
        throw new Error('IndexedDB failed');
      },
    });
    assert.deepEqual(outcome, { status: 'failed' });
  });
});

describe('reconnectFolder', () => {
  const target = { handle: fakeDir('Pictures'), subPath: ['Screenshots'] };

  it('asks in its first statement, and makes the sub folder when access is back', async () => {
    /** @type {string[]} */
    const log = [];
    const pending = reconnectFolder(target, {
      request: async () => {
        log.push('request');
        return 'granted';
      },
      ensure: async () => void log.push('ensure'),
    });
    assert.deepEqual(log, ['request'], 'the request starts in the same task');
    assert.equal(await pending, 'granted');
    assert.deepEqual(log, ['request', 'ensure']);
  });

  it('says "prompt" or "denied" when the user does not allow it, and makes nothing', async () => {
    for (const answer of /** @type {const} */ (['prompt', 'denied'])) {
      let ensured = false;
      const outcome = await reconnectFolder(target, {
        request: async () => answer,
        ensure: async () => void (ensured = true),
      });
      assert.equal(outcome, answer);
      assert.equal(ensured, false);
    }
  });

  it('says "missing" when the folder is gone and "failed" for another error', async () => {
    const gone = await reconnectFolder(target, {
      request: async () => 'granted',
      ensure: async () => {
        throw new DOMException('gone', 'NotFoundError');
      },
    });
    assert.equal(gone, 'missing');
    const other = await reconnectFolder(target, {
      request: async () => 'granted',
      ensure: async () => {
        throw new Error('boom');
      },
    });
    assert.equal(other, 'failed');
  });
});

describe('useDownloads and the counters', () => {
  it('forgets the folder and ends the question on the toast', async () => {
    /** @type {string[]} */
    const log = [];
    await useDownloads({
      clear: async () => void log.push('clear'),
      silence: async () => void log.push('silence'),
    });
    assert.deepEqual(log, ['clear', 'silence']);
  });

  it('permissionOf: no folder means nothing to ask', async () => {
    assert.equal(await permissionOf(null, async () => 'granted'), 'prompt');
    const t = { handle: fakeDir('Pictures'), subPath: [] };
    assert.equal(await permissionOf(t, async () => 'denied'), 'denied');
  });

  it('reads and writes the number of reconnects, and never throws', async () => {
    /** @type {Record<string, unknown>} */
    const data = {};
    const area = {
      get: async (/** @type {string} */ key) => ({ [key]: data[key] }),
      set: async (/** @type {Record<string, unknown>} */ items) => void Object.assign(data, items),
    };
    assert.equal(await readReconnects(/** @type {any} */ (area)), 0);
    await writeReconnects(2, /** @type {any} */ (area));
    assert.equal(await readReconnects(/** @type {any} */ (area)), 2);
    await writeReconnects(-3, /** @type {any} */ (area));
    assert.equal(await readReconnects(/** @type {any} */ (area)), 0);
    data['saveReconnects'] = 'many';
    assert.equal(await readReconnects(/** @type {any} */ (area)), 0, 'a value that is no count');

    const broken = {
      get: async () => {
        throw new Error('storage');
      },
      set: async () => {
        throw new Error('storage');
      },
    };
    assert.equal(await readReconnects(/** @type {any} */ (broken)), 0);
    await writeReconnects(1, /** @type {any} */ (broken));
  });
});
