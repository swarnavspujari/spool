// @ts-check
/**
 * Geometry of the fixture pages and the rules of their expected output. The numbers here come
 * from the page CSS in e2e/fixtures/*.html and from the band code in e2e/bands.js.
 */

import { BAND_CSS, FOREIGN_COLORS } from './bands.js';
import { pollUntil } from './util.js';
import { scrollState } from './driver.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('./bands.js').VerifyResult} VerifyResult */

// ---------------------------------------------------------------------------------------------
// Pages whose document scrolls (long-document.html, smooth-scroll.html)
// ---------------------------------------------------------------------------------------------

/** The drag box: left edge, width and top edge, viewport CSS px. All are multiples of 4 or 8. */
export const DOC_BOX = Object.freeze({ x: 300, width: 400, y: 80 });

/**
 * @typedef {Object} DocumentPlan
 * @property {{ x: number, y: number, width: number, height: number }} box  Drag box.
 * @property {number} startScroll   Scroll position before the capture (restored afterwards).
 * @property {number} max           Maximum scroll position.
 * @property {number} firstIndex    Band at the top edge of the box at the start position.
 * @property {number} lastIndex     Band at the bottom edge of the box at the maximum position.
 */

/**
 * Scrolls the document to `startScroll` and plans a drag box whose top and bottom edges lie on
 * band edges (at the start position and at the maximum position), so the first and the last band
 * of the capture are whole bands and their indexes are exact.
 * @param {Page} page
 * @param {number} startScroll  A multiple of 8.
 * @returns {Promise<DocumentPlan>}
 */
export async function planDocumentBox(page, startScroll) {
  await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), startScroll);
  await pollUntil(async () => Math.abs((await scrollState(page, null)).top - startScroll) < 1, {
    message: `the document did not scroll to ${startScroll}`,
  });
  const { max } = await scrollState(page, null);
  const viewportHeight = await page.evaluate(() => innerHeight);

  let bottom = viewportHeight - DOC_BOX.y;
  while ((max + bottom) % BAND_CSS !== 0 && bottom > DOC_BOX.y + 200) bottom--;
  if ((startScroll + DOC_BOX.y) % BAND_CSS !== 0 || (max + bottom) % BAND_CSS !== 0) {
    throw new Error(`Cannot align the box to band edges (max scroll ${max}, viewport ${viewportHeight}).`);
  }
  return {
    box: { x: DOC_BOX.x, y: DOC_BOX.y, width: DOC_BOX.width, height: bottom - DOC_BOX.y },
    startScroll,
    max,
    firstIndex: (startScroll + DOC_BOX.y) / BAND_CSS,
    lastIndex: (max + bottom) / BAND_CSS - 1,
  };
}

// ---------------------------------------------------------------------------------------------
// Pages with an inner scroller (chat-inner.html, lazy-grow.html)
// ---------------------------------------------------------------------------------------------

/** Selector of the scrolling panel in chat-inner.html and lazy-grow.html. */
export const PANEL = '#panel';
/** Height of the sticky header in chat-inner.html and chat-pinned.html, CSS px. */
export const CHAT_HEADER_CSS = 48;
/** Height of a sticky date divider in chat-pinned.html, CSS px. */
export const CHAT_DIVIDER_CSS = 16;

/**
 * The panel's client box in viewport coordinates (no border, no scrollbar in the fixtures).
 * @param {Page} page
 * @returns {Promise<{ x: number, y: number, width: number, height: number }>}
 */
export function panelBox(page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`${sel} not found`);
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: el.clientWidth, height: el.clientHeight };
  }, PANEL);
}

/**
 * Sets the panel's scroll position (instant) and waits until it is there.
 * @param {Page} page
 * @param {number | 'bottom'} top
 */
export async function scrollPanel(page, top) {
  await page.evaluate(
    ([sel, t]) => {
      const el = document.querySelector(/** @type {string} */ (sel));
      if (!el) throw new Error(`${sel} not found`);
      el.scrollTo({ top: t === 'bottom' ? el.scrollHeight : /** @type {number} */ (t), behavior: 'instant' });
    },
    [PANEL, top],
  );
  await pollUntil(
    async () => {
      const s = await scrollState(page, PANEL);
      return top === 'bottom' ? s.top >= s.max - 1 : Math.abs(s.top - top) < 1;
    },
    { message: `the panel did not scroll to ${top}` },
  );
}

/**
 * Where to click to select the panel: its middle, which is band content (not header, not the
 * fixed composer).
 * @param {{ x: number, y: number, width: number, height: number }} box
 * @returns {{ x: number, y: number }}
 */
export function panelClickPoint(box) {
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 */
function sameColor(a, b) {
  return a.length === 3 && b.length === 3 && a.every((v, i) => v === b[i]);
}

/**
 * Rules for the foreign (non-band) content of a capture of chat-inner.html and chat-pinned.html:
 * - Only the sticky header and the panel background may appear.
 * - The sticky header exactly once, at the top: it is in the content, so it shows once, at its
 *   place. It is neither hidden (a gap) nor repeated.
 * - The fixed composer never: a fixed element is hidden in every frame, the first one included.
 * - Nothing between two bands (the band verifier reports that as well). In-flow blocks that
 *   belong there (the dividers of chat-pinned.html) are cut out by checkCapture() first.
 * @param {VerifyResult} bands
 * @returns {string[]} Problems.
 */
export function chatForeignProblems(bands) {
  /** @type {string[]} */
  const problems = [];
  const headers = bands.foreign.filter((f) => sameColor(f.color, FOREIGN_COLORS.header));
  const composers = bands.foreign.filter((f) => sameColor(f.color, FOREIGN_COLORS.composer));
  const panels = bands.foreign.filter((f) => sameColor(f.color, FOREIGN_COLORS.panel));
  const others = bands.foreign.filter((f) => ![...headers, ...composers, ...panels].includes(f));

  for (const f of others) problems.push(`unknown content rgb(${f.color}) at rows ${f.start}-${f.end}`);
  if (headers.length !== 1) {
    problems.push(
      `the sticky header must appear exactly once, at its place at the top; it appears ${headers.length} times` +
        (headers.length > 0 ? ` (rows ${headers.map((f) => `${f.start}-${f.end}`).join(', ')})` : ''),
    );
  }
  for (const f of headers) {
    if (f.where !== 'leading') problems.push(`sticky header is not at the top (${f.where}, rows ${f.start}-${f.end})`);
  }
  if (composers.length > 0) {
    problems.push(`the fixed composer must be hidden in every frame; it appears ${composers.length} times (rows ${composers.map((f) => `${f.start}-${f.end}`).join(', ')})`);
  }
  for (const f of panels) {
    if (f.where === 'between') problems.push(`panel background between bands at rows ${f.start}-${f.end}`);
  }
  return problems;
}
