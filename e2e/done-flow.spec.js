// @ts-check
/**
 * The flow after Done (docs/contracts.md section 7.1): no result tab opens by itself; the full
 * image is on the clipboard; a toast shows the result and closes with Esc; a long capture shows
 * the numbered tile chips and the hint, and a chip copies that tile.
 *
 * The toast lives in a closed shadow root: the tests read and press it through the accessibility
 * tree of the browser (see e2e/driver.js). The clipboard is read through a page on another origin
 * that has `clipboard-read`, as the browser spike did (docs/browser-behavior.md).
 */
import {
  expect,
  offscreenStatus,
  recordDownloads,
  test,
  waitForResult,
  workerCounts,
} from './fixtures.js';
import {
  axNodes,
  axTexts,
  diffSnapshots,
  dismissToast,
  overlayHostCount,
  pressCardButton,
  readClipboardImage,
  snapshotPage,
  waitForAx,
  waitForText,
} from './driver.js';
import { PANEL } from './scenarios.js';
import {
  captureChatAndFinish,
  describeImageDifference,
  savedFileProblems,
  thumbnailCheck,
  waitForCopiedToast,
} from './post-capture.js';

/** The title of the fixture page chat-inner.html: it is in the names of the saved files. */
const PAGE_TITLE = 'Chat with an inner scroller';

/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */

/** Pages of the browser that show the result page. @param {BrowserContext} context */
const resultTabs = (context) => context.pages().filter((p) => p.url().includes('/src/result/'));

test('done-flow: Done copies the full image, opens no result tab, and the toast closes with Esc', async ({
  page,
  context,
  server,
}) => {
  await page.goto(server.url('/chat-inner.html?bands=100'));
  const before = await snapshotPage(page, PANEL);
  await recordDownloads(context);
  const startedAt = Date.now();

  await captureChatAndFinish(page, server, { bands: 100 });

  // The toast takes the place of the overlay: one host on the page, and it says what happened.
  // The default settings save the files, so "Copied" alone would mean that the save step failed.
  const title = await waitForCopiedToast(page);
  expect(title, 'copied and saved (the save step worked)').toBe('Copied and saved');
  expect(await overlayHostCount(page), 'the toast is on the page').toBe(1);
  expect(await waitForText(page, /\d,?\d* × \d,?\d* px/)).toMatch(/px/);
  await waitForAx(page, 'button', 'Open');
  const names = (await axNodes(page)).map((n) => n.name);
  expect(names.filter((n) => /^Copy tile/.test(n)), 'one tile: no tile chips').toEqual([]);

  // The content script could write to the clipboard itself: the service worker was not asked.
  expect((await workerCounts(context))['in page/clipboard-fallback'] ?? 0).toBe(0);

  // No result tab opened by itself, also not a moment later.
  await page.waitForTimeout(1500);
  expect(resultTabs(context), 'no result tab').toHaveLength(0);
  expect(context.pages(), 'only the page under test is open').toHaveLength(1);

  // Esc closes the toast (and the page does not see the key).
  await dismissToast(page);
  expect(await overlayHostCount(page)).toBe(0);
  expect(diffSnapshots(before, await snapshotPage(page, PANEL)), 'page state after the capture').toEqual([]);

  // The clipboard holds the full image: the same picture as the result page builds.
  const clipboard = await readClipboardImage(context, server);
  const result = await waitForResult(context);
  const full = await result.decodeFull();
  expect(describeImageDifference(clipboard, full), 'clipboard against the full image').toBe('');
  expect(result.tilePlan, 'a short capture is one tile').toHaveLength(1);

  // The files: one image, in Downloads/Spool, and it is the picture on the clipboard.
  expect(await savedFileProblems(context, result, { title: PAGE_TITLE, notBefore: startedAt }), 'saved files').toEqual([]);
  expect(await thumbnailCheck(result), 'thumbnail of the summary').toEqual([]);
  // The slices are freed once the outputs exist; the outputs stay for the toast and the shelf.
  expect(await offscreenStatus(context), 'the offscreen document after Done').toEqual({
    exists: true,
    sessions: 0,
    lastCapture: true,
  });
});

test('done-flow: a long capture shows the tile chips and the hint, and a chip copies that tile', async ({
  page,
  context,
  server,
}) => {
  await recordDownloads(context);
  const startedAt = Date.now();
  await captureChatAndFinish(page, server, { bands: 900, auto: true });

  // The title teaches the key that pastes the full image.
  expect(await waitForText(page, /^Copied\. Press Ctrl\+V for the full image\.$/, 90_000)).toBeTruthy();
  // The hint is a tinted block with keycaps, so its text comes in pieces: one for each key.
  await waitForText(page, /^Long capture\? In your chat tab, press$/);
  const hint = await waitForText(page, /^to insert all \d+ screenshots\.$/);
  const tiles = Number(/all (\d+) screenshots/.exec(hint)?.[1]);
  const pieces = (await axTexts(page)).map((t) => t.trim());
  const at = pieces.indexOf('Long capture? In your chat tab, press');
  expect(pieces.slice(at + 1, at + 6), 'the real key, as keycaps').toEqual(['Alt', '+', 'Shift', '+', 'V']);
  expect(tiles, 'a long capture has several tiles').toBeGreaterThan(1);
  await waitForText(page, new RegExp(`^${tiles} AI screenshots ready · `));

  const chips = (await axNodes(page)).filter((n) => n.role === 'button' && /^Copy screenshot \d+$/.test(n.name));
  expect(chips.map((n) => n.name)).toEqual(Array.from({ length: tiles }, (_, i) => `Copy screenshot ${i + 1}`));
  // There is no way to drag all tiles in Chromium: no button of the toast offers it. The one line
  // that says "drag" is for a desktop chat app: the files are in a folder.
  const buttons = (await axNodes(page)).filter((n) => n.role === 'button').map((n) => n.name);
  expect(buttons.join(' | ')).not.toMatch(/drag/i);
  await waitForText(page, /^Desktop app: drag them from Downloads › Spool › Spool for AI\.$/);

  // A chip copies that tile: the click starts the write, the tile arrives later.
  await pressCardButton(page, 'Copy screenshot 2');
  await waitForAx(page, 'button', 'Screenshot 2 copied');
  const clipboard = await readClipboardImage(context, server);

  const result = await waitForResult(context);
  expect(result.tilePlan, 'the toast counts the tiles of the capture').toHaveLength(tiles);
  const tile = await result.decodeTile(1);
  expect(describeImageDifference(clipboard, tile), 'clipboard against tile 2').toBe('');

  // The files: the full image and every tile, each one the picture of the capture.
  expect(await savedFileProblems(context, result, { title: PAGE_TITLE, notBefore: startedAt }), 'saved files').toEqual([]);
  expect(await thumbnailCheck(result), 'thumbnail of the summary').toEqual([]);

  await dismissToast(page);
  expect(await overlayHostCount(page)).toBe(0);
});

test('done-flow: a page that blocks the clipboard still gets the copy, through the service worker', async ({
  page,
  context,
  server,
}) => {
  // Permissions-Policy: clipboard-write=() (the server adds it for ?noclip): a content script
  // cannot write. The agent asks the service worker, which has the clipboardWrite permission.
  await recordDownloads(context);
  const startedAt = Date.now();
  await captureChatAndFinish(page, server, { bands: 100, query: '&noclip' });
  expect(await waitForCopiedToast(page), 'the toast shows the final state').toBeTruthy();
  await dismissToast(page);

  const counts = await workerCounts(context);
  expect(counts['in page/clipboard-fallback'] ?? 0, 'the service worker was asked to copy').toBeGreaterThanOrEqual(1);
  const clipboard = await readClipboardImage(context, server);
  const result = await waitForResult(context);
  expect(describeImageDifference(clipboard, await result.decodeFull()), 'clipboard against the full image').toBe('');
  // The blocked clipboard does not stop the save: the files are there.
  expect(await savedFileProblems(context, result, { title: PAGE_TITLE, notBefore: startedAt }), 'saved files').toEqual([]);
});

test('done-flow: Done while Auto runs finishes after the step and copies once', async ({ page, context, server }) => {
  await recordDownloads(context);
  const startedAt = Date.now();
  await captureChatAndFinish(page, server, { bands: 300, auto: true });
  expect(await waitForCopiedToast(page)).toBeTruthy();
  expect(resultTabs(context), 'no result tab').toHaveLength(0);
  await dismissToast(page);
  const counts = await workerCounts(context);
  expect(counts['in page/finish'], 'one finish').toBe(1);
  const clipboard = await readClipboardImage(context, server);
  const result = await waitForResult(context);
  expect(describeImageDifference(clipboard, await result.decodeFull())).toBe('');
  // One finish saves one set of files (the check counts them).
  expect(await savedFileProblems(context, result, { title: PAGE_TITLE, notBefore: startedAt }), 'saved files').toEqual([]);
});
