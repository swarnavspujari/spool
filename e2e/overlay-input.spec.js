// @ts-check
/**
 * Input while the overlay is hidden for a capture, and select mode from the keyboard.
 *
 * Input while hidden: for each capture the overlay hides itself, and its buttons cannot be hit then. A click on
 * Stop used to reach the page 6 times in 8, and Auto went on. Now a transparent layer keeps the
 * pointer and the wheel, so the click is found for the HUD button under it.
 *
 * What a test can observe. The overlay is in a closed shadow root. The page reaches the host only.
 * The accessibility tree shows the names and the text, and CDP reaches any node by its backend ID
 * (a box, an attribute), also while it is hidden (`visibility: hidden` keeps the layout).
 */
import { expect, findServiceWorker, startCapture, test, waitForResult } from './fixtures.js';
import {
  axNodes,
  beginCapture,
  clickSelect,
  dismissToast,
  frameCount,
  overlayHostCount,
  scrollState,
  stepOnce,
  waitForAx,
  waitForFrameCount,
  waitForIdle,
  waitForOverlay,
  waitForOverlayGone,
  waitForText,
} from './driver.js';
import { CHAT_HEADER_CSS, PANEL, chatForeignProblems, panelBox, panelClickPoint } from './scenarios.js';
import { checkCapture, expectNoProblems } from './verify.js';
import { delay, pollUntil } from './util.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */

/** One Auto run is about 2.3 s per step in a real run; the clicks are spread over this time. */
const SPREAD_MS = 2400;
/** The default overlap between steps, CSS px (DEFAULT_SETTINGS.overlapCss). */
const OVERLAP_CSS = 80;

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * Handles on the Auto button of the HUD. It is in a closed shadow root, so the test reaches it
 * through its backend node: its attribute `aria-pressed` tells whether Auto runs, and its box
 * tells where to click. Both work while the overlay is hidden for a capture.
 * @param {Page} page
 */
async function openAutoButton(page) {
  const node = await waitForAx(page, 'button', 'Auto scroll (A)');
  const backendNodeId = node.backendNodeId;
  if (backendNodeId === undefined) throw new Error('the Auto button has no backend node');
  const cdp = await page.context().newCDPSession(page);
  const { object } = await cdp.send('DOM.resolveNode', { backendNodeId });
  const objectId = object.objectId;
  if (!objectId) throw new Error('the Auto button cannot be resolved');
  return {
    /** @returns {Promise<string | null>} `aria-pressed`: 'true' while Auto runs. */
    async pressed() {
      const { result } = await cdp.send('Runtime.callFunctionOn', {
        objectId,
        functionDeclaration: 'function () { return this.getAttribute("aria-pressed"); }',
        returnByValue: true,
      });
      return /** @type {string | null} */ (result.value ?? null);
    },
    /** The middle of the button, window coordinates. */
    async centre() {
      const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId });
      const q = model.content;
      return {
        x: ((q[0] ?? 0) + (q[2] ?? 0) + (q[4] ?? 0) + (q[6] ?? 0)) / 4,
        y: ((q[1] ?? 0) + (q[3] ?? 0) + (q[5] ?? 0) + (q[7] ?? 0)) / 4,
      };
    },
    detach: () => cdp.detach().catch(() => undefined),
  };
}

/**
 * Watches what reaches the page. A press, a click or a wheel turn that the overlay should take
 * must have the overlay host as its target; a page element as target means the page got it. A
 * sampler also asks `elementFromPoint` every 15 ms at the middle of the panel and at the bottom
 * edge of the window: the host must be there at every moment, hidden for a capture or not.
 * @param {Page} page
 * @param {{ x: number, y: number }[]} points
 */
async function startWatching(page, points) {
  await page.evaluate((spots) => {
    const w = /** @type {any} */ (window);
    const root = Reflect.get(Document.prototype, 'documentElement', document);
    /** @param {unknown} t */
    const isOverlay = (t) =>
      t instanceof Element && t.parentNode === root && t !== document.body && t !== document.head;
    /** @type {{ pageEvents: string[], misses: string[], samples: number }} */
    const probe = { pageEvents: [], misses: [], samples: 0 };
    w.__overlayProbe = probe;
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'click', 'wheel']) {
      window.addEventListener(
        type,
        (e) => {
          if (!isOverlay(e.target)) {
            const el = /** @type {Element | null} */ (e.target);
            probe.pageEvents.push(`${type} on ${el?.tagName ?? '?'}#${el?.id ?? ''}`);
          }
        },
        true,
      );
    }
    setInterval(() => {
      for (const { x, y } of spots) {
        probe.samples += 1;
        const hit = document.elementFromPoint(x, y);
        if (!isOverlay(hit)) probe.misses.push(`${x},${y}: ${hit?.tagName ?? 'nothing'}#${hit?.id ?? ''}`);
      }
    }, 15);
  }, points);
}

/** @param {Page} page */
function readProbe(page) {
  return page.evaluate(() => /** @type {any} */ (window).__overlayProbe);
}

/**
 * Presses `a` and waits until Auto runs.
 * @param {Page} page
 * @param {Awaited<ReturnType<typeof openAutoButton>>} auto
 */
async function startAuto(page, auto) {
  await pollUntil(async () => (await auto.pressed()) === 'false', {
    timeoutMs: 20_000,
    intervalMs: 40,
    message: 'the agent did not get ready for the next Auto run',
  });
  await page.keyboard.press('a');
  await pollUntil(async () => (await auto.pressed()) === 'true', {
    timeoutMs: 5_000,
    intervalMs: 20,
    message: 'Auto did not start',
  });
}

/**
 * Waits until Auto has stopped.
 * @param {Awaited<ReturnType<typeof openAutoButton>>} auto
 * @returns {Promise<number>} Milliseconds from now until it stopped.
 */
async function waitForStop(auto) {
  const start = Date.now();
  await pollUntil(async () => (await auto.pressed()) === 'false', {
    timeoutMs: 10_000,
    intervalMs: 20,
    message: 'Auto did not stop (the click did not reach the Stop button)',
  });
  return Date.now() - start;
}

/**
 * The capture spans of this browser: from the request of a frame to the reply that stored it
 * (the overlay is hidden for all of it).
 * @param {BrowserContext} context
 * @returns {Promise<{ from: number, to: number }[]>}
 */
async function captureSpans(context) {
  const sw = await findServiceWorker(context);
  const events = await sw.evaluate(() => [...globalThis.__spoolTest.events]);
  /** @type {{ from: number, to: number }[]} */
  const spans = [];
  /** @type {number | null} */
  let open = null;
  for (const e of events) {
    if (e.dir === 'in' && e.type === 'page/capture-frame') open = e.t;
    else if (open !== null && e.dir === 'out' && e.type === 'offscreen/add-frame') {
      spans.push({ from: open, to: e.t });
      open = null;
    }
  }
  return spans;
}

/** Stratified random delays: one in each slice of the cycle, in random order. @param {number} n */
function spreadDelays(n) {
  const slices = Array.from({ length: n }, (_, i) => Math.round(((i + Math.random()) * SPREAD_MS) / n));
  return slices.sort(() => Math.random() - 0.5);
}

/**
 * Opens a long chat page, starts a capture and selects the panel.
 * @param {Page} page
 * @param {{ url: (path: string) => string }} server
 * @param {number} bands
 */
async function openLongChat(page, server, bands) {
  await page.goto(server.url(`/chat-inner.html?bands=${bands}`));
  const box = await panelBox(page);
  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));
  return { box, point };
}

// ---------------------------------------------------------------------------------------------
// Stop and the wheel, at any moment of Auto
// ---------------------------------------------------------------------------------------------

test.describe('overlay input while hidden for a capture', () => {
  test.setTimeout(240_000);

  test('a click on Stop at a random moment of Auto stops it: 10 of 10', async ({ page, context, server }) => {
    const { box } = await openLongChat(page, server, 4000);
    const auto = await openAutoButton(page);
    const hud = await auto.centre();
    await startWatching(page, [
      { x: box.x + box.width / 2, y: box.y + box.height / 2 },
      { x: hud.x, y: hud.y },
    ]);

    // Ten clicks at random moments, spread over the whole cycle of a step.
    const delays = spreadDelays(10);
    /** @type {{ at: number, stopMs: number }[]} */
    const random = [];
    for (const wait of delays) {
      await startAuto(page, auto);
      await delay(wait);
      const c = await auto.centre();
      const at = Date.now();
      await page.mouse.click(c.x, c.y);
      random.push({ at, stopMs: await waitForStop(auto) });
    }

    // Four clicks right after a frame was asked for: the overlay is hidden for sure.
    const sw = await findServiceWorker(context);
    /** @type {number[]} */
    const flight = [];
    for (let i = 0; i < 4; i++) {
      const asked = () => sw.evaluate(() => globalThis.__spoolTest.counts['in page/capture-frame'] ?? 0);
      const before = await asked();
      await startAuto(page, auto);
      await pollUntil(async () => (await asked()) > before, {
        timeoutMs: 15_000,
        intervalMs: 5,
        message: 'Auto did not ask for a frame',
      });
      await delay(30);
      const c = await auto.centre();
      flight.push(Date.now());
      await page.mouse.click(c.x, c.y);
      await waitForStop(auto);
    }

    const stopped = random.length + flight.length;
    expect(stopped, 'every click stopped Auto (a failure throws above)').toBe(14);

    const spans = await captureSpans(context);
    const inSpan = (/** @type {number} */ t) => spans.some((s) => t >= s.from && t <= s.to);
    const hiddenRandom = random.filter((r) => inSpan(r.at)).length;
    const hiddenFlight = flight.filter(inSpan).length;
    test.info().annotations.push({
      type: 'stop clicks',
      description:
        `random delays ${delays.join(', ')} ms; ${hiddenRandom} of 10 random clicks and ` +
        `${hiddenFlight} of 4 timed clicks were made while the overlay was hidden; ` +
        `stop took ${random.map((r) => r.stopMs).join(', ')} ms`,
    });
    // The proof is not empty: a good part of the clicks came while the overlay was hidden.
    expect(hiddenFlight, 'the timed clicks were made inside a capture').toBeGreaterThanOrEqual(2);
    expect(hiddenRandom + hiddenFlight).toBeGreaterThanOrEqual(3);

    const probe = await readProbe(page);
    expect(probe.pageEvents, 'no press, click or wheel turn reached the page').toEqual([]);
    expect(probe.misses, 'the overlay was the element at the point at every moment').toEqual([]);
    expect(probe.samples, 'the sampler ran').toBeGreaterThan(100);
    await auto.detach();
  });

  test('the wheel at a random moment stops Auto, and neither scrolls nor reaches the page', async ({
    page,
    server,
  }) => {
    const { box, point } = await openLongChat(page, server, 3000);
    const auto = await openAutoButton(page);
    await startWatching(page, [point]);
    const step = box.height - OVERLAP_CSS;

    for (const wait of spreadDelays(6)) {
      await startAuto(page, auto);
      await delay(wait);
      await page.mouse.move(point.x, point.y);
      await page.mouse.wheel(0, 120);
      await waitForStop(auto);
      await waitForIdle(page);
      // Only whole steps moved the panel: a wheel turn that got through would leave it off by 120.
      const { top } = await scrollState(page, PANEL);
      const rest = top % step;
      expect(Math.min(rest, step - rest), `scroll position ${top} is a whole number of steps`).toBeLessThan(2);
    }
    const probe = await readProbe(page);
    expect(probe.pageEvents).toEqual([]);
    expect(probe.misses).toEqual([]);
    await auto.detach();
  });

  test('captures that were taken while the user clicked hold no overlay pixel', async ({
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
    const auto = await openAutoButton(page);

    // Stop Auto at three moments (clicks at the Stop button), then let it run to the end.
    for (const wait of [150, 900, 1700]) {
      await startAuto(page, auto);
      await delay(wait);
      const c = await auto.centre();
      await page.mouse.click(c.x, c.y);
      await waitForStop(auto);
    }
    await startAuto(page, auto);
    await pollUntil(
      async () => {
        const s = await scrollState(page, PANEL);
        return s.top >= s.max - 1 && (await auto.pressed()) === 'false';
      },
      { timeoutMs: 90_000, intervalMs: 100, message: 'Auto did not reach the end of the panel' },
    );
    await auto.detach();
    await page.keyboard.press('Enter'); // Done: at the end of the panel it has the focus

    const result = await waitForResult(context);
    const checks = await checkCapture(result, {
      scale,
      firstIndex: 0,
      lastIndex: bands - 1,
      widthCss: box.width,
      extraCss: CHAT_HEADER_CSS,
    });
    await expectNoProblems(checks, scale, chatForeignProblems(checks.bands));
    await dismissToast(page);
  });
});

// ---------------------------------------------------------------------------------------------
// Select mode from the keyboard
// ---------------------------------------------------------------------------------------------

test.describe('select mode from the keyboard', () => {
  /** The element that has the focus: its id, or 'overlay' for the host, or the tag name. @param {Page} page */
  const focusedId = (page) =>
    page.evaluate(() => {
      const root = Reflect.get(Document.prototype, 'documentElement', document);
      const active = Reflect.get(Document.prototype, 'activeElement', document);
      if (active && active.parentNode === root && active !== document.body) return 'overlay';
      return active?.id || active?.tagName || 'none';
    });

  test('Tab and Shift+Tab move over the panels, Enter selects one, and the mode announces itself', async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url('/two-panels.html'));
    await page.focus('#editor');
    expect(await focusedId(page)).toBe('editor');

    await startCapture(page);
    await waitForOverlay(page);

    // The focus is in the overlay, which is a dialog with a name and a description.
    expect(await focusedId(page), 'the focus moved into the overlay').toBe('overlay');
    await waitForAx(page, 'dialog', 'Spool: choose what to capture');
    await waitForText(page, /^Choose what to capture\. Press Tab or Shift and Tab/);
    const hint = await waitForText(page, /Press Tab or Shift and Tab/);
    expect(hint).toMatch(/Enter to select the highlighted panel/);
    expect(hint).toMatch(/Escape to cancel/);

    // Tab walks the panels in reading order, and says which one.
    await page.keyboard.press('Tab');
    await waitForText(page, /^Scroll panel 1 of 2, 360 by \d+ pixels\. Press Enter to select it/);
    await waitForText(page, 'Press Enter to spool this panel');
    await page.keyboard.press('Tab');
    await waitForText(page, /^Scroll panel 2 of 2, 520 by \d+ pixels/);
    await page.keyboard.press('Shift+Tab');
    await waitForText(page, /^Scroll panel 1 of 2/);
    await page.keyboard.press('Tab');
    await waitForText(page, /^Scroll panel 2 of 2/);
    expect(await focusedId(page), 'Tab did not leave the overlay').toBe('overlay');

    // Enter selects the highlighted panel (the right one): the capture steps there.
    const framesBefore = await frameCount(context);
    await page.keyboard.press('Enter');
    await waitForFrameCount(context, framesBefore + 1);
    await waitForIdle(page);
    await stepOnce(page, 'Space');
    await stepOnce(page, 'Space');
    expect((await scrollState(page, '#b')).top, 'the right panel scrolled').toBeGreaterThan(100);
    expect((await scrollState(page, '#a')).top, 'the left panel stayed').toBe(0);

    // Esc cancels, and the focus goes back to the field it came from.
    await page.keyboard.press('Escape');
    await waitForOverlayGone(page);
    expect(await focusedId(page), 'the focus went back to the page editor').toBe('editor');
  });

  test('Esc cancels the selection with a panel highlighted, and nothing is captured', async ({
    page,
    context,
    server,
  }) => {
    await page.goto(server.url('/two-panels.html'));
    await page.focus('#editor');
    const before = await frameCount(context);
    await startCapture(page);
    await waitForOverlay(page);
    await page.keyboard.press('Tab');
    await waitForText(page, /^Scroll panel 1 of 2/);
    await page.keyboard.press('Escape');
    await waitForOverlayGone(page);
    expect(await frameCount(context)).toBe(before);
    expect(await focusedId(page)).toBe('editor');
    expect(await overlayHostCount(page)).toBe(0);
    // The editor still takes the keys (the overlay kept none of them).
    await page.keyboard.type('hi');
    expect(await page.inputValue('#editor')).toBe('hi');
  });

  test('Enter with nothing highlighted selects the main panel', async ({ page, context, server }) => {
    await page.goto(server.url('/chat-inner.html'));
    const before = await frameCount(context);
    await startCapture(page);
    await waitForOverlay(page);
    await page.keyboard.press('Enter');
    await waitForFrameCount(context, before + 1);
    await waitForIdle(page);
    await stepOnce(page, 'Space');
    expect((await scrollState(page, PANEL)).top, 'the panel scrolled').toBeGreaterThan(100);
    await page.keyboard.press('Escape');
    await waitForOverlayGone(page);
  });

  test('the HUD buttons have names in one pattern, and the HUD is a toolbar', async ({ page, server }) => {
    await openLongChat(page, server, 30);
    const names = (await axNodes(page)).filter((n) => n.role === 'button').map((n) => n.name);
    for (const name of ['Scroll down (Space)', 'Scroll up (Shift+Space)', 'Auto scroll (A)', 'Copy and save (Enter)', 'Cancel (Esc)']) {
      expect(names, name).toContain(name);
    }
    await waitForAx(page, 'toolbar', 'Spool capture');
  });
});
