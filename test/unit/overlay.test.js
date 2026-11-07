// @ts-check
/**
 * Tests for the input rules of src/page/overlay.js: which keyboard and pointer events drive the
 * overlay. The script is a classic script. It is loaded into a node:vm context whose globals are
 * a small fake DOM (elements that record listeners and attributes, a window that dispatches
 * events, animation frames that the test runs by hand). The look of the overlay and real pointer
 * handling are covered by the e2e tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadClassic } from '../helpers/load-classic.js';

/** @typedef {import('../../src/shared/types.js').Rect} Rect */
/** @typedef {import('../../types/page-globals.js').OverlayCommand} OverlayCommand */
/** @typedef {import('../../types/page-globals.js').OverlayHandle} OverlayHandle */

/** What the fake `lib.findScrollTarget` returns for a click. */
const CLICK_BOX = Object.freeze({ x: 40, y: 50, width: 300, height: 400 });
const SESSION_RECT = Object.freeze({ x: 100, y: 100, width: 400, height: 400 });

/** An event target that records its listeners and can dispatch an event to them. */
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

  /** @param {string} type */
  listenerCount(type) {
    return this.listeners.get(type)?.size ?? 0;
  }

  /**
   * Calls every listener of `type`. The returned event shows what the overlay did with it.
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
    /** @type {string[]} */
    this.removedAttributes = [];
    this.focusCalls = 0;
    this.blurCalls = 0;
  }

  focus() {
    this.focusCalls += 1;
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
    this.removedAttributes.push(name);
  }

  /** @param {string} name @param {string} value */
  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }

  /** @param {string} name @param {boolean} [force] */
  toggleAttribute(name, force) {
    if (force) this.attributes.set(name, '');
    else this.attributes.delete(name);
    return force === true;
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

/** An element in a browser that has popovers. */
class FakePopoverElement extends FakeElement {
  /** @param {string} tag */
  constructor(tag) {
    super(tag);
    /** @type {string | undefined} */
    this.popover = undefined;
    this.shown = 0;
    this.hidden = 0;
    this.failShow = false;
  }

  showPopover() {
    if (this.failShow) throw new Error('not allowed');
    this.shown += 1;
  }

  hidePopover() {
    this.hidden += 1;
  }
}

/**
 * A page with the fakes the overlay needs, the overlay loaded, and a record of what it did.
 * @param {{ popover?: boolean, copyOnDone?: boolean }} [options]  `popover`: the browser has
 *   popovers. `copyOnDone`: what the setting says (default: not given, so on).
 */
function setup({ popover = false, copyOnDone } = {}) {
  /** @type {FakeElement[]} */
  const created = [];
  const win = new FakeTarget();
  const documentElement = new FakeElement('html');
  /** @type {unknown[][]} */
  const consoleErrors = [];
  /** Modal dialogs that are open now, and elements left by an old version. */
  const page = {
    /** @type {FakeElement[]} */
    modals: [],
    /** @type {FakeElement[]} */
    legacyHosts: [],
    /** What `document.elementsFromPoint` reports, topmost first. @type {unknown[] | null} */
    stack: null,
    /** The box that `lib.findScrollTarget` reports. @type {Rect} */
    box: CLICK_BOX,
    /** The points that `lib.findScrollTarget` was asked about. @type {{ x: number, y: number }[]} */
    hitTests: [],
    /** Animation frames that wait for `runFrames()`. @type {Map<number, () => void>} */
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
      querySelectorAll: (/** @type {string} */ selector) => {
        if (selector === 'dialog:modal') return page.modals;
        if (selector === '[data-spool-host]') return page.legacyHosts;
        return [];
      },
      elementsFromPoint: () => page.stack ?? [created[0]],
      createElement: (/** @type {string} */ tag) => {
        const el = popover ? new FakePopoverElement(tag) : new FakeElement(tag);
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
        nextFrames: () => Promise.resolve(),
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
    ...(copyOnDone === undefined ? {} : { copyOnDone }),
  });

  /** @param {string} className */
  const find = (className) => {
    const el = created.find((e) => e.className === className);
    assert.ok(el, `no element with class "${className}"`);
    return el;
  };
  /** Runs the animation frames that wait (the ones they ask for while running wait again). */
  const runFrames = () => {
    const waiting = [...page.frames];
    page.frames.clear();
    for (const [, fn] of waiting) fn();
  };
  return {
    overlay,
    overlayModule,
    win,
    root: find('root'),
    find,
    /** All elements with this class, in creation order. @param {string} className */
    findAll: (className) => created.filter((e) => e.className === className),
    runFrames,
    commands,
    regions,
    consoleErrors,
    documentElement,
    page,
    /** The host: the first element the overlay made. */
    host: /** @type {FakePopoverElement} */ (created[0]),
    /** The namespace the scripts share. */
    ns: /** @type {any} */ (globals).__spool,
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

/**
 * A status for `setStatus`. @param {Partial<import('../../types/page-globals.js').OverlayStatus>} [more]
 */
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

/** The text under a fake node. @param {any} node @returns {string} */
function textOf(node) {
  if (typeof node?.data === 'string') return node.data;
  if (typeof node?.textContent === 'string' && node.textContent !== '') return node.textContent;
  return (node?.children ?? []).map(textOf).join('');
}

/** @type {[string, OverlayCommand][]} */
const KEY_COMMANDS = [
  [' ', 'down'],
  ['ArrowDown', 'down'],
  ['ArrowUp', 'up'],
  ['a', 'auto'],
  ['Enter', 'done'],
  ['Escape', 'cancel'],
];

describe('overlay.js: keyboard', () => {
  it('a trusted key drives the session, and the page does not get it', () => {
    for (const [name, cmd] of KEY_COMMANDS) {
      const t = setup();
      t.overlay.beginSelect();
      t.overlay.showSession(SESSION_RECT);
      const down = t.win.dispatch('keydown', key(name));
      assert.deepEqual(t.commands, [cmd], `key "${name}"`);
      assert.equal(down.defaultPrevented, true, `key "${name}" is claimed (keydown)`);
      assert.equal(down.immediatelyStopped, true, `key "${name}" is hidden from the page`);
      const up = t.win.dispatch('keyup', key(name));
      assert.equal(up.defaultPrevented && up.immediatelyStopped, true, `key "${name}" (keyup)`);
    }
  });

  describe('the A key on a layout that has no Latin letters', () => {
    /** @param {string} name @param {string} code */
    const press = (name, code) => {
      const t = setup();
      t.overlay.beginSelect();
      t.overlay.showSession(SESSION_RECT);
      const down = t.win.dispatch('keydown', key(name, { code }));
      return { commands: t.commands, down };
    };

    it('the key in the place of A starts Auto: Cyrillic, Greek, Hebrew, Arabic', () => {
      for (const [name, code] of [
        ['ф', 'KeyA'], // Russian
        ['Ф', 'KeyA'],
        ['α', 'KeyA'], // Greek
        ['ש', 'KeyA'], // Hebrew
        ['ش', 'KeyA'], // Arabic
      ]) {
        const { commands, down } = press(/** @type {string} */ (name), /** @type {string} */ (code));
        assert.deepEqual(commands, ['auto'], `${name} on ${code}`);
        assert.equal(down.defaultPrevented, true);
      }
    });

    it('a Latin layout that has another Latin letter in that place keeps it: AZERTY has Q there', () => {
      for (const [name, code] of [
        ['q', 'KeyA'],
        ['Q', 'KeyA'],
        ['z', 'KeyA'],
      ]) {
        const { commands, down } = press(/** @type {string} */ (name), /** @type {string} */ (code));
        assert.deepEqual(commands, [], `${name} on ${code}`);
        assert.equal(down.defaultPrevented, false);
      }
    });

    it('the letter A still works wherever it is: AZERTY has it where QWERTY has Q', () => {
      assert.deepEqual(press('a', 'KeyQ').commands, ['auto']);
      assert.deepEqual(press('A', 'KeyQ').commands, ['auto']);
      assert.deepEqual(press('a', 'KeyA').commands, ['auto']);
    });

    it('a letter of another script in another place does not start Auto', () => {
      assert.deepEqual(press('ы', 'KeyS').commands, []);
      assert.deepEqual(press('ф', 'KeyB').commands, []);
    });

    it('a dead key, a symbol and a missing code are not the A key', () => {
      assert.deepEqual(press('Dead', 'KeyA').commands, []);
      assert.deepEqual(press('1', 'KeyA').commands, []);
      assert.deepEqual(press('ф', '').commands, []);
    });

    it('with Ctrl, Meta or Alt held, or while composing, it is not a command', () => {
      for (const field of ['ctrlKey', 'metaKey', 'altKey', 'isComposing']) {
        const t = setup();
        t.overlay.beginSelect();
        t.overlay.showSession(SESSION_RECT);
        t.win.dispatch('keydown', key('ф', { code: 'KeyA', [field]: true }));
        assert.deepEqual(t.commands, [], field);
      }
    });

    it('a fake key event of the page still does nothing', () => {
      const t = setup();
      t.overlay.beginSelect();
      t.overlay.showSession(SESSION_RECT);
      t.win.dispatch('keydown', key('ф', { code: 'KeyA', isTrusted: false }));
      assert.deepEqual(t.commands, []);
    });
  });

  it('ignores a key event that a page script made (isTrusted is false)', () => {
    for (const [name] of KEY_COMMANDS) {
      const t = setup();
      t.overlay.beginSelect();
      t.overlay.showSession(SESSION_RECT);
      const down = t.win.dispatch('keydown', key(name, { isTrusted: false }));
      const up = t.win.dispatch('keyup', key(name, { isTrusted: false }));
      assert.deepEqual(t.commands, [], `fake key "${name}" must not drive the overlay`);
      for (const event of [down, up]) {
        assert.equal(event.defaultPrevented, false, 'the page keeps its own fake event');
        assert.equal(event.immediatelyStopped, false);
      }
      assert.deepEqual(t.consoleErrors, []);
    }
  });

  it('a fake Escape does not cancel the selection, a real one does', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.win.dispatch('keydown', key('Escape', { isTrusted: false }));
    assert.deepEqual(t.commands, []);
    t.win.dispatch('keydown', key('Escape'));
    assert.deepEqual(t.commands, ['cancel']);
  });

  it('while selecting, only Escape is a command (Tab and Enter choose a panel)', () => {
    const t = setup();
    t.overlay.beginSelect();
    for (const [name] of KEY_COMMANDS.filter(([k]) => k !== 'Escape' && k !== 'Enter')) {
      const event = t.win.dispatch('keydown', key(name));
      assert.equal(event.defaultPrevented, false, `key "${name}"`);
    }
    assert.deepEqual(t.commands, []);
  });

  it('Shift+Space scrolls up; keys with Ctrl, Meta or Alt are left to the page', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    t.win.dispatch('keydown', key(' ', { shiftKey: true }));
    assert.deepEqual(t.commands, ['up']);
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey']) {
      const event = t.win.dispatch('keydown', key('ArrowDown', { [modifier]: true }));
      assert.equal(event.defaultPrevented, false, modifier);
    }
    assert.deepEqual(t.commands, ['up']);
  });
});

describe('overlay.js: pointer', () => {
  it('a trusted click selects the scroll area under the pointer', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointerdown', pointer({ clientX: 120, clientY: 130 }));
    t.root.dispatch('pointerup', pointer({ clientX: 120, clientY: 130 }));
    assert.deepEqual(t.regions, [CLICK_BOX]);
  });

  it('a trusted drag selects the box between the two points', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 250, clientY: 220 }));
    t.root.dispatch('pointerup', pointer({ clientX: 300, clientY: 340 }));
    assert.deepEqual(t.regions, [{ x: 100, y: 100, width: 200, height: 240 }]);
  });

  it('ignores pointer events that a page script made', () => {
    const t = setup();
    t.overlay.beginSelect();
    // A fake click, a fake drag, and a fake release after a real press: none selects anything.
    t.root.dispatch('pointerdown', pointer({ isTrusted: false, clientX: 120, clientY: 130 }));
    t.root.dispatch('pointerup', pointer({ isTrusted: false, clientX: 120, clientY: 130 }));
    t.root.dispatch('pointerdown', pointer({ isTrusted: false, clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ isTrusted: false, clientX: 300, clientY: 300 }));
    t.root.dispatch('pointerup', pointer({ isTrusted: false, clientX: 300, clientY: 300 }));
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointerup', pointer({ isTrusted: false, clientX: 300, clientY: 300 }));
    assert.deepEqual(t.regions, []);
    // The real release still ends the real press.
    t.root.dispatch('pointerup', pointer({ clientX: 100, clientY: 100 }));
    assert.deepEqual(t.regions, [CLICK_BOX]);
  });

  it('a fake pointercancel does not drop a real drag', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 250, clientY: 250 }));
    t.root.dispatch('pointercancel', pointer({ isTrusted: false }));
    t.root.dispatch('pointerup', pointer({ clientX: 300, clientY: 300 }));
    assert.deepEqual(t.regions, [{ x: 100, y: 100, width: 200, height: 200 }]);
  });

  it('presses a bar button only for a trusted click', () => {
    for (const [className, cmd] of /** @type {[string, OverlayCommand][]} */ ([
      ['down', 'down'],
      ['up', 'up'],
      ['auto', 'auto'],
      ['done', 'done'],
      ['cancel', 'cancel'],
    ])) {
      const t = setup();
      t.overlay.beginSelect();
      t.overlay.showSession(SESSION_RECT);
      const button = t.find(className);
      button.dispatch('click', { isTrusted: false });
      assert.deepEqual(t.commands, [], `a fake click on "${className}"`);
      button.dispatch('click');
      assert.deepEqual(t.commands, [cmd], `a real click on "${className}"`);
    }
  });

  it('keeps page-bound mouse events from the page only while it is in use', () => {
    const t = setup();
    // The host stops the events that the overlay handles, but not fake ones.
    const host = /** @type {FakeElement} */ (
      /** @type {unknown} */ (t.documentElement.children[0])
    );
    t.overlay.beginSelect();
    assert.equal(host.dispatch('mousedown').propagationStopped, true);
    assert.equal(host.dispatch('mousedown', { isTrusted: false }).propagationStopped, false);
  });
});

describe('overlay.js: destroy', () => {
  it('removes the host and every listener, and is idempotent', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    const host = /** @type {FakeElement} */ (/** @type {unknown} */ (t.overlay.host));
    assert.ok(t.win.listenerCount('keydown') > 0);
    t.overlay.destroy();
    t.overlay.destroy();
    assert.equal(host.removed, true);
    assert.equal(t.win.listenerCount('keydown'), 0);
    assert.equal(t.win.listenerCount('keyup'), 0);
    assert.equal(t.win.listenerCount('resize'), 0);
    const event = t.win.dispatch('keydown', key('Escape'));
    assert.deepEqual(t.commands, []);
    assert.equal(event.defaultPrevented, false);
  });
});

describe('overlay.js: what the page can see', () => {
  it('the host has no attribute, and hiding for a capture changes only a class inside', async () => {
    const t = setup({ popover: true });
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    t.overlay.setStatus(status());
    const snapshot = () => JSON.stringify([[...t.host.attributes], t.host.dataset, t.host.style]);
    const before = snapshot();
    assert.equal([...t.host.attributes].length, 0, 'no marker and no state attribute');

    await t.overlay.hideForCapture();
    assert.equal(t.root.classList.contains('hidden'), true, 'the content is hidden inside');
    assert.equal(snapshot(), before, 'nothing about the host changed');

    t.overlay.showAfterCapture();
    assert.equal(t.root.classList.contains('hidden'), false);
    assert.equal(snapshot(), before);
  });

  it('removes hosts that an earlier injection left, by its own record and by the old marker', () => {
    const t = setup();
    const first = t.host;
    assert.deepEqual([...t.ns.overlayHosts], [first]);
    const old = new FakeElement('div'); // made by an earlier version, with the marker attribute
    t.documentElement.append(old);
    t.page.legacyHosts.push(old);

    const second = t.overlayModule.createOverlay({ onRegion: () => {}, onCommand: () => {} });
    assert.equal(first.removed, true, 'the orphan of the same version is removed');
    assert.equal(old.removed, true, 'the host of an old version is removed');
    assert.notEqual(second.host, first);
    assert.deepEqual([...t.ns.overlayHosts], [second.host]);

    second.destroy();
    assert.equal(t.ns.overlayHosts.size, 0, 'destroy forgets the host');
  });
});

describe('overlay.js: top layer', () => {
  it('shows the host as a manual popover', () => {
    const t = setup({ popover: true });
    assert.equal(t.host.popover, 'manual');
    assert.equal(t.host.shown, 1);
    assert.equal(t.host.parentNode, t.documentElement);
  });

  it('stays an ordinary fixed element without popover support', () => {
    const t = setup();
    assert.equal(t.host.parentNode, t.documentElement);
    assert.equal('popover' in t.host, false);
    assert.doesNotThrow(() => t.overlay.keepOnTop());
  });

  it('drops the popover attribute when the browser refuses to show it', () => {
    const t = setup({ popover: true });
    t.host.failShow = true;
    t.overlay.beginSelect();
    t.host.shown = 0;
    // Force a new try: a modal dialog opens, the host moves, and showing it fails.
    const dialog = new FakeElement('dialog');
    t.page.modals.push(dialog);
    assert.doesNotThrow(() => t.overlay.keepOnTop());
    assert.deepEqual(t.host.removedAttributes, ['popover']);
    assert.equal(t.host.parentNode, dialog, 'it is still in the dialog');
  });

  it('sits inside an open modal dialog (the rest of the page is inert), else on <html>', () => {
    const dialog = new FakeElement('dialog');
    const first = setup({ popover: true });
    assert.equal(first.host.parentNode, first.documentElement);

    // A dialog that is open before the overlay starts: use the topmost one.
    const t = setup({ popover: true });
    t.page.modals.push(new FakeElement('dialog'), dialog);
    const handle = t.overlayModule.createOverlay({ onRegion: () => {}, onCommand: () => {} });
    assert.equal(/** @type {any} */ (handle.host).parentNode, dialog);
    assert.equal(/** @type {any} */ (handle.host).shown, 1);
  });

  it('keepOnTop moves the host into a dialog that opens later, and back when it closes', () => {
    const t = setup({ popover: true });
    t.overlay.beginSelect();
    const dialog = new FakeElement('dialog');
    t.page.modals.push(dialog);
    t.overlay.keepOnTop();
    assert.equal(t.host.parentNode, dialog);
    assert.equal(t.host.shown, 2, 'a moved popover is shown again');
    assert.equal(t.root.removed, false, 'the content moves with the host');

    t.page.modals.length = 0; // the dialog closes
    t.overlay.keepOnTop();
    assert.equal(t.host.parentNode, t.documentElement);
    assert.equal(t.host.shown, 3);
  });

  it('keepOnTop shows the host again when something else is above it, and only then', () => {
    const t = setup({ popover: true });
    t.overlay.beginSelect();
    t.overlay.keepOnTop(); // topmost: nothing to do
    assert.equal(t.host.hidden, 0);
    assert.equal(t.host.shown, 1);

    t.page.stack = [new FakeElement('div'), t.host]; // a popover of the page opened above
    t.overlay.keepOnTop();
    assert.equal(t.host.hidden, 1);
    assert.equal(t.host.shown, 2);

    t.page.stack = [t.host];
    t.overlay.keepOnTop();
    assert.equal(t.host.shown, 2);
  });

  it('keepOnTop does nothing before the selection starts, while hidden, or after destroy', async () => {
    const t = setup({ popover: true });
    t.page.stack = [new FakeElement('div')];
    t.overlay.keepOnTop(); // not started: its content is not displayed and cannot be hit
    assert.equal(t.host.shown, 1);

    t.overlay.beginSelect();
    await t.overlay.hideForCapture();
    t.overlay.keepOnTop(); // hidden for a capture: it cannot be hit either
    assert.equal(t.host.shown, 1);
    t.overlay.showAfterCapture();
    t.overlay.keepOnTop();
    assert.equal(t.host.shown, 2);

    t.overlay.destroy();
    t.overlay.keepOnTop();
    assert.equal(t.host.shown, 2);
  });

  it('keeps handling trusted keys and clicks after the move into a dialog', () => {
    const t = setup({ popover: true });
    t.overlay.beginSelect();
    t.page.modals.push(new FakeElement('dialog'));
    t.overlay.keepOnTop();
    t.root.dispatch('pointerdown', pointer({ clientX: 120, clientY: 130 }));
    t.root.dispatch('pointerup', pointer({ clientX: 120, clientY: 130 }));
    assert.deepEqual(t.regions, [CLICK_BOX]);
    t.win.dispatch('keydown', key('Escape'));
    assert.deepEqual(t.commands, ['cancel']);
  });
});

describe('overlay.js: hover outline while selecting', () => {
  it('tests the panel under the pointer once per animation frame', () => {
    const t = setup();
    t.overlay.beginSelect();
    for (const x of [120, 130, 140]) {
      t.root.dispatch('pointermove', pointer({ clientX: x, clientY: 150 }));
    }
    assert.equal(t.page.frames.size, 1, 'one frame is waiting, not three');
    assert.deepEqual(t.page.hitTests, [], 'nothing is tested before the frame');

    t.runFrames();
    assert.deepEqual(t.page.hitTests, [{ x: 140, y: 150 }], 'the last pointer position');
    assert.equal('hover' in t.root.dataset, true);
    const frame = t.find('frame');
    assert.deepEqual(
      [frame.style['left'], frame.style['top'], frame.style['width'], frame.style['height']],
      ['40px', '50px', '300px', '400px'],
    );
    assert.equal(textOf(t.find('tag')), 'Click to spool this panel');
    assert.equal(t.find('tag').style['left'], '40px', 'the label sits on the panel edge');
    assert.equal(t.find('tag').style['top'], '22px', 'and 28 px above it');
    assert.equal('inside' in t.find('tag').dataset, false);
  });

  it('fades in without gliding, then glides from panel to panel', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    t.runFrames();
    assert.equal(t.find('frame').classes.has('glide'), false, 'first outline: no glide');

    t.page.box = Object.freeze({ x: 500, y: 60, width: 200, height: 300 });
    t.root.dispatch('pointermove', pointer({ clientX: 600, clientY: 100 }));
    t.runFrames();
    assert.equal(t.find('frame').classes.has('glide'), true, 'the next one glides');
    assert.equal(t.find('frame').style['left'], '500px');

    t.root.dispatch('pointerleave', pointer());
    assert.equal('hover' in t.root.dataset, false, 'the pointer left: no outline');
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    t.runFrames();
    assert.equal(t.find('frame').classes.has('glide'), false, 'back from nothing: no glide');
  });

  it('puts the label inside the panel, under the hint, when the panel touches the top', () => {
    const t = setup();
    t.page.box = Object.freeze({ x: 0, y: 0, width: 1000, height: 800 });
    t.overlay.beginSelect();
    t.root.dispatch('pointermove', pointer({ clientX: 500, clientY: 400 }));
    t.runFrames();
    assert.equal('inside' in t.find('tag').dataset, true);
    assert.equal(t.find('tag').style['top'], '56px');
    assert.equal(t.find('tag').style['left'], '12px');
  });

  it('does not test the pointer while dragging, after a pick or in a session', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 250, clientY: 220 }));
    assert.equal('hover' in t.root.dataset, false, 'a drag replaces the hover outline');
    assert.equal('drag' in t.root.dataset, true);
    t.root.dispatch('pointermove', pointer({ clientX: 260, clientY: 230 }));
    assert.equal(t.page.frames.size, 0, 'no hover test during a drag');
    assert.equal(textOf(t.find('size')), '160 × 130', 'the live size label');
    t.root.dispatch('pointerup', pointer({ clientX: 260, clientY: 230 }));
    t.root.dispatch('pointermove', pointer({ clientX: 300, clientY: 300 }));
    assert.equal(t.page.frames.size, 0, 'locked after the pick');

    t.overlay.showSession(SESSION_RECT);
    t.root.dispatch('pointermove', pointer({ clientX: 300, clientY: 300 }));
    assert.equal(t.page.frames.size, 0, 'no hover in a session');
    assert.equal('hover' in t.root.dataset, false);
  });

  it('a click selects the panel and keeps its outline until the session starts', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointerdown', pointer({ clientX: 120, clientY: 130 }));
    t.root.dispatch('pointerup', pointer({ clientX: 120, clientY: 130 }));
    assert.deepEqual(t.regions, [CLICK_BOX]);
    assert.equal('hover' in t.root.dataset, true);
    assert.equal(t.find('frame').style['width'], '300px');
  });

  it('a drag that is too small shows a message under the hint, and the next press clears it', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    t.root.dispatch('pointermove', pointer({ clientX: 110, clientY: 108 }));
    t.root.dispatch('pointerup', pointer({ clientX: 110, clientY: 108 }));
    assert.deepEqual(t.regions, []);
    const [hintNotice] = t.findAll('notice');
    assert.ok(hintNotice);
    assert.equal(textOf(hintNotice), 'That box is too small. Drag a larger box.');
    assert.equal(hintNotice.dataset['level'], 'warn');
    assert.equal('show' in hintNotice.dataset, true);
    t.root.dispatch('pointerdown', pointer({ clientX: 100, clientY: 100 }));
    assert.equal('show' in hintNotice.dataset, false);
  });

  it('ignores a pointer that a page script made, and a failing hit test', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointermove', pointer({ isTrusted: false, clientX: 100, clientY: 100 }));
    assert.equal(t.page.frames.size, 0);

    t.ns.lib.findScrollTarget = () => {
      throw new Error('detached');
    };
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    assert.doesNotThrow(() => t.runFrames());
    assert.equal('hover' in t.root.dataset, false);
    assert.deepEqual(t.consoleErrors, []);
  });

  it('tests again when the page scrolls under the pointer, and stops after destroy', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.root.dispatch('pointermove', pointer({ clientX: 100, clientY: 100 }));
    t.runFrames();
    t.page.box = Object.freeze({ x: 40, y: 10, width: 300, height: 400 });
    t.win.dispatch('scroll');
    t.runFrames();
    assert.equal(t.page.hitTests.length, 2);
    assert.equal(t.find('frame').style['top'], '10px');

    t.root.dispatch('pointermove', pointer({ clientX: 101, clientY: 100 }));
    t.overlay.destroy();
    assert.equal(t.page.cancelledFrames, 1, 'the waiting frame is cancelled');
    assert.equal(t.win.listenerCount('scroll'), 0);
    t.runFrames();
    assert.equal(t.page.hitTests.length, 2);
  });
});

describe('overlay.js: HUD, readout and thread', () => {
  /**
   * A session with the given status.
   * @param {Partial<import('../../types/page-globals.js').OverlayStatus>} [more]
   * @param {Rect} [rect]
   */
  function session(more = {}, rect = SESSION_RECT) {
    const t = setup();
    t.overlay.beginSelect();
    t.overlay.showSession(rect);
    t.overlay.setStatus(status(more));
    return t;
  }

  it('shows steps, pixels and AI screenshots, with singular forms', () => {
    const t = session({ slices: 4, heightPx: 6240, tiles: 3 });
    assert.equal(textOf(t.find('counts')), '4 steps · 6,240 px · 3 AI screenshots');
    t.overlay.setStatus(status({ slices: 1, heightPx: 600, tiles: 1 }));
    assert.equal(textOf(t.find('counts')), '1 step · 600 px · 1 AI screenshot');
  });

  it('sets the end of panel and auto flags inside the shadow root only', () => {
    const t = session();
    assert.equal('end' in t.root.dataset, false);
    t.overlay.setStatus(status({ atEnd: true, tiles: 5, progress: 1 }));
    assert.equal('end' in t.root.dataset, true);
    assert.equal(textOf(t.find('end')), 'End of panel · 5 AI screenshots');
    t.overlay.setStatus(status({ auto: true }));
    assert.equal('auto' in t.root.dataset, true);
    assert.equal('end' in t.root.dataset, false);
    assert.equal([...t.host.attributes].length, 0, 'the host shows nothing of it');
  });

  it('Auto is pressed and says Stop while it runs', () => {
    const t = session();
    const auto = t.find('auto');
    assert.equal(auto.attributes.get('aria-pressed'), 'false');
    assert.equal(textOf(auto), 'AutoA');
    t.overlay.setStatus(status({ auto: true }));
    assert.equal(auto.attributes.get('aria-pressed'), 'true');
    assert.equal(auto.attributes.get('aria-label'), 'Stop auto (A)');
    assert.equal(textOf(auto), 'StopA');
  });

  it('names every button, and Cancel has an aria-label', () => {
    const t = session();
    assert.equal(t.find('cancel').attributes.get('aria-label'), 'Cancel (Esc)');
    assert.equal(t.find('up').attributes.get('aria-label'), 'Scroll up (Shift+Space)');
    assert.equal(t.find('done').attributes.get('aria-label'), 'Copy and save (Enter)');
    assert.equal(textOf(t.find('done')), 'Copy & saveEnter');
  });

  it('says "Save" when the setting copyOnDone is off, so the button tells the truth', () => {
    const t = setup({ copyOnDone: false });
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    t.overlay.setStatus(status());
    assert.equal(t.find('done').attributes.get('aria-label'), 'Save (Enter)');
    assert.equal(t.find('done').title, 'Save (Enter)');
    assert.equal(textOf(t.find('done')), 'SaveEnter');
    const on = setup({ copyOnDone: true });
    on.overlay.beginSelect();
    on.overlay.showSession(SESSION_RECT);
    assert.equal(textOf(on.find('done')), 'Copy & saveEnter');
    assert.equal(on.find('done').title, 'Copy and save (Enter)');
  });

  it('grows the thread with the progress', () => {
    const t = session({ progress: 0.5 });
    const thread = t.find('thread');
    assert.deepEqual(
      [thread.style['left'], thread.style['top'], thread.style['height']],
      ['506px', '100px', '400px'],
      '6 px right of the selection',
    );
    assert.equal(t.find('fill').style['height'], '200px');
    assert.deepEqual(
      t.findAll('tick').map((tick) => tick.style['transform']),
      ['translateY(49px)', 'translateY(99px)', 'translateY(149px)'],
    );
    assert.equal(t.find('knob').style['transform'], 'translateY(195px)');

    t.overlay.setStatus(status({ progress: 1, atEnd: true }));
    assert.equal(t.find('fill').style['height'], '400px');
    // The dot stays inside the track: its centre is at most half its grown size from the end.
    assert.equal(t.find('knob').style['transform'], 'translateY(387px)');

    t.overlay.setStatus(status({ progress: 5 }));
    assert.equal(t.find('fill').style['height'], '400px', 'progress is clamped to 1');
    t.overlay.setStatus(status({ progress: Number.NaN }));
    assert.equal(t.find('fill').style['height'], '0px', 'a bad value is 0');
  });

  it('puts the thread inside the selection when the window edge is too near', () => {
    const t = session({}, { x: 600, y: 100, width: 394, height: 300 });
    assert.equal(t.find('thread').style['left'], '985px');
  });

  it('centres the HUD below the selection, above it, or inside it', () => {
    const t = session();
    const hud = t.find('hud');
    assert.deepEqual([hud.style['left'], hud.style['top']], ['260px', '512px']);
    assert.equal(hud.dataset['notice'], 'below');

    t.overlay.showSession({ x: 100, y: 500, width: 400, height: 290 });
    assert.deepEqual([hud.style['left'], hud.style['top']], ['260px', '458px'], 'above');
    assert.equal(hud.dataset['notice'], 'below', 'the message goes below the HUD there');

    t.overlay.showSession({ x: 100, y: 10, width: 400, height: 780 });
    assert.equal(hud.style['top'], '748px', 'no room outside: inside at the bottom');
    assert.equal(hud.dataset['notice'], 'above');

    t.overlay.showSession({ x: 0, y: 100, width: 40, height: 400 });
    assert.equal(hud.style['left'], '8px', 'kept inside the window');
  });

  it('shows the message under the HUD and under the hint, and hides it when empty', () => {
    const t = session();
    const [hintNotice, hudNotice] = t.findAll('notice');
    assert.ok(hintNotice && hudNotice);
    assert.equal('show' in hudNotice.dataset, false);
    t.overlay.setStatus(status({ level: 'warn', message: 'Go back to this tab to continue.' }));
    for (const pill of [hintNotice, hudNotice]) {
      assert.equal(textOf(pill), 'Go back to this tab to continue.');
      assert.equal(pill.dataset['level'], 'warn');
      assert.equal('show' in pill.dataset, true);
    }
    t.overlay.setStatus(status());
    assert.equal('show' in hudNotice.dataset, false);
  });

  it('shows the error of a rejected selection under the hint', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.overlay.setStatus(
      status({ level: 'error', message: 'Select an area inside the page.', slices: 0 }),
    );
    const [hintNotice] = t.findAll('notice');
    assert.ok(hintNotice);
    assert.equal(textOf(hintNotice), 'Select an area inside the page.');
    assert.equal(hintNotice.dataset['level'], 'error');
    assert.equal('show' in hintNotice.dataset, true);
  });

  it('disables the step buttons while busy, and keeps Done, Cancel and a running Auto', () => {
    const t = session();
    t.overlay.setBusy(true);
    assert.deepEqual(
      ['down', 'up', 'auto', 'done', 'cancel'].map((c) => t.find(c).disabled),
      [true, true, true, false, false],
    );
    t.overlay.setStatus(status({ auto: true }));
    assert.equal(t.find('auto').disabled, false, 'Auto stays enabled to stop it');
  });

  it('while Done saves, Cancel is disabled and neither it nor Esc cancels', () => {
    const t = session();
    t.overlay.setBusy(true);
    t.overlay.setStatus(status({ finishing: true }));
    assert.equal(t.find('cancel').disabled, true);
    t.find('cancel').dispatch('click');
    const esc = t.win.dispatch('keydown', key('Escape'));
    assert.deepEqual(t.commands, [], 'no cancel reaches the agent');
    assert.equal(esc.defaultPrevented, true, 'Esc is still kept from the page');
    assert.equal(esc.immediatelyStopped, true);
  });

  it('Cancel works again when the status says that saving is over', () => {
    const t = session();
    t.overlay.setBusy(true);
    t.overlay.setStatus(status({ finishing: true }));
    t.overlay.setBusy(false);
    t.overlay.setStatus(status({ finishing: false, level: 'error', message: 'Could not save.' }));
    assert.equal(t.find('cancel').disabled, false);
    t.win.dispatch('keydown', key('Escape'));
    assert.deepEqual(t.commands, ['cancel']);
  });

  it('a new selection or session starts with Cancel on', () => {
    const t = session();
    t.overlay.setStatus(status({ finishing: true }));
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    assert.equal(t.find('cancel').disabled, false);
  });

  it('hides the HUD, the thread and the outline for a capture with one class', async () => {
    const t = session({ progress: 0.4 });
    await t.overlay.hideForCapture();
    assert.equal(t.root.classList.contains('hidden'), true);
    assert.equal([...t.host.attributes].length, 0);
    t.overlay.showAfterCapture();
    assert.equal(t.root.classList.contains('hidden'), false);
  });
});

describe('overlay.js: Auto stops on any other input', () => {
  /** A session with Auto running. */
  function running() {
    const t = setup();
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    t.overlay.setStatus(status({ auto: true }));
    return t;
  }

  /** @type {[string, (t: ReturnType<typeof running>) => unknown][]} */
  const TRIGGERS = [
    ['Space', (t) => t.win.dispatch('keydown', key(' '))],
    ['ArrowDown', (t) => t.win.dispatch('keydown', key('ArrowDown'))],
    ['ArrowUp', (t) => t.win.dispatch('keydown', key('ArrowUp'))],
    ['A', (t) => t.win.dispatch('keydown', key('a'))],
    ['wheel', (t) => t.root.dispatch('wheel', { deltaY: 100 })],
    [
      'click on the panel',
      (t) => t.root.dispatch('pointerdown', pointer({ target: t.root, clientX: 200, clientY: 200 })),
    ],
    ['Scroll button', (t) => t.find('down').dispatch('click')],
    ['Up button', (t) => t.find('up').dispatch('click')],
    ['Auto button', (t) => t.find('auto').dispatch('click')],
  ];

  for (const [name, trigger] of TRIGGERS) {
    it(`${name} stops it, once`, () => {
      const t = running();
      trigger(t);
      trigger(t);
      assert.deepEqual(t.commands, ['auto']);
    });
  }

  it('the wheel is still kept from the page', () => {
    const t = running();
    assert.equal(t.root.dispatch('wheel', { deltaY: 100 }).defaultPrevented, true);
  });

  it('a click on the HUD does not stop it (the buttons decide)', () => {
    const t = running();
    t.root.dispatch('pointerdown', pointer({ target: t.find('cancel') }));
    assert.deepEqual(t.commands, []);
  });

  it('can stop again after Auto ran and stopped', () => {
    const t = running();
    t.win.dispatch('keydown', key(' '));
    t.overlay.setStatus(status({ auto: false }));
    t.overlay.setStatus(status({ auto: true }));
    t.win.dispatch('keydown', key(' '));
    assert.deepEqual(t.commands, ['auto', 'auto']);
  });

  it('does not stop anything when Auto is not running', () => {
    const t = setup();
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    t.overlay.setStatus(status());
    t.root.dispatch('wheel', { deltaY: 100 });
    t.root.dispatch('pointerdown', pointer({ target: t.root, clientX: 200, clientY: 200 }));
    t.find('down').dispatch('click');
    t.win.dispatch('keydown', key('ArrowUp'));
    assert.deepEqual(t.commands, ['down', 'up']);
  });
});

describe('overlay.js: end of panel moves the focus to Done', () => {
  /** A session at the end of the panel. @param {boolean} [atEnd] */
  function ended(atEnd = true) {
    const t = setup();
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    t.overlay.setStatus(status({ progress: 1, atEnd }));
    return t;
  }

  it('focuses Done once the end is reached, not before', () => {
    const before = ended(false);
    assert.equal(before.find('done').focusCalls, 0);
    const t = ended();
    assert.ok(t.find('done').focusCalls >= 1);
  });

  it('waits while hidden for a capture (a hidden button cannot take focus), then focuses', async () => {
    const t = setup();
    t.overlay.beginSelect();
    t.overlay.showSession(SESSION_RECT);
    await t.overlay.hideForCapture();
    t.overlay.setStatus(status({ progress: 1, atEnd: true }));
    assert.equal(t.find('done').focusCalls, 0);
    t.overlay.showAfterCapture();
    assert.ok(t.find('done').focusCalls >= 1);
  });

  it('lets go of Done when the panel is not at its end any more', () => {
    const t = ended();
    t.overlay.setStatus(status({ progress: 0.7, atEnd: false }));
    assert.equal(t.find('done').blurCalls, 1);
    t.overlay.setStatus(status({ progress: 0.7, atEnd: false }));
    assert.equal(t.find('done').blurCalls, 1, 'once');
  });

  it('with the focus on Done, Enter finishes once and Space still means Scroll', () => {
    const t = ended();
    const enter = t.win.dispatch('keydown', key('Enter', { target: t.host }));
    assert.deepEqual(t.commands, ['done']);
    assert.equal(enter.defaultPrevented, true, 'no second press by the focused button');
    const space = t.win.dispatch('keydown', key(' ', { target: t.host }));
    assert.deepEqual(t.commands, ['done', 'down']);
    assert.equal(space.defaultPrevented, true, 'Space does not press Done');
  });

  it('after Tab the user owns the focus: Enter and Space press the focused button', () => {
    const t = ended();
    t.win.dispatch('keydown', key('Tab', { target: t.host }));
    const enter = t.win.dispatch('keydown', key('Enter', { target: t.host }));
    const space = t.win.dispatch('keydown', key(' ', { target: t.host }));
    assert.deepEqual(t.commands, []);
    assert.equal(enter.defaultPrevented || space.defaultPrevented, false);
    // Esc keeps its meaning.
    t.win.dispatch('keydown', key('Escape', { target: t.host }));
    assert.deepEqual(t.commands, ['cancel']);
  });

  it('without the end of the panel, a focused button keeps Enter and Space', () => {
    const t = ended(false);
    const enter = t.win.dispatch('keydown', key('Enter', { target: t.host }));
    assert.equal(enter.defaultPrevented, false);
    assert.deepEqual(t.commands, []);
  });

  it('a trusted press of the Done button still finishes', () => {
    const t = ended();
    t.find('done').dispatch('click');
    assert.deepEqual(t.commands, ['done']);
  });
});
