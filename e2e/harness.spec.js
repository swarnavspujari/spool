// @ts-check
/**
 * Checks of the test harness itself: the extension copy loads, the hooks work, and the browser
 * has the viewport and the scale the other specs rely on. When a capture spec fails in a strange
 * way, run these first.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { BUILD_PARENT, REPO_ROOT, TEST_BUILD_NAME, patchManifest } from './build-extension.mjs';
import { expect, test } from './fixtures.js';

test('harness: the test extension loads, and its hooks are reachable', async ({
  serviceWorker,
  extensionDir,
}) => {
  expect(serviceWorker.url()).toMatch(/^chrome-extension:\/\/[a-p]{32}\/src\/sw\/service-worker\.js$/);
  const info = await serviceWorker.evaluate(() => ({
    startCapture: typeof globalThis.__spoolTest.startCapture,
    counts: typeof globalThis.__spoolTest.counts,
    events: Array.isArray(globalThis.__spoolTest.events),
    manifest: chrome.runtime.getManifest(),
  }));
  expect(info.startCapture).toBe('function');
  expect(info.counts).toBe('object');
  expect(info.events).toBe(true);
  expect(info.manifest.host_permissions).toContain('<all_urls>');
  expect(/** @type {any} */ (info.manifest.background)?.service_worker).toBe('src/sw/service-worker.js');
  // The build is outside the repository (below the temp folder) and is marked as a test build.
  expect(path.resolve(extensionDir).startsWith(path.resolve(BUILD_PARENT) + path.sep)).toBe(true);
  expect(info.manifest.name).toContain(TEST_BUILD_NAME);
});

test('harness: only the copy is patched, production files are untouched', async ({
  extensionDir,
}) => {
  const production = JSON.parse(await fs.readFile(path.join(REPO_ROOT, 'manifest.json'), 'utf8'));
  expect(production.host_permissions, 'the real manifest has no host permissions').toBeUndefined();
  expect(production.background.service_worker).toBe('src/sw/service-worker.js');

  const copy = JSON.parse(await fs.readFile(path.join(extensionDir, 'manifest.json'), 'utf8'));
  expect(copy.host_permissions).toEqual(['<all_urls>']);
  expect(copy, 'the copy is the production manifest with the marks of patchManifest()').toEqual(
    patchManifest(production),
  );
  expect(production.name, 'the real manifest has none of the test marks').not.toContain(TEST_BUILD_NAME);

  const original = await fs.readFile(path.join(REPO_ROOT, 'src/sw/service-worker.js'));
  const moved = await fs.readFile(path.join(extensionDir, 'src/sw/service-worker.original.js'));
  expect(Buffer.compare(original, moved), 'the production worker is copied unchanged').toBe(0);
});

test('harness: the viewport size and the device scale are real', { tag: '@core' }, async ({
  page,
  serviceWorker,
  server,
  scale,
  viewportSize,
}) => {
  await page.goto(server.url('/long-document.html?bands=20'));
  await page.bringToFront();
  const view = await page.evaluate(() => ({
    width: innerWidth,
    height: innerHeight,
    dpr: devicePixelRatio,
  }));
  expect(view.dpr).toBe(scale);
  // The window size is rounded to device pixels, so the viewport can differ by 1-2 CSS px.
  expect(Math.abs(view.width - viewportSize.width)).toBeLessThanOrEqual(3);
  expect(Math.abs(view.height - viewportSize.height)).toBeLessThanOrEqual(3);

  // captureVisibleTab must return the page at the real device scale (Playwright's
  // deviceScaleFactor emulation would return a 1x image here).
  //
  // This is the first capture of a page that has just loaded. Chrome answers "image readback
  // failed" until the tab has presented its first frame, which can take a few hundred ms.
  // The product path waits for frames and retries that one error (see
  // src/sw/capture.js); the test waits the same way, a bounded number of times, and no other error.
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
  );
  const bitmap = await serviceWorker.evaluate(async () => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    const windowId = tab?.windowId ?? chrome.windows.WINDOW_ID_CURRENT;
    /** @type {string | undefined} */
    let url;
    for (let attempt = 0; url === undefined; attempt += 1) {
      try {
        url = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
      } catch (error) {
        const transient = String(/** @type {Error} */ (error)?.message).includes('image readback failed');
        if (!transient || attempt >= 20) throw error;
        await new Promise((resolve) => setTimeout(resolve, 150));
      }
    }
    // Width and height are the first two numbers of the PNG header (the extension's CSP does not
    // allow fetch() of a data URL in the worker).
    const header = atob(url.slice(url.indexOf(',') + 1, url.indexOf(',') + 45));
    const at = (/** @type {number} */ o) =>
      ((header.charCodeAt(o) << 24) | (header.charCodeAt(o + 1) << 16) | (header.charCodeAt(o + 2) << 8) | header.charCodeAt(o + 3)) >>> 0;
    return { width: at(16), height: at(20) };
  });
  // At a fractional scale, innerHeight * scale is not a whole number; Chrome rounds either way.
  expect(Math.abs(bitmap.width - view.width * scale)).toBeLessThanOrEqual(1);
  expect(Math.abs(bitmap.height - view.height * scale)).toBeLessThanOrEqual(1);
});
