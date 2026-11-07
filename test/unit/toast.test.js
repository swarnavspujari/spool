// @ts-check
/**
 * Tests for src/page/toast.js: what the toast says for a short and a long capture, its actions,
 * the countdown (6 s, paused by hover and focus), Esc, and the rules of the page scripts (closed
 * shadow root, trusted events only, text only, no <img>, no drag chip, no focus taken).
 * The script is a classic script in a node:vm context with the fake page of
 * test/helpers/fake-card-dom.js. The look is covered by the e2e tests.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERR, MSG, PROTOCOL_VERSION, TARGET } from '../../src/shared/protocol.js';
import {
  FakeElement,
  FakePopoverElement,
  findAll,
  findOne,
  flush,
  setupCards,
  textOf,
  walk,
} from '../helpers/fake-card-dom.js';

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
    createdAt: Date.now(),
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

/** A long capture: five tiles. @param {Record<string, unknown>} [more] */
function longSummary(more = {}) {
  return summary({ heightPx: 9000, tileCount: 5, fitsOneImage: false, ...more });
}

/** @param {Parameters<typeof setupCards>[0]['replies']} [replies] */
function setup(replies = {}) {
  const t = setupCards({ files: ['src/page/ui-kit.js', 'src/page/toast.js'], replies });
  assert.ok(t.ns.toast, 'toast.js must register __spool.toast');
  return t;
}

/**
 * Shows a toast and returns the pieces of its card.
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
    title: () => textOf(findOne(root, (e) => e.className === 'title', 'title')),
    caption: () => textOf(byClass('caption')[0]),
    note: () => byClass('caption')[1],
    button: (/** @type {string} */ label) =>
      findOne(
        root,
        (e) => e.tagName === 'BUTTON' && (textOf(e).trim() === label || e.attributes.get('aria-label') === label),
        `button "${label}"`,
      ),
    chips: () => byClass('chip'),
  };
}

describe('toast.js: short capture', () => {
  it('says "Copied and saved", the size and the place, and offers Open and the paste keys', () => {
    const t = setup();
    const toast = show(t, summary());
    assert.equal(toast.title(), 'Copied and saved');
    assert.equal(toast.caption(), '1,500 × 2,210 px · Saved to Pictures › Screenshots');
    assert.equal(toast.card.attributes.get('role'), 'status');
    assert.equal(toast.card.attributes.get('aria-live'), 'polite');
    assert.equal(toast.card.attributes.get('aria-label'), 'Spool: capture result');
    assert.ok(toast.button('Open'));
    assert.equal(toast.chips().length, 0, 'no tile chips for one image');
    const paste = findOne(toast.root, (e) => e.className === 'paste small', 'paste hint');
    assert.equal(textOf(paste), 'PasteCtrlV');
    assert.notEqual(paste.style['display'], 'none');
  });

  it('shows "Copying…" first, and the paste hint only when the copy worked', () => {
    const t = setup();
    const toast = show(t, summary(), 'pending');
    assert.equal(toast.title(), 'Copying…');
    const paste = findOne(toast.root, (e) => e.className === 'paste small');
    assert.equal(paste.style['display'], 'none');
    toast.handle?.setCopy('copied');
    assert.equal(toast.title(), 'Copied and saved');
    assert.equal(paste.style['display'], 'flex');
  });

  it('says what failed: not saved, not copied, both', () => {
    const t = setup();
    const unsaved = show(t, summary({ save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false } }));
    assert.equal(unsaved.title(), 'Copied');
    assert.equal(unsaved.caption(), '1,500 × 2,210 px · Not saved');
    const failedSave = show(
      t,
      summary({
        save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false, error: 'The disk is full.' },
      }),
    );
    assert.equal(failedSave.caption(), '1,500 × 2,210 px · The disk is full.');

    const notCopied = show(t, summary(), 'failed');
    assert.equal(notCopied.title(), 'Saved, not copied');
    assert.equal(textOf(notCopied.note()), 'Use Open to copy or save it.');
    const neither = show(
      t,
      summary({ save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false } }),
      'failed',
    );
    assert.equal(neither.title(), 'Not copied');
  });

  it('shows the reason that the service worker gave for a failed copy', () => {
    const t = setup();
    const toast = show(t, longSummary(), 'pending');
    toast.handle?.setCopy('failed', 'This image is too large to copy. Use the AI screenshots.');
    assert.equal(toast.title(), 'Saved, not copied');
    assert.equal(textOf(toast.note()), 'This image is too large to copy. Use the AI screenshots.');
    assert.equal(toast.note()?.style['display'], 'block');
  });

  it('shows the first warning of the capture', () => {
    const t = setup();
    const toast = show(t, summary({ warnings: ['Could not write to the chosen folder. Saved to Downloads instead.'] }));
    assert.equal(textOf(toast.note()), 'Could not write to the chosen folder. Saved to Downloads instead.');
  });

  it('Open asks the service worker for the result page and closes the toast', async () => {
    const t = setup();
    const toast = show(t, summary());
    toast.button('Open').dispatch('click');
    assert.deepEqual(t.sent, [{ v: 1, target: 'sw', type: 'page/open-result', sessionId: SESSION }]);
    assert.equal(toast.host.removed, false, 'it waits for the answer');
    await flush();
    t.timers.advance(167);
    assert.equal(toast.host.removed, true);
  });

  it('Open that the service worker refuses stays open and says why', async () => {
    const t = setup();
    t.runtime.sendMessage = () =>
      Promise.resolve({
        ok: false,
        error: { code: 'E_SESSION_NOT_FOUND', message: 'This capture has ended. Start a new capture.' },
      });
    const toast = show(t, summary());
    toast.button('Open').dispatch('click');
    await flush();
    t.timers.advance(167);
    assert.equal(toast.host.removed, false);
    assert.equal(textOf(toast.note()), 'This capture has ended. Start a new capture.');
  });

  it('Open with no answer from the extension says so', async () => {
    const t = setup();
    t.runtime.sendMessage = () => Promise.reject(new Error('gone'));
    const toast = show(t, summary());
    toast.button('Open').dispatch('click');
    await flush();
    assert.equal(textOf(toast.note()), 'Could not reach the extension. Try again.');
    assert.equal(toast.host.removed, false);
  });

  it('draws the thumbnail on a canvas from the bytes: no <img>, no blob URL', async () => {
    const t = setup();
    show(t, summary());
    await flush();
    const canvas = findOne(t.rootOf(/** @type {FakeElement} */ (t.hosts()[0])), (e) => e.tagName === 'CANVAS');
    // 56 px wide at a device pixel ratio of 2; the thumbnail 320 x 480 gives a 56 x 84 box, cut to 82.
    assert.equal(canvas.width, 112);
    assert.equal(canvas.drawn.length, 1);
    assert.ok(!t.createdTags.includes('img'));
  });
});

describe('toast.js: long capture', () => {
  it('says what Ctrl+V pastes, counts the AI tiles and gives the hint', () => {
    const t = setup();
    const toast = show(t, longSummary());
    assert.equal(toast.title(), 'Copied. Press Ctrl+V for the full image.');
    assert.equal(toast.caption(), '5 AI screenshots ready · Saved to Pictures › Screenshots');
    const hint = findOne(toast.root, (e) => e.className === 'hint', 'hint');
    assert.equal(
      textOf(hint),
      'Long capture? In your chat tab, press Alt+Shift+V to insert all 5 screenshots.',
    );
    assert.equal(toast.chips().length, 5);
    assert.deepEqual(
      toast.chips().map((c) => c.attributes.get('aria-label')),
      ['Copy screenshot 1', 'Copy screenshot 2', 'Copy screenshot 3', 'Copy screenshot 4', 'Copy screenshot 5'],
    );
    assert.equal(textOf(toast.chips()[2]), '3');
    assert.ok(
      findOne(toast.root, (e) => e.className === 'link' && textOf(e).startsWith('Open'), 'Open'),
    );
  });

  it('has no "drag all tiles" chip: nothing is draggable, and drag shows only for a desktop app', () => {
    const t = setup();
    const toast = show(t, longSummary());
    for (const node of walk(toast.root)) {
      if (!(node instanceof FakeElement)) continue;
      assert.equal(node.attributes.has('draggable'), false);
      assert.equal(node.listenerCount('dragstart'), 0);
      // The one line that says "drag" is about the files in the folder, for a desktop chat app.
      if (/drag/i.test(textOf(node)) && node.className !== 'card') {
        assert.ok(
          /^Desktop app: drag them from .+ › Spool for AI\.$/.test(textOf(node)) ||
            node.className === 'main' ||
            node.tagName === 'SHADOW' ||
            node.className === 'root',
          textOf(node),
        );
      }
    }
  });

  it('a chip click starts the clipboard write at once, with a promise of that tile', async () => {
    const t = setup({ [MSG.PAGE_GET_TILE]: () => ({ ok: true, pngBase64: PNG_BASE64 }) });
    const toast = show(t, longSummary());
    const chip = /** @type {FakeElement} */ (toast.chips()[1]);
    chip.dispatch('click');
    assert.equal(t.clipboard.writes.length, 1, 'clipboard.write ran inside the click');
    assert.deepEqual(t.clipboard.writes[0]?.types, ['image/png']);
    assert.deepEqual(t.sent, [
      { v: 1, target: 'sw', type: 'page/get-tile', sessionId: SESSION, index: 1 },
    ]);
    assert.equal(chip.dataset['state'], 'pending');
    await flush();
    await flush();
    assert.equal(chip.dataset['state'], 'copied');
    assert.equal(textOf(chip), '2 · Copied');
    assert.equal(chip.attributes.get('aria-label'), 'Screenshot 2 copied');
    t.timers.advance(2000);
    assert.equal(chip.dataset['state'], 'idle');
    assert.equal(textOf(chip), '2');
    assert.equal(chip.attributes.get('aria-label'), 'Copy screenshot 2');
  });

  it('a chip shows "Failed" when the write is refused or the tile cannot be read', async () => {
    const t = setup({ [MSG.PAGE_GET_TILE]: () => ({ ok: true, pngBase64: PNG_BASE64 }) });
    t.clipboard.reject = true;
    const toast = show(t, longSummary());
    const chip = /** @type {FakeElement} */ (toast.chips()[0]);
    chip.dispatch('click');
    await flush();
    await flush();
    assert.equal(chip.dataset['state'], 'failed');
    assert.equal(textOf(chip), '1 · Failed');

    const bad = setup({
      [MSG.PAGE_GET_TILE]: () => ({ ok: false, error: { code: ERR.BAD_MESSAGE, message: 'Unknown part.' } }),
    });
    const other = show(bad, longSummary());
    const chip2 = /** @type {FakeElement} */ (other.chips()[0]);
    chip2.dispatch('click');
    await flush();
    await flush();
    assert.equal(chip2.dataset['state'], 'failed');
  });

  it('a chip that is copying ignores a second click, and holds the countdown', async () => {
    const t = setup({ [MSG.PAGE_GET_TILE]: () => new Promise(() => {}) });
    const toast = show(t, longSummary());
    const chip = /** @type {FakeElement} */ (toast.chips()[0]);
    chip.dispatch('click');
    chip.dispatch('click');
    assert.equal(t.clipboard.writes.length, 1);
    t.timers.advance(60_000);
    assert.equal(toast.host.removed, false, 'a copy in progress keeps the toast');
  });

  it('an untrusted click on a chip does nothing', () => {
    const t = setup();
    const toast = show(t, longSummary());
    /** @type {FakeElement} */ (toast.chips()[0]).dispatch('click', { isTrusted: false });
    assert.equal(t.clipboard.writes.length, 0);
    assert.deepEqual(t.sent, []);
  });
});

describe('toast.js: save to a folder that is not allowed yet', () => {
  const needing = () =>
    summary({
      save: {
        location: 'downloads',
        label: 'Downloads/Spool',
        files: 1,
        needsPermission: true,
        folderLabel: 'Pictures/Screenshots',
      },
    });

  it('asks to reconnect the folder by name, and says where the capture went', () => {
    const t = setup();
    const toast = show(t, needing());
    const heading = findOne(toast.root, (e) => e.tagName === 'H2');
    assert.equal(textOf(heading), 'Reconnect Pictures › Screenshots?');
    assert.equal(toast.caption(), '1,500 × 2,210 px · Saved to Downloads › Spool this time');
    assert.ok(toast.button('Reconnect'));
    assert.ok(toast.button('Not now'));
    assert.equal(findAll(toast.root, (e) => e.className === 'link change').length, 0, 'no Change link');
  });

  it('"Reconnect" opens the reconnect card and closes the toast', async () => {
    const t = setup();
    const toast = show(t, needing());
    toast.button('Reconnect').dispatch('click');
    assert.deepEqual(t.sent, [{ v: 1, target: 'sw', type: 'page/open-options', section: 'reconnect' }]);
    await flush();
    t.timers.advance(167);
    assert.equal(toast.host.removed, true);
  });

  it('"Not now" only closes it, and the block stays 15 s (not 6 s)', () => {
    const t = setup();
    const toast = show(t, needing());
    t.timers.advance(6500);
    assert.equal(toast.host.removed, false);
    t.timers.advance(8500 + 167);
    assert.equal(toast.host.removed, true);

    const again = show(t, needing());
    again.button('Not now').dispatch('click');
    assert.deepEqual(t.sent, []);
    t.timers.advance(167);
    assert.equal(again.host.removed, true);
  });

  it('a capture that is saved as wanted has no such block', () => {
    const t = setup();
    const toast = show(t, summary());
    assert.equal(findAll(toast.root, (e) => e.className === 'permission').length, 0);
  });
});

describe('toast.js: countdown', () => {
  it('hides after 6 s, with a short closing animation', () => {
    const t = setup();
    const toast = show(t, summary());
    assert.equal('timing' in toast.root.dataset, true);
    t.timers.advance(5900);
    assert.equal('closing' in toast.root.dataset, false);
    t.timers.advance(200);
    assert.equal('closing' in toast.root.dataset, true);
    assert.equal(toast.host.removed, false);
    t.timers.advance(167);
    assert.equal(toast.host.removed, true);
    assert.deepEqual(t.hosts(), []);
  });

  it('does not count while the copy is pending, and starts when it ends', () => {
    const t = setup();
    const toast = show(t, summary(), 'pending');
    assert.equal('timing' in toast.root.dataset, false);
    t.timers.advance(30_000);
    assert.equal(toast.host.removed, false);
    toast.handle?.setCopy('copied');
    t.timers.advance(5900);
    assert.equal(toast.host.removed, false);
    t.timers.advance(400);
    assert.equal(toast.host.removed, true);
  });

  it('hover and focus hold it, and it goes on with the time that was left', () => {
    const t = setup();
    const toast = show(t, summary());
    t.timers.advance(4000);
    toast.card.dispatch('pointerenter');
    assert.equal('paused' in toast.root.dataset, true);
    t.timers.advance(60_000);
    assert.equal(toast.host.removed, false);
    toast.card.dispatch('pointerleave');
    assert.equal('paused' in toast.root.dataset, false);
    t.timers.advance(1900);
    assert.equal(toast.host.removed, false);
    t.timers.advance(300);
    assert.equal(toast.host.removed, true);

    const second = show(t, summary());
    second.card.dispatch('focusin');
    t.timers.advance(20_000);
    assert.equal(second.host.removed, false);
    second.card.dispatch('pointerenter');
    second.card.dispatch('focusout');
    t.timers.advance(20_000);
    assert.equal(second.host.removed, false, 'hover still holds it');
    second.card.dispatch('pointerleave');
    t.timers.advance(6500);
    assert.equal(second.host.removed, true);
  });
});

describe('toast.js: Esc, close and show again', () => {
  it('Esc closes it and the page does not get that key', () => {
    const t = setup();
    const toast = show(t, summary());
    const event = t.win.dispatch('keydown', { key: 'Escape', ctrlKey: false, metaKey: false, altKey: false });
    assert.equal(event.defaultPrevented, true);
    assert.equal(event.immediatelyStopped, true);
    t.timers.advance(167);
    assert.equal(toast.host.removed, true);
    assert.equal(t.win.listenerCount('keydown'), 0);
  });

  it('a fake Escape, other keys and Esc with a modifier do nothing', () => {
    const t = setup();
    const toast = show(t, summary());
    t.win.dispatch('keydown', { key: 'Escape', isTrusted: false });
    t.win.dispatch('keydown', { key: 'Enter' });
    t.win.dispatch('keydown', { key: 'Escape', ctrlKey: true });
    t.timers.advance(167);
    assert.equal(toast.host.removed, false);
    assert.equal('closing' in toast.root.dataset, false);
  });

  it('the close button closes it', () => {
    const t = setup();
    const toast = show(t, summary());
    toast.button('Close (Esc)').dispatch('click');
    t.timers.advance(167);
    assert.equal(toast.host.removed, true);
  });

  it('a new toast replaces the old one at once; dismiss() closes the current one', () => {
    const t = setup();
    const first = show(t, summary());
    const second = show(t, summary());
    assert.equal(first.host.removed, true);
    assert.deepEqual(t.hosts(), [second.host]);
    t.ns.toast.dismiss();
    t.timers.advance(167);
    assert.equal(second.host.removed, true);
    assert.doesNotThrow(() => t.ns.toast.dismiss());
  });

  it('the handle is safe after the toast closed', () => {
    const t = setup();
    const toast = show(t, summary(), 'pending');
    toast.handle?.close();
    t.timers.advance(167);
    assert.doesNotThrow(() => toast.handle?.setCopy('copied'));
    assert.doesNotThrow(() => toast.handle?.close());
  });

  it('does not show for a summary without a session', () => {
    const t = setup();
    const handle = t.ns.toast.show({ config: CONFIG, summary: /** @type {any} */ (undefined), copy: 'copied' });
    assert.equal(handle, null);
    assert.equal(
      t.ns.toast.show({ config: CONFIG, summary: /** @type {any} */ ({ sessionId: 5 }), copy: 'copied' }),
      null,
    );
    assert.deepEqual(t.hosts(), []);
  });

  it('closes when the extension is reloaded (nobody can use the buttons then)', () => {
    const t = setup();
    const toast = show(t, summary());
    t.extension.id = undefined;
    t.timers.advance(1000);
    assert.equal(toast.host.removed, true);
  });
});

describe('toast.js: what the page can see and do', () => {
  it('the host has no attribute but the popover, and the content is a closed shadow root', () => {
    const t = setup();
    const toast = show(t, summary());
    const host = /** @type {FakePopoverElement} */ (toast.host);
    assert.deepEqual([...host.attributes], [], 'popover is a property in the fake, not an attribute');
    assert.equal(host.popover, 'manual');
    assert.equal(host.shown, 1);
    assert.equal(host.parentNode, t.documentElement);
    assert.equal(host.shadowRoot, null, 'closed: the page cannot reach the content');
  });

  it('text of the capture is text only: markup in a title or a folder name stays text', () => {
    const t = setup();
    const toast = show(
      t,
      summary({
        save: { location: 'folder', label: '<img src=x onerror=alert(1)>', files: 1, needsPermission: false },
      }),
    );
    assert.ok(textOf(toast.root).includes('<img src=x onerror=alert(1)>'));
    assert.ok(!t.createdTags.includes('img'));
    const tags = new Set([...walk(toast.root)].map((n) => /** @type {any} */ (n).tagName));
    assert.ok(![...tags].some((tag) => tag === 'IMG' || tag === 'SCRIPT'));
  });

  it('never takes the focus', () => {
    const t = setup();
    show(t, longSummary({ save: { location: 'downloads', label: 'D', files: 1, needsPermission: true } }));
    for (const el of t.created) assert.equal(el.focusCalls, 0);
    assert.equal(t.page.activeElement, t.body);
  });

  it('keeps a press on the toast from moving the focus away from the page', () => {
    const t = setup();
    const toast = show(t, summary());
    assert.equal(toast.card.dispatch('mousedown').defaultPrevented, true);
    assert.equal(toast.card.dispatch('mousedown', { isTrusted: false }).defaultPrevented, false);
  });

  it('ignores a fake pointer: it does not pause the countdown', () => {
    const t = setup();
    const toast = show(t, summary());
    toast.card.dispatch('pointerenter', { isTrusted: false });
    t.timers.advance(6200);
    assert.equal('closing' in toast.root.dataset, true);
  });

  it('survives a toast with odd values (no tiles field, no save field)', () => {
    const t = setup();
    const toast = show(
      t,
      /** @type {any} */ ({ sessionId: SESSION, widthPx: 'wide', save: 'x', tileCount: -3, warnings: 'none' }),
    );
    assert.equal(toast.title(), 'Copied');
    assert.deepEqual(t.consoleErrors, []);
  });
});

describe('toast.js: the place of the save and the way to change it', () => {
  const inDownloads = (/** @type {Record<string, unknown>} */ more = {}) =>
    summary({
      save: { location: 'downloads', label: 'Downloads/Spool', files: 1, needsPermission: false, ...more },
    });
  const changeLink = (/** @type {ReturnType<typeof show>} */ toast) =>
    findAll(toast.root, (e) => e.className === 'link change');

  it('a save in the folder says "Saved to <place>", with no link to change it', () => {
    const t = setup();
    const toast = show(t, summary());
    assert.equal(toast.caption(), '1,500 × 2,210 px · Saved to Pictures › Screenshots');
    assert.equal(changeLink(toast).length, 0);
    const long = show(t, longSummary());
    assert.equal(long.caption(), '5 AI screenshots ready · Saved to Pictures › Screenshots');
  });

  it('a save in Downloads has the link "Change", also with no question', () => {
    const t = setup();
    const toast = show(t, inDownloads());
    assert.equal(toast.caption(), '1,500 × 2,210 px · Saved to Downloads › Spool · Change');
    const [link] = changeLink(toast);
    assert.ok(link);
    assert.equal(link.tagName, 'BUTTON');
    assert.equal(link.attributes.get('aria-label'), 'Change the save location');
    assert.equal(findAll(toast.root, (e) => e.className === 'permission').length, 0);
  });

  it('the link opens the setup page and closes the toast', async () => {
    const t = setup();
    const toast = show(t, inDownloads());
    /** @type {FakeElement} */ (changeLink(toast)[0]).dispatch('click');
    assert.deepEqual(t.sent, [{ v: 1, target: 'sw', type: 'page/open-options', section: 'setup' }]);
    await flush();
    t.timers.advance(167);
    assert.equal(toast.host.removed, true);
  });

  it('an untrusted click on the link does nothing', () => {
    const t = setup();
    const toast = show(t, inDownloads());
    /** @type {FakeElement} */ (changeLink(toast)[0]).dispatch('click', { isTrusted: false });
    assert.deepEqual(t.sent, []);
  });

  it('the question names the place and has Set up and Not now', () => {
    const t = setup();
    const toast = show(t, inDownloads({ askFolder: true }));
    assert.equal(textOf(findOne(toast.root, (e) => e.tagName === 'H2')), 'Save to Pictures › Screenshots?');
    toast.button('Set up').dispatch('click');
    assert.deepEqual(t.sent, [{ v: 1, target: 'sw', type: 'page/open-options', section: 'setup' }]);
    assert.ok(toast.button('Not now'));
  });

  it('the question stays 15 s, like the one about the folder that needs a click', () => {
    const t = setup();
    const toast = show(t, inDownloads({ askFolder: true }));
    t.timers.advance(14_000);
    assert.equal(toast.host.removed, false);
    t.timers.advance(1_500);
    assert.equal(toast.host.removed, true);
  });

  it('the reconnect question names the folder, and the caption says this time', () => {
    const t = setup();
    const toast = show(t, inDownloads({ needsPermission: true, folderLabel: 'Pictures/Screenshots' }));
    assert.equal(textOf(findOne(toast.root, (e) => e.tagName === 'H2')), 'Reconnect Pictures › Screenshots?');
    assert.equal(toast.caption(), '1,500 × 2,210 px · Saved to Downloads › Spool this time');
    assert.equal(changeLink(toast).length, 0, 'the question is the way back, not a second link');
  });

  it('with no folder name in the reply, the question says "your folder"', () => {
    const t = setup();
    const toast = show(t, inDownloads({ needsPermission: true }));
    assert.equal(textOf(findOne(toast.root, (e) => e.tagName === 'H2')), 'Reconnect your folder?');
  });

  it('the name of the folder is cut like every text from the worker', () => {
    const t = setup();
    const toast = show(t, inDownloads({ needsPermission: true, folderLabel: 'F'.repeat(100) }));
    assert.equal(
      textOf(findOne(toast.root, (e) => e.tagName === 'H2')),
      `Reconnect ${'F'.repeat(80)}?`,
    );
  });

  it('no Change link when nothing was saved', () => {
    const t = setup();
    const toast = show(
      t,
      summary({ save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false } }),
    );
    assert.equal(changeLink(toast).length, 0);
  });
});

describe('toast.js: some files did not save', () => {
  /** Six files planned, four saved. @param {Record<string, unknown>} [more] */
  const partial = (more = {}) =>
    summary({
      tileCount: 5,
      fitsOneImage: false,
      save: {
        location: 'downloads',
        label: 'Downloads/Spool',
        files: 4,
        needsPermission: false,
        failed: 2,
        error: 'Some files could not be saved.',
      },
      ...more,
    });

  it('does not say "Copied and saved": it says how many files are missing', () => {
    const t = setup();
    const toast = show(t, partial());
    assert.equal(toast.title(), "Copied, but 2 of 6 files didn't save.");
    assert.doesNotMatch(toast.title(), /Copied and saved/);
  });

  it('says what to do, and shows the warning of the capture after it', () => {
    const t = setup();
    const toast = show(t, partial({ warnings: ['More than 20 tiles. Check your chat app.'] }));
    assert.equal(
      textOf(/** @type {any} */ (toast.note())),
      'The full image is on your clipboard. Open the capture to save the rest. ' +
        'More than 20 tiles. Check your chat app.',
    );
  });

  it('uses a warning level and puts the Open button first for a short capture', () => {
    const t = setup();
    const toast = show(
      t,
      summary({
        save: {
          location: 'downloads',
          label: 'Downloads/Spool',
          files: 1,
          needsPermission: false,
          failed: 1,
          error: 'Some files could not be saved.',
        },
      }),
    );
    assert.equal(toast.title(), "Copied, but 1 of 2 files didn't save.");
    assert.equal(toast.button('Open').className, 'btn primary');
    const title = findOne(toast.root, (e) => e.className === 'title', 'title');
    assert.equal(title.dataset['level'], 'warn');
  });

  it('with the copy turned off, the title is the count and the note says nothing of the clipboard', () => {
    const t = setup();
    const toast = show(t, partial(), 'skipped');
    assert.equal(toast.title(), "2 of 6 files didn't save.");
    assert.equal(textOf(/** @type {any} */ (toast.note())), 'Open the capture to save the rest.');
  });

  it('with the copy failed too, it says both', () => {
    const t = setup();
    const toast = show(t, partial(), 'pending');
    toast.handle?.setCopy('failed', 'The page blocks the clipboard.');
    assert.equal(toast.title(), "Not copied. 2 of 6 files didn't save.");
    assert.equal(textOf(/** @type {any} */ (toast.note())), 'The page blocks the clipboard.');
  });

  it('while it copies, the title says so, and the final state comes after', () => {
    const t = setup();
    const toast = show(t, partial(), 'pending');
    assert.equal(toast.title(), 'Copying…');
    toast.handle?.setCopy('copied');
    assert.equal(toast.title(), "Copied, but 2 of 6 files didn't save.");
  });

  it('a reply without the count says "some files"', () => {
    const t = setup();
    const toast = show(
      t,
      summary({
        save: {
          location: 'downloads',
          label: 'Downloads/Spool',
          files: 3,
          needsPermission: false,
          error: 'Some files could not be saved.',
        },
      }),
    );
    assert.equal(toast.title(), "Copied, but some files didn't save.");
  });

  it('a save that is complete says "Copied and saved", and no save says "Copied"', () => {
    const t = setup();
    assert.equal(show(t, summary()).title(), 'Copied and saved');
    assert.equal(
      show(t, summary({ save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false } })).title(),
      'Copied',
    );
  });

  it('the warning of a failed folder write shows next to the count', () => {
    const t = setup();
    const toast = show(
      t,
      partial({
        warnings: ['Writing to Pictures › Screenshots stopped after 2 of 4 files. They stay there.'],
      }),
    );
    assert.match(textOf(/** @type {any} */ (toast.note())), /stopped after 2 of 4 files/);
  });
});
