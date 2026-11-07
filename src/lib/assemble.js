// @ts-check
/**
 * Assembly plan for the full image: which rows of which slice go to which rows of the result.
 * Pure functions, device px. Invalid input throws TypeError or RangeError.
 */

/** @typedef {import('../shared/types.js').SliceInfo} SliceInfo */
/** @typedef {import('../shared/types.js').Piece} Piece */
/** @typedef {{ totalHeight: number, pieces: Piece[] }} AssemblyPlan */
/** @typedef {{ index: number, start: number, end: number }} Span */

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} [min]
 * @returns {asserts value is number}
 */
function requireInteger(name, value, min) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isSafeInteger(value) || (min !== undefined && value < min)) {
    throw new RangeError(`${name} must be a whole number${min === undefined ? '' : ` >= ${min}`}`);
  }
}

/**
 * @param {SliceInfo} slice
 * @returns {Span}
 */
function toSpan(slice) {
  requireInteger('slice.index', slice.index, 0);
  requireInteger('slice.yPx', slice.yPx);
  requireInteger('slice.heightPx', slice.heightPx, 1);
  return { index: slice.index, start: slice.yPx, end: slice.yPx + slice.heightPx };
}

/**
 * Drops every slice whose rows the other slices already provide: a slice inside another one,
 * or a slice that its two neighbours cover together. The result is a chain in which both
 * `start` and `end` grow strictly, so each slice owns at least one row.
 * @param {Span[]} spans  Sorted by `start`; for equal starts the longer slice comes first.
 * @returns {Span[]}
 */
function dropCoveredSlices(spans) {
  /** @type {Span[]} */
  const chain = [];
  for (const span of spans) {
    const last = chain.at(-1);
    // Same or later start and not a later end: the slice lies inside `last`.
    if (last !== undefined && span.end <= last.end) continue;
    // `last` adds nothing when the slice before it already reaches `span`. Dropping it can make
    // the slice before it redundant too, so repeat.
    while (chain.length >= 2 && chain[chain.length - 2].end >= span.start) chain.pop();
    chain.push(span);
  }
  return chain;
}

/**
 * Where two neighbouring slices meet. Slices that overlap or touch are cut in the middle of the
 * overlap. With a gap, each slice keeps its own edge.
 * @param {Span} upper
 * @param {Span} lower
 * @returns {{ upperEnd: number, lowerStart: number }}
 */
function seamBetween(upper, lower) {
  if (upper.end < lower.start) return { upperEnd: upper.end, lowerStart: lower.start };
  const cut = lower.start + Math.floor((upper.end - lower.start) / 2);
  return { upperEnd: cut, lowerStart: cut };
}

/**
 * Plans the copy operations that build the full image from its slices.
 *
 * `yPx` values are relative to any origin: the result starts at the smallest one. Neighbours
 * that overlap are cut in the middle of the overlap. A slice that the others cover completely
 * gets no piece. Rows that no slice covers get no piece, so the gap stays empty.
 * The input need not be sorted. `seamStatus` is ignored.
 *
 * @param {SliceInfo[]} slices
 * @returns {AssemblyPlan}  `pieces` are sorted by `dstY` and never overlap.
 */
export function planAssembly(slices) {
  if (!Array.isArray(slices)) throw new TypeError('slices must be an array');
  const spans = slices.map(toSpan).sort((a, b) => a.start - b.start || b.end - a.end);
  const chain = dropCoveredSlices(spans);
  const first = chain[0];
  const last = chain.at(-1);
  if (first === undefined || last === undefined) return { totalHeight: 0, pieces: [] };

  /** @type {Piece[]} */
  const pieces = [];
  let from = first.start;
  for (const [i, span] of chain.entries()) {
    const next = chain[i + 1];
    const seam = next ? seamBetween(span, next) : { upperEnd: span.end, lowerStart: span.end };
    pieces.push({
      sliceIndex: span.index,
      srcY: from - span.start,
      dstY: from - first.start,
      height: seam.upperEnd - from,
    });
    from = seam.lowerStart;
  }
  return { totalHeight: last.end - first.start, pieces };
}

/**
 * The part of a plan that falls into the rows `[y, y + height)`.
 * @param {Piece[]} pieces  From `planAssembly`.
 * @param {number} y        First row of the range in the full image.
 * @param {number} height   Row count of the range.
 * @returns {Piece[]}  New pieces cut at the range edges; `dstY` is relative to `y`. A range
 *   that no piece touches gives an empty array.
 */
export function piecesForRange(pieces, y, height) {
  if (!Array.isArray(pieces)) throw new TypeError('pieces must be an array');
  requireInteger('y', y, 0);
  requireInteger('height', height, 1);

  const end = y + height;
  /** @type {Piece[]} */
  const clipped = [];
  for (const piece of pieces) {
    const from = Math.max(piece.dstY, y);
    const to = Math.min(piece.dstY + piece.height, end);
    if (to <= from) continue;
    clipped.push({
      sliceIndex: piece.sliceIndex,
      srcY: piece.srcY + (from - piece.dstY),
      dstY: from - y,
      height: to - from,
    });
  }
  return clipped;
}
