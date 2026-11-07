// @ts-check
import { expect, offscreenStatus, test, workerCounts } from './fixtures.js';
import {
  beginCapture,
  clickSelect,
  diffSnapshots,
  overlayHostCount,
  scrollState,
  snapshotPage,
  stepOnce,
  waitForOverlayGone,
} from './driver.js';
import { PANEL, panelBox, panelClickPoint, scrollPanel } from './scenarios.js';
import { pollUntil } from './util.js';

test('cancel-restores: Escape after two steps restores the page and opens no result tab', async ({
  page,
  context,
  server,
}) => {
  await page.goto(server.url('/chat-inner.html'));
  const box = await panelBox(page);
  await scrollPanel(page, 800); // A band-aligned position in the middle of the panel.
  const before = await snapshotPage(page, PANEL);
  const tabsBefore = context.pages().length;

  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));
  await stepOnce(page, 'Space');
  await stepOnce(page, 'Space');
  // During the session the agent has moved the panel, so restoring it is a real check.
  expect((await scrollState(page, PANEL)).top, 'the panel scrolled during the session').toBeGreaterThan(1000);
  expect(await overlayHostCount(page), 'the overlay is up during the session').toBe(1);

  // The frames of the session (the first one and two steps) are held by the offscreen document.
  expect(await offscreenStatus(context), 'the offscreen document holds the session').toEqual({
    exists: true,
    sessions: 1,
    lastCapture: false,
  });

  const cancelsBefore = (await workerCounts(context))['in page/cancel'] ?? 0;
  await page.keyboard.press('Escape'); // Cancel

  await waitForOverlayGone(page);
  await pollUntil(async () => ((await workerCounts(context))['in page/cancel'] ?? 0) > cancelsBefore, {
    message: 'the service worker did not receive page/cancel',
  });

  // The slices are freed: the session is gone from the offscreen document (it may close itself,
  // because nothing is left in it).
  await pollUntil(async () => (await offscreenStatus(context)).sessions === 0, {
    timeoutMs: 10_000,
    message: 'the offscreen document still holds the cancelled session',
  });
  expect(await offscreenStatus(context), 'nothing is left after cancel').toMatchObject({
    sessions: 0,
    lastCapture: false,
  });

  // The page is exactly as it was: scroll position, inline styles of every element, no overlay.
  const after = await snapshotPage(page, PANEL);
  expect(diffSnapshots(before, after), 'page state after cancel').toEqual([]);
  const visibility = await page.evaluate(() =>
    ['#header', '#composer', '#panel'].map((s) => {
      const el = document.querySelector(s);
      return el ? getComputedStyle(el).visibility : 'missing';
    }),
  );
  expect(visibility, 'header, composer and panel are visible again').toEqual(['visible', 'visible', 'visible']);

  // No result tab. This is a negative check, so it needs a short observation window after the
  // cancel was acknowledged.
  await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 500)));
  expect(context.pages().map((p) => p.url()), 'tabs after cancel').toHaveLength(tabsBefore);
});
