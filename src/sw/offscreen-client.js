// @ts-check
/**
 * Service worker side of the offscreen document: create it, talk to it, close it when idle.
 *
 * Chrome allows one offscreen document per extension. Create and close calls and the idle check
 * run one at a time (a mutex), so two callers never create two documents, and a document is never
 * closed between the moment a caller made it exist and the moment that caller used it.
 *
 * The mutex lives in memory. If the service worker restarts, getContexts() is the source of
 * truth: it shows whether a document exists.
 */

import { PATHS } from '../shared/constants.js';
import { ERR, MSG, SpoolError, makeMessage } from '../shared/protocol.js';

const JUSTIFICATION =
  'Holds screenshot slices in memory during a capture, and the last finished capture afterwards.';
const KNOWN_ERROR_CODES = new Set(Object.values(ERR));

const MSG_UNAVAILABLE = 'Spool is not ready. Try again.';
const MSG_CREATE_FAILED = 'Spool could not start. Try again.';
const MSG_UNEXPECTED = 'Something went wrong. Try again.';

/** End of the chain of locked jobs. It never rejects. */
let tail = Promise.resolve();

/**
 * Runs `job` after all earlier locked jobs finished.
 * @template T
 * @param {() => Promise<T>} job
 * @returns {Promise<T>}
 */
function withLock(job) {
  const result = tail.then(job);
  tail = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

/** @returns {Promise<boolean>} */
async function hasDocument() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: [/** @type {chrome.runtime.ContextType} */ ('OFFSCREEN_DOCUMENT')],
  });
  return contexts.length > 0;
}

/** Creates the document when none exists. Call only while holding the lock. */
async function createIfMissing() {
  if (await hasDocument()) return;
  try {
    await chrome.offscreen.createDocument({
      url: PATHS.offscreen,
      reasons: [/** @type {chrome.offscreen.Reason} */ ('BLOBS')],
      justification: JUSTIFICATION,
    });
  } catch {
    // Accept the error when a document exists now (for example a previous worker created it).
    if (!(await hasDocument().catch(() => false))) {
      throw new SpoolError(ERR.INTERNAL, MSG_CREATE_FAILED);
    }
  }
}

/**
 * Sends a message to the offscreen document and returns the reply data.
 * Does not take the lock and does not create the document.
 * @param {string} type  One of MSG, with target 'offscreen'.
 * @param {Record<string, unknown>} fields
 * @returns {Promise<Record<string, any>>}
 */
async function send(type, fields) {
  const message = makeMessage(type, fields);
  /** @type {any} */
  let reply;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch {
    throw new SpoolError(ERR.INTERNAL, MSG_UNAVAILABLE);
  }
  if (typeof reply !== 'object' || reply === null) {
    throw new SpoolError(ERR.INTERNAL, MSG_UNAVAILABLE);
  }
  if (reply.ok === true) return reply;
  const error = reply.ok === false ? reply.error : undefined;
  const knownCode = typeof error?.code === 'string' && KNOWN_ERROR_CODES.has(error.code);
  const hasText = typeof error?.message === 'string' && error.message !== '';
  throw new SpoolError(
    knownCode ? error.code : ERR.INTERNAL,
    hasText ? error.message : MSG_UNEXPECTED,
  );
}

/** True when the offscreen document exists. Never creates it. */
export async function offscreenExists() {
  return hasDocument();
}

/**
 * Makes sure the offscreen document exists. Safe to call many times at once.
 * @returns {Promise<void>}
 */
export function ensureOffscreen() {
  return withLock(createIfMissing);
}

/**
 * Sends a message to the offscreen document. Throws SpoolError when the document does not
 * answer or answers with { ok: false }.
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 * @returns {Promise<Record<string, any>>}  The reply: { ok: true, ...data }.
 */
export function sendToOffscreen(type, fields = {}) {
  return send(type, fields);
}

/**
 * Creates the document when needed and sends the message, as one step under the lock.
 * Use it for messages that start a session: closeIfIdle() cannot close the document in between.
 * @param {string} type
 * @param {Record<string, unknown>} [fields]
 * @returns {Promise<Record<string, any>>}
 */
export function ensureAndSend(type, fields = {}) {
  return withLock(async () => {
    await createIfMissing();
    return send(type, fields);
  });
}

/**
 * Closes the offscreen document when it holds no session and no last capture (docs/contracts.md
 * 7.6). Pings and closes under the lock. Best effort: any failure means "do not close" and the
 * result is false.
 * @returns {Promise<boolean>}  True when this call closed the document.
 */
export function closeIfIdle() {
  return withLock(async () => {
    try {
      if (!(await hasDocument())) return false;
      const reply = await send(MSG.OFF_PING, {});
      if (reply.sessions !== 0 || reply.lastCapture === true) return false;
      await chrome.offscreen.closeDocument();
      return true;
    } catch {
      return false;
    }
  });
}
