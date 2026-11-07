// @ts-check
/**
 * Tests for the parts of src/page/ui-kit.js that decide where a paste goes and how it is cut up:
 * `takesPaste`, `pickComposer`, `findComposer`, `findPasteTarget`, `planBatches`, `mapLimit`, and
 * the keys of the texts (`keysOf`, `withKeys`). The page is the fake one of
 * test/helpers/fake-card-dom.js.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FakeElement, FakePopoverElement, flush, setupCards } from '../helpers/fake-card-dom.js';

/** Objects of the vm realm: copy them to this realm before they are compared. @param {any} v */
const clone = (v) => JSON.parse(JSON.stringify(v));

/** @param {Parameters<typeof setupCards>[0]} [options] */
function page(options = { files: ['src/page/ui-kit.js'] }) {
  const t = setupCards({ ...options, files: options.files ?? ['src/page/ui-kit.js'] });
  return { t, ui: /** @type {any} */ (t.ns.ui) };
}

/**
 * An editable element at a place on the screen.
 * @param {string} tag
 * @param {{ top: number, bottom: number, left?: number, right?: number }} box
 * @param {{ editable?: boolean }} [options]
 */
function editorAt(tag, box, { editable = true } = {}) {
  const el = new FakeElement(tag);
  const left = box.left ?? 100;
  const right = box.right ?? 700;
  el.rect = {
    top: box.top,
    bottom: box.bottom,
    left,
    right,
    width: right - left,
    height: box.bottom - box.top,
  };
  el.isContentEditable = editable;
  return el;
}

describe('ui.takesPaste', () => {
  it('is true for a textarea, an input and an editable element', () => {
    const { ui } = page();
    assert.equal(ui.takesPaste(new FakeElement('textarea')), true);
    assert.equal(ui.takesPaste(new FakeElement('input')), true);
    const div = new FakeElement('div');
    div.isContentEditable = true;
    assert.equal(ui.takesPaste(div), true);
  });

  it('is false for a button, a plain element, null and a value that cannot be read', () => {
    const { ui } = page();
    assert.equal(ui.takesPaste(new FakeElement('button')), false);
    assert.equal(ui.takesPaste(new FakeElement('div')), false);
    assert.equal(ui.takesPaste(null), false);
    const broken = {
      get tagName() {
        throw new Error('blocked');
      },
    };
    assert.equal(ui.takesPaste(broken), false);
  });
});

describe('ui.pickComposer', () => {
  const at = (/** @type {string} */ item, /** @type {number[]} */ [top, bottom, left, right]) => ({
    item,
    top: /** @type {number} */ (top),
    bottom: /** @type {number} */ (bottom),
    left: /** @type {number} */ (left),
    right: /** @type {number} */ (right),
  });

  it('gives null for no editor', () => {
    assert.equal(page().ui.pickComposer([]), null);
  });

  it('takes the one that sits lowest: a chat box is at the bottom', () => {
    const { ui } = page();
    const title = at('title', [10, 50, 0, 900]); // wide, but at the top
    const box = at('box', [700, 760, 100, 700]);
    assert.equal(ui.pickComposer([title, box]), 'box');
    assert.equal(ui.pickComposer([box, title]), 'box', 'in any order');
  });

  it('among editors whose bottoms are within 48 px, takes the largest', () => {
    const { ui } = page();
    const small = at('small', [740, 760, 100, 300]);
    const big = at('big', [700, 740, 100, 700]); // bottom 20 px higher, much larger
    assert.equal(ui.pickComposer([small, big]), 'big');
    const farAbove = at('far', [200, 300, 0, 1000]); // larger, but 460 px higher
    assert.equal(ui.pickComposer([small, farAbove]), 'small');
  });

  it('48 px is the edge: 48 still counts as close, 49 does not', () => {
    const { ui } = page();
    const low = at('low', [940, 1000, 0, 100]);
    const big = (/** @type {number} */ bottom) => at('big', [bottom - 100, bottom, 0, 1000]);
    assert.equal(ui.pickComposer([low, big(952)]), 'big');
    assert.equal(ui.pickComposer([low, big(951)]), 'low');
  });

  it('keeps the first of two that are equal', () => {
    const { ui } = page();
    assert.equal(ui.pickComposer([at('a', [0, 100, 0, 100]), at('b', [0, 100, 0, 100])]), 'a');
  });
});

describe('ui.findComposer', () => {
  it('finds the lowest editor that is on the screen', () => {
    const { t, ui } = page();
    const top = editorAt('div', { top: 20, bottom: 60 });
    const box = editorAt('div', { top: 690, bottom: 760 });
    t.page.editables = [top, box];
    assert.equal(ui.findComposer(), box);
  });

  it('skips an element that is too small, off the screen, or has no size', () => {
    const { t, ui } = page();
    const tiny = editorAt('div', { top: 700, bottom: 710 }); // 10 px high
    const below = editorAt('div', { top: 900, bottom: 960 }); // under an 800 px viewport
    const above = editorAt('div', { top: -80, bottom: -20 });
    const right = editorAt('div', { top: 600, bottom: 700, left: 1100, right: 1300 });
    const none = new FakeElement('div'); // zero rect: display none
    const ok = editorAt('div', { top: 300, bottom: 360 });
    t.page.editables = [tiny, below, above, right, none, ok];
    assert.equal(ui.findComposer(), ok);
  });

  it('gives null when the page has no editor', () => {
    const { ui } = page();
    assert.equal(ui.findComposer(), null);
  });

  it('looks into open shadow roots', () => {
    const { t, ui } = page();
    const inner = editorAt('div', { top: 700, bottom: 760 });
    const host = new FakeElement('chat-widget');
    host.shadowRoot = /** @type {any} */ ({
      host,
      querySelectorAll: (/** @type {string} */ selector) => (selector.includes('contenteditable') ? [inner] : []),
    });
    t.page.shadowRoots = [host.shadowRoot];
    const light = editorAt('div', { top: 100, bottom: 140 });
    t.page.editables = [light];
    assert.equal(ui.findComposer(), inner, 'the lower one is in the shadow root');
  });

  it('never throws: a page that breaks the query gives null', () => {
    const { t, ui } = page();
    t.context.document.querySelectorAll = () => {
      throw new Error('blocked');
    };
    assert.equal(ui.findComposer(), null);
  });

  it('asks for editable elements that are not disabled, not read-only and not contenteditable=false', () => {
    const { t, ui } = page();
    /** @type {string[]} */
    const asked = [];
    const original = t.context.document.querySelectorAll;
    t.context.document.querySelectorAll = (/** @type {string} */ selector) => {
      asked.push(selector);
      return original(selector);
    };
    ui.findComposer();
    const editable = asked.find((s) => s.includes('contenteditable')) ?? '';
    assert.ok(editable.includes('textarea:not([disabled]):not([readonly])'));
    assert.ok(editable.includes('[contenteditable]:not([contenteditable="false"])'));
  });
});

describe('ui.findPasteTarget', () => {
  it('takes the editor that has the focus', () => {
    const { t, ui } = page();
    const focused = editorAt('div', { top: 100, bottom: 160 });
    const lower = editorAt('div', { top: 690, bottom: 760 });
    t.page.editables = [focused, lower];
    t.page.activeElement = focused;
    assert.deepEqual({ ...ui.findPasteTarget() }, { element: focused, kind: 'focused' });
  });

  it('finds the composer when nothing has the focus', () => {
    const { t, ui } = page();
    const box = editorAt('div', { top: 690, bottom: 760 });
    t.page.editables = [box];
    const found = ui.findPasteTarget();
    assert.equal(found.element, box);
    assert.equal(found.kind, 'composer');
  });

  it('finds the new composer when the remembered one left the page', () => {
    const { t, ui } = page();
    const old = editorAt('div', { top: 690, bottom: 760 });
    const fresh = editorAt('div', { top: 690, bottom: 760 });
    t.page.editables = [fresh];
    old.remove();
    const found = ui.findPasteTarget({ remembered: old });
    assert.equal(found.element, fresh);
    assert.equal(found.kind, 'composer');
  });

  it('uses the remembered editor while it is still in the page, before it looks for another', () => {
    const { t, ui } = page();
    const kept = editorAt('div', { top: 100, bottom: 160 });
    const lower = editorAt('div', { top: 690, bottom: 760 });
    t.page.editables = [kept, lower];
    const found = ui.findPasteTarget({ remembered: kept });
    assert.equal(found.element, kept);
    assert.equal(found.kind, 'focused');
  });

  it('prefers the editor that has the focus now to the remembered one', () => {
    const { t, ui } = page();
    const kept = editorAt('div', { top: 100, bottom: 160 });
    const now = editorAt('div', { top: 300, bottom: 360 });
    t.page.activeElement = now;
    assert.equal(ui.findPasteTarget({ remembered: kept }).element, now);
  });

  it('a focused button does not take a paste: the composer does', () => {
    const { t, ui } = page();
    const box = editorAt('div', { top: 690, bottom: 760 });
    t.page.editables = [box];
    t.page.activeElement = new FakeElement('button');
    const found = ui.findPasteTarget();
    assert.equal(found.element, box);
    assert.equal(found.kind, 'composer');
  });

  it('with no editor in the page, the element that has the focus gets it (kind "other")', () => {
    const { t, ui } = page();
    const button = new FakeElement('button');
    t.page.activeElement = button;
    const found = ui.findPasteTarget();
    assert.equal(found.element, button);
    assert.equal(found.kind, 'other');
  });

  it('with nothing at all, the body gets it (kind "none")', () => {
    const { t, ui } = page();
    const found = ui.findPasteTarget();
    assert.equal(found.element, t.body);
    assert.equal(found.kind, 'none');
  });

  it('ignores the element that the caller says is not the page: the card host', () => {
    const { t, ui } = page();
    const host = new FakeElement('div');
    t.page.activeElement = host;
    const box = editorAt('div', { top: 690, bottom: 760 });
    t.page.editables = [box];
    assert.equal(ui.findPasteTarget({ ignore: host }).element, box);
  });

  it('an element that left the page is not the target, also when it still has the focus', () => {
    const { t, ui } = page();
    const gone = editorAt('div', { top: 100, bottom: 160 });
    t.page.activeElement = gone;
    gone.remove();
    assert.equal(ui.findPasteTarget().element, t.body);
  });

  it('never takes the focus itself', () => {
    const { t, ui } = page();
    const box = editorAt('div', { top: 690, bottom: 760 });
    t.page.editables = [box];
    ui.findPasteTarget();
    assert.equal(box.focusCalls, 0);
  });
});

describe('ui.planBatches', () => {
  it('cuts 26 into 20 and 6, in order', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(page().ui.planBatches(26, 20))), [
      { start: 0, end: 20 },
      { start: 20, end: 26 },
    ]);
  });

  it('keeps 20 or fewer in one batch, and an exact multiple without an empty one', () => {
    const { ui } = page();
    assert.equal(ui.planBatches(5, 20).length, 1);
    assert.equal(ui.planBatches(20, 20).length, 1);
    assert.equal(ui.planBatches(21, 20).length, 2);
    assert.equal(ui.planBatches(40, 20).length, 2);
    assert.equal(ui.planBatches(41, 20).length, 3);
    assert.equal(ui.planBatches(0, 20).length, 0);
  });

  it('covers every index once, for any count', () => {
    const { ui } = page();
    for (const count of [1, 7, 20, 21, 59, 60, 61, 300]) {
      /** @type {number[]} */
      const seen = [];
      for (const b of ui.planBatches(count, 20)) {
        for (let i = b.start; i < b.end; i += 1) seen.push(i);
      }
      assert.deepEqual(seen, Array.from({ length: count }, (_, i) => i), String(count));
    }
  });

  it('takes a limit below 1 as 1, and cuts a fraction down', () => {
    const { ui } = page();
    assert.equal(ui.planBatches(3, 0).length, 3);
    assert.equal(ui.planBatches(3, -4).length, 3);
    assert.equal(ui.planBatches(5, 2.9).length, 3);
  });
});

describe('ui.mapLimit', () => {
  it('gives the results in order, whatever order the work finishes in', async () => {
    const { ui } = page();
    /** @type {((v: number) => void)[]} */
    const finish = [];
    const done = ui.mapLimit(
      4,
      4,
      (/** @type {number} */ i) => new Promise((resolve) => (finish[i] = () => resolve(i * 10))),
    );
    for (const i of [3, 1, 0, 2]) {
      await flush();
      finish[i]?.(0);
    }
    assert.deepEqual(clone(await done), [0, 10, 20, 30]);
  });

  it('runs at most `limit` at once, and starts the next as soon as one is done', async () => {
    const { ui } = page();
    let running = 0;
    let most = 0;
    /** @type {(() => void)[]} */
    const releases = [];
    const done = ui.mapLimit(7, 3, async (/** @type {number} */ i) => {
      running += 1;
      most = Math.max(most, running);
      await new Promise((resolve) => releases.push(() => resolve(undefined)));
      running -= 1;
      return i;
    });
    await flush();
    assert.equal(running, 3, 'three started at once');
    releases.shift()?.();
    await flush();
    assert.equal(running, 3, 'one finished, one more started');
    while (releases.length > 0 || running > 0) {
      releases.shift()?.();
      await flush();
    }
    assert.deepEqual(clone(await done), [0, 1, 2, 3, 4, 5, 6]);
    assert.equal(most, 3);
  });

  it('with a limit of 1 it runs one after the other', async () => {
    const { ui } = page();
    /** @type {number[]} */
    const order = [];
    await ui.mapLimit(4, 1, async (/** @type {number} */ i) => {
      order.push(i);
      await flush();
      order.push(-i);
    });
    assert.deepEqual(order, [0, -0, 1, -1, 2, -2, 3, -3]);
  });

  it('after the first failure it starts no more, waits for those that run, and fails with that error', async () => {
    const { ui } = page();
    /** @type {number[]} */
    const started = [];
    const failure = new Error('tile 1 is gone');
    await assert.rejects(
      ui.mapLimit(10, 2, async (/** @type {number} */ i) => {
        started.push(i);
        await flush();
        if (i === 1) throw failure;
        return i;
      }),
      (e) => e === failure,
    );
    assert.ok(started.length < 10, `only ${started.length} started`);
    assert.ok(!started.includes(9));
  });

  it('keeps the first error when several fail', async () => {
    const { ui } = page();
    await assert.rejects(
      ui.mapLimit(3, 3, async (/** @type {number} */ i) => {
        throw new Error(`failed ${i}`);
      }),
      { message: 'failed 0' },
    );
  });

  it('an empty list gives an empty list, and a limit above the count is fine', async () => {
    const { ui } = page();
    assert.deepEqual(clone(await ui.mapLimit(0, 3, async () => 1)), []);
    assert.deepEqual(clone(await ui.mapLimit(2, 50, async (/** @type {number} */ i) => i)), [0, 1]);
    assert.deepEqual(clone(await ui.mapLimit(2, 0, async (/** @type {number} */ i) => i)), [0, 1]);
  });
});

describe('ui.keysOf and ui.withKeys', () => {
  it('uses the keys that the worker wrote for the system: "⌃⇧V" and "⌘V" on a Mac', () => {
    const { ui } = page();
    const config = {
      keys: {
        start: { parts: ['⌃', '⇧', 'S'], text: '⌃⇧S' },
        insert: { parts: ['⌃', '⇧', 'V'], text: '⌃⇧V' },
        paste: { parts: ['⌘', 'V'], text: '⌘V' },
      },
    };
    assert.deepEqual(JSON.parse(JSON.stringify(ui.keysOf(config, 'insert'))), config.keys.insert);
    assert.deepEqual(JSON.parse(JSON.stringify(ui.keysOf(config, 'paste'))), config.keys.paste);
    assert.equal(ui.withKeys(config, 'A newer capture exists. Press Alt+Shift+V again.'),
      'A newer capture exists. Press ⌃⇧V again.');
    assert.equal(ui.withKeys(config, 'Nothing to insert yet. Press Alt+Shift+S to spool a page.'),
      'Nothing to insert yet. Press ⌃⇧S to spool a page.');
  });

  it('a config from an older worker has no `keys`: the shortcuts are split at "+"', () => {
    const { ui } = page();
    const config = { shortcuts: { start: 'Ctrl+Shift+Y', insert: 'Ctrl+Shift+I' } };
    assert.deepEqual(JSON.parse(JSON.stringify(ui.keysOf(config, 'insert'))), {
      parts: ['Ctrl', 'Shift', 'I'],
      text: 'Ctrl+Shift+I',
    });
    assert.deepEqual(JSON.parse(JSON.stringify(ui.keysOf({}, 'start'))), {
      parts: ['Alt', 'Shift', 'S'],
      text: 'Alt+Shift+S',
    });
  });

  it('a command with no key has no parts', () => {
    const { ui } = page();
    const config = { keys: { start: { parts: [], text: '' }, insert: { parts: [], text: '' } } };
    assert.deepEqual(JSON.parse(JSON.stringify(ui.keysOf(config, 'insert'))), { parts: [], text: '' });
    assert.equal(ui.withKeys(config, 'Press Alt+Shift+V again.'), 'Run Insert last capture again.');
    assert.equal(
      ui.withKeys(config, 'Press Alt+Shift+S to spool a page.'),
      'Click the Spool button to spool a page.',
    );
  });

  it('the Paste key of a config without keys follows the platform: ⌘V on a Mac, Ctrl+V elsewhere', () => {
    for (const [platform, text] of [
      ['MacIntel', '⌘V'],
      ['iPad', '⌘V'],
      ['Win32', 'Ctrl+V'],
      ['Linux x86_64', 'Ctrl+V'],
    ]) {
      const { ui } = page({ files: ['src/page/ui-kit.js'], platform });
      assert.equal(ui.keysOf({}, 'paste').text, text, String(platform));
    }
  });

  it('cuts a key that is too long, and ignores a value that is not text', () => {
    const { ui } = page();
    const long = { keys: { insert: { parts: ['x'.repeat(50)], text: 'y'.repeat(100) } } };
    const got = ui.keysOf(long, 'insert');
    assert.equal(got.parts[0].length, 20);
    assert.equal(got.text.length, 40);
    const bad = { keys: { insert: { parts: [7, 'V', null], text: 'V' } } };
    assert.deepEqual(JSON.parse(JSON.stringify(ui.keysOf(bad, 'insert').parts)), ['V']);
  });
});

describe('the card host can put itself above the page', () => {
  it('raise() hides the popover and shows it again, which puts it last in the top layer', () => {
    const t = setupCards({ files: ['src/page/ui-kit.js'] });
    const card = t.ns.ui.createCardHost('');
    const host = /** @type {FakePopoverElement} */ (/** @type {unknown} */ (card.host));
    const before = { shown: host.shown, hidden: host.hidden };
    card.raise();
    assert.equal(host.hidden, before.hidden + 1);
    assert.equal(host.shown, before.shown + 1);
  });

  it('raise() after destroy does nothing, and never throws', () => {
    const t = setupCards({ files: ['src/page/ui-kit.js'] });
    const card = t.ns.ui.createCardHost('');
    const host = /** @type {FakePopoverElement} */ (/** @type {unknown} */ (card.host));
    card.destroy();
    const shown = host.shown;
    assert.doesNotThrow(() => card.raise());
    assert.equal(host.shown, shown);
  });

  it('a browser without popovers: raise() does nothing', () => {
    const t = setupCards({ files: ['src/page/ui-kit.js'], popover: false });
    const card = t.ns.ui.createCardHost('');
    assert.doesNotThrow(() => card.raise());
  });
});
