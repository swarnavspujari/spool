// @ts-check
/**
 * File and folder names for saved captures. Pure functions.
 * Output is safe as a chrome.downloads relative path segment on Windows, macOS and Linux.
 */

// Windows device names, including the superscript-digit and console variants.
const RESERVED_WINDOWS = /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])$/i;
// Control characters (C0, DEL and C1, for example U+0085) and characters that Windows forbids in
// file names. Each run becomes one space.
const FORBIDDEN_CHARS = /[\p{Cc}<>:"/\\|?*]+/gu;
// Format characters: soft hyphen, zero-width joiner and non-joiner, bidi marks (U+200E, U+200F,
// U+202A to U+202E), byte order mark, tag characters. They are invisible, so they can hide what a
// name says. Chromium refuses a download whose path has one. They are removed, not replaced by
// a space: a name keeps its words, and a sequence of emoji only loses its joiners.
const FORMAT_CHARS = /\p{Cf}+/gu;
// Chromium refuses `~` in a download path (Windows short names look like PROGRA~1).
const TILDE = /~/g;
// A final extension that makes Windows run or open the file, or that the browser refuses.
// A folder named "Report.exe" or "x.lnk" is not a program, but the browser applies the file
// rules to every path segment. `.{...}` is a shell folder (CLSID) extension.
const DANGEROUS_EXTENSIONS = new Set([
  'lnk', 'local', 'url', 'scf', 'exe', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'js', 'msi',
]);

/**
 * Replaces the dot before a dangerous final extension with an underscore:
 * "Report.exe" -> "Report_exe". Other names stay as they are. The case of the extension is kept.
 * One call fixes one dot: `neutralizeExtensions` repeats it.
 * @param {string} segment Without a dot or a space at its ends.
 * @returns {string}
 */
function neutralizeFinalExtension(segment) {
  const dot = segment.lastIndexOf('.');
  if (dot < 0) return segment;
  const extension = segment.slice(dot + 1).trim().toLowerCase();
  const isShellFolder =
    extension.length >= 2 && extension.startsWith('{') && extension.endsWith('}');
  if (!DANGEROUS_EXTENSIONS.has(extension) && !isShellFolder) return segment;
  return `${segment.slice(0, dot)}_${segment.slice(dot + 1)}`;
}

/**
 * Repeats `neutralizeFinalExtension` until the name stops changing. A name with several dots
 * ("a.{b}.{c}") shows a new final extension after each fix ("a.{b}_{c}" now ends in the shell
 * folder form ".{b}_{c}"). One pass gives a name that a second call changes again, and the
 * download check (`isDownloadPath`) compares a name with its own sanitized form. Each pass
 * removes one dot, so the loop ends.
 * @param {string} segment
 * @returns {string}
 */
function neutralizeExtensions(segment) {
  let current = segment;
  for (;;) {
    const next = neutralizeFinalExtension(current);
    if (next === current) return current;
    current = next;
  }
}

/**
 * Makes one path segment safe. Returns `fallback` when nothing usable remains.
 * The result has no control or format characters, no `~`, no character that Windows forbids, no
 * dot or space at the ends, no reserved Windows device name, and no dangerous final extension.
 * It is idempotent: sanitizing a result gives the same result.
 * @param {unknown} value
 * @param {number} maxLength
 * @param {string} fallback
 * @returns {string}
 */
export function sanitizePathSegment(value, maxLength, fallback) {
  if (typeof value !== 'string') return fallback;
  // Format characters go first: a joiner between a letter and its accent must not block the
  // composition in NFC.
  let s = value
    .replace(FORMAT_CHARS, '')
    .normalize('NFC')
    .replace(TILDE, '-')
    .replace(FORBIDDEN_CHARS, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  // Cut by code points, so a surrogate pair (for example an emoji) is never split.
  s = Array.from(s).slice(0, Math.max(0, maxLength)).join('').trim();
  s = s.replace(/^[.\s]+/, '').replace(/[.\s]+$/, '');
  if (s === '' || RESERVED_WINDOWS.test(s.split('.')[0] ?? '')) return fallback;
  // After the cut: the cut can leave a dangerous extension at the end ("a.exe.txt" -> "a.exe").
  return neutralizeExtensions(s);
}

/** @param {number} n @returns {string} */
function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * File name of one AI screenshot (a tile), for example "screenshot-03-of-12.png". Width of the
 * numbers grows with the count.
 * @param {number} index  0-based.
 * @param {number} count
 * @returns {string}
 */
export function tileFileName(index, count) {
  const width = Math.max(2, String(count).length);
  const n = String(index + 1).padStart(width, '0');
  const total = String(count).padStart(width, '0');
  return `screenshot-${n}-of-${total}.png`;
}

// ---------------------------------------------------------------------------------------------
// Names of a finished capture (docs/contracts.md section 7.3)
// ---------------------------------------------------------------------------------------------

/** Every file of a finished capture starts with this word. */
export const CAPTURE_PREFIX = 'Spool';
/** Folder of the AI screenshot sets (the tiles), next to the flat full images. */
export const TILES_FOLDER_NAME = `${CAPTURE_PREFIX} for AI`;
/** Longest page title in a capture name, in characters (code points). */
export const CAPTURE_TITLE_MAX_LENGTH = 48;

/**
 * Local-time stamp for a file name: YYYY-MM-DD HH.mm.ss. It has no colon (Windows forbids it).
 * @param {Date} date
 * @returns {string}
 */
export function captureStamp(date) {
  return (
    `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ` +
    `${pad2(date.getHours())}.${pad2(date.getMinutes())}.${pad2(date.getSeconds())}`
  );
}

/**
 * Base name of a finished capture, without an extension: `Spool <YYYY-MM-DD HH.mm.ss> <title>`.
 * The title is sanitized and cut to CAPTURE_TITLE_MAX_LENGTH. An empty title (or one that has
 * nothing usable) leaves it out: `Spool <YYYY-MM-DD HH.mm.ss>`. The result is one safe path
 * segment: `<base>.png` is the full image, and `<base>` is the folder name of the tiles.
 * @param {Date} date
 * @param {unknown} title  Page title (may be empty or anything).
 * @returns {string}
 */
export function captureBaseName(date, title) {
  const label = sanitizePathSegment(title, CAPTURE_TITLE_MAX_LENGTH, '');
  const stamp = captureStamp(date);
  return label === '' ? `${CAPTURE_PREFIX} ${stamp}` : `${CAPTURE_PREFIX} ${stamp} ${label}`;
}

/**
 * One file of a finished capture.
 * @typedef {Object} CaptureFile
 * @property {'full' | 'tile'} kind
 * @property {number} [index]  0-based tile index. Present for kind 'tile'.
 * @property {string[]} path   Folder names, then the file name. Relative to the save root.
 */

/**
 * The files that one finished capture writes, in write order: the full image first, then the
 * tiles. `base` comes from captureBaseName().
 * - One tile that is the full image 1:1 (`fitsOneImage`): one flat file `<base>.png`. It is the
 *   full image, or the tile when only tiles are on. Never both: they show the same picture.
 * - Any other capture: the full image flat as `<base>.png` (when `saveFull`), and the tiles as
 *   `Spool for AI/<base>/screenshot-NN-of-MM.png` (when `saveTiles`). A single tile that is
 *   scaled to the size an AI reads belongs here: it is not the same picture as the full image.
 * - Both off: no file.
 * @param {{ base: string, tileCount: number, saveTiles: boolean, saveFull: boolean,
 *   fitsOneImage?: boolean }} input
 *   `fitsOneImage`: default `tileCount === 1`. Pass `fitsOneImage(plans, widthPx)` from
 *   src/lib/tiles.js: a single tile can be a scaled one.
 * @returns {CaptureFile[]}
 */
export function captureFiles({ base, tileCount, saveTiles, saveFull, fitsOneImage = tileCount === 1 }) {
  if (typeof base !== 'string' || base === '') throw new TypeError('base must be a name');
  if (!Number.isSafeInteger(tileCount) || tileCount < 1) {
    throw new RangeError('tileCount must be a whole number of at least 1');
  }
  const flat = `${base}.png`;
  /** @type {CaptureFile[]} */
  const files = [];
  if (fitsOneImage && tileCount === 1) {
    if (saveFull) files.push({ kind: 'full', path: [flat] });
    else if (saveTiles) files.push({ kind: 'tile', index: 0, path: [flat] });
    return files;
  }
  if (saveFull) files.push({ kind: 'full', path: [flat] });
  if (saveTiles) {
    for (let index = 0; index < tileCount; index += 1) {
      files.push({
        kind: 'tile',
        index,
        path: [TILES_FOLDER_NAME, base, tileFileName(index, tileCount)],
      });
    }
  }
  return files;
}
