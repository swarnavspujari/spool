// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PICKER_OPTIONS,
  SETUP_PICKER_OPTIONS,
  cleanSubPath,
  createFolderStore,
  ensureSubPath,
  folderExists,
  folderPermission,
  pickSaveFolder,
  requestFolderPermission,
} from '../../src/ui/folder-store.js';

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

/**
 * A directory handle that is good enough for the store: it has a `kind`, and the permission
 * methods. The permission state comes from `states`.
 * @param {string} name
 * @param {{ query?: unknown, request?: unknown }} [states]  A value, or an Error to throw.
 */
function fakeHandle(name, states = {}) {
  /** @param {unknown} value */
  const answer = async (value) => {
    if (value instanceof Error) throw value;
    return value;
  };
  return {
    kind: 'directory',
    name,
    calls: /** @type {unknown[]} */ ([]),
    async queryPermission(/** @type {unknown} */ options) {
      this.calls.push(['query', options]);
      return answer(states.query ?? 'granted');
    },
    async requestPermission(/** @type {unknown} */ options) {
      this.calls.push(['request', options]);
      return answer(states.request ?? 'granted');
    },
  };
}

/** @param {unknown} value */
const isFakeHandle = (value) =>
  typeof value === 'object' && value !== null && /** @type {any} */ (value).kind === 'directory';

/**
 * A small IndexedDB. It has one database with object stores that hold values by key, the
 * request and transaction events in the order of the real thing (the request first, then
 * `complete`), and it counts opens and closes.
 * @param {{ failOpen?: boolean, failTransaction?: boolean, data?: Record<string, unknown> }} [options]
 */
function fakeIndexedDB({ failOpen = false, failTransaction = false, data = {} } = {}) {
  /** @type {Map<string, unknown>} */
  const values = new Map(Object.entries(data));
  const counts = { opened: 0, closed: 0, upgraded: 0 };
  let created = false;

  const factory = {
    /** @param {string} _name @param {number} _version */
    open(_name, _version) {
      /** @type {any} */
      const request = { result: null, error: null };
      queueMicrotask(() => {
        if (failOpen) {
          request.error = new Error('open failed');
          request.onerror?.();
          return;
        }
        const db = {
          createObjectStore() {
            counts.upgraded += 1;
          },
          close() {
            counts.closed += 1;
          },
          transaction(/** @type {string} */ _store, /** @type {string} */ mode) {
            /** @type {any} */
            const transaction = { error: null };
            const objectStore = {
              /** @param {string} key */
              get: (key) => run(() => values.get(key)),
              /** @param {unknown} value @param {string} key */
              put: (value, key) => run(() => (values.set(key, value), key), mode === 'readwrite'),
              /** @param {string} key */
              delete: (key) => run(() => (values.delete(key), undefined), mode === 'readwrite'),
            };
            /**
             * @param {() => unknown} work
             * @param {boolean} [writes]
             */
            function run(work, writes = false) {
              if (writes && mode !== 'readwrite') throw new Error('read-only transaction');
              /** @type {any} */
              const req = { result: undefined, error: null };
              queueMicrotask(() => {
                if (failTransaction) {
                  transaction.error = new Error('transaction failed');
                  transaction.onerror?.();
                  return;
                }
                req.result = work();
                req.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return req;
            }
            transaction.objectStore = () => objectStore;
            return transaction;
          },
        };
        counts.opened += 1;
        request.result = db;
        if (!created) {
          created = true;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory: /** @type {any} */ (factory), values, counts };
}

/** @param {ReturnType<typeof fakeIndexedDB>} idb */
function storeOn(idb) {
  return createFolderStore({ indexedDB: idb.factory, isHandle: isFakeHandle });
}

// ---------------------------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------------------------

test('folder store: nothing is stored at first', async () => {
  const store = storeOn(fakeIndexedDB());
  assert.equal(await store.getSaveFolder(), null);
});

test('folder store: set, then get gives the same handle', async () => {
  const store = storeOn(fakeIndexedDB());
  const handle = fakeHandle('Screenshots');
  await store.setSaveFolder(/** @type {any} */ (handle));
  assert.equal(await store.getSaveFolder(), handle);
});

test('folder store: set replaces the earlier folder, and clear forgets it', async () => {
  const store = storeOn(fakeIndexedDB());
  const first = fakeHandle('One');
  const second = fakeHandle('Two');
  await store.setSaveFolder(/** @type {any} */ (first));
  await store.setSaveFolder(/** @type {any} */ (second));
  assert.equal(await store.getSaveFolder(), second);
  await store.clearSaveFolder();
  assert.equal(await store.getSaveFolder(), null);
  // Clearing an empty store is fine.
  await store.clearSaveFolder();
  assert.equal(await store.getSaveFolder(), null);
});

test('folder store: a value that is not a handle is not a folder', async () => {
  const idb = fakeIndexedDB({ data: { saveFolder: 'C:\\Users\\me\\Pictures' } });
  assert.equal(await storeOn(idb).getSaveFolder(), null);
  const file = { kind: 'file', name: 'x.png' };
  assert.equal(await storeOn(fakeIndexedDB({ data: { saveFolder: file } })).getSaveFolder(), null);
});

test('folder store: setSaveFolder refuses a value that is not a directory handle', async () => {
  const idb = fakeIndexedDB();
  const store = storeOn(idb);
  await assert.rejects(() => store.setSaveFolder(/** @type {any} */ ('Pictures')), TypeError);
  await assert.rejects(
    () => store.setSaveFolder(/** @type {any} */ ({ kind: 'file', name: 'a' })),
    TypeError,
  );
  assert.equal(idb.values.size, 0);
  assert.equal(idb.counts.opened, 0, 'the database is not even opened');
});

test('folder store: only the handle and the folder names are stored, under two keys', async () => {
  const idb = fakeIndexedDB();
  const handle = fakeHandle('Pictures');
  await storeOn(idb).setSaveFolder(/** @type {any} */ (handle), ['Screenshots']);
  assert.deepEqual([...idb.values.keys()].sort(), ['saveFolder', 'saveSubPath']);
  assert.equal(idb.values.get('saveFolder'), handle);
  assert.deepEqual(idb.values.get('saveSubPath'), ['Screenshots']);
});

test('folder store: set and get give the handle with its sub folders, one transaction each', async () => {
  const idb = fakeIndexedDB();
  const store = storeOn(idb);
  const handle = fakeHandle('Pictures');
  await store.setSaveFolder(/** @type {any} */ (handle), ['Screenshots']);
  assert.equal(idb.counts.opened, 1, 'both keys are written in one transaction');
  assert.deepEqual(await store.getSaveTarget(), { handle, subPath: ['Screenshots'] });
  assert.equal(idb.counts.opened, 2, 'both keys are read in one transaction');
  assert.equal(await store.getSaveFolder(), handle, 'getSaveFolder still gives the handle');
});

test('folder store: a handle stored without folder names (version 1.0.0) keeps its folder', async () => {
  const handle = fakeHandle('Screenshots');
  const store = storeOn(fakeIndexedDB({ data: { saveFolder: handle } }));
  assert.deepEqual(await store.getSaveTarget(), { handle, subPath: [] });
  assert.equal(await store.getSaveFolder(), handle);
});

test('folder store: setSaveFolder without folder names clears the names of an earlier target', async () => {
  const idb = fakeIndexedDB();
  const store = storeOn(idb);
  await store.setSaveFolder(/** @type {any} */ (fakeHandle('Pictures')), ['Screenshots']);
  const other = fakeHandle('Work');
  await store.setSaveFolder(/** @type {any} */ (other));
  assert.deepEqual(await store.getSaveTarget(), { handle: other, subPath: [] });
});

test('folder store: folder names that are not valid read as none', async () => {
  const handle = fakeHandle('Pictures');
  const bad = [
    'Screenshots', // Not a list.
    ['a', 'b', 'c'], // More than two.
    ['..'],
    ['a/b'],
    [''],
    [7],
    ['CON'],
    ['Report.exe'],
    ['x'.repeat(200)],
    null,
  ];
  for (const value of bad) {
    const idb = fakeIndexedDB({ data: { saveFolder: handle, saveSubPath: value } });
    assert.deepEqual(
      await storeOn(idb).getSaveTarget(),
      { handle, subPath: [] },
      JSON.stringify(value),
    );
  }
});

test('folder store: setSaveFolder refuses folder names that are not valid', async () => {
  const idb = fakeIndexedDB();
  const store = storeOn(idb);
  const handle = /** @type {any} */ (fakeHandle('Pictures'));
  await assert.rejects(() => store.setSaveFolder(handle, ['..']), TypeError);
  await assert.rejects(() => store.setSaveFolder(handle, ['a', 'b', 'c']), TypeError);
  await assert.rejects(() => store.setSaveFolder(handle, /** @type {any} */ ('x')), TypeError);
  assert.equal(idb.values.size, 0);
});

test('folder store: clear removes the handle and the folder names', async () => {
  const idb = fakeIndexedDB();
  const store = storeOn(idb);
  await store.setSaveFolder(/** @type {any} */ (fakeHandle('Pictures')), ['Screenshots']);
  await store.clearSaveFolder();
  assert.equal(idb.values.size, 0);
  assert.equal(await store.getSaveTarget(), null);
});

test('folder store: getSaveTarget never throws, also when the database fails', async () => {
  assert.equal(await storeOn(fakeIndexedDB({ failOpen: true })).getSaveTarget(), null);
  assert.equal(await storeOn(fakeIndexedDB({ failTransaction: true })).getSaveTarget(), null);
  const none = createFolderStore({ indexedDB: /** @type {any} */ (null), isHandle: isFakeHandle });
  assert.equal(await none.getSaveTarget(), null);
});

test('cleanSubPath: keeps up to two clean names and nothing else', () => {
  assert.deepEqual(cleanSubPath(['Screenshots']), ['Screenshots']);
  assert.deepEqual(cleanSubPath(['Spool', 'Shots 2026']), ['Spool', 'Shots 2026']);
  assert.deepEqual(cleanSubPath([]), []);
  assert.deepEqual(cleanSubPath(undefined), []);
  assert.deepEqual(cleanSubPath(['a', 'b', 'c']), []);
  assert.deepEqual(cleanSubPath(['a:b']), [], 'a name that sanitizing would change is not clean');
  assert.deepEqual(cleanSubPath(['ok', '..']), [], 'one bad name voids the whole list');
});

/**
 * A directory that makes sub folders on request, and records what it was asked for.
 * @param {string} name
 * @param {{ failWith?: string }} [options]
 * @returns {any}
 */
function fakeDir(name, options = {}) {
  /** @type {Map<string, any>} */
  const dirs = new Map();
  /** @type {unknown[]} */
  const asked = [];
  return {
    kind: 'directory',
    name,
    dirs,
    asked,
    /** @param {string} child @param {unknown} opts */
    async getDirectoryHandle(child, opts) {
      asked.push([child, opts]);
      if (options.failWith) throw new DOMException('no', options.failWith);
      let made = dirs.get(child);
      if (!made) {
        made = fakeDir(child);
        dirs.set(child, made);
      }
      return made;
    },
  };
}

test('ensureSubPath: makes each folder that is missing and gives the last one', async () => {
  const root = fakeDir('Pictures');
  const leaf = await ensureSubPath(root, ['Spool', 'Shots']);
  assert.equal(leaf.name, 'Shots');
  assert.equal(root.dirs.get('Spool').dirs.get('Shots'), leaf);
  assert.deepEqual(root.asked, [['Spool', { create: true }]]);
  // A folder that exists is used again, not replaced.
  assert.equal(await ensureSubPath(root, ['Spool', 'Shots']), leaf);
});

test('ensureSubPath: no folder names gives the root itself', async () => {
  const root = fakeDir('Screenshots');
  assert.equal(await ensureSubPath(root, []), root);
  assert.deepEqual(root.asked, []);
});

test('ensureSubPath: gives what the browser throws (no access, or the folder is gone)', async () => {
  await assert.rejects(
    () => ensureSubPath(fakeDir('Pictures', { failWith: 'NotAllowedError' }), ['Screenshots']),
    { name: 'NotAllowedError' },
  );
  await assert.rejects(
    () => ensureSubPath(fakeDir('Pictures', { failWith: 'NotFoundError' }), ['Screenshots']),
    { name: 'NotFoundError' },
  );
});

test('folder store: the database is created once and closed after every call', async () => {
  const idb = fakeIndexedDB();
  const store = storeOn(idb);
  await store.getSaveFolder();
  await store.setSaveFolder(/** @type {any} */ (fakeHandle('A')));
  await store.getSaveFolder();
  await store.clearSaveFolder();
  assert.equal(idb.counts.upgraded, 1);
  assert.equal(idb.counts.opened, 4);
  assert.equal(idb.counts.closed, 4);
});

test('folder store: getSaveFolder never throws, also when the database fails', async () => {
  assert.equal(await storeOn(fakeIndexedDB({ failOpen: true })).getSaveFolder(), null);
  assert.equal(await storeOn(fakeIndexedDB({ failTransaction: true })).getSaveFolder(), null);
  // No IndexedDB at all (for example in a page that has none).
  const none = createFolderStore({ indexedDB: /** @type {any} */ (null), isHandle: isFakeHandle });
  const saved = globalThis.indexedDB;
  try {
    assert.equal(await none.getSaveFolder(), null);
  } finally {
    if (saved !== undefined) globalThis.indexedDB = saved;
  }
});

test('folder store: the calls that change something tell the caller when they fail', async () => {
  const failing = storeOn(fakeIndexedDB({ failOpen: true }));
  await assert.rejects(() => failing.setSaveFolder(/** @type {any} */ (fakeHandle('A'))), /open failed/);
  await assert.rejects(() => failing.clearSaveFolder(), /open failed/);
  const aborting = storeOn(fakeIndexedDB({ failTransaction: true }));
  await assert.rejects(
    () => aborting.setSaveFolder(/** @type {any} */ (fakeHandle('A'))),
    /transaction failed/,
  );
});

test('folder store: the database is closed also when a call fails', async () => {
  const idb = fakeIndexedDB({ failTransaction: true });
  await storeOn(idb).clearSaveFolder().catch(() => undefined);
  assert.equal(idb.counts.closed, idb.counts.opened);
  assert.equal(idb.counts.opened, 1);
});

// ---------------------------------------------------------------------------------------------
// Permission
// ---------------------------------------------------------------------------------------------

test('folderPermission: asks for readwrite and returns the three states', async () => {
  for (const state of /** @type {const} */ (['granted', 'prompt', 'denied'])) {
    const handle = fakeHandle('A', { query: state });
    assert.equal(await folderPermission(/** @type {any} */ (handle)), state);
    assert.deepEqual(handle.calls, [['query', { mode: 'readwrite' }]]);
  }
});

test('folderPermission: an unknown answer counts as prompt, and a failure as denied', async () => {
  assert.equal(
    await folderPermission(/** @type {any} */ (fakeHandle('A', { query: 'maybe' }))),
    'prompt',
  );
  assert.equal(
    await folderPermission(/** @type {any} */ (fakeHandle('A', { query: undefined }))),
    'granted',
  );
  const gone = fakeHandle('A', { query: new DOMException('Gone', 'NotFoundError') });
  assert.equal(await folderPermission(/** @type {any} */ (gone)), 'denied');
  // A value that has no permission methods at all.
  assert.equal(await folderPermission(/** @type {any} */ ({})), 'denied');
});

test('folderPermission never asks the user', async () => {
  const handle = fakeHandle('A', { query: 'prompt' });
  await folderPermission(/** @type {any} */ (handle));
  assert.ok(handle.calls.every((call) => /** @type {any} */ (call)[0] === 'query'));
});

test('requestFolderPermission: asks for readwrite and returns the answer', async () => {
  const handle = fakeHandle('A', { query: 'prompt', request: 'granted' });
  assert.equal(await requestFolderPermission(/** @type {any} */ (handle)), 'granted');
  assert.deepEqual(handle.calls, [['request', { mode: 'readwrite' }]]);
  const refused = fakeHandle('A', { request: 'denied' });
  assert.equal(await requestFolderPermission(/** @type {any} */ (refused)), 'denied');
});

test('requestFolderPermission: without a click the browser refuses, and the state stays', async () => {
  const handle = fakeHandle('A', {
    query: 'prompt',
    request: new DOMException('Needs a click', 'SecurityError'),
  });
  assert.equal(await requestFolderPermission(/** @type {any} */ (handle)), 'prompt');
  const gone = fakeHandle('A', {
    query: new DOMException('Gone', 'NotFoundError'),
    request: new DOMException('Gone', 'NotFoundError'),
  });
  assert.equal(await requestFolderPermission(/** @type {any} */ (gone)), 'denied');
});

// ---------------------------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------------------------

test('pickSaveFolder: calls the picker at once, with the options of the contract', async () => {
  /** @type {unknown[]} */
  const calls = [];
  const handle = fakeHandle('Screenshots');
  const pending = pickSaveFolder(
    /** @type {any} */ (
      async (/** @type {unknown} */ options) => {
        calls.push(options);
        return handle;
      }
    ),
  );
  // Before any await of this test: the click is still fresh (user activation) at this point.
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], { id: 'spool-shots', mode: 'readwrite', startIn: 'pictures' });
  assert.equal(await pending, handle);
  assert.deepEqual({ ...PICKER_OPTIONS }, { id: 'spool-shots', mode: 'readwrite', startIn: 'pictures' });
});

test('the setup picker has its own id, so the remembered folder never replaces startIn', () => {
  assert.deepEqual(
    { ...SETUP_PICKER_OPTIONS },
    { id: 'spool-pictures', mode: 'readwrite', startIn: 'pictures' },
  );
  assert.notEqual(SETUP_PICKER_OPTIONS.id, PICKER_OPTIONS.id);
});

test('pickSaveFolder: gives the options that it is given to the picker', async () => {
  /** @type {unknown[]} */
  const calls = [];
  const handle = fakeHandle('Pictures');
  const picked = await pickSaveFolder(
    /** @type {any} */ (
      async (/** @type {unknown} */ options) => {
        calls.push(options);
        return handle;
      }
    ),
    SETUP_PICKER_OPTIONS,
  );
  assert.equal(picked, handle);
  assert.deepEqual(calls, [SETUP_PICKER_OPTIONS]);
});

test('pickSaveFolder: closing the picker gives null, other failures are thrown', async () => {
  const closed = async () => {
    throw new DOMException('The user aborted a request.', 'AbortError');
  };
  assert.equal(await pickSaveFolder(/** @type {any} */ (closed)), null);
  const blocked = async () => {
    throw new DOMException('System files', 'SecurityError');
  };
  await assert.rejects(() => pickSaveFolder(/** @type {any} */ (blocked)), /System files/);
  const broken = async () => {
    throw new Error('boom');
  };
  await assert.rejects(() => pickSaveFolder(/** @type {any} */ (broken)), /boom/);
});

test('pickSaveFolder: a browser without the picker gives a plain error', async () => {
  const saved = /** @type {any} */ (globalThis).showDirectoryPicker;
  delete (/** @type {any} */ (globalThis).showDirectoryPicker);
  try {
    await assert.rejects(() => pickSaveFolder(), /cannot choose a folder/);
  } finally {
    if (saved !== undefined) /** @type {any} */ (globalThis).showDirectoryPicker = saved;
  }
});

/**
 * A handle whose entries come from `values()`. The first read can throw.
 * @param {{ throws?: string, entries?: number }} [options]
 * @returns {any}
 */
function listingHandle({ throws, entries = 1 } = {}) {
  return {
    kind: 'directory',
    name: 'Pictures',
    values() {
      let left = entries;
      return {
        [Symbol.asyncIterator]() {
          return {
            async next() {
              if (throws) throw new DOMException('x', throws);
              left -= 1;
              return left >= 0 ? { done: false, value: {} } : { done: true, value: undefined };
            },
          };
        },
      };
    },
  };
}

test('folderExists: a folder that lists, or is empty, is there', async () => {
  assert.equal(await folderExists(listingHandle()), true);
  assert.equal(await folderExists(listingHandle({ entries: 0 })), true);
});

test('folderExists: only NotFoundError says that the folder is gone', async () => {
  assert.equal(await folderExists(listingHandle({ throws: 'NotFoundError' })), false);
  assert.equal(await folderExists(listingHandle({ throws: 'NotAllowedError' })), true);
  assert.equal(await folderExists(listingHandle({ throws: 'SecurityError' })), true);
  // A value with no listing at all is not a reason to say "gone".
  assert.equal(await folderExists(/** @type {any} */ ({})), true);
});
