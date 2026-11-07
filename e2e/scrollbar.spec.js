// @ts-check
/**
 * Overlay scrollbars. macOS draws a scrollbar over the content, not
 * beside it, and so does Windows 11 when "Always show scrollbars" is off. `clientWidth` then holds
 * the width of the scrollbar, the capture rect covers it, and the thumb is in every frame at a new
 * height. The agent sets `scrollbar-width: none` on the scroll target for the session (through the
 * style jar, so the page is put back).
 *
 * The test browser hides scrollbars. These tests turn them on (`showScrollbars`, and the switch
 * `--enable-features=OverlayScrollbar`). What they check without doubt: the scroller has
 * `scrollbar-width: none` for the session and `auto` again afterwards. They also run the pixel check of
 * the whole capture with the scrollbar on. That check passes without the fix as well, because the
 * thumb of an overlay scrollbar fades about 500 ms after the scroll and the frames are taken later:
 * it would show the thumb only in a frame that is taken early. A screenshot 150 ms after a scroll shows
 * the thumb (104 pixels in the right edge of a 300 px scroller), and `scrollbar-width: none` removes it
 * (0 pixels), which is why the fix is a style and not a wait.
 */
import { expect, test, waitForResult } from './fixtures.js';
import {
  beginCapture,
  clickSelect,
  diffSnapshots,
  dismissToast,
  scrollState,
  snapshotPage,
  stepUntil,
} from './driver.js';
import {
  CHAT_HEADER_CSS,
  PANEL,
  chatForeignProblems,
  panelBox,
  panelClickPoint,
} from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';

test.use({ showScrollbars: true, extraBrowserArgs: ['--enable-features=OverlayScrollbar'] });

test('scrollbar: the browser draws an overlay scrollbar (the setup of this spec works)', async ({
  page,
  server,
}) => {
  await page.goto(server.url('/chat-inner.html'));
  const sizes = await page.evaluate(() => {
    const panel = /** @type {HTMLElement} */ (document.querySelector('#panel'));
    return { offset: panel.offsetWidth, client: panel.clientWidth };
  });
  expect(sizes.client, 'an overlay scrollbar takes no room: client width equals the width').toBe(
    sizes.offset,
  );
});

test('scrollbar: no thumb in the frames, and the page is put back', async ({
  page,
  context,
  server,
  scale,
}) => {
  await page.goto(server.url('/chat-inner.html'));
  const bands = await page.evaluate(() => Number(document.documentElement.dataset['bands']));
  const box = await panelBox(page);
  const before = await snapshotPage(page, PANEL);
  const before1 = await page.evaluate(
    (selector) => getComputedStyle(/** @type {Element} */ (document.querySelector(selector))).scrollbarWidth,
    PANEL,
  );
  expect(before1).toBe('auto');

  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));

  // For the whole session the panel has no scrollbar.
  const during = await page.evaluate(
    (selector) => getComputedStyle(/** @type {Element} */ (document.querySelector(selector))).scrollbarWidth,
    PANEL,
  );
  expect(during, 'scrollbar-width during the session').toBe('none');

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
    extraCss: CHAT_HEADER_CSS,
  });
  test.info().annotations.push({ type: 'capture', description: `${steps} steps; ${checks.summary}` });
  // Every pixel of every band has the colour of its band, also the right edge where a thumb would be.
  await expectNoProblems(checks, scale, chatForeignProblems(checks.bands));

  await dismissToast(page);
  const after = await page.evaluate(
    (selector) => getComputedStyle(/** @type {Element} */ (document.querySelector(selector))).scrollbarWidth,
    PANEL,
  );
  expect(after, 'scrollbar-width after the session').toBe('auto');
  expect(diffSnapshots(before, await snapshotPage(page, PANEL)), 'page state after the capture').toEqual([]);
});
