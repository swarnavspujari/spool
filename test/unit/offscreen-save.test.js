// @ts-check
/**
 * The save step (docs/contracts.md 7.3): the folder writer with an in-memory directory, and the
 * saver that chooses between the chosen folder and chrome.downloads.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAccessError,
  isMissingError,
  pickFreeBase,
  writeFiles,
} from '../../src/offscreen/folder-writer.js';
import { createSaver } from '../../src/offscreen/save.js';
import { captureBaseName, captureFiles } from '../../src/lib/names.js';

const DATE = new Date(2026, 10, 6, 15, 22, 48);
const BASE = 'Spool 2026-11-06 15.22.48 Inbox - Mail';

// ---------------------------------------------------------------------------------------------
// An in-memory directory with the three calls that the writer uses
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} [name]
 * @param {{ failWriteOf?: string, denyWrites?: boolean, missing?: boolean }} [options]
 *   `missing`: the folder is gone (a deleted folder: every call fails with NotFoundError).
 * @returns {any}
 */
function makeDir(name = 'Screenshots', options = {}) {
  /** @type {Map<string, any>} */
  const dirs = new Map();
  /** @type {Map<string, Blob>} */
  const files = new Map();
  const dir = {
    name,
    dirs,
    files,
    /** @param {string} n @param {{ create?: boolean }} [o] */
    async getDirectoryHandle(n, o = {}) {
      if (options.missing) throw new DOMException('gone', 'NotFoundError');
      if (files.has(n)) throw new DOMException('is a file', 'TypeMismatchError');
      const existing = dirs.get(n);
      if (existing) return existing;
      if (!o.create) throw new DOMException('not found', 'NotFoundError');
      const created = makeDir(n, options);
      dirs.set(n, created);
      return created;
    },
    /** @param {string} n @param {{ create?: boolean }} [o] */
    async getFileHandle(n, o = {}) {
      if (options.missing) throw new DOMException('gone', 'NotFoundError');
      if (dirs.has(n)) throw new DOMException('is a directory', 'TypeMismatchError');
      if (!files.has(n) && !o.create) throw new DOMException('not found', 'NotFoundError');
      return {
        name: n,
        async createWritable() {
          if (options.denyWrites) throw new DOMException('no access', 'NotAllowedError');
          /** @type {Blob | null} */
          let pending = null;
          return {
            async write(/** @type {Blob} */ blob) {
              if (options.failWriteOf === n) throw new Error('disk full');
              pending = blob;
            },
            async close() {
              if (pending) files.set(n, pending);
              else files.set(n, new Blob([]));
            },
            async abort() {
              pending = null;
            },
          };
        },
      };
    },
  };
  return dir;
}

/** Lists every file below a directory as "a/b/c.png". @param {any} dir @param {string} [prefix] @returns {string[]} */
function listFiles(dir, prefix = '') {
  /** @type {string[]} */
  const out = [];
  for (const n of dir.files.keys()) out.push(`${prefix}${n}`);
  for (const [n, d] of dir.dirs) out.push(...listFiles(d, `${prefix}${n}/`));
  return out.sort();
}

const blob = (/** @type {number} */ n) => new Blob([new Uint8Array(n)]);

// ---------------------------------------------------------------------------------------------
// Folder writer
// ---------------------------------------------------------------------------------------------

describe('folder writer', () => {
  /** @param {string} base */
  const makeFiles = (base) => captureFiles({ base, tileCount: 3, saveTiles: true, saveFull: true });

  it('writes the full image flat and the tiles below "Spool for AI/<base>/"', async () => {
    const root = makeDir();
    const files = makeFiles(BASE).map((f) => ({ ...f, blob: blob(10) }));
    assert.equal(await writeFiles(root, files), 4);
    assert.deepEqual(listFiles(root), [
      `${BASE}.png`,
      `Spool for AI/${BASE}/screenshot-01-of-03.png`,
      `Spool for AI/${BASE}/screenshot-02-of-03.png`,
      `Spool for AI/${BASE}/screenshot-03-of-03.png`,
    ]);
  });

  it('writes the bytes of each file', async () => {
    const root = makeDir();
    const a = blob(7);
    await writeFiles(root, [{ kind: 'full', path: ['a.png'], blob: a }]);
    assert.equal(root.files.get('a.png'), a);
  });

  it('stops at the first failure, and leaves no half file under the final name', async () => {
    const root = makeDir('Screenshots', { failWriteOf: 'screenshot-02-of-03.png' });
    const files = makeFiles(BASE).map((f) => ({ ...f, blob: blob(10) }));
    await assert.rejects(writeFiles(root, files), /disk full/);
    assert.deepEqual(listFiles(root), [
      `${BASE}.png`,
      `Spool for AI/${BASE}/screenshot-01-of-03.png`,
    ]);
  });

  it('counts the files that are complete, also when a later write fails', async () => {
    const root = makeDir('Screenshots', { failWriteOf: 'screenshot-02-of-03.png' });
    const files = makeFiles(BASE).map((f) => ({ ...f, blob: blob(10) }));
    const progress = { written: 0 };
    await assert.rejects(writeFiles(root, files, progress), /disk full/);
    assert.equal(progress.written, 2, 'the full image and the first screenshot');
    const done = { written: 0 };
    assert.equal(await writeFiles(makeDir(), files, done), 4);
    assert.equal(done.written, 4);
  });

  it('pickFreeBase keeps the wanted name when nothing of this capture exists', async () => {
    const root = makeDir();
    await root.getFileHandle('other.png', { create: true });
    assert.equal(await pickFreeBase(root, BASE, makeFiles), BASE);
  });

  it('pickFreeBase adds a number when the full image exists', async () => {
    const root = makeDir();
    root.files.set(`${BASE}.png`, blob(1));
    assert.equal(await pickFreeBase(root, BASE, makeFiles), `${BASE} (2)`);
  });

  it('pickFreeBase adds a number when the tiles folder exists', async () => {
    const root = makeDir();
    const tiles = makeDir('Spool for AI');
    tiles.dirs.set(BASE, makeDir(BASE));
    root.dirs.set('Spool for AI', tiles);
    assert.equal(await pickFreeBase(root, BASE, makeFiles), `${BASE} (2)`);
  });

  it('pickFreeBase goes on past (2) and (3)', async () => {
    const root = makeDir();
    root.files.set(`${BASE}.png`, blob(1));
    root.files.set(`${BASE} (2).png`, blob(1));
    root.files.set(`${BASE} (3).png`, blob(1));
    assert.equal(await pickFreeBase(root, BASE, makeFiles), `${BASE} (4)`);
  });

  it('pickFreeBase treats a folder where a file goes as taken', async () => {
    const root = makeDir();
    root.dirs.set(`${BASE}.png`, makeDir());
    assert.equal(await pickFreeBase(root, BASE, makeFiles), `${BASE} (2)`);
  });

  it('pickFreeBase checks only what this capture writes (tiles only: the flat name is free)', async () => {
    const root = makeDir();
    root.files.set(`${BASE}.png`, blob(1));
    const tilesOnly = (/** @type {string} */ base) =>
      captureFiles({ base, tileCount: 3, saveTiles: true, saveFull: false });
    assert.equal(await pickFreeBase(root, BASE, tilesOnly), BASE);
  });

  it('pickFreeBase gives up after 100 names', async () => {
    const root = makeDir();
    root.files.set(`${BASE}.png`, blob(1));
    for (let n = 2; n <= 100; n++) root.files.set(`${BASE} (${n}).png`, blob(1));
    await assert.rejects(pickFreeBase(root, BASE, makeFiles), /No free name/);
  });

  it('isAccessError knows the two errors that mean no write access', () => {
    assert.equal(isAccessError(new DOMException('x', 'NotAllowedError')), true);
    assert.equal(isAccessError(new DOMException('x', 'SecurityError')), true);
    assert.equal(isAccessError(new DOMException('x', 'NotFoundError')), false);
    assert.equal(isAccessError(new Error('x')), false);
    assert.equal(isAccessError(null), false);
  });

  it('isMissingError knows NotFoundError, and only that', () => {
    assert.equal(isMissingError(new DOMException('x', 'NotFoundError')), true);
    assert.equal(isMissingError(new DOMException('x', 'NotAllowedError')), false);
    assert.equal(isMissingError(new Error('x')), false);
    assert.equal(isMissingError(undefined), false);
  });
});

// ---------------------------------------------------------------------------------------------
// Saver
// ---------------------------------------------------------------------------------------------

/**
 * @param {{
 *   folder?: any,
 *   subPath?: string[],
 *   permission?: 'granted' | 'prompt' | 'denied',
 *   storeFails?: boolean,
 *   permissionFails?: boolean,
 *   downloads?: (files: { path: string, url: string }[], call: number) => any,
 * }} [o]
 */
function makeSaver(o = {}) {
  /** @type {{ path: string, url: string }[][]} */
  const downloadCalls = [];
  /** @type {string[]} */
  const revoked = [];
  /** @type {Blob[]} */
  const urlBlobs = [];
  const saver = createSaver({
    folderStore: {
      async getSaveTarget() {
        if (o.storeFails) throw new Error('IndexedDB failed');
        return o.folder ? { handle: o.folder, subPath: o.subPath ?? [] } : null;
      },
      async folderPermission() {
        if (o.permissionFails) throw new Error('no state');
        return o.permission ?? 'granted';
      },
    },
    async requestDownloads(files) {
      downloadCalls.push(files);
      const custom = o.downloads?.(files, downloadCalls.length - 1);
      return custom ?? { saved: files.length, rejected: 0, interrupted: 0 };
    },
    makeUrl: (b) => {
      urlBlobs.push(b);
      return `blob:chrome-extension://x/${urlBlobs.length}`;
    },
    revokeUrl: (url) => {
      revoked.push(url);
    },
  });
  return { saver, downloadCalls, revoked, urlBlobs };
}

/** @param {Partial<Parameters<ReturnType<typeof createSaver>['save']>[0]>} [over] */
function request(over = {}) {
  const full = blob(100);
  return {
    date: DATE,
    title: 'Inbox - Mail',
    tileCount: 3,
    tiles: [blob(11), blob(12), blob(13)],
    full,
    saveTiles: true,
    saveFull: true,
    folderName: 'Spool',
    ...over,
  };
}

describe('saver: the chosen folder', () => {
  it('writes the files into a granted folder and says so', async () => {
    const folder = makeDir('Screenshots');
    const { saver, downloadCalls } = makeSaver({ folder });
    const req = request();
    const { save, warnings } = await saver.save(req);
    assert.deepEqual(save, { location: 'folder', label: 'Screenshots', files: 4, needsPermission: false });
    assert.deepEqual(warnings, []);
    assert.deepEqual(listFiles(folder), [
      `${BASE}.png`,
      `Spool for AI/${BASE}/screenshot-01-of-03.png`,
      `Spool for AI/${BASE}/screenshot-02-of-03.png`,
      `Spool for AI/${BASE}/screenshot-03-of-03.png`,
    ]);
    assert.equal(folder.files.get(`${BASE}.png`), req.full);
    assert.equal(downloadCalls.length, 0, 'no download');
  });

  it('uses the layout of captureBaseName and captureFiles', async () => {
    const folder = makeDir();
    const { saver } = makeSaver({ folder });
    await saver.save(request({ title: 'a.exe' }));
    assert.ok(folder.files.has(`${captureBaseName(DATE, 'a.exe')}.png`));
  });

  it('respects saveFull and saveTiles', async () => {
    for (const [saveFull, saveTiles, expected] of /** @type {const} */ ([
      [true, false, 1],
      [false, true, 3],
      [true, true, 4],
    ])) {
      const folder = makeDir();
      const { saver } = makeSaver({ folder });
      const { save } = await saver.save(request({ saveFull, saveTiles }));
      assert.equal(save.files, expected, `full ${saveFull} tiles ${saveTiles}`);
      assert.equal(listFiles(folder).length, expected);
    }
  });

  it('writes one flat file for one tile, and never both the tile and the full image', async () => {
    const folder = makeDir();
    const { saver } = makeSaver({ folder });
    const one = blob(5);
    const { save } = await saver.save(request({ tileCount: 1, tiles: [one], full: one }));
    assert.equal(save.files, 1);
    assert.deepEqual(listFiles(folder), [`${BASE}.png`]);
    // Only tiles on: the tile is the flat file.
    const folder2 = makeDir();
    const tile = blob(6);
    await makeSaver({ folder: folder2 }).saver.save(
      request({ tileCount: 1, tiles: [tile], full: blob(9), saveFull: false }),
    );
    assert.equal(folder2.files.get(`${BASE}.png`), tile);
  });

  it('does not replace a file that exists: it adds a number', async () => {
    const folder = makeDir();
    const old = blob(1);
    folder.files.set(`${BASE}.png`, old);
    const { saver } = makeSaver({ folder });
    await saver.save(request());
    assert.equal(folder.files.get(`${BASE}.png`), old);
    assert.ok(folder.files.has(`${BASE} (2).png`));
    assert.ok(folder.dirs.get('Spool for AI').dirs.has(`${BASE} (2)`));
  });

  it('leaves the title out of the name when the title is empty', async () => {
    const folder = makeDir();
    await makeSaver({ folder }).saver.save(request({ title: '' }));
    assert.ok(folder.files.has('Spool 2026-11-06 15.22.48.png'));
  });
});

describe('saver: a folder below the folder that the user picked', () => {
  it('writes below the sub folder, makes it, and labels it with both names', async () => {
    const pictures = makeDir('Pictures');
    const { saver, downloadCalls } = makeSaver({ folder: pictures, subPath: ['Screenshots'] });
    const req = request();
    const { save, warnings } = await saver.save(req);
    assert.deepEqual(save, {
      location: 'folder',
      label: 'Pictures/Screenshots',
      files: 4,
      needsPermission: false,
    });
    assert.deepEqual(warnings, []);
    assert.deepEqual(listFiles(pictures), [
      `Screenshots/${BASE}.png`,
      `Screenshots/Spool for AI/${BASE}/screenshot-01-of-03.png`,
      `Screenshots/Spool for AI/${BASE}/screenshot-02-of-03.png`,
      `Screenshots/Spool for AI/${BASE}/screenshot-03-of-03.png`,
    ]);
    assert.equal(pictures.dirs.get('Screenshots').files.get(`${BASE}.png`), req.full);
    assert.equal(downloadCalls.length, 0);
  });

  it('makes a deleted sub folder again, so the next save works', async () => {
    const pictures = makeDir('Pictures');
    const { saver } = makeSaver({ folder: pictures, subPath: ['Screenshots'] });
    await saver.save(request());
    pictures.dirs.delete('Screenshots'); // The user deleted it.
    const { save } = await saver.save(request());
    assert.equal(save.location, 'folder');
    assert.equal(save.files, 4);
    assert.ok(pictures.dirs.get('Screenshots').files.has(`${BASE}.png`));
  });

  it('puts the files in the folder itself when it has no sub folder (version 1.0.0)', async () => {
    const folder = makeDir('Screenshots');
    const { saver } = makeSaver({ folder, subPath: [] });
    const { save } = await saver.save(request());
    assert.equal(save.label, 'Screenshots');
    assert.ok(folder.files.has(`${BASE}.png`));
    assert.equal(folder.dirs.size, 1, 'only the folder of the AI screenshots');
  });

  it('goes to Downloads and asks to reconnect when access is not granted', async () => {
    for (const permission of /** @type {const} */ (['prompt', 'denied'])) {
      const pictures = makeDir('Pictures');
      const { saver, downloadCalls } = makeSaver({
        folder: pictures,
        subPath: ['Screenshots'],
        permission,
      });
      const { save } = await saver.save(request());
      assert.equal(save.location, 'downloads', permission);
      assert.equal(save.needsPermission, true, permission);
      assert.equal(save.folderLabel, 'Pictures/Screenshots', permission);
      assert.equal(pictures.dirs.size, 0, 'nothing is made without access');
      assert.equal(downloadCalls.length, 1);
    }
  });

  it('goes to Downloads and asks to reconnect when the picked folder is gone', async () => {
    const pictures = makeDir('Pictures', { missing: true });
    const { saver, downloadCalls } = makeSaver({ folder: pictures, subPath: ['Screenshots'] });
    const { save, warnings } = await saver.save(request());
    assert.equal(save.location, 'downloads');
    assert.equal(save.needsPermission, true, 'the toast offers Reconnect, and Reconnect says it is gone');
    assert.equal(save.folderLabel, 'Pictures/Screenshots');
    assert.deepEqual(warnings, ['Could not write to the chosen folder. Saved to Downloads instead.']);
    assert.equal(downloadCalls.length, 1);
  });

  it('also finds a gone folder that has no sub folder (version 1.0.0)', async () => {
    const gone = makeDir('Screenshots', { missing: true });
    const { save } = await makeSaver({ folder: gone, subPath: [] }).saver.save(request());
    assert.equal(save.location, 'downloads');
    assert.equal(save.needsPermission, true);
  });

  it('does not ask to reconnect for a write error that is not about access', async () => {
    const pictures = makeDir('Pictures', { failWriteOf: `${BASE}.png` });
    const { save } = await makeSaver({ folder: pictures, subPath: ['Screenshots'] }).saver.save(
      request(),
    );
    assert.equal(save.location, 'downloads');
    assert.equal(save.needsPermission, false);
    assert.equal(save.folderLabel, undefined);
  });
});

describe('saver: downloads', () => {
  it('downloads under Downloads/<folderName> when no folder is chosen', async () => {
    const { saver, downloadCalls, urlBlobs } = makeSaver();
    const req = request();
    const { save, warnings } = await saver.save(req);
    assert.deepEqual(save, { location: 'downloads', label: 'Downloads/Spool', files: 4, needsPermission: false });
    assert.deepEqual(warnings, []);
    assert.deepEqual(
      downloadCalls[0]?.map((f) => f.path),
      [
        `Spool/${BASE}.png`,
        `Spool/Spool for AI/${BASE}/screenshot-01-of-03.png`,
        `Spool/Spool for AI/${BASE}/screenshot-02-of-03.png`,
        `Spool/Spool for AI/${BASE}/screenshot-03-of-03.png`,
      ],
    );
    assert.equal(urlBlobs[0], req.full, 'the URL is made from the Blob of the file');
    assert.equal(urlBlobs[1], req.tiles[0]);
  });

  it('uses the folder name of the settings', async () => {
    const { saver, downloadCalls } = makeSaver();
    const { save } = await saver.save(request({ folderName: 'Shots' }));
    assert.equal(save.label, 'Downloads/Shots');
    assert.ok(downloadCalls[0]?.every((f) => f.path.startsWith('Shots/')));
  });

  it('revokes every blob URL after the service worker replied, also when it fails', async () => {
    const ok = makeSaver();
    await ok.saver.save(request());
    assert.equal(ok.revoked.length, 4);

    const failing = createSaver({
      folderStore: { getSaveTarget: async () => null, folderPermission: async () => 'denied' },
      requestDownloads: async () => {
        throw new Error('the worker is gone');
      },
      makeUrl: () => 'blob:chrome-extension://x/1',
      revokeUrl: (url) => revoked.push(url),
    });
    /** @type {string[]} */
    const revoked = [];
    const { save } = await failing.save(request());
    assert.equal(revoked.length, 4);
    assert.deepEqual(save, {
      location: 'none',
      label: 'Not saved',
      files: 0,
      needsPermission: false,
      error: 'Could not save the files.',
    });
  });

  it('falls back to downloads and asks for access when the folder is not granted', async () => {
    for (const permission of /** @type {const} */ (['prompt', 'denied'])) {
      const folder = makeDir();
      const { saver, downloadCalls } = makeSaver({ folder, permission });
      const { save, warnings } = await saver.save(request());
      assert.equal(save.location, 'downloads', permission);
      assert.equal(save.needsPermission, true, permission);
      assert.equal(save.folderLabel, 'Screenshots', 'the toast names the folder to reconnect');
      assert.deepEqual(warnings, []);
      assert.equal(downloadCalls.length, 1);
      assert.deepEqual(listFiles(folder), [], 'nothing written without access');
    }
  });

  it('treats a permission state that cannot be read as denied', async () => {
    const { saver } = makeSaver({ folder: makeDir(), permissionFails: true });
    const { save } = await saver.save(request());
    assert.equal(save.location, 'downloads');
    assert.equal(save.needsPermission, true);
  });

  it('treats a store that cannot be read as "no folder chosen"', async () => {
    const { saver } = makeSaver({ storeFails: true });
    const { save } = await saver.save(request());
    assert.equal(save.location, 'downloads');
    assert.equal(save.needsPermission, false);
  });

  it('falls back to downloads with a warning when a write in the folder fails', async () => {
    const folder = makeDir('Screenshots', { failWriteOf: `${BASE}.png` });
    const { saver, downloadCalls } = makeSaver({ folder });
    const { save, warnings } = await saver.save(request());
    assert.equal(save.location, 'downloads');
    assert.equal(save.needsPermission, false, 'not an access problem');
    assert.deepEqual(warnings, ['Could not write to the chosen folder. Saved to Downloads instead.']);
    assert.equal(downloadCalls.length, 1);
  });

  it('says how many files stay in the folder when the write stops half way', async () => {
    // The full image and the first screenshot are written, the second one fails.
    const folder = makeDir('Screenshots', { failWriteOf: 'screenshot-02-of-03.png' });
    const { saver, downloadCalls } = makeSaver({ folder });
    const { save, warnings } = await saver.save(request());
    assert.equal(save.location, 'downloads');
    assert.equal(save.files, 4, 'the whole set went to Downloads');
    assert.deepEqual(warnings, [
      'Writing to Screenshots stopped after 2 of 4 files. They stay there. ' +
        'All files went to Downloads instead.',
    ]);
    assert.equal(downloadCalls.length, 1);
    assert.deepEqual(listFiles(folder), [
      `${BASE}.png`,
      `Spool for AI/${BASE}/screenshot-01-of-03.png`,
    ]);
  });

  it('does not promise Downloads when Downloads fails too', async () => {
    const folder = makeDir('Screenshots', { failWriteOf: 'screenshot-02-of-03.png' });
    const { saver } = makeSaver({
      folder,
      downloads: (files) => ({ saved: 0, rejected: 0, interrupted: files.length }),
    });
    const { save, warnings } = await saver.save(request());
    assert.equal(save.location, 'none');
    assert.deepEqual(warnings, ['Writing to Screenshots stopped after 2 of 4 files. They stay there.']);
    const noneAtAll = makeSaver({
      folder: makeDir('Screenshots', { failWriteOf: `${BASE}.png` }),
      downloads: (files) => ({ saved: 0, rejected: 0, interrupted: files.length }),
    });
    assert.deepEqual((await noneAtAll.saver.save(request())).warnings, [
      'Could not write to the chosen folder.',
    ]);
  });

  it('asks for access when the folder refuses the write with NotAllowedError', async () => {
    const folder = makeDir('Screenshots', { denyWrites: true });
    const { saver } = makeSaver({ folder });
    const { save, warnings } = await saver.save(request());
    assert.equal(save.location, 'downloads');
    assert.equal(save.needsPermission, true);
    assert.equal(warnings.length, 1);
  });

  it('tries the whole set again without the title when Chrome refuses the first names', async () => {
    const { saver, downloadCalls } = makeSaver({
      downloads: (files, call) =>
        call === 0
          ? { saved: 0, rejected: files.length, interrupted: 0 }
          : { saved: files.length, rejected: 0, interrupted: 0 },
    });
    const { save } = await saver.save(request());
    assert.equal(downloadCalls.length, 2);
    assert.ok(downloadCalls[0]?.[0]?.path.includes('Inbox - Mail'));
    assert.ok(!downloadCalls[1]?.[0]?.path.includes('Inbox'));
    assert.equal(downloadCalls[1]?.[0]?.path, 'Spool/Spool 2026-11-06 15.22.48.png');
    assert.equal(save.location, 'downloads');
    assert.equal(save.files, 4);
    assert.equal(save.error, undefined);
  });

  it('does not try again when the name has no title anyway', async () => {
    const { saver, downloadCalls } = makeSaver({
      downloads: (files) => ({ saved: 0, rejected: files.length, interrupted: 0 }),
    });
    const { save } = await saver.save(request({ title: '' }));
    assert.equal(downloadCalls.length, 1);
    assert.equal(save.location, 'none');
    assert.equal(save.error, 'Could not save the files.');
  });

  it('does not try again for a download that started and was interrupted', async () => {
    const { saver, downloadCalls } = makeSaver({
      downloads: () => ({ saved: 0, rejected: 0, interrupted: 4 }),
    });
    const { save } = await saver.save(request());
    assert.equal(downloadCalls.length, 1);
    assert.equal(save.location, 'none');
  });

  it('reports some files as saved when not all of them were', async () => {
    const { saver } = makeSaver({ downloads: () => ({ saved: 3, rejected: 0, interrupted: 1 }) });
    const { save } = await saver.save(request());
    // `failed` lets the toast say "1 of 4 files didn't save".
    assert.deepEqual(save, {
      location: 'downloads',
      label: 'Downloads/Spool',
      files: 3,
      needsPermission: false,
      failed: 1,
      error: 'Some files could not be saved.',
    });
  });
});

describe('saver: nothing to save', () => {
  it('says "none" when both settings are off, and touches nothing', async () => {
    const folder = makeDir();
    const { saver, downloadCalls } = makeSaver({ folder });
    const { save } = await saver.save(request({ saveFull: false, saveTiles: false }));
    assert.deepEqual(save, { location: 'none', label: 'Not saved', files: 0, needsPermission: false });
    assert.deepEqual(listFiles(folder), []);
    assert.equal(downloadCalls.length, 0);
  });

  it('leaves out the full image when it was not built, and saves the tiles', async () => {
    const { saver, downloadCalls } = makeSaver();
    const { save } = await saver.save(request({ full: null }));
    assert.equal(save.files, 3);
    assert.ok(downloadCalls[0]?.every((f) => f.path.includes('screenshot-')));
  });

  it('says "none" when only the full image was asked for and it was not built', async () => {
    const { saver } = makeSaver();
    const { save } = await saver.save(request({ full: null, saveTiles: false }));
    assert.equal(save.location, 'none');
    assert.equal(save.error, undefined);
  });
});
