// @ts-check
/**
 * Names of a finished capture (docs/contracts.md 7.3): captureStamp, captureBaseName and
 * captureFiles in src/lib/names.js.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  CAPTURE_PREFIX,
  CAPTURE_TITLE_MAX_LENGTH,
  TILES_FOLDER_NAME,
  captureBaseName,
  captureFiles,
  captureStamp,
  sanitizePathSegment,
} from '../../src/lib/names.js';
import { isDownloadPath } from '../../src/shared/protocol.js';

const DATE = new Date(2026, 10, 6, 15, 2, 3);

describe('captureStamp', () => {
  it('is local time as YYYY-MM-DD HH.mm.ss, with no colon', () => {
    assert.equal(captureStamp(DATE), '2026-11-06 15.02.03');
    assert.equal(captureStamp(new Date(2026, 0, 1, 0, 0, 0)), '2026-01-01 00.00.00');
    assert.equal(captureStamp(new Date(2026, 11, 31, 23, 59, 59)), '2026-12-31 23.59.59');
    assert.ok(!captureStamp(DATE).includes(':'));
  });
});

describe('captureBaseName', () => {
  it('is "Spool <stamp> <title>"', () => {
    assert.equal(captureBaseName(DATE, 'Inbox - Mail'), 'Spool 2026-11-06 15.02.03 Inbox - Mail');
    assert.equal(CAPTURE_PREFIX, 'Spool');
  });

  it('leaves out the title when it is empty or has nothing usable', () => {
    for (const title of ['', '   ', '***', '...', '///', 'con', undefined, null, 5]) {
      assert.equal(captureBaseName(DATE, title), 'Spool 2026-11-06 15.02.03', String(title));
    }
  });

  it('cuts the title at 48 characters (code points), never in the middle of an emoji', () => {
    assert.equal(CAPTURE_TITLE_MAX_LENGTH, 48);
    const long = captureBaseName(DATE, 'x'.repeat(100));
    assert.equal(long, `Spool 2026-11-06 15.02.03 ${'x'.repeat(48)}`);
    const emoji = captureBaseName(DATE, '😀'.repeat(60));
    assert.equal(emoji, `Spool 2026-11-06 15.02.03 ${'😀'.repeat(48)}`);
  });

  it('removes what a file name cannot hold', () => {
    assert.equal(
      captureBaseName(DATE, 'a/b\\c:d*e?f"g<h>i|j'),
      'Spool 2026-11-06 15.02.03 a b c d e f g h i j',
    );
    assert.equal(captureBaseName(DATE, 'tab\there\nnewline'), 'Spool 2026-11-06 15.02.03 tab here newline');
    assert.equal(captureBaseName(DATE, 'PROGRA~1'), 'Spool 2026-11-06 15.02.03 PROGRA-1');
  });

  it('neutralizes a dangerous extension at the end of the title', () => {
    assert.equal(captureBaseName(DATE, 'setup.exe'), 'Spool 2026-11-06 15.02.03 setup_exe');
    assert.equal(captureBaseName(DATE, 'a.lnk'), 'Spool 2026-11-06 15.02.03 a_lnk');
  });

  it('is one clean path segment for any title, so it is also clean as a download path', () => {
    const titles = [
      'Inbox - Mail',
      '  spaces  ',
      'ends with dot.',
      '. leading',
      'Ünï çödé 日本語 😀',
      'a‮b‍c',
      'x'.repeat(500),
      'CON',
      'lpt1.txt',
      '{abc}.{def}',
    ];
    for (const title of titles) {
      const base = captureBaseName(DATE, title);
      assert.equal(sanitizePathSegment(base, 255, ''), base, `base of ${JSON.stringify(title)}`);
      assert.ok(isDownloadPath(`Spool/${base}.png`), `path of ${JSON.stringify(title)}`);
      assert.ok(isDownloadPath(`Spool/${TILES_FOLDER_NAME}/${base}/screenshot-01-of-02.png`));
    }
  });
});

describe('captureFiles', () => {
  const BASE = 'Spool 2026-11-06 15.02.03 Page';

  it('puts the full image flat and the tiles in "Spool for AI/<base>/"', () => {
    assert.deepEqual(captureFiles({ base: BASE, tileCount: 3, saveTiles: true, saveFull: true }), [
      { kind: 'full', path: [`${BASE}.png`] },
      { kind: 'tile', index: 0, path: ['Spool for AI', BASE, 'screenshot-01-of-03.png'] },
      { kind: 'tile', index: 1, path: ['Spool for AI', BASE, 'screenshot-02-of-03.png'] },
      { kind: 'tile', index: 2, path: ['Spool for AI', BASE, 'screenshot-03-of-03.png'] },
    ]);
    assert.equal(TILES_FOLDER_NAME, 'Spool for AI');
  });

  it('respects saveFull and saveTiles for several tiles', () => {
    const only = (/** @type {boolean} */ saveTiles, /** @type {boolean} */ saveFull) =>
      captureFiles({ base: BASE, tileCount: 2, saveTiles, saveFull }).map((f) => f.kind);
    assert.deepEqual(only(true, false), ['tile', 'tile']);
    assert.deepEqual(only(false, true), ['full']);
    assert.deepEqual(only(false, false), []);
  });

  it('one tile: one flat file, the full image or else the tile, never both', () => {
    assert.deepEqual(captureFiles({ base: BASE, tileCount: 1, saveTiles: true, saveFull: true }), [
      { kind: 'full', path: [`${BASE}.png`] },
    ]);
    assert.deepEqual(captureFiles({ base: BASE, tileCount: 1, saveTiles: false, saveFull: true }), [
      { kind: 'full', path: [`${BASE}.png`] },
    ]);
    assert.deepEqual(captureFiles({ base: BASE, tileCount: 1, saveTiles: true, saveFull: false }), [
      { kind: 'tile', index: 0, path: [`${BASE}.png`] },
    ]);
    assert.deepEqual(captureFiles({ base: BASE, tileCount: 1, saveTiles: false, saveFull: false }), []);
  });

  it('one scaled tile is not the full image: both are saved, the tile in its folder', () => {
    const input = { base: BASE, tileCount: 1, fitsOneImage: false };
    assert.deepEqual(captureFiles({ ...input, saveTiles: true, saveFull: true }), [
      { kind: 'full', path: [`${BASE}.png`] },
      { kind: 'tile', index: 0, path: ['Spool for AI', BASE, 'screenshot-01-of-01.png'] },
    ]);
    assert.deepEqual(captureFiles({ ...input, saveTiles: true, saveFull: false }), [
      { kind: 'tile', index: 0, path: ['Spool for AI', BASE, 'screenshot-01-of-01.png'] },
    ]);
    assert.deepEqual(captureFiles({ ...input, saveTiles: false, saveFull: true }), [
      { kind: 'full', path: [`${BASE}.png`] },
    ]);
  });

  it('widens the numbers of the tile names with the count', () => {
    const files = captureFiles({ base: BASE, tileCount: 120, saveTiles: true, saveFull: false });
    assert.equal(files.length, 120);
    assert.equal(files[0]?.path[2], 'screenshot-001-of-120.png');
    assert.equal(files[119]?.path[2], 'screenshot-120-of-120.png');
  });

  it('gives only clean download paths', () => {
    for (const file of captureFiles({ base: BASE, tileCount: 5, saveTiles: true, saveFull: true })) {
      assert.ok(isDownloadPath(['Spool', ...file.path].join('/')), file.path.join('/'));
    }
  });

  it('refuses bad arguments', () => {
    assert.throws(() => captureFiles({ base: '', tileCount: 1, saveTiles: true, saveFull: true }), TypeError);
    assert.throws(
      () => captureFiles({ base: /** @type {any} */ (5), tileCount: 1, saveTiles: true, saveFull: true }),
      TypeError,
    );
    for (const tileCount of [0, -1, 1.5, NaN]) {
      assert.throws(
        () => captureFiles({ base: BASE, tileCount, saveTiles: true, saveFull: true }),
        RangeError,
        String(tileCount),
      );
    }
  });
});

describe('sanitizePathSegment is idempotent', () => {
  /** @param {string} s @param {number} [max] */
  const once = (s, max = 120) => sanitizePathSegment(s, max, 'Spool');

  it('a title with several dots does not change on a second pass: a.{b}.{c}', () => {
    const first = once('a.{b}.{c}');
    assert.equal(first, 'a_{b}_{c}');
    assert.equal(once(first), first);
  });

  it('each dot that exposes a dangerous extension is fixed, however many there are', () => {
    assert.equal(once('a.{b}.{c}.{d}.{e}'), 'a_{b}_{c}_{d}_{e}');
    assert.equal(once('a.exe.lnk'), 'a.exe_lnk');
    assert.equal(once('x.{b}.exe'), 'x.{b}_exe');
    assert.equal(once(once('x.{b}.exe')), once('x.{b}.exe'));
    // Names that are fine stay as they are.
    assert.equal(once('v1.2.3'), 'v1.2.3');
    assert.equal(once('my.report.pdf'), 'my.report.pdf');
  });

  it('the file names of a capture whose title is a.{b}.{c} are clean download paths', () => {
    const base = captureBaseName(DATE, 'a.{b}.{c}');
    assert.equal(base, 'Spool 2026-11-06 15.02.03 a_{b}_{c}');
    assert.equal(sanitizePathSegment(base, 120, ''), base);
    for (const tileCount of [1, 5]) {
      for (const file of captureFiles({ base, tileCount, saveTiles: true, saveFull: true })) {
        assert.ok(isDownloadPath(['Spool', ...file.path].join('/')), file.path.join('/'));
      }
    }
  });

  it('property: sanitizing twice gives the same name, and a capture name is always clean', () => {
    // A fixed generator: a failure repeats, and the case that fails is in the message.
    let seed = 12345;
    const random = () => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const pieces = [
      'a', 'b', 'x', '.', '.', '{', '}', '{b}', '{c}', '_', 'exe', 'lnk', 'Con', ' ', '~', '/',
      '😀', 'txt', 'COM1', 'nul', ':', '\u200d', 'ü', '1', 'url', 'js',
    ];
    for (let i = 0; i < 30_000; i += 1) {
      let text = '';
      for (let n = 1 + Math.floor(random() * 14); n > 0; n -= 1) {
        text += pieces[Math.floor(random() * pieces.length)];
      }
      for (const max of [8, 40, 48, 120]) {
        const first = sanitizePathSegment(text, max, 'Spool');
        assert.equal(sanitizePathSegment(first, max, 'Spool'), first, `${JSON.stringify(text)} at ${max}`);
      }
      const base = captureBaseName(DATE, text);
      for (const file of captureFiles({ base, tileCount: 3, saveTiles: true, saveFull: true })) {
        assert.ok(
          isDownloadPath(['Spool', ...file.path].join('/')),
          `${JSON.stringify(text)}: ${file.path.join('/')}`,
        );
      }
    }
  });
});
