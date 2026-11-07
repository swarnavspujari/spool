// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ERR, SpoolError } from '../../src/shared/protocol.js';
import {
  CAPTURE_MIN_INTERVAL_MS,
  CAPTURE_READBACK_RETRY_DELAY_MS,
  CAPTURE_READBACK_RETRY_LIMIT,
  CAPTURE_RETRY_DELAY_MS,
  CAPTURE_RETRY_LIMIT,
} from '../../src/shared/constants.js';
import { createCaptureQueue, isQuotaError, isReadbackError } from '../../src/sw/capture.js';
import { PNG_DATA_URL, deferred, installFakeChrome } from '../helpers/fake-chrome.js';

const QUOTA_MESSAGE = 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.';
const READBACK_MESSAGE = 'Failed to capture tab: image readback failed';

/** A fake clock. `sleep` moves the clock forward, like real time would. */
function createClock() {
  let t = 10_000;
  /** @type {number[]} */
  const sleeps = [];
  return {
    now: () => t,
    /** @param {number} ms */
    sleep: async (ms) => {
      sleeps.push(ms);
      t += ms;
    },
    /** @param {number} ms */
    advance(ms) {
      t += ms;
    },
    sleeps,
  };
}

/** @param {unknown} e */
function assertCaptureFailed(e) {
  assert.ok(e instanceof SpoolError, 'expected a SpoolError');
  assert.equal(e.code, ERR.CAPTURE_FAILED);
  return true;
}

describe('isQuotaError', () => {
  it('matches the Chrome quota message in errors, strings and plain objects', () => {
    assert.equal(isQuotaError(new Error(QUOTA_MESSAGE)), true);
    assert.equal(isQuotaError(QUOTA_MESSAGE), true);
    assert.equal(isQuotaError({ message: QUOTA_MESSAGE }), true);
  });

  it('does not match other failures', () => {
    assert.equal(isQuotaError(new Error('Cannot access contents of the page.')), false);
    assert.equal(isQuotaError(new Error('')), false);
    assert.equal(isQuotaError(null), false);
    assert.equal(isQuotaError(undefined), false);
    assert.equal(isQuotaError(42), false);
    assert.equal(isQuotaError({}), false);
  });
});

describe('isReadbackError', () => {
  it('matches the Chrome readback message in errors, strings and plain objects', () => {
    assert.equal(isReadbackError(new Error(READBACK_MESSAGE)), true);
    assert.equal(isReadbackError(READBACK_MESSAGE), true);
    assert.equal(isReadbackError({ message: READBACK_MESSAGE }), true);
  });

  it('does not match other failures, including the other capture errors', () => {
    assert.equal(isReadbackError(new Error(QUOTA_MESSAGE)), false);
    assert.equal(isReadbackError(new Error('Failed to capture tab: view is invisible')), false);
    assert.equal(isReadbackError(new Error('Failed to capture tab: encoding failed')), false);
    assert.equal(isReadbackError(null), false);
    assert.equal(isReadbackError({}), false);
  });
});

describe('createCaptureQueue: basic behaviour', () => {
  it('runs the first call at once and passes the window id', async () => {
    const clock = createClock();
    /** @type {number[]} */
    const windows = [];
    const queue = createCaptureQueue({
      captureFn: async (windowId) => {
        windows.push(windowId);
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(await queue.capture(42), PNG_DATA_URL);
    assert.deepEqual(windows, [42]);
    assert.deepEqual(clock.sleeps, [], 'the first call must not wait');
  });

  it('uses the constants as defaults', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        calls += 1;
        throw new Error(QUOTA_MESSAGE);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(queue.capture(1), assertCaptureFailed);
    assert.equal(calls, 1 + CAPTURE_RETRY_LIMIT);
    assert.deepEqual(clock.sleeps, Array(CAPTURE_RETRY_LIMIT).fill(CAPTURE_RETRY_DELAY_MS));
    assert.ok(CAPTURE_RETRY_DELAY_MS >= CAPTURE_MIN_INTERVAL_MS - 100);
  });

  it('rejects invalid options', () => {
    assert.throws(() => createCaptureQueue({ minIntervalMs: -1 }), RangeError);
    assert.throws(() => createCaptureQueue({ minIntervalMs: NaN }), RangeError);
    assert.throws(() => createCaptureQueue({ retryLimit: 1.5 }), RangeError);
    assert.throws(() => createCaptureQueue({ retryLimit: -1 }), RangeError);
    assert.throws(() => createCaptureQueue({ retryDelayMs: Infinity }), RangeError);
    assert.throws(() => createCaptureQueue({ readbackRetryLimit: 0.5 }), RangeError);
    assert.throws(() => createCaptureQueue({ readbackRetryDelayMs: -1 }), RangeError);
  });
});

describe('createCaptureQueue: spacing', () => {
  it('starts consecutive calls at least minIntervalMs apart', async () => {
    const clock = createClock();
    /** @type {number[]} */
    const starts = [];
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      captureFn: async () => {
        starts.push(clock.now());
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await queue.capture(1);
    await queue.capture(1);
    await queue.capture(1);
    assert.equal(starts.length, 3);
    assert.equal(starts[1] - starts[0], 550);
    assert.equal(starts[2] - starts[1], 550);
    assert.deepEqual(clock.sleeps, [550, 550]);
  });

  it('waits only for the time that is still missing', async () => {
    const clock = createClock();
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      captureFn: async () => PNG_DATA_URL,
      now: clock.now,
      sleep: clock.sleep,
    });
    await queue.capture(1);
    clock.advance(300);
    await queue.capture(1);
    assert.deepEqual(clock.sleeps, [250]);
  });

  it('does not wait when the interval has passed', async () => {
    const clock = createClock();
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      captureFn: async () => PNG_DATA_URL,
      now: clock.now,
      sleep: clock.sleep,
    });
    await queue.capture(1);
    clock.advance(550);
    await queue.capture(1);
    clock.advance(10_000);
    await queue.capture(1);
    assert.deepEqual(clock.sleeps, []);
  });

  it('measures the interval from the start of the previous call, not from its end', async () => {
    const clock = createClock();
    /** @type {number[]} */
    const starts = [];
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      captureFn: async () => {
        starts.push(clock.now());
        clock.advance(200); // The capture itself takes 200 ms.
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await queue.capture(1);
    await queue.capture(1);
    assert.equal(starts[1] - starts[0], 550);
    assert.deepEqual(clock.sleeps, [350]);
  });

  it('respects the spacing for retries too, even when the retry delay is short', async () => {
    const clock = createClock();
    /** @type {number[]} */
    const starts = [];
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      retryDelayMs: 100,
      retryLimit: 2,
      captureFn: async () => {
        starts.push(clock.now());
        if (starts.length < 3) throw new Error(QUOTA_MESSAGE);
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(await queue.capture(1), PNG_DATA_URL);
    assert.equal(starts.length, 3);
    assert.ok(starts[1] - starts[0] >= 550);
    assert.ok(starts[2] - starts[1] >= 550);
  });
});

describe('createCaptureQueue: serialization', () => {
  it('runs one capture at a time and keeps the call order', async () => {
    const clock = createClock();
    const gates = [deferred(), deferred(), deferred()];
    /** @type {number[]} */
    const started = [];
    let running = 0;
    let maxRunning = 0;
    const queue = createCaptureQueue({
      minIntervalMs: 0,
      captureFn: async (windowId) => {
        started.push(windowId);
        running += 1;
        maxRunning = Math.max(maxRunning, running);
        await gates[started.length - 1]?.promise;
        running -= 1;
        return `data:image/png;base64,${windowId}`;
      },
      now: clock.now,
      sleep: clock.sleep,
    });

    const p1 = queue.capture(1);
    const p2 = queue.capture(2);
    const p3 = queue.capture(3);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [1], 'only the first call may run');

    gates[0]?.resolve();
    assert.equal(await p1, 'data:image/png;base64,1');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [1, 2]);

    gates[1]?.resolve();
    assert.equal(await p2, 'data:image/png;base64,2');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(started, [1, 2, 3]);

    gates[2]?.resolve();
    assert.equal(await p3, 'data:image/png;base64,3');
    assert.equal(maxRunning, 1);
  });

  it('spaces concurrent calls', async () => {
    const clock = createClock();
    /** @type {number[]} */
    const starts = [];
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      captureFn: async () => {
        starts.push(clock.now());
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await Promise.all([queue.capture(1), queue.capture(1), queue.capture(1), queue.capture(1)]);
    for (let i = 1; i < starts.length; i += 1) {
      assert.ok(starts[i] - starts[i - 1] >= 550, `gap before call ${i}`);
    }
  });

  it('keeps working after a failed call', async () => {
    const clock = createClock();
    let n = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        n += 1;
        if (n === 1) throw new Error('boom');
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    const first = queue.capture(1);
    const second = queue.capture(1);
    await assert.rejects(first, assertCaptureFailed);
    assert.equal(await second, PNG_DATA_URL);
  });

  it('does not leave unhandled rejections behind', async () => {
    /** @type {unknown[]} */
    const unhandled = [];
    /** @param {unknown} reason */
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const clock = createClock();
      const queue = createCaptureQueue({
        captureFn: async () => {
          throw new Error('boom');
        },
        now: clock.now,
        sleep: clock.sleep,
      });
      const results = await Promise.allSettled([queue.capture(1), queue.capture(1)]);
      assert.deepEqual(
        results.map((r) => r.status),
        ['rejected', 'rejected'],
      );
      await new Promise((resolve) => setImmediate(resolve));
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });
});

describe('createCaptureQueue: retries and errors', () => {
  it('retries a quota error and returns the later success', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      retryDelayMs: 600,
      captureFn: async () => {
        calls += 1;
        if (calls <= 2) throw new Error(QUOTA_MESSAGE);
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(await queue.capture(1), PNG_DATA_URL);
    assert.equal(calls, 3);
    assert.deepEqual(clock.sleeps, [600, 600]);
  });

  it('stops after retryLimit retries and fails with E_CAPTURE_FAILED', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      retryLimit: 2,
      captureFn: async () => {
        calls += 1;
        throw new Error(QUOTA_MESSAGE);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(queue.capture(1), assertCaptureFailed);
    assert.equal(calls, 3, '1 try + 2 retries');
  });

  it('does not retry when retryLimit is 0', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      retryLimit: 0,
      captureFn: async () => {
        calls += 1;
        throw new Error(QUOTA_MESSAGE);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(queue.capture(1), assertCaptureFailed);
    assert.equal(calls, 1);
  });

  it('does not retry other errors and hides the Chrome text', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        calls += 1;
        throw new Error('No tab with id 12 at https://secret.example/path');
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    /** @type {unknown} */
    let caught;
    await queue.capture(1).catch((e) => {
      caught = e;
    });
    assertCaptureFailed(caught);
    assert.equal(calls, 1);
    assert.ok(caught instanceof SpoolError);
    assert.doesNotMatch(caught.message, /secret|tab with id/i);
    assert.deepEqual(clock.sleeps, []);
  });

  it('handles failures that are not Error objects', async () => {
    const clock = createClock();
    for (const thrown of ['text', 42, null, undefined, { message: 'x' }]) {
      const queue = createCaptureQueue({
        captureFn: async () => {
          throw thrown;
        },
        now: clock.now,
        sleep: clock.sleep,
      });
      await assert.rejects(queue.capture(1), assertCaptureFailed);
    }
  });

  it('retries a quota error that is a plain string', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        calls += 1;
        if (calls === 1) throw QUOTA_MESSAGE;
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(await queue.capture(1), PNG_DATA_URL);
    assert.equal(calls, 2);
  });

  it('gives a clear message when the tab permission is gone', async () => {
    const clock = createClock();
    const queue = createCaptureQueue({
      captureFn: async () => {
        throw new Error("Either the '<all_urls>' or 'activeTab' permission is required.");
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    /** @type {unknown} */
    let caught;
    await queue.capture(1).catch((e) => {
      caught = e;
    });
    assertCaptureFailed(caught);
    assert.ok(caught instanceof SpoolError);
    assert.match(caught.message, /lost access/i);
  });

  it('passes a SpoolError from the capture function through unchanged', async () => {
    const clock = createClock();
    const original = new SpoolError(ERR.TAB_NOT_VISIBLE, 'Go back to this tab to continue.');
    const queue = createCaptureQueue({
      captureFn: async () => {
        throw original;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(queue.capture(1), (e) => e === original);
  });
});

describe('createCaptureQueue: readback retries', () => {
  it('retries "image readback failed" once and returns the later success', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        calls += 1;
        if (calls === 1) throw new Error(READBACK_MESSAGE);
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(await queue.capture(1), PNG_DATA_URL);
    assert.equal(calls, 2);
    assert.ok(clock.sleeps.includes(CAPTURE_READBACK_RETRY_DELAY_MS), 'waited before the retry');
  });

  it('stops after the limit and fails with the plain message, not Chrome text', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        calls += 1;
        throw new Error(READBACK_MESSAGE);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    /** @type {unknown} */
    let caught;
    await queue.capture(1).catch((e) => {
      caught = e;
    });
    assertCaptureFailed(caught);
    assert.equal(calls, 1 + CAPTURE_READBACK_RETRY_LIMIT);
    assert.ok(caught instanceof SpoolError);
    assert.equal(caught.message, 'Could not capture the tab. Try again.');
  });

  it('does not retry when readbackRetryLimit is 0', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      readbackRetryLimit: 0,
      captureFn: async () => {
        calls += 1;
        throw new Error(READBACK_MESSAGE);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(queue.capture(1), assertCaptureFailed);
    assert.equal(calls, 1);
  });

  it('does not retry the other Chrome capture failures', async () => {
    const texts = [
      'Failed to capture tab: view is invisible',
      'Failed to capture tab: encoding failed',
    ];
    for (const text of texts) {
      const clock = createClock();
      let calls = 0;
      const queue = createCaptureQueue({
        captureFn: async () => {
          calls += 1;
          throw new Error(text);
        },
        now: clock.now,
        sleep: clock.sleep,
      });
      await assert.rejects(queue.capture(1), assertCaptureFailed);
      assert.equal(calls, 1, text);
    }
  });

  it('keeps the call spacing for a readback retry, even when its delay is short', async () => {
    const clock = createClock();
    /** @type {number[]} */
    const starts = [];
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      readbackRetryDelayMs: 50,
      captureFn: async () => {
        starts.push(clock.now());
        if (starts.length < 3) throw new Error(READBACK_MESSAGE);
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(await queue.capture(1), PNG_DATA_URL);
    assert.equal(starts.length, 3);
    assert.ok((starts[1] ?? 0) - (starts[0] ?? 0) >= 550);
    assert.ok((starts[2] ?? 0) - (starts[1] ?? 0) >= 550);
  });

  it('counts quota retries and readback retries separately', async () => {
    const clock = createClock();
    const errors = [READBACK_MESSAGE, QUOTA_MESSAGE, READBACK_MESSAGE, QUOTA_MESSAGE, QUOTA_MESSAGE];
    let calls = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        const next = errors[calls];
        calls += 1;
        if (next !== undefined) throw new Error(next);
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    assert.equal(await queue.capture(1), PNG_DATA_URL);
    assert.equal(calls, 6, '2 readback retries and 3 quota retries, then the success');
  });

  it('the retry of one capture runs before the next capture starts', async () => {
    const clock = createClock();
    /** @type {string[]} */
    const log = [];
    let first = true;
    const queue = createCaptureQueue({
      captureFn: async (windowId) => {
        log.push(`call ${windowId}`);
        if (windowId === 1 && first) {
          first = false;
          throw new Error(READBACK_MESSAGE);
        }
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await Promise.all([queue.capture(1), queue.capture(2)]);
    assert.deepEqual(log, ['call 1', 'call 1', 'call 2']);
  });
});

describe('createCaptureQueue: beforeAttempt', () => {
  it('runs right before the first call and before every retry, after the slot wait', async () => {
    const clock = createClock();
    /** @type {string[]} */
    const log = [];
    let calls = 0;
    const queue = createCaptureQueue({
      minIntervalMs: 550,
      captureFn: async () => {
        calls += 1;
        log.push(`capture@${clock.now()}`);
        if (calls === 1) throw new Error(READBACK_MESSAGE);
        if (calls === 2) throw new Error(QUOTA_MESSAGE);
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await queue.capture(1); // The next call has to wait for its slot.
    log.length = 0;
    calls = 0;
    await queue.capture(1, {
      beforeAttempt: async () => {
        log.push(`check@${clock.now()}`);
      },
    });
    assert.equal(log.length, 6, 'a check and a call for each of the three attempts');
    for (let i = 0; i < log.length; i += 2) {
      assert.ok(String(log[i]).startsWith('check@'), String(log[i]));
      assert.ok(String(log[i + 1]).startsWith('capture@'), String(log[i + 1]));
      assert.equal(
        log[i]?.split('@')[1],
        log[i + 1]?.split('@')[1],
        'the check and the call are at the same time: nothing waits between them',
      );
    }
  });

  it('a refusal stops the capture with its own error and makes no more call', async () => {
    const clock = createClock();
    const refusal = new SpoolError(ERR.TAB_NOT_VISIBLE, 'Go back to this tab to continue.');
    let calls = 0;
    let checks = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        calls += 1;
        throw new Error(READBACK_MESSAGE);
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(
      queue.capture(1, {
        beforeAttempt: async () => {
          checks += 1;
          if (checks === 2) throw refusal; // The user left the tab while the retry waited.
        },
      }),
      (e) => e === refusal,
    );
    assert.equal(calls, 1, 'the retry was not made');
    assert.equal(checks, 2);
  });

  it('a refusal before the first call makes no call at all', async () => {
    const clock = createClock();
    let calls = 0;
    const queue = createCaptureQueue({
      captureFn: async () => {
        calls += 1;
        return PNG_DATA_URL;
      },
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(
      queue.capture(1, {
        beforeAttempt: async () => {
          throw new SpoolError(ERR.TAB_NOT_VISIBLE, 'Go back to this tab to continue.');
        },
      }),
      (e) => e instanceof SpoolError && e.code === ERR.TAB_NOT_VISIBLE,
    );
    assert.equal(calls, 0);
  });

  it('a check that fails with something else becomes the plain capture error', async () => {
    const clock = createClock();
    const queue = createCaptureQueue({
      captureFn: async () => PNG_DATA_URL,
      now: clock.now,
      sleep: clock.sleep,
    });
    /** @type {unknown} */
    let caught;
    await queue
      .capture(1, {
        beforeAttempt: async () => {
          throw new Error('tabs.query failed for https://secret.example/');
        },
      })
      .catch((e) => {
        caught = e;
      });
    assertCaptureFailed(caught);
    assert.ok(caught instanceof SpoolError);
    assert.doesNotMatch(caught.message, /secret/);
  });

  it('a refused capture does not block the next one', async () => {
    const clock = createClock();
    const queue = createCaptureQueue({
      captureFn: async () => PNG_DATA_URL,
      now: clock.now,
      sleep: clock.sleep,
    });
    await assert.rejects(
      queue.capture(1, {
        beforeAttempt: async () => {
          throw new SpoolError(ERR.TAB_NOT_VISIBLE, 'x');
        },
      }),
    );
    assert.equal(await queue.capture(1), PNG_DATA_URL);
  });
});

describe('default capture function (chrome.tabs.captureVisibleTab)', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it('captures the window as PNG', async () => {
    const clock = createClock();
    const queue = createCaptureQueue({ now: clock.now, sleep: clock.sleep });
    assert.equal(await queue.capture(5), PNG_DATA_URL);
    assert.deepEqual(fake.argsOf('tabs.captureVisibleTab'), [[5, { format: 'png' }]]);
  });

  it('retries the Chrome quota error', async () => {
    const clock = createClock();
    let calls = 0;
    fake.behavior.captureVisibleTab = async () => {
      calls += 1;
      if (calls === 1) throw new Error(QUOTA_MESSAGE);
      return PNG_DATA_URL;
    };
    const queue = createCaptureQueue({ now: clock.now, sleep: clock.sleep });
    assert.equal(await queue.capture(5), PNG_DATA_URL);
    assert.equal(calls, 2);
  });

  it('retries "image readback failed" (no frame yet on a page that has just loaded)', async () => {
    const clock = createClock();
    let calls = 0;
    fake.behavior.captureVisibleTab = async () => {
      calls += 1;
      if (calls === 1) throw new Error(READBACK_MESSAGE);
      return PNG_DATA_URL;
    };
    const queue = createCaptureQueue({ now: clock.now, sleep: clock.sleep });
    assert.equal(await queue.capture(5), PNG_DATA_URL);
    assert.equal(calls, 2);
  });

  it('fails when Chrome returns something that is not a PNG data URL', async () => {
    const clock = createClock();
    fake.behavior.captureVisibleTab = async () => 'data:image/jpeg;base64,AAAA';
    const queue = createCaptureQueue({ now: clock.now, sleep: clock.sleep });
    await assert.rejects(queue.capture(5), assertCaptureFailed);
  });
});
