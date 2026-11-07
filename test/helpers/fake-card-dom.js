// @ts-check
/**
 * A small fake page for the unit tests of the cards (ui-kit.js, toast.js, shelf.js): elements
 * that keep their children, attributes, styles and listeners, a window that dispatches events,
 * timers that the test advances by hand, a fake `chrome.runtime` and the browser APIs the cards
 * use (clipboard, createImageBitmap, DataTransfer, File, ClipboardEvent).
 *
 * The scripts are classic scripts. They load into a node:vm context whose globals are these fakes
 * (see `loadClassic`). The look of the cards and real pointer handling are covered by the e2e tests.
 */
import { loadClassic } from './load-classic.js';

/** An event target that records its listeners and can dispatch an event to them. */
export class FakeTarget {
  constructor() {
    /** @type {Map<string, { fn: (e: any) => void, capture: boolean }[]>} */
    this.listeners = new Map();
  }

  /**
   * @param {string} type
   * @param {(e: any) => void} fn
   * @param {any} [options]
   */
  addEventListener(type, fn, options) {
    const capture = options === true || Boolean(options && options.capture);
    const list = this.listeners.get(type) ?? [];
    list.push({ fn, capture });
    this.listeners.set(type, list);
  }

  /** @param {string} type @param {(e: any) => void} fn */
  removeEventListener(type, fn) {
    const list = this.listeners.get(type);
    if (list)
      this.listeners.set(
        type,
        list.filter((l) => l.fn !== fn),
      );
  }

  /** @param {string} type */
  listenerCount(type) {
    return this.listeners.get(type)?.length ?? 0;
  }

  /**
   * Calls every listener of the event's type. Returns false when the event was cancelled.
   * @param {any} event
   */
  dispatchEvent(event) {
    event.target ??= this;
    for (const { fn } of [...(this.listeners.get(event.type) ?? [])]) {
      if (event.immediatelyStopped) break;
      fn(event);
    }
    return !event.defaultPrevented;
  }

  /**
   * Makes a trusted event (like the browser's) and dispatches it. The returned event shows what
   * the listeners did with it.
   * @param {string} type
   * @param {Record<string, unknown>} [fields]
   */
  dispatch(type, fields = {}) {
    const event = {
      type,
      isTrusted: true,
      defaultPrevented: false,
      propagationStopped: false,
      immediatelyStopped: false,
      target: this,
      preventDefault() {
        this.defaultPrevented = true;
      },
      stopPropagation() {
        this.propagationStopped = true;
      },
      stopImmediatePropagation() {
        this.immediatelyStopped = true;
        this.propagationStopped = true;
      },
      ...fields,
    };
    this.dispatchEvent(event);
    return event;
  }
}

/** The inline style of a fake element. */
class FakeStyle {
  /** @param {string} name @param {string} value */
  setProperty(name, value) {
    /** @type {any} */ (this)[name] = value;
  }
}

export class FakeElement extends FakeTarget {
  /** @param {string} tag */
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.id = '';
    this.title = '';
    this.type = '';
    this.disabled = false;
    /** @type {any} */
    this.style = new FakeStyle();
    /** @type {Record<string, string>} */
    this.dataset = {};
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {any[]} */
    this.children = [];
    /** @type {any} */
    this.parentNode = null;
    this.removed = false;
    this.offsetWidth = 100;
    this.offsetHeight = 40;
    /** What getBoundingClientRect gives. A test sets it for an element that has a place. */
    this.rect = { top: 0, bottom: 0, left: 0, right: 0, width: 0, height: 0 };
    /** What `isContentEditable` says. */
    this.isContentEditable = false;
    this.width = 0;
    this.height = 0;
    this.focusCalls = 0;
    /** @type {any} */
    this.shadow = null;
    /** @type {any} */
    this.shadowRoot = null;
    /** The drawing context of a canvas. */
    this.drawn = /** @type {{ args: number[] }[]} */ ([]);
  }

  /** The text under this element. */
  get textContent() {
    return this.children.map((c) => (typeof c.data === 'string' ? c.data : c.textContent)).join('');
  }

  set textContent(value) {
    this.children = [{ data: String(value), parentNode: this }];
  }

  /** @param {any[]} nodes */
  append(...nodes) {
    for (const node of nodes) {
      if (node && typeof node === 'object' && 'parentNode' in node) {
        node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1);
        node.parentNode = this;
      }
      this.children.push(node);
    }
  }

  /** @param {any[]} nodes */
  replaceChildren(...nodes) {
    for (const child of this.children) if (child && typeof child === 'object') child.parentNode = null;
    this.children = [];
    this.append(...nodes);
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /** @param {string} name */
  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  getBoundingClientRect() {
    return this.rect;
  }

  attachShadow() {
    const shadow = new FakeElement('shadow');
    /** @type {any} */ (shadow).adoptedStyleSheets = [];
    /** @type {any} */ (shadow).activeElement = null;
    /** @type {any} */ (shadow).host = this;
    this.shadow = shadow;
    return shadow;
  }

  focus() {
    this.focusCalls += 1;
  }

  /** @param {string} kind */
  getContext(kind) {
    if (kind !== '2d') return null;
    return {
      imageSmoothingQuality: '',
      drawImage: (/** @type {any} */ _bitmap, /** @type {number[]} */ ...args) => {
        this.drawn.push({ args });
      },
    };
  }

  remove() {
    this.removed = true;
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }

  get isConnected() {
    return !this.removed;
  }
}

/**
 * A fake IntersectionObserver v2: the test says what it reports, with `report`.
 */
export class FakeIntersectionObserver {
  /** @param {(entries: any[]) => void} callback @param {any} options */
  constructor(callback, options) {
    this.callback = callback;
    this.options = options;
    /** @type {any[]} */
    this.targets = [];
    this.disconnected = false;
  }

  /** @param {any} target */
  observe(target) {
    this.targets.push(target);
  }

  disconnect() {
    this.disconnected = true;
  }

  /** @param {{ isIntersecting: boolean, isVisible?: boolean }} entry */
  report(entry) {
    this.callback([{ target: this.targets[0], ...entry }]);
  }
}

/** An element in a browser that has popovers. */
export class FakePopoverElement extends FakeElement {
  /** @param {string} tag */
  constructor(tag) {
    super(tag);
    /** @type {string | undefined} */
    this.popover = undefined;
    this.shown = 0;
    this.hidden = 0;
  }

  showPopover() {
    this.shown += 1;
  }

  hidePopover() {
    this.hidden += 1;
  }
}

/**
 * Every element below `root`, depth first (the shadow root of a host is searched too).
 * @param {any} root
 * @returns {Generator<any, void, undefined>}
 */
export function* walk(root) {
  yield root;
  if (root.shadow) yield* walk(root.shadow);
  for (const child of root.children ?? []) {
    if (child && typeof child === 'object' && 'children' in child) yield* walk(child);
  }
}

/**
 * @param {any} root
 * @param {(el: FakeElement) => boolean} test
 * @returns {FakeElement[]}
 */
export function findAll(root, test) {
  return [...walk(root)].filter((node) => node instanceof FakeElement && test(node));
}

/**
 * The one element that matches, or a failure.
 * @param {any} root
 * @param {(el: FakeElement) => boolean} test
 * @param {string} [what]
 * @returns {FakeElement}
 */
export function findOne(root, test, what = 'element') {
  const found = findAll(root, test);
  if (found.length !== 1) throw new Error(`${what}: found ${found.length}, wanted 1`);
  return /** @type {FakeElement} */ (found[0]);
}

/** The text under a node. @param {any} node @returns {string} */
export function textOf(node) {
  if (typeof node?.data === 'string') return node.data;
  return (node?.children ?? []).map(textOf).join('');
}

/** Timers that the test advances by hand. */
export function createTimers() {
  let now = 0;
  let nextId = 1;
  /** @type {Map<number, { at: number, fn: () => void, every: number | null }>} */
  const timers = new Map();
  return {
    get now() {
      return now;
    },
    get pending() {
      return timers.size;
    },
    /** @param {() => void} fn @param {number} ms */
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + Math.max(0, ms), fn, every: null });
      return id;
    },
    /** @param {() => void} fn @param {number} ms */
    setInterval(fn, ms) {
      const id = nextId++;
      timers.set(id, { at: now + ms, fn, every: ms });
      return id;
    },
    /** @param {number} id */
    clear(id) {
      timers.delete(id);
    },
    /** Runs every timer that is due within `ms`, in order. @param {number} ms */
    advance(ms) {
      const end = now + ms;
      for (;;) {
        let nextTimer = null;
        for (const [id, t] of timers) {
          if (t.at <= end && (!nextTimer || t.at < nextTimer.t.at)) nextTimer = { id, t };
        }
        if (!nextTimer) break;
        now = Math.max(now, nextTimer.t.at);
        if (nextTimer.t.every === null) timers.delete(nextTimer.id);
        else nextTimer.t.at += nextTimer.t.every;
        nextTimer.t.fn();
      }
      now = end;
    },
  };
}

/** Lets promises that are already resolved run. */
export const flush = () => new Promise((resolve) => setImmediate(resolve));

/** @param {string} base64 */
const bytesOf = (base64) => Buffer.from(base64, 'base64');

/**
 * A page with the fakes that the cards need, and the scripts loaded.
 * @param {{ files: string[], popover?: boolean, config?: Record<string, unknown>,
 *   replies?: Record<string, (msg: any) => unknown>, intersection?: boolean, hostname?: string,
 *   platform?: string }} options  `intersection`: the page has IntersectionObserver v2 (a fake
 *   that the test drives). `hostname`: the host name of the page (`location.hostname`).
 */
export function setupCards({
  files,
  popover = true,
  config,
  replies = {},
  intersection = false,
  hostname,
  platform = 'Win32',
}) {
  /** @type {FakeElement[]} */
  const created = [];
  const win = new FakeTarget();
  const timers = createTimers();
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  documentElement.append(body);
  /** @type {any[]} */
  const consoleErrors = [];
  /** @type {any[]} */
  const sent = [];
  /** @type {string[]} */
  const createdTags = [];

  const page = {
    /** @type {FakeElement[]} */
    modals: [],
    /** @type {any} */
    activeElement: body,
    /** What `document.elementsFromPoint` reports; null: the first host. @type {any[] | null} */
    stack: null,
    /** The editable elements of the page, as a query for them finds them. @type {any[]} */
    editables: [],
    /** Open shadow roots of the page: each one has a `host` and its own `editables`. @type {any[]} */
    shadowRoots: [],
  };
  /** @type {FakeIntersectionObserver[]} */
  const observers = [];
  const extension = { id: /** @type {string | undefined} */ ('ext-id') };
  const clipboard = {
    /** @type {{ types: string[], image: Promise<Blob> }[]} */
    writes: [],
    reject: false,
    missing: false,
  };
  const bitmaps = { closed: 0, fail: false };

  class FakeClipboardItem {
    /** @param {Record<string, Promise<Blob>>} data */
    constructor(data) {
      this.data = data;
    }
  }
  class FakeFile {
    /** @param {any[]} parts @param {string} name @param {{ type?: string }} [options] */
    constructor(parts, name, options = {}) {
      this.parts = parts;
      this.name = name;
      this.type = options.type ?? '';
    }
  }
  class FakeDataTransfer {
    constructor() {
      /** @type {FakeFile[]} */
      this.files = [];
      this.items = { add: (/** @type {FakeFile} */ file) => this.files.push(file) };
    }
  }
  class FakeClipboardEvent {
    /** @param {string} type @param {Record<string, any>} init */
    constructor(type, init = {}) {
      this.type = type;
      this.clipboardData = init.clipboardData;
      this.bubbles = init.bubbles === true;
      this.cancelable = init.cancelable === true;
      this.composed = init.composed === true;
      this.isTrusted = false;
      this.defaultPrevented = false;
    }

    preventDefault() {
      if (this.cancelable) this.defaultPrevented = true;
    }
  }

  /** @type {Record<string, any>} */
  const globals = {
    window: win,
    innerWidth: 1000,
    innerHeight: 800,
    devicePixelRatio: 2,
    document: {
      documentElement,
      body,
      get activeElement() {
        return page.activeElement;
      },
      querySelectorAll: (/** @type {string} */ selector) => {
        if (selector === 'dialog:modal') return page.modals;
        if (selector.includes('contenteditable')) return page.editables;
        if (selector === '*') return page.shadowRoots.map((root) => root.host);
        return [];
      },
      elementsFromPoint: () => page.stack ?? [created[0]],
      createElement: (/** @type {string} */ tag) => {
        createdTags.push(tag);
        const el = popover ? new FakePopoverElement(tag) : new FakeElement(tag);
        created.push(el);
        return el;
      },
      createElementNS: (/** @type {string} */ _ns, /** @type {string} */ tag) => {
        createdTags.push(tag);
        return new FakeElement(tag);
      },
      createTextNode: (/** @type {string} */ data) => ({ data, parentNode: null }),
    },
    CSSStyleSheet: class {
      constructor() {
        this.text = '';
      }

      /** @param {string} text */
      replaceSync(text) {
        this.text = text;
      }
    },
    console: { error: (/** @type {any[]} */ ...args) => consoleErrors.push(args) },
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.setTimeout(fn, ms),
    clearTimeout: (/** @type {number} */ id) => timers.clear(id),
    setInterval: (/** @type {() => void} */ fn, /** @type {number} */ ms) => timers.setInterval(fn, ms),
    clearInterval: (/** @type {number} */ id) => timers.clear(id),
    performance: { now: () => timers.now },
    atob: (/** @type {string} */ s) => Buffer.from(s, 'base64').toString('binary'),
    Blob,
    File: FakeFile,
    DataTransfer: FakeDataTransfer,
    ClipboardEvent: FakeClipboardEvent,
    ClipboardItem: FakeClipboardItem,
    createImageBitmap: (/** @type {Blob} */ blob) => {
      if (bitmaps.fail || blob.size === 0) return Promise.reject(new Error('cannot decode'));
      return Promise.resolve({
        width: 320,
        height: 480,
        close: () => {
          bitmaps.closed += 1;
        },
      });
    },
    navigator: {
      platform,
      get clipboard() {
        if (clipboard.missing) return undefined;
        return {
          write: (/** @type {FakeClipboardItem[]} */ items) => {
            const first = items[0];
            const image = first?.data['image/png'] ?? Promise.reject(new Error('no image'));
            clipboard.writes.push({ types: Object.keys(first?.data ?? {}), image });
            if (clipboard.reject) return Promise.reject(new Error('NotAllowedError'));
            return image.then(() => undefined);
          },
        };
      },
    },
    chrome: {
      runtime: {
        get id() {
          return extension.id;
        },
        sendMessage: (/** @type {any} */ msg) => {
          sent.push(JSON.parse(JSON.stringify(msg)));
          const reply = replies[msg.type];
          return Promise.resolve(reply ? reply(msg) : { ok: true });
        },
      },
    },
    __spool: {},
  };
  if (config) globals['__spool'].config = config;
  if (hostname !== undefined) globals['location'] = { hostname };
  if (intersection) {
    globals['IntersectionObserver'] = class extends FakeIntersectionObserver {
      /** @param {(entries: any[]) => void} callback @param {any} options */
      constructor(callback, options) {
        super(callback, options);
        observers.push(this);
      }
    };
  }

  /** @type {any} */
  let context = globals;
  for (const file of files) context = loadClassic(file, context);
  const ns = /** @type {any} */ (context).__spool;

  return {
    ns,
    /** The global object of the vm context: a test can replace or delete a global of the page. */
    context: /** @type {Record<string, any>} */ (context),
    win,
    timers,
    documentElement,
    body,
    page,
    extension,
    clipboard,
    bitmaps,
    sent,
    /** The IntersectionObservers that the scripts made, oldest first. */
    observers,
    /** The fake `chrome.runtime`: a test can replace `sendMessage`. */
    runtime: /** @type {any} */ (globals['chrome'].runtime),
    created,
    createdTags,
    consoleErrors,
    /** The hosts of the cards that are on screen now. */
    hosts: () => /** @type {FakeElement[]} */ ([...(ns.cardHosts ?? [])]),
    /** The content of the shadow root of a host. @param {FakeElement} host */
    rootOf: (host) => /** @type {FakeElement} */ (host.shadow.children[0]),
    /** @param {string} base64 */
    bytesOf,
  };
}
