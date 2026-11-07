// @ts-check
/**
 * The shelf against composers that behave like the ones of real chat apps (docs/contracts.md
 * section 5, shelf.js):
 *  - A composer that is a ProseMirror-style contenteditable, and a page that takes a paste with one
 *    listener at the document, only when the target is inside the composer. A paste at <body> or at
 *    a node that left the page does nothing for such a page.
 *  - Nothing has the focus when the shelf opens: the shelf finds the composer on the screen.
 *  - The composer was made again after the shelf opened (a single-page app that changed the
 *    chat): the paste goes to the new one.
 *  - A page that ignores a paste that the browser did not make: the shelf offers one screenshot at
 *    a time. Each copy is a trusted click and each paste is a real Ctrl+V of the user, so it works.
 *  - A page that covers the card with its own element that ignores the pointer (clickjacking): a
 *    click on the real button does nothing while it is covered, and works when the page lets go.
 *
 * The command is started through the test hook of the service worker (a real shortcut is a browser
 * feature that a test cannot press).
 */
import { expect, startShelf, test, waitForResult } from './fixtures.js';
import {
  dismissToast,
  overlayHostCount,
  pressCardButton,
  readClipboardImage,
  shownScreenshots,
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
 * @param {BrowserContext} context
 * @param {{ url: (path: string) => string }} server
 * @param {string} path
 */
async function openTab(context, server, path) {
  const tab = await context.newPage();
  await tab.goto(server.url(path));
  await tab.bringToFront();
  return tab;
}

/** @param {Page} tab */
function pasted(tab) {
  return tab.evaluate(() => /** @type {any} */ (window).__pasted);
}

test('shelf composer: nothing has the focus, and the shelf finds the composer', async ({
  page,
  context,
  server,
}) => {
  await makeLongCapture(page, server);
  const tab = await openTab(context, server, '/shelf-prosemirror.html');
  expect(await tab.evaluate(() => /** @type {any} */ (window).__blur()), 'no focus').toBe(true);
  await startShelf(tab);
  const tiles = await shownScreenshots(tab);
  // The shelf has found a composer: it does not say "Click your message box first."
  expect(await tab.evaluate(() => document.activeElement?.tagName)).toBe('BODY');

  await pressCardButton(tab, `Insert ${tiles} screenshots`);
  await waitForText(tab, `Inserted ${tiles} screenshots.`);

  const got = await pasted(tab);
  expect(got, 'the composer took the paste').not.toBeNull();
  expect(got.gen).toBe(1);
  expect(got.names).toHaveLength(tiles);
  expect(got.trusted, 'a synthetic event: the page can tell').toBe(false);
  const seen = await tab.evaluate(() => /** @type {any} */ (window).__seen);
  expect(seen, 'the one paste of the shelf, at the composer').toEqual([
    { trusted: false, gen: 1, files: tiles, target: 'DIV' },
  ]);
});

test('shelf composer: the composer is made again after the shelf opened', async ({
  page,
  context,
  server,
}) => {
  await makeLongCapture(page, server);
  const tab = await openTab(context, server, '/shelf-prosemirror.html');
  await tab.click('.ProseMirror');
  await startShelf(tab);
  const tiles = await shownScreenshots(tab);

  // The app changes the chat: the node that had the focus is gone, a new one is in its place.
  expect(await tab.evaluate(() => /** @type {any} */ (window).__remount())).toBe('2');
  expect(await tab.evaluate(() => document.activeElement?.tagName)).toBe('BODY');

  await pressCardButton(tab, `Insert ${tiles} screenshots`);
  await waitForText(tab, `Inserted ${tiles} screenshots.`);
  const got = await pasted(tab);
  expect(got, 'the new composer took the paste').not.toBeNull();
  expect(got.gen, 'the second composer, not the one that left').toBe(2);
  expect(got.names).toHaveLength(tiles);
});

test('shelf composer: a page that ignores a fake paste gets the steps, and a real Ctrl+V works', async ({
  page,
  context,
  server,
}) => {
  await makeLongCapture(page, server);
  const tab = await openTab(context, server, '/shelf-prosemirror.html?strict');
  await tab.click('.ProseMirror');
  await startShelf(tab);
  const tiles = await shownScreenshots(tab);

  await pressCardButton(tab, `Insert ${tiles} screenshots`);
  await waitForText(tab, "This chat won't take them all at once.");
  expect(await pasted(tab), 'the page ignored the event that the browser did not make').toBeNull();
  const result = await waitForResult(context);

  for (const n of [1, 2]) {
    await tab.bringToFront();
    await pressCardButton(tab, `Copy screenshot ${n} of ${tiles}`);
    await waitForText(tab, `Copied screenshot ${n} of ${tiles}. Press Ctrl+V in your chat.`);
    // The user's own paste: a trusted event, with the image that the shelf copied.
    await tab.click('.ProseMirror');
    await tab.evaluate(() => {
      /** @type {any} */ (window).__pasted = null;
      /** @type {any} */ (window).__pastedBase64 = null;
    });
    await tab.keyboard.press('Control+V');
    const got = await pollUntil(() => pasted(tab), {
      timeoutMs: 10_000,
      message: `the real Ctrl+V of step ${n} did not reach the composer`,
    });
    expect(got.trusted, 'a real paste').toBe(true);
    expect(got.names, 'one image for each step').toHaveLength(1);
    const base64 = /** @type {string[]} */ (
      await pollUntil(() => tab.evaluate(() => /** @type {any} */ (window).__pastedBase64), {
        timeoutMs: 10_000,
        message: 'the composer did not finish reading the pasted file',
      })
    );
    const image = decodePng(base64ToBytes(/** @type {string} */ (base64[0])));
    expect(
      describeImageDifference(image, await result.decodeTile(n - 1)),
      `the pasted image against tile ${n}`,
    ).toBe('');
  }
  // The clipboard of the browser holds what the step copied, and nothing was inserted by script.
  const clipboard = await readClipboardImage(context, server);
  expect(describeImageDifference(clipboard, await result.decodeTile(1))).toBe('');
});

test('shelf composer: a page that covers the card gets no click through to Insert', async ({
  page,
  context,
  server,
}) => {
  await makeLongCapture(page, server);
  const tab = await openTab(context, server, '/shelf-hostile.html');
  await tab.click('#editor');
  await startShelf(tab);
  const tiles = await shownScreenshots(tab);
  const insert = `Insert ${tiles} screenshots`;

  // The page puts its own element over the card, and keeps it on top.
  await tab.evaluate(() => /** @type {any} */ (window).cover(true));
  await tab.waitForTimeout(600);
  // The real button is under the fake one. The click goes through (the element ignores the
  // pointer), and the shelf ignores it: nothing was pasted.
  await pressCardButton(tab, insert, { even: 'disabled' });
  await tab.waitForTimeout(1200);
  expect(await tab.evaluate(() => /** @type {any} */ (window).__seen), 'no paste').toBe(0);
  expect(await overlayHostCount(tab), 'the shelf is still there').toBe(1);

  // The page lets go: the card is visible again, and after a short wait the button works.
  await tab.evaluate(() => /** @type {any} */ (window).cover(false));
  await pressCardButton(tab, insert);
  await waitForText(tab, `Inserted ${tiles} screenshots.`);
  const got = await pasted(tab);
  expect(got.names).toHaveLength(tiles);
});
