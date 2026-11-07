// @ts-check
import { expect, test, waitForResult } from './fixtures.js';
import {
  beginCapture,
  clickSelect,
  diffSnapshots,
  scrollState,
  snapshotPage,
  stepUntil,
  dismissToast,
} from './driver.js';
import {
  CHAT_HEADER_CSS,
  PANEL,
  chatForeignProblems,
  panelBox,
  panelClickPoint,
  scrollPanel,
} from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';

test('capture-up: start at the bottom, step up to the top, bands are continuous', async ({
  page,
  context,
  server,
  scale,
}) => {
  await page.goto(server.url('/chat-inner.html'));
  const bands = await page.evaluate(() => Number(document.documentElement.dataset['bands']));
  const box = await panelBox(page);
  await scrollPanel(page, 'bottom');
  const before = await snapshotPage(page, PANEL);

  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));

  const steps = await stepUntil(page, {
    key: 'ArrowUp',
    atEnd: async () => (await scrollState(page, PANEL)).top <= 0.5,
  });
  expect(steps, 'the panel needs several steps').toBeGreaterThan(3);
  await page.keyboard.press('Enter'); // Done

  const result = await waitForResult(context);
  const checks = await checkCapture(result, {
    scale,
    firstIndex: 0,
    lastIndex: bands - 1,
    widthCss: box.width,
    extraCss: CHAT_HEADER_CSS, // Header space at the top: the header itself or a blank gap.
  });
  test.info().annotations.push({ type: 'capture', description: `${steps} steps; ${checks.summary}` });
  await expectNoProblems(checks, scale, chatForeignProblems(checks.bands));

  // The panel is back at the bottom, where it was.
  await dismissToast(page); // Done shows the toast in place of the overlay
  expect(diffSnapshots(before, await snapshotPage(page, PANEL)), 'page state after the capture').toEqual([]);
});
