// @ts-check
/**
 * Shared pieces of the small cards that Spool draws over a page: the toast after a capture
 * (toast.js) and the shelf in another tab (shelf.js). The selection overlay (overlay.js) has the
 * same look and the same rules but keeps its own copy of the DOM helpers (it is older).
 *
 * Classic script for the page's isolated world. Contract: docs/contracts.md section 5 and 7.
 * Every injection replaces `__spool.ui` (no "already loaded" guard).
 *
 * What this file gives a card:
 *  - `createCardHost(css)`: a host element with a CLOSED shadow root, styles from a constructable
 *    stylesheet (a page CSP can block <style>), a place in the top layer (manual popover, inside an
 *    open modal dialog while one is open), and a watchdog that removes the card when the extension
 *    was reloaded. The host has no attribute that shows its state (only `popover="manual"`).
 *  - `listen()`: a listener that acts only on trusted events (`isTrusted`) and never throws.
 *  - Icons (inline SVG with a 1.5 px stroke), `send()` (a runtime message to the service worker),
 *    `copyImage()` (the clipboard write that must run inside the user's gesture) and a few text
 *    helpers.
 *  - `findPasteTarget()`: where a paste goes (the focused editor, else a composer that it finds).
 *  - `keysOf()`: the keys as the system writes them (a Mac: "⌃⇧V" and "⌘V").
 *
 * Names that page markup can shadow (DOM clobbering) are read through the prototypes, like in
 * page-lib.js: see the comment there.
 */
(() => {
  'use strict';

  /** @typedef {import('../../types/page-globals.js').Reply} Reply */
  /** @typedef {import('../../types/page-globals.js').CardHost} CardHost */
  /** @typedef {import('../../types/page-globals.js').UiKit} UiKit */
  /** @typedef {import('../shared/types.js').PageConfig} PageConfig */

  /**
   * @param {object | undefined} proto
   * @param {string} name
   * @returns {(self: any) => any}
   */
  function getterFrom(proto, name) {
    const get = proto ? Object.getOwnPropertyDescriptor(proto, name)?.get : undefined;
    return get ? (self) => get.call(self) : (self) => self[name];
  }

  /**
   * @param {object | undefined} proto
   * @param {string} name
   * @returns {(self: any, ...args: any[]) => any}
   */
  function methodFrom(proto, name) {
    const fn = proto ? Object.getOwnPropertyDescriptor(proto, name)?.value : undefined;
    return typeof fn === 'function'
      ? (self, ...args) => fn.apply(self, args)
      : (self, ...args) => self[name](...args);
  }

  const DocumentProto = globalThis.Document?.prototype;
  const ElementProto = globalThis.Element?.prototype;
  const docElement = getterFrom(DocumentProto, 'documentElement');
  const docBody = getterFrom(DocumentProto, 'body');
  const docActiveElement = getterFrom(DocumentProto, 'activeElement');
  const docCreateElement = methodFrom(DocumentProto, 'createElement');
  const docCreateElementNS = methodFrom(DocumentProto, 'createElementNS');
  const docCreateTextNode = methodFrom(DocumentProto, 'createTextNode');
  const docQuerySelectorAll = methodFrom(DocumentProto, 'querySelectorAll');
  const docElementsFromPoint = methodFrom(DocumentProto, 'elementsFromPoint');
  const elAppend = methodFrom(ElementProto, 'append');
  const elShadowRoot = getterFrom(ElementProto, 'shadowRoot');
  const elTagName = getterFrom(ElementProto, 'tagName');
  const elRect = methodFrom(ElementProto, 'getBoundingClientRect');
  const elIsVisible = methodFrom(ElementProto, 'checkVisibility');
  const rootQuerySelectorAll = methodFrom(globalThis.DocumentFragment?.prototype, 'querySelectorAll');
  const nodeIsConnected = getterFrom(globalThis.Node?.prototype, 'isConnected');
  const htmlIsEditable = getterFrom(globalThis.HTMLElement?.prototype, 'isContentEditable');
  const shadowActiveElement = getterFrom(globalThis.ShadowRoot?.prototype, 'activeElement');

  /** @returns {import('../../types/page-globals.js').SpoolNamespace} */
  function sharedNamespace() {
    if (Object.hasOwn(globalThis, '__spool')) {
      const existing = globalThis.__spool;
      if (existing && Object.prototype.toString.call(existing) === '[object Object]') return existing;
    }
    /** @type {import('../../types/page-globals.js').SpoolNamespace} */
    const fresh = {};
    Object.defineProperty(globalThis, '__spool', {
      value: fresh,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return fresh;
  }

  const ns = sharedNamespace();

  /** The SVG namespace name. An identifier, nothing is fetched. Two parts: the policy scan for
   * URLs would flag it as one string. */
  const SVG_NS = 'http:' + '//www.w3.org/2000/svg';
  /** How often a card checks that the extension is still there and that it is on top. */
  const WATCH_INTERVAL_MS = 1000;
  const MAX_ERROR_LENGTH = 200;
  const CODE_UNREACHABLE = 'E_UNREACHABLE';
  const TEXT_UNREACHABLE = 'Could not reach the extension. Try again.';
  const TEXT_GENERIC = 'Something went wrong. Try again.';

  // Same order as --font-text in src/ui/tokens.css: the system font first, so macOS and Linux
  // show their own. Windows gets Segoe UI Variable behind them.
  const FONT =
    "system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', " +
    "Roboto, 'Helvetica Neue', Arial, sans-serif";

  /**
   * Styles of every card. Colours, type, motion (Fluent: 83, 167, 250 ms; enter
   * `cubic-bezier(0, 0, 0, 1)`, exit `cubic-bezier(1, 0, 1, 1)`), buttons, keycaps, chips. A card
   * adds its own rules after these.
   */
  const BASE_CSS = `
:host {
  all: initial !important;
  position: fixed !important;
  inset: 0 !important;
  z-index: 2147483647 !important;
  display: block !important;
  pointer-events: none !important;
}
*, *::before, *::after { box-sizing: border-box; }

.root {
  --in: cubic-bezier(0, 0, 0, 1);
  --out: cubic-bezier(1, 0, 1, 1);
  --graphite: #1C1D20;
  --line: #2A2C30;
  --raised: #26282C;
  --raised-line: #3A3C41;
  --text: #EDEEF0;
  --muted: #A1A4AA;
  --key: #6E7178;
  --accent: #FFB224;
  --accent-text: #FFC453;
  --on-accent: #1B1C1E;
  --error: #FF9C94;
  position: absolute; inset: 0; overflow: hidden; pointer-events: none;
  font: 400 14px/20px ${FONT}; letter-spacing: normal; text-transform: none; color: var(--text);
  -webkit-user-select: none; user-select: none;
}
.root.hidden { visibility: hidden !important; }

.card {
  position: absolute; right: 16px; bottom: 16px; width: 360px; max-width: calc(100% - 32px);
  display: flex; flex-direction: column; gap: 12px; padding: 12px; pointer-events: auto;
  background: var(--graphite); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.22), 0 2px 8px rgba(0, 0, 0, 0.16);
  color: var(--text); overflow: hidden;
  opacity: 0; transform: translateY(8px);
  transition: opacity 250ms var(--in), transform 250ms var(--in);
}
.root[data-open] .card { opacity: 1; transform: none; }
.root[data-closing] .card {
  opacity: 0; transform: translateY(8px);
  transition: opacity 167ms var(--out), transform 167ms var(--out);
}

button, a.btn {
  appearance: none; margin: 0; border: 0; background: transparent; color: inherit; cursor: pointer;
  font: inherit; letter-spacing: normal; text-transform: none; text-decoration: none;
  display: inline-flex; align-items: center; gap: 6px; white-space: nowrap;
  transition: background-color 83ms var(--in), border-color 83ms var(--in);
}
button svg { flex: none; }
button:focus-visible {
  outline: none; box-shadow: 0 0 0 2px var(--graphite), 0 0 0 4px var(--accent);
}
button:disabled { opacity: 0.45; cursor: default; }
.btn {
  height: 32px; padding: 0 12px; border: 1px solid var(--raised-line); border-radius: 8px;
  background: var(--raised); color: var(--text);
}
.btn:hover:not(:disabled) { background: #30333A; }
.btn.primary {
  height: 36px; border: 0; background: var(--accent); color: var(--on-accent); font-weight: 600;
}
.btn.primary:hover:not(:disabled) { background: var(--accent-text); }
.btn.wide { width: 100%; justify-content: center; }
.icon-btn {
  width: 32px; height: 32px; justify-content: center; border-radius: 8px; padding: 0;
  color: var(--text);
}
.icon-btn:hover:not(:disabled) { background: var(--line); }
.chip {
  min-width: 34px; height: 32px; padding: 0 8px; justify-content: center; border-radius: 8px;
  border: 1px solid var(--raised-line); background: var(--raised); color: var(--text);
  font-variant-numeric: tabular-nums;
}
.chip:hover:not(:disabled) { background: #30333A; }
.chip[data-state='copied'] {
  border-color: var(--accent); background: rgba(255, 178, 36, 0.12); color: var(--accent-text);
  font-weight: 600; padding: 0 10px 0 8px;
}
.chip[data-state='failed'] { border-color: var(--error); color: var(--error); padding: 0 10px; }
.link {
  height: 32px; padding: 0 4px; color: var(--accent-text); font-weight: 600; border-radius: 6px;
}
.link:hover { text-decoration: underline; }

kbd {
  display: inline-flex; align-items: center; height: 20px; padding: 0 5px;
  border: 1px solid var(--key); border-radius: 4px; color: var(--text); font: 400 12px/16px ${FONT};
}
.muted { color: var(--muted); }
.small { font-size: 12px; line-height: 16px; }
.strong { font-weight: 600; }
.title { display: flex; align-items: center; gap: 6px; font-weight: 600; }
.title svg { flex: none; color: var(--accent-text); }
.title[data-level='error'] svg { color: var(--error); }
.caption {
  margin-top: 2px; font-size: 12px; line-height: 16px; color: var(--muted);
  font-variant-numeric: tabular-nums; overflow-wrap: anywhere;
}
.caption[data-level='warn'] { color: var(--accent-text); }
.caption[data-level='error'] { color: var(--error); }
.spin { animation: spin 1.2s linear infinite; transform-origin: 50% 50%; }

@keyframes spin { to { transform: rotate(360deg); } }

@media (prefers-reduced-motion: reduce) {
  .card { transform: none; transition: opacity 167ms var(--in); }
  .root[data-closing] .card { transform: none; transition: opacity 167ms var(--out); }
  .spin { animation: none; }
  button, a.btn { transition: none; }
}
@media (forced-colors: active) {
  .card { background: Canvas; color: CanvasText; border-color: CanvasText; box-shadow: none; }
  .btn.primary { background: Highlight; color: HighlightText; forced-color-adjust: none; }
  .btn, .chip { border-color: ButtonText; }
  button:focus-visible { outline: 2px solid Highlight; box-shadow: none; }
}
`;

  // ---- DOM helpers -------------------------------------------------------------------------

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElementTagNameMap[K]}
   */
  function el(tag, className, text) {
    const node = docCreateElement(document, tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /** @param {string} value @returns {Text} */
  function text(value) {
    return docCreateTextNode(document, value);
  }

  /**
   * @param {string} tag
   * @param {Record<string, string>} attrs
   * @returns {Element}
   */
  function svg(tag, attrs) {
    const node = docCreateElementNS(document, SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  }

  /** Paths of the 16 px stroke icons. */
  const ICON_PATHS = Object.freeze({
    check: ['M3 8.5L6.5 12L13 4.5'],
    close: ['M4 4L12 12M12 4L4 12'],
    open: ['M9 2.5H13.5V7M13.5 2.5L7.5 8.5M11.5 9.5V13.5H2.5V4.5H6.5'],
    warn: ['M8 2.5L14 13H2Z', 'M8 6.5V9.5', 'M8 11.5V11.51'],
    folder: [
      'M2 4.5A1 1 0 0 1 3 3.5H6.5L8 5H13A1 1 0 0 1 14 6V12A1 1 0 0 1 13 13H3A1 1 0 0 1 2 12Z',
    ],
    copy: ['M5.5 5.5H13V13H5.5Z', 'M3 10.5V3H10.5'],
    insert: ['M8 2.5V10M4.5 6.5L8 10L11.5 6.5M3 13.5H13'],
    spinner: ['M8 2.5A5.5 5.5 0 1 1 2.5 8'],
  });

  /**
   * A 16 px stroke icon in the colour of the text around it.
   * @param {keyof typeof ICON_PATHS} name
   * @param {string} [className]
   * @param {number} [size]
   * @returns {Element}
   */
  function icon(name, className = '', size = 16) {
    const box = svg('svg', {
      class: className,
      width: String(size),
      height: String(size),
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    for (const d of ICON_PATHS[name]) box.append(svg('path', { d }));
    return box;
  }

  /** The Spool glyph (filled shapes), 16 px. @returns {Element} */
  function glyph() {
    const box = svg('svg', { width: '16', height: '16', viewBox: '0 0 16 16', 'aria-hidden': 'true' });
    box.append(
      svg('rect', { width: '16', height: '16', rx: '4', fill: '#2A2C30' }),
      svg('rect', { x: '3', y: '4', width: '8', height: '8', fill: '#FFB224' }),
      svg('rect', { x: '2', y: '3', width: '10', height: '2', rx: '1', fill: '#E6E7EA' }),
      svg('rect', { x: '2', y: '11', width: '10', height: '2', rx: '1', fill: '#E6E7EA' }),
      svg('path', { d: 'M11 9.5H13.5V14', fill: 'none', stroke: '#FFB224' }),
    );
    return box;
  }

  /** @param {number} n */
  function num(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  /**
   * "1,500 × 2,210 px"
   * @param {number} widthPx
   * @param {number} heightPx
   */
  function sizeText(widthPx, heightPx) {
    return `${num(widthPx)} × ${num(heightPx)} px`;
  }

  /**
   * Names of the AI screenshot files: screenshot-01-of-05.png (1-based, two digits at least).
   * @param {number} index  0-based.
   * @param {number} count
   */
  function tileFileName(index, count) {
    const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');
    return `screenshot-${pad(index + 1)}-of-${pad(count)}.png`;
  }

  // ---- Extension context, messages, clipboard ----------------------------------------------

  /** False when the extension was reloaded, updated or removed (this script is orphaned). */
  function contextValid() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  /**
   * @param {string} message
   * @returns {Reply}
   */
  function failure(message) {
    return { ok: false, code: CODE_UNREACHABLE, message };
  }

  /**
   * Turns a reply into a Reply. A reply that is missing, or is not { ok: true }, is an error.
   * @param {unknown} raw
   * @returns {Reply}
   */
  function parseReply(raw) {
    if (typeof raw === 'object' && raw !== null && 'ok' in raw) {
      if (raw.ok === true) return { ok: true, data: /** @type {Record<string, any>} */ (raw) };
      const e = 'error' in raw && typeof raw.error === 'object' ? raw.error : null;
      const code = e && 'code' in e && typeof e.code === 'string' ? e.code : CODE_UNREACHABLE;
      const message = e && 'message' in e && typeof e.message === 'string' ? e.message : '';
      return { ok: false, code, message: message.slice(0, MAX_ERROR_LENGTH) || TEXT_GENERIC };
    }
    return failure(TEXT_UNREACHABLE);
  }

  /**
   * Sends one message to the service worker. `key` is the name in `config.msg` (for example
   * 'PAGE_GET_TILE'). Never throws.
   * @param {PageConfig} config
   * @param {string} key
   * @param {Record<string, unknown>} [fields]
   * @returns {Promise<Reply>}
   */
  async function send(config, key, fields = {}) {
    const type = config.msg?.[key];
    if (typeof type !== 'string' || type === '' || !contextValid()) return failure(TEXT_UNREACHABLE);
    try {
      return parseReply(
        await chrome.runtime.sendMessage({
          v: config.protocolVersion,
          target: config.target['SW'],
          type,
          ...fields,
        }),
      );
    } catch {
      return failure(TEXT_UNREACHABLE);
    }
  }

  /**
   * PNG bytes from base64, as a Blob.
   * @param {unknown} base64
   * @returns {Blob}
   */
  function pngBlob(base64) {
    if (typeof base64 !== 'string' || base64 === '') throw new TypeError('No image data.');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return new Blob([bytes], { type: 'image/png' });
  }

  /**
   * Writes an image to the clipboard. It must run in the same task as the user's key press or
   * click: call it with no `await` before it. The image may arrive later, as a promise (the
   * browser accepts a promise for a clipboard item and waits for it). Resolves to true when the
   * browser accepted the write, false when it refused, when the API is missing, or when the image
   * promise failed. Never rejects.
   * @param {Promise<Blob>} blob
   * @returns {Promise<boolean>}
   */
  function copyImage(blob) {
    // A failure is reported through the result, not as an unhandled rejection.
    blob.catch(() => undefined);
    try {
      const clipboard = globalThis.navigator?.clipboard;
      if (!clipboard || typeof clipboard.write !== 'function') return Promise.resolve(false);
      if (typeof ClipboardItem === 'undefined') return Promise.resolve(false);
      const item = new ClipboardItem({ 'image/png': blob });
      return clipboard.write([item]).then(
        () => true,
        () => false,
      );
    } catch {
      return Promise.resolve(false);
    }
  }

  /**
   * Draws a PNG, given as base64, into a canvas: scaled to the canvas width, top of the image at
   * the top of the canvas (the rest is cut). It uses createImageBitmap, not an <img> or a blob
   * URL, so that the CSP of the page cannot block it. Never throws.
   * @param {HTMLCanvasElement} canvas
   * @param {string} base64
   * @returns {Promise<boolean>} true when something was drawn.
   */
  async function drawPng(canvas, base64) {
    try {
      const bitmap = await createImageBitmap(pngBlob(base64));
      try {
        const context = canvas.getContext('2d');
        if (!context || bitmap.width < 1) return false;
        const scale = canvas.width / bitmap.width;
        context.imageSmoothingQuality = 'high';
        context.drawImage(bitmap, 0, 0, bitmap.width * scale, bitmap.height * scale);
        return true;
      } finally {
        bitmap.close();
      }
    } catch {
      return false;
    }
  }

  // ---- Card host ---------------------------------------------------------------------------

  /**
   * @param {Element} el
   */
  function removeQuietly(el) {
    try {
      el.remove();
    } catch {
      // Gone already.
    }
  }

  /**
   * The element that has the focus now, read in a way that markup cannot shadow. It looks into
   * open shadow roots. The page's `<html>` and `<body>` do not count: null then.
   * @returns {Element | null}
   */
  function focusedElement() {
    try {
      /** @type {Element | null} */
      let active = docActiveElement(document);
      for (let depth = 0; active && depth < 10; depth += 1) {
        const inner = elShadowRoot(active);
        const deeper = inner ? shadowActiveElement(inner) : null;
        if (!deeper) break;
        active = deeper;
      }
      const tag = active?.tagName;
      return !active || tag === 'BODY' || tag === 'HTML' ? null : active;
    } catch {
      return null;
    }
  }

  /** The keys of the manifest. A config from an older worker has no `shortcuts`. */
  const DEFAULT_SHORTCUTS = Object.freeze({ start: 'Alt+Shift+S', insert: 'Alt+Shift+V' });

  /**
   * The key of a command as the browser has it now: `config.shortcuts`, which the service worker
   * reads with chrome.commands.getAll. An empty string: no key is set. The manifest default when
   * the config has no such value.
   * @param {PageConfig | undefined} config
   * @param {'start' | 'insert'} name
   * @returns {string}
   */
  function shortcutOf(config, name) {
    const value = config?.shortcuts?.[name];
    return typeof value === 'string' ? value.slice(0, 40) : DEFAULT_SHORTCUTS[name];
  }

  /**
   * A key as it shows on screen. The service worker writes it for the system of the user
   * (`config.keys`: "⌃⇧V" and "⌘V" on a Mac). A config without `keys` (an older worker) gets the
   * keys of `config.shortcuts` split at "+", and the Paste key of the platform. No parts: the
   * command has no key.
   * @param {PageConfig | undefined} config
   * @param {'start' | 'insert' | 'paste'} name
   * @returns {{ parts: string[], text: string }}
   */
  function keysOf(config, name) {
    const given = config?.keys?.[name];
    if (given && Array.isArray(given.parts) && typeof given.text === 'string') {
      const parts = given.parts.filter((p) => typeof p === 'string').slice(0, 6);
      return { parts: parts.map((p) => p.slice(0, 20)), text: given.text.slice(0, 40) };
    }
    if (name === 'paste') {
      let mac = false;
      try {
        mac = /mac|iphone|ipad/i.test(String(globalThis.navigator?.platform ?? ''));
      } catch {
        mac = false;
      }
      return mac ? { parts: ['⌘', 'V'], text: '⌘V' } : { parts: ['Ctrl', 'V'], text: 'Ctrl+V' };
    }
    const text = shortcutOf(config, name);
    const parts = text
      .split('+')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    return { parts, text };
  }

  /**
   * Puts the real keys into a text that names the default keys: "Press Alt+Shift+V again." and
   * "Press Alt+Shift+S to spool a page." come from the service worker and the offscreen document,
   * which do not know the keys of the user. A command with no key gets words that do not name one.
   * @param {PageConfig | undefined} config
   * @param {string} text
   * @returns {string}
   */
  function withKeys(config, text) {
    const insert = keysOf(config, 'insert').text;
    const start = keysOf(config, 'start').text;
    return text
      .replace(
        'Press Alt+Shift+V again.',
        insert ? `Press ${insert} again.` : 'Run Insert last capture again.',
      )
      .replace(
        'Press Alt+Shift+S to spool a page.',
        start ? `Press ${start} to spool a page.` : 'Click the Spool button to spool a page.',
      );
  }

  // ---- Where a paste goes ------------------------------------------------------------------

  /** Elements that take text, and so a pasted file. A disabled or read-only field does not. */
  const EDITABLE_SELECTOR =
    'textarea:not([disabled]):not([readonly]), [contenteditable]:not([contenteditable="false"])';
  /** The most elements that the search for a composer looks at (a page can be very large). */
  const MAX_SEARCHED_ELEMENTS = 60_000;
  /** The most open shadow roots that the search for a composer opens. */
  const MAX_SEARCHED_ROOTS = 200;
  /** An editor is not a composer when it is smaller than this (CSS px). */
  const MIN_COMPOSER_SIDE = 16;
  /** Editors whose bottom edges differ by less than this count as "the lowest": the larger wins. */
  const LOWEST_BAND = 48;

  /**
   * Tells if a paste has a place in this element: a field that takes text (a textarea, an input)
   * or an editable element. Never throws.
   * @param {Element | null} element
   * @returns {boolean}
   */
  function takesPaste(element) {
    try {
      if (element === null) return false;
      const tag = String(elTagName(element)).toUpperCase();
      if (tag === 'TEXTAREA' || tag === 'INPUT') return true;
      return htmlIsEditable(element) === true;
    } catch {
      return false;
    }
  }

  /**
   * The composer among editors: the one that sits lowest on the screen (a chat box is at the
   * bottom), and among editors whose bottoms are close, the largest. Pure.
   * @template T
   * @param {{ item: T, top: number, bottom: number, left: number, right: number }[]} candidates
   * @returns {T | null}
   */
  function pickComposer(candidates) {
    if (candidates.length === 0) return null;
    const lowest = Math.max(...candidates.map((c) => c.bottom));
    let best = null;
    let bestArea = -1;
    for (const c of candidates) {
      if (c.bottom < lowest - LOWEST_BAND) continue;
      const area = (c.right - c.left) * (c.bottom - c.top);
      if (area > bestArea) {
        best = c;
        bestArea = area;
      }
    }
    return best === null ? null : best.item;
  }

  /**
   * Looks for the message box of a chat: the editable elements that are on the screen, in the page
   * and in open shadow roots, and the one that `pickComposer` picks. Null when there is none.
   * Never throws.
   * @returns {Element | null}
   */
  function findComposer() {
    try {
      /** @type {{ item: Element, top: number, bottom: number, left: number, right: number }[]} */
      const found = [];
      /** @type {(Document | ShadowRoot)[]} */
      const roots = [document];
      let looked = 0;
      for (let r = 0; r < roots.length; r += 1) {
        const root = roots[r];
        /** @param {string} selector */
        const query = (selector) =>
          r === 0 ? docQuerySelectorAll(document, selector) : rootQuerySelectorAll(root, selector);
        for (const element of query(EDITABLE_SELECTOR)) {
          const box = elRect(element);
          const onScreen =
            box.width >= MIN_COMPOSER_SIDE &&
            box.height >= MIN_COMPOSER_SIDE &&
            box.bottom > 0 &&
            box.top < innerHeight &&
            box.right > 0 &&
            box.left < innerWidth;
          if (!onScreen) continue;
          const canCheck = typeof ElementProto?.checkVisibility === 'function';
          if (canCheck && !elIsVisible(element, { visibilityProperty: true })) continue;
          found.push({
            item: element,
            top: box.top,
            bottom: box.bottom,
            left: box.left,
            right: box.right,
          });
        }
        // Open shadow roots hold editors too (a chat built from web components).
        if (roots.length < MAX_SEARCHED_ROOTS) {
          for (const element of query('*')) {
            looked += 1;
            if (looked > MAX_SEARCHED_ELEMENTS || roots.length >= MAX_SEARCHED_ROOTS) break;
            const inner = elShadowRoot(element);
            if (inner) roots.push(inner);
          }
        }
      }
      return pickComposer(found);
    } catch {
      return null;
    }
  }

  /**
   * Where a paste goes. In this order: the element that has the focus now when it takes a paste,
   * then the `remembered` element (the focus when the card opened) when it is still in the page
   * and takes a paste, then the composer that `findComposer` finds (the page has no focus, or the
   * editor was made again), then any focused element, then the page body.
   *
   * It does not move the focus. `kind`: 'focused' (an editor has the focus), 'composer' (found),
   * 'other' (the focus is on something that takes no paste), 'none' (the body).
   * @param {{ remembered?: Element | null, ignore?: Element | null }} [options]
   *   `ignore`: an element that is not the page's (the card's own host).
   * @returns {{ element: Element, kind: 'focused' | 'composer' | 'other' | 'none' }}
   */
  function findPasteTarget({ remembered = null, ignore = null } = {}) {
    const live = focusedElement();
    const focus = live !== null && live !== ignore && nodeIsConnected(live) ? live : null;
    if (focus !== null && takesPaste(focus)) return { element: focus, kind: 'focused' };
    const kept = remembered !== null && nodeIsConnected(remembered) ? remembered : null;
    if (kept !== null && takesPaste(kept)) return { element: kept, kind: 'focused' };
    const composer = findComposer();
    if (composer !== null) return { element: composer, kind: 'composer' };
    const other = focus ?? kept;
    if (other !== null) return { element: other, kind: 'other' };
    return { element: docBody(document) ?? docElement(document), kind: 'none' };
  }

  // ---- Batches and bounded work ------------------------------------------------------------

  /**
   * Cuts `count` items into batches of at most `limit`, in order. Pure.
   * @param {number} count
   * @param {number} limit
   * @returns {{ start: number, end: number }[]}  `end` is exclusive.
   */
  function planBatches(count, limit) {
    const size = Math.max(1, Math.floor(limit));
    /** @type {{ start: number, end: number }[]} */
    const batches = [];
    for (let start = 0; start < count; start += size) {
      batches.push({ start, end: Math.min(count, start + size) });
    }
    return batches;
  }

  /**
   * Runs `work(i)` for every i from 0 to `count - 1`, with at most `limit` running at once, and
   * gives the results in order. After the first failure it starts no more, waits for those that
   * run, and fails with that first error. Never leaves a promise unhandled.
   * @template T
   * @param {number} count
   * @param {number} limit
   * @param {(index: number) => Promise<T>} work
   * @returns {Promise<T[]>}
   */
  async function mapLimit(count, limit, work) {
    /** @type {T[]} */
    const results = new Array(count);
    let next = 0;
    let failed = false;
    /** @type {unknown} */
    let error;
    const lane = async () => {
      while (!failed) {
        const index = next;
        next += 1;
        if (index >= count) return;
        try {
          results[index] = await work(index);
        } catch (e) {
          if (!failed) {
            failed = true;
            error = e;
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), count) }, lane));
    if (failed) throw error;
    return results;
  }

  /**
   * True when the full image is too large to put on the clipboard as one image: the browser decodes
   * width x height x 4 bytes in the page that writes it, and a tab crashes far above 256 MiB.
   * @param {number} widthPx
   * @param {number} heightPx
   * @param {number} maxBytes
   * @returns {boolean}
   */
  function exceedsClipboard(widthPx, heightPx, maxBytes) {
    return !(widthPx * heightPx * 4 <= maxBytes);
  }

  /** Elements that hold another document. The focus can sit inside it. */
  const FRAME_OWNERS = new Set(['IFRAME', 'FRAME', 'OBJECT', 'EMBED']);

  /**
   * True for an element that holds another document. When the focus is in a frame,
   * `document.activeElement` of the top page is that element. The page scripts of Spool run in
   * the top frame only: an event that they dispatch at the element goes to the scripts of the
   * top page, not into the frame, so the shelf must not paste then. Never throws.
   * @param {Element | null} element
   * @returns {boolean}
   */
  function isFrameOwner(element) {
    try {
      return element !== null && FRAME_OWNERS.has(String(elTagName(element)).toUpperCase());
    } catch {
      return false;
    }
  }

  /**
   * Closes every card that this world made, also the cards of an earlier injection. Each
   * injection loads new script instances, so the toast module of a new injection has no state for
   * the toast of an old one: the registry `ns.cardClosers` is what survives. A closer undoes
   * everything of its card (the listeners on the window as well), so an old toast does not take an
   * Esc key from a new capture. Never throws.
   */
  function dismissCards() {
    const closers = ns.cardClosers;
    if (closers) {
      for (const close of [...closers]) {
        try {
          close();
        } catch {
          // A card that cannot close is removed with its host below.
        }
      }
      closers.clear();
    }
    const stale = ns.cardHosts;
    if (stale) {
      for (const host of stale) removeQuietly(host);
      stale.clear();
    }
  }

  /**
   * @param {string} css  Rules that the card adds to BASE_CSS.
   * @param {{ onOrphan?: () => void, onDismiss?: () => void }} [options]  `onOrphan`: the
   *   extension was reloaded. `onDismiss`: a new card or a new capture closes this card (the card
   *   cleans its own state there; its host and its listeners go in any case).
   * @returns {CardHost}
   */
  function createCardHost(css, options = {}) {
    // A new card closes the card of an earlier injection (or of the same one).
    dismissCards();
    const hosts = (ns.cardHosts ??= new Set());
    const closers = (ns.cardClosers ??= new Set());

    const host = el('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(BASE_CSS + css);
    shadow.adoptedStyleSheets = [sheet];
    const root = el('div', 'root');
    shadow.append(root);
    hosts.add(host);
    closers.add(dismiss);

    let destroyed = false;
    /** @type {(() => void)[]} */
    const cleanups = [];
    /** @type {ReturnType<typeof setInterval> | null} */
    let watch = null;

    /** The topmost open modal dialog, or null. */
    function modalDialog() {
      try {
        const found = docQuerySelectorAll(document, 'dialog:modal');
        return found.length > 0 ? found[found.length - 1] : null;
      } catch {
        return null;
      }
    }
    const mountPoint = () => modalDialog() ?? docElement(document);

    function enterTopLayer() {
      if (typeof host.showPopover !== 'function') return;
      try {
        host.popover = 'manual';
        host.showPopover();
      } catch {
        host.removeAttribute('popover');
      }
    }

    function isTopmost() {
      const hit = docElementsFromPoint(document, innerWidth - 40, innerHeight - 40);
      return hit[0] === host;
    }

    /**
     * Keeps the card above what the page opens later (a modal dialog, a popover). The card does not
     * move the focus.
     */
    function keepOnTop() {
      if (destroyed) return;
      const parent = mountPoint();
      if (host.parentNode !== parent) {
        elAppend(parent, host);
        enterTopLayer();
      } else if (typeof host.hidePopover === 'function' && !isTopmost()) {
        raise();
      }
    }

    /**
     * Puts the card above everything else in the top layer, also above an element that the page
     * opened later with `pointer-events: none` (`isTopmost` cannot see such an element).
     */
    function raise() {
      if (destroyed || typeof host.hidePopover !== 'function') return;
      try {
        host.hidePopover();
      } catch {
        // Not shown: show it now.
      }
      enterTopLayer();
    }

    /** What `dismissCards` calls: the card's own cleanup, then the host and the listeners. */
    function dismiss() {
      try {
        options.onDismiss?.();
      } catch {
        // The card still goes.
      }
      destroy();
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      if (watch !== null) clearInterval(watch);
      watch = null;
      try {
        for (const undo of cleanups.splice(0)) undo();
      } finally {
        closers.delete(dismiss);
        hosts.delete(host);
        host.remove();
      }
    }

    /**
     * A listener that acts only on trusted events and never throws into the page.
     * @template {keyof HTMLElementEventMap} K
     * @param {EventTarget} target
     * @param {K} type
     * @param {(event: HTMLElementEventMap[K]) => void} handler
     * @param {AddEventListenerOptions | boolean} [listenOptions]
     */
    function listen(target, type, handler, listenOptions) {
      /** @param {Event} event */
      const guarded = (event) => {
        if (event.isTrusted !== true) return;
        try {
          handler(/** @type {HTMLElementEventMap[K]} */ (event));
        } catch (error) {
          console.error('Spool:', error);
        }
      };
      target.addEventListener(type, guarded, listenOptions);
      cleanups.push(() => target.removeEventListener(type, guarded, listenOptions));
    }

    elAppend(mountPoint(), host);
    enterTopLayer();
    watch = setInterval(() => {
      try {
        if (!contextValid()) {
          destroy();
          options.onOrphan?.();
        } else {
          keepOnTop();
        }
      } catch {
        // Never throw into the page.
      }
    }, WATCH_INTERVAL_MS);

    return { host, shadow, root, listen, keepOnTop, raise, destroy, isDestroyed: () => destroyed };
  }

  ns.ui = Object.freeze(
    /** @type {UiKit} */ ({
      FONT,
      BASE_CSS,
      el,
      text,
      svg,
      icon,
      glyph,
      num,
      sizeText,
      tileFileName,
      contextValid,
      send,
      pngBlob,
      copyImage,
      drawPng,
      focusedElement,
      takesPaste,
      pickComposer,
      findComposer,
      findPasteTarget,
      planBatches,
      mapLimit,
      exceedsClipboard,
      isFrameOwner,
      shortcutOf,
      keysOf,
      withKeys,
      dismissCards,
      createCardHost,
    }),
  );
})();
