// @ts-check
/**
 * Message protocol between extension contexts. See docs/contracts.md.
 *
 * Every message is a plain JSON object: { v, target, type, ...fields }.
 * Every reply is { ok: true, ...data } or { ok: false, error: { code, message } }.
 * Receivers call routeCheck() first. It rejects unknown types, wrong senders, bad fields and
 * extra fields.
 */

import {
  MAX_DOWNLOAD_FILES,
  MAX_DOWNLOAD_PATH_LENGTH,
  MAX_DOWNLOAD_PATH_SEGMENTS,
  MAX_SOURCE_HOST_LENGTH,
  OPTIONS_SECTIONS,
  PATHS,
} from './constants.js';
import { sanitizePathSegment } from '../lib/names.js';

/** @typedef {import('./types.js').ErrorInfo} ErrorInfo */
/** @typedef {import('./types.js').ErrorResponse} ErrorResponse */
/** @typedef {'content'|'worker'|'offscreen'|'result'|'options'|'unknown'} SenderKind */

export const PROTOCOL_VERSION = 1;

export const TARGET = Object.freeze({ SW: 'sw', OFFSCREEN: 'offscreen' });

export const MSG = Object.freeze({
  // page agent (content script) -> service worker
  PAGE_SESSION_OPEN: 'page/session-open',
  PAGE_CAPTURE_FRAME: 'page/capture-frame',
  PAGE_FINISH: 'page/finish',
  PAGE_CANCEL: 'page/cancel',
  // page agent, toast and shelf (content script) -> service worker (docs/contracts.md 7.4)
  PAGE_GET_CLIPBOARD: 'page/get-clipboard',
  PAGE_CLIPBOARD_FALLBACK: 'page/clipboard-fallback',
  PAGE_GET_TILE: 'page/get-tile',
  PAGE_OPEN_RESULT: 'page/open-result',
  PAGE_OPEN_OPTIONS: 'page/open-options',
  PAGE_SHOW_IN_FOLDER: 'page/show-in-folder',
  PAGE_SHELF_INFO: 'page/shelf-info',
  PAGE_SHELF_GET: 'page/shelf-get',
  // offscreen document -> service worker
  SW_OFFSCREEN_IDLE: 'sw/offscreen-idle',
  SW_DOWNLOAD: 'sw/download',
  // service worker -> offscreen document
  OFF_SESSION_OPEN: 'offscreen/session-open',
  OFF_ADD_FRAME: 'offscreen/add-frame',
  OFF_SESSION_DROP: 'offscreen/session-drop',
  OFF_DROP_TAB: 'offscreen/drop-tab',
  OFF_PING: 'offscreen/ping',
  OFF_FINALIZE: 'offscreen/finalize',
  OFF_OUTPUT_INFO: 'offscreen/output-info',
  OFF_GET_OUTPUT: 'offscreen/get-output',
  OFF_SHELF_GRANT: 'offscreen/shelf-grant',
  OFF_SHELF_INFO: 'offscreen/shelf-info',
  OFF_SHELF_GET: 'offscreen/shelf-get',
  // result page -> offscreen document
  OFF_LAST_INFO: 'offscreen/last-info',
  OFF_LAST_GET: 'offscreen/last-get',
});

export const ERR = Object.freeze({
  BAD_MESSAGE: 'E_BAD_MESSAGE',
  FORBIDDEN_SENDER: 'E_FORBIDDEN_SENDER',
  TAB_NOT_VISIBLE: 'E_TAB_NOT_VISIBLE',
  CAPTURE_FAILED: 'E_CAPTURE_FAILED',
  SESSION_NOT_FOUND: 'E_SESSION_NOT_FOUND',
  SESSION_TOO_LARGE: 'E_SESSION_TOO_LARGE',
  INTERNAL: 'E_INTERNAL',
});

/** Error with a protocol error code. Throw it; receivers convert it with toErrorResponse(). */
export class SpoolError extends Error {
  /** @param {string} code One of ERR. @param {string} message Short, plain English. */
  constructor(code, message) {
    super(message);
    this.name = 'SpoolError';
    this.code = code;
  }
}

/** @param {string} code @param {string} message @returns {ErrorResponse} */
export function errorResponse(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Converts any thrown value to an ErrorResponse. Unknown errors become E_INTERNAL with a
 * generic message, so internal details do not leak into page context.
 * @param {unknown} e
 * @returns {ErrorResponse}
 */
export function toErrorResponse(e) {
  if (e instanceof SpoolError) return errorResponse(e.code, e.message);
  return errorResponse(ERR.INTERNAL, 'Something went wrong. Try again.');
}

// ---------------------------------------------------------------------------------------------
// Field validators
// ---------------------------------------------------------------------------------------------

const SESSION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SOURCE_HOST_RE = /^(?:[a-z0-9._-]*|\[[0-9a-f:.]+\])$/;
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';
const MAX_DATA_URL_LENGTH = 60 * 1024 * 1024;
const MAX_VIEWPORT = 100_000;
/**
 * Largest `contentY` (CSS px). Blink lays out in fixed-point `LayoutUnit`s (1/64 px in 32 bits),
 * so a page can be about 33.5 million px tall, and a hostile page can scroll near that end.
 * Real pages stay far below 10 million px (that is 10,000 screens). With this bound, every
 * position stays a small, safe integer in device px (at most 16 x 10,000,000).
 */
const MAX_CONTENT_Y = 10_000_000;

/** @param {unknown} v @returns {v is Record<string, unknown>} */
function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
/** @param {unknown} v @returns {v is number} */
function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}
/** @param {unknown} v @returns {v is number} */
export function isNonNegativeInt(v) {
  return Number.isSafeInteger(v) && /** @type {number} */ (v) >= 0;
}
/** @param {unknown} v @returns {v is string} */
export function isSessionId(v) {
  return typeof v === 'string' && SESSION_ID_RE.test(v);
}
/** @param {unknown} v @returns {v is string} */
function isShortString(v) {
  return typeof v === 'string' && v.length <= 512;
}
/** @param {unknown} v @returns {v is import('./types.js').TileTier} */
function isTileTier(v) {
  return v === 'high' || v === 'standard';
}
/** @param {unknown} v @returns {v is string} */
function isPngDataUrl(v) {
  return (
    typeof v === 'string' && v.length <= MAX_DATA_URL_LENGTH && v.startsWith(PNG_DATA_URL_PREFIX)
  );
}

/**
 * A shelf token: a random UUID v4, like a session ID. The service worker makes it with
 * crypto.randomUUID() and the offscreen document binds it to one tab.
 * @param {unknown} v
 * @returns {v is string}
 */
export function isToken(v) {
  return isSessionId(v);
}
/**
 * One output of a finished capture: a tile (its 0-based index) or the full image.
 * @param {unknown} v
 * @returns {v is number | 'full'}
 */
export function isOutputItem(v) {
  return v === 'full' || isNonNegativeInt(v);
}
/**
 * The host name that a capture remembers as its source: what `URL.hostname` gives (lower case
 * letters, digits, dots, hyphens and underscores; an IPv6 address in brackets; punycode for a name
 * with other characters), or an empty string for a page that has no host.
 * The worker reads it from the sender. No path, no query, no port, nothing else of the page.
 * @param {unknown} v
 * @returns {v is string}
 */
export function isSourceHost(v) {
  return typeof v === 'string' && v.length <= MAX_SOURCE_HOST_LENGTH && SOURCE_HOST_RE.test(v);
}
/** @param {unknown} v @returns {v is boolean} */
function isBoolean(v) {
  return typeof v === 'boolean';
}
/** @param {unknown} v @returns {v is string} */
function isOptionsSection(v) {
  return typeof v === 'string' && OPTIONS_SECTIONS.includes(v);
}
/**
 * The root folder of the downloads (`Settings.folderName`): one clean path segment, 1 to 40
 * characters. Settings are normalized before they are used, so a valid value is unchanged.
 * @param {unknown} v
 * @returns {v is string}
 */
function isFolderName(v) {
  return typeof v === 'string' && v !== '' && sanitizePathSegment(v, 40, '') === v;
}
/**
 * A relative path for chrome.downloads: 1 to MAX_DOWNLOAD_PATH_SEGMENTS clean segments with `/`
 * between them. A segment is clean when sanitizePathSegment() does not change it, so it has no
 * `..`, no drive letter, no control character, no reserved name. No leading or trailing `/`.
 * @param {unknown} v
 * @returns {v is string}
 */
export function isDownloadPath(v) {
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_DOWNLOAD_PATH_LENGTH) return false;
  const segments = v.split('/');
  return (
    segments.length <= MAX_DOWNLOAD_PATH_SEGMENTS &&
    segments.every((s) => s !== '' && sanitizePathSegment(s, 120, '') === s)
  );
}
const BLOB_URL_RE =
  /^blob:chrome-extension:\/\/[a-z0-9]{1,64}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/**
 * A blob URL of an extension page (`blob:chrome-extension://<id>/<uuid>`). The service worker also
 * checks that the ID is its own.
 * @param {unknown} v
 * @returns {v is string}
 */
export function isExtensionBlobUrl(v) {
  return typeof v === 'string' && v.length <= 200 && BLOB_URL_RE.test(v);
}
/**
 * The file list of `sw/download`: 1 to MAX_DOWNLOAD_FILES entries `{ path, url }`.
 * @param {unknown} v
 * @returns {v is { path: string, url: string }[]}
 */
function isDownloadList(v) {
  return (
    Array.isArray(v) &&
    v.length >= 1 &&
    v.length <= MAX_DOWNLOAD_FILES &&
    v.every(
      (f) =>
        isPlainObject(f) &&
        hasExactKeys(f, ['path', 'url']) &&
        isDownloadPath(f.path) &&
        isExtensionBlobUrl(f.url),
    )
  );
}

/**
 * @param {unknown} v
 * @returns {v is import('./types.js').Size}
 */
function isSize(v) {
  return (
    isPlainObject(v) &&
    hasExactKeys(v, ['width', 'height']) &&
    isFiniteNumber(v.width) &&
    isFiniteNumber(v.height) &&
    v.width > 0 &&
    v.height > 0 &&
    v.width <= MAX_VIEWPORT &&
    v.height <= MAX_VIEWPORT
  );
}

/**
 * @param {unknown} v
 * @returns {v is import('./types.js').Rect}
 */
function isRect(v) {
  return (
    isPlainObject(v) &&
    hasExactKeys(v, ['x', 'y', 'width', 'height']) &&
    isFiniteNumber(v.x) &&
    isFiniteNumber(v.y) &&
    isFiniteNumber(v.width) &&
    isFiniteNumber(v.height) &&
    v.width >= 1 &&
    v.height >= 1
  );
}

/**
 * True when v is a valid FrameMeta and its rect lies inside its viewport (1 px tolerance).
 * `contentY` is at least -1 and at most MAX_CONTENT_Y.
 * @param {unknown} v
 * @returns {v is import('./types.js').FrameMeta}
 */
export function isFrameMeta(v) {
  if (!isPlainObject(v)) return false;
  if (!hasExactKeys(v, ['direction', 'viewport', 'rect', 'contentY'])) return false;
  if (v.direction !== 'initial' && v.direction !== 'down' && v.direction !== 'up') return false;
  if (!isSize(v.viewport) || !isRect(v.rect)) return false;
  const { rect, viewport } = v;
  if (rect.x < -1 || rect.y < -1) return false;
  if (rect.x + rect.width > viewport.width + 1) return false;
  if (rect.y + rect.height > viewport.height + 1) return false;
  if (!isFiniteNumber(v.contentY) || v.contentY < -1 || v.contentY > MAX_CONTENT_Y) return false;
  return true;
}

/**
 * @param {Record<string, unknown>} obj
 * @param {readonly string[]} keys
 */
function hasExactKeys(obj, keys) {
  const own = Object.keys(obj);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(obj, k));
}

// ---------------------------------------------------------------------------------------------
// Message specs
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} MessageSpec
 * @property {string} target
 * @property {readonly SenderKind[]} from
 * @property {Readonly<Record<string, (v: unknown) => boolean>>} fields
 */

/** @type {Readonly<Record<string, MessageSpec>>} */
const SPEC = Object.freeze({
  [MSG.PAGE_SESSION_OPEN]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { sessionId: isSessionId, title: isShortString },
  },
  [MSG.PAGE_CAPTURE_FRAME]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { sessionId: isSessionId, meta: isFrameMeta },
  },
  [MSG.PAGE_FINISH]: { target: TARGET.SW, from: ['content'], fields: { sessionId: isSessionId } },
  [MSG.PAGE_CANCEL]: { target: TARGET.SW, from: ['content'], fields: { sessionId: isSessionId } },
  [MSG.PAGE_GET_CLIPBOARD]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { sessionId: isSessionId },
  },
  [MSG.PAGE_CLIPBOARD_FALLBACK]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { sessionId: isSessionId },
  },
  [MSG.PAGE_GET_TILE]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { sessionId: isSessionId, index: isNonNegativeInt },
  },
  [MSG.PAGE_OPEN_RESULT]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { sessionId: isSessionId },
  },
  [MSG.PAGE_OPEN_OPTIONS]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { section: isOptionsSection },
  },
  [MSG.PAGE_SHOW_IN_FOLDER]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { sessionId: isSessionId },
  },
  [MSG.PAGE_SHELF_INFO]: { target: TARGET.SW, from: ['content'], fields: { token: isToken } },
  [MSG.PAGE_SHELF_GET]: {
    target: TARGET.SW,
    from: ['content'],
    fields: { token: isToken, item: isOutputItem },
  },
  [MSG.SW_OFFSCREEN_IDLE]: { target: TARGET.SW, from: ['offscreen'], fields: {} },
  [MSG.SW_DOWNLOAD]: { target: TARGET.SW, from: ['offscreen'], fields: { files: isDownloadList } },
  [MSG.OFF_SESSION_OPEN]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: {
      sessionId: isSessionId,
      tabId: isNonNegativeInt,
      title: isShortString,
      host: isSourceHost,
      tileTier: isTileTier,
    },
  },
  [MSG.OFF_ADD_FRAME]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: { sessionId: isSessionId, tabId: isNonNegativeInt, dataUrl: isPngDataUrl, meta: isFrameMeta },
  },
  // Drops an UNFINISHED session of that tab (cancel). The tab comes from the sender tab.
  [MSG.OFF_SESSION_DROP]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: { sessionId: isSessionId, tabId: isNonNegativeInt },
  },
  [MSG.OFF_DROP_TAB]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: { tabId: isNonNegativeInt },
  },
  [MSG.OFF_PING]: { target: TARGET.OFFSCREEN, from: ['worker'], fields: {} },
  [MSG.OFF_FINALIZE]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: {
      sessionId: isSessionId,
      tabId: isNonNegativeInt,
      saveTiles: isBoolean,
      saveFull: isBoolean,
      folderName: isFolderName,
    },
  },
  [MSG.OFF_OUTPUT_INFO]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: { sessionId: isSessionId, tabId: isNonNegativeInt },
  },
  [MSG.OFF_GET_OUTPUT]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: { sessionId: isSessionId, tabId: isNonNegativeInt, item: isOutputItem },
  },
  [MSG.OFF_SHELF_GRANT]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: { token: isToken, tabId: isNonNegativeInt },
  },
  [MSG.OFF_SHELF_INFO]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: { token: isToken, tabId: isNonNegativeInt },
  },
  [MSG.OFF_SHELF_GET]: {
    target: TARGET.OFFSCREEN,
    from: ['worker'],
    fields: { token: isToken, tabId: isNonNegativeInt, item: isOutputItem },
  },
  [MSG.OFF_LAST_INFO]: {
    target: TARGET.OFFSCREEN,
    from: ['result'],
    fields: { sessionId: isSessionId },
  },
  [MSG.OFF_LAST_GET]: {
    target: TARGET.OFFSCREEN,
    from: ['result'],
    fields: { sessionId: isSessionId, item: isOutputItem },
  },
});

const ENVELOPE_KEYS = Object.freeze(['v', 'target', 'type']);

/**
 * Builds a message for `type` with the correct envelope.
 * @param {string} type One of MSG.
 * @param {Record<string, unknown>} [fields]
 * @returns {Record<string, unknown>}
 */
export function makeMessage(type, fields = {}) {
  const spec = Object.hasOwn(SPEC, type) ? SPEC[type] : undefined;
  if (!spec) throw new SpoolError(ERR.BAD_MESSAGE, `Unknown message type: ${type}`);
  // The envelope is written last, so a field can never replace it.
  return { ...fields, v: PROTOCOL_VERSION, target: spec.target, type };
}

/**
 * Classifies the sender of a runtime message.
 *
 * Extension pages and the worker are known by their exact script or page URL. A sender without a
 * URL is never trusted: Chrome gives the worker's messages the URL of its script
 * (`PATHS.serviceWorker`), so the worker needs no fallback.
 * @param {chrome.runtime.MessageSender | undefined} sender
 * @param {string} runtimeId  chrome.runtime.id
 * @param {string} origin     chrome.runtime.getURL('') (ends with '/')
 * @returns {SenderKind}
 */
export function classifySender(sender, runtimeId, origin) {
  if (!sender || sender.id !== runtimeId) return 'unknown';
  const url = typeof sender.url === 'string' ? sender.url : '';
  if (url === '') return 'unknown';
  if (url.startsWith(origin)) {
    const path = url.slice(origin.length).split(/[?#]/, 1)[0];
    if (path === PATHS.result) return 'result';
    if (path === PATHS.options) return 'options';
    if (path === PATHS.offscreen) return 'offscreen';
    if (path === PATHS.serviceWorker && !sender.tab) return 'worker';
    return 'unknown';
  }
  if (sender.tab && isNonNegativeInt(sender.tab.id) && sender.frameId === 0) return 'content';
  return 'unknown';
}

/**
 * Checks an incoming message for a receiver.
 * Returns null when the message is not addressed to `target` (the listener must ignore it and
 * return false). Otherwise returns { ok: true, type, kind } or an ErrorResponse.
 *
 * @param {unknown} msg
 * @param {chrome.runtime.MessageSender | undefined} sender
 * @param {string} target  One of TARGET.
 * @param {{ runtimeId: string, origin: string }} env
 * @returns {null | { ok: true, type: string, kind: SenderKind } | ErrorResponse}
 */
export function routeCheck(msg, sender, target, env) {
  if (!isPlainObject(msg) || msg.target !== target) return null;
  if (msg.v !== PROTOCOL_VERSION || typeof msg.type !== 'string') {
    return errorResponse(ERR.BAD_MESSAGE, 'Unsupported message.');
  }
  const spec = Object.hasOwn(SPEC, msg.type) ? SPEC[msg.type] : undefined;
  if (!spec || spec.target !== target) return errorResponse(ERR.BAD_MESSAGE, 'Unknown message.');
  const kind = classifySender(sender, env.runtimeId, env.origin);
  if (!spec.from.includes(kind)) return errorResponse(ERR.FORBIDDEN_SENDER, 'Sender not allowed.');
  const fieldNames = Object.keys(spec.fields);
  for (const key of Object.keys(msg)) {
    if (!ENVELOPE_KEYS.includes(key) && !fieldNames.includes(key)) {
      return errorResponse(ERR.BAD_MESSAGE, `Unexpected field: ${key}`);
    }
  }
  for (const name of fieldNames) {
    const check = spec.fields[name];
    if (!check || !check(msg[name])) return errorResponse(ERR.BAD_MESSAGE, `Bad field: ${name}`);
  }
  return { ok: true, type: msg.type, kind };
}
