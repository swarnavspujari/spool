// @ts-check
/**
 * Checks of a finished capture (the result page's full PNG, tiles and manifest) against what the
 * fixture page must produce. All checks collect readable problem lines instead of stopping at the
 * first one, so one failed run shows everything that is wrong.
 */

import { expect, test } from '@playwright/test';

import { DEFAULT_SETTINGS } from '../src/shared/settings.js';
import { BAND_CSS, analyzeColumn, describeResult, verifyBands } from './bands.js';
import { workerEvents } from './fixtures.js';
import { seamProblems } from './save-check.js';

/**
 * Limits of the image tiers, written out here on purpose: they come from the vision docs of the
 * target models (the image limits of the vision models), not from the extension's own constants, so a wrong
 * constant in src/ fails this test instead of silently passing it.
 */
const PATCH_PX = 28;
const TIER_LIMITS = Object.freeze({
  high: Object.freeze({ maxLongEdgePx: 2576, maxPatches: 4784 }),
  standard: Object.freeze({ maxLongEdgePx: 1568, maxPatches: 1568 }),
});

/** @typedef {import('./fixtures.js').ResultTab} ResultTab */
/** @typedef {import('../test/helpers/png-decode.js').DecodedPng} DecodedPng */
/** @typedef {import('./bands.js').VerifyResult} VerifyResult */

/**
 * A block of page content that is not a band but sits between two bands in the page flow (for
 * example a sticky date divider). It must be in the image exactly once, full width, and between
 * band `afterBand` and band `afterBand + 1`.
 * @typedef {Object} InFlowBlock
 * @property {string} name
 * @property {readonly number[]} color  RGB of the block.
 * @property {number} heightCss
 * @property {number} afterBand         Index of the band above the block.
 */

/**
 * @typedef {Object} ExpectedCapture
 * @property {number} scale         Device scale factor of the browser.
 * @property {number} firstIndex    Index of the first band in the image.
 * @property {number} lastIndex     Index of the last band in the image.
 * @property {number} widthCss      Width of the selected area, CSS px.
 * @property {number} [extraCss]    CSS px of content in the image that is not a band
 *                                  (for example the 48 px sticky header, and every in-flow
 *                                  block). Default 0.
 * @property {InFlowBlock[]} [inFlow]  Blocks between bands that belong to the page flow. The band
 *                                  rules (continuity, pitch) are checked with them cut out.
 */

/**
 * @typedef {Object} CaptureChecks
 * @property {string[]} problems
 * @property {DecodedPng} full
 * @property {VerifyResult} bands   Band analysis of the full image.
 * @property {string} summary       Short text of the manifest, for messages and annotations.
 * @property {Uint8Array} fullPng    The full image (attached to the report when a check fails).
 */

/**
 * First row of `tile` that differs from the same rows of `full` (starting at `srcY`), or -1.
 * Alpha of a 4-channel image is checked to be opaque.
 * @param {DecodedPng} full
 * @param {DecodedPng} tile
 * @param {number} srcY
 * @returns {{ row: number, why: string } | null}
 */
function firstTileMismatch(full, tile, srcY) {
  for (let row = 0; row < tile.height; row++) {
    for (let x = 0; x < tile.width; x++) {
      const f = ((srcY + row) * full.width + x) * full.channels;
      const t = (row * tile.width + x) * tile.channels;
      if (tile.channels === 4 && tile.data[t + 3] !== 255) {
        return { row, why: `transparent pixel at x=${x}` };
      }
      if (
        full.data[f] !== tile.data[t] ||
        full.data[f + 1] !== tile.data[t + 1] ||
        full.data[f + 2] !== tile.data[t + 2]
      ) {
        return { row, why: `pixel differs at x=${x}` };
      }
    }
  }
  return null;
}

/**
 * @param {readonly number[]} a
 * @param {readonly number[]} b
 */
function sameColor(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * Finds each in-flow block in the centre column, checks it, and returns the image without the
 * rows of those blocks, so that the band rules apply across them. Blocks of one colour are
 * matched to the segments of that colour in order (top to bottom, by `afterBand`). Every problem
 * is added to `problems`. A block that is missing or repeated is a problem, and every segment is
 * cut out anyway (one wrong block must not hide the other findings).
 * @param {DecodedPng} full
 * @param {InFlowBlock[]} blocks
 * @param {number} scale
 * @param {string[]} problems
 * @returns {DecodedPng}
 */
function cutInFlowBlocks(full, blocks, scale, problems) {
  const { width, channels, data } = full;
  const columns = [0.25, 0.5, 0.75].map((f) => Math.min(width - 1, Math.floor(width * f)));
  const refX = /** @type {number} */ (columns[1]);
  const { bands, foreign } = analyzeColumn(full, refX, scale);
  /** @type {{ start: number, end: number }[]} */
  const cuts = [];

  /** @type {InFlowBlock[][]} */
  const groups = [];
  for (const block of [...blocks].sort((a, b) => a.afterBand - b.afterBand)) {
    const group = groups.find((g) => sameColor(g[0]?.color ?? [], block.color));
    if (group) group.push(block);
    else groups.push([block]);
  }

  for (const group of groups) {
    const color = /** @type {InFlowBlock} */ (group[0]).color;
    const found = foreign.filter((f) => sameColor(f.color, color)).sort((a, b) => a.start - b.start);
    if (found.length !== group.length) {
      problems.push(
        `${group.map((b) => b.name).join(', ')}: each must appear exactly once, ${group.length} ` +
          `segment(s) of rgb(${color}) expected; found ${found.length}` +
          (found.length > 0 ? ` (rows ${found.map((f) => `${f.start}-${f.end}`).join(', ')})` : ''),
      );
    }
    found.forEach((f, i) => {
      cuts.push({ start: f.start, end: f.end });
      const block = group[i];
      if (!block) return; // An extra copy: it is cut out, and the count above is the problem.
      const rows = f.end - f.start;
      const wanted = block.heightCss * scale;
      if (Math.abs(rows - wanted) > 2) {
        problems.push(`${block.name} is ${rows} rows tall (rows ${f.start}-${f.end}); expected ${wanted} +/- 2`);
      }
      const above = [...bands].reverse().find((b) => b.end <= f.start);
      const below = bands.find((b) => b.start >= f.end);
      if (above?.index !== block.afterBand || below?.index !== block.afterBand + 1) {
        problems.push(
          `${block.name} sits between band ${above?.index ?? '?'} and band ${below?.index ?? '?'}; ` +
            `expected between ${block.afterBand} and ${block.afterBand + 1}`,
        );
      }
      for (const x of columns) {
        for (let y = f.start; y < f.end; y++) {
          const o = (y * width + x) * channels;
          if (!sameColor([data[o] ?? 0, data[o + 1] ?? 0, data[o + 2] ?? 0], block.color)) {
            problems.push(`${block.name} does not fill the width: column ${x}, row ${y} differs`);
            break; // One finding per column is enough.
          }
        }
      }
    });
  }

  cuts.sort((a, b) => a.start - b.start);
  const removed = cuts.reduce((n, c) => n + (c.end - c.start), 0);
  const out = new Uint8Array((full.height - removed) * width * channels);
  const rowBytes = width * channels;
  let from = 0;
  let to = 0;
  for (const cut of [...cuts, { start: full.height, end: full.height }]) {
    const start = Math.max(cut.start, from);
    out.set(data.subarray(from * rowBytes, start * rowBytes), to * rowBytes);
    to += start - from;
    from = Math.max(from, cut.end);
  }
  return { ...full, height: full.height - removed, data: out };
}

/**
 * Checks the manifest, the full PNG and every tile of a result tab.
 * @param {ResultTab} result
 * @param {ExpectedCapture} expected
 * @returns {Promise<CaptureChecks>}
 */
export async function checkCapture(result, expected) {
  const { manifest, tilePlan } = result;
  const { scale } = expected;
  /** @type {string[]} */
  const problems = [];

  // --- Full image -------------------------------------------------------------------------
  const full = await result.decodeFull();
  const expectedWidth = Math.round(expected.widthCss * scale);
  if (Math.abs(full.width - expectedWidth) > 1) {
    problems.push(`full image is ${full.width} px wide; expected ${expectedWidth} (${expected.widthCss} CSS px x ${scale})`);
  }
  if (full.width !== manifest.widthPx) {
    problems.push(`full image width ${full.width} differs from manifest.widthPx ${manifest.widthPx}`);
  }
  if (full.height !== manifest.totalHeightPx) {
    problems.push(`full image height ${full.height} differs from manifest.totalHeightPx ${manifest.totalHeightPx}`);
  }
  // The result page reads the last capture from the offscreen document. It has no slices any more
  // and does not know the scale of the capture: `manifest.scale` is 0 then. The width checks below
  // (the image is `widthCss * scale` wide) cover the scale.
  if (manifest.scale > 0 && Math.abs(manifest.scale - scale) > 0.02) {
    problems.push(`manifest.scale is ${manifest.scale}; the browser scale is ${scale}`);
  }
  const bandCount = expected.lastIndex - expected.firstIndex + 1;
  const expectedHeight = (bandCount * BAND_CSS + (expected.extraCss ?? 0)) * scale;
  if (Math.abs(full.height - expectedHeight) > 2) {
    problems.push(`full image is ${full.height} px tall; expected about ${expectedHeight} (${bandCount} bands + ${expected.extraCss ?? 0} CSS px, x ${scale})`);
  }
  // The result page's manifest has no slices (it reads the last capture, not the session), so the
  // seam statuses come from the replies of the offscreen document that the service worker saw.
  // A duplicate frame has the index -1 and is not a slice.
  const events = await workerEvents(result.page.context());
  const seams = events
    .filter((e) => e.dir === 'out' && e.type === 'offscreen/add-frame' && e.ok === true)
    .map((e) => /** @type {string | undefined} */ (e.intake?.seam?.status));
  for (const p of seamProblems(seams)) problems.push(p);

  // --- Bands --------------------------------------------------------------------------------
  const bandImage = expected.inFlow?.length
    ? cutInFlowBlocks(full, expected.inFlow, scale, problems)
    : full;
  const bands = verifyBands(bandImage, {
    scale,
    expectedFirst: expected.firstIndex,
    expectedLast: expected.lastIndex,
  });
  for (const e of bands.errors) problems.push(`full image: ${e}`);

  // --- Tiles --------------------------------------------------------------------------------
  const tier = TIER_LIMITS[DEFAULT_SETTINGS.tileTier];
  if (tilePlan.length === 0) problems.push('the tile plan is empty');
  const sorted = [...tilePlan].sort((a, b) => a.srcY - b.srcY);
  const firstTile = sorted[0];
  const lastTile = sorted[sorted.length - 1];
  if (firstTile && firstTile.srcY !== 0) problems.push(`first tile starts at row ${firstTile.srcY}, not 0`);
  if (lastTile && lastTile.srcY + lastTile.srcHeight !== full.height) {
    problems.push(`tiles end at row ${lastTile.srcY + lastTile.srcHeight}; the image has ${full.height} rows`);
  }
  for (let i = 1; i < sorted.length; i++) {
    const prev = /** @type {import('../src/shared/types.js').TilePlan} */ (sorted[i - 1]);
    const cur = /** @type {import('../src/shared/types.js').TilePlan} */ (sorted[i]);
    if (cur.srcY > prev.srcY + prev.srcHeight) {
      problems.push(`gap between tile ${prev.index} (ends at ${prev.srcY + prev.srcHeight}) and tile ${cur.index} (starts at ${cur.srcY})`);
    }
    if (cur.srcY <= prev.srcY) problems.push(`tile ${cur.index} does not start below tile ${prev.index}`);
  }
  for (const plan of tilePlan) {
    const tile = await result.decodeTile(plan.index);
    const label = `tile ${plan.index + 1}/${tilePlan.length}`;
    if (tile.width !== plan.outWidth || tile.height !== plan.outHeight) {
      problems.push(`${label}: PNG is ${tile.width}x${tile.height}; plan says ${plan.outWidth}x${plan.outHeight}`);
    }
    if (Math.max(tile.width, tile.height) > tier.maxLongEdgePx) {
      problems.push(`${label}: long edge ${Math.max(tile.width, tile.height)} > ${tier.maxLongEdgePx}`);
    }
    const patches = Math.ceil(tile.width / PATCH_PX) * Math.ceil(tile.height / PATCH_PX);
    if (patches > tier.maxPatches) problems.push(`${label}: ${patches} patches > ${tier.maxPatches}`);
    if (tile.width === full.width && plan.srcY + tile.height <= full.height) {
      const bad = firstTileMismatch(full, tile, plan.srcY);
      if (bad) problems.push(`${label}: row ${bad.row} (image row ${plan.srcY + bad.row}): ${bad.why}`);
    } else if (tile.width !== full.width) {
      problems.push(`${label}: width ${tile.width} differs from the full image width ${full.width} (no scaling expected here)`);
    }
  }

  const summary =
    `${seams.length} frames [${seams.join(',')}], ` +
    `${full.width}x${full.height} px, scale ${manifest.scale}, ${tilePlan.length} tile(s)` +
    (bands.edgeRows.length > 0
      ? `, boundary rows: ${bands.edgeRows.map((e) => `${e.side} ${e.rows} x rgb(${e.color})`).join('; ')}`
      : '') +
    (manifest.warnings.length > 0 ? `, warnings: ${manifest.warnings.join(' / ')}` : '');
  return { problems, full, bands, summary, fullPng: await result.fullPng() };
}

/**
 * Fails the test with all problems, and with the band analysis, when there is any. The full image
 * is attached to the report then.
 * @param {CaptureChecks} checks
 * @param {number} scale
 * @param {string[]} [extraProblems]
 */
export async function expectNoProblems(checks, scale, extraProblems = []) {
  const all = [...checks.problems, ...extraProblems];
  if (all.length > 0) {
    await test.info().attach('full.png', { body: Buffer.from(checks.fullPng), contentType: 'image/png' });
  }
  expect(
    all,
    `Capture problems (${checks.summary}):\n${all.map((p) => `  - ${p}`).join('\n')}\n${describeResult(checks.bands, scale)}`,
  ).toEqual([]);
}
