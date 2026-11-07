// @ts-check
/**
 * Starts a capture in a tab (docs/contracts.md section 2, steps 1 to 3).
 *
 * The service worker injects the page agent and then it is done: the agent talks to the service
 * worker by messages. This module never rejects. A failure shows as a "!" badge on the tab's
 * toolbar button, with the reason as the button's title, for 4 seconds.
 */

import { defaultShortcut, keyLabel, pasteLabel, platformKind } from '../lib/keys.js';
import {
  COMMANDS,
  MAX_CLIPBOARD_BITMAP_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  PAGE_MODES,
  PATHS,
  RESTRICTED_HOSTS,
  RESTRICTED_SCHEMES,
} from '../shared/constants.js';
import { ERR, MSG, PROTOCOL_VERSION, TARGET } from '../shared/protocol.js';
import { loadSettings, normalizeSettings } from '../shared/settings.js';
import { offscreenExists, sendToOffscreen } from './offscreen-client.js';

/** @typedef {import('../shared/types.js').PageConfig} PageConfig */
/** @typedef {import('../shared/types.js').Settings} Settings */
/** @typedef {import('../shared/types.js').Shortcuts} Shortcuts */
/** @typedef {import('../lib/keys.js').Platform} Platform */

/**
 * The keys of the manifest for Windows and Linux (`suggested_key.default`). The page shows them
 * when the browser does not say. A Mac has its own (`defaultShortcut` in src/lib/keys.js).
 */
export const DEFAULT_SHORTCUTS = Object.freeze({ start: 'Alt+Shift+S', insert: 'Alt+Shift+V' });
const MAX_SHORTCUT_LENGTH = 40;

/**
 * The system that the browser runs on. A worker has `navigator`; without it (a test) the answer is
 * a system that writes words.
 * @returns {Platform}
 */
export function systemPlatform() {
  try {
    const nav = /** @type {any} */ (globalThis.navigator);
    return platformKind(nav?.userAgentData?.platform ?? nav?.platform);
  } catch {
    return 'windows';
  }
}

/**
 * The keys of the two commands as the browser has them now. The user can change them on the
 * shortcuts page of the browser, so the manifest is not the source. A command with no key gives
 * an empty string. Without the API (or when it fails) the keys of the manifest.
 * @param {Platform} [platform]  The keys of the manifest depend on it.
 * @returns {Promise<Shortcuts>}
 */
export async function readShortcuts(platform = 'windows') {
  /** @type {Shortcuts} */
  const manifestKeys = {
    start: defaultShortcut(platform, 'start'),
    insert: defaultShortcut(platform, 'insert'),
  };
  try {
    const list = await chrome.commands.getAll();
    /** @param {string} name @param {string} fallback */
    const keyOf = (name, fallback) => {
      const command = list.find((c) => c.name === name);
      if (!command) return fallback;
      const key = command.shortcut;
      return typeof key === 'string' ? key.slice(0, MAX_SHORTCUT_LENGTH) : '';
    };
    return {
      start: keyOf(COMMANDS.START, manifestKeys.start),
      insert: keyOf(COMMANDS.INSERT, manifestKeys.insert),
    };
  } catch {
    return manifestKeys;
  }
}

export const START_COMMAND = COMMANDS.START;
export const INSERT_COMMAND = COMMANDS.INSERT;
export const BADGE_TEXT = '!';
export const BADGE_COLOR = '#b3261e';
export const BADGE_CLEAR_MS = 4000;

export const MSG_RESTRICTED =
  'Spool cannot capture browser pages or the web store. Open a normal web page.';
export const MSG_INJECT_FAILED = 'Spool cannot capture this page. Reload it or try another page.';

/**
 * True when extensions cannot run scripts at `url`. A missing or invalid URL counts as restricted
 * (the extension has no access to the tab).
 * @param {string | undefined} url
 * @returns {boolean}
 */
export function isRestrictedUrl(url) {
  if (typeof url !== 'string' || url === '') return true;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return true;
  }
  if (RESTRICTED_SCHEMES.includes(parsed.protocol)) return true;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  return RESTRICTED_HOSTS.includes(host);
}

// The two functions below run in the page (isolated world). They are serialized by
// chrome.scripting, so they must not use anything from this module.

/**
 * Step 3a. Stores the config for the page scripts. Returns true when an agent is already active;
 * the config is then left alone, so the running session keeps its own.
 * @param {PageConfig} config
 * @returns {boolean}
 */
function installConfig(config) {
  // Namespace rule of contract section 5: an own, plain-object property only, so page markup
  // such as <form id="__spool"> (a named property, never an own one) cannot stand in for it.
  /** @param {unknown} v */
  const isPlainObject = (v) => Object.prototype.toString.call(v) === '[object Object]';
  /** @type {any} */
  let ns = Object.hasOwn(globalThis, '__spool') ? Reflect.get(globalThis, '__spool') : null;
  if (!isPlainObject(ns)) {
    ns = {};
    Object.defineProperty(globalThis, '__spool', {
      value: ns,
      writable: true,
      configurable: true,
      enumerable: false,
    });
  }
  const agent = Object.hasOwn(ns, 'agent') ? ns.agent : null;
  if (agent && typeof agent.isActive === 'function' && agent.isActive()) return true;
  ns.config = config;
  return false;
}

/**
 * Step 3c. Starts the agent. Returns false when the page scripts did not register it.
 * @returns {boolean}
 */
function startAgent() {
  /** @type {any} */
  const ns = Object.hasOwn(globalThis, '__spool') ? Reflect.get(globalThis, '__spool') : null;
  if (Object.prototype.toString.call(ns) !== '[object Object]') return false;
  const agent = Object.hasOwn(ns, 'agent') ? ns.agent : null;
  if (!agent || typeof agent.start !== 'function') return false;
  agent.start();
  return true;
}

/**
 * @typedef {Object} StarterDeps
 * @property {(fn: () => void, ms: number) => unknown} [schedule]  Like setTimeout.
 * @property {(handle: unknown) => void} [cancel]                  Like clearTimeout.
 * @property {() => string} [newSessionId]
 * @property {() => string} [newToken]       A new shelf token (a random UUID v4).
 * @property {() => Promise<Settings>} [readSettings]
 * @property {() => Promise<Shortcuts>} [readShortcutKeys]  Default: `readShortcuts`.
 * @property {Platform} [platform]  The system of the browser. Default: read from `navigator`.
 * @property {(token: string, tabId: number) => Promise<void>} [registerShelfToken]
 *   Makes the offscreen document know the token for the tab. Default: `offscreen/shelf-grant`,
 *   only when an offscreen document exists (without one there is no last capture).
 */

/**
 * @param {StarterDeps} [deps]
 */
export function createStarter(deps = {}) {
  const schedule = deps.schedule ?? ((fn, ms) => setTimeout(fn, ms));
  const cancel = deps.cancel ?? ((handle) => clearTimeout(/** @type {any} */ (handle)));
  const newSessionId = deps.newSessionId ?? (() => crypto.randomUUID());
  const newToken = deps.newToken ?? (() => crypto.randomUUID());
  const readSettings = deps.readSettings ?? (() => loadSettings());
  const platform = deps.platform ?? systemPlatform();
  const readShortcutKeys = deps.readShortcutKeys ?? (() => readShortcuts(platform));
  const registerShelfToken =
    deps.registerShelfToken ??
    (async (token, tabId) => {
      if (!(await offscreenExists())) return;
      await sendToOffscreen(MSG.OFF_SHELF_GRANT, { token, tabId });
    });

  /** Tabs where a start is running now. Stops a double click from injecting twice. */
  const starting = new Set();
  /** Pending "clear the badge" timers by tab. Only UI state, not session state. */
  const badgeTimers = new Map();

  /** @returns {string} */
  function defaultTitle() {
    /** @type {any} */
    const manifest = chrome.runtime.getManifest();
    return typeof manifest?.action?.default_title === 'string'
      ? manifest.action.default_title
      : 'Spool';
  }

  /** @param {number} tabId */
  async function clearFlag(tabId) {
    badgeTimers.delete(tabId);
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text: '' }),
        chrome.action.setTitle({ tabId, title: defaultTitle() }),
      ]);
    } catch {
      // The tab is gone. Tab-specific values go with it.
    }
  }

  /**
   * Shows "!" on the tab's button, with `message` as its title, for BADGE_CLEAR_MS.
   * @param {number} tabId
   * @param {string} message
   */
  async function flagTab(tabId, message) {
    if (badgeTimers.has(tabId)) cancel(badgeTimers.get(tabId));
    badgeTimers.delete(tabId);
    try {
      await Promise.all([
        chrome.action.setBadgeText({ tabId, text: BADGE_TEXT }),
        chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }),
        chrome.action.setTitle({ tabId, title: message }),
      ]);
    } catch {
      return; // The tab is gone.
    }
    badgeTimers.set(
      tabId,
      schedule(() => void clearFlag(tabId), BADGE_CLEAR_MS),
    );
  }

  /** @returns {Promise<Settings>} */
  async function settingsOrDefaults() {
    try {
      return normalizeSettings(await readSettings());
    } catch {
      return normalizeSettings(undefined);
    }
  }

  /**
   * Injects the page scripts and starts the agent. Does nothing when an agent is already active.
   * Returns false when the page scripts did not register an agent.
   * @param {number} tabId
   * @param {PageConfig} config
   * @param {() => Promise<void>} [prepare]  Runs after the config is in place and before the agent
   *   starts, only when no agent was active. A failure stops the start (and is thrown).
   * @returns {Promise<boolean>}
   */
  async function inject(tabId, config, prepare) {
    const target = { tabId, frameIds: [0] };
    const [probe] = await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      func: installConfig,
      args: [config],
    });
    if (probe?.result === true) return true; // An agent is active: leave it alone.
    if (prepare) await prepare();
    await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      files: [...PATHS.pageScripts],
    });
    const [started] = await chrome.scripting.executeScript({
      target,
      world: 'ISOLATED',
      func: startAgent,
    });
    return started?.result === true;
  }

  /**
   * Starts a capture in `tab`. Never rejects.
   * @param {chrome.tabs.Tab | undefined} tab
   * @returns {Promise<void>}
   */
  async function startCapture(tab) {
    const tabId = tab?.id;
    if (typeof tabId !== 'number' || tabId < 0 || starting.has(tabId)) return;
    starting.add(tabId);
    try {
      if (isRestrictedUrl(tab?.url)) {
        await flagTab(tabId, MSG_RESTRICTED);
        return;
      }
      const settings = await settingsOrDefaults();
      const config = buildConfig(settings, PAGE_MODES.CAPTURE, '', await shortcutsOrDefaults());
      if (!(await inject(tabId, config))) await flagTab(tabId, MSG_INJECT_FAILED);
    } catch {
      await flagTab(tabId, MSG_INJECT_FAILED);
    } finally {
      starting.delete(tabId);
    }
  }

  /** @returns {Promise<Shortcuts>} Never rejects. */
  async function shortcutsOrDefaults() {
    try {
      return await readShortcutKeys();
    } catch {
      return {
        start: defaultShortcut(platform, 'start'),
        insert: defaultShortcut(platform, 'insert'),
      };
    }
  }

  /**
   * @param {Settings} settings
   * @param {import('../shared/types.js').PageMode} mode
   * @param {string} shelfToken
   * @param {Shortcuts} shortcuts
   * @returns {PageConfig}
   */
  function buildConfig(settings, mode, shelfToken, shortcuts) {
    return {
      protocolVersion: PROTOCOL_VERSION,
      sessionId: newSessionId(),
      settings,
      mode,
      shelfToken,
      shortcuts: { ...shortcuts },
      keys: {
        start: keyLabel(shortcuts.start, platform),
        insert: keyLabel(shortcuts.insert, platform),
        paste: pasteLabel(platform),
      },
      limits: {
        maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
        maxClipboardBitmapBytes: MAX_CLIPBOARD_BITMAP_BYTES,
      },
      msg: { ...MSG },
      err: { ...ERR },
      target: { ...TARGET },
    };
  }

  /**
   * Opens the shelf of the last capture in `tab` (docs/contracts.md 7.1, step 5). The page scripts
   * get `config.mode = 'shelf'` and a new token for this tab. The token is registered with the
   * offscreen document only when no agent is active in the tab: a running capture or an open shelf
   * keeps what it has. Never rejects.
   * @param {chrome.tabs.Tab | undefined} tab
   * @returns {Promise<void>}
   */
  async function startShelf(tab) {
    const tabId = tab?.id;
    if (typeof tabId !== 'number' || tabId < 0 || starting.has(tabId)) return;
    starting.add(tabId);
    try {
      if (isRestrictedUrl(tab?.url)) {
        await flagTab(tabId, MSG_RESTRICTED);
        return;
      }
      const settings = await settingsOrDefaults();
      const token = newToken();
      const config = buildConfig(settings, PAGE_MODES.SHELF, token, await shortcutsOrDefaults());
      const started = await inject(tabId, config, () => registerShelfToken(token, tabId));
      if (!started) await flagTab(tabId, MSG_INJECT_FAILED);
    } catch {
      await flagTab(tabId, MSG_INJECT_FAILED);
    } finally {
      starting.delete(tabId);
    }
  }

  /**
   * Handles chrome.commands.onCommand: `start-capture` starts a capture, `insert-capture` opens
   * the shelf. Uses the tab Chrome passes, or the active tab. Never rejects.
   * @param {string} command
   * @param {chrome.tabs.Tab | undefined} [tab]
   * @returns {Promise<void>}
   */
  async function startFromCommand(command, tab) {
    if (command !== START_COMMAND && command !== INSERT_COMMAND) return;
    let target = tab;
    if (typeof target?.id !== 'number') {
      try {
        [target] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      } catch {
        return;
      }
    }
    if (command === INSERT_COMMAND) await startShelf(target);
    else await startCapture(target);
  }

  return { startCapture, startShelf, startFromCommand };
}

/** The starter the service worker uses. */
const defaultStarter = createStarter();
export const startCapture = defaultStarter.startCapture;
export const startShelf = defaultStarter.startShelf;
export const startFromCommand = defaultStarter.startFromCommand;
