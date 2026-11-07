// @ts-check
/**
 * Tests added by mutation testing for the folder store
 * (src/ui/folder-store.js). The older fake database accepted any database name, version, store
 * name and transaction mode, so a rename (which would make every user lose the folder that they
 * chose) passed. This fake is strict like a real IndexedDB, and the names are pinned.
 */

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  clearSaveFolder,
  createFolderStore,
  getSaveFolder,
  setSaveFolder,
} from '../../src/ui/folder-store.js';

/**
 * A strict IndexedDB: a store must exist before a transaction names it, a write needs
 * 'readwrite', and every call is recorded.
 * @param {{ block?: boolean, abort?: boolean }} [options]
 */
function strictIdb(options = {}) {
  /** @type {Map<string, unknown>} */
  const values = new Map();
  /** @type {Set<string>} */
  const stores = new Set();
  const log = {
    /** @type {[string, number][]} */
    opens: [],
    /** @type {string[]} */
    created: [],
    /** @type {[string, string][]} */
    transactions: [],
    /** @type {string[]} */
    keys: [],
  };
  let upgraded = false;
  const factory = {
    /** @param {string} name @param {number} version */
    open(name, version) {
      log.opens.push([name, version]);
      /** @type {any} */
      const request = { result: null, error: null };
      queueMicrotask(() => {
        if (options.block) {
          request.onblocked?.();
          return;
        }
        const db = {
          createObjectStore(/** @type {string} */ storeName) {
            stores.add(storeName);
            log.created.push(storeName);
          },
          close() {},
          transaction(/** @type {string} */ storeName, /** @type {string} */ mode) {
            log.transactions.push([storeName, mode]);
            if (!stores.has(storeName)) throw new DOMException('no such store', 'NotFoundError');
            if (mode !== 'readonly' && mode !== 'readwrite') throw new TypeError('bad mode');
            /** @type {any} */
            const transaction = { error: null };
            /** @param {() => unknown} work @param {boolean} writes */
            const run = (work, writes) => {
              if (writes && mode !== 'readwrite') throw new DOMException('read only', 'ReadOnlyError');
              /** @type {any} */
              const req = { result: undefined, error: null };
              queueMicrotask(() => {
                if (options.abort) {
                  transaction.onabort?.();
                  return;
                }
                req.result = work();
                req.onsuccess?.();
                queueMicrotask(() => transaction.oncomplete?.());
              });
              return req;
            };
            transaction.objectStore = () => ({
              get: (/** @type {string} */ key) => {
                log.keys.push(key);
                return run(() => values.get(key), false);
              },
              put: (/** @type {unknown} */ value, /** @type {string} */ key) => {
                log.keys.push(key);
                return run(() => (values.set(key, value), key), true);
              },
              delete: (/** @type {string} */ key) => {
                log.keys.push(key);
                return run(() => (values.delete(key), undefined), true);
              },
            });
            return transaction;
          },
        };
        request.result = db;
        if (!upgraded) {
          upgraded = true;
          request.onupgradeneeded?.();
        }
        request.onsuccess?.();
      });
      return request;
    },
  };
  return { factory: /** @type {any} */ (factory), values, log };
}

const handle = { kind: 'directory', name: 'Shots' };
const isHandle = (/** @type {unknown} */ v) => v === handle;

describe('folder store: what is stored where (a rename would lose the saved folder)', () => {
  it('uses the database "spool-folder" version 1, the store "handles" and the keys "saveFolder" and "saveSubPath"', async () => {
    const idb = strictIdb();
    const store = createFolderStore({ indexedDB: idb.factory, isHandle });
    await store.setSaveFolder(/** @type {any} */ (handle));
    assert.equal(await store.getSaveFolder(), handle);
    await store.clearSaveFolder();
    assert.deepEqual(idb.log.opens.at(0), ['spool-folder', 1]);
    assert.deepEqual(idb.log.created, ['handles']);
    assert.deepEqual(idb.log.transactions, [
      ['handles', 'readwrite'],
      ['handles', 'readonly'],
      ['handles', 'readwrite'],
    ]);
    // The handle keeps its key from version 1.0.0, so a stored folder is still found. The names of
    // the folders below it have a key of their own, and every call uses both in one transaction.
    assert.deepEqual(idb.log.keys, [
      'saveFolder',
      'saveSubPath',
      'saveFolder',
      'saveSubPath',
      'saveFolder',
      'saveSubPath',
    ]);
  });
});

describe('folder store: a database that cannot be used', () => {
  it('reports a blocked database: the folder is unknown and a change fails with a clear error', async () => {
    const store = createFolderStore({ indexedDB: strictIdb({ block: true }).factory, isHandle });
    assert.equal(await store.getSaveFolder(), null);
    await assert.rejects(store.setSaveFolder(/** @type {any} */ (handle)), /IndexedDB is blocked\./);
  });

  it('reports a transaction that was aborted instead of waiting for ever', async () => {
    const store = createFolderStore({ indexedDB: strictIdb({ abort: true }).factory, isHandle });
    await assert.rejects(store.setSaveFolder(/** @type {any} */ (handle)), /IndexedDB stopped the change\./);
  });
});

describe('folder store: the default test for a directory handle', () => {
  const g = /** @type {any} */ (globalThis);
  const hadClass = Object.hasOwn(g, 'FileSystemDirectoryHandle');
  const previous = g.FileSystemDirectoryHandle;
  afterEach(() => {
    if (hadClass) g.FileSystemDirectoryHandle = previous;
    else delete g.FileSystemDirectoryHandle;
  });

  /** @param {unknown} value */
  async function storedAs(value) {
    const idb = strictIdb();
    idb.values.set('saveFolder', value);
    const store = createFolderStore({ indexedDB: idb.factory });
    return store.getSaveFolder();
  }

  it('accepts an instance of FileSystemDirectoryHandle whose kind is "directory"', async () => {
    g.FileSystemDirectoryHandle = class {
      kind = 'directory';
    };
    const value = new g.FileSystemDirectoryHandle();
    assert.equal(await storedAs(value), value);
  });

  it('refuses an instance of kind "file", and an object that is not an instance', async () => {
    g.FileSystemDirectoryHandle = class {
      kind = 'file';
    };
    assert.equal(await storedAs(new g.FileSystemDirectoryHandle()), null);
    assert.equal(await storedAs({ kind: 'directory' }), null);
  });

  it('refuses everything in a browser that has no FileSystemDirectoryHandle', async () => {
    delete g.FileSystemDirectoryHandle;
    assert.equal(await storedAs({ kind: 'directory' }), null);
  });
});

describe('folder store: the functions of the module use the shared store', () => {
  // Node has no IndexedDB, so the shared store fails the way a browser without one would.
  it('getSaveFolder gives null, and says so (not undefined)', async () => {
    assert.strictEqual(await getSaveFolder(), null);
  });

  it('setSaveFolder passes the refusal of a bad handle on', async () => {
    await assert.rejects(setSaveFolder(/** @type {any} */ ({})), TypeError);
  });

  it('clearSaveFolder passes the failure of the database on', async () => {
    await assert.rejects(clearSaveFolder(), /IndexedDB is not available\./);
  });
});
