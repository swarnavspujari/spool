// @ts-check
/**
 * The shelf is bound to the capture that was the last one when it opened, and it does not paste into a frame:
 *  - A shelf that stays open while the user captures another page does not hand out the tiles of
 *    the new capture. It says "A newer capture exists." and the page of the tab gets no paste.
 *    Opening the shelf again serves the newer capture.
 *  - When the focus is in an iframe, the shelf says that it cannot insert into the frame and does
 *    not dispatch the paste event to the top page. A tile can still be copied with a click.
 *
 * The command itself is started through the test hook of the service worker (a real shortcut is a
 * browser feature that a test cannot press), like in shelf.spec.js.
 */
import { expect, startShelf, test } from './fixtures.js';
import {
  dismissToast,
  overlayHostCount,
  pressCardButton,
  shownScreenshots,
  waitForAx,
  waitForText,
} from './driver.js';
import { captureChatAndFinish, waitForCopiedToast } from './post-capture.js';

/** @typedef {import('@playwright/test').Page} Page */

/**
 * Makes a capture in `page` and closes the toast.
 * @param {Page} page
 * @param {{ url: (path: string) => string }} server
 * @param {number} bands
 */
async function capture(page, server, bands) {
  await captureChatAndFinish(page, server, { bands, auto: true });
  await waitForCopiedToast(page);
  await dismissToast(page);
}

/** @param {Page} tab @returns {Promise<number>} The tile count that the shelf shows. */
function shownTiles(tab) {
  return shownScreenshots(tab);
}

/**
 * Brings a tab to the front, so that its shelf is on the screen and a mouse click reaches it.
 * @param {Page} tab
 */
async function front(tab) {
  await tab.bringToFront();
}

test('shelf binding: a newer capture is refused by the open shelf, and a new shelf serves it', async ({
  page,
  context,
  server,
}) => {
  await capture(page, server, 900);

  // The shelf of capture A is open in a second tab, and the user does not press Insert yet.
  const tab = await context.newPage();
  await tab.goto(server.url('/shelf-editor.html'));
  await tab.bringToFront();
  await tab.click('#editor');
  await startShelf(tab);
  const tilesA = await shownTiles(tab);
  expect(tilesA, 'capture A has several tiles').toBeGreaterThan(1);

  // In the first tab the user captures another page: capture B, a different one.
  await capture(page, server, 500);

  // Back in the second tab: the shelf still shows A. Insert is refused, and nothing is pasted.
  await front(tab);
  await pressCardButton(tab, `Insert ${tilesA} screenshots`);
  const message = await waitForText(tab, /^A newer capture exists\. (Press .+ again\.|Run Insert last capture again\.)$/);
  expect(message).toContain('A newer capture exists.');
  expect(await tab.evaluate(() => /** @type {any} */ (window).__pasted), 'the editor got no paste').toBeNull();
  expect(await overlayHostCount(tab), 'the shelf stays open and shows why').toBe(1);

  // A chip and "Copy full image" are refused in the same way. The clipboard is not written with B.
  await pressCardButton(tab, 'Copy screenshot 1');
  await waitForText(tab, /^A newer capture exists\./);
  await pressCardButton(tab, 'Copy full image');
  await waitForText(tab, /^A newer capture exists\./);

  // The user presses the shortcut again: a new shelf, bound to capture B.
  await startShelf(tab);
  const tilesB = await shownScreenshots(tab);
  await pressCardButton(tab, `Insert ${tilesB} screenshot${tilesB === 1 ? '' : 's'}`);
  await waitForText(tab, /^Inserted \d+ screenshots?\.$/);
  const pasted = await tab.evaluate(() => /** @type {any} */ (window).__pasted);
  expect(pasted, 'the editor got the paste of capture B').not.toBeNull();
  expect(pasted.names).toHaveLength(tilesB);
  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
  expect(pasted.names[0]).toBe(`screenshot-01-of-${pad(tilesB)}.png`);
});

test('shelf in a frame: it does not paste into the host page, and a tile can still be copied', async ({
  page,
  context,
  server,
}) => {
  await capture(page, server, 900);

  const tab = await context.newPage();
  await tab.goto(server.url('/shelf-frame.html'));
  await tab.bringToFront();
  // The focus goes into the editor inside the frame: for the host page, the active element is the
  // <iframe> element.
  await tab.frameLocator('#frame').locator('#editor').click();
  expect(await tab.evaluate(() => document.activeElement?.tagName)).toBe('IFRAME');
  await startShelf(tab);

  const tiles = await shownTiles(tab);
  await waitForText(tab, 'Spool cannot insert into an embedded frame. Click a number to copy one instead.');

  // The button is off: a real click on it does nothing, and nothing is pasted anywhere.
  await pressCardButton(tab, `Insert ${tiles} screenshots`, { even: 'disabled' });
  await tab.waitForTimeout(500);
  await waitForText(tab, 'Spool cannot insert into an embedded frame. Click a number to copy one instead.');
  expect(await tab.evaluate(() => /** @type {any} */ (window).__topPaste), 'the host page got no paste').toBe(0);
  const inner = await tab.frameLocator('#frame').locator('body').evaluate(
    () => /** @type {any} */ (window).__pasted,
  );
  expect(inner, 'the frame got no paste').toBeNull();

  // A tile can still be copied (a trusted click).
  await pressCardButton(tab, 'Copy screenshot 1');
  await waitForAx(tab, 'button', 'Screenshot 1 copied');
  expect(await tab.evaluate(() => /** @type {any} */ (window).__topPaste)).toBe(0);
});
