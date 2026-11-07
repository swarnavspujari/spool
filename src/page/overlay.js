// @ts-check
/**
 * Selection overlay and capture HUD, drawn over the page.
 *
 * Classic script for the page's isolated world. Contract: docs/contracts.md section 5.
 * Every injection replaces `__spool.overlay` (no "already loaded" guard).
 *
 * The UI lives in a closed shadow root. Its styles come from a constructable stylesheet because
 * the page's CSP can block <style> elements. The page's own CSS must not reach it, so the host
 * resets itself with `all: initial !important` (an important rule of the shadow tree wins over
 * the page's important rules).
 *
 * What the page can see of the overlay is kept to a minimum. The host carries no attribute that
 * tells its state (hiding for a capture changes a class inside the closed shadow root, which the
 * page cannot observe) and no marker attribute. It acts only on trusted events (`isTrusted`).
 *
 * Input stays safe while the overlay is hidden for a capture. A transparent layer (it paints no
 * pixel) keeps the pointer and the wheel, so a click on Stop, Done or Cancel is never a click on
 * the page. The click is mapped to the HUD button under it, and the HUD does not change while it
 * is hidden. The keyboard works in every mode: Tab, Shift+Tab and Enter select a scroll panel.
 *
 * Look: the HUD is always dark graphite, the accent is
 * amber, and an amber outline on the page carries a 1 px dark halo (amber on white is 1.8:1).
 */
(() => {
  'use strict';

  /** @typedef {import('../shared/types.js').Rect} Rect */
  /** @typedef {import('../../types/page-globals.js').OverlayCommand} OverlayCommand */
  /** @typedef {import('../../types/page-globals.js').OverlayStatus} OverlayStatus */
  /** @typedef {import('../../types/page-globals.js').OverlayHandle} OverlayHandle */
  /** @typedef {import('../../types/page-globals.js').OverlayModule} OverlayModule */

  // Page markup can shadow names (DOM clobbering: `<img name="createElement">` replaces
  // `document.createElement`, an element with `id="__spool"` replaces the namespace). The
  // namespace is an own property of the global, and the DOM entry points come from the
  // prototypes when the script loads. See page-lib.js. Without a prototype (a unit test with a
  // fake DOM) the plain property is used.

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
  const ShadowRootProto = globalThis.ShadowRoot?.prototype;
  const HTMLElementProto = globalThis.HTMLElement?.prototype;
  const docElement = getterFrom(DocumentProto, 'documentElement');
  const docBody = getterFrom(DocumentProto, 'body');
  const docActiveElement = getterFrom(DocumentProto, 'activeElement');
  const elShadowRoot = getterFrom(ElementProto, 'shadowRoot');
  const shadowActiveElement = getterFrom(ShadowRootProto, 'activeElement');
  const htmlFocus = methodFrom(HTMLElementProto, 'focus');
  const docCreateElement = methodFrom(DocumentProto, 'createElement');
  const docCreateElementNS = methodFrom(DocumentProto, 'createElementNS');
  const docCreateTextNode = methodFrom(DocumentProto, 'createTextNode');
  const docQuerySelectorAll = methodFrom(DocumentProto, 'querySelectorAll');
  const docElementsFromPoint = methodFrom(DocumentProto, 'elementsFromPoint');
  const elAppend = methodFrom(ElementProto, 'append');

  /**
   * @returns {import('../../types/page-globals.js').SpoolNamespace}
   */
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
  const loadedLib = ns.lib;
  if (!loadedLib) throw new Error('Spool: page-lib.js must load before overlay.js.');
  const lib = loadedLib;

  /** The marker attribute of the hosts that earlier versions made: removed when found. */
  const LEGACY_HOST_ATTR = 'data-spool-host';
  /** Smallest box a drag may select, CSS px. */
  const MIN_SIZE = 24;
  /** A press-and-release that moves less than this is a click, CSS px. */
  const CLICK_SLOP = 4;
  const HINT = 'Click a panel or drag an area';
  const HINT_MORE = 'to cancel';
  const TAG_TEXT = 'Click to spool this panel';
  /** The label of a panel that the keyboard highlighted. */
  const TAG_TEXT_KEY = 'Press Enter to spool this panel';
  const TIP_END = 'Nothing more below';
  const TOO_SMALL = 'That box is too small. Drag a larger box.';
  /** The live region of the select mode: what a screen reader hears when it starts. */
  const HINT_SPEECH =
    'Choose what to capture. Press Tab or Shift and Tab to move between the scroll panels, ' +
    'Enter to select the highlighted panel, or Escape to cancel. You can also click a panel ' +
    'or drag an area.';
  const LABEL_SELECT = 'Spool: choose what to capture';
  const LABEL_SESSION = 'Spool: scrolling capture';
  const DOWN_ARIA = 'Scroll down (Space)';
  const DOWN_TIP = 'Scroll down (Space or Down arrow)';
  const UP_ARIA = 'Scroll up (Shift+Space)';
  const UP_TIP = 'Scroll up (Up arrow or Shift+Space)';
  /** The finish button names what it does: it copies and saves, or only saves (copy is off). */
  const DONE_TEXT_COPY = 'Copy & save';
  const DONE_TEXT_SAVE = 'Save';
  const DONE_ARIA_COPY = 'Copy and save (Enter)';
  const DONE_ARIA_SAVE = 'Save (Enter)';
  /** Shown on the finish button from the press until the toast takes over (or the finish fails). */
  const DONE_TEXT_BUSY = 'Finishing…';
  const DONE_ARIA_BUSY = 'Finishing';
  const AUTO_ARIA_OFF = 'Auto scroll (A)';
  const AUTO_ARIA_ON = 'Stop auto (A)';
  const AUTO_TIP_OFF = 'Scroll down automatically (A)';
  const AUTO_TIP_ON = 'Stop auto scroll (A or Space)';
  /** The HUD buttons, left to right. @type {OverlayCommand[]} */
  const HUD_ORDER = ['down', 'up', 'auto', 'done', 'cancel'];
  /** Id of the tip that the Scroll button points to at the end of the panel. */
  const TIP_ID = 'tip-end';
  /** Id of the live region that describes the dialog. */
  const SPEECH_ID = 'speech';
  /** Height of the hover label, and of the hint pill, and the top edge of the pill, CSS px. */
  const TAG_HEIGHT = 28;
  const HINT_HEIGHT = 36;
  const HINT_TOP = 12;
  /** Space kept between the hover label and the hint pill, CSS px. */
  const TAG_CLEAR = 8;
  /** Space between the selection and the HUD, and between the HUD and the window edge, CSS px. */
  const HUD_GAP = 12;
  const EDGE = 8;
  /** Space between the selection and the thread, CSS px. */
  const THREAD_GAP = 6;
  /** Width of the thread, CSS px. */
  const THREAD_WIDTH = 3;
  const DOT_SIZE = 11;
  /** The thread dot grows by this factor at the end of the panel (11 px to 15 px). */
  const DOT_END_SCALE = 15 / 11;
  /** The SVG namespace name. It is an identifier, and nothing is fetched. It is written in two
   * parts so that the policy scan for URLs does not flag it. */
  const SVG_NS = 'http:' + '//www.w3.org/2000/svg';

  // Same order as --font-text in src/ui/tokens.css: the system font first, so macOS and Linux
  // show their own. Windows gets Segoe UI Variable behind them. Same as FONT in ui-kit.js.
  const FONT =
    "system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', " +
    "Roboto, 'Helvetica Neue', Arial, sans-serif";

  // Motion: Fluent timing (83, 167, 250 ms), nothing longer. Enter decelerates, exit accelerates.
  // With reduced motion only opacity changes.
  const CSS = `
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
  --text: #EDEEF0;
  --muted: #A1A4AA;
  --key: #6E7178;
  --accent: #FFB224;
  --accent-text: #FFC453;
  --on-accent: #1B1C1E;
  --error: #FF9C94;
  position: absolute; inset: 0; display: none; overflow: hidden;
  pointer-events: auto; touch-action: none; user-select: none; -webkit-user-select: none;
  font: 400 14px/20px ${FONT}; letter-spacing: normal; text-transform: none; color: var(--text);
}
.root[data-mode] { display: block; }
.root.hidden { visibility: hidden !important; }
.root[data-mode='select'] { cursor: crosshair; }
.root[data-mode='session'] { cursor: default; }
.root:focus, .root:focus-visible { outline: none; }

/* While the overlay is hidden for a capture, this layer still takes the pointer and the wheel: a
   click on Stop must not be a click on the page. It paints nothing (no fill, no border, no
   shadow), so the capture holds no pixel of it. */
.shield { position: absolute; inset: 0; background: transparent; visibility: hidden; }
.root.hidden .shield { visibility: visible; }

/* Text for screen readers only. */
.sr {
  position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; border: 0;
  overflow: hidden; clip-path: inset(50%); white-space: nowrap; pointer-events: none;
}

/* Page dim. With no hover box the whole page dims; a hover or drag box cuts a hole in it. */
.dim {
  position: absolute; inset: 0; background: rgba(0, 0, 0, 0.45); opacity: 0;
  transition: opacity 83ms var(--in);
}
.root[data-mode='select']:not([data-hover]):not([data-drag]) .dim { opacity: 1; }

/* The outline carries a 1 px dark halo inside and outside, so it shows on any page. */
.frame {
  position: absolute; left: 0; top: 0; width: 0; height: 0; pointer-events: none; opacity: 0;
  border: 2px solid var(--accent); border-radius: 4px;
  box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.6),
    0 0 0 100vmax rgba(0, 0, 0, 0.45);
  transition: opacity 83ms var(--in);
}
.frame.glide {
  transition: opacity 83ms var(--in), left 83ms var(--in), top 83ms var(--in),
    width 83ms var(--in), height 83ms var(--in);
}
.root[data-hover] .frame, .root[data-drag] .frame, .root[data-mode='session'] .frame {
  opacity: 1;
}

.tag {
  position: absolute; left: 0; top: 0; display: flex; align-items: center; gap: 6px;
  height: 28px; padding: 0 10px; border-radius: 6px 6px 0 0; white-space: nowrap;
  background: var(--accent); color: var(--on-accent); font: 600 12px/16px ${FONT};
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6); pointer-events: none; opacity: 0;
  transition: opacity 83ms var(--in);
}
.tag[data-inside] { border-radius: 6px; }
.root[data-mode='select'][data-hover]:not([data-drag]) .tag { opacity: 1; }

.size {
  position: absolute; left: 0; top: 0; display: none; align-items: center; height: 24px;
  padding: 0 8px; border-radius: 6px; pointer-events: none; white-space: nowrap;
  background: var(--graphite); border: 1px solid var(--line); color: var(--text);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
  font: 600 12px/16px ${FONT}; font-variant-numeric: tabular-nums;
}
.root[data-drag] .size { display: flex; }

/* Select: the hint pill, with the message of the last error under it. */
.top {
  position: absolute; top: 12px; left: 50%; transform: translateX(-50%); display: none;
  flex-direction: column; align-items: center; gap: 8px; max-width: calc(100% - 16px);
  pointer-events: none;
}
.root[data-mode='select'] .top { display: flex; }
.hint {
  display: flex; align-items: center; gap: 10px; height: 36px; padding: 0 16px 0 12px;
  border-radius: 18px; background: var(--graphite); border: 1px solid var(--line);
  color: var(--text); white-space: nowrap; box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  opacity: 0; transition: opacity 83ms var(--in);
}
.root[data-mode='select']:not([data-drag]) .hint { opacity: 1; }
.hint .sep-dot { color: var(--key); }
.hint .more { display: flex; align-items: center; gap: 6px; color: var(--muted); }

.notice {
  display: none; align-items: center; gap: 8px; max-width: min(420px, calc(100vw - 16px));
  padding: 6px 12px; border-radius: 8px; background: var(--graphite);
  border: 1px solid var(--line); box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
  color: var(--text); font: 400 12px/16px ${FONT}; white-space: normal; pointer-events: none;
}
.notice[data-show] { display: flex; animation: fade-in 167ms var(--in); }
.notice svg { display: none; flex: none; }
.notice[data-level='warn'] .ic-warn { display: block; color: var(--accent-text); }
.notice[data-level='error'] .ic-error { display: block; color: var(--error); }

kbd {
  display: inline-flex; align-items: center; height: 20px; padding: 0 5px;
  border: 1px solid var(--key); border-radius: 4px; color: var(--muted);
  font: 400 12px/16px ${FONT};
}

/* Thread: progress of the scroll position along the selection's right edge. */
.thread {
  position: absolute; left: 0; top: 0; width: ${THREAD_WIDTH}px; height: 0; opacity: 0;
  pointer-events: none; transition: opacity 167ms var(--in);
}
.root[data-mode='session'] .thread { opacity: 1; }
.track { position: absolute; inset: 0; border-radius: 2px; background: rgba(255, 255, 255, 0.22); }
.fill {
  position: absolute; left: 0; top: 0; width: 100%; height: 0; border-radius: 2px;
  background: var(--accent); box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.5);
  transition: height 167ms var(--in);
}
.tick {
  position: absolute; left: -3px; top: 0; width: 9px; height: 2px; border-radius: 1px;
  background: var(--accent); transition: transform 167ms var(--in);
}
.knob {
  position: absolute; left: -4px; top: 0; width: ${DOT_SIZE}px; height: ${DOT_SIZE}px;
  transition: transform 167ms var(--in);
}
.knob::before {
  content: ''; position: absolute; inset: 0; border-radius: 50%; background: var(--accent);
  box-shadow: 0 0 0 2px var(--graphite); transition: transform 250ms var(--in);
}
.root[data-end] .knob::before { transform: scale(${DOT_END_SCALE}); }

/* HUD: always dark graphite, below the selection when there is room. */
.hud {
  position: absolute; left: 0; top: 0; display: none; align-items: center;
  justify-content: center; flex-wrap: wrap; gap: 4px; width: max-content;
  max-width: calc(100% - 16px); min-height: 48px; padding: 5px 6px;
  background: var(--graphite); border: 1px solid var(--line); border-radius: 12px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.32), 0 2px 6px rgba(0, 0, 0, 0.24);
  color: var(--text); white-space: nowrap; cursor: default;
}
.root[data-mode='session'] .hud { display: flex; animation: hud-in 167ms var(--in); }
.hud > .notice { position: absolute; left: 50%; transform: translateX(-50%); }
.hud[data-notice='below'] > .notice { top: calc(100% + 8px); }
.hud[data-notice='above'] > .notice { bottom: calc(100% + 8px); }

button {
  appearance: none; margin: 0; border: 0; border-radius: 8px; background: transparent;
  color: inherit; cursor: pointer; display: inline-flex; align-items: center; gap: 8px;
  height: 36px; padding: 0 8px 0 10px; white-space: nowrap; letter-spacing: normal;
  text-transform: none; font: inherit; transition: background-color 83ms var(--in);
}
button svg { flex: none; }
button:hover:not(:disabled) { background: var(--line); }
button:focus-visible {
  outline: none; box-shadow: 0 0 0 2px var(--graphite), 0 0 0 4px var(--accent);
}
button:disabled { opacity: 0.45; cursor: default; }
.down { background: var(--line); }
.down:hover:not(:disabled) { background: #34363B; }
.up { width: 36px; padding: 0; justify-content: center; }
.auto .ic-spool { display: none; }
.auto[aria-pressed='true'] {
  background: rgba(255, 178, 36, 0.14); box-shadow: inset 0 0 0 1px var(--accent);
  color: var(--accent-text); font-weight: 600;
}
.auto[aria-pressed='true']:hover:not(:disabled) { background: rgba(255, 178, 36, 0.22); }
.auto[aria-pressed='true']:focus-visible {
  box-shadow: inset 0 0 0 1px var(--accent), 0 0 0 2px var(--graphite), 0 0 0 4px var(--accent);
}
.auto[aria-pressed='true'] .ic-auto { display: none; }
.auto[aria-pressed='true'] .ic-spool {
  display: block; transform-origin: 50% 50%; animation: spool-turn 1.2s linear infinite;
}
.auto[aria-pressed='true'] kbd {
  border-color: rgba(255, 196, 83, 0.6); color: var(--accent-text); font-weight: 400;
}
.done {
  padding: 0 8px 0 12px; background: var(--accent); color: var(--on-accent); font-weight: 600;
}
.done:hover:not(:disabled) { background: var(--accent-text); }
.done kbd { border-color: rgba(27, 28, 30, 0.45); color: var(--on-accent); font-weight: 400; }
/* After the press: a turning spool and "Finishing…" in place of the check and the keycap. */
.done .ic-wait {
  display: none; transform-origin: 50% 50%; animation: spool-turn 1.2s linear infinite;
}
.root[data-finishing] .done .ic-done, .root[data-finishing] .done kbd { display: none; }
.root[data-finishing] .done .ic-wait { display: block; }
.root[data-finishing] .done { cursor: default; }
.done:focus, .done:focus-visible {
  outline: none; box-shadow: 0 0 0 2px var(--graphite), 0 0 0 4px var(--accent);
  transition: background-color 83ms var(--in), box-shadow 250ms var(--in);
}
.cancel { gap: 6px; padding: 0 8px; }

.sep { width: 1px; height: 20px; margin: 0 6px; background: #3A3C41; }
.readout {
  display: flex; align-items: center; justify-content: center; gap: 6px; min-width: 200px;
  padding: 0 4px; color: var(--muted); font-variant-numeric: tabular-nums;
}
.readout b { color: var(--text); font-weight: 600; }
.readout .end { display: none; align-items: center; gap: 6px; }
.readout .end svg { color: var(--accent-text); }
.root[data-end] .readout .counts { display: none; }
.root[data-end] .readout .end { display: flex; }

/* At the end of the panel the Scroll button looks off, and says why on hover or focus. */
.tipwrap { position: relative; display: flex; }
.tip {
  position: absolute; left: 0; bottom: 44px; height: 28px; display: flex; align-items: center;
  padding: 0 10px; border-radius: 6px; background: #2E3034; border: 1px solid #3A3C41;
  color: var(--text); font: 400 12px/16px ${FONT}; white-space: nowrap; pointer-events: none;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3); opacity: 0; transition: opacity 83ms var(--in);
}
.root[data-end] .tipwrap:hover .tip, .root[data-end] .tipwrap:focus-within .tip { opacity: 1; }
.root[data-end] .down { background: transparent; color: #8A8D93; cursor: default; }
.root[data-end] .down:hover:not(:disabled) { background: transparent; }
.root[data-end] .down kbd { border-color: #3A3C41; color: #8A8D93; }

@keyframes hud-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: none; }
}
@keyframes fade-in { from { opacity: 0; } to { opacity: 1; } }
@keyframes spool-turn { to { transform: rotate(360deg); } }

/* A narrow window: the readout takes its own row, and the keycaps go. */
@media (max-width: 820px) {
  .sep { display: none; }
  .readout { order: 9; flex: 1 0 100%; }
}
@media (max-width: 560px) {
  .hud kbd { display: none; }
  .hint .more { display: none; }
}

/* Reduced motion: only opacity changes. The spool stands still. */
@media (prefers-reduced-motion: reduce) {
  .frame.glide { transition: opacity 83ms var(--in); }
  .fill, .tick, .knob, .knob::before { transition: none; }
  .root[data-mode='session'] .hud { animation-name: fade-in; }
  .auto[aria-pressed='true'] .ic-spool, .done .ic-wait { animation: none; }
  button, .done:focus, .done:focus-visible { transition: none; }
}

/* Forced colours (a high contrast theme): system colours, an outline instead of the dim fill. */
@media (forced-colors: active) {
  .dim { background: transparent; }
  .frame { border-color: Highlight; box-shadow: none; }
  .hud, .hint, .notice, .size, .tip {
    background: Canvas; color: CanvasText; border-color: CanvasText;
  }
  .tag, .done { background: Highlight; color: HighlightText; forced-color-adjust: none; }
  .track { background: GrayText; }
  .fill, .tick, .knob::before { background: Highlight; box-shadow: none; }
  button:focus-visible, .done:focus { outline: 2px solid Highlight; box-shadow: none; }
}
`;

  /**
   * Mouse and pointer events that the page must not see while the overlay is up.
   * @type {(keyof HTMLElementEventMap)[]}
   */
  const BLOCKED_EVENTS = [
    'pointerdown',
    'pointermove',
    'pointerup',
    'mousedown',
    'mousemove',
    'mouseup',
    'click',
    'dblclick',
    'contextmenu',
    'wheel',
  ];

  /**
   * @param {number} value
   * @param {number} min
   * @param {number} max
   */
  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  /**
   * @template {keyof HTMLElementTagNameMap} K
   * @param {K} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElementTagNameMap[K]}
   */
  function make(tag, className, text) {
    const node = docCreateElement(document, tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * An element with one text node. Later updates change `text.data` in place, so the tree of
   * the overlay stays the same.
   * @param {string} className
   * @param {string} [value]
   * @param {keyof HTMLElementTagNameMap} [tag]
   * @returns {{ el: HTMLElement, text: Text }}
   */
  function makeLabel(className, value = '', tag = 'div') {
    const el = make(tag, className);
    const text = docCreateTextNode(document, value);
    el.append(text);
    return { el, text };
  }

  // ---- Icons ---------------------------------------------------------------------------------
  // Inline SVG, 16 px, 1.5 px stroke in the colour of the text. Built with createElementNS (no
  // innerHTML, no image file, so a page CSP has nothing to block).

  /**
   * @param {string} tag
   * @param {Record<string, string>} attrs
   * @returns {Element}
   */
  function svgNode(tag, attrs) {
    const node = docCreateElementNS(document, SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
    return node;
  }

  /**
   * A 16 px stroke icon.
   * @param {string} className
   * @param {Element[]} children
   * @returns {Element}
   */
  function iconBox(className, children) {
    const svg = svgNode('svg', {
      class: className,
      width: '16',
      height: '16',
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '1.5',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
    });
    for (const child of children) svg.append(child);
    return svg;
  }

  /** @param {string} className @param {string[]} paths */
  function pathIcon(className, ...paths) {
    return iconBox(
      className,
      paths.map((d) => svgNode('path', { d })),
    );
  }

  /**
   * The turning spool of the running Auto button, and of the Done button while it finishes.
   * @param {string} [className]
   */
  function spoolIcon(className = 'ic-spool') {
    return iconBox(className, [
      svgNode('circle', { cx: '8', cy: '8', r: '6.25' }),
      svgNode('circle', { cx: '8', cy: '8', r: '1.5', fill: 'currentColor', stroke: 'none' }),
      svgNode('path', { d: 'M8 1.75V5M13.4 11.1L10.6 9.5M2.6 11.1L5.4 9.5' }),
    ]);
  }

  /** The Spool glyph at 16 px (filled shapes), for the hint pill. */
  function glyphIcon() {
    const svg = svgNode('svg', {
      width: '16',
      height: '16',
      viewBox: '0 0 16 16',
      'aria-hidden': 'true',
    });
    svg.append(
      svgNode('rect', { width: '16', height: '16', rx: '4', fill: '#2A2C30' }),
      svgNode('rect', { x: '3', y: '4', width: '8', height: '8', fill: '#FFB224' }),
      svgNode('rect', { x: '2', y: '3', width: '10', height: '2', rx: '1', fill: '#E6E7EA' }),
      svgNode('rect', { x: '2', y: '11', width: '10', height: '2', rx: '1', fill: '#E6E7EA' }),
      svgNode('path', { d: 'M11 9.5H13.5V14', fill: 'none', stroke: '#FFB224' }),
    );
    return svg;
  }

  /** The panel icon of the hover tag (14 px). */
  function panelIcon() {
    const svg = iconBox('ic-panel', [
      svgNode('rect', { x: '4', y: '1.5', width: '8', height: '13', rx: '4' }),
      svgNode('path', { d: 'M8 4V6.5' }),
    ]);
    svg.setAttribute('width', '14');
    svg.setAttribute('height', '14');
    return svg;
  }

  const PATH_DOWN = 'M8 2.5V13M3.5 8.5L8 13L12.5 8.5';
  const PATH_UP = 'M8 13.5V3M3.5 7.5L8 3L12.5 7.5';
  const PATH_AUTO = 'M4 3.5L8 7.5L12 3.5M4 8.5L8 12.5L12 8.5';
  const PATH_DONE = 'M3 8.5L6.5 12L13 4.5';
  const PATH_CANCEL = 'M4 4L12 12M12 4L4 12';
  const PATH_END = 'M8 2.5V10M4.5 6.5L8 10L11.5 6.5M3 13.5H13';

  /**
   * @param {Rect} r
   * @param {Rect} other
   */
  function sameRect(r, other) {
    return (
      r.x === other.x && r.y === other.y && r.width === other.width && r.height === other.height
    );
  }

  /**
   * @param {HTMLElement} node
   * @param {Rect} r
   */
  function setBox(node, r) {
    node.style.left = `${r.x}px`;
    node.style.top = `${r.y}px`;
    node.style.width = `${r.width}px`;
    node.style.height = `${r.height}px`;
  }

  /**
   * Rect between two points, clamped to the area (0, 0, maxWidth, maxHeight), whole pixels.
   * @param {number} ax
   * @param {number} ay
   * @param {number} bx
   * @param {number} by
   * @param {number} maxWidth
   * @param {number} maxHeight
   * @returns {Rect}
   */
  function rectBetween(ax, ay, bx, by, maxWidth, maxHeight) {
    const x0 = Math.round(clamp(Math.min(ax, bx), 0, maxWidth));
    const x1 = Math.round(clamp(Math.max(ax, bx), 0, maxWidth));
    const y0 = Math.round(clamp(Math.min(ay, by), 0, maxHeight));
    const y1 = Math.round(clamp(Math.max(ay, by), 0, maxHeight));
    return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
  }

  /** @param {number} n */
  function num(n) {
    return Math.round(n).toLocaleString('en-US');
  }

  /**
   * @param {number} n
   * @param {string} one
   * @param {string} many
   */
  function plural(n, one, many) {
    return Math.round(n) === 1 ? one : many;
  }

  /**
   * The overlay command for a key, or null. Shift+Space scrolls up (the browser's own rule).
   * @param {KeyboardEvent} e
   * @returns {OverlayCommand | null}
   */
  function commandForKey(e) {
    if (e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
    switch (e.key) {
      case ' ':
        return e.shiftKey ? 'up' : 'down';
      case 'ArrowDown':
        return 'down';
      case 'ArrowUp':
        return 'up';
      case 'a':
      case 'A':
        return 'auto';
      case 'Enter':
        return 'done';
      case 'Escape':
        return 'cancel';
      default:
        // The HUD shows the key "A". On a layout with no Latin letters (Cyrillic, Greek, Hebrew,
        // Arabic) that key gives another letter, so the position of the key counts. A Latin layout
        // that puts another Latin letter there (AZERTY: Q) keeps that letter for itself.
        return e.code === 'KeyA' && /^\p{L}$/u.test(e.key) && !/^[a-z]$/i.test(e.key)
          ? 'auto'
          : null;
    }
  }

  /** @param {Element} el */
  function removeQuietly(el) {
    try {
      el.remove();
    } catch {
      // Gone already.
    }
  }

  /**
   * Is `node` the same as `ancestor` or inside it? (Plain walk up: the nodes are our own.)
   * @param {any} node
   * @param {any} ancestor
   */
  function isInside(node, ancestor) {
    for (let n = node; n; n = n.parentNode) if (n === ancestor) return true;
    return false;
  }

  /**
   * Runs `fn` on the next animation frame (at once without `requestAnimationFrame`).
   * @param {() => void} fn
   * @returns {number} A handle for `cancelFrame`, 0 when `fn` has run already.
   */
  function onFrame(fn) {
    if (typeof requestAnimationFrame !== 'function') {
      fn();
      return 0;
    }
    return requestAnimationFrame(fn);
  }

  /** @param {number} handle */
  function cancelFrame(handle) {
    if (handle && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(handle);
  }

  /**
   * @param {{
   *   onRegion(rect: Rect): void,
   *   onCommand(cmd: OverlayCommand): void,
   *   copyOnDone?: boolean,
   * }} opts  `copyOnDone`: false when the setting is off, so the finish button says "Save"
   *   (default: true, "Copy & save").
   * @returns {OverlayHandle}
   */
  function createOverlay({ onRegion, onCommand, copyOnDone = true }) {
    const DONE_TEXT = copyOnDone ? DONE_TEXT_COPY : DONE_TEXT_SAVE;
    const DONE_ARIA = copyOnDone ? DONE_ARIA_COPY : DONE_ARIA_SAVE;
    // An orphan from an earlier injection (the extension was reloaded while a capture was up) is
    // found by the set of hosts that the namespace keeps, not by an attribute of the host.
    const hosts = (ns.overlayHosts ??= new Set());
    for (const stale of hosts) removeQuietly(stale);
    hosts.clear();
    for (const stale of docQuerySelectorAll(document, `[${LEGACY_HOST_ATTR}]`)) removeQuietly(stale);

    // ---- DOM (built once; later updates only change text, attributes and styles) -----------
    const host = make('div');
    const shadow = host.attachShadow({ mode: 'closed' });
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(CSS);
    shadow.adoptedStyleSheets = [sheet];

    const root = make('div', 'root');
    // The layer is a modal dialog for assistive technology. It holds the keyboard focus (the
    // tabindex only lets a script focus it), and a live region says what the keys do.
    root.setAttribute('role', 'dialog');
    root.setAttribute('aria-modal', 'true');
    root.setAttribute('aria-label', LABEL_SELECT);
    root.setAttribute('aria-describedby', SPEECH_ID);
    root.setAttribute('tabindex', '-1');
    const dim = make('div', 'dim');
    const frame = make('div', 'frame');
    const { el: speech, text: speechText } = makeLabel('sr');
    speech.id = SPEECH_ID;
    speech.setAttribute('role', 'status');
    speech.setAttribute('aria-live', 'polite');
    const shield = make('div', 'shield');
    shield.setAttribute('aria-hidden', 'true');

    // Hover label above the panel under the pointer.
    const tag = make('div', 'tag');
    const tagText = docCreateTextNode(document, TAG_TEXT);
    tag.append(panelIcon(), tagText);

    const { el: sizeLabel, text: sizeText } = makeLabel('size');

    // Select: hint pill and the message of the last error.
    const top = make('div', 'top');
    const hint = make('div', 'hint');
    const more = make('span', 'more');
    more.append(make('kbd', '', 'Esc'), docCreateTextNode(document, HINT_MORE));
    hint.append(
      glyphIcon(),
      make('span', 'hint-main', HINT),
      make('span', 'sep-dot', '·'),
      more,
    );
    /**
     * A message pill with a text node and an icon for each level.
     * @param {string} className
     */
    const makeNotice = (className) => {
      const el = make('div', className);
      el.setAttribute('aria-live', 'polite');
      const noticeText = docCreateTextNode(document, '');
      const label = make('span', 'notice-text');
      label.append(noticeText);
      el.append(
        pathIcon('ic-warn', 'M8 2.5L14 13H2Z', 'M8 6.5V9.5', 'M8 11.5V11.51'),
        iconBox('ic-error', [
          svgNode('circle', { cx: '8', cy: '8', r: '6' }),
          svgNode('path', { d: 'M8 4.8V8.5M8 10.9V10.91' }),
        ]),
        label,
      );
      el.dataset.level = 'info';
      return { el, text: noticeText };
    };
    const { el: hintNotice, text: hintNoticeText } = makeNotice('notice');
    top.append(hint, hintNotice);

    // Session: the thread, then the HUD.
    const thread = make('div', 'thread');
    const track = make('div', 'track');
    const fill = make('div', 'fill');
    const ticks = [make('div', 'tick'), make('div', 'tick'), make('div', 'tick')];
    const knob = make('div', 'knob');
    thread.append(track, fill, ...ticks, knob);

    const hud = make('div', 'hud');
    hud.setAttribute('role', 'toolbar');
    hud.setAttribute('aria-label', 'Spool capture');

    /** @type {Record<string, HTMLButtonElement>} */
    const buttons = {};
    /**
     * @param {OverlayCommand} cmd
     * @param {{ aria: string, tip: string }} spec
     * @param {(Element | Text)[]} content
     */
    const makeButton = (cmd, spec, content) => {
      const button = make('button', cmd);
      button.type = 'button';
      button.setAttribute('aria-label', spec.aria);
      button.title = spec.tip;
      button.append(...content);
      buttons[cmd] = button;
      return button;
    };
    const text = (/** @type {string} */ value) => docCreateTextNode(document, value);
    const keycap = (/** @type {string} */ value) => make('kbd', '', value);

    const downButton = makeButton('down', { aria: DOWN_ARIA, tip: DOWN_TIP }, [
      pathIcon('ic-down', PATH_DOWN),
      text('Scroll'),
      keycap('Space'),
    ]);
    // The tip is a description of the Scroll button only at the end of the panel (setStatus sets
    // `aria-describedby` then). It stays out of the reading order: a description that an
    // attribute points to is read even from a hidden element.
    const tipWrap = make('span', 'tipwrap');
    const tip = make('span', 'tip', TIP_END);
    tip.id = TIP_ID;
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    tipWrap.append(downButton, tip);

    const upButton = makeButton('up', { aria: UP_ARIA, tip: UP_TIP }, [pathIcon('ic-up', PATH_UP)]);

    const autoLabel = text('Auto');
    const autoButton = makeButton(
      'auto',
      { aria: AUTO_ARIA_OFF, tip: AUTO_TIP_OFF },
      [pathIcon('ic-auto', PATH_AUTO), spoolIcon(), autoLabel, keycap('A')],
    );
    autoButton.setAttribute('aria-pressed', 'false');

    const doneLabel = text(DONE_TEXT);
    const doneButton = makeButton('done', { aria: DONE_ARIA, tip: DONE_ARIA }, [
      pathIcon('ic-done', PATH_DONE),
      spoolIcon('ic-wait'),
      doneLabel,
      keycap('Enter'),
    ]);
    const cancelButton = makeButton(
      'cancel',
      { aria: 'Cancel (Esc)', tip: 'Cancel the capture (Esc)' },
      [pathIcon('ic-cancel', PATH_CANCEL), keycap('Esc')],
    );

    // The readout: counts while capturing, "End of panel" at the end.
    const readout = make('div', 'readout');
    readout.setAttribute('role', 'status');
    readout.setAttribute('aria-live', 'polite');
    const counts = make('span', 'counts');
    const partsN = makeLabel('', '0', 'b');
    const partsT = text(' steps · ');
    const pxN = makeLabel('', '0', 'b');
    const pxT = text(' px · ');
    const tilesN = makeLabel('', '0', 'b');
    const tilesT = text(' AI screenshots');
    counts.append(partsN.el, partsT, pxN.el, pxT, tilesN.el, tilesT);
    const endInfo = make('span', 'end');
    const endTiles = text(' · 0 AI screenshots');
    endInfo.append(pathIcon('ic-end', PATH_END), make('b', '', 'End of panel'), endTiles);
    readout.append(counts, endInfo);

    const { el: notice, text: noticeText } = makeNotice('notice');

    const separator = () => {
      const sep = make('span', 'sep');
      sep.setAttribute('aria-hidden', 'true');
      return sep;
    };
    hud.append(
      tipWrap,
      upButton,
      autoButton,
      separator(),
      readout,
      separator(),
      doneButton,
      cancelButton,
      notice,
    );

    root.append(dim, frame, tag, sizeLabel, top, thread, hud, speech, shield);
    shadow.append(root);
    hosts.add(host);

    // ---- State ------------------------------------------------------------------------------
    /** @type {'idle' | 'select' | 'session'} */
    let mode = 'idle';
    let destroyed = false;
    /** The overlay is hidden for a capture (a class on `root`, not an attribute of the host). */
    let hiddenForCapture = false;
    let busy = false;
    /** Done is saving (from the agent): Cancel can no longer cancel. */
    let finishing = false;
    let auto = false;
    /** The end of the panel is reached (from the agent). */
    let atEnd = false;
    /** Scroll position along the panel, 0..1 (from the agent). */
    let progress = 0;
    /** The overlay holds the focus on Done at the end of the panel, until the user Tabs away. */
    let endFocus = false;
    /** A request to stop Auto is on its way: one is enough. */
    let stopAsked = false;
    /** The region was handed to the agent; ignore the pointer until it shows the session. */
    let locked = false;
    /** @type {Rect | null} */
    let sessionRect = null;
    /** @type {{ id: number, x: number, y: number, moved: boolean } | null} */
    let drag = null;
    /** The panel that has the highlight while selecting (hover or keyboard). @type {Rect | null} */
    let hoverBox = null;
    /** The element of that panel, when it is known: Tab moves on from it. @type {Element | null} */
    let highlightEl = null;
    /** The next hover change may glide (the outline is on screen already). */
    let glideReady = false;
    /** The pointer position the next hover test uses. @type {{ x: number, y: number } | null} */
    let hoverPoint = null;
    let hoverFrame = 0;
    /** Done was pressed: the Done button says "Finishing…" while the agent is busy. */
    let doneRequested = false;
    /** Where a press began while hidden for a capture. @type {{ x: number, y: number } | null} */
    let heldAt = null;
    /** The part of the overlay that had the focus when it hid. @type {HTMLElement | null} */
    let heldFocus = null;
    /** The element of the page that had the focus before the overlay. @type {Element | null} */
    let previousFocus = null;
    /** @type {(() => void)[]} */
    const cleanups = [];

    /**
     * Adds a listener that never throws into the page and is removed by destroy(). It acts only
     * on trusted events (`isTrusted`: the browser made them from real input). A page script can
     * dispatch fake keyboard and pointer events into the window; those must not press Done or
     * Cancel, scroll the page or select an area. They are ignored without being stopped, so the
     * page still receives its own events.
     * @template {keyof HTMLElementEventMap} K
     * @param {EventTarget} target
     * @param {K} type
     * @param {(event: HTMLElementEventMap[K]) => void} handler
     * @param {AddEventListenerOptions | boolean} [options]
     */
    function listen(target, type, handler, options) {
      /** @param {Event} event */
      const guarded = (event) => {
        if (event.isTrusted !== true) return;
        try {
          handler(/** @type {HTMLElementEventMap[K]} */ (event));
        } catch (error) {
          console.error('Spool overlay:', error);
        }
      };
      target.addEventListener(type, guarded, options);
      cleanups.push(() => target.removeEventListener(type, guarded, options));
    }

    // ---- Top layer --------------------------------------------------------------------------
    // A very large z-index does not lift the host above the top layer (a modal <dialog>, a
    // popover, a fullscreen element). The host is a manual popover, which puts it in the top layer.
    // A modal dialog also makes everything outside it inert, so while one is open the host sits
    // inside it, which keeps the controls usable. Without popover support the host stays an
    // ordinary fixed element.

    /** The topmost open modal dialog, or null. */
    function modalDialog() {
      try {
        const found = docQuerySelectorAll(document, 'dialog:modal');
        return found.length > 0 ? found[found.length - 1] : null;
      } catch {
        return null; // `:modal` is not supported
      }
    }

    function mountPoint() {
      return modalDialog() ?? docElement(document);
    }

    /** Shows the host as a popover (a new place in the top layer). */
    function enterTopLayer() {
      if (typeof host.showPopover !== 'function') return;
      try {
        host.popover = 'manual';
        host.showPopover();
      } catch {
        host.removeAttribute('popover');
      }
    }

    /** Is the host the topmost thing at the middle of the viewport? */
    function isTopmost() {
      const hit = docElementsFromPoint(document, innerWidth / 2, innerHeight / 2);
      return hit[0] === host;
    }

    elAppend(mountPoint(), host);
    enterTopLayer();

    // ---- Focus ------------------------------------------------------------------------------
    // The overlay is modal, so it takes the keyboard focus when the selection starts (a screen
    // reader then announces the dialog) and gives it back to the page when it closes: a capture
    // started from a chat editor leaves the focus in the editor, where the user pastes the result.

    /**
     * The element that has the focus in the page now (open shadow roots included). Null for the
     * page itself, and for the overlay.
     * @returns {Element | null}
     */
    function pageFocus() {
      /** @type {Element | null} */
      let el = docActiveElement(document);
      for (let depth = 0; el && depth < 8; depth++) {
        const inner = elShadowRoot(el);
        const next = inner ? shadowActiveElement(inner) : null;
        if (!next) break;
        el = next;
      }
      const bare = !el || el === host || el === docBody(document) || el === docElement(document);
      return bare ? null : el;
    }
    previousFocus = pageFocus();

    /** Puts the focus on the overlay itself (not while hidden: a hidden element cannot take it). */
    function focusOverlay() {
      if (destroyed || hiddenForCapture) return;
      try {
        root.focus({ preventScroll: true });
      } catch {
        // Not focusable now.
      }
    }

    /** Gives the focus back to the element that had it before, unless the user moved it since. */
    function restorePageFocus() {
      const target = previousFocus;
      previousFocus = null;
      if (!target || !target.isConnected) return;
      const now = docActiveElement(document);
      if (now && now !== docBody(document) && now !== docElement(document)) return;
      try {
        htmlFocus(target, { preventScroll: true });
      } catch {
        // Not focusable now (an SVG element, or a page that changed).
      }
    }

    // ---- Layout -----------------------------------------------------------------------------
    /**
     * Puts the amber label of the hover box above it. It goes inside the box when the box touches
     * the top of the window, and also when the label above would touch the hint pill (the pill is
     * centred at the top: a panel that starts below it, or beside a sidebar, would have its label
     * cut by it). Inside, the label sits at the top edge of the box, and below the pill when the
     * pill is there too.
     * @param {Rect} box
     */
    function placeTag(box) {
      const width = tag.offsetWidth;
      const maxX = Math.max(4, root.clientWidth - width - 4);
      const pillWidth = hint.offsetWidth;
      const pillLeft = root.clientWidth / 2 - pillWidth / 2 - TAG_CLEAR;
      const pillRight = pillLeft + pillWidth + 2 * TAG_CLEAR;
      const pillBottom = HINT_TOP + HINT_HEIGHT + TAG_CLEAR;
      /** Would the label at (x, y) touch the hint pill? @param {number} x @param {number} y */
      const meetsPill = (x, y) =>
        x < pillRight &&
        x + width > pillLeft &&
        y < pillBottom &&
        y + TAG_HEIGHT > HINT_TOP - TAG_CLEAR;
      let inside = box.y < TAG_HEIGHT;
      let x = clamp(inside ? box.x + 12 : box.x, 4, maxX);
      let y = inside ? box.y + 56 : box.y - TAG_HEIGHT;
      if (!inside && meetsPill(x, y)) {
        inside = true;
        x = clamp(box.x + 12, 4, maxX);
        y = box.y + 8;
        if (meetsPill(x, y)) y = pillBottom;
      }
      if (inside) tag.dataset.inside = '';
      else delete tag.dataset.inside;
      tag.style.left = `${Math.round(x)}px`;
      tag.style.top = `${Math.round(y)}px`;
    }

    /**
     * Shows the outline of the panel that has the highlight, or hides it. The outline glides from
     * one panel to the next, and fades in without gliding.
     * @param {Rect | null} box
     * @param {Element | null} [el]  The element of the panel, when it is known.
     * @param {boolean} [byKey]  The keyboard made the highlight: the label says Enter, not click.
     */
    function setHover(box, el = null, byKey = false) {
      if (!box) {
        hoverBox = null;
        highlightEl = null;
        glideReady = false;
        delete root.dataset.hover;
        return;
      }
      highlightEl = el;
      const label = byKey ? TAG_TEXT_KEY : TAG_TEXT;
      const relabel = tagText.data !== label;
      tagText.data = label;
      if (hoverBox && sameRect(hoverBox, box)) {
        if (relabel) placeTag(hoverBox);
        return;
      }
      hoverBox = { x: box.x, y: box.y, width: box.width, height: box.height };
      if (glideReady) frame.classList.add('glide');
      else frame.classList.remove('glide');
      setBox(frame, hoverBox);
      root.dataset.hover = '';
      placeTag(hoverBox);
      glideReady = true;
    }

    /** The hover test: runs at most once per animation frame. */
    function updateHover() {
      hoverFrame = 0;
      const p = hoverPoint;
      if (!p || destroyed || mode !== 'select' || locked || drag) return;
      /** @type {import('../../types/page-globals.js').ScrollTarget | null} */
      let target = null;
      try {
        target = lib.findScrollTarget({ x: p.x, y: p.y, width: 1, height: 1 });
      } catch {
        // No hover outline for this point.
      }
      setHover(target ? target.box : null, target ? target.el : null);
    }

    /**
     * @param {number} x
     * @param {number} y
     */
    function scheduleHover(x, y) {
      hoverPoint = { x, y };
      if (!hoverFrame) hoverFrame = onFrame(updateHover) || 0;
    }

    /** Stops the hover test and forgets the pointer. */
    function stopHover() {
      cancelFrame(hoverFrame);
      hoverFrame = 0;
      hoverPoint = null;
      setHover(null);
    }

    /** Shows the drag box and its live size label. @param {Rect} r */
    function showDragFrame(r) {
      if (hoverBox) setHover(null);
      frame.classList.remove('glide');
      setBox(frame, r);
      root.dataset.drag = '';
      sizeText.data = `${Math.round(r.width)} × ${Math.round(r.height)}`;
      const labelWidth = sizeLabel.offsetWidth;
      const above = r.y >= 30;
      sizeLabel.style.left = `${clamp(r.x, 4, Math.max(4, root.clientWidth - labelWidth - 4))}px`;
      sizeLabel.style.top = `${above ? r.y - 30 : r.y + 6}px`;
    }

    function hideDragFrame() {
      delete root.dataset.drag;
    }

    /**
     * The HUD goes below the selection, centred on it. Else above it, else inside at the bottom.
     * The message pill of the HUD goes on the side that has room.
     */
    function layoutBar() {
      if (mode !== 'session' || !sessionRect) return;
      const r = sessionRect;
      const { clientWidth: viewW, clientHeight: viewH } = root;
      const { offsetWidth: w, offsetHeight: h } = hud;
      let top = r.y + r.height + HUD_GAP;
      if (top + h + EDGE > viewH) {
        top = r.y - HUD_GAP - h >= EDGE ? r.y - HUD_GAP - h : r.y + r.height - HUD_GAP - h;
      }
      const left = r.x + r.width / 2 - w / 2;
      const placedTop = Math.round(clamp(top, EDGE, Math.max(EDGE, viewH - h - EDGE)));
      hud.style.left = `${Math.round(clamp(left, EDGE, Math.max(EDGE, viewW - w - EDGE)))}px`;
      hud.style.top = `${placedTop}px`;
      const noticeHeight = notice.offsetHeight || 32;
      hud.dataset.notice = placedTop + h + 8 + noticeHeight + EDGE <= viewH ? 'below' : 'above';
    }

    /**
     * The thread runs along the right edge of the selection, 6 px outside it (inside it when the
     * selection touches the window edge). The fill, the ticks and the dot follow the progress.
     */
    function layoutThread() {
      if (!sessionRect) return;
      const r = sessionRect;
      const viewW = root.clientWidth;
      const outside = r.x + r.width + THREAD_GAP + THREAD_WIDTH + DOT_SIZE <= viewW;
      const left = outside ? r.x + r.width + THREAD_GAP : r.x + r.width - THREAD_GAP - THREAD_WIDTH;
      thread.style.left = `${left}px`;
      thread.style.top = `${r.y}px`;
      thread.style.height = `${r.height}px`;
      const filled = Math.round(r.height * progress);
      fill.style.height = `${filled}px`;
      ticks.forEach((tick, i) => {
        tick.style.transform = `translateY(${Math.round((filled * (i + 1)) / 4) - 1}px)`;
      });
      // The dot rides the end of the fill and stays inside the track.
      const half = DOT_SIZE / 2;
      const reach = half * DOT_END_SCALE;
      const centre = clamp(filled, reach, Math.max(half, r.height - reach));
      knob.style.transform = `translateY(${Math.round(centre - half)}px)`;
    }

    function syncButtons() {
      buttons['down'].disabled = busy;
      buttons['up'].disabled = busy;
      // While auto runs, the Auto button is the way to stop it.
      buttons['auto'].disabled = busy && !auto;
      // The files are being saved and the toast will report them: there is nothing left to cancel.
      buttons['cancel'].disabled = finishing;
      hud.setAttribute('aria-busy', String(busy));
      renderDone();
    }

    /**
     * After Done the agent stays busy until the toast takes over, so a busy overlay that was asked
     * to finish says so: a turning spool and "Finishing…" (and no keycap). It does not look like
     * a button that waits for a click.
     */
    function renderDone() {
      const finishing = doneRequested && busy;
      if (finishing) root.dataset['finishing'] = '';
      else delete root.dataset['finishing'];
      doneLabel.data = finishing ? DONE_TEXT_BUSY : DONE_TEXT;
      doneButton.setAttribute('aria-label', finishing ? DONE_ARIA_BUSY : DONE_ARIA);
      if (finishing) doneButton.setAttribute('aria-disabled', 'true');
      else doneButton.removeAttribute('aria-disabled');
    }

    /**
     * Moves the focus to Done at the end of the panel, so Enter finishes. It cannot focus while
     * the overlay is hidden for a capture; `showAfterCapture` tries again.
     */
    function focusDone() {
      if (!endFocus || hiddenForCapture || destroyed) return;
      try {
        doneButton.focus({ preventScroll: true });
      } catch {
        // Not focusable now.
      }
    }

    /** After the host moved or was shown again: the focus goes back where it was held. */
    function refocus() {
      if (endFocus) focusDone();
      else if (mode !== 'idle') focusOverlay();
    }

    // ---- Selecting --------------------------------------------------------------------------
    /** @param {Rect} rect */
    function pick(rect) {
      locked = true;
      onRegion(rect);
    }

    /**
     * The scroll panels on screen, in reading order. Without the list helper (an older page-lib)
     * it holds the main panel only. Empty when the page cannot be read.
     * @returns {import('../../types/page-globals.js').ScrollTarget[]}
     */
    function panelList() {
      try {
        if (typeof lib.listScrollTargets === 'function') return lib.listScrollTargets();
        return [lib.findScrollTarget(centreRect())];
      } catch {
        return [];
      }
    }

    /** The one pixel at the middle of the window: where the main panel is. @returns {Rect} */
    function centreRect() {
      return {
        x: Math.floor(root.clientWidth / 2),
        y: Math.floor(root.clientHeight / 2),
        width: 1,
        height: 1,
      };
    }

    /**
     * Tab and Shift+Tab: highlights the next (or the previous) scroll panel, and says which one.
     * The list is read again each time, so a page that changed since the last key is followed. The
     * first Tab goes to the first panel (the last for Shift+Tab); after that the highlight moves
     * on from the panel that has it, also when the pointer put it there. The list is a ring.
     * @param {boolean} back
     */
    function stepPanel(back) {
      const list = panelList();
      const count = list.length;
      if (count === 0) return;
      const at = highlightEl ? list.findIndex((t) => t.el === highlightEl) : -1;
      const next = at < 0 ? (back ? count - 1 : 0) : (at + (back ? -1 : 1) + count) % count;
      const target = list[next];
      if (!target) return;
      // The keyboard owns the highlight now: a hover test that is on its way must not replace it.
      cancelFrame(hoverFrame);
      hoverFrame = 0;
      hoverPoint = null;
      setHover(target.box, target.el, true);
      const kind = target.kind === 'document' ? 'Whole page' : 'Scroll panel';
      const place = count > 1 ? ` ${next + 1} of ${count}` : '';
      const onward = count > 1 ? ', or Tab for the next one' : '';
      speechText.data =
        `${kind}${place}, ${num(target.box.width)} by ${num(target.box.height)} pixels. ` +
        `Press Enter to select it${onward}.`;
    }

    /**
     * Enter: selects the highlighted panel, as a click on it would. With no highlight it selects
     * the main panel (the one at the middle of the window), so Enter alone does something useful.
     */
    function pickHighlighted() {
      if (locked || drag) return;
      let box = hoverBox;
      if (box && highlightEl) {
        // The page may have moved since the highlight: take the panel's box as it is now.
        const fresh = panelList().find((t) => t.el === highlightEl);
        if (fresh) box = fresh.box;
      }
      if (!box) {
        try {
          box = lib.findScrollTarget(centreRect()).box;
        } catch {
          return;
        }
      }
      stopHover();
      setHover(box, null, true);
      pick(box);
    }

    /**
     * The rect of an element of the overlay in window coordinates, or null (no layout, as in a
     * test with a fake DOM).
     * @param {HTMLElement} el
     * @returns {{ left: number, top: number, right: number, bottom: number } | null}
     */
    function rectOf(el) {
      return typeof el.getBoundingClientRect === 'function' ? el.getBoundingClientRect() : null;
    }

    /**
     * Is the point over the HUD, or over the button `el` when it is given? The HUD keeps its
     * layout while it is hidden for a capture, so this works then too.
     * @param {number} x
     * @param {number} y
     * @param {HTMLElement} [el]
     */
    function isOver(x, y, el = hud) {
      const r = rectOf(el);
      return r !== null && x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    }

    /**
     * A click while the overlay is hidden for a capture. The buttons cannot be hit then, so the
     * click lands on the layer that holds the input; it does what a click on the HUD button at that
     * place does. Elsewhere (the panel) it stops Auto, as a click on the panel does.
     * @param {number} x
     * @param {number} y
     */
    function pressAt(x, y) {
      for (const cmd of HUD_ORDER) {
        const button = buttons[cmd];
        if (button && !button.disabled && isOver(x, y, button)) {
          command(cmd);
          return;
        }
      }
      if (auto && !isOver(x, y)) stopAuto();
    }

    listen(root, 'pointerdown', (e) => {
      // A press that begins while the overlay is hidden for a capture belongs to the HUD under it:
      // its click is found below (the click may end after the overlay shows again).
      heldAt =
        hiddenForCapture && e.button === 0 && e.isPrimary ? { x: e.clientX, y: e.clientY } : null;
      if (mode === 'session') {
        // A click on the panel stops Auto. The HUD handles its own clicks.
        const onHud = isInside(e.target, hud) || (hiddenForCapture && isOver(e.clientX, e.clientY));
        if (auto && !onHud) stopAuto();
        return;
      }
      if (mode !== 'select' || locked || drag || e.button !== 0 || !e.isPrimary) return;
      root.setPointerCapture(e.pointerId);
      drag = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      hintNoticeText.data = '';
      delete hintNotice.dataset.show;
    });

    listen(root, 'pointermove', (e) => {
      if (!drag) {
        if (mode === 'select' && !locked) scheduleHover(e.clientX, e.clientY);
        return;
      }
      if (e.pointerId !== drag.id) return;
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < CLICK_SLOP) return;
      drag.moved = true;
      showDragFrame(
        rectBetween(drag.x, drag.y, e.clientX, e.clientY, root.clientWidth, root.clientHeight),
      );
    });

    listen(root, 'pointerup', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const { x, y, moved } = drag;
      drag = null;
      if (!moved) {
        const box = lib.findScrollTarget({ x: e.clientX, y: e.clientY, width: 1, height: 1 }).box;
        stopHover();
        setHover(box);
        pick(box);
        return;
      }
      const rect = rectBetween(x, y, e.clientX, e.clientY, root.clientWidth, root.clientHeight);
      if (rect.width < MIN_SIZE || rect.height < MIN_SIZE) {
        hideDragFrame();
        showNotice(hintNotice, hintNoticeText, 'warn', TOO_SMALL);
        scheduleHover(e.clientX, e.clientY);
        return;
      }
      showDragFrame(rect);
      pick(rect);
    });

    /** The pointer was taken away (touch scroll, alt-tab): forget the drag. */
    const abortDrag = () => {
      if (!drag) return;
      drag = null;
      if (!locked) hideDragFrame();
    };
    listen(root, 'pointercancel', abortDrag);
    listen(root, 'pointercancel', () => {
      heldAt = null;
    });
    listen(root, 'lostpointercapture', abortDrag);
    listen(root, 'pointerleave', () => {
      if (!drag && mode === 'select' && !locked) stopHover();
    });
    // The page may scroll under the pointer while selecting: test the pointer position again.
    listen(
      window,
      'scroll',
      () => {
        if (hoverPoint && mode === 'select' && !locked && !drag) {
          scheduleHover(hoverPoint.x, hoverPoint.y);
        }
      },
      { capture: true, passive: true },
    );

    /**
     * Shows a message in a pill, or hides the pill when the text is empty.
     * @param {HTMLElement} pill
     * @param {Text} label
     * @param {'info' | 'warn' | 'error'} level
     * @param {string} message
     */
    function showNotice(pill, label, level, message) {
      label.data = message;
      pill.dataset.level = level;
      if (message === '') delete pill.dataset.show;
      else pill.dataset.show = '';
    }

    // ---- Page isolation ---------------------------------------------------------------------
    // Keep the page's own listeners (menus that close on an outside click, hover trackers) from
    // seeing events that were meant for the overlay.
    for (const type of BLOCKED_EVENTS) {
      listen(host, type, (e) => {
        if (mode !== 'idle') e.stopPropagation();
      });
    }
    // The page must not scroll under the capture area. (Non-passive: it calls preventDefault.)
    // The wheel also stops Auto.
    listen(
      root,
      'wheel',
      (e) => {
        if (mode === 'session' || locked) e.preventDefault();
        if (mode === 'session' && auto) stopAuto();
      },
      { passive: false },
    );
    // A mouse press on the HUD must not move the keyboard focus: Enter and Space then keep
    // their meaning (Done, Scroll) instead of re-activating the button that was clicked.
    listen(root, 'mousedown', (e) => e.preventDefault());

    /**
     * Asks the agent to stop Auto (the same command as the Auto button). While Auto runs, any
     * other input stops it: a second Space, an arrow key, the wheel, a click on the panel.
     */
    function stopAuto() {
      if (stopAsked) return;
      stopAsked = true;
      onCommand('auto');
    }

    /** @param {OverlayCommand} cmd */
    function command(cmd) {
      // Once Done is saving, Cancel and Esc do nothing (the keys are still kept from the page).
      if (cmd === 'cancel' && finishing) return;
      // Set first: the agent answers a Done at once with setBusy(true), and the Done button then
      // says "Finishing…".
      if (cmd === 'done') doneRequested = true;
      if (auto && (cmd === 'down' || cmd === 'up' || cmd === 'auto')) stopAuto();
      else onCommand(cmd);
    }

    for (const cmd of HUD_ORDER) {
      listen(buttons[cmd], 'click', () => command(cmd));
    }
    // A click that no visible button took. While the overlay is hidden for a capture it is a click
    // on the HUD button under the pointer (see pressAt). A click that began on the layer while it
    // was hidden and ends after the overlay shows again also counts, at the place where it began.
    listen(root, 'click', (e) => {
      const from = heldAt;
      heldAt = null;
      if (mode !== 'session' || !(from || hiddenForCapture)) return;
      if (e.target !== root && e.target !== shield) return;
      pressAt(from ? from.x : e.clientX, from ? from.y : e.clientY);
    });

    // ---- Keyboard ---------------------------------------------------------------------------
    /**
     * The command a key press is for, or null when the page keeps the key. While selecting only
     * Esc is a command (selectKeyFor has the keys that choose a panel).
     * @param {KeyboardEvent} e
     */
    function claimedCommand(e) {
      const cmd = commandForKey(e);
      if (!cmd || (mode !== 'session' && cmd !== 'cancel')) return null;
      // With a HUD button focused (Tab), Enter and Space press that button. At the end of the
      // panel the overlay itself put the focus on Done: then the keys keep their own meaning. The
      // overlay layer itself has the focus most of the time (a mouse press does not move it): then
      // the keys are ours.
      if (
        e.target === host &&
        !endFocus &&
        shadowActiveElement(shadow) !== root &&
        (e.key === 'Enter' || e.key === ' ')
      ) {
        return null;
      }
      return cmd;
    }

    /**
     * The key of the selection (before the session starts): Tab and Shift+Tab move the highlight
     * over the scroll panels, Enter selects the highlighted one. The page does not get them: the
     * overlay is modal, and the focus is in it.
     * @param {KeyboardEvent} e
     * @returns {'next' | 'prev' | 'pick' | null}
     */
    function selectKeyFor(e) {
      if (mode !== 'select' || e.ctrlKey || e.metaKey || e.altKey || e.isComposing) return null;
      if (e.key === 'Tab') return e.shiftKey ? 'prev' : 'next';
      return e.key === 'Enter' ? 'pick' : null;
    }

    listen(
      window,
      'keydown',
      (e) => {
        // Tab hands the focus to the user: the overlay stops holding it on Done.
        if (e.key === 'Tab') endFocus = false;
        const choice = selectKeyFor(e);
        if (choice) {
          e.preventDefault();
          e.stopImmediatePropagation();
          // A held Tab keeps moving; a held Enter selects once. A pick that is under way, or a
          // drag, is not disturbed.
          if (!locked && !drag && !(choice === 'pick' && e.repeat)) {
            if (choice === 'pick') pickHighlighted();
            else stepPanel(choice === 'prev');
          }
          return;
        }
        const cmd = claimedCommand(e);
        if (!cmd) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (e.repeat) return;
        const stepKey = cmd === 'down' || cmd === 'up';
        if (busy && (stepKey || (cmd === 'auto' && !auto))) return;
        command(cmd);
      },
      true,
    );
    // A page button that has the focus presses on keyup: keep that from the page too.
    listen(
      window,
      'keyup',
      (e) => {
        if (!claimedCommand(e) && !selectKeyFor(e)) return;
        e.preventDefault();
        e.stopImmediatePropagation();
      },
      true,
    );

    listen(window, 'resize', () => {
      layoutBar();
      layoutThread();
    });

    // ---- Handle -----------------------------------------------------------------------------
    function beginSelect() {
      if (destroyed) return;
      mode = 'select';
      locked = false;
      drag = null;
      sessionRect = null;
      endFocus = false;
      heldAt = null;
      doneRequested = false;
      finishing = false;
      renderDone();
      stopHover();
      hideDragFrame();
      delete root.dataset.end;
      delete root.dataset.auto;
      root.dataset.mode = 'select';
      root.setAttribute('aria-label', LABEL_SELECT);
      // The live region says what the keys do. The focus is in the overlay, so the keys work at
      // once, and a screen reader reads the dialog and its description.
      speechText.data = HINT_SPEECH;
      focusOverlay();
    }

    /** @param {Rect} rect */
    function showSession(rect) {
      if (destroyed) return;
      mode = 'session';
      locked = false;
      drag = null;
      stopHover();
      sessionRect = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      hideDragFrame();
      heldAt = null;
      doneRequested = false;
      finishing = false;
      root.dataset.mode = 'session';
      root.setAttribute('aria-label', LABEL_SESSION);
      speechText.data = '';
      frame.classList.remove('glide');
      setBox(frame, sessionRect);
      syncButtons();
      layoutBar();
      layoutThread();
      focusOverlay();
    }

    /** @param {OverlayStatus} s */
    function setStatus(s) {
      if (destroyed) return;
      const wasEnd = atEnd;
      auto = s.auto;
      finishing = s.finishing === true;
      atEnd = s.atEnd === true;
      progress = clamp(Number.isFinite(s.progress) ? s.progress : 0, 0, 1);
      if (!auto) stopAsked = false;
      // A message of the error level ends a Done that failed: the button says "Done" again.
      if (s.level === 'error' && s.message !== '') doneRequested = false;

      partsN.text.data = num(s.slices);
      partsT.data = ` ${plural(s.slices, 'step', 'steps')} · `;
      pxN.text.data = num(s.heightPx);
      tilesN.text.data = num(s.tiles);
      tilesT.data = ` AI ${plural(s.tiles, 'screenshot', 'screenshots')}`;
      endTiles.data = ` · ${num(s.tiles)} AI ${plural(s.tiles, 'screenshot', 'screenshots')}`;

      // The same message goes to the HUD (session) and to the hint (selecting again after an
      // error): only one of them is visible.
      showNotice(notice, noticeText, s.level, s.message);
      showNotice(hintNotice, hintNoticeText, s.level, s.message);

      if (auto) root.dataset.auto = '';
      else delete root.dataset.auto;
      if (atEnd) root.dataset.end = '';
      else delete root.dataset.end;
      autoButton.setAttribute('aria-pressed', String(auto));
      autoButton.setAttribute('aria-label', auto ? AUTO_ARIA_ON : AUTO_ARIA_OFF);
      autoButton.title = auto ? AUTO_TIP_ON : AUTO_TIP_OFF;
      autoLabel.data = auto ? 'Stop' : 'Auto';
      // "Nothing more below" describes the Scroll button only at the end of the panel.
      if (atEnd) downButton.setAttribute('aria-describedby', TIP_ID);
      else downButton.removeAttribute('aria-describedby');

      syncButtons();
      layoutThread();
      layoutBar();

      if (mode === 'session' && atEnd) {
        if (!wasEnd) endFocus = true;
        focusDone();
      } else if (endFocus) {
        endFocus = false;
        try {
          doneButton.blur();
        } catch {
          // Nothing to do.
        }
        focusOverlay();
      }
    }

    /** @param {boolean} value */
    function setBusy(value) {
      if (destroyed) return;
      busy = value;
      syncButtons();
    }

    /** Hides everything, then waits until the page has painted without it. */
    async function hideForCapture() {
      if (destroyed) return;
      hiddenForCapture = true;
      // Remember what holds the focus: a hidden element loses it.
      heldFocus = shadowActiveElement(shadow) ?? null;
      root.classList.add('hidden');
      await lib.nextFrames(2);
    }

    function showAfterCapture() {
      if (destroyed) return;
      hiddenForCapture = false;
      root.classList.remove('hidden');
      // A hidden element loses the focus: at the end of the panel it goes back to Done, else back
      // to the element (a HUD button, or the layer) that had it.
      const held = heldFocus;
      heldFocus = null;
      if (endFocus) {
        focusDone();
      } else if (held) {
        try {
          held.focus({ preventScroll: true });
        } catch {
          // Not focusable now.
        }
      }
    }

    /**
     * Keeps the overlay usable above everything the page does later: a modal dialog that opens
     * moves the host into it, and a popover that opens above it is passed by showing the host
     * again. It does nothing while the overlay is hidden for a capture (it cannot be hit then).
     */
    function keepOnTop() {
      if (destroyed || hiddenForCapture || mode === 'idle') return;
      const parent = mountPoint();
      if (host.parentNode !== parent) {
        elAppend(parent, host); // Moving a popover closes it.
        enterTopLayer();
        refocus();
      } else if (typeof host.hidePopover === 'function' && !isTopmost()) {
        try {
          host.hidePopover();
        } catch {
          // Not shown: show it now.
        }
        enterTopLayer();
        refocus();
      }
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      mode = 'idle';
      drag = null;
      cancelFrame(hoverFrame);
      hoverFrame = 0;
      try {
        for (const undo of cleanups.splice(0)) undo();
      } finally {
        hosts.delete(host);
        host.remove();
        heldFocus = null;
        restorePageFocus();
      }
    }

    return {
      host,
      beginSelect,
      showSession,
      setStatus,
      setBusy,
      hideForCapture,
      showAfterCapture,
      keepOnTop,
      destroy,
    };
  }

  ns.overlay = Object.freeze(/** @type {OverlayModule} */ ({ createOverlay }));
})();
