// @ts-check
/**
 * Result page. It shows a finished capture and lets the user copy or save it. See
 * docs/contracts.md sections 6 and 7.
 *
 * The offscreen document has already built the images when the user pressed Done. This page asks
 * for them by session ID (the URL hash): `offscreen/last-info` gives the summary, and
 * `offscreen/last-get` gives one PNG (a tile, or the full image) as base64. Nothing is assembled
 * here. The tiles load one by one (each shows when it is ready). The full image loads only when
 * the user copies or saves it: the "For people" column shows the tiles, without their overlap.
 */

import {
  COMMANDS,
  MAX_CLIPBOARD_BITMAP_BYTES,
  MAX_TRANSFER_BYTES,
  PATHS,
  TILE_TIERS,
} from '../shared/constants.js';
import { ERR, MSG, SpoolError, isSessionId, makeMessage } from '../shared/protocol.js';
import { DEFAULT_SETTINGS, loadSettings } from '../shared/settings.js';
import { exceedsClipboardLimit } from '../lib/clipboard-limit.js';
import { defaultShortcut, platformKind, shortcutParts } from '../lib/keys.js';
import { captureBaseName } from '../lib/names.js';
import { fitsOneImage, planTiles } from '../lib/tiles.js';
import {
  base64ToBlob,
  formatBytes,
  formatDimensions,
  plural,
  saveAllHint,
  saveInfoLine,
  savedLine,
  savePlan,
  stackLayout,
  startDownload,
  summaryLine,
  tileLabelParts,
} from './save-plan.js';

/** @typedef {import('../shared/types.js').FinishSummary} FinishSummary */
/** @typedef {import('../shared/types.js').SessionManifest} SessionManifest */
/** @typedef {import('../shared/types.js').Settings} Settings */
/** @typedef {import('../shared/types.js').TilePlan} TilePlan */
/** @typedef {import('./save-plan.js').SaveItem} SaveItem */

/**
 * What a click on a save button saves.
 * @typedef {Object} SaveRequest
 * @property {boolean} includeTiles
 * @property {boolean} includeFull
 * @property {number} [tileIndex]  Only this tile (the Save button of a tile).
 */

/**
 * @typedef {Object} TileEntry
 * @property {TilePlan} plan
 * @property {{ outWidth: number, skipHeight: number, visibleHeight: number }} stack
 *   Place in the "For people" column. `skipHeight` rows at the top of the picture are cut off.
 * @property {HTMLElement} frame        Preview box in the "For AI" grid.
 * @property {HTMLElement} stackItem   Box in the "For people" column.
 * @property {HTMLButtonElement} copyButton
 * @property {HTMLButtonElement} saveButton
 * @property {Blob | null} blob   Set when the tile is loaded.
 * @property {string | null} url  Object URL of `blob`, used for the previews.
 */

/**
 * @template T
 * @typedef {Object} Deferred
 * @property {Promise<T>} promise
 * @property {(value: T) => void} resolve
 * @property {(reason: unknown) => void} reject
 */

const TEXT = Object.freeze({
  notInMemory: 'This capture is no longer in memory. Start a new capture.',
  badCapture: 'Something is wrong with this capture. Start a new capture.',
  buildFailed: 'Could not load the images. Start a new capture.',
  fullFailed: 'The full image could not be built. You can still use the AI screenshots.',
  fullTooLarge: 'The full image is too large to copy or save here. Use the AI screenshots.',
  tooTallToCopy: 'Too tall to copy as one image. Save it, or copy the AI screenshots.',
  nothingToSave: 'Nothing to save. Turn on AI screenshots or the full image in Settings.',
  saveFailed: 'Could not save the files.',
  downloadCanceled: 'The download was canceled.',
  downloadFailed: 'The download failed.',
  titleDropped: 'The browser refused the page title, so the file names leave it out.',
  loadingFull: 'Loading the full image…',
});

/** How long a button shows "Copied" before it shows its normal label again. */
const FLASH_MS = 1500;

/** The system of the browser: the keys are written for it ("⌃⇧V" on a Mac). */
const PLATFORM = platformKind(
  /** @type {any} */ (globalThis.navigator)?.userAgentData?.platform ??
    globalThis.navigator?.platform,
);

// ---------------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------------

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Element #${id} is missing.`);
  return node;
}

/**
 * Creates an element. Text goes in with textContent, never as markup.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {string} [className]
 * @param {string} [text]
 * @returns {HTMLElementTagNameMap[K]}
 */
function h(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * A button with an icon and a label. The icon is a mask (see src/ui/base.css).
 * @param {string} text
 * @param {'copy' | 'download'} iconName
 * @param {string} [className]
 * @returns {HTMLButtonElement}
 */
function makeButton(text, iconName, className = '') {
  const button = h('button', `sp-btn ${className}`.trim());
  button.type = 'button';
  const icon = h('span', `sp-icon sp-icon-${iconName}`);
  icon.setAttribute('aria-hidden', 'true');
  button.append(icon, h('span', 'sp-btn-label', text));
  return button;
}

const ui = {
  openSettings: byId('open-settings', HTMLButtonElement),
  pageTitle: byId('page-title', HTMLHeadingElement),
  summary: byId('summary', HTMLParagraphElement),
  tabAi: byId('tab-ai', HTMLButtonElement),
  tabAiCount: byId('tab-ai-count', HTMLElement),
  tabPeople: byId('tab-people', HTMLButtonElement),
  tabPeopleCount: byId('tab-people-count', HTMLElement),
  panelAi: byId('panel-ai', HTMLElement),
  panelPeople: byId('panel-people', HTMLElement),
  loading: byId('loading', HTMLElement),
  loadText: byId('load-text', HTMLParagraphElement),
  loadProgress: byId('load-progress', HTMLProgressElement),
  error: byId('error', HTMLElement),
  errorText: byId('error-text', HTMLParagraphElement),
  content: byId('content', HTMLElement),
  saveAll: byId('save-all', HTMLButtonElement),
  saveFull: byId('save-full', HTMLButtonElement),
  copyFull: byId('copy-full', HTMLButtonElement),
  saveHint: byId('save-hint', HTMLElement),
  insertHint: byId('insert-hint', HTMLElement),
  fullInfo: byId('full-info', HTMLParagraphElement),
  peopleStack: byId('people-stack', HTMLElement),
  statusbar: byId('statusbar', HTMLElement),
  status: byId('status', HTMLParagraphElement),
  showFolder: byId('show-folder', HTMLButtonElement),
  allowAccess: byId('allow-access', HTMLButtonElement),
  warnings: byId('warnings', HTMLElement),
  warningList: byId('warning-list', HTMLUListElement),
  buildText: byId('build-text', HTMLParagraphElement),
  buildProgress: byId('build-progress', HTMLProgressElement),
  tileGrid: byId('tile-grid', HTMLOListElement),
};

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** @type {Settings} */
let settings = DEFAULT_SETTINGS;

const state = {
  sessionId: '',
  /** @type {FinishSummary | null} */
  summary: null,
  /** Folder in Downloads (the setting). */
  root: '',
  /** Base name of this capture's files: `Spool <date> <title>`. */
  base: '',
  /** The same without the page title, for the one retry when Chrome refuses `base`. */
  fallbackBase: '',
  /** True when Chrome refused `base` and the files went out with `fallbackBase`. */
  titleDropped: false,
  /** @type {TileEntry[]} */
  tiles: [],
  /** One tile that is the full image 1:1: the files are one flat file, not two. */
  oneImage: false,
  tilesReady: false,
  /** Text for the full image when it cannot be copied or saved here. Empty when it can. */
  fullBlocked: '',
  /** @type {Promise<Blob> | null} */
  fullPromise: null,
  /** @type {Blob | null} */
  fullBlob: null,
  saving: false,
  /** @type {number | null} Id of the last finished download, for "Show in folder". */
  lastDownloadId: null,
};

/** @template T @returns {Deferred<T>} */
function deferred() {
  /** @type {(value: T) => void} */
  let resolve = () => {};
  /** @type {(reason: unknown) => void} */
  let reject = () => {};
  /** @type {Promise<T>} */
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nobody may read the promise (for example when the test hook is not used). Do not report it.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** @type {Deferred<void>} */
const tilesDone = deferred();

// ---------------------------------------------------------------------------------------------
// Test hook (see docs/contracts.md section 6)
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {Object} DebugApi
 * @property {FinishSummary | null} summary
 * @property {SessionManifest | null} manifest  The summary in the shape of a manifest. It has no
 *   slices (the offscreen document has freed them), and `scale` is 0 (it is not known here).
 * @property {TilePlan[]} tilePlan
 * @property {(index: number) => Promise<string>} getTileBase64
 * @property {() => Promise<string>} getFullBase64
 */

/**
 * What the end-to-end tests read: the summary, the tile plan and the finished images (as base64).
 * This page publishes it nowhere. The test build (e2e/build-extension.mjs) adds a module script
 * to its own copy of result.html that imports this object and sets `globalThis.spoolDebug`.
 * The production extension has no such global, so no script can ask this page for image data.
 * @type {DebugApi}
 */
export const debugApi = {
  summary: null,
  manifest: null,
  tilePlan: [],
  async getTileBase64(index) {
    await tilesDone.promise;
    const blob = state.tiles[index]?.blob;
    if (!blob) throw new RangeError(`There is no tile ${index}.`);
    return blobToBase64(blob);
  },
  async getFullBase64() {
    return blobToBase64(await getFullBlob());
  },
};

/**
 * Converts a Blob to base64 (without a data-URL prefix). Used by the test hook only.
 * @param {Blob} blob
 * @returns {Promise<string>}
 */
function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const text = String(reader.result);
      resolve(text.slice(text.indexOf(',') + 1));
    };
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

/** @param {'loading' | 'ready' | 'error'} value */
function setPageState(value) {
  document.body.dataset['state'] = value;
}

// ---------------------------------------------------------------------------------------------
// Status and progress
// ---------------------------------------------------------------------------------------------

/**
 * Shows a message in the live status line at the bottom of the page.
 * @param {string} text
 * @param {'info' | 'ok' | 'error'} [tone]
 */
function setStatus(text, tone = 'info') {
  ui.status.textContent = text;
  ui.status.dataset['tone'] = tone;
}

/**
 * @param {string} text
 * @param {number} fraction  0 to 1.
 */
function setLoad(text, fraction) {
  ui.loadText.textContent = text;
  ui.loadProgress.value = fraction;
}

/**
 * Text and progress bar for loading the tiles. An empty text hides the whole row.
 * @param {string} text
 * @param {number | null} fraction  0 to 1, or null to hide the bar.
 */
function setBuild(text, fraction) {
  ui.buildText.textContent = text;
  ui.buildText.parentElement?.toggleAttribute('hidden', text === '');
  ui.buildProgress.hidden = fraction === null;
  if (fraction !== null) ui.buildProgress.value = fraction;
}

/** @param {string} message */
function showFatal(message) {
  setPageState('error');
  ui.loading.hidden = true;
  ui.errorText.textContent = message;
  ui.error.hidden = false;
}

function showContent() {
  ui.loading.hidden = true;
  ui.content.hidden = false;
  ui.statusbar.hidden = false;
}

/**
 * Switches between "For AI" and "For people". Only the selected tab is in the tab order.
 * @param {'ai' | 'people'} which
 * @param {boolean} [moveFocus]
 */
function selectTab(which, moveFocus = false) {
  const ai = which === 'ai';
  ui.tabAi.setAttribute('aria-selected', String(ai));
  ui.tabAi.tabIndex = ai ? 0 : -1;
  ui.tabPeople.setAttribute('aria-selected', String(!ai));
  ui.tabPeople.tabIndex = ai ? -1 : 0;
  ui.panelAi.hidden = !ai;
  ui.panelPeople.hidden = ai;
  if (moveFocus) (ai ? ui.tabAi : ui.tabPeople).focus();
}

/** Enables each button when the data it needs exists. */
function refreshButtons() {
  const idle = !state.saving;
  const full = state.fullBlocked === '';
  ui.saveAll.disabled = !(state.tilesReady && idle);
  ui.saveFull.disabled = !(full && idle);
  ui.copyFull.disabled = !full;
  for (const tile of state.tiles) {
    tile.copyButton.disabled = !tile.blob;
    tile.saveButton.disabled = !(tile.blob && idle);
  }
}

/** @param {readonly string[]} warnings */
function renderWarnings(warnings) {
  ui.warningList.replaceChildren(...warnings.map((line) => h('li', undefined, line)));
  ui.warnings.hidden = warnings.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------------------------

/**
 * Sends a message and checks the reply. A missing receiver or a missing capture means that the
 * capture is gone from memory.
 * @param {Record<string, unknown>} message
 * @returns {Promise<Record<string, any>>}
 */
async function request(message) {
  /** @type {unknown} */
  let reply;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch {
    throw new SpoolError(ERR.SESSION_NOT_FOUND, TEXT.notInMemory);
  }
  if (typeof reply !== 'object' || reply === null) {
    throw new SpoolError(ERR.SESSION_NOT_FOUND, TEXT.notInMemory);
  }
  const data = /** @type {Record<string, any>} */ (reply);
  if (data['ok'] === true) return data;
  const code = data['error']?.code;
  if (typeof code !== 'string' || code === ERR.SESSION_NOT_FOUND) {
    throw new SpoolError(ERR.SESSION_NOT_FOUND, TEXT.notInMemory);
  }
  const text = typeof data['error']?.message === 'string' ? data['error'].message : TEXT.buildFailed;
  throw new SpoolError(code, text);
}

/**
 * Checks the summary from the offscreen document and fills in safe defaults.
 * @param {unknown} raw
 * @returns {FinishSummary}
 */
function readSummary(raw) {
  const m = /** @type {Record<string, any>} */ (typeof raw === 'object' && raw !== null ? raw : {});
  const valid =
    Number.isSafeInteger(m['widthPx']) &&
    m['widthPx'] > 0 &&
    Number.isSafeInteger(m['heightPx']) &&
    m['heightPx'] > 0 &&
    Number.isSafeInteger(m['tileCount']) &&
    m['tileCount'] >= 1 &&
    typeof m['tileTier'] === 'string' &&
    Object.hasOwn(TILE_TIERS, m['tileTier']);
  if (!valid) throw new SpoolError(ERR.INTERNAL, TEXT.badCapture);
  const save = typeof m['save'] === 'object' && m['save'] !== null ? m['save'] : {};
  return {
    sessionId: typeof m['sessionId'] === 'string' ? m['sessionId'] : '',
    title: typeof m['title'] === 'string' ? m['title'] : '',
    sourceHost: typeof m['sourceHost'] === 'string' ? m['sourceHost'] : '',
    createdAt: Number.isFinite(m['createdAt']) ? m['createdAt'] : Date.now(),
    widthPx: m['widthPx'],
    heightPx: m['heightPx'],
    tileCount: m['tileCount'],
    tileTier: m['tileTier'],
    fitsOneImage: typeof m['fitsOneImage'] === 'boolean' ? m['fitsOneImage'] : m['tileCount'] === 1,
    fullBytes: Number.isFinite(m['fullBytes']) && m['fullBytes'] > 0 ? m['fullBytes'] : 0,
    thumbnailPngBase64: '',
    thumbnailWidthPx: 0,
    thumbnailHeightPx: 0,
    save: {
      location:
        save.location === 'folder' || save.location === 'downloads' ? save.location : 'none',
      label: typeof save.label === 'string' ? save.label : '',
      files: Number.isSafeInteger(save.files) && save.files > 0 ? save.files : 0,
      needsPermission: save.needsPermission === true,
      ...(typeof save.error === 'string' && save.error !== '' ? { error: save.error } : {}),
    },
    warnings: Array.isArray(m['warnings'])
      ? m['warnings'].filter((w) => typeof w === 'string' && w.trim() !== '')
      : [],
  };
}

/**
 * @param {Record<string, any>} reply  A reply of offscreen/last-get.
 * @returns {Blob}
 */
function pngBlobOf(reply) {
  const base64 = reply['pngBase64'];
  if (typeof base64 !== 'string' || base64 === '') {
    throw new SpoolError(ERR.INTERNAL, TEXT.badCapture);
  }
  return base64ToBlob(base64);
}

/**
 * Gets one PNG of the capture: a tile (index) or the full image.
 * @param {number | 'full'} item
 * @returns {Promise<Blob>}
 */
async function fetchOutput(item) {
  const reply = await request(makeMessage(MSG.OFF_LAST_GET, { sessionId: state.sessionId, item }));
  return pngBlobOf(reply);
}

/**
 * The full image. It loads once, on the first copy or save. A failure can be tried again.
 * @returns {Promise<Blob>}
 */
function getFullBlob() {
  if (state.fullBlocked !== '') {
    return Promise.reject(new SpoolError(ERR.INTERNAL, state.fullBlocked));
  }
  const promise = (state.fullPromise ??= fetchOutput('full').then((blob) => {
    state.fullBlob = blob;
    return blob;
  }));
  promise.catch(() => {
    if (state.fullPromise === promise) state.fullPromise = null;
  });
  return promise;
}

// ---------------------------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------------------------

/**
 * Creates the card of one tile, and its box in the "For people" column. Both show a
 * placeholder until the tile is loaded.
 * @param {TilePlan} plan
 * @param {number} count
 * @param {{ index: number, outWidth: number, skipHeight: number, visibleHeight: number }} stack
 *   Place of the tile in the "For people" column (see stackLayout in save-plan.js).
 * @returns {TileEntry}
 */
function createTileEntry(plan, count, stack) {
  const number = plan.index + 1;
  const frame = h('div', 'tile-frame');
  frame.style.aspectRatio = `${plan.outWidth} / ${plan.outHeight}`;
  frame.append(h('span', 'tile-placeholder', 'Loading…'));

  const copyButton = makeButton('Copy', 'copy');
  copyButton.setAttribute('aria-label', `Copy screenshot ${number}`);
  copyButton.disabled = true;
  const saveButton = makeButton('Save', 'download');
  saveButton.setAttribute('aria-label', `Save screenshot ${number}`);
  saveButton.disabled = true;

  const actions = h('div', 'tile-actions');
  actions.append(copyButton, saveButton);
  const parts = tileLabelParts(plan.index, count, plan.outWidth, plan.outHeight);
  const label = h('p', 'tile-label');
  label.append(h('span', 'tile-name', parts.name), ` · ${parts.size}`);
  const card = h('li', 'tile');
  card.append(frame, label, actions);
  ui.tileGrid.append(card);

  // The rows that the tile above already shows are cut off at the top of this box.
  const stackItem = h('div', 'stack-item');
  if (stack.visibleHeight >= 1) {
    stackItem.style.aspectRatio = `${stack.outWidth} / ${stack.visibleHeight.toFixed(3)}`;
  } else {
    stackItem.hidden = true;
  }
  ui.peopleStack.append(stackItem);

  /** @type {TileEntry} */
  const entry = { plan, stack, frame, stackItem, copyButton, saveButton, blob: null, url: null };
  copyButton.addEventListener('click', () => {
    if (entry.blob) void copyImage(entry.blob, `screenshot ${number}`, copyButton);
  });
  saveButton.addEventListener('click', () => {
    void runSave({ includeTiles: true, includeFull: false, tileIndex: plan.index });
  });
  return entry;
}

/**
 * Shows a loaded tile in the grid and in the "For people" column. Both pictures use the same
 * blob URL, so the browser decodes the tile once, and only when a picture is on screen.
 * @param {number} index
 * @param {Blob} blob
 */
function showTile(index, blob) {
  const entry = state.tiles[index];
  if (!entry) return;
  entry.blob = blob;
  entry.url = URL.createObjectURL(blob);

  const image = h('img', 'tile-img');
  image.alt = `Preview of screenshot ${index + 1} of ${state.tiles.length}`;
  image.decoding = 'async';
  image.loading = 'lazy';
  image.src = entry.url;
  entry.frame.replaceChildren(image);

  const stackImage = h('img', 'stack-img');
  stackImage.alt = '';
  stackImage.decoding = 'async';
  stackImage.loading = 'lazy';
  stackImage.src = entry.url;
  const { skipHeight, outWidth } = entry.stack;
  if (skipHeight > 0) {
    stackImage.style.marginTop = `${((-skipHeight / outWidth) * 100).toFixed(4)}%`;
  }
  entry.stackItem.replaceChildren(stackImage);
  refreshButtons();
}

/** @param {number} count */
async function loadTiles(count) {
  for (let i = 0; i < count; i += 1) {
    setBuild(`Loading screenshot ${i + 1} of ${count}`, i / count);
    showTile(i, await fetchOutput(i));
  }
  state.tilesReady = true;
  tilesDone.resolve();
  setBuild('', null);
  refreshButtons();
}

// ---------------------------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------------------------

/** Timers of the buttons that show "Copied", so a second click restarts the 1.5 s. */
const flashTimers = new WeakMap();

/**
 * Shows "Copied" with a check on a button for a moment (amber tint, see src/ui/base.css).
 * @param {HTMLButtonElement} button
 * @param {string} text
 */
function flashLabel(button, text) {
  const label = button.querySelector('.sp-btn-label');
  if (!label) return;
  const original = button.dataset['label'] ?? label.textContent ?? '';
  button.dataset['label'] = original;
  button.dataset['flash'] = '';
  label.textContent = text;
  clearTimeout(flashTimers.get(button));
  flashTimers.set(
    button,
    setTimeout(() => {
      delete button.dataset['flash'];
      label.textContent = original;
    }, FLASH_MS),
  );
}

/**
 * Copies a PNG to the clipboard. Call it directly from a click handler: the browser allows the
 * write only while the click is fresh, so there is no `await` before the clipboard call. The
 * image can be a promise (the full image loads on the first copy).
 * @param {Blob | Promise<Blob>} image
 * @param {string} what  For messages, for example "tile 3" or "the full image".
 * @param {HTMLButtonElement} flashButton  Shows "Copied" for a moment.
 */
async function copyImage(image, what, flashButton) {
  try {
    const written = navigator.clipboard.write([new ClipboardItem({ 'image/png': image })]);
    if (image instanceof Promise && !state.fullBlob) setStatus(TEXT.loadingFull);
    await written;
    setStatus(`Copied ${what} to the clipboard.`, 'ok');
    flashLabel(flashButton, 'Copied');
  } catch (error) {
    console.error('Spool: copy failed.', error);
    const blocked = error instanceof DOMException && error.name === 'NotAllowedError';
    const reason = error instanceof SpoolError ? ` ${error.message}` : '';
    setStatus(
      blocked
        ? 'The browser blocked the copy. Click this page and try again.'
        : `Could not copy ${what}.${reason || ' Save it instead.'}`,
      'error',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------------------------

/**
 * Resolves when the download is complete. Rejects when it is interrupted.
 * @param {number} id
 * @returns {Promise<void>}
 */
function waitForDownload(id) {
  return new Promise((resolve, reject) => {
    /** @param {string | undefined} current @param {string | undefined} error */
    function settle(current, error) {
      if (current === 'complete') {
        done();
        resolve();
      } else if (current === 'interrupted') {
        done();
        const text = error === 'USER_CANCELED' ? TEXT.downloadCanceled : TEXT.downloadFailed;
        reject(new SpoolError(ERR.INTERNAL, text));
      }
    }
    /** @param {chrome.downloads.DownloadDelta} delta */
    function onChanged(delta) {
      if (delta.id === id && delta.state) settle(delta.state.current, delta.error?.current);
    }
    function done() {
      chrome.downloads.onChanged.removeListener(onChanged);
    }
    chrome.downloads.onChanged.addListener(onChanged);
    // The download may already be finished: its change event came before the listener existed.
    chrome.downloads.search({ id }).then(
      ([item]) => {
        if (item) settle(item.state, item.error);
      },
      () => {},
    );
  });
}

/**
 * Saves a Blob in Downloads and waits until the browser has written it. When Chrome refuses to
 * start the download (it does not accept the path), the file is tried once more with the
 * fallback path (the base name without the page title).
 * @param {Blob} blob
 * @param {string} filename  Planned path relative to Downloads.
 * @param {string} fallback  Path for the one retry.
 * @param {() => void} onFallback  Called when the fallback was used.
 * @returns {Promise<number>}  Download id.
 */
async function downloadBlob(blob, filename, fallback, onFallback) {
  const url = URL.createObjectURL(blob);
  try {
    const started = await startDownload(
      (path) =>
        chrome.downloads.download({
          url,
          filename: path,
          conflictAction: 'uniquify',
          saveAs: false,
        }),
      filename,
      fallback,
    );
    if (started.fellBack) {
      console.warn('Spool: the file name was refused. Using the fallback.', started.firstError);
      onFallback();
    }
    await waitForDownload(started.id);
    return started.id;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/**
 * @param {SaveItem} item
 * @returns {Promise<Blob>}
 */
async function blobFor(item) {
  if (item.kind === 'full') {
    if (!state.fullBlob) setStatus(TEXT.loadingFull);
    return getFullBlob();
  }
  await tilesDone.promise;
  const blob = item.index === undefined ? undefined : state.tiles[item.index]?.blob;
  if (!blob) throw new SpoolError(ERR.INTERNAL, TEXT.saveFailed);
  return blob;
}

/**
 * The files of a request, with the names of `base`.
 * @param {string} base
 * @param {SaveRequest} request
 * @returns {SaveItem[]}
 */
function planWith(base, request) {
  const items = savePlan({
    root: state.root,
    base,
    tileCount: state.tiles.length,
    includeTiles: request.includeTiles,
    includeFull: request.includeFull,
    fitsOneImage: state.oneImage,
  });
  return request.tileIndex === undefined
    ? items
    : items.filter((item) => item.index === request.tileIndex);
}

/**
 * Saves files one after another into Downloads.
 * @param {SaveRequest} request
 */
async function runSave(request) {
  if (state.saving) return;
  let items = planWith(state.base, request);
  if (items.length === 0) {
    setStatus(TEXT.nothingToSave);
    return;
  }
  state.saving = true;
  ui.showFolder.hidden = true;
  refreshButtons();
  let saved = 0;
  try {
    for (const [n, item] of items.entries()) {
      setStatus(`Saving file ${saved + 1} of ${items.length}…`);
      const blob = await blobFor(item);
      const fallback = planWith(state.fallbackBase, request)[n]?.filename ?? item.filename;
      state.lastDownloadId = await downloadBlob(blob, item.filename, fallback, () => {
        // The rest of the files use the names without the title.
        state.base = state.fallbackBase;
        state.titleDropped = true;
        items = planWith(state.base, request);
      });
      saved += 1;
      // `items` can have changed: the next file has its new name.
      items = planWith(state.base, request);
    }
    const note = state.titleDropped ? ` ${TEXT.titleDropped}` : '';
    setStatus(`${savedLine(saved, state.root)}${note}`, 'ok');
  } catch (error) {
    console.error('Spool: save failed.', error);
    const reason = error instanceof SpoolError ? error.message : TEXT.saveFailed;
    const stopped = saved > 0 ? `Saved ${plural(saved, 'file')}, then stopped. ` : '';
    setStatus(`${stopped}${reason}`, 'error');
  } finally {
    state.saving = false;
    ui.showFolder.hidden = state.lastDownloadId === null;
    refreshButtons();
  }
}

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

/**
 * "In your chat, press Alt+Shift+V to insert all 5 tiles." The shortcut is the one that the
 * browser has for the insert command (the user can change it), written for the system: a Mac gets
 * glyphs. Only for a capture of more than one tile: one tile is the image on the clipboard.
 * @param {number} tileCount
 */
async function showInsertHint(tileCount) {
  if (tileCount < 2) return;
  let shortcut = defaultShortcut(PLATFORM, 'insert');
  try {
    const commands = await chrome.commands.getAll();
    const command = commands.find((c) => c.name === COMMANDS.INSERT);
    if (command) shortcut = command.shortcut ?? '';
  } catch {
    // The default text is right unless the user changed the key.
  }
  const keys = shortcutParts(shortcut, PLATFORM);
  if (keys.length === 0) return;
  /** @type {Array<Node | string>} */
  const content = ['In your chat, press '];
  keys.forEach((key, i) => {
    if (i > 0 && PLATFORM !== 'mac') content.push('+');
    content.push(h('kbd', 'sp-kbd', key));
  });
  content.push(` to insert all ${tileCount} screenshots.`);
  ui.insertHint.replaceChildren(...content);
  ui.insertHint.hidden = false;
}

/**
 * What the capture's own save did, in the status bar.
 * @param {FinishSummary} summary
 */
function showSavedByDone(summary) {
  const line = saveInfoLine(summary.save);
  setStatus(line.text, line.tone);
  ui.allowAccess.hidden = !line.needsPermission;
}

async function main() {
  const sessionId = location.hash.slice(1);
  if (!isSessionId(sessionId)) throw new SpoolError(ERR.SESSION_NOT_FOUND, TEXT.notInMemory);
  state.sessionId = sessionId;

  setLoad('Loading the capture', 0);
  const reply = await request(makeMessage(MSG.OFF_LAST_INFO, { sessionId }));
  const summary = readSummary(reply['summary']);
  state.summary = summary;
  debugApi.summary = summary;
  debugApi.manifest = {
    sessionId: summary.sessionId,
    title: summary.title,
    sourceHost: summary.sourceHost,
    createdAt: summary.createdAt,
    widthPx: summary.widthPx,
    totalHeightPx: summary.heightPx,
    scale: 0,
    slices: [],
    warnings: summary.warnings,
  };
  ui.pageTitle.textContent = summary.title || 'Untitled capture';
  document.title = `${summary.title || 'Capture'} - Spool`;

  settings = await loadSettings().catch(() => DEFAULT_SETTINGS);
  const tilePlan = planTiles(summary.widthPx, summary.heightPx, summary.tileTier);
  if (tilePlan.length !== summary.tileCount) throw new SpoolError(ERR.INTERNAL, TEXT.badCapture);
  debugApi.tilePlan = tilePlan;
  state.oneImage = fitsOneImage(tilePlan, summary.widthPx);

  const createdAt = new Date(summary.createdAt);
  state.root = settings.folderName;
  state.base = captureBaseName(createdAt, summary.title);
  state.fallbackBase = captureBaseName(createdAt, '');

  // The full image: its size is known now, the picture loads on the first copy or save.
  if (summary.fullBytes === 0) state.fullBlocked = TEXT.fullFailed;
  else if (summary.fullBytes > MAX_TRANSFER_BYTES) state.fullBlocked = TEXT.fullTooLarge;
  ui.fullInfo.textContent =
    state.fullBlocked === ''
      ? `${formatDimensions(summary.widthPx, summary.heightPx)} · ${formatBytes(summary.fullBytes)}`
      : state.fullBlocked;

  ui.summary.textContent = summaryLine({
    createdAt: summary.createdAt,
    widthPx: summary.widthPx,
    heightPx: summary.heightPx,
  });
  ui.tabAiCount.textContent = plural(tilePlan.length, 'screenshot');
  ui.tabPeopleCount.textContent = '1 image';
  ui.saveHint.textContent = saveAllHint(
    savePlan({
      root: state.root,
      base: state.base,
      tileCount: tilePlan.length,
      includeTiles: settings.saveTiles,
      includeFull: settings.saveFull,
      fitsOneImage: state.oneImage,
    }),
  );
  showSavedByDone(summary);
  renderWarnings(summary.warnings);

  const stacks = stackLayout(tilePlan);
  state.tiles = tilePlan.map((plan, i) =>
    createTileEntry(plan, tilePlan.length, /** @type {(typeof stacks)[number]} */ (stacks[i])),
  );
  refreshButtons();
  showContent();
  void showInsertHint(tilePlan.length);

  await loadTiles(tilePlan.length);
  setPageState('ready');
}

ui.saveAll.addEventListener('click', () => {
  void runSave({ includeTiles: settings.saveTiles, includeFull: settings.saveFull });
});
ui.saveFull.addEventListener('click', () => {
  void runSave({ includeTiles: false, includeFull: true });
});
ui.copyFull.addEventListener('click', () => {
  const full = state.summary;
  // A very tall image decodes to hundreds of MB and can crash this tab: save it or copy a tile.
  if (full && exceedsClipboardLimit(full.widthPx, full.heightPx, MAX_CLIPBOARD_BITMAP_BYTES)) {
    setStatus(TEXT.tooTallToCopy, 'error');
    return;
  }
  void copyImage(getFullBlob(), 'the full image', ui.copyFull);
});
ui.showFolder.addEventListener('click', () => {
  if (state.lastDownloadId !== null) chrome.downloads.show(state.lastDownloadId);
});
ui.allowAccess.addEventListener('click', () => {
  chrome.tabs
    .create({ url: chrome.runtime.getURL(`${PATHS.options}#save`) })
    .catch(() => setStatus('Could not open the settings.', 'error'));
});
ui.openSettings.addEventListener('click', () => {
  chrome.runtime.openOptionsPage().catch(() => setStatus('Could not open the settings.', 'error'));
});
for (const tab of [ui.tabAi, ui.tabPeople]) {
  tab.addEventListener('click', () => selectTab(tab === ui.tabAi ? 'ai' : 'people'));
  // Arrow keys, Home and End move between the two tabs (the tab pattern of the ARIA guide).
  tab.addEventListener('keydown', (event) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'ArrowLeft' || event.key === 'Home' ? 'ai' : 'people';
    selectTab(next, true);
  });
}

addEventListener('pagehide', (event) => {
  if (event.persisted) return;
  for (const tile of state.tiles) {
    if (tile.url) URL.revokeObjectURL(tile.url);
  }
});

setPageState('loading');
main().catch((error) => {
  console.error('Spool: the result page failed.', error);
  tilesDone.reject(error);
  showFatal(error instanceof SpoolError ? error.message : TEXT.buildFailed);
});
