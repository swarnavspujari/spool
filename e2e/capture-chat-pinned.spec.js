// @ts-check
/**
 * Pinned elements inside a captured panel (fixture chat-pinned.html):
 *  - sticky date dividers in the middle of the content must show exactly once, at their place
 *    between two bands (hiding them would leave gaps, leaving them alone would repeat them),
 *  - a fixed fade above the composer that takes no pointer events (a hit test cannot see it)
 *    must still be hidden, and the fixed composer too,
 *  - the sticky header shows once, at the top.
 * The stitched bands must stay continuous, and the page must be exactly as it was afterwards.
 */
import { expect, test, waitForResult } from './fixtures.js';
import { FOREIGN_COLORS } from './bands.js';
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
  CHAT_DIVIDER_CSS,
  CHAT_HEADER_CSS,
  PANEL,
  chatForeignProblems,
  panelBox,
  panelClickPoint,
  scrollPanel,
} from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';

/** @typedef {import('@playwright/test').Page} Page */

/**
 * Reads the fixture's layout from the page and checks that the page is the trap this test needs.
 * @param {Page} page
 */
async function readFixture(page) {
  const info = await page.evaluate(() => {
    const fade = document.getElementById('fade');
    if (!fade) throw new Error('#fade missing');
    const r = fade.getBoundingClientRect();
    const hit = document.elementsFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return {
      bands: Number(document.documentElement.dataset['bands']),
      dividers: (document.documentElement.dataset['dividers'] ?? '').split(',').map(Number),
      dividerHeights: [...document.querySelectorAll('.divider')].map((e) => e.getBoundingClientRect().height),
      fadeFixed: getComputedStyle(fade).position === 'fixed',
      fadeSeenByHitTest: hit.includes(fade),
    };
  });
  expect(info.dividers, 'the fixture has two dividers').toHaveLength(2);
  expect(info.dividerHeights, 'divider height matches the test constant').toEqual(
    info.dividers.map(() => CHAT_DIVIDER_CSS),
  );
  expect(info.fadeFixed, 'the fade is a fixed element').toBe(true);
  expect(info.fadeSeenByHitTest, 'elementsFromPoint must not report the fade').toBe(false);
  return info;
}

/**
 * While the session runs, the agent has freed the pinned elements: sticky ones are static (they
 * keep their space in the flow), fixed ones are hidden. A read-only check of the live page.
 * @param {Page} page
 */
async function expectPinnedFreed(page) {
  const live = await page.evaluate(() => {
    /** @param {string} sel @param {'position' | 'visibility'} prop */
    const all = (sel, prop) => [...document.querySelectorAll(sel)].map((e) => getComputedStyle(e)[prop]);
    return {
      header: all('#header', 'position'),
      dividers: all('.divider', 'position'),
      fade: all('#fade', 'visibility'),
      composer: all('#composer', 'visibility'),
      topbar: all('#topbar', 'visibility'),
    };
  });
  expect(live.header, 'the sticky header is released').toEqual(['static']);
  expect(live.dividers, 'the sticky dividers are released').toEqual(['static', 'static']);
  expect(live.fade, 'the fixed fade is hidden').toEqual(['hidden']);
  expect(live.composer, 'the fixed composer is hidden').toEqual(['hidden']);
  expect(live.topbar, 'a fixed bar outside the capture area is left alone').toEqual(['visible']);
}

/**
 * @param {import('./fixtures.js').ResultTab} result
 * @param {Awaited<ReturnType<typeof readFixture>>} info
 * @param {number} scale
 * @param {number} widthCss
 */
function checkPinnedCapture(result, info, scale, widthCss) {
  return checkCapture(result, {
    scale,
    firstIndex: 0,
    lastIndex: info.bands - 1,
    widthCss,
    // The header and each divider are content that takes room in the image.
    extraCss: CHAT_HEADER_CSS + info.dividers.length * CHAT_DIVIDER_CSS,
    inFlow: info.dividers.map((firstBandAfter, i) => ({
      name: `date divider ${i + 1}`,
      color: FOREIGN_COLORS.divider,
      heightCss: CHAT_DIVIDER_CSS,
      afterBand: firstBandAfter - 1,
    })),
  });
}

test(
  'capture-chat-pinned: stepping down shows each sticky divider once, hides the fade and the composer',
  { tag: '@core' },
  async ({ page, context, server, scale }) => {
    await page.goto(server.url('/chat-pinned.html'));
    const info = await readFixture(page);
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
    await expectPinnedFreed(page);
    await page.keyboard.press('Enter'); // Done

    const result = await waitForResult(context);
    const checks = await checkPinnedCapture(result, info, scale, box.width);
    test.info().annotations.push({ type: 'capture', description: `${steps} steps; ${checks.summary}` });
    await expectNoProblems(checks, scale, chatForeignProblems(checks.bands));

    await dismissToast(page); // Done shows the toast in place of the overlay
    expect(diffSnapshots(before, await snapshotPage(page, PANEL)), 'page state after the capture').toEqual([]);
  },
);

test(
  'capture-chat-pinned: stepping up from the bottom gives the same image, each divider once',
  async ({ page, context, server, scale }) => {
    await page.goto(server.url('/chat-pinned.html'));
    const info = await readFixture(page);
    const box = await panelBox(page);
    await scrollPanel(page, 'bottom');
    const before = await snapshotPage(page, PANEL);

    const point = panelClickPoint(box);
    await beginCapture(page, () => clickSelect(page, point.x, point.y));
    const steps = await stepUntil(page, {
      key: 'ArrowUp',
      atEnd: async () => (await scrollState(page, PANEL)).top <= 0.5,
    });
    expect(steps, 'the panel needs several steps').toBeGreaterThan(3);
    await expectPinnedFreed(page);
    await page.keyboard.press('Enter'); // Done

    const result = await waitForResult(context);
    const checks = await checkPinnedCapture(result, info, scale, box.width);
    test.info().annotations.push({ type: 'capture', description: `${steps} steps; ${checks.summary}` });
    await expectNoProblems(checks, scale, chatForeignProblems(checks.bands));

    await dismissToast(page); // Done shows the toast in place of the overlay
    expect(diffSnapshots(before, await snapshotPage(page, PANEL)), 'page state after the capture').toEqual([]);
  },
);
