// @ts-check
/**
 * Message handlers of the service worker (docs/contracts.md sections 2 and 3).
 *
 * The service worker keeps no session state: the offscreen document owns it. A handler gets a
 * message that already passed routeCheck(). It reads tabId and windowId only from `sender.tab`.
 */

import { sourceHostOf } from '../lib/source-host.js';
import { PATHS, SEAM_STATUSES } from '../shared/constants.js';
import { ERR, MSG, SpoolError, isNonNegativeInt } from '../shared/protocol.js';
import {
  DEFAULT_SETTINGS,
  loadSettings as loadStoredSettings,
  normalizeSettings,
} from '../shared/settings.js';
import { captureQueue } from './capture.js';
import { setCapturing as defaultSetCapturing } from './capturing.js';
import { writeImageToClipboard } from './clipboard.js';
import { downloader, recallSaveDownload, rememberSaveDownload } from './downloads.js';
import { withFirstSaveQuestion } from './first-save.js';
import * as defaultOffscreen from './offscreen-client.js';
import { parsePngBase64, parseSummary, toShelfSummary } from './summary.js';
import { withLongCaptureTeaching } from './teach.js';

/** @typedef {import('../shared/types.js').PageIntake} PageIntake */
/** @typedef {import('../shared/types.js').FinishSummary} FinishSummary */
/** @typedef {import('../shared/types.js').Settings} Settings */
/**
 * @typedef {Pick<
 *   typeof import('./offscreen-client.js'),
 *   'ensureAndSend' | 'sendToOffscreen' | 'offscreenExists' | 'closeIfIdle'
 * >} OffscreenApi
 */
/**
 * @typedef {(
 *   windowId: number,
 *   options?: { beforeAttempt?: () => Promise<void> },
 * ) => Promise<string>} CaptureFn
 *   Captures the visible tab of a window. The function awaits `options.beforeAttempt` before every
 *   call to the browser (also before a retry), and stops with its error when it throws.
 */
/**
 * @typedef {Object} HandlerDeps
 * @property {CaptureFn} [capture]  Returns a PNG data URL.
 * @property {OffscreenApi} [offscreen]
 * @property {() => Promise<Settings>} [loadSettings]
 * @property {(pngBase64: string) => Promise<boolean>} [writeClipboard]  Default: the worker
 *   clipboard (`clipboardWrite`, feature-detected).
 * @property {(files: { path: string, url: string }[], onComplete?: (id: number) => void) => Promise<import('./downloads.js').DownloadOutcome>} [downloadFiles]
 *   Default: chrome.downloads. `onComplete` gets the ID of each file that is complete.
 * @property {(id: number) => Promise<void>} [rememberDownload]  Keeps the ID of the first file
 *   that the last save made in Downloads, for "Show in folder". Default: chrome.storage.session.
 *   Never rejects.
 * @property {() => Promise<number | undefined>} [recallDownload]  The ID that `rememberDownload`
 *   kept. Default: chrome.storage.session. Never rejects.
 * @property {(tabId: number, on: boolean) => Promise<void>} [setCapturing]  Shows or clears the
 *   "capturing" badge on the button of a tab. Default: chrome.action. Never rejects.
 * @property {(summary: FinishSummary) => Promise<FinishSummary>} [firstSave]
 *   Adds `save.askFolder` to the summary of a capture that asks "Save to Pictures › Screenshots?"
 *   (one of the first three). Default: the count in chrome.storage.local (src/sw/first-save.js).
 *   Never rejects.
 * @property {(summary: FinishSummary) => Promise<FinishSummary>} [teach]
 *   Adds `teach` to the summary of one of the first long captures: its toast stays until the user
 *   dismisses it. Default: the count in chrome.storage.local (src/sw/teach.js). Never rejects.
 * @property {(downloadId: number) => void} [showDownload]  Reveals a downloaded file in the file
 *   manager. Default: chrome.downloads.show.
 * @property {(query: Record<string, unknown>) => Promise<{ id: number }[]>} [searchDownloads]
 *   Default: chrome.downloads.search. "Show in folder" asks it for the remembered ID, to see that
 *   the file is complete and still on the disk.
 */

const MSG_NOT_VISIBLE = 'Go back to this tab to continue.';
const MSG_SESSION_ENDED = 'This capture has ended. Start a new capture.';
const MSG_FORBIDDEN = 'Sender not allowed.';
const MSG_RESULT_FAILED = 'Could not open the capture page. Try again.';
const MSG_OPTIONS_FAILED = 'Could not open Settings. Try again.';
const MSG_NO_FOLDER_TO_SHOW = 'Spool cannot show these files. Open your Downloads folder.';
const MSG_FILE_GONE = 'Spool cannot find the saved files. Open your Downloads folder.';
const MSG_NOTHING_YET = 'Nothing to insert yet. Press Alt+Shift+S to spool a page.';
const MSG_UNEXPECTED = 'Something went wrong. Try again.';

/**
 * Tab data of a content-script sender. Throws when the sender has no usable tab.
 * @param {chrome.runtime.MessageSender} sender
 * @returns {{ tab: chrome.tabs.Tab, tabId: number, windowId: number }}
 */
function senderTab(sender) {
  const tab = sender.tab;
  if (!tab || !isNonNegativeInt(tab.id) || !isNonNegativeInt(tab.windowId)) {
    throw new SpoolError(ERR.FORBIDDEN_SENDER, MSG_FORBIDDEN);
  }
  return { tab, tabId: tab.id, windowId: tab.windowId };
}

/**
 * Throws E_TAB_NOT_VISIBLE unless the tab is the active tab of its window.
 * @param {number} tabId
 * @param {number} windowId
 */
async function requireActiveTab(tabId, windowId) {
  const active = await chrome.tabs.query({ active: true, windowId });
  if (!active.some((t) => t.id === tabId)) {
    throw new SpoolError(ERR.TAB_NOT_VISIBLE, MSG_NOT_VISIBLE);
  }
}

/**
 * Captures the visible tab of a window for the page in `tabId`, and fails with E_TAB_NOT_VISIBLE
 * when the image can show another tab.
 *
 * `captureVisibleTab(windowId)` captures the tab that is visible at the moment of the call, not
 * the tab of the sender. The queue can wait for a rate slot (and for quota retries) between the
 * first check and the capture, and a tab that the user used before keeps its `activeTab` grant.
 * Two "is this tab active" checks are not enough: the user can leave the tab after the first
 * check and come back before the second one (Ctrl+Tab and back), and both checks pass while the
 * capture shows the other tab.
 *
 * So a temporary `tabs.onActivated` listener counts every tab switch in this window from before
 * the first check to after the second one. Any switch fails the call, and the caller does not
 * send the image on. The queue also runs both checks (the active tab and the switch count) right
 * before every attempt, so a retry after a transient failure never captures a tab that the user
 * has left. The listener lives only while this call runs: the worker is awake then, and
 * a listener at the top level would wake the worker at every tab switch of every window.
 *
 * Limit: events and replies of `tabs.query` travel over different channels, so an event can
 * arrive a little after a later reply. This cannot hide a wrong image: a tab that the capture
 * shows was activated before the capture started, so its event is older than the capture and
 * than the second query, and it arrives first.
 * @param {CaptureFn} capture  Returns a PNG data URL.
 * @param {number} tabId
 * @param {number} windowId
 * @returns {Promise<string>}
 */
async function captureOwnTab(capture, tabId, windowId) {
  let switches = 0;
  const onActivated = (/** @type {{ tabId: number, windowId: number }} */ info) => {
    if (info.windowId === windowId) switches += 1;
  };
  const requireNoSwitch = () => {
    if (switches > 0) throw new SpoolError(ERR.TAB_NOT_VISIBLE, MSG_NOT_VISIBLE);
  };
  chrome.tabs.onActivated.addListener(onActivated);
  try {
    await requireActiveTab(tabId, windowId);
    requireNoSwitch(); // Do not capture a tab that the user has already left.
    const dataUrl = await capture(windowId, {
      beforeAttempt: async () => {
        await requireActiveTab(tabId, windowId);
        requireNoSwitch();
      },
    });
    await requireActiveTab(tabId, windowId);
    requireNoSwitch();
    return dataUrl;
  } finally {
    chrome.tabs.onActivated.removeListener(onActivated);
  }
}

/**
 * The part of an IntakeResult that the page agent uses. The page is the least trusted context.
 * `seam.meanDiff`, `seam.shiftPx`, `storedBytes` and `widthPx` come from the pixels of the
 * capture, and nothing in the page needs them. Throws E_INTERNAL when a field the agent needs is
 * missing, so the page never sees a half answer.
 * @param {unknown} intake  The `intake` of the offscreen reply.
 * @returns {PageIntake}
 */
function toPageIntake(intake) {
  const i = /** @type {any} */ (intake);
  const status = i?.seam?.status;
  const numbers = [i?.index, i?.sliceCount, i?.totalHeightPx, i?.tileCount];
  if (
    !numbers.every((n) => typeof n === 'number' && Number.isFinite(n)) ||
    !SEAM_STATUSES.includes(status)
  ) {
    throw new SpoolError(ERR.INTERNAL, MSG_UNEXPECTED);
  }
  return {
    index: i.index,
    sliceCount: i.sliceCount,
    totalHeightPx: i.totalHeightPx,
    tileCount: i.tileCount,
    seam: { status },
  };
}

/**
 * @param {HandlerDeps} [deps]
 * @returns {Record<string, import('./router.js').Handler>}  Keyed by message type.
 */
export function createHandlers(deps = {}) {
  const capture = deps.capture ?? ((windowId, options) => captureQueue.capture(windowId, options));
  const offscreen = deps.offscreen ?? defaultOffscreen;
  const readSettings = deps.loadSettings ?? (() => loadStoredSettings());
  const writeClipboard = deps.writeClipboard ?? ((pngBase64) => writeImageToClipboard(pngBase64));
  const downloadFiles = deps.downloadFiles ?? ((files) => downloader.downloadFiles(files));
  const setCapturing = deps.setCapturing ?? defaultSetCapturing;
  const askFirstSave = deps.firstSave ?? ((summary) => withFirstSaveQuestion(summary));
  const markTeaching = deps.teach ?? ((summary) => withLongCaptureTeaching(summary));
  const showDownload = deps.showDownload ?? ((id) => chrome.downloads.show(id));
  const searchDownloads = deps.searchDownloads ?? ((query) => chrome.downloads.search(query));
  const rememberDownload = deps.rememberDownload ?? ((id) => rememberSaveDownload(id));
  const recallDownload = deps.recallDownload ?? (() => recallSaveDownload());

  /**
   * Shows or clears the badge. Never throws, and never holds the reply back.
   * @param {number} tabId
   * @param {boolean} on
   */
  function badge(tabId, on) {
    void Promise.resolve()
      .then(() => setCapturing(tabId, on))
      .catch(() => undefined);
  }

  /** The user's settings. Falls back to the defaults when storage fails. @returns {Promise<Settings>} */
  async function settingsOrDefaults() {
    try {
      return normalizeSettings(await readSettings());
    } catch {
      return { ...DEFAULT_SETTINGS };
    }
  }

  /** The tile tier of the user's settings. Falls back to the default when storage fails. */
  async function readTileTier() {
    return (await settingsOrDefaults()).tileTier;
  }

  /**
   * One output (a tile index or 'full') of the last capture of the sender's session and tab, as
   * base64. The offscreen document checks the session and the tab.
   * @param {string} sessionId
   * @param {number} tabId
   * @param {number | 'full'} item
   * @returns {Promise<string>}
   */
  async function readOutput(sessionId, tabId, item) {
    await requireOffscreen();
    const reply = await offscreen.sendToOffscreen(MSG.OFF_GET_OUTPUT, { sessionId, tabId, item });
    return parsePngBase64(reply);
  }

  /**
   * Opens an extension page in a new tab next to the tab of the sender.
   * @param {{ tab: chrome.tabs.Tab, tabId: number, windowId: number }} sender
   * @param {string} url
   * @param {string} failedMessage
   */
  async function openNextTo({ tab, tabId, windowId }, url, failedMessage) {
    try {
      await chrome.tabs.create({ url, windowId, index: tab.index + 1, openerTabId: tabId });
    } catch {
      throw new SpoolError(ERR.INTERNAL, failedMessage);
    }
  }

  /** Throws E_SESSION_NOT_FOUND when there is no offscreen document (so no session). */
  async function requireOffscreen() {
    if (!(await offscreen.offscreenExists())) {
      throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_SESSION_ENDED);
    }
  }

  /**
   * Removes a session from the offscreen document. `type` is OFF_SESSION_DROP (an unfinished
   * session of the sender tab: cancel). Does nothing when there is no document (it never creates
   * one) or no such session, so cancel can be repeated.
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @returns {Promise<number | undefined>}  Sessions left in the offscreen document, or
   *   undefined when this call did not learn it.
   */
  async function removeSession(type, fields) {
    if (!(await offscreen.offscreenExists())) return undefined;
    try {
      const reply = await offscreen.sendToOffscreen(type, fields);
      return typeof reply.remaining === 'number' ? reply.remaining : undefined;
    } catch (e) {
      if (e instanceof SpoolError && e.code === ERR.SESSION_NOT_FOUND) return undefined;
      throw e;
    }
  }

  return {
    [MSG.PAGE_SESSION_OPEN]: async (msg, sender) => {
      const { tab, tabId } = senderTab(sender);
      const tileTier = await readTileTier();
      await offscreen.ensureAndSend(MSG.OFF_SESSION_OPEN, {
        sessionId: msg.sessionId,
        tabId,
        title: msg.title,
        // From the sender (the browser's own value), never from a field of the page's message.
        host: sourceHostOf(sender.url ?? tab.url),
        tileTier,
      });
      badge(tabId, true); // The toolbar button shows a dot while the capture is open.
      return {};
    },

    [MSG.PAGE_CAPTURE_FRAME]: async (msg, sender) => {
      const { tabId, windowId } = senderTab(sender);
      await requireOffscreen();
      // Fails when the image can show another tab: then it is not sent on.
      const dataUrl = await captureOwnTab(capture, tabId, windowId);
      const reply = await offscreen.sendToOffscreen(MSG.OFF_ADD_FRAME, {
        sessionId: msg.sessionId,
        tabId,
        dataUrl,
        meta: msg.meta,
      });
      return { intake: toPageIntake(reply.intake) };
    },

    // Done: the offscreen document builds the tiles and the full image, saves the files and keeps
    // the outputs as the last capture (docs/contracts.md 7.9). No tab opens. The page gets a
    // checked copy of the summary.
    [MSG.PAGE_FINISH]: async (msg, sender) => {
      const { tabId } = senderTab(sender);
      await requireOffscreen();
      const settings = await settingsOrDefaults();
      const reply = await offscreen.sendToOffscreen(MSG.OFF_FINALIZE, {
        sessionId: msg.sessionId,
        tabId,
        saveTiles: settings.saveTiles,
        saveFull: settings.saveFull,
        folderName: settings.folderName,
      });
      badge(tabId, false);
      // A capture that goes to Downloads with no folder chosen asks, up to three times.
      // One of the first long captures keeps its toast on screen (it teaches the keys).
      const summary = await askFirstSave(parseSummary(reply.summary));
      return { summary: await markTeaching(summary) };
    },

    // The clipboard always gets the full image. The page agent calls this inside the promise that
    // it gave to navigator.clipboard.write.
    [MSG.PAGE_GET_CLIPBOARD]: async (msg, sender) => {
      const { tabId } = senderTab(sender);
      return { pngBase64: await readOutput(msg.sessionId, tabId, 'full') };
    },

    // The page could not write the clipboard. The worker tries, with the clipboardWrite
    // permission. An image that is too large for one message, or no full image: not copied.
    [MSG.PAGE_CLIPBOARD_FALLBACK]: async (msg, sender) => {
      const { tabId } = senderTab(sender);
      let pngBase64;
      try {
        pngBase64 = await readOutput(msg.sessionId, tabId, 'full');
      } catch (e) {
        if (e instanceof SpoolError && (e.code === ERR.SESSION_TOO_LARGE || e.code === ERR.INTERNAL)) {
          return { copied: false };
        }
        throw e;
      }
      return { copied: await writeClipboard(pngBase64) };
    },

    [MSG.PAGE_GET_TILE]: async (msg, sender) => {
      const { tabId } = senderTab(sender);
      return { pngBase64: await readOutput(msg.sessionId, tabId, msg.index) };
    },

    // Opens the result page for the last capture of this session and tab.
    [MSG.PAGE_OPEN_RESULT]: async (msg, sender) => {
      const target = senderTab(sender);
      await requireOffscreen();
      await offscreen.sendToOffscreen(MSG.OFF_OUTPUT_INFO, {
        sessionId: msg.sessionId,
        tabId: target.tabId,
      });
      await openNextTo(
        target,
        `${chrome.runtime.getURL(PATHS.result)}#${msg.sessionId}`,
        MSG_RESULT_FAILED,
      );
      return {};
    },

    // "Show in folder" of the toast, for a save in Downloads only: the browser can reveal a file
    // that it downloaded. A folder that the user picked has no such call. The last capture must be
    // this session and tab, and its files must be in Downloads. The file is the one that the save
    // made (its ID was kept at the download), never one found by the name of a folder: another
    // folder can have the same name.
    [MSG.PAGE_SHOW_IN_FOLDER]: async (msg, sender) => {
      const { tabId } = senderTab(sender);
      await requireOffscreen();
      const reply = await offscreen.sendToOffscreen(MSG.OFF_OUTPUT_INFO, {
        sessionId: msg.sessionId,
        tabId,
      });
      const { save } = parseSummary(reply.summary);
      if (save.location !== 'downloads') throw new SpoolError(ERR.INTERNAL, MSG_NO_FOLDER_TO_SHOW);
      const id = await recallDownload();
      if (id === undefined) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_FILE_GONE);
      // The file must still be complete and on the disk: the person may have deleted it.
      const found = await searchDownloads({ id, state: 'complete', exists: true, limit: 1 });
      if (found[0]?.id !== id) throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_FILE_GONE);
      showDownload(id);
      return {};
    },

    [MSG.PAGE_OPEN_OPTIONS]: async (msg, sender) => {
      const target = senderTab(sender);
      await openNextTo(
        target,
        `${chrome.runtime.getURL(PATHS.options)}#${msg.section}`,
        MSG_OPTIONS_FAILED,
      );
      return {};
    },

    // The shelf asks for the capture that its token is bound to. Without an offscreen document
    // there is none. The shelf runs in any tab, so it gets only what it shows (`toShelfSummary`):
    // the summary is checked in full, and then cut down.
    [MSG.PAGE_SHELF_INFO]: async (msg, sender) => {
      const { tabId } = senderTab(sender);
      if (!(await offscreen.offscreenExists())) return { summary: null };
      const reply = await offscreen.sendToOffscreen(MSG.OFF_SHELF_INFO, {
        token: msg.token,
        tabId,
      });
      return {
        summary: reply.summary === null ? null : toShelfSummary(parseSummary(reply.summary)),
      };
    },

    [MSG.PAGE_SHELF_GET]: async (msg, sender) => {
      const { tabId } = senderTab(sender);
      if (!(await offscreen.offscreenExists())) {
        throw new SpoolError(ERR.SESSION_NOT_FOUND, MSG_NOTHING_YET);
      }
      const reply = await offscreen.sendToOffscreen(MSG.OFF_SHELF_GET, {
        token: msg.token,
        tabId,
        item: msg.item,
      });
      return { pngBase64: parsePngBase64(reply) };
    },

    // The agent sends cancel on a best-effort basis (also on pagehide), so an unknown session
    // or a missing offscreen document is not an error. The offscreen document drops only an
    // unfinished session of the sender tab: a page cannot remove the session of another tab, or
    // a finished session that waits for its result page. The agent may have been the last user
    // of the document: close it when no session is left.
    [MSG.PAGE_CANCEL]: async (msg, sender) => {
      const { tabId } = senderTab(sender);
      badge(tabId, false);
      const remaining = await removeSession(MSG.OFF_SESSION_DROP, {
        sessionId: msg.sessionId,
        tabId,
      });
      if (remaining === 0) await offscreen.closeIfIdle().catch(() => false);
      return {};
    },

    [MSG.SW_OFFSCREEN_IDLE]: async () => {
      await offscreen.closeIfIdle();
      return {};
    },

    // The offscreen document asks for downloads: it made blob URLs (the worker cannot) and chose
    // the names. A URL of another origin is refused, so this cannot be a way to download an
    // address that a page picked.
    [MSG.SW_DOWNLOAD]: async (msg) => {
      const prefix = `blob:${chrome.runtime.getURL('')}`;
      for (const file of msg.files) {
        if (!file.url.startsWith(prefix)) throw new SpoolError(ERR.BAD_MESSAGE, 'Bad field: files');
      }
      // The first complete file of the save: the full image when there is one, else the first
      // tile. "Show in folder" reveals it.
      /** @type {number | undefined} */
      let first;
      const outcome = await downloadFiles(msg.files, (id) => {
        first ??= id;
      });
      if (first !== undefined) await rememberDownload(first);
      return { ...outcome };
    },
  };
}

/**
 * Drops the unfinished sessions of a tab (the tab closed).
 * Does nothing when no offscreen document exists: it never creates one. Never rejects.
 * @param {number} tabId
 * @param {OffscreenApi} [offscreen]
 * @returns {Promise<void>}
 */
export async function dropTabSessions(tabId, offscreen = defaultOffscreen) {
  if (!isNonNegativeInt(tabId)) return;
  try {
    if (!(await offscreen.offscreenExists())) return;
    await offscreen.sendToOffscreen(MSG.OFF_DROP_TAB, { tabId });
  } catch {
    // Best effort: a finished or missing session is cleaned up by its TTL.
  }
}
