// @ts-check
import { expect, test, waitForResult } from './fixtures.js';
import {
  beginCapture,
  diffSnapshots,
  dragSelect,
  scrollState,
  snapshotPage,
  stepUntil,
  dismissToast,
} from './driver.js';
import { planDocumentBox } from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';

test('smooth-scroll: a page with scroll-behavior: smooth still gives exact bands', async ({
  page,
  context,
  server,
  scale,
}) => {
  await page.goto(server.url('/smooth-scroll.html?bands=300'));
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    'the fixture really uses smooth scrolling',
  ).toBe('smooth');
  const plan = await planDocumentBox(page, 160);
  const before = await snapshotPage(page, null);

  await beginCapture(page, () => dragSelect(page, plan.box));
  const steps = await stepUntil(page, {
    key: 'Space',
    atEnd: async () => (await scrollState(page, null)).top >= plan.max - 1,
  });
  await page.keyboard.press('Enter');

  const result = await waitForResult(context);
  const checks = await checkCapture(result, {
    scale,
    firstIndex: plan.firstIndex,
    lastIndex: plan.lastIndex,
    widthCss: plan.box.width,
  });
  test.info().annotations.push({ type: 'capture', description: `${steps} steps; ${checks.summary}` });
  await expectNoProblems(checks, scale);

  await dismissToast(page); // Done shows the toast in place of the overlay
  expect(diffSnapshots(before, await snapshotPage(page, null)), 'page state after the capture').toEqual([]);
  expect(
    await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    'scroll-behavior is restored',
  ).toBe('smooth');
});
