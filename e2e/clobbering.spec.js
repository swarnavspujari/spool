// @ts-check
/**
 * DOM clobbering: page markup can shadow names that the extension's page scripts read.
 * `<form id="__spool">` takes the place of the namespace on the global, and `<img name="title">`
 * and its kind take the place of `document.title`, `document.documentElement` and the other entry
 * points of the document. A fixed element that is a <form> with inputs named `style`,
 * `getBoundingClientRect` and so on has its own properties shadowed: it must still be hidden.
 * A capture must still work, and must still find the real title.
 */
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
import { CHAT_HEADER_CSS, PANEL, chatForeignProblems, panelBox, panelClickPoint } from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';

/** The name of the page in chat-inner.html. */
const PAGE_TITLE = 'Chat with an inner scroller';

test('clobbering: a capture works on a page whose markup shadows the extension\'s names', async ({
  page,
  context,
  server,
  scale,
}) => {
  await page.goto(server.url('/chat-inner.html?clobber=1'));

  // The markup is in effect (in the page's own world; the extension's world shares the DOM).
  const shadowed = await page.evaluate(() => {
    const names = [
      'title',
      'documentElement',
      'body',
      'scrollingElement',
      'elementsFromPoint',
      'createElement',
      'createTextNode',
      'querySelectorAll',
      'createTreeWalker',
    ];
    /** @type {any} */
    const doc = document;
    const bar = /** @type {any} */ (document.getElementById('clobber-bar'));
    return {
      namespace: /** @type {any} */ (window).__spool === document.getElementById('__spool'),
      names: names.filter((n) => doc[n] instanceof HTMLImageElement),
      allNames: names,
      barStyleShadowed: bar.style instanceof HTMLInputElement,
      barBoxShadowed: typeof bar.getBoundingClientRect !== 'function',
    };
  });
  expect(shadowed.namespace, 'window.__spool is the form').toBe(true);
  expect(shadowed.names, 'every name of the document is an <img>').toEqual(shadowed.allNames);
  expect(shadowed.barStyleShadowed, 'the fixed <form> bar has its `style` shadowed').toBe(true);
  expect(shadowed.barBoxShadowed, 'the fixed <form> bar has `getBoundingClientRect` shadowed').toBe(true);

  const bands = await page.evaluate(() =>
    Number(Reflect.get(Document.prototype, 'documentElement', document).dataset['bands']),
  );
  const box = await panelBox(page);
  const before = await snapshotPage(page, PANEL);

  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));
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
  expect(result.manifest.title, 'the title comes from the real document, not from the <img>').toBe(PAGE_TITLE);
  const checks = await checkCapture(result, {
    scale,
    firstIndex: 0,
    lastIndex: bands - 1,
    widthCss: box.width,
    extraCss: CHAT_HEADER_CSS,
  });
  test.info().annotations.push({ type: 'capture', description: `${steps} steps; ${checks.summary}` });
  await expectNoProblems(checks, scale, chatForeignProblems(checks.bands));

  await dismissToast(page); // Done shows the toast in place of the overlay
  expect(diffSnapshots(before, await snapshotPage(page, PANEL)), 'page state after the capture').toEqual([]);
});
