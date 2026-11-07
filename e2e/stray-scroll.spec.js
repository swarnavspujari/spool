// @ts-check
/**
 * A stray scroll: a scroll that the user made (a wheel notch that reached the page,
 * or a wheel that stopped Auto) moved the panel away from the place of the last frame. The next
 * frame then lay too far from the last one, the offscreen document refused it ("The page moved too
 * far."), and every later step failed the same way: only Done or Cancel remained.
 *
 * The agent now scrolls the page back to the place of the last frame before each step. This test
 * moves the panel by 100 px in the middle of a capture, steps on to the end, and checks that the
 * bands of the image are continuous and that the message never showed.
 */
import { expect, test, waitForResult } from './fixtures.js';
import {
  axTexts,
  beginCapture,
  clickSelect,
  dismissToast,
  scrollState,
  stepOnce,
  stepUntil,
} from './driver.js';
import { CHAT_HEADER_CSS, PANEL, chatForeignProblems, panelBox, panelClickPoint } from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';

/**
 * Moves the panel like a wheel notch that reached the page would: instantly, by `delta` CSS px.
 * @param {import('@playwright/test').Page} page
 * @param {number} delta
 */
async function strayScroll(page, delta) {
  await page.evaluate(
    ([selector, by]) => {
      const el = document.querySelector(/** @type {string} */ (selector));
      if (!el) throw new Error('panel not found');
      el.scrollBy({ top: /** @type {number} */ (by), behavior: 'instant' });
    },
    [PANEL, delta],
  );
}

test('stray scroll: a scroll that reached the page does not break the steps that follow', async ({
  page,
  context,
  server,
  scale,
}) => {
  await page.goto(server.url('/chat-inner.html'));
  const bands = await page.evaluate(() => Number(document.documentElement.dataset['bands']));
  const box = await panelBox(page);
  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));

  await stepOnce(page, 'Space');
  await stepOnce(page, 'Space');
  const before = (await scrollState(page, PANEL)).top;

  // The user scrolls by 100 px (and, later, back by 30 px): the panel is not where the last frame was.
  await strayScroll(page, 100);
  expect((await scrollState(page, PANEL)).top).toBeCloseTo(before + 100, 0);
  await stepOnce(page, 'Space');
  await strayScroll(page, -30);
  await stepOnce(page, 'ArrowDown');

  // The rest of the capture goes on to the end, with no manual help.
  const steps = await stepUntil(page, {
    key: 'Space',
    atEnd: async () => {
      const s = await scrollState(page, PANEL);
      return s.top >= s.max - 1;
    },
  });
  expect((await axTexts(page)).join(' | '), 'no "moved too far" message on the HUD').not.toContain('moved too far');
  await page.keyboard.press('Enter'); // Done

  const result = await waitForResult(context);
  const checks = await checkCapture(result, {
    scale,
    firstIndex: 0,
    lastIndex: bands - 1,
    widthCss: box.width,
    extraCss: CHAT_HEADER_CSS,
  });
  test.info().annotations.push({ type: 'capture', description: `${steps} more steps; ${checks.summary}` });
  await expectNoProblems(checks, scale, chatForeignProblems(checks.bands));
  await dismissToast(page);
});
