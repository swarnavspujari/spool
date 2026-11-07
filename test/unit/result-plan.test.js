// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION_PX,
  MAX_IMAGES_PER_MESSAGE,
} from '../../src/shared/constants.js';
import { captureBaseName, tileFileName } from '../../src/lib/names.js';
import { planTiles } from '../../src/lib/tiles.js';
import {
  base64ToBytes,
  createAsyncLru,
  outputWarnings,
  planRowChunks,
} from '../../src/render/util.js';
import {
  base64ToBlob,
  formatBytes,
  formatDateTime,
  formatDimensions,
  formatInt,
  plural,
  saveAllHint,
  saveInfoLine,
  savedLine,
  savePlan,
  stackLayout,
  startDownload,
  summaryLine,
  tileLabelParts,
} from '../../src/result/save-plan.js';

const DATE = new Date(2026, 10, 6, 14, 30, 5);
const BASE = captureBaseName(DATE, 'Inbox: Mail');
/** The same capture with a base name that has no page title. */
const BASE_NO_TITLE = captureBaseName(DATE, '');
const ROOT = 'Spool';

// ---------------------------------------------------------------------------------------------
// savePlan (the layout of docs/contracts.md section 7.3)
// ---------------------------------------------------------------------------------------------

test('savePlan: the base name is Spool, the time and the title', () => {
  assert.equal(BASE, 'Spool 2026-11-06 14.30.05 Inbox Mail');
  assert.equal(BASE_NO_TITLE, 'Spool 2026-11-06 14.30.05');
});

test('savePlan: tiles only go in the tile folder of the capture', () => {
  const plan = savePlan({ root: ROOT, base: BASE, tileCount: 3, includeTiles: true, includeFull: false });
  assert.deepEqual(plan, [
    { kind: 'tile', index: 0, filename: `Spool/Spool for AI/${BASE}/screenshot-01-of-03.png` },
    { kind: 'tile', index: 1, filename: `Spool/Spool for AI/${BASE}/screenshot-02-of-03.png` },
    { kind: 'tile', index: 2, filename: `Spool/Spool for AI/${BASE}/screenshot-03-of-03.png` },
  ]);
});

test('savePlan: the full image is one flat file', () => {
  const plan = savePlan({ root: ROOT, base: BASE, tileCount: 3, includeTiles: false, includeFull: true });
  assert.deepEqual(plan, [{ kind: 'full', filename: `Spool/${BASE}.png` }]);
  assert.ok(!('index' in /** @type {object} */ (plan[0])));
});

test('savePlan: both lists the full image first, then the tiles', () => {
  const plan = savePlan({ root: ROOT, base: BASE, tileCount: 2, includeTiles: true, includeFull: true });
  assert.deepEqual(
    plan.map((item) => item.kind),
    ['full', 'tile', 'tile'],
  );
  assert.equal(plan[0]?.filename, `Spool/${BASE}.png`);
});

test('savePlan: one tile that fits is one flat file, and never both', () => {
  const both = savePlan({ root: ROOT, base: BASE, tileCount: 1, includeTiles: true, includeFull: true });
  assert.deepEqual(both, [{ kind: 'full', filename: `Spool/${BASE}.png` }]);
  const tileOnly = savePlan({ root: ROOT, base: BASE, tileCount: 1, includeTiles: true, includeFull: false });
  assert.deepEqual(tileOnly, [{ kind: 'tile', index: 0, filename: `Spool/${BASE}.png` }]);
});

test('savePlan: nothing selected gives an empty list', () => {
  assert.deepEqual(
    savePlan({ root: ROOT, base: BASE, tileCount: 5, includeTiles: false, includeFull: false }),
    [],
  );
});

test('savePlan: file names match names.js, including the wider number format', () => {
  for (const count of [2, 9, 12, 99, 100, 120]) {
    const plan = savePlan({ root: ROOT, base: BASE, tileCount: count, includeTiles: true, includeFull: false });
    assert.equal(plan.length, count);
    plan.forEach((item, i) => {
      assert.equal(item.kind, 'tile');
      assert.equal(item.index, i);
      assert.equal(item.filename, `Spool/Spool for AI/${BASE}/${tileFileName(i, count)}`);
    });
  }
  const wide = savePlan({ root: ROOT, base: BASE, tileCount: 100, includeTiles: true, includeFull: false });
  assert.match(wide[0]?.filename ?? '', /\/screenshot-001-of-100\.png$/);
  assert.match(wide[99]?.filename ?? '', /\/screenshot-100-of-100\.png$/);
});

test('savePlan: the page picks one tile for the Save button of that tile', () => {
  const all = savePlan({ root: ROOT, base: BASE, tileCount: 4, includeTiles: true, includeFull: false });
  const one = all.filter((item) => item.index === 2);
  assert.deepEqual(one, [{ kind: 'tile', index: 2, filename: `Spool/Spool for AI/${BASE}/screenshot-03-of-04.png` }]);
});

test('savePlan: an empty root gives paths without the root folder', () => {
  const plan = savePlan({ root: '', base: BASE, tileCount: 2, includeTiles: true, includeFull: true });
  assert.equal(plan[0]?.filename, `${BASE}.png`);
  assert.equal(plan[1]?.filename, `Spool for AI/${BASE}/screenshot-01-of-02.png`);
});

test('savePlan: a bad base or tile count is refused', () => {
  assert.throws(() => savePlan({ root: ROOT, base: '', tileCount: 2, includeTiles: true, includeFull: true }));
  assert.throws(() => savePlan({ root: ROOT, base: BASE, tileCount: 0, includeTiles: true, includeFull: true }));
});

// ---------------------------------------------------------------------------------------------
// startDownload (one retry with a base name that has no page title)
// ---------------------------------------------------------------------------------------------

const PATH = `Spool/Spool for AI/${BASE}/screenshot-02-of-03.png`;
const FALLBACK = `Spool/Spool for AI/${BASE_NO_TITLE}/screenshot-02-of-03.png`;

/**
 * A fake for chrome.downloads.download. `refuse` tells which paths it rejects.
 * @param {(path: string) => boolean} refuse
 */
function fakeStart(refuse) {
  /** @type {string[]} */
  const calls = [];
  /** @param {string} path */
  const start = async (path) => {
    calls.push(path);
    if (refuse(path)) throw new Error(`Invalid filename: ${path}`);
    return 40 + calls.length;
  };
  return { start, calls };
}

test('startDownload: starts at the planned path when Chrome accepts it, with no retry', async () => {
  const { start, calls } = fakeStart(() => false);
  const result = await startDownload(start, PATH, FALLBACK);
  assert.deepEqual(result, { id: 41, filename: PATH, fellBack: false });
  assert.deepEqual(calls, [PATH]);
});

test('startDownload: retries once with the fallback path when the path is refused', async () => {
  const { start, calls } = fakeStart((path) => path.includes('Inbox'));
  const result = await startDownload(start, PATH, FALLBACK);
  assert.equal(result.id, 42);
  assert.equal(result.filename, FALLBACK);
  assert.equal(result.fellBack, true);
  assert.match(String(/** @type {Error} */ (result.firstError).message), /Invalid filename/);
  assert.deepEqual(calls, [PATH, FALLBACK]);
});

test('startDownload: the error of the retry goes to the caller when it fails too', async () => {
  const { start, calls } = fakeStart(() => true);
  await assert.rejects(
    startDownload(start, PATH, FALLBACK),
    (/** @type {Error} */ error) => error.message === `Invalid filename: ${FALLBACK}`,
  );
  assert.equal(calls.length, 2, 'one retry, not more');
});

test('startDownload: no second try when the fallback is the path that failed', async () => {
  const { start, calls } = fakeStart(() => true);
  await assert.rejects(
    startDownload(start, FALLBACK, FALLBACK),
    (/** @type {Error} */ error) => error.message === `Invalid filename: ${FALLBACK}`,
  );
  assert.deepEqual(calls, [FALLBACK]);
});

test('startDownload: the whole set can switch to the fallback, file by file', async () => {
  const { start, calls } = fakeStart((path) => path.includes('Inbox'));
  const planWith = (/** @type {string} */ base) =>
    savePlan({ root: ROOT, base, tileCount: 2, includeTiles: true, includeFull: true });
  let items = planWith(BASE);
  const fallbackItems = planWith(BASE_NO_TITLE);
  let base = BASE;
  for (let n = 0; n < items.length; n += 1) {
    const result = await startDownload(start, items[n]?.filename ?? '', fallbackItems[n]?.filename ?? '');
    if (result.fellBack && base === BASE) {
      base = BASE_NO_TITLE;
      items = planWith(base);
    }
  }
  // The first file was tried twice. The other two went straight to the fallback names.
  assert.deepEqual(calls, [
    `Spool/${BASE}.png`,
    `Spool/${BASE_NO_TITLE}.png`,
    `Spool/Spool for AI/${BASE_NO_TITLE}/screenshot-01-of-02.png`,
    `Spool/Spool for AI/${BASE_NO_TITLE}/screenshot-02-of-02.png`,
  ]);
});

test('startDownload: a path that the names filter produced is accepted as it is', async () => {
  const base = captureBaseName(DATE, 'Pipeline ~ Q4');
  assert.equal(base, 'Spool 2026-11-06 14.30.05 Pipeline - Q4');
  const { start, calls } = fakeStart((path) => path.includes('~'));
  const [item] = savePlan({ root: ROOT, base, tileCount: 1, includeTiles: false, includeFull: true });
  const result = await startDownload(start, item?.filename ?? '', `Spool/${BASE_NO_TITLE}.png`);
  assert.equal(result.fellBack, false);
  assert.equal(calls.length, 1);
});

test('saveAllHint: says what the planned files are', () => {
  const plan = (/** @type {number} */ tileCount, /** @type {boolean} */ includeTiles, /** @type {boolean} */ includeFull) =>
    savePlan({ root: ROOT, base: BASE, tileCount, includeTiles, includeFull });
  assert.equal(saveAllHint(plan(8, true, true)), 'Save all saves 8 screenshots and the full image.');
  assert.equal(saveAllHint(plan(8, true, false)), 'Save all saves 8 screenshots.');
  assert.equal(saveAllHint(plan(8, false, true)), 'Save all saves the full image.');
  assert.equal(saveAllHint(plan(1, true, false)), 'Save all saves 1 screenshot.');
  // One tile with both on: the full image is the same picture, so it is one file.
  assert.equal(saveAllHint(plan(1, true, true)), 'Save all saves the full image.');
  assert.match(saveAllHint(plan(8, false, false)), /nothing/);
  assert.match(saveAllHint([]), /nothing/);
});

// ---------------------------------------------------------------------------------------------
// outputWarnings (src/render/util.js: the warnings that the summary carries)
// ---------------------------------------------------------------------------------------------

const OK = { tileCount: 4, widthPx: 1500, heightPx: 6000, fullBytes: 1_000_000 };

test('outputWarnings: no warning for a normal capture', () => {
  assert.deepEqual(outputWarnings({ ...OK, manifestWarnings: [] }), []);
  assert.deepEqual(outputWarnings(OK), []);
});

test('outputWarnings: tile count boundary is exactly 20 versus 21', () => {
  assert.equal(MAX_IMAGES_PER_MESSAGE, 20);
  assert.deepEqual(outputWarnings({ ...OK, tileCount: 20 }), []);
  assert.deepEqual(outputWarnings({ ...OK, tileCount: 21 }), [
    'More than 20 screenshots. Send them in more than one message.',
  ]);
});

test('outputWarnings: image dimension boundary is 8000 versus 8001 px', () => {
  assert.equal(MAX_IMAGE_DIMENSION_PX, 8000);
  const tooLarge = 'The full image is too large for most chats. Use the AI screenshots.';
  assert.deepEqual(outputWarnings({ ...OK, heightPx: 8000 }), []);
  assert.deepEqual(outputWarnings({ ...OK, heightPx: 8001 }), [tooLarge]);
  assert.deepEqual(outputWarnings({ ...OK, widthPx: 8000 }), []);
  assert.deepEqual(outputWarnings({ ...OK, widthPx: 8001 }), [tooLarge]);
});

test('outputWarnings: byte boundary is exactly 10 MiB versus 10 MiB + 1', () => {
  assert.equal(MAX_IMAGE_BYTES, 10 * 1024 * 1024);
  const tooLarge = 'The full image is too large for most chats. Use the AI screenshots.';
  assert.deepEqual(outputWarnings({ ...OK, fullBytes: MAX_IMAGE_BYTES }), []);
  assert.deepEqual(outputWarnings({ ...OK, fullBytes: MAX_IMAGE_BYTES + 1 }), [tooLarge]);
});

test('outputWarnings: the too-large message appears once when every check fails', () => {
  const result = outputWarnings({
    ...OK,
    widthPx: 9000,
    heightPx: 20_000,
    fullBytes: MAX_IMAGE_BYTES * 3,
  });
  assert.equal(result.length, 1);
});

test('outputWarnings: order is tiles, full image, then manifest lines, cleaned and de-duplicated', () => {
  const result = outputWarnings({
    tileCount: 25,
    widthPx: 1500,
    heightPx: 30_000,
    fullBytes: 1,
    manifestWarnings: ['Part of the page changed.', '', '   ', 'A seam may be off.', 'A seam may be off.'],
  });
  assert.deepEqual(result, [
    'More than 20 screenshots. Send them in more than one message.',
    'The full image is too large for most chats. Use the AI screenshots.',
    'Part of the page changed.',
    'A seam may be off.',
  ]);
  assert.deepEqual(outputWarnings({ ...OK, manifestWarnings: null }), []);
});

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

test('formatInt: comma separators', () => {
  assert.equal(formatInt(0), '0');
  assert.equal(formatInt(999), '999');
  assert.equal(formatInt(1000), '1,000');
  assert.equal(formatInt(1500), '1,500');
  assert.equal(formatInt(18_240), '18,240');
  assert.equal(formatInt(1_234_567), '1,234,567');
  assert.equal(formatInt(2575.6), '2,576');
  assert.equal(formatInt(Number.NaN), '0');
});

test('formatDimensions and tileLabelParts', () => {
  assert.equal(formatDimensions(1500, 18_240), '1,500 × 18,240 px');
  assert.deepEqual(tileLabelParts(1, 5, 1500, 2576), {
    name: 'Screenshot 2 of 5',
    size: '1,500 × 2,576 px',
  });
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(-5), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1024), '1.0 KB');
  assert.equal(formatBytes(1536), '1.5 KB');
  assert.equal(formatBytes(MAX_IMAGE_BYTES), '10.0 MB');
  assert.equal(formatBytes(12.3 * 1024 * 1024), '12.3 MB');
  assert.equal(formatBytes(250 * 1024 * 1024), '250 MB');
  assert.equal(formatBytes(1024 * 1024 * 1024), '1.0 GB');
  assert.equal(formatBytes(1024 * 1024 - 1), '1.0 MB');
});

test('plural', () => {
  assert.equal(plural(1, 'tile'), '1 tile');
  assert.equal(plural(8, 'tile'), '8 tiles');
  assert.equal(plural(1200, 'file'), '1,200 files');
});

test('formatDateTime: one format in every locale, and nothing for a bad time', () => {
  // 2026-11-06 15:42 UTC is 10:42 in New York (UTC-5 in November).
  const ms = Date.UTC(2026, 10, 6, 15, 42);
  assert.equal(formatDateTime(ms, 'America/New_York'), 'Nov 6, 2026, 10:42 AM');
  assert.equal(formatDateTime(ms, 'UTC'), 'Nov 6, 2026, 3:42 PM');
  assert.equal(formatDateTime(Date.UTC(2026, 0, 2, 0, 5), 'UTC'), 'Jan 2, 2026, 12:05 AM');
  // The space before AM or PM is a plain space (newer ICU data has a narrow no-break space).
  assert.doesNotMatch(formatDateTime(ms, 'UTC'), /[\u202f\u00a0]/);
  assert.equal(formatDateTime(Number.NaN), '');
  assert.equal(formatDateTime(Number.POSITIVE_INFINITY), '');
});

test('summaryLine: date, size and parts, and it leaves out what is not known', () => {
  const createdAt = Date.UTC(2026, 10, 6, 15, 42);
  assert.equal(
    summaryLine({ createdAt, widthPx: 1500, heightPx: 11_980, partCount: 8, timeZone: 'UTC' }),
    'Nov 6, 2026, 3:42 PM · 1,500 × 11,980 px · 8 parts',
  );
  assert.equal(
    summaryLine({ createdAt, widthPx: 800, heightPx: 600, partCount: 1, timeZone: 'UTC' }),
    'Nov 6, 2026, 3:42 PM · 800 × 600 px · 1 part',
  );
  assert.equal(summaryLine({ widthPx: 800, heightPx: 600 }), '800 × 600 px');
  assert.equal(
    summaryLine({ createdAt: Number.NaN, widthPx: 800, heightPx: 600, partCount: 2 }),
    '800 × 600 px · 2 parts',
  );
});

test('savedLine: counts the files and shows the folder with arrows', () => {
  assert.equal(savedLine(1, 'Spool'), 'Saved 1 file in Downloads › Spool.');
  assert.equal(
    savedLine(6, 'Spool/2026-11-06_10-42-01 Draft 3'),
    'Saved 6 files in Downloads › Spool › 2026-11-06_10-42-01 Draft 3.',
  );
  assert.equal(savedLine(2, ''), 'Saved 2 files in Downloads.');
});

// ---------------------------------------------------------------------------------------------
// stackLayout (the "For people" column)
// ---------------------------------------------------------------------------------------------

test('stackLayout: the first tile is whole, later tiles hide the rows the tile above shows', () => {
  const plan = planTiles(1500, 6000, 'high');
  const layout = stackLayout(plan);
  assert.equal(layout.length, plan.length);
  assert.equal(layout[0]?.skipHeight, 0);
  const first = plan[0];
  const second = plan[1];
  assert.ok(first && second);
  const overlap = first.srcY + first.srcHeight - second.srcY;
  assert.ok(overlap > 0);
  // Width 1500 is below the long edge: no scaling, so the overlap is in output rows too.
  assert.equal(layout[1]?.skipHeight, overlap);
  assert.equal(layout[1]?.visibleHeight, second.outHeight - overlap);
});

test('stackLayout: the visible rows of all tiles add up to the full image', () => {
  for (const [width, height, tier] of /** @type {const} */ ([
    [1500, 6000, 'high'],
    [1500, 40_000, 'high'],
    [900, 12_345, 'standard'],
    [3000, 20_000, 'high'],
    [1500, 2000, 'high'],
  ])) {
    const plan = planTiles(width, height, tier);
    const total = stackLayout(plan).reduce((sum, tile) => sum + tile.visibleHeight, 0);
    const scale = (plan[0]?.outWidth ?? width) / width;
    // Rounding of each tile height to whole rows can add up to half a row for each tile.
    assert.ok(Math.abs(total - height * scale) <= plan.length, `${width} x ${height}`);
  }
});

test('stackLayout: a tile that the tile above covers completely is empty', () => {
  const layout = stackLayout([
    { index: 0, srcY: 0, srcHeight: 100, outWidth: 50, outHeight: 100 },
    { index: 1, srcY: 40, srcHeight: 30, outWidth: 50, outHeight: 30 },
    { index: 2, srcY: 80, srcHeight: 40, outWidth: 50, outHeight: 20 },
  ]);
  assert.deepEqual(layout[1], { index: 1, outWidth: 50, skipHeight: 30, visibleHeight: 0 });
  // The third tile is scaled by 1/2: its 20 shared source rows are 10 output rows.
  assert.deepEqual(layout[2], { index: 2, outWidth: 50, skipHeight: 10, visibleHeight: 10 });
});

test('stackLayout: one tile, and no tiles', () => {
  const one = [{ index: 0, srcY: 0, srcHeight: 50, outWidth: 9, outHeight: 50 }];
  assert.deepEqual(stackLayout(one), [{ index: 0, outWidth: 9, skipHeight: 0, visibleHeight: 50 }]);
  assert.deepEqual(stackLayout([]), []);
});

// ---------------------------------------------------------------------------------------------
// planRowChunks
// ---------------------------------------------------------------------------------------------

test('planRowChunks: covers every row once, in order', () => {
  assert.deepEqual(planRowChunks(1200, 512), [
    { y: 0, height: 512 },
    { y: 512, height: 512 },
    { y: 1024, height: 176 },
  ]);
  assert.deepEqual(planRowChunks(1024, 512), [
    { y: 0, height: 512 },
    { y: 512, height: 512 },
  ]);
  assert.deepEqual(planRowChunks(100, 512), [{ y: 0, height: 100 }]);
  assert.deepEqual(planRowChunks(1, 512), [{ y: 0, height: 1 }]);
});

test('planRowChunks: empty or invalid input gives no chunks', () => {
  assert.deepEqual(planRowChunks(0, 512), []);
  assert.deepEqual(planRowChunks(-4, 512), []);
  assert.deepEqual(planRowChunks(Number.NaN, 512), []);
  assert.deepEqual(planRowChunks(100, 0), []);
});

test('planRowChunks: heights add up and no chunk exceeds the limit', () => {
  const chunks = planRowChunks(18_240, 512);
  assert.equal(
    chunks.reduce((sum, chunk) => sum + chunk.height, 0),
    18_240,
  );
  assert.ok(chunks.every((chunk) => chunk.height >= 1 && chunk.height <= 512));
});

// ---------------------------------------------------------------------------------------------
// base64ToBytes
// ---------------------------------------------------------------------------------------------

test('base64ToBytes: round trip for every padding case', () => {
  for (let length = 0; length <= 12; length += 1) {
    const bytes = Uint8Array.from({ length }, (_, i) => (i * 37 + 11) & 0xff);
    const decoded = base64ToBytes(Buffer.from(bytes).toString('base64'));
    assert.deepEqual(decoded, bytes, `length ${length}`);
  }
});

test('base64ToBytes: round trip across the 1 Mi-character chunk boundary', () => {
  const length = 2_000_003;
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31 + (i >> 8)) & 0xff;
  const decoded = base64ToBytes(Buffer.from(bytes).toString('base64'));
  assert.equal(decoded.length, length);
  assert.ok(Buffer.from(decoded).equals(Buffer.from(bytes)));
});

test('base64ToBytes: rejects invalid input', () => {
  assert.throws(() => base64ToBytes('not base64 !!'));
});

// ---------------------------------------------------------------------------------------------
// createAsyncLru
// ---------------------------------------------------------------------------------------------

/** @param {number} [max] */
function makeCache(max = 2) {
  /** @type {number[]} */
  const loads = [];
  /** @type {number[]} */
  const disposed = [];
  const cache = createAsyncLru({
    max,
    load: async (/** @type {number} */ key) => {
      loads.push(key);
      return { key };
    },
    dispose: (/** @type {{ key: number }} */ value) => {
      disposed.push(value.key);
    },
  });
  return { cache, loads, disposed };
}

/** Lets pending promise callbacks run. */
function flush() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

test('createAsyncLru: keeps at most max entries and disposes the least recently used', async () => {
  const { cache, loads, disposed } = makeCache(2);
  assert.deepEqual(await cache.get(1), { key: 1 });
  await cache.get(2);
  assert.equal(cache.size, 2);
  await cache.get(3);
  await flush();
  assert.equal(cache.size, 2);
  assert.deepEqual(disposed, [1]);
  assert.deepEqual(loads, [1, 2, 3]);
});

test('createAsyncLru: disposes the evicted value before the next load starts', async () => {
  /** @type {string[]} */
  const events = [];
  const cache = createAsyncLru({
    max: 2,
    load: async (/** @type {number} */ key) => {
      events.push(`load ${key}`);
      return key;
    },
    dispose: (/** @type {number} */ value) => {
      events.push(`dispose ${value}`);
    },
  });
  await cache.get(1);
  await cache.get(2);
  await cache.get(3);
  await cache.get(4);
  await flush();
  assert.deepEqual(events, ['load 1', 'load 2', 'dispose 1', 'load 3', 'dispose 2', 'load 4']);
});

test('createAsyncLru: a hit refreshes the entry and does not reload', async () => {
  const { cache, loads, disposed } = makeCache(2);
  await cache.get(1);
  await cache.get(2);
  await cache.get(1); // 1 is now the newest
  await cache.get(3); // evicts 2
  await flush();
  assert.deepEqual(disposed, [2]);
  assert.deepEqual(loads, [1, 2, 3]);
});

test('createAsyncLru: concurrent gets share one load', async () => {
  const { cache, loads } = makeCache(2);
  const [a, b] = await Promise.all([cache.get(7), cache.get(7)]);
  assert.equal(a, b);
  assert.deepEqual(loads, [7]);
});

test('createAsyncLru: an entry evicted while it loads is disposed after the load', async () => {
  const { cache, disposed } = makeCache(1);
  const first = cache.get(1);
  const second = cache.get(2); // evicts the pending load of 1
  await Promise.all([first, second]);
  await flush();
  assert.deepEqual(disposed, [1]);
  assert.equal(cache.size, 1);
});

test('createAsyncLru: a failed load is not cached and nothing is disposed', async () => {
  /** @type {number[]} */
  const disposed = [];
  let attempts = 0;
  const cache = createAsyncLru({
    max: 2,
    load: async (/** @type {number} */ key) => {
      attempts += 1;
      if (attempts === 1) throw new Error('decode failed');
      return key;
    },
    dispose: (/** @type {number} */ value) => {
      disposed.push(value);
    },
  });
  await assert.rejects(cache.get(5), /decode failed/);
  await flush();
  assert.equal(cache.size, 0);
  assert.equal(await cache.get(5), 5);
  assert.deepEqual(disposed, []);
});

test('createAsyncLru: a load that throws before it returns a promise is a rejection', async () => {
  const cache = createAsyncLru({
    max: 2,
    load: (/** @type {number} */ key) => {
      throw new Error(`no slice ${key}`);
    },
    dispose: () => {},
  });
  await assert.rejects(cache.get(3), /no slice 3/);
  assert.equal(cache.size, 0);
});

test('createAsyncLru: close disposes everything and refuses new gets', async () => {
  const { cache, disposed } = makeCache(2);
  await cache.get(1);
  await cache.get(2);
  cache.close();
  await flush();
  assert.deepEqual(disposed.sort(), [1, 2]);
  assert.equal(cache.size, 0);
  await assert.rejects(cache.get(3), /closed/);
});

test('base64ToBlob: a PNG Blob with the same bytes', async () => {
  const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 255]);
  const base64 = Buffer.from(bytes).toString('base64');
  const blob = base64ToBlob(base64);
  assert.equal(blob.type, 'image/png');
  assert.equal(blob.size, bytes.length);
  assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  assert.equal(base64ToBlob(base64, 'image/jpeg').type, 'image/jpeg');
});

// ---------------------------------------------------------------------------------------------
// saveInfoLine (what Done saved)
// ---------------------------------------------------------------------------------------------

test('saveInfoLine: a save in the chosen folder names the folder', () => {
  assert.deepEqual(
    saveInfoLine({ location: 'folder', label: 'Screenshots', files: 6, needsPermission: false }),
    { text: 'Saved 6 files in Screenshots.', tone: 'ok', needsPermission: false },
  );
  assert.equal(
    saveInfoLine({ location: 'folder', label: '', files: 1, needsPermission: false }).text,
    'Saved 1 file in the chosen folder.',
  );
});

test('saveInfoLine: a save in Downloads shows the folder with arrows', () => {
  assert.equal(
    saveInfoLine({ location: 'downloads', label: 'Downloads/Spool', files: 2, needsPermission: false })
      .text,
    'Saved 2 files in Downloads › Spool.',
  );
});

test('saveInfoLine: a chosen folder without permission offers to allow access', () => {
  const line = saveInfoLine({
    location: 'downloads',
    label: 'Downloads/Spool',
    files: 2,
    needsPermission: true,
  });
  assert.equal(line.needsPermission, true);
  assert.equal(line.tone, 'info');
  assert.match(line.text, /^Saved 2 files in Downloads › Spool\. Spool could not use your chosen folder/);
});

test('saveInfoLine: nothing saved says why', () => {
  assert.match(
    saveInfoLine({ location: 'none', label: 'Not saved', files: 0, needsPermission: false }).text,
    /Turn on AI screenshots or the full image in Settings/,
  );
  assert.deepEqual(
    saveInfoLine({
      location: 'none',
      label: 'Not saved',
      files: 0,
      needsPermission: false,
      error: 'The disk is full.',
    }),
    { text: 'Not saved. The disk is full.', tone: 'error', needsPermission: false },
  );
  // A save that has an error and some files shows both.
  const partial = saveInfoLine({
    location: 'downloads',
    label: 'Downloads/Spool',
    files: 1,
    needsPermission: false,
    error: 'One file failed.',
  });
  assert.equal(partial.tone, 'error');
  assert.equal(partial.text, 'Saved 1 file in Downloads › Spool. One file failed.');
});
