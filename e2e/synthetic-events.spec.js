// @ts-check
/**
 * Fake input from the page: a page script can dispatch keyboard events into the window (they
 * reach the overlay's listeners in the isolated world). Only events of the user (`isTrusted`) may
 * drive the overlay: a fake Escape, Enter, Space, ArrowDown or "a" must not cancel, finish or
 * scroll the capture, and the page must still receive its own fake events.
 *
 * Pointer events cannot be faked from outside: the overlay's elements are in a closed shadow
 * root, which the page cannot reach. Its trusted-only rule for pointer events is covered by
 * test/unit/overlay.test.js.
 */
import { expect, startCapture, test, workerCounts } from './fixtures.js';
import {
  clickSelect,
  frameCount,
  overlayHostCount,
  scrollState,
  waitForIdle,
  waitForOverlay,
  waitForOverlayGone,
} from './driver.js';
import { PANEL, panelBox, panelClickPoint } from './scenarios.js';
import { pollUntil } from './util.js';

/** Keys that the overlay claims. */
const KEYS = ['Escape', 'Enter', ' ', 'ArrowDown', 'ArrowUp', 'a'];

/**
 * Dispatches fake key events from the page (main world) at the window, and returns the keys that
 * the page's own listener received (the overlay must not stop them).
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<string[]>}
 */
function dispatchFakeKeys(page) {
  return page.evaluate((keys) => {
    /** @type {string[]} */
    const seen = [];
    const onKey = (/** @type {KeyboardEvent} */ e) => {
      seen.push(e.key);
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    for (const key of keys) {
      for (const type of ['keydown', 'keyup']) {
        const fake = new KeyboardEvent(type, { key, bubbles: true, cancelable: true });
        if (fake.isTrusted) throw new Error('a script-made event must not be trusted');
        window.dispatchEvent(fake);
      }
    }
    window.removeEventListener('keydown', onKey);
    window.removeEventListener('keyup', onKey);
    return seen;
  }, KEYS);
}

/** Lets the agent react, if it would. This is a negative check: it needs a short window. */
function observe(/** @type {import('@playwright/test').Page} */ page) {
  return page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 600)));
}

test('synthetic-events: fake keys from the page do not drive the overlay; real keys do', async ({
  page,
  context,
  server,
}) => {
  await page.goto(server.url('/chat-inner.html'));
  const box = await panelBox(page);
  const point = panelClickPoint(box);

  // While selecting: a fake Escape must not close the overlay.
  await startCapture(page);
  await waitForOverlay(page);
  const seenWhileSelecting = await dispatchFakeKeys(page);
  await observe(page);
  expect(await overlayHostCount(page), 'the overlay survives fake keys while selecting').toBe(1);
  expect(seenWhileSelecting, 'the page still gets its own fake events').toHaveLength(KEYS.length * 2);

  // During the session: fake Enter, Escape, Space, ArrowDown and "a" must change nothing.
  const framesBefore = await frameCount(context);
  await clickSelect(page, point.x, point.y);
  await pollUntil(async () => (await frameCount(context)) > framesBefore, {
    timeoutMs: 30_000,
    message: 'the initial frame was not stored',
  });
  // Idle: a real step key would be accepted now, so "nothing happened" proves the fakes are ignored.
  await waitForIdle(page);
  const frames = await frameCount(context);
  const counts = await workerCounts(context);
  const scrollTop = (await scrollState(page, PANEL)).top;

  const seenInSession = await dispatchFakeKeys(page);
  await observe(page);
  expect(seenInSession, 'the page still gets its own fake events').toHaveLength(KEYS.length * 2);
  expect(await overlayHostCount(page), 'the overlay survives fake keys during the session').toBe(1);
  expect(await frameCount(context), 'no fake key made a capture step').toBe(frames);
  expect((await scrollState(page, PANEL)).top, 'no fake key scrolled the panel').toBeCloseTo(scrollTop, 0);
  const after = await workerCounts(context);
  expect(after['in page/cancel'] ?? 0, 'no fake key cancelled the session').toBe(counts['in page/cancel'] ?? 0);
  expect(after['in page/finish'] ?? 0, 'no fake key finished the session').toBe(counts['in page/finish'] ?? 0);

  // A real key still works.
  const cancelsBefore = counts['in page/cancel'] ?? 0;
  await page.keyboard.press('Escape');
  await waitForOverlayGone(page);
  await pollUntil(async () => ((await workerCounts(context))['in page/cancel'] ?? 0) > cancelsBefore, {
    message: 'the service worker did not receive page/cancel after a real Escape',
  });
});
