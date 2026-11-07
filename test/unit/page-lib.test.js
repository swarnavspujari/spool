// @ts-check
/**
 * Tests for src/page/page-lib.js. The script is a classic script: it is loaded into a node:vm
 * context whose globals are a small fake DOM (elements with boxes, a computed style, a paint
 * order and `elementsFromPoint`). Real browser behaviour is covered by the e2e tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadClassic } from '../helpers/load-classic.js';

/** @typedef {import('../../src/shared/types.js').Rect} Rect */
/** @typedef {import('../../types/page-globals.js').PageLib} PageLib */
/** @typedef {import('../../types/page-globals.js').ScrollTarget} ScrollTarget */

// ---------------------------------------------------------------------------------------------
// Fakes
// ---------------------------------------------------------------------------------------------

/**
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @returns {Rect}
 */
const box = (x, y, width, height) => ({ x, y, width, height });

/**
 * @typedef {Object} FakeEl
 * @property {string} name
 * @property {FakeEl | null} parentElement
 * @property {null} assignedSlot
 * @property {FakeShadow | null} shadowRoot
 * @property {FakeShadow | FakeDocument} root
 * @property {Rect} rect          Border box, viewport coordinates.
 * @property {Record<string, string>} css
 * @property {number} clientLeft
 * @property {number} clientTop
 * @property {number} clientWidth
 * @property {number} clientHeight
 * @property {number} scrollHeight
 * @property {number} scrollTop
 * @property {unknown} scrolledTo
 * @property {() => Record<string, number>} getBoundingClientRect
 * @property {() => FakeShadow | FakeDocument} getRootNode
 * @property {(options: unknown) => void} scrollTo
 */
/**
 * @typedef {{ nodeType: 11, host: FakeEl, elementsFromPoint(x: number, y: number): FakeEl[] }}
 *   FakeShadow
 */
/**
 * @typedef {{
 *   nodeType: 9,
 *   elementsFromPoint(x: number, y: number): FakeEl[],
 *   createTreeWalker(root: FakeShadow | FakeDocument, whatToShow: number): FakeWalker,
 * }} FakeDocument
 */
/** @typedef {{ nextNode(): FakeEl | null }} FakeWalker */

/** Treats a fake as the DOM type the script expects. @param {unknown} fake @returns {Element} */
const asEl = (fake) => /** @type {Element} */ (fake);

/** Names of the elements, for readable comparisons. @param {Iterable<unknown>} list */
const names = (list) => Array.from(list, (el) => /** @type {FakeEl} */ (el).name);

/** Copies a value out of the script's realm. @template T @param {T} value @returns {T} */
const plain = (value) => JSON.parse(JSON.stringify(value));

class FakeDom {
  /** @param {{ width?: number, height?: number, pageHeight?: number }} [size] */
  constructor({ width = 1000, height = 800, pageHeight = height } = {}) {
    /** @type {FakeEl[]} Paint order: later entries are on top. */
    this.paint = [];
    /** @type {(FakeShadow | FakeDocument)[]} The roots a tree walker was made for, in order. */
    this.walks = [];
    /** How many computed styles were read. */
    this.styleReads = 0;
    /** @type {FakeDocument} */
    this.document = {
      nodeType: 9,
      elementsFromPoint: (x, y) => this.hit(this.document, x, y),
      createTreeWalker: (root, whatToShow) => this.walk(root, whatToShow),
    };
    this.html = this.add('html', { rect: box(0, 0, width, height), scrollHeight: pageHeight });
    this.body = this.add('body', {
      parent: this.html,
      rect: box(0, 0, width, pageHeight),
    });
    Object.assign(this.document, {
      documentElement: this.html,
      body: this.body,
      scrollingElement: this.html,
    });
  }

  /**
   * @param {FakeShadow | FakeDocument} root
   * @param {number} x
   * @param {number} y
   * @returns {FakeEl[]} Topmost first, like the real call.
   */
  hit(root, x, y) {
    return this.paint
      .filter((el) => {
        const { x: left, y: top, width, height } = el.rect;
        return (
          el.root === root &&
          el.css['display'] !== 'none' &&
          el.css['pointerEvents'] !== 'none' &&
          x >= left &&
          x < left + width &&
          y >= top &&
          y < top + height
        );
      })
      .reverse();
  }

  /**
   * A tree walker over the elements of one root (it does not enter shadow roots, like the real one).
   * @param {FakeShadow | FakeDocument} root
   * @param {number} whatToShow
   * @returns {FakeWalker}
   */
  walk(root, whatToShow) {
    assert.equal(whatToShow, 1, 'the scan asks for elements only (SHOW_ELEMENT)');
    this.walks.push(root);
    const list = this.paint.filter((el) => el.root === root);
    let next = 0;
    return { nextNode: () => list[next++] ?? null };
  }

  /**
   * @param {string} name
   * @param {{
   *   parent?: FakeEl | null,
   *   root?: FakeShadow | FakeDocument,
   *   rect?: Rect,
   *   css?: Record<string, string>,
   *   scrollHeight?: number,
   *   client?: { left?: number, top?: number, width?: number, height?: number },
   * }} [options]
   * @returns {FakeEl}
   */
  add(name, options = {}) {
    const { parent = null, root, rect = box(0, 0, 0, 0), css = {}, scrollHeight } = options;
    const client = options.client ?? {};
    /** @type {FakeEl} */
    const el = {
      name,
      parentElement: parent,
      assignedSlot: null,
      shadowRoot: null,
      root: root ?? parent?.root ?? this.document,
      rect,
      css: {
        position: 'static',
        overflowX: 'visible',
        overflowY: 'visible',
        display: 'block',
        transform: 'none',
        pointerEvents: 'auto',
        ...css,
      },
      clientLeft: client.left ?? 0,
      clientTop: client.top ?? 0,
      clientWidth: client.width ?? rect.width,
      clientHeight: client.height ?? rect.height,
      scrollHeight: scrollHeight ?? client.height ?? rect.height,
      scrollTop: 0,
      scrolledTo: undefined,
      getBoundingClientRect() {
        // An element that is not displayed has an empty box.
        const { x, y, width, height } =
          this.css['display'] === 'none' ? box(0, 0, 0, 0) : this.rect;
        return { left: x, top: y, width, height, right: x + width, bottom: y + height };
      },
      getRootNode() {
        return this.root;
      },
      scrollTo(options) {
        this.scrolledTo = options;
      },
    };
    this.paint.push(el);
    return el;
  }

  /** Gives `host` an open shadow root. @param {FakeEl} host @returns {FakeShadow} */
  attachShadow(host) {
    /** @type {FakeShadow} */
    const shadow = {
      nodeType: 11,
      host,
      // Like the real call: the shadow tree first, then the host and the ancestors outside it.
      elementsFromPoint: (x, y) => [
        ...this.hit(shadow, x, y),
        ...this.hit(this.document, x, y),
      ],
    };
    host.shadowRoot = shadow;
    return shadow;
  }

  /** @returns {Record<string, unknown>} */
  globals() {
    return {
      document: this.document,
      getComputedStyle: (/** @type {FakeEl} */ el) => {
        this.styleReads += 1;
        return el.css;
      },
      requestAnimationFrame: (/** @type {() => void} */ cb) => setImmediate(cb),
      setTimeout,
    };
  }

  /** @returns {PageLib} */
  load() {
    const lib = loadClassic('src/page/page-lib.js', this.globals()).__spool?.lib;
    assert.ok(lib, 'page-lib.js must register __spool.lib');
    return lib;
  }
}

/**
 * A fake element with an inline style that logs every write.
 * @param {Record<string, { value: string, priority?: string }>} [initial]
 */
function styled(initial = {}) {
  const props = new Map(Object.entries(initial).map(([k, v]) => [k, { priority: '', ...v }]));
  /** @type {unknown[][]} */
  const log = [];
  const state = { failWrites: false };
  const guard = () => {
    if (state.failWrites) throw new Error('style is locked');
  };
  const style = {
    getPropertyValue: (/** @type {string} */ p) => props.get(p)?.value ?? '',
    getPropertyPriority: (/** @type {string} */ p) => props.get(p)?.priority ?? '',
    setProperty(/** @type {string} */ p, /** @type {string} */ value, priority = '') {
      guard();
      log.push(['set', p, value, priority]);
      props.set(p, { value, priority });
    },
    removeProperty(/** @type {string} */ p) {
      guard();
      log.push(['remove', p]);
      props.delete(p);
    },
  };
  return { el: asEl({ style }), log, props, state };
}

// ---------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------

/**
 * One scan of a rect: a new scanner, one `collect`.
 * @param {any} lib  The loaded page-lib API.
 * @param {any} rect
 * @param {any} ignore
 * @param {any} target
 * @returns {any[]}
 */
function scan(lib, rect, ignore, target) {
  return lib.createOverlayScanner(ignore, target).collect(rect);
}


describe('page-lib registration', () => {
  it('registers a frozen API with exactly the contract methods', () => {
    const lib = new FakeDom().load();
    assert.ok(Object.isFrozen(lib));
    assert.deepEqual(Object.keys(lib).sort(), [
      'clipRect',
      'contentYOf',
      'createOverlayScanner',
      'createStyleJar',
      'findScrollTarget',
      'getScrollTop',
      'listScrollTargets',
      'maxScrollTop',
      'nextFrames',
      'setScrollTop',
      'sleep',
    ]);
  });

  it('replaces the module on every injection (no already-loaded guard)', () => {
    const globals = new FakeDom().globals();
    const context = loadClassic('src/page/page-lib.js', globals);
    const first = context.__spool?.lib;
    loadClassic('src/page/page-lib.js', context);
    const second = context.__spool?.lib;
    assert.ok(first && second);
    assert.notEqual(first, second);
  });

  it('leaves no global except __spool, and that one is not enumerable', () => {
    const globals = new FakeDom().globals();
    const context = loadClassic('src/page/page-lib.js', globals);
    const added = Object.getOwnPropertyNames(context).filter((key) => !(key in globals));
    assert.deepEqual(added, ['__spool']);
    assert.equal(Object.getOwnPropertyDescriptor(context, '__spool')?.enumerable, false);
    assert.deepEqual(Object.keys(context).filter((key) => !(key in globals)), []);
  });
});

describe('clipRect', () => {
  const lib = new FakeDom().load();

  it('returns the overlap of two rects', () => {
    const clipped = lib.clipRect(box(0, 0, 100, 100), box(50, 20, 100, 100));
    assert.deepEqual(plain(clipped), box(50, 20, 50, 80));
  });

  it('returns the inner rect when one contains the other, in either order', () => {
    const inner = box(10, 10, 20, 30);
    assert.deepEqual(plain(lib.clipRect(box(0, 0, 100, 100), inner)), inner);
    assert.deepEqual(plain(lib.clipRect(inner, box(0, 0, 100, 100))), inner);
  });

  it('returns null for rects that do not overlap or only touch', () => {
    assert.equal(lib.clipRect(box(0, 0, 10, 10), box(20, 20, 10, 10)), null);
    assert.equal(lib.clipRect(box(0, 0, 10, 10), box(10, 0, 10, 10)), null);
    assert.equal(lib.clipRect(box(0, 0, 10, 10), box(0, 10, 10, 10)), null);
  });

  it('returns null when the overlap is under 1 px in either direction', () => {
    assert.equal(lib.clipRect(box(0, 0, 10, 10), box(9.5, 0, 10, 10)), null);
    assert.equal(lib.clipRect(box(0, 0, 10, 10), box(0, 9.5, 10, 10)), null);
  });

  it('keeps an overlap of exactly 1 px', () => {
    assert.deepEqual(plain(lib.clipRect(box(0, 0, 10, 10), box(9, 9, 10, 10))), box(9, 9, 1, 1));
  });

  it('handles negative coordinates and fractions', () => {
    const clipped = lib.clipRect(box(-20, -10, 30, 30), box(-5.5, 0, 100, 100));
    assert.deepEqual(plain(clipped), box(-5.5, 0, 15.5, 20));
  });

  it('returns null for empty or non-finite input', () => {
    assert.equal(lib.clipRect(box(0, 0, 0, 10), box(0, 0, 10, 10)), null);
    assert.equal(lib.clipRect(box(0, 0, 10, 10), box(NaN, 0, 10, 10)), null);
    assert.equal(lib.clipRect(box(0, 0, 10, 10), box(0, 0, Infinity, NaN)), null);
  });

  it('does not change its arguments', () => {
    const a = Object.freeze(box(0, 0, 100, 100));
    const b = Object.freeze(box(50, 50, 100, 100));
    assert.deepEqual(plain(lib.clipRect(a, b)), box(50, 50, 50, 50));
    assert.deepEqual({ ...a }, box(0, 0, 100, 100));
  });
});

describe('createStyleJar', () => {
  const lib = new FakeDom().load();

  it('applies the value with !important', () => {
    const jar = lib.createStyleJar();
    const { el, log } = styled();
    jar.set(el, 'visibility', 'hidden');
    assert.deepEqual(log, [['set', 'visibility', 'hidden', 'important']]);
    assert.equal(jar.size, 1);
  });

  it('records the original once per element and property', () => {
    const jar = lib.createStyleJar();
    const { el, props } = styled({ color: { value: 'red' } });
    jar.set(el, 'color', 'blue');
    jar.set(el, 'color', 'green');
    assert.equal(jar.size, 1);
    assert.equal(props.get('color')?.value, 'green');
    jar.restoreAll();
    assert.deepEqual(props.get('color'), { value: 'red', priority: '' });
  });

  it('counts each (element, property) pair', () => {
    const jar = lib.createStyleJar();
    const a = styled().el;
    const b = styled().el;
    jar.set(a, 'visibility', 'hidden');
    jar.set(a, 'opacity', '0');
    jar.set(b, 'visibility', 'hidden');
    jar.set(b, 'visibility', 'hidden');
    assert.equal(jar.size, 3);
  });

  it('removes a property that had no inline value', () => {
    const jar = lib.createStyleJar();
    const { el, log, props } = styled();
    jar.set(el, 'visibility', 'hidden');
    jar.restoreAll();
    assert.deepEqual(log.at(-1), ['remove', 'visibility']);
    assert.equal(props.has('visibility'), false);
  });

  it('restores the original value with its original priority', () => {
    const jar = lib.createStyleJar();
    const { el, log } = styled({ color: { value: 'red', priority: 'important' } });
    jar.set(el, 'color', 'blue');
    jar.restoreAll();
    assert.deepEqual(log.at(-1), ['set', 'color', 'red', 'important']);
  });

  it('restores in reverse order', () => {
    const jar = lib.createStyleJar();
    const log = /** @type {string[]} */ ([]);
    const make = (/** @type {string} */ name) => {
      const { el } = styled();
      const style = /** @type {HTMLElement} */ (el).style;
      const remove = style.removeProperty.bind(style);
      style.removeProperty = (prop) => {
        log.push(`${name}.${prop}`);
        return remove(prop);
      };
      return el;
    };
    const a = make('a');
    const b = make('b');
    jar.set(a, 'one', '1');
    jar.set(b, 'two', '2');
    jar.set(a, 'three', '3');
    jar.restoreAll();
    assert.deepEqual(log, ['a.three', 'b.two', 'a.one']);
  });

  it('is empty after restoreAll and a second call does nothing', () => {
    const jar = lib.createStyleJar();
    const { el, log } = styled();
    jar.set(el, 'visibility', 'hidden');
    jar.restoreAll();
    const writes = log.length;
    jar.restoreAll();
    assert.equal(jar.size, 0);
    assert.equal(log.length, writes);
  });

  it('records again after restoreAll', () => {
    const jar = lib.createStyleJar();
    const { el, props } = styled({ color: { value: 'red' } });
    jar.set(el, 'color', 'blue');
    jar.restoreAll();
    jar.set(el, 'color', 'green');
    assert.equal(jar.size, 1);
    jar.restoreAll();
    assert.equal(props.get('color')?.value, 'red');
  });

  it('never throws from restoreAll and still restores the other elements', () => {
    const jar = lib.createStyleJar();
    const locked = styled();
    const fine = styled({ color: { value: 'red' } });
    jar.set(fine.el, 'color', 'blue');
    jar.set(locked.el, 'visibility', 'hidden');
    jar.set(fine.el, 'opacity', '0');
    locked.state.failWrites = true;
    assert.doesNotThrow(() => jar.restoreAll());
    assert.equal(fine.props.get('color')?.value, 'red');
    assert.equal(fine.props.has('opacity'), false);
    assert.equal(jar.size, 0);
  });

  it('ignores an element that cannot take a style', () => {
    const jar = lib.createStyleJar();
    assert.doesNotThrow(() => jar.set(asEl({}), 'visibility', 'hidden'));
    const rejecting = styled();
    rejecting.state.failWrites = true;
    assert.doesNotThrow(() => jar.set(rejecting.el, 'visibility', 'hidden'));
    assert.equal(jar.size, 0);
    assert.doesNotThrow(() => jar.restoreAll());
  });
});

describe('scrolling helpers', () => {
  const dom = new FakeDom({ pageHeight: 3000 });
  const lib = dom.load();
  const scroller = dom.add('scroller', {
    rect: box(100, 50, 400, 500),
    css: { overflowY: 'auto' },
    scrollHeight: 2000,
    client: { left: 1, top: 1, width: 385, height: 498 },
  });
  /** @type {ScrollTarget} */
  const element = { kind: 'element', el: asEl(scroller), box: box(101, 51, 385, 498) };
  /** @type {ScrollTarget} */
  const page = { kind: 'document', el: asEl(dom.html), box: box(0, 0, 1000, 800) };

  it('reads the scroll position', () => {
    scroller.scrollTop = 120;
    dom.html.scrollTop = 40;
    assert.equal(lib.getScrollTop(element), 120);
    assert.equal(lib.getScrollTop(page), 40);
  });

  it('computes the largest scroll position, never below 0', () => {
    assert.equal(lib.maxScrollTop(element), 2000 - 498);
    assert.equal(lib.maxScrollTop(page), 3000 - 800);
    scroller.scrollHeight = 100;
    assert.equal(lib.maxScrollTop(element), 0);
    scroller.scrollHeight = 2000;
  });

  it('scrolls instantly, whatever scroll-behavior says', () => {
    lib.setScrollTop(element, 700);
    assert.deepEqual(plain(scroller.scrolledTo), { top: 700, behavior: 'instant' });
    lib.setScrollTop(page, 12);
    assert.deepEqual(plain(dom.html.scrolledTo), { top: 12, behavior: 'instant' });
  });

  it('maps a rect to a content coordinate inside an element', () => {
    scroller.scrollTop = 400;
    // scrollTop + rect.y - box.y
    assert.equal(lib.contentYOf(element, box(120, 151, 100, 100)), 400 + 151 - 51);
    assert.equal(lib.contentYOf(element, box(120, 51, 100, 100)), 400);
  });

  it('maps a rect to a content coordinate on the page', () => {
    dom.html.scrollTop = 300;
    assert.equal(lib.contentYOf(page, box(0, 10, 100, 100)), 310);
  });

  it('keeps fractional scroll positions', () => {
    scroller.scrollTop = 400.5;
    assert.equal(lib.contentYOf(element, box(0, 51.25, 10, 10)), 400.75);
  });
});

describe('findScrollTarget', () => {
  it('falls back to the page, with the viewport as its box', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    dom.add('text', { parent: dom.body, rect: box(0, 0, 1000, 800) });
    const t = dom.load().findScrollTarget(box(100, 100, 400, 300));
    assert.equal(t.kind, 'document');
    assert.equal(t.el, dom.html);
    assert.deepEqual(plain(t.box), box(0, 0, 1000, 800));
  });

  it('uses the page box without scrollbars', () => {
    const dom = new FakeDom({ pageHeight: 4000 });
    dom.html.clientWidth = 985;
    const t = dom.load().findScrollTarget(box(100, 100, 400, 300));
    assert.equal(t.kind, 'document');
    assert.deepEqual(plain(t.box), box(0, 0, 985, 800));
  });

  it('picks the page for an ordinary long document', () => {
    const dom = new FakeDom({ pageHeight: 5000 });
    dom.add('article', { parent: dom.body, rect: box(0, 0, 1000, 5000) });
    const t = dom.load().findScrollTarget(box(100, 100, 400, 300));
    assert.equal(t.kind, 'document');
  });

  it('finds the inner scroller of a chat-style app and excludes border and scrollbar', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const chat = dom.add('chat', {
      parent: dom.body,
      rect: box(200, 50, 600, 700),
      css: { overflowY: 'auto' },
      scrollHeight: 4000,
      client: { left: 1, top: 1, width: 583, height: 698 },
    });
    dom.add('message', { parent: chat, rect: box(210, 60, 500, 200) });
    const t = dom.load().findScrollTarget(box(300, 100, 300, 400));
    assert.equal(t.kind, 'element');
    assert.equal(t.el, chat);
    assert.deepEqual(plain(t.box), box(201, 51, 583, 698));
  });

  it('prefers the scroller over a page that also scrolls', () => {
    const dom = new FakeDom({ pageHeight: 3000 });
    const panel = dom.add('panel', {
      parent: dom.body,
      rect: box(100, 100, 500, 400),
      css: { overflowY: 'scroll' },
      scrollHeight: 1500,
    });
    const t = dom.load().findScrollTarget(box(150, 150, 300, 200));
    assert.equal(t.el, panel);
  });

  it('does not treat overflow hidden, clip or visible as scrollers', () => {
    for (const overflowY of ['hidden', 'clip', 'visible']) {
      const dom = new FakeDom({ pageHeight: 800 });
      dom.add('panel', {
        parent: dom.body,
        rect: box(100, 100, 500, 400),
        css: { overflowY },
        scrollHeight: 2000,
      });
      const t = dom.load().findScrollTarget(box(150, 150, 300, 200));
      assert.equal(t.kind, 'document', overflowY);
    }
  });

  it('does not treat an element without extra content as a scroller', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    dom.add('short', {
      parent: dom.body,
      rect: box(100, 100, 500, 400),
      css: { overflowY: 'auto' },
      scrollHeight: 401,
    });
    assert.equal(dom.load().findScrollTarget(box(150, 150, 300, 200)).kind, 'document');
  });

  it('accepts overflow-y: overlay', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const panel = dom.add('panel', {
      parent: dom.body,
      rect: box(100, 100, 500, 400),
      css: { overflowY: 'overlay' },
      scrollHeight: 1500,
    });
    assert.equal(dom.load().findScrollTarget(box(150, 150, 300, 200)).el, panel);
  });

  describe('nested scrollers', () => {
    const build = () => {
      const dom = new FakeDom({ pageHeight: 800 });
      const outer = dom.add('outer', {
        parent: dom.body,
        rect: box(200, 50, 600, 700),
        css: { overflowY: 'auto' },
        scrollHeight: 3000,
      });
      const inner = dom.add('inner', {
        parent: outer,
        rect: box(250, 100, 300, 300),
        css: { overflowY: 'auto' },
        scrollHeight: 900,
      });
      return { lib: dom.load(), outer, inner };
    };

    it('picks the inner scroller when the selection is inside it', () => {
      const { lib, inner } = build();
      assert.equal(lib.findScrollTarget(box(260, 110, 200, 200)).el, inner);
    });

    it('picks the inner scroller when it holds most of the selection', () => {
      const { lib, inner } = build();
      // The inner scroller covers 60% of this selection.
      assert.equal(lib.findScrollTarget(box(250, 100, 300, 500)).el, inner);
    });

    it('picks the outer scroller when the inner one holds a small part', () => {
      const { lib, outer } = build();
      assert.equal(lib.findScrollTarget(box(210, 60, 560, 600)).el, outer);
    });

    it('picks the inner scroller for a click on it, the outer one beside it', () => {
      const { lib, outer, inner } = build();
      assert.equal(lib.findScrollTarget(box(300, 200, 1, 1)).el, inner);
      assert.equal(lib.findScrollTarget(box(700, 600, 1, 1)).el, outer);
    });
  });

  describe('scrollers side by side', () => {
    /** @param {number[]} widths */
    const columns = (widths) => {
      const dom = new FakeDom({ pageHeight: 800 });
      let x = 0;
      const els = widths.map((width, i) => {
        const el = dom.add(`col${i}`, {
          parent: dom.body,
          rect: box(x, 0, width, 800),
          css: { overflowY: 'auto' },
          scrollHeight: 3000,
        });
        x += width;
        return el;
      });
      return { lib: dom.load(), els };
    };

    it('picks the one that holds most of the selection', () => {
      const { lib, els } = columns([400, 600]);
      assert.equal(lib.findScrollTarget(box(300, 100, 500, 400)).el, els[1]);
      assert.equal(lib.findScrollTarget(box(100, 100, 400, 400)).el, els[0]);
    });

    it('breaks a tie in favour of the first one found', () => {
      const { lib, els } = columns([500, 500]);
      assert.equal(lib.findScrollTarget(box(250, 100, 500, 400)).el, els[0]);
    });

    it('picks the one with the largest share when none holds most of it', () => {
      // Shares of the selection: 40%, 30%, 30%.
      const first = columns([400, 300, 300]);
      assert.equal(first.lib.findScrollTarget(box(0, 100, 1000, 400)).el, first.els[0]);
      // Shares of the selection: 30%, 40%, 30%.
      const middle = columns([300, 400, 300]);
      assert.equal(middle.lib.findScrollTarget(box(0, 100, 1000, 400)).el, middle.els[1]);
    });
  });

  it('looks through the stack: a cover on top of the scroller does not hide it', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const chat = dom.add('chat', {
      parent: dom.body,
      rect: box(200, 50, 600, 700),
      css: { overflowY: 'auto' },
      scrollHeight: 4000,
    });
    dom.add('cover', { parent: dom.html, rect: box(0, 0, 1000, 800), css: { position: 'fixed' } });
    assert.equal(dom.load().findScrollTarget(box(300, 100, 1, 1)).el, chat);
  });

  it('goes into open shadow roots and out through the host', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const host = dom.add('host', { parent: dom.body, rect: box(100, 100, 500, 500) });
    const shadow = dom.attachShadow(host);
    const scroller = dom.add('scroller', {
      root: shadow,
      rect: box(100, 100, 500, 500),
      css: { overflowY: 'auto' },
      scrollHeight: 2000,
    });
    const t = dom.load().findScrollTarget(box(150, 150, 300, 300));
    assert.equal(t.kind, 'element');
    assert.equal(t.el, scroller);
    assert.deepEqual(plain(t.box), box(100, 100, 500, 500));
  });

  it('clips the box to a scroller that clips it (an ancestor with overflow hidden)', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const wrapper = dom.add('wrapper', {
      parent: dom.body,
      rect: box(0, 0, 1000, 300),
      css: { overflowY: 'hidden' },
    });
    const scroller = dom.add('scroller', {
      parent: wrapper,
      rect: box(0, 0, 1000, 600),
      css: { overflowY: 'auto' },
      scrollHeight: 2000,
    });
    const t = dom.load().findScrollTarget(box(100, 100, 200, 150));
    assert.equal(t.el, scroller);
    assert.deepEqual(plain(t.box), box(0, 0, 1000, 300));
  });

  it('ignores an inline ancestor with overflow set (it has no box to clip with)', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const span = dom.add('span', {
      parent: dom.body,
      rect: box(0, 0, 0, 0),
      css: { overflowY: 'hidden', display: 'inline' },
    });
    const scroller = dom.add('scroller', {
      parent: span,
      rect: box(0, 0, 1000, 600),
      css: { overflowY: 'auto' },
      scrollHeight: 2000,
    });
    const t = dom.load().findScrollTarget(box(100, 100, 200, 150));
    assert.equal(t.el, scroller);
    assert.deepEqual(plain(t.box), box(0, 0, 1000, 600));
  });

  it('clips the box to the viewport', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const scroller = dom.add('scroller', {
      parent: dom.body,
      rect: box(100, 500, 400, 600),
      css: { overflowY: 'auto' },
      scrollHeight: 2000,
    });
    const t = dom.load().findScrollTarget(box(150, 600, 200, 150));
    assert.equal(t.el, scroller);
    assert.deepEqual(plain(t.box), box(100, 500, 400, 300));
  });

  describe('positioned scrollers and clipping ancestors', () => {
    /** @param {Record<string, string>} wrapperCss @param {Record<string, string>} scrollerCss */
    const build = (wrapperCss, scrollerCss) => {
      const dom = new FakeDom({ pageHeight: 800 });
      const wrapper = dom.add('wrapper', {
        parent: dom.body,
        rect: box(0, 0, 1000, 300),
        css: { overflowY: 'hidden', ...wrapperCss },
      });
      const scroller = dom.add('scroller', {
        parent: wrapper,
        rect: box(0, 0, 1000, 600),
        css: { overflowY: 'auto', ...scrollerCss },
        scrollHeight: 2000,
      });
      const t = dom.load().findScrollTarget(box(100, 100, 200, 150));
      assert.equal(t.el, scroller);
      return plain(t.box);
    };

    it('an absolute scroller escapes a static clipping ancestor', () => {
      assert.deepEqual(build({}, { position: 'absolute' }), box(0, 0, 1000, 600));
    });

    it('an absolute scroller is clipped by its positioned ancestor', () => {
      const clipped = build({ position: 'relative' }, { position: 'absolute' });
      assert.deepEqual(clipped, box(0, 0, 1000, 300));
    });

    it('an absolute scroller is clipped by a transformed ancestor', () => {
      const clipped = build({ transform: 'scale(1)' }, { position: 'absolute' });
      assert.deepEqual(clipped, box(0, 0, 1000, 300));
    });

    it('a fixed scroller is not clipped by its ancestors', () => {
      assert.deepEqual(build({}, { position: 'fixed' }), box(0, 0, 1000, 600));
    });

    it('a sticky or relative scroller is clipped like a static one', () => {
      assert.deepEqual(build({}, { position: 'sticky' }), box(0, 0, 1000, 300));
      assert.deepEqual(build({}, { position: 'relative' }), box(0, 0, 1000, 300));
    });
  });

  describe('the page and <body>', () => {
    it('does not treat <body> as a scroller when its overflow went to the viewport', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      dom.body.css['overflowY'] = 'auto';
      dom.body.clientHeight = 800;
      dom.body.scrollHeight = 3000;
      const t = dom.load().findScrollTarget(box(100, 100, 300, 300));
      assert.equal(t.kind, 'document');
      assert.equal(t.el, dom.html);
    });

    it('treats <body> as a scroller when <html> keeps the viewport overflow', () => {
      const dom = new FakeDom({ pageHeight: 800 });
      dom.html.css['overflowY'] = 'hidden';
      dom.html.css['overflowX'] = 'hidden';
      dom.body.css['overflowY'] = 'auto';
      dom.body.clientHeight = 800;
      dom.body.scrollHeight = 3000;
      const t = dom.load().findScrollTarget(box(100, 100, 300, 300));
      assert.equal(t.kind, 'element');
      assert.equal(t.el, dom.body);
      assert.deepEqual(plain(t.box), box(0, 0, 1000, 800));
    });

    it('does not offer a page that cannot scroll (overflow hidden on the viewport)', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      dom.html.css['overflowY'] = 'hidden';
      dom.html.css['overflowX'] = 'hidden';
      const side = dom.add('side', {
        parent: dom.body,
        rect: box(0, 0, 300, 800),
        css: { overflowY: 'auto' },
        scrollHeight: 2000,
      });
      // The side scroller holds only 30% of the selection, but the page is not an option.
      const t = dom.load().findScrollTarget(box(0, 100, 1000, 400));
      assert.equal(t.el, side);
    });

    it('treats the page as scrollable under overflow: scroll on <html>', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      dom.html.css['overflowY'] = 'scroll';
      assert.equal(dom.load().findScrollTarget(box(100, 100, 300, 300)).kind, 'document');
    });
  });

  it('returns the page for a selection outside the viewport', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    dom.add('chat', {
      parent: dom.body,
      rect: box(200, 50, 600, 700),
      css: { overflowY: 'auto' },
      scrollHeight: 4000,
    });
    assert.equal(dom.load().findScrollTarget(box(2000, 2000, 100, 100)).kind, 'document');
  });

  it('works for a selection that only partly lies inside the viewport', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const chat = dom.add('chat', {
      parent: dom.body,
      rect: box(200, 50, 600, 700),
      css: { overflowY: 'auto' },
      scrollHeight: 4000,
    });
    assert.equal(dom.load().findScrollTarget(box(500, 400, 2000, 2000)).el, chat);
  });
});

describe('the overlay scanner (one scan of a rect)', () => {
  const RECT = box(200, 0, 800, 800);
  const FIXED = { position: 'fixed' };
  const STICKY = { position: 'sticky' };
  /** A pinned element that takes no pointer events: a hit test never reports it. */
  const GHOST = { position: 'fixed', pointerEvents: 'none' };

  /** The page itself scrolls. @param {FakeDom} dom @returns {ScrollTarget} */
  const pageTarget = (dom) => ({ kind: 'document', el: asEl(dom.html), box: box(0, 0, 1000, 800) });

  /**
   * "name:kind" of each hit, sorted. (`Array.from` makes an array of this realm: the script's
   * arrays have other prototypes and do not compare equal.)
   * @param {{ el: Element, kind: string }[]} hits
   */
  const described = (hits) =>
    Array.from(hits, (hit) => `${/** @type {FakeEl} */ (/** @type {unknown} */ (hit.el)).name}:${hit.kind}`).sort();

  /** A scrolling page with a header, a footer, a floating button and a side bar. */
  const page = () => {
    const dom = new FakeDom({ pageHeight: 3000 });
    dom.add('article', { parent: dom.body, rect: box(0, 0, 1000, 3000) });
    const header = dom.add('header', { parent: dom.body, rect: box(0, 0, 1000, 60), css: FIXED });
    const footer = dom.add('footer', { parent: dom.body, rect: box(0, 740, 1000, 60), css: FIXED });
    const fab = dom.add('fab', { parent: dom.body, rect: box(900, 500, 48, 48), css: STICKY });
    const sidebar = dom.add('sidebar', { parent: dom.body, rect: box(0, 0, 100, 800), css: FIXED });
    dom.add('relative', {
      parent: dom.body,
      rect: box(300, 300, 100, 100),
      css: { position: 'relative' },
    });
    const lib = dom.load();
    const target = pageTarget(dom);
    return { dom, lib, target, header, footer, fab, sidebar };
  };

  it('finds fixed and sticky elements that cover part of the rect, with their kind', () => {
    const { lib, target } = page();
    const found = scan(lib, RECT, null, target);
    assert.deepEqual(described(found), ['fab:sticky', 'footer:fixed', 'header:fixed']);
  });

  it('reports a header at the top of the rect as well as a footer (no frame phases)', () => {
    const { lib, target, header } = page();
    assert.ok(names(scan(lib, RECT, null, target).map((h) => h.el)).includes('header'));
    header.rect = box(0, 700, 1000, 60); // now a bar in the lower half
    assert.ok(names(scan(lib, RECT, null, target).map((h) => h.el)).includes('header'));
  });

  it('does not return elements that lie outside the rect', () => {
    const { lib, target } = page();
    const inside = described(scan(lib, RECT, null, target));
    assert.ok(!inside.includes('sidebar:fixed'));
    const left = described(scan(lib, box(0, 0, 400, 800), null, target));
    assert.ok(left.includes('sidebar:fixed'));
  });

  it('returns each element once, also when the hit test and the scan both find it', () => {
    const { lib, target } = page();
    const found = names(scan(lib, RECT, null, target).map((h) => h.el));
    assert.equal(new Set(found).size, found.length);
  });

  it('never returns the ignored element or anything inside it', () => {
    const { dom, lib, target } = page();
    const ours = dom.add('ours', { parent: dom.html, rect: box(0, 0, 1000, 800), css: FIXED });
    dom.add('ours-child', { parent: ours, rect: box(300, 300, 100, 100), css: FIXED });
    dom.add('ours-ghost', { parent: ours, rect: box(300, 400, 100, 100), css: GHOST });
    const found = described(scan(lib, RECT, asEl(ours), target));
    assert.deepEqual(found, ['fab:sticky', 'footer:fixed', 'header:fixed']);
    // Without the ignore argument the host would be hidden too.
    const all = described(scan(lib, RECT, null, target));
    assert.ok(all.includes('ours:fixed') && all.includes('ours-ghost:fixed'));
  });

  it('never returns <html> or <body>', () => {
    const { dom, lib, target } = page();
    dom.html.css['position'] = 'sticky';
    dom.body.css['position'] = 'fixed';
    const found = described(scan(lib, RECT, null, target));
    assert.ok(!found.some((f) => f.startsWith('html:') || f.startsWith('body:')));
    assert.equal(found.length, 3);
  });

  it('returns a fixed element and a fixed element inside it', () => {
    const dom = new FakeDom({ pageHeight: 3000 });
    const outer = dom.add('outer', { parent: dom.body, rect: box(0, 0, 400, 100), css: FIXED });
    dom.add('inner', { parent: outer, rect: box(10, 10, 100, 50), css: FIXED });
    const found = described(scan(dom.load(), box(0, 0, 1000, 800), null, pageTarget(dom)));
    assert.deepEqual(found, ['inner:fixed', 'outer:fixed']);
  });

  it('finds a fixed wrapper that has no size of its own through its visible child', () => {
    const dom = new FakeDom({ pageHeight: 3000 });
    const wrapper = dom.add('wrapper', { parent: dom.body, css: FIXED });
    const bubble = dom.add('bubble', {
      parent: wrapper,
      rect: box(900, 700, 60, 60),
      css: { position: 'absolute' },
    });
    const lib = dom.load();
    const target = pageTarget(dom);
    const all = box(0, 0, 1000, 800);
    assert.deepEqual(described(scan(lib, all, null, target)), ['wrapper:fixed']);
    bubble.rect = box(900, 20, 60, 60);
    assert.deepEqual(described(scan(lib, box(0, 100, 1000, 600), null, target)), []);
    assert.deepEqual(described(scan(lib, all, null, target)), ['wrapper:fixed']);
  });

  it('does not return the scroll target or an element that holds it', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const shell = dom.add('shell', { parent: dom.body, rect: box(0, 0, 1000, 800), css: FIXED });
    const chat = dom.add('chat', {
      parent: shell,
      rect: box(200, 100, 600, 600),
      css: { overflowY: 'auto' },
      scrollHeight: 3000,
    });
    dom.add('title', { parent: chat, rect: box(200, 100, 600, 50), css: STICKY });
    dom.add('composer', { parent: shell, rect: box(200, 640, 600, 60), css: FIXED });
    dom.add('fade', { parent: shell, rect: box(200, 580, 600, 60), css: GHOST });
    const lib = dom.load();
    const area = box(200, 100, 600, 600);
    /** @type {ScrollTarget} */
    const target = { kind: 'element', el: asEl(chat), box: area };
    assert.deepEqual(described(scan(lib, area, null, target)), [
      'composer:fixed',
      'fade:fixed',
      'title:sticky',
    ]);
  });

  it('does not return a fixed element that is the scroll target', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const drawer = dom.add('drawer', {
      parent: dom.body,
      rect: box(0, 0, 300, 800),
      css: { position: 'fixed', overflowY: 'auto' },
      scrollHeight: 3000,
    });
    /** @type {ScrollTarget} */
    const target = { kind: 'element', el: asEl(drawer), box: box(0, 0, 300, 800) };
    assert.deepEqual(described(scan(dom.load(), box(0, 0, 300, 800), null, target)), []);
  });

  it('returns nothing for a rect outside the viewport', () => {
    const { lib, target } = page();
    assert.equal(scan(lib, box(3000, 3000, 100, 100), null, target).length, 0);
  });

  describe('open shadow roots', () => {
    it('finds a fixed element that is drawn inside one', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      const host = dom.add('host', { parent: dom.body, rect: box(0, 0, 1000, 800) });
      const shadow = dom.attachShadow(host);
      dom.add('toast', { root: shadow, rect: box(700, 700, 200, 60), css: FIXED });
      const found = scan(dom.load(), box(0, 0, 1000, 800), null, pageTarget(dom));
      assert.deepEqual(described(found), ['toast:fixed']);
    });

    it('finds a pinned element inside one that takes no pointer events (the scan walks in)', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      const host = dom.add('host', { parent: dom.body, rect: box(0, 0, 1000, 800) });
      const shadow = dom.attachShadow(host);
      dom.add('veil', { root: shadow, rect: box(0, 600, 1000, 100), css: GHOST });
      const found = scan(dom.load(), box(0, 0, 1000, 800), null, pageTarget(dom));
      assert.deepEqual(described(found), ['veil:fixed']);
    });
  });

  describe('pinned elements that a hit test cannot see (pointer-events: none)', () => {
    it('finds a fade above a composer with the full scan', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      dom.add('article', { parent: dom.body, rect: box(0, 0, 1000, 3000) });
      const fade = dom.add('fade', { parent: dom.body, rect: box(200, 650, 600, 64), css: GHOST });
      dom.add('sticky-title', { parent: dom.body, rect: box(200, 0, 600, 40), css: STICKY });
      const area = box(200, 0, 600, 800);
      const hit = dom.document.elementsFromPoint(300, 680);
      assert.ok(!hit.includes(fade), 'a hit test does not see the fade');
      const found = scan(dom.load(), area, null, pageTarget(dom));
      assert.deepEqual(described(found), ['fade:fixed', 'sticky-title:sticky']);
    });

    it('skips scan candidates that are not displayed or that lie outside the rect', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      dom.add('none', {
        parent: dom.body,
        rect: box(0, 0, 1000, 800),
        css: { position: 'fixed', pointerEvents: 'none', display: 'none' },
      });
      dom.add('elsewhere', { parent: dom.body, rect: box(0, 0, 100, 800), css: GHOST });
      dom.add('here', { parent: dom.body, rect: box(300, 300, 100, 100), css: GHOST });
      const found = scan(dom.load(), box(200, 0, 800, 800), null, pageTarget(dom));
      assert.deepEqual(described(found), ['here:fixed']);
    });

    it('does not count a candidate that only touches the rect', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      dom.add('edge', { parent: dom.body, rect: box(0, 0, 200, 800), css: GHOST });
      assert.deepEqual(
        described(scan(dom.load(), box(200, 0, 800, 800), null, pageTarget(dom))),
        [],
      );
    });
  });

  describe('createOverlayScanner (one scanner per capture session)', () => {
    /** @param {FakeDom} dom */
    const documentScans = (dom) => dom.walks.filter((root) => root === dom.document).length;

    it('walks the document once, however many times it collects', () => {
      const { dom, lib, target } = page();
      const scanner = lib.createOverlayScanner(null, target);
      assert.equal(documentScans(dom), 0, 'nothing is scanned before the first collect');
      scanner.collect(RECT);
      scanner.collect(RECT);
      scanner.collect(RECT);
      assert.equal(documentScans(dom), 1);
      // The one-shot form scans every time.
      scan(lib, RECT, null, target);
      scan(lib, RECT, null, target);
      assert.equal(documentScans(dom), 3);
    });

    it('reads few styles per frame after the scan', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      dom.add('article', { parent: dom.body, rect: box(0, 0, 1000, 3000) });
      for (let i = 0; i < 500; i++) dom.add(`filler${i}`, { parent: dom.body });
      dom.add('fade', { parent: dom.body, rect: box(200, 650, 600, 64), css: GHOST });
      dom.add('header', { parent: dom.body, rect: box(0, 0, 1000, 60), css: FIXED });
      const scanner = dom.load().createOverlayScanner(null, pageTarget(dom));
      const before = dom.styleReads;
      scanner.collect(RECT);
      const first = dom.styleReads - before;
      assert.ok(first >= 500, `the first call reads every element (${first})`);
      const mid = dom.styleReads;
      scanner.collect(RECT);
      const next = dom.styleReads - mid;
      assert.ok(next < 30, `a later call reads only a few (${next})`);
    });

    it('looks at the page again on every call', () => {
      const { dom, lib, target, header, footer } = page();
      dom.add('ghost', { parent: dom.body, rect: box(0, 0, 100, 100), css: GHOST }); // outside RECT
      const scanner = lib.createOverlayScanner(null, target);
      assert.deepEqual(described(scanner.collect(RECT)), ['fab:sticky', 'footer:fixed', 'header:fixed']);

      // Released (the agent set it to static): no longer pinned, no longer returned.
      header.css['position'] = 'static';
      // Moved out of the rect and back in.
      footer.rect = box(0, 1200, 1000, 60);
      assert.deepEqual(described(scanner.collect(RECT)), ['fab:sticky']);
      footer.rect = box(0, 740, 1000, 60);
      assert.deepEqual(described(scanner.collect(RECT)), ['fab:sticky', 'footer:fixed']);

      // A candidate of the scan that moves into the rect later.
      const ghost = /** @type {FakeEl} */ (dom.paint.find((el) => el.name === 'ghost'));
      ghost.rect = box(500, 500, 100, 100);
      assert.deepEqual(described(scanner.collect(RECT)), ['fab:sticky', 'footer:fixed', 'ghost:fixed']);
    });

    it('finds a pinned element that is added after the scan, if it takes pointer events', () => {
      const { dom, lib, target } = page();
      const scanner = lib.createOverlayScanner(null, target);
      scanner.collect(RECT);
      dom.add('late-toast', { parent: dom.body, rect: box(400, 300, 200, 60), css: FIXED });
      assert.ok(described(scanner.collect(RECT)).includes('late-toast:fixed'));
    });

    it('keeps its ignore and target for every call', () => {
      const { dom, lib, target } = page();
      const ours = dom.add('ours', { parent: dom.html, rect: box(0, 0, 1000, 800), css: FIXED });
      const scanner = lib.createOverlayScanner(asEl(ours), target);
      for (let i = 0; i < 2; i++) {
        assert.ok(!names(scanner.collect(RECT).map((h) => h.el)).includes('ours'));
      }
    });

    it('returns nothing for a rect outside the viewport', () => {
      const { lib, target } = page();
      assert.equal(lib.createOverlayScanner(null, target).collect(box(3000, 3000, 9, 9)).length, 0);
    });
  });

  describe('limits of the full scan', () => {
    const LIMIT = 50_000;
    const small = box(0, 0, 20, 20);

    it('stops after 50,000 elements', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      const early = dom.add('early', { parent: dom.body, rect: small, css: GHOST });
      for (let i = 0; i < LIMIT; i++) dom.add('filler', { parent: dom.body });
      dom.add('late', { parent: dom.body, rect: small, css: GHOST });
      const before = dom.styleReads;
      const found = scan(dom.load(), small, null, pageTarget(dom));
      assert.deepEqual(described(found), ['early:fixed']);
      assert.ok(found[0]?.el === asEl(early));
      // html and body count as elements; the hit test adds a handful of reads.
      assert.ok(dom.styleReads - before <= LIMIT + 50, `style reads: ${dom.styleReads - before}`);
    });

    it('still finds everything when the page is smaller than the limit', () => {
      const dom = new FakeDom({ pageHeight: 3000 });
      for (let i = 0; i < 2000; i++) dom.add('filler', { parent: dom.body });
      dom.add('late', { parent: dom.body, rect: small, css: GHOST });
      assert.deepEqual(described(scan(dom.load(), small, null, pageTarget(dom))), [
        'late:fixed',
      ]);
    });

    it('keeps the hit-test results when the scan throws', () => {
      const { dom, lib, target } = page();
      dom.document.createTreeWalker = () => {
        throw new Error('no tree walker');
      };
      const found = scan(lib, RECT, null, target);
      assert.deepEqual(described(found), ['fab:sticky', 'footer:fixed', 'header:fixed']);
    });
  });
});

describe('nextFrames and sleep', () => {
  /** @param {number} n */
  const run = async (n) => {
    /** @type {(() => void)[]} */
    const frames = [];
    const dom = new FakeDom();
    const globals = {
      ...dom.globals(),
      requestAnimationFrame: (/** @type {() => void} */ cb) => frames.push(cb),
    };
    const lib = loadClassic('src/page/page-lib.js', globals).__spool?.lib;
    assert.ok(lib);
    let done = false;
    const promise = lib.nextFrames(n).then(() => {
      done = true;
    });
    return { frames, promise, isDone: () => done };
  };

  /** Lets resolved promises run. */
  const flush = () => new Promise((resolve) => setImmediate(resolve));

  it('waits for n animation frames, one per tick', async () => {
    const { frames, isDone, promise } = await run(3);
    assert.equal(frames.length, 1);
    for (let i = 1; i <= 3; i++) {
      frames.shift()?.();
      await flush();
      assert.equal(isDone(), i === 3);
    }
    await promise;
  });

  it('waits for 2 frames by default', async () => {
    let frames = 0;
    const dom = new FakeDom();
    const globals = {
      ...dom.globals(),
      requestAnimationFrame: (/** @type {() => void} */ cb) => {
        frames += 1;
        setImmediate(cb);
      },
    };
    const lib = loadClassic('src/page/page-lib.js', globals).__spool?.lib;
    assert.ok(lib);
    await lib.nextFrames();
    assert.equal(frames, 2);
  });

  it('resolves at once for 0 frames', async () => {
    const { isDone, promise } = await run(0);
    await promise;
    assert.equal(isDone(), true);
  });

  it('sleep resolves after the delay and treats a negative delay as 0', async () => {
    const lib = new FakeDom().load();
    const start = Date.now();
    await lib.sleep(30);
    assert.ok(Date.now() - start >= 25);
    await lib.sleep(-5);
  });
});

// ---------------------------------------------------------------------------------------------
// Names that page markup can shadow (DOM clobbering)
// ---------------------------------------------------------------------------------------------

/**
 * Turns a FakeDom into a DOM with prototypes, like a browser's: `Document.prototype` and
 * `Element.prototype` hold the accessors, and the objects the script gets are instances that keep
 * the real data out of reach. A test can then shadow a name on one object (as `<img name="title">`
 * or `<form><input name="style">` does) and see that the script still reads the real value.
 * @param {FakeDom} dom
 */
function virtualize(dom) {
  const REAL = Symbol('real');
  class NodeType {}
  class ElementType extends NodeType {}
  class HTMLElementType extends ElementType {}
  class ShadowRootType extends NodeType {}
  class DocumentType extends NodeType {}
  /** @type {Map<unknown, any>} */
  const wrapped = new Map();
  /** @param {any} raw @returns {any} */
  const wrap = (raw) => {
    if (raw === null || raw === undefined) return raw;
    let node = wrapped.get(raw);
    if (!node) {
      const type = raw.nodeType === 9 ? DocumentType : raw.nodeType === 11 ? ShadowRootType : HTMLElementType;
      node = Object.create(type.prototype);
      node[REAL] = raw;
      wrapped.set(raw, node);
    }
    return node;
  };
  /** @param {any} node */
  const real = (node) => node[REAL];
  /**
   * @param {object} proto
   * @param {string} name
   * @param {boolean} [node]  The value is an element or a root: wrap it.
   */
  const accessor = (proto, name, node = false) =>
    Object.defineProperty(proto, name, {
      configurable: true,
      get() {
        const value = real(this)[name];
        return node ? wrap(value) : value;
      },
    });

  accessor(NodeType.prototype, 'parentElement', true);
  Object.defineProperty(NodeType.prototype, 'nodeType', {
    configurable: true,
    get() {
      return real(this).nodeType ?? 1;
    },
  });
  /** @type {any} */ (NodeType.prototype).getRootNode = function () {
    return wrap(real(this).getRootNode());
  };
  for (const name of ['shadowRoot', 'assignedSlot']) accessor(ElementType.prototype, name, true);
  for (const name of ['clientLeft', 'clientTop', 'clientWidth', 'clientHeight', 'scrollHeight']) {
    accessor(ElementType.prototype, name);
  }
  Object.defineProperty(ElementType.prototype, 'scrollTop', {
    configurable: true,
    get() {
      return real(this).scrollTop;
    },
  });
  /** @type {any} */ (ElementType.prototype).getBoundingClientRect = function () {
    return real(this).getBoundingClientRect();
  };
  /** @type {any} */ (ElementType.prototype).scrollTo = function (/** @type {unknown} */ options) {
    real(this).scrollTo(options);
  };
  Object.defineProperty(HTMLElementType.prototype, 'style', {
    configurable: true,
    get() {
      return real(this).style;
    },
  });
  accessor(ShadowRootType.prototype, 'host', true);
  for (const name of ['documentElement', 'body', 'scrollingElement']) {
    accessor(DocumentType.prototype, name, true);
  }
  for (const type of [DocumentType, ShadowRootType]) {
    /** @type {any} */ (type.prototype).elementsFromPoint = function (/** @type {number} */ x, /** @type {number} */ y) {
      return real(this).elementsFromPoint(x, y).map(wrap);
    };
  }
  /** @type {any} */ (DocumentType.prototype).createTreeWalker = function (/** @type {any} */ root, /** @type {number} */ what) {
    const walker = real(this).createTreeWalker(real(root), what);
    return { nextNode: () => wrap(walker.nextNode()) };
  };

  const document = wrap(dom.document);
  const globals = {
    ...dom.globals(),
    document,
    Document: DocumentType,
    Node: NodeType,
    Element: ElementType,
    HTMLElement: HTMLElementType,
    ShadowRoot: ShadowRootType,
    getComputedStyle: (/** @type {any} */ el) => real(el).css,
  };
  return {
    wrap,
    document,
    globals,
    /** @returns {PageLib} */
    load() {
      const lib = loadClassic('src/page/page-lib.js', globals).__spool?.lib;
      assert.ok(lib, 'page-lib.js must register __spool.lib');
      return lib;
    },
  };
}

/** What page markup puts in place of a name: something that is no use. */
const JUNK = Object.freeze({ junk: true });

/**
 * Shadows names on `node` itself, like markup does.
 * @param {any} node
 * @param {string[]} names
 */
function shadow(node, names) {
  for (const name of names) {
    Object.defineProperty(node, name, { value: JUNK, configurable: true });
  }
}

describe('names that page markup can shadow (DOM clobbering)', () => {
  it('registers on a namespace of its own when the name belongs to an element', () => {
    const globals = new FakeDom().globals();
    const element = Object.create({ [Symbol.toStringTag]: 'HTMLFormElement' });
    element.lib = JUNK;
    const context = loadClassic('src/page/page-lib.js', { ...globals, __spool: element });
    const ns = /** @type {any} */ (context).__spool;
    assert.notEqual(ns, element, 'the element is not used');
    assert.ok(Object.isFrozen(ns.lib));
    assert.equal(Object.getOwnPropertyDescriptor(context, '__spool')?.enumerable, false);
  });

  it('keeps the namespace of an earlier injection', () => {
    const globals = new FakeDom().globals();
    /** @type {any} */
    const previous = { config: { sessionId: 'x' } };
    const context = loadClassic('src/page/page-lib.js', { ...globals, __spool: previous });
    const ns = /** @type {any} */ (context).__spool;
    assert.equal(ns, previous);
    assert.deepEqual(plain(ns.config), { sessionId: 'x' });
    assert.ok(ns.lib);
  });

  it('works through the prototypes of an unshadowed DOM (the control for the tests below)', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const chat = dom.add('chat', {
      parent: dom.body,
      rect: box(200, 50, 600, 700),
      css: { overflowY: 'auto' },
      scrollHeight: 4000,
      client: { left: 1, top: 1, width: 583, height: 698 },
    });
    const world = virtualize(dom);
    const target = world.load().findScrollTarget(box(300, 100, 300, 400));
    assert.equal(target.el, world.wrap(chat));
    assert.deepEqual(plain(target.box), box(201, 51, 583, 698));
  });

  it('finds the scroller and the pinned elements when markup shadows the names of the document', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const chat = dom.add('chat', {
      parent: dom.body,
      rect: box(200, 50, 600, 700),
      css: { overflowY: 'auto' },
      scrollHeight: 4000,
    });
    dom.add('title', { parent: chat, rect: box(200, 50, 600, 40), css: { position: 'sticky' } });
    dom.add('fade', {
      parent: dom.body,
      rect: box(200, 600, 600, 100),
      css: { position: 'fixed', pointerEvents: 'none' },
    });
    const world = virtualize(dom);
    const lib = world.load();
    // <img name="scrollingElement">, <img name="documentElement">, <img name="body">,
    // <img name="elementsFromPoint">, <img name="createTreeWalker">: all on the document.
    shadow(world.document, [
      'scrollingElement',
      'documentElement',
      'body',
      'elementsFromPoint',
      'createTreeWalker',
    ]);

    const target = lib.findScrollTarget(box(300, 100, 300, 400));
    assert.equal(target.el, world.wrap(chat));
    const area = box(200, 50, 600, 700);
    const found = scan(lib, area, null, { kind: 'element', el: target.el, box: area });
    assert.deepEqual(
      Array.from(found, (h) => `${dom.paint.find((e) => world.wrap(e) === h.el)?.name}:${h.kind}`).sort(),
      ['fade:fixed', 'title:sticky'],
    );
  });

  it('reads an element that markup shadows (a <form> with named inputs) like any other', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const chat = dom.add('chat', {
      parent: dom.body,
      rect: box(200, 50, 600, 700),
      css: { overflowY: 'auto' },
      scrollHeight: 4000,
      client: { left: 1, top: 1, width: 583, height: 698 },
    });
    chat.scrollTop = 120;
    const world = virtualize(dom);
    const lib = world.load();
    // <form><input name="getBoundingClientRect"><input name="parentElement"> ...</form>
    shadow(world.wrap(chat), [
      'getBoundingClientRect',
      'parentElement',
      'shadowRoot',
      'assignedSlot',
      'clientLeft',
      'clientTop',
      'clientWidth',
      'clientHeight',
      'scrollHeight',
      'scrollTop',
      'scrollTo',
      'style',
    ]);

    const target = lib.findScrollTarget(box(300, 100, 300, 400));
    assert.equal(target.el, world.wrap(chat));
    assert.deepEqual(plain(target.box), box(201, 51, 583, 698));
    assert.equal(lib.getScrollTop(target), 120);
    assert.equal(lib.maxScrollTop(target), 4000 - 698);
    assert.equal(lib.contentYOf(target, box(300, 151, 10, 10)), 120 + 151 - 51);
    lib.setScrollTop(target, 700);
    assert.deepEqual(plain(chat.scrolledTo), { top: 700, behavior: 'instant' });
  });

  it('changes and restores the style of an element whose markup shadows `style`', () => {
    const dom = new FakeDom({ pageHeight: 800 });
    const el = dom.add('form', { parent: dom.body, rect: box(0, 0, 100, 100) });
    const holder = styled({ visibility: { value: 'visible' } });
    /** @type {any} */ (el).style = /** @type {any} */ (holder.el).style;
    const world = virtualize(dom);
    const jar = world.load().createStyleJar();
    const node = world.wrap(el);
    shadow(node, ['style']); // <form><input name="style"></form>

    jar.set(node, 'visibility', 'hidden');
    assert.equal(holder.props.get('visibility')?.value, 'hidden');
    assert.equal(jar.size, 1);
    jar.restoreAll();
    assert.equal(holder.props.get('visibility')?.value, 'visible');
  });
});
