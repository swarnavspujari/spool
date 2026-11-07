// @ts-check
/// <reference path="./globals.d.ts" />
/**
 * Playwright fixtures and extension helpers for the Spool end-to-end tests.
 *
 * Every test gets its own Chromium profile with the extension loaded (a persistent context in a
 * temporary folder), a page, and the extension's service worker. The extension copy is built once
 * per run by e2e/global-setup.mjs (see e2e/build-extension.mjs).
 *
 * Real device scale: Playwright's `deviceScaleFactor` option only emulates the page's
 * `devicePixelRatio`; `captureVisibleTab` still returns a 1x image then. To test real scaled
 * captures, the context is launched without viewport emulation. The browser gets the switch
 * `--force-device-scale-factor` and the window is resized (through CDP) until the page viewport
 * is exactly the configured size. The extension then sees what a user with display scaling sees.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test as base, expect, chromium } from '@playwright/test';

import { EXTENSION_DIR_ENV } from './build-extension.mjs';
import { startServer } from './server.mjs';
import { decodePng } from '../test/helpers/png-decode.js';
import { MSG, makeMessage } from '../src/shared/protocol.js';
import { base64ToBytes, pollUntil } from './util.js';

export { expect };

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */
/** @typedef {import('@playwright/test').Worker} Worker */
/** @typedef {import('../test/helpers/png-decode.js').DecodedPng} DecodedPng */
/** @typedef {import('../src/shared/types.js').SessionManifest} SessionManifest */
/** @typedef {import('../src/shared/types.js').TilePlan} TilePlan */
/** @typedef {import('../src/shared/types.js').FinishSummary} FinishSummary */
/** @typedef {import('./server.mjs').FixtureServer} FixtureServer */

/** Viewport (CSS px) when the project does not set one. */
const DEFAULT_VIEWPORT = Object.freeze({ width: 1000, height: 800 });

/** Path (below the extension folder) of the service worker script the tests look for. */
const SERVICE_WORKER_SUFFIX = '/src/sw/service-worker.js';


// ---------------------------------------------------------------------------------------------
// Browser launch
// ---------------------------------------------------------------------------------------------

/** Largest accepted difference between the wanted and the real viewport size, CSS px. */
const VIEWPORT_TOLERANCE_CSS = 3;

/**
 * Resizes the browser window until the page viewport (innerWidth x innerHeight) is as close as
 * possible to `width` x `height`. The window frame size differs by OS and Chromium version, so the
 * size is measured and corrected instead of assumed. At a fractional device scale the window
 * size is rounded to device pixels, so an exact match can be impossible (for example 1000x802
 * instead of 1000x800 at 1.25). That is accepted within VIEWPORT_TOLERANCE_CSS; the tests read
 * the real viewport size from the page.
 * @param {Page} page
 * @param {number} width
 * @param {number} height
 * @returns {Promise<{ width: number, height: number }>}  The real viewport size.
 */
async function fitViewport(page, width, height) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { windowId } = await cdp.send('Browser.getWindowForTarget');
    const measure = () =>
      page.evaluate(() => ({
        iw: innerWidth,
        ih: innerHeight,
        ow: outerWidth,
        oh: outerHeight,
      }));
    let m = await measure();
    for (let attempt = 0; attempt < 6 && (m.iw !== width || m.ih !== height); attempt++) {
      const wantOuter = { width: m.ow + (width - m.iw), height: m.oh + (height - m.ih) };
      await cdp.send('Browser.setWindowBounds', {
        windowId,
        bounds: { windowState: 'normal', ...wantOuter },
      });
      // Wait until the viewport reacts. If the window did not change (same rounded size), stop.
      const changed = await page
        .waitForFunction(([w, h]) => innerWidth !== w || innerHeight !== h, [m.iw, m.ih], {
          timeout: 1000,
        })
        .then(() => true, () => false);
      m = await measure();
      if (!changed) break;
    }
    if (Math.abs(m.iw - width) > VIEWPORT_TOLERANCE_CSS || Math.abs(m.ih - height) > VIEWPORT_TOLERANCE_CSS) {
      throw new Error(
        `Could not size the browser viewport to ${width}x${height}; it is ${m.iw}x${m.ih} ` +
          `(window ${m.ow}x${m.oh}).`,
      );
    }
    return { width: m.iw, height: m.ih };
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * @param {{ extensionDir: string, width: number, height: number, scale: number,
 *   extraArgs?: readonly string[], showScrollbars?: boolean }} options  `showScrollbars`: Playwright
 *   hides scrollbars in a headless browser (`--hide-scrollbars`). True draws them again: with
 *   `--enable-features=OverlayScrollbar` in `extraArgs` they are the overlay scrollbars of macOS and of
 *   Windows 11 with auto-hide, which are drawn over the content and not beside it.
 * @returns {Promise<{ context: BrowserContext, profileDir: string }>}
 */
export async function launchExtensionContext({
  extensionDir,
  width,
  height,
  scale,
  extraArgs = [],
  showScrollbars = false,
}) {
  const profileDir = await fs.mkdtemp(path.join(os.tmpdir(), 'spool-e2e-'));
  const context = await chromium.launchPersistentContext(profileDir, {
    channel: 'chromium', // New headless mode: it supports extensions.
    headless: true,
    ignoreDefaultArgs: showScrollbars ? ['--hide-scrollbars'] : [],
    viewport: null, // No emulation: see the file comment.
    args: [
      `--disable-extensions-except=${extensionDir}`,
      `--load-extension=${extensionDir}`,
      `--force-device-scale-factor=${scale}`,
      `--window-size=${width},${height}`,
      ...extraArgs,
    ],
  });
  return { context, profileDir };
}

/**
 * Returns the extension's service worker (waits for it when it has not started yet).
 * @param {BrowserContext} context
 * @param {number} [timeoutMs]
 * @returns {Promise<Worker>}
 */
export async function findServiceWorker(context, timeoutMs = 15_000) {
  /** @param {Worker} w */
  const isOurs = (w) => w.url().startsWith('chrome-extension://') && w.url().endsWith(SERVICE_WORKER_SUFFIX);
  const waiter = context.waitForEvent('serviceworker', { predicate: isOurs, timeout: timeoutMs });
  const existing = context.serviceWorkers().find(isOurs);
  if (existing) {
    waiter.catch(() => undefined);
    return existing;
  }
  return waiter;
}

// ---------------------------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} TestFixtures
 * @property {number} scale           Option. Device scale factor of the browser.
 * @property {{ width: number, height: number }} viewportSize  Option. Viewport in CSS px.
 * @property {string[]} extraBrowserArgs  Option. More Chromium switches (perf.spec.js uses
 *   `--remote-debugging-port` to reach the offscreen document, which is not a Playwright page).
 * @property {boolean} showScrollbars  Option. Draw scrollbars (scrollbar.spec.js).
 * @property {Worker} serviceWorker
 */

/**
 * @typedef {Object} WorkerFixtures
 * @property {string} extensionDir
 * @property {FixtureServer} server
 */

/**
 * @typedef {import('@playwright/test').Fixtures<
 *   TestFixtures,
 *   WorkerFixtures,
 *   import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions,
 *   import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions
 * >} FixtureSet
 */

/** @type {FixtureSet} */
const fixtures = {
  extensionDir: [
    async ({}, use) => {
      const dir = process.env[EXTENSION_DIR_ENV];
      if (!dir) {
        throw new Error(
          `${EXTENSION_DIR_ENV} is not set. The extension is built by e2e/global-setup.mjs; ` +
            'run the tests with `npx playwright test`.',
        );
      }
      await use(dir);
    },
    { scope: 'worker' },
  ],

  server: [
    async ({}, use) => {
      const server = await startServer();
      await use(server);
      await server.close();
    },
    { scope: 'worker' },
  ],

  // Options (set per project in playwright.config.js). They have their own names because the
  // built-in `deviceScaleFactor` and `viewport` options turn on emulation: Playwright applies
  // them to every launchPersistentContext call, and they conflict with `viewport: null`.
  scale: [1, { option: true }],
  viewportSize: [{ ...DEFAULT_VIEWPORT }, { option: true }],
  extraBrowserArgs: [[], { option: true }],
  showScrollbars: [false, { option: true }],

  context: async (
    { extensionDir, scale, viewportSize, extraBrowserArgs, showScrollbars },
    use,
    testInfo,
  ) => {
    const { context, profileDir } = await launchExtensionContext({
      extensionDir,
      width: viewportSize.width,
      height: viewportSize.height,
      scale,
      extraArgs: extraBrowserArgs,
      showScrollbars,
    });

    /** @type {string[]} */
    const log = [];
    context.on('console', (msg) => {
      const where = msg.worker() ? 'worker' : 'page';
      log.push(`[${where} ${msg.type()}] ${msg.text()}`);
    });
    context.on('weberror', (err) => {
      log.push(`[uncaught] ${err.error().stack ?? err.error().message}`);
    });

    try {
      await use(context);
    } finally {
      if (testInfo.status !== testInfo.expectedStatus) {
        await attachDiagnostics(context, testInfo, log).catch(() => undefined);
      }
      await context.close().catch(() => undefined);
      await fs
        .rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
        .catch(() => undefined);
    }
  },

  page: async ({ context, scale, viewportSize }, use, testInfo) => {
    const page = context.pages()[0] ?? (await context.waitForEvent('page'));
    const real = await fitViewport(page, viewportSize.width, viewportSize.height);
    if (real.width !== viewportSize.width || real.height !== viewportSize.height) {
      testInfo.annotations.push({
        type: 'viewport',
        description: `wanted ${viewportSize.width}x${viewportSize.height}, real ${real.width}x${real.height} CSS px (window sizes are rounded to device pixels)`,
      });
    }
    const actual = await page.evaluate(() => devicePixelRatio);
    if (actual !== scale) {
      throw new Error(`devicePixelRatio is ${actual}; the project asked for ${scale}.`);
    }
    await use(page);
  },

  serviceWorker: async ({ context }, use) => {
    await use(await findServiceWorker(context));
  },
};

/**
 * @typedef {import('@playwright/test').TestType<
 *   import('@playwright/test').PlaywrightTestArgs & import('@playwright/test').PlaywrightTestOptions & TestFixtures,
 *   import('@playwright/test').PlaywrightWorkerArgs & import('@playwright/test').PlaywrightWorkerOptions & WorkerFixtures
 * >} ExtendedTest
 */

// The fixture bodies above are type-checked through FixtureSet. Playwright's `extend` cannot infer
// our fixture types from a JSDoc-typed object, so the result gets its type by a cast.
export const test = /** @type {ExtendedTest} */ (
  /** @type {unknown} */ (base.extend(/** @type {any} */ (fixtures)))
);

/**
 * Attaches what helps to understand a failure: console output, the service worker's event log,
 * and a screenshot of every open tab.
 * @param {BrowserContext} context
 * @param {import('@playwright/test').TestInfo} testInfo
 * @param {string[]} log
 */
async function attachDiagnostics(context, testInfo, log) {
  await testInfo.attach('console.txt', { body: log.join('\n') || '(empty)', contentType: 'text/plain' });
  try {
    const sw = await findServiceWorker(context, 2000);
    const events = await sw.evaluate(() => globalThis.__spoolTest?.events ?? null);
    await testInfo.attach('service-worker-events.json', {
      body: JSON.stringify(events, null, 1),
      contentType: 'application/json',
    });
  } catch {
    // No service worker (for example the failure was before the extension loaded).
  }
  let n = 0;
  for (const p of context.pages()) {
    n += 1;
    try {
      const body = await p.screenshot({ timeout: 5000 });
      await testInfo.attach(`tab-${n}.png`, { body, contentType: 'image/png' });
    } catch {
      // Not every tab can be captured.
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Extension helpers
// ---------------------------------------------------------------------------------------------

/**
 * Starts a capture in `page`'s tab, like a click on the toolbar button would. The page is brought
 * to front first (the tab must be the active tab of its window).
 * @param {Page} page
 */
export async function startCapture(page) {
  await page.bringToFront();
  const sw = await findServiceWorker(page.context());
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await globalThis.__spoolTest.startCapture(tab);
  });
}

/**
 * Opens the shelf of the last capture in `page`'s tab, like the command Alt+Shift+V would. The page
 * is brought to front first (the tab must be the active tab of its window).
 * @param {Page} page
 */
export async function startShelf(page) {
  await page.bringToFront();
  const sw = await findServiceWorker(page.context());
  await sw.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    await globalThis.__spoolTest.startShelf(tab);
  });
}

/**
 * @typedef {Object} ResultTab
 * @property {Page} page
 * @property {SessionManifest} manifest
 * @property {TilePlan[]} tilePlan
 * @property {() => Promise<FinishSummary>} offscreenSummary  The summary that the offscreen document
 *   keeps for this capture (thumbnail, sizes, what was saved). The result page itself has no
 *   thumbnail: it keeps a reduced copy.
 * @property {() => Promise<Uint8Array>} fullPng        The full image as PNG bytes.
 * @property {() => Promise<DecodedPng>} decodeFull
 * @property {(index: number) => Promise<DecodedPng>} decodeTile
 */

/** Session IDs that `waitForResult` has opened already, and the finalize count it has seen. */
const resultsSeen = new WeakMap();

/**
 * Opens the result page of the capture that was just finished, waits until it has built the tiles
 * and the full image, and returns handles to read them. Done opens no result tab by itself (the
 * clipboard and the toast are the result), so this opens `result.html#<session>` in a new tab,
 * like the toast's Open button. The session comes from the page/finish message that the service
 * worker received, and the page waits until the offscreen document has finalized the capture.
 * Fails fast, with the page text, when the result page shows an error.
 * @param {BrowserContext} context
 * @param {{ openTimeoutMs?: number, readyTimeoutMs?: number }} [options]
 * @returns {Promise<ResultTab>}
 */
export async function waitForResult(context, options = {}) {
  const { openTimeoutMs = 60_000, readyTimeoutMs = 90_000 } = options;
  const sw = await findServiceWorker(context);
  const seen = resultsSeen.get(context) ?? { sessions: new Set(), finalized: 0 };
  resultsSeen.set(context, seen);

  const sessionId = await pollUntil(
    async () => {
      const state = await sw.evaluate(() => ({
        sessions: globalThis.__spoolTest.events
          .filter((e) => e.dir === 'in' && e.type === 'page/finish' && typeof e.sessionId === 'string')
          .map((e) => e.sessionId),
        finalized: globalThis.__spoolTest.counts['out offscreen/finalize ok'] ?? 0,
      }));
      const fresh = state.sessions.filter((id) => !seen.sessions.has(id)).at(-1);
      return fresh && state.finalized > seen.finalized ? { id: fresh, finalized: state.finalized } : null;
    },
    {
      timeoutMs: openTimeoutMs,
      intervalMs: 100,
      message: () => `the capture was not finished (open tabs: ${context.pages().map((p) => p.url()).join(' | ')})`,
    },
  );
  seen.sessions.add(sessionId.id);
  seen.finalized = sessionId.finalized;

  const page = await context.newPage();
  const extensionId = new URL(sw.url()).host;
  await page.goto(`chrome-extension://${extensionId}/src/result/result.html#${sessionId.id}`);

  await page
    .waitForFunction(
      () => ['ready', 'error'].includes(document.body?.dataset?.['state'] ?? ''),
      null,
      { timeout: readyTimeoutMs, polling: 100 },
    )
    .catch(async (e) => {
      const text = await page.evaluate(() => document.body?.innerText ?? '').catch(() => '');
      throw new Error(
        `The result page did not become ready in ${readyTimeoutMs} ms: ${e.message}\n` +
          `Page text: ${text.replace(/\s+/g, ' ').slice(0, 600)}`,
      );
    });
  const state = await page.evaluate(() => document.body.dataset['state']);
  if (state === 'error') {
    const text = await page.evaluate(() => document.body.innerText);
    throw new Error(`The result page reports an error: ${text.replace(/\s+/g, ' ').slice(0, 600)}`);
  }

  const info = await page.evaluate(() => {
    const debug = /** @type {any} */ (globalThis).spoolDebug;
    return { manifest: debug.manifest, tilePlan: debug.tilePlan };
  });
  /** @type {Uint8Array | null} */
  let cachedFull = null;
  const fullPng = async () => {
    cachedFull ??= base64ToBytes(
      await page.evaluate(() => /** @type {any} */ (globalThis).spoolDebug.getFullBase64()),
    );
    return cachedFull;
  };
  return {
    page,
    manifest: info.manifest,
    tilePlan: info.tilePlan,
    offscreenSummary: async () => {
      // The result page asks like this itself (it is the only context that may).
      const reply = await page.evaluate(
        (m) => chrome.runtime.sendMessage(m),
        makeMessage(MSG.OFF_LAST_INFO, { sessionId: sessionId.id }),
      );
      if (!reply || reply.ok !== true) throw new Error(`offscreen/last-info failed: ${JSON.stringify(reply)}`);
      return reply.summary;
    },
    fullPng,
    decodeFull: async () => decodePng(await fullPng()),
    decodeTile: async (index) =>
      decodePng(
        base64ToBytes(
          await page.evaluate(
            (i) => /** @type {any} */ (globalThis).spoolDebug.getTileBase64(i),
            index,
          ),
        ),
      ),
  };
}

/**
 * Event counters of the service worker (see e2e/build-extension.mjs, test-hook.js).
 * Keys look like "out offscreen/add-frame" and "out offscreen/add-frame ok".
 * @param {BrowserContext} context
 * @returns {Promise<Record<string, number>>}
 */
export async function workerCounts(context) {
  const sw = await findServiceWorker(context);
  return sw.evaluate(() => ({ ...globalThis.__spoolTest.counts }));
}

/**
 * Recent service worker events (see workerCounts()).
 * @param {BrowserContext} context
 * @returns {Promise<WorkerEvent[]>}
 */
export async function workerEvents(context) {
  const sw = await findServiceWorker(context);
  return sw.evaluate(() => [...globalThis.__spoolTest.events]);
}

// ---------------------------------------------------------------------------------------------
// The offscreen document and the downloads, seen from the service worker
// ---------------------------------------------------------------------------------------------

/**
 * Sends a message to the offscreen document from the service worker, as the worker itself does
 * (the offscreen document accepts these messages only from the worker's script URL).
 * @param {BrowserContext} context
 * @param {string} type  One of MSG, with the offscreen document as its target.
 * @param {Record<string, unknown>} [fields]
 * @returns {Promise<Record<string, any>>}  The reply: { ok: true, ...data } or { ok: false, error }.
 */
export async function sendToOffscreen(context, type, fields = {}) {
  const sw = await findServiceWorker(context);
  const message = makeMessage(type, fields);
  return sw.evaluate((m) => chrome.runtime.sendMessage(m), message);
}

/**
 * What the offscreen document holds, asked with `offscreen/ping`: the number of capture sessions
 * (slices in memory) and whether a last capture (the outputs) exists. A closed document holds
 * nothing.
 * @param {BrowserContext} context
 * @returns {Promise<{ exists: boolean, sessions: number, lastCapture: boolean }>}
 */
export async function offscreenStatus(context) {
  const sw = await findServiceWorker(context);
  const exists = await sw.evaluate(
    async () =>
      (await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] })).length > 0,
  );
  if (!exists) return { exists: false, sessions: 0, lastCapture: false };
  /** @type {Record<string, any> | undefined} */
  let reply;
  try {
    reply = await sendToOffscreen(context, MSG.OFF_PING);
  } catch {
    // The document closed between the two calls.
  }
  if (!reply || reply['ok'] !== true) return { exists: false, sessions: 0, lastCapture: false };
  return { exists: true, sessions: Number(reply['sessions']), lastCapture: reply['lastCapture'] === true };
}

/**
 * Makes the service worker remember every download it starts (the requested path and the id), so
 * that a test can check the names. Chrome keeps only the path that it saved to, and in the test
 * browser that path is a GUID file of Playwright. Call it before the capture; once per browser.
 * @param {BrowserContext} context
 */
export async function recordDownloads(context) {
  const sw = await findServiceWorker(context);
  await sw.evaluate(() => {
    if (globalThis.__spoolDownloads) return;
    /** @type {{ id: number, filename: string, conflictAction: string, urlScheme: string }[]} */
    const started = [];
    globalThis.__spoolDownloads = started;
    /** @type {any} */
    const api = chrome.downloads;
    const original = api.download.bind(api);
    // The downloader reads chrome.downloads.download at every call, so this takes its place.
    api.download = async (/** @type {any} */ options) => {
      const id = await original(options);
      started.push({
        id,
        filename: String(options.filename),
        conflictAction: String(options.conflictAction),
        urlScheme: String(options.url).split(':')[0] ?? '',
      });
      return id;
    };
  });
}

/**
 * @typedef {Object} SavedDownload
 * @property {string} requested     The path that the extension asked for (relative to Downloads).
 * @property {string} conflictAction
 * @property {string} urlScheme     Of the URL that was downloaded ('blob').
 * @property {string} state         'complete' when the file is whole.
 * @property {string} path          Where Chrome put the file (a GUID file in the test browser).
 * @property {number} size          Bytes, as Chrome counts them.
 * @property {Uint8Array} bytes     The file, read from disk.
 */

/**
 * The downloads that the worker started since recordDownloads(), in start order, with the file
 * that Chrome wrote for each.
 * @param {BrowserContext} context
 * @returns {Promise<SavedDownload[]>}
 */
export async function savedDownloads(context) {
  const sw = await findServiceWorker(context);
  const { started, items } = await sw.evaluate(async () => ({
    started: [...(globalThis.__spoolDownloads ?? [])],
    items: (await chrome.downloads.search({})).map((d) => ({
      id: d.id,
      state: d.state,
      path: d.filename,
      size: d.fileSize,
    })),
  }));
  return Promise.all(
    started.map(async (request) => {
      const item = items.find((i) => i.id === request.id);
      const path = item?.path ?? '';
      const bytes = path === '' ? new Uint8Array() : new Uint8Array(await fs.readFile(path).catch(() => Buffer.alloc(0)));
      return {
        requested: request.filename,
        conflictAction: request.conflictAction,
        urlScheme: request.urlScheme,
        state: item?.state ?? 'missing',
        path,
        size: item?.size ?? 0,
        bytes,
      };
    }),
  );
}
