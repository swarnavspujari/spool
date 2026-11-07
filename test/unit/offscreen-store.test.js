// @ts-check
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { planTiles } from '../../src/lib/tiles.js';
import { dataUrlToBlob } from '../../src/offscreen/image-ops.js';
import { createSessionStore } from '../../src/offscreen/session-store.js';
import {
  MAX_TOTAL_HEIGHT_PX,
  PATHS,
  SESSION_IDLE_MS,
  SESSION_MAX_BYTES,
  SESSION_TTL_MS,
  SIGNATURE_MAX_COLS,
  TOTAL_MAX_BYTES,
} from '../../src/shared/constants.js';
import {
  ERR,
  MSG,
  PROTOCOL_VERSION,
  SpoolError,
  TARGET,
  makeMessage,
} from '../../src/shared/protocol.js';
import { EXTENSION_ID, EXTENSION_ORIGIN, installFakeChrome } from '../helpers/fake-chrome.js';

/** @typedef {import('../../src/shared/types.js').Direction} Direction */
/** @typedef {import('../../src/shared/types.js').FrameMeta} FrameMeta */
/** @typedef {import('../../src/shared/types.js').Rect} Rect */
/** @typedef {import('../../src/shared/types.js').Size} Size */
/** @typedef {import('../../src/offscreen/session-store.js').CropBox} CropBox */
/** @typedef {import('../../src/offscreen/session-store.js').ImageOps} ImageOps */
/** @typedef {(row: number, col: number) => number} PageModel */

// ---------------------------------------------------------------------------------------------
// Test page and fake image code
// ---------------------------------------------------------------------------------------------

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER_SESSION = '22222222-2222-4222-8222-222222222222';
const THIRD_SESSION = '33333333-3333-4333-8333-333333333333';
const TAB = 7;
const PNG_PREFIX = 'data:image/png;base64,';

const VIEWPORT = Object.freeze({ width: 1000, height: 800 });
const RECT = Object.freeze({ x: 0, y: 100, width: 1000, height: 600 });
/** Scroll distance of one step: rect height minus an overlap of 80 px. */
const STEP = 520;
const BLOB_BYTES = 1000;
const MSG_JUMP = 'The page moved too far. Finish now to keep what you have.';

/**
 * Luminance of the test page at one row and one signature column. Random-looking, so two
 * different rows differ by about 85 levels and only the right offset gives a match.
 * @param {number} row
 * @param {number} col
 * @returns {number}
 */
function noise(row, col) {
  let h = (Math.imul(row, 374761393) + Math.imul(col, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) & 255;
}

/**
 * A page that is flat (one grey) in the given row ranges and noisy elsewhere.
 * @param {ReadonlyArray<readonly [number, number]>} bands  [first row, end row) pairs.
 * @returns {PageModel}
 */
function pageWithFlatBands(bands) {
  const isFlat = (/** @type {number} */ row) => bands.some(([from, to]) => row >= from && row < to);
  return (row, col) => (isFlat(row) ? 200 : noise(row, col));
}

/**
 * Fake imageOps. A "data URL" holds JSON { w, h, origin }: the bitmap size and the page row at
 * bitmap row 0. A crop builds the signature from the page model, so seam corrections are real.
 * @param {{ page?: PageModel, blobSize?: number }} [options]
 */
function createFake({ page = noise, blobSize = BLOB_BYTES } = {}) {
  const stats = {
    decoded: 0,
    closed: 0,
    /** @type {CropBox[]} */
    boxes: [],
    /** @type {Uint8Array[]} Bytes of every produced blob, in crop order. */
    blobs: [],
    failNextDecode: false,
    /** @type {{ promise: Promise<void>, release: () => void } | null} */
    hold: null,
  };

  /** @type {ImageOps} */
  const ops = {
    async decode(dataUrl) {
      if (stats.failNextDecode) {
        stats.failNextDecode = false;
        throw new Error('bad png');
      }
      if (stats.hold !== null) {
        const { promise } = stats.hold;
        stats.hold = null;
        await promise;
      }
      const spec = JSON.parse(Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64').toString());
      stats.decoded += 1;
      return {
        widthPx: spec.w,
        heightPx: spec.h,
        async crop(box) {
          stats.boxes.push(box);
          const cols = Math.min(SIGNATURE_MAX_COLS, box.sw);
          const signature = new Uint8Array(box.sh * cols);
          for (let r = 0; r < box.sh; r++) {
            for (let c = 0; c < cols; c++) {
              signature[r * cols + c] = page(spec.origin + box.sy + r, c);
            }
          }
          const bytes = Uint8Array.from(
            { length: blobSize },
            (_, i) => (spec.origin + box.sy + i * 7 + box.sh) & 255,
          );
          stats.blobs.push(bytes);
          return { blob: new Blob([bytes]), signature, cols, width: box.sw, height: box.sh };
        },
        close() {
          stats.closed += 1;
        },
      };
    },
  };

  return {
    ops,
    stats,
    /** Makes the next decode wait until release() is called. */
    holdNextDecode() {
      /** @type {() => void} */
      let release = () => {};
      const promise = new Promise((resolve) => {
        release = () => resolve(undefined);
      });
      stats.hold = { promise: /** @type {Promise<void>} */ (promise), release };
      return { release };
    },
  };
}

/**
 * A captured frame: the data URL and the FrameMeta that the page agent would send.
 * `drift` moves the real content by that many device px against the reported contentY,
 * like content that loaded late.
 * @param {{ contentY: number, direction?: Direction, drift?: number, scale?: number,
 *   rect?: Rect, viewport?: Size }} options
 * @returns {{ dataUrl: string, meta: FrameMeta }}
 */
function frame({
  contentY,
  direction = 'down',
  drift = 0,
  scale = 1,
  rect = RECT,
  viewport = VIEWPORT,
}) {
  const w = Math.round(viewport.width * scale);
  const h = Math.round(viewport.height * scale);
  const origin = Math.round(contentY * scale) - Math.round(rect.y * scale) + drift;
  const dataUrl = PNG_PREFIX + Buffer.from(JSON.stringify({ w, h, origin })).toString('base64');
  return {
    dataUrl,
    meta: { direction, viewport: { ...viewport }, rect: { ...rect }, contentY },
  };
}

const CLOCK_START = 1_700_000_000_000;
const MINUTE_MS = 60 * 1000;

/**
 * @typedef {Object} FakeTimer
 * @property {() => void} fn
 * @property {number} ms         The delay that the store asked for.
 * @property {number} dueAt      Virtual time (ms since the start) at which it runs.
 * @property {boolean} cancelled
 * @property {boolean} fired
 */

/**
 * Fake timers on a virtual clock. Time only moves in advance(), which runs the timers that fall
 * due on the way, in order.
 */
function createFakeTimers() {
  /** @type {FakeTimer[]} Every timer that was ever set. */
  const list = [];
  let elapsed = 0;
  const pending = () => list.filter((timer) => !timer.cancelled && !timer.fired);
  return {
    list,
    /** Epoch ms of the virtual clock. */
    now: () => CLOCK_START + elapsed,
    /** @param {() => void} fn @param {number} ms */
    set(fn, ms) {
      /** @type {FakeTimer} */
      const timer = { fn, ms, dueAt: elapsed + ms, cancelled: false, fired: false };
      list.push(timer);
      return timer;
    },
    /** @param {unknown} handle */
    clear(handle) {
      /** @type {FakeTimer} */ (handle).cancelled = true;
    },
    /** Timers that are neither cleared nor fired. */
    pending,
    /** @param {number} ms */
    advance(ms) {
      const target = elapsed + ms;
      for (;;) {
        const due = pending()
          .filter((timer) => timer.dueAt <= target)
          .sort((a, b) => a.dueAt - b.dueAt)[0];
        if (due === undefined) break;
        elapsed = due.dueAt;
        due.fired = true;
        due.fn();
      }
      elapsed = target;
    },
  };
}

/**
 * @param {{
 *   fake?: Parameters<typeof createFake>[0],
 *   store?: {
 *     maxBytes?: number,
 *     totalMaxBytes?: number,
 *     maxHeightPx?: number,
 *     idleMs?: number,
 *     ttlMs?: number,
 *   },
 * }} [options]
 */
function setup(options = {}) {
  const fake = createFake(options.fake);
  const timers = createFakeTimers();
  const empty = { calls: 0 };
  const store = createSessionStore({
    imageOps: fake.ops,
    now: () => timers.now(),
    setTimer: (fn, ms) => timers.set(fn, ms),
    clearTimer: (handle) => timers.clear(handle),
    onEmpty: () => {
      empty.calls += 1;
    },
    ...options.store,
  });
  return { store, fake, timers, empty };
}

/**
 * @param {ReturnType<typeof setup>['store']} store
 * @param {ReturnType<typeof frame>} f
 * @param {string} [sessionId]
 */
function add(store, f, sessionId = SESSION) {
  return store.addFrame(sessionId, TAB, f.dataUrl, f.meta);
}

/**
 * Opens a session on TAB and adds the frames in order.
 * @param {ReturnType<typeof setup>} env
 * @param {Array<Parameters<typeof frame>[0]>} frames
 * @param {import('../../src/shared/types.js').TileTier} [tier]
 */
async function capture(env, frames, tier = 'high') {
  env.store.open(SESSION, TAB, 'Test page', tier);
  const results = [];
  for (const options of frames) results.push(await add(env.store, frame(options)));
  return results;
}

/** @param {ReturnType<typeof setup>} env */
async function finishAndRead(env) {
  await env.store.finish(SESSION, TAB);
  return env.store.takeForAssembly(SESSION, TAB).manifest;
}

/** @param {unknown} e @param {string} code @param {string} [message] */
function isSpoolError(e, code, message) {
  assert.ok(e instanceof SpoolError, `expected a SpoolError, got ${String(e)}`);
  assert.equal(e.code, code);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
}

/** @param {Promise<unknown>} promise @param {string} code @param {string} [message] */
async function rejectsWith(promise, code, message) {
  await assert.rejects(promise, (e) => isSpoolError(e, code, message));
}

/** @param {() => unknown} fn @param {string} code */
function throwsWith(fn, code) {
  assert.throws(fn, (e) => isSpoolError(e, code));
}

/** Lets pending promise callbacks run. */
function tick() {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

describe('open', () => {
  it('does nothing for the same id and tab, and keeps the slices', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    env.store.open(SESSION, TAB, 'Other title', 'standard');
    assert.equal(env.store.ping().sessions, 1);
    const manifest = await finishAndRead(env);
    assert.equal(manifest.slices.length, 1);
    assert.equal(manifest.title, 'Test page');
  });

  it('remembers the host name of the captured page, and "" when none is given', async () => {
    const withHost = setup();
    withHost.store.open(SESSION, TAB, 'Test page', 'high', 'github.com');
    await add(withHost.store, frame({ contentY: 0 }));
    assert.equal((await finishAndRead(withHost)).sourceHost, 'github.com');

    const without = setup();
    await capture(without, [{ contentY: 0 }]);
    assert.equal((await finishAndRead(without)).sourceHost, '');
  });

  it('keeps the host of the first open when the same session is opened again', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, 'Test page', 'high', 'github.com');
    await add(env.store, frame({ contentY: 0 }));
    env.store.open(SESSION, TAB, 'Test page', 'high', 'evil.example');
    assert.equal((await finishAndRead(env)).sourceHost, 'github.com');
  });

  it('fails for the same id on another tab', () => {
    const { store } = setup();
    store.open(SESSION, TAB, '', 'high');
    throwsWith(() => store.open(SESSION, TAB + 1, '', 'high'), ERR.SESSION_NOT_FOUND);
  });
});

describe('addFrame: first frame and sequences', () => {
  it('stores the first frame and fixes width and scale', async () => {
    const env = setup();
    const [first] = await capture(env, [{ contentY: 0, direction: 'initial' }]);
    assert.deepEqual(first, {
      index: 0,
      sliceCount: 1,
      widthPx: 1000,
      totalHeightPx: 600,
      tileCount: planTiles(1000, 600, 'high').length,
      seam: { status: 'first', shiftPx: 0, meanDiff: 0 },
      storedBytes: BLOB_BYTES,
    });
    assert.deepEqual(env.fake.stats.boxes, [{ sx: 0, sy: 100, sw: 1000, sh: 600 }]);
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded);
  });

  it('appends a down sequence with exact seams', async () => {
    const env = setup();
    const results = await capture(
      env,
      [0, 1, 2, 3].map((k) => ({
        contentY: k * STEP,
        direction: k === 0 ? 'initial' : 'down',
      })),
    );
    assert.deepEqual(
      results.map((r) => r.seam.status),
      ['first', 'exact', 'exact', 'exact'],
    );
    assert.deepEqual(
      results.map((r) => r.index),
      [0, 1, 2, 3],
    );
    assert.equal(results[3]?.totalHeightPx, 3 * STEP + 600);
    assert.equal(results[3]?.sliceCount, 4);
    assert.equal(results[3]?.storedBytes, 4 * BLOB_BYTES);
    const manifest = await finishAndRead(env);
    assert.deepEqual(
      manifest.slices.map((s) => s.yPx),
      [0, 520, 1040, 1560],
    );
    assert.deepEqual(manifest.warnings, []);
    assert.equal(manifest.totalHeightPx, 2160);
    assert.equal(manifest.widthPx, 1000);
    assert.equal(manifest.scale, 1);
    assert.equal(manifest.createdAt, CLOCK_START);
  });

  it('prepends an up sequence and keeps the insertion indexes stable', async () => {
    const env = setup();
    const results = await capture(env, [
      { contentY: 2000, direction: 'initial' },
      { contentY: 2000 - STEP, direction: 'up' },
      { contentY: 2000 - 2 * STEP, direction: 'up' },
    ]);
    assert.deepEqual(
      results.map((r) => [r.index, r.seam.status]),
      [
        [0, 'first'],
        [1, 'exact'],
        [2, 'exact'],
      ],
    );
    assert.equal(results[2]?.totalHeightPx, 2 * STEP + 600);
    const manifest = await finishAndRead(env);
    // Sorted by position: the last added slice is the top one.
    assert.deepEqual(
      manifest.slices.map((s) => [s.index, s.yPx]),
      [
        [2, 0],
        [1, STEP],
        [0, 2 * STEP],
      ],
    );
    assert.deepEqual(manifest.warnings, []);
  });

  it('checks a down frame against the slice above after a prepend', async () => {
    const env = setup();
    const results = await capture(env, [
      { contentY: 1000, direction: 'initial' },
      { contentY: 1000 - STEP, direction: 'up' },
      { contentY: 1000 + STEP, direction: 'down' },
    ]);
    assert.deepEqual(
      results.map((r) => r.seam.status),
      ['first', 'exact', 'exact'],
    );
    const manifest = await finishAndRead(env);
    assert.deepEqual(
      manifest.slices.map((s) => [s.index, s.yPx]),
      [
        [1, 0],
        [0, STEP],
        [2, 2 * STEP],
      ],
    );
  });

  it('uses the slice on the other side when no slice on the preferred side overlaps', async () => {
    const env = setup();
    const results = await capture(env, [
      { contentY: 1000, direction: 'initial' },
      { contentY: 1000 - STEP, direction: 'down' },
    ]);
    assert.equal(results[1]?.seam.status, 'exact');
    assert.deepEqual((await finishAndRead(env)).warnings, []);
  });

  it('works with a device scale of 1.5', async () => {
    const env = setup();
    const results = await capture(env, [
      { contentY: 0, direction: 'initial', scale: 1.5 },
      { contentY: STEP, scale: 1.5 },
    ]);
    assert.equal(results[0]?.widthPx, 1500);
    assert.equal(results[0]?.totalHeightPx, 900);
    assert.deepEqual(results[1]?.seam, { status: 'exact', shiftPx: 0, meanDiff: 0 });
    assert.equal(results[1]?.totalHeightPx, 780 + 900);
    const manifest = await finishAndRead(env);
    assert.equal(manifest.scale, 1.5);
    assert.deepEqual(
      manifest.slices.map((s) => s.yPx),
      [0, 780],
    );
  });

  it('reports the tile count of the session tile tier', async () => {
    const env = setup();
    const frames = Array.from({ length: 10 }, (_, k) => ({ contentY: k * STEP }));
    const results = await capture(env, frames, 'standard');
    const last = results[9];
    assert.ok(last);
    assert.equal(last.totalHeightPx, 9 * STEP + 600);
    assert.equal(last.tileCount, planTiles(1000, last.totalHeightPx, 'standard').length);
    assert.ok(last.tileCount > 1);
  });
});

describe('addFrame: duplicates', () => {
  it('drops a frame at the end of the content (down)', async () => {
    const env = setup();
    const results = await capture(env, [
      { contentY: 0 },
      { contentY: STEP },
      { contentY: STEP },
    ]);
    assert.deepEqual(results[2], {
      index: -1,
      sliceCount: 2,
      widthPx: 1000,
      totalHeightPx: STEP + 600,
      tileCount: planTiles(1000, STEP + 600, 'high').length,
      seam: { status: 'duplicate', shiftPx: 0, meanDiff: 0 },
      storedBytes: 2 * BLOB_BYTES,
    });
    assert.equal(env.fake.stats.blobs.length, 2, 'no crop for a duplicate');
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded);
    const next = await add(env.store, frame({ contentY: 2 * STEP }));
    assert.equal(next.index, 2, 'a duplicate does not use an index');
  });

  it('drops a frame at the start of the content (up) and within one px', async () => {
    const env = setup();
    const results = await capture(env, [
      { contentY: STEP, direction: 'initial' },
      { contentY: 0, direction: 'up' },
      { contentY: 0, direction: 'up' },
      { contentY: 1, direction: 'up' },
    ]);
    assert.deepEqual(
      results.map((r) => r.seam.status),
      ['first', 'exact', 'duplicate', 'duplicate'],
    );
    assert.equal(results[3]?.sliceCount, 2);
  });

  it('keeps a frame at the same position with another height', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    const shorter = frame({ contentY: 0, rect: { ...RECT, height: 400 } });
    const result = await add(env.store, shorter);
    assert.equal(result.sliceCount, 2);
    assert.notEqual(result.index, -1);
  });
});

describe('addFrame: seam correction and warnings', () => {
  it('shifts the position of a lower slice by the corrected seam', async () => {
    const env = setup();
    const results = await capture(env, [
      { contentY: 0 },
      { contentY: STEP, drift: 7 },
      { contentY: 2 * STEP, drift: 7 },
    ]);
    assert.equal(results[1]?.seam.status, 'corrected');
    assert.equal(results[1]?.seam.shiftPx, 7);
    assert.equal(results[1]?.seam.meanDiff, 0);
    assert.equal(results[1]?.totalHeightPx, STEP + 7 + 600);
    assert.equal(results[2]?.seam.status, 'corrected');
    const manifest = await finishAndRead(env);
    assert.deepEqual(
      manifest.slices.map((s) => s.yPx),
      [0, STEP + 7, 2 * STEP + 7],
    );
    assert.deepEqual(manifest.warnings, []);
  });

  it('corrects a negative shift', async () => {
    const env = setup();
    const results = await capture(env, [{ contentY: 0 }, { contentY: STEP, drift: -9 }]);
    assert.equal(results[1]?.seam.status, 'corrected');
    assert.equal(results[1]?.seam.shiftPx, -9);
    const manifest = await finishAndRead(env);
    assert.deepEqual(
      manifest.slices.map((s) => s.yPx),
      [0, STEP - 9],
    );
  });

  it('moves an upper slice (up direction) the other way', async () => {
    const env = setup();
    const results = await capture(env, [
      { contentY: 2000, direction: 'initial' },
      { contentY: 2000 - STEP, direction: 'up', drift: 5 },
    ]);
    assert.equal(results[1]?.seam.status, 'corrected');
    assert.equal(results[1]?.seam.shiftPx, 5, 'the new slice moves down by 5');
    const manifest = await finishAndRead(env);
    assert.deepEqual(
      manifest.slices.map((s) => [s.index, s.yPx]),
      [
        [1, 0],
        [0, STEP - 5],
      ],
    );
  });

  it('warns about a join that could not be checked when the overlap does not match', async () => {
    const env = setup();
    const results = await capture(env, [{ contentY: 0 }, { contentY: STEP, drift: 300 }]);
    assert.equal(results[1]?.seam.status, 'unmatched');
    assert.equal(results[1]?.seam.shiftPx, 0);
    const manifest = await finishAndRead(env);
    assert.deepEqual(manifest.warnings, [
      'Spool could not verify 1 seam, near step 2. Check that area.',
    ]);
  });

  it('warns about a join when slices touch without overlap (no gap)', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }, { contentY: 600 }]);
    const manifest = await finishAndRead(env);
    assert.deepEqual(manifest.warnings, [
      'Spool could not verify 1 seam, near step 2. Check that area.',
    ]);
  });

  it('lists ambiguous joins by part number', async () => {
    const page = pageWithFlatBands([
      [1040, 1120],
      [3120, 3200],
    ]);
    const env = setup({ fake: { page } });
    const results = await capture(
      env,
      Array.from({ length: 8 }, (_, k) => ({ contentY: k * STEP })),
    );
    assert.deepEqual(
      results.map((r) => r.seam.status),
      ['first', 'exact', 'ambiguous', 'exact', 'exact', 'exact', 'ambiguous', 'exact'],
    );
    const manifest = await finishAndRead(env);
    assert.deepEqual(manifest.warnings, [
      'Spool could not verify 2 seams, near steps 3 and 7. Check those areas.',
    ]);
  });

  it('shortens a long list of parts', async () => {
    const env = setup();
    await capture(
      env,
      Array.from({ length: 10 }, (_, k) => ({ contentY: k * 600 })),
    );
    const manifest = await finishAndRead(env);
    assert.deepEqual(manifest.warnings, [
      'Spool could not verify 9 seams, near steps 2, 3, 4, 5, 6, 7, 8, 9 and 1 more. ' +
        'Check those areas.',
    ]);
  });

  it('never warns about a gap: a frame that would leave one is refused', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }, { contentY: STEP, drift: 300 }]);
    await rejectsWith(add(env.store, frame({ contentY: 3000 })), ERR.CAPTURE_FAILED, MSG_JUMP);
    const manifest = await finishAndRead(env);
    assert.deepEqual(manifest.warnings, [
      'Spool could not verify 1 seam, near step 2. Check that area.',
    ]);
  });
});

describe('addFrame: zoom, width and sessions', () => {
  it('rejects a frame with another zoom and keeps what it has', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    const zoomed = frame({ contentY: STEP, scale: 1.5 });
    await rejectsWith(
      add(env.store, zoomed),
      ERR.CAPTURE_FAILED,
      'Page zoom changed. Finish now to keep what you have.',
    );
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded, 'the bitmap is closed');
    assert.equal(env.fake.stats.blobs.length, 1, 'no crop for the rejected frame');
    const manifest = await finishAndRead(env);
    assert.equal(manifest.slices.length, 1);
    assert.equal(manifest.totalHeightPx, 600);
  });

  it('accepts a crop width within 2 px and uses the session width', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    const result = await add(env.store, frame({ contentY: STEP, rect: { ...RECT, width: 998 } }));
    assert.equal(result.widthPx, 1000);
    assert.equal(result.seam.status, 'exact');
    assert.deepEqual(env.fake.stats.boxes[1], { sx: 0, sy: 100, sw: 1000, sh: 600 });
  });

  it('rejects a crop width that is 3 px off', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    await rejectsWith(
      add(env.store, frame({ contentY: STEP, rect: { ...RECT, width: 997 } })),
      ERR.CAPTURE_FAILED,
      'Page zoom changed. Finish now to keep what you have.',
    );
  });

  it('keeps the crop inside the bitmap when it is moved right', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    const moved = frame({ contentY: STEP, rect: { ...RECT, x: 2 } });
    const result = await add(env.store, moved);
    assert.equal(result.seam.status, 'exact');
    assert.deepEqual(env.fake.stats.boxes[1], { sx: 0, sy: 100, sw: 1000, sh: 600 });
  });

  it('rejects frames for another tab and for an unknown session', async () => {
    const { store } = setup();
    store.open(SESSION, TAB, '', 'high');
    const f = frame({ contentY: 0 });
    await rejectsWith(
      store.addFrame(SESSION, TAB + 1, f.dataUrl, f.meta),
      ERR.SESSION_NOT_FOUND,
    );
    await rejectsWith(
      store.addFrame(OTHER_SESSION, TAB, f.dataUrl, f.meta),
      ERR.SESSION_NOT_FOUND,
    );
    assert.equal(store.ping().sessions, 1);
  });

  it('rejects finish for another tab', async () => {
    const { store } = setup();
    store.open(SESSION, TAB, '', 'high');
    await rejectsWith(store.finish(SESSION, TAB + 1), ERR.SESSION_NOT_FOUND);
    throwsWith(() => store.takeForAssembly(SESSION, TAB).manifest, ERR.SESSION_NOT_FOUND);
  });

  it('rejects frames after finish', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    await env.store.finish(SESSION, TAB);
    await rejectsWith(add(env.store, frame({ contentY: STEP })), ERR.SESSION_NOT_FOUND);
    assert.equal(env.fake.stats.decoded, 1);
  });

  it('turns an image failure into a plain capture error and goes on', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    env.fake.stats.failNextDecode = true;
    await rejectsWith(
      add(env.store, frame({ contentY: STEP })),
      ERR.CAPTURE_FAILED,
      'Could not read the captured image. Try again.',
    );
    const result = await add(env.store, frame({ contentY: STEP }));
    assert.equal(result.seam.status, 'exact');
  });
});

describe('addFrame: byte limit', () => {
  it('rejects a frame that would pass the limit and keeps the stored ones', async () => {
    const env = setup({ store: { maxBytes: 2500 } });
    const results = await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    assert.equal(results[1]?.storedBytes, 2000);
    await rejectsWith(
      add(env.store, frame({ contentY: 2 * STEP })),
      ERR.SESSION_TOO_LARGE,
      'This capture is too large. Finish now to keep what you have.',
    );
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded);
    const manifest = await finishAndRead(env);
    assert.equal(manifest.slices.length, 2);
  });

  it('allows a total that equals the limit', async () => {
    const env = setup({ store: { maxBytes: 2000 } });
    const results = await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    assert.equal(results[1]?.storedBytes, 2000);
  });
});

describe('addFrame: total memory limit (all sessions)', () => {
  const TOTAL_MESSAGE = 'This capture is using too much memory. Finish now to keep what you have.';

  /**
   * @param {ReturnType<typeof setup>} env
   * @param {string} id
   * @param {number} tab
   * @param {number} y
   */
  function addTo(env, id, tab, y) {
    const f = frame({ contentY: y });
    return env.store.addFrame(id, tab, f.dataUrl, f.meta);
  }

  it('is two full sessions: 1 GiB', () => {
    assert.equal(TOTAL_MAX_BYTES, 1024 * 1024 * 1024);
    assert.equal(TOTAL_MAX_BYTES, 2 * SESSION_MAX_BYTES);
  });

  it('rejects a frame that would pass the total of all sessions', async () => {
    const env = setup({ store: { totalMaxBytes: 2500 } });
    await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    env.store.open(OTHER_SESSION, TAB + 1, '', 'high');
    await rejectsWith(addTo(env, OTHER_SESSION, TAB + 1, 0), ERR.SESSION_TOO_LARGE, TOTAL_MESSAGE);
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded, 'the bitmap is closed');
    const manifest = await finishAndRead(env);
    assert.equal(manifest.slices.length, 2);
    // The session that was refused is open and empty: nothing of it was stored.
    assert.equal(env.store.ping().sessions, 2);
  });

  it('allows a total that equals the limit', async () => {
    const env = setup({ store: { totalMaxBytes: 3000 } });
    await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    env.store.open(OTHER_SESSION, TAB + 1, '', 'high');
    const result = await addTo(env, OTHER_SESSION, TAB + 1, 0);
    assert.equal(result.storedBytes, 1000);
  });

  it('counts a finished session that waits for its result page, until it is released', async () => {
    const env = setup({ store: { totalMaxBytes: 2500 } });
    await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    await env.store.finish(SESSION, TAB);
    env.store.open(OTHER_SESSION, TAB + 1, '', 'high');
    await rejectsWith(addTo(env, OTHER_SESSION, TAB + 1, 0), ERR.SESSION_TOO_LARGE, TOTAL_MESSAGE);
    env.store.release(SESSION);
    const result = await addTo(env, OTHER_SESSION, TAB + 1, 0);
    assert.equal(result.sliceCount, 1);
  });

  it('is free again after a cancel', async () => {
    const env = setup({ store: { totalMaxBytes: 2500 } });
    await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    env.store.open(OTHER_SESSION, TAB + 1, '', 'high');
    await rejectsWith(addTo(env, OTHER_SESSION, TAB + 1, 0), ERR.SESSION_TOO_LARGE);
    env.store.drop(SESSION, TAB);
    assert.equal((await addTo(env, OTHER_SESSION, TAB + 1, 0)).sliceCount, 1);
  });

  it('gives the message of the session limit when both limits are passed', async () => {
    const env = setup({ store: { maxBytes: 1500, totalMaxBytes: 1500 } });
    await capture(env, [{ contentY: 0 }]);
    await rejectsWith(
      add(env.store, frame({ contentY: STEP })),
      ERR.SESSION_TOO_LARGE,
      'This capture is too large. Finish now to keep what you have.',
    );
  });

  it('counts the frame of another session that was stored while this one waited', async () => {
    const env = setup({ store: { totalMaxBytes: 1500 } });
    env.store.open(SESSION, TAB, '', 'high');
    env.store.open(OTHER_SESSION, TAB + 1, '', 'high');
    const hold = env.fake.holdNextDecode();
    const slow = addTo(env, SESSION, TAB, 0); // Waits in decode.
    const fast = addTo(env, OTHER_SESSION, TAB + 1, 0); // Is stored first: 1000 of 1500.
    assert.equal((await fast).index, 0);
    hold.release();
    await rejectsWith(slow, ERR.SESSION_TOO_LARGE, TOTAL_MESSAGE);
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded);
  });
});

describe('addFrame: height limit', () => {
  const MAX_LENGTH = 'The capture reached its maximum length. Finish now to keep what you have.';

  it('is 300,000 device px', () => {
    assert.equal(MAX_TOTAL_HEIGHT_PX, 300_000);
  });

  it('rejects a frame that would make the image taller, and keeps the stored ones', async () => {
    const env = setup({ store: { maxHeightPx: 1500 } });
    const results = await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    assert.equal(results[1]?.totalHeightPx, 1120);
    await rejectsWith(
      add(env.store, frame({ contentY: 2 * STEP })), // Would be 1640.
      ERR.SESSION_TOO_LARGE,
      MAX_LENGTH,
    );
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded, 'the bitmap is closed');
    const manifest = await finishAndRead(env);
    assert.equal(manifest.slices.length, 2);
    assert.equal(manifest.totalHeightPx, 1120);
  });

  it('allows a height that equals the limit', async () => {
    const env = setup({ store: { maxHeightPx: 1640 } });
    const results = await capture(env, [
      { contentY: 0 },
      { contentY: STEP },
      { contentY: 2 * STEP },
    ]);
    assert.equal(results[2]?.totalHeightPx, 1640);
    await rejectsWith(
      add(env.store, frame({ contentY: 3 * STEP })),
      ERR.SESSION_TOO_LARGE,
      MAX_LENGTH,
    );
  });

  it('limits the height upward too, and from either end', async () => {
    const env = setup({ store: { maxHeightPx: 1120 } });
    await capture(env, [
      { contentY: 2000, direction: 'initial' },
      { contentY: 2000 - STEP, direction: 'up' },
    ]);
    await rejectsWith(
      add(env.store, frame({ contentY: 2000 - 2 * STEP, direction: 'up' })),
      ERR.SESSION_TOO_LARGE,
      MAX_LENGTH,
    );
    // A frame inside the image does not make it taller.
    const inside = await add(env.store, frame({ contentY: 2000 - 300, direction: 'up' }));
    assert.equal(inside.totalHeightPx, 1120);
  });

  it('refuses a first frame that is taller than the limit', async () => {
    const env = setup({ store: { maxHeightPx: 500 } });
    env.store.open(SESSION, TAB, '', 'high');
    await rejectsWith(
      add(env.store, frame({ contentY: 0, direction: 'initial' })),
      ERR.SESSION_TOO_LARGE,
      MAX_LENGTH,
    );
    assert.equal(env.store.ping().sessions, 1, 'the session stays open');
  });

  it('checks the final place of a frame, after the seam correction', async () => {
    // At the expected place the image would be exactly as tall as the limit (1120 rows). The
    // seam says that the frame sits 7 rows lower, so it would be 1127 rows.
    const env = setup({ store: { maxHeightPx: 1120 } });
    await capture(env, [{ contentY: 0 }]);
    await rejectsWith(
      add(env.store, frame({ contentY: STEP, drift: 7 })),
      ERR.SESSION_TOO_LARGE,
      MAX_LENGTH,
    );
    const ok = await add(env.store, frame({ contentY: STEP, drift: -7 }));
    assert.equal(ok.seam.shiftPx, -7);
    assert.equal(ok.totalHeightPx, STEP - 7 + 600);
  });

  it('lets the user finish after a refused frame', async () => {
    const env = setup({ store: { maxHeightPx: 1120 } });
    await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    await rejectsWith(add(env.store, frame({ contentY: 2 * STEP })), ERR.SESSION_TOO_LARGE);
    const manifest = await finishAndRead(env);
    assert.equal(manifest.totalHeightPx, 1120);
    assert.deepEqual(manifest.warnings, []);
  });

  it('uses the default limit when no option is given', async () => {
    // Touching frames of 800 rows: 375 of them are exactly 300,000 rows. No seam work.
    const rect = { x: 0, y: 0, width: 1000, height: 800 };
    const env = setup();
    env.store.open(SESSION, TAB, '', 'high');
    let last;
    for (let k = 0; k < 375; k++) last = await add(env.store, frame({ contentY: k * 800, rect }));
    assert.equal(last?.totalHeightPx, MAX_TOTAL_HEIGHT_PX);
    await rejectsWith(
      add(env.store, frame({ contentY: 375 * 800, rect })),
      ERR.SESSION_TOO_LARGE,
      MAX_LENGTH,
    );
  });
});

describe('addFrame: a page that jumps', () => {
  it('refuses a frame that neither overlaps nor touches the covered rows', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    await rejectsWith(add(env.store, frame({ contentY: 700 })), ERR.CAPTURE_FAILED, MSG_JUMP);
    await rejectsWith(add(env.store, frame({ contentY: 601 })), ERR.CAPTURE_FAILED, MSG_JUMP);
    await rejectsWith(add(env.store, frame({ contentY: 5_000_000 })), ERR.CAPTURE_FAILED, MSG_JUMP);
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded, 'the bitmaps are closed');
    assert.equal(env.fake.stats.blobs.length, 1, 'no crop for a refused frame');
    const manifest = await finishAndRead(env);
    assert.equal(manifest.slices.length, 1);
    assert.equal(manifest.totalHeightPx, 600);
    assert.deepEqual(manifest.warnings, []);
  });

  it('accepts a frame that touches the bottom, and warns that the join is unchecked', async () => {
    const env = setup();
    const results = await capture(env, [{ contentY: 0 }, { contentY: 600 }]);
    assert.equal(results[1]?.seam.status, 'unmatched');
    assert.equal(results[1]?.seam.meanDiff, 255);
    assert.equal(results[1]?.totalHeightPx, 1200);
    assert.deepEqual((await finishAndRead(env)).warnings, [
      'Spool could not verify 1 seam, near step 2. Check that area.',
    ]);
  });

  it('accepts a frame that touches the top, and refuses one row further', async () => {
    const env = setup();
    await capture(env, [{ contentY: 2000, direction: 'initial' }]);
    const touching = await add(env.store, frame({ contentY: 1400, direction: 'up' }));
    assert.equal(touching.seam.status, 'unmatched');
    // The stretch starts at 1400 now. A slice of 600 rows that ends at 1399 leaves one row.
    await rejectsWith(
      add(env.store, frame({ contentY: 799, direction: 'up' })),
      ERR.CAPTURE_FAILED,
      MSG_JUMP,
    );
    const next = await add(env.store, frame({ contentY: 800, direction: 'up' }));
    assert.equal(next.totalHeightPx, 1800);
  });

  it('compares with the whole covered stretch, not with the first or the last slice', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }, { contentY: STEP }, { contentY: 2 * STEP }]);
    // The stretch is 0 to 1640. A frame at 1640 touches its end, one at 1641 does not.
    await rejectsWith(add(env.store, frame({ contentY: 1641 })), ERR.CAPTURE_FAILED, MSG_JUMP);
    const touching = await add(env.store, frame({ contentY: 1640 }));
    assert.equal(touching.totalHeightPx, 2240);
    // A frame in the middle overlaps the stored slices there.
    const middle = await add(env.store, frame({ contentY: 300 }));
    assert.notEqual(middle.index, -1);
  });

  it('accepts the first frame at any position, also a very high one', async () => {
    const env = setup();
    const results = await capture(env, [{ contentY: 9_999_999 }, { contentY: 9_999_999 + STEP }]);
    assert.equal(results[1]?.seam.status, 'exact');
  });

  it('counts a refused frame as activity, stores nothing and uses no index', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    env.timers.advance(29 * MINUTE_MS);
    await rejectsWith(add(env.store, frame({ contentY: 9_000_000 })), ERR.CAPTURE_FAILED, MSG_JUMP);
    env.timers.advance(29 * MINUTE_MS);
    assert.equal(env.store.ping().sessions, 1, 'the refused frame counted as activity');
    const next = await add(env.store, frame({ contentY: 2 * STEP }));
    assert.equal(next.index, 2, 'a refused frame does not use an index');
    assert.equal(next.storedBytes, 3 * BLOB_BYTES);
  });

  it('keeps the stored slices free of gaps, whatever the order and jumps (seeded)', async () => {
    let seed = 20_261_106;
    const random = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    const env = setup();
    env.store.open(SESSION, TAB, '', 'high');
    // The model: the covered stretch [top, bottom) and the stored positions, with scale 1.
    /** @type {number[]} */
    const placed = [];
    let top = 0;
    let bottom = 0;
    let accepted = 0;
    let jumps = 0;
    for (let k = 0; k < 240; k++) {
      const anchor =
        placed.length === 0 ? 3000 : (placed[Math.floor(random() * placed.length)] ?? 0);
      // Most frames land near a stored one. Some jump up to 30,000 rows either way.
      const reach = random() < 0.3 ? 60_000 : 1100;
      const contentY = Math.max(-1, Math.round(anchor + (random() - 0.5) * reach));
      const direction = random() < 0.5 ? 'down' : 'up';
      const duplicate = placed.some((y) => Math.abs(y - contentY) <= 1);
      const joins = placed.length === 0 || (contentY <= bottom && contentY + 600 >= top);
      const f = frame({ contentY, direction });
      if (duplicate) {
        assert.equal((await add(env.store, f)).seam.status, 'duplicate', `frame ${k}`);
      } else if (joins) {
        const result = await add(env.store, f);
        assert.notEqual(result.index, -1, `frame ${k} at ${contentY}`);
        top = placed.length === 0 ? contentY : Math.min(top, contentY);
        bottom = placed.length === 0 ? contentY + 600 : Math.max(bottom, contentY + 600);
        placed.push(contentY);
        accepted += 1;
        assert.equal(result.totalHeightPx, bottom - top, `height after frame ${k}`);
      } else {
        await rejectsWith(add(env.store, f), ERR.CAPTURE_FAILED, MSG_JUMP);
        jumps += 1;
      }
    }
    assert.ok(accepted > 20 && jumps > 20, `accepted ${accepted}, refused ${jumps}`);
    const manifest = await finishAndRead(env);
    assert.equal(manifest.totalHeightPx, bottom - top);
    assert.ok(
      manifest.warnings.every((w) => !/gap/.test(w)),
      manifest.warnings.join(' | '),
    );
    // No gap in the manifest: each slice starts at or above the lowest row covered so far.
    let reach = 0;
    for (const slice of manifest.slices) {
      assert.ok(slice.yPx <= reach, `gap before slice ${slice.index}`);
      reach = Math.max(reach, slice.yPx + slice.heightPx);
    }
    assert.equal(reach, manifest.totalHeightPx);
  });
});

describe('concurrency', () => {
  it('stores frames of a session in call order, also when a decode is slow', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, '', 'high');
    const first = env.fake.holdNextDecode();
    const p0 = add(env.store, frame({ contentY: 0, direction: 'initial' }));
    const p1 = add(env.store, frame({ contentY: STEP }));
    await tick();
    first.release();
    const [r0, r1] = await Promise.all([p0, p1]);
    assert.equal(r0.index, 0);
    assert.equal(r0.seam.status, 'first');
    assert.equal(r1.index, 1);
    assert.equal(r1.seam.status, 'exact');
  });

  it('fails the frame and closes the bitmap when the session is dropped meanwhile', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, '', 'high');
    const hold = env.fake.holdNextDecode();
    const pending = add(env.store, frame({ contentY: 0 }));
    await tick();
    assert.deepEqual(env.store.drop(SESSION, TAB), { remaining: 0 });
    hold.release();
    await rejectsWith(pending, ERR.SESSION_NOT_FOUND);
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded);
    assert.equal(env.fake.stats.blobs.length, 0);
    assert.equal(env.empty.calls, 1);
  });

  it('finish waits for the frames in progress', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, '', 'high');
    const hold = env.fake.holdNextDecode();
    const pending = add(env.store, frame({ contentY: 0 }));
    const finishing = env.store.finish(SESSION, TAB);
    await tick();
    hold.release();
    await pending;
    await finishing;
    assert.equal(env.store.takeForAssembly(SESSION, TAB).manifest.slices.length, 1);
  });
});

describe('finish, drop and expiry', () => {
  it('drops a finished session after the time to live', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    await env.store.finish(SESSION, TAB);
    await env.store.finish(SESSION, TAB);
    assert.deepEqual(
      env.timers.pending().map((timer) => timer.ms),
      [SESSION_TTL_MS],
      'finish twice leaves one timer',
    );
    assert.equal(env.store.takeForAssembly(SESSION, TAB).manifest.slices.length, 1);

    env.timers.advance(SESSION_TTL_MS - 1);
    assert.equal(env.store.ping().sessions, 1);
    env.timers.advance(1);
    assert.equal(env.store.ping().sessions, 0);
    assert.equal(env.empty.calls, 1);
    throwsWith(() => env.store.takeForAssembly(SESSION, TAB).manifest, ERR.SESSION_NOT_FOUND);
  });

  it('cancels the timer when the session is released', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    await env.store.finish(SESSION, TAB);
    assert.deepEqual(env.store.release(SESSION), { remaining: 0 });
    assert.deepEqual(env.timers.pending(), [], 'no timer is left');
    env.timers.advance(2 * SESSION_TTL_MS);
    assert.equal(env.empty.calls, 1, 'a cleared timer does nothing');
  });

  it('dropTab removes unfinished sessions of the tab and keeps finished ones', async () => {
    const env = setup();
    const { store } = env;
    store.open(SESSION, TAB, 'done', 'high');
    await add(store, frame({ contentY: 0 }));
    await store.finish(SESSION, TAB);
    store.open(OTHER_SESSION, TAB, 'running', 'high');
    store.open(THIRD_SESSION, TAB + 1, 'other tab', 'high');

    assert.deepEqual(store.dropTab(TAB), { remaining: 2 });
    assert.equal(store.takeForAssembly(SESSION, TAB).manifest.title, 'done');
    await rejectsWith(add(store, frame({ contentY: 0 }), OTHER_SESSION), ERR.SESSION_NOT_FOUND);
    assert.equal(env.empty.calls, 0);
    assert.deepEqual(store.dropTab(999), { remaining: 2 });
  });

  it('calls onEmpty when the last session goes away, and only then', async () => {
    const env = setup();
    const { store } = env;
    assert.deepEqual(store.drop(SESSION, TAB), { remaining: 0 });
    assert.deepEqual(store.release(SESSION), { remaining: 0 });
    assert.equal(env.empty.calls, 0, 'an unknown id on an empty store is no event');

    store.open(SESSION, TAB, '', 'high');
    store.open(OTHER_SESSION, TAB + 1, '', 'high');
    assert.deepEqual(store.drop(SESSION, TAB), { remaining: 1 });
    assert.equal(env.empty.calls, 0);
    assert.deepEqual(store.dropTab(TAB + 1), { remaining: 0 });
    assert.equal(env.empty.calls, 1);
    assert.deepEqual(store.drop(OTHER_SESSION, TAB + 1), { remaining: 0 });
    assert.equal(env.empty.calls, 1);
    assert.deepEqual(store.ping(), { sessions: 0 });
  });

  it('does not let a failing onEmpty break drop or release', async () => {
    const store = createSessionStore({
      imageOps: createFake().ops,
      onEmpty: () => {
        throw new Error('boom');
      },
    });
    store.open(SESSION, TAB, '', 'high');
    assert.deepEqual(store.drop(SESSION, TAB), { remaining: 0 });
    store.open(SESSION, TAB, '', 'high');
    await store.finish(SESSION, TAB);
    assert.deepEqual(store.release(SESSION), { remaining: 0 });
  });
});

describe('drop (cancel) and release', () => {
  /**
   * Two sessions on two tabs: SESSION on TAB is finished, OTHER_SESSION on TAB + 1 is running.
   * Both hold one slice.
   */
  async function twoSessions() {
    const env = setup();
    const { store } = env;
    store.open(SESSION, TAB, 'finished', 'high');
    await add(store, frame({ contentY: 0 }));
    await store.finish(SESSION, TAB);
    store.open(OTHER_SESSION, TAB + 1, 'running', 'high');
    await store.addFrame(
      OTHER_SESSION,
      TAB + 1,
      frame({ contentY: 0 }).dataUrl,
      frame({ contentY: 0 }).meta,
    );
    return env;
  }

  describe('drop(sessionId, tabId)', () => {
    it('removes an unfinished session of that tab, with its timer, and reports empty', async () => {
      const env = setup();
      await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
      assert.equal(env.timers.pending().length, 1);
      assert.deepEqual(env.store.drop(SESSION, TAB), { remaining: 0 });
      assert.deepEqual(env.timers.pending(), []);
      assert.equal(env.empty.calls, 1);
      await rejectsWith(add(env.store, frame({ contentY: 2 * STEP })), ERR.SESSION_NOT_FOUND);
      await rejectsWith(env.store.finish(SESSION, TAB), ERR.SESSION_NOT_FOUND);
    });

    it('does nothing for a session of another tab: no error, nothing removed', async () => {
      const env = await twoSessions();
      const timers = env.timers.pending().length;
      assert.deepEqual(env.store.drop(OTHER_SESSION, TAB), { remaining: 2 }, 'wrong tab');
      assert.deepEqual(env.store.drop(OTHER_SESSION, TAB + 2), { remaining: 2 });
      assert.equal(env.empty.calls, 0);
      assert.equal(env.timers.pending().length, timers, 'its timer still runs');
      // The session is intact and goes on.
      const next = await env.store.addFrame(
        OTHER_SESSION,
        TAB + 1,
        frame({ contentY: STEP }).dataUrl,
        frame({ contentY: STEP }).meta,
      );
      assert.equal(next.sliceCount, 2);
    });

    it('does nothing for a finished session, also from its own tab', async () => {
      const env = await twoSessions();
      assert.deepEqual(env.store.drop(SESSION, TAB), { remaining: 2 });
      assert.deepEqual(env.store.drop(SESSION, TAB + 1), { remaining: 2 });
      assert.equal(env.store.takeForAssembly(SESSION, TAB).manifest.slices.length, 1, 'still readable');
      assert.equal(env.store.ping().sessions, 2);
      assert.equal(env.empty.calls, 0);
      assert.ok(
        env.timers.pending().some((timer) => timer.ms === SESSION_TTL_MS),
        'the time to live still runs',
      );
    });

    it('does nothing for an unknown session, and can be repeated', async () => {
      const env = await twoSessions();
      assert.deepEqual(env.store.drop(THIRD_SESSION, TAB), { remaining: 2 });
      assert.deepEqual(env.store.drop(OTHER_SESSION, TAB + 1), { remaining: 1 });
      assert.deepEqual(env.store.drop(OTHER_SESSION, TAB + 1), { remaining: 1 });
    });

    it('still cancels a session whose finish waits for a frame in progress', async () => {
      const env = setup();
      env.store.open(SESSION, TAB, '', 'high');
      const hold = env.fake.holdNextDecode();
      const outcomes = [
        rejectsWith(add(env.store, frame({ contentY: 0 })), ERR.SESSION_NOT_FOUND),
        rejectsWith(env.store.finish(SESSION, TAB), ERR.SESSION_NOT_FOUND),
      ];
      await tick();
      // It is unfinished until the frame is done, so a cancel from its tab works. A release
      // does not (see below).
      assert.deepEqual(env.store.release(SESSION), { remaining: 1 });
      assert.deepEqual(env.store.drop(SESSION, TAB), { remaining: 0 });
      hold.release();
      await Promise.all(outcomes);
    });
  });

  describe('release(sessionId)', () => {
    it('removes a finished session, with its timer, and reports empty', async () => {
      const env = setup();
      await capture(env, [{ contentY: 0 }]);
      await env.store.finish(SESSION, TAB);
      assert.deepEqual(env.store.release(SESSION), { remaining: 0 });
      assert.deepEqual(env.timers.pending(), []);
      assert.equal(env.empty.calls, 1);
      throwsWith(() => env.store.takeForAssembly(SESSION, TAB).manifest, ERR.SESSION_NOT_FOUND);
    });

    it('takes no tab: the result page is in another tab than the capture', async () => {
      const env = await twoSessions();
      assert.deepEqual(env.store.release(SESSION), { remaining: 1 });
      assert.equal(env.empty.calls, 0);
    });

    it('does nothing for an unfinished session: it stays open and keeps its timer', async () => {
      const env = await twoSessions();
      const idle = env.timers.pending().filter((timer) => timer.ms === SESSION_IDLE_MS);
      assert.equal(idle.length, 1);
      assert.deepEqual(env.store.release(OTHER_SESSION), { remaining: 2 });
      assert.equal(env.empty.calls, 0);
      assert.equal(idle[0]?.cancelled, false);
      const next = await env.store.addFrame(
        OTHER_SESSION,
        TAB + 1,
        frame({ contentY: STEP }).dataUrl,
        frame({ contentY: STEP }).meta,
      );
      assert.equal(next.sliceCount, 2, 'the capture goes on');
      await env.store.finish(OTHER_SESSION, TAB + 1);
      assert.deepEqual(env.store.release(OTHER_SESSION), { remaining: 1 }, 'now it is finished');
    });

    it('does nothing for an unknown session, and can be repeated', async () => {
      const env = await twoSessions();
      assert.deepEqual(env.store.release(THIRD_SESSION), { remaining: 2 });
      assert.deepEqual(env.store.release(SESSION), { remaining: 1 });
      assert.deepEqual(env.store.release(SESSION), { remaining: 1 });
      assert.equal(env.empty.calls, 0);
    });
  });
});

describe('idle timeout of an unfinished session', () => {
  it('is 30 minutes', () => {
    assert.equal(SESSION_IDLE_MS, 30 * MINUTE_MS);
  });

  it('starts at open: one timer, and it uses the idle time', () => {
    const env = setup();
    assert.deepEqual(env.timers.pending(), []);
    env.store.open(SESSION, TAB, '', 'high');
    assert.deepEqual(
      env.timers.pending().map((timer) => timer.ms),
      [SESSION_IDLE_MS],
    );
  });

  it('drops a session that gets no frame, and tells the owner of the store', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }, { contentY: STEP }]);
    env.timers.advance(SESSION_IDLE_MS - 1);
    assert.equal(env.store.ping().sessions, 1, 'alive 1 ms before the time');
    assert.equal(env.empty.calls, 0);
    env.timers.advance(1);
    assert.equal(env.store.ping().sessions, 0);
    assert.equal(env.empty.calls, 1);
    assert.deepEqual(env.timers.pending(), []);
    await rejectsWith(add(env.store, frame({ contentY: 2 * STEP })), ERR.SESSION_NOT_FOUND);
    await rejectsWith(env.store.finish(SESSION, TAB), ERR.SESSION_NOT_FOUND);
    throwsWith(() => env.store.takeForAssembly(SESSION, TAB).manifest, ERR.SESSION_NOT_FOUND);
  });

  it('restarts at every frame', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, '', 'high');
    env.timers.advance(29 * MINUTE_MS);
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    env.timers.advance(29 * MINUTE_MS);
    assert.equal(env.store.ping().sessions, 1, '58 minutes after open, 29 after the frame');
    await add(env.store, frame({ contentY: STEP }));
    assert.equal(env.timers.pending().length, 1, 'still one timer');
    env.timers.advance(SESSION_IDLE_MS - 1);
    assert.equal(env.store.ping().sessions, 1);
    env.timers.advance(1);
    assert.equal(env.store.ping().sessions, 0);
  });

  it('restarts for a frame that fails, and for a frame that waits for its turn', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    env.timers.advance(29 * MINUTE_MS);
    await rejectsWith(add(env.store, frame({ contentY: STEP, scale: 1.5 })), ERR.CAPTURE_FAILED);
    env.timers.advance(29 * MINUTE_MS);
    assert.equal(env.store.ping().sessions, 1, 'the zoom error counted as activity');
    const hold = env.fake.holdNextDecode();
    const pending = add(env.store, frame({ contentY: STEP }));
    env.timers.advance(29 * MINUTE_MS);
    hold.release();
    assert.equal((await pending).seam.status, 'exact');
    assert.equal(env.store.ping().sessions, 1);
  });

  it('does not restart for a frame of another tab or of an unknown session', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    env.timers.advance(29 * MINUTE_MS);
    const { dataUrl, meta } = frame({ contentY: STEP });
    await rejectsWith(env.store.addFrame(SESSION, TAB + 1, dataUrl, meta), ERR.SESSION_NOT_FOUND);
    await rejectsWith(env.store.addFrame(OTHER_SESSION, TAB, dataUrl, meta), ERR.SESSION_NOT_FOUND);
    env.timers.advance(MINUTE_MS);
    assert.equal(env.store.ping().sessions, 0, 'it expired 30 minutes after the last real frame');
  });

  it('restarts when the same session is opened again, and keeps its slices', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    env.timers.advance(20 * MINUTE_MS);
    env.store.open(SESSION, TAB, 'Other title', 'high');
    assert.equal(env.timers.pending().length, 1);
    env.timers.advance(20 * MINUTE_MS);
    assert.equal(env.store.ping().sessions, 1, '40 minutes after the first open');
    assert.equal((await finishAndRead(env)).slices.length, 1);
    // A finished session has no idle timer: another open does not start one.
    env.store.open(SESSION, TAB, '', 'high');
    assert.deepEqual(
      env.timers.pending().map((timer) => timer.ms),
      [SESSION_TTL_MS],
    );
  });

  it('is stopped by finish, and the finished timeout takes over', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    env.timers.advance(10 * MINUTE_MS);
    const idleTimer = env.timers.pending()[0];
    await env.store.finish(SESSION, TAB);
    assert.equal(idleTimer?.cancelled, true);
    const [timer, ...others] = env.timers.pending();
    assert.equal(others.length, 0);
    assert.equal(timer?.ms, SESSION_TTL_MS);
    // The finished timeout counts from finish, not from the last frame.
    env.timers.advance(SESSION_TTL_MS - 1);
    assert.equal(env.store.takeForAssembly(SESSION, TAB).manifest.slices.length, 1);
    env.timers.advance(1);
    assert.equal(env.store.ping().sessions, 0);
    // One removal, one event: the stopped idle timer does not fire later.
    env.timers.advance(2 * SESSION_IDLE_MS);
    assert.equal(env.empty.calls, 1);
  });

  it('is not started again by a frame that arrives after finish', async () => {
    const env = setup();
    await capture(env, [{ contentY: 0 }]);
    await env.store.finish(SESSION, TAB);
    await rejectsWith(add(env.store, frame({ contentY: STEP })), ERR.SESSION_NOT_FOUND);
    assert.deepEqual(
      env.timers.pending().map((timer) => timer.ms),
      [SESSION_TTL_MS],
    );
  });

  it('is stopped by drop and by dropTab', () => {
    const env = setup();
    const { store } = env;
    store.open(SESSION, TAB, '', 'high');
    store.open(OTHER_SESSION, TAB + 1, '', 'high');
    store.open(THIRD_SESSION, TAB + 2, '', 'high');
    assert.equal(env.timers.pending().length, 3);
    assert.deepEqual(store.dropTab(TAB), { remaining: 2 });
    assert.equal(env.timers.pending().length, 2);
    assert.deepEqual(store.drop(OTHER_SESSION, TAB + 1), { remaining: 1 });
    assert.equal(env.timers.pending().length, 1);
    assert.deepEqual(store.drop(THIRD_SESSION, TAB + 2), { remaining: 0 });
    assert.deepEqual(env.timers.pending(), []);
    env.timers.advance(2 * SESSION_IDLE_MS);
    assert.equal(env.empty.calls, 1, 'only the last drop was an event');
  });

  it('drops one session at a time and reports empty only for the last', () => {
    const env = setup();
    const { store } = env;
    store.open(SESSION, TAB, '', 'high');
    env.timers.advance(10 * MINUTE_MS);
    store.open(OTHER_SESSION, TAB + 1, '', 'high');
    env.timers.advance(20 * MINUTE_MS);
    assert.equal(store.ping().sessions, 1, 'the older session expired');
    assert.equal(env.empty.calls, 0);
    env.timers.advance(10 * MINUTE_MS);
    assert.equal(store.ping().sessions, 0);
    assert.equal(env.empty.calls, 1);
  });

  it('fails a frame in progress when the session expires, and closes its bitmap', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, '', 'high');
    const hold = env.fake.holdNextDecode();
    const pending = add(env.store, frame({ contentY: 0 }));
    await tick();
    env.timers.advance(SESSION_IDLE_MS);
    assert.equal(env.store.ping().sessions, 0);
    hold.release();
    await rejectsWith(pending, ERR.SESSION_NOT_FOUND);
    assert.equal(env.fake.stats.closed, env.fake.stats.decoded);
    assert.equal(env.fake.stats.blobs.length, 0);
    assert.equal(env.empty.calls, 1);
  });

  it('uses the idleMs option', () => {
    const env = setup({ store: { idleMs: 5000 } });
    env.store.open(SESSION, TAB, '', 'high');
    assert.deepEqual(
      env.timers.pending().map((timer) => timer.ms),
      [5000],
    );
    env.timers.advance(5000);
    assert.equal(env.store.ping().sessions, 0);
  });
});

describe('manifest', () => {
  it('needs a finished session with at least one slice', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, '', 'high');
    throwsWith(() => env.store.takeForAssembly(SESSION, TAB).manifest, ERR.SESSION_NOT_FOUND);
    await env.store.finish(SESSION, TAB);
    throwsWith(() => env.store.takeForAssembly(SESSION, TAB).manifest, ERR.CAPTURE_FAILED);
    throwsWith(() => env.store.takeForAssembly(OTHER_SESSION, TAB).manifest, ERR.SESSION_NOT_FOUND);
  });

  it('normalizes the positions so that the first slice is at 0', async () => {
    const env = setup();
    await capture(env, [
      { contentY: 2000, direction: 'initial' },
      { contentY: 2000 - STEP, direction: 'up' },
    ]);
    const manifest = await finishAndRead(env);
    assert.deepEqual(manifest.slices, [
      { index: 1, yPx: 0, heightPx: 600, seamStatus: 'exact' },
      { index: 0, yPx: STEP, heightPx: 600, seamStatus: 'first' },
    ]);
    assert.equal(manifest.totalHeightPx, STEP + 600);
  });

  it('normalizes a first slice with a negative position', async () => {
    const env = setup();
    await capture(env, [{ contentY: -1, direction: 'initial' }, { contentY: STEP }]);
    const manifest = await finishAndRead(env);
    assert.deepEqual(
      manifest.slices.map((s) => s.yPx),
      [0, STEP + 1],
    );
    assert.equal(manifest.totalHeightPx, STEP + 1 + 600);
  });
});

describe('dataUrlToBlob', () => {
  it('decodes a PNG data URL without a network call', async () => {
    const bytes = Uint8Array.from([0, 1, 2, 3, 250, 251, 255, 128, 64]);
    const blob = dataUrlToBlob(PNG_PREFIX + Buffer.from(bytes).toString('base64'));
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), bytes);
  });

  it('rejects other data URLs', () => {
    assert.throws(
      () => dataUrlToBlob('data:text/plain;base64,AAAA'),
      (e) => isSpoolError(e, ERR.CAPTURE_FAILED),
    );
  });
});

// ---------------------------------------------------------------------------------------------
// The offscreen document itself: message in, reply out
// ---------------------------------------------------------------------------------------------

describe('offscreen document: messages', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  before(async () => {
    // offscreen.js registers its listener when it loads, so the fake must exist before.
    fake = installFakeChrome();
    await import('../../src/offscreen/offscreen.js');
  });
  after(() => {
    fake.uninstall();
  });

  const WORKER = { id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}${PATHS.serviceWorker}` };
  const RESULT = {
    id: EXTENSION_ID,
    url: `${EXTENSION_ORIGIN}${PATHS.result}#x`,
    tab: { id: 99 },
  };
  const CONTENT = {
    id: EXTENSION_ID,
    url: 'https://example.com/',
    tab: { id: TAB, windowId: 1 },
    frameId: 0,
  };

  /**
   * Delivers a message like Chrome does and returns the reply.
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @param {unknown} [sender]
   * @returns {Promise<any>}
   */
  function deliver(type, fields, sender = WORKER) {
    return new Promise((resolve) => {
      const kept = fake.events.message.dispatch(makeMessage(type, fields), sender, resolve);
      if (!kept.includes(true)) resolve(undefined); // Ignored, or already answered.
    });
  }

  const sessions = async () => (await deliver(MSG.OFF_PING, {})).sessions;
  const open = (/** @type {string} */ id, tabId = TAB) =>
    deliver(MSG.OFF_SESSION_OPEN, {
      sessionId: id,
      tabId,
      title: 't',
      host: 'example.com',
      tileTier: 'high',
    });
  const finalize = (/** @type {string} */ id, tabId = TAB) =>
    deliver(MSG.OFF_FINALIZE, {
      sessionId: id,
      tabId,
      saveTiles: true,
      saveFull: true,
      folderName: 'Spool',
    });
  const drop = (/** @type {string} */ id, tabId = TAB) =>
    deliver(MSG.OFF_SESSION_DROP, { sessionId: id, tabId });

  it('starts empty', async () => {
    assert.equal(await sessions(), 0);
  });

  it('answers a cancel from another tab with ok, and leaves the session alone', async () => {
    await open(SESSION);
    assert.deepEqual(await drop(SESSION, TAB + 1), { ok: true, remaining: 1 });
    assert.equal(await sessions(), 1);
    assert.deepEqual(await drop(SESSION), { ok: true, remaining: 0 });
  });

  it('answers a cancel from its own tab with the sessions that are left', async () => {
    await open(SESSION);
    await open(OTHER_SESSION, TAB + 1);
    assert.deepEqual(await drop(SESSION), { ok: true, remaining: 1 });
    assert.equal(await finalize(SESSION).then((r) => r.error.code), ERR.SESSION_NOT_FOUND);
    assert.deepEqual(await drop(OTHER_SESSION, TAB + 1), { ok: true, remaining: 0 });
  });

  it('frees a capture with no frame when it is finalized: there is nothing to retry', async () => {
    await open(SESSION);
    assert.equal(await finalize(SESSION).then((r) => r.error.code), ERR.CAPTURE_FAILED);
    assert.equal(await sessions(), 0);
  });

  it('answers a drop of an unknown session with ok, also twice', async () => {
    assert.deepEqual(await drop(THIRD_SESSION), { ok: true, remaining: 0 });
    assert.deepEqual(await drop(THIRD_SESSION), { ok: true, remaining: 0 });
  });

  it('tells the worker when the last session is gone after a cancel', async () => {
    const idleMessages = () =>
      fake
        .argsOf('runtime.sendMessage')
        .filter((a) => /** @type {any} */ (a[0]).type === MSG.SW_OFFSCREEN_IDLE).length;
    const baseline = idleMessages();
    await open(SESSION);
    await drop(SESSION);
    assert.equal(idleMessages(), baseline + 1);
    await drop(SESSION); // A no-op: no event.
    assert.equal(idleMessages(), baseline + 1);
  });

  it('refuses the old drop without a tab', async () => {
    await open(SESSION);
    assert.deepEqual(await deliver(MSG.OFF_SESSION_DROP, { sessionId: SESSION }), {
      ok: false,
      error: { code: ERR.BAD_MESSAGE, message: 'Bad field: tabId' },
    });
    assert.equal(await sessions(), 1);
    await drop(SESSION);
  });

  it('does not know the messages that nothing sends any more', async () => {
    await open(SESSION);
    for (const type of [
      'offscreen/session-finish',
      'offscreen/session-release',
      'offscreen/get-manifest',
      'offscreen/get-slice',
    ]) {
      /** @type {any} */
      const reply = await new Promise((resolve) => {
        const raw = { v: PROTOCOL_VERSION, target: TARGET.OFFSCREEN, type, sessionId: SESSION };
        const kept = fake.events.message.dispatch(raw, WORKER, resolve);
        if (!kept.includes(true)) resolve(undefined);
      });
      assert.ok(reply === undefined || reply.ok === false, type);
    }
    assert.equal(await sessions(), 1, 'nothing was removed');
    await drop(SESSION);
  });

  it('refuses drop from every sender except the worker', async () => {
    await open(SESSION);
    const noUrl = { id: EXTENSION_ID }; // The old "no URL, no tab" worker: not trusted any more.
    for (const sender of [RESULT, CONTENT, noUrl, { id: 'other-extension' }]) {
      const reply = await deliver(MSG.OFF_SESSION_DROP, { sessionId: SESSION, tabId: TAB }, sender);
      assert.equal(reply.ok, false);
      assert.equal(reply.error.code, ERR.FORBIDDEN_SENDER);
    }
    assert.equal(await sessions(), 1, 'nothing was removed');
    await drop(SESSION);
  });
});
