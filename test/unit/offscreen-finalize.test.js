// @ts-check
/**
 * Finalize (docs/contracts.md 7.9): a real session store, the real last capture, and fakes for the
 * image work and the save step. The browser image code is checked in a real browser (see the
 * scratch run in the pipeline report), not here.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { planTiles } from '../../src/lib/tiles.js';
import { createFinalizer } from '../../src/offscreen/finalize.js';
import { createLastCapture } from '../../src/offscreen/last-capture.js';
import { createSessionStore } from '../../src/offscreen/session-store.js';
import { thumbnailPlan } from '../../src/render/util.js';
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
const NOW = Date.UTC(2026, 10, 6, 15, 22, 48);

/** @param {number} row @param {number} col */
function noise(row, col) {
  let h = (Math.imul(row, 374761393) + Math.imul(col, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) & 255;
}

/** Fake image code for the store: a "data URL" holds JSON { w, h, origin }. */
function fakeImageOps() {
  return {
    /** @param {string} dataUrl */
    async decode(dataUrl) {
      const spec = JSON.parse(Buffer.from(dataUrl.slice(PNG_PREFIX.length), 'base64').toString());
      return {
        widthPx: spec.w,
        heightPx: spec.h,
        /** @param {{ sx: number, sy: number, sw: number, sh: number }} box */
        async crop(box) {
          const cols = Math.min(SIGNATURE_MAX_COLS, box.sw);
          const signature = new Uint8Array(box.sh * cols);
          for (let r = 0; r < box.sh; r++) {
            for (let c = 0; c < cols; c++) signature[r * cols + c] = noise(spec.origin + box.sy + r, c);
          }
          return { blob: new Blob([new Uint8Array(500)]), signature, cols, width: box.sw, height: box.sh };
        },
        close() {},
      };
    },
  };
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

/**
 * Opens a session and stores `frames` frames (the first one 'initial', then 'down').
 * @param {ReturnType<typeof createSessionStore>} store
 * @param {{ id?: string, tabId?: number, frames?: number, tier?: 'high' | 'standard', title?: string,
 *   host?: string }} [o]
 */
async function capture(
  store,
  { id = SESSION, tabId = TAB, frames = 3, tier = 'high', title = 'My page', host = '' } = {},
) {
  store.open(id, tabId, title, tier, host);
  for (let i = 0; i < frames; i++) {
    const f = frame(i * STEP, i === 0 ? 'initial' : 'down');
    await store.addFrame(id, tabId, f.dataUrl, f.meta);
  }
}

/**
 * Fake render ops. A tile or the full image is a Blob whose size tells what it is.
 * @param {{ failFull?: boolean, failTile?: number, delay?: Promise<void> | null }} [options]
 */
function fakeRenderOps(options = {}) {
  const log = {
    /** @type {string[]} */
    events: [],
    /** @type {any[]} */
    opened: [],
    tilePlans: /** @type {any[]} */ ([]),
    disposed: 0,
    open: 0,
  };
  const ops = {
    /** @param {any} input */
    open(input) {
      log.open += 1;
      log.opened.push(input);
      log.events.push('open');
      return {
        /** @param {any} plan */
        async renderTile(plan) {
          log.events.push(`tile ${plan.index} ${plan.outWidth}x${plan.outHeight}`);
          log.tilePlans.push(plan);
          if (options.delay) await options.delay;
          if (options.failTile !== undefined && plan.srcY === options.failTile) {
            throw new Error('tile failed');
          }
          return new Blob([new Uint8Array(100 + plan.index)], { type: 'image/png' });
        },
        async buildFullPng() {
          log.events.push('full');
          if (options.failFull) throw new Error('full failed');
          return new Blob([new Uint8Array(1000)], { type: 'image/png' });
        },
        dispose() {
          log.disposed += 1;
          log.events.push('dispose');
        },
      };
    },
  };
  return { ops, log };
}

/** @param {{ fail?: boolean }} [options] */
function fakeSaver(options = {}) {
  /** @type {any[]} */
  const requests = [];
  return {
    requests,
    saver: /** @type {any} */ ({
      async save(/** @type {any} */ request) {
        requests.push(request);
        if (options.fail) throw new Error('saver bug');
        return {
          save: { location: 'downloads', label: 'Downloads/Spool', files: 4, needsPermission: false },
          warnings: ['saver warning'],
        };
      },
    }),
  };
}

/** @param {Parameters<typeof fakeRenderOps>[0]} [renderOptions] @param {Parameters<typeof fakeSaver>[0]} [saverOptions] */
function setup(renderOptions, saverOptions) {
  const store = createSessionStore({
    ...NO_TIMERS,
    now: () => NOW,
    imageOps: /** @type {any} */ (fakeImageOps()),
  });
  const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
  const render = fakeRenderOps(renderOptions);
  const saving = fakeSaver(saverOptions);
  /** @type {unknown[]} */
  const logged = [];
  const finalizer = createFinalizer({
    store,
    last,
    renderOps: render.ops,
    saver: saving.saver,
    log: (message, error) => logged.push([message, error]),
  });
  const request = {
    sessionId: SESSION,
    tabId: TAB,
    saveTiles: true,
    saveFull: true,
    folderName: 'Spool',
  };
  return { store, last, render, saving, finalizer, request, logged };
}

/** @param {unknown} e @param {string} code @param {string} [message] */
function isSpoolError(e, code, message) {
  assert.ok(e instanceof SpoolError, `expected SpoolError, got ${String(e)}`);
  assert.equal(e.code, code);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
}

describe('finalize', () => {
  it('builds the tiles, the thumbnail and the full image, and returns the summary', async () => {
    const { store, finalizer, request, render } = setup();
    await capture(store, { frames: 3 });
    const summary = await finalizer.finalize(request);

    // Three slices of 600 rows with a step of 520 rows: 600 + 520 + 520 rows.
    assert.equal(summary.widthPx, 1000);
    assert.equal(summary.heightPx, 1640);
    const plans = planTiles(1000, 1640, 'high');
    assert.equal(summary.tileCount, plans.length);
    assert.equal(summary.fitsOneImage, plans.length === 1);
    assert.equal(summary.tileTier, 'high');
    assert.equal(summary.sessionId, SESSION);
    assert.equal(summary.title, 'My page');
    assert.equal(summary.fullBytes, 1000);
    assert.equal(typeof summary.createdAt, 'number');
    assert.deepEqual(render.log.events.filter((e) => e !== 'open' && e !== 'dispose').at(-1), 'full');
  });

  it('renders every tile of the plan, then the thumbnail, then the full image, and disposes', async () => {
    const { store, finalizer, request, render } = setup();
    // A tall capture at the standard tier needs several tiles.
    await capture(store, { frames: 12, tier: 'standard' });
    const summary = await finalizer.finalize(request);
    const plans = planTiles(1000, summary.heightPx, 'standard');
    assert.ok(plans.length > 1);
    const thumb = thumbnailPlan(1000, summary.heightPx);
    assert.deepEqual(render.log.tilePlans.slice(0, plans.length), plans);
    assert.deepEqual(render.log.tilePlans[plans.length], thumb);
    assert.equal(render.log.tilePlans.length, plans.length + 1);
    assert.deepEqual(render.log.events.slice(-2), ['full', 'dispose']);
    assert.equal(render.log.disposed, 1);
    assert.equal(summary.thumbnailWidthPx, thumb.outWidth);
    assert.equal(summary.thumbnailHeightPx, thumb.outHeight);
    assert.ok(summary.thumbnailPngBase64.length > 0);
  });

  it('plans the assembly from the manifest and gives the slices to the renderer', async () => {
    const { store, finalizer, request, render } = setup();
    await capture(store, { frames: 3 });
    await finalizer.finalize(request);
    const [input] = render.log.opened;
    assert.equal(input.widthPx, 1000);
    assert.equal(input.totalHeight, 1640);
    assert.equal(input.blobs.size, 3);
    assert.ok(input.blobs.get(0) instanceof Blob);
    assert.ok(input.pieces.length >= 1);
    assert.equal(
      input.pieces.reduce((/** @type {number} */ sum, /** @type {any} */ p) => sum + p.height, 0),
      1640,
    );
  });

  it('keeps the outputs as the last capture, bound to the tab of the session', async () => {
    const { store, last, finalizer, request } = setup();
    await capture(store);
    const summary = await finalizer.finalize(request);
    const entry = last.require(SESSION, TAB);
    assert.equal(entry.tabId, TAB);
    assert.equal(entry.tiles.length, summary.tileCount);
    assert.equal(entry.full?.size, 1000);
    assert.deepEqual(entry.summary, summary);
    assert.throws(() => last.require(SESSION, TAB + 1), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
  });

  it('frees the slices: the session is gone and the store is empty', async () => {
    const { store, finalizer, request } = setup();
    await capture(store);
    await finalizer.finalize(request);
    assert.deepEqual(store.ping(), { sessions: 0 });
    assert.equal(store.stateOf(SESSION, TAB), null);
  });

  it('sets the last capture before it frees the slices (the document is never empty between)', async () => {
    /** @type {string[]} */
    const order = [];
    const store = createSessionStore({
      ...NO_TIMERS,
      imageOps: /** @type {any} */ (fakeImageOps()),
      onEmpty: () => order.push(`store empty, last capture: ${last.has()}`),
    });
    const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
    const finalizer = createFinalizer({
      store,
      last,
      renderOps: fakeRenderOps().ops,
      saver: fakeSaver().saver,
    });
    await capture(store);
    await finalizer.finalize({ sessionId: SESSION, tabId: TAB, saveTiles: true, saveFull: true, folderName: 'Spool' });
    assert.deepEqual(order, ['store empty, last capture: true']);
  });

  it('drops the old last capture first and replaces it', async () => {
    const { store, last, finalizer, request } = setup();
    await capture(store, { id: SESSION });
    await finalizer.finalize(request);
    assert.ok(last.has());
    await capture(store, { id: OTHER, tabId: 8 });
    const second = await finalizer.finalize({ ...request, sessionId: OTHER, tabId: 8 });
    assert.equal(second.sessionId, OTHER);
    assert.equal(last.latest()?.sessionId, OTHER);
    assert.throws(() => last.require(SESSION), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
  });

  it('frees the old outputs before it builds the new ones', async () => {
    const { store, last, finalizer, request, render } = setup();
    await capture(store, { id: SESSION });
    await finalizer.finalize(request);
    await capture(store, { id: OTHER, tabId: 8 });
    let hadOldCapture = true;
    const open = render.ops.open.bind(render.ops);
    render.ops.open = (input) => {
      hadOldCapture = last.has();
      return open(input);
    };
    await finalizer.finalize({ ...request, sessionId: OTHER, tabId: 8 });
    assert.equal(hadOldCapture, false);
  });

  it('returns the same summary for the same session again, without building twice', async () => {
    const { store, finalizer, request, render } = setup();
    await capture(store);
    const first = await finalizer.finalize(request);
    const second = await finalizer.finalize(request);
    assert.equal(second, first);
    assert.equal(render.log.open, 1);
  });

  it('shares one build between two calls at the same time', async () => {
    const { store, finalizer, request, render } = setup();
    await capture(store);
    const [a, b] = await Promise.all([finalizer.finalize(request), finalizer.finalize(request)]);
    assert.equal(a, b);
    assert.equal(render.log.open, 1);
  });

  it('does not give the summary to another tab for the same session', async () => {
    const { store, finalizer, request } = setup();
    await capture(store);
    await finalizer.finalize(request);
    await assert.rejects(finalizer.finalize({ ...request, tabId: TAB + 1 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
  });

  it('fails with E_SESSION_NOT_FOUND for an unknown session or the session of another tab', async () => {
    const { store, finalizer, request } = setup();
    await assert.rejects(finalizer.finalize(request), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
    await capture(store);
    await assert.rejects(finalizer.finalize({ ...request, tabId: 99 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
    // The session of the right tab is untouched and still finalizes.
    assert.equal((await finalizer.finalize(request)).sessionId, SESSION);
  });

  it('runs one finalize at a time', async () => {
    /** @type {() => void} */
    let release = () => {};
    const gate = new Promise((resolve) => {
      release = () => resolve(undefined);
    });
    const { store, finalizer, request, render } = setup({ delay: /** @type {Promise<void>} */ (gate) });
    await capture(store, { id: SESSION });
    await capture(store, { id: OTHER, tabId: 8 });
    const first = finalizer.finalize(request);
    const second = finalizer.finalize({ ...request, sessionId: OTHER, tabId: 8 });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(render.log.open, 1, 'the second waits');
    release();
    await Promise.all([first, second]);
    assert.equal(render.log.open, 2);
    assert.equal(render.log.disposed, 2);
  });

  describe('one tile', () => {
    it('builds a short capture that is the source 1:1 once: the tile is the full image', async () => {
      const { store, last, finalizer, request, render } = setup();
      await capture(store, { frames: 1 }); // 1000 x 600 px: one tile, not scaled
      const summary = await finalizer.finalize(request);
      assert.equal(summary.tileCount, 1);
      assert.equal(summary.fitsOneImage, true);
      const entry = last.require(SESSION);
      assert.equal(entry.tiles.length, 1);
      assert.equal(entry.tiles[0], entry.full, 'the same Blob');
      // Only the thumbnail is rendered through renderTile.
      assert.equal(render.log.tilePlans.length, 1);
      assert.deepEqual(render.log.tilePlans[0], thumbnailPlan(1000, 600));
      assert.equal(last.bytes(), 1000 + (entry.tiles[0] === entry.full ? 0 : 1));
    });

    it('renders a one-tile capture that needs a scale step as its own tile', async () => {
      // 1000 px wide is within the high tier, so force a scale with the standard tier of a very
      // wide capture: use a custom plan through a 2000 px wide viewport.
      const store = createSessionStore({ ...NO_TIMERS, imageOps: /** @type {any} */ (fakeImageOps()) });
      const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
      const render = fakeRenderOps();
      const finalizer = createFinalizer({ store, last, renderOps: render.ops, saver: fakeSaver().saver });
      store.open(SESSION, TAB, 'Wide', 'standard');
      const wide = { width: 2000, height: 800 };
      const rect = { x: 0, y: 100, width: 2000, height: 600 };
      const dataUrl =
        PNG_PREFIX + Buffer.from(JSON.stringify({ w: 2000, h: 800, origin: -100 })).toString('base64');
      await store.addFrame(SESSION, TAB, dataUrl, {
        direction: 'initial',
        viewport: wide,
        rect,
        contentY: 0,
      });
      const summary = await finalizer.finalize({
        sessionId: SESSION,
        tabId: TAB,
        saveTiles: true,
        saveFull: true,
        folderName: 'Spool',
      });
      assert.equal(summary.tileCount, 1);
      const entry = last.require(SESSION);
      assert.notEqual(entry.tiles[0], entry.full);
      assert.equal(render.log.tilePlans.length, 2, 'the tile and the thumbnail');
      assert.equal(render.log.tilePlans[0].outWidth, 1568);
    });
  });

  describe('the host of the captured page', () => {
    it('goes from the session into the summary of Done, and into the last capture', async () => {
      const { store, last, finalizer, request } = setup();
      await capture(store, { host: 'github.com' });
      const summary = await finalizer.finalize(request);
      assert.equal(summary.sourceHost, 'github.com');
      assert.equal(last.require(SESSION).summary.sourceHost, 'github.com');
    });

    it('is an empty text for a page that has none (a local file)', async () => {
      const { store, finalizer, request } = setup();
      await capture(store);
      assert.equal((await finalizer.finalize(request)).sourceHost, '');
    });
  });

  describe('the save step', () => {
    it('saves with the settings of the request and the start time and title of the capture', async () => {
      const { store, finalizer, request, saving } = setup();
      await capture(store, { frames: 12, tier: 'standard', title: 'Inbox - Mail' });
      const summary = await finalizer.finalize({ ...request, saveTiles: false, folderName: 'Shots' });
      const [saved] = saving.requests;
      assert.equal(saving.requests.length, 1);
      assert.equal(saved.date.getTime(), NOW);
      assert.equal(saved.title, 'Inbox - Mail');
      assert.equal(saved.tileCount, summary.tileCount);
      assert.equal(saved.tiles.length, summary.tileCount);
      assert.equal(saved.saveTiles, false);
      assert.equal(saved.saveFull, true);
      assert.equal(saved.folderName, 'Shots');
      assert.equal(saved.full.size, 1000);
    });

    it('uses the start time of the capture for the names, not the time of Done', async () => {
      const { store, finalizer, request, saving } = setup();
      await capture(store);
      await finalizer.finalize(request);
      assert.equal(saving.requests[0].date.getTime(), NOW);
    });

    it('one tile that is the image 1:1 is one picture: one build, fitsOneImage true', async () => {
      const { store, finalizer, request, render, saving } = setup();
      await capture(store, { frames: 1 });
      const summary = await finalizer.finalize(request);
      assert.equal(summary.tileCount, 1);
      assert.equal(summary.fitsOneImage, true);
      assert.equal(saving.requests[0].fitsOneImage, true);
      assert.equal(render.log.events.filter((e) => e.startsWith('tile ')).length, 1, 'the thumbnail');
      assert.equal(saving.requests[0].tiles[0], saving.requests[0].full, 'the same Blob');
    });

    it('one tile that is scaled is its own picture: built, saved and told apart', async () => {
      const { store, finalizer, request, render, saving } = setup();
      // A bitmap three times as wide as the viewport: 3000 px of image, wider than the tile tier.
      store.open(SESSION, TAB, 'Wide', 'high', '');
      const wide = PNG_PREFIX +
        Buffer.from(JSON.stringify({ w: 3000, h: 2400, origin: 0 })).toString('base64');
      const meta = { ...frame(0, 'initial').meta, rect: { x: 0, y: 100, width: 1000, height: 100 } };
      await store.addFrame(SESSION, TAB, wide, meta);
      const summary = await finalizer.finalize(request);
      assert.equal(summary.widthPx, 3000);
      assert.equal(summary.tileCount, 1);
      assert.equal(summary.fitsOneImage, false, 'the tile is scaled: not the full image');
      const saved = saving.requests[0];
      assert.equal(saved.fitsOneImage, false);
      assert.notEqual(saved.tiles[0], saved.full, 'two different Blobs');
      assert.equal(saved.tiles[0].size, 100);
      assert.equal(saved.full.size, 1000);
      assert.ok(render.log.tilePlans.some((p) => p.srcY === 0 && p.outWidth < 3000));
    });

    it('puts the save result and its warnings in the summary and in the last capture', async () => {
      const { store, last, finalizer, request } = setup();
      await capture(store);
      const summary = await finalizer.finalize(request);
      assert.deepEqual(summary.save, {
        location: 'downloads',
        label: 'Downloads/Spool',
        files: 4,
        needsPermission: false,
      });
      assert.ok(summary.warnings.includes('saver warning'));
      assert.equal(last.require(SESSION).summary, summary);
    });

    it('keeps the capture when the saver throws, and says it was not saved', async () => {
      const { store, last, finalizer, request, logged } = setup({}, { fail: true });
      await capture(store);
      const summary = await finalizer.finalize(request);
      assert.equal(summary.save.location, 'none');
      assert.equal(summary.save.error, 'Could not save the files.');
      assert.ok(last.has());
      assert.equal(logged.length, 1);
    });

    it('sets the last capture before it saves (the shelf works while the files are written)', async () => {
      const { store, last, finalizer, request, saving } = setup();
      await capture(store);
      let hadCapture = false;
      const save = saving.saver.save;
      saving.saver.save = async (/** @type {any} */ r) => {
        hadCapture = last.has();
        return save(r);
      };
      await finalizer.finalize(request);
      assert.equal(hadCapture, true);
    });
  });

  describe('failures', () => {
    it('keeps the session so Done can be tried again, when a tile fails', async () => {
      const { store, finalizer, request, render, last, logged } = setup({ failTile: 0 });
      await capture(store, { frames: 3 });
      await assert.rejects(finalizer.finalize(request), (e) =>
        isSpoolError(e, ERR.INTERNAL, 'Could not build the images. Try again.'),
      );
      assert.equal(render.log.disposed, 1, 'the bitmaps are freed');
      assert.equal(store.stateOf(SESSION, TAB), 'finished');
      assert.equal(last.has(), false);
      assert.equal(logged.length, 1);
      // A retry builds again (the fake no longer fails for this plan once we change it).
      render.ops.open = fakeRenderOps().ops.open;
      assert.equal((await finalizer.finalize(request)).sessionId, SESSION);
      assert.equal(store.stateOf(SESSION, TAB), null);
    });

    it('keeps the cause of the failure for the log, not for the page', async () => {
      const { store, finalizer, request } = setup({ failTile: 0 });
      await capture(store, { frames: 3 });
      try {
        await finalizer.finalize(request);
        assert.fail('should reject');
      } catch (e) {
        assert.ok(e instanceof SpoolError);
        assert.equal(/** @type {Error} */ (e.cause).message, 'tile failed');
        assert.ok(!e.message.includes('tile failed'));
      }
    });

    it('goes on without the full image when it fails and there are several tiles', async () => {
      const { store, last, finalizer, request, saving } = setup({ failFull: true });
      await capture(store, { frames: 12, tier: 'standard' });
      const summary = await finalizer.finalize(request);
      assert.ok(summary.tileCount > 1);
      assert.equal(summary.fullBytes, 0);
      assert.ok(summary.warnings.includes('The full image could not be built. You can still use the AI screenshots.'));
      assert.equal(last.require(SESSION).full, null);
      assert.equal(last.require(SESSION).tiles.length, summary.tileCount);
      assert.equal(saving.requests[0].full, null);
    });

    it('fails when the full image fails and it is also the only tile', async () => {
      const { store, finalizer, request } = setup({ failFull: true });
      await capture(store, { frames: 1 });
      await assert.rejects(finalizer.finalize(request), (e) => isSpoolError(e, ERR.INTERNAL));
      assert.equal(store.stateOf(SESSION, TAB), 'finished');
    });

    it('frees the session of a capture with no slice (there is nothing to try again)', async () => {
      const { store, finalizer, request, render } = setup();
      store.open(SESSION, TAB, 'Empty', 'high');
      await assert.rejects(finalizer.finalize(request), (e) =>
        isSpoolError(e, ERR.CAPTURE_FAILED, 'Nothing was captured.'),
      );
      assert.equal(store.stateOf(SESSION, TAB), null);
      assert.equal(render.log.open, 0);
    });

    it('keeps the old last capture when the new capture has nothing in it', async () => {
      const { store, last, finalizer, request } = setup();
      await capture(store, { id: SESSION });
      await finalizer.finalize(request);
      store.open(OTHER, 8, 'Empty', 'high');
      await assert.rejects(finalizer.finalize({ ...request, sessionId: OTHER, tabId: 8 }), (e) =>
        isSpoolError(e, ERR.CAPTURE_FAILED),
      );
      assert.equal(last.latest()?.sessionId, SESSION);
    });

    it('does not keep a failed finalize in memory: the next call starts again', async () => {
      const { store, finalizer, request } = setup({ failTile: 0 });
      await capture(store, { frames: 3 });
      await assert.rejects(finalizer.finalize(request));
      await assert.rejects(finalizer.finalize(request), (e) => isSpoolError(e, ERR.INTERNAL));
    });
  });

  describe('warnings', () => {
    it('lists a seam that could not be verified, and a long tile list', async () => {
      const { store, finalizer, request } = setup();
      // A page that jumps by a step that has no overlap: the second frame touches the first.
      store.open(SESSION, TAB, 'Page', 'standard');
      const first = frame(0, 'initial');
      await store.addFrame(SESSION, TAB, first.dataUrl, first.meta);
      const touching = frame(600, 'down'); // starts exactly where the first one ends
      await store.addFrame(SESSION, TAB, touching.dataUrl, touching.meta);
      const summary = await finalizer.finalize(request);
      assert.ok(
        summary.warnings.some((w) => /could not verify 1 seam/.test(w)),
        JSON.stringify(summary.warnings),
      );
    });
  });
});
