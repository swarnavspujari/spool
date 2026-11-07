// @ts-check
/**
 * Pure helpers of e2e/perf.spec.js: statistics, the timeline of a capture from the service worker
 * events, the peak of the heap samples, and the text table. No Playwright and no browser, so they
 * are unit-tested in test/unit/e2e-perf-stats.test.js.
 */

/**
 * @typedef {Object} Summary
 * @property {number} n
 * @property {number} min
 * @property {number} median
 * @property {number} p95
 * @property {number} max
 * @property {number} mean
 */

/**
 * The value at fraction `p` (0 to 1) of the sorted values, by linear interpolation.
 * @param {readonly number[]} sorted  Ascending.
 * @param {number} p
 * @returns {number}
 */
function quantile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const at = (sorted.length - 1) * p;
  const lower = Math.floor(at);
  const upper = Math.ceil(at);
  const a = /** @type {number} */ (sorted[lower]);
  const b = /** @type {number} */ (sorted[upper]);
  return a + (b - a) * (at - lower);
}

/**
 * @param {readonly number[]} values
 * @returns {Summary}  NaN fields when there are no values.
 */
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  return {
    n,
    min: n === 0 ? NaN : /** @type {number} */ (sorted[0]),
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    max: n === 0 ? NaN : /** @type {number} */ (sorted[n - 1]),
    mean: n === 0 ? NaN : sorted.reduce((sum, v) => sum + v, 0) / n,
  };
}

/**
 * @param {readonly number[]} values
 * @returns {number}  The median, NaN for no values.
 */
export function median(values) {
  return summarize(values).median;
}

/**
 * The differences between neighbours: [b - a, c - b, ...].
 * @param {readonly number[]} values
 * @returns {number[]}
 */
export function gaps(values) {
  /** @type {number[]} */
  const out = [];
  for (let i = 1; i < values.length; i++) {
    out.push(/** @type {number} */ (values[i]) - /** @type {number} */ (values[i - 1]));
  }
  return out;
}

/**
 * Most captures that completed inside one window of `windowMs` (a sliding window that starts at a
 * capture). Chrome allows 2 calls per second of captureVisibleTab; this is what the log shows.
 * @param {readonly number[]} times  Ascending, ms.
 * @param {number} [windowMs]
 * @returns {number}
 */
export function mostInWindow(times, windowMs = 1000) {
  let best = 0;
  let start = 0;
  for (let end = 0; end < times.length; end++) {
    while (/** @type {number} */ (times[end]) - /** @type {number} */ (times[start]) >= windowMs) start++;
    best = Math.max(best, end - start + 1);
  }
  return best;
}

/**
 * @typedef {Object} Timeline
 * @property {number} frames            Frames the offscreen document stored (one per request).
 * @property {number} captureFailures   captureVisibleTab calls that failed (quota or other).
 * @property {number[]} stepMs          Between the page asking for two frames in a row.
 * @property {number[]} captureMs       From the request to the end of captureVisibleTab (queue wait
 *   for the rate limit included).
 * @property {number[]} intakeMs        From the end of the capture to the offscreen reply
 *   (message, decode, crop, seam, PNG encode, reply).
 * @property {number[]} captureGapMs    Between the ends of two captures in a row.
 * @property {number} mostCapturesInOneSecond
 * @property {number} totalMs           First request to last stored frame.
 * @property {number} floorMs           (frames - 1) intervals of the rate limit: the least time
 *   that the limit allows.
 * @property {number} capturesPerSecond Frames divided by the time they took.
 * @property {number | null} finalizeMs From the page's Done (page/finish) to the reply of the
 *   offscreen finalize (build and save).
 * @property {number | null} buildMs    From Done to the start of the save step (sw/download), or
 *   null when nothing was downloaded.
 * @property {number | null} saveMs     From the start of the save step to the finalize reply.
 */

/**
 * Reads the timeline of one capture from the events of the test hook of the service worker
 * (e2e/build-extension.mjs). Events of one browser belong to one capture.
 * @param {readonly WorkerEvent[]} events
 * @param {{ minIntervalMs: number }} options  CAPTURE_MIN_INTERVAL_MS, written out by the caller.
 * @returns {Timeline}
 */
export function captureTimeline(events, { minIntervalMs }) {
  /** @param {(e: WorkerEvent) => boolean} test @returns {number[]} */
  const times = (test) => events.filter(test).map((e) => e.t);
  const requests = times((e) => e.dir === 'in' && e.type === 'page/capture-frame');
  const captures = times((e) => e.dir === 'out' && e.type === 'tabs.captureVisibleTab' && e.ok === true);
  const stored = times((e) => e.dir === 'out' && e.type === 'offscreen/add-frame' && e.ok === true);
  const captureFailures = events.filter(
    (e) => e.dir === 'out' && e.type === 'tabs.captureVisibleTab' && e.ok !== true,
  ).length;

  const frames = Math.min(requests.length, captures.length, stored.length);
  const pair = (/** @type {number[]} */ later, /** @type {number[]} */ earlier) =>
    Array.from({ length: frames }, (_, i) => /** @type {number} */ (later[i]) - /** @type {number} */ (earlier[i]));
  const totalMs = frames === 0 ? 0 : /** @type {number} */ (stored[frames - 1]) - /** @type {number} */ (requests[0]);

  const finish = times((e) => e.dir === 'in' && e.type === 'page/finish')[0];
  const finalized = events
    .filter((e) => e.dir === 'out' && e.type === 'offscreen/finalize' && e.ok === true)
    .map((e) => e.t)[0];
  const download = times((e) => e.dir === 'in' && e.type === 'sw/download')[0];
  const known = finish !== undefined && finalized !== undefined;

  return {
    frames,
    captureFailures,
    stepMs: gaps(requests.slice(0, frames)),
    captureMs: pair(captures, requests),
    intakeMs: pair(stored, captures),
    captureGapMs: gaps(captures.slice(0, frames)),
    mostCapturesInOneSecond: mostInWindow(captures.slice(0, frames)),
    totalMs,
    floorMs: Math.max(0, frames - 1) * minIntervalMs,
    capturesPerSecond: totalMs > 0 ? frames / (totalMs / 1000) : 0,
    finalizeMs: known ? finalized - finish : null,
    buildMs: known && download !== undefined ? download - finish : null,
    saveMs: known && download !== undefined ? finalized - download : null,
  };
}

/**
 * @param {readonly { t: number, used: number }[]} samples
 * @returns {{ n: number, firstBytes: number, peakBytes: number, lastBytes: number }}
 */
export function heapPeak(samples) {
  if (samples.length === 0) return { n: 0, firstBytes: NaN, peakBytes: NaN, lastBytes: NaN };
  return {
    n: samples.length,
    firstBytes: /** @type {{ used: number }} */ (samples[0]).used,
    peakBytes: Math.max(...samples.map((s) => s.used)),
    lastBytes: /** @type {{ used: number }} */ (samples[samples.length - 1]).used,
  };
}

/**
 * @param {number} ms
 * @returns {string}  For example "1,234 ms".
 */
export function formatMs(ms) {
  return Number.isFinite(ms) ? `${Math.round(ms).toLocaleString('en-US')} ms` : 'n/a';
}

/**
 * @param {number} bytes
 * @returns {string}  For example "12.3 MB" or "456 KB" (decimal units).
 */
export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return 'n/a';
  return bytes >= 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${(bytes / 1e3).toFixed(0)} KB`;
}

/**
 * A text table with aligned columns.
 * @param {readonly (readonly string[])[]} rows  The first row is the header.
 * @returns {string}
 */
export function formatTable(rows) {
  const columns = Math.max(0, ...rows.map((r) => r.length));
  const widths = Array.from({ length: columns }, (_, c) => Math.max(...rows.map((r) => (r[c] ?? '').length)));
  const line = (/** @type {readonly string[]} */ row) =>
    row.map((cell, c) => cell.padEnd(/** @type {number} */ (widths[c]))).join(' | ').trimEnd();
  const [header, ...body] = rows;
  if (!header) return '';
  const rule = widths.map((w) => '-'.repeat(w)).join('-|-');
  return [line(header), rule, ...body.map(line)].join('\n');
}
