// @ts-check
/**
 * Small helpers shared by the end-to-end support code.
 */

/**
 * @param {number} ms
 * @returns {Promise<void>}
 */
export function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Thrown by a probe to stop pollUntil() at once (the condition can never become true). */
export class PollAbort extends Error {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = 'PollAbort';
  }
}

/**
 * Calls `probe` every `intervalMs` until it returns a truthy value, and returns that value.
 * Throws an Error with `message` and the last probe value (or error) when `timeoutMs` pass.
 * A probe that throws PollAbort ends the wait at once and the PollAbort is rethrown.
 * Use this instead of a fixed sleep wherever a condition can be observed.
 *
 * @template T
 * @param {() => Promise<T> | T} probe
 * @param {{ timeoutMs?: number, intervalMs?: number, message: string | (() => string) }} options
 * @returns {Promise<NonNullable<T>>}
 */
export async function pollUntil(probe, { timeoutMs = 10_000, intervalMs = 50, message }) {
  const deadline = Date.now() + timeoutMs;
  /** @type {unknown} */
  let last;
  for (;;) {
    try {
      last = await probe();
      if (last) return /** @type {NonNullable<T>} */ (last);
    } catch (e) {
      if (e instanceof PollAbort) throw e;
      last = e;
    }
    if (Date.now() >= deadline) break;
    await delay(intervalMs);
  }
  const text = typeof message === 'function' ? message() : message;
  const lastText = last instanceof Error ? `${last.name}: ${last.message}` : JSON.stringify(last);
  throw new Error(`Timed out after ${timeoutMs} ms: ${text} (last value: ${lastText})`);
}

/**
 * Decodes a base64 string to bytes.
 * @param {string} base64
 * @returns {Uint8Array}
 */
export function base64ToBytes(base64) {
  return new Uint8Array(Buffer.from(base64, 'base64'));
}
