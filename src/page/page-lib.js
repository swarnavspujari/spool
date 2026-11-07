// @ts-check
/**
 * Page helpers for the capture agent: find the element that scrolls, scroll it, find fixed and
 * sticky elements, and change inline styles with a guaranteed undo.
 *
 * Classic script for the page's isolated world. Contract: docs/contracts.md section 5.
 * Every injection replaces `__spool.lib` (no "already loaded" guard).
 */
(() => {
  'use strict';

  /** @typedef {import('../shared/types.js').Rect} Rect */
  /** @typedef {import('../../types/page-globals.js').ScrollTarget} ScrollTarget */
  /** @typedef {import('../../types/page-globals.js').StyleJar} StyleJar */
  /** @typedef {import('../../types/page-globals.js').PinnedKind} PinnedKind */
  /** @typedef {import('../../types/page-globals.js').PinnedElement} PinnedElement */
  /** @typedef {import('../../types/page-globals.js').OverlayScanner} OverlayScanner */
  /** @typedef {import('../../types/page-globals.js').PageLib} PageLib */
  /** @typedef {{ step: number, max: number }} Grid */

  // -----------------------------------------------------------------------------------------
  // Page-proof access to the DOM and to the shared namespace
  // -----------------------------------------------------------------------------------------
  // Page markup can shadow names that these scripts read (DOM clobbering). `<img name="title">`
  // replaces `document.title`, `<form><input name="style">` replaces `form.style`, and an element
  // with `id="__spool"` replaces `globalThis.__spool`. The page cannot change the prototypes
  // of this world, so every read of the page's DOM goes through the accessors that are taken from
  // them when the script loads. Without a prototype (a unit test with a fake DOM) the plain
  // property is used.

  /**
   * @param {object | undefined} proto
   * @param {string} name
   * @returns {(self: any) => any}  The getter of `proto[name]`, as a function of its object.
   */
  function getterFrom(proto, name) {
    const get = proto ? Object.getOwnPropertyDescriptor(proto, name)?.get : undefined;
    return get ? (self) => get.call(self) : (self) => self[name];
  }

  /**
   * @param {object | undefined} proto
   * @param {string} name
   * @returns {(self: any, ...args: any[]) => any}  The method `proto[name]`, called on `self`.
   */
  function methodFrom(proto, name) {
    const fn = proto ? Object.getOwnPropertyDescriptor(proto, name)?.value : undefined;
    return typeof fn === 'function'
      ? (self, ...args) => fn.apply(self, args)
      : (self, ...args) => self[name](...args);
  }

  const DocumentProto = globalThis.Document?.prototype;
  const NodeProto = globalThis.Node?.prototype;
  const ElementProto = globalThis.Element?.prototype;
  const ShadowRootProto = globalThis.ShadowRoot?.prototype;
  const docElement = getterFrom(DocumentProto, 'documentElement');
  const docBody = getterFrom(DocumentProto, 'body');
  const docScrollingElement = getterFrom(DocumentProto, 'scrollingElement');
  const docElementsFromPoint = methodFrom(DocumentProto, 'elementsFromPoint');
  const docCreateTreeWalker = methodFrom(DocumentProto, 'createTreeWalker');
  const shadowElementsFromPoint = methodFrom(ShadowRootProto, 'elementsFromPoint');
  const shadowHost = getterFrom(ShadowRootProto, 'host');
  const nodeParentElement = getterFrom(NodeProto, 'parentElement');
  const nodeType = getterFrom(NodeProto, 'nodeType');
  const nodeGetRootNode = methodFrom(NodeProto, 'getRootNode');
  const elShadowRoot = getterFrom(ElementProto, 'shadowRoot');
  const elAssignedSlot = getterFrom(ElementProto, 'assignedSlot');
  const elClientLeft = getterFrom(ElementProto, 'clientLeft');
  const elClientTop = getterFrom(ElementProto, 'clientTop');
  const elClientWidth = getterFrom(ElementProto, 'clientWidth');
  const elClientHeight = getterFrom(ElementProto, 'clientHeight');
  const elScrollHeight = getterFrom(ElementProto, 'scrollHeight');
  const elScrollTop = getterFrom(ElementProto, 'scrollTop');
  const elGetBoundingClientRect = methodFrom(ElementProto, 'getBoundingClientRect');
  const elScrollTo = methodFrom(ElementProto, 'scrollTo');
  const computedStyleOf = globalThis.getComputedStyle;
  /** The `style` getters of the element types that have an inline style. */
  const styleGetters = [globalThis.HTMLElement, globalThis.SVGElement].flatMap((type) => {
    const get = type ? Object.getOwnPropertyDescriptor(type.prototype, 'style')?.get : undefined;
    return get ? [get] : [];
  });

  /**
   * The inline style of an element, also when its markup shadows `style`.
   * @param {Element} el
   * @returns {CSSStyleDeclaration}
   */
  function inlineStyleOf(el) {
    for (const get of styleGetters) {
      try {
        return get.call(el);
      } catch {
        // Not an element of this type: try the next one.
      }
    }
    return /** @type {HTMLElement} */ (el).style;
  }

  /**
   * The shared namespace. It is an own, plain-object property of the global: markup cannot replace
   * an own property (an element with that id only shows up as an inherited, named one). Another
   * kind of value, for example an element, is not trusted: a fresh namespace takes its place.
   * It is not enumerable, so it does not show up in `for...in` or `Object.keys` of the global.
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

  /** `overflow-y` values of an element that the user can scroll. */
  const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
  /** Content must overflow by more than this (CSS px) to count as scrollable (rounding noise). */
  const SCROLL_SLACK = 1;
  /** Share of the selection that a scroller must cover to win over the scrollers around it. */
  const MAJORITY = 0.5;
  /** Scroll targets are large: a coarse grid is enough. */
  const TARGET_GRID = { step: 80, max: 12 };
  /** Floating buttons can be 40 px wide: sample densely. */
  const OVERLAY_GRID = { step: 32, max: 24 };
  /** The full scan for pinned elements stops after this many elements (a huge page must not stall). */
  const SCAN_LIMIT = 50_000;
  /** Smallest panel (CSS px, each side) that the keyboard list holds: the same as a drag box. */
  const MIN_PANEL_SIZE = 24;
  /** The keyboard list stops here: a page with hundreds of small scrollers is not a list to Tab. */
  const MAX_PANELS = 24;
  const DOCUMENT_FRAGMENT_NODE = 11;
  /** `NodeFilter.SHOW_ELEMENT` (the constant is not written out: no dependency on the global). */
  const SHOW_ELEMENT = 1;

  // -----------------------------------------------------------------------------------------
  // Geometry
  // -----------------------------------------------------------------------------------------

  /**
   * Intersection of two rects, or null when it is less than 1 px wide or high.
   * @param {Rect} a
   * @param {Rect} b
   * @returns {Rect | null}
   */
  function clipRect(a, b) {
    const x = Math.max(a.x, b.x);
    const y = Math.max(a.y, b.y);
    const width = Math.min(a.x + a.width, b.x + b.width) - x;
    const height = Math.min(a.y + a.height, b.y + b.height) - y;
    // Written as a positive test so that NaN (bad input) also gives null.
    return width >= 1 && height >= 1 ? { x, y, width, height } : null;
  }

  /**
   * Area of the overlap of two rects, 0 when they do not overlap.
   * @param {Rect} a
   * @param {Rect} b
   */
  function overlapArea(a, b) {
    const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
    const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
    return width > 0 && height > 0 ? width * height : 0;
  }

  /** The element that scrolls the page: <html>, or <body> in quirks mode. */
  function viewportElement() {
    return docScrollingElement(document) || docElement(document);
  }

  /** The viewport without scrollbars, in viewport coordinates. @returns {Rect} */
  function viewportBox() {
    const el = viewportElement();
    return { x: 0, y: 0, width: elClientWidth(el), height: elClientHeight(el) };
  }

  /**
   * Padding box minus scrollbars: the area in which an element shows its content.
   * @param {Element} el
   * @returns {Rect}
   */
  function clientBox(el) {
    const r = elGetBoundingClientRect(el);
    return {
      x: r.left + elClientLeft(el),
      y: r.top + elClientTop(el),
      width: elClientWidth(el),
      height: elClientHeight(el),
    };
  }

  /**
   * Border box in viewport coordinates.
   * @param {Element} el
   * @returns {Rect}
   */
  function boxOf(el) {
    const r = elGetBoundingClientRect(el);
    return { x: r.left, y: r.top, width: r.width, height: r.height };
  }

  /**
   * Sample coordinates along one axis. Both ends are included (half a pixel inside) so that
   * bars that hug an edge are found.
   * @param {number} start
   * @param {number} size
   * @param {Grid} grid
   * @returns {number[]}
   */
  function axisPoints(start, size, grid) {
    if (size <= 1) return [start + size / 2];
    const count = Math.min(grid.max, Math.ceil(size / grid.step) + 1);
    return Array.from({ length: count }, (_, i) => start + 0.5 + ((size - 1) * i) / (count - 1));
  }

  /**
   * @param {Rect} rect
   * @param {Grid} grid
   * @returns {{ x: number, y: number }[]}
   */
  function samplePoints(rect, grid) {
    const xs = axisPoints(rect.x, rect.width, grid);
    const points = [];
    for (const y of axisPoints(rect.y, rect.height, grid)) {
      for (const x of xs) points.push({ x, y });
    }
    return points;
  }

  // -----------------------------------------------------------------------------------------
  // Walking the page (flat tree: slots and open shadow roots)
  // -----------------------------------------------------------------------------------------

  /**
   * Parent in the flat tree: the slot for a slotted element, the host for a shadow tree's top.
   * @param {Element} el
   * @returns {Element | null}
   */
  function composedParent(el) {
    const slot = elAssignedSlot(el);
    if (slot) return slot;
    const parent = nodeParentElement(el);
    if (parent) return parent;
    const root = nodeGetRootNode(el);
    return nodeType(root) === DOCUMENT_FRAGMENT_NODE ? shadowHost(root) : null;
  }

  /**
   * Is `el` the same as `ancestor` or inside it?
   * @param {Element} el
   * @param {Element} ancestor
   */
  function isInside(el, ancestor) {
    /** @type {Element | null} */
    let node = el;
    while (node && node !== ancestor) node = composedParent(node);
    return node !== null;
  }

  /**
   * All elements under a viewport point, topmost first. Looks into open shadow roots (the
   * document only reports the host).
   * @param {DocumentOrShadowRoot & Node} root
   * @param {number} x
   * @param {number} y
   * @param {Element[]} out
   */
  function stackAt(root, x, y, out) {
    const hit = root === document ? docElementsFromPoint(root, x, y) : shadowElementsFromPoint(root, x, y);
    for (const el of hit) {
      // The list of a shadow root also holds its host and the ancestors outside it.
      if (nodeGetRootNode(el) !== root) continue;
      const shadow = elShadowRoot(el);
      if (shadow) stackAt(shadow, x, y, out);
      out.push(el);
    }
  }

  /**
   * Visits each element of `stack` and then its ancestors, each element once per `seen`.
   * `visit` returns false to stop climbing the current chain (its ancestors are not visited).
   * @param {Element[]} stack
   * @param {Set<Element>} seen
   * @param {(el: Element) => boolean | void} visit
   */
  function climb(stack, seen, visit) {
    for (const hit of stack) {
      /** @type {Element | null} */
      let el = hit;
      while (el && !seen.has(el)) {
        seen.add(el);
        if (visit(el) === false) break;
        el = composedParent(el);
      }
    }
  }

  // -----------------------------------------------------------------------------------------
  // Scroll target
  // -----------------------------------------------------------------------------------------

  /**
   * The element whose `overflow` the viewport adopts: <html>, or <body> when <html> is visible.
   * A body like that is not a scroller of its own.
   */
  function viewportOverflowSource() {
    const root = docElement(document);
    const { overflowX, overflowY } = computedStyleOf(root);
    const bodyHoldsIt = overflowX === 'visible' && overflowY === 'visible';
    const body = docBody(document);
    return bodyHoldsIt && body ? body : root;
  }

  /** Can the user scroll the page itself? (`overflow: hidden` on the viewport says no.) */
  function documentScrolls() {
    const el = viewportElement();
    if (elScrollHeight(el) <= elClientHeight(el) + SCROLL_SLACK) return false;
    const { overflowY } = computedStyleOf(viewportOverflowSource());
    return overflowY !== 'hidden' && overflowY !== 'clip';
  }

  /** @param {Element} el */
  function scrollsVertically(el) {
    return (
      SCROLLING_OVERFLOW.has(computedStyleOf(el).overflowY) &&
      elScrollHeight(el) > elClientHeight(el) + SCROLL_SLACK
    );
  }

  /** @returns {ScrollTarget} */
  function documentTarget() {
    return { kind: 'document', el: viewportElement(), box: viewportBox() };
  }

  /**
   * The part of an element's client box that is on screen: clipped by the viewport and by every
   * ancestor that clips it. Null when nothing is left.
   * @param {Element} el
   * @returns {Rect | null}
   */
  function visibleClientBox(el) {
    const source = viewportOverflowSource();
    let box = clipRect(clientBox(el), viewportBox());
    let position = computedStyleOf(el).position;
    for (let a = composedParent(el); a && box; a = composedParent(a)) {
      // The viewport clip is already applied. A fixed element ignores clipping ancestors
      // (a transformed ancestor that would clip it is not handled).
      if (a === docElement(document) || position === 'fixed') break;
      const style = computedStyleOf(a);
      // An absolute element is clipped only by its containing block and the ancestors outside it.
      const containsAbsolute = style.position !== 'static' || style.transform !== 'none';
      if (position === 'absolute' && !containsAbsolute) continue;
      const hasBox = style.display !== 'inline' && style.display !== 'contents';
      const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible';
      if (a !== source && hasBox && clips) box = clipRect(box, clientBox(a));
      position = style.position;
    }
    return box;
  }

  /**
   * Every vertical scroller found under the sample points of `rect` (the page itself included
   * when it scrolls), innermost first along each chain.
   * @param {Rect} rect
   * @returns {ScrollTarget[]}
   */
  function scrollerCandidates(rect) {
    const page = viewportElement();
    const source = viewportOverflowSource();
    /** @type {Set<Element>} */
    const seen = new Set();
    /** @type {ScrollTarget[]} */
    const found = [];
    for (const { x, y } of samplePoints(rect, TARGET_GRID)) {
      /** @type {Element[]} */
      const stack = [];
      // The whole stack, not only the top element: an overlay or a transparent cover may sit
      // above the scroller.
      stackAt(document, x, y, stack);
      climb(stack, seen, (el) => {
        if (el === page) {
          if (documentScrolls()) found.push(documentTarget());
          return false;
        }
        if (el === docElement(document)) return false; // <html> in quirks mode never scrolls
        // <body> is not a scroller of its own when its overflow went to the viewport.
        if (el === source || !scrollsVertically(el)) return;
        const box = visibleClientBox(el);
        if (box) found.push({ kind: 'element', el, box });
      });
    }
    return found;
  }

  /**
   * Does `outer` hold `inner`? The page holds every element target.
   * @param {ScrollTarget} outer
   * @param {ScrollTarget} inner
   */
  function encloses(outer, inner) {
    if (inner.kind === 'document') return false;
    return outer.kind === 'document' || (inner.el !== outer.el && isInside(inner.el, outer.el));
  }

  /**
   * Picks the innermost scroller that covers most of `rect`. When none covers most of it, the
   * one that covers the most. Without any scroller: the page.
   * @param {Rect} rect
   * @returns {ScrollTarget}
   */
  function pickTarget(rect) {
    const area = Math.max(rect.width, 1) * Math.max(rect.height, 1);
    const scored = scrollerCandidates(rect).map((target) => ({
      target,
      share: overlapArea(rect, target.box) / area,
    }));
    if (scored.length === 0) return documentTarget();
    // On a tie the earlier one wins: the one that is higher on the page.
    const best = (/** @type {typeof scored} */ list) =>
      list.reduce((a, b) => (b.share > a.share ? b : a));
    const majority = scored.filter((s) => s.share >= MAJORITY);
    if (majority.length === 0) return best(scored).target;
    return best(majority.filter((a) => !majority.some((b) => encloses(a.target, b.target)))).target;
  }

  /**
   * @param {Rect} rect  Viewport coordinates.
   * @returns {ScrollTarget}
   */
  function findScrollTarget(rect) {
    const view = clipRect(rect, viewportBox());
    return view ? pickTarget(view) : documentTarget();
  }

  /**
   * The scroll panels that are on screen, in reading order: top to bottom, then left to right (the
   * larger one first when two start at the same place). The page itself is one of them when it
   * scrolls. The overlay uses the list for keyboard selection (Tab and Shift+Tab). The panels are
   * found like the target under the pointer is (`scrollerCandidates` over the whole viewport), so a
   * panel that a click can select can be reached with the keyboard. A panel smaller than
   * MIN_PANEL_SIZE in either direction is left out, and the list stops at MAX_PANELS. A page with
   * no scroller gives the page itself, which is what a click on it selects.
   * @returns {ScrollTarget[]}
   */
  function listScrollTargets() {
    const panels = scrollerCandidates(viewportBox())
      .filter((t) => t.box.width >= MIN_PANEL_SIZE && t.box.height >= MIN_PANEL_SIZE)
      .sort(
        (a, b) =>
          a.box.y - b.box.y ||
          a.box.x - b.box.x ||
          b.box.width * b.box.height - a.box.width * a.box.height,
      );
    return panels.length > 0 ? panels.slice(0, MAX_PANELS) : [documentTarget()];
  }

  // -----------------------------------------------------------------------------------------
  // Scrolling
  // -----------------------------------------------------------------------------------------

  /** @param {ScrollTarget} t */
  function getScrollTop(t) {
    return elScrollTop(t.el);
  }

  /** @param {ScrollTarget} t */
  function maxScrollTop(t) {
    return Math.max(0, elScrollHeight(t.el) - elClientHeight(t.el));
  }

  /**
   * `behavior: 'instant'` ignores a `scroll-behavior: smooth` rule of the page.
   * @param {ScrollTarget} t
   * @param {number} top
   */
  function setScrollTop(t, top) {
    elScrollTo(t.el, { top, behavior: 'instant' });
  }

  /**
   * Content coordinate of the top edge of `rect` (viewport coordinates).
   * @param {ScrollTarget} t
   * @param {Rect} rect
   */
  function contentYOf(t, rect) {
    const top = elScrollTop(t.el);
    return t.kind === 'document' ? top + rect.y : top + rect.y - t.box.y;
  }

  // -----------------------------------------------------------------------------------------
  // Fixed and sticky elements
  // -----------------------------------------------------------------------------------------

  /**
   * @param {Element} el
   * @returns {PinnedKind | null} `fixed` or `sticky` by the computed `position`, else null.
   */
  function pinnedKind(el) {
    const { position } = computedStyleOf(el);
    return position === 'fixed' || position === 'sticky' ? position : null;
  }

  /**
   * Every element under `root` (and under the open shadow roots inside it) with a pinned
   * `position`, in document order. It reads the computed style of each element, so it is the
   * costly part: it stops when `budget.left` elements are visited.
   * @param {Document | ShadowRoot} root
   * @param {{ left: number }} budget
   * @param {Element[]} out
   */
  function scanPinned(root, budget, out) {
    const walker = docCreateTreeWalker(document, root, SHOW_ELEMENT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (budget.left <= 0) return;
      budget.left -= 1;
      const el = /** @type {Element} */ (node);
      if (pinnedKind(el)) out.push(el);
      const shadow = elShadowRoot(el);
      if (shadow) scanPinned(shadow, budget, out);
    }
  }

  /**
   * Finds the fixed and sticky elements that cover part of the capture area. They would repeat in
   * every frame (fixed) or sit at the top of every frame (sticky). It never returns:
   *   - `ignore` and its subtree (the Spool overlay), `<html>` and `<body>`,
   *   - the scroll target and its ancestors (hiding those would hide the capture itself).
   *
   * Two ways find an element, and `collect` merges them:
   *   1. Hit test: a grid of points in the area (`elementsFromPoint`, shadow roots included),
   *      each hit and each of its ancestors. It sees what is drawn there, also a fixed wrapper
   *      that has no box of its own (its visible child is hit). It runs on every call.
   *   2. Full scan, once per scanner: one walk over the document and its open shadow roots finds
   *      the pinned elements a hit test cannot reach (`pointer-events: none`, for example a fade
   *      above a chat composer). Per call only these few candidates are checked again: is the
   *      element still pinned, and does its box meet the area. A pinned element that is created
   *      later and takes no pointer events is not found by the scan, only by the hit test.
   *
   * @param {Element | null} ignore  The overlay host.
   * @param {ScrollTarget} target
   * @returns {OverlayScanner}
   */
  function createOverlayScanner(ignore, target) {
    const html = docElement(document);
    const body = docBody(document);
    /** The candidates of the full scan, taken on the first `collect`. @type {Element[] | null} */
    let scanned = null;

    /** @param {Element} el */
    const isExcluded = (el) =>
      el === html ||
      el === body ||
      (ignore !== null && isInside(el, ignore)) ||
      isInside(target.el, el);

    function candidates() {
      if (scanned === null) {
        scanned = [];
        try {
          scanPinned(document, { left: SCAN_LIMIT }, scanned);
        } catch {
          // Best effort: the hit test still works with the part that was found.
        }
      }
      return scanned;
    }

    /**
     * @param {Rect} rect  Viewport coordinates.
     * @returns {PinnedElement[]}
     */
    function collect(rect) {
      const view = clipRect(rect, viewportBox());
      if (!view) return [];
      /** @type {Map<Element, PinnedKind>} */
      const found = new Map();
      /** @type {Map<Element, PinnedKind | null>} */
      const kinds = new Map();
      /** @param {Element} el */
      const kindOf = (el) => {
        let kind = kinds.get(el);
        if (kind === undefined) {
          kind = pinnedKind(el);
          kinds.set(el, kind);
        }
        return kind;
      };
      /** @param {Element} el */
      const consider = (el) => {
        const kind = kindOf(el);
        if (kind && !found.has(el) && !isExcluded(el)) found.set(el, kind);
      };

      for (const { x, y } of samplePoints(view, OVERLAY_GRID)) {
        /** @type {Element[]} */
        const stack = [];
        stackAt(document, x, y, stack);
        climb(stack, new Set(), consider);
      }
      for (const el of candidates()) {
        if (found.has(el) || !kindOf(el) || isExcluded(el)) continue;
        if (clipRect(boxOf(el), view)) consider(el);
      }
      return Array.from(found, ([el, kind]) => ({ el, kind }));
    }

    return { collect };
  }

  // -----------------------------------------------------------------------------------------
  // Style jar
  // -----------------------------------------------------------------------------------------

  /** @returns {StyleJar} */
  function createStyleJar() {
    /** @type {{ el: Element, prop: string, value: string, priority: string }[]} */
    let saved = [];
    /** @type {Map<Element, Set<string>>} */
    const known = new Map();
    return {
      set(el, prop, value) {
        try {
          const style = inlineStyleOf(el);
          const props = known.get(el) ?? new Set();
          const original = props.has(prop)
            ? null
            : { value: style.getPropertyValue(prop), priority: style.getPropertyPriority(prop) };
          style.setProperty(prop, value, 'important');
          if (original) {
            props.add(prop);
            known.set(el, props);
            saved.push({ el, prop, ...original });
          }
        } catch {
          // Best effort: an element that cannot take a style must not stop a capture.
        }
      },
      restoreAll() {
        const entries = saved;
        saved = [];
        known.clear();
        for (let i = entries.length - 1; i >= 0; i--) {
          const { el, prop, value, priority } = entries[i];
          try {
            const style = inlineStyleOf(el);
            if (value === '') style.removeProperty(prop);
            else style.setProperty(prop, value, priority);
          } catch {
            // The element is gone or locked: there is nothing left to restore.
          }
        }
      },
      get size() {
        return saved.length;
      },
    };
  }

  // -----------------------------------------------------------------------------------------
  // Timing
  // -----------------------------------------------------------------------------------------

  /**
   * @param {number} [n]
   * @returns {Promise<void>}
   */
  function nextFrames(n = 2) {
    return new Promise((resolve) => {
      let left = n;
      const tick = () => {
        if (left-- > 0) requestAnimationFrame(tick);
        else resolve();
      };
      tick();
    });
  }

  /**
   * @param {number} ms
   * @returns {Promise<void>}
   */
  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  }

  ns.lib = Object.freeze(
    /** @type {PageLib} */ ({
      findScrollTarget,
      listScrollTargets,
      clipRect,
      getScrollTop,
      maxScrollTop,
      setScrollTop,
      contentYOf,
      createOverlayScanner,
      createStyleJar,
      nextFrames,
      sleep,
    }),
  );
})();
