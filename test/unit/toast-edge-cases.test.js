// @ts-check
/**
 * More tests for src/page/toast.js, written from mutation testing:
 * the namespace, the numbers that come from the service worker, the size of the thumbnail, the
 * countdown arithmetic, the state of every part of the card, and the order of events when the
 * toast closes. Same fake page as toast.test.js.
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

const SESSION = '11111111-1111-4111-8111-111111111111';
const PNG_BASE64 = 'iVBORw0KGgo=';
const CONFIG = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  sessionId: SESSION,
  msg: MSG,
  err: ERR,
  target: TARGET,
});

/** @param {Record<string, unknown>} [more] */
function summary(more = {}) {
  return {
    sessionId: SESSION,
    title: 'Draft 3 review',
    createdAt: 1_700_000_000_000,
    widthPx: 1500,
    heightPx: 2210,
    tileCount: 1,
    tileTier: 'standard',
    fitsOneImage: true,
    fullBytes: 1000,
    thumbnailPngBase64: PNG_BASE64,
    thumbnailWidthPx: 320,
    thumbnailHeightPx: 480,
    save: { location: 'folder', label: 'Pictures › Screenshots', files: 1, needsPermission: false },
    warnings: [],
    ...more,
  };
}

/** @param {Record<string, unknown>} [more] */
const longSummary = (more = {}) =>
  summary({ heightPx: 9000, tileCount: 5, fitsOneImage: false, ...more });

const NOT_SAVED = { location: 'none', label: 'Not saved', files: 0, needsPermission: false };
const NEEDS_PERMISSION = {
  location: 'downloads',
  label: 'Downloads/Spool',
  files: 1,
  needsPermission: true,
};

/** @param {Parameters<typeof setupCards>[0]['replies']} [replies] */
function setup(replies = {}) {
  const t = setupCards({ files: ['src/page/ui-kit.js', 'src/page/toast.js'], replies });
  assert.ok(t.ns.toast, 'toast.js must register __spool.toast');
  return t;
}

/**
 * @param {ReturnType<typeof setup>} t
 * @param {Record<string, unknown>} info
 * @param {'pending' | 'copied' | 'failed' | 'skipped'} [copy]
 */
function show(t, info, copy = 'copied') {
  const handle = t.ns.toast.show({ config: CONFIG, summary: info, copy });
  const host = t.hosts().at(-1);
  assert.ok(host, 'a toast host is on screen');
  const root = t.rootOf(host);
  const byClass = (/** @type {string} */ name) => findAll(root, (e) => e.className === name);
  return {
    handle,
    host,
    root,
    card: findOne(root, (e) => e.className === 'card', 'card'),
    byClass,
    titleBox: () => findOne(root, (e) => e.className === 'title', 'title'),
    title: () => textOf(findOne(root, (e) => e.className === 'title', 'title')),
    caption: () => byClass('caption')[0],
    note: () => /** @type {FakeElement} */ (byClass('caption')[1]),
    iconSlot: () => findOne(root, (e) => e.className === 'icon-slot', 'icon slot'),
    button: (/** @type {string} */ label) =>
      findOne(
        root,
        (e) =>
          e.tagName === 'BUTTON' &&
          (textOf(e).trim() === label || e.attributes.get('aria-label') === label),
        `button "${label}"`,
      ),
    chips: () => byClass('chip'),
    thumb: () => findOne(root, (e) => e.className === 'thumb', 'thumb'),
    canvas: () => findOne(root, (e) => e.tagName === 'CANVAS', 'canvas'),
  };
}

/** The path of the first icon in a node: tells which icon it is. @param {any} node */
function iconPath(node) {
  const [svg] = findAll(node, (e) => e.tagName === 'SVG');
  const path = svg ? findAll(svg, (e) => e.tagName === 'PATH')[0] : undefined;
  return path?.attributes.get('d');
}

describe('toast.js: the namespace and the kit', () => {
  it('stops with a clear message when the kit did not load first', () => {
    assert.throws(() => loadClassic('src/page/toast.js', { __spool: {} }), {
      message: 'Spool: ui-kit.js must load before toast.js.',
    });
  });

  it('does not trust a namespace that is not a plain object, and makes its own', () => {
    const clobbered = Object.create({ [Symbol.toStringTag]: 'HTMLFormElement' });
    clobbered.ui = {}; // a kit that markup put there: the toast must not take it
    assert.throws(() => loadClassic('src/page/toast.js', { __spool: clobbered }), {
      message: 'Spool: ui-kit.js must load before toast.js.',
    });
  });

  it('makes the namespace an own, hidden, replaceable property when there is none', () => {
    const context = vm.createContext({});
    assert.throws(() => loadClassic('src/page/toast.js', context));
    const descriptor = Object.getOwnPropertyDescriptor(context, '__spool');
    assert.ok(descriptor, 'an own property of the global');
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
  });
});

describe('toast.js: numbers and text from the service worker', () => {
  it('a size that is not a whole, finite, positive number is 0', () => {
    const t = setup();
    const toast = show(
      t,
      summary({ widthPx: Number.POSITIVE_INFINITY, heightPx: -5, save: NOT_SAVED }),
    );
    assert.equal(textOf(toast.caption()), '0 × 0 px · Not saved');
    const text = show(t, summary({ widthPx: '1500', heightPx: Number.NaN, save: NOT_SAVED }));
    assert.equal(textOf(text.caption()), '0 × 0 px · Not saved');
  });

  it('a count with a fraction is cut to a whole number, and a bad count is one tile', () => {
    const t = setup();
    const fraction = show(t, longSummary({ tileCount: 2.9 }));
    assert.equal(fraction.chips().length, 2);
    assert.match(textOf(findOne(fraction.root, (e) => e.className === 'hint')), /all 2 screenshots/);
    const negative = show(t, summary({ tileCount: -1, fitsOneImage: false }));
    assert.equal(negative.chips().length, 0, 'one tile is a short toast');
    const infinite = show(t, summary({ tileCount: Number.POSITIVE_INFINITY, fitsOneImage: false }));
    assert.equal(infinite.chips().length, 0);
  });

  it('shows the Paste key of the platform: ⌘ on a Mac or an iPad, Ctrl elsewhere', () => {
    for (const [platform, key] of [
      ['MacIntel', '⌘'],
      ['MACINTEL', '⌘'],
      ['iPhone', '⌘'],
      ['iPad', '⌘'],
      ['Win32', 'Ctrl'],
      ['Linux x86_64', 'Ctrl'],
    ]) {
      const t = setup();
      t.context.navigator.platform = platform;
      const paste = findOne(show(t, summary()).root, (e) => e.className === 'paste small');
      assert.equal(textOf(paste), `Paste${key}V`, String(platform));
    }
    const t = setup();
    Object.defineProperty(t.context.navigator, 'platform', {
      get() {
        throw new Error('blocked');
      },
    });
    const paste = findOne(show(t, summary()).root, (e) => e.className === 'paste small');
    assert.equal(textOf(paste), 'PasteCtrlV');
  });

  it('a capture with no save field is "not saved", and asks for no permission', () => {
    const t = setup();
    const toast = show(t, /** @type {any} */ ({ ...summary(), save: undefined }));
    assert.equal(textOf(toast.caption()), '1,500 × 2,210 px · Not saved');
    assert.equal(toast.title(), 'Copied');
    assert.equal(findAll(toast.root, (e) => e.className === 'permission').length, 0);
  });
});

describe('toast.js: the title, the icon and the levels', () => {
  it('marks an error title, and uses the icon of each state', () => {
    const t = setup();
    const cases = /** @type {const} */ ([
      ['pending', 'info', 'M8 2.5A5.5 5.5 0 1 1 2.5 8'],
      ['copied', 'info', 'M3 8.5L6.5 12L13 4.5'],
      ['failed', 'error', 'M8 2.5L14 13H2Z'],
      ['skipped', 'info', 'M3 8.5L6.5 12L13 4.5'],
    ]);
    for (const [copy, level, path] of cases) {
      const toast = show(t, summary(), copy);
      assert.equal(toast.titleBox().dataset['level'], level, copy);
      assert.equal(iconPath(toast.iconSlot()), path, copy);
    }
  });

  it('the caption is a warning when nothing was saved, unless the copy is pending', () => {
    const t = setup();
    assert.equal(show(t, summary()).caption()?.dataset['level'], 'info');
    assert.equal(show(t, summary({ save: NOT_SAVED })).caption()?.dataset['level'], 'warn');
    assert.equal(show(t, summary({ save: NOT_SAVED }), 'pending').caption()?.dataset['level'], 'info');
  });

  it('the note is an error for a failed copy and a warning for a capture warning', () => {
    const t = setup();
    const failed = show(t, summary(), 'failed');
    assert.equal(failed.note().dataset['level'], 'error');
    assert.equal(failed.note().style['display'], 'block');
    const warned = show(t, summary({ warnings: ['Spool could not verify the last seam.'] }));
    assert.equal(warned.note().dataset['level'], 'warn');
    assert.equal(textOf(warned.note()), 'Spool could not verify the last seam.');
    assert.equal(warned.note().style['display'], 'block');
    const quiet = show(t, summary());
    assert.equal(quiet.note().style['display'], 'none');
  });

  it('"Saved" and "Not saved" when the copy was left out on purpose', () => {
    const t = setup();
    assert.equal(show(t, summary(), 'skipped').title(), 'Saved');
    const unsaved = show(t, summary({ save: NOT_SAVED }), 'skipped');
    assert.equal(unsaved.title(), 'Not saved');
    const paste = findOne(unsaved.root, (e) => e.className === 'paste small');
    assert.equal(paste.style['display'], 'none', 'nothing was copied: no paste hint');
  });

  it('a second setCopy to the same state keeps the card as it is', () => {
    const t = setup();
    const toast = show(t, summary(), 'pending');
    toast.handle?.setCopy('failed', 'Too large.');
    const icon = toast.iconSlot().children[0];
    toast.handle?.setCopy('failed', 'Too large.');
    assert.equal(toast.iconSlot().children[0], icon, 'not drawn again');
    assert.equal(textOf(toast.note()), 'Too large.');
    toast.handle?.setCopy('failed', 'Another reason.');
    assert.equal(textOf(toast.note()), 'Another reason.', 'a new reason is drawn');
  });

  it('a closed toast does not change when it is told how the copy ended', () => {
    const t = setup();
    const toast = show(t, summary(), 'pending');
    toast.handle?.close();
    t.timers.advance(167);
    toast.handle?.setCopy('failed', 'Too late.');
    assert.equal(toast.title(), 'Copying…');
  });
});

describe('toast.js: the thumbnail', () => {
  it('sizes the box by the ratio of the thumbnail, between 28 px and the maximum', () => {
    const t = setup();
    /** @type {[number, number, string][]} */
    const cases = [
      [320, 480, '82px'], // 56 x 1.5 = 84: cut to 82
      [320, 250, '44px'], // 43.75: rounded
      [320, 229, '40px'], // 40.07
      [320, 100, '28px'], // 17.5: raised to 28
    ];
    for (const [w, h, height] of cases) {
      const toast = show(t, summary({ thumbnailWidthPx: w, thumbnailHeightPx: h }));
      assert.equal(toast.thumb().style['width'], '56px');
      assert.equal(toast.thumb().style['height'], height, `${w} x ${h}`);
      assert.equal(toast.thumb().attributes.get('aria-hidden'), 'true');
    }
  });

  it('uses the ratio 1.5 when the size of the thumbnail is not known', () => {
    const t = setup();
    for (const fields of [
      { thumbnailWidthPx: 0, thumbnailHeightPx: 0 },
      { thumbnailWidthPx: 320, thumbnailHeightPx: 0 },
      { thumbnailWidthPx: 0, thumbnailHeightPx: 480 },
    ]) {
      const toast = show(t, summary(fields));
      assert.equal(toast.thumb().style['height'], '82px', JSON.stringify(fields));
    }
    const stack = show(t, longSummary({ thumbnailWidthPx: 0, thumbnailHeightPx: 480 }));
    assert.equal(stack.thumb().style['width'], '30px');
    assert.equal(stack.thumb().style['height'], '45px', '30 x 1.5');
    const tall = show(t, longSummary({ thumbnailWidthPx: 100, thumbnailHeightPx: 400 }));
    assert.equal(tall.thumb().style['height'], '60px', 'cut to the maximum of a stack');
  });

  it('draws the canvas at the device pixel ratio, rounded, between 1 and 3', () => {
    /** @type {[number, number, number][]} */
    const cases = [
      [1.2, 67, 98], // 56 x 1.2 = 67.2; 82 x 1.2 = 98.4
      [1.75, 98, 144], // 82 x 1.75 = 143.5
      [5, 168, 246], // limited to 3
      [0.5, 56, 82], // raised to 1
      [Number.NaN, 56, 82],
    ];
    for (const [dpr, width, height] of cases) {
      const t = setup();
      t.context.devicePixelRatio = dpr;
      const toast = show(t, summary());
      assert.equal(toast.canvas().width, width, `dpr ${dpr}`);
      assert.equal(toast.canvas().height, height, `dpr ${dpr}`);
    }
  });

  it('a long capture shows a stack of three layers with the thumbnail on top', () => {
    const t = setup();
    const toast = show(t, longSummary());
    const stack = findOne(toast.root, (e) => e.className === 'stack', 'stack');
    assert.equal(stack.attributes.get('aria-hidden'), 'true');
    assert.deepEqual(
      stack.children.map((c) => c.className),
      ['layer back', 'layer mid', 'thumb'],
    );
    const main = findOne(toast.root, (e) => e.className === 'main', 'main');
    assert.equal(main.children[0], stack, 'the stack leads');
    assert.equal(toast.thumb().style['width'], '30px');

    const short = show(t, summary());
    const shortMain = findOne(short.root, (e) => e.className === 'main', 'main');
    assert.equal(shortMain.children[0], short.thumb(), 'a short capture has the thumbnail alone');
    assert.equal(findAll(short.root, (e) => e.className === 'stack').length, 0);
  });
});

describe('toast.js: the parts of the card', () => {
  it('every button is a plain button, with its own label and no form behaviour', () => {
    const t = setup();
    const toast = show(t, longSummary({ save: NEEDS_PERMISSION }));
    const buttons = findAll(toast.root, (e) => e.tagName === 'BUTTON');
    assert.equal(
      buttons.length,
      1 + 2 + 5 + 1 + 1,
      'close, open and show in folder, five chips, allow, not now',
    );
    for (const button of buttons) assert.equal(button.type, 'button', textOf(button));
    const close = toast.button('Close (Esc)');
    assert.equal(close.title, 'Close (Esc)');
    assert.equal(iconPath(close), 'M4 4L12 12M12 4L4 12');
    const short = show(t, summary());
    assert.equal(short.button('Open').type, 'button');
    assert.equal(iconPath(short.button('Open')), 'M9 2.5H13.5V7M13.5 2.5L7.5 8.5M11.5 9.5V13.5H2.5V4.5H6.5');
    const link = findOne(
      toast.root,
      (e) => e.className === 'link' && textOf(e) === 'Open',
      'open link',
    );
    assert.equal(textOf(link), 'Open');
    assert.equal(findAll(link, (e) => e.tagName === 'SVG').length, 1);
  });

  it('the icon slot sits in line with the title', () => {
    const t = setup();
    assert.equal(show(t, summary()).iconSlot().style['display'], 'inline-flex');
  });

  it('the tile chips are a labelled group', () => {
    const t = setup();
    const toast = show(t, longSummary());
    const label = findOne(toast.root, (e) => e.id === 'tile-label', 'label');
    assert.equal(textOf(label), 'Or copy one at a time');
    const group = findOne(toast.root, (e) => e.className === 'chips', 'group');
    assert.equal(group.attributes.get('role'), 'group');
    assert.equal(group.attributes.get('aria-labelledby'), 'tile-label');
    assert.deepEqual(
      toast.chips().map((c) => c.dataset['state']),
      ['idle', 'idle', 'idle', 'idle', 'idle'],
    );
  });

  it('the question block is a labelled group of a heading and two buttons, and the bar is part of the card', () => {
    const t = setup();
    const toast = show(t, summary({ save: NEEDS_PERMISSION }));
    const block = findOne(toast.root, (e) => e.className === 'permission', 'permission block');
    assert.equal(block.attributes.get('role'), 'group');
    assert.equal(block.attributes.get('aria-label'), 'Reconnect your folder');
    assert.equal(findAll(block, (e) => e.className === 'folder').length, 0, 'no folder icon');
    assert.equal(findAll(block, (e) => e.className === 'note').length, 0, 'no footnote');
    const allow = toast.button('Reconnect');
    assert.equal(allow.type, 'button');
    assert.equal(allow.className, 'btn primary');
    const later = toast.button('Not now');
    assert.equal(later.type, 'button');
    assert.equal(later.className, 'btn quiet');
    assert.equal(later.style['height'], '36px');

    const bar = findOne(toast.card, (e) => e.className === 'bar', 'countdown bar');
    assert.equal(bar.attributes.get('aria-hidden'), 'true');
    assert.equal(bar.children.length, 1);
    assert.equal(toast.card.children.at(-1), bar, 'the bar is the last part of the card');
  });

  it('shows itself: the open mark is set and the countdown starts at once for a finished copy', () => {
    const t = setup();
    const toast = show(t, summary());
    assert.equal('open' in toast.root.dataset, true);
    assert.equal(toast.root.style['--hide'], '6000ms');
    const asking = show(t, summary({ save: NEEDS_PERMISSION }));
    assert.equal(asking.root.style['--hide'], '15000ms');
    const pending = show(t, summary(), 'pending');
    assert.equal('open' in pending.root.dataset, true);
    assert.equal('--hide' in pending.root.style, false, 'no countdown while the copy is pending');
  });
});

describe('toast.js: the countdown keeps exact time', () => {
  it('goes on with the time that is left, counted from when the countdown began', () => {
    const t = setup();
    t.timers.advance(1000); // the toast does not start at time 0
    const toast = show(t, summary());
    t.timers.advance(4000);
    toast.card.dispatch('pointerenter'); // 2000 ms are left
    t.timers.advance(30_000);
    toast.card.dispatch('pointerleave');
    t.timers.advance(1900);
    assert.equal(toast.host.removed, false);
    assert.equal('closing' in toast.root.dataset, false);
    t.timers.advance(200);
    assert.equal('closing' in toast.root.dataset, true);
  });

  it('a second hold does not take the time away twice', () => {
    const t = setup();
    const toast = show(t, summary());
    t.timers.advance(1000);
    toast.card.dispatch('pointerenter'); // 5000 ms are left
    t.timers.advance(2000);
    toast.card.dispatch('focusin'); // already held: nothing changes
    toast.card.dispatch('pointerleave');
    toast.card.dispatch('focusout');
    t.timers.advance(4900);
    assert.equal('closing' in toast.root.dataset, false);
    t.timers.advance(200);
    assert.equal('closing' in toast.root.dataset, true);
  });

  it('a second hold after a release counts from the new start', () => {
    const t = setup();
    const toast = show(t, summary());
    t.timers.advance(4000);
    toast.card.dispatch('pointerenter'); // 2000 ms are left
    t.timers.advance(10_000);
    toast.card.dispatch('pointerleave'); // runs again from here
    t.timers.advance(1000);
    toast.card.dispatch('pointerenter'); // 1000 ms are left
    t.timers.advance(10_000);
    toast.card.dispatch('pointerleave');
    t.timers.advance(900);
    assert.equal('closing' in toast.root.dataset, false);
    t.timers.advance(200);
    assert.equal('closing' in toast.root.dataset, true);
  });

  it('hover, leave and hover again hold it (the second hover pauses it too)', () => {
    const t = setup();
    const toast = show(t, summary());
    toast.card.dispatch('pointerenter');
    toast.card.dispatch('pointerleave');
    toast.card.dispatch('pointerenter');
    assert.equal('paused' in toast.root.dataset, true);
    t.timers.advance(60_000);
    assert.equal('closing' in toast.root.dataset, false);
  });

  it('a hold that came before the copy ended keeps the countdown from starting', () => {
    const t = setup();
    const toast = show(t, summary(), 'pending');
    toast.card.dispatch('pointerenter');
    toast.handle?.setCopy('copied');
    assert.equal('paused' in toast.root.dataset, true);
    assert.equal('timing' in toast.root.dataset, true);
    t.timers.advance(60_000);
    assert.equal('closing' in toast.root.dataset, false);
    toast.card.dispatch('pointerleave');
    t.timers.advance(5900);
    assert.equal('closing' in toast.root.dataset, false);
    t.timers.advance(200);
    assert.equal('closing' in toast.root.dataset, true);
  });

  it('a change of the copy state after the countdown began does not restart it', () => {
    const t = setup();
    const toast = show(t, summary(), 'pending');
    toast.handle?.setCopy('copied');
    t.timers.advance(3000);
    toast.handle?.setCopy('failed', 'Changed its mind.');
    t.timers.advance(2900);
    assert.equal('closing' in toast.root.dataset, false);
    t.timers.advance(200);
    assert.equal('closing' in toast.root.dataset, true, 'closed 6 s after the first start');
  });
});

describe('toast.js: closing', () => {
  it('Open, Reconnect, the handle and dismiss() close with the animation', async () => {
    const t = setup();
    const open = show(t, summary());
    open.button('Open').dispatch('click');
    await flush();
    assert.equal('closing' in open.root.dataset, true);
    assert.equal(open.host.removed, false);

    const allow = show(t, summary({ save: NEEDS_PERMISSION }));
    allow.button('Reconnect').dispatch('click');
    await flush();
    assert.equal('closing' in allow.root.dataset, true);

    const later = show(t, summary({ save: NEEDS_PERMISSION }));
    later.button('Not now').dispatch('click');
    assert.equal('closing' in later.root.dataset, true);

    const handled = show(t, summary());
    handled.handle?.close();
    assert.equal('closing' in handled.root.dataset, true);
    assert.equal(handled.host.removed, false);
    t.timers.advance(167);
    assert.equal(handled.host.removed, true);

    const dismissed = show(t, summary());
    t.ns.toast.dismiss();
    assert.equal('closing' in dismissed.root.dataset, true);
  });

  it('Esc closes with the animation and listens in the capture phase', () => {
    const t = setup();
    const toast = show(t, summary());
    const listener = t.win.listeners.get('keydown')?.[0];
    assert.equal(listener?.capture, true, 'it sees the key before the page does');
    t.win.dispatch('keydown', { key: 'Escape' });
    assert.equal('closing' in toast.root.dataset, true);
    assert.equal(toast.host.removed, false);
  });

  it('Esc is left alone while the user composes text, and with Meta or Alt', () => {
    const t = setup();
    const toast = show(t, summary());
    t.win.dispatch('keydown', { key: 'Escape', isComposing: true });
    t.win.dispatch('keydown', { key: 'Escape', metaKey: true });
    t.win.dispatch('keydown', { key: 'Escape', altKey: true });
    t.win.dispatch('keydown', { key: 'Escape', ctrlKey: true });
    assert.equal('closing' in toast.root.dataset, false);
    const real = t.win.dispatch('keydown', { key: 'Escape' });
    assert.equal(real.defaultPrevented, true);
    assert.equal('closing' in toast.root.dataset, true);
  });

  it('a new toast closes the old one for good: no key listener, no timer, no animation', () => {
    const t = setup();
    const first = show(t, summary());
    const second = show(t, summary());
    assert.equal(t.win.listenerCount('keydown'), 1, 'only the new toast listens');
    assert.equal('closing' in first.root.dataset, false, 'it goes at once');
    assert.equal(first.host.removed, true);
    first.handle?.setCopy('failed', 'Late.');
    assert.equal(first.title(), 'Copied and saved');
    assert.equal(second.host.removed, false);
  });

  it('a toast that the extension left behind goes at once, without an animation', () => {
    const t = setup();
    const toast = show(t, summary());
    t.extension.id = undefined;
    t.timers.advance(1000);
    assert.equal(toast.host.removed, true);
    assert.equal('closing' in toast.root.dataset, false);
    assert.equal(t.timers.pending, 0);
  });
});

describe('toast.js: tile chips', () => {
  const tileReply = () => ({ ok: true, pngBase64: PNG_BASE64 });

  it('the clipboard gets the bytes of the tile', async () => {
    const t = setup({ [MSG.PAGE_GET_TILE]: tileReply });
    const toast = show(t, longSummary());
    /** @type {FakeElement} */ (toast.chips()[0]).dispatch('click');
    const blob = await t.clipboard.writes[0]?.image;
    assert.ok(blob);
    assert.equal(blob.type, 'image/png');
    assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });

  it('a chip says that it copies, then that it worked or failed', async () => {
    const t = setup({ [MSG.PAGE_GET_TILE]: tileReply });
    const toast = show(t, longSummary());
    const chip = /** @type {FakeElement} */ (toast.chips()[2]);
    chip.dispatch('click');
    assert.equal(chip.attributes.get('aria-label'), 'Copying screenshot 3');
    assert.equal(textOf(chip), '3');
    assert.equal(iconPath(chip), 'M8 2.5A5.5 5.5 0 1 1 2.5 8');
    await flush();
    await flush();
    assert.equal(chip.attributes.get('aria-label'), 'Screenshot 3 copied');
    assert.equal(iconPath(chip), 'M3 8.5L6.5 12L13 4.5');

    t.clipboard.reject = true;
    const other = /** @type {FakeElement} */ (toast.chips()[3]);
    other.dispatch('click');
    await flush();
    await flush();
    assert.equal(other.attributes.get('aria-label'), 'Screenshot 4 could not be copied');
  });

  it('after a tile was copied the toast closes on time, and its timer goes with it', async () => {
    const t = setup({ [MSG.PAGE_GET_TILE]: tileReply });
    const toast = show(t, longSummary());
    /** @type {FakeElement} */ (toast.chips()[0]).dispatch('click');
    await flush();
    await flush();
    t.timers.advance(6100); // the copy no longer holds it
    assert.equal('closing' in toast.root.dataset, true);
    t.timers.advance(167);
    assert.equal(toast.host.removed, true);
    assert.equal(t.timers.pending, 0, 'the timer of the chip is gone');
  });

  it('a tile that arrives after the toast closed changes nothing and leaves no timer', async () => {
    /** @type {(value: unknown) => void} */
    let answer = () => {};
    const t = setup({
      [MSG.PAGE_GET_TILE]: () => new Promise((resolve) => (answer = resolve)),
    });
    const toast = show(t, longSummary());
    const chip = /** @type {FakeElement} */ (toast.chips()[0]);
    chip.dispatch('click');
    toast.handle?.close();
    t.timers.advance(167);
    answer(tileReply());
    await flush();
    await flush();
    assert.equal(chip.dataset['state'], 'pending', 'the closed card is left as it was');
    assert.equal(t.timers.pending, 0);
  });

  it('a chip goes back to its number after two seconds, and not before', async () => {
    const t = setup({ [MSG.PAGE_GET_TILE]: tileReply });
    const toast = show(t, longSummary());
    const chip = /** @type {FakeElement} */ (toast.chips()[0]);
    chip.dispatch('click');
    await flush();
    await flush();
    t.timers.advance(1999);
    assert.equal(chip.dataset['state'], 'copied');
    t.timers.advance(1);
    assert.equal(chip.dataset['state'], 'idle');
  });
});

describe('toast.js: text from the service worker is cut to its own length', () => {
  it('cuts the place, the error, the warning, the detail and the session', () => {
    const t = setup();
    const label = show(t, summary({ save: { location: 'folder', label: 'L'.repeat(100), files: 1, needsPermission: false } }));
    assert.equal(textOf(label.caption()), `1,500 × 2,210 px · Saved to ${'L'.repeat(80)}`);

    const error = show(
      t,
      summary({ save: { location: 'none', label: 'x', files: 0, needsPermission: false, error: 'E'.repeat(150) } }),
    );
    assert.equal(textOf(error.caption()), `1,500 × 2,210 px · ${'E'.repeat(120)}`);

    const warned = show(t, summary({ warnings: ['W'.repeat(200)] }));
    assert.equal(textOf(warned.note()), 'W'.repeat(140));

    const failed = show(t, summary(), 'pending');
    failed.handle?.setCopy('failed', 'D'.repeat(200));
    assert.equal(textOf(failed.note()), 'D'.repeat(160));

    const long = show(t, summary({ sessionId: 's'.repeat(70) }));
    long.button('Open').dispatch('click');
    assert.equal(t.sent.at(-1)?.sessionId, 's'.repeat(64));
  });

  it('cuts a thumbnail of more than 400,000 characters to a size that still decodes', async () => {
    const t = setup();
    t.context.atob = atob; // the strict one of the browser: a length of 4n + 1 is refused
    const toast = show(t, summary({ thumbnailPngBase64: 'A'.repeat(400_004) }));
    await flush();
    await flush();
    assert.equal(toast.canvas().drawn.length, 1);
  });

  it('draws the small icons at their own sizes', () => {
    const t = setup();
    const long = show(t, longSummary({ save: NEEDS_PERMISSION }));
    const size = (/** @type {any} */ node) =>
      findAll(node, (e) => e.tagName === 'SVG')[0]?.attributes.get('width');
    assert.equal(
      size(findOne(long.root, (e) => e.className === 'link' && textOf(e).startsWith('Open'))),
      '14',
    );
    assert.equal(size(long.button('Close (Esc)')), '16');
  });

  it('the close button closes with the animation', () => {
    const t = setup();
    const toast = show(t, summary());
    toast.button('Close (Esc)').dispatch('click');
    assert.equal('closing' in toast.root.dataset, true);
    assert.equal(toast.host.removed, false);
  });

  it('a chip shows a spinner and a check mark at 14 px', async () => {
    const t = setup({ [MSG.PAGE_GET_TILE]: () => ({ ok: true, pngBase64: PNG_BASE64 }) });
    const toast = show(t, longSummary());
    const chip = /** @type {FakeElement} */ (toast.chips()[0]);
    const size = () => findAll(chip, (e) => e.tagName === 'SVG')[0]?.attributes.get('width');
    chip.dispatch('click');
    assert.equal(size(), '14');
    await flush();
    await flush();
    assert.equal(size(), '14');
  });
});
