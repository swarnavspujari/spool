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
} from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';

test(
  'capture-chat-inner: a click selects the inner panel; stepping down gives continuous bands',
  { tag: '@core' },
  async ({ page, context, server, scale }) => {
    await page.goto(server.url('/chat-inner.html'));
    const bands = await page.evaluate(() => Number(document.documentElement.dataset['bands']));
    const box = await panelBox(page);
    const before = await snapshotPage(page, PANEL);

    const point = panelClickPoint(box);
    await beginCapture(page, () => clickSelect(page, point.x, point.y));

    // Step with Space and ArrowDown, alternately, until the panel is at its end.
    const steps = await stepUntil(page, {
      key: ['Space', 'ArrowDown'],
      atEnd: async () => {
        const s = await scrollState(page, PANEL);
        return s.top >= s.max - 1;
      },
    });
    expect(steps, 'the panel needs several steps').toBeGreaterThan(3);
    await page.keyboard.press('Enter'); // Done

    const result = await waitForResult(context);
    const checks = await checkCapture(result, {
      scale,
      firstIndex: 0,
      lastIndex: bands - 1,
      widthCss: box.width,
      extraCss: CHAT_HEADER_CSS, // The sticky header is in the flow at the top of the panel.
    });
    test.info().annotations.push({ type: 'capture', description: `${steps} steps; ${checks.summary}` });
    await expectNoProblems(checks, scale, chatForeignProblems(checks.bands));

    await dismissToast(page); // Done shows the toast in place of the overlay
    expect(diffSnapshots(before, await snapshotPage(page, PANEL)), 'page state after the capture').toEqual([]);
  },
);
