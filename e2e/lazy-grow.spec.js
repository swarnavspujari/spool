// @ts-check
import { expect, test, waitForResult } from './fixtures.js';
import {
  beginCapture,
  clickSelect,
  diffSnapshots,
  scrollState,
  snapshotPage,
  dismissToast,
} from './driver.js';
import { PANEL, panelBox, panelClickPoint } from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';
import { pollUntil } from './util.js';

test('lazy-grow: a list that grows at the bottom (twice) is captured to its real end', async ({
  page,
  context,
  server,
  scale,
}) => {
  await page.goto(server.url('/lazy-grow.html'));
  const box = await panelBox(page);
  // The page adds bands to its own list while it is captured: leave the bands out of the snapshot.
  const before = await snapshotPage(page, PANEL, '.band');

  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));
  await page.keyboard.press('a'); // Auto

  // The list has 200 bands and grows by 100 each of the first two times the bottom is reached.
  const lazy = () =>
    page.evaluate(() => {
      const s = /** @type {any} */ (globalThis).lazyState;
      return { grown: s.grown, total: s.total, pending: s.pending };
    });
  await pollUntil(
    async () => {
      const [state, scroll] = await Promise.all([lazy(), scrollState(page, PANEL)]);
      return state.grown === 2 && !state.pending && scroll.top >= scroll.max - 1;
    },
    {
      timeoutMs: 90_000,
      intervalMs: 100,
      message: 'auto mode did not reach the end of the grown list',
    },
  );
  await page.keyboard.press('Enter');

  const final = await lazy();
  expect(final.total).toBe(400);
  const result = await waitForResult(context);
  const checks = await checkCapture(result, {
    scale,
    firstIndex: 0,
    lastIndex: final.total - 1,
    widthCss: box.width,
  });
  test.info().annotations.push({ type: 'capture', description: checks.summary });
  await expectNoProblems(checks, scale);

  await dismissToast(page); // Done shows the toast in place of the overlay
  expect(diffSnapshots(before, await snapshotPage(page, PANEL, '.band')), 'page state after the capture').toEqual([]);
});
