// @ts-check
/**
 * Tests added by mutation testing for the offscreen
 * document: each one pins behaviour that a mutation run (one changed operator, constant or
 * statement at a time) showed to be unchecked by the older tests. The session store, finalize,
 * the saver, the folder writer, the last capture, the shelf tokens and `dataUrlToBlob`.
 *
 * Every test names the rule it protects. None uses a real timer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { pickFreeBase, writeFiles } from '../../src/offscreen/folder-writer.js';
import { createFinalizer } from '../../src/offscreen/finalize.js';
import { dataUrlToBlob } from '../../src/offscreen/image-ops.js';
import { createLastCapture, pickOutput } from '../../src/offscreen/last-capture.js';
import { createSaver } from '../../src/offscreen/save.js';
import { createSessionStore } from '../../src/offscreen/session-store.js';
import { createShelfTokens } from '../../src/offscreen/shelf-tokens.js';
import { captureFiles } from '../../src/lib/names.js';
import { SIGNATURE_MAX_COLS } from '../../src/shared/constants.js';
import { ERR, SpoolError } from '../../src/shared/protocol.js';

// ---------------------------------------------------------------------------------------------
// Fakes for the session store (the same model as offscreen-store.test.js: a "data URL" holds JSON)
// ---------------------------------------------------------------------------------------------

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TAB = 7;
const PNG_PREFIX = 'data:image/png;base64,';
const VIEWPORT = Object.freeze({ width: 1000, height: 800 });
const RECT = Object.freeze({ x: 0, y: 100, width: 1000, height: 600 });
const BLOB_BYTES = 1000;

/** @param {number} row @param {number} col */
function noise(row, col) {
  let h = (Math.imul(row, 374761393) + Math.imul(col, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) & 255;
}

/**
 * @param {{ blobSize?: number, decodeError?: unknown, holdCrop?: boolean }} [options]
 */
function createFake({ blobSize = BLOB_BYTES, decodeError, holdCrop = false } = {}) {
  const stats = {
    decoded: 0,
    closed: 0,
    /** @type {(() => void) | null} */
    releaseCrop: null,
    /** @type {Promise<void> | null} */
    decodeGate: null,
  };
  const ops = {
    /** @param {string} dataUrl */
    async decode(dataUrl) {
      if (decodeError !== undefined) throw decodeError;
      if (stats.decodeGate !== null) await stats.decodeGate;
      const spec = JSON.parse(Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64').toString());
      stats.decoded += 1;
      return {
        widthPx: spec.w,
        heightPx: spec.h,
        /** @param {{ sx: number, sy: number, sw: number, sh: number }} box */
        async crop(box) {
          if (holdCrop) {
            await new Promise((resolve) => {
              stats.releaseCrop = () => resolve(undefined);
            });
          }
          const cols = Math.min(SIGNATURE_MAX_COLS, box.sw);
          const signature = new Uint8Array(box.sh * cols);
          for (let r = 0; r < box.sh; r++) {
            for (let c = 0; c < cols; c++) signature[r * cols + c] = noise(spec.origin + box.sy + r, c);
          }
          return {
            blob: new Blob([new Uint8Array(blobSize)]),
            signature,
            cols,
            width: box.sw,
            height: box.sh,
          };
        },
        close() {
          stats.closed += 1;
        },
      };
    },
  };
  return { ops, stats };
}

/**
 * @param {{ contentY: number, direction?: 'initial' | 'down' | 'up', scale?: number,
 *   rect?: { x: number, y: number, width: number, height: number },
 *   viewport?: { width: number, height: number }, bitmapWidth?: number }} o
 */
function frame({
  contentY,
  direction = 'down',
  scale = 1,
  rect = RECT,
  viewport = VIEWPORT,
  bitmapWidth,
}) {
  const w = bitmapWidth ?? Math.round(viewport.width * scale);
  const h = Math.round(viewport.height * scale);
  const origin = Math.round(contentY * scale) - Math.round(rect.y * scale);
  const dataUrl = PNG_PREFIX + Buffer.from(JSON.stringify({ w, h, origin })).toString('base64');
  return {
    dataUrl,
    meta: { direction, viewport: { ...viewport }, rect: { ...rect }, contentY },
  };
}

/** Fake timers that run only on demand. @returns {{ set: (fn: () => void, ms: number) => unknown, clear: (h: unknown) => void, list: { fn: () => void, ms: number, cleared: boolean }[] }} */
function createTimers() {
  /** @type {{ fn: () => void, ms: number, cleared: boolean }[]} */
  const list = [];
  return {
    list,
    set(fn, ms) {
      const timer = { fn, ms, cleared: false };
      list.push(timer);
      return timer;
    },
    clear(handle) {
      /** @type {{ cleared: boolean }} */ (handle).cleared = true;
    },
  };
}

/**
 * @param {{ fake?: Parameters<typeof createFake>[0], store?: Record<string, unknown> }} [options]
 */
function setup(options = {}) {
  const fake = createFake(options.fake);
  const timers = createTimers();
  const empty = { calls: 0 };
  const store = createSessionStore({
    imageOps: /** @type {any} */ (fake.ops),
    setTimer: timers.set,
    clearTimer: timers.clear,
    onEmpty: () => {
      empty.calls += 1;
    },
    ...options.store,
  });
  return { store, fake, timers, empty };
}

/** @param {ReturnType<typeof createSessionStore>} store @param {ReturnType<typeof frame>} f @param {string} [id] */
function add(store, f, id = SESSION) {
  return store.addFrame(id, TAB, f.dataUrl, f.meta);
}

/** @param {Promise<unknown>} promise @param {string} code @param {string} [message] */
async function rejectsWith(promise, code, message) {
  await assert.rejects(promise, (e) => {
    assert.ok(e instanceof SpoolError, `expected a SpoolError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (message !== undefined) assert.equal(e.message, message);
    return true;
  });
}

const tick = () => new Promise((resolve) => setImmediate(resolve));

// ---------------------------------------------------------------------------------------------
// Session store
// ---------------------------------------------------------------------------------------------

describe('session store: zoom tolerance', () => {
  // A narrow area, so that the crop width stays within 2 px while the zoom differs.
  const NARROW = Object.freeze({ x: 0, y: 100, width: 100, height: 600 });

  it('accepts a frame whose zoom is 0.008 away from the first one', async () => {
    const { store } = setup();
    store.open(SESSION, TAB, 't', 'high');
    await add(store, frame({ contentY: 0, direction: 'initial', rect: NARROW }));
    const second = await add(store, frame({ contentY: 520, scale: 1.008, rect: NARROW }));
    assert.equal(second.index, 1);
  });

  it('refuses a frame whose zoom is 0.015 away: the page zoom changed', async () => {
    const { store } = setup();
    store.open(SESSION, TAB, 't', 'high');
    await add(store, frame({ contentY: 0, direction: 'initial', rect: NARROW }));
    await rejectsWith(
      add(store, frame({ contentY: 520, scale: 1.015, rect: NARROW })),
      ERR.CAPTURE_FAILED,
      'Page zoom changed. Finish now to keep what you have.',
    );
  });
});

describe('session store: placing a slice', () => {
  it('a slice that only touches the covered rows has no neighbour: unmatched, no shift, worst diff', async () => {
    const { store } = setup();
    store.open(SESSION, TAB, 't', 'high');
    await add(store, frame({ contentY: 0, direction: 'initial' }));
    const touching = await add(store, frame({ contentY: 600 }));
    assert.deepEqual(touching.seam, { status: 'unmatched', shiftPx: 0, meanDiff: 255 });
    assert.equal(touching.totalHeightPx, 1200);
  });

  it('a slice that touches the covered rows from above has no neighbour either', async () => {
    const { store } = setup();
    store.open(SESSION, TAB, 't', 'high');
    await add(store, frame({ contentY: 600, direction: 'initial' }));
    const touching = await add(store, frame({ contentY: 0, direction: 'up' }));
    assert.deepEqual(touching.seam, { status: 'unmatched', shiftPx: 0, meanDiff: 255 });
  });

  it('slices at the same position keep their arrival order in the manifest', async () => {
    const { store } = setup();
    store.open(SESSION, TAB, 't', 'high');
    await add(store, frame({ contentY: 0, direction: 'initial' }));
    // Same top, another height: not a duplicate, so it is stored next to the first one.
    const shorter = await add(store, frame({ contentY: 0, rect: { ...RECT, height: 500 } }));
    assert.equal(shorter.index, 1);
    await store.finish(SESSION, TAB);
    const { slices } = store.takeForAssembly(SESSION, TAB).manifest;
    assert.deepEqual(
      slices.map((s) => [s.index, s.yPx, s.heightPx]),
      [
        [0, 0, 600],
        [1, 0, 500],
      ],
    );
  });
});

describe('session store: image errors', () => {
  it('keeps a SpoolError of the image code as it is (the code is not replaced)', async () => {
    const own = new SpoolError(ERR.SESSION_TOO_LARGE, 'own message');
    const { store } = setup({ fake: { decodeError: own } });
    store.open(SESSION, TAB, 't', 'high');
    await assert.rejects(add(store, frame({ contentY: 0, direction: 'initial' })), (e) => {
      assert.equal(e, own);
      return true;
    });
  });

  it('turns any other failure into E_CAPTURE_FAILED and keeps the original as the cause', async () => {
    const original = new Error('bad png');
    const { store } = setup({ fake: { decodeError: original } });
    store.open(SESSION, TAB, 't', 'high');
    await assert.rejects(add(store, frame({ contentY: 0, direction: 'initial' })), (e) => {
      assert.ok(e instanceof SpoolError);
      assert.equal(e.code, ERR.CAPTURE_FAILED);
      assert.equal(e.message, 'Could not read the captured image. Try again.');
      assert.equal(e.cause, original);
      return true;
    });
  });
});

describe('session store: a frame is checked against the session as it is when its turn comes', () => {
  it('a frame that was accepted before Done, but runs after it, is refused', async () => {
    const { store, fake } = setup();
    store.open(SESSION, TAB, 't', 'high');
    await add(store, frame({ contentY: 0, direction: 'initial' }));
    // Hold the next frame at its decode, so Done and a second frame queue behind it.
    /** @type {() => void} */
    let open = () => {};
    fake.stats.decodeGate = new Promise((resolve) => {
      open = () => resolve();
    });
    const first = add(store, frame({ contentY: 520 }));
    const done = store.finish(SESSION, TAB);
    // The session is not finished yet, so the call is accepted, then queued behind Done.
    const late = add(store, frame({ contentY: 1040 }));
    open();
    await first;
    await done;
    await rejectsWith(late, ERR.SESSION_NOT_FOUND, 'This capture is finished.');
    assert.equal(store.takeForAssembly(SESSION, TAB).manifest.slices.length, 2, 'the late frame was not stored');
  });

  it('a session that is dropped while frames wait does not decode the waiting frames', async () => {
    const { store, fake } = setup();
    store.open(SESSION, TAB, 't', 'high');
    /** @type {() => void} */
    let open = () => {};
    fake.stats.decodeGate = new Promise((resolve) => {
      open = () => resolve();
    });
    const first = add(store, frame({ contentY: 0, direction: 'initial' }));
    const second = add(store, frame({ contentY: 520 }));
    await tick();
    store.drop(SESSION, TAB);
    open();
    await rejectsWith(first, ERR.SESSION_NOT_FOUND);
    await rejectsWith(second, ERR.SESSION_NOT_FOUND);
    assert.equal(fake.stats.decoded, 1, 'only the frame that was already decoding was decoded');
    assert.equal(fake.stats.closed, 1, 'its bitmap was closed');
  });

  it('a session that is dropped while a frame is being cropped rejects that frame', async () => {
    const { store, fake } = setup({ fake: { holdCrop: true } });
    store.open(SESSION, TAB, 't', 'high');
    const pending = add(store, frame({ contentY: 0, direction: 'initial' }));
    await tick();
    await tick();
    assert.ok(fake.stats.releaseCrop, 'the crop has started');
    store.drop(SESSION, TAB);
    fake.stats.releaseCrop?.();
    await rejectsWith(pending, ERR.SESSION_NOT_FOUND);
    assert.equal(store.ping().sessions, 0);
  });

  it('refuses a frame that is narrower than the session by 1 px (the window shrank)', async () => {
    const { store } = setup();
    store.open(SESSION, TAB, 't', 'high');
    await add(store, frame({ contentY: 0, direction: 'initial' }));
    // The crop width differs by 1 px (inside the 2 px tolerance), but the bitmap is narrower than
    // the session width: the crop would leave the bitmap.
    const narrower = frame({
      contentY: 520,
      viewport: { width: 999, height: 800 },
      rect: { x: 0, y: 100, width: 999, height: 600 },
    });
    await rejectsWith(
      add(store, narrower),
      ERR.CAPTURE_FAILED,
      'Page zoom changed. Finish now to keep what you have.',
    );
  });
});

describe('session store: memory limits at the exact boundary', () => {
  /** A store with blobs of 1000 bytes and the given total limit. @param {number} totalMaxBytes @param {Record<string, unknown>} [extra] */
  function limited(totalMaxBytes, extra = {}) {
    return setup({ store: { totalMaxBytes, ...extra } });
  }

  it('accepts a frame that brings the total to exactly the limit, and refuses one byte more', async () => {
    const exact = limited(2 * BLOB_BYTES);
    exact.store.open(SESSION, TAB, 't', 'high');
    await add(exact.store, frame({ contentY: 0, direction: 'initial' }));
    const second = await add(exact.store, frame({ contentY: 520 }));
    assert.equal(second.storedBytes, 2 * BLOB_BYTES);

    const over = limited(2 * BLOB_BYTES - 1);
    over.store.open(SESSION, TAB, 't', 'high');
    await add(over.store, frame({ contentY: 0, direction: 'initial' }));
    await rejectsWith(
      add(over.store, frame({ contentY: 520 })),
      ERR.SESSION_TOO_LARGE,
      'This capture is using too much memory. Finish now to keep what you have.',
    );
  });

  it('counts the bytes held outside the store, also when they are one byte', async () => {
    let held = 1;
    let released = 0;
    const env = limited(2 * BLOB_BYTES, {
      heldBytes: () => held,
      releaseHeld: () => {
        released += 1;
        held = 0;
      },
    });
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    // 1000 stored + 1 held + 1000 new = 2001 > 2000: the held byte goes first, then it fits.
    const second = await add(env.store, frame({ contentY: 520 }));
    assert.equal(released, 1, 'the held outputs were released for the new frame');
    assert.equal(second.storedBytes, 2 * BLOB_BYTES);
  });

  it('does not release the held bytes when everything fits exactly', async () => {
    let released = 0;
    const env = setup({
      fake: { blobSize: 500 },
      store: {
        totalMaxBytes: 2000,
        heldBytes: () => 1000,
        releaseHeld: () => {
          released += 1;
        },
      },
    });
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    // 500 stored + 1000 held + 500 new = 2000: exactly the limit, so nothing has to go.
    await add(env.store, frame({ contentY: 520 }));
    assert.equal(released, 0);
  });

  it('does not release anything when nothing is held', async () => {
    let released = 0;
    const env = limited(BLOB_BYTES, {
      releaseHeld: () => {
        released += 1;
      },
    });
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    await rejectsWith(add(env.store, frame({ contentY: 520 })), ERR.SESSION_TOO_LARGE);
    assert.equal(released, 0);
  });

  it('refuses when even after the release the frame does not fit, by one byte', async () => {
    let held = 500;
    const env = limited(2 * BLOB_BYTES - 1, {
      heldBytes: () => held,
      releaseHeld: () => {
        held = 0;
      },
    });
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    // After the release: 1000 stored + 0 held + 1000 new = 2000 > 1999.
    await rejectsWith(add(env.store, frame({ contentY: 520 })), ERR.SESSION_TOO_LARGE);
  });

  it('accepts after the release when the total is exactly the limit', async () => {
    let held = 500;
    const env = limited(2 * BLOB_BYTES, {
      heldBytes: () => held,
      releaseHeld: () => {
        held = 0;
      },
    });
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    const second = await add(env.store, frame({ contentY: 520 }));
    assert.equal(second.sliceCount, 2);
  });

  it('a held byte count that stays after the release still counts', async () => {
    // releaseHeld frees only part of the held bytes: the rest must still be counted.
    let held = 1500;
    const env = limited(2 * BLOB_BYTES, {
      heldBytes: () => held,
      releaseHeld: () => {
        held = 500;
      },
    });
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    // 1000 + 500 + 1000 = 2500 > 2000 after the release: refused.
    await rejectsWith(add(env.store, frame({ contentY: 520 })), ERR.SESSION_TOO_LARGE);
  });
});

describe('session store: timers and notifications', () => {
  it('a stopped idle timer that still fires does nothing (Done stopped it first)', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    const idle = env.timers.list.at(-1); // The idle timer that is running now.
    assert.ok(idle);
    await env.store.finish(SESSION, TAB);
    assert.equal(idle.cleared, true);
    idle.fn(); // The timer had already fired when Done cleared it.
    assert.equal(env.store.ping().sessions, 1, 'the finished session is still there');
    assert.equal(env.store.takeForAssembly(SESSION, TAB).manifest.slices.length, 1);
  });

  it('an expiry of a session that was released earlier does not tell "empty" twice', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    await env.store.finish(SESSION, TAB);
    const ttl = env.timers.list.at(-1);
    assert.ok(ttl);
    env.store.release(SESSION);
    assert.equal(env.empty.calls, 1);
    ttl.fn(); // The finished timer fires after the result page took the session.
    assert.equal(env.empty.calls, 1, 'no second notification');
    assert.deepEqual(env.store.ping(), { sessions: 0 });
  });

  it('dropTab tells "empty" only when it removed something', async () => {
    const env = setup();
    env.store.dropTab(99);
    assert.equal(env.empty.calls, 0, 'nothing was removed: nothing to tell');
    env.store.open(SESSION, TAB, 't', 'high');
    assert.deepEqual(env.store.dropTab(TAB), { remaining: 0 });
    assert.equal(env.empty.calls, 1);
    env.store.dropTab(TAB);
    assert.equal(env.empty.calls, 1, 'a second dropTab removes nothing');
  });

  it('dropTab leaves the sessions of other tabs and finished sessions', async () => {
    const env = setup();
    env.store.open(SESSION, TAB, 't', 'high');
    await add(env.store, frame({ contentY: 0, direction: 'initial' }));
    await env.store.finish(SESSION, TAB);
    env.store.open(OTHER, TAB + 1, 't', 'high');
    assert.deepEqual(env.store.dropTab(TAB), { remaining: 2 });
    assert.equal(env.empty.calls, 0);
    assert.deepEqual(env.store.dropTab(TAB + 1), { remaining: 1 });
    assert.equal(env.empty.calls, 0, 'the finished session is still there');
  });
});

// ---------------------------------------------------------------------------------------------
// Finalize
// ---------------------------------------------------------------------------------------------

/**
 * A finalizer with a real store and last capture and fake render ops.
 * @param {{ failFull?: boolean, saver?: any, store?: any, widthPx?: number, rowHeight?: number }} [o]
 */
function finalizerSetup(o = {}) {
  const store = o.store ?? createSessionStore({
    imageOps: /** @type {any} */ (createFake().ops),
    setTimer: () => 0,
    clearTimer: () => {},
  });
  const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
  /** @type {unknown[][]} */
  const logged = [];
  /** @type {any[]} */
  const rendered = [];
  const renderOps = {
    /** @param {any} _input */
    open(_input) {
      return {
        /** @param {any} plan */
        async renderTile(plan) {
          rendered.push(plan);
          return new Blob([new Uint8Array(100 + plan.index)], { type: 'image/png' });
        },
        async buildFullPng() {
          if (o.failFull) throw new Error('full failed');
          return new Blob([new Uint8Array(1000)], { type: 'image/png' });
        },
        dispose() {},
      };
    },
  };
  const saver =
    o.saver ??
    /** @type {any} */ ({
      async save() {
        return {
          save: { location: 'downloads', label: 'Downloads/Spool', files: 2, needsPermission: false },
          warnings: [],
        };
      },
    });
  const finalizer = createFinalizer({
    store,
    last,
    renderOps,
    saver,
    log: (message, error) => logged.push([message, error]),
  });
  const request = { sessionId: SESSION, tabId: TAB, saveTiles: true, saveFull: true, folderName: 'Spool' };
  return { store, last, finalizer, request, logged, rendered };
}

/** @param {ReturnType<typeof createSessionStore>} store @param {number} frames */
async function captureFrames(store, frames) {
  store.open(SESSION, TAB, 'My page', 'high');
  for (let i = 0; i < frames; i++) {
    const f = frame({ contentY: i * 520, direction: i === 0 ? 'initial' : 'down' });
    await add(store, f);
  }
}

describe('finalize', () => {
  it('says "This capture has ended" for a session that is not there (the user message)', async () => {
    const env = finalizerSetup();
    await rejectsWith(env.finalizer.finalize(env.request), ERR.SESSION_NOT_FOUND, 'This capture has ended. Start a new capture.');
  });

  it('keeps the session of an error that is not "nothing was captured"', async () => {
    const real = createSessionStore({
      imageOps: /** @type {any} */ (createFake().ops),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    await captureFrames(real, 1);
    let released = 0;
    const store = /** @type {any} */ ({
      ...real,
      takeForAssembly() {
        throw new SpoolError(ERR.INTERNAL, 'x');
      },
      release(/** @type {string} */ id) {
        released += 1;
        return real.release(id);
      },
    });
    const env = finalizerSetup({ store });
    await rejectsWith(env.finalizer.finalize(env.request), ERR.INTERNAL);
    assert.equal(released, 0, 'only "nothing was captured" frees the session');
  });

  it('frees a session with no slice when Done finds nothing to build', async () => {
    const store = createSessionStore({
      imageOps: /** @type {any} */ (createFake().ops),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    store.open(SESSION, TAB, 'Empty', 'high');
    const env = finalizerSetup({ store });
    await rejectsWith(env.finalizer.finalize(env.request), ERR.CAPTURE_FAILED);
    assert.equal(store.ping().sessions, 0, 'the empty session was released');
  });

  it('logs the failure of the full image and still gives the tiles', async () => {
    const env = finalizerSetup({ failFull: true });
    // Two tall frames, so there is more than one tile and the full image is not one of them.
    await captureFrames(env.store, 8);
    const summary = await env.finalizer.finalize(env.request);
    assert.ok(summary.tileCount > 1);
    assert.equal(summary.fullBytes, 0, 'no full image: no bytes');
    assert.ok(summary.warnings.includes('The full image could not be built. You can still use the AI screenshots.'));
    assert.equal(env.logged.length, 1);
    assert.equal(env.logged[0]?.[0], 'Spool offscreen: the full image failed');
    assert.equal(/** @type {Error} */ (env.logged[0]?.[1]).message, 'full failed');
  });

  it('shows the capture as "Not saved" while the save step still runs', async () => {
    /** @type {() => void} */
    let finishSave = () => {};
    const saver = /** @type {any} */ ({
      save() {
        return new Promise((resolve) => {
          finishSave = () =>
            resolve({
              save: { location: 'downloads', label: 'Downloads/Spool', files: 2, needsPermission: false },
              warnings: [],
            });
        });
      },
    });
    const env = finalizerSetup({ saver });
    await captureFrames(env.store, 2);
    const pending = env.finalizer.finalize(env.request);
    for (let i = 0; i < 50 && !env.last.has(); i++) await tick();
    assert.ok(env.last.has(), 'the outputs are kept before the save step ends');
    assert.deepEqual(env.last.latest()?.summary.save, {
      location: 'none',
      label: 'Not saved',
      files: 0,
      needsPermission: false,
    });
    finishSave();
    const summary = await pending;
    assert.equal(summary.save.location, 'downloads');
    assert.equal(env.last.latest()?.summary.save.location, 'downloads');
  });

  it('a save step that throws gives the exact "Not saved" answer with the error text', async () => {
    const saver = /** @type {any} */ ({
      async save() {
        throw new Error('saver bug');
      },
    });
    const env = finalizerSetup({ saver });
    await captureFrames(env.store, 2);
    const summary = await env.finalizer.finalize(env.request);
    assert.deepEqual(summary.save, {
      location: 'none',
      label: 'Not saved',
      files: 0,
      needsPermission: false,
      error: 'Could not save the files.',
    });
    assert.equal(env.logged.at(-1)?.[0], 'Spool offscreen: the save step failed');
  });

  it('a capture 1 px tall and wider than the tile limit is a scaled tile, not the full image', async () => {
    // Width 3000, 1 row: the tile is 2576 x 1. Its width differs from the source, its height does
    // not, and it is still not the source 1:1, so it must be rendered and not shared with the full
    // image.
    const real = createSessionStore({
      imageOps: /** @type {any} */ ({
        async decode() {
          return {
            widthPx: 3000,
            heightPx: 800,
            async crop(/** @type {any} */ box) {
              const cols = Math.min(SIGNATURE_MAX_COLS, box.sw);
              return {
                blob: new Blob([new Uint8Array(10)]),
                signature: new Uint8Array(box.sh * cols),
                cols,
                width: box.sw,
                height: box.sh,
              };
            },
            close() {},
          };
        },
      }),
      setTimer: () => 0,
      clearTimer: () => {},
    });
    real.open(SESSION, TAB, 'Wide', 'high');
    await real.addFrame(SESSION, TAB, PNG_PREFIX + 'AA==', {
      direction: 'initial',
      viewport: { width: 3000, height: 800 },
      rect: { x: 0, y: 10, width: 3000, height: 1 },
      contentY: 0,
    });
    const env = finalizerSetup({ store: real });
    const summary = await env.finalizer.finalize(env.request);
    assert.equal(summary.tileCount, 1);
    assert.equal(env.rendered.length, 2, 'the tile and the thumbnail were rendered');
    assert.equal(env.rendered[0].outWidth, 2576);
    assert.equal(env.rendered[0].outHeight, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Saver
// ---------------------------------------------------------------------------------------------

const DATE = new Date(2026, 10, 6, 15, 22, 48);
const blob = (/** @type {number} */ n) => new Blob([new Uint8Array(n)]);

/**
 * @param {{ folder?: any, downloads?: (files: { path: string, url: string }[], call: number) => any }} [o]
 */
function makeSaver(o = {}) {
  /** @type {{ path: string, url: string }[][]} */
  const downloadCalls = [];
  const saver = createSaver({
    folderStore: {
      async getSaveTarget() {
        return o.folder ? { handle: o.folder, subPath: [] } : null;
      },
      async folderPermission() {
        return 'granted';
      },
    },
    async requestDownloads(files) {
      downloadCalls.push(files);
      return o.downloads?.(files, downloadCalls.length - 1) ?? { saved: files.length, rejected: 0, interrupted: 0 };
    },
    makeUrl: () => 'blob:chrome-extension://x/1',
    revokeUrl: () => {},
  });
  return { saver, downloadCalls };
}

/** @param {Record<string, unknown>} [over] */
function saveRequest(over = {}) {
  return {
    date: DATE,
    title: 'Inbox - Mail',
    tileCount: 1,
    tiles: [blob(11)],
    full: blob(100),
    saveTiles: true,
    saveFull: false,
    folderName: 'Spool',
    ...over,
  };
}

describe('saver: counts', () => {
  it('retries without the title when the only file was refused (one rejected file is enough)', async () => {
    const { saver, downloadCalls } = makeSaver({
      downloads: (files, call) =>
        call === 0
          ? { saved: 0, rejected: 1, interrupted: 0 }
          : { saved: files.length, rejected: 0, interrupted: 0 },
    });
    const result = await saver.save(/** @type {any} */ (saveRequest()));
    assert.equal(downloadCalls.length, 2, 'the set went again, once');
    assert.equal(result.save.location, 'downloads');
    assert.equal(result.save.files, 1);
    assert.equal(result.save.error, undefined);
  });

  it('reports one saved file of two as a partial save', async () => {
    const { saver } = makeSaver({ downloads: () => ({ saved: 1, rejected: 0, interrupted: 1 }) });
    const result = await saver.save(/** @type {any} */ (saveRequest({ saveFull: true, tileCount: 2, tiles: [blob(5), blob(6)] })));
    assert.deepEqual(result.save, {
      location: 'downloads',
      label: 'Downloads/Spool',
      files: 1,
      needsPermission: false,
      failed: 2, // Three files were planned: the full image and two tiles.
      error: 'Some files could not be saved.',
    });
  });

  it('reports no saved file as "none" with zero files and the error', async () => {
    const { saver } = makeSaver({ downloads: () => ({ saved: 0, rejected: 0, interrupted: 2 }) });
    const result = await saver.save(/** @type {any} */ (saveRequest()));
    assert.deepEqual(result.save, {
      location: 'none',
      label: 'Not saved',
      files: 0,
      needsPermission: false,
      error: 'Could not save the files.',
    });
  });

  it('gives an empty label to a folder that has no name', async () => {
    const root = makeNamelessDir();
    const { saver } = makeSaver({ folder: root });
    const result = await saver.save(/** @type {any} */ (saveRequest()));
    assert.equal(result.save.location, 'folder');
    assert.equal(result.save.label, '');
  });
});

/** An in-memory directory without a `name`. @returns {any} */
function makeNamelessDir() {
  /** @type {Map<string, any>} */
  const dirs = new Map();
  /** @type {Map<string, Blob>} */
  const files = new Map();
  return {
    dirs,
    files,
    /** @param {string} n @param {{ create?: boolean }} [o] */
    async getDirectoryHandle(n, o = {}) {
      if (files.has(n)) throw new DOMException('is a file', 'TypeMismatchError');
      const existing = dirs.get(n);
      if (existing) return existing;
      if (!o.create) throw new DOMException('not found', 'NotFoundError');
      const created = makeNamelessDir();
      dirs.set(n, created);
      return created;
    },
    /** @param {string} n @param {{ create?: boolean }} [o] */
    async getFileHandle(n, o = {}) {
      if (dirs.has(n)) throw new DOMException('is a directory', 'TypeMismatchError');
      if (!files.has(n) && !o.create) throw new DOMException('not found', 'NotFoundError');
      return {
        async createWritable() {
          /** @type {Blob | null} */
          let pending = null;
          return {
            async write(/** @type {Blob} */ b) {
              pending = b;
            },
            async close() {
              files.set(n, pending ?? new Blob([]));
            },
            async abort() {},
          };
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Folder writer
// ---------------------------------------------------------------------------------------------

describe('folder writer: limits and cleanup', () => {
  const BASE = 'Spool 2026-11-06 15.22.48 Inbox - Mail';
  /** @param {string} base */
  const makeFiles = (base) => captureFiles({ base, tileCount: 3, saveTiles: true, saveFull: true });

  it('pickFreeBase finds the 100th name when the 99 before it are taken', async () => {
    const root = makeNamelessDir();
    root.files.set(`${BASE}.png`, blob(1));
    for (let n = 2; n <= 99; n++) root.files.set(`${BASE} (${n}).png`, blob(1));
    assert.equal(await pickFreeBase(root, BASE, makeFiles), `${BASE} (100)`);
  });

  it('pickFreeBase gives up when all 100 names are taken', async () => {
    const root = makeNamelessDir();
    root.files.set(`${BASE}.png`, blob(1));
    for (let n = 2; n <= 100; n++) root.files.set(`${BASE} (${n}).png`, blob(1));
    await assert.rejects(pickFreeBase(root, BASE, makeFiles), /No free name in the folder\./);
  });

  it('aborts the writer of a file whose write failed, and keeps the original error', async () => {
    let aborted = 0;
    const root = /** @type {any} */ ({
      async getDirectoryHandle() {
        return root;
      },
      async getFileHandle() {
        return {
          async createWritable() {
            return {
              async write() {
                throw new Error('disk full');
              },
              async close() {},
              async abort() {
                aborted += 1;
                throw new Error('abort failed too');
              },
            };
          },
        };
      },
    });
    await assert.rejects(
      writeFiles(root, [{ kind: 'full', path: ['full.png'], blob: blob(3) }]),
      /disk full/,
    );
    assert.equal(aborted, 1, 'the half-written file was aborted');
  });
});

// ---------------------------------------------------------------------------------------------
// Last capture and shelf tokens
// ---------------------------------------------------------------------------------------------

describe('last capture: timer and output limits', () => {
  it('stops its timer once: a second end of the capture does not stop it again', () => {
    /** @type {{ cleared: number }[]} */
    const handles = [];
    const last = createLastCapture({
      setTimer: () => {
        const handle = { cleared: 0 };
        handles.push(handle);
        return handle;
      },
      clearTimer: (h) => {
        /** @type {{ cleared: number }} */ (h).cleared += 1;
      },
    });
    const entry = /** @type {any} */ ({ sessionId: SESSION, tabId: TAB, summary: { sessionId: SESSION }, tiles: [], full: null });
    last.set(entry);
    last.clear();
    last.set({ ...entry, sessionId: OTHER, summary: { sessionId: OTHER } });
    assert.equal(handles[0]?.cleared, 1, 'the first timer was cleared exactly once');
    assert.equal(handles[1]?.cleared, 0);
  });

  it('a tile of exactly the transfer limit can be read, one byte more cannot', () => {
    const entry = /** @type {any} */ ({ tiles: [blob(10), blob(11)], full: blob(5) });
    assert.equal(pickOutput(entry, 0, 10).size, 10);
    assert.throws(
      () => pickOutput(entry, 1, 10),
      (e) => e instanceof SpoolError && e.code === ERR.SESSION_TOO_LARGE && e.message === 'This screenshot is too large to copy.',
    );
  });
});

describe('shelf tokens: expiry bookkeeping', () => {
  it('the size does not count tokens that ran out', () => {
    let now = 0;
    const tokens = createShelfTokens({ now: () => now, ttlMs: 1000, max: 8 });
    tokens.grant('a', 1);
    tokens.grant('b', 2);
    assert.equal(tokens.size, 2);
    now = 1000;
    assert.equal(tokens.size, 0, 'a token ends at its expiry time, not after it');
  });

  it('a token that is granted again counts as the newest one when the oldest goes', () => {
    const tokens = createShelfTokens({ now: () => 0, ttlMs: 1000, max: 2 });
    tokens.grant('t', 1);
    tokens.grant('p', 4);
    tokens.grant('t', 2); // The same token for another tab: it moves to the end.
    tokens.grant('q', 5); // Three tokens: the oldest ('p') goes.
    assert.doesNotThrow(() => tokens.check('t', 2));
    assert.doesNotThrow(() => tokens.check('q', 5));
    assert.throws(() => tokens.check('p', 4), (e) => e instanceof SpoolError && e.code === ERR.SESSION_NOT_FOUND);
  });

  it('an expired token is gone before a new one is granted', () => {
    let now = 0;
    const tokens = createShelfTokens({ now: () => now, ttlMs: 1000, max: 8 });
    tokens.grant('old', 1);
    now = 1000;
    tokens.grant('new', 2);
    assert.equal(tokens.size, 1);
    assert.throws(() => tokens.check('old', 1), (e) => e instanceof SpoolError && e.code === ERR.SESSION_NOT_FOUND);
  });
});

describe('dataUrlToBlob', () => {
  it('keeps every byte, the first one too', async () => {
    const bytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 255, 7]);
    const url = PNG_PREFIX + Buffer.from(bytes).toString('base64');
    const result = dataUrlToBlob(url);
    assert.equal(result.type, 'image/png');
    assert.deepEqual([...new Uint8Array(await result.arrayBuffer())], [...bytes]);
  });
});
