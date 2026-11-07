// @ts-check
/**
 * Checks of what a finished capture leaves behind: the paths of the saved files and the thumbnail
 * of the summary. Pure functions (no Playwright, no browser), unit-tested in
 * test/unit/e2e-save-check.test.js.
 *
 * The rules are written out here from docs/contracts.md section 7.3 and the toast spec, not taken
 * from src/lib/names.js or src/render/util.js: a wrong rule in src/ fails the spec instead of
 * passing it. The thumbnail limits are the 320 x 480 px of the toast (THUMBNAIL_MAX_* in
 * constants.js).
 */

/**
 * What these checks read of a decoded PNG (a DecodedPng has more fields).
 * @typedef {Object} DecodedPng
 * @property {number} width
 * @property {number} height
 * @property {number} channels  3 (RGB) or 4 (RGBA).
 * @property {Uint8Array | Uint8ClampedArray} data
 */

/** Largest thumbnail, px (the toast card). */
const THUMB_MAX_WIDTH = 320;
const THUMB_MAX_HEIGHT = 480;

/**
 * @param {string} text
 * @returns {string}
 */
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Problems with the paths that a capture asked Chrome to download (relative to Downloads).
 *
 * - One tile: one flat file `<folder>/<base>.png` (the full image).
 * - More tiles: the full image `<folder>/<base>.png` and every tile as
 *   `<folder>/Spool for AI/<base>/screenshot-NN-of-MM.png` (NN and MM have at least 2 digits).
 * - `<base>` is `Spool <YYYY-MM-DD HH.mm.ss> <title>` in local time, and the time lies in
 *   [notBefore, notAfter] (epoch ms; the stamp has a resolution of one second).
 * The order of the paths is not checked.
 *
 * @param {readonly string[]} requested
 * @param {{ folder: string, title: string, tileCount: number, notBefore: number, notAfter: number }} expected
 * @returns {string[]}
 */
export function savePathProblems(requested, { folder, title, tileCount, notBefore, notAfter }) {
  /** @type {string[]} */
  const problems = [];
  const wanted = tileCount === 1 ? 1 : 1 + tileCount;
  if (requested.length !== wanted) {
    problems.push(
      `${requested.length} file(s) were saved; expected ${wanted} (${tileCount} tile(s)): ${requested.join(' | ')}`,
    );
  }
  const stamp = String.raw`(\d{4})-(\d{2})-(\d{2}) (\d{2})\.(\d{2})\.(\d{2})`;
  const head = `^${escapeRegExp(folder)}/(Spool ${stamp} ${escapeRegExp(title)})`;
  const flat = requested.filter((p) => !p.includes('/Spool for AI/'));
  if (flat.length !== 1) {
    problems.push(`expected one flat full image, found ${flat.length}: ${flat.join(' | ')}`);
  }
  const full = flat[0] ?? '';
  const match = new RegExp(`${head}\\.png$`).exec(full);
  if (!match) {
    problems.push(
      `the full image path "${full}" does not look like ${folder}/Spool <YYYY-MM-DD HH.mm.ss> ${title}.png`,
    );
    return problems;
  }
  const base = /** @type {string} */ (match[1]);
  const [y, mo, d, h, mi, s] = match.slice(2, 8).map(Number);
  const when = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s)).getTime();
  if (!(when >= notBefore - 1000 && when <= notAfter)) {
    problems.push(
      `the time in the name (${base}) is outside the run: ${new Date(when).toISOString()} not in ` +
        `${new Date(notBefore).toISOString()} .. ${new Date(notAfter).toISOString()}`,
    );
  }
  if (tileCount > 1) {
    const digits = Math.max(2, String(tileCount).length);
    const pad = (/** @type {number} */ n) => String(n).padStart(digits, '0');
    const names = Array.from(
      { length: tileCount },
      (_, i) => `${folder}/Spool for AI/${base}/screenshot-${pad(i + 1)}-of-${pad(tileCount)}.png`,
    );
    for (const name of names) {
      if (!requested.includes(name)) problems.push(`missing tile file: ${name}`);
    }
    for (const path of requested) {
      if (path !== full && !names.includes(path)) problems.push(`unexpected file: ${path}`);
    }
  }
  return problems;
}

/**
 * The thumbnail that a capture of this size must have: the top of the full image, scaled down to
 * fit 320 x 480 px and never scaled up.
 * @param {number} widthPx   Width of the full image.
 * @param {number} heightPx  Height of the full image.
 * @returns {{ srcHeight: number, width: number, height: number }}
 */
export function expectedThumbnail(widthPx, heightPx) {
  const scale = Math.min(1, THUMB_MAX_WIDTH / widthPx);
  const srcHeight = Math.min(heightPx, Math.floor(THUMB_MAX_HEIGHT / scale));
  return {
    srcHeight,
    width: Math.max(1, Math.min(THUMB_MAX_WIDTH, Math.round(widthPx * scale))),
    height: Math.max(1, Math.min(THUMB_MAX_HEIGHT, Math.round(srcHeight * scale))),
  };
}

/**
 * Box-filter reduction of the top `srcHeight` rows of an image to `width` x `height` (RGB).
 * @param {DecodedPng} image
 * @param {number} srcHeight
 * @param {number} width
 * @param {number} height
 * @returns {Uint8Array}  RGB, row by row.
 */
export function boxReduce(image, srcHeight, width, height) {
  const out = new Uint8Array(width * height * 3);
  for (let oy = 0; oy < height; oy++) {
    const y0 = Math.floor((oy * srcHeight) / height);
    const y1 = Math.max(y0 + 1, Math.ceil(((oy + 1) * srcHeight) / height));
    for (let ox = 0; ox < width; ox++) {
      const x0 = Math.floor((ox * image.width) / width);
      const x1 = Math.max(x0 + 1, Math.ceil(((ox + 1) * image.width) / width));
      let r = 0;
      let g = 0;
      let b = 0;
      let n = 0;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const o = (y * image.width + x) * image.channels;
          r += image.data[o] ?? 0;
          g += image.data[o + 1] ?? 0;
          b += image.data[o + 2] ?? 0;
          n += 1;
        }
      }
      const p = (oy * width + ox) * 3;
      out[p] = Math.round(r / n);
      out[p + 1] = Math.round(g / n);
      out[p + 2] = Math.round(b / n);
    }
  }
  return out;
}

/**
 * Mean absolute difference (0-255) of the RGB values of an image and a reference.
 * @param {DecodedPng} image
 * @param {Uint8Array} reference  RGB, same size as the image.
 * @returns {number}
 */
export function meanAbsDifference(image, reference) {
  let total = 0;
  const pixels = image.width * image.height;
  for (let i = 0; i < pixels; i++) {
    const o = i * image.channels;
    for (let c = 0; c < 3; c++) {
      total += Math.abs((image.data[o + c] ?? 0) - (reference[i * 3 + c] ?? 0));
    }
  }
  return total / (pixels * 3);
}

/**
 * Problems with the thumbnail of a summary, against the full image of the same capture.
 * The thumbnail is drawn with a smoothing filter, so the pixels are compared with a box reduction
 * of the full image's top rows, with a tolerance (`maxMeanDiff`, 0-255). A blank or shifted
 * thumbnail is far above it; the filter difference at the 8 px band edges is far below it.
 * @param {{
 *   thumbnail: DecodedPng,
 *   full: DecodedPng,
 *   reportedWidth: number,
 *   reportedHeight: number,
 *   maxMeanDiff?: number,
 * }} input
 * @returns {string[]}
 */
export function thumbnailProblems({ thumbnail, full, reportedWidth, reportedHeight, maxMeanDiff = 12 }) {
  /** @type {string[]} */
  const problems = [];
  const want = expectedThumbnail(full.width, full.height);
  if (thumbnail.width !== reportedWidth || thumbnail.height !== reportedHeight) {
    problems.push(
      `the thumbnail PNG is ${thumbnail.width}x${thumbnail.height}; the summary says ${reportedWidth}x${reportedHeight}`,
    );
  }
  if (Math.abs(thumbnail.width - want.width) > 1 || Math.abs(thumbnail.height - want.height) > 1) {
    problems.push(
      `the thumbnail is ${thumbnail.width}x${thumbnail.height}; the top ${want.srcHeight} rows of a ` +
        `${full.width}x${full.height} image must fit 320x480 as ${want.width}x${want.height}`,
    );
    return problems;
  }
  const reference = boxReduce(full, want.srcHeight, thumbnail.width, thumbnail.height);
  const diff = meanAbsDifference(thumbnail, reference);
  if (!(diff <= maxMeanDiff)) {
    problems.push(
      `the thumbnail differs from the top of the full image: mean difference ${diff.toFixed(1)} of 255 (limit ${maxMeanDiff})`,
    );
  }
  return problems;
}

/**
 * Problems with the seam status of every stored frame (the `seam.status` of each add-frame
 * reply). The first frame is 'first'. Every other frame must be 'exact', 'corrected',
 * 'duplicate' (a repeat of a stored frame: harmless) or 'ambiguous'. 'ambiguous' is accepted on
 * purpose: the fixture bands repeat flat colours, so a search upwards can find more than one
 * equal shift (capture-up.spec.js does), and the pixel checks of the same spec prove that the
 * join is right. 'unmatched' (no shift fits) or an unknown status is a failure: the join was not
 * verified at all. The result page keeps no per-slice data, so the statuses come from the replies
 * that the service worker saw.
 * @param {readonly (string | undefined)[]} statuses  In frame order.
 * @returns {string[]}
 */
export function seamProblems(statuses) {
  /** @type {string[]} */
  const problems = [];
  if (statuses.length === 0) problems.push('no frame reply was seen: the seam statuses are unknown');
  statuses.forEach((status, i) => {
    if (i === 0 && status !== 'first') problems.push(`frame 1 has seam status "${status}", not "first"`);
    if (i > 0 && !['exact', 'corrected', 'duplicate', 'ambiguous'].includes(String(status))) {
      problems.push(`frame ${i + 1} has seam status "${status}": the join was not verified`);
    }
  });
  return problems;
}
