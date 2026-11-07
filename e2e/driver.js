// @ts-check
/// <reference path="./globals.d.ts" />
/**
 * Helpers that drive a capture session in the test page the way a user does: mouse drag or click
 * to select, keys to step. They wait for observable progress (frames stored by the offscreen
 * document, the scroll position, the overlay element) and never sleep for a fixed time where a
 * condition can be polled.
 *
 * What a test can observe: the overlay lives in a closed shadow root, so its buttons and text are
 * out of reach. The page shows the overlay host (a child of <html>) and the scroll position. The
 * service worker's test hook (e2e/build-extension.mjs) shows every frame the offscreen document
 * stored. Together these give all the progress signals the tests need.
 */

import { findServiceWorker, startCapture, workerCounts, workerEvents } from './fixtures.js';
import { decodePng } from '../test/helpers/png-decode.js';
import { PollAbort, base64ToBytes, pollUntil } from './util.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */

/** Counter key of frames the offscreen document stored successfully. */
export const FRAME_STORED = 'out offscreen/add-frame ok';

// ---------------------------------------------------------------------------------------------
// Overlay
// ---------------------------------------------------------------------------------------------

/**
 * Number of elements on <html> besides <head> and <body>. The overlay host is one `div` there.
 * The fixture pages have no other such element, so this is 1 while the overlay exists, else 0.
 * @param {Page} page
 * @returns {Promise<number>}
 */
export function overlayHostCount(page) {
  // The element is read through Document.prototype: a fixture can shadow `document.documentElement`
  // with markup (clobbering.spec.js).
  return page.evaluate(
    () =>
      [...Reflect.get(Document.prototype, 'documentElement', document).children].filter(
        (e) => e.tagName !== 'HEAD' && e.tagName !== 'BODY',
      ).length,
  );
}

/** @param {Page} page */
export async function waitForOverlay(page) {
  await pollUntil(async () => (await overlayHostCount(page)) === 1, {
    timeoutMs: 15_000,
    message: 'the selection overlay did not appear after startCapture',
  });
}

/** @param {Page} page */
export async function waitForOverlayGone(page) {
  await pollUntil(async () => (await overlayHostCount(page)) === 0, {
    timeoutMs: 15_000,
    message: 'the overlay host is still in the page',
  });
}

// ---------------------------------------------------------------------------------------------
// Selecting
// ---------------------------------------------------------------------------------------------

/**
 * Drags a box with the mouse (viewport CSS px).
 * @param {Page} page
 * @param {{ x: number, y: number, width: number, height: number }} box
 */
export async function dragSelect(page, box) {
  const { x, y, width, height } = box;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + width / 2, y + height / 2, { steps: 6 });
  await page.mouse.move(x + width, y + height, { steps: 6 });
  await page.mouse.up();
}

/**
 * Clicks without moving: the overlay selects the whole scroll area under the pointer.
 * @param {Page} page
 * @param {number} x
 * @param {number} y
 */
export async function clickSelect(page, x, y) {
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.up();
}

// ---------------------------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------------------------

/**
 * @param {BrowserContext} context
 * @returns {Promise<number>}  Frames the offscreen document stored so far (this browser).
 */
export async function frameCount(context) {
  return (await workerCounts(context))[FRAME_STORED] ?? 0;
}

/**
 * @param {WorkerEvent[]} events
 * @param {number} n
 * @returns {string}
 */
function lastEvents(events, n = 8) {
  return events
    .slice(-n)
    .map((e) => `${e.dir} ${e.type}${e.ok === false ? ` FAILED ${e.code ?? e.threw ?? ''}` : ''}`)
    .join(' | ');
}

/** The expected frame did not arrive in time (the cause is not known). */
export class FrameTimeout extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'FrameTimeout';
  }
}

/**
 * Waits until at least `atLeast` frames are stored. Throws PollAbort at once when the offscreen
 * document rejects a frame, and FrameTimeout (naming the last service worker events) when time
 * runs out.
 * @param {BrowserContext} context
 * @param {number} atLeast
 * @param {number} [timeoutMs]
 */
export async function waitForFrameCount(context, atLeast, timeoutMs = 30_000) {
  const sw = await findServiceWorker(context);
  try {
    await pollUntil(
      async () => {
        const state = await sw.evaluate(() => ({
          stored: globalThis.__spoolTest.counts['out offscreen/add-frame ok'] ?? 0,
          failure:
            globalThis.__spoolTest.events.find(
              (e) => e.type === 'offscreen/add-frame' && (e.ok === false || e.threw),
            ) ?? null,
        }));
        if (state.failure) {
          throw new PollAbort(`The offscreen document rejected a frame: ${JSON.stringify(state.failure)}`);
        }
        return state.stored >= atLeast;
      },
      { timeoutMs, message: `frame ${atLeast} was not stored` },
    );
  } catch (e) {
    if (e instanceof PollAbort) throw e;
    const events = await workerEvents(context).catch(() => []);
    throw new FrameTimeout(`${/** @type {Error} */ (e).message}
Last service worker events: ${lastEvents(events)}`);
  }
}

/**
 * Waits until the agent has finished with the last frame and takes the next key. The overlay
 * hides inside its closed shadow root and the host shows no state (on purpose: the page must not
 * see the moment of a capture), so there is nothing to poll. Once the offscreen document has
 * stored a frame, the service worker answers the page at once, and the agent then runs to the
 * end of the step in the same task. A few animation frames and a short pause cover the message
 * trip. A key that arrives early is dropped, and stepOnce() presses it again.
 * @param {Page} page
 */
export async function waitForIdle(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 60))),
      ),
  );
}

/**
 * Starts a capture, waits for the overlay, runs `select` (drag or click) and waits until the
 * initial frame is stored and the agent is idle.
 * @param {Page} page
 * @param {() => Promise<void>} select
 */
export async function beginCapture(page, select) {
  const context = page.context();
  const framesBefore = await frameCount(context);
  await startCapture(page);
  await waitForOverlay(page);
  await select();
  await waitForFrameCount(context, framesBefore + 1);
  await waitForIdle(page);
}

// ---------------------------------------------------------------------------------------------
// Scrolling state
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} ScrollState
 * @property {number} top
 * @property {number} max
 * @property {number} clientHeight
 * @property {number} scrollHeight
 */

/**
 * Scroll state of an element, or of the document when `selector` is null.
 * @param {Page} page
 * @param {string | null} selector
 * @returns {Promise<ScrollState>}
 */
export function scrollState(page, selector) {
  return page.evaluate((sel) => {
    const el = sel
      ? document.querySelector(sel)
      : Reflect.get(Document.prototype, 'scrollingElement', document);
    if (!el) throw new Error(`scroll container not found: ${sel}`);
    return {
      top: el.scrollTop,
      max: el.scrollHeight - el.clientHeight,
      clientHeight: el.clientHeight,
      scrollHeight: el.scrollHeight,
    };
  }, selector);
}

/**
 * Makes one capture step: presses `key`, waits for the frame to be stored and for the agent to be
 * idle. A key that has no effect (it can be dropped while the agent is busy) is pressed again;
 * after 3 presses without effect the test fails.
 * @param {Page} page
 * @param {string} key  For example 'Space', 'ArrowDown' or 'ArrowUp'.
 */
export async function stepOnce(page, key) {
  const context = page.context();
  const before = await frameCount(context);
  for (let press = 1; ; press++) {
    await page.keyboard.press(key);
    try {
      await waitForFrameCount(context, before + 1, press === 1 ? 8_000 : 30_000);
      break;
    } catch (e) {
      if (!(e instanceof FrameTimeout) || press >= 3) throw e;
    }
  }
  await waitForIdle(page);
}

/**
 * Steps (see stepOnce) until `atEnd()` is true. An array of keys is used in turn.
 * @param {Page} page
 * @param {{ key: string | string[], atEnd: () => Promise<boolean>, maxSteps?: number }} options
 * @returns {Promise<number>}  Number of steps made.
 */
export async function stepUntil(page, { key, atEnd, maxSteps = 120 }) {
  let steps = 0;
  while (!(await atEnd())) {
    if (steps >= maxSteps) throw new Error(`Still not at the end after ${maxSteps} steps.`);
    await stepOnce(page, Array.isArray(key) ? (key[steps % key.length] ?? 'Space') : key);
    steps += 1;
  }
  return steps;
}

// ---------------------------------------------------------------------------------------------
// Page state snapshots (restore checks)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} PageSnapshot
 * @property {[string, string][]} styles       [element description, inline style text] for all.
 * @property {string[]} rootChildren           Tag names of the children of <html>.
 * @property {number} bodyChildren
 * @property {number} documentScrollTop
 * @property {number | null} scrollerScrollTop
 */

/**
 * Records everything the extension must restore: every element's inline style, the children of
 * <html> (the overlay host must be gone) and the scroll positions.
 * @param {Page} page
 * @param {string | null} scrollerSelector
 * @param {string | null} [skipSelector]  Elements to leave out (content the page itself changes).
 * @returns {Promise<PageSnapshot>}
 */
export function snapshotPage(page, scrollerSelector, skipSelector = null) {
  return page.evaluate(([sel, skip]) => {
    /** @param {Element} e */
    const describe = (e) =>
      e.tagName.toLowerCase() +
      (e.id ? `#${e.id}` : '') +
      ('i' in /** @type {HTMLElement} */ (e).dataset ? `[band ${/** @type {HTMLElement} */ (e).dataset['i']}]` : '');
    // Read through Document.prototype: a fixture can shadow these names with markup.
    const root = Reflect.get(Document.prototype, 'documentElement', document);
    const body = Reflect.get(Document.prototype, 'body', document);
    const scrolling = Reflect.get(Document.prototype, 'scrollingElement', document);
    const all = [root, body, ...body.querySelectorAll('*')].filter(
      (e) => !skip || !e.matches(skip),
    );
    const scroller = sel ? document.querySelector(sel) : null;
    return {
      styles: /** @type {[string, string][]} */ (
        all.map((e) => [describe(e), /** @type {HTMLElement} */ (e).style.cssText])
      ),
      rootChildren: [...root.children].map((e) => e.tagName),
      bodyChildren: body.children.length,
      documentScrollTop: scrolling?.scrollTop ?? 0,
      scrollerScrollTop: scroller ? scroller.scrollTop : null,
    };
  }, [scrollerSelector, skipSelector]);
}

/**
 * Differences between two snapshots, as readable lines. Empty when the page is restored.
 * Scroll positions may differ by up to 1 CSS px (browsers snap to device pixels).
 * @param {PageSnapshot} before
 * @param {PageSnapshot} after
 * @returns {string[]}
 */
export function diffSnapshots(before, after) {
  /** @type {string[]} */
  const out = [];
  if (before.styles.length !== after.styles.length) {
    out.push(`element count changed: ${before.styles.length} -> ${after.styles.length}`);
  }
  const n = Math.min(before.styles.length, after.styles.length);
  for (let i = 0; i < n; i++) {
    const [name, was] = /** @type {[string, string]} */ (before.styles[i]);
    const [, now] = /** @type {[string, string]} */ (after.styles[i]);
    if (was !== now) out.push(`inline style of ${name} changed: "${was}" -> "${now}"`);
  }
  if (before.rootChildren.join() !== after.rootChildren.join()) {
    out.push(`children of <html>: [${before.rootChildren}] -> [${after.rootChildren}]`);
  }
  if (before.bodyChildren !== after.bodyChildren) {
    out.push(`children of <body>: ${before.bodyChildren} -> ${after.bodyChildren}`);
  }
  if (Math.abs(before.documentScrollTop - after.documentScrollTop) > 1) {
    out.push(`document scrollTop: ${before.documentScrollTop} -> ${after.documentScrollTop}`);
  }
  if (
    before.scrollerScrollTop !== null &&
    after.scrollerScrollTop !== null &&
    Math.abs(before.scrollerScrollTop - after.scrollerScrollTop) > 1
  ) {
    out.push(`scroller scrollTop: ${before.scrollerScrollTop} -> ${after.scrollerScrollTop}`);
  }
  return out.slice(0, 20);
}

// ---------------------------------------------------------------------------------------------
// Toast and shelf
// ---------------------------------------------------------------------------------------------
// Both live in a closed shadow root, so the DOM cannot see them. The accessibility tree of the
// browser does: it holds the text, the roles and the boxes of what is drawn, whatever the shadow
// mode. The tests read and press the cards through it (CDP: Accessibility and DOM).

/**
 * @typedef {Object} AxNode
 * @property {string} role
 * @property {string} name
 * @property {number | undefined} backendNodeId
 * @property {boolean} disabled  The control is off (a disabled button).
 */

/**
 * @template T
 * @param {Page} page
 * @param {(cdp: import('@playwright/test').CDPSession) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withCdp(page, fn) {
  const cdp = await page.context().newCDPSession(page);
  try {
    return await fn(cdp);
  } finally {
    await cdp.detach().catch(() => undefined);
  }
}

/**
 * Every node of the accessibility tree that is not ignored.
 * @param {Page} page
 * @returns {Promise<AxNode[]>}
 */
export function axNodes(page) {
  return withCdp(page, async (cdp) => {
    await cdp.send('Accessibility.enable');
    const { nodes } = await cdp.send('Accessibility.getFullAXTree');
    return nodes
      .filter((n) => !n.ignored)
      .map((n) => ({
        role: String(n.role?.value ?? ''),
        name: String(n.name?.value ?? ''),
        backendNodeId: n.backendDOMNodeId,
        disabled: (n.properties ?? []).some(
          (/** @type {any} */ p) => p.name === 'disabled' && p.value?.value === true,
        ),
      }));
  });
}

/**
 * @param {string} name
 * @param {string | RegExp} wanted
 */
function nameMatches(name, wanted) {
  return typeof wanted === 'string' ? name === wanted : wanted.test(name);
}

/**
 * The names of the text nodes (what a person reads) on the page now.
 * @param {Page} page
 * @returns {Promise<string[]>}
 */
export async function axTexts(page) {
  return (await axNodes(page)).filter((n) => n.role === 'StaticText' && n.name.trim() !== '').map((n) => n.name);
}

/**
 * Waits until a node with this role and name is in the accessibility tree.
 * @param {Page} page
 * @param {string} role
 * @param {string | RegExp} name
 * @param {number} [timeoutMs]
 * @returns {Promise<AxNode>}
 */
export function waitForAx(page, role, name, timeoutMs = 20_000) {
  return pollUntil(
    async () => (await axNodes(page)).find((n) => n.role === role && nameMatches(n.name, name)),
    { timeoutMs, intervalMs: 150, message: `no ${role} named ${name} on the page` },
  );
}

/**
 * The number of AI screenshots that the shelf shows: "5 AI screenshots from 127.0.0.1, just now."
 * @param {Page} page
 * @returns {Promise<number>}
 */
export async function shownScreenshots(page) {
  const line = await waitForText(page, /^\d[\d,]* AI screenshots? from /);
  return Number(/^([\d,]+)/.exec(line)?.[1]?.replace(/,/g, ''));
}

/**
 * Waits until some text on the page matches.
 * @param {Page} page
 * @param {string | RegExp} text
 * @param {number} [timeoutMs]
 * @returns {Promise<string>} The text that matched.
 */
export function waitForText(page, text, timeoutMs = 20_000) {
  /** @type {string[]} */
  let lastTexts = [];
  return pollUntil(
    async () => {
      lastTexts = await axTexts(page);
      return lastTexts.find((t) => nameMatches(t.trim(), text));
    },
    {
      timeoutMs,
      intervalMs: 150,
      message: () => `the text ${text} is not on the page (texts: ${lastTexts.slice(-12).join(' | ')})`,
    },
  );
}

/**
 * Presses a button of the toast or the shelf with the mouse (a trusted click in the middle of its
 * box). The card moves in for 250 ms, so the box is read again until it stands still.
 * @param {Page} page
 * @param {string | RegExp} name  The accessible name of the button.
 * @param {{ even?: 'disabled' }} [options]  `even: 'disabled'`: click it although it is off (a
 *   test that proves that the click does nothing). Else the click waits until the button is on.
 */
export async function pressCardButton(page, name, options = {}) {
  const node = await waitForAx(page, 'button', name);
  /** @type {number[] | null} */
  let last = null;
  const box = await pollUntil(
    async () => {
      const fresh = (await axNodes(page)).find(
        (n) => n.role === 'button' && nameMatches(n.name, name) && n.backendNodeId !== undefined,
      );
      // The insert button of the shelf is off while the card is new (clickjacking guard): a click
      // on it would do nothing.
      if (fresh?.disabled && options.even !== 'disabled') {
        last = null;
        return null;
      }
      const id = fresh?.backendNodeId ?? node.backendNodeId;
      if (id === undefined) return null;
      const content = await withCdp(page, async (cdp) => {
        const { model } = await cdp.send('DOM.getBoxModel', { backendNodeId: id });
        return model.content;
      });
      const stable = last !== null && last.every((v, i) => Math.abs(v - (content[i] ?? 0)) < 0.5);
      last = content;
      return stable ? content : null;
    },
    { timeoutMs: 10_000, intervalMs: 120, message: `the button ${name} did not stand still` },
  );
  const xs = [box[0], box[2], box[4], box[6]].map(Number);
  const ys = [box[1], box[3], box[5], box[7]].map(Number);
  const x = xs.reduce((a, b) => a + b, 0) / 4;
  const y = ys.reduce((a, b) => a + b, 0) / 4;
  await page.mouse.click(x, y);
}

/**
 * After Done the toast takes the place of the overlay (in the same task), so the page has one host
 * until the toast closes. Esc closes the toast; this presses it until the host is gone.
 * @param {Page} page
 */
export async function dismissToast(page) {
  await page.bringToFront();
  await pollUntil(
    async () => {
      if ((await overlayHostCount(page)) === 0) return true;
      await page.keyboard.press('Escape');
      return false;
    },
    { timeoutMs: 30_000, intervalMs: 300, message: 'the toast did not close' },
  );
}

/**
 * Reads the image on the clipboard through a page on another origin, as the browser spike did:
 * the extension's own origin has no `clipboard-read`, and the fixture server answers on both
 * 127.0.0.1 and localhost. The page is closed again. Waits until an image is there.
 * @param {BrowserContext} context
 * @param {{ port: number }} server
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<import('../test/helpers/png-decode.js').DecodedPng>}
 */
export async function readClipboardImage(context, server, { timeoutMs = 30_000 } = {}) {
  const origin = `http://localhost:${server.port}`;
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
  const reader = await context.newPage();
  try {
    await reader.goto(`${origin}/reader.html`);
    await reader.bringToFront();
    const base64 = await pollUntil(
      () =>
        reader.evaluate(async () => {
          try {
            for (const item of await navigator.clipboard.read()) {
              if (!item.types.includes('image/png')) continue;
              const blob = await item.getType('image/png');
              return await new Promise((resolve) => {
                const fr = new FileReader();
                fr.onload = () => resolve(String(fr.result).split(',')[1]);
                fr.readAsDataURL(blob);
              });
            }
          } catch {
            // Empty clipboard, or no focus yet: try again.
          }
          return null;
        }),
      { timeoutMs, intervalMs: 300, message: 'no image on the clipboard' },
    );
    return decodePng(base64ToBytes(/** @type {string} */ (base64)));
  } finally {
    await reader.close().catch(() => undefined);
  }
}
