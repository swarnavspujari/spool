// @ts-check
/**
 * Serialized, rate-limited wrapper around chrome.tabs.captureVisibleTab.
 *
 * Chrome allows 2 captureVisibleTab calls per second. The queue runs one capture at a time, starts
 * each call at least `minIntervalMs` after the start of the previous one, and retries only on two
 * transient errors: the per-second quota, and "image readback failed" (the tab has not presented
 * a frame yet, which a freshly loaded or freshly shown page can answer once). Each kind has its own
 * bounded count, and every retry waits for a rate slot. Every other failure becomes
 * E_CAPTURE_FAILED.
 *
 * The caller can pass `beforeAttempt`. The queue awaits it right before every call to Chrome,
 * the first one and each retry, after the wait for the slot. When it throws, the capture stops
 * with that error and no more call is made. The handler uses it to check, on every attempt, that
 * the user has not left the tab (see captureOwnTab in handlers.js).
 *
 * The queue keeps timing state in memory only. When the service worker restarts, the first call
 * has no delay; if Chrome still reports the quota error, the retry rule covers it.
 */

import {
  CAPTURE_MIN_INTERVAL_MS,
  CAPTURE_READBACK_RETRY_DELAY_MS,
  CAPTURE_READBACK_RETRY_LIMIT,
  CAPTURE_RETRY_DELAY_MS,
  CAPTURE_RETRY_LIMIT,
} from '../shared/constants.js';
import { ERR, SpoolError } from '../shared/protocol.js';

const QUOTA_ERROR_TEXT = 'MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND';
const READBACK_ERROR_TEXT = 'image readback failed';
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

const MSG_FAILED = 'Could not capture the tab. Try again.';
const MSG_QUOTA = 'The browser is limiting screenshots. Wait a moment and try again.';
const MSG_ACCESS = 'Spool lost access to this tab. Start a new capture.';

/**
 * @typedef {Object} CaptureQueueOptions
 * @property {number} [minIntervalMs]  Least time between the starts of two capture calls.
 * @property {number} [retryLimit]     Retries after a quota error (so attempts = 1 + retryLimit).
 * @property {number} [retryDelayMs]   Wait before a quota retry.
 * @property {number} [readbackRetryLimit]    Retries after "image readback failed".
 * @property {number} [readbackRetryDelayMs]  Wait before a readback retry.
 * @property {(windowId: number) => Promise<string>} [captureFn]  Returns a PNG data URL.
 * @property {() => number} [now]      Monotonic clock in ms.
 * @property {(ms: number) => Promise<void>} [sleep]
 */

/**
 * @typedef {Object} CaptureCallOptions
 * @property {() => Promise<void>} [beforeAttempt]  Awaited before every call to Chrome. A throw
 *   ends the capture with that error.
 */

/**
 * @typedef {Object} CaptureQueue
 * @property {(windowId: number, options?: CaptureCallOptions) => Promise<string>} capture
 *   Resolves with a PNG data URL.
 */

/**
 * Text of any thrown value, or '' when it has none.
 * @param {unknown} e
 * @returns {string}
 */
function messageOf(e) {
  if (typeof e === 'string') return e;
  if (typeof e === 'object' && e !== null && 'message' in e) return String(e.message);
  return '';
}

/**
 * True for the Chrome per-second quota error of captureVisibleTab.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isQuotaError(e) {
  return messageOf(e).includes(QUOTA_ERROR_TEXT);
}

/**
 * True for "Failed to capture tab: image readback failed": Chrome had no frame of the tab to read
 * yet. A second call a moment later succeeds.
 * @param {unknown} e
 * @returns {boolean}
 */
export function isReadbackError(e) {
  return messageOf(e).includes(READBACK_ERROR_TEXT);
}

/**
 * Maps any failure of a capture call to a SpoolError with a short, plain message.
 * Chrome's own text can contain page URLs, so it is never passed on.
 * @param {unknown} e
 * @returns {SpoolError}
 */
function toCaptureError(e) {
  if (e instanceof SpoolError) return e;
  if (isQuotaError(e)) return new SpoolError(ERR.CAPTURE_FAILED, MSG_QUOTA);
  if (/activeTab|<all_urls>|cannot access/i.test(messageOf(e))) {
    return new SpoolError(ERR.CAPTURE_FAILED, MSG_ACCESS);
  }
  return new SpoolError(ERR.CAPTURE_FAILED, MSG_FAILED);
}

/**
 * @param {unknown} v
 * @param {string} name
 * @param {boolean} integer
 * @returns {number}
 */
function nonNegative(v, name, integer) {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || (integer && !Number.isInteger(v))) {
    throw new RangeError(`${name} must be a non-negative ${integer ? 'integer' : 'number'}`);
  }
  return v;
}

/**
 * Default capture function: the visible tab of a window, as a PNG data URL.
 * @param {number} windowId
 * @returns {Promise<string>}
 */
export async function captureVisibleTab(windowId) {
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: 'png' });
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) {
    throw new SpoolError(ERR.CAPTURE_FAILED, MSG_FAILED);
  }
  return dataUrl;
}

/**
 * @param {CaptureQueueOptions} [options]
 * @returns {CaptureQueue}
 */
export function createCaptureQueue(options = {}) {
  const minIntervalMs = nonNegative(
    options.minIntervalMs ?? CAPTURE_MIN_INTERVAL_MS,
    'minIntervalMs',
    false,
  );
  const retryLimit = nonNegative(options.retryLimit ?? CAPTURE_RETRY_LIMIT, 'retryLimit', true);
  const retryDelayMs = nonNegative(
    options.retryDelayMs ?? CAPTURE_RETRY_DELAY_MS,
    'retryDelayMs',
    false,
  );
  const readbackRetryLimit = nonNegative(
    options.readbackRetryLimit ?? CAPTURE_READBACK_RETRY_LIMIT,
    'readbackRetryLimit',
    true,
  );
  const readbackRetryDelayMs = nonNegative(
    options.readbackRetryDelayMs ?? CAPTURE_READBACK_RETRY_DELAY_MS,
    'readbackRetryDelayMs',
    false,
  );
  const captureFn = options.captureFn ?? captureVisibleTab;
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  /** End of the chain of queued captures. It never rejects. */
  let tail = Promise.resolve();
  /** Start time of the latest capture call (including retries). */
  let lastStartMs = Number.NEGATIVE_INFINITY;

  async function waitForSlot() {
    const waitMs = lastStartMs + minIntervalMs - now();
    if (waitMs > 0) await sleep(waitMs);
  }

  /**
   * @param {number} windowId
   * @param {CaptureCallOptions} callOptions
   * @returns {Promise<string>}
   */
  async function run(windowId, callOptions) {
    let quotaRetries = 0;
    let readbackRetries = 0;
    for (;;) {
      await waitForSlot();
      try {
        // After the wait, so the check is as close to the call as it can be. A refusal is final.
        await callOptions.beforeAttempt?.();
      } catch (e) {
        throw toCaptureError(e);
      }
      lastStartMs = now();
      let delayMs;
      try {
        return await captureFn(windowId);
      } catch (e) {
        if (isQuotaError(e) && quotaRetries < retryLimit) {
          quotaRetries += 1;
          delayMs = retryDelayMs;
        } else if (isReadbackError(e) && readbackRetries < readbackRetryLimit) {
          readbackRetries += 1;
          delayMs = readbackRetryDelayMs;
        } else {
          throw toCaptureError(e);
        }
      }
      await sleep(delayMs);
    }
  }

  return {
    capture(windowId, callOptions = {}) {
      const result = tail.then(() => run(windowId, callOptions));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

/** The queue the service worker uses. */
export const captureQueue = createCaptureQueue();
