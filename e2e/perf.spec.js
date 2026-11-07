// @ts-check
/**
 * Performance of a long capture, and the release of what it holds (docs/contracts.md 7.6, 7.9).
 *
 * Scenario: the chat fixture (chat-inner.html) with a panel of 40 screens, captured in Auto mode at
 * device scale 1 (project scale-1; the other scales are not meaningful for these numbers). The
 * panel is 480 x 704 CSS px (viewport 1000 x 800 minus 96 px), a band is 8 px, the sticky header
 * 48 px: 40 screens = 40 * 704 = 28,160 px = 48 + 8 * 3,514 bands. The default step is the panel
 * height minus the overlap of 80 px, so the capture takes about 46 frames. The default limit of
 * 40,000 CSS px is not reached.
 *
 * What is measured, and where it comes from:
 *  - time per step, capture time (the queue wait for the rate limit included), the time of the
 *    offscreen intake of a frame, the time between two captures, the total capture time against
 *    the least time that Chrome's limit of 2 captures per second allows, and finalize (build and
 *    save): from the events of the test hook of the service worker (e2e/build-extension.mjs,
 *    timestamps in epoch ms);
 *  - the JS heap of the offscreen document: sampled every 100 ms with the DevTools protocol
 *    (`Performance.getMetrics`, JSHeapUsedSize) through `--remote-debugging-port`, because the
 *    offscreen document is not a Playwright page (e2e/cdp.js). The first sample is the baseline;
 *    after Done and the copy, a forced garbage collection gives the heap that stays. Blob data
 *    (slices, tiles, full image) lives outside the JS heap, so the heap shows what the code holds
 *    (row signatures, base64 text of a message), not the image bytes. Those are reported as
 *    output sizes;
 *  - the PNG encode time of the tiles and the thumbnail (`OffscreenCanvas.convertToBlob`, wrapped
 *    in the offscreen document for this run) and of the full image (from the creation of its
 *    compression stream to the creation of its Blob: draw, filter and deflate of 28,208 rows);
 *  - output sizes: the saved files (Chrome's file size of each download).
 *
 * Correctness comes first: the capture is checked like the other capture specs (bands, tiles,
 * seams), and the saved files are compared with the capture. A fast but wrong run fails.
 *
 * Slices freed and last-capture TTL: the second test. The time to live of the last capture is
 * LAST_CAPTURE_TTL_MS = 60 min, which no test can wait for. This test runs a COPY of the test
 * extension in which only that constant of src/shared/constants.js is replaced (regex on the
 * `export const LAST_CAPTURE_TTL_MS = ...;` line, written to a temporary folder below
 * os.tmpdir()/spool-e2e, deleted afterwards; the build fails loudly if the line is not found).
 * The production files and the shared test build are not touched.
 *
 * Budgets: generous on purpose. The measured values (median of the runs on the development
 * machine, scale 1, Chromium 158 headless, Windows 11) and the margin are in BUDGET below. A
 * budget fails only for a real regression (a slower algorithm, a leak), not for a slow CI machine.
 */

import fs from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { BUILD_PARENT } from './build-extension.mjs';
import { startHeapSampler } from './cdp.js';
import {
  beginCapture,
  clickSelect,
  dismissToast,
  scrollState,
  waitForText,
} from './driver.js';
import {
  expect,
  offscreenStatus,
  recordDownloads,
  savedDownloads,
  startShelf,
  test,
  waitForResult,
  workerEvents,
} from './fixtures.js';
import {
  captureChatAndFinish,
  COPIED_TITLE,
  savedFileProblems,
  thumbnailCheck,
} from './post-capture.js';
import {
  captureTimeline,
  formatBytes,
  formatMs,
  formatTable,
  heapPeak,
  summarize,
} from './perf-stats.js';
import { PANEL, panelBox, panelClickPoint } from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';
import { pollUntil } from './util.js';

/** The title of chat-inner.html: it is in the names of the saved files. */
const PAGE_TITLE = 'Chat with an inner scroller';

/** Screens of the panel, and the bands that make them (see the header). */
const SCREENS = 40;
const BANDS = 3514;
/** Height of the sticky header, and of a band, in CSS px (fixtures/chat-inner.html, bands.js). */
const HEADER_CSS = 48;

/**
 * Chrome allows 2 captureVisibleTab calls per second. The extension starts a call at least this
 * long after the start of the one before (CAPTURE_MIN_INTERVAL_MS), written out here on purpose.
 */
const MIN_INTERVAL_MS = 550;

/** The time to live of the last capture in the copy of the TTL test. */
const SHORT_TTL_MS = 20_000;

/**
 * Budgets, with the measured value (median of 3 runs, 45 frames, 12 tiles) and the margin.
 * Machine: development laptop (Windows 11, 20 logical cores, other work running at the same
 * time), Chromium 158, new headless mode. The runs differed by less than 5 % (the full PNG build
 * by 40 %, 1.0 to 1.4 s).
 *
 * | quantity                                | measured     | budget      | margin |
 * | captures per second (mean)              | 0.66         | <= 2        | 3.0x   |
 * | shortest gap between two captures       | 1,455 ms     | >= 300 ms   | 4.8x   |
 * | step, median / p95                      | 1.52 s / 1.60 s | 5 s / 8 s | 3.3x / 5x |
 * | offscreen intake of a frame, median/max | 1.02 s / 1.04 s | 4 s / 10 s | 3.9x / 9.6x |
 * | total capture time (45 frames)          | 68.3 s       | <= 240 s    | 3.5x   |
 * | finalize (Done to reply, 12 tiles)      | 16.1 s       | <= 90 s     | 5.6x   |
 * | full PNG build (28,208 rows)            | 1.0 s        | <= 10 s     | 9.6x   |
 * | offscreen JS heap peak                  | 1.6 MB       | <= 64 MB    | 40x    |
 * | JS heap after Done + GC over baseline   | +0.3 MB      | <= +16 MB   | 50x    |
 * | any saved file                          | 0.1 MB       | <= 10 MiB   | 100x   |
 *
 * Two facts the numbers show. (1) `OffscreenCanvas.convertToBlob` takes about 1.0 s per call in
 * this browser, for a 10 x 10 canvas as for a 480 x 2,576 tile (probed in the offscreen document),
 * so a frame costs 1.0 s of intake and a tile 1.0 s of finalize; the capture is bound by that and
 * by the agent's settle time (1.5 s per step), not by Chrome's limit of 2 captures per second
 * (0.66 per second, a third of it). (2) The fixture is flat colour bands: its PNGs are tiny (0.4 MB
 * for all files) and the JS heap holds no image data (Blob and canvas memory is outside it), so
 * the size and heap budgets only guard against a large regression, for example JS code that keeps
 * decoded rows. The time budgets are the useful ones.
 */
const BUDGET = Object.freeze({
  /** Chrome counts 2 calls per second. The queue waits MIN_INTERVAL_MS between starts. */
  maxCapturesPerSecond: 2,
  /** Completion times jitter by the duration of a capture: two captures can end closer than the interval. */
  minCaptureGapMs: 300,
  maxStepMedianMs: 5000,
  maxStepP95Ms: 8000,
  maxIntakeMedianMs: 4000,
  maxIntakeMaxMs: 10_000,
  maxTotalCaptureMs: 240_000,
  maxFinalizeMs: 90_000,
  maxFullBuildMs: 10_000,
  maxHeapPeakBytes: 64e6,
  maxHeapAfterGcOverBaselineBytes: 16e6,
  /** The chat apps take 10 MiB per image (MAX_IMAGE_BYTES); the spec states the limit itself. */
  maxFileBytes: 10 * 1024 * 1024,
});

/** @returns {Promise<number>} A free TCP port on 127.0.0.1. */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

// The browser listens for the DevTools protocol on this port (127.0.0.1 only) for the heap samples.
const DEBUG_PORT = await freePort();
test.use({ extraBrowserArgs: [`--remote-debugging-port=${DEBUG_PORT}`] });

/**
 * Script that runs in the offscreen document before the capture finishes. It wraps three browser
 * functions to record time stamps and keeps the records in `globalThis.__spoolPerf`:
 *  - OffscreenCanvas.convertToBlob: one record per PNG encode of a canvas (a frame while the
 *    capture runs; a tile and the thumbnail in finalize);
 *  - CompressionStream: created once when the full PNG build starts;
 *  - Blob: a record for every PNG Blob that is built from parts (a frame, and the full image).
 * The wrappers call the original and return its result.
 */
const INSTRUMENT = `(() => {
  if (globalThis.__spoolPerf) return true;
  const perf = { encodes: [], compressors: [], pngBlobs: [] };
  globalThis.__spoolPerf = perf;

  const proto = OffscreenCanvas.prototype;
  const convertToBlob = proto.convertToBlob;
  proto.convertToBlob = async function (...args) {
    const t0 = Date.now();
    const p0 = performance.now();
    const blob = await convertToBlob.apply(this, args);
    perf.encodes.push({ t0, ms: performance.now() - p0, width: this.width, height: this.height, bytes: blob.size });
    return blob;
  };

  const NativeCompressionStream = globalThis.CompressionStream;
  globalThis.CompressionStream = class extends NativeCompressionStream {
    constructor(...args) {
      super(...args);
      perf.compressors.push(Date.now());
    }
  };

  const NativeBlob = globalThis.Blob;
  globalThis.Blob = new Proxy(NativeBlob, {
    construct(target, args) {
      const blob = Reflect.construct(target, args);
      if (args[1] && args[1].type === 'image/png') perf.pngBlobs.push({ t: Date.now(), bytes: blob.size });
      return blob;
    },
  });
  return true;
})()`;

/**
 * @typedef {Object} OffscreenPerf
 * @property {{ t0: number, ms: number, width: number, height: number, bytes: number }[]} encodes
 * @property {number[]} compressors
 * @property {{ t: number, bytes: number }[]} pngBlobs
 */

test.describe('performance of a long capture', () => {
  test(
    `perf: ${SCREENS} screens at scale 1: step, capture, finalize, encode, heap and sizes stay in budget @perf`,
    async ({ page, context, server, scale }) => {
      test.setTimeout(600_000);
      test.skip(scale !== 1, 'The numbers and the budgets are for scale 1.');
      expect(BANDS * 8 + HEADER_CSS, 'the fixture is 40 screens of 704 px').toBe(SCREENS * 704);

      await recordDownloads(context);
      const startedAt = Date.now();
      await page.goto(server.url(`/chat-inner.html?bands=${BANDS}`));
      const box = await panelBox(page);
      expect(box.height, 'the panel is 704 px high (viewport 800 px)').toBeGreaterThan(690);
      const point = panelClickPoint(box);

      // The heap sampler waits for the offscreen document: it exists from the first frame on.
      const heap = startHeapSampler(DEBUG_PORT);
      try {
        await beginCapture(page, () => clickSelect(page, point.x, point.y));
        const cdp = await Promise.race([
          heap.ready,
          new Promise((_, reject) => setTimeout(() => reject(new Error('The offscreen document did not show up on the DevTools port.')), 30_000)),
        ]);
        await /** @type {import('./cdp.js').CdpClient} */ (cdp).evaluate(INSTRUMENT);

        await page.keyboard.press('a'); // Auto
        await pollUntil(
          async () => {
            const s = await scrollState(page, PANEL);
            return s.top >= s.max - 1;
          },
          { timeoutMs: 400_000, intervalMs: 250, message: 'auto mode did not scroll the panel to its end' },
        );
        await page.keyboard.press('Enter'); // Done: finishes after the current step.

        // The title of a long capture shows when the copy is done, after the finalize.
        await waitForText(page, COPIED_TITLE, 300_000);
        await waitForText(page, /\d+ AI screenshots ready · /, 30_000);

        const status = await offscreenStatus(context);
        const events = await workerEvents(context);
        const timeline = captureTimeline(events, { minIntervalMs: MIN_INTERVAL_MS });

        // What the offscreen document holds now, and what stays after a garbage collection.
        const live = /** @type {import('./cdp.js').CdpClient} */ (heap.client() ?? (await heap.ready));
        const perf = /** @type {OffscreenPerf} */ (await live.evaluate('globalThis.__spoolPerf'));
        await live.collectGarbage();
        const afterGc = await live.heap();
        const peak = heapPeak(heap.samples);

        // ---- The capture is right (before any number counts) --------------------------------
        const result = await waitForResult(context);
        const checks = await checkCapture(result, {
          scale,
          firstIndex: 0,
          lastIndex: BANDS - 1,
          widthCss: box.width,
          extraCss: HEADER_CSS,
        });
        await expectNoProblems(checks, scale);
        const downloads = await savedDownloads(context);
        expect(
          await savedFileProblems(context, result, { title: PAGE_TITLE, notBefore: startedAt }),
          'saved files',
        ).toEqual([]);
        expect(await thumbnailCheck(result), 'thumbnail of the summary').toEqual([]);
        const summary = await result.offscreenSummary();

        // ---- Numbers ------------------------------------------------------------------------
        const finishAt = events.find((e) => e.dir === 'in' && e.type === 'page/finish')?.t ?? 0;
        const finalizeEncodes = perf.encodes.filter((e) => e.t0 >= finishAt);
        const frameEncodes = perf.encodes.filter((e) => e.t0 < finishAt);
        const fullStart = perf.compressors.at(-1);
        const fullEnd = perf.pngBlobs.find((b) => fullStart !== undefined && b.t >= fullStart);
        const fullBuildMs = fullStart !== undefined && fullEnd ? fullEnd.t - fullStart : NaN;
        const step = summarize(timeline.stepMs);
        const capture = summarize(timeline.captureMs);
        const intake = summarize(timeline.intakeMs);
        const gap = summarize(timeline.captureGapMs);
        const frameEncode = summarize(frameEncodes.map((e) => e.ms));
        const tileEncode = summarize(finalizeEncodes.map((e) => e.ms));
        const files = downloads.map((d) => ({ name: d.requested, bytes: d.bytes.length }));
        const tileFiles = files.filter((f) => f.name.includes('/Spool for AI/'));
        const fullFile = files.find((f) => !f.name.includes('/Spool for AI/'));
        const filesTotal = files.reduce((sum, f) => sum + f.bytes, 0);

        const rows = [
          ['metric', 'value', 'budget'],
          ['frames stored', String(timeline.frames), '-'],
          ['capture failures (quota or other)', String(timeline.captureFailures), '0'],
          ['captures per second (mean)', timeline.capturesPerSecond.toFixed(2), `<= ${BUDGET.maxCapturesPerSecond}`],
          ['most captures ending in 1 s', String(timeline.mostCapturesInOneSecond), 'info'],
          ['shortest gap between two captures', formatMs(gap.min), `>= ${BUDGET.minCaptureGapMs} ms`],
          ['total capture time', formatMs(timeline.totalMs), `<= ${formatMs(BUDGET.maxTotalCaptureMs)}`],
          ['least time the 2/s limit allows', formatMs(timeline.floorMs), 'info'],
          ['total / least time', (timeline.totalMs / timeline.floorMs).toFixed(2), 'info'],
          ['step (median / p95 / max)', `${formatMs(step.median)} / ${formatMs(step.p95)} / ${formatMs(step.max)}`, `<= ${formatMs(BUDGET.maxStepMedianMs)} / ${formatMs(BUDGET.maxStepP95Ms)}`],
          ['capture incl. rate-limit wait (median / max)', `${formatMs(capture.median)} / ${formatMs(capture.max)}`, 'info'],
          ['offscreen intake of a frame (median / p95 / max)', `${formatMs(intake.median)} / ${formatMs(intake.p95)} / ${formatMs(intake.max)}`, `<= ${formatMs(BUDGET.maxIntakeMedianMs)} / max ${formatMs(BUDGET.maxIntakeMaxMs)}`],
          ['PNG encode of a frame crop (median / max)', `${formatMs(frameEncode.median)} / ${formatMs(frameEncode.max)} (n=${frameEncode.n})`, 'info'],
          ['finalize: Done to reply', formatMs(timeline.finalizeMs ?? NaN), `<= ${formatMs(BUDGET.maxFinalizeMs)}`],
          ['  build (Done to start of save)', formatMs(timeline.buildMs ?? NaN), 'info'],
          ['  save (downloads of all files)', formatMs(timeline.saveMs ?? NaN), 'info'],
          ['PNG encode of tiles + thumbnail (sum / max)', `${formatMs(tileEncode.mean * tileEncode.n)} / ${formatMs(tileEncode.max)} (n=${tileEncode.n})`, 'info'],
          ['full PNG build (draw + filter + deflate)', formatMs(fullBuildMs), `<= ${formatMs(BUDGET.maxFullBuildMs)}`],
          ['offscreen JS heap: baseline (first sample)', formatBytes(peak.firstBytes), 'info'],
          ['offscreen JS heap: peak', formatBytes(peak.peakBytes), `<= ${formatBytes(BUDGET.maxHeapPeakBytes)}`],
          ['offscreen JS heap: after Done + GC', formatBytes(afterGc.used), `<= baseline + ${formatBytes(BUDGET.maxHeapAfterGcOverBaselineBytes)}`],
          ['heap samples', String(peak.n), '-'],
          ['image', `${summary.widthPx} x ${summary.heightPx} px, ${summary.tileCount} tiles`, '-'],
          ['full image file', formatBytes(fullFile?.bytes ?? NaN), `<= ${formatBytes(BUDGET.maxFileBytes)}`],
          ['tile files (n / largest / total)', `${tileFiles.length} / ${formatBytes(Math.max(0, ...tileFiles.map((f) => f.bytes)))} / ${formatBytes(tileFiles.reduce((s, f) => s + f.bytes, 0))}`, `each <= ${formatBytes(BUDGET.maxFileBytes)}`],
          ['all saved files (total)', formatBytes(filesTotal), 'info'],
          ['summary.fullBytes', formatBytes(summary.fullBytes), 'info'],
        ];
        const table = formatTable(rows);
        console.log(`\n${table}\n`);
        test.info().annotations.push({ type: 'perf', description: `\n${table}` });
        test.info().annotations.push({ type: 'capture', description: checks.summary });

        // ---- Budgets ------------------------------------------------------------------------
        expect(timeline.frames, 'every step stored a frame').toBeGreaterThan(40);
        expect(timeline.captureFailures, 'Chrome never refused a capture (limit: 2 per second)').toBe(0);
        expect(timeline.capturesPerSecond, 'captures per second over the whole run').toBeLessThanOrEqual(BUDGET.maxCapturesPerSecond);
        expect(gap.min, 'shortest time between two captures (ms)').toBeGreaterThanOrEqual(BUDGET.minCaptureGapMs);
        expect(timeline.totalMs, 'total capture time (ms)').toBeLessThanOrEqual(BUDGET.maxTotalCaptureMs);
        expect(step.median, 'median step (ms)').toBeLessThanOrEqual(BUDGET.maxStepMedianMs);
        expect(step.p95, 'p95 step (ms)').toBeLessThanOrEqual(BUDGET.maxStepP95Ms);
        expect(intake.median, 'median offscreen intake (ms)').toBeLessThanOrEqual(BUDGET.maxIntakeMedianMs);
        expect(intake.max, 'slowest offscreen intake (ms)').toBeLessThanOrEqual(BUDGET.maxIntakeMaxMs);
        expect(timeline.finalizeMs, 'finalize (ms)').not.toBeNull();
        expect(timeline.finalizeMs ?? Infinity, 'finalize (ms)').toBeLessThanOrEqual(BUDGET.maxFinalizeMs);
        expect(Number.isFinite(fullBuildMs), 'the full PNG build was timed').toBe(true);
        expect(fullBuildMs, 'full PNG build (ms)').toBeLessThanOrEqual(BUDGET.maxFullBuildMs);
        expect(peak.n, 'the heap was sampled during the run').toBeGreaterThan(50);
        expect(peak.peakBytes, 'peak JS heap of the offscreen document').toBeLessThanOrEqual(BUDGET.maxHeapPeakBytes);
        expect(afterGc.used, 'JS heap after Done and a garbage collection').toBeLessThanOrEqual(peak.firstBytes + BUDGET.maxHeapAfterGcOverBaselineBytes);
        for (const f of files) expect(f.bytes, `${f.name} (bytes)`).toBeLessThanOrEqual(BUDGET.maxFileBytes);

        // Slices are freed once the outputs exist, and the outputs stay for the toast and the shelf.
        expect(status, 'the offscreen document after Done').toEqual({ exists: true, sessions: 0, lastCapture: true });
      } finally {
        await heap.stop();
      }
      await dismissToast(page);
    },
  );
});

// ---------------------------------------------------------------------------------------------
// Slices freed after finalize, and the last capture released after its time to live
// ---------------------------------------------------------------------------------------------

/**
 * Test object that runs a copy of the test extension with a short LAST_CAPTURE_TTL_MS (see the
 * header). The copy is made from the shared test build of the run.
 */
const ttlTest = /** @type {typeof test} */ (
  /** @type {any} */ (test).extend({
    extensionDir: [
      async (/** @type {{ extensionDir: string }} */ { extensionDir }, /** @type {(dir: string) => Promise<void>} */ use) => {
        await fs.mkdir(BUILD_PARENT, { recursive: true });
        const copy = path.join(BUILD_PARENT, `ttl-${randomUUID()}`);
        await fs.cp(extensionDir, copy, { recursive: true });
        const file = path.join(copy, 'src/shared/constants.js');
        const text = await fs.readFile(file, 'utf8');
        const line = /^export const LAST_CAPTURE_TTL_MS = [^;\n]+;$/m;
        if (!line.test(text)) {
          throw new Error('src/shared/constants.js has no "export const LAST_CAPTURE_TTL_MS = ...;" line to shorten.');
        }
        await fs.writeFile(file, text.replace(line, `export const LAST_CAPTURE_TTL_MS = ${SHORT_TTL_MS};`));
        try {
          await use(copy);
        } finally {
          await fs.rm(copy, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }).catch(() => undefined);
        }
      },
      { scope: 'worker' },
    ],
  })
);

ttlTest(
  `perf: after Done the slices are freed; the last capture is released ${SHORT_TTL_MS / 1000} s later (short TTL build)`,
  async ({ page, context, server }) => {
    ttlTest.setTimeout(300_000);
    await captureChatAndFinish(page, server, { bands: 300 });
    await waitForText(page, COPIED_TITLE, 120_000);

    const finalizedAt = (await workerEvents(context)).find(
      (e) => e.dir === 'out' && e.type === 'offscreen/finalize' && e.ok === true,
    )?.t;
    expect(finalizedAt, 'the finalize reply was seen').toBeDefined();
    const sinceFinalize = Date.now() - /** @type {number} */ (finalizedAt);
    expect(sinceFinalize, `this check must run well inside the ${SHORT_TTL_MS} ms time to live`).toBeLessThan(SHORT_TTL_MS - 5000);

    // Right after finalize: no session (the slices are freed), and the outputs are kept.
    expect(await offscreenStatus(context), 'just after Done').toEqual({ exists: true, sessions: 0, lastCapture: true });
    await dismissToast(page);

    // The time to live ends the last capture, and then the idle document closes.
    await pollUntil(async () => !(await offscreenStatus(context)).lastCapture, {
      timeoutMs: SHORT_TTL_MS + 40_000,
      intervalMs: 500,
      message: 'the last capture was not released after its time to live',
    });
    const releasedAfter = Date.now() - /** @type {number} */ (finalizedAt);
    const note = `last capture released ${formatMs(releasedAfter)} after the finalize reply (time to live ${formatMs(SHORT_TTL_MS)})`;
    console.log(`
${note}
`);
    test.info().annotations.push({ type: 'perf', description: note });
    expect(releasedAfter, 'the capture must not end early').toBeGreaterThanOrEqual(SHORT_TTL_MS * 0.5);
    expect(releasedAfter, 'the capture ends in about the time to live').toBeLessThanOrEqual(SHORT_TTL_MS + 30_000);
    await pollUntil(async () => !(await offscreenStatus(context)).exists, {
      timeoutMs: 20_000,
      message: 'the offscreen document did not close after it held nothing',
    });

    // What the user sees: the shelf has nothing to insert any more.
    await page.bringToFront();
    await startShelf(page);
    await waitForText(page, 'Nothing to insert yet. Press Alt+Shift+S to spool a page.');
    await dismissToast(page);
  },
);
