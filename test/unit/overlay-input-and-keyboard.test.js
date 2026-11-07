// @ts-check
/**
 * Tests for the overlay:
 *   - input stays safe while the overlay is hidden for a capture (a transparent layer),
 *   - selecting from the keyboard (Tab, Shift+Tab, Enter) and the announcement,
 *   - the Done button says "Finishing…" (the overlay side),
 *   - "Nothing more below" describes the Scroll button only at the end of the panel,
 *   - the hover label does not sit under the hint pill,
 *   - the names of the HUD buttons,
 * and the focus rules that go with them. It also tests `listScrollTargets` of page-lib.js.
 *
 * Like test/unit/overlay.test.js, the script is loaded into a node:vm context whose globals are a
 * small fake DOM. The real look, the real hit test and real pointer input are covered by
 * e2e/overlay-input.spec.js.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadClassic } from '../helpers/load-classic.js';

/** @typedef {import('../../src/shared/types.js').Rect} Rect */
/** @typedef {import('../../types/page-globals.js').OverlayCommand} OverlayCommand */
/** @typedef {import('../../types/page-globals.js').PageLib} PageLib */

const CLICK_BOX = Object.freeze({ x: 40, y: 50, width: 300, height: 400 });
const SESSION_RECT = Object.freeze({ x: 100, y: 100, width: 400, height: 400 });
const PANEL_A = Object.freeze({ el: { id: 'A' }, kind: 'element', box: { x: 40, y: 80, width: 360, height: 560 } });
const PANEL_B = Object.freeze({ el: { id: 'B' }, kind: 'element', box: { x: 440, y: 80, width: 520, height: 560 } });
const HINT_PILL = Object.freeze({ left: 460, right: 540, top: 12, bottom: 48 });

// ---------------------------------------------------------------------------------------------
// Fakes (a trimmed copy of the ones in overlay.test.js, with the focus and the layout the fixes use)
// ---------------------------------------------------------------------------------------------

class FakeTarget {
  constructor() {
    /** @type {Map<string, Set<(e: any) => void>>} */
    this.listeners = new Map();
  }

  /** @param {string} type @param {(e: any) => void} fn */
  addEventListener(type, fn) {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }

  /** @param {string} type @param {(e: any) => void} fn */
  removeEventListener(type, fn) {
    this.listeners.get(type)?.delete(fn);
  }

  /**
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
    this.id = '';
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
    /** @type {any[]} */
    this.focusArgs = [];
    this.blurCalls = 0;
    this.removed = false;
  }

  /** @param {unknown} [options] */
  focus(options) {
    this.focusArgs.push(options);
  }

  blur() {
    this.blurCalls += 1;
  }

  get focusCalls() {
    return this.focusArgs.length;
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

  setPointerCapture() {}

  remove() {
    this.removed = true;
    this.parentNode?.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
}

/**
 * A page with the fakes the overlay needs, the overlay loaded, and a record of what it did.
 * @param {{ withList?: boolean, active?: unknown, panels?: unknown[] }} [options]
 *   `withList: false` leaves `listScrollTargets` out of the fake lib (an older page-lib).
 *   `active`: what `document.activeElement` is when the overlay opens.
 */
function setup({ withList = true, active = null, panels = [PANEL_A, PANEL_B] } = {}) {
  /** @type {FakeElement[]} */
  const created = [];
  const win = new FakeTarget();
  const documentElement = new FakeElement('html');
  const body = new FakeElement('body');
  /** @type {string[]} */
  const sheets = [];
  const page = {
    /** What `document.activeElement` reports. @type {unknown} */
    active,
    body,
    /** The panels `lib.listScrollTargets` reports. @type {any[]} */
    panels,
    /** What `lib.findScrollTarget` reports. @type {{ el: unknown, box: Rect }} */
    hit: { el: { id: 'under the pointer' }, box: CLICK_BOX },
    /** @type {{ x: number, y: number }[]} */
    hitTests: [],
    /** @type {Map<number, () => void>} */
    frames: new Map(),
    nextFrameId: 1,
  };
  /** @type {Record<string, any>} */
  const lib = {
    findScrollTarget: (/** @type {Rect} */ rect) => {
      page.hitTests.push({ x: rect.x, y: rect.y });
      return { kind: 'element', el: page.hit.el, box: page.hit.box };
    },
    nextFrames: () => Promise.resolve(),
  };
  if (withList) lib['listScrollTargets'] = () => page.panels;
  /** @type {Record<string, any>} */
  const globals = {
    window: win,
    innerWidth: 1000,
    innerHeight: 800,
    document: {
      documentElement,
      body,
      get activeElement() {
        return page.active;
      },
      querySelectorAll: () => [],
      elementsFromPoint: () => [created[0]],
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
    cancelAnimationFrame: (/** @type {number} */ id) => page.frames.delete(id),
    CSSStyleSheet: class {
      /** @param {string} css */
      replaceSync(css) {
        sheets.push(css);
      }
    },
    console: { error: () => {} },
    __spool: { lib },
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
  return {
    overlay,
    win,
    find,
    root: find('root'),
    host: /** @type {FakeElement} */ (created[0]),
    shadow: /** @type {FakeElement} */ (created[0]).shadow,
    commands,
    regions,
    page,
    css: sheets.join('\n'),
    runFrames() {
      const waiting = [...page.frames];
      page.frames.clear();
      for (const [, fn] of waiting) fn();
    },
  };
}

/** @param {Record<string, unknown>} [fields] */
function pointer(fields = {}) {
  return { button: 0, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, ...fields };
}

/** @param {string} name @param {Record<string, unknown>} [fields] */
function key(name, fields = {}) {
  return {
    key: name,
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

/**
 * Gives a HUD element a box. The fake DOM has no layout, so the tests lay the HUD out by hand.
 * @param {FakeElement} el
 * @param {number} left
 * @param {number} top
 * @param {number} width
 * @param {number} height
 */
function place(el, left, top, width, height) {
  Object.assign(el, {
    getBoundingClientRect: () => ({ left, top, right: left + width, bottom: top + height, width, height }),
  });
}

/** The HUD at the bottom: Scroll, Up, Auto, Done, Cancel side by side, 40 px high. */
const HUD_BOXES = Object.freeze({
  hud: [100, 520, 520, 48],
  down: [104, 524, 100, 40],
  up: [208, 524, 40, 40],
  auto: [252, 524, 90, 40],
  done: [460, 524, 90, 40],
  cancel: [554, 524, 60, 40],
});

/**
 * A session with a laid-out HUD.
 * @param {Partial<import('../../types/page-globals.js').OverlayStatus>} [more]
 */
function session(more = {}) {
  const t = setup();
  t.overlay.beginSelect();
  t.overlay.showSession(SESSION_RECT);
  t.overlay.setStatus(status(more));
  for (const [name, box] of Object.entries(HUD_BOXES)) {
    place(t.find(name), box[0] ?? 0, box[1] ?? 0, box[2] ?? 0, box[3] ?? 0);
  }
  return t;
}

/** The centre of a HUD box. @param {keyof typeof HUD_BOXES} name */
function centreOf(name) {
  const [left = 0, top = 0, width = 0, height = 0] = HUD_BOXES[name];
  return { clientX: left + width / 2, clientY: top + height / 2 };
}

/**
 * A press and release at a place. The fake DOM does not bubble, so the event is sent to the root
 * with the target that the browser would report: the layer (or the button).
 * @param {ReturnType<typeof setup>} t
 * @param {{ clientX: number, clientY: number }} at
 * @param {FakeElement} [target]
 */
function click(t, at, target = t.find('shield')) {
  t.root.dispatch('pointerdown', pointer({ ...at, target }));
  t.root.dispatch('pointerup', pointer({ ...at, target }));
  return t.root.dispatch('click', { ...at, target });
}

// ---------------------------------------------------------------------------------------------
// Input while the overlay is hidden for a capture
// ---------------------------------------------------------------------------------------------

describe('overlay: a click or the wheel while hidden for a capture', () => {
  it('has a layer that paints nothing and takes input only while hidden', () => {
    const t = setup();
    const shield = t.find('shield');
    assert.equal(shield.attributes.get('aria-hidden'), 'true');
    assert.equal(/** @type {FakeElement} */ (t.root.children.at(-1)), shield, 'on top of the rest');
    const rule = (/** @type {string} */ selector) => {
      const found = new RegExp(`${selector.replace(/[.\\[\]]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(t.css);
      assert.ok(found, `no rule for ${selector}`);
      return found[1] ?? '';
    };
    const base = rule('.shield');
    assert.match(base, /background:\s*transparent/);
    assert.match(base, /visibility:\s*hidden/, 'out of the way while the overlay shows');
    assert.doesNotMatch(base, /border|box-shadow|outline|filter|backdrop/, 'nothing that paints');
    assert.match(rule('.root.hidden .shield'), /visibility:\s*visible/);
    // Everything else is still hidden by the same class (the capture holds no overlay pixel).
    assert.match(rule('.root.hidden'), /visibility:\s*hidden\s*!important/);
  });

  it('a click on Stop while hidden stops Auto, once', async () => {
    const t = session({ auto: true });
    await t.overlay.hideForCapture();
    click(t, centreOf('auto'));
    assert.deepEqual(t.commands, ['auto']);
  });

  it('a click on the Scroll and Up buttons while hidden also stops Auto', async () => {
    for (const name of /** @type {const} */ (['down', 'up'])) {
      const t = session({ auto: true });
      await t.overlay.hideForCapture();
      click(t, centreOf(name));
      assert.deepEqual(t.commands, ['auto'], name);
    }
  });

  it('a click on Done or Cancel while hidden is honoured', async () => {
    for (const name of /** @type {const} */ (['done', 'cancel'])) {
      for (const auto of [false, true]) {
        const t = session({ auto });
        t.overlay.setBusy(!auto);
        await t.overlay.hideForCapture();
        click(t, centreOf(name));
        // While Auto runs the press on the layer stops it first: Done and Cancel still come.
        assert.deepEqual(t.commands.slice(-1), [name], `${name} (auto: ${auto})`);
      }
    }
  });

  it('a click on a button that is off (a step is under way) does nothing', async () => {
    const t = session();
    t.overlay.setBusy(true);
    await t.overlay.hideForCapture();
    click(t, centreOf('down'));
    click(t, centreOf('up'));
    assert.deepEqual(t.commands, []);
  });

  it('a click on the panel stops Auto; a click between the HUD buttons does not', async () => {
    const t = session({ auto: true });
    await t.overlay.hideForCapture();
    click(t, { clientX: 112, clientY: 566 }); // inside the HUD box, on no button
    assert.deepEqual(t.commands, []);
    click(t, { clientX: 300, clientY: 300 }); // on the panel
    assert.deepEqual(t.commands, ['auto']);
  });

  it('the wheel on the layer is kept from the page and stops Auto', async () => {
    const t = session({ auto: true });
    await t.overlay.hideForCapture();
    const wheel = t.root.dispatch('wheel', { deltaY: 120, target: t.find('shield') });
    assert.equal(wheel.defaultPrevented, true, 'the page does not scroll');
    assert.deepEqual(t.commands, ['auto']);
    const idle = session();
    await idle.overlay.hideForCapture();
    assert.equal(idle.root.dispatch('wheel', { deltaY: 120 }).defaultPrevented, true);
    assert.deepEqual(idle.commands, []);
  });

  it('a press that began on the layer counts where it began, after the overlay shows again', async () => {
    const t = session();
    t.overlay.setBusy(true);
    await t.overlay.hideForCapture();
    t.root.dispatch('pointerdown', pointer({ ...centreOf('cancel'), target: t.find('shield') }));
    t.overlay.showAfterCapture();
    // The release is on the Cancel button now: the browser sends the click to their common parent.
    t.root.dispatch('click', { ...centreOf('cancel'), target: t.root });
    assert.deepEqual(t.commands, ['cancel']);
    // The next click on the root that the overlay did not hide for is not a press on the HUD.
    t.root.dispatch('click', { ...centreOf('done'), target: t.root });
    assert.deepEqual(t.commands, ['cancel']);
  });

  it('a click that the HUD took itself is not taken a second time', () => {
    const t = session();
    t.find('done').dispatch('click', { ...centreOf('done') });
    assert.deepEqual(t.commands, ['done']);
  });

  it('ignores a press that a page script made, and does nothing before the session', async () => {
    const t = session({ auto: true });
    await t.overlay.hideForCapture();
    const shield = t.find('shield');
    t.root.dispatch('pointerdown', pointer({ ...centreOf('auto'), isTrusted: false, target: shield }));
    t.root.dispatch('click', { ...centreOf('auto'), isTrusted: false, target: shield });
    assert.deepEqual(t.commands, []);

    const selecting = setup();
    selecting.overlay.beginSelect();
    click(selecting, { clientX: 10, clientY: 10 });
    assert.deepEqual(selecting.commands, []);
  });

  it('the page does not see a press on the layer', () => {
    const t = session();
    for (const type of ['pointerdown', 'mousedown', 'click', 'wheel']) {
      assert.equal(t.host.dispatch(type).propagationStopped, true, type);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Select mode from the keyboard
// ---------------------------------------------------------------------------------------------

describe('overlay: select mode works from the keyboard', () => {
  it('is a modal dialog with the focus, and a live region that says what the keys do', () => {
    const t = setup();
    t.overlay.beginSelect();
    assert.equal(t.root.attributes.get('role'), 'dialog');
    assert.equal(t.root.attributes.get('aria-modal'), 'true');
    assert.equal(t.root.attributes.get('aria-label'), 'Spool: choose what to capture');
    assert.equal(t.root.attributes.get('tabindex'), '-1');
    assert.ok(t.root.focusCalls >= 1, 'the focus starts in the overlay');
    assert.deepEqual({ ...t.root.focusArgs.at(-1) }, { preventScroll: true });
    const live = t.find('sr');
    assert.equal(live.attributes.get('aria-live'), 'polite');
    assert.equal(live.attributes.get('role'), 'status');
    assert.equal(t.root.attributes.get('aria-describedby'), live.id);
    const said = textOf(live);
    for (const word of ['Tab', 'Enter', 'Escape', 'click', 'drag']) assert.ok(said.includes(word), word);
  });

  it('keeps the page from the keys, and the session takes over the announcement', () => {
    const t = setup();
    t.overlay.beginSelect();
    for (const name of ['Tab', 'Enter']) {
      const down = t.win.dispatch('keydown', key(name));
      const up = t.win.dispatch('keyup', key(name));
      assert.equal(down.defaultPrevented && down.immediatelyStopped, true, `${name} down`);
      assert.equal(up.defaultPrevented && up.immediatelyStopped, true, `${name} up`);
    }
    t.overlay.showSession(SESSION_RECT);
    assert.equal(textOf(t.find('sr')), '', 'the hint is gone when the session starts');
    assert.equal(t.root.attributes.get('aria-label'), 'Spool: scrolling capture');
    const tab = t.win.dispatch('keydown', key('Tab'));
    assert.equal(tab.defaultPrevented, false, 'in the session Tab walks the HUD buttons');
  });

  it('Tab highlights the first panel like a hover, and announces it', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Tab'));
    const frame = t.find('frame');
    assert.deepEqual(
      [frame.style['left'], frame.style['top'], frame.style['width'], frame.style['height']],
      ['40px', '80px', '360px', '560px'],
    );
    assert.equal('hover' in t.root.dataset, true);
    assert.equal(textOf(t.find('tag')), 'Press Enter to spool this panel');
    assert.equal(
      textOf(t.find('sr')),
      'Scroll panel 1 of 2, 360 by 560 pixels. Press Enter to select it, or Tab for the next one.',
    );
    assert.deepEqual(t.regions, [], 'Tab only highlights');
  });

  it('Tab and Shift+Tab go round the panels', () => {
    const t = setup();
    t.overlay.beginSelect();
    const left = () => t.find('frame').style['left'];
    t.win.dispatch('keydown', key('Tab'));
    assert.equal(left(), '40px');
    t.win.dispatch('keydown', key('Tab'));
    assert.equal(left(), '440px');
    t.win.dispatch('keydown', key('Tab'));
    assert.equal(left(), '40px', 'after the last panel the first');
    t.win.dispatch('keydown', key('Tab', { shiftKey: true }));
    assert.equal(left(), '440px', 'Shift+Tab from the first goes to the last');
    t.win.dispatch('keydown', key('Tab', { shiftKey: true }));
    assert.equal(left(), '40px');
    assert.match(textOf(t.find('sr')), /^Scroll panel 1 of 2/);
  });

  it('the first Shift+Tab goes to the last panel', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Tab', { shiftKey: true }));
    assert.equal(t.find('frame').style['left'], '440px');
    assert.match(textOf(t.find('sr')), /^Scroll panel 2 of 2, 520 by 560 pixels/);
  });

  it('names the page, and says nothing about "next" when there is one panel only', () => {
    const t = setup({ panels: [{ el: {}, kind: 'document', box: { x: 0, y: 0, width: 1000, height: 800 } }] });
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Tab'));
    assert.equal(textOf(t.find('sr')), 'Whole page, 1,000 by 800 pixels. Press Enter to select it.');
    t.win.dispatch('keydown', key('Tab'));
    assert.equal(t.find('frame').style['left'], '0px', 'a ring of one');
  });

  it('Enter selects the highlighted panel, once', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Tab'));
    t.win.dispatch('keydown', key('Tab'));
    t.win.dispatch('keydown', key('Enter'));
    assert.deepEqual(t.regions, [PANEL_B.box]);
    t.win.dispatch('keydown', key('Enter'));
    t.win.dispatch('keydown', key('Tab'));
    assert.equal(t.regions.length, 1, 'the pick is final until the session shows');
    assert.equal(t.find('frame').style['left'], '440px', 'and Tab does not move the outline');
  });

  it('a held Enter selects once, and a held Tab keeps moving', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Tab'));
    t.win.dispatch('keydown', key('Tab', { repeat: true }));
    assert.equal(t.find('frame').style['left'], '440px');
    t.win.dispatch('keydown', key('Enter', { repeat: true }));
    assert.deepEqual(t.regions, [], 'a repeat of Enter is not a press');
    t.win.dispatch('keydown', key('Enter'));
    assert.equal(t.regions.length, 1);
  });

  it('Enter with no highlight selects the main panel, at the middle of the window', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Enter'));
    assert.deepEqual(t.regions, [CLICK_BOX]);
    assert.deepEqual(t.page.hitTests, [{ x: 500, y: 400 }]);
  });

  it('Esc cancels, and the keys of a page script do nothing', () => {
    const t = setup();
    t.overlay.beginSelect();
    for (const name of ['Tab', 'Enter']) {
      const fake = t.win.dispatch('keydown', key(name, { isTrusted: false }));
      assert.equal(fake.defaultPrevented, false, `a fake ${name} is left to the page`);
    }
    assert.equal(t.find('frame').style['left'], undefined);
    assert.deepEqual(t.regions, []);
    t.win.dispatch('keydown', key('Tab'));
    t.win.dispatch('keydown', key('Escape'));
    assert.deepEqual(t.commands, ['cancel']);
  });

  it('leaves Ctrl+Tab, Alt+Tab and Ctrl+Enter to the browser', () => {
    const t = setup();
    t.overlay.beginSelect();
    for (const [name, modifier] of /** @type {const} */ ([
      ['Tab', 'ctrlKey'],
      ['Tab', 'altKey'],
      ['Tab', 'metaKey'],
      ['Enter', 'ctrlKey'],
    ])) {
      const event = t.win.dispatch('keydown', key(name, { [modifier]: true }));
      assert.equal(event.defaultPrevented, false, `${modifier}+${name}`);
    }
    assert.equal('hover' in t.root.dataset, false);
  });

  it('Tab goes on from the panel that the pointer is over', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.page.hit = { el: PANEL_A.el, box: PANEL_A.box };
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    t.runFrames();
    assert.equal(t.find('frame').style['left'], '40px');
    assert.equal(textOf(t.find('tag')), 'Click to spool this panel');
    t.win.dispatch('keydown', key('Tab'));
    assert.equal(t.find('frame').style['left'], '440px', 'the next one, not the first');
    assert.equal(textOf(t.find('tag')), 'Press Enter to spool this panel');
  });

  it('Enter selects the panel that the pointer is over', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.page.hit = { el: PANEL_B.el, box: PANEL_B.box };
    t.root.dispatch('pointermove', pointer({ clientX: 600, clientY: 300 }));
    t.runFrames();
    t.win.dispatch('keydown', key('Enter'));
    assert.deepEqual(t.regions, [PANEL_B.box]);
  });

  it('the pointer takes the highlight back, and a hover test on its way does not undo the key', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.page.hit = { el: PANEL_B.el, box: PANEL_B.box };
    t.root.dispatch('pointermove', pointer({ clientX: 600, clientY: 300 })); // a test is waiting
    t.win.dispatch('keydown', key('Tab')); // panel A
    t.runFrames();
    assert.equal(t.find('frame').style['left'], '40px', 'the waiting hover test was dropped');
    t.root.dispatch('pointermove', pointer({ clientX: 600, clientY: 300 }));
    t.runFrames();
    assert.equal(t.find('frame').style['left'], '440px', 'a new pointer move wins');
  });

  it('takes the box of the panel as it is when Enter comes (the page moved)', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Tab'));
    t.page.panels = [{ ...PANEL_A, box: { x: 40, y: 60, width: 360, height: 580 } }, PANEL_B];
    t.win.dispatch('keydown', key('Enter'));
    assert.deepEqual(t.regions, [{ x: 40, y: 60, width: 360, height: 580 }]);
  });

  it('with an older page-lib the list is the main panel', () => {
    const t = setup({ withList: false });
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Tab'));
    assert.equal(t.find('frame').style['left'], '40px');
    assert.deepEqual(t.page.hitTests, [{ x: 500, y: 400 }]);
  });

  it('an empty list does nothing, and a failing page does not throw', () => {
    const t = setup({ panels: [] });
    t.overlay.beginSelect();
    assert.doesNotThrow(() => t.win.dispatch('keydown', key('Tab')));
    assert.equal('hover' in t.root.dataset, false);
  });

  it('after an error the selection starts again with the hint and the focus', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Tab'));
    t.win.dispatch('keydown', key('Enter'));
    const focusBefore = t.root.focusCalls;
    t.overlay.beginSelect(); // the agent rejected the area
    assert.ok(t.root.focusCalls > focusBefore);
    assert.match(textOf(t.find('sr')), /^Choose what to capture/);
    t.win.dispatch('keydown', key('Tab'));
    t.win.dispatch('keydown', key('Enter'));
    assert.equal(t.regions.length, 2, 'the keys work again');
  });
});

describe('overlay: the overlay layer holds the focus in the session', () => {
  it('with the layer focused, Enter and Space are Done and Scroll', () => {
    const t = session();
    t.shadow.activeElement = t.root;
    const enter = t.win.dispatch('keydown', key('Enter', { target: t.host }));
    const space = t.win.dispatch('keydown', key(' ', { target: t.host }));
    assert.deepEqual(t.commands, ['done', 'down']);
    assert.equal(enter.defaultPrevented && space.defaultPrevented, true);
  });

  it('with a HUD button focused, Enter and Space press that button', () => {
    const t = session();
    t.shadow.activeElement = t.find('auto');
    const enter = t.win.dispatch('keydown', key('Enter', { target: t.host }));
    assert.equal(enter.defaultPrevented, false);
    assert.deepEqual(t.commands, []);
  });
});

// ---------------------------------------------------------------------------------------------
// Focus: where it goes and where it comes back to
// ---------------------------------------------------------------------------------------------

describe('overlay: focus', () => {
  /** An element of the page that records focus() calls. @param {Record<string, unknown>} [more] */
  function editor(more = {}) {
    /** @type {unknown[]} */
    const calls = [];
    return { isConnected: true, calls, focus: (/** @type {unknown} */ options) => calls.push(options), ...more };
  }

  it('gives the focus back to the element that had it, when the overlay closes', () => {
    const input = editor();
    const t = setup({ active: input });
    t.overlay.beginSelect();
    t.page.active = t.host; // the overlay holds it
    t.page.active = t.page.body; // the host is gone: the focus fell back to the page
    t.overlay.destroy();
    assert.deepEqual(input.calls.map((o) => ({ .../** @type {any} */ (o) })), [{ preventScroll: true }]);
    t.overlay.destroy();
    assert.equal(input.calls.length, 1, 'destroy is idempotent');
  });

  it('does not take the focus back from the user, nor from an element that left the page', () => {
    const moved = editor();
    const a = setup({ active: moved });
    a.page.active = editor(); // something else has it now
    a.overlay.destroy();
    assert.deepEqual(moved.calls, []);

    const gone = editor({ isConnected: false });
    const b = setup({ active: gone });
    b.page.active = b.page.body;
    b.overlay.destroy();
    assert.deepEqual(gone.calls, []);
  });

  it('does not remember the page itself or the overlay as the place to go back to', () => {
    const t = setup();
    assert.doesNotThrow(() => t.overlay.destroy());
    const body = setup();
    body.page.active = body.page.body;
    assert.doesNotThrow(() => body.overlay.destroy());
  });

  it('puts the focus back on the HUD button that had it, after a capture', async () => {
    const t = session();
    t.shadow.activeElement = t.find('auto');
    await t.overlay.hideForCapture();
    const before = t.find('auto').focusCalls;
    t.overlay.showAfterCapture();
    assert.equal(t.find('auto').focusCalls, before + 1);
    assert.deepEqual({ ...t.find('auto').focusArgs.at(-1) }, { preventScroll: true });
  });

  it('puts the focus back on the layer after a capture, and never while hidden', async () => {
    const t = session();
    t.shadow.activeElement = t.root;
    await t.overlay.hideForCapture();
    const hiddenCalls = t.root.focusCalls;
    t.overlay.keepOnTop(); // does nothing while hidden
    assert.equal(t.root.focusCalls, hiddenCalls);
    t.overlay.showAfterCapture();
    assert.equal(t.root.focusCalls, hiddenCalls + 1);
  });

  it('does not steal the focus from the page after a capture when it was not in the overlay', async () => {
    const t = session();
    t.shadow.activeElement = null;
    await t.overlay.hideForCapture();
    const before = t.root.focusCalls;
    t.overlay.showAfterCapture();
    assert.equal(t.root.focusCalls, before);
  });
});

// ---------------------------------------------------------------------------------------------
// The Done button, the end-of-panel description, the hover label and the HUD button names
// ---------------------------------------------------------------------------------------------

describe('overlay: the Done button says "Finishing…"', () => {
  it('says Done until Done is pressed, then Finishing… while the agent is busy', () => {
    const t = session();
    const done = t.find('done');
    assert.equal(textOf(done), 'Copy & saveEnter');
    t.find('done').dispatch('click');
    t.overlay.setBusy(true); // the agent starts to finish
    assert.equal(textOf(done), 'Finishing…Enter');
    assert.equal('finishing' in t.root.dataset, true, 'the stylesheet swaps the check for a spinner');
    assert.equal(done.attributes.get('aria-label'), 'Finishing');
    assert.equal(done.attributes.get('aria-disabled'), 'true');
  });

  it('says Done again when Done fails (the agent shows an error and is not busy)', () => {
    const t = session();
    t.find('done').dispatch('click');
    t.overlay.setBusy(true);
    t.overlay.setBusy(false);
    t.overlay.setStatus(status({ level: 'error', message: 'Could not finish.' }));
    assert.equal(textOf(t.find('done')), 'Copy & saveEnter');
    assert.equal('finishing' in t.root.dataset, false);
    assert.equal(t.find('done').attributes.get('aria-label'), 'Copy and save (Enter)');
    assert.equal(t.find('done').attributes.has('aria-disabled'), false);
    // A new press works and shows it again.
    t.find('done').dispatch('click');
    t.overlay.setBusy(true);
    assert.equal(textOf(t.find('done')), 'Finishing…Enter');
  });

  it('does not say it for a busy step that Done did not ask for, nor before the agent is busy', () => {
    const t = session();
    t.overlay.setBusy(true);
    assert.equal(textOf(t.find('done')), 'Copy & saveEnter');
    const u = session({ auto: true });
    u.find('done').dispatch('click'); // Done during Auto: the agent stops after the step first
    assert.equal(textOf(u.find('done')), 'Copy & saveEnter');
    u.overlay.setBusy(true);
    assert.equal(textOf(u.find('done')), 'Finishing…Enter');
  });

  it('starts clean when the selection starts again', () => {
    const t = session();
    t.find('done').dispatch('click');
    t.overlay.setBusy(true);
    t.overlay.beginSelect();
    assert.equal(textOf(t.find('done')), 'Copy & saveEnter');
    t.overlay.showSession(SESSION_RECT);
    assert.equal(textOf(t.find('done')), 'Copy & saveEnter');
  });
});

describe('overlay: the end-of-panel description and the button names', () => {
  it('describes the Scroll button with "Nothing more below" only at the end of the panel', () => {
    const t = session();
    const down = t.find('down');
    assert.equal(down.attributes.has('aria-describedby'), false, 'mid-capture: no description');
    t.overlay.setStatus(status({ atEnd: true, progress: 1 }));
    const id = down.attributes.get('aria-describedby');
    assert.equal(id, t.find('tip').id);
    assert.equal(textOf(t.find('tip')), 'Nothing more below');
    t.overlay.setStatus(status({ atEnd: false, progress: 0.5 }));
    assert.equal(down.attributes.has('aria-describedby'), false);
  });

  it('keeps the tip out of the reading order (a description is read from a hidden element)', () => {
    const t = session();
    assert.equal(t.find('tip').attributes.get('aria-hidden'), 'true');
  });

  it('names every button with its key, in one pattern', () => {
    const t = session();
    const names = ['down', 'up', 'auto', 'done', 'cancel'].map((c) => t.find(c).attributes.get('aria-label'));
    assert.deepEqual(names, [
      'Scroll down (Space)',
      'Scroll up (Shift+Space)',
      'Auto scroll (A)',
      'Copy and save (Enter)',
      'Cancel (Esc)',
    ]);
    assert.equal(t.find('up').title, 'Scroll up (Up arrow or Shift+Space)');
  });
});

describe('overlay: the hover label and the hint pill', () => {
  /** @param {Rect} box @returns {{ left: number, top: number, right: number, bottom: number }} */
  function labelAfterHover(box) {
    const t = setup();
    t.overlay.beginSelect();
    t.page.hit = { el: {}, box };
    t.root.dispatch('pointermove', pointer({ clientX: box.x + 5, clientY: box.y + 5 }));
    t.runFrames();
    const tag = t.find('tag');
    const left = Number.parseInt(tag.style['left'] ?? '', 10);
    const top = Number.parseInt(tag.style['top'] ?? '', 10);
    return { left, top, right: left + tag.offsetWidth, bottom: top + 28 };
  }

  /** The label is 80 px wide in the fake DOM; the pill is 460..540 by 12..48. */
  const touches = (/** @type {{ left: number, top: number, right: number, bottom: number }} */ r) =>
    r.left < HINT_PILL.right && r.right > HINT_PILL.left && r.top < HINT_PILL.bottom && r.bottom > HINT_PILL.top;

  it('never lies under the pill, wherever the panel starts', () => {
    for (let x = 0; x <= 760; x += 20) {
      for (let y = 0; y <= 120; y += 6) {
        const label = labelAfterHover({ x, y, width: 240, height: 500 });
        assert.equal(touches(label), false, `panel at ${x}, ${y}: label ${JSON.stringify(label)}`);
      }
    }
  });

  it('stays above the panel when there is room', () => {
    const label = labelAfterHover({ x: 100, y: 200, width: 300, height: 300 });
    assert.deepEqual([label.left, label.top], [100, 172]);
  });

  it('moves into the panel when the pill would cover it (a panel beside a sidebar)', () => {
    const label = labelAfterHover({ x: 450, y: 50, width: 300, height: 500 });
    assert.equal(label.top >= 50, true, 'inside the panel: below its top edge');
    assert.equal(touches(label), false);
  });
});

// ---------------------------------------------------------------------------------------------
// page-lib.js: listScrollTargets
// ---------------------------------------------------------------------------------------------

describe('page-lib: listScrollTargets', () => {
  /**
   * A page of boxes: elements with a rect, a scroll height and an overflow, no overlap. The hit
   * test returns the elements under a point, topmost first (panels before body before html).
   * @param {{ panels?: { name: string, rect: Rect, scrolls?: boolean, overflowY?: string, parent?: string }[], pageScrolls?: boolean }} options
   */
  function pageWith({ panels = [], pageScrolls = false } = {}) {
    /** @type {any} */
    const documentFake = { nodeType: 9 };
    /** @param {string} name @param {Rect} rect @param {any} extra */
    const make = (name, rect, extra = {}) => ({
      name,
      rect,
      parentElement: null,
      assignedSlot: null,
      shadowRoot: null,
      getRootNode: () => documentFake,
      clientLeft: 0,
      clientTop: 0,
      clientWidth: rect.width,
      clientHeight: rect.height,
      scrollHeight: rect.height,
      scrollTop: 0,
      css: { position: 'static', overflowX: 'visible', overflowY: 'visible', display: 'block', transform: 'none' },
      getBoundingClientRect() {
        const { x, y, width, height } = this.rect;
        return { left: x, top: y, width, height, right: x + width, bottom: y + height };
      },
      ...extra,
    });
    const html = make('html', { x: 0, y: 0, width: 1000, height: 800 }, { scrollHeight: pageScrolls ? 3000 : 800 });
    const body = make('body', { x: 0, y: 0, width: 1000, height: 800 });
    body.parentElement = html;
    const list = panels.map((p) => {
      const el = make(p.name, p.rect, { scrollHeight: p.scrolls === false ? p.rect.height : p.rect.height * 3 });
      el.parentElement = body;
      el.css.overflowY = p.overflowY ?? 'auto';
      return el;
    });
    Object.assign(documentFake, {
      documentElement: html,
      body,
      scrollingElement: html,
      elementsFromPoint: (/** @type {number} */ x, /** @type {number} */ y) =>
        [...list, body, html].filter(
          (el) => x >= el.rect.x && x < el.rect.x + el.rect.width && y >= el.rect.y && y < el.rect.y + el.rect.height,
        ),
      createTreeWalker: () => ({ nextNode: () => null }),
    });
    const globals = {
      document: documentFake,
      getComputedStyle: (/** @type {any} */ el) => el.css,
      requestAnimationFrame: (/** @type {() => void} */ cb) => setImmediate(cb),
      setTimeout,
    };
    /** @type {PageLib | undefined} */
    const lib = loadClassic('src/page/page-lib.js', globals).__spool?.lib;
    assert.ok(lib, 'page-lib.js must register __spool.lib');
    return { lib, list };
  }

  /** @param {{ el: unknown }[]} targets */
  const names = (targets) => Array.from(targets, (t) => /** @type {any} */ (t.el).name);
  /** @param {{ kind: string }[]} targets */
  const kinds = (targets) => Array.from(targets, (t) => t.kind);

  it('lists the panels in reading order: top to bottom, then left to right', () => {
    const { lib } = pageWith({
      panels: [
        { name: 'right', rect: { x: 520, y: 80, width: 400, height: 500 } },
        { name: 'low', rect: { x: 40, y: 400, width: 300, height: 300 } },
        { name: 'left', rect: { x: 40, y: 80, width: 400, height: 280 } },
      ],
    });
    assert.deepEqual(names(lib.listScrollTargets()), ['left', 'right', 'low']);
  });

  it('puts the page first when it scrolls, and leaves it out when it does not', () => {
    const panel = { name: 'panel', rect: { x: 100, y: 100, width: 300, height: 300 } };
    const scrolling = pageWith({ panels: [panel], pageScrolls: true }).lib.listScrollTargets();
    assert.deepEqual(kinds(scrolling), ['document', 'element']);
    const still = pageWith({ panels: [panel] }).lib.listScrollTargets();
    assert.deepEqual(kinds(still), ['element']);
  });

  it('gives the page itself when nothing scrolls, as a click on it would', () => {
    const [only, ...more] = pageWith({ panels: [{ name: 'p', rect: { x: 10, y: 10, width: 200, height: 200 }, scrolls: false }] })
      .lib.listScrollTargets();
    assert.equal(only?.kind, 'document');
    assert.deepEqual(more, []);
    assert.deepEqual({ ...only?.box }, { x: 0, y: 0, width: 1000, height: 800 });
  });

  it('leaves out panels that cannot be scrolled by the user, and tiny ones', () => {
    const { lib } = pageWith({
      panels: [
        { name: 'hidden', rect: { x: 40, y: 40, width: 300, height: 300 }, overflowY: 'hidden' },
        { name: 'tiny', rect: { x: 400, y: 40, width: 20, height: 300 } },
        { name: 'short', rect: { x: 500, y: 40, width: 300, height: 10 } },
        { name: 'good', rect: { x: 40, y: 400, width: 300, height: 300 } },
      ],
    });
    assert.deepEqual(names(lib.listScrollTargets()), ['good']);
  });

  it('gives each panel a box that is on screen (the same as a click on it selects)', () => {
    const { lib } = pageWith({ panels: [{ name: 'p', rect: { x: 700, y: 500, width: 600, height: 600 } }] });
    const [first] = lib.listScrollTargets();
    assert.deepEqual({ ...first?.box }, { x: 700, y: 500, width: 300, height: 300 });
    assert.deepEqual({ ...lib.findScrollTarget({ x: 800, y: 600, width: 1, height: 1 }).box }, { ...first?.box });
  });
});
