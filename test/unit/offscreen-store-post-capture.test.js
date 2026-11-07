// @ts-check
/**
 * Additions of the session store for the post-capture flow: `takeForAssembly`, `stateOf`, and the
 * bytes of the last capture in the total memory limit (`heldBytes` and `releaseHeld`).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSessionStore } from '../../src/offscreen/session-store.js';
import { SIGNATURE_MAX_COLS } from '../../src/shared/constants.js';
import { ERR, SpoolError } from '../../src/shared/protocol.js';

/** No real timers: a session timer of 15 or 30 minutes would keep Node alive. */
const NO_TIMERS = { setTimer: () => 0, clearTimer: () => {} };

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TAB = 7;
const PNG_PREFIX = 'data:image/png;base64,';
const VIEWPORT = { width: 1000, height: 800 };
const RECT = { x: 0, y: 100, width: 1000, height: 600 };
const STEP = 520;

/** @param {number} row @param {number} col */
function noise(row, col) {
  let h = (Math.imul(row, 374761393) + Math.imul(col, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) & 255;
}

/** @param {number} blobSize */
function fakeImageOps(blobSize = 500) {
  return /** @type {any} */ ({
    async decode(/** @type {string} */ dataUrl) {
      const spec = JSON.parse(Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64').toString());
      return {
        widthPx: spec.w,
        heightPx: spec.h,
        async crop(/** @type {any} */ box) {
          const cols = Math.min(SIGNATURE_MAX_COLS, box.sw);
          const signature = new Uint8Array(box.sh * cols);
          for (let r = 0; r < box.sh; r++) {
            for (let c = 0; c < cols; c++) signature[r * cols + c] = noise(spec.origin + box.sy + r, c);
          }
          return { blob: new Blob([new Uint8Array(blobSize)]), signature, cols, width: box.sw, height: box.sh };
        },
        close() {},
      };
    },
  });
}

/** @param {number} contentY @param {'initial' | 'down'} direction */
function frame(contentY, direction) {
  const origin = contentY - RECT.y;
  const dataUrl =
    PNG_PREFIX +
    Buffer.from(JSON.stringify({ w: VIEWPORT.width, h: VIEWPORT.height, origin })).toString('base64');
  return {
    dataUrl,
    meta: { direction, viewport: { ...VIEWPORT }, rect: { ...RECT }, contentY },
  };
}

/** @param {ReturnType<typeof createSessionStore>} store @param {string} id @param {number} frames */
async function capture(store, id, frames, tabId = TAB) {
  store.open(id, tabId, 'A page', 'high');
  for (let i = 0; i < frames; i++) {
    const f = frame(i * STEP, i === 0 ? 'initial' : 'down');
    await store.addFrame(id, tabId, f.dataUrl, f.meta);
  }
}

/** @param {unknown} e @param {string} code */
function isSpoolError(e, code) {
  assert.ok(e instanceof SpoolError, `expected SpoolError, got ${String(e)}`);
  assert.equal(e.code, code);
  return true;
}

describe('store.takeForAssembly', () => {
  it('gives the manifest, the tile tier and the blob of every slice, for a finished session of the tab', async () => {
    const store = createSessionStore({ ...NO_TIMERS, imageOps: fakeImageOps() });
    await capture(store, SESSION, 3);
    await store.finish(SESSION, TAB);
    const taken = store.takeForAssembly(SESSION, TAB);
    assert.equal(taken.manifest.sessionId, SESSION);
    assert.equal(taken.manifest.slices.length, 3);
    assert.equal(taken.manifest.totalHeightPx, 1640);
    assert.equal(taken.tileTier, 'high');
    assert.deepEqual([...taken.blobs.keys()].sort(), [0, 1, 2]);
    for (const blob of taken.blobs.values()) assert.equal(blob.size, 500);
  });

  it('does not remove the session: release does', async () => {
    const store = createSessionStore({ ...NO_TIMERS, imageOps: fakeImageOps() });
    await capture(store, SESSION, 2);
    await store.finish(SESSION, TAB);
    store.takeForAssembly(SESSION, TAB);
    assert.deepEqual(store.ping(), { sessions: 1 });
    assert.deepEqual(store.release(SESSION), { remaining: 0 });
  });

  it('refuses an unfinished session, an unknown one and the session of another tab', async () => {
    const store = createSessionStore({ ...NO_TIMERS, imageOps: fakeImageOps() });
    await capture(store, SESSION, 1);
    assert.throws(() => store.takeForAssembly(SESSION, TAB), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
    await store.finish(SESSION, TAB);
    assert.throws(() => store.takeForAssembly(OTHER, TAB), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
    assert.throws(() => store.takeForAssembly(SESSION, TAB + 1), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
  });

  it('fails with E_CAPTURE_FAILED for a finished session with no slice', async () => {
    const store = createSessionStore({ ...NO_TIMERS, imageOps: fakeImageOps() });
    store.open(SESSION, TAB, 'Empty', 'high');
    await store.finish(SESSION, TAB);
    assert.throws(() => store.takeForAssembly(SESSION, TAB), (e) => isSpoolError(e, ERR.CAPTURE_FAILED));
  });
});

describe('store.stateOf', () => {
  it('tells open, finished, or null for an unknown session and another tab', async () => {
    const store = createSessionStore({ ...NO_TIMERS, imageOps: fakeImageOps() });
    assert.equal(store.stateOf(SESSION, TAB), null);
    store.open(SESSION, TAB, 't', 'high');
    assert.equal(store.stateOf(SESSION, TAB), 'open');
    assert.equal(store.stateOf(SESSION, TAB + 1), null);
    await store.finish(SESSION, TAB);
    assert.equal(store.stateOf(SESSION, TAB), 'finished');
    store.release(SESSION);
    assert.equal(store.stateOf(SESSION, TAB), null);
  });
});

describe('store: the bytes of the last capture count in the total limit', () => {
  it('counts held bytes with the stored bytes, and frees them before it refuses a frame', async () => {
    let held = 800;
    let released = 0;
    const store = createSessionStore({
      ...NO_TIMERS,
      imageOps: fakeImageOps(500),
      totalMaxBytes: 1200,
      heldBytes: () => held,
      releaseHeld: () => {
        released += 1;
        held = 0;
      },
    });
    store.open(SESSION, TAB, 't', 'high');
    // 800 held + 500 = 1300 > 1200: the held bytes go first, then the frame fits.
    const f = frame(0, 'initial');
    const intake = await store.addFrame(SESSION, TAB, f.dataUrl, f.meta);
    assert.equal(intake.index, 0);
    assert.equal(released, 1);
    assert.equal(held, 0);
  });

  it('refuses the frame when it does not fit even without the held bytes', async () => {
    let held = 800;
    let released = 0;
    const store = createSessionStore({
      ...NO_TIMERS,
      imageOps: fakeImageOps(500),
      totalMaxBytes: 1200,
      heldBytes: () => held,
      releaseHeld: () => {
        released += 1;
        held = 0;
      },
    });
    await capture(store, SESSION, 2); // 1000 stored: the held bytes go (1 release), then it fits
    assert.equal(released, 1);
    store.open(OTHER, 8, 't', 'high');
    const f = frame(0, 'initial');
    await assert.rejects(store.addFrame(OTHER, 8, f.dataUrl, f.meta), (e) =>
      isSpoolError(e, ERR.SESSION_TOO_LARGE),
    );
    assert.equal(released, 1, 'nothing more to release');
  });

  it('does not release anything while the total limit holds', async () => {
    let released = 0;
    const store = createSessionStore({
      ...NO_TIMERS,
      imageOps: fakeImageOps(500),
      totalMaxBytes: 5000,
      heldBytes: () => 1000,
      releaseHeld: () => {
        released += 1;
      },
    });
    await capture(store, SESSION, 3);
    assert.equal(released, 0);
  });

  it('works as before without the options', async () => {
    const store = createSessionStore({ ...NO_TIMERS, imageOps: fakeImageOps(500), totalMaxBytes: 600 });
    store.open(SESSION, TAB, 't', 'high');
    const a = frame(0, 'initial');
    await store.addFrame(SESSION, TAB, a.dataUrl, a.meta);
    const b = frame(STEP, 'down');
    await assert.rejects(store.addFrame(SESSION, TAB, b.dataUrl, b.meta), (e) =>
      isSpoolError(e, ERR.SESSION_TOO_LARGE),
    );
  });
});
