// @ts-check
/**
 * Message handlers of the offscreen document (docs/contracts.md sections 3 and 7). A handler gets a
 * message that already passed routeCheck(), so its fields are valid. It returns the reply data and
 * throws SpoolError for expected failures. The wiring (listeners, replies) is in offscreen.js.
 *
 * Who may ask what is decided in the protocol (`from` of each type) and here:
 * - A request of the worker for a session carries the `tabId` that the worker read from
 *   `sender.tab`. The last capture answers only when its session and its tab are the ones asked.
 * - A shelf request carries a token and the tab of the sender: the token must belong to that tab,
 *   and it serves only the capture that was the last one when it was granted.
 * - The result page reads the last capture by its session ID.
 */

import { MAX_TRANSFER_BYTES } from '../shared/constants.js';
import { ERR, MSG, SpoolError } from '../shared/protocol.js';
import { blobToBase64Text } from '../render/util.js';
import { pickOutput } from './last-capture.js';

const MSG_NOTHING_YET = 'Nothing to insert yet. Press Alt+Shift+S to spool a page.';
const MSG_NEWER_CAPTURE = 'A newer capture exists. Press Alt+Shift+V again.';
const MSG_CAPTURE_ENDED = 'This capture has ended. Press Alt+Shift+V again.';

/**
 * @typedef {Object} OffscreenHandlerDeps
 * @property {ReturnType<typeof import('./session-store.js').createSessionStore>} store
 * @property {ReturnType<typeof import('./last-capture.js').createLastCapture>} last
 * @property {ReturnType<typeof import('./shelf-tokens.js').createShelfTokens>} tokens
 * @property {ReturnType<typeof import('./finalize.js').createFinalizer>} finalizer
 * @property {number} [maxTransferBytes]  Default: MAX_TRANSFER_BYTES.
 * @property {(blob: Blob) => Promise<string>} [blobToBase64]  Default: base64 without a prefix.
 */

/**
 * @param {OffscreenHandlerDeps} deps
 * @returns {(type: string, m: Record<string, any>) => Promise<Record<string, unknown>>}
 */
export function createOffscreenHandler(deps) {
  const { store, last, tokens, finalizer } = deps;
  const maxTransferBytes = deps.maxTransferBytes ?? MAX_TRANSFER_BYTES;
  const toBase64 = deps.blobToBase64 ?? blobToBase64Text;

  /**
   * @param {import('./last-capture.js').LastCaptureEntry} entry
   * @param {number | 'full'} item
   * @returns {Promise<{ pngBase64: string }>}
   */
  async function outputOf(entry, item) {
    return { pngBase64: await toBase64(pickOutput(entry, item, maxTransferBytes)) };
  }

  /**
   * The capture that a shelf token may read: the one that was the last capture when the token was
   * granted, and only while it still is. Throws E_SESSION_NOT_FOUND when the token is unknown or
   * expired, when a newer capture replaced the bound one, or when the bound one ended. A token
   * that was granted with no capture serves nothing: null while there is still none.
   * @param {string} token
   * @param {number} tabId
   * @returns {import('./last-capture.js').LastCaptureEntry | null}
   */
  function shelfCapture(token, tabId) {
    const bound = tokens.check(token, tabId);
    const entry = last.latest();
    if (bound === null) {
      if (entry === null) return null;
      throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_NEWER_CAPTURE);
    }
    if (entry === null) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_CAPTURE_ENDED);
    if (entry.sessionId !== bound) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_NEWER_CAPTURE);
    return entry;
  }

  return async function handle(type, m) {
    switch (type) {
      case MSG.OFF_SESSION_OPEN:
        store.open(m.sessionId, m.tabId, m.title, m.tileTier, m.host);
        return {};
      case MSG.OFF_ADD_FRAME:
        return { intake: await store.addFrame(m.sessionId, m.tabId, m.dataUrl, m.meta) };
      case MSG.OFF_SESSION_DROP:
        return store.drop(m.sessionId, m.tabId);
      case MSG.OFF_DROP_TAB:
        // The tab closed: its shelf is gone, and so is an unfinished capture.
        tokens.revokeTab(m.tabId);
        return store.dropTab(m.tabId);
      case MSG.OFF_PING:
        return { ...store.ping(), lastCapture: last.has() };

      case MSG.OFF_FINALIZE:
        return {
          summary: await finalizer.finalize({
            sessionId: m.sessionId,
            tabId: m.tabId,
            saveTiles: m.saveTiles,
            saveFull: m.saveFull,
            folderName: m.folderName,
          }),
        };
      case MSG.OFF_OUTPUT_INFO:
        return { summary: last.require(m.sessionId, m.tabId).summary };
      case MSG.OFF_GET_OUTPUT:
        return outputOf(last.require(m.sessionId, m.tabId), m.item);

      case MSG.OFF_SHELF_GRANT:
        // The token is bound to the capture that is the last one now (docs/contracts.md 7.8).
        tokens.grant(m.token, m.tabId, last.latest()?.sessionId ?? null);
        return { hasCapture: last.has() };
      case MSG.OFF_SHELF_INFO: {
        const entry = shelfCapture(m.token, m.tabId);
        return { summary: entry === null ? null : entry.summary };
      }
      case MSG.OFF_SHELF_GET: {
        const entry = shelfCapture(m.token, m.tabId);
        if (entry === null) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_NOTHING_YET);
        return outputOf(entry, m.item);
      }

      case MSG.OFF_LAST_INFO:
        return { summary: last.require(m.sessionId).summary };
      case MSG.OFF_LAST_GET:
        return outputOf(last.require(m.sessionId), m.item);

      default:
        throw new SpoolError(ERR.BAD_MESSAGE, 'Unknown message.');
    }
  };
}
