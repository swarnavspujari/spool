// @ts-check
/**
 * The page agent (src/page/agent.js) in a node:vm context, with the smallest set of fakes that
 * lets it select an area, take frames, step, and finish: the page library (a scroll position that
 * a test can change), the overlay (it records the status lines), the clipboard, the toast and the
 * service worker (it answers every message). The real ui-kit.js is loaded, because the agent
 * writes the clipboard through it.
 *
 * `agent.test.js` has a larger harness of its own. This one is for tests in other files.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';
import { ERR, MSG, PROTOCOL_VERSION, TARGET } from '../../src/shared/protocol.js';

const read = (/** @type {string} */ path) =>
  readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8');
const AGENT_SOURCE = read('../../src/page/agent.js');
const UI_KIT_SOURCE = read('../../src/page/ui-kit.js');

export const SESSION_ID = '11111111-1111-4111-8111-111111111111';
export const PNG_BASE64 = 'iVBORw0KGgo=';
/** The visible box of the scroll target, and the region that the user drags (inside the box). */
export const BOX = Object.freeze({ x: 100, y: 100, width: 600, height: 500 });
export const REGION = Object.freeze({ x: 150, y: 120, width: 400, height: 400 });
/** One step: the region height 400 minus the overlap 100. */
export const STEP = 300;

export const flush = () => new Promise((resolve) => setImmediate(resolve));

/**
 * @param {Partial<import('../../src/shared/types.js').Settings>} [settings]
 * @param {{ summary?: Record<string, unknown>, config?: Record<string, unknown>,
 *   holdFinish?: boolean }} [options]  `holdFinish`: the answer to page/finish waits for
 *   `releaseFinish()`, so a test can look at the agent while it saves.
 */
export function agentPage(settings = {}, options = {}) {
  /** @type {Record<string, any>[]} */
  const sent = [];
  /** @type {{ images: Promise<Blob>[] }[]} */
  const writes = [];
  /** @type {any[]} */
  const toasts = [];
  /** @type {string[]} */
  const copies = [];
  /** @type {any[]} Every status line that the agent gave to the overlay. */
  const statuses = [];
  /** @type {number[]} Every scroll position that the agent set. */
  const scrollLog = [];
  /** @type {Array<{ fn: () => void, cleared: boolean }>} */
  const intervals = [];
  /** @type {unknown[]} Replies for the next capture-frame messages (an object: used as is). */
  const frameReplies = [];
  /** @type {{ onRegion(r: any): void, onCommand(c: string): void } | null} */
  let handlers = null;
  const clock = { now: 1_000_000 };
  const scroller = { style: {} };
  const target = { kind: 'element', el: scroller, box: { ...BOX } };
  const page = { scrollTop: 0, max: 2000 };
  let stored = 0;
  /** @type {() => void} */
  let releaseFinish = () => {};
  const finishGate = new Promise((resolve) => {
    releaseFinish = () => resolve(undefined);
  });

  class FakeClipboardItem {
    /** @param {Record<string, Promise<Blob>>} data */
    constructor(data) {
      this.data = data;
    }
  }

  /** @param {Record<string, any>} msg */
  function reply(msg) {
    switch (msg['type']) {
      case MSG.PAGE_CAPTURE_FRAME: {
        const queued = frameReplies.shift();
        if (queued !== undefined) return queued;
        stored += 1;
        return {
          ok: true,
          intake: {
            index: stored - 1,
            sliceCount: stored,
            totalHeightPx: stored * 600,
            tileCount: 1,
            seam: { status: stored === 1 ? 'first' : 'exact' },
          },
        };
      }
      case MSG.PAGE_FINISH:
        return (options.holdFinish ? finishGate : Promise.resolve()).then(() => ({
          ok: true,
          summary: {
            sessionId: SESSION_ID,
            title: 'Test page',
            createdAt: 1_760_000_000_000,
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
            ...options.summary,
          },
        }));
      case MSG.PAGE_GET_CLIPBOARD:
        return { ok: true, pngBase64: PNG_BASE64 };
      case MSG.PAGE_CLIPBOARD_FALLBACK:
        return { ok: true, copied: true };
      default:
        return { ok: true };
    }
  }

  const sandbox = /** @type {Record<string, any>} */ ({
    chrome: {
      runtime: {
        id: 'ext-id',
        sendMessage: (/** @type {Record<string, any>} */ msg) => {
          sent.push(JSON.parse(JSON.stringify(msg)));
          return Promise.resolve(reply(msg));
        },
      },
    },
    document: { title: 'Test page', documentElement: { style: {} } },
    innerWidth: 1000,
    innerHeight: 800,
    devicePixelRatio: 1,
    Date: { now: () => clock.now },
    setInterval: (/** @type {() => void} */ fn) => intervals.push({ fn, cleared: false }),
    clearInterval: (/** @type {number} */ id) => {
      const timer = intervals[id - 1];
      if (timer) timer.cleared = true;
    },
    addEventListener: () => {},
    removeEventListener: () => {},
    navigator: {
      clipboard: {
        write: (/** @type {FakeClipboardItem[]} */ items) => {
          writes.push({ images: items.map((item) => item.data['image/png']) });
          return Promise.all(items.map((item) => item.data['image/png'])).then(() => undefined);
        },
      },
    },
    ClipboardItem: FakeClipboardItem,
    atob,
    Blob,
    __spool: {
      config: {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: SESSION_ID,
        settings: { ...DEFAULT_SETTINGS, overlapCss: 100, settleMs: 0, hideOverlays: false, ...settings },
        msg: MSG,
        err: ERR,
        target: TARGET,
        ...options.config,
      },
      lib: {
        findScrollTarget: () => target,
        clipRect: (/** @type {any} */ a, /** @type {any} */ b) => {
          const x = Math.max(a.x, b.x);
          const y = Math.max(a.y, b.y);
          const w = Math.min(a.x + a.width, b.x + b.width) - x;
          const h = Math.min(a.y + a.height, b.y + b.height) - y;
          return w < 1 || h < 1 ? null : { x, y, width: w, height: h };
        },
        getScrollTop: () => page.scrollTop,
        maxScrollTop: () => page.max,
        setScrollTop: (/** @type {unknown} */ _t, /** @type {number} */ top) => {
          scrollLog.push(top);
          page.scrollTop = Math.min(page.max, Math.max(0, top));
        },
        contentYOf: (/** @type {any} */ t, /** @type {any} */ rect) => page.scrollTop + rect.y - t.box.y,
        createOverlayScanner: () => ({ collect: () => [] }),
        createStyleJar: () => ({ set() {}, restoreAll() {}, size: 0 }),
        nextFrames: () => Promise.resolve(),
        sleep: () => Promise.resolve(),
      },
      overlay: {
        createOverlay: (/** @type {any} */ h) => {
          handlers = h;
          return {
            host: {},
            keepOnTop() {},
            beginSelect() {},
            showSession() {},
            setStatus: (/** @type {any} */ status) => void statuses.push(JSON.parse(JSON.stringify(status))),
            setBusy() {},
            hideForCapture: () => Promise.resolve(),
            showAfterCapture() {},
            destroy() {},
          };
        },
      },
      toast: {
        show: (/** @type {any} */ opts) => {
          toasts.push(opts);
          return { setCopy: (/** @type {string} */ state) => void copies.push(state), close() {} };
        },
        dismiss() {},
      },
    },
  });
  vm.createContext(sandbox);
  vm.runInContext(UI_KIT_SOURCE, sandbox, { filename: 'ui-kit.js' });
  vm.runInContext(AGENT_SOURCE, sandbox, { filename: 'agent.js' });

  return {
    sandbox,
    releaseFinish: () => releaseFinish(),
    sent,
    writes,
    toasts,
    copies,
    statuses,
    scrollLog,
    page,
    clock,
    /** Replies for the next capture-frame messages. @param {unknown[]} replies */
    queueFrameReplies(...replies) {
      frameReplies.push(...replies);
    },
    types: () => sent.map((m) => m['type']),
    /** The FrameMeta of every capture-frame message so far. */
    frames: () => sent.filter((m) => m['type'] === MSG.PAGE_CAPTURE_FRAME).map((m) => m['meta']),
    /** The last status line. */
    status() {
      const last = statuses.at(-1);
      assert.ok(last, 'no status line yet');
      return last;
    },
    /** Starts the agent, picks the area, and takes the first frame. */
    async begin() {
      sandbox['__spool'].agent.start();
      assert.ok(handlers, 'the overlay was made');
      /** @type {any} */ (handlers).onRegion({ ...REGION });
      await flush();
    },
    /** One command of the overlay ('down', 'up', 'auto', 'done', 'cancel'); waits for it. @param {string} name */
    async cmd(name) {
      /** @type {any} */ (handlers).onCommand(name);
      await flush();
      await flush();
    },
    /** Presses Done in the task of this call (no wait): the clipboard write must start here. */
    done() {
      /** @type {any} */ (handlers).onCommand('done');
    },
    /** Runs the watchdog timers once. */
    async tick() {
      for (const timer of [...intervals]) if (!timer.cleared) timer.fn();
      await flush();
    },
  };
}
