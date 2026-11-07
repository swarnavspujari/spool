// @ts-check
import { expect, findServiceWorker, startCapture, test } from './fixtures.js';
import { overlayHostCount } from './driver.js';
import { pollUntil } from './util.js';

/** Pages where extensions cannot run: the extension must refuse them with a "!" badge. */
const RESTRICTED_URLS = ['about:blank', 'chrome://version/'];

for (const url of RESTRICTED_URLS) {
  test(`restricted-page: ${url} gets the "!" badge, no overlay, no crash`, async ({ page, context }) => {
    await page.goto(url);
    await startCapture(page); // Must not throw: the starter reports failures with the badge.

    const sw = await findServiceWorker(context);
    const tabId = await sw.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      return tab?.id ?? -1;
    });
    expect(tabId, 'active tab id').toBeGreaterThanOrEqual(0);

    // The badge shows for 4 s; startCapture returned after it was set.
    await pollUntil(
      async () =>
        (await sw.evaluate((id) => chrome.action.getBadgeText({ tabId: id }), tabId)) === '!',
      { timeoutMs: 3000, message: 'the "!" badge was not set on the tab' },
    );

    // Nothing was injected and nothing crashed.
    expect(await overlayHostCount(page), 'overlay host count').toBe(0);
    expect(await page.evaluate(() => 1 + 1), 'the page still runs scripts').toBe(2);
    expect(await sw.evaluate(() => 1 + 1), 'the service worker still answers').toBe(2);
    expect(context.pages(), 'no extra tab was opened').toHaveLength(1);
  });
}
