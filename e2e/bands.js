// @ts-check
/**
 * Band encoding and band verifier for the end-to-end tests.
 *
 * The fixture pages draw content as BANDS: horizontal stripes 8 CSS px tall. The solid colour of
 * band `i` encodes its index (r = i & 255, g = (i >> 8) & 255, b = 200). Every 5th band also has
 * a 1 CSS px darker line at its top edge (a visual aid for humans, and a trap for a verifier that
 * is not careful). The fixture pages and the verifier import this one module, so both sides
 * always agree on the encoding. It is plain ES module code with no Node or DOM dependency.
 *
 * verifyBands() reads some pixel columns of a decoded image, turns pixel runs into band indexes
 * and reports every violation of the rules below.
 *
 *  1. Indexes increase by exactly 1 from one band to the next (no gap, no duplicate, no reorder).
 *  2. The distance between the tops of two neighbour bands is 8 * scale rows (+/- 1).
 *  3. Nothing but bands sits between two bands. Other content ("foreign" colours, for example a
 *     sticky header or a fixed footer) may only lead or trail the band sequence.
 *  4. The first and the last band have the expected indexes (when given).
 *  5. The other sampled columns show the same bands as the centre column.
 *
 * One or two antialiased rows at a band edge (fractional scale) and the 1 CSS px lines are
 * ignored: they are runs of fewer rows than a real band could have. A run of at most
 * ceil(scale) rows of foreign colour at the very top or bottom of the image is a boundary row
 * (the crop at a fractional scale can include one device row beyond the captured element). It is
 * not an error; it is reported in `edgeRows`.
 */

/** Height of one band, CSS px. */
export const BAND_CSS = 8;
/** Blue channel of every band colour. */
export const BAND_BLUE = 200;
/** Every LINE_EVERY-th band has a line at its top edge. */
export const LINE_EVERY = 5;
/** Thickness of the line, CSS px. */
export const LINE_CSS = 1;
/** Opacity of the black line over the band colour. */
export const LINE_ALPHA = 0.45;
/** Blue channel of a line row: the band blue darkened by LINE_ALPHA. */
export const LINE_BLUE = Math.round(BAND_BLUE * (1 - LINE_ALPHA));
/** `box-shadow` that draws the line inside a band element (it does not change the layout). */
export const LINE_SHADOW = `inset 0 ${LINE_CSS}px 0 rgba(0, 0, 0, ${LINE_ALPHA})`;
/** Largest index the colour code can carry. */
export const MAX_BAND_INDEX = 0xffff;

/** Colours of page parts that are not bands. None has a blue channel near 200 or LINE_BLUE. */
export const FOREIGN_COLORS = Object.freeze({
  /** Sticky header inside the chat panel. */
  header: Object.freeze([16, 24, 48]),
  /** Fixed composer (footer) over the chat panel. */
  composer: Object.freeze([240, 224, 32]),
  /** Fixed top bar of the chat page. */
  topBar: Object.freeze([60, 64, 72]),
  /** Background of the chat panel. */
  panel: Object.freeze([244, 244, 244]),
  /** Sticky date divider inside the panel of chat-pinned.html (in the flow, between bands). */
  divider: Object.freeze([200, 40, 120]),
});

/**
 * @typedef {Object} RawImage
 * @property {number} width
 * @property {number} height
 * @property {number} channels  3 (RGB) or 4 (RGBA). Alpha is ignored.
 * @property {Uint8Array | Uint8ClampedArray} data  Row by row, `channels` bytes per pixel.
 */

/**
 * @param {number} index
 * @returns {[number, number, number]}
 */
export function bandRgb(index) {
  return [index & 255, (index >> 8) & 255, BAND_BLUE];
}

/** @param {number} index @returns {string} */
export function bandCss(index) {
  const [r, g, b] = bandRgb(index);
  return `rgb(${r}, ${g}, ${b})`;
}

/** @param {number} index @returns {boolean} */
export function hasLine(index) {
  return index % LINE_EVERY === 0;
}

/**
 * Colour of a line row for band `index`: the band colour with LINE_ALPHA of black over it.
 * @param {number} index
 * @returns {[number, number, number]}
 */
export function lineRgb(index) {
  const [r, g, b] = bandRgb(index);
  const k = 1 - LINE_ALPHA;
  return [Math.round(r * k), Math.round(g * k), Math.round(b * k)];
}

/**
 * @param {number} r
 * @param {number} g
 * @returns {number}
 */
export function indexOfRgb(r, g) {
  return r + (g << 8);
}

// ---------------------------------------------------------------------------------------------
// Column analysis
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} Band
 * @property {number} index
 * @property {number} top     First row of the band (its line row, when it has one).
 * @property {number} start   First row of the solid colour run.
 * @property {number} end     Row after the solid colour run.
 * @property {boolean} cutTop     The band touches the top edge of the image (may be partial).
 * @property {boolean} cutBottom  The band touches the bottom edge of the image (may be partial).
 */

/**
 * @typedef {Object} Foreign
 * @property {[number, number, number]} color
 * @property {number} start
 * @property {number} end
 * @property {'leading' | 'between' | 'trailing' | 'only'} where  Position relative to the bands.
 */

/**
 * @typedef {Object} EdgeRows
 * @property {'top' | 'bottom'} side
 * @property {[number, number, number]} color
 * @property {number} rows
 */

/**
 * @typedef {Object} Analysis
 * @property {Band[]} bands
 * @property {Foreign[]} foreign
 * @property {EdgeRows[]} edgeRows  Boundary rows at the top or bottom edge of the image.
 */

/**
 * @typedef {Object} Run
 * @property {number} r
 * @property {number} g
 * @property {number} b
 * @property {number} start
 * @property {number} end
 */

/**
 * Splits column `x` into runs of identical colour. Exact equality is on purpose: neighbour band
 * colours differ by 1 in one channel.
 * @param {RawImage} img
 * @param {number} x
 * @returns {Run[]}
 */
function columnRuns(img, x) {
  const { width, height, channels, data } = img;
  /** @type {Run[]} */
  const runs = [];
  /** @type {Run | null} */
  let cur = null;
  for (let y = 0; y < height; y++) {
    const o = (y * width + x) * channels;
    const r = data[o] ?? 0;
    const g = data[o + 1] ?? 0;
    const b = data[o + 2] ?? 0;
    if (cur && cur.r === r && cur.g === g && cur.b === b) {
      cur.end = y + 1;
    } else {
      cur = { r, g, b, start: y, end: y + 1 };
      runs.push(cur);
    }
  }
  return runs;
}

/**
 * Turns the runs of one column into bands and foreign segments.
 * @param {RawImage} img
 * @param {number} x
 * @param {number} scale  Device px per CSS px.
 * @returns {Analysis}
 */
export function analyzeColumn(img, x, scale) {
  const runs = columnRuns(img, x);
  // A real band has at least (BAND_CSS - LINE_CSS) * scale rows. Antialiased rows at an edge and
  // the line are shorter than this threshold, so they are noise.
  const minRun = Math.max(3, Math.floor(BAND_CSS * scale * 0.4));
  const maxLineRows = Math.ceil(LINE_CSS * scale) + 1;
  const maxEdgeRows = Math.ceil(scale);

  /** @type {Band[]} */
  const bands = [];
  /** @type {Omit<Foreign, 'where'>[]} */
  const foreignRaw = [];
  /** Position of each item in reading order: 'b' + band number or 'f' + foreign number. */
  /** @type {{ kind: 'band' | 'foreign', at: number }[]} */
  const order = [];
  /** @type {EdgeRows[]} */
  const edgeRows = [];
  /** @type {Run | null} */
  let pendingLine = null;

  for (const run of runs) {
    const len = run.end - run.start;
    const atEdge = run.start === 0 || run.end === img.height;
    const long = len >= minRun || atEdge;
    if (Math.abs(run.b - BAND_BLUE) <= 1 && long) {
      const lineHere =
        pendingLine !== null && run.start - pendingLine.end <= 2 ? pendingLine : null;
      const index = indexOfRgb(run.r, run.g);
      // The same colour twice in a row merges into one tall run (a duplicated band without a
      // line). Split it, so that the continuity rule reports the duplicate.
      const copies = lineHere ? 1 : Math.max(1, Math.round(len / (BAND_CSS * scale)));
      for (let j = 0; j < copies; j++) {
        const start = run.start + Math.round((j * len) / copies);
        bands.push({
          index,
          top: j === 0 && lineHere ? lineHere.start : start,
          start,
          end: run.start + Math.round(((j + 1) * len) / copies),
          cutTop: j === 0 && run.start === 0,
          cutBottom: j === copies - 1 && run.end === img.height,
        });
        order.push({ kind: 'band', at: bands.length - 1 });
      }
      pendingLine = null;
    } else if (Math.abs(run.b - LINE_BLUE) <= 2 && len <= maxLineRows) {
      pendingLine = run;
    } else if (len < minRun && atEdge && len <= maxEdgeRows) {
      edgeRows.push({
        side: run.start === 0 ? 'top' : 'bottom',
        color: [run.r, run.g, run.b],
        rows: len,
      });
    } else if (long) {
      foreignRaw.push({ color: [run.r, run.g, run.b], start: run.start, end: run.end });
      order.push({ kind: 'foreign', at: foreignRaw.length - 1 });
      pendingLine = null;
    }
    // Else: antialiased edge row(s). Ignored.
  }

  const firstBand = order.findIndex((o) => o.kind === 'band');
  let lastBand = -1;
  order.forEach((o, i) => {
    if (o.kind === 'band') lastBand = i;
  });
  /** @type {Foreign[]} */
  const foreign = [];
  order.forEach((o, i) => {
    if (o.kind !== 'foreign') return;
    const raw = /** @type {Omit<Foreign, 'where'>} */ (foreignRaw[o.at]);
    /** @type {Foreign['where']} */
    let where = 'between';
    if (firstBand === -1) where = 'only';
    else if (i < firstBand) where = 'leading';
    else if (i > lastBand) where = 'trailing';
    foreign.push({ ...raw, where });
  });
  return { bands, foreign, edgeRows };
}

// ---------------------------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} VerifyOptions
 * @property {number} scale               Device px per CSS px of the image.
 * @property {number} [expectedFirst]     Index of the first band.
 * @property {number} [expectedLast]      Index of the last band.
 * @property {number[]} [columns]         Columns to read. Default: 25%, 50% and 75% of the width.
 *                                        The middle one is the reference.
 * @property {number} [tolerance]         Allowed error of a band pitch, rows. Default 1.
 * @property {number} [maxErrors]         Error lines to keep. Default 12.
 */

/**
 * @typedef {Object} VerifyResult
 * @property {boolean} ok
 * @property {string[]} errors
 * @property {Band[]} bands        Bands of the reference column.
 * @property {Foreign[]} foreign   Foreign segments of the reference column.
 * @property {EdgeRows[]} edgeRows Boundary rows at the image edges (not errors).
 * @property {number | null} firstIndex
 * @property {number | null} lastIndex
 */

/**
 * @param {number[]} tops
 * @returns {string}
 */
function listRows(tops) {
  return tops.join(', ');
}

/**
 * @param {Foreign} f
 * @param {number} scale
 * @returns {string}
 */
function describeForeign(f, scale) {
  const css = ((f.end - f.start) / scale).toFixed(1);
  return `rgb(${f.color.join(',')}) rows ${f.start}-${f.end} (${css} CSS px)`;
}

/**
 * Checks the bands of an image. See the file comment for the rules.
 * @param {RawImage} img
 * @param {VerifyOptions} opts
 * @returns {VerifyResult}
 */
export function verifyBands(img, opts) {
  const { scale, expectedFirst, expectedLast } = opts;
  const tolerance = opts.tolerance ?? 1;
  const maxErrors = opts.maxErrors ?? 12;
  /** @type {string[]} */
  const errors = [];
  /** @param {string} message */
  const fail = (message) => {
    errors.push(message);
  };

  if (!(scale > 0)) throw new RangeError('verifyBands: scale must be > 0');
  if (img.channels < 3) {
    return { ok: false, errors: [`image has ${img.channels} channel(s); need RGB`], bands: [], foreign: [], edgeRows: [], firstIndex: null, lastIndex: null };
  }
  if (img.width < 1 || img.height < 1) {
    return { ok: false, errors: ['image is empty'], bands: [], foreign: [], edgeRows: [], firstIndex: null, lastIndex: null };
  }

  const columns = opts.columns ?? [0.25, 0.5, 0.75].map((f) => Math.min(img.width - 1, Math.floor(img.width * f)));
  const refX = columns[Math.floor(columns.length / 2)] ?? 0;
  const ref = analyzeColumn(img, refX, scale);
  const { bands, foreign, edgeRows } = ref;
  const bandRows = BAND_CSS * scale;

  if (bands.length === 0) {
    fail(
      `no bands found in the centre column (x=${refX}); ` +
        `foreign segments: ${foreign.map((f) => describeForeign(f, scale)).join('; ') || 'none'}`,
    );
  }

  // Rule 1 and 2: continuity and spacing.
  for (let k = 1; k < bands.length; k++) {
    const prev = /** @type {Band} */ (bands[k - 1]);
    const cur = /** @type {Band} */ (bands[k]);
    const step = cur.index - prev.index;
    if (step === 0) {
      fail(`band ${cur.index} appears twice in a row (row ${prev.top} and row ${cur.top}): duplicate content`);
    } else if (step < 0) {
      fail(`band ${cur.index} follows band ${prev.index} at row ${cur.top}: order goes backwards`);
    } else if (step > 1) {
      fail(`${step - 1} band(s) missing between ${prev.index} and ${cur.index} at row ${cur.top} (indexes ${prev.index + 1}..${cur.index - 1})`);
    } else if (!prev.cutTop) {
      const pitch = cur.top - prev.top;
      if (Math.abs(pitch - bandRows) > tolerance) {
        fail(`band ${cur.index} is ${pitch} rows below band ${prev.index}; expected ${bandRows} +/- ${tolerance} (scale ${scale})`);
      }
    }
  }

  // Rule 3: nothing but bands between two bands.
  for (const f of foreign) {
    if (f.where === 'between') {
      const before = [...bands].reverse().find((b) => b.end <= f.start);
      const after = bands.find((b) => b.start >= f.end);
      fail(`foreign content between band ${before?.index ?? '?'} and band ${after?.index ?? '?'}: ${describeForeign(f, scale)}`);
    }
  }

  // Rule 4: first and last index.
  const firstIndex = bands.length > 0 ? /** @type {Band} */ (bands[0]).index : null;
  const lastIndex = bands.length > 0 ? /** @type {Band} */ (bands[bands.length - 1]).index : null;
  if (expectedFirst !== undefined && bands.length > 0 && firstIndex !== expectedFirst) {
    fail(`first band is ${firstIndex}; expected ${expectedFirst}`);
  }
  if (expectedLast !== undefined && bands.length > 0 && lastIndex !== expectedLast) {
    fail(`last band is ${lastIndex}; expected ${expectedLast}`);
  }

  // Rule 5: the other columns agree with the reference column.
  for (const x of columns) {
    if (x === refX) continue;
    const other = analyzeColumn(img, x, scale);
    const refSig = bands.map((b) => b.index).join(',');
    const otherSig = other.bands.map((b) => b.index).join(',');
    if (refSig !== otherSig) {
      const n = Math.min(bands.length, other.bands.length);
      let at = 0;
      while (at < n && /** @type {Band} */ (bands[at]).index === /** @type {Band} */ (other.bands[at]).index) at++;
      fail(`column x=${x} shows other bands than x=${refX}: first difference at band #${at} (${bands[at]?.index ?? 'none'} vs ${other.bands[at]?.index ?? 'none'})`);
      continue;
    }
    const drift = bands.filter((b, i) => Math.abs(b.top - /** @type {Band} */ (other.bands[i]).top) > tolerance && !b.cutTop);
    if (drift.length > 0) {
      fail(`column x=${x} has bands at other rows than x=${refX}: ${listRows(drift.slice(0, 5).map((b) => b.index))}`);
    }
  }

  const shown = errors.length > maxErrors ? [...errors.slice(0, maxErrors), `... and ${errors.length - maxErrors} more`] : errors;
  return { ok: errors.length === 0, errors: shown, bands, foreign, edgeRows, firstIndex, lastIndex };
}

/**
 * One short text block for assertion messages.
 * @param {VerifyResult} res
 * @param {number} scale
 * @returns {string}
 */
export function describeResult(res, scale) {
  const lines = [
    `bands: ${res.bands.length}` +
      (res.firstIndex === null ? '' : ` (${res.firstIndex}..${res.lastIndex})`),
  ];
  for (const f of res.foreign) lines.push(`foreign (${f.where}): ${describeForeign(f, scale)}`);
  for (const e of res.edgeRows) lines.push(`edge rows (${e.side}): ${e.rows} row(s) of rgb(${e.color.join(',')}) (boundary, ignored)`);
  for (const e of res.errors) lines.push(`error: ${e}`);
  return lines.join('\n');
}
