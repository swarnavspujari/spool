// @ts-check
/**
 * The shelf (docs/contracts.md section 7.1, step 5): the command Alt+Shift+V in any tab shows the
 * last capture. "Insert N screenshots" dispatches a synthetic paste with N PNG files at the editor
 * that has the focus (or a composer that the shelf finds); a page that takes it shows "Inserted", a
 * page that refuses it gets the steps: one screenshot at a time, each one a trusted copy. The command itself is started through the test hook of the service
 * worker (a real shortcut is a browser feature that a test cannot press).
 */
import { expect, startShelf, test, waitForResult } from './fixtures.js';
import {
  dismissToast,
  overlayHostCount,
  pressCardButton,
  readClipboardImage,
  shownScreenshots,
  waitForAx,
  waitForText,
} from './driver.js';
import {
  captureChatAndFinish,
  describeImageDifference,
  waitForCopiedToast,
} from './post-capture.js';
import { base64ToBytes, pollUntil } from './util.js';
import { decodePng } from '../test/helpers/png-decode.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */

/**
 * Makes a capture of several tiles in `page` and closes the toast. The last capture stays in the
 * offscreen document.
 * @param {Page} page
 * @param {{ url: (path: string) => string }} server
 */
async function makeLongCapture(page, server) {
  await captureChatAndFinish(page, server, { bands: 900, auto: true });
  await waitForCopiedToast(page);
  await dismissToast(page);
}

/**
 * Opens a second tab with a page that has an editor, focuses the editor and opens the shelf.
 * @param {BrowserContext} context
 * @param {{ url: (path: string) => string }} server
 * @param {string} path
 */
async function openShelfInEditor(context, server, path) {
  const tab = await context.newPage();
  await tab.goto(server.url(path));
  await tab.bringToFront();
  await tab.click('#editor');
  await startShelf(tab);
  return tab;
}

test('shelf: with no capture it says how to make one, and Esc closes it', async ({ page, server }) => {
  await page.goto(server.url('/shelf-editor.html'));
  await page.click('#editor');
  await startShelf(page);
  await waitForText(page, 'Nothing to insert yet. Press Alt+Shift+S to spool a page.');
  expect(await overlayHostCount(page), 'the shelf is on the page').toBe(1);
  await dismissToast(page); // Esc closes a shelf the same way
  expect(await overlayHostCount(page)).toBe(0);
});

test('shelf: Insert pastes every tile into the editor that had the focus', async ({ page, context, server }) => {
  await makeLongCapture(page, server);

  const tab = await openShelfInEditor(context, server, '/shelf-editor.html');
  const tiles = await shownScreenshots(tab);
  expect(tiles, 'a long capture has several tiles').toBeGreaterThan(1);
  await waitForAx(tab, 'button', 'Copy full image');

  await pressCardButton(tab, `Insert ${tiles} screenshots`);
  await waitForText(tab, `Inserted ${tiles} screenshots.`);

  const pasted = await tab.evaluate(() => /** @type {any} */ (window).__pasted);
  expect(pasted, 'the editor got a paste event').not.toBeNull();
  expect(pasted.names).toEqual(
    Array.from({ length: tiles }, (_, i) => `screenshot-${String(i + 1).padStart(2, '0')}-of-${String(tiles).padStart(2, '0')}.png`),
  );
  expect(pasted.types.every((/** @type {string} */ t) => t === 'image/png')).toBe(true);
  expect(pasted.sizes.every((/** @type {number} */ n) => n > 1000)).toBe(true);
  expect(pasted.trusted, 'a synthetic event: the page can tell').toBe(false);

  // The shelf closes itself a moment after "Inserted".
  await pollUntil(async () => (await overlayHostCount(tab)) === 0, {
    timeoutMs: 10_000,
    message: 'the shelf did not close after Inserted',
  });

  // The tiles that were pasted are the tiles of the capture: file i is tile i, byte for pixel.
  const result = await waitForResult(context);
  expect(result.tilePlan).toHaveLength(tiles);
  const pastedBase64 = /** @type {string[]} */ (
    await pollUntil(() => tab.evaluate(() => /** @type {any} */ (window).__pastedBase64), {
      timeoutMs: 10_000,
      message: 'the editor did not finish reading the pasted files',
    })
  );
  expect(pastedBase64, 'one file per tile').toHaveLength(tiles);
  for (let i = 0; i < tiles; i++) {
    const pasted = decodePng(base64ToBytes(/** @type {string} */ (pastedBase64[i])));
    expect(
      describeImageDifference(pasted, await result.decodeTile(i)),
      `pasted file ${i + 1} against tile ${i + 1} of the capture`,
    ).toBe('');
  }
  // A paste that repeats one tile must not pass: neighbour tiles are different pictures.
  const first = decodePng(base64ToBytes(/** @type {string} */ (pastedBase64[0])));
  const second = decodePng(base64ToBytes(/** @type {string} */ (pastedBase64[1])));
  expect(describeImageDifference(first, second), 'tile 1 and tile 2 are different pictures').not.toBe('');
});

test('shelf: a page that refuses the paste gets the steps, and each step copies one tile', async ({
  page,
  context,
  server,
}) => {
  await makeLongCapture(page, server);

  const tab = await openShelfInEditor(context, server, '/shelf-refuse.html');
  const tiles = await shownScreenshots(tab);

  await pressCardButton(tab, `Insert ${tiles} screenshots`);
  await waitForText(tab, "This chat won't take them all at once.");
  expect(await tab.evaluate(() => /** @type {any} */ (window).__seen), 'the page saw one paste').toBe(1);
  expect(await overlayHostCount(tab), 'the shelf stays open').toBe(1);

  // A step is a trusted click: it copies screenshot 1, then 2.
  await pressCardButton(tab, `Copy screenshot 1 of ${tiles}`);
  await waitForText(tab, `Copied screenshot 1 of ${tiles}. Press Ctrl+V in your chat.`);
  const first = await readClipboardImage(context, server);
  const result = await waitForResult(context);
  expect(describeImageDifference(first, await result.decodeTile(0)), 'clipboard against tile 1').toBe('');
  await pressCardButton(tab, `Copy screenshot 2 of ${tiles}`);
  await waitForText(tab, `Copied screenshot 2 of ${tiles}. Press Ctrl+V in your chat.`);
  const second = await readClipboardImage(context, server);
  expect(describeImageDifference(second, await result.decodeTile(1)), 'clipboard against tile 2').toBe('');

  await tab.bringToFront();
  await dismissToast(tab);
  expect(await overlayHostCount(tab)).toBe(0);
});

test('shelf: a chip copies that tile', async ({ page, context, server }) => {
  await makeLongCapture(page, server);

  const tab = await openShelfInEditor(context, server, '/shelf-editor.html');
  await shownScreenshots(tab);
  // A chip is a trusted click: it copies tile 1.
  await pressCardButton(tab, 'Copy screenshot 1');
  await waitForAx(tab, 'button', 'Screenshot 1 copied');
  const clipboard = await readClipboardImage(context, server);
  const result = await waitForResult(context);
  expect(describeImageDifference(clipboard, await result.decodeTile(0)), 'clipboard against tile 1').toBe('');
});

test('shelf: it says where the pixels come from and how old they are', async ({
  page,
  context,
  server,
}) => {
  await makeLongCapture(page, server);

  const tab = await openShelfInEditor(context, server, '/shelf-editor.html');
  const host = new URL(server.url('/')).hostname;
  const line = await waitForText(tab, /^\d+ AI screenshots from /);
  expect(line).toMatch(new RegExp(`^\\d+ AI screenshots from ${host.replace(/\./g, '\\.')}, (just now|\\d+ min ago)\\.$`));
  await waitForText(tab, `Into ${host}`);
  await waitForText(tab, 'Insert into this chat?');
});

test('shelf: Copy full image puts the full image on the clipboard', async ({ page, context, server }) => {
  await makeLongCapture(page, server);

  const tab = await openShelfInEditor(context, server, '/shelf-editor.html');
  await shownScreenshots(tab);
  await pressCardButton(tab, 'Copy full image');
  await waitForAx(tab, 'button', /^Copied$/);
  const clipboard = await readClipboardImage(context, server);
  const result = await waitForResult(context);
  expect(describeImageDifference(clipboard, await result.decodeFull()), 'clipboard against the full image').toBe('');
});
