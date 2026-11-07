// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  LAST_SAVE_DOWNLOAD_KEY,
  createDownloader,
  recallSaveDownload,
  rememberSaveDownload,
} from '../../src/sw/downloads.js';

/**
 * A fake chrome.downloads. `plan(file)` says what happens to a file: `{ reject }`, or `{ state,
 * when }` where `when` is 'event' (a state change after download() returned), 'before' (the state
 * changed before download() returned, so only search() and the early event can tell) or 'never'.
 * @param {(file: { url: string, filename: string }, index: number) => any} [plan]
 */
function makeApi(plan = () => ({ state: 'complete', when: 'event' })) {
  /** @type {any[]} */
  const downloadCalls = [];
  /** @type {((delta: any) => void)[]} */
  const listeners = [];
  /** @type {Map<number, string>} */
  const states = new Map();
  let nextId = 1;
  let maxListeners = 0;
  const api = {
    downloadCalls,
    listeners,
    get maxListeners() {
      return maxListeners;
    },
    /** @param {any} options */
    async download(options) {
      const index = downloadCalls.length;
      downloadCalls.push(options);
      const p = plan(options, index);
      if (p.reject) throw new Error(p.reject);
      const id = nextId++;
      if (p.when === 'before') {
        states.set(id, p.state);
        for (const fn of [...listeners]) fn({ id, state: { current: p.state } });
      } else if (p.when === 'event') {
        setTimeout(() => {
          states.set(id, p.state);
          for (const fn of [...listeners]) fn({ id, state: { current: p.state } });
        }, 0);
      }
      return id;
    },
    /** @param {{ id: number }} query */
    async search({ id }) {
      const state = states.get(id);
      return state === undefined ? [{ state: 'in_progress' }] : [{ state }];
    },
    onChanged: {
      addListener(/** @type {(delta: any) => void} */ fn) {
        listeners.push(fn);
        maxListeners = Math.max(maxListeners, listeners.length);
      },
      removeListener(/** @type {(delta: any) => void} */ fn) {
        const i = listeners.indexOf(fn);
        if (i >= 0) listeners.splice(i, 1);
      },
    },
  };
  return api;
}

const FILES = [
  { path: 'Spool/Spool 2026-11-06 15.22.48 A.png', url: 'blob:chrome-extension://x/1' },
  { path: 'Spool/Spool for AI/B/screenshot-01-of-02.png', url: 'blob:chrome-extension://x/2' },
  { path: 'Spool/Spool for AI/B/screenshot-02-of-02.png', url: 'blob:chrome-extension://x/3' },
];

describe('createDownloader', () => {
  it('starts the files in order with the documented options and counts the complete ones', async () => {
    const api = makeApi();
    const { downloadFiles } = createDownloader({ api });
    const outcome = await downloadFiles(FILES);
    assert.deepEqual(outcome, { saved: 3, rejected: 0, interrupted: 0 });
    assert.deepEqual(
      api.downloadCalls,
      FILES.map((f) => ({
        url: f.url,
        filename: f.path,
        conflictAction: 'uniquify',
        saveAs: false,
      })),
    );
  });

  it('starts the next file only after the one before has ended', async () => {
    /** @type {string[]} */
    const log = [];
    const api = makeApi((file) => {
      log.push(`start ${file.url}`);
      return { state: 'complete', when: 'event' };
    });
    const originalAdd = api.onChanged.addListener;
    api.onChanged.addListener = (fn) => {
      log.push('listen');
      originalAdd(fn);
    };
    await createDownloader({ api }).downloadFiles(FILES.slice(0, 2));
    assert.deepEqual(log, ['listen', 'start blob:chrome-extension://x/1', 'start blob:chrome-extension://x/2']);
  });

  it('counts a call that Chrome refuses as rejected and goes on', async () => {
    const api = makeApi((_file, index) =>
      index === 0 ? { reject: 'Invalid filename' } : { state: 'complete', when: 'event' },
    );
    const outcome = await createDownloader({ api }).downloadFiles(FILES);
    assert.deepEqual(outcome, { saved: 2, rejected: 1, interrupted: 0 });
    assert.equal(api.downloadCalls.length, 3);
  });

  it('counts an interrupted download', async () => {
    const api = makeApi((_file, index) => ({
      state: index === 1 ? 'interrupted' : 'complete',
      when: 'event',
    }));
    const outcome = await createDownloader({ api }).downloadFiles(FILES);
    assert.deepEqual(outcome, { saved: 2, rejected: 0, interrupted: 1 });
  });

  it('sees a download that ended before download() returned (from the event or from search)', async () => {
    const api = makeApi(() => ({ state: 'complete', when: 'before' }));
    const outcome = await createDownloader({ api }).downloadFiles(FILES);
    assert.deepEqual(outcome, { saved: 3, rejected: 0, interrupted: 0 });
  });

  it('sees a finished download in search when the event was missed', async () => {
    const api = makeApi(() => ({ state: 'complete', when: 'none' }));
    // The state is only in search(): the fake stores it when the event would have fired.
    const original = api.download.bind(api);
    api.download = async (options) => {
      const id = await original(options);
      // The listener was not told, but the item is complete.
      /** @type {any} */ (api).search = async () => [{ state: 'complete' }];
      return id;
    };
    const outcome = await createDownloader({ api }).downloadFiles(FILES.slice(0, 1));
    assert.deepEqual(outcome, { saved: 1, rejected: 0, interrupted: 0 });
  });

  it('gives up on a download that never ends, after the wait time', async () => {
    const api = makeApi(() => ({ state: 'complete', when: 'never' }));
    /** @type {{ fn: () => void, ms: number }[]} */
    const timers = [];
    const downloader = createDownloader({
      api,
      waitMs: 1234,
      setTimer: (fn, ms) => {
        timers.push({ fn, ms });
        return timers.length;
      },
      clearTimer: () => {},
    });
    const pending = downloader.downloadFiles(FILES.slice(0, 1));
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(timers.length, 1);
    assert.equal(timers[0]?.ms, 1234);
    timers[0]?.fn();
    assert.deepEqual(await pending, { saved: 0, rejected: 0, interrupted: 1 });
    assert.equal(api.listeners.length, 0, 'the listener is removed');
  });

  it('keeps one temporary onChanged listener, and removes it at the end', async () => {
    const api = makeApi();
    await createDownloader({ api }).downloadFiles(FILES);
    assert.equal(api.maxListeners, 1);
    assert.equal(api.listeners.length, 0);
  });

  it('removes the listener also when a call throws something unexpected', async () => {
    const api = makeApi();
    api.search = async () => {
      throw new Error('search failed');
    };
    // search() fails: the event still tells.
    const outcome = await createDownloader({ api }).downloadFiles(FILES.slice(0, 1));
    assert.deepEqual(outcome, { saved: 1, rejected: 0, interrupted: 0 });
    assert.equal(api.listeners.length, 0);
  });

  it('ignores events of other downloads and other changes', async () => {
    const api = makeApi(() => ({ state: 'complete', when: 'never' }));
    const downloader = createDownloader({ api });
    const pending = downloader.downloadFiles(FILES.slice(0, 1));
    await new Promise((resolve) => setImmediate(resolve));
    for (const fn of [...api.listeners]) {
      fn({ id: 999, state: { current: 'complete' } }); // another download
      fn({ id: 1, filename: { current: 'x' } }); // not a state change
      fn({ id: 1, state: { current: 'in_progress' } }); // not final
      fn(undefined);
      fn({ id: 'x', state: { current: 'complete' } });
    }
    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(settled, false);
    for (const fn of [...api.listeners]) fn({ id: 1, state: { current: 'complete' } });
    assert.deepEqual(await pending, { saved: 1, rejected: 0, interrupted: 0 });
  });

  it('returns zero counts for no files', async () => {
    const api = makeApi();
    assert.deepEqual(await createDownloader({ api }).downloadFiles([]), {
      saved: 0,
      rejected: 0,
      interrupted: 0,
    });
  });
});

describe('createDownloader: onComplete', () => {
  it('gives the ID of each complete file, in order', async () => {
    const api = makeApi();
    const { downloadFiles } = createDownloader({ api });
    /** @type {number[]} */
    const ids = [];
    await downloadFiles(FILES, (id) => ids.push(id));
    assert.deepEqual(ids, [1, 2, 3]);
  });

  it('skips a file that was refused or interrupted', async () => {
    const api = makeApi((_file, index) =>
      index === 0
        ? { reject: 'Invalid filename' }
        : index === 1
          ? { state: 'interrupted', when: 'event' }
          : { state: 'complete', when: 'event' },
    );
    const { downloadFiles } = createDownloader({ api });
    /** @type {number[]} */
    const ids = [];
    const outcome = await downloadFiles(FILES, (id) => ids.push(id));
    assert.deepEqual(outcome, { saved: 1, rejected: 1, interrupted: 1 });
    assert.deepEqual(ids, [2], 'the first file got no ID, the second was interrupted');
  });

  it('ignores an error that the callback throws', async () => {
    const api = makeApi();
    const { downloadFiles } = createDownloader({ api });
    const outcome = await downloadFiles(FILES, () => {
      throw new Error('boom');
    });
    assert.deepEqual(outcome, { saved: 3, rejected: 0, interrupted: 0 });
  });
});

describe('the download ID of the last save', () => {
  /**
   * A fake chrome.storage.session.
   * @param {Record<string, unknown>} [start]
   * @returns {any}
   */
  function makeArea(start = {}) {
    const data = { ...start };
    return {
      data,
      /** @param {string} key */
      async get(key) {
        return Object.hasOwn(data, key) ? { [key]: data[key] } : {};
      },
      /** @param {Record<string, unknown>} items */
      async set(items) {
        Object.assign(data, items);
      },
    };
  }

  it('is kept as a plain number under one key', async () => {
    const area = makeArea();
    await rememberSaveDownload(41, area);
    assert.deepEqual(area.data, { [LAST_SAVE_DOWNLOAD_KEY]: 41 });
    assert.equal(await recallSaveDownload(area), 41);
  });

  it('the next save replaces it', async () => {
    const area = makeArea();
    await rememberSaveDownload(41, area);
    await rememberSaveDownload(57, area);
    assert.equal(await recallSaveDownload(area), 57);
  });

  it('is undefined when nothing was kept or the value is not an ID', async () => {
    assert.equal(await recallSaveDownload(makeArea()), undefined);
    for (const bad of ['41', -1, 1.5, null, {}, Number.NaN]) {
      assert.equal(await recallSaveDownload(makeArea({ [LAST_SAVE_DOWNLOAD_KEY]: bad })), undefined);
    }
  });

  it('never throws when the storage fails or does not exist', async () => {
    const failing = {
      async get() {
        throw new Error('no storage');
      },
      async set() {
        throw new Error('no storage');
      },
    };
    await rememberSaveDownload(41, failing);
    assert.equal(await recallSaveDownload(failing), undefined);
    // With no area and no `chrome` global (a unit test), the default also does not throw.
    await rememberSaveDownload(41);
    assert.equal(await recallSaveDownload(), undefined);
  });
});
