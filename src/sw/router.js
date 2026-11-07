// @ts-check
/**
 * chrome.runtime.onMessage router for the service worker.
 *
 * Every message goes through routeCheck() first. A valid message runs its handler. The router
 * replies exactly once for every message that it accepts, whatever the handler does.
 */

import {
  ERR,
  TARGET,
  SpoolError,
  errorResponse,
  routeCheck,
  toErrorResponse,
} from '../shared/protocol.js';

/**
 * A handler gets a message that passed routeCheck() and returns reply data (or nothing).
 * It throws SpoolError for expected failures.
 * @typedef {(msg: any, sender: chrome.runtime.MessageSender) => unknown} Handler
 */

/**
 * @typedef {Object} RouterEnv
 * @property {string} runtimeId  chrome.runtime.id
 * @property {string} origin     chrome.runtime.getURL('')
 * @property {(e: unknown) => void} [onError]  Called for failures that are not SpoolError.
 */

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Wraps sendResponse so that it runs at most once and never throws.
 * @param {(response?: any) => void} sendResponse
 * @returns {(response: unknown) => void}
 */
function once(sendResponse) {
  let sent = false;
  return (response) => {
    if (sent) return;
    sent = true;
    try {
      sendResponse(response);
    } catch {
      // The sender is gone (for example the tab closed). There is nobody to tell.
    }
  };
}

/**
 * @typedef {(
 *   msg: unknown,
 *   sender: chrome.runtime.MessageSender,
 *   sendResponse: (response?: any) => void,
 * ) => boolean} MessageListener
 */

/**
 * @param {Readonly<Record<string, Handler>>} handlers  Keyed by message type.
 * @param {RouterEnv} env
 * @returns {MessageListener}
 */
export function createRouter(handlers, env) {
  return function onMessage(msg, sender, sendResponse) {
    const checked = routeCheck(msg, sender, TARGET.SW, env);
    if (checked === null) return false;
    const reply = once(sendResponse);
    if (!checked.ok) {
      reply(checked);
      return false;
    }
    const handler = Object.hasOwn(handlers, checked.type) ? handlers[checked.type] : undefined;
    if (!handler) {
      reply(errorResponse(ERR.BAD_MESSAGE, 'Unknown message.'));
      return false;
    }
    new Promise((resolve) => resolve(handler(msg, sender))).then(
      (data) => reply({ ...(isPlainObject(data) ? data : {}), ok: true }),
      (e) => {
        try {
          if (!(e instanceof SpoolError)) env.onError?.(e);
        } catch {
          // A failing logger must not stop the reply.
        }
        reply(toErrorResponse(e));
      },
    );
    return true;
  };
}
