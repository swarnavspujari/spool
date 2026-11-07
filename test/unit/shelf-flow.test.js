// @ts-check
/**
 * Tests for the new work of src/page/shelf.js (docs/contracts.md section 5, shelf.js):
 *  - the card says where the pixels come from and into which page they go;
 *  - the guard against clickjacking: Insert is off while the card is new and while the browser
 *    says that something covers it (IntersectionObserver v2), and the card puts itself back on top;
 *  - more tiles than a chat takes: batches of 20, tiles fetched three at a time, a truthful result;
 *  - the place of the paste: the focused editor, else a composer that the shelf finds, found again
 *    at the click (the editor can be made again);
 *  - the steps after a page refuses the paste, and the hints for a desktop app;
 *  - a capture that is too tall to copy as one image has no "Copy full image".
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
} from '../helpers/fake-card-dom.js';

const TOKEN = '22222222-2222-4222-8222-222222222222';
const SESSION = '11111111-1111-4111-8111-111111111111';
const PNG_BASE64 = 'iVBORw0KGgo=';
const DWELL_MS = 400;

const MAC_KEYS = Object.freeze({
  start: { parts: ['⌃', '⇧', 'S'], text: '⌃⇧S' },
  insert: { parts: ['⌃', '⇧', 'V'], text: '⌃⇧V' },
  paste: { parts: ['⌘', 'V'], text: '⌘V' },
});

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

/** The `ShelfSummary` that the worker gives. @param {Record<string, unknown>} [more] */
function summary(more = {}) {
  return {
    tileCount: 3,
    widthPx: 1500,
    heightPx: 6240,
    createdAt: Date.now(),
    sourceHost: 'github.com',
    saveLabel: 'Pictures/Screenshots',
    thumbnailPngBase64: PNG_BASE64,
    thumbnailWidthPx: 320,
    thumbnailHeightPx: 480,
    ...more,
  };
}

/**
 * @param {{ info?: unknown, replies?: Record<string, (msg: any) => unknown>,
 *   config?: Record<string, unknown>, intersection?: boolean, hostname?: string,
 *   platform?: string }} [options]
 */
function setup({
  info = summary(),
  replies = {},
  config: more = {},
  intersection = false,
  hostname,
  platform,
} = {}) {
  const t = setupCards({
    files: ['src/page/ui-kit.js', 'src/page/shelf.js'],
    config: config(more),
    replies: {
      [MSG.PAGE_SHELF_INFO]: () => ({ ok: true, summary: info }),
      [MSG.PAGE_SHELF_GET]: () => ({ ok: true, pngBase64: PNG_BASE64 }),
      ...replies,
    },
    intersection,
    hostname,
    platform,
  });
  assert.ok(t.ns.shelf);
  return t;
}

/**
 * Opens the shelf. `wait`: let the 400 ms of the guard pass, so that Insert is on.
 * @param {ReturnType<typeof setup>} t
 * @param {{ wait?: boolean }} [options]
 */
async function open(t, { wait = true } = {}) {
  t.ns.shelf.start();
  await flush();
  await flush();
  if (wait) t.timers.advance(DWELL_MS + 50);
  const host = /** @type {FakeElement} */ (t.hosts().at(-1));
  assert.ok(host, 'a shelf host is on screen');
  const root = t.rootOf(host);
  const statusBox = () => findAll(root, (e) => e.className === 'status')[0];
  return {
    host,
    root,
    text: () => textOf(root),
    status: () => textOf(statusBox()),
    statusBox,
    button: (/** @type {string} */ label) =>
      findOne(
        root,
        (e) =>
          e.tagName === 'BUTTON' &&
          (textOf(e).trim() === label || e.attributes.get('aria-label') === label),
        `button "${label}"`,
      ),
    hasButton: (/** @type {string} */ label) =>
      findAll(
        root,
        (e) =>
          e.tagName === 'BUTTON' &&
          (textOf(e).trim() === label || e.attributes.get('aria-label') === label),
      ).length > 0,
    chips: () => findAll(root, (e) => e.className === 'chip'),
    title: () => textOf(findAll(root, (e) => e.className === 'title')[0]),
    captions: () => findAll(root, (e) => e.className === 'caption').map((e) => textOf(e)),
  };
}

/** An editor that records the paste events that reach it. @param {boolean} [accepts] */
function editor(accepts = true) {
  const el = new FakeElement('div');
  el.isContentEditable = true;
  el.rect = { top: 690, bottom: 760, left: 100, right: 700, width: 600, height: 70 };
  /** @type {any[]} */
  const pastes = [];
  el.addEventListener('paste', (/** @type {any} */ event) => {
    pastes.push(event);
    if (accepts) event.preventDefault();
  });
  return { el, pastes };
}

const names = (/** @type {any} */ event) =>
  event.clipboardData.files.map((/** @type {any} */ f) => f.name);

describe('shelf.js: where the pixels come from', () => {
  it('says how many AI screenshots, from which host, and how old', async () => {
    const shelf = await open(setup({ info: summary({ createdAt: Date.now() - 4 * 60_000 - 500 }) }));
    assert.equal(shelf.title(), 'Insert into this chat?');
    assert.deepEqual(shelf.captions()[0], '3 AI screenshots from github.com, 4 min ago.');
  });

  it('says "from a local page" when the capture has no host (a local file)', async () => {
    const shelf = await open(setup({ info: summary({ sourceHost: '' }) }));
    assert.equal(shelf.captions()[0], '3 AI screenshots from a local page, just now.');
  });

  it('writes one screenshot in the singular', async () => {
    const shelf = await open(setup({ info: summary({ tileCount: 1 }) }));
    assert.equal(shelf.captions()[0], '1 AI screenshot from github.com, just now.');
    assert.ok(shelf.hasButton('Insert 1 screenshot'));
  });

  it('says into which page they would go, with the host of the page that the shelf is in', async () => {
    const shelf = await open(setup({ hostname: 'chat.example.com' }));
    assert.ok(shelf.captions().includes('Into chat.example.com'));
  });

  it('shows the host as text only: no markup, no link, whatever the host contains', async () => {
    const t = setup({ info: summary({ sourceHost: '<img src=x onerror=alert(1)>.example' }) });
    const shelf = await open(t);
    assert.ok(shelf.captions()[0]?.includes('<img src=x'));
    assert.ok(!t.createdTags.includes('img'));
    assert.ok(!t.createdTags.includes('a'));
  });

  it('cuts a host that is longer than a host name can be', async () => {
    const shelf = await open(setup({ info: summary({ sourceHost: 'a'.repeat(400) }) }));
    assert.ok((shelf.captions()[0] ?? '').length < 300);
  });

  it('keeps one send: a capture is not shown with a host that the page could have changed', async () => {
    // The shelf asks only for the summary: the host comes from the worker, not from the page.
    const t = setup();
    await open(t);
    assert.deepEqual(
      t.sent.map((m) => m.type),
      [MSG.PAGE_SHELF_INFO],
    );
  });
});

describe('shelf.js: the guard against clickjacking', () => {
  it('Insert is off while the card is new, and on after 400 ms', async () => {
    const t = setup();
    const shelf = await open(t, { wait: false });
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true);
    t.timers.advance(DWELL_MS - 1);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true);
    t.timers.advance(1);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
  });

  it('a click in the first 400 ms does nothing: no tile is asked for, nothing is pasted', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t, { wait: false });
    shelf.button('Insert 3 screenshots').dispatch('click'); // a browser would not even send it
    await flush();
    await flush();
    assert.equal(target.pastes.length, 0);
    assert.deepEqual(
      t.sent.map((m) => m.type),
      [MSG.PAGE_SHELF_INFO],
    );
    assert.equal(shelf.status(), 'Something on this page covers Spool. Click again in a moment.');
    assert.equal(shelf.statusBox()?.dataset['level'], 'error');
  });

  it('a browser with IntersectionObserver v2 watches the card, with the visibility option', async () => {
    const t = setup({ intersection: true });
    const shelf = await open(t);
    assert.equal(t.observers.length, 1);
    const [observer] = t.observers;
    assert.equal(observer?.options.trackVisibility, true);
    assert.ok(observer.options.delay >= 100, 'the API asks for 100 ms or more');
    // The card, not a button: a disabled button is drawn at 45% opacity, which counts as not visible.
    assert.equal(observer.targets[0]?.className, 'card');
    assert.equal(shelf.host.removed, false);
  });

  it('while the browser says that something covers the card, Insert is off and the card says why', async () => {
    const t = setup({ intersection: true });
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    const [observer] = t.observers;
    observer?.report({ isIntersecting: true, isVisible: true });
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);

    observer?.report({ isIntersecting: true, isVisible: false }); // the page put a layer over it
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true);
    assert.equal(shelf.status(), 'Something on this page covers Spool. Click again in a moment.');
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 0, 'the click went through the layer, and got nowhere');
    assert.equal(t.sent.filter((m) => m.type === MSG.PAGE_SHELF_GET).length, 0);
  });

  it('a card that is not on the screen at all counts as covered', async () => {
    const t = setup({ intersection: true });
    const shelf = await open(t);
    t.observers[0]?.report({ isIntersecting: false, isVisible: false });
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true);
  });

  it('puts the card above what covers it, at most once a second', async () => {
    const t = setup({ intersection: true });
    const shelf = await open(t);
    const host = /** @type {FakePopoverElement} */ (/** @type {unknown} */ (shelf.host));
    const [observer] = t.observers;
    const before = host.shown;
    observer?.report({ isIntersecting: true, isVisible: false });
    assert.equal(host.shown, before + 1, 'hidden and shown again: last in the top layer');
    observer?.report({ isIntersecting: true, isVisible: true });
    observer?.report({ isIntersecting: true, isVisible: false });
    assert.equal(host.shown, before + 1, 'not again within a second');
    t.timers.advance(1000);
    observer?.report({ isIntersecting: true, isVisible: true });
    observer?.report({ isIntersecting: true, isVisible: false });
    assert.equal(host.shown, before + 2, 'a second later it does');
  });

  it('after the layer is gone, Insert comes back only after 400 ms of a visible card', async () => {
    const t = setup({ intersection: true });
    const shelf = await open(t);
    const [observer] = t.observers;
    observer?.report({ isIntersecting: true, isVisible: false });
    observer?.report({ isIntersecting: true, isVisible: true });
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true, 'not at once');
    t.timers.advance(DWELL_MS - 1);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true);
    t.timers.advance(1);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
    assert.equal(shelf.status(), '', 'the warning is gone');
  });

  it('a layer that comes back within the 400 ms starts the wait again', async () => {
    const t = setup({ intersection: true });
    const shelf = await open(t);
    const [observer] = t.observers;
    observer?.report({ isIntersecting: true, isVisible: false });
    observer?.report({ isIntersecting: true, isVisible: true });
    t.timers.advance(300);
    observer?.report({ isIntersecting: true, isVisible: false });
    observer?.report({ isIntersecting: true, isVisible: true });
    t.timers.advance(300);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true, '600 ms in all, 300 since the last');
    t.timers.advance(100);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
  });

  it('a click that arrives while the page covers the card is refused, also when the button is on', async () => {
    const t = setup({ intersection: true });
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    const button = shelf.button('Insert 3 screenshots');
    t.observers[0]?.report({ isIntersecting: true, isVisible: false });
    button.disabled = false; // a click that was on its way when the browser said "covered"
    button.dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 0);
  });

  it('a browser without v2 reports no answer: then the wait of 400 ms is the guard', async () => {
    const t = setup({ intersection: true });
    const shelf = await open(t);
    t.observers[0]?.report({ isIntersecting: true }); // no isVisible
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
  });

  it('a browser without IntersectionObserver still has the wait', async () => {
    const t = setup({ intersection: false });
    const shelf = await open(t, { wait: false });
    assert.equal(t.observers.length, 0);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, true);
    t.timers.advance(DWELL_MS);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
  });

  it('an IntersectionObserver that throws does not stop the shelf', async () => {
    const t = setup({ intersection: true });
    t.context.IntersectionObserver = class {
      constructor() {
        throw new TypeError('trackVisibility is not supported');
      }
    };
    const shelf = await open(t);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
  });

  it('the observer ends with the shelf: no answer after it closed, no timer left', async () => {
    const t = setup({ intersection: true });
    const shelf = await open(t, { wait: false });
    t.ns.shelf.dismiss();
    t.timers.advance(167);
    assert.equal(t.observers[0]?.disconnected, true);
    assert.doesNotThrow(() => t.observers[0]?.report({ isIntersecting: true, isVisible: false }));
    assert.equal(shelf.host.removed, true);
    assert.equal(t.timers.pending, 0);
  });

  it('only a trusted click counts: a fake click on the button does nothing', async () => {
    const t = setup();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click', { isTrusted: false });
    await flush();
    assert.equal(target.pastes.length, 0);
  });
});

describe('shelf.js: more tiles than a chat takes', () => {
  /** @param {number} tiles */
  const big = (tiles) => setup({ info: summary({ tileCount: tiles, heightPx: 90_000 }) });

  it('asks "Insert the first 20?", explains the limit and has two buttons', async () => {
    const shelf = await open(big(26));
    assert.equal(shelf.title(), 'Insert the first 20?');
    assert.ok(
      shelf.captions().includes('Most AI chats take up to 20 images in one message. This capture has 26 AI screenshots.'),
    );
    assert.equal(shelf.captions()[0], '26 AI screenshots from github.com, just now.');
    assert.ok(shelf.hasButton('Insert first 20'));
    assert.ok(shelf.hasButton('Insert the other 6 next'));
    assert.equal(shelf.chips().length, 26, 'one chip for each tile, still');
  });

  it('20 tiles or fewer are one batch: one button, no limit text', async () => {
    for (const tiles of [2, 19, 20]) {
      const shelf = await open(big(tiles));
      assert.equal(shelf.title(), 'Insert into this chat?', String(tiles));
      assert.ok(shelf.hasButton(`Insert ${tiles} screenshots`));
      assert.ok(!shelf.text().includes('Most AI chats'), String(tiles));
      assert.ok(!shelf.text().includes('Insert first'));
    }
    assert.ok((await open(big(21))).text().includes('Most AI chats'));
  });

  it('the first press pastes screenshots 1 to 20, named for their place among all 26', async () => {
    const t = big(26);
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert first 20').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(target.pastes.length, 1, 'one paste');
    const first = names(target.pastes[0]);
    assert.equal(first.length, 20);
    assert.equal(first[0], 'screenshot-01-of-26.png');
    assert.equal(first[19], 'screenshot-20-of-26.png');
    const items = t.sent.filter((m) => m.type === MSG.PAGE_SHELF_GET).map((m) => m.item);
    assert.deepEqual(items, Array.from({ length: 20 }, (_, i) => i), 'only the tiles of this batch');
  });

  it('says how many it inserted, and that the rest waits; the shelf stays open', async () => {
    const t = big(26);
    t.page.activeElement = editor(true).el;
    const shelf = await open(t);
    shelf.button('Insert first 20').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Inserted 1–20 of 26. Send your message, then insert the rest.');
    assert.equal(shelf.statusBox()?.dataset['level'], 'ok');
    t.timers.advance(60_000);
    assert.equal(shelf.host.removed, false, 'it does not close: the rest is still to come');
    assert.equal(shelf.title(), 'Insert the rest?');
  });

  it('then the other button becomes the main one, and inserts 21 to 26 and closes', async () => {
    const t = big(26);
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert first 20').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.ok(shelf.hasButton('Insert the other 6 next'));
    t.sent.length = 0;
    shelf.button('Insert the other 6 next').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(target.pastes.length, 2);
    const second = names(target.pastes[1]);
    assert.deepEqual(second, [21, 22, 23, 24, 25, 26].map((n) => `screenshot-${n}-of-26.png`));
    assert.deepEqual(
      t.sent.filter((m) => m.type === MSG.PAGE_SHELF_GET).map((m) => m.item),
      [20, 21, 22, 23, 24, 25],
    );
    assert.equal(shelf.status(), 'Inserted 21–26 of 26.');
    t.timers.advance(2000);
    t.timers.advance(167);
    assert.equal(shelf.host.removed, true);
  });

  it('the second button can go first: it inserts the last batch, the first one stays to do', async () => {
    const t = big(26);
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert the other 6 next').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(names(target.pastes[0]).length, 6);
    assert.equal(shelf.status(), 'Inserted 21–26 of 26. Send your message, then insert the rest.');
    assert.ok(shelf.hasButton('Insert first 20'), 'the first batch is still to do');
  });

  it('a capture of three batches: first 20, the next 20, the other N', async () => {
    const t = big(45);
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    assert.ok(shelf.hasButton('Insert first 20'));
    assert.ok(shelf.hasButton('Insert the next 20'));
    shelf.button('Insert first 20').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.ok(shelf.hasButton('Insert the next 20'));
    assert.ok(shelf.hasButton('Insert the other 5 next'));
    shelf.button('Insert the next 20').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Inserted 21–40 of 45. Send your message, then insert the rest.');
    assert.ok(shelf.hasButton('Insert the other 5 next'));
    assert.equal(findAll(shelf.root, (e) => e.textContent === 'Insert the next 20').length, 0);
  });

  it('a batch that was skipped stays on the main button: nothing is lost behind a later batch', async () => {
    const t = big(45);
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert the next 20').dispatch('click'); // batch 2 of 3 first
    await flush();
    await flush();
    await flush();
    assert.deepEqual(names(target.pastes[0]).slice(0, 1), ['screenshot-21-of-45.png']);
    assert.ok(shelf.hasButton('Insert first 20'), 'the first batch is still the main button');
    assert.ok(shelf.hasButton('Insert the other 5 next'));
    assert.equal(shelf.title(), 'Insert the rest?');
    assert.equal(shelf.host.removed, false);
  });

  it('a capture of 20 or fewer says "Inserted 5 screenshots." and closes', async () => {
    const t = big(5);
    t.page.activeElement = editor(true).el;
    const shelf = await open(t);
    shelf.button('Insert 5 screenshots').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Inserted 5 screenshots.');
    t.timers.advance(2000 + 167);
    assert.equal(shelf.host.removed, true);
  });

  it('uses the limit that the worker sends in the config', async () => {
    const t = setup({
      info: summary({ tileCount: 7 }),
      config: { limits: { maxImagesPerMessage: 5, maxClipboardBitmapBytes: 1e9 } },
    });
    const shelf = await open(t);
    assert.equal(shelf.title(), 'Insert the first 5?');
    assert.ok(shelf.hasButton('Insert first 5'));
    assert.ok(shelf.hasButton('Insert the other 2 next'));
  });

  it('ignores a limit that is not a number of at least 1, and uses 20', async () => {
    for (const maxImagesPerMessage of [0, -3, Number.NaN, '5', null]) {
      const t = setup({
        info: summary({ tileCount: 26 }),
        config: { limits: { maxImagesPerMessage, maxClipboardBitmapBytes: 1e9 } },
      });
      const shelf = await open(t);
      assert.equal(shelf.title(), 'Insert the first 20?', String(maxImagesPerMessage));
    }
  });

  it('fetches the tiles at most three at a time, never all together', async () => {
    /** @type {((value: unknown) => void)[]} */
    const waiting = [];
    let inFlight = 0;
    let most = 0;
    const t = setup({
      info: summary({ tileCount: 12 }),
      replies: {
        [MSG.PAGE_SHELF_GET]: () => {
          inFlight += 1;
          most = Math.max(most, inFlight);
          return new Promise((resolve) =>
            waiting.push(() => {
              inFlight -= 1;
              resolve({ ok: true, pngBase64: PNG_BASE64 });
            }),
          );
        },
      },
    });
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert 12 screenshots').dispatch('click');
    await flush();
    assert.equal(inFlight, 3, 'three tiles are being fetched');
    assert.equal(target.pastes.length, 0);
    for (let guard = 0; guard < 40 && (waiting.length > 0 || inFlight > 0); guard += 1) {
      waiting.shift()?.(undefined);
      await flush();
    }
    await flush();
    assert.equal(most, 3, 'never more than three at once');
    assert.equal(target.pastes.length, 1);
    assert.equal(names(target.pastes[0]).length, 12);
    assert.equal(names(target.pastes[0])[11], 'screenshot-12-of-12.png');
  });

  it('a tile that fails stops the fetch: no more tiles are asked for, and nothing is pasted', async () => {
    const t = setup({
      info: summary({ tileCount: 12 }),
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
    shelf.button('Insert 12 screenshots').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(target.pastes.length, 0);
    assert.equal(shelf.status(), 'This shelf has expired.');
    assert.ok(t.sent.filter((m) => m.type === MSG.PAGE_SHELF_GET).length < 12, 'it did not go on');
    assert.equal(shelf.button('Insert 12 screenshots').disabled, false, 'it can be tried again');
  });
});

describe('shelf.js: the place of the paste', () => {
  it('nothing has the focus: the paste goes to the composer that the shelf finds, not to the body', async () => {
    const t = setup();
    const box = editor(true);
    t.page.editables = [box.el];
    /** @type {any[]} */
    const onBody = [];
    t.body.addEventListener('paste', (/** @type {any} */ e) => onBody.push(e));
    const shelf = await open(t);
    assert.ok(!shelf.status().includes('Click your message box'), 'a composer was found');
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(box.pastes.length, 1);
    assert.equal(onBody.length, 0);
  });

  it('the composer was made again after the shelf opened: the paste goes to the new one', async () => {
    const t = setup();
    const old = editor(true);
    t.page.activeElement = old.el;
    t.page.editables = [old.el];
    const shelf = await open(t);
    const fresh = editor(true);
    old.el.remove();
    t.page.activeElement = t.body;
    t.page.editables = [fresh.el];
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(old.pastes.length, 0, 'not to the node that left the page');
    assert.equal(fresh.pastes.length, 1);
  });

  it('the user clicked another editor after the shelf opened: that one gets it', async () => {
    const t = setup();
    const first = editor(true);
    const second = editor(true);
    t.page.activeElement = first.el;
    const shelf = await open(t);
    t.page.activeElement = second.el;
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(first.pastes.length, 0);
    assert.equal(second.pastes.length, 1);
  });

  it('a button that has the focus does not get a paste while the page has a composer', async () => {
    const t = setup();
    const box = editor(true);
    t.page.editables = [box.el];
    const button = new FakeElement('button');
    /** @type {any[]} */
    const onButton = [];
    button.addEventListener('paste', (/** @type {any} */ e) => onButton.push(e));
    t.page.activeElement = button;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(onButton.length, 0);
    assert.equal(box.pastes.length, 1);
  });

  it('never moves the focus: the editor keeps it', async () => {
    const t = setup();
    const box = editor(true);
    t.page.editables = [box.el];
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(box.el.focusCalls, 0);
    for (const el of t.created) assert.equal(el.focusCalls, 0);
  });

  it('with no editor in the page, it says to click the message box first, and Insert still works', async () => {
    const t = setup({ config: { keys: MAC_KEYS } });
    /** @type {any[]} */
    const onBody = [];
    t.body.addEventListener('paste', (/** @type {any} */ e) => onBody.push(e));
    const shelf = await open(t);
    assert.equal(
      shelf.status(),
      'Click your message box first. Spool inserts where your cursor is. Press ⌃⇧V again after you click.',
    );
    // A page that takes a paste anywhere (an upload page) still gets it.
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(onBody.length, 1);
  });

  it('without a key for the shelf command, the message does not name one', async () => {
    const t = setup({ config: { shortcuts: { start: 'Alt+Shift+S', insert: '' } } });
    const shelf = await open(t);
    assert.equal(
      shelf.status(),
      'Click your message box first. Spool inserts where your cursor is. ' +
        'Run Insert last capture again after you click.',
    );
  });

  it('an editor has the focus: no message about the message box', async () => {
    const t = setup();
    t.page.activeElement = editor(true).el;
    assert.equal((await open(t)).status(), '');
  });

  it('a composer was found: no message about the message box', async () => {
    const t = setup();
    t.page.editables = [editor(true).el];
    assert.equal((await open(t)).status(), '');
  });
});

describe('shelf.js: after a page refuses the paste, one screenshot at a time (H1)', () => {
  /** Opens, presses Insert on an editor that refuses, and waits for the steps. @param {Record<string, unknown>} [more] */
  async function refused(more = {}) {
    const t = setup(more);
    const target = editor(false);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    const label = textOf(findAll(shelf.root, (e) => e.className === 'btn primary wide')[0]).trim();
    shelf.button(label).dispatch('click');
    await flush();
    await flush();
    await flush();
    return { t, shelf, target };
  }

  it('shows the heading, the paste key and the first step, with a progress bar at one of three', async () => {
    const { shelf } = await refused({ info: summary({ tileCount: 5 }) });
    assert.equal(shelf.title(), "This chat won't take them all at once.");
    assert.ok(shelf.text().includes('Copy one, press Ctrl+V, then come back.'));
    assert.ok(shelf.hasButton('Copy screenshot 1 of 5'));
    const bar = findOne(shelf.root, (e) => e.className === 'progress', 'progress');
    assert.equal(bar.attributes.get('role'), 'progressbar');
    assert.equal(bar.attributes.get('aria-valuenow'), '1');
    assert.equal(bar.attributes.get('aria-valuemax'), '5');
    assert.equal(findAll(bar, (e) => e.tagName === 'SPAN')[0]?.style['width'], '20%');
  });

  it('the paste key is ⌘V on a Mac', async () => {
    const { shelf } = await refused({ config: { keys: MAC_KEYS }, info: summary({ tileCount: 5 }) });
    assert.ok(shelf.text().includes('Copy one, press ⌘V, then come back.'));
  });

  it('a step starts the clipboard write in its own click, with a promise of that tile', async () => {
    const { t, shelf } = await refused({ info: summary({ tileCount: 5 }) });
    t.sent.length = 0;
    shelf.button('Copy screenshot 1 of 5').dispatch('click');
    assert.equal(t.clipboard.writes.length, 1, 'clipboard.write ran inside the click');
    assert.deepEqual(t.clipboard.writes[0]?.types, ['image/png']);
    assert.deepEqual(
      t.sent.map((m) => [m.type, m.item]),
      [[MSG.PAGE_SHELF_GET, 0]],
    );
  });

  it('after a copy it says what to do, and moves to the next step and the next part of the bar', async () => {
    const { shelf, t } = await refused({ info: summary({ tileCount: 5 }) });
    shelf.button('Copy screenshot 1 of 5').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Copied screenshot 1 of 5. Press Ctrl+V in your chat.');
    assert.equal(shelf.statusBox()?.dataset['level'], 'ok');
    assert.ok(shelf.hasButton('Copy screenshot 2 of 5'));
    const bar = findOne(shelf.root, (e) => e.className === 'progress', 'progress');
    assert.equal(bar.attributes.get('aria-valuenow'), '2');
    shelf.button('Copy screenshot 2 of 5').dispatch('click');
    await flush();
    await flush();
    assert.deepEqual(
      t.sent.filter((m) => m.type === MSG.PAGE_SHELF_GET).slice(-2).map((m) => m.item),
      [0, 1],
    );
  });

  it('after the last one, the button says "All copied" and is off, and the bar is full', async () => {
    const { shelf } = await refused({ info: summary({ tileCount: 2 }) });
    for (const n of [1, 2]) {
      shelf.button(`Copy screenshot ${n} of 2`).dispatch('click');
      await flush();
      await flush();
    }
    const done = shelf.button('All copied');
    assert.equal(done.disabled, true);
    const bar = findOne(shelf.root, (e) => e.className === 'progress', 'progress');
    assert.equal(findAll(bar, (e) => e.tagName === 'SPAN')[0]?.style['width'], '100%');
    assert.equal(shelf.status(), 'Copied screenshot 2 of 2. Press Ctrl+V in your chat.');
  });

  it('a copy that fails stays on the same step and says so', async () => {
    const { shelf, t } = await refused({ info: summary({ tileCount: 3 }) });
    t.clipboard.reject = true;
    shelf.button('Copy screenshot 1 of 3').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Could not copy on this page.');
    assert.equal(shelf.statusBox()?.dataset['level'], 'error');
    assert.ok(shelf.hasButton('Copy screenshot 1 of 3'));
    assert.equal(shelf.button('Copy screenshot 1 of 3').disabled, false);
  });

  it('the button is off while a copy runs, and a second click does not start another', async () => {
    const { shelf, t } = await refused({ info: summary({ tileCount: 3 }) });
    t.runtime.sendMessage = () => new Promise(() => {}); // the tile never arrives
    const step = shelf.button('Copy screenshot 1 of 3');
    step.dispatch('click');
    assert.equal(step.disabled, true);
    step.dispatch('click');
    assert.equal(t.clipboard.writes.length, 1);
  });

  it('a refusal of the worker (a newer capture) shows its message in the steps', async () => {
    const t = setup({ info: summary({ tileCount: 3 }) });
    t.page.activeElement = editor(false).el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    await flush();
    t.runtime.sendMessage = (/** @type {any} */ msg) =>
      Promise.resolve(
        msg.type === MSG.PAGE_SHELF_GET
          ? { ok: false, error: { code: ERR.SESSION_NOT_FOUND, message: 'A newer capture exists. Press Alt+Shift+V again.' } }
          : { ok: true },
      );
    shelf.button('Copy screenshot 1 of 3').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), 'A newer capture exists. Press Alt+Shift+V again.');
  });

  it('a capture that came in batches steps through all of its screenshots, from the first of the refused batch', async () => {
    const t = setup({ info: summary({ tileCount: 26, heightPx: 90_000 }) });
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await open(t);
    shelf.button('Insert first 20').dispatch('click');
    await flush();
    await flush();
    await flush();
    target.el.listeners.set('paste', []); // now the page stops taking it
    target.el.addEventListener('paste', () => {});
    shelf.button('Insert the other 6 next').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(shelf.title(), "This chat won't take them all at once.");
    assert.ok(shelf.hasButton('Copy screenshot 21 of 26'), 'it starts at the batch that was refused');
  });

  it('one image: "This chat didn\'t take the paste." and "Copy the image"', async () => {
    const { shelf } = await refused({ info: summary({ tileCount: 1 }) });
    assert.equal(shelf.title(), "This chat didn't take the paste.");
    assert.ok(shelf.text().includes('Copy it, then press Ctrl+V in your chat.'));
    assert.ok(shelf.hasButton('Copy the image'));
    shelf.button('Copy the image').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Copied. Press Ctrl+V in your chat.');
  });

  it('the steps replace the Insert buttons: the guard has nothing left to watch', async () => {
    const t = setup({ intersection: true, info: summary({ tileCount: 3 }) });
    t.page.activeElement = editor(false).el;
    const shelf = await open(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    await flush();
    assert.equal(t.observers[0]?.disconnected, true);
    assert.ok(!shelf.hasButton('Insert 3 screenshots'));
  });

  it('desktop app hint: the paste key, and the folder of the screenshots with its place', async () => {
    const { shelf } = await refused({ info: summary({ tileCount: 5, saveLabel: 'Pictures/Screenshots' }) });
    assert.ok(
      shelf.text().includes(
        'Desktop app? Press Ctrl+V for the full image, or drag the screenshots from ' +
          'Pictures › Screenshots › Spool for AI.',
      ),
    );
  });

  it('desktop app hint for a save in Downloads, and without a place when nothing was saved', async () => {
    const downloads = await refused({ info: summary({ tileCount: 5, saveLabel: 'Downloads/Spool' }) });
    assert.ok(downloads.shelf.text().includes('drag the screenshots from Downloads › Spool › Spool for AI.'));
    const none = await refused({ info: summary({ tileCount: 5, saveLabel: '' }) });
    assert.ok(none.shelf.text().includes('Desktop app? Press Ctrl+V for the full image.'));
    assert.ok(!none.shelf.text().includes('drag'));
  });
});

describe('shelf.js: nothing to insert (H2)', () => {
  it('says how to make a capture, how long it stays, and what a desktop app can do', async () => {
    const t = setup({ info: null, config: { keys: MAC_KEYS } });
    const shelf = await open(t);
    assert.ok(shelf.text().includes('Nothing to insert yet. Press ⌃⇧S to spool a page.'));
    assert.ok(shelf.text().includes('Captures stay ready for 60 minutes.'));
    assert.ok(
      shelf.text().includes(
        'Desktop app? This shortcut works in browser tabs only. Capture a page, then press ⌘V in ' +
          'the app, or drag the screenshots from the Spool for AI folder.',
      ),
    );
  });

  it('the first line stays a paragraph of its own, with the words that the worker also uses', async () => {
    const shelf = await open(setup({ info: null }));
    const paragraphs = findAll(shelf.root, (e) => e.tagName === 'P').map((p) => textOf(p));
    assert.equal(paragraphs[0], 'Nothing to insert yet. Press Alt+Shift+S to spool a page.');
  });

  it('a refusal of the worker stands alone: no "60 minutes" and no desktop hint', async () => {
    const t = setup({
      replies: {
        [MSG.PAGE_SHELF_INFO]: () => ({
          ok: false,
          error: { code: ERR.SESSION_NOT_FOUND, message: 'This capture has expired here. Press Alt+Shift+V again.' },
        }),
      },
    });
    const shelf = await open(t);
    assert.equal(shelf.text().trim(), 'This capture has expired here. Press Alt+Shift+V again.');
  });
});

describe('shelf.js: a capture that is too tall to copy as one image (4.7)', () => {
  it('has no "Copy full image", and says why; the tiles can still be copied', async () => {
    const t = setup({ info: summary({ widthPx: 1500, heightPx: 70_000, tileCount: 30 }) });
    const shelf = await open(t);
    assert.ok(!shelf.hasButton('Copy full image'));
    assert.ok(shelf.text().includes('Too tall to copy as one image. Use the screenshots.'));
    shelf.chips()[0]?.dispatch('click');
    assert.equal(t.clipboard.writes.length, 1, 'a tile is small: it can be copied');
  });

  it('keeps the button for a capture that is under the limit', async () => {
    const shelf = await open(setup({ info: summary({ widthPx: 1500, heightPx: 40_000, tileCount: 20 }) }));
    assert.ok(shelf.hasButton('Copy full image'));
  });

  it('uses the limit of the config, and the built-in one without it', async () => {
    const small = setup({
      info: summary({ widthPx: 1000, heightPx: 1000 }),
      config: { limits: { maxImagesPerMessage: 20, maxClipboardBitmapBytes: 1_000_000 } },
    });
    assert.ok(!(await open(small)).hasButton('Copy full image'), '4 MB over a limit of 1 MB');
    for (const bad of [0, -1, Number.NaN, '9']) {
      const t = setup({
        info: summary({ widthPx: 1500, heightPx: 70_000, tileCount: 30 }),
        config: { limits: { maxImagesPerMessage: 20, maxClipboardBitmapBytes: bad } },
      });
      assert.ok(!(await open(t)).hasButton('Copy full image'), String(bad));
    }
  });
});

describe('shelf.js: keys of the system', () => {
  it('uses the key that the worker wrote for a Mac in the texts of the card', async () => {
    const t = setup({ info: null, config: { keys: MAC_KEYS } });
    const shelf = await open(t);
    assert.ok(shelf.text().includes('⌃⇧S'));
    assert.ok(!shelf.text().includes('Alt+Shift'));
  });
});
