// @ts-check
/**
 * Shared steps of the specs for the flow after Done (done-flow.spec.js, shelf.spec.js): capture the
 * chat panel and press Done. The result is the toast on the page, the full image on the clipboard
 * and the last capture in the offscreen document.
 */

import {
  beginCapture,
  clickSelect,
  scrollState,
  stepUntil,
  waitForText,
} from './driver.js';
import { savedDownloads } from './fixtures.js';
import { PANEL, panelBox, panelClickPoint } from './scenarios.js';
import { savePathProblems, thumbnailProblems } from './save-check.js';
import { base64ToBytes, pollUntil } from './util.js';
import { decodePng } from '../test/helpers/png-decode.js';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */
/** @typedef {import('./fixtures.js').ResultTab} ResultTab */
/** @typedef {import('../test/helpers/png-decode.js').DecodedPng} DecodedPng */

/** The text of the toast title when the copy worked. */
export const COPIED_TITLE =
  /^(Copied and saved|Copied|Copied\. Press (Ctrl\+V|⌘V) for the full image\.)$/;

/**
 * Captures the whole chat panel (a click selects it) and presses Done at the end.
 * @param {Page} page
 * @param {{ url: (path: string) => string }} server
 * @param {{ bands: number, auto?: boolean, query?: string }} options  `bands`: length of the panel
 *   content (8 px each). Under about 90 the panel does not scroll. 100 gives one tile, 900 gives
 *   several. `query`: more of the query string, for example '&noclip'.
 * @returns {Promise<{ steps: number }>}
 */
export async function captureChatAndFinish(page, server, { bands, auto = false, query = '' }) {
  await page.goto(server.url(`/chat-inner.html?bands=${bands}${query}`));
  const box = await panelBox(page);
  const point = panelClickPoint(box);
  await beginCapture(page, () => clickSelect(page, point.x, point.y));
  let steps = 0;
  if (auto) {
    await page.keyboard.press('a');
    await pollUntil(
      async () => {
        const s = await scrollState(page, PANEL);
        return s.top >= s.max - 1;
      },
      { timeoutMs: 90_000, intervalMs: 100, message: 'auto mode did not scroll the panel to its end' },
    );
  } else {
    steps = await stepUntil(page, {
      key: 'Space',
      atEnd: async () => {
        const s = await scrollState(page, PANEL);
        return s.top >= s.max - 1;
      },
    });
  }
  await page.keyboard.press('Enter'); // Done
  return { steps };
}

/**
 * Waits for the toast of a finished capture (its title says the copy worked).
 * @param {Page} page
 * @returns {Promise<string>} The title.
 */
export function waitForCopiedToast(page) {
  return waitForText(page, COPIED_TITLE, 60_000);
}

/**
 * RGBA bytes of a decoded PNG (a clipboard image can come back with or without an alpha channel).
 * @param {DecodedPng} png
 * @returns {Buffer}
 */
export function rgbaOf(png) {
  if (png.channels === 4) return Buffer.from(png.data);
  const out = Buffer.alloc(png.width * png.height * 4);
  for (let i = 0, j = 0; i < png.data.length; i += 3, j += 4) {
    out[j] = png.data[i] ?? 0;
    out[j + 1] = png.data[i + 1] ?? 0;
    out[j + 2] = png.data[i + 2] ?? 0;
    out[j + 3] = 255;
  }
  return out;
}

/**
 * Describes the first difference between two images, or returns an empty string when they are the
 * same picture.
 * @param {DecodedPng} a
 * @param {DecodedPng} b
 * @returns {string}
 */
export function describeImageDifference(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return `size ${a.width} x ${a.height} against ${b.width} x ${b.height}`;
  }
  const x = rgbaOf(a);
  const y = rgbaOf(b);
  for (let i = 0; i < x.length; i += 4) {
    if (x[i] !== y[i] || x[i + 1] !== y[i + 1] || x[i + 2] !== y[i + 2]) {
      const pixel = i / 4;
      return `pixel ${pixel % a.width},${Math.floor(pixel / a.width)} is ${x[i]},${x[i + 1]},${x[i + 2]} against ${y[i]},${y[i + 1]},${y[i + 2]}`;
    }
  }
  return '';
}

/**
 * Checks the files that the capture saved: how many, their paths (docs/contracts.md 7.3), that
 * each download is complete and not empty, and that each file is the picture of the capture (the
 * full image, or tile N). Call recordDownloads(context) before the capture.
 * @param {BrowserContext} context
 * @param {ResultTab} result  The result tab of the same capture.
 * @param {{ title: string, notBefore: number, folder?: string }} expected  `notBefore`: epoch ms
 *   before Done was pressed.
 * @returns {Promise<string[]>} Problems. Empty when the files are right.
 */
export async function savedFileProblems(context, result, { title, notBefore, folder = 'Spool' }) {
  const downloads = await savedDownloads(context);
  const tileCount = result.tilePlan.length;
  const problems = savePathProblems(
    downloads.map((d) => d.requested),
    { folder, title, tileCount, notBefore, notAfter: Date.now() + 2000 },
  );
  for (const d of downloads) {
    if (d.state !== 'complete') problems.push(`${d.requested}: the download is "${d.state}", not complete`);
    if (d.conflictAction !== 'uniquify') problems.push(`${d.requested}: conflictAction is ${d.conflictAction}`);
    if (d.urlScheme !== 'blob') problems.push(`${d.requested}: the URL scheme is ${d.urlScheme}, not blob`);
    if (d.bytes.length === 0 || d.bytes.length !== d.size) {
      problems.push(`${d.requested}: ${d.bytes.length} bytes on disk, Chrome counts ${d.size}`);
    }
  }
  const full = downloads.find((d) => !d.requested.includes('/Spool for AI/'));
  if (full && full.bytes.length > 0) {
    const bad = describeImageDifference(decodePng(full.bytes), await result.decodeFull());
    if (bad) problems.push(`the saved full image differs from the capture: ${bad}`);
  }
  for (const plan of result.tilePlan) {
    if (tileCount === 1) break; // The one file above is the picture.
    const name = `/screenshot-${String(plan.index + 1).padStart(2, '0')}-of-${String(tileCount).padStart(2, '0')}.png`;
    const file = downloads.find((d) => d.requested.endsWith(name));
    if (!file || file.bytes.length === 0) continue; // Reported by the path check.
    const bad = describeImageDifference(decodePng(file.bytes), await result.decodeTile(plan.index));
    if (bad) problems.push(`the saved tile ${plan.index + 1} differs from the capture: ${bad}`);
  }
  return problems;
}

/**
 * Checks the thumbnail of the summary against the full image of the capture.
 * @param {ResultTab} result
 * @returns {Promise<string[]>} Problems.
 */
export async function thumbnailCheck(result) {
  const summary = await result.offscreenSummary();
  return thumbnailProblems({
    thumbnail: decodePng(base64ToBytes(summary.thumbnailPngBase64)),
    full: await result.decodeFull(),
    reportedWidth: summary.thumbnailWidthPx,
    reportedHeight: summary.thumbnailHeightPx,
  });
}
