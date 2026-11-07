// @ts-check
/**
 * More tests for src/page/overlay.js, written from mutation testing:
 * the namespace, the edges of the drag rules (slop, minimum size, which pointer, which button),
 * rounding and clamping of the box, the readout numbers, the keys while busy, what beginSelect
 * resets, what a destroyed overlay ignores, and the layout boundaries of the HUD, the thread, the
 * hover label and the size label. Same kind of fake page as overlay.test.js.
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { loadClassic } from '../helpers/load-classic.js';

/** @typedef {import('../../src/shared/types.js').Rect} Rect */
/** @typedef {import('../../types/page-globals.js').OverlayCommand} OverlayCommand */

const CLICK_BOX = Object.freeze({ x: 40, y: 50, width: 300, height: 400 });
const SESSION_RECT = Object.freeze({ x: 100, y: 100, width: 400, height: 400 });

class FakeTarget {
  constructor() {
    /** @type {Map<string, unknown[]> | undefined} */
    this.optionsSeen = undefined;
    /** @type {Map<string, Set<(e: any) => void>>} */
    this.listeners = new Map();
  }

  /** @param {string} type @param {(e: any) => void} fn @param {unknown} [options] */
  addEventListener(type, fn, options) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
    /** @type {Map<string, unknown[]>} */
    this.optionsSeen ??= new Map();
    this.optionsSeen.set(type, [...(this.optionsSeen.get(type) ?? []), options]);
  }

  /** @param {string} type @param {(e: any) => void} fn */
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  /** @param {string} type @param {Record<string, unknown>} [fields] */
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
    for (const fn of [...(this.listeners.get(type) ?? [])]) fn(event);
    return event;
  }
}

class FakeElement extends FakeTarget {
  /** @param {string} tag */
  constructor(tag) {
    super();
    this.tagName = tag.toUpperCase();
    this.className = '';
    this.textContent = '';
    this.title = '';
    this.type = '';
    this.disabled = false;
    /** @type {Record<string, string>} */
    this.style = {};
    /** @type {Record<string, string>} */
    this.dataset = {};
    /** @type {Map<string, string>} */
    this.attributes = new Map();
    /** @type {unknown[]} */
    this.children = [];
    /** @type {FakeElement | null} */
    this.parentNode = null;
    this.removed = false;
    this.classes = new Set();
    this.classList = {
      add: (/** @type {string} */ name) => this.classes.add(name),
      remove: (/** @type {string} */ name) => this.classes.delete(name),
      contains: (/** @type {string} */ name) => this.classes.has(name),
    };
    this.offsetWidth = 80;
    this.offsetHeight = 30;
    this.clientWidth = 1000;
    this.clientHeight = 800;
    /** @type {any} */
    this.shadow = null;
    this.focusCalls = 0;
    /** @type {unknown[]} */
    this.focusArgs = [];
    this.blurCalls = 0;
    /** @type {number[]} */
    this.captured = [];
  }

  /** @param {unknown} [options] */
  focus(options) {
    this.focusCalls += 1;
    this.focusArgs.push(options);
  }

  blur() {
    this.blurCalls += 1;
  }

  /** @param {unknown[]} nodes */
  append(...nodes) {
    for (const node of nodes) {
      if (node instanceof FakeElement) {
        node.parentNode?.children.splice(node.parentNode.children.indexOf(node), 1);
        node.parentNode = this;
      }
      this.children.push(node);
    }
  }

  /** @param {string} name */
  removeAttribute(name) {
    this.attributes.delete(name);
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  attachShadow() {
    this.shadow = new FakeElement('shadow');
    return this.shadow;
  }

  /** @param {number} id */
  setPointerCapture(id) {
    this.captured.push(id);
  }

  remove() {
    this.removed = true;
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
}

/** @param {{ popover?: boolean }} [options] */
function setup(options = {}) {
  void options;
  /** @type {FakeElement[]} */
  const created = [];
  const win = new FakeTarget();
  const documentElement = new FakeElement('html');
  /** @type {unknown[][]} */
  const consoleErrors = [];
  const page = {
    /** @type {FakeElement[]} */
    modals: [],
    /** @type {unknown[] | null} */
    stack: null,
    /** @type {Rect} */
    box: CLICK_BOX,
    /** @type {{ x: number, y: number }[]} */
    hitTests: [],
    /** @type {number[][]} */
    pointsAsked: [],
    /** @type {number[]} */
    frameWaits: [],
    /** @type {Map<number, () => void>} */
    frames: new Map(),
    nextFrameId: 1,
    cancelledFrames: 0,
  };
  /** @type {Record<string, any>} */
  const globals = {
    window: win,
    innerWidth: 1000,
    innerHeight: 800,
    document: {
      documentElement,
      querySelectorAll: (/** @type {string} */ selector) =>
        selector === 'dialog:modal' ? page.modals : [],
      elementsFromPoint: (/** @type {number} */ x, /** @type {number} */ y) => {
        page.pointsAsked.push([x, y]);
        return page.stack ?? [created[0]];
      },
      createElement: (/** @type {string} */ tag) => {
        const el = new FakeElement(tag);
        created.push(el);
        return el;
      },
      createTextNode: (/** @type {string} */ data) => ({ data }),
      createElementNS: (/** @type {string} */ _ns, /** @type {string} */ tag) => {
        const el = new FakeElement(tag);
        created.push(el);
        return el;
      },
    },
    requestAnimationFrame: (/** @type {() => void} */ fn) => {
      const id = page.nextFrameId++;
      page.frames.set(id, fn);
      return id;
    },
    cancelAnimationFrame: (/** @type {number} */ id) => {
      if (page.frames.delete(id)) page.cancelledFrames += 1;
    },
    CSSStyleSheet: class {
      replaceSync() {}
    },
    console: { error: (/** @type {unknown[]} */ ...args) => consoleErrors.push(args) },
    __spool: {
      lib: {
        findScrollTarget: (/** @type {Rect} */ rect) => {
          page.hitTests.push({ x: rect.x, y: rect.y });
          return { kind: 'element', el: {}, box: page.box };
        },
        nextFrames: (/** @type {number} */ n) => {
          page.frameWaits.push(n);
          return Promise.resolve();
        },
      },
    },
  };
  const overlayModule = loadClassic('src/page/overlay.js', globals).__spool?.overlay;
  assert.ok(overlayModule, 'overlay.js must register __spool.overlay');

  /** @type {OverlayCommand[]} */
  const commands = [];
  /** @type {Rect[]} */
  const regions = [];
  const overlay = overlayModule.createOverlay({
    onRegion: (rect) => regions.push({ x: rect.x, y: rect.y, width: rect.width, height: rect.height }),
    onCommand: (cmd) => commands.push(cmd),
  });

  /** @param {string} className */
  const find = (className) => {
    const el = created.find((e) => e.className === className);
    assert.ok(el, `no element with class "${className}"`);
    return el;
  };
  const runFrames = () => {
    const waiting = [...page.frames];
    page.frames.clear();
    for (const [, fn] of waiting) fn();
  };
  return {
    overlay,
    win,
    root: find('root'),
    find,
    findAll: (/** @type {string} */ className) => created.filter((e) => e.className === className),
    runFrames,
    commands,
    regions,
    consoleErrors,
    documentElement,
    page,
    host: /** @type {FakeElement} */ (created[0]),
    /** What the listeners of a type were registered with. @param {FakeTarget} target @param {string} type */
    optionsOf: (target, type) => target.optionsSeen?.get(type) ?? [],
  };
}

/** @param {Record<string, unknown>} [fields] */
function pointer(fields = {}) {
  return { button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, ...fields };
}

/** @param {string} key @param {Record<string, unknown>} [fields] */
function key(key, fields = {}) {
  return {
    key,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    isComposing: false,
    repeat: false,
    ...fields,
  };
}

/** @param {Partial<import('../../types/page-globals.js').OverlayStatus>} [more] */
function status(more = {}) {
  return {
    slices: 1,
    heightPx: 600,
    tiles: 1,
    auto: false,
    level: /** @type {const} */ ('info'),
    message: '',
    progress: 0,
    atEnd: false,
    ...more,
  };
}

/** @param {any} node @returns {string} */
function textOf(node) {
  if (typeof node?.data === 'string') return node.data;
  if (typeof node?.textContent === 'string' && node.textContent !== '') return node.textContent;
  return (node?.children ?? []).map(textOf).join('');
}

/** A selecting overlay. */
function selecting() {
  const t = setup();
  t.overlay.beginSelect();
  return t;
}

/** A session with a status. @param {Partial<import('../../types/page-globals.js').OverlayStatus>} [more] @param {Rect} [rect] */
function session(more = {}, rect = SESSION_RECT) {
  const t = setup();
  t.overlay.beginSelect();
  t.overlay.showSession(rect);
  t.overlay.setStatus(status(more));
  return t;
}

describe('overlay.js: the namespace', () => {
  const MESSAGE = /page-lib\.js must load before overlay\.js/;

  it('stops with a clear message when page-lib.js did not load first', () => {
    assert.throws(() => loadClassic('src/page/overlay.js', { __spool: {} }), MESSAGE);
  });

  it('does not trust a namespace that is not a plain object, and makes its own', () => {
    const clobbered = Object.create({ [Symbol.toStringTag]: 'HTMLFormElement' });
    clobbered.lib = {}; // a library that markup put there
    assert.throws(() => loadClassic('src/page/overlay.js', { __spool: clobbered }), MESSAGE);
  });

  it('makes the namespace an own, hidden, replaceable property when there is none', () => {
    const context = vm.createContext({});
    assert.throws(() => loadClassic('src/page/overlay.js', context));
    const descriptor = Object.getOwnPropertyDescriptor(context, '__spool');
    assert.ok(descriptor, 'an own property of the global');
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
  });
});

describe('overlay.js: the box of a drag', () => {
  it('rounds both corners to the nearest pixel', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: 10.4, clientY: 20.4 }));
    t.root.dispatch('pointermove', pointer({ clientX: 200.6, clientY: 300.6 }));
    t.root.dispatch('pointerup', pointer({ clientX: 200.6, clientY: 300.6 }));
    assert.deepEqual(t.regions, [{ x: 10, y: 20, width: 191, height: 281 }]);
  });

  it('a drag towards the top left gives the same box as one towards the bottom right', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: 300, clientY: 300 }));
    t.root.dispatch('pointermove', pointer({ clientX: 150, clientY: 200 }));
    t.root.dispatch('pointerup', pointer({ clientX: 100, clientY: 150 }));
    assert.deepEqual(t.regions, [{ x: 100, y: 150, width: 200, height: 150 }]);
  });

  it('keeps the box inside the window', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: -50, clientY: -30 }));
    t.root.dispatch('pointermove', pointer({ clientX: 500, clientY: 400 }));
    t.root.dispatch('pointerup', pointer({ clientX: 1200, clientY: 900 }));
    assert.deepEqual(t.regions, [{ x: 0, y: 0, width: 1000, height: 800 }]);
  });

  it('shows the live size of the box, and the label sits above it from 30 px down', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 30 }));
    t.root.dispatch('pointermove', pointer({ clientX: 300, clientY: 230 }));
    const label = t.find('size');
    assert.equal(textOf(label), '200 × 200');
    assert.equal(label.style['top'], '0px', 'y 30: 30 px above it');
    assert.equal(label.style['left'], '100px');
    t.root.dispatch('pointerup', pointer({ clientX: 300, clientY: 230 }));

    const near = selecting();
    near.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 29 }));
    near.root.dispatch('pointermove', pointer({ clientX: 300, clientY: 230 }));
    assert.equal(near.find('size').style['top'], '35px', 'y 29: 6 px below the edge');
  });

  it('keeps the size label inside the right edge of the window', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: 990, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 995, clientY: 300 }));
    assert.equal(t.find('size').style['left'], '916px', '1000 - 80 - 4');
  });
});

describe('overlay.js: which pointer and which button start a drag', () => {
  it('only the primary button of a primary pointer starts a drag, and the root captures it', () => {
    for (const fields of [{ button: 2 }, { button: 1 }, { isPrimary: false }]) {
      const t = selecting();
      t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100, ...fields }));
      t.root.dispatch('pointermove', pointer({ clientX: 300, clientY: 300, ...fields }));
      t.root.dispatch('pointerup', pointer({ clientX: 300, clientY: 300, ...fields }));
      assert.deepEqual(t.regions, [], JSON.stringify(fields));
      assert.deepEqual(t.root.captured, [], JSON.stringify(fields));
    }
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ pointerId: 7, clientX: 100, clientY: 100 }));
    assert.deepEqual(t.root.captured, [7]);
  });

  it('a second pointer does not take over a drag that is under way', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ pointerId: 1, clientX: 100, clientY: 100 }));
    t.root.dispatch('pointerdown', pointer({ pointerId: 2, clientX: 600, clientY: 600 }));
    assert.deepEqual(t.root.captured, [1]);
    t.root.dispatch('pointermove', pointer({ pointerId: 2, clientX: 700, clientY: 700 }));
    assert.equal('drag' in t.root.dataset, false, 'a move of another pointer is no drag');
    t.root.dispatch('pointerup', pointer({ pointerId: 2, clientX: 700, clientY: 700 }));
    assert.deepEqual(t.regions, [], 'the release of another pointer ends nothing');
    t.root.dispatch('pointermove', pointer({ pointerId: 1, clientX: 250, clientY: 250 }));
    t.root.dispatch('pointerup', pointer({ pointerId: 1, clientX: 300, clientY: 300 }));
    assert.deepEqual(t.regions, [{ x: 100, y: 100, width: 200, height: 200 }]);
  });

  it('nothing starts while a selection is waiting for the session', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointerup', pointer({ clientX: 100, clientY: 100 }));
    assert.equal(t.regions.length, 1);
    t.root.dispatch('pointerdown', pointer({ pointerId: 3, clientX: 100, clientY: 100 }));
    assert.deepEqual(t.root.captured, [1], 'locked: no new capture of the pointer');
  });
});

describe('overlay.js: click, drag and too small a drag', () => {
  it('a move under 4 px is still a click; 4 px is a drag', () => {
    const click = selecting();
    click.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    click.root.dispatch('pointermove', pointer({ clientX: 103, clientY: 100 }));
    assert.equal('drag' in click.root.dataset, false);
    click.root.dispatch('pointerup', pointer({ clientX: 103, clientY: 100 }));
    assert.deepEqual(click.regions, [CLICK_BOX]);

    const drag = selecting();
    drag.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    drag.root.dispatch('pointermove', pointer({ clientX: 104, clientY: 100 }));
    assert.equal('drag' in drag.root.dataset, true);
    // Diagonal moves count by distance: 3 and 3 are 4.24 px.
    const diagonal = selecting();
    diagonal.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    diagonal.root.dispatch('pointermove', pointer({ clientX: 103, clientY: 103 }));
    assert.equal('drag' in diagonal.root.dataset, true);
    // And it counts from where the press was, not from the last move.
    const slow = selecting();
    slow.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    slow.root.dispatch('pointermove', pointer({ clientX: 103, clientY: 100 }));
    slow.root.dispatch('pointermove', pointer({ clientX: 106, clientY: 100 }));
    assert.equal('drag' in slow.root.dataset, true);
  });

  it('a box of 24 px both ways is big enough; 23 px in one direction is too small', () => {
    /** @type {[number, number, boolean][]} */
    const cases = [
      [24, 24, true],
      [23, 24, false],
      [24, 23, false],
      [23, 23, false],
      [500, 23, false],
      [23, 500, false],
    ];
    for (const [w, h, big] of cases) {
      const t = selecting();
      t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
      t.root.dispatch('pointermove', pointer({ clientX: 100 + w, clientY: 100 + h }));
      t.root.dispatch('pointerup', pointer({ clientX: 100 + w, clientY: 100 + h }));
      assert.equal(t.regions.length, big ? 1 : 0, `${w} x ${h}`);
      if (!big) {
        const [hintNotice] = t.findAll('notice');
        assert.equal(textOf(hintNotice), 'That box is too small. Drag a larger box.');
      }
    }
  });

  it('a too small box takes the drag frame away, tests the hover again, and ends the drag', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 110, clientY: 110 }));
    assert.equal('drag' in t.root.dataset, true);
    t.root.dispatch('pointerup', pointer({ clientX: 110, clientY: 110 }));
    assert.equal('drag' in t.root.dataset, false, 'the frame is gone');
    assert.equal(t.page.frames.size, 1, 'the hover test is scheduled for the pointer');
    t.root.dispatch('pointermove', pointer({ clientX: 140, clientY: 140 }));
    assert.equal('drag' in t.root.dataset, false, 'the drag is over: a move draws no frame');
  });

  it('a drag takes the hover outline away', () => {
    const t = selecting();
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    t.runFrames();
    assert.equal('hover' in t.root.dataset, true);
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 160, clientY: 160 }));
    assert.equal('hover' in t.root.dataset, false);
    assert.equal('drag' in t.root.dataset, true);
  });

  it('a pointer that is taken away ends the drag and takes the frame away', () => {
    for (const type of ['pointercancel', 'lostpointercapture']) {
      const t = selecting();
      t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
      t.root.dispatch('pointermove', pointer({ clientX: 250, clientY: 250 }));
      assert.equal('drag' in t.root.dataset, true);
      t.root.dispatch(type, pointer());
      assert.equal('drag' in t.root.dataset, false, type);
      t.root.dispatch('pointerup', pointer({ clientX: 300, clientY: 300 }));
      assert.deepEqual(t.regions, [], `${type}: the release finds no drag`);
    }
  });

  it('the pointer leaving the window takes the hover outline away, unless it is locked or dragging', () => {
    const t = selecting();
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    t.runFrames();
    t.root.dispatch('pointerleave', pointer());
    assert.equal('hover' in t.root.dataset, false);

    const locked = selecting();
    locked.root.dispatch('pointerdown', pointer({ clientX: 120, clientY: 130 }));
    locked.root.dispatch('pointerup', pointer({ clientX: 120, clientY: 130 }));
    locked.root.dispatch('pointerleave', pointer());
    assert.equal('hover' in locked.root.dataset, true, 'the picked panel stays outlined');

    const dragging = selecting();
    dragging.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    dragging.runFrames();
    dragging.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    dragging.root.dispatch('pointerleave', pointer());
    assert.equal(dragging.page.cancelledFrames, 0, 'a drag under way keeps its frames');
  });

  it('a pointer that leaves cancels the hover test that waits', () => {
    const t = selecting();
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    assert.equal(t.page.frames.size, 1);
    t.root.dispatch('pointerleave', pointer());
    assert.equal(t.page.cancelledFrames, 1);
    t.runFrames();
    assert.deepEqual(t.page.hitTests, []);
    assert.equal('hover' in t.root.dataset, false);
  });
});

describe('overlay.js: the hover outline', () => {
  it('the same panel again keeps the outline and does not glide', () => {
    const t = selecting();
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    t.runFrames();
    t.root.dispatch('pointermove', pointer({ clientX: 110, clientY: 110 }));
    t.runFrames();
    assert.equal(t.find('frame').classes.has('glide'), false, 'nothing moved');
    for (const change of [{ x: 41 }, { y: 51 }, { width: 301 }, { height: 401 }]) {
      t.page.box = { ...CLICK_BOX, ...change };
      t.root.dispatch('pointermove', pointer({ clientX: 120, clientY: 120 }));
      t.runFrames();
      assert.equal(t.find('frame').classes.has('glide'), true, JSON.stringify(change));
      t.find('frame').classes.delete('glide');
      t.page.box = CLICK_BOX;
      t.root.dispatch('pointermove', pointer({ clientX: 130, clientY: 130 }));
      t.runFrames();
    }
  });

  it('the label sits 28 px above a panel, and inside it from a box that starts above 28 px', () => {
    const outside = selecting();
    outside.page.box = { x: 40, y: 28, width: 300, height: 400 };
    outside.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    outside.runFrames();
    assert.equal('inside' in outside.find('tag').dataset, false);
    assert.equal(outside.find('tag').style['top'], '0px');

    const inside = selecting();
    inside.page.box = { x: 40, y: 27, width: 300, height: 400 };
    inside.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    inside.runFrames();
    assert.equal('inside' in inside.find('tag').dataset, true);
    assert.equal(inside.find('tag').style['top'], '83px', 'y + 56');
    assert.equal(inside.find('tag').style['left'], '52px', 'x + 12');
  });

  it('keeps the label inside the right edge of the window', () => {
    const t = selecting();
    t.page.box = { x: 980, y: 100, width: 200, height: 400 };
    t.root.dispatch('pointermove', pointer({ clientX: 990, clientY: 150 }));
    t.runFrames();
    assert.equal(t.find('tag').style['left'], '916px');
  });
});

describe('overlay.js: the readout rounds like a person would', () => {
  it('rounds the numbers to the nearest whole number, and picks the singular from that', () => {
    const t = session({ slices: 1.4, heightPx: 1234.5, tiles: 0.6 });
    assert.equal(textOf(t.find('counts')), '1 step · 1,235 px · 1 AI screenshot');
    t.overlay.setStatus(status({ slices: 1.6, heightPx: 999.4, tiles: 1.4 }));
    assert.equal(textOf(t.find('counts')), '2 steps · 999 px · 1 AI screenshot');
    t.overlay.setStatus(status({ slices: 0.4, tiles: 1.5 }));
    assert.equal(textOf(t.find('counts')), '0 steps · 600 px · 2 AI screenshots');
    t.overlay.setStatus(status({ atEnd: true, tiles: 0.6 }));
    assert.equal(textOf(t.find('end')), 'End of panel · 1 AI screenshot');
  });
});

describe('overlay.js: keys while the agent is busy', () => {
  it('a key that repeats is claimed from the page but does nothing', () => {
    const t = session();
    const event = t.win.dispatch('keydown', key(' ', { repeat: true }));
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.immediatelyStopped, true);
    assert.deepEqual(t.commands, []);
  });

  it('while busy, Scroll and Auto keys wait, and Done and Cancel still work', () => {
    const t = session();
    t.overlay.setBusy(true);
    for (const name of [' ', 'ArrowDown', 'ArrowUp', 'a']) {
      const event = t.win.dispatch('keydown', key(name));
      assert.equal(event.defaultPrevented, true, `${name} is still claimed`);
    }
    assert.deepEqual(t.commands, []);
    t.win.dispatch('keydown', key('Enter'));
    t.win.dispatch('keydown', key('Escape'));
    assert.deepEqual(t.commands, ['done', 'cancel']);
  });

  it('while Auto runs, even if busy, a key asks it to stop once', () => {
    const t = session({ auto: true });
    t.overlay.setBusy(true);
    t.win.dispatch('keydown', key('a'));
    t.win.dispatch('keydown', key('a')); // a stop is on its way: one is enough
    assert.deepEqual(t.commands, ['auto']);
    t.overlay.setStatus(status({ auto: false }));
    t.overlay.setStatus(status({ auto: true }));
    t.win.dispatch('keydown', key('a'));
    assert.deepEqual(t.commands, ['auto', 'auto'], 'a new run can be stopped again');
  });

  it('while Auto runs and the agent is not busy, Space and the arrow keys stop it', () => {
    for (const name of [' ', 'ArrowDown', 'ArrowUp']) {
      const t = session({ auto: true });
      t.win.dispatch('keydown', key(name));
      assert.deepEqual(t.commands, ['auto'], name);
    }
  });

  it('keys with the shift key, capital A and the arrow keys name their commands', () => {
    const t = session();
    t.win.dispatch('keydown', key('A'));
    t.win.dispatch('keydown', key('ArrowUp'));
    t.win.dispatch('keydown', key('ArrowDown', { shiftKey: true }));
    assert.deepEqual(t.commands, ['auto', 'up', 'down']);
    for (const name of ['q', 'Tab', 'F5', 'Backspace']) {
      assert.equal(t.win.dispatch('keydown', key(name)).defaultPrevented, false, name);
    }
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
      assert.equal(t.win.dispatch('keydown', key('Enter', { [modifier]: true })).defaultPrevented, false, modifier);
    }
  });

  it('a key that is released is claimed only when it was claimed on the way down', () => {
    const t = setup();
    t.overlay.beginSelect(); // selecting: Esc, and Tab and Enter (they choose a panel)
    assert.equal(t.win.dispatch('keyup', key('a')).defaultPrevented, false);
    assert.equal(t.win.dispatch('keyup', key('Escape')).defaultPrevented, true);
    const s = session();
    assert.equal(s.win.dispatch('keyup', key('q')).defaultPrevented, false);
    assert.equal(s.win.dispatch('keyup', key('Enter')).defaultPrevented, true);
  });
});

describe('overlay.js: what beginSelect and showSession reset', () => {
  it('going back to selecting clears the flags and the panel of the session, and unlocks the pointer', () => {
    const t = session({ auto: true, atEnd: true, progress: 1 });
    assert.equal('end' in t.root.dataset, true);
    assert.equal('auto' in t.root.dataset, true);
    assert.equal(t.root.dataset['mode'], 'session');
    t.overlay.beginSelect();
    assert.equal('end' in t.root.dataset, false);
    assert.equal('auto' in t.root.dataset, false);
    assert.equal(t.root.dataset['mode'], 'select');
    // The pointer works again, and the layout of the session no longer follows a resize.
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointerup', pointer({ clientX: 100, clientY: 100 }));
    assert.deepEqual(t.regions, [CLICK_BOX]);
    const left = t.find('hud').style['left'];
    t.find('hud').offsetWidth = 300;
    t.win.dispatch('resize');
    assert.equal(t.find('hud').style['left'], left);
  });

  it('beginSelect drops a drag and the hover outline that were under way', () => {
    const t = selecting();
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    t.runFrames();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 250, clientY: 250 }));
    t.overlay.beginSelect();
    assert.equal('drag' in t.root.dataset, false);
    assert.equal('hover' in t.root.dataset, false);
    t.root.dispatch('pointerup', pointer({ clientX: 300, clientY: 300 }));
    assert.deepEqual(t.regions, [], 'the old drag is gone');
  });

  it('showSession unlocks the pointer handling of a pick, outlines the session and hides the drag frame', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 250, clientY: 250 }));
    t.root.dispatch('pointerup', pointer({ clientX: 300, clientY: 300 }));
    assert.equal('drag' in t.root.dataset, true, 'the pick keeps the frame until the session shows');
    t.overlay.showSession(SESSION_RECT);
    assert.equal('drag' in t.root.dataset, false);
    assert.equal(t.root.dataset['mode'], 'session');
    const frame = t.find('frame');
    assert.deepEqual(
      [frame.style['left'], frame.style['top'], frame.style['width'], frame.style['height']],
      ['100px', '100px', '400px', '400px'],
    );
    assert.equal(frame.classes.has('glide'), false);
    assert.equal(t.find('down').disabled, false);
  });

  it('showSession lays the HUD and the thread out at once', () => {
    const t = setup();
    t.overlay.showSession(SESSION_RECT);
    assert.equal(t.find('hud').style['top'], '512px');
    assert.equal(t.find('thread').style['left'], '506px');
  });
});

describe('overlay.js: a destroyed overlay ignores everything', () => {
  it('beginSelect, showSession, setStatus, setBusy and the capture calls do nothing', async () => {
    const t = session();
    t.overlay.destroy();
    const mode = t.root.dataset['mode'];
    t.overlay.beginSelect();
    assert.equal(t.root.dataset['mode'], mode);
    t.overlay.showSession({ x: 0, y: 0, width: 50, height: 50 });
    assert.equal(t.find('frame').style['left'], '100px');
    t.overlay.setStatus(status({ slices: 9, auto: true, atEnd: true, message: 'late', level: 'error' }));
    assert.equal(textOf(t.find('counts')).startsWith('1 step'), true);
    assert.equal('auto' in t.root.dataset, false);
    t.overlay.setBusy(true);
    assert.equal(t.find('down').disabled, false);
    await t.overlay.hideForCapture();
    assert.equal(t.root.classList.contains('hidden'), false);
    assert.deepEqual(t.page.frameWaits, []);
    t.overlay.showAfterCapture();
    t.overlay.keepOnTop();
    assert.deepEqual(t.page.pointsAsked, []);
    assert.deepEqual(t.commands, []);
  });

  it('keys and clicks no longer drive it', () => {
    const t = session();
    t.overlay.destroy();
    const event = t.win.dispatch('keydown', key('Enter'));
    assert.equal(event.defaultPrevented, false);
    t.find('done').dispatch('click');
    assert.deepEqual(t.commands, []);
  });

  it('hiding for a capture waits two animation frames', async () => {
    const t = session();
    await t.overlay.hideForCapture();
    assert.deepEqual(t.page.frameWaits, [2]);
    assert.equal(t.root.classList.contains('hidden'), true);
  });

  it('checks the top layer at the middle of the window', () => {
    const t = session();
    t.page.stack = [t.host];
    t.overlay.keepOnTop();
    assert.deepEqual(t.page.pointsAsked, []);
    Object.assign(t.host, { hidePopover: () => {}, showPopover: () => {} });
    t.overlay.keepOnTop();
    assert.deepEqual(t.page.pointsAsked, [[500, 400]]);
  });
});

describe('overlay.js: the layout follows the window', () => {
  it('a resize lays the HUD and the thread out again', () => {
    const t = session();
    assert.equal(t.find('hud').style['left'], '260px');
    t.find('hud').offsetWidth = 200;
    t.root.clientWidth = 519; // 1 px too narrow for the thread outside the selection
    t.win.dispatch('resize');
    assert.equal(t.find('hud').style['left'], '200px', 'centred: 100 + 200 - 100');
    assert.equal(t.find('thread').style['left'], '491px', 'inside: 100 + 400 - 6 - 3');
    t.root.clientWidth = 520; // exactly enough
    t.win.dispatch('resize');
    assert.equal(t.find('thread').style['left'], '506px');
  });

  it('keeps the HUD below the selection down to the last pixel of room', () => {
    // viewH 800, HUD 30 px high, 8 px edge: the HUD may start at 762.
    const below = session({}, { x: 100, y: 350, width: 400, height: 400 });
    assert.equal(below.find('hud').style['top'], '762px');
    const above = session({}, { x: 100, y: 351, width: 400, height: 400 });
    assert.equal(above.find('hud').style['top'], '309px', 'one pixel more: above, 12 px gap');
  });

  it('goes above the selection only when that fits in 8 px from the window top', () => {
    const fits = session({}, { x: 100, y: 50, width: 400, height: 740 });
    assert.equal(fits.find('hud').style['top'], '8px');
    const tight = session({}, { x: 100, y: 49, width: 400, height: 741 });
    assert.equal(tight.find('hud').style['top'], '748px', 'inside at the bottom');
  });

  it('puts the message under the HUD while there is room for it, and above it after that', () => {
    const below = session({}, { x: 100, y: 312, width: 400, height: 400 }); // HUD at 724
    assert.equal(below.find('hud').style['top'], '724px');
    assert.equal(below.find('hud').dataset['notice'], 'below');
    const above = session({}, { x: 100, y: 313, width: 400, height: 400 }); // HUD at 725
    assert.equal(above.find('hud').dataset['notice'], 'above');
  });

  it('counts a message of unknown height as 32 px', () => {
    const [, hudNotice] = (() => {
      const t = session({}, { x: 100, y: 310, width: 400, height: 400 });
      return [t, t.findAll('notice')[1]];
    })();
    assert.ok(hudNotice);
    // HUD at 722: 722 + 30 + 8 + 32 + 8 = 800 fits; at 723 it does not.
    const fits = setup();
    fits.overlay.beginSelect();
    fits.findAll('notice')[1].offsetHeight = 0;
    fits.overlay.showSession({ x: 100, y: 310, width: 400, height: 400 });
    assert.equal(fits.find('hud').style['top'], '722px');
    assert.equal(fits.find('hud').dataset['notice'], 'below');
    const over = setup();
    over.overlay.beginSelect();
    over.findAll('notice')[1].offsetHeight = 0;
    over.overlay.showSession({ x: 100, y: 311, width: 400, height: 400 });
    assert.equal(over.find('hud').dataset['notice'], 'above');
  });

  it('rounds the fill of the thread to a whole pixel', () => {
    const t = session({ progress: 1 / 3 });
    assert.equal(t.find('fill').style['height'], '133px');
    const u = session({ progress: 0.3374 });
    assert.equal(u.find('fill').style['height'], '135px', '134.96 rounds up');
  });
});

describe('overlay.js: rounding of the drag box, the other way', () => {
  it('rounds .6 up at the start and .4 down at the end of each axis', () => {
    const t = selecting();
    t.root.dispatch('pointerdown', pointer({ clientX: 10.6, clientY: 20.6 }));
    t.root.dispatch('pointermove', pointer({ clientX: 200.4, clientY: 300.4 }));
    t.root.dispatch('pointerup', pointer({ clientX: 200.4, clientY: 300.4 }));
    assert.deepEqual(t.regions, [{ x: 11, y: 21, width: 189, height: 279 }]);
  });
});

describe('overlay.js: the HUD position is a whole pixel inside the window', () => {
  it('rounds the top to the nearest pixel', () => {
    const down = session({}, { x: 100, y: 100, width: 400, height: 400.4 });
    assert.equal(down.find('hud').style['top'], '512px');
    const up = session({}, { x: 100, y: 100, width: 400, height: 400.6 });
    assert.equal(up.find('hud').style['top'], '513px');
  });

  it('keeps the HUD 8 px above the bottom of the window when the selection runs past it', () => {
    const t = session({}, { x: 100, y: 10, width: 400, height: 800 });
    assert.equal(t.find('hud').style['top'], '762px', '800 - 30 - 8');
  });
});

describe('overlay.js: Done keeps the focus only as long as the session is at its end', () => {
  it('Done gets the focus without scrolling the page', () => {
    const t = session({ progress: 1, atEnd: true });
    assert.deepEqual({ ...(/** @type {object} */ (t.find('done').focusArgs.at(-1))) }, { preventScroll: true });
  });

  it('going back to selecting lets go of the end: no later blur of Done', () => {
    const t = session({ progress: 1, atEnd: true });
    t.overlay.beginSelect();
    t.overlay.setStatus(status({ message: 'Select an area inside the page.', level: 'error' }));
    assert.equal(t.find('done').blurCalls, 0);
  });

  it('a stop that is on its way stays asked while Auto keeps reporting', () => {
    const t = session({ auto: true });
    t.win.dispatch('keydown', key('a'));
    t.overlay.setStatus(status({ auto: true, slices: 2 })); // the next frame: still running
    t.win.dispatch('keydown', key('a'));
    assert.deepEqual(t.commands, ['auto'], 'one stop is enough until Auto has stopped');
  });
});

describe('overlay.js: what a hidden, destroyed overlay does', () => {
  it('stays hidden for a capture when it was destroyed meanwhile', async () => {
    const t = session();
    await t.overlay.hideForCapture();
    t.overlay.destroy();
    t.overlay.showAfterCapture();
    assert.equal(t.root.classList.contains('hidden'), true, 'nothing of a destroyed overlay changes');
  });
});

describe('overlay.js: how the listeners are registered', () => {
  it('keys are heard before the page does, the wheel can be cancelled, and scrolling is only watched', () => {
    const t = setup();
    assert.deepEqual(t.optionsOf(t.win, 'keydown'), [true]);
    assert.deepEqual(t.optionsOf(t.win, 'keyup'), [true]);
    assert.deepEqual(t.optionsOf(t.root, 'wheel').map((o) => ({ ...(/** @type {object} */ (o)) })), [{ passive: false }]);
    assert.deepEqual(t.optionsOf(t.win, 'scroll').map((o) => ({ ...(/** @type {object} */ (o)) })), [
      { capture: true, passive: true },
    ]);
  });
});
