// @ts-check
/**
 * More tests for src/page/page-lib.js, written from mutation testing:
 * the points of the hit-test grids (which decide what the library can see), the scroll slack, the
 * walk from a shadow tree up to its host, the fallback when the page has no scrolling element, and
 * the timer. A very small fake DOM: elements are plain objects, and the document records every
 * point that it is asked about.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadClassic } from '../helpers/load-classic.js';

/**
 * One scan of a rect: a new scanner, one `collect`.
 * @param {any} lib  The loaded page-lib API.
 * @param {any} rect
 * @param {any} ignore
 * @param {any} target
 */
function scan(lib, rect, ignore, target) {
  return lib.createOverlayScanner(ignore, target).collect(rect);
}

/**
 * @param {string} name
 * @param {Record<string, any>} [props]
 * @returns {any}
 */
function element(name, props = {}) {
  return {
    name,
    nodeType: 1,
    parentElement: null,
    assignedSlot: null,
    shadowRoot: null,
    clientLeft: 0,
    clientTop: 0,
    clientWidth: 0,
    clientHeight: 0,
    scrollHeight: 0,
    scrollTop: 0,
    rect: { x: 0, y: 0, width: 0, height: 0 },
    css: {
      position: 'static',
      overflowX: 'visible',
      overflowY: 'visible',
      display: 'block',
      transform: 'none',
    },
    getBoundingClientRect() {
      const r = this.rect;
      return { left: r.x, top: r.y, width: r.width, height: r.height, right: r.x + r.width, bottom: r.y + r.height };
    },
    scrollTo() {},
    ...props,
  };
}

/** @param {{ width?: number, height?: number }} [size] The viewport. */
function setup({ width = 1000, height = 800 } = {}) {
  /** @type {any} */
  const doc = { nodeType: 9, stack: null, walk: [], walkerArgs: [], scrollingElement: null };
  const html = element('html', {
    clientWidth: width,
    clientHeight: height,
    scrollHeight: height,
    rect: { x: 0, y: 0, width, height },
    getRootNode: () => doc,
  });
  const body = element('body', {
    parentElement: html,
    clientWidth: width,
    clientHeight: height,
    rect: { x: 0, y: 0, width, height },
    getRootNode: () => doc,
  });
  doc.documentElement = html;
  doc.body = body;
  doc.scrollingElement = html;
  /** @type {number[][]} */
  const asked = [];
  doc.elementsFromPoint = (/** @type {number} */ x, /** @type {number} */ y) => {
    asked.push([x, y]);
    if (doc.stackFn) return doc.stackFn(x, y);
    return doc.stack ?? [html];
  };
  doc.createTreeWalker = (/** @type {unknown} */ _root, /** @type {number} */ what) => {
    doc.walkerArgs.push(what);
    const list = doc.walk;
    let i = 0;
    return { nextNode: () => list[i++] ?? null };
  };
  /** @type {number[]} */
  const timeouts = [];
  const lib = loadClassic('src/page/page-lib.js', {
    document: doc,
    getComputedStyle: (/** @type {any} */ el) => el.css,
    requestAnimationFrame: (/** @type {() => void} */ cb) => setImmediate(cb),
    setTimeout: (/** @type {() => void} */ fn, /** @type {number} */ ms) => {
      timeouts.push(ms);
      fn();
    },
  }).__spool?.lib;
  assert.ok(lib, 'page-lib.js must register __spool.lib');
  return { lib, doc, html, body, asked, timeouts };
}

/** The distinct values of one coordinate, in order of first use. @param {number[][]} points @param {0 | 1} axis */
const distinct = (points, axis) => [...new Set(points.map((p) => p[axis]))];

describe('page-lib: the hit-test grid of the scroll target search', () => {
  it('samples both ends of each axis (half a pixel inside) and evenly between them', () => {
    const t = setup();
    t.lib.findScrollTarget({ x: 10, y: 20, width: 100, height: 50 });
    assert.deepEqual(t.asked, [
      [10.5, 20.5],
      [60, 20.5],
      [109.5, 20.5],
      [10.5, 69.5],
      [60, 69.5],
      [109.5, 69.5],
    ]);
  });

  it('a one-pixel axis has one sample, in its middle', () => {
    const t = setup();
    t.lib.findScrollTarget({ x: 10, y: 20, width: 1, height: 1 });
    assert.deepEqual(t.asked, [[10.5, 20.5]]);
  });

  it('puts a sample at every 80 px, and no more than 12 on an axis', () => {
    const t = setup({ width: 2000, height: 900 });
    t.lib.findScrollTarget({ x: 0, y: 0, width: 810, height: 810 });
    assert.equal(distinct(t.asked, 0).length, 12, '810 / 80 is 11 steps: 12 samples');
    assert.equal(distinct(t.asked, 1).length, 12);
    const wide = setup({ width: 2000, height: 900 });
    wide.lib.findScrollTarget({ x: 0, y: 0, width: 2000, height: 900 });
    assert.equal(distinct(wide.asked, 0).length, 12, 'capped at 12');
    assert.equal(distinct(wide.asked, 1).length, 12, '900 / 80 is 12 steps: 13, capped at 12');
    const small = setup({ width: 2000, height: 900 });
    small.lib.findScrollTarget({ x: 0, y: 0, width: 79, height: 81 });
    assert.equal(distinct(small.asked, 0).length, 2);
    assert.equal(distinct(small.asked, 1).length, 3);
  });
});

describe('page-lib: the hit-test grid of the scan for fixed and sticky elements', () => {
  /** @param {ReturnType<typeof setup>} t @param {{ x: number, y: number, width: number, height: number }} rect */
  function collect(t, rect) {
    const scanner = t.lib.createOverlayScanner(null, { kind: 'document', el: t.html, box: { x: 0, y: 0, width: 5000, height: 5000 } });
    return scanner.collect(rect);
  }

  it('samples every 32 px, both ends included', () => {
    const t = setup();
    collect(t, { x: 10, y: 20, width: 100, height: 50 });
    assert.deepEqual(distinct(t.asked, 0), [10.5, 35.25, 60, 84.75, 109.5]);
    assert.deepEqual(distinct(t.asked, 1), [20.5, 45, 69.5]);
    assert.equal(t.asked.length, 15);
  });

  it('keeps to the grid of 32 px, and to 24 samples on an axis', () => {
    const t = setup({ width: 2000, height: 2000 });
    collect(t, { x: 0, y: 0, width: 330, height: 320 });
    assert.equal(distinct(t.asked, 0).length, 12, '330 / 32 is 11 steps');
    assert.equal(distinct(t.asked, 1).length, 11, '320 / 32 is 10 steps');
    const big = setup({ width: 2000, height: 2000 });
    collect(big, { x: 0, y: 0, width: 2000, height: 2000 });
    assert.equal(distinct(big.asked, 0).length, 24);
    assert.equal(distinct(big.asked, 1).length, 24);
  });

  it('the full scan walks the elements of the document once per scanner', () => {
    const t = setup();
    const scanner = t.lib.createOverlayScanner(null, { kind: 'document', el: t.html, box: { x: 0, y: 0, width: 5000, height: 5000 } });
    scanner.collect({ x: 0, y: 0, width: 100, height: 100 });
    scanner.collect({ x: 0, y: 0, width: 100, height: 100 });
    assert.deepEqual(t.doc.walkerArgs, [1], 'only elements, and only once');
  });
});

describe('page-lib: what counts as a scroller', () => {
  /** @param {number} scrollHeight */
  function pick(scrollHeight) {
    const t = setup();
    const panel = element('panel', {
      parentElement: t.html,
      clientWidth: 300,
      clientHeight: 400,
      scrollHeight,
      rect: { x: 100, y: 100, width: 300, height: 400 },
      css: { position: 'static', overflowX: 'visible', overflowY: 'auto', display: 'block', transform: 'none' },
      getRootNode: () => t.doc,
    });
    t.doc.stack = [panel, t.html];
    return { target: t.lib.findScrollTarget({ x: 150, y: 150, width: 100, height: 100 }), panel };
  }

  it('content that overflows by one CSS px is rounding noise; two is a scroller', () => {
    assert.equal(pick(400).target.kind, 'document');
    assert.equal(pick(401).target.kind, 'document');
    const two = pick(402);
    assert.equal(two.target.kind, 'element');
    assert.equal(two.target.el, two.panel);
    assert.deepEqual({ ...two.target.box }, { x: 100, y: 100, width: 300, height: 400 });
  });
});

describe('page-lib: the walk up from a shadow tree', () => {
  /** An overlay host with a fixed element inside its open shadow root. */
  function overlayHost() {
    const t = setup();
    const host = element('host', { parentElement: t.body, rect: { x: 0, y: 0, width: 10, height: 10 }, getRootNode: () => t.doc });
    /** @type {any} */
    const shadow = { nodeType: 11, host };
    const child = element('child', {
      parentElement: null,
      rect: { x: 0, y: 0, width: 50, height: 50 },
      css: { position: 'fixed', overflowX: 'visible', overflowY: 'visible', display: 'block', transform: 'none' },
      getRootNode: () => shadow,
    });
    shadow.elementsFromPoint = () => [child, host];
    host.shadowRoot = shadow;
    t.doc.stack = [host, t.html];
    return { ...t, host, child };
  }

  it('an element inside the shadow root of the ignored host is ignored with it', () => {
    const t = overlayHost();
    const target = { kind: /** @type {const} */ ('document'), el: t.html, box: { x: 0, y: 0, width: 1000, height: 800 } };
    assert.equal(scan(t.lib, { x: 0, y: 0, width: 40, height: 40 }, t.host, target).length, 0);
    const seen = scan(t.lib, { x: 0, y: 0, width: 40, height: 40 }, null, target);
    assert.equal(seen.length, 1, 'without the host to ignore it is found');
    assert.equal(/** @type {any} */ (seen[0]?.el).name, 'child');
    assert.equal(seen[0]?.kind, 'fixed');
  });
});

describe('page-lib: the page without a scrolling element, and the timer', () => {
  it('falls back to <html> when the document names no scrolling element', () => {
    const t = setup();
    t.doc.scrollingElement = null;
    const target = t.lib.findScrollTarget({ x: 10, y: 10, width: 100, height: 100 });
    assert.equal(target.kind, 'document');
    assert.equal(target.el, t.html);
    assert.deepEqual({ ...target.box }, { x: 0, y: 0, width: 1000, height: 800 });
  });

  it('sleep waits as long as asked, and never a negative time', async () => {
    const t = setup();
    await t.lib.sleep(7);
    await t.lib.sleep(-5);
    await t.lib.sleep(0);
    assert.deepEqual(t.timeouts, [7, 0, 0]);
  });
});

describe('page-lib: limits and special paths of the walks', () => {
  const view = { x: 0, y: 0, width: 100, height: 100 };

  /** @param {string} name @param {string} position */
  const pinned = (name, position) =>
    element(name, {
      rect: { x: 10, y: 10, width: 20, height: 20 },
      css: { position, overflowX: 'visible', overflowY: 'visible', display: 'block', transform: 'none' },
    });

  it('the full scan looks at 50,000 elements and no more', () => {
    const t = setup();
    const filler = { shadowRoot: null, css: { position: 'static' } };
    const walk = Array.from({ length: 49_999 }, () => filler);
    walk.push(pinned('last-in-reach', 'fixed'), pinned('too-far', 'fixed'));
    t.doc.walk = walk;
    const scanner = t.lib.createOverlayScanner(null, { kind: 'document', el: t.html, box: { x: 0, y: 0, width: 1000, height: 800 } });
    const names = scanner.collect(view).map((p) => /** @type {any} */ (p.el).name);
    assert.deepEqual([...names], ['last-in-reach']);
  });

  it('an element that is slotted into the shadow tree of the ignored host is ignored with it', () => {
    const t = setup();
    const host = element('host', { parentElement: t.body, getRootNode: () => t.doc });
    /** @type {any} */
    const shadow = { nodeType: 11, host, elementsFromPoint: () => [] };
    const slot = element('slot', { parentElement: null, getRootNode: () => shadow });
    const child = element('child', {
      parentElement: t.body,
      assignedSlot: slot,
      rect: { x: 0, y: 0, width: 50, height: 50 },
      css: { position: 'fixed', overflowX: 'visible', overflowY: 'visible', display: 'block', transform: 'none' },
      getRootNode: () => t.doc,
    });
    host.shadowRoot = shadow;
    t.doc.stack = [child, host, t.html];
    const target = { kind: /** @type {const} */ ('document'), el: t.html, box: { x: 0, y: 0, width: 1000, height: 800 } };
    assert.equal(scan(t.lib, { x: 0, y: 0, width: 40, height: 40 }, host, target).length, 0);
    assert.equal(scan(t.lib, { x: 0, y: 0, width: 40, height: 40 }, null, target).length, 1);
  });

  it('a scroller that covers exactly half of the selection counts as a majority, and the innermost wins', () => {
    const t = setup();
    const css = { position: 'static', overflowX: 'visible', overflowY: 'auto', display: 'block', transform: 'none' };
    const outer = element('outer', {
      parentElement: t.html,
      clientWidth: 600,
      clientHeight: 600,
      scrollHeight: 2000,
      rect: { x: 0, y: 0, width: 600, height: 600 },
      css,
      getRootNode: () => t.doc,
    });
    const inner = element('inner', {
      parentElement: outer,
      clientWidth: 100,
      clientHeight: 200,
      scrollHeight: 900,
      rect: { x: 100, y: 100, width: 100, height: 200 },
      css,
      getRootNode: () => t.doc,
    });
    t.doc.stackFn = (/** @type {number} */ x) => (x < 200 ? [inner, outer, t.html] : [outer, t.html]);
    const target = t.lib.findScrollTarget({ x: 100, y: 100, width: 200, height: 200 });
    assert.equal(target.kind, 'element');
    assert.equal(/** @type {any} */ (target.el).name, 'inner');
  });
});
