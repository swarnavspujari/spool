// @ts-check
/**
 * Tests for e2e/perf-stats.js: the statistics and the timeline that e2e/perf.spec.js reports and
 * checks its budgets with. A wrong number here would make a budget meaningless.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  captureTimeline,
  formatBytes,
  formatMs,
  formatTable,
  gaps,
  heapPeak,
  median,
  mostInWindow,
  summarize,
} from '../../e2e/perf-stats.js';

describe('summarize and median', () => {
  it('summarizes an odd and an even number of values', () => {
    const odd = summarize([5, 1, 3]);
    assert.deepEqual([odd.n, odd.min, odd.median, odd.max, odd.mean], [3, 1, 3, 5, 3]);
    const even = summarize([4, 1, 3, 2]);
    assert.equal(even.median, 2.5);
    assert.equal(even.mean, 2.5);
  });

  it('interpolates the 95th percentile', () => {
    const values = Array.from({ length: 101 }, (_, i) => i); // 0..100
    assert.equal(summarize(values).p95, 95);
    assert.equal(summarize([10, 20]).p95, 19.5);
  });

  it('does not change its input', () => {
    const values = [3, 1, 2];
    summarize(values);
    assert.deepEqual(values, [3, 1, 2]);
  });

  it('gives NaN for no values and the value itself for one', () => {
    const none = summarize([]);
    assert.equal(none.n, 0);
    assert.ok([none.min, none.median, none.p95, none.max, none.mean].every(Number.isNaN));
    assert.deepEqual(summarize([7]), { n: 1, min: 7, median: 7, p95: 7, max: 7, mean: 7 });
    assert.equal(median([9, 1, 5]), 5);
  });
});

describe('gaps and mostInWindow', () => {
  it('takes the differences of neighbours', () => {
    assert.deepEqual(gaps([10, 15, 40]), [5, 25]);
    assert.deepEqual(gaps([1]), []);
    assert.deepEqual(gaps([]), []);
  });

  it('counts the most events inside one second', () => {
    assert.equal(mostInWindow([0, 550, 1100, 1650]), 2);
    assert.equal(mostInWindow([0, 400, 800, 1200]), 3);
    assert.equal(mostInWindow([0, 1000, 2000]), 1); // A window is [t, t + 1000).
    assert.equal(mostInWindow([0, 999]), 2);
    assert.equal(mostInWindow([]), 0);
    assert.equal(mostInWindow([5]), 1);
    assert.equal(mostInWindow([0, 100, 200], 150), 2);
  });
});

/**
 * @param {number} t
 * @param {'in' | 'out'} dir
 * @param {string} type
 * @param {Partial<WorkerEvent>} [extra]
 * @returns {WorkerEvent}
 */
const event = (t, dir, type, extra = {}) => ({ t, dir, type, ...extra });

describe('captureTimeline', () => {
  // Three frames, 1,000 ms apart. Capture ends 100 ms after the request, the store replies 40 ms
  // later. Done at 3,500; the build ends at 4,000 (sw/download) and the reply comes at 4,300.
  const events = [
    event(0, 'in', 'page/session-open'),
    event(1000, 'in', 'page/capture-frame'),
    event(1100, 'out', 'tabs.captureVisibleTab', { ok: true }),
    event(1140, 'out', 'offscreen/add-frame', { ok: true }),
    event(2000, 'in', 'page/capture-frame'),
    event(2100, 'out', 'tabs.captureVisibleTab', { ok: true }),
    event(2150, 'out', 'offscreen/add-frame', { ok: true }),
    event(3000, 'in', 'page/capture-frame'),
    event(3120, 'out', 'tabs.captureVisibleTab', { ok: true }),
    event(3160, 'out', 'offscreen/add-frame', { ok: true }),
    event(3500, 'in', 'page/finish'),
    event(4000, 'in', 'sw/download'),
    event(4300, 'out', 'offscreen/finalize', { ok: true }),
  ];

  it('measures every phase', () => {
    const t = captureTimeline(events, { minIntervalMs: 550 });
    assert.equal(t.frames, 3);
    assert.equal(t.captureFailures, 0);
    assert.deepEqual(t.stepMs, [1000, 1000]);
    assert.deepEqual(t.captureMs, [100, 100, 120]);
    assert.deepEqual(t.intakeMs, [40, 50, 40]);
    assert.deepEqual(t.captureGapMs, [1000, 1020]);
    assert.equal(t.mostCapturesInOneSecond, 1);
    assert.equal(t.totalMs, 2160);
    assert.equal(t.floorMs, 1100);
    assert.ok(Math.abs(t.capturesPerSecond - 3 / 2.16) < 1e-9);
    assert.equal(t.finalizeMs, 800);
    assert.equal(t.buildMs, 500);
    assert.equal(t.saveMs, 300);
  });

  it('counts failed captures and keeps them out of the pairs', () => {
    const withFailure = [
      event(1000, 'in', 'page/capture-frame'),
      event(1050, 'out', 'tabs.captureVisibleTab', { ok: false, threw: 'quota' }),
      event(1700, 'out', 'tabs.captureVisibleTab', { ok: true }),
      event(1740, 'out', 'offscreen/add-frame', { ok: true }),
    ];
    const t = captureTimeline(withFailure, { minIntervalMs: 550 });
    assert.equal(t.captureFailures, 1);
    assert.equal(t.frames, 1);
    assert.deepEqual(t.captureMs, [700]);
    assert.equal(t.finalizeMs, null);
    assert.equal(t.buildMs, null);
    assert.equal(t.saveMs, null);
  });

  it('does not count a failed frame reply as stored', () => {
    const t = captureTimeline(
      [
        event(0, 'in', 'page/capture-frame'),
        event(10, 'out', 'tabs.captureVisibleTab', { ok: true }),
        event(20, 'out', 'offscreen/add-frame', { ok: false, code: 'E_SESSION_TOO_LARGE' }),
      ],
      { minIntervalMs: 550 },
    );
    assert.equal(t.frames, 0);
    assert.equal(t.totalMs, 0);
    assert.equal(t.capturesPerSecond, 0);
  });

  it('has no build time when nothing was downloaded', () => {
    const t = captureTimeline(
      [
        event(100, 'in', 'page/finish'),
        event(900, 'out', 'offscreen/finalize', { ok: true }),
      ],
      { minIntervalMs: 550 },
    );
    assert.equal(t.finalizeMs, 800);
    assert.equal(t.buildMs, null);
    assert.equal(t.saveMs, null);
  });

  it('takes a failed finalize for no finalize', () => {
    const t = captureTimeline(
      [event(100, 'in', 'page/finish'), event(900, 'out', 'offscreen/finalize', { ok: false })],
      { minIntervalMs: 550 },
    );
    assert.equal(t.finalizeMs, null);
  });
});

describe('heapPeak and formatting', () => {
  it('finds the first, the highest and the last sample', () => {
    const peak = heapPeak([
      { t: 1, used: 10 },
      { t: 2, used: 50 },
      { t: 3, used: 20 },
    ]);
    assert.deepEqual(peak, { n: 3, firstBytes: 10, peakBytes: 50, lastBytes: 20 });
    assert.equal(heapPeak([]).n, 0);
    assert.ok(Number.isNaN(heapPeak([]).peakBytes));
  });

  it('formats milliseconds and bytes', () => {
    assert.equal(formatMs(1234.4), '1,234 ms');
    assert.equal(formatMs(NaN), 'n/a');
    assert.equal(formatBytes(12_340_000), '12.3 MB');
    assert.equal(formatBytes(1_000_000), '1.0 MB');
    assert.equal(formatBytes(999_999), '1000 KB');
    assert.equal(formatBytes(456_400), '456 KB');
    assert.equal(formatBytes(0), '0 KB');
    assert.equal(formatBytes(NaN), 'n/a');
  });

  it('aligns the columns of a table', () => {
    const table = formatTable([
      ['metric', 'value'],
      ['a', '1'],
      ['longer name', '22'],
    ]);
    assert.equal(
      table,
      ['metric      | value', '------------|------', 'a           | 1', 'longer name | 22'].join('\n'),
    );
    assert.equal(formatTable([]), '');
  });
});
