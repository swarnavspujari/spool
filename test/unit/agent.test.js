// @ts-check
/**
 * Tests for src/page/agent.js. The agent is a classic script: it is loaded into a node:vm
 * context whose globals are fakes (page-lib, overlay, chrome.runtime, document, window).
 * Every promise the fakes return is already resolved, so one macrotask turn (flush) lets the
 * agent run until it waits for something the test controls (a deferred reply).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { ERR, MSG, PROTOCOL_VERSION, TARGET, routeCheck } from '../../src/shared/protocol.js';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';

/** @typedef {import('../../src/shared/types.js').Rect} Rect */
/** @typedef {import('../../src/shared/types.js').PageConfig} PageConfig */
/** @typedef {import('../../src/shared/types.js').Settings} Settings */
/** @typedef {import('../../types/page-globals.js').OverlayCommand} OverlayCommand */
/** @typedef {import('../../types/page-globals.js').OverlayStatus} OverlayStatus */

const AGENT_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/page/agent.js', import.meta.url)),
  'utf8',
);
/** The shared card kit: the agent writes to the clipboard through it (ui.copyImage). */
const UI_KIT_SOURCE = readFileSync(
  fileURLToPath(new URL('../../src/page/ui-kit.js', import.meta.url)),
  'utf8',
);

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const VIEWPORT = Object.freeze({ width: 1000, height: 800 });
/** Visible box of the scroll target, viewport coordinates. */
const BOX = Object.freeze({ x: 100, y: 100, width: 600, height: 500 });
/** The region the user drags. It lies inside BOX, so the capture rect is the same. */
const REGION = Object.freeze({ x: 150, y: 120, width: 400, height: 400 });
/** Scroll step = REGION.height - overlapCss (100) = 300 CSS px. */
const STEP = 300;
const DPR = 1.5;
/** A content script in the top frame of tab 7. @type {any} */
const SENDER = Object.freeze({
  id: 'ext-id',
  url: 'https://example.com/',
  tab: { id: 7 },
  frameId: 0,
});
const ENV = Object.freeze({ runtimeId: 'ext-id', origin: 'chrome-extension://ext-id/' });

const MSG_UNREACHABLE = 'Could not reach the extension. Try again.';
const MSG_GENERIC = 'Something went wrong. Try again.';
const MSG_STOPPING = 'Stopping after this step.';

/** A small PNG as base64: the bytes are not decoded in these tests. */
const PNG_BASE64 = 'iVBORw0KGgo=';
/** The messages that follow page/finish: the image for the clipboard. */
const CLIPBOARD_TYPES = new Set([MSG.PAGE_GET_CLIPBOARD, MSG.PAGE_CLIPBOARD_FALLBACK]);

/** What the service worker answers to page/finish. */
const SUMMARY = Object.freeze({
  sessionId: SESSION_A,
  title: 'Test page',
  createdAt: 1_700_000_000_000,
  widthPx: 1500,
  heightPx: 4200,
  tileCount: 3,
  tileTier: 'standard',
  fitsOneImage: false,
  fullBytes: 1000,
  thumbnailPngBase64: PNG_BASE64,
  thumbnailWidthPx: 320,
  thumbnailHeightPx: 480,
  save: { location: 'downloads', label: 'Downloads/Spool', files: 4, needsPermission: false },
  warnings: [],
});

/** Marks a queued reply that means "use the default reply". */
const DEFAULT = Symbol('default');

const flush = () => new Promise((resolve) => setImmediate(resolve));
function noop() {}

/**
 * Objects that the agent builds live in the vm realm: copy them to this realm before comparing.
 * @template T
 * @param {T} v
 * @returns {T}
 */
function clone(v) {
  return v === undefined ? v : JSON.parse(JSON.stringify(v));
}

/**
 * @template T
 * @returns {{ promise: Promise<T>, resolve: (v: T) => void }}
 */
function deferred() {
  /** @type {(v: T) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** @param {Rect} a @param {Rect} b @returns {Rect | null} */
function intersect(a, b) {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);
  return right - x < 1 || bottom - y < 1 ? null : { x, y, width: right - x, height: bottom - y };
}

/**
 * @param {Partial<Settings>} [settings]
 * @param {string} [sessionId]
 * @returns {PageConfig}
 */
function makeConfig(settings = {}, sessionId = SESSION_A) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    settings: { ...DEFAULT_SETTINGS, overlapCss: 100, settleMs: 7, ...settings },
    msg: MSG,
    err: ERR,
    target: TARGET,
  };
}

/** @param {string} code @param {string} message */
function errorReply(code, message) {
  return { ok: false, error: { code, message } };
}

class FakeEl {
  /** @param {string} name */
  constructor(name) {
    this.name = name;
    /** @type {Record<string, string>} */
    this.style = {};
  }
}

/** A style jar that really changes the style of fake elements, so restores can be checked. */
class FakeJar {
  constructor() {
    /** @type {{ el: FakeEl, prop: string, value: string }[]} */
    this.sets = [];
    /** @type {{ el: FakeEl, prop: string, old: string | undefined }[]} */
    this.saved = [];
    this.restoreCalls = 0;
  }

  /** @param {FakeEl} el @param {string} prop @param {string} value */
  set(el, prop, value) {
    this.sets.push({ el, prop, value });
    if (!this.saved.some((x) => x.el === el && x.prop === prop)) {
      this.saved.push({ el, prop, old: el.style[prop] });
    }
    el.style[prop] = value;
  }

  restoreAll() {
    this.restoreCalls += 1;
    for (const { el, prop, old } of this.saved.reverse()) {
      if (old === undefined) delete el.style[prop];
      else el.style[prop] = old;
    }
    this.saved = [];
  }

  get size() {
    return this.saved.length;
  }
}

class FakeOverlay {
  /**
   * @param {string[]} events
   * @param {{ onRegion(rect: Rect): void, onCommand(cmd: OverlayCommand): void,
   *   copyOnDone?: boolean }} handlers
   */
  constructor(events, handlers) {
    this.host = new FakeEl('overlay-host');
    this.events = events;
    this.handlers = handlers;
    this.beginSelectCalls = 0;
    this.destroyCalls = 0;
    /** @type {Rect[]} */
    this.sessions = [];
    /** @type {OverlayStatus[]} */
    this.statuses = [];
    /** @type {boolean[]} */
    this.busy = [];
    this.keepOnTopCalls = 0;
    this.failKeepOnTop = false;
  }

  keepOnTop() {
    this.keepOnTopCalls += 1;
    if (this.failKeepOnTop) throw new Error('keepOnTop failed');
  }

  beginSelect() {
    this.beginSelectCalls += 1;
    this.events.push('beginSelect');
  }

  /** @param {Rect} rect */
  showSession(rect) {
    this.sessions.push(clone(rect));
    this.events.push('showSession');
  }

  /** @param {OverlayStatus} status */
  setStatus(status) {
    this.statuses.push(clone(status));
  }

  /** @param {boolean} busy */
  setBusy(busy) {
    this.busy.push(busy);
  }

  hideForCapture() {
    this.events.push('hideForCapture');
    return Promise.resolve();
  }

  showAfterCapture() {
    this.events.push('showAfterCapture');
  }

  destroy() {
    this.destroyCalls += 1;
    this.events.push('destroy');
  }

  /** The last status line. */
  get status() {
    const last = this.statuses.at(-1);
    assert.ok(last, 'no status was shown');
    return last;
  }

  /** @param {OverlayCommand} cmd */
  command(cmd) {
    this.handlers.onCommand(cmd);
  }

  /** @param {Rect} rect */
  select(rect) {
    this.handlers.onRegion(rect);
  }
}

/**
 * @param {{ scrollTop?: number, maxScrollTop?: number }} [options]
 */
function createHarness(options = {}) {
  const originalScrollTop = options.scrollTop ?? 0;
  /** `reportedMax`: what `lib.maxScrollTop` says when it differs from what the page can scroll. */
  const page = {
    scrollTop: originalScrollTop,
    max: options.maxScrollTop ?? 2000,
    /** @type {number | null} */
    reportedMax: null,
  };
  /** @type {string[]} */
  const events = [];
  /** @type {number[]} */
  const scrollLog = [];
  /** @type {{ ignore: unknown, target: unknown }[]} One entry per scanner the agent made. */
  const scannerCalls = [];
  /** @type {Rect[]} The rect of every collect() call. */
  const collectCalls = [];
  /** @type {number[]} */
  const sleeps = [];
  /** @type {FakeOverlay[]} */
  const overlays = [];
  /** @type {FakeJar[]} */
  const jars = [];
  /** @type {Record<string, any>[]} */
  const sent = [];
  /** @type {Map<string, unknown[]>} */
  const queues = new Map();
  /** @type {Map<string, Set<(e?: unknown) => void>>} */
  const listeners = new Map();
  /** The timers the agent started with setInterval. @type {{ fn: () => void, ms: number, cleared: boolean }[]} */
  const intervals = [];

  /**
   * The clipboard of the page: what the agent wrote, and how the browser answers. `reject`: the
   * write fails (NotAllowedError). `missing`: there is no clipboard API.
   * @type {{ writes: { images: Promise<Blob>[] }[], reject: boolean, missing: boolean }}
   */
  const clipboard = { writes: [], reject: false, missing: false };
  class FakeClipboardItem {
    /** @param {Record<string, Promise<Blob>>} data */
    constructor(data) {
      this.data = data;
    }
  }
  const fakeNavigator = {
    get clipboard() {
      if (clipboard.missing) return undefined;
      return {
        /** @param {FakeClipboardItem[]} items */
        write: (items) => {
          clipboard.writes.push({ images: items.map((item) => item.data['image/png']) });
          if (clipboard.reject) return Promise.reject(new Error('NotAllowedError'));
          return Promise.all(items.map((item) => item.data['image/png'])).then(() => undefined);
        },
      };
    },
  };
  /** The toast the agent shows after Done: what it was given, and the copy states it was told. */
  const toast = {
    /** @type {any[]} */
    shown: [],
    /** @type {string[]} */
    copies: [],
    /** @type {string[]} */
    details: [],
    dismissed: 0,
  };

  const scroller = new FakeEl('scroller');
  const root = new FakeEl('html');
  const footer = new FakeEl('footer');
  const divider = new FakeEl('divider');
  const doc = { title: 'Test page', documentElement: root };
  const target = { kind: 'element', el: scroller, box: { ...BOX } };
  /**
   * What the fake scanner reports on every collect(): a fixed footer and a sticky divider. A test
   * can add to it, or make the scan fail.
   * @type {{ el: FakeEl, kind: 'fixed' | 'sticky' }[]}
   */
  const pinned = [
    { el: footer, kind: 'fixed' },
    { el: divider, kind: 'sticky' },
  ];
  const scan = { fail: false };

  const lib = {
    findScrollTarget: () => target,
    clipRect: intersect,
    getScrollTop: () => page.scrollTop,
    maxScrollTop: () => page.reportedMax ?? page.max,
    /** @param {unknown} _t @param {number} top */
    setScrollTop: (_t, top) => {
      page.scrollTop = Math.min(page.max, Math.max(0, top));
      scrollLog.push(top);
    },
    /** @param {{ box: Rect }} t @param {Rect} rect */
    contentYOf: (t, rect) => page.scrollTop + rect.y - t.box.y,
    /** @param {unknown} ignore @param {unknown} scanTarget */
    createOverlayScanner: (ignore, scanTarget) => {
      scannerCalls.push({ ignore, target: scanTarget });
      return {
        /** @param {Rect} rect */
        collect: (rect) => {
          collectCalls.push(clone(rect));
          events.push('collect');
          if (scan.fail) throw new Error('scan failed');
          return [...pinned];
        },
      };
    },
    createStyleJar: () => {
      const jar = new FakeJar();
      jars.push(jar);
      return jar;
    },
    nextFrames: () => Promise.resolve(),
    /** @param {number} ms */
    sleep: (ms) => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  };

  const overlayModule = {
    /** @param {{ onRegion(rect: Rect): void, onCommand(cmd: OverlayCommand): void, copyOnDone?: boolean }} handlers */
    createOverlay: (handlers) => {
      const overlay = new FakeOverlay(events, handlers);
      overlays.push(overlay);
      return overlay;
    },
  };

  // Replies of the fake service worker: queued replies first, then the defaults.
  let stored = 0;
  /** @param {'exact' | 'corrected' | 'unmatched' | 'duplicate'} [kind] */
  function intake(kind = 'exact') {
    if (kind === 'duplicate') {
      const seam = { status: 'duplicate', shiftPx: 0, meanDiff: 0 };
      return { ok: true, intake: reply0(-1, seam) };
    }
    stored += 1;
    const seam = { status: stored === 1 ? 'first' : kind, shiftPx: 0, meanDiff: 0 };
    return { ok: true, intake: reply0(stored - 1, seam) };
  }
  /** @param {number} index @param {Record<string, unknown>} seam */
  function reply0(index, seam) {
    return {
      index,
      sliceCount: stored,
      widthPx: 1500,
      totalHeightPx: stored * 600,
      tileCount: 1 + Math.floor(stored / 8),
      seam,
      storedBytes: stored * 1000,
    };
  }
  /** @param {Record<string, any>} msg */
  function defaultReply(msg) {
    switch (msg['type']) {
      case MSG.PAGE_CAPTURE_FRAME:
        return intake();
      case MSG.PAGE_FINISH:
        return { ok: true, summary: SUMMARY };
      case MSG.PAGE_GET_CLIPBOARD:
        return { ok: true, pngBase64: PNG_BASE64 };
      case MSG.PAGE_CLIPBOARD_FALLBACK:
        return { ok: true, copied: true };
      default:
        return { ok: true };
    }
  }
  /** @param {Record<string, any>} msg */
  function reply(msg) {
    const queue = queues.get(msg['type']);
    if (queue && queue.length > 0) {
      const entry = queue.shift();
      if (entry === DEFAULT) return defaultReply(msg);
      return typeof entry === 'function' ? entry(msg) : entry;
    }
    return defaultReply(msg);
  }

  const runtime = {
    /** @type {string | undefined} */
    id: 'ext-id',
    /** @param {Record<string, any>} msg */
    sendMessage: (msg) => {
      sent.push(clone(msg));
      events.push(`send:${msg['type']}`);
      return Promise.resolve(reply(msg));
    },
  };

  /**
   * The global object of the vm context. Tests change its properties (innerWidth, chrome).
   * @type {Record<string, any>}
   */
  const sandbox = {
    chrome: { runtime },
    document: doc,
    innerWidth: VIEWPORT.width,
    innerHeight: VIEWPORT.height,
    devicePixelRatio: DPR,
    /** @param {() => void} fn @param {number} ms */
    setInterval: (fn, ms) => intervals.push({ fn, ms, cleared: false }),
    /** @param {number} id */
    clearInterval: (id) => {
      const timer = intervals[id - 1];
      if (timer) timer.cleared = true;
    },
    /** @param {string} type @param {(e?: unknown) => void} fn */
    addEventListener: (type, fn) => {
      const set = listeners.get(type) ?? new Set();
      set.add(fn);
      listeners.set(type, set);
    },
    /** @param {string} type @param {(e?: unknown) => void} fn */
    removeEventListener: (type, fn) => {
      listeners.get(type)?.delete(fn);
    },
    navigator: fakeNavigator,
    ClipboardItem: FakeClipboardItem,
    atob,
    Blob,
    __spool: {
      config: makeConfig(),
      lib,
      overlay: overlayModule,
      toast: {
        /** @param {any} opts */
        show: (opts) => {
          toast.shown.push(opts);
          events.push('toast.show');
          return {
            /** @param {string} state @param {string} [detail] */
            setCopy: (state, detail) => {
              toast.copies.push(state);
              toast.details.push(detail ?? '');
            },
            close: noop,
          };
        },
        dismiss: () => {
          toast.dismissed += 1;
        },
      },
    },
  };
  vm.createContext(sandbox);

  function inject() {
    vm.runInContext(UI_KIT_SOURCE, sandbox, { filename: 'ui-kit.js' });
    vm.runInContext(AGENT_SOURCE, sandbox, { filename: 'agent.js' });
  }
  inject();

  /** @returns {{ start(): void, isActive(): boolean }} */
  function agent() {
    return sandbox.__spool.agent;
  }
  function overlay() {
    const last = overlays.at(-1);
    assert.ok(last, 'the overlay was not created');
    return last;
  }
  function jar() {
    const last = jars.at(-1);
    assert.ok(last, 'the style jar was not created');
    return last;
  }

  return {
    sandbox,
    events,
    page,
    scrollLog,
    intervals,
    scannerCalls,
    collectCalls,
    pinned,
    scan,
    target,
    sleeps,
    overlays,
    jars,
    sent,
    clipboard,
    toast,
    listeners,
    runtime,
    doc,
    scroller,
    root,
    footer,
    divider,
    originalScrollTop,
    inject,
    agent,
    overlay,
    jar,
    intake,
    /** @param {PageConfig} [config] */
    start(config) {
      if (config) sandbox.__spool.config = config;
      agent().start();
    },
    /**
     * Queues replies for a message type. They are used before the default reply.
     * @param {string} type
     * @param {unknown[]} replies
     */
    queue(type, ...replies) {
      queues.set(type, [...(queues.get(type) ?? []), ...replies]);
    },
    /** @param {Rect} [region] */
    async select(region = REGION) {
      overlay().select(region);
      await flush();
    },
    /**
     * Starts the agent, selects the region, waits for the initial frame.
     * @param {PageConfig} [config]
     */
    async begin(config) {
      if (config) sandbox.__spool.config = config;
      agent().start();
      overlay().select(REGION);
      await flush();
    },
    /** @param {OverlayCommand} cmd */
    async cmd(cmd) {
      overlay().command(cmd);
      await flush();
    },
    /** @param {boolean} [trusted]  False: an event that a script of the page made. */
    async pageHide(trusted = true) {
      for (const fn of [...(listeners.get('pagehide') ?? [])]) {
        fn({ type: 'pagehide', isTrusted: trusted });
      }
      await flush();
    },
    /** Lets every running watchdog timer fire once. */
    async tick() {
      for (const timer of [...intervals]) if (!timer.cleared) timer.fn();
      await flush();
    },
    /** Types of the messages sent so far. */
    types() {
      return sent.map((m) => m['type']);
    },
    /** Types without the clipboard messages (they follow page/finish). */
    mainTypes() {
      return sent.map((m) => m['type']).filter((t) => !CLIPBOARD_TYPES.has(t));
    },
    /** @param {string} type */
    messages(type) {
      return sent.filter((m) => m['type'] === type);
    },
    /** FrameMeta of every capture-frame message sent so far. */
    frames() {
      return sent.filter((m) => m['type'] === MSG.PAGE_CAPTURE_FRAME).map((m) => m['meta']);
    },
  };
}

/**
 * The overlay is told that the end of the panel is reached: the thread is full and the HUD says
 * "End of panel", so the agent adds no message of its own.
 * @param {ReturnType<typeof createHarness>} h
 */
function assertAtEnd(h) {
  const status = h.overlay().status;
  assert.equal(status.atEnd, true, 'at the end of the panel');
  assert.equal(status.progress, 1);
  assert.equal(status.message, '');
  assert.equal(status.level, 'info');
}

/**
 * Asserts that the page is back in its original state and the session is closed.
 * @param {ReturnType<typeof createHarness>} h
 */
function assertRestored(h) {
  assert.equal(h.page.scrollTop, h.originalScrollTop, 'scroll position');
  assert.deepEqual(h.scroller.style, {}, 'scroller inline style');
  assert.deepEqual(h.root.style, {}, 'root inline style');
  assert.deepEqual(h.footer.style, {}, 'hidden element style');
  assert.deepEqual(h.divider.style, {}, 'released sticky element style');
  assert.equal(h.jar().size, 0);
  assert.equal(h.jar().restoreCalls, 1, 'restoreAll runs once');
  assert.equal(h.overlay().destroyCalls, 1, 'overlay.destroy runs once');
  assert.equal(h.listeners.get('pagehide')?.size ?? 0, 0, 'pagehide listener removed');
  assert.ok(h.intervals.every((t) => t.cleared), 'the watchdog timer is cleared');
  assert.equal(h.agent().isActive(), false);
}

describe('agent.js: loading and start()', () => {
  it('registers a frozen agent on every injection and adds no other global', () => {
    const h = createHarness();
    const first = h.agent();
    assert.ok(Object.isFrozen(first));
    assert.deepEqual(Object.keys(first).sort(), ['isActive', 'start']);
    const keys = Object.keys(h.sandbox).sort();
    h.inject();
    assert.notEqual(h.agent(), first, 'a new injection replaces the agent');
    assert.deepEqual(Object.keys(h.sandbox).sort(), keys);
  });

  it('does nothing without a usable config', () => {
    const bad = [
      undefined,
      { ...makeConfig(), protocolVersion: 2 },
      { ...makeConfig(), sessionId: '' },
      { ...makeConfig(), msg: {} },
      { ...makeConfig(), target: {} },
      { ...makeConfig(), settings: { ...makeConfig().settings, overlapCss: 'x' } },
    ];
    for (const config of bad) {
      const h = createHarness();
      h.sandbox.__spool.config = config;
      h.start();
      assert.equal(h.overlays.length, 0);
      assert.equal(h.agent().isActive(), false);
      assert.deepEqual(h.sent, []);
    }
  });

  it('does nothing when page-lib or overlay is missing, and never throws', () => {
    for (const key of ['lib', 'overlay']) {
      const h = createHarness();
      delete h.sandbox.__spool[key];
      assert.doesNotThrow(() => h.start());
      assert.equal(h.overlays.length, 0);
      assert.equal(h.agent().isActive(), false);
    }
  });

  it('closes cleanly when the overlay cannot start', () => {
    const h = createHarness();
    h.sandbox.__spool.overlay = {
      createOverlay: () => {
        throw new Error('no overlay');
      },
    };
    assert.doesNotThrow(() => h.start());
    assert.equal(h.agent().isActive(), false);
  });

  it('shows the selection overlay and is active', () => {
    const h = createHarness();
    h.start();
    assert.equal(h.overlays.length, 1);
    assert.equal(h.overlay().beginSelectCalls, 1);
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.listeners.get('pagehide')?.size, 1);
    assert.deepEqual(h.sent, []);
  });

  it('start() while a session is active does nothing', () => {
    const h = createHarness();
    h.start();
    h.start();
    assert.equal(h.overlays.length, 1);
  });

  it('is restartable after close, with a new config', async () => {
    const h = createHarness();
    await h.begin();
    await h.cmd('done');
    assertRestored(h);
    const firstOverlay = h.overlay();

    h.scroller.style = {};
    await h.begin(makeConfig({}, SESSION_B));
    assert.equal(h.overlays.length, 2);
    assert.notEqual(h.overlay(), firstOverlay);
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.listeners.get('pagehide')?.size, 1);
    const open = h.messages(MSG.PAGE_SESSION_OPEN).at(-1);
    assert.equal(open?.['sessionId'], SESSION_B);
    assert.equal(h.messages(MSG.PAGE_CAPTURE_FRAME).at(-1)?.['sessionId'], SESSION_B);
    assert.equal(firstOverlay.destroyCalls, 1, 'the old overlay stays closed');
    await h.cmd('cancel');
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.agent().isActive(), false);
  });

  it('is restartable after a cancel and after an invalidated context', async () => {
    const h = createHarness();
    await h.begin();
    await h.cmd('cancel');
    await h.begin(makeConfig({}, SESSION_B));
    h.runtime.id = undefined;
    assert.equal(h.agent().isActive(), false);
    h.runtime.id = 'ext-id';
    await h.begin(makeConfig({}, SESSION_A));
    assert.equal(h.overlays.length, 3);
    assert.equal(h.agent().isActive(), true);
  });
});

describe('agent.js: selecting an area', () => {
  it('rejects a region outside the scroll area and stays in select mode', async () => {
    const h = createHarness();
    h.start();
    await h.select({ x: 0, y: 0, width: 50, height: 50 });
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, 'Select an area inside the page.');
    assert.equal(h.overlay().beginSelectCalls, 2, 'select mode is entered again');
    assert.deepEqual(h.sent, []);
    assert.equal(h.jar().sets.length, 0);
    assert.equal(h.agent().isActive(), true);
    await h.select(REGION); // a valid region is accepted afterwards
    assert.deepEqual(h.types(), [MSG.PAGE_SESSION_OPEN, MSG.PAGE_CAPTURE_FRAME]);
  });

  it('clips the region to the scroll target and sends the same rect every frame', async () => {
    const h = createHarness();
    h.start();
    // Starts left of and above the box: clipped to the box corner.
    await h.select({ x: 50, y: 50, width: 300, height: 300 });
    const rect = { x: 100, y: 100, width: 250, height: 250 };
    assert.deepEqual(h.overlay().sessions, [rect]);
    await h.cmd('down');
    await h.cmd('down');
    for (const meta of h.frames()) assert.deepEqual(meta.rect, rect);
  });

  it('returns to select mode with the message when the service worker refuses', async () => {
    const h = createHarness();
    const refusal = errorReply(ERR.CAPTURE_FAILED, 'This page cannot be captured.');
    h.queue(MSG.PAGE_SESSION_OPEN, refusal);
    h.start();
    await h.select();
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, 'This page cannot be captured.');
    assert.equal(h.overlay().beginSelectCalls, 2);
    assert.equal(h.jar().sets.length, 0, 'the page is not touched');
    assert.deepEqual(h.overlay().sessions, []);
    assert.equal(h.agent().isActive(), true);
    await h.cmd('cancel');
    assert.deepEqual(h.types(), [MSG.PAGE_SESSION_OPEN], 'nothing was opened: no cancel message');
  });

  it('sends the title cut to 200 characters', async () => {
    const h = createHarness();
    h.doc.title = 'x'.repeat(300);
    await h.begin();
    assert.equal(h.messages(MSG.PAGE_SESSION_OPEN)[0]?.['title'], 'x'.repeat(200));
  });

  it('cancel during selection closes without any message', async () => {
    const h = createHarness({ scrollTop: 123 });
    h.start();
    await h.cmd('cancel');
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.scrollLog, [], 'no scroll was set: nothing to restore');
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.agent().isActive(), false);
  });

  it('ignores step commands during selection', async () => {
    const h = createHarness();
    h.start();
    for (const c of /** @type {OverlayCommand[]} */ (['down', 'up', 'auto'])) await h.cmd(c);
    assert.deepEqual(h.sent, []);
    assert.equal(h.agent().isActive(), true);
  });
});

describe('agent.js: stepping', () => {
  it('captures the initial frame, steps down to the end, and finishes', async () => {
    const h = createHarness({ scrollTop: 450 });
    await h.begin();

    assert.deepEqual(h.types(), [MSG.PAGE_SESSION_OPEN, MSG.PAGE_CAPTURE_FRAME]);
    assert.deepEqual(h.sent[0], {
      v: 1,
      target: 'sw',
      type: 'page/session-open',
      sessionId: SESSION_A,
      title: 'Test page',
    });
    assert.deepEqual(h.frames()[0], {
      direction: 'initial',
      viewport: { width: 1000, height: 800 },
      rect: REGION,
      contentY: 470, // scrollTop 450 + rect.y 120 - box.y 100
    });
    assert.deepEqual(h.overlay().sessions, [REGION]);
    // scroll-behavior and scrollbar-width are set on the scroll target and on <html>; the old
    // state is saved.
    assert.deepEqual(
      h.jar().sets.map((s) => [s.el.name, s.prop, s.value]),
      [
        ['scroller', 'scroll-behavior', 'auto'],
        ['html', 'scroll-behavior', 'auto'],
        ['scroller', 'scrollbar-width', 'none'],
        ['html', 'scrollbar-width', 'none'],
        ['footer', 'visibility', 'hidden'],
        ['divider', 'position', 'static'],
      ],
    );
    assert.deepEqual(h.overlay().status, {
      slices: 1,
      heightPx: 600,
      tiles: 1,
      auto: false,
      finishing: false,
      level: 'info',
      message: '',
      progress: 0.225, // scrollTop 450 of 2000
      atEnd: false,
    });

    // Scroll tops 750, 1050, 1350, 1650, 1950, then 2000 (clamped: moves 50).
    for (let i = 0; i < 6; i += 1) await h.cmd('down');
    assert.deepEqual(
      h.frames().map((f) => [f.direction, f.contentY]),
      [
        ['initial', 470],
        ['down', 770],
        ['down', 1070],
        ['down', 1370],
        ['down', 1670],
        ['down', 1970],
        ['down', 2020],
      ],
    );
    assert.equal(h.overlay().status.slices, 7);
    assert.equal(h.overlay().status.heightPx, 7 * 600);
    assertAtEnd(h); // the last frame was taken at the bottom of the range

    // At the end: nothing moves, so no frame is sent.
    await h.cmd('down');
    assert.equal(h.frames().length, 7);
    assertAtEnd(h);
    assert.equal(h.overlay().status.auto, false);
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.overlay().busy.at(-1), false, 'the step buttons are enabled again');

    await h.cmd('done');
    assert.equal(h.mainTypes().at(-1), MSG.PAGE_FINISH);
    assert.deepEqual(h.messages(MSG.PAGE_FINISH)[0], {
      v: 1,
      target: 'sw',
      type: 'page/finish',
      sessionId: SESSION_A,
    });
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0);
    assertRestored(h);
    assert.ok(h.sleeps.every((ms) => ms === 7), 'waits settleMs after every scroll');
  });

  it('sends messages that pass routeCheck in the service worker', async () => {
    const h = createHarness({ scrollTop: 900 });
    await h.begin();
    await h.cmd('down');
    await h.cmd('up');
    await h.cmd('done');
    assert.equal(h.sent.length, 6, 'open, three frames, finish, get-clipboard');
    for (const msg of h.sent) {
      const checked = routeCheck(msg, SENDER, TARGET.SW, ENV);
      assert.ok(checked && checked.ok === true, JSON.stringify([msg['type'], checked]));
      assert.equal(/** @type {any} */ (checked).kind, 'content');
    }
  });

  it('steps up and prepends, down to the top', async () => {
    const h = createHarness({ scrollTop: 1000 });
    await h.begin();
    for (let i = 0; i < 5; i += 1) await h.cmd('up'); // 700, 400, 100, 0 (clamped), then no move
    assert.deepEqual(
      h.frames().map((f) => [f.direction, f.contentY]),
      [
        ['initial', 1020],
        ['up', 720],
        ['up', 420],
        ['up', 120],
        ['up', 20],
      ],
    );
    assert.equal(h.overlay().status.message, 'Reached the top.');
    assert.equal(h.page.scrollTop, 0);
    await h.cmd('done');
    assertRestored(h);
    assert.equal(h.page.scrollTop, 1000);
  });

  it('keeps a minimum scroll step of 8 px when the overlap is large', async () => {
    const h = createHarness();
    await h.begin(makeConfig({ overlapCss: 400 })); // rect.height 400 - 400 = 0 -> 8
    await h.cmd('down');
    assert.equal(h.page.scrollTop, 8);
    assert.equal(h.frames()[1]?.contentY, 28);
  });

  it('stops at the length limit and then refuses more steps', async () => {
    const h = createHarness();
    // 400 -> 700 -> 1000 covered: the second step reaches maxHeightCss.
    await h.begin(makeConfig({ maxHeightCss: 1000 }));
    await h.cmd('auto');
    assert.equal(h.frames().length, 3);
    assert.equal(h.overlay().status.message, 'Reached the length limit.');
    assert.equal(h.overlay().status.level, 'warn');
    assert.equal(h.overlay().status.auto, false);
    const scrollTop = h.page.scrollTop;
    await h.cmd('down');
    await h.cmd('up');
    await h.cmd('auto');
    assert.equal(h.frames().length, 3, 'no more frames');
    assert.equal(h.page.scrollTop, scrollTop, 'the page does not scroll any more');
    assert.equal(h.overlay().status.message, 'Reached the length limit.');
    await h.cmd('done');
    assert.equal(h.mainTypes().at(-1), MSG.PAGE_FINISH);
  });

  it('covers the length limit with prepended frames too', async () => {
    const h = createHarness({ scrollTop: 1000 });
    await h.begin(makeConfig({ maxHeightCss: 1000 }));
    await h.cmd('up');
    await h.cmd('up');
    assert.equal(h.frames().length, 3);
    assert.equal(h.overlay().status.message, 'Reached the length limit.');
  });

  it('shows a warning for an unmatched seam and none for a duplicate', async () => {
    const h = createHarness();
    h.queue(
      MSG.PAGE_CAPTURE_FRAME,
      DEFAULT,
      () => h.intake('unmatched'),
      () => h.intake('duplicate'),
    );
    await h.begin();
    await h.cmd('down');
    assert.equal(h.overlay().status.level, 'warn');
    assert.equal(h.overlay().status.message, 'Spool could not verify the last seam.');
    await h.cmd('down');
    assert.equal(h.overlay().status.level, 'info');
    assert.equal(h.overlay().status.message, '');
    assert.equal(h.overlay().status.slices, 2, 'a duplicate adds no slice');
  });

  it('refuses to capture when the rect no longer fits the viewport', async () => {
    const h = createHarness();
    await h.begin();
    h.sandbox.innerWidth = 300;
    await h.cmd('down');
    assert.equal(h.frames().length, 1);
    assert.equal(h.overlay().status.level, 'error');
    assert.match(h.overlay().status.message, /window size changed/i);
    assert.equal(h.agent().isActive(), true);
    await h.cmd('cancel');
    assertRestored(h);
  });
});

describe('agent.js: auto', () => {
  it('scrolls to the end, then stops', async () => {
    const h = createHarness();
    await h.begin();
    await h.cmd('auto');
    // Scroll tops 300 ... 1800, then 2000 (clamped), then no move.
    assert.deepEqual(
      h.frames().map((f) => f.contentY),
      [20, 320, 620, 920, 1220, 1520, 1820, 2020],
    );
    assert.ok(h.frames().slice(1).every((f) => f.direction === 'down'));
    assertAtEnd(h);
    assert.equal(h.overlay().status.auto, false);
    assert.equal(h.overlay().status.slices, 8);
    assert.ok(
      h.overlay().statuses.some((s) => s.auto && s.slices >= 2),
      'the status shows auto while it runs',
    );
    assert.equal(h.agent().isActive(), true);
    // Auto keeps the buttons enabled so that it can be toggled off.
    assert.deepEqual(h.overlay().busy, [true, false, false, false]);
    await h.cmd('done');
    assertRestored(h);
  });

  it('Auto toggles off after the current step', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => slow.promise);
    await h.begin();
    await h.cmd('auto');
    assert.equal(h.frames().length, 2, 'step 1 waits for its reply');
    await h.cmd('auto'); // toggle off
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.frames().length, 2, 'no further step');
    assert.equal(h.overlay().status.auto, false);
    assert.equal(h.overlay().status.slices, 2);
    assert.equal(h.agent().isActive(), true);
    await h.cmd('down'); // manual steps work again
    assert.equal(h.frames().length, 3);
  });

  it('Done during auto stops after the current step, then finishes', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, DEFAULT, () => slow.promise);
    await h.begin();
    await h.cmd('auto');
    assert.equal(h.frames().length, 3, 'step 2 waits for its reply');
    await h.cmd('done');
    assert.equal(h.overlay().status.message, MSG_STOPPING);
    assert.equal(h.types().at(-1), MSG.PAGE_CAPTURE_FRAME, 'not finished yet');
    assert.equal(h.overlay().destroyCalls, 0);
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.frames().length, 3, 'no step 3');
    assert.equal(h.mainTypes().at(-1), MSG.PAGE_FINISH);
    assertRestored(h);
  });

  it('Cancel during auto closes after the current step and sends cancel', async () => {
    const h = createHarness({ scrollTop: 77 });
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => slow.promise);
    await h.begin();
    await h.cmd('auto');
    await h.cmd('cancel');
    assert.equal(h.overlay().destroyCalls, 0, 'waits for the step');
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.frames().length, 2);
    assert.equal(h.types().at(-1), MSG.PAGE_CANCEL);
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 0);
    assertRestored(h);
  });

  it('Cancel overrides a pending Done', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => slow.promise);
    await h.begin();
    await h.cmd('down');
    await h.cmd('done');
    await h.cmd('cancel');
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 0);
    assert.equal(h.types().at(-1), MSG.PAGE_CANCEL);
    assertRestored(h);
  });

  it('stops after three frames in a row that add nothing', async () => {
    const h = createHarness();
    const dup = () => h.intake('duplicate');
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, dup, dup, dup);
    await h.begin();
    await h.cmd('auto');
    assert.equal(h.frames().length, 4);
    assert.equal(h.overlay().status.message, 'No new content found.');
    assert.equal(h.overlay().status.slices, 1);
  });

  it('continues after a single duplicate', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => h.intake('duplicate'));
    await h.begin();
    await h.cmd('auto');
    assertAtEnd(h);
    assert.equal(h.frames().length, 8);
  });
});

describe('agent.js: busy flag', () => {
  it('ignores step and auto commands during the initial capture', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, () => slow.promise);
    await h.begin();
    for (const c of /** @type {OverlayCommand[]} */ (['down', 'up', 'auto', 'down'])) {
      await h.cmd(c);
    }
    assert.equal(h.frames().length, 1);
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.frames().length, 1, 'ignored commands are not replayed');
    assert.deepEqual(h.overlay().busy, [true, false]);
    await h.cmd('down');
    assert.equal(h.frames().length, 2);
  });

  it('runs one step at a time', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => slow.promise);
    await h.begin();
    await h.cmd('down');
    await h.cmd('down');
    await h.cmd('up');
    await h.cmd('auto');
    assert.equal(h.frames().length, 2);
    assert.equal(h.page.scrollTop, STEP, 'only the first step scrolled');
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.frames().length, 2);
    assert.equal(h.page.scrollTop, STEP);
    assert.equal(h.overlay().busy.at(-1), false);
  });
});

describe('agent.js: a frame that failed is captured again before the page scrolls on', () => {
  /** [direction, contentY] of every capture-frame message. @param {ReturnType<typeof createHarness>} h */
  const frameLog = (h) => h.frames().map((f) => [f.direction, f.contentY]);

  it('manual: the next step captures at the current position, then scrolls', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, errorReply(ERR.CAPTURE_FAILED, 'Failed.'));
    await h.begin();
    await h.cmd('down'); // scrolls to 300, its capture fails
    assert.equal(h.page.scrollTop, STEP);
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.slices, 1, 'only the initial frame is stored');

    const scrolls = h.scrollLog.length;
    await h.cmd('down');
    assert.deepEqual(frameLog(h), [
      ['initial', 20],
      ['down', 320], // failed
      ['down', 320], // again, at the same position
      ['down', 620], // the step that was asked for
    ]);
    assert.deepEqual(h.scrollLog.slice(scrolls), [2 * STEP], 'one scroll, after the capture');
    assert.equal(h.overlay().status.slices, 3);
    assert.equal(h.overlay().status.level, 'info');
    // From now on steps are single again.
    await h.cmd('down');
    assert.equal(h.frames().length, 5);
    await h.cmd('cancel');
    assertRestored(h);
  });

  it('manual: a capture that fails again does not scroll', async () => {
    const h = createHarness();
    const failed = errorReply(ERR.CAPTURE_FAILED, 'Failed.');
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, failed, failed);
    await h.begin();
    await h.cmd('down'); // scrolls to 300, fails
    const scrolls = h.scrollLog.length;
    await h.cmd('down'); // captures again, fails again
    assert.deepEqual(h.scrollLog.slice(scrolls), [], 'no scroll while the frame is missing');
    assert.equal(h.page.scrollTop, STEP);
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, 'Failed.');
    await h.cmd('down'); // now it works: the frame first, then the step
    assert.deepEqual(frameLog(h), [
      ['initial', 20],
      ['down', 320],
      ['down', 320],
      ['down', 320],
      ['down', 620],
    ]);
    assert.deepEqual(h.scrollLog.slice(scrolls), [2 * STEP]);
  });

  it('manual: the frame is captured again in the direction it was taken', async () => {
    const h = createHarness({ scrollTop: 1000 });
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, errorReply(ERR.CAPTURE_FAILED, 'Failed.'));
    await h.begin();
    await h.cmd('up'); // scrolls to 700, fails
    await h.cmd('down'); // the user asks for the other direction
    assert.deepEqual(frameLog(h), [
      ['initial', 1020],
      ['up', 720],
      ['up', 720], // the missed frame, as it was meant: an up frame
      ['down', 1020],
    ]);
  });

  it('auto: paused on E_TAB_NOT_VISIBLE, the next Auto captures the missed frame first', async () => {
    const h = createHarness();
    h.queue(
      MSG.PAGE_CAPTURE_FRAME,
      DEFAULT,
      DEFAULT,
      errorReply(ERR.TAB_NOT_VISIBLE, 'The tab is not visible.'),
    );
    await h.begin();
    await h.cmd('auto'); // frames at 20 and 320; the one at 620 fails: auto stops
    assert.equal(h.overlay().status.message, 'Go back to this tab to continue.');
    assert.equal(h.page.scrollTop, 2 * STEP);
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.overlay().status.auto, false);

    const scrolls = h.scrollLog.length;
    await h.cmd('auto'); // runs to the end
    assert.deepEqual(frameLog(h), [
      ['initial', 20],
      ['down', 320],
      ['down', 620], // failed
      ['down', 620], // again, before any scroll
      ['down', 920],
      ['down', 1220],
      ['down', 1520],
      ['down', 1820],
      ['down', 2020], // clamped at the end of the content
    ]);
    // The first scroll of the second run came after the retry (to 3 * STEP).
    assert.equal(h.scrollLog[scrolls], 3 * STEP);
    assertAtEnd(h);
    await h.cmd('done');
    assert.equal(h.mainTypes().at(-1), MSG.PAGE_FINISH);
  });

  it('auto: a capture that fails again stops Auto without a scroll', async () => {
    const h = createHarness();
    const hidden = errorReply(ERR.TAB_NOT_VISIBLE, 'The tab is not visible.');
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, hidden, hidden);
    await h.begin();
    await h.cmd('auto'); // the frame at 320 fails
    assert.equal(h.page.scrollTop, STEP);
    const scrolls = h.scrollLog.length;
    await h.cmd('auto'); // the retry fails again
    assert.deepEqual(h.scrollLog.slice(scrolls), []);
    assert.equal(h.page.scrollTop, STEP);
    assert.equal(h.overlay().status.message, 'Go back to this tab to continue.');
    assert.equal(h.agent().isActive(), true);
  });

  it('an exception while capturing also leaves the frame to be captured again', async () => {
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    h.scan.fail = true;
    await h.cmd('down'); // scrolls to 800, throws before the frame is sent
    h.scan.fail = false;
    await h.cmd('down');
    assert.deepEqual(frameLog(h), [
      ['initial', 520],
      ['down', 820], // no frame was sent for the failed try
      ['down', 1120],
    ]);
  });

  it('a duplicate that the service worker accepted is not captured again', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => h.intake('duplicate'));
    await h.begin();
    await h.cmd('down');
    await h.cmd('down');
    assert.deepEqual(
      h.frames().map((f) => f.contentY),
      [20, 320, 620],
    );
  });
});

describe('agent.js: errors', () => {
  it('E_TAB_NOT_VISIBLE pauses auto with a warning', async () => {
    const h = createHarness();
    const tab = errorReply(ERR.TAB_NOT_VISIBLE, 'The tab is not visible.');
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, DEFAULT, tab);
    await h.begin();
    await h.cmd('auto');
    assert.equal(h.frames().length, 3, 'auto stops at the failed frame');
    assert.deepEqual(h.overlay().status, {
      slices: 2,
      heightPx: 1200,
      tiles: 1,
      auto: false,
      finishing: false,
      level: 'warn',
      message: 'Go back to this tab to continue.',
      progress: 0.3, // the page is at 600 of 2000
      atEnd: false,
    });
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.overlay().destroyCalls, 0);
    // Continue: the failed frame is captured again at the same position (same
    // contentY: no scroll in between), and only then does the step scroll on.
    await h.cmd('down');
    assert.deepEqual(
      h.frames().map((f) => [f.contentY]),
      [
        [20],
        [320],
        [620],
        [620],
        [920],
      ],
    );
    assert.equal(h.overlay().status.level, 'info');
    await h.cmd('done');
    assert.equal(h.mainTypes().at(-1), MSG.PAGE_FINISH);
  });

  it('retries the initial frame first when it failed', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, errorReply(ERR.TAB_NOT_VISIBLE, 'Hidden.'));
    await h.begin();
    assert.equal(h.overlay().status.message, 'Go back to this tab to continue.');
    assert.equal(h.overlay().status.slices, 0);
    await h.cmd('down');
    assert.deepEqual(
      h.frames().map((f) => [f.direction, f.contentY]),
      [
        ['initial', 20],
        ['initial', 20],
        ['down', 320],
      ],
    );
  });

  it('Done with nothing captured says so and stays open, then Cancel closes it', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, errorReply(ERR.TAB_NOT_VISIBLE, 'Hidden.'));
    await h.begin();
    await h.cmd('done');
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 0);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0);
    assert.equal(h.overlay().destroyCalls, 0, 'the HUD stays');
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, 'Nothing was captured yet. Scroll once, or Cancel.');
    await h.cmd('cancel');
    assert.equal(h.types().at(-1), MSG.PAGE_CANCEL);
    assertRestored(h);
  });

  for (const end of /** @type {const} */ (['done', 'cancel'])) {
    it(`a capture error shows the message and keeps Done and Cancel (${end})`, async () => {
      const h = createHarness();
      h.queue(
        MSG.PAGE_CAPTURE_FRAME,
        DEFAULT,
        errorReply(ERR.CAPTURE_FAILED, 'The capture failed. Try again.'),
      );
      await h.begin();
      await h.cmd('down');
      assert.equal(h.overlay().status.level, 'error');
      assert.equal(h.overlay().status.message, 'The capture failed. Try again.');
      assert.equal(h.agent().isActive(), true);
      assert.equal(h.overlay().busy.at(-1), false);
      assert.equal(h.overlay().destroyCalls, 0);
      await h.cmd(end);
      assert.equal(h.mainTypes().at(-1), end === 'done' ? MSG.PAGE_FINISH : MSG.PAGE_CANCEL);
      assertRestored(h);
    });
  }

  it('treats a missing, malformed or incomplete reply as an error', async () => {
    const replies = [undefined, {}, { ok: 'yes' }, { ok: true }, { ok: true, intake: {} }, null, 7];
    for (const bad of replies) {
      const h = createHarness();
      h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, bad);
      await h.begin();
      await h.cmd('down');
      assert.equal(h.overlay().status.level, 'error', JSON.stringify(bad));
      assert.ok(h.overlay().status.message.length > 0);
      assert.equal(h.overlay().status.slices, 1, 'the bad reply is not counted');
      assert.equal(h.agent().isActive(), true);
    }
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, undefined);
    await h.begin();
    await h.cmd('down');
    assert.equal(h.overlay().status.message, MSG_UNREACHABLE);
  });

  it('shows a generic message for an error reply without a message', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, { ok: false });
    await h.begin();
    await h.cmd('down');
    assert.equal(h.overlay().status.message, MSG_GENERIC);
  });

  it('shows a short message when sendMessage fails for another reason', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => {
      throw new Error('Could not establish connection. Receiving end does not exist.');
    });
    await h.begin();
    await h.cmd('down');
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, MSG_UNREACHABLE);
    assert.equal(h.agent().isActive(), true, 'only an invalid context closes the session');
  });

  it('shows a generic message and stays open when page-lib throws', async () => {
    const h = createHarness();
    await h.begin();
    // The agent holds the lib object it got at start(): break a function on that object.
    h.sandbox.__spool.lib.setScrollTop = () => {
      throw new Error('detached');
    };
    await h.cmd('down');
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, MSG_GENERIC);
    assert.equal(h.agent().isActive(), true);
    assert.ok(h.events.at(-1) !== 'destroy');
    await h.cmd('cancel');
    assert.equal(h.overlay().destroyCalls, 1);
  });

  it('keeps the session when the service worker refuses Done; a retry finishes', async () => {
    const h = createHarness();
    h.queue(
      MSG.PAGE_FINISH,
      errorReply(ERR.SESSION_NOT_FOUND, 'The capture was not found.'),
      DEFAULT,
    );
    await h.begin();
    await h.cmd('done');
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, 'The capture was not found.');
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.overlay().destroyCalls, 0);
    assert.equal(h.overlay().busy.at(-1), false);
    await h.cmd('done');
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 2);
    assertRestored(h);
  });
});

describe('agent.js: invalid extension context', () => {
  /** @param {ReturnType<typeof createHarness>} h */
  function assertClosedWithoutMessage(h) {
    assertRestored(h);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0, 'the extension is gone: nothing to tell');
  }

  it('closes and restores when sendMessage throws "Extension context invalidated"', async () => {
    const h = createHarness({ scrollTop: 300 });
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => {
      h.runtime.id = undefined;
      throw new Error('Extension context invalidated.');
    });
    await h.begin();
    await h.cmd('down');
    assertClosedWithoutMessage(h);
  });

  it('closes and restores when the sendMessage promise rejects', async () => {
    const h = createHarness({ scrollTop: 300 });
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () =>
      Promise.reject(new Error('Extension context invalidated.')),
    );
    await h.begin();
    await h.cmd('auto');
    assertClosedWithoutMessage(h);
  });

  it('closes when the context is invalid during session-open', async () => {
    const h = createHarness({ scrollTop: 300 });
    h.queue(MSG.PAGE_SESSION_OPEN, () => {
      throw new Error('Extension context invalidated.');
    });
    h.start();
    await h.select();
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.agent().isActive(), false);
    assert.equal(h.jar().sets.length, 0);
  });

  it('isActive() is false and restores the page when chrome.runtime.id is gone', async () => {
    const h = createHarness({ scrollTop: 300 });
    await h.begin();
    await h.cmd('down');
    h.runtime.id = undefined;
    assert.equal(h.agent().isActive(), false);
    assertClosedWithoutMessage(h);
  });

  it('closes on the next command when chrome.runtime.id is gone', async () => {
    const h = createHarness({ scrollTop: 300 });
    await h.begin();
    h.runtime.id = undefined;
    await h.cmd('down');
    assertClosedWithoutMessage(h);
    assert.equal(h.frames().length, 1);
  });

  it('closes when the whole chrome object is gone', async () => {
    const h = createHarness();
    await h.begin();
    h.sandbox.chrome = undefined;
    assert.equal(h.agent().isActive(), false);
    assert.equal(h.overlay().destroyCalls, 1);
  });
});

describe('agent.js: pagehide and idempotent close', () => {
  it('pagehide closes the session, restores the page and tells the service worker', async () => {
    const h = createHarness({ scrollTop: 250 });
    await h.begin();
    await h.cmd('down');
    await h.pageHide();
    assertRestored(h);
    assert.equal(h.types().at(-1), MSG.PAGE_CANCEL);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 1);
  });

  it('pagehide during selection sends no message', async () => {
    const h = createHarness();
    h.start();
    await h.pageHide();
    assert.deepEqual(h.sent, []);
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.agent().isActive(), false);
  });

  it('pagehide during a step: the step ends quietly and the page stays restored', async () => {
    const h = createHarness({ scrollTop: 250 });
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => slow.promise);
    await h.begin();
    await h.cmd('auto');
    await h.pageHide();
    assertRestored(h);
    const scrolls = h.scrollLog.length;
    const sentBefore = h.sent.length;
    const eventsBefore = h.events.length;
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.scrollLog.length, scrolls, 'no scroll after close');
    assert.equal(h.sent.length, sentBefore, 'no message after close');
    assert.equal(h.events.length, eventsBefore, 'no overlay call after close');
    assert.equal(h.page.scrollTop, 250);
  });

  it('pagehide while finishing does not send cancel', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_FINISH, () => slow.promise);
    await h.begin();
    await h.cmd('done');
    assert.equal(h.overlay().destroyCalls, 0);
    await h.pageHide();
    assertRestored(h);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0);
    slow.resolve({ ok: true });
    await flush();
    assert.equal(h.overlay().destroyCalls, 1);
  });

  it('Cancel while finishing does nothing: the save completes and the toast shows', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_FINISH, () => slow.promise);
    await h.begin();
    await h.cmd('done');
    assert.equal(h.overlay().status.finishing, true, 'the overlay is told: Cancel is off');
    assert.equal(h.overlay().destroyCalls, 0);
    await h.cmd('cancel');
    assert.equal(h.overlay().destroyCalls, 0, 'the overlay stays until the save ends');
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0);
    assert.equal(h.toast.shown.length, 0);
    slow.resolve({ ok: true, summary: SUMMARY });
    await flush();
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.toast.shown.length, 1, 'the person gets the result');
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0);
    assert.equal(h.messages(MSG.PAGE_GET_CLIPBOARD).length, 1, 'and the copy goes on');
  });

  it('Cancel pressed twice while finishing is ignored both times', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_FINISH, () => slow.promise);
    await h.begin();
    await h.cmd('done');
    await h.cmd('cancel');
    await h.cmd('cancel');
    assert.equal(h.overlay().destroyCalls, 0);
    slow.resolve({ ok: true, summary: SUMMARY });
    await flush();
    assert.equal(h.toast.shown.length, 1);
  });

  it('a Done that fails turns Cancel on again', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_FINISH, errorReply(ERR.INTERNAL, 'Could not save the files.'));
    await h.begin();
    await h.cmd('done');
    assert.equal(h.overlay().status.finishing, false);
    assert.equal(h.overlay().status.level, 'error');
    await h.cmd('cancel');
    assertRestored(h);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 1);
  });

  it('a save that never answers ends at the time limit, and Cancel works again', async () => {
    const h = createHarness();
    const never = deferred();
    h.queue(MSG.PAGE_FINISH, () => never.promise);
    await h.begin();
    let now = 1_000_000;
    h.sandbox.Date = { now: () => now };
    await h.cmd('done');
    now += 179_000;
    await h.tick();
    assert.equal(h.overlay().status.finishing, true, 'still waiting just before the limit');
    assert.equal(h.agent().isActive(), true);
    now += 2_000;
    await h.tick();
    assert.equal(h.overlay().status.finishing, false);
    assert.equal(h.overlay().status.level, 'error');
    assert.match(h.overlay().status.message, /taking too long/);
    assert.equal(h.agent().isActive(), true, 'the overlay stays, with a way out');
    assert.equal(h.toast.shown.length, 0);
    assert.equal(h.messages(MSG.PAGE_GET_CLIPBOARD).length, 0, 'and nothing is copied later');
    await h.cmd('cancel');
    assertRestored(h);
    assert.equal(h.agent().isActive(), false);
    never.resolve({ ok: true, summary: SUMMARY });
    await flush();
    assert.equal(h.toast.shown.length, 0, 'the late answer is ignored');
  });

  it('pagehide while the service worker opens the session cancels it when it answers', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_SESSION_OPEN, () => slow.promise);
    h.start();
    await h.select();
    await h.pageHide();
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0, 'nothing was open yet');
    slow.resolve({ ok: true });
    await flush();
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 1);
    assert.equal(h.frames().length, 0);
    assert.deepEqual(h.overlay().sessions, []);
    assert.equal(h.jar().sets.length, 0);
  });

  it('Cancel while the service worker opens the session closes after the answer', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_SESSION_OPEN, () => slow.promise);
    h.start();
    await h.select();
    await h.cmd('cancel');
    assert.equal(h.overlay().destroyCalls, 0);
    slow.resolve({ ok: true });
    await flush();
    assert.equal(h.types().at(-1), MSG.PAGE_CANCEL);
    assert.equal(h.frames().length, 0, 'no frame for a cancelled session');
    assert.deepEqual(h.overlay().sessions, []);
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.agent().isActive(), false);
  });

  it('Cancel while a step runs waits for the step, then restores', async () => {
    const h = createHarness({ scrollTop: 500 });
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => slow.promise);
    await h.begin();
    await h.cmd('down');
    await h.cmd('cancel');
    assert.equal(h.overlay().status.message, MSG_STOPPING);
    assert.equal(h.overlay().destroyCalls, 0);
    assert.equal(h.page.scrollTop, 500 + STEP, 'the page is not restored mid-step');
    slow.resolve(h.intake());
    await flush();
    assertRestored(h);
    assert.equal(h.types().at(-1), MSG.PAGE_CANCEL);
  });

  it('hides the scrollbar of the area for the whole session, and puts it back', async () => {
    // An overlay scrollbar is drawn over the content: it would be in every frame, at a new height.
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    assert.equal(h.scroller.style['scrollbar-width'], 'none');
    assert.equal(h.root.style['scrollbar-width'], 'none');
    const set = h.jar().sets.findIndex((x) => x.prop === 'scrollbar-width');
    assert.ok(set >= 0, 'through the style jar');
    assert.deepEqual(h.types().slice(0, 2), [MSG.PAGE_SESSION_OPEN, MSG.PAGE_CAPTURE_FRAME]);
    await h.cmd('cancel');
    assertRestored(h);
  });

  it('Cancel restores everything: scroll, styles, hidden and released elements, overlay', async () => {
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    await h.cmd('down');
    await h.cmd('down');
    assert.equal(h.footer.style['visibility'], 'hidden');
    assert.equal(h.divider.style['position'], 'static');
    assert.equal(h.scroller.style['scroll-behavior'], 'auto');
    await h.cmd('cancel');
    assert.equal(h.types().at(-1), MSG.PAGE_CANCEL);
    assert.deepEqual(h.sent.at(-1), {
      v: 1,
      target: 'sw',
      type: 'page/cancel',
      sessionId: SESSION_A,
    });
    assertRestored(h);
  });

  it('restore runs exactly once however many ways close at the same session', async () => {
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    await h.cmd('down');
    await h.cmd('cancel');
    const scrolls = h.scrollLog.length;
    const sentBefore = h.sent.length;
    await h.cmd('cancel');
    await h.cmd('done');
    await h.cmd('down');
    await h.cmd('auto');
    await h.pageHide();
    h.runtime.id = undefined;
    h.agent().isActive();
    assertRestored(h);
    assert.equal(h.scrollLog.length, scrolls, 'the scroll position was restored once');
    assert.equal(h.scrollLog.at(-1), 500);
    assert.equal(h.sent.length, sentBefore, 'cancel was sent once');
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 1);
  });

  it('restores the rest of the page when one restore step throws', async () => {
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    await h.cmd('down');
    h.jar().restoreAll = () => {
      throw new Error('jar failed');
    };
    h.overlay().destroy = () => {
      throw new Error('destroy failed');
    };
    await h.cmd('cancel');
    assert.equal(h.page.scrollTop, 500);
    assert.equal(h.agent().isActive(), false);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 1);
  });
});

describe('agent.js: fixed and sticky elements', () => {
  it('frees them before every capture, from the first frame on', async () => {
    const h = createHarness();
    await h.begin();
    // One scanner for the session. It ignores the overlay host and knows the scroll target.
    assert.equal(h.scannerCalls.length, 1);
    assert.equal(h.scannerCalls[0]?.ignore, h.overlay().host, 'the overlay host is ignored');
    assert.equal(h.scannerCalls[0]?.target, h.target);
    assert.deepEqual(h.collectCalls, [REGION], 'the first frame already looks at the area');
    // Order: free the elements, hide the overlay, capture, show the overlay.
    const start = h.events.indexOf('collect');
    assert.deepEqual(h.events.slice(start, start + 4), [
      'collect',
      'hideForCapture',
      `send:${MSG.PAGE_CAPTURE_FRAME}`,
      'showAfterCapture',
    ]);
    // A fixed element is hidden, a sticky one is put back in the flow. Never the other way round.
    assert.equal(h.footer.style['visibility'], 'hidden');
    assert.equal(h.footer.style['position'], undefined);
    assert.equal(h.divider.style['position'], 'static');
    assert.equal(h.divider.style['visibility'], undefined, 'a sticky element must not become a gap');

    await h.cmd('down');
    await h.cmd('down');
    assert.deepEqual(h.collectCalls, [REGION, REGION, REGION], 'looked at again before each frame');
    assert.equal(h.scannerCalls.length, 1, 'the full scan is made once per session');
    for (const [el, prop, value] of /** @type {const} */ ([
      ['footer', 'visibility', 'hidden'],
      ['divider', 'position', 'static'],
    ])) {
      const sets = h.jar().sets.filter((x) => x.el.name === el);
      assert.deepEqual(
        sets.map((x) => [x.prop, x.value]),
        [[prop, value], [prop, value], [prop, value]],
      );
    }
    await h.cmd('done');
    assertRestored(h);
  });

  it('frees elements that appear while the page scrolls', async () => {
    const h = createHarness();
    const toast = new FakeEl('toast');
    const bar = new FakeEl('bar');
    await h.begin();
    h.pinned.push({ el: toast, kind: 'fixed' }, { el: bar, kind: 'sticky' });
    await h.cmd('down');
    assert.equal(toast.style['visibility'], 'hidden');
    assert.equal(bar.style['position'], 'static');
    await h.cmd('cancel');
    assert.deepEqual(toast.style, {}, 'restored');
    assert.deepEqual(bar.style, {}, 'restored');
    assertRestored(h);
  });

  it('keeps what the page set inline and puts it back exactly', async () => {
    const h = createHarness();
    h.divider.style['position'] = 'sticky';
    h.footer.style['visibility'] = 'visible';
    await h.begin();
    assert.equal(h.divider.style['position'], 'static');
    assert.equal(h.footer.style['visibility'], 'hidden');
    await h.cmd('down');
    await h.cmd('done');
    assert.equal(h.divider.style['position'], 'sticky');
    assert.equal(h.footer.style['visibility'], 'visible');
  });

  it('makes a new scanner for a new session', async () => {
    const h = createHarness();
    await h.begin();
    await h.cmd('done');
    await h.begin(makeConfig({}, SESSION_B));
    assert.equal(h.scannerCalls.length, 2);
    assert.equal(h.scannerCalls[1]?.ignore, h.overlay().host, 'the new overlay host');
    await h.cmd('cancel');
  });

  it('does not touch fixed or sticky elements when hideOverlays is off', async () => {
    const h = createHarness();
    await h.begin(makeConfig({ hideOverlays: false }));
    await h.cmd('down');
    assert.deepEqual(h.scannerCalls, []);
    assert.deepEqual(h.collectCalls, []);
    assert.equal(h.footer.style['visibility'], undefined);
    assert.equal(h.divider.style['position'], undefined);
    assert.deepEqual(
      h.jar().sets.map((s) => s.prop),
      ['scroll-behavior', 'scroll-behavior', 'scrollbar-width', 'scrollbar-width'],
    );
    // The overlay is still hidden around the capture.
    assert.ok(h.events.includes('hideForCapture'));
    assert.ok(h.events.includes('showAfterCapture'));
  });

  it('shows an error when the scan fails, keeps the session, and restores on Cancel', async () => {
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    h.scan.fail = true;
    await h.cmd('down');
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, MSG_GENERIC);
    assert.equal(h.frames().length, 1, 'no frame was captured without the scan');
    assert.equal(h.agent().isActive(), true);
    h.scan.fail = false;
    await h.cmd('down'); // works again: the missed frame, then the step
    assert.equal(h.frames().length, 3);
    await h.cmd('cancel');
    assertRestored(h);
  });

  it('shows the overlay again after a failed capture', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, errorReply(ERR.CAPTURE_FAILED, 'Failed.'));
    await h.begin();
    await h.cmd('down');
    const hidden = h.events.filter((e) => e === 'hideForCapture').length;
    const shown = h.events.filter((e) => e === 'showAfterCapture').length;
    assert.equal(hidden, 2);
    assert.equal(shown, 2);
  });
});

describe('agent.js: events from the page', () => {
  it('ignores a pagehide that a script of the page made', async () => {
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    await h.cmd('down');
    const sent = h.sent.length;
    await h.pageHide(false);
    assert.equal(h.agent().isActive(), true, 'the session goes on');
    assert.equal(h.overlay().destroyCalls, 0);
    assert.equal(h.sent.length, sent, 'no cancel message');
    assert.equal(h.footer.style['visibility'], 'hidden', 'the page is not restored');
    assert.equal(h.listeners.get('pagehide')?.size, 1, 'the listener stays');

    await h.pageHide(true); // the browser's own event still closes the session
    assert.equal(h.types().at(-1), MSG.PAGE_CANCEL);
    assertRestored(h);
  });

  it('ignores an event without isTrusted (nothing but the browser sets it to true)', async () => {
    const h = createHarness();
    await h.begin();
    for (const fn of [...(h.listeners.get('pagehide') ?? [])]) fn({ type: 'pagehide' });
    await flush();
    assert.equal(h.agent().isActive(), true);
  });
});

describe('agent.js: watchdog', () => {
  it('starts one timer per session, every second', async () => {
    const h = createHarness();
    h.start();
    assert.equal(h.intervals.length, 1);
    assert.equal(h.intervals[0]?.ms, 1000);
    await h.cmd('cancel');
    assert.equal(h.intervals[0]?.cleared, true);
    h.scroller.style = {};
    await h.begin(makeConfig({}, SESSION_B));
    assert.equal(h.intervals.length, 2);
    assert.equal(h.intervals[1]?.cleared, false);
  });

  it('keeps the overlay on top on every tick while the extension is there', async () => {
    const h = createHarness();
    await h.begin();
    await h.tick();
    await h.tick();
    assert.equal(h.overlay().keepOnTopCalls, 2);
    assert.equal(h.agent().isActive(), true);
    h.overlay().failKeepOnTop = true;
    await h.tick(); // an error of the overlay does not stop the timer or the session
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.intervals[0]?.cleared, false);
  });

  it('closes the session and restores the page when the extension is reloaded', async () => {
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    await h.cmd('down');
    assert.equal(h.footer.style['visibility'], 'hidden');
    h.runtime.id = undefined; // the extension context is invalidated: no event reaches the page
    const sent = h.sent.length;
    await h.tick();
    assertRestored(h);
    assert.equal(h.sent.length, sent, 'nothing can be sent to a service worker that is gone');
    assert.equal(h.overlay().keepOnTopCalls, 0);
  });

  it('also closes while the user is still selecting', async () => {
    const h = createHarness();
    h.start();
    h.runtime.id = undefined;
    await h.tick();
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.agent().isActive(), false);
    assert.equal(h.intervals[0]?.cleared, true);
  });

  it('stops on Done, on a closed context found by a message, and on pagehide', async () => {
    const done = createHarness();
    await done.begin();
    await done.cmd('done');
    assert.equal(done.intervals[0]?.cleared, true);

    const hidden = createHarness();
    await hidden.begin();
    await hidden.pageHide();
    assert.equal(hidden.intervals[0]?.cleared, true);

    const gone = createHarness();
    await gone.begin();
    gone.runtime.id = undefined;
    await gone.cmd('down'); // the send finds the context invalid
    assert.equal(gone.intervals[0]?.cleared, true);
  });

  it('a tick after the session closed does nothing', async () => {
    const h = createHarness();
    await h.begin();
    await h.cmd('cancel');
    const calls = h.overlay().keepOnTopCalls;
    h.intervals[0]?.fn(); // a timer that fires late
    await flush();
    assert.equal(h.overlay().keepOnTopCalls, calls);
    assert.equal(h.overlay().destroyCalls, 1);
  });
});

describe('agent.js: names that page markup can shadow', () => {
  /** Something that is not a plain object: an element that markup put at the namespace name. */
  const formLike = () => Object.create({ [Symbol.toStringTag]: 'HTMLFormElement' });

  it('does not trust a namespace that is not a plain object, and makes its own', () => {
    const h = createHarness();
    const clobbered = formLike();
    h.sandbox.__spool = clobbered;
    assert.doesNotThrow(() => h.inject());
    const ns = h.sandbox.__spool;
    assert.notEqual(ns, clobbered);
    assert.ok(Object.isFrozen(ns.agent), 'the agent registered on the new namespace');
    const descriptor = Object.getOwnPropertyDescriptor(h.sandbox, '__spool');
    assert.equal(descriptor?.enumerable, false, 'not enumerable');
    // Without a config, lib and overlay on it, start() does nothing and does not throw.
    assert.doesNotThrow(() => h.agent().start());
    assert.equal(h.overlays.length, 0);
  });

  it('keeps a namespace that is a plain object, also one of an earlier injection', () => {
    const h = createHarness();
    const before = h.sandbox.__spool;
    h.inject();
    assert.equal(h.sandbox.__spool, before);
    assert.equal(Object.getOwnPropertyDescriptor(h.sandbox, '__spool')?.enumerable, true);
  });

  it('reads the title and <html> through the prototype, not through names of the document', async () => {
    const h = createHarness();
    class FakeDocument {
      get title() {
        return 'Real title';
      }
      get documentElement() {
        return h.root;
      }
    }
    const doc = new FakeDocument();
    // Markup shadows both names on the document itself (<img name="title">, <img name="documentElement">).
    Object.defineProperty(doc, 'title', { value: { notAString: true } });
    Object.defineProperty(doc, 'documentElement', { value: { style: 'shadowed' } });
    h.sandbox.Document = FakeDocument;
    h.sandbox.document = doc;
    h.inject(); // the accessors are taken from the prototype when the script loads
    await h.begin();
    assert.equal(h.messages(MSG.PAGE_SESSION_OPEN)[0]?.['title'], 'Real title');
    assert.ok(h.jar().sets.some((x) => x.el === h.root && x.prop === 'scroll-behavior'));
    await h.cmd('cancel');
    assertRestored(h);
  });
});

describe('agent.js: progress and end of panel', () => {
  it('sends the scroll position along the range as progress, up and down', async () => {
    const h = createHarness({ scrollTop: 500 });
    await h.begin();
    assert.equal(h.overlay().status.progress, 0.25);
    assert.equal(h.overlay().status.atEnd, false);
    await h.cmd('down'); // 800
    assert.equal(h.overlay().status.progress, 0.4);
    await h.cmd('down'); // 1100
    assert.equal(h.overlay().status.progress, 0.55);
    await h.cmd('up'); // 800
    assert.equal(h.overlay().status.progress, 0.4);
    assert.equal(h.overlay().status.atEnd, false);
    // Every status of the run is in range.
    assert.ok(h.overlay().statuses.every((s) => s.progress >= 0 && s.progress <= 1));
  });

  it('is at the end when a frame was taken at the bottom, before any step that does not move', async () => {
    const h = createHarness({ scrollTop: 1700 });
    await h.begin();
    assert.equal(h.overlay().status.atEnd, false);
    await h.cmd('down'); // 2000: clamped, moves 300
    assertAtEnd(h);
    assert.equal(h.frames().length, 2);
  });

  it('Auto stops by itself at the end, and the last status says so', async () => {
    const h = createHarness({ scrollTop: 1000 });
    await h.begin();
    await h.cmd('auto');
    assertAtEnd(h);
    assert.equal(h.overlay().status.auto, false);
    assert.ok(h.overlay().statuses.some((s) => s.auto && !s.atEnd), 'it ran before the end');
  });

  it('leaves the end when the user scrolls up', async () => {
    const h = createHarness({ scrollTop: 1900 });
    await h.begin();
    await h.cmd('down');
    assertAtEnd(h);
    await h.cmd('up');
    assert.equal(h.overlay().status.atEnd, false);
    assert.ok(h.overlay().status.progress < 1);
  });

  it('a panel that cannot scroll is at its end at once', async () => {
    const h = createHarness({ maxScrollTop: 0 });
    await h.begin();
    assertAtEnd(h);
    assert.equal(h.frames().length, 1);
  });

  it('a downward scroll that does not move is the end, also when the range says more', async () => {
    const h = createHarness();
    h.page.reportedMax = 5000; // the range says 5000, the page stops at 2000
    await h.begin();
    await h.cmd('auto');
    const status = h.overlay().status;
    assert.equal(status.atEnd, true);
    assert.equal(status.message, '');
    assert.ok(status.progress > 0.39 && status.progress < 0.41, `progress ${status.progress}`);

    await h.cmd('up'); // moves: the sticky end is gone
    assert.equal(h.overlay().status.atEnd, false);
  });

  it('the top is not an end of panel: it keeps its message', async () => {
    const h = createHarness({ scrollTop: 0 });
    await h.begin();
    await h.cmd('up');
    assert.equal(h.overlay().status.message, 'Reached the top.');
    assert.equal(h.overlay().status.atEnd, false);
    assert.equal(h.overlay().status.progress, 0);
  });

  it('survives a scroll range that cannot be read', async () => {
    const h = createHarness();
    h.sandbox.__spool.lib.maxScrollTop = () => {
      throw new Error('detached');
    };
    // The agent copied nothing from the lib object: it calls through it on every status.
    await h.begin();
    assert.equal(h.overlay().status.atEnd, false);
    assert.equal(h.overlay().status.progress, 0);
    assert.equal(h.frames().length, 1);
    await h.cmd('cancel');
    assertRestored(h);
  });

  it('before an area is picked there is no progress', async () => {
    const h = createHarness();
    h.start();
    await h.select({ x: 0, y: 0, width: 0.2, height: 0.2 }); // clipped to nothing: error, selecting
    assert.equal(h.overlay().status.progress, 0);
    assert.equal(h.overlay().status.atEnd, false);
  });
});

describe('agent.js: Done, clipboard and toast', () => {
  /** @param {ReturnType<typeof createHarness>} h */
  async function readyToFinish(h) {
    await h.begin();
    await h.cmd('down');
  }

  it('starts the clipboard write in the same task as Done, before any await', async () => {
    const h = createHarness();
    await readyToFinish(h);
    h.overlay().command('done'); // no flush: this is the task of the key press or click
    assert.equal(h.clipboard.writes.length, 1, 'clipboard.write was called synchronously');
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 1, 'page/finish is on its way');
    assert.equal(h.messages(MSG.PAGE_GET_CLIPBOARD).length, 0, 'the image is asked for later');

    await flush();
    assert.deepEqual(h.mainTypes().slice(-1), [MSG.PAGE_FINISH]);
    assert.equal(h.messages(MSG.PAGE_GET_CLIPBOARD).length, 1);
    assert.deepEqual(h.messages(MSG.PAGE_GET_CLIPBOARD)[0], {
      v: 1,
      target: 'sw',
      type: 'page/get-clipboard',
      sessionId: SESSION_A,
    });
    assert.equal(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK).length, 0, 'the write worked');
    // The item holds a promise of the full image as a PNG blob.
    const blob = await h.clipboard.writes[0]?.images[0];
    assert.ok(blob);
    assert.equal(blob.type, 'image/png');
    assert.equal(blob.size, Buffer.from(PNG_BASE64, 'base64').length);
  });

  it('restores the page first, then shows the toast with the summary and the config', async () => {
    const h = createHarness();
    await readyToFinish(h);
    await h.cmd('done');
    assertRestored(h);
    assert.equal(h.toast.shown.length, 1);
    const shown = h.toast.shown[0];
    assert.equal(shown.copy, 'pending', 'it shows at once, the copy ends later');
    assert.equal(shown.summary.sessionId, SESSION_A);
    assert.equal(shown.summary.save.label, 'Downloads/Spool');
    assert.equal(shown.config.sessionId, SESSION_A);
    assert.ok(h.events.indexOf('destroy') < h.events.indexOf('toast.show'));
    assert.deepEqual(h.toast.copies, ['copied']);
    assert.equal(h.agent().isActive(), false);
  });

  it('a refused write goes to the service worker, and its answer is the final state', async () => {
    const h = createHarness();
    h.clipboard.reject = true;
    await readyToFinish(h);
    await h.cmd('done');
    assert.equal(h.clipboard.writes.length, 1);
    assert.deepEqual(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK), [
      { v: 1, target: 'sw', type: 'page/clipboard-fallback', sessionId: SESSION_A },
    ]);
    assert.deepEqual(h.toast.copies, ['copied'], 'the service worker wrote it');

    const failed = createHarness();
    failed.clipboard.reject = true;
    failed.queue(MSG.PAGE_CLIPBOARD_FALLBACK, { ok: true, copied: false });
    await readyToFinish(failed);
    await failed.cmd('done');
    assert.deepEqual(failed.toast.copies, ['failed']);
  });

  it('a page without the clipboard API uses the service worker at once', async () => {
    const h = createHarness();
    h.clipboard.missing = true;
    await readyToFinish(h);
    await h.cmd('done');
    assert.equal(h.clipboard.writes.length, 0);
    assert.equal(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK).length, 1);
    assert.deepEqual(h.toast.copies, ['copied']);
  });

  describe('an image that is too large to copy as one image', () => {
    /** @param {number} maxClipboardBitmapBytes */
    const limited = (maxClipboardBitmapBytes) => ({
      ...makeConfig(),
      limits: { maxImagesPerMessage: 20, maxClipboardBitmapBytes },
    });

    it('is not written at all when the size known before Done is over the limit', async () => {
      const h = createHarness();
      // 400 CSS px x 1.5 = 600 px wide, 1,200 px high after two frames: 2.88 MB decoded.
      await h.begin(limited(1_000_000));
      await h.cmd('down');
      h.overlay().command('done');
      assert.equal(h.clipboard.writes.length, 0, 'no clipboard.write, not even a promise');
      await flush();
      assert.equal(h.messages(MSG.PAGE_FINISH).length, 1, 'the capture still finishes');
      assert.equal(h.messages(MSG.PAGE_GET_CLIPBOARD).length, 0, 'the image is not fetched');
      assert.equal(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK).length, 0, 'the worker does not try');
      assert.equal(h.toast.shown.length, 1, 'the toast still shows the saved files');
      assert.equal(h.toast.shown[0].copy, 'toolarge');
      assert.deepEqual(h.toast.copies, []);
    });

    it('is given up when the summary shows that it is over the limit (Done came late)', async () => {
      const h = createHarness();
      // 2.88 MB is under 10 MB, so the write starts. The summary says 1500 x 4200: 25 MB.
      await h.begin(limited(10_000_000));
      await h.cmd('down');
      h.overlay().command('done');
      assert.equal(h.clipboard.writes.length, 1, 'the estimate let it start');
      await flush();
      await flush();
      assert.equal(h.messages(MSG.PAGE_GET_CLIPBOARD).length, 0, 'the image is not fetched');
      assert.equal(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK).length, 0, 'no fallback either');
      assert.equal(h.toast.shown[0].copy, 'pending');
      assert.deepEqual(h.toast.copies, ['toolarge']);
      await assert.rejects(h.clipboard.writes[0]?.images[0] ?? Promise.resolve(), /Too tall/);
    });

    it('is written when it is under the limit, and the limit of a config is the built-in one', async () => {
      const h = createHarness();
      await h.begin(limited(1_000_000_000));
      await h.cmd('down');
      await h.cmd('done');
      assert.equal(h.clipboard.writes.length, 1);
      assert.deepEqual(h.toast.copies, ['copied']);

      const bare = createHarness();
      await bare.begin(); // the config has no limits: 256 MiB
      await bare.cmd('down');
      await bare.cmd('done');
      assert.equal(bare.clipboard.writes.length, 1);
      assert.deepEqual(bare.toast.copies, ['copied']);
    });

    it('tells the overlay whether the setting copies, so the button says "Save" or "Copy & save"', async () => {
      const off = createHarness();
      await off.begin({ ...limited(1_000_000), settings: { ...limited(1).settings, copyOnDone: false } });
      assert.equal(off.overlay().handlers.copyOnDone, false);
      const on = createHarness();
      await on.begin();
      assert.equal(on.overlay().handlers.copyOnDone, true);
    });

    it('does not change the "Saved" state of the setting that turns the copy off', async () => {
      const h = createHarness();
      await h.begin({ ...limited(1_000_000), settings: { ...limited(1).settings, copyOnDone: false } });
      await h.cmd('down');
      await h.cmd('done');
      assert.equal(h.toast.shown[0].copy, 'skipped');
    });

    it('ignores a limit that is not a positive number', async () => {
      for (const bad of [0, -5, Number.NaN, '1']) {
        const h = createHarness();
        await h.begin({ ...makeConfig(), limits: { maxImagesPerMessage: 20, maxClipboardBitmapBytes: /** @type {any} */ (bad) } });
        await h.cmd('down');
        await h.cmd('done');
        assert.deepEqual(h.toast.copies, ['copied'], String(bad));
      }
    });
  });

  it('a fallback that fails, or cannot be reached, ends as "failed"', async () => {
    const h = createHarness();
    h.clipboard.reject = true;
    h.queue(
      MSG.PAGE_CLIPBOARD_FALLBACK,
      errorReply(ERR.INTERNAL, 'Could not write to the clipboard.'),
    );
    await readyToFinish(h);
    await h.cmd('done');
    assert.deepEqual(h.toast.copies, ['failed']);
  });

  it('an image that is too large for a message gives the reason to the toast', async () => {
    const h = createHarness();
    const tooLarge = 'This image is too large to copy. Use the AI screenshots.';
    h.queue(MSG.PAGE_GET_CLIPBOARD, errorReply(ERR.SESSION_TOO_LARGE, tooLarge));
    h.queue(MSG.PAGE_CLIPBOARD_FALLBACK, { ok: true, copied: false });
    await readyToFinish(h);
    await h.cmd('done');
    assert.deepEqual(h.toast.copies, ['failed']);
    assert.deepEqual(h.toast.details, [tooLarge]);
    await assert.rejects(h.clipboard.writes[0]?.images[0] ?? Promise.resolve(), /too large/);
  });

  it('when page/finish fails, the session stays open and no toast shows', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_FINISH, errorReply(ERR.INTERNAL, 'Could not build the images. Try again.'));
    await readyToFinish(h);
    await h.cmd('done');
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, 'Could not build the images. Try again.');
    assert.equal(h.overlay().destroyCalls, 0);
    assert.equal(h.toast.shown.length, 0);
    assert.equal(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK).length, 0, 'nothing was finished');
    assert.equal(h.messages(MSG.PAGE_GET_CLIPBOARD).length, 0);
    await assert.rejects(h.clipboard.writes[0]?.images[0] ?? Promise.resolve(), /Could not build/);

    // Done again is a new gesture: a new write, and now it works.
    await h.cmd('done');
    assert.equal(h.clipboard.writes.length, 2);
    assert.equal(h.toast.shown.length, 1);
    assert.deepEqual(h.toast.copies, ['copied']);
    assertRestored(h);
  });

  it('a second Done while the first one runs writes nothing more', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_FINISH, () => slow.promise);
    await readyToFinish(h);
    h.overlay().command('done');
    h.overlay().command('done');
    await flush();
    assert.equal(h.clipboard.writes.length, 1);
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 1);
    slow.resolve({ ok: true, summary: SUMMARY });
    await flush();
    assert.equal(h.toast.shown.length, 1);
  });

  it('Done during a step: the write starts at once, page/finish waits for the step to end', async () => {
    const h = createHarness();
    await h.begin();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, () => slow.promise);
    h.overlay().command('down');
    await flush(); // the step waits for its frame
    assert.equal(h.overlay().status.slices, 1);

    h.overlay().command('done');
    assert.equal(h.clipboard.writes.length, 1, 'the gesture is now: the write starts');
    await flush();
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 0, 'page/finish waits for the step');
    assert.equal(h.overlay().status.message, MSG_STOPPING);

    slow.resolve(h.intake());
    await flush();
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 1);
    assert.equal(h.messages(MSG.PAGE_GET_CLIPBOARD).length, 1);
    assert.equal(h.clipboard.writes.length, 1, 'one write for one Done');
    assert.equal(h.overlay().status.slices, 2, 'the frame of the step is in the capture');
    assert.equal(h.toast.shown.length, 1);
    assert.deepEqual(h.toast.copies, ['copied']);
    assertRestored(h);
  });

  it('Cancel after a Done that waits: nothing is finished and the clipboard stays as it was', async () => {
    const h = createHarness();
    await h.begin();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, () => slow.promise);
    h.overlay().command('down');
    await flush();
    h.overlay().command('done');
    h.overlay().command('cancel');
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 0);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 1);
    assert.equal(h.toast.shown.length, 0);
    await assert.rejects(h.clipboard.writes[0]?.images[0] ?? Promise.resolve());
    assertRestored(h);
  });

  it('pagehide while Done waits for a step does not finish the closed session', async () => {
    const h = createHarness();
    await h.begin();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, () => slow.promise);
    h.overlay().command('down');
    await flush();
    h.overlay().command('done');
    await h.pageHide();
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 0);
    assert.equal(h.toast.shown.length, 0);
    assertRestored(h);
  });

  it('Done before anything is stored writes nothing (there is nothing to finish)', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, () => slow.promise);
    h.start();
    h.overlay().select(REGION);
    await flush(); // the initial frame waits
    h.overlay().command('done');
    assert.equal(h.clipboard.writes.length, 0);
    slow.resolve(h.intake());
    await flush();
    // The first frame is stored now: the pending Done finishes (without a gesture; the service
    // worker copies it if the browser refuses).
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 1);
    assert.equal(h.toast.shown.length, 1);
  });

  it('a finish reply without a summary still restores the page; the toast gets nothing useful', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_FINISH, { ok: true });
    await readyToFinish(h);
    await h.cmd('done');
    assertRestored(h);
    assert.equal(h.agent().isActive(), false);
  });

  it('works when the shared kit is missing: the service worker copies', async () => {
    const h = createHarness();
    delete h.sandbox.__spool.ui;
    await readyToFinish(h);
    await h.cmd('done');
    assert.equal(h.clipboard.writes.length, 0);
    assert.equal(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK).length, 1);
    assertRestored(h);
  });

  it('never throws into the page when the toast throws', async () => {
    const h = createHarness();
    h.sandbox.__spool.toast.show = () => {
      throw new Error('toast broke');
    };
    await readyToFinish(h);
    await h.cmd('done');
    assertRestored(h);
    assert.equal(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK).length, 0);
  });
});

describe('agent.js: shelf mode and the toast of an earlier capture', () => {
  it('in mode shelf, start() opens the shelf and no capture', () => {
    const h = createHarness();
    h.sandbox.__spool.config = { ...makeConfig(), mode: 'shelf', shelfToken: SESSION_B };
    h.sandbox.__spool.shelf = {
      start: () => {
        h.events.push('shelf.start');
      },
      dismiss: noop,
    };
    h.start();
    assert.deepEqual(h.events, ['shelf.start']);
    assert.equal(h.overlays.length, 0, 'no overlay');
    assert.equal(h.agent().isActive(), false, 'the shelf is not a capture');
  });

  it('a shelf command is ignored while a capture is active', async () => {
    const h = createHarness();
    await h.begin();
    h.sandbox.__spool.shelf = {
      start: () => {
        h.events.push('shelf.start');
      },
      dismiss: noop,
    };
    h.start({ ...makeConfig(), mode: 'shelf', shelfToken: SESSION_B });
    assert.ok(!h.events.includes('shelf.start'));
    assert.equal(h.overlays.length, 1);
  });

  it('a new capture closes the toast and the shelf of the earlier one', () => {
    const h = createHarness();
    let shelfDismissed = 0;
    h.sandbox.__spool.shelf = {
      start: noop,
      dismiss: () => {
        shelfDismissed += 1;
      },
    };
    h.start();
    assert.equal(h.toast.dismissed, 1);
    assert.equal(shelfDismissed, 1);
  });

  it('a malformed config does not touch the toast', () => {
    const h = createHarness();
    h.sandbox.__spool.config = { protocolVersion: 99 };
    h.start();
    assert.equal(h.toast.dismissed, 0);
    assert.equal(h.overlays.length, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Mutation testing of the agent: edges of numbers, outcomes of the
// state machine, and the paths that only matter when something fails or ends at a bad moment.
// ---------------------------------------------------------------------------------------------

describe('agent.js: its own namespace (the agent loaded without the shared kit)', () => {
  /** @param {ReturnType<typeof createHarness>} h */
  const loadAgentAlone = (h) =>
    vm.runInContext(AGENT_SOURCE, h.sandbox, { filename: 'agent.js' });

  it('does not trust a namespace that is not a plain object, and makes its own', () => {
    const h = createHarness();
    const clobbered = Object.create({ [Symbol.toStringTag]: 'HTMLFormElement' });
    h.sandbox.__spool = clobbered;
    loadAgentAlone(h);
    assert.notEqual(h.sandbox.__spool, clobbered);
    assert.equal(typeof h.sandbox.__spool.agent.start, 'function');
    assert.equal(clobbered.agent, undefined, 'the agent did not register on the element');
  });

  it('makes the namespace an own, hidden, replaceable property when there is none', () => {
    const h = createHarness();
    delete h.sandbox.__spool;
    loadAgentAlone(h);
    const descriptor = Object.getOwnPropertyDescriptor(h.sandbox, '__spool');
    assert.ok(descriptor, 'an own property of the global');
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
    assert.equal(typeof descriptor.value.agent.isActive, 'function');
  });
});

describe('agent.js: edges of the scroll range and of the viewport', () => {
  it('a downward scroll of under half a CSS px is the end; half a px is a step', async () => {
    for (const [top, frames] of [
      [1999.6, 1],
      [1999.5, 2],
    ]) {
      const h = createHarness({ scrollTop: top }); // the page stops at 2000
      await h.begin();
      await h.cmd('down');
      assert.equal(h.frames().length, frames, `scrollTop ${top}`);
    }
  });

  it('the bottom starts one CSS px before the end of the range', async () => {
    /** @type {[number, boolean][]} */
    const cases = [
      [1999, true],
      [1998.9, false],
    ];
    for (const [top, atEnd] of cases) {
      const h = createHarness({ scrollTop: top });
      await h.begin();
      assert.equal(h.overlay().status.atEnd, atEnd, `scrollTop ${top}`);
    }
  });

  it('a range of one CSS px cannot scroll; a little more can', async () => {
    const flat = createHarness();
    flat.page.reportedMax = 1;
    await flat.begin();
    assert.equal(flat.overlay().status.progress, 1);
    assert.equal(flat.overlay().status.atEnd, true);

    const short = createHarness();
    short.page.reportedMax = 1.5;
    await short.begin();
    assert.equal(short.overlay().status.progress, 0);
    assert.equal(short.overlay().status.atEnd, false);
  });

  it('progress stays between 0 and 1 for a position outside the range or not a number', async () => {
    for (const [top, progress] of [
      [500, 1],
      [-50, 0],
      [Number.NaN, 0],
    ]) {
      const h = createHarness({ scrollTop: top });
      h.page.reportedMax = 100;
      await h.begin();
      assert.equal(h.overlay().status.progress, progress, `scrollTop ${top}`);
    }
  });

  it('the capture rect may reach one CSS px past the viewport, and not two', async () => {
    // REGION is x 150..550 and y 120..520.
    for (const [prop, edge] of [
      ['innerWidth', 550],
      ['innerHeight', 520],
    ]) {
      const fits = createHarness();
      await fits.begin();
      fits.sandbox[String(prop)] = Number(edge) - 1;
      await fits.cmd('down');
      assert.equal(fits.frames().length, 2, `${prop} ${Number(edge) - 1}`);

      const tooSmall = createHarness();
      await tooSmall.begin();
      tooSmall.sandbox[String(prop)] = Number(edge) - 2;
      await tooSmall.cmd('down');
      assert.equal(tooSmall.frames().length, 1, `${prop} ${Number(edge) - 2}`);
      assert.equal(tooSmall.overlay().status.level, 'error');
    }
  });

  it('clips a region that starts outside the window to the corner of the window', async () => {
    const h = createHarness();
    Object.assign(h.target.box, { x: -50, y: -30 });
    h.start();
    await h.select({ x: -20, y: -10, width: 400, height: 400 });
    assert.deepEqual(h.overlay().sessions, [{ x: 0, y: 0, width: 380, height: 390 }]);
    assert.deepEqual(h.frames()[0]?.rect, { x: 0, y: 0, width: 380, height: 390 });
  });

  it('keeps an error message of the service worker to 200 characters', async () => {
    for (const [length, shown] of [
      [300, 200],
      [200, 200],
      [150, 150],
    ]) {
      const h = createHarness();
      h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, errorReply(ERR.INTERNAL, 'm'.repeat(length)));
      await h.begin();
      await h.cmd('down');
      assert.equal(h.overlay().status.message.length, shown, `message of ${length}`);
    }
  });

  it('waits two frames and settleMs after every scroll, and scrolls up no lower than 0', async () => {
    const h = createHarness({ scrollTop: 100 });
    /** @type {number[]} */
    const frameWaits = [];
    h.sandbox.__spool.lib.nextFrames = (/** @type {number} */ n) => {
      frameWaits.push(n);
      return Promise.resolve();
    };
    await h.begin();
    assert.deepEqual(h.sleeps, [], 'the initial frame needs no wait');
    await h.cmd('up'); // 100 - 300: clamped to 0 by the agent, not only by the page
    assert.equal(h.scrollLog.at(-1), 0);
    await h.cmd('down');
    assert.deepEqual(frameWaits, [2, 2]);
    assert.deepEqual(h.sleeps, [7, 7]);
  });
});

describe('agent.js: replies and rejections that cannot be used', () => {
  /** @param {Record<string, unknown>} [over] */
  const withIntake = (over = {}) => ({
    ok: true,
    intake: {
      index: 1,
      sliceCount: 2,
      widthPx: 1500,
      totalHeightPx: 1200,
      tileCount: 1,
      storedBytes: 2000,
      seam: { status: 'exact', shiftPx: 0, meanDiff: 0 },
      ...over,
    },
  });

  it('an intake with a missing or wrong field is "could not reach", and is not counted', async () => {
    const bad = [
      { ok: true, intake: undefined },
      { ok: true, intake: null },
      { ok: true, intake: 'stored' },
      withIntake({ index: Number.NaN }),
      withIntake({ sliceCount: '2' }),
      withIntake({ totalHeightPx: Number.POSITIVE_INFINITY }),
      withIntake({ tileCount: undefined }),
      withIntake({ seam: undefined }),
      withIntake({ seam: null }),
      withIntake({ seam: 'exact' }),
      withIntake({ seam: {} }),
      withIntake({ seam: { status: 5 } }),
    ];
    for (const [i, reply] of bad.entries()) {
      const h = createHarness();
      h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, reply);
      await h.begin();
      await h.cmd('down');
      const status = h.overlay().status;
      assert.equal(status.level, 'error', `case ${i}`);
      assert.equal(status.message, MSG_UNREACHABLE, `case ${i}`);
      assert.equal(status.slices, 1, `case ${i}: not counted`);
      assert.equal(h.agent().isActive(), true);
    }
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, withIntake());
    await h.begin();
    await h.cmd('down');
    assert.equal(h.overlay().status.slices, 2, 'the good intake is counted');
    assert.equal(h.overlay().status.level, 'info');
  });

  it('a rejection that names the invalid context closes the session, whatever its shape', async () => {
    const thrown = [
      'Extension context invalidated.', // a string
      { message: 'Extension context invalidated.' }, // not an Error
      new Error('EXTENSION CONTEXT INVALIDATED.'), // other case
    ];
    for (const value of thrown) {
      const h = createHarness({ scrollTop: 300 });
      h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => Promise.reject(value));
      await h.begin();
      await h.cmd('down'); // chrome.runtime.id is still set: only the text says it
      assert.equal(h.overlay().destroyCalls, 1, JSON.stringify(value));
      assert.equal(h.agent().isActive(), false);
      assert.equal(h.page.scrollTop, 300);
      assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0, 'the extension is gone: no cancel');
    }
  });

  it('a rejection of another shape or text keeps the session', async () => {
    for (const value of [{ code: 7 }, 'Receiving end does not exist.', 42]) {
      const h = createHarness();
      h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => Promise.reject(value));
      await h.begin();
      await h.cmd('down');
      assert.equal(h.agent().isActive(), true, JSON.stringify(value));
      assert.equal(h.overlay().status.message, MSG_UNREACHABLE);
    }
  });

  it('a chrome.runtime that throws when read counts as an invalid context', async () => {
    const h = createHarness();
    await h.begin();
    h.sandbox.chrome = {
      get runtime() {
        throw new Error('The extension was unloaded.');
      },
    };
    assert.equal(h.agent().isActive(), false);
    assert.equal(h.overlay().destroyCalls, 1);
  });

  it('pagehide after the extension went sends no cancel', async () => {
    const h = createHarness({ scrollTop: 250 });
    await h.begin();
    h.runtime.id = undefined;
    await h.pageHide();
    assertRestored(h);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0);
  });

  it('a cancel message that is rejected does not become an unhandled rejection', async () => {
    /** @type {unknown[]} */
    const unhandled = [];
    const onRejection = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', onRejection);
    try {
      const h = createHarness();
      h.queue(MSG.PAGE_CANCEL, () => Promise.reject(new Error('worker is asleep')));
      await h.begin();
      await h.cmd('cancel');
      await flush();
      await flush();
      assert.equal(h.messages(MSG.PAGE_CANCEL).length, 1);
      assertRestored(h);
    } finally {
      process.off('unhandledRejection', onRejection);
    }
    assert.deepEqual(unhandled, []);
  });

  it('the toast gets "failed" when the extension is gone before the fallback copy', async () => {
    const h = createHarness({ scrollTop: 250 });
    h.clipboard.reject = true;
    // The image arrives, the browser refuses the write, and then the extension is unloaded.
    h.queue(MSG.PAGE_GET_CLIPBOARD, () => {
      h.runtime.id = undefined;
      return { ok: true, pngBase64: PNG_BASE64 };
    });
    await h.begin();
    await h.cmd('down');
    await h.cmd('done');
    assert.equal(h.toast.shown.length, 1);
    assert.equal(h.messages(MSG.PAGE_CLIPBOARD_FALLBACK).length, 0, 'it cannot be asked');
    assert.deepEqual(h.toast.copies, ['failed']);
    // The page was restored once, and the late attempt to close it changed nothing.
    assertRestored(h);
  });
});

describe('agent.js: the toast learns how the copy ended', () => {
  it('a copy that worked has no detail text', async () => {
    const h = createHarness();
    await h.begin();
    await h.cmd('down');
    await h.cmd('done');
    assert.deepEqual(h.toast.copies, ['copied']);
    assert.deepEqual(h.toast.details, ['']);
  });

  it('a copy that failed without a reason from the service worker has no detail text', async () => {
    const h = createHarness();
    h.clipboard.reject = true;
    h.queue(MSG.PAGE_CLIPBOARD_FALLBACK, { ok: true, copied: false });
    await h.begin();
    await h.cmd('down');
    await h.cmd('done');
    assert.deepEqual(h.toast.copies, ['failed']);
    assert.deepEqual(h.toast.details, ['']);
  });
});

describe('agent.js: the length limit and Auto', () => {
  it('a step at the limit shows the limit as a warning and captures nothing', async () => {
    const h = createHarness();
    await h.begin(makeConfig({ maxHeightCss: 1000 }));
    await h.cmd('auto'); // reaches the limit
    await h.cmd('down');
    const status = h.overlay().status;
    assert.equal(status.level, 'warn');
    assert.equal(status.message, 'Reached the length limit.');
    assert.equal(h.frames().length, 3);
  });

  it('three duplicates in a row stop Auto, and the message is information', async () => {
    const h = createHarness();
    const dup = () => h.intake('duplicate');
    // Initial frame, one new frame, then three that add nothing. The new frame starts the count.
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, DEFAULT, dup, dup, dup);
    await h.begin();
    await h.cmd('auto');
    assert.equal(h.frames().length, 5);
    assert.equal(h.overlay().status.message, 'No new content found.');
    assert.equal(h.overlay().status.level, 'info');
    assert.equal(h.overlay().status.slices, 2);
  });

  it('a frame that adds something starts the count of empty frames again', async () => {
    const h = createHarness();
    const dup = () => h.intake('duplicate');
    // Two duplicates, a new frame, two duplicates: never three in a row.
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, dup, dup, DEFAULT, dup, dup);
    await h.begin();
    await h.cmd('auto');
    assertAtEnd(h);
    assert.equal(h.frames().length, 8);
  });

  it('Auto starts again after it was toggled off', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, () => slow.promise);
    await h.begin();
    await h.cmd('auto');
    await h.cmd('auto'); // off
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.frames().length, 2);
    await h.cmd('auto'); // on again: the old "off" must not stop it
    assertAtEnd(h);
    assert.equal(h.frames().length, 8);
  });

  it('a new step clears the message of the last one at once', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_CAPTURE_FRAME, DEFAULT, errorReply(ERR.INTERNAL, 'The capture failed.'));
    await h.begin();
    await h.cmd('down');
    assert.equal(h.overlay().status.message, 'The capture failed.');
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, () => slow.promise);
    h.overlay().command('down');
    await flush(); // the step waits for its frame
    assert.equal(h.overlay().status.message, '');
    assert.equal(h.overlay().status.level, 'info');
  });
});

describe('agent.js: Done and Cancel at awkward moments', () => {
  /**
   * A step that waits for its frame, so Done and Cancel come in during it.
   * @param {ReturnType<typeof createHarness>} h
   */
  async function stepInProgress(h) {
    await h.begin();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, () => slow.promise);
    h.overlay().command('down');
    await flush();
    return slow;
  }

  it('the status tells that it stops after the step, as information', async () => {
    const h = createHarness();
    await stepInProgress(h);
    h.overlay().command('done');
    await flush();
    assert.equal(h.overlay().status.message, MSG_STOPPING);
    assert.equal(h.overlay().status.level, 'info');
  });

  it('while page/finish runs the overlay is busy and says it opens the result', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_FINISH, () => slow.promise);
    await h.begin();
    await h.cmd('down');
    await h.cmd('done');
    assert.equal(h.overlay().status.message, 'Saving and copying…');
    assert.equal(h.overlay().status.level, 'info');
    assert.equal(h.overlay().busy.at(-1), true);
    slow.resolve({ ok: true, summary: SUMMARY });
    await flush();
    assert.equal(h.toast.shown.length, 1);
  });

  it('pagehide while page/finish runs: when it answers, no toast shows', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_FINISH, () => slow.promise);
    await h.begin();
    await h.cmd('down');
    await h.cmd('done');
    await h.pageHide();
    slow.resolve({ ok: true, summary: SUMMARY });
    await flush();
    assert.equal(h.toast.shown.length, 0);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0);
    assertRestored(h);
  });

  it('a Done that failed does not finish again at the end of the next step', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_FINISH, errorReply(ERR.INTERNAL, 'Could not build the images. Try again.'));
    const slow = await stepInProgress(h);
    h.overlay().command('done');
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 1);
    assert.equal(h.overlay().status.message, 'Could not build the images. Try again.');
    assert.equal(h.agent().isActive(), true, 'the session stays open');

    await h.cmd('down'); // an ordinary step: the old Done is spent
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 1);
    assert.equal(h.agent().isActive(), true);
    assert.equal(h.frames().length, 3);
  });

  it('a Done that waited for a step and failed is tried afresh by the next Done', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_FINISH, errorReply(ERR.INTERNAL, 'Could not build the images. Try again.'));
    const slow = await stepInProgress(h);
    h.overlay().command('done');
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.clipboard.writes.length, 1);

    await h.cmd('done'); // a new gesture, a new write and a new page/finish
    assert.equal(h.messages(MSG.PAGE_FINISH).length, 2);
    assert.equal(h.clipboard.writes.length, 2);
    assert.equal(h.toast.shown.length, 1);
    assert.deepEqual(h.toast.copies, ['copied']);
    assertRestored(h);
  });

  it('a step that ends after pagehide does not bring the session back', async () => {
    const h = createHarness({ scrollTop: 250 });
    const slow = await stepInProgress(h);
    await h.pageHide();
    const statuses = h.overlay().statuses.length;
    const busy = h.overlay().busy.length;
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.overlay().statuses.length, statuses, 'no status after close');
    assert.equal(h.overlay().busy.length, busy, 'the busy flag is left alone');
    const frames = h.frames().length;
    await h.cmd('down');
    await h.cmd('auto');
    assert.equal(h.frames().length, frames, 'a command after close does nothing');
    assert.equal(h.agent().isActive(), false);
    assertRestored(h);
  });

  it('the page closing while the overlay hides ends the step before any frame is asked for', async () => {
    const h = createHarness();
    await h.begin();
    const hide = deferred();
    h.overlay().hideForCapture = () => hide.promise;
    h.overlay().command('down');
    await flush();
    await h.pageHide();
    hide.resolve(undefined);
    await flush();
    assert.equal(h.frames().length, 1, 'no capture-frame message for a closed session');
    assertRestored(h);
  });

  it('the page closing while the scroll settles ends the step before the frame', async () => {
    for (const wait of ['nextFrames', 'sleep']) {
      const h = createHarness();
      await h.begin();
      const gate = deferred();
      h.sandbox.__spool.lib[wait] = () => gate.promise;
      h.overlay().command('down');
      await flush();
      await h.pageHide();
      gate.resolve(undefined);
      await flush();
      assert.equal(h.frames().length, 1, `closed during ${wait}`);
      assertRestored(h);
    }
  });

  it('a frame reply that comes after the page closed is not counted or shown', async () => {
    const h = createHarness();
    const slow = await stepInProgress(h);
    await h.pageHide();
    const statuses = h.overlay().statuses.length;
    const events = h.events.length;
    slow.resolve(h.intake());
    await flush();
    assert.equal(h.overlay().statuses.length, statuses);
    assert.equal(h.events.length, events, 'the overlay is not shown again');
  });
});

describe('agent.js: opening the session', () => {
  it('Cancel while the session opens, and the service worker refuses: the session closes', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_SESSION_OPEN, () => slow.promise);
    h.start();
    await h.select();
    await h.cmd('cancel');
    slow.resolve(errorReply(ERR.CAPTURE_FAILED, 'This page cannot be captured.'));
    await flush();
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.overlay().beginSelectCalls, 1, 'it does not go back to selecting');
    assert.equal(h.agent().isActive(), false);
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 0, 'nothing was opened');
  });

  it('closes when it cannot go back to selecting', async () => {
    const h = createHarness();
    h.queue(MSG.PAGE_SESSION_OPEN, errorReply(ERR.CAPTURE_FAILED, 'This page cannot be captured.'));
    h.start();
    h.overlay().beginSelect = () => {
      throw new Error('the overlay is gone');
    };
    await h.select();
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.agent().isActive(), false);
  });

  it('closes and restores when the overlay cannot start selecting', () => {
    const h = createHarness();
    const create = h.sandbox.__spool.overlay.createOverlay;
    h.sandbox.__spool.overlay.createOverlay = (/** @type {any} */ handlers) => {
      const overlay = create(handlers);
      overlay.beginSelect = () => {
        throw new Error('no selection');
      };
      return overlay;
    };
    assert.doesNotThrow(() => h.start());
    assert.equal(h.overlay().destroyCalls, 1);
    assert.equal(h.agent().isActive(), false);
    assert.equal(h.listeners.get('pagehide')?.size ?? 0, 0);
    assert.ok(h.intervals.every((t) => t.cleared));
  });

  it('a second region while the session runs is ignored', async () => {
    const h = createHarness();
    await h.begin();
    await h.select(REGION);
    assert.equal(h.messages(MSG.PAGE_SESSION_OPEN).length, 1);
    assert.equal(h.frames().length, 1);
    assert.equal(h.agent().isActive(), true);
  });

  it('shows an empty status with no slices at once, before the first frame is stored', async () => {
    const h = createHarness();
    const slow = deferred();
    h.queue(MSG.PAGE_CAPTURE_FRAME, () => slow.promise);
    h.start();
    await h.select();
    const status = h.overlay().statuses.at(-1);
    assert.ok(status, 'a status was shown');
    assert.deepEqual(
      { slices: status.slices, heightPx: status.heightPx, tiles: status.tiles },
      { slices: 0, heightPx: 0, tiles: 0 },
    );
    assert.equal(status.level, 'info');
    assert.equal(status.message, '');
    assert.equal(status.auto, false);
    assert.equal(h.overlay().busy.at(-1), true);
  });

  it('goes back to selecting with a generic message when page-lib throws before the session opens', async () => {
    const h = createHarness();
    h.start();
    h.sandbox.__spool.lib.findScrollTarget = () => {
      throw new Error('detached');
    };
    await h.select();
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, MSG_GENERIC);
    assert.equal(h.overlay().beginSelectCalls, 2);
    assert.deepEqual(h.sent, []);
    assert.equal(h.agent().isActive(), true);
  });

  it('keeps the session and shows a generic message when the overlay fails after it opened', async () => {
    const h = createHarness();
    h.start();
    h.overlay().showSession = () => {
      throw new Error('overlay broke');
    };
    await h.select();
    assert.equal(h.messages(MSG.PAGE_SESSION_OPEN).length, 1);
    assert.equal(h.overlay().status.level, 'error');
    assert.equal(h.overlay().status.message, MSG_GENERIC);
    assert.equal(h.overlay().beginSelectCalls, 1, 'not back to selecting: the session is open');
    assert.equal(h.agent().isActive(), true);
    await h.cmd('cancel');
    assert.equal(h.messages(MSG.PAGE_CANCEL).length, 1);
    assert.equal(h.overlay().destroyCalls, 1);
  });
});

describe('agent.js: the config is checked in full', () => {
  it('does nothing when a part of the config is missing or of the wrong type', () => {
    const base = makeConfig();
    /** @type {Record<string, unknown>[]} */
    const bad = [
      { ...base, settings: undefined },
      { ...base, msg: undefined },
      { ...base, err: undefined },
      { ...base, target: undefined },
      { ...base, settings: { ...base.settings, hideOverlays: 'yes' } },
      { ...base, settings: { ...base.settings, hideOverlays: undefined } },
      { ...base, settings: { ...base.settings, maxHeightCss: Number.POSITIVE_INFINITY } },
      { ...base, err: {} },
    ];
    for (const [i, config] of bad.entries()) {
      const h = createHarness();
      h.sandbox.__spool.config = config;
      assert.doesNotThrow(() => h.start(), `case ${i}`);
      assert.equal(h.overlays.length, 0, `case ${i}`);
      assert.equal(h.agent().isActive(), false);
    }
  });
});
