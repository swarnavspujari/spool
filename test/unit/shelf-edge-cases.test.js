// @ts-check
/**
 * More tests for src/page/shelf.js, written from mutation testing:
 * the namespace, the config checks at their edges, the age text, the thumbnail size, every state
 * of a chip and of the full-image button, the order of events when the shelf closes, and what the
 * status line says for each outcome. Same fake page as shelf.test.js.
 */
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { describe, it } from 'node:test';
import { ERR, MSG, PROTOCOL_VERSION, TARGET } from '../../src/shared/protocol.js';
import {
  FakeElement,
  findAll,
  findOne,
  flush,
  setupCards,
  textOf,
} from '../helpers/fake-card-dom.js';
import { loadClassic } from '../helpers/load-classic.js';

const TOKEN = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const PNG_BASE64 = 'iVBORw0KGgo=';
const MINUTE = 60_000;
const DWELL_MS = 450;

/** @param {Record<string, unknown>} [more] */
function config(more = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    mode: 'shelf',
    shelfToken: TOKEN,
    msg: MSG,
    err: ERR,
    target: TARGET,
    ...more,
  };
}

/** @param {Record<string, unknown>} [more] */
function summary(more = {}) {
  return {
    sessionId: SESSION,
    title: 'Draft 3 review',
    createdAt: Date.now(),
    widthPx: 1500,
    heightPx: 6240,
    tileCount: 3,
    tileTier: 'standard',
    fitsOneImage: false,
    fullBytes: 1000,
    thumbnailPngBase64: PNG_BASE64,
    thumbnailWidthPx: 320,
    thumbnailHeightPx: 480,
    save: { location: 'folder', label: 'Pictures', files: 4, needsPermission: false },
    warnings: [],
    ...more,
  };
}

/**
 * @param {{ info?: unknown, replies?: Record<string, (msg: any) => unknown>,
 *   config?: Record<string, unknown> | null }} [options]
 */
function setup({ info = summary(), replies = {}, config: cfg = config() } = {}) {
  const t = setupCards({
    files: ['src/page/ui-kit.js', 'src/page/shelf.js'],
    config: cfg ?? undefined,
    replies: {
      [MSG.PAGE_SHELF_INFO]: () => ({ ok: true, summary: info }),
      [MSG.PAGE_SHELF_GET]: () => ({ ok: true, pngBase64: PNG_BASE64 }),
      ...replies,
    },
  });
  assert.ok(t.ns.shelf, 'shelf.js must register __spool.shelf');
  return t;
}

/** @param {ReturnType<typeof setup>} t */
async function open(t) {
  t.ns.shelf.start();
  await flush();
  await flush();
  t.timers.advance(DWELL_MS); // Insert stays off for 400 ms after the card appears
  const host = /** @type {FakeElement} */ (t.hosts().at(-1));
  assert.ok(host, 'a shelf host is on screen');
  const root = t.rootOf(host);
  const statusBox = () => findAll(root, (e) => e.className === 'status')[0];
  return {
    host,
    root,
    surface: findOne(root, (e) => e.className === 'card', 'card'),
    statusBox,
    status: () => textOf(statusBox()),
    button: (/** @type {string} */ label) =>
      findOne(
        root,
        (e) =>
          e.tagName === 'BUTTON' &&
          (textOf(e).trim() === label || e.attributes.get('aria-label') === label),
        `button "${label}"`,
      ),
    chips: () => findAll(root, (e) => e.className === 'chip'),
    thumb: () => findOne(root, (e) => e.className === 'thumb', 'thumb'),
    canvas: () => findOne(root, (e) => e.tagName === 'CANVAS', 'canvas'),
    caption: () => textOf(findAll(root, (e) => e.className === 'caption')[0]),
    title: () => textOf(findOne(root, (e) => e.className === 'title', 'title')),
  };
}

/** @param {boolean} accepts */
function editor(accepts) {
  const el = new FakeElement('div');
  el.isContentEditable = true;
  /** @type {any[]} */
  const pastes = [];
  el.addEventListener('paste', (/** @type {any} */ event) => {
    pastes.push(event);
    if (accepts) event.preventDefault();
  });
  return { el, pastes };
}

/** The path of the first icon in a node: tells which icon it is. @param {any} node */
function iconPath(node) {
  const [svg] = findAll(node, (e) => e.tagName === 'SVG');
  const path = svg ? findAll(svg, (e) => e.tagName === 'PATH')[0] : undefined;
  return path?.attributes.get('d');
}

describe('shelf.js: the namespace and the kit', () => {
  it('stops with a clear message when the kit did not load first', () => {
    assert.throws(() => loadClassic('src/page/shelf.js', { __spool: {} }), {
      message: 'Spool: ui-kit.js must load before shelf.js.',
    });
  });

  it('does not trust a namespace that is not a plain object, and makes its own', () => {
    const clobbered = Object.create({ [Symbol.toStringTag]: 'HTMLFormElement' });
    clobbered.ui = {}; // a kit that markup put there: the shelf must not take it
    assert.throws(() => loadClassic('src/page/shelf.js', { __spool: clobbered }), {
      message: 'Spool: ui-kit.js must load before shelf.js.',
    });
  });

  it('makes the namespace an own, hidden, replaceable property when there is none', () => {
    const context = vm.createContext({});
    assert.throws(() => loadClassic('src/page/shelf.js', context));
    const descriptor = Object.getOwnPropertyDescriptor(context, '__spool');
    assert.ok(descriptor, 'an own property of the global');
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
  });
});

describe('shelf.js: the config at its edges', () => {
  it('a token of 64 characters opens the shelf, one of 65 or none does not', async () => {
    const ok = setup({ config: config({ shelfToken: 'x'.repeat(64) }) });
    ok.ns.shelf.start();
    await flush();
    assert.equal(ok.hosts().length, 1);
    assert.equal(ok.sent[0]?.token, 'x'.repeat(64));

    for (const shelfToken of ['x'.repeat(65), '', 7, undefined]) {
      const t = setup({ config: config({ shelfToken }) });
      t.ns.shelf.start();
      await flush();
      assert.deepEqual(t.hosts(), [], JSON.stringify(shelfToken));
      assert.deepEqual(t.sent, []);
    }
  });

  it('a config without a message table, an error table or a target does nothing', async () => {
    for (const missing of ['msg', 'err', 'target']) {
      const t = setup({ config: config({ [missing]: undefined }) });
      assert.doesNotThrow(() => t.ns.shelf.start());
      await flush();
      assert.deepEqual(t.hosts(), [], missing);
    }
    const bad = setup({ config: config({ target: { SW: 5 } }) });
    bad.ns.shelf.start();
    await flush();
    assert.deepEqual(bad.hosts(), []);
  });

  it('a tile count with a fraction is cut, and one below 1 is the empty state', async () => {
    const fraction = await open(setup({ info: summary({ tileCount: 2.9 }) }));
    assert.equal(fraction.caption(), '2 AI screenshots from a local page, just now.');
    assert.equal(fraction.chips().length, 2);
    for (const tileCount of [0.9, -1, Number.NaN, '3', undefined]) {
      const t = setup({ info: summary({ tileCount }) });
      const shelf = await open(t);
      assert.equal(textOf(shelf.surface).includes('Nothing to insert yet'), true, String(tileCount));
    }
  });
});

describe('shelf.js: the source and the age in the caption', () => {
  /** @param {number} ageMs */
  async function captionFor(ageMs) {
    const t = setup({ info: summary({ createdAt: Date.now() - ageMs }) });
    return (await open(t)).caption();
  }

  it('says "just now", minutes or hours, counted down to whole minutes', async () => {
    const lead = '3 AI screenshots from a local page';
    assert.equal(await captionFor(0), `${lead}, just now.`);
    assert.equal(await captionFor(59 * 1000), `${lead}, just now.`);
    assert.equal(await captionFor(MINUTE + 500), `${lead}, 1 min ago.`);
    assert.equal(await captionFor(59 * MINUTE + 500), `${lead}, 59 min ago.`);
    assert.equal(await captionFor(60 * MINUTE + 500), `${lead}, 1 h ago.`);
    assert.equal(await captionFor(125 * MINUTE), `${lead}, 2 h ago.`);
    assert.equal(await captionFor(-5 * MINUTE), `${lead}, just now.`, 'a clock that is ahead');
  });

  it('leaves the age out when the time is not known', async () => {
    for (const createdAt of [undefined, 'yesterday', Number.NaN, Number.POSITIVE_INFINITY]) {
      const t = setup({ info: summary({ createdAt }) });
      assert.equal(
        (await open(t)).caption(),
        '3 AI screenshots from a local page.',
        String(createdAt),
      );
    }
  });

  it('a size that is not a whole positive number counts as 0: the full image can be copied', async () => {
    const t = setup({
      info: summary({ widthPx: Number.POSITIVE_INFINITY, heightPx: -3, createdAt: undefined }),
    });
    const shelf = await open(t);
    assert.equal(shelf.button('Copy full image').disabled, false);
  });

  it('names the host of the captured page, and says "a local page" without one', async () => {
    const named = await open(setup({ info: summary({ sourceHost: 'github.com' }) }));
    assert.equal(named.caption(), '3 AI screenshots from github.com, just now.');
    const bad = await open(setup({ info: summary({ sourceHost: 7 }) }));
    assert.equal(bad.caption(), '3 AI screenshots from a local page, just now.');
  });

  it('names the capture by its tile count', async () => {
    const many = await open(setup({ info: summary({ tileCount: 1200 }) }));
    assert.ok(many.caption().startsWith('1,200 AI screenshots from'));
    const one = await open(setup({ info: summary({ tileCount: 1, fitsOneImage: true }) }));
    assert.ok(one.caption().startsWith('1 AI screenshot from'));
    assert.equal(findAll(one.root, (e) => e.id === 'tile-label').length, 0);
  });
});

describe('shelf.js: the thumbnail', () => {
  it('sizes the box by the ratio of the thumbnail, between 28 px and 82 px', async () => {
    /** @type {[number, number, string][]} */
    const cases = [
      [320, 480, '82px'],
      [320, 250, '44px'],
      [320, 229, '40px'],
      [320, 100, '28px'],
      [0, 0, '82px'],
      [320, 0, '82px'],
      [0, 480, '82px'],
    ];
    for (const [w, h, height] of cases) {
      const shelf = await open(setup({ info: summary({ thumbnailWidthPx: w, thumbnailHeightPx: h }) }));
      assert.equal(shelf.thumb().style['width'], '56px');
      assert.equal(shelf.thumb().style['height'], height, `${w} x ${h}`);
      assert.equal(shelf.thumb().attributes.get('aria-hidden'), 'true');
    }
  });

  it('draws the canvas at the device pixel ratio, rounded, between 1 and 3', async () => {
    /** @type {[number, number, number][]} */
    const cases = [
      [1.2, 67, 98],
      [1.75, 98, 144],
      [5, 168, 246],
      [0.5, 56, 82],
      [Number.NaN, 56, 82],
    ];
    for (const [dpr, width, height] of cases) {
      const t = setup();
      t.context.devicePixelRatio = dpr;
      const shelf = await open(t);
      assert.equal(shelf.canvas().width, width, `dpr ${dpr}`);
      assert.equal(shelf.canvas().height, height, `dpr ${dpr}`);
    }
  });
});

describe('shelf.js: the parts of the card', () => {
  it('every button is a plain button; the close button has a title and an icon', async () => {
    const shelf = await open(setup());
    const buttons = findAll(shelf.root, (e) => e.tagName === 'BUTTON');
    assert.equal(buttons.length, 1 + 1 + 3 + 1, 'close, insert, three chips, full image');
    for (const button of buttons) assert.equal(button.type, 'button', textOf(button));
    const close = shelf.button('Close (Esc)');
    assert.equal(close.title, 'Close (Esc)');
    assert.equal(iconPath(close), 'M4 4L12 12M12 4L4 12');
    assert.equal(iconPath(shelf.button('Insert 3 screenshots')), 'M8 2.5V10M4.5 6.5L8 10L11.5 6.5M3 13.5H13');
    assert.equal(iconPath(shelf.button('Copy full image')), 'M5.5 5.5H13V13H5.5Z');
  });

  it('the status line is a polite live region, and the chips are a labelled group', async () => {
    const shelf = await open(setup());
    assert.equal(shelf.statusBox()?.attributes.get('role'), 'status');
    assert.equal(shelf.statusBox()?.attributes.get('aria-live'), 'polite');
    const label = findOne(shelf.root, (e) => e.id === 'tile-label', 'label');
    assert.equal(textOf(label), 'Or copy one at a time');
    const group = findOne(shelf.root, (e) => e.className === 'chips', 'group');
    assert.equal(group.attributes.get('role'), 'group');
    assert.equal(group.attributes.get('aria-labelledby'), 'tile-label');
    assert.equal('open' in shelf.root.dataset, true);
  });

  it('the empty state is a status with the glyph, the message and the close button', async () => {
    const shelf = await open(setup({ info: null }));
    const row = findOne(shelf.root, (e) => e.className === 'empty', 'empty row');
    assert.equal(row.attributes.get('role'), 'status');
    const tile = findOne(shelf.root, (e) => e.className === 'tile', 'tile');
    assert.equal(tile.attributes.get('aria-hidden'), 'true');
    assert.equal(findAll(tile, (e) => e.tagName === 'SVG').length, 1, 'the glyph');
    assert.equal(
      textOf(findAll(row, (e) => e.tagName === 'P')[0]),
      'Nothing to insert yet. Press Alt+Shift+S to spool a page.',
    );
    assert.equal(shelf.button('Close (Esc)').type, 'button');
  });

  it('the loading card says so until the service worker answers', async () => {
    const t = setup();
    t.ns.shelf.start();
    const host = /** @type {FakeElement} */ (t.hosts().at(-1));
    const root = t.rootOf(host);
    assert.equal(textOf(root), 'Loading…');
    assert.equal('open' in root.dataset, true);
    await flush();
    await flush();
    assert.equal(textOf(root).includes('Loading'), false);
  });
});

describe('shelf.js: chips and the full-image button show every state', () => {
  it('a chip says that it copies, then that it worked or failed, then goes back', async () => {
    const t = setup();
    const shelf = await open(t);
    const chip = /** @type {FakeElement} */ (shelf.chips()[1]);
    assert.equal(chip.dataset['state'], 'idle');
    chip.dispatch('click');
    assert.equal(chip.dataset['state'], 'pending');
    assert.equal(chip.attributes.get('aria-label'), 'Copy screenshot 2');
    assert.equal(iconPath(chip), 'M8 2.5A5.5 5.5 0 1 1 2.5 8');
    assert.equal(textOf(chip), '2');
    await flush();
    await flush();
    assert.equal(chip.attributes.get('aria-label'), 'Screenshot 2 copied');
    assert.equal(iconPath(chip), 'M3 8.5L6.5 12L13 4.5');
    t.timers.advance(1999);
    assert.equal(chip.dataset['state'], 'copied');
    t.timers.advance(1);
    assert.equal(chip.dataset['state'], 'idle');
    assert.equal(chip.attributes.get('aria-label'), 'Copy screenshot 2');

    t.clipboard.reject = true;
    const other = /** @type {FakeElement} */ (shelf.chips()[2]);
    other.dispatch('click');
    await flush();
    await flush();
    assert.equal(textOf(other), '3 · Failed');
    assert.equal(other.attributes.get('aria-label'), 'Screenshot 3 not copied');
  });

  it('a chip that is copying ignores a second click', async () => {
    const t = setup({ replies: { [MSG.PAGE_SHELF_GET]: () => new Promise(() => {}) } });
    const shelf = await open(t);
    const chip = /** @type {FakeElement} */ (shelf.chips()[0]);
    chip.dispatch('click');
    chip.dispatch('click');
    assert.equal(t.clipboard.writes.length, 1);
  });

  it('the full-image button says "Copied", then goes back; and "Not copied" when it failed', async () => {
    const t = setup();
    const shelf = await open(t);
    const full = shelf.button('Copy full image');
    full.dispatch('click');
    assert.equal(full.dataset['state'], 'pending');
    full.dispatch('click'); // copying: ignored
    assert.equal(t.clipboard.writes.length, 1);
    await flush();
    await flush();
    assert.equal(textOf(full), 'Copied');
    t.timers.advance(2000);
    assert.equal(textOf(full), 'Copy full image');
    assert.equal(full.dataset['state'], 'idle');

    t.clipboard.reject = true;
    full.dispatch('click');
    await flush();
    await flush();
    assert.equal(textOf(full), 'Not copied');
    assert.equal(shelf.status(), 'Could not copy on this page.');
    assert.equal(shelf.statusBox()?.dataset['level'], 'error');
    assert.equal(iconPath(shelf.statusBox()), 'M8 2.5L14 13H2Z');
  });

  it('shows the reason of a refusal instead of the general text, and clears it for the next try', async () => {
    let refuse = true;
    const t = setup({
      replies: {
        [MSG.PAGE_SHELF_GET]: () =>
          refuse
            ? { ok: false, error: { code: ERR.SESSION_NOT_FOUND, message: 'A newer capture exists.' } }
            : { ok: true, pngBase64: PNG_BASE64 },
      },
    });
    const shelf = await open(t);
    const full = shelf.button('Copy full image');
    full.dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), 'A newer capture exists.');

    refuse = false;
    t.clipboard.reject = true; // now the browser refuses: the old reason must not show
    full.dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Could not copy on this page.');
  });

  it('a copy that finishes after the shelf closed leaves no timer', async () => {
    const t = setup();
    const shelf = await open(t);
    shelf.button('Copy full image').dispatch('click');
    t.ns.shelf.dismiss();
    t.timers.advance(167);
    await flush();
    await flush();
    assert.equal(t.timers.pending, 0);
    assert.equal(shelf.host.removed, true);
  });

  it('a timer of a finished copy goes with the shelf', async () => {
    const t = setup();
    const shelf = await open(t);
    shelf.button('Copy full image').dispatch('click');
    await flush();
    await flush();
    t.ns.shelf.dismiss();
    t.timers.advance(167);
    assert.equal(t.timers.pending, 0, 'the 2 s timer was cleared');
  });
});

describe('shelf.js: what the status line says for an insert', () => {
  it('says "Inserting…" while the tiles load, as information', async () => {
    const t = setup({ replies: { [MSG.PAGE_SHELF_GET]: () => new Promise(() => {}) } });
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    assert.equal(shelf.status(), 'Inserting…');
    assert.equal(shelf.statusBox()?.dataset['level'], 'info');
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true);
  });

  it('"Inserted" is a success with a check mark, and the shelf closes 2 s later', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.statusBox()?.dataset['level'], 'ok');
    assert.equal(iconPath(shelf.statusBox()), 'M3 8.5L6.5 12L13 4.5');
    t.timers.advance(1999);
    assert.equal('closing' in shelf.root.dataset, false);
    t.timers.advance(1);
    assert.equal('closing' in shelf.root.dataset, true);
    assert.equal(shelf.host.removed, false);
    t.timers.advance(167);
    assert.equal(shelf.host.removed, true);
  });

  it('a refusal of the page opens the steps: one screenshot at a time', async () => {
    const t = setup();
    const target = editor(false);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 1);
    assert.equal(shelf.title(), "This chat won't take them all at once.");
    assert.ok(shelf.button('Copy screenshot 1 of 3'));
    assert.equal(findAll(shelf.root, (e) => e.textContent === 'Insert 3 screenshots').length, 0);
  });

  it('a service worker refusal keeps the card and shows its message, with a warning mark', async () => {
    const t = setup({
      replies: {
        [MSG.PAGE_SHELF_GET]: () => ({
          ok: false,
          error: { code: ERR.SESSION_NOT_FOUND, message: 'This shelf has expired.' },
        }),
      },
    });
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.statusBox()?.dataset['level'], 'error');
    assert.equal(iconPath(shelf.statusBox()), 'M8 2.5L14 13H2Z');
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
    // The text of an earlier refusal does not stay for the next try.
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 0);
  });

  it('an insert that the shelf closed meanwhile dispatches nothing', async () => {
    /** @type {(value: unknown) => void} */
    let answer = () => {};
    const t = setup({
      replies: { [MSG.PAGE_SHELF_GET]: () => new Promise((resolve) => (answer = resolve)) },
    });
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    t.ns.shelf.dismiss();
    t.timers.advance(167);
    answer({ ok: true, pngBase64: PNG_BASE64 });
    await flush();
    await flush();
    assert.equal(target.pastes.length, 0);
    assert.equal(t.timers.pending, 0);
    assert.equal(shelf.host.removed, true);
  });

  it('a page that throws while it takes the paste is a refusal, not a crash', async () => {
    const t = setup();
    const target = new FakeElement('div');
    target.isContentEditable = true;
    target.addEventListener('paste', () => {
      throw new Error('the editor broke');
    });
    t.page.activeElement = target;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.title(), "This chat won't take them all at once.");
  });
});

describe('shelf.js: closing', () => {
  it('Esc, the close button and dismiss() close with the animation, in that order of events', async () => {
    const t = setup();
    const first = await open(t);
    const listener = t.win.listeners.get('keydown')?.[0];
    assert.equal(listener?.capture, true, 'it sees the key before the page does');
    t.win.dispatch('keydown', { key: 'Escape' });
    assert.equal('closing' in first.root.dataset, true);
    assert.equal(first.host.removed, false);
    t.timers.advance(167);
    assert.equal(first.host.removed, true);

    const second = await open(t);
    second.button('Close (Esc)').dispatch('click');
    assert.equal('closing' in second.root.dataset, true);

    const third = await open(t);
    t.ns.shelf.dismiss();
    assert.equal('closing' in third.root.dataset, true);
  });

  it('Esc is left alone while the user composes text, and with Meta, Alt or Ctrl', async () => {
    const t = setup();
    const shelf = await open(t);
    for (const mod of ['isComposing', 'metaKey', 'altKey', 'ctrlKey']) {
      t.win.dispatch('keydown', { key: 'Escape', [mod]: true });
    }
    t.win.dispatch('keydown', { key: 'Enter' });
    assert.equal('closing' in shelf.root.dataset, false);
    assert.equal(t.win.dispatch('keydown', { key: 'Escape' }).defaultPrevented, true);
    assert.equal('closing' in shelf.root.dataset, true);
  });

  it('a new shelf closes the old one for good: no key listener of it, no animation', async () => {
    const t = setup();
    const first = await open(t);
    const second = await open(t);
    assert.equal(t.win.listenerCount('keydown'), 1, 'only the new shelf listens');
    assert.equal('closing' in first.root.dataset, false, 'it goes at once');
    assert.equal(first.host.removed, true);
    assert.equal(second.host.removed, false);
  });

  it('a shelf that the extension left behind goes at once, without an animation', async () => {
    const t = setup();
    const shelf = await open(t);
    t.extension.id = undefined;
    t.timers.advance(1000);
    assert.equal(shelf.host.removed, true);
    assert.equal('closing' in shelf.root.dataset, false);
    assert.equal(t.timers.pending, 0);
  });

  it('a close while "Inserted" waits cancels the timer of the shelf', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    t.win.dispatch('keydown', { key: 'Escape' });
    t.timers.advance(167);
    assert.equal(t.timers.pending, 0, 'the 2 s timer is gone');
    assert.equal(shelf.host.removed, true);
  });
});

describe('shelf.js: exact edges of the age text', () => {
  const NOW = 1_700_000_000_000;

  /** @param {number} ageMs */
  async function captionAt(ageMs) {
    const t = setup({ info: summary({ createdAt: NOW - ageMs, widthPx: 100, heightPx: 200 }) });
    t.context.Date = { now: () => NOW };
    return (await open(t)).caption();
  }

  it('turns to minutes at 60 s and to hours at 60 min, counting the minute as 60,000 ms', async () => {
    const lead = '3 AI screenshots from a local page';
    assert.equal(await captionAt(59_999), `${lead}, just now.`);
    assert.equal(await captionAt(60_000), `${lead}, 1 min ago.`);
    assert.equal(await captionAt(119_999), `${lead}, 1 min ago.`);
    assert.equal(await captionAt(3_599_940), `${lead}, 59 min ago.`);
    assert.equal(await captionAt(3_599_999), `${lead}, 59 min ago.`);
    assert.equal(await captionAt(3_600_000), `${lead}, 1 h ago.`);
    assert.equal(await captionAt(7_199_999), `${lead}, 1 h ago.`);
    assert.equal(await captionAt(7_200_000), `${lead}, 2 h ago.`);
  });
});

describe('shelf.js: more of the card', () => {
  it('draws the thumbnail from the bytes of the summary', async () => {
    const t = setup();
    const shelf = await open(t);
    await flush();
    assert.equal(shelf.canvas().drawn.length, 1);
    assert.equal(shelf.surface.attributes.get('aria-label'), 'Spool: last capture');
  });

  it('the empty state takes the loading card away', async () => {
    const shelf = await open(setup({ info: null }));
    assert.equal(textOf(shelf.root).includes('Loading'), false);
    const none = await open(setup({ info: summary({ tileCount: 0 }) }));
    assert.equal(textOf(none.root).includes('Loading'), false);
  });

  it('the clipboard gets the bytes of the tile or of the full image', async () => {
    const t = setup();
    const shelf = await open(t);
    shelf.chips()[0]?.dispatch('click');
    shelf.button('Copy full image').dispatch('click');
    for (const write of t.clipboard.writes) {
      const blob = await write.image;
      assert.equal(blob.type, 'image/png');
      assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    }
    assert.equal(t.clipboard.writes.length, 2);
  });

  it('the small icons are 14 px: the chip states and the status line', async () => {
    const t = setup();
    const shelf = await open(t);
    const width = (/** @type {any} */ node) => findAll(node, (e) => e.tagName === 'SVG')[0]?.attributes.get('width');
    const chip = /** @type {FakeElement} */ (shelf.chips()[0]);
    chip.dispatch('click');
    assert.equal(width(chip), '14', 'spinner');
    await flush();
    await flush();
    assert.equal(width(chip), '14', 'check mark');
    t.clipboard.reject = true;
    shelf.button('Copy full image').dispatch('click');
    await flush();
    await flush();
    assert.equal(width(shelf.statusBox()), '14', 'status');
  });

  it('a late answer of an insert after the shelf closed does not change the status line', async () => {
    /** @type {(value: unknown) => void} */
    let answer = () => {};
    const t = setup({
      replies: { [MSG.PAGE_SHELF_GET]: () => new Promise((resolve) => (answer = resolve)) },
    });
    const target = editor(false);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    assert.equal(shelf.status(), 'Inserting…');
    t.ns.shelf.dismiss();
    answer({ ok: false, error: { code: ERR.SESSION_NOT_FOUND, message: 'Too late.' } });
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Inserting…');
  });
});

describe('shelf.js: the focus is in a frame', () => {
  /** @param {number} tileCount */
  async function openInFrame(tileCount = 3) {
    const t = setup({ info: summary({ tileCount, fitsOneImage: tileCount === 1 }) });
    t.page.activeElement = new FakeElement('iframe');
    const shelf = await open(t);
    return { t, shelf };
  }

  it('disables Insert and says why; the tiles can still be copied', async () => {
    const { t, shelf } = await openInFrame();
    const insert = shelf.button('Insert 3 screenshots');
    assert.equal(insert.disabled, true);
    assert.equal(shelf.status(), 'Spool cannot insert into an embedded frame. Click a number to copy one instead.');
    assert.equal(shelf.statusBox()?.dataset['level'], 'error');
    shelf.chips()[0]?.dispatch('click');
    assert.equal(t.clipboard.writes.length, 1);
  });

  it('a click on Insert dispatches nothing and asks for no tile', async () => {
    const { t, shelf } = await openInFrame();
    const before = t.sent.length;
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(t.sent.length, before, 'no page/shelf-get');
    assert.equal(shelf.status(), 'Spool cannot insert into an embedded frame. Click a number to copy one instead.');
  });

  it('one image: the text points to Copy full image', async () => {
    const { shelf } = await openInFrame(1);
    assert.equal(shelf.status(), 'Spool cannot insert into an embedded frame. Click Copy full image.');
    assert.equal(shelf.button('Insert 1 screenshot').disabled, true);
  });

  it('with the focus in a field of the page itself, Insert works', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
    assert.equal(shelf.status(), '');
  });
});
