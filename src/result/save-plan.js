// @ts-check
/**
 * Pure helpers for the result page. No DOM and no chrome.* calls, so Node unit tests can import
 * this file. It holds: the list of files to save, number and date formatting, the layout of the
 * "For people" column, and the base64 to Blob step (the decoder is in src/render/util.js).
 */

import { formatSaveLabel, joinPlace } from '../lib/labels.js';
import { captureFiles } from '../lib/names.js';
import { base64ToBytes } from '../render/util.js';

// ---------------------------------------------------------------------------------------------
// Save plan
// ---------------------------------------------------------------------------------------------

/**
 * One file to save.
 * @typedef {Object} SaveItem
 * @property {'tile' | 'full'} kind
 * @property {number} [index]  0-based tile index. Present for tiles only.
 * @property {string} filename Path relative to Downloads: "<root>/<folders>/<file name>".
 */

/**
 * Lists the files to save, in save order: the full image, then the tiles. The names and folders
 * are the ones of the capture itself (`captureFiles` in src/lib/names.js, docs/contracts.md
 * section 7.3): the full image flat as "<base>.png", the tiles in "Spool for AI/<base>/". One
 * tile that fits is one flat file, never two.
 * @param {{ root: string, base: string, tileCount: number, includeTiles: boolean,
 *   includeFull: boolean, fitsOneImage?: boolean }} input
 *   `root` is the folder in Downloads (the folder name of the settings). `base` is
 *   captureBaseName(date, title).
 * @returns {SaveItem[]}
 */
export function savePlan({ root, base, tileCount, includeTiles, includeFull, fitsOneImage }) {
  const prefix = root === '' ? '' : `${root}/`;
  return captureFiles({
    base,
    tileCount,
    saveTiles: includeTiles,
    saveFull: includeFull,
    ...(fitsOneImage === undefined ? {} : { fitsOneImage }),
  }).map((file) => ({
    kind: file.kind,
    ...(file.index === undefined ? {} : { index: file.index }),
    filename: `${prefix}${file.path.join('/')}`,
  }));
}

/**
 * @typedef {Object} StartedDownload
 * @property {number} id          Download id.
 * @property {string} filename    The path that the browser accepted.
 * @property {boolean} fellBack   True when the first attempt failed and `fallback` was used.
 * @property {unknown} [firstError]  The error of the first attempt, when `fellBack` is true.
 */

/**
 * Starts one download. `start` is a thin call to chrome.downloads.download. Chrome refuses a
 * path that its file name rules do not accept (for example a character in the page title that
 * the name filter did not know), and then `start` rejects. In that case the file is tried once
 * more with `fallback`, the same path made with a base name without the page title. When this
 * attempt fails too, its error goes to the caller. There is no second try when the fallback is
 * the path that failed.
 * @param {(path: string) => Promise<number>} start  Gets the path relative to Downloads.
 * @param {string} filename  Planned path.
 * @param {string} fallback  Path for the one retry.
 * @returns {Promise<StartedDownload>}
 */
export async function startDownload(start, filename, fallback) {
  try {
    return { id: await start(filename), filename, fellBack: false };
  } catch (firstError) {
    if (fallback === filename) throw firstError;
    const id = await start(fallback);
    return { id, filename: fallback, fellBack: true, firstError };
  }
}

/**
 * Describes what "Save all" saves, from the planned files.
 * @param {ReadonlyArray<{ kind: 'tile' | 'full' }>} items  The result of savePlan().
 * @returns {string}
 */
export function saveAllHint(items) {
  const tiles = items.filter((item) => item.kind === 'tile').length;
  const full = items.some((item) => item.kind === 'full');
  if (tiles > 0 && full) return `Save all saves ${plural(tiles, 'screenshot')} and the full image.`;
  if (tiles > 0) return `Save all saves ${plural(tiles, 'screenshot')}.`;
  if (full) return 'Save all saves the full image.';
  return 'Save all has nothing to save. Turn on AI screenshots or the full image in Settings.';
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------

/**
 * Whole number with comma separators, independent of the browser locale: 18240 -> "18,240".
 * @param {number} n
 * @returns {string}
 */
export function formatInt(n) {
  const rounded = Number.isFinite(n) ? Math.round(n) : 0;
  return String(rounded).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * Image size, for example "1,500 × 18,240 px".
 * @param {number} width
 * @param {number} height
 * @returns {string}
 */
export function formatDimensions(width, height) {
  return `${formatInt(width)} × ${formatInt(height)} px`;
}

/**
 * File size with 1024-based units, for example "12.3 MB".
 * @param {number} bytes
 * @returns {string}
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (unit < units.length - 1 && Math.round(value * 10) / 10 >= 1024) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * The two parts of the label under an AI screenshot preview: the name ("Screenshot 3 of 8") and
 * the size ("1,500 × 2,576 px"). The page shows the name in a stronger weight.
 * @param {number} index  0-based.
 * @param {number} count
 * @param {number} width
 * @param {number} height
 * @returns {{ name: string, size: string }}
 */
export function tileLabelParts(index, count, width, height) {
  return { name: `Screenshot ${index + 1} of ${count}`, size: formatDimensions(width, height) };
}

/**
 * @param {number} n
 * @param {string} noun  Singular form. The plural adds "s".
 * @returns {string}
 */
export function plural(n, noun) {
  return `${formatInt(n)} ${noun}${n === 1 ? '' : 's'}`;
}

/**
 * Date and time of the capture, the same in every locale: "Nov 6, 2026, 10:42 AM".
 * @param {number} ms  Milliseconds since the epoch.
 * @param {string} [timeZone]  IANA name. The default is the time zone of the browser.
 * @returns {string}  An empty string when `ms` is not a time.
 */
export function formatDateTime(ms, timeZone) {
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    ...(timeZone ? { timeZone } : {}),
  })
    .format(date)
    .replace(/[  ]/g, ' ');
}

/**
 * Line under the page title, for example "Nov 6, 2026, 10:42 AM · 1,500 × 11,980 px · 8 parts".
 * A part that is not known is left out.
 * @param {{ createdAt?: number, widthPx: number, heightPx: number, partCount?: number,
 *   timeZone?: string }} input
 * @returns {string}
 */
export function summaryLine({ createdAt, widthPx, heightPx, partCount, timeZone }) {
  const when = createdAt === undefined ? '' : formatDateTime(createdAt, timeZone);
  return [
    when,
    formatDimensions(widthPx, heightPx),
    partCount === undefined ? '' : plural(partCount, 'part'),
  ]
    .filter((part) => part !== '')
    .join(' · ');
}

/**
 * Text for the status bar after a save: "Saved 6 files in Downloads › Spool › 2026-11-06 Title."
 * @param {number} fileCount
 * @param {string} folder  Relative folder below Downloads, with "/" between the segments.
 * @returns {string}
 */
export function savedLine(fileCount, folder) {
  const path = joinPlace('Downloads', ...folder.split('/'));
  return `Saved ${plural(fileCount, 'file')} in ${path}.`;
}

// ---------------------------------------------------------------------------------------------
// People view: the tiles stacked without their overlap
// ---------------------------------------------------------------------------------------------

/**
 * Where each tile goes in the "For people" column. Adjacent tiles share rows (the overlap), so
 * a tile hides the rows that the tile above it already shows. Sizes are in output px of that
 * tile. The page uses `visibleHeight` for the box and `skipHeight` to move the picture up.
 * @param {ReadonlyArray<{ index: number, srcY: number, srcHeight: number, outWidth: number,
 *   outHeight: number }>} plan  Tiles from planTiles(), top to bottom.
 * @returns {Array<{ index: number, outWidth: number, skipHeight: number, visibleHeight: number }>}
 */
export function stackLayout(plan) {
  let shownTo = 0;
  return plan.map((tile) => {
    const skipRows = Math.min(tile.srcHeight, Math.max(0, shownTo - tile.srcY));
    shownTo = Math.max(shownTo, tile.srcY + tile.srcHeight);
    const outPerSrc = tile.outHeight / tile.srcHeight;
    return {
      index: tile.index,
      outWidth: tile.outWidth,
      skipHeight: skipRows * outPerSrc,
      visibleHeight: (tile.srcHeight - skipRows) * outPerSrc,
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------------------------

/**
 * Converts base64 to a PNG Blob without a network call.
 * @param {string} base64
 * @param {string} [type]
 * @returns {Blob}
 */
export function base64ToBlob(base64, type = 'image/png') {
  return new Blob([base64ToBytes(base64)], { type });
}

// ---------------------------------------------------------------------------------------------
// What Done saved
// ---------------------------------------------------------------------------------------------

/**
 * The status line for the save that Done made (`FinishSummary.save`, docs/contracts.md 7.3).
 * @param {{ location: 'folder' | 'downloads' | 'none', label: string, files: number,
 *   needsPermission: boolean, error?: string }} save
 * @returns {{ text: string, tone: 'info' | 'ok' | 'error', needsPermission: boolean }}
 *   `needsPermission`: the page offers "Allow folder access".
 */
export function saveInfoLine(save) {
  const reason = save.error === undefined || save.error === '' ? '' : ` ${save.error}`;
  if (save.location === 'none' || save.files < 1) {
    return reason === ''
      ? {
          text: 'Not saved. Turn on AI screenshots or the full image in Settings.',
          tone: 'info',
          needsPermission: false,
        }
      : { text: `Not saved.${reason}`, tone: 'error', needsPermission: false };
  }
  const where = formatSaveLabel(save.label) || 'the chosen folder';
  const saved = `Saved ${plural(save.files, 'file')} in ${where}.`;
  if (save.needsPermission) {
    return {
      text: `${saved} Spool could not use your chosen folder. Allow access to save there.`,
      tone: 'info',
      needsPermission: true,
    };
  }
  return { text: `${saved}${reason}`, tone: reason === '' ? 'ok' : 'error', needsPermission: false };
}
