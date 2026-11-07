// @ts-check
/**
 * The overlay must stay above everything the page can put in the top layer. A very large z-index
 * does not do it: a modal <dialog>, a popover or a fullscreen element is drawn above it. A modal
 * dialog also makes the rest of the page inert, so the overlay cannot be used from outside it.
 * The overlay is a manual popover (top layer) and sits inside an open modal dialog.
 */
import { expect, startCapture, test, waitForResult } from './fixtures.js';
import {
  beginCapture,
  clickSelect,
  diffSnapshots,
  frameCount,
  overlayHostCount,
  scrollState,
  snapshotPage,
  stepUntil,
  waitForFrameCount,
  waitForIdle,
  waitForOverlayGone,
} from './driver.js';
import { PANEL, panelBox, panelClickPoint } from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';
import { pollUntil } from './util.js';

/** @typedef {import('@playwright/test').Page} Page */

/**
 * The topmost element at the middle of the viewport, as the page's own hit test sees it. The
 * overlay is the element with `popover="manual"` that has no id (the test's own elements have one).
 * @param {Page} page
 */
function topAtCentre(page) {
  return page.evaluate(() => {
    const top = document.elementsFromPoint(innerWidth / 2, innerHeight / 2)[0];
    if (!top) return null;
    return {
      id: top.id,
      popover: top.getAttribute('popover'),
      parent: top.parentElement ? top.parentElement.id || top.parentElement.tagName : null,
    };
  });
}

/** Where the overlay is: `{ popover: 'manual', parent }` with the id or the tag of its parent. */
const overlayIn = (/** @type {string} */ parent) => ({ id: '', popover: 'manual', parent });

test('top-layer: with a modal dialog open, the overlay is above it and a capture works', async ({
  page,
  context,
  server,
  scale,
}) => {
  await page.goto(server.url('/modal-dialog.html'));
  await page.waitForFunction(() => document.getElementById('dlg')?.matches(':modal'));
  const bands = await page.evaluate(() => Number(document.documentElement.dataset['bands']));
  const box = await panelBox(page);
  const before = await snapshotPage(page, PANEL);

  // Without the top layer the overlay would be under the dialog, and a click would hit the dialog.
  const framesBefore = await frameCount(context);
  await startCapture(page);
  await pollUntil(() => page.evaluate(() => document.querySelector('#dlg > [popover]') !== null), {
    timeoutMs: 15_000,
    message: 'the overlay did not appear (it belongs inside the open dialog)',
  });
  expect(await topAtCentre(page), 'the overlay is on top of the dialog').toEqual(overlayIn('dlg'));

  const point = panelClickPoint(box);
  await clickSelect(page, point.x, point.y);
  await waitForFrameCount(context, framesBefore + 1);
  await waitForIdle(page);

  const steps = await stepUntil(page, {
    key: ['Space', 'ArrowDown'],
    atEnd: async () => {
      const s = await scrollState(page, PANEL);
      return s.top >= s.max - 1;
    },
  });
  expect(steps, 'the panel needs several steps').toBeGreaterThan(3);
  expect(await topAtCentre(page), 'the overlay is still on top').toEqual(overlayIn('dlg'));
  await page.keyboard.press('Enter'); // Done

  const result = await waitForResult(context);
  const checks = await checkCapture(result, {
    scale,
    firstIndex: 0,
    lastIndex: bands - 1,
    widthCss: box.width,
  });
  test.info().annotations.push({ type: 'capture', description: `${steps} steps; ${checks.summary}` });
  await expectNoProblems(checks, scale);

  // The overlay is gone and the toast that took its place sits inside the open dialog (the rest of
  // the page is inert while it is open). Esc closes the toast and not the dialog.
  await pollUntil(() => page.evaluate(() => document.querySelector('#dlg > [popover]') !== null), {
    timeoutMs: 15_000,
    message: 'the toast did not appear inside the open dialog',
  });
  // (The toast is a child of the dialog, so the generic helper that counts the children of <html>
  // does not see it.)
  await page.bringToFront();
  await pollUntil(
    async () => {
      if (await page.evaluate(() => document.querySelector('[popover]') === null)) return true;
      await page.keyboard.press('Escape');
      return false;
    },
    { timeoutMs: 30_000, intervalMs: 300, message: 'the toast did not close with Esc' },
  );
  expect(
    await page.evaluate(() => document.getElementById('dlg')?.matches(':modal')),
    'Esc closed the toast, not the dialog',
  ).toBe(true);
  expect(diffSnapshots(before, await snapshotPage(page, PANEL)), 'page state after the capture').toEqual([]);
});

test('top-layer: a modal dialog or a popover that the page opens later does not cover the overlay', async ({
  page,
  server,
}) => {
  await page.goto(server.url('/chat-inner.html'));
  const box = await panelBox(page);
  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));
  expect(await topAtCentre(page), 'the overlay is on <html>, on top').toEqual(overlayIn('HTML'));

  // A modal dialog over the whole viewport opens during the capture. It covers the overlay at
  // once and makes the overlay inert. The watchdog moves the overlay into the dialog.
  await page.evaluate(() => {
    const dialog = document.createElement('dialog');
    dialog.id = 'late';
    dialog.style.cssText = 'width:100vw;height:100vh;max-width:none;max-height:none;margin:0;padding:0;border:0';
    dialog.textContent = 'A modal dialog that the page opens during the capture';
    document.body.append(dialog);
    dialog.showModal();
  });
  expect((await topAtCentre(page))?.id, 'the dialog covers the overlay at first').toBe('late');
  await pollUntil(async () => JSON.stringify(await topAtCentre(page)) === JSON.stringify(overlayIn('late')), {
    timeoutMs: 8000,
    intervalMs: 100,
    message: 'the overlay did not come back above the modal dialog',
  });

  // The dialog closes: the overlay goes back to <html> (it would vanish with the closed dialog).
  await page.evaluate(() => /** @type {HTMLDialogElement} */ (document.getElementById('late')).close());
  await pollUntil(async () => (await overlayHostCount(page)) === 1, {
    timeoutMs: 8000,
    intervalMs: 100,
    message: 'the overlay did not return to <html> after the dialog closed',
  });
  await pollUntil(async () => JSON.stringify(await topAtCentre(page)) === JSON.stringify(overlayIn('HTML')), {
    timeoutMs: 8000,
    intervalMs: 100,
    message: 'the overlay is not on top after the dialog closed',
  });

  // A popover that the page shows later is above the overlay in the top layer.
  await page.evaluate(() => {
    const popover = document.createElement('div');
    popover.id = 'pop';
    popover.popover = 'manual';
    popover.style.cssText = 'width:100vw;height:100vh;margin:0;padding:0;border:0;inset:0';
    document.body.append(popover);
    popover.showPopover();
  });
  expect((await topAtCentre(page))?.id, 'the popover covers the overlay at first').toBe('pop');
  await pollUntil(async () => JSON.stringify(await topAtCentre(page)) === JSON.stringify(overlayIn('HTML')), {
    timeoutMs: 8000,
    intervalMs: 100,
    message: 'the overlay did not come back above the popover',
  });

  // Real input still works: Escape cancels the capture.
  await page.keyboard.press('Escape');
  await waitForOverlayGone(page);
});
