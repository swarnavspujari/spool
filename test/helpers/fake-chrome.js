// @ts-check
/**
 * A small, explicit fake of the chrome.* APIs that the service worker uses.
 *
 * - Every call is recorded in `calls` ({ api, args }, in call order).
 * - Results are controlled with `behavior` (replace a function) and `state` (data).
 * - It models the Chrome rules that matter for the tests: one offscreen document at a time
 *   (a second createDocument call, also while the first one is pending, throws).
 *
 * Use it per test:
 *   const fake = installFakeChrome();   // sets globalThis.chrome
 *   ...
 *   fake.uninstall();
 */

export const EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';
export const EXTENSION_ORIGIN = `chrome-extension://${EXTENSION_ID}/`;
export const PNG_DATA_URL = 'data:image/png;base64,iVBORw0KGgo=';
export const DEFAULT_TITLE = 'Spool it';

/** Resolves on a later macrotask, so other pending async work can run first. */
export function macrotask() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * @template {(...args: any[]) => any} F
 * @typedef {Object} FakeEvent
 * @property {(fn: F) => void} addListener
 * @property {(fn: F) => void} removeListener
 * @property {(fn: F) => boolean} hasListener
 * @property {F[]} listeners
 * @property {(...args: Parameters<F>) => unknown[]} dispatch  Calls every listener.
 */

/**
 * @template {(...args: any[]) => any} F
 * @returns {FakeEvent<F>}
 */
export function createEvent() {
  /** @type {F[]} */
  const listeners = [];
  return {
    listeners,
    addListener: (fn) => void listeners.push(fn),
    removeListener(fn) {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    },
    hasListener: (fn) => listeners.includes(fn),
    dispatch: (...args) => listeners.map((fn) => fn(...args)),
  };
}

/**
 * @typedef {Object} FakeTab
 * @property {number} id
 * @property {number} windowId
 * @property {number} index
 * @property {boolean} active
 * @property {string} [url]
 */

/**
 * @typedef {Object} FakeBehavior
 * @property {(message: any) => Promise<any>} sendMessage
 *   runtime.sendMessage. Default: { ok: true }.
 * @property {(injection: any, callIndex: number) => Promise<any[]>} executeScript
 *   scripting.executeScript. Default (happy path): files -> no result; func with args
 *   (the config installer) -> false; func without args (the agent starter) -> true.
 * @property {(windowId: number, options: any) => Promise<string>} captureVisibleTab
 *   Default: PNG_DATA_URL.
 * @property {(queryInfo: any) => Promise<FakeTab[]>} tabsQuery
 *   Default: filters state.tabs by `active` and `windowId`.
 * @property {(props: any) => Promise<any>} tabsCreate
 *   Default: returns the properties plus a new id.
 * @property {(params: any) => Promise<void>} createDocument
 *   Runs while the document is being created. Default: one macrotask.
 * @property {() => Promise<void>} closeDocument  Default: one macrotask.
 */

/**
 * @param {{ id?: string }} [options]
 */
export function createFakeChrome(options = {}) {
  const id = options.id ?? EXTENSION_ID;
  const origin = `chrome-extension://${id}/`;

  /** @type {{ api: string, args: unknown[] }[]} */
  const calls = [];
  /**
   * @param {string} api
   * @param {unknown[]} args
   */
  const record = (api, args) => {
    calls.push({ api, args });
  };

  const state = {
    /** @type {FakeTab[]} */
    tabs: [],
    /** @type {{ contextType: string, documentUrl: string }[]} */
    contexts: [],
    /** @type {Record<string, unknown>} chrome.storage.sync content */
    storage: {},
    /** Number of createDocument calls that were accepted. */
    createdDocuments: 0,
    /** Number of createDocument calls that Chrome would reject. */
    rejectedCreates: 0,
    /** Number of closeDocument calls. */
    closedDocuments: 0,
    createInFlight: false,
    nextTabId: 900,
    /** @type {Record<string, unknown>} */
    manifest: { action: { default_title: DEFAULT_TITLE } },
  };

  /** @type {FakeBehavior} */
  const behavior = {
    sendMessage: async () => ({ ok: true }),
    executeScript: async (injection) => {
      if (injection.files) return [{ frameId: 0 }];
      return [{ frameId: 0, result: !injection.args }];
    },
    captureVisibleTab: async () => PNG_DATA_URL,
    tabsQuery: async (queryInfo) =>
      state.tabs.filter(
        (t) =>
          (queryInfo.active === undefined || t.active === queryInfo.active) &&
          (queryInfo.windowId === undefined || t.windowId === queryInfo.windowId),
      ),
    tabsCreate: async (props) => ({ id: state.nextTabId++, ...props }),
    createDocument: async () => {
      await macrotask();
    },
    closeDocument: async () => {
      await macrotask();
    },
  };

  let executeScriptCalls = 0;

  const events = {
    actionClicked: /** @type {FakeEvent<(tab: any) => any>} */ (createEvent()),
    command: /** @type {FakeEvent<(command: string, tab?: any) => any>} */ (createEvent()),
    message: /** @type {FakeEvent<(msg: any, sender: any, sendResponse: any) => any>} */ (
      createEvent()
    ),
    /** `chrome.tabs.onActivated`. Dispatch it with `{ tabId, windowId }`. */
    tabActivated: /** @type {FakeEvent<(info: { tabId: number, windowId: number }) => any>} */ (
      createEvent()
    ),
    tabRemoved: /** @type {FakeEvent<(tabId: number, info?: any) => any>} */ (createEvent()),
    /** `chrome.runtime.onInstalled`. Dispatch it with `{ reason }`. */
    installed: /** @type {FakeEvent<(details: { reason: string }) => any>} */ (createEvent()),
    tabUpdated: /** @type {FakeEvent<(tabId: number, info: any, tab?: any) => any>} */ (
      createEvent()
    ),
  };

  const chrome = {
    runtime: {
      id,
      getURL: (/** @type {string} */ path) => origin + path,
      getManifest: () => state.manifest,
      sendMessage: (/** @type {any} */ message) => {
        record('runtime.sendMessage', [message]);
        return behavior.sendMessage(message);
      },
      getContexts: async (/** @type {any} */ filter) => {
        record('runtime.getContexts', [filter]);
        const types = filter?.contextTypes;
        return state.contexts.filter((c) => !types || types.includes(c.contextType));
      },
      onMessage: events.message,
      onInstalled: events.installed,
    },
    offscreen: {
      createDocument: async (/** @type {any} */ params) => {
        record('offscreen.createDocument', [params]);
        const exists = state.contexts.some((c) => c.contextType === 'OFFSCREEN_DOCUMENT');
        if (exists || state.createInFlight) {
          state.rejectedCreates += 1;
          throw new Error('Only a single offscreen document may be created.');
        }
        state.createInFlight = true;
        try {
          await behavior.createDocument(params);
          state.contexts.push({
            contextType: 'OFFSCREEN_DOCUMENT',
            documentUrl: origin + params.url,
          });
          state.createdDocuments += 1;
        } finally {
          state.createInFlight = false;
        }
      },
      closeDocument: async () => {
        record('offscreen.closeDocument', []);
        if (!state.contexts.some((c) => c.contextType === 'OFFSCREEN_DOCUMENT')) {
          throw new Error('No current offscreen document.');
        }
        await behavior.closeDocument();
        state.contexts = state.contexts.filter((c) => c.contextType !== 'OFFSCREEN_DOCUMENT');
        state.closedDocuments += 1;
      },
    },
    tabs: {
      query: (/** @type {any} */ queryInfo) => {
        record('tabs.query', [queryInfo]);
        return behavior.tabsQuery(queryInfo);
      },
      create: (/** @type {any} */ props) => {
        record('tabs.create', [props]);
        return behavior.tabsCreate(props);
      },
      captureVisibleTab: (/** @type {number} */ windowId, /** @type {any} */ opts) => {
        record('tabs.captureVisibleTab', [windowId, opts]);
        return behavior.captureVisibleTab(windowId, opts);
      },
      onActivated: events.tabActivated,
      onRemoved: events.tabRemoved,
      onUpdated: events.tabUpdated,
    },
    scripting: {
      executeScript: (/** @type {any} */ injection) => {
        record('scripting.executeScript', [injection]);
        return behavior.executeScript(injection, executeScriptCalls++);
      },
    },
    action: {
      onClicked: events.actionClicked,
      setBadgeText: async (/** @type {any} */ details) => {
        record('action.setBadgeText', [details]);
      },
      setBadgeBackgroundColor: async (/** @type {any} */ details) => {
        record('action.setBadgeBackgroundColor', [details]);
      },
      setTitle: async (/** @type {any} */ details) => {
        record('action.setTitle', [details]);
      },
    },
    commands: { onCommand: events.command },
    storage: {
      sync: {
        get: async (/** @type {string} */ key) => {
          record('storage.sync.get', [key]);
          return Object.hasOwn(state.storage, key) ? { [key]: state.storage[key] } : {};
        },
        set: async (/** @type {Record<string, unknown>} */ items) => {
          record('storage.sync.set', [items]);
          Object.assign(state.storage, items);
        },
      },
    },
  };

  return {
    chrome,
    calls,
    state,
    behavior,
    events,
    origin,
    /** Arguments of every call to `api`, in order. */
    argsOf: (/** @type {string} */ api) => calls.filter((c) => c.api === api).map((c) => c.args),
    /** Names of all recorded calls, in order. */
    names: () => calls.map((c) => c.api),
    /**
     * @param {Partial<FakeTab> & { id: number }} tab
     * @returns {FakeTab}
     */
    addTab(tab) {
      /** @type {FakeTab} */
      const full = { windowId: 1, index: 0, active: false, url: 'https://example.com/', ...tab };
      state.tabs.push(full);
      return full;
    },
    /**
     * Marks a tab as the active tab of its window and the others of that window as inactive.
     * Like Chrome, it then fires `tabs.onActivated` for that tab and window.
     */
    activate(/** @type {number} */ tabId) {
      const target = state.tabs.find((t) => t.id === tabId);
      if (!target) throw new Error(`No fake tab ${tabId}`);
      for (const t of state.tabs) if (t.windowId === target.windowId) t.active = t.id === tabId;
      events.tabActivated.dispatch({ tabId, windowId: target.windowId });
    },
    /** Pretends that an offscreen document exists. */
    addOffscreenDocument() {
      state.contexts.push({
        contextType: 'OFFSCREEN_DOCUMENT',
        documentUrl: `${origin}src/offscreen/offscreen.html`,
      });
    },
  };
}

/**
 * Creates a fake and installs it as globalThis.chrome.
 * @param {{ id?: string }} [options]
 */
export function installFakeChrome(options) {
  const fake = createFakeChrome(options);
  const target = /** @type {any} */ (globalThis);
  const had = Object.hasOwn(target, 'chrome');
  const previous = target.chrome;
  target.chrome = fake.chrome;
  return {
    ...fake,
    uninstall() {
      if (had) target.chrome = previous;
      else delete target.chrome;
    },
  };
}

/**
 * A promise that you resolve or reject by hand.
 * @template [T=void]
 * @returns {{ promise: Promise<T>, resolve: (v: T) => void, reject: (e: unknown) => void }}
 */
export function deferred() {
  /** @type {(v: T) => void} */
  let resolve = () => {};
  /** @type {(e: unknown) => void} */
  let reject = () => {};
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * Message sender objects for tests.
 * @param {{ tabId?: number, windowId?: number, index?: number, frameId?: number, url?: string,
 *   id?: string }} [o]
 * @returns {chrome.runtime.MessageSender}
 */
export function contentSender(o = {}) {
  return /** @type {any} */ ({
    id: o.id ?? EXTENSION_ID,
    url: o.url ?? 'https://example.com/page',
    frameId: o.frameId ?? 0,
    tab: { id: o.tabId ?? 7, windowId: o.windowId ?? 1, index: o.index ?? 3 },
  });
}
