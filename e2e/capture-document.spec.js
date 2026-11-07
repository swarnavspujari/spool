// @ts-check
import { expect, test, waitForResult } from './fixtures.js';
import {
  beginCapture,
  diffSnapshots,
  dragSelect,
  scrollState,
  snapshotPage,
  dismissToast,
} from './driver.js';
import { planDocumentBox } from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';
import { pollUntil } from './util.js';

test(
  'capture-document: auto capture of a long page gives continuous bands and valid tiles',
  { tag: '@core' },
  async ({ page, context, server, scale }) => {
    await page.goto(server.url('/long-document.html'));
    // Start below the top, so that "the scroll position is restored" is a real check.
    const plan = await planDocumentBox(page, 400);
    const before = await snapshotPage(page, null);

    await beginCapture(page, () => dragSelect(page, plan.box));
    await page.keyboard.press('a'); // Auto
    await pollUntil(async () => (await scrollState(page, null)).top >= plan.max - 1, {
      timeoutMs: 90_000,
      intervalMs: 100,
      message: `auto mode did not scroll the page to its end (${plan.max})`,
    });
    await page.keyboard.press('Enter'); // Done: finishes after the current step.

    const result = await waitForResult(context);
    const checks = await checkCapture(result, {
      scale,
      firstIndex: plan.firstIndex,
      lastIndex: plan.lastIndex,
      widthCss: plan.box.width,
    });
    test.info().annotations.push({ type: 'capture', description: checks.summary });
    await expectNoProblems(checks, scale);

    // The page is as it was before: scroll position, inline styles, no overlay.
    await dismissToast(page); // Done shows the toast in place of the overlay
    const after = await snapshotPage(page, null);
    expect(diffSnapshots(before, after), 'page state after the capture').toEqual([]);
    expect((await scrollState(page, null)).top).toBeCloseTo(plan.startScroll, 0);
  },
);
