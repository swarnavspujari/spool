// @ts-check
/**
 * Shelf tokens (docs/contracts.md 7.8). The service worker holds no state, so the offscreen
 * document keeps the tokens. A token is made by the worker for one `insert-capture` command, and
 * it lets the shelf of ONE tab read ONE capture (the last one at that time):
 *
 * - it belongs to one tab, and a request from another tab fails with E_FORBIDDEN_SENDER;
 * - it is bound to the capture that was the last one when it was granted (`sessionId`, or null
 *   when there was none). `check` returns that ID and the caller serves only that capture, so a
 *   shelf that stays open never reads a newer capture than the one it shows;
 * - it ends after `ttlMs`, when the tab closes (`revokeTab`), and when a new
 *   token is granted for the same tab;
 * - at most `max` tokens live at once. The oldest one goes first.
 *
 * Time goes through `now`, so tests run in Node. A token is never written anywhere.
 */

import { MAX_SHELF_TOKENS, SHELF_TOKEN_TTL_MS } from '../shared/constants.js';
import { ERR, SpoolError } from '../shared/protocol.js';

const MSG_EXPIRED = 'This capture has expired here. Press Alt+Shift+V again.';
const MSG_FORBIDDEN = 'Sender not allowed.';

/**
 * @param {{ now?: () => number, ttlMs?: number, max?: number }} [options]
 */
export function createShelfTokens(options = {}) {
  const { now = () => Date.now(), ttlMs = SHELF_TOKEN_TTL_MS, max = MAX_SHELF_TOKENS } = options;

  /**
   * Insertion order is age: oldest first.
   * @type {Map<string, { tabId: number, sessionId: string | null, expiresAt: number }>}
   */
  const tokens = new Map();

  function purgeExpired() {
    const t = now();
    for (const [token, info] of tokens) if (info.expiresAt <= t) tokens.delete(token);
  }

  return Object.freeze({
    /**
     * Registers a token for a tab and binds it to a capture. Ends the older tokens of that tab.
     * @param {string} token
     * @param {number} tabId
     * @param {string | null} [sessionId]  The session of the last capture now, or null for none.
     */
    grant(token, tabId, sessionId = null) {
      purgeExpired();
      for (const [other, info] of tokens) if (info.tabId === tabId) tokens.delete(other);
      tokens.delete(token);
      tokens.set(token, { tabId, sessionId, expiresAt: now() + ttlMs });
      while (tokens.size > max) {
        const oldest = tokens.keys().next();
        if (oldest.done) break;
        tokens.delete(oldest.value);
      }
    },

    /**
     * Throws unless the token is alive and belongs to this tab.
     * @param {string} token
     * @param {number} tabId
     * @returns {string | null}  The session that the token is bound to (null: no capture then).
     */
    check(token, tabId) {
      purgeExpired();
      const info = tokens.get(token);
      if (info === undefined) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_EXPIRED);
      if (info.tabId !== tabId) throw new SpoolError(ERR.FORBIDDEN_SENDER, MSG_FORBIDDEN);
      return info.sessionId;
    },

    /**
     * Ends every token of a tab (the tab closed).
     * @param {number} tabId
     */
    revokeTab(tabId) {
      for (const [token, info] of tokens) if (info.tabId === tabId) tokens.delete(token);
    },

    /** @returns {number} Tokens that are alive now. */
    get size() {
      purgeExpired();
      return tokens.size;
    },
  });
}
