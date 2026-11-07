// @ts-check
/**
 * Offscreen document: owns the capture sessions and the last finished capture. Wiring only. The
 * logic is in session-store.js (sessions), finalize.js (outputs), save.js (files), last-capture.js,
 * shelf-tokens.js and handlers.js. The browser image code is in image-ops.js and render-ops.js.
 *
 * Every message goes through routeCheck() first. Every message gets exactly one reply:
 * { ok: true, ...data } or { ok: false, error }.
 */

import * as folderStore from '../ui/folder-store.js';
import {
  MSG,
  TARGET,
  SpoolError,
  makeMessage,
  routeCheck,
  toErrorResponse,
} from '../shared/protocol.js';
import { createFinalizer } from './finalize.js';
import { createOffscreenHandler } from './handlers.js';
import { createImageOps } from './image-ops.js';
import { createLastCapture } from './last-capture.js';
import { createRenderOps } from './render-ops.js';
import { createSaver } from './save.js';
import { createSessionStore } from './session-store.js';
import { createShelfTokens } from './shelf-tokens.js';

/**
 * Tells the service worker that this document holds nothing (no session and no last capture), so
 * it can close the document.
 */
function notifyIdle() {
  try {
    chrome.runtime.sendMessage(makeMessage(MSG.SW_OFFSCREEN_IDLE)).catch(() => {
      // The service worker is not listening. It closes this document by its own checks.
    });
  } catch {
    // The extension context is gone. Nothing to tell.
  }
}

/** Called when a session or the last capture ends. */
function notifyIfIdle() {
  if (store.ping().sessions === 0 && !last.has()) notifyIdle();
}

/**
 * Asks the service worker to download files (chrome.downloads is not available in this document).
 * @param {{ path: string, url: string }[]} files
 * @returns {Promise<import('./save.js').DownloadResult>}
 */
async function requestDownloads(files) {
  const reply = await chrome.runtime.sendMessage(makeMessage(MSG.SW_DOWNLOAD, { files }));
  const ok = typeof reply === 'object' && reply !== null && reply.ok === true;
  if (!ok) throw new Error('The download request failed.');
  const count = (/** @type {unknown} */ n) => (Number.isSafeInteger(n) && /** @type {number} */ (n) >= 0 ? /** @type {number} */ (n) : 0);
  return {
    saved: count(reply.saved),
    rejected: count(reply.rejected),
    interrupted: count(reply.interrupted),
  };
}

/** The outputs of the last finished capture (docs/contracts.md 7.6). */
const last = createLastCapture({ onChange: notifyIfIdle });
const tokens = createShelfTokens();
const store = createSessionStore({
  imageOps: createImageOps(),
  onEmpty: notifyIfIdle,
  // The outputs of the last capture count in the total limit, and they go first when a frame
  // needs the room.
  heldBytes: () => last.bytes(),
  releaseHeld: () => last.clear(),
});
const saver = createSaver({
  folderStore,
  requestDownloads,
  makeUrl: (blob) => URL.createObjectURL(blob),
  revokeUrl: (url) => URL.revokeObjectURL(url),
});
const finalizer = createFinalizer({
  store,
  last,
  renderOps: createRenderOps(),
  saver,
  log: (message, error) => console.error(message, error),
});

/**
 * Runs one validated message.
 * @type {(type: string, m: Record<string, any>) => Promise<Record<string, unknown>>}
 */
const handle = createOffscreenHandler({ store, last, tokens, finalizer });

/**
 * Logs failures that the user message hides: unexpected errors and image errors with a cause.
 * The log has no image data and no page data.
 * @param {unknown} e
 */
function logFailure(e) {
  if (!(e instanceof SpoolError)) console.error('Spool offscreen:', e);
  else if (e.cause !== undefined) console.error('Spool offscreen:', e.message, e.cause);
}

/**
 * @param {(response?: any) => void} sendResponse
 * @param {unknown} payload
 */
function reply(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch {
    // The sender is gone (for example a closed result tab). There is nobody to answer.
  }
}

const ENV = Object.freeze({
  runtimeId: chrome.runtime.id,
  origin: chrome.runtime.getURL(''),
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const route = routeCheck(message, sender, TARGET.OFFSCREEN, ENV);
  if (route === null) return false;
  if (!route.ok) {
    reply(sendResponse, route);
    return false;
  }
  handle(route.type, message).then(
    (data) => reply(sendResponse, { ok: true, ...data }),
    (e) => {
      logFailure(e);
      reply(sendResponse, toErrorResponse(e));
    },
  );
  return true;
});
