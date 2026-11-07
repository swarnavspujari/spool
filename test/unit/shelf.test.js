// @ts-check
/**
 * Tests for src/page/shelf.js: opening with a token, the last capture or the empty state, the
 * synthetic paste of all tiles at the element that had the focus, the copy chips, Esc, and the
 * rules of the page scripts. The script is a classic script in a node:vm context with the fake
 * page of test/helpers/fake-card-dom.js.
 */
import assert from 'node:assert/strict';
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

const TOKEN = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const PNG_BASE64 = 'iVBORw0KGgo=';
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

/** Opens the shelf and waits for the answer about the last capture. @param {ReturnType<typeof setup>} t */
async function open(t) {
  t.ns.shelf.start();
  await flush();
  await flush();
  t.timers.advance(DWELL_MS); // Insert stays off for 400 ms after the card appears
  const host = /** @type {FakeElement} */ (t.hosts().at(-1));
  assert.ok(host, 'a shelf host is on screen');
  const root = t.rootOf(host);
  return {
    host,
    root,
    surface: findOne(root, (e) => e.className === 'card', 'card'),
    status: () => textOf(findAll(root, (e) => e.className === 'status')[0]),
    button: (/** @type {string} */ label) =>
      findOne(
        root,
        (e) => e.tagName === 'BUTTON' && (textOf(e).trim() === label || e.attributes.get('aria-label') === label),
        `button "${label}"`,
      ),
    chips: () => findAll(root, (e) => e.className === 'chip'),
  };
}

/**
 * An editor that the paste event can reach. `accepts`: its listener calls preventDefault().
 * @param {boolean} accepts
 */
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

describe('shelf.js: opening', () => {
  it('asks for the last capture with its token, and shows it', async () => {
    const t = setup();
    const shelf = await open(t);
    assert.deepEqual(t.sent, [{ v: 1, target: 'sw', type: 'page/shelf-info', token: TOKEN }]);
    assert.equal(shelf.surface.attributes.get('role'), 'dialog');
    assert.ok(textOf(shelf.root).includes('Insert into this chat?'));
    assert.ok(textOf(shelf.root).includes('3 AI screenshots from a local page, just now.'));
    assert.ok(shelf.button('Insert 3 screenshots'));
    assert.ok(shelf.button('Copy full image'));
    assert.equal(shelf.chips().length, 3);
    assert.deepEqual(
      shelf.chips().map((c) => c.attributes.get('aria-label')),
      ['Copy screenshot 1', 'Copy screenshot 2', 'Copy screenshot 3'],
    );
  });

  it('one image: "Insert 1 screenshot", no chips, the full image button stays', async () => {
    const t = setup({ info: summary({ tileCount: 1, fitsOneImage: true }) });
    const shelf = await open(t);
    assert.ok(shelf.button('Insert 1 screenshot'));
    assert.equal(shelf.chips().length, 0);
    assert.ok(shelf.button('Copy full image'));
  });

  it('with no last capture it says how to make one', async () => {
    const t = setup({ info: null });
    const shelf = await open(t);
    assert.ok(textOf(shelf.root).includes('Nothing to insert yet. Press Alt+Shift+S to spool a page.'));
    assert.equal(findAll(shelf.root, (e) => e.className === 'btn primary wide').length, 0);
  });

  it('shows the message of the service worker when it refuses (an expired shelf)', async () => {
    const t = setup({
      replies: {
        [MSG.PAGE_SHELF_INFO]: () => ({
          ok: false,
          error: { code: ERR.SESSION_NOT_FOUND, message: 'This capture has expired here. Press Alt+Shift+V again.' },
        }),
      },
    });
    const shelf = await open(t);
    assert.ok(textOf(shelf.root).includes('This capture has expired here. Press Alt+Shift+V again.'));
  });

  it('does nothing without a shelf config (wrong mode, no token, old protocol)', async () => {
    for (const bad of [
      config({ mode: 'capture' }),
      config({ shelfToken: '' }),
      config({ protocolVersion: 2 }),
      config({ shelfToken: 'x'.repeat(100) }),
      null,
    ]) {
      const t = setup({ config: bad });
      t.ns.shelf.start();
      await flush();
      assert.deepEqual(t.hosts(), []);
      assert.deepEqual(t.sent, []);
    }
  });

  it('a summary without tiles is the empty state, not a broken card', async () => {
    const t = setup({ info: { tileCount: 0 } });
    const shelf = await open(t);
    assert.ok(textOf(shelf.root).includes('Nothing to insert yet.'));
  });
});

describe('shelf.js: Insert N tiles', () => {
  it('reads every tile and dispatches one paste with N PNG files at the element that had the focus', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    t.page.activeElement = t.body; // the focus moves later (a click): the target stays the editor
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.deepEqual(
      t.sent.filter((m) => m.type === 'page/shelf-get'),
      [0, 1, 2].map((item) => ({ v: 1, target: 'sw', type: 'page/shelf-get', token: TOKEN, item })),
    );
    assert.equal(target.pastes.length, 1, 'one paste for all tiles');
    const event = target.pastes[0];
    assert.equal(event.type, 'paste');
    assert.equal(event.bubbles && event.cancelable && event.composed, true);
    assert.deepEqual(
      event.clipboardData.files.map((/** @type {any} */ f) => [f.name, f.type]),
      [
        ['screenshot-01-of-03.png', 'image/png'],
        ['screenshot-02-of-03.png', 'image/png'],
        ['screenshot-03-of-03.png', 'image/png'],
      ],
    );
    assert.equal(shelf.status(), 'Inserted 3 screenshots.');
  });

  it('closes itself 2 s after "Inserted"', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    t.timers.advance(1900);
    assert.equal(shelf.host.removed, false);
    t.timers.advance(100 + 167);
    assert.equal(shelf.host.removed, true);
  });

  it('a page that does not take the paste gets the steps, and the shelf stays', async () => {
    const t = setup();
    const target = editor(false);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 1);
    // The steps: one screenshot at a time, with the paste key of the system.
    assert.equal(textOf(findAll(shelf.root, (e) => e.className === 'title')[0]), "This chat won't take them all at once.");
    assert.ok(textOf(shelf.root).includes('Copy one, press Ctrl+V, then come back.'));
    assert.ok(shelf.button('Copy screenshot 1 of 3'));
    t.timers.advance(60_000);
    assert.equal(shelf.host.removed, false);
  });

  it('one image: the refusal offers to copy it, then press the paste key', async () => {
    const t = setup({ info: summary({ tileCount: 1, fitsOneImage: true }) });
    const target = editor(false);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 1 screenshot').dispatch('click');
    await flush();
    await flush();
    assert.ok(textOf(shelf.root).includes("This chat didn't take the paste."));
    assert.ok(shelf.button('Copy the image'));
    assert.equal(target.pastes[0].clipboardData.files[0].name, 'screenshot-01-of-01.png');
  });

  it('falls back to the page body when nothing had the focus, or the element is gone', async () => {
    const t = setup();
    /** @type {any[]} */
    const onBody = [];
    t.body.addEventListener('paste', (/** @type {any} */ e) => onBody.push(e));
    const first = await open(t);
    first.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(onBody.length, 1);

    const gone = editor(true);
    t.page.activeElement = gone.el;
    const second = await open(t);
    gone.el.remove();
    second.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(gone.pastes.length, 0);
    assert.equal(onBody.length, 2);
  });

  it('a tile that cannot be read stops the insert with the message of the refusal and no paste', async () => {
    const t = setup({
      replies: {
        [MSG.PAGE_SHELF_GET]: (msg) =>
          msg.item === 1
            ? { ok: false, error: { code: ERR.SESSION_NOT_FOUND, message: 'This shelf has expired.' } }
            : { ok: true, pngBase64: PNG_BASE64 },
      },
    });
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 0);
    assert.equal(shelf.status(), 'This shelf has expired.');
  });

  it('presses only on a trusted click, and only once at a time', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    const insert = shelf.button('Insert 3 screenshots');
    insert.dispatch('click', { isTrusted: false });
    await flush();
    assert.equal(target.pastes.length, 0);
    insert.dispatch('click');
    insert.dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 1);
  });

  it('a shelf that opens on the focused element of its own host keeps the earlier target', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const first = await open(t);
    t.page.activeElement = first.host; // the user pressed Tab into the shelf
    const second = await open(t);
    assert.equal(first.host.removed, true, 'the new shelf replaces the old one');
    second.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 1);
  });
});

describe('shelf.js: copy chips and the full image', () => {
  it('a chip copies that tile: the write starts in the click', async () => {
    const t = setup();
    const shelf = await open(t);
    const chip = /** @type {FakeElement} */ (shelf.chips()[2]);
    chip.dispatch('click');
    assert.equal(t.clipboard.writes.length, 1);
    assert.deepEqual(t.sent.at(-1), { v: 1, target: 'sw', type: 'page/shelf-get', token: TOKEN, item: 2 });
    await flush();
    await flush();
    assert.equal(textOf(chip), '3 · Copied');
    t.timers.advance(2000);
    assert.equal(textOf(chip), '3');
  });

  it('"Copy full image" asks for the full image', async () => {
    const t = setup();
    const shelf = await open(t);
    shelf.button('Copy full image').dispatch('click');
    assert.equal(t.clipboard.writes.length, 1);
    assert.deepEqual(t.sent.at(-1), { v: 1, target: 'sw', type: 'page/shelf-get', token: TOKEN, item: 'full' });
    await flush();
    await flush();
    assert.ok(textOf(shelf.root).includes('Copied'));
  });

  it('says so when the page does not allow the clipboard', async () => {
    const t = setup();
    t.clipboard.missing = true;
    const shelf = await open(t);
    shelf.button('Copy full image').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Could not copy on this page.');
    assert.ok(textOf(shelf.root).includes('Not copied'));
  });
});

describe('shelf.js: Esc, close and what the page can see', () => {
  it('Esc closes the shelf and the page does not get that key', async () => {
    const t = setup();
    const shelf = await open(t);
    const event = t.win.dispatch('keydown', { key: 'Escape', ctrlKey: false, metaKey: false, altKey: false });
    assert.equal(event.defaultPrevented && event.immediatelyStopped, true);
    t.timers.advance(167);
    assert.equal(shelf.host.removed, true);
    assert.equal(t.win.listenerCount('keydown'), 0);
  });

  it('a fake Escape does nothing', async () => {
    const t = setup();
    const shelf = await open(t);
    t.win.dispatch('keydown', { key: 'Escape', isTrusted: false });
    t.timers.advance(1000);
    assert.equal(shelf.host.removed, false);
  });

  it('the close button closes it; dismiss() too', async () => {
    const t = setup();
    const shelf = await open(t);
    shelf.button('Close (Esc)').dispatch('click');
    t.timers.advance(167);
    assert.equal(shelf.host.removed, true);

    const again = await open(t);
    t.ns.shelf.dismiss();
    t.timers.advance(167);
    assert.equal(again.host.removed, true);
  });

  it('never takes the focus, and a press does not move it from the editor', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    for (const el of t.created) assert.equal(el.focusCalls, 0);
    assert.equal(shelf.surface.dispatch('mousedown').defaultPrevented, true);
  });

  it('the host has no attribute; a closed shadow root; text only; no <img>', async () => {
    const t = setup({ info: summary({ save: { location: 'folder', label: '<b>x</b>', files: 1 } }) });
    const shelf = await open(t);
    assert.deepEqual([...shelf.host.attributes], []);
    assert.equal(shelf.host.shadowRoot, null);
    assert.ok(!t.createdTags.includes('img'));
    assert.deepEqual(t.consoleErrors, []);
  });

  it('closes when the extension was reloaded', async () => {
    const t = setup();
    const shelf = await open(t);
    t.extension.id = undefined;
    t.timers.advance(1000);
    assert.equal(shelf.host.removed, true);
  });

  it('a late answer after the shelf closed does nothing', async () => {
    const t = setup();
    t.ns.shelf.start();
    t.ns.shelf.dismiss();
    t.timers.advance(167);
    await flush();
    await flush();
    assert.deepEqual(t.hosts(), []);
    assert.deepEqual(t.consoleErrors, []);
  });
});
