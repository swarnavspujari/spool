// @ts-check
/**
 * Tests for what the shelf is allowed to see and do, and for the `copyOnDone` setting:
 *  - a shelf token is bound to the capture that was the last one when it was granted;
 *  - the shelf tab gets only the summary that it shows, and asks for image bytes after a click;
 *  - the shelf does not dispatch a paste when the focus is in a frame;
 *  - the setting `copyOnDone` (the agent skips the clipboard write, the toast says "Saved").
 * Other test files cover the rest of these modules.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOffscreenHandler } from '../../src/offscreen/handlers.js';
import { createLastCapture } from '../../src/offscreen/last-capture.js';
import { createShelfTokens } from '../../src/offscreen/shelf-tokens.js';
import { SHELF_TOKEN_TTL_MS } from '../../src/shared/constants.js';
import { ERR, MSG, PROTOCOL_VERSION, SpoolError, TARGET } from '../../src/shared/protocol.js';
import { DEFAULT_SETTINGS, normalizeSettings, saveSettings } from '../../src/shared/settings.js';
import { createHandlers } from '../../src/sw/handlers.js';
import { toShelfSummary } from '../../src/sw/summary.js';
import { FIELDS, GROUPS, formToSettings, settingsToForm } from '../../src/options/form-model.js';
import { agentPage } from '../helpers/agent-page.js';
import {
  FakeElement,
  findAll,
  findOne,
  flush,
  setupCards,
  textOf,
} from '../helpers/fake-card-dom.js';

const SESSION_A = '11111111-1111-4111-8111-111111111111';
const SESSION_B = '22222222-2222-4222-8222-222222222222';
const TOKEN = '0c9d6a52-7b1e-4f3a-9a40-2d8e5b7c1f66';
const TOKEN_2 = '9a7e1d34-2c58-4e0b-8f63-1b4d7a9c2e05';
const PNG_BASE64 = 'iVBORw0KGgo=';

const NEWER = 'A newer capture exists. Press Alt+Shift+V again.';
const ENDED = 'This capture has ended. Press Alt+Shift+V again.';
const NOTHING = 'Nothing to insert yet. Press Alt+Shift+S to spool a page.';
const FRAME = 'Spool cannot insert into an embedded frame. Click a number to copy one instead.';
const FRAME_ONE = 'Spool cannot insert into an embedded frame. Click Copy full image.';

/** @param {unknown} e @param {string} code @param {string} [message] */
function isSpoolError(e, code, message) {
  assert.ok(e instanceof SpoolError, `expected SpoolError, got ${String(e)}`);
  assert.equal(e.code, code);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
}

// ---------------------------------------------------------------------------------------------
// A shelf token is bound to a capture
// ---------------------------------------------------------------------------------------------

/**
 * The offscreen handler with the real last capture and the real tokens. The capture timer is
 * manual: `expire()` runs it, like the 60 minutes that pass.
 */
function offscreenSetup() {
  /** @type {(() => void) | null} */
  let fire = null;
  const last = createLastCapture({
    setTimer: (fn) => {
      fire = fn;
      return 1;
    },
    clearTimer: () => {
      fire = null;
    },
  });
  /** @type {{ now: number }} */
  const clock = { now: 1_000 };
  const tokens = createShelfTokens({ now: () => clock.now });
  const store = /** @type {any} */ ({ ping: () => ({ sessions: 0 }), dropTab: () => ({ remaining: 0 }) });
  const finalizer = /** @type {any} */ ({ finalize: async () => ({}) });
  /** The bytes are `b64:<size>`, so a test sees which capture a tile came from. */
  const handle = createOffscreenHandler({
    store,
    last,
    tokens,
    finalizer,
    blobToBase64: async (blob) => `b64:${blob.size}`,
  });
  return {
    handle,
    last,
    tokens,
    clock,
    expire() {
      assert.ok(fire, 'a timer is set');
      fire();
    },
  };
}

/**
 * Keeps a capture. The tiles of a capture have the sizes `base`, `base + 1`, `base + 2`.
 * @param {ReturnType<typeof offscreenSetup>} s
 * @param {string} sessionId
 * @param {number} base
 * @param {number} [tabId]
 */
function keep(s, sessionId, base, tabId = 7) {
  s.last.set({
    sessionId,
    tabId,
    summary: /** @type {any} */ ({ sessionId, marker: `summary of ${sessionId}` }),
    tiles: [0, 1, 2].map((i) => new Blob([new Uint8Array(base + i)])),
    full: new Blob([new Uint8Array(base * 10)]),
  });
}

describe('shelf tokens are bound to a capture', () => {
  it('serves the capture that was the last one when the token was granted', async () => {
    const s = offscreenSetup();
    keep(s, SESSION_A, 10);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 3 }), {
      summary: { sessionId: SESSION_A, marker: `summary of ${SESSION_A}` },
    });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 2 }), {
      pngBase64: 'b64:12',
    });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 'full' }), {
      pngBase64: 'b64:100',
    });
  });

  it('refuses every read once a newer capture exists', async () => {
    const s = offscreenSetup();
    keep(s, SESSION_A, 10, 7);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    // The shelf of tab 3 shows capture A. In tab 8 the user captures a confidential page B.
    keep(s, SESSION_B, 50, 8);
    const tab = { token: TOKEN, tabId: 3 };
    await assert.rejects(s.handle(MSG.OFF_SHELF_INFO, tab), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, NEWER),
    );
    // Insert reads all tiles, a chip reads one, and Copy full image reads the full image.
    for (const item of /** @type {const} */ ([0, 1, 2, 3, 'full'])) {
      await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { ...tab, item }), (e) =>
        isSpoolError(e, ERR.SESSION_NOT_FOUND, NEWER),
      );
    }
  });

  it('a newer capture with fewer or more tiles gives the same refusal', async () => {
    const s = offscreenSetup();
    keep(s, SESSION_A, 10);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    s.last.set({
      sessionId: SESSION_B,
      tabId: 8,
      summary: /** @type {any} */ ({ sessionId: SESSION_B }),
      tiles: [new Blob([new Uint8Array(5)])],
      full: null,
    });
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, NEWER),
    );
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 2 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, NEWER),
    );
  });

  it('Alt+Shift+V again (a new token) serves the newer capture, and the old token stays refused', async () => {
    const s = offscreenSetup();
    keep(s, SESSION_A, 10);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    keep(s, SESSION_B, 50);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN_2, tabId: 3 });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_GET, { token: TOKEN_2, tabId: 3, item: 0 }), {
      pngBase64: 'b64:50',
    });
    // A new token for the same tab ends the old one (the old shelf closes itself).
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
  });

  it('a token for another tab is bound to its own grant', async () => {
    const s = offscreenSetup();
    keep(s, SESSION_A, 10);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    keep(s, SESSION_B, 50);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN_2, tabId: 4 });
    // Tab 3 still shows A and is refused. Tab 4 shows B and is served.
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, NEWER),
    );
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_GET, { token: TOKEN_2, tabId: 4, item: 0 }), {
      pngBase64: 'b64:50',
    });
  });

  it('refuses when the capture ended with no newer one (clear and the 60 minute limit)', async () => {
    const cleared = offscreenSetup();
    keep(cleared, SESSION_A, 10);
    await cleared.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    cleared.last.clear();
    await assert.rejects(cleared.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 3 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, ENDED),
    );
    await assert.rejects(
      cleared.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }),
      (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND, ENDED),
    );

    const expired = offscreenSetup();
    keep(expired, SESSION_A, 10);
    await expired.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    expired.expire();
    assert.equal(expired.last.has(), false);
    await assert.rejects(expired.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 'full' }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, ENDED),
    );
  });

  it('a token that was granted with no capture serves nothing, also after a capture appears', async () => {
    const s = offscreenSetup();
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 3 }), { summary: null });
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, NOTHING),
    );
    keep(s, SESSION_A, 10);
    await assert.rejects(s.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 3 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, NEWER),
    );
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, NEWER),
    );
  });

  it('keeps the other rules: another tab, an unknown token and the token time', async () => {
    const s = offscreenSetup();
    keep(s, SESSION_A, 10);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 4, item: 0 }), (e) =>
      isSpoolError(e, ERR.FORBIDDEN_SENDER),
    );
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN_2, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, 'This capture has expired here. Press Alt+Shift+V again.'),
    );
    s.clock.now += SHELF_TOKEN_TTL_MS;
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, 'This capture has expired here. Press Alt+Shift+V again.'),
    );
  });

  it('the shelf does not read the capture of the page agent or the result page by session', async () => {
    // The session API (get-output) is separate and asks for the session ID and the tab. A token is
    // not a session ID.
    const s = offscreenSetup();
    keep(s, SESSION_A, 10, 3);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    assert.deepEqual(
      await s.handle(MSG.OFF_GET_OUTPUT, { sessionId: SESSION_A, tabId: 3, item: 0 }),
      { pngBase64: 'b64:10' },
    );
    keep(s, SESSION_B, 50, 3);
    await assert.rejects(
      s.handle(MSG.OFF_GET_OUTPUT, { sessionId: SESSION_A, tabId: 3, item: 0 }),
      (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
  });
});

describe('createShelfTokens keeps the session of a grant', () => {
  it('check returns the bound session, or null when the grant had none', () => {
    const tokens = createShelfTokens({ now: () => 1 });
    tokens.grant(TOKEN, 3, SESSION_A);
    tokens.grant(TOKEN_2, 4);
    assert.equal(tokens.check(TOKEN, 3), SESSION_A);
    assert.equal(tokens.check(TOKEN_2, 4), null);
    tokens.grant(TOKEN_2, 4, null);
    assert.equal(tokens.check(TOKEN_2, 4), null);
  });

  it('a token that is granted again takes the new session', () => {
    const tokens = createShelfTokens({ now: () => 1 });
    tokens.grant(TOKEN, 3, SESSION_A);
    tokens.grant(TOKEN, 3, SESSION_B);
    assert.equal(tokens.check(TOKEN, 3), SESSION_B);
    assert.equal(tokens.size, 1);
  });

  it('still refuses another tab before it says anything about the session', () => {
    const tokens = createShelfTokens({ now: () => 1 });
    tokens.grant(TOKEN, 3, SESSION_A);
    assert.throws(() => tokens.check(TOKEN, 4), (e) => isSpoolError(e, ERR.FORBIDDEN_SENDER));
  });
});

// ---------------------------------------------------------------------------------------------
// The shelf tab gets only what the shelf shows
// ---------------------------------------------------------------------------------------------

const FULL_SUMMARY = Object.freeze({
  sessionId: SESSION_A,
  title: 'Q3 pipeline: Acme CRM record',
  sourceHost: 'crm.acme.example',
  createdAt: 1_760_000_000_000,
  widthPx: 1500,
  heightPx: 6240,
  tileCount: 3,
  tileTier: 'standard',
  fitsOneImage: false,
  fullBytes: 999_999,
  thumbnailPngBase64: PNG_BASE64,
  thumbnailWidthPx: 320,
  thumbnailHeightPx: 480,
  save: { location: 'folder', label: 'Confidential', files: 4, needsPermission: false },
  warnings: ['one'],
});

describe('toShelfSummary and page/shelf-info', () => {
  const SHOWN = [
    'createdAt',
    'heightPx',
    'saveLabel',
    'sourceHost',
    'thumbnailHeightPx',
    'thumbnailPngBase64',
    'thumbnailWidthPx',
    'tileCount',
    'widthPx',
  ];

  it('keeps the size, the age, the host, the place and the thumbnail, and nothing else', () => {
    const shelf = toShelfSummary(/** @type {any} */ (FULL_SUMMARY));
    assert.deepEqual(Object.keys(shelf).sort(), SHOWN);
    assert.deepEqual(shelf, {
      tileCount: 3,
      widthPx: 1500,
      heightPx: 6240,
      createdAt: 1_760_000_000_000,
      sourceHost: 'crm.acme.example',
      saveLabel: 'Confidential',
      thumbnailPngBase64: PNG_BASE64,
      thumbnailWidthPx: 320,
      thumbnailHeightPx: 480,
    });
  });

  it('leaves out the title, the session ID, the save details and the warnings', () => {
    const text = JSON.stringify(toShelfSummary(/** @type {any} */ (FULL_SUMMARY)));
    for (const secret of [
      'Q3 pipeline',
      'Record',
      SESSION_A,
      'warnings',
      'title',
      'needsPermission',
      'folderLabel',
      'files',
      'one',
    ]) {
      assert.ok(!text.includes(secret), secret);
    }
  });

  it('gives no place for a capture that was not saved, and no host that the worker did not check', () => {
    const none = toShelfSummary(
      /** @type {any} */ ({
        ...FULL_SUMMARY,
        save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false },
      }),
    );
    assert.equal(none.saveLabel, '');
  });

  /** A worker handler with a fake offscreen document that replies with `summary`. */
  function shelfInfoHandler(/** @type {unknown} */ summary) {
    const offscreen = /** @type {any} */ ({
      offscreenExists: async () => true,
      sendToOffscreen: async () => ({ ok: true, summary }),
    });
    const handlers = createHandlers({ offscreen });
    const handler = handlers[MSG.PAGE_SHELF_INFO];
    assert.ok(handler);
    return async () =>
      handler({ type: MSG.PAGE_SHELF_INFO, token: TOKEN }, /** @type {any} */ ({
        tab: { id: 3, windowId: 1 },
        frameId: 0,
      }));
  }

  it('the worker answers the shelf with the trimmed summary', async () => {
    const reply = /** @type {any} */ (await shelfInfoHandler(FULL_SUMMARY)());
    assert.deepEqual(Object.keys(reply.summary).sort(), SHOWN);
    assert.equal(reply.summary.title, undefined);
    assert.equal(reply.summary.sessionId, undefined);
  });

  it('the worker still checks the whole summary before it cuts it down', async () => {
    await assert.rejects(shelfInfoHandler({ ...FULL_SUMMARY, title: 5 })(), (e) =>
      isSpoolError(e, ERR.INTERNAL),
    );
    await assert.rejects(shelfInfoHandler({ ...FULL_SUMMARY, tileCount: 0 })(), (e) =>
      isSpoolError(e, ERR.INTERNAL),
    );
    assert.deepEqual(await shelfInfoHandler(null)(), { summary: null });
  });
});

// ---------------------------------------------------------------------------------------------
// The shelf page script
// ---------------------------------------------------------------------------------------------

/** @param {Record<string, unknown>} [more] */
function shelfConfig(more = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION_A,
    mode: 'shelf',
    shelfToken: TOKEN,
    msg: MSG,
    err: ERR,
    target: TARGET,
    ...more,
  };
}

/** What the worker sends to the shelf: the trimmed summary. @param {Record<string, unknown>} [more] */
function shelfSummary(more = {}) {
  return { ...toShelfSummary(/** @type {any} */ (FULL_SUMMARY)), createdAt: Date.now(), ...more };
}

/** @param {{ info?: unknown, replies?: Record<string, (msg: any) => unknown> }} [options] */
function shelfPage({ info = shelfSummary(), replies = {} } = {}) {
  const t = setupCards({
    files: ['src/page/ui-kit.js', 'src/page/shelf.js'],
    config: shelfConfig(),
    replies: {
      [MSG.PAGE_SHELF_INFO]: () => ({ ok: true, summary: info }),
      [MSG.PAGE_SHELF_GET]: () => ({ ok: true, pngBase64: PNG_BASE64 }),
      ...replies,
    },
  });
  assert.ok(t.ns.shelf);
  return t;
}

/** @param {ReturnType<typeof shelfPage>} t */
async function openShelf(t) {
  t.ns.shelf.start();
  await flush();
  await flush();
  t.timers.advance(450); // Insert stays off for 400 ms after the card appears
  const host = /** @type {FakeElement} */ (t.hosts().at(-1));
  assert.ok(host, 'a shelf is on screen');
  const root = t.rootOf(host);
  return {
    root,
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

/** @param {ReturnType<typeof shelfPage>} t @returns {unknown[]} The items asked for with page/shelf-get. */
function itemsAsked(t) {
  return t.sent.filter((m) => m.type === MSG.PAGE_SHELF_GET).map((m) => m.item);
}

/** An editor that records the paste events that reach it. @param {boolean} accepts */
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

describe('the shelf asks for image bytes only after a click', () => {
  it('opens with one message (the summary) and asks for no tile and no full image', async () => {
    const t = shelfPage();
    const shelf = await openShelf(t);
    assert.deepEqual(
      t.sent.map((m) => m.type),
      [MSG.PAGE_SHELF_INFO],
    );
    // Time passes (hover, the watchdog): still nothing more.
    t.timers.advance(5000);
    await flush();
    assert.deepEqual(itemsAsked(t), []);
    assert.equal(shelf.chips().length, 3);
    assert.equal(t.clipboard.writes.length, 0, 'nothing was written to the clipboard');
  });

  it('Insert reads every tile after the click, and only the tiles', async () => {
    const t = shelfPage();
    t.page.activeElement = editor(true).el;
    const shelf = await openShelf(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.deepEqual(itemsAsked(t), [0, 1, 2]);
  });

  it('a chip reads one tile after the click, in the click, and no other', async () => {
    const t = shelfPage();
    const shelf = await openShelf(t);
    shelf.chips()[1]?.dispatch('click');
    assert.equal(t.clipboard.writes.length, 1, 'clipboard.write starts in the click');
    await flush();
    await flush();
    assert.deepEqual(itemsAsked(t), [1]);
  });

  it('Copy full image reads the full image after the click', async () => {
    const t = shelfPage();
    const shelf = await openShelf(t);
    shelf.button('Copy full image').dispatch('click');
    assert.equal(t.clipboard.writes.length, 1);
    await flush();
    await flush();
    assert.deepEqual(itemsAsked(t), ['full']);
  });

  it('does not show a title, even when a reply has one', async () => {
    const t = shelfPage({ info: { ...shelfSummary(), title: 'Q3 pipeline: Acme', save: { label: 'Confidential' } } });
    const shelf = await openShelf(t);
    const text = textOf(shelf.root);
    assert.ok(text.includes('3 AI screenshots from crm.acme.example'));
    assert.ok(!text.includes('Q3 pipeline'));
    assert.ok(!text.includes('Confidential'));
  });
});

describe('the shelf shows why a read was refused', () => {
  const refuse = () => ({ ok: false, error: { code: ERR.SESSION_NOT_FOUND, message: NEWER } });

  it('shows the message when the summary is refused', async () => {
    const t = shelfPage({ replies: { [MSG.PAGE_SHELF_INFO]: refuse } });
    const shelf = await openShelf(t);
    assert.equal(textOf(shelf.root).trim(), NEWER, 'the message alone: no hint about 60 minutes');
    assert.deepEqual(itemsAsked(t), []);
  });

  it('Insert: no paste, and the status is the message (not "did not accept")', async () => {
    const t = shelfPage({ replies: { [MSG.PAGE_SHELF_GET]: refuse } });
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await openShelf(t);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 0);
    assert.equal(shelf.status(), NEWER);
    // The button works again: a second click asks again.
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), NEWER);
  });

  it('a chip and Copy full image show the message too', async () => {
    const t = shelfPage({ replies: { [MSG.PAGE_SHELF_GET]: refuse } });
    const shelf = await openShelf(t);
    shelf.chips()[0]?.dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), NEWER);

    const t2 = shelfPage({ replies: { [MSG.PAGE_SHELF_GET]: refuse } });
    const shelf2 = await openShelf(t2);
    shelf2.button('Copy full image').dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf2.status(), NEWER);
  });

  it('a refusal does not stay: a copy that the browser refuses says so in the usual words', async () => {
    const t = shelfPage();
    t.clipboard.reject = true;
    const shelf = await openShelf(t);
    shelf.chips()[0]?.dispatch('click');
    await flush();
    await flush();
    assert.equal(shelf.status(), 'Could not copy on this page.');
  });
});

describe('no paste into a frame', () => {
  /** @param {string} tag */
  function frameLike(tag) {
    const el = new FakeElement(tag);
    /** @type {any[]} */
    const pastes = [];
    el.addEventListener('paste', (/** @type {any} */ e) => pastes.push(e));
    return { el, pastes };
  }

  for (const tag of ['iframe', 'frame', 'object', 'embed']) {
    it(`when the focus is in <${tag}>: says so, does not paste, reads no tile`, async () => {
      const t = shelfPage();
      const frame = frameLike(tag);
      /** @type {any[]} */
      const onBody = [];
      t.body.addEventListener('paste', (/** @type {any} */ e) => onBody.push(e));
      t.page.activeElement = frame.el;
      const shelf = await openShelf(t);
      assert.equal(shelf.status(), FRAME);
      const insert = shelf.button('Insert 3 screenshots');
      assert.equal(insert.disabled, true);
      insert.dispatch('click'); // A click on a disabled button does not arrive in a browser. Be safe.
      await flush();
      await flush();
      assert.equal(shelf.status(), FRAME);
      assert.equal(frame.pastes.length, 0, 'not to the frame element');
      assert.equal(onBody.length, 0, 'and not to the top page');
      assert.deepEqual(itemsAsked(t), []);
    });
  }

  it('finds a frame inside an open shadow root', async () => {
    const t = shelfPage();
    const inner = frameLike('iframe');
    const host = new FakeElement('chat-widget');
    host.shadowRoot = /** @type {any} */ ({ activeElement: inner.el });
    t.page.activeElement = host;
    const shelf = await openShelf(t);
    assert.equal(shelf.status(), FRAME);
  });

  it('one image: the words point to Copy full image', async () => {
    const t = shelfPage({ info: shelfSummary({ tileCount: 1 }) });
    t.page.activeElement = frameLike('iframe').el;
    const shelf = await openShelf(t);
    assert.equal(shelf.status(), FRAME_ONE);
    assert.equal(shelf.button('Insert 1 screenshot').disabled, true);
  });

  it('the tiles can still be copied: a chip and Copy full image work', async () => {
    const t = shelfPage();
    t.page.activeElement = frameLike('iframe').el;
    const shelf = await openShelf(t);
    shelf.chips()[2]?.dispatch('click');
    shelf.button('Copy full image').dispatch('click');
    assert.equal(t.clipboard.writes.length, 2);
    await flush();
    await flush();
    assert.deepEqual(itemsAsked(t), [2, 'full']);
  });

  it('an editor, a body, and an element that is no frame still get the paste', async () => {
    const t = shelfPage();
    const target = editor(true);
    t.page.activeElement = target.el;
    const shelf = await openShelf(t);
    assert.equal(shelf.button('Insert 3 screenshots').disabled, false);
    shelf.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(target.pastes.length, 1);
    assert.equal(shelf.status(), 'Inserted 3 screenshots.');

    const t2 = shelfPage();
    /** @type {any[]} */
    const onBody = [];
    t2.body.addEventListener('paste', (/** @type {any} */ e) => onBody.push(e));
    const shelf2 = await openShelf(t2);
    shelf2.button('Insert 3 screenshots').dispatch('click');
    await flush();
    await flush();
    assert.equal(onBody.length, 1);
  });

  it('a shelf that opens on the focus of an earlier shelf for a frame keeps the frame rule', async () => {
    const t = shelfPage();
    const frame = frameLike('iframe');
    t.page.activeElement = frame.el;
    const first = await openShelf(t);
    assert.equal(first.status(), FRAME);
    // The user tabs into the shelf and presses Alt+Shift+V again: the target is still the frame.
    const firstHost = /** @type {FakeElement} */ (t.hosts().at(-1));
    t.page.activeElement = firstHost;
    const second = await openShelf(t);
    assert.equal(second.status(), FRAME);
  });

  describe('ui.isFrameOwner', () => {
    const t = shelfPage();
    const isFrameOwner = /** @type {(e: unknown) => boolean} */ (t.ns.ui.isFrameOwner);

    it('is true for iframe, frame, object and embed, in any case', () => {
      for (const tag of ['iframe', 'frame', 'object', 'embed', 'IFRAME', 'Embed']) {
        const el = new FakeElement('div');
        el.tagName = tag;
        assert.equal(isFrameOwner(el), true, tag);
      }
    });

    it('is false for other elements, null and a value that cannot be read', () => {
      for (const tag of ['div', 'textarea', 'input', 'body', 'html', 'video', 'canvas']) {
        assert.equal(isFrameOwner(new FakeElement(tag)), false, tag);
      }
      assert.equal(isFrameOwner(null), false);
      const broken = {
        get tagName() {
          throw new Error('blocked');
        },
      };
      assert.equal(isFrameOwner(broken), false);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// The setting copyOnDone
// ---------------------------------------------------------------------------------------------

describe('the setting copyOnDone', () => {
  it('is on by default', () => {
    assert.equal(DEFAULT_SETTINGS.copyOnDone, true);
    assert.equal(normalizeSettings(undefined).copyOnDone, true);
    assert.equal(normalizeSettings({}).copyOnDone, true);
  });

  it('keeps false and true, and falls back to on for any other value', () => {
    assert.equal(normalizeSettings({ copyOnDone: false }).copyOnDone, false);
    assert.equal(normalizeSettings({ copyOnDone: true }).copyOnDone, true);
    for (const bad of ['false', 0, null, 'no', [], {}, 1]) {
      assert.equal(normalizeSettings({ copyOnDone: bad }).copyOnDone, true, JSON.stringify(bad));
    }
  });

  it('is stored with the other settings', async () => {
    /** @type {Record<string, unknown>} */
    const data = {};
    const area = /** @type {any} */ ({
      get: async (/** @type {string} */ key) => (key in data ? { [key]: data[key] } : {}),
      set: async (/** @type {Record<string, unknown>} */ items) => void Object.assign(data, items),
    });
    const saved = await saveSettings({ copyOnDone: false }, area);
    assert.equal(saved.copyOnDone, false);
    assert.equal(/** @type {any} */ (data['settings']).copyOnDone, false);
  });

  it('has a field in the Output group of the options page, with the words of the setting', () => {
    const field = FIELDS.find((f) => f.key === 'copyOnDone');
    assert.ok(field);
    assert.equal(field.type, 'boolean');
    assert.equal(field.group, 'output');
    assert.equal(field.label, 'Copy the full image when you finish');
    assert.equal(field.defaultValue, true);
    assert.ok(GROUPS.some((g) => g.id === field.group));
    assert.ok(field.help.length > 0);
  });

  it('goes through the form: settings to form values and back', () => {
    assert.equal(settingsToForm({ copyOnDone: false }).copyOnDone, false);
    assert.equal(settingsToForm({}).copyOnDone, true);
    assert.equal(formToSettings({ copyOnDone: false }).copyOnDone, false);
    assert.equal(formToSettings({ copyOnDone: 'off' }).copyOnDone, false);
    assert.equal(formToSettings({}).copyOnDone, true);
  });
});

describe('the toast says "Saved" when nothing was copied', () => {
  /** @param {Record<string, unknown>} [summary] @param {'pending' | 'copied' | 'failed' | 'skipped'} [copy] */
  function toastPage(summary = {}, copy = 'skipped') {
    const t = setupCards({ files: ['src/page/ui-kit.js', 'src/page/toast.js'] });
    const full = {
      ...FULL_SUMMARY,
      tileCount: 1,
      fitsOneImage: true,
      save: { location: 'downloads', label: 'Downloads/Spool', files: 1, needsPermission: false },
      ...summary,
    };
    const handle = t.ns.toast.show({ config: shelfConfig({ mode: 'capture', shelfToken: '' }), summary: full, copy });
    assert.ok(handle);
    const host = /** @type {FakeElement} */ (t.hosts().at(-1));
    return { t, handle, root: t.rootOf(host), host };
  }

  /** @param {FakeElement} root */
  const title = (root) => textOf(findAll(root, (e) => e.className === 'title')[0]).trim();

  it('a short capture: "Saved", the caption, and no paste hint', () => {
    const { root } = toastPage();
    assert.equal(title(root), 'Saved');
    assert.ok(textOf(root).includes('1,500 × 6,240 px · Saved to Downloads › Spool'));
    const hint = findAll(root, (e) => e.className === 'paste small')[0];
    assert.equal(hint?.style.display, 'none');
    assert.ok(!textOf(root).includes('Copied'));
    assert.ok(!textOf(root).includes('Copying'));
  });

  it('a long capture: "Saved" in place of "Full image copied", and the tiles stay', () => {
    const { root } = toastPage({ tileCount: 3, fitsOneImage: false });
    assert.equal(title(root), 'Saved');
    assert.ok(textOf(root).includes('3 AI screenshots ready · Saved to Downloads › Spool'));
    assert.ok(textOf(root).includes('press Alt+Shift+V to insert all 3 screenshots'));
    assert.equal(findAll(root, (e) => e.className === 'chip').length, 3);
    assert.ok(!textOf(root).includes('Full image copied'));
  });

  it('nothing saved and nothing copied: "Not saved"', () => {
    const { root } = toastPage({ save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false } });
    assert.equal(title(root), 'Not saved');
  });

  it('is final at once: the countdown runs, and the toast closes after 6 s', () => {
    const { t, host } = toastPage();
    t.timers.advance(5900);
    assert.equal(host.removed, false);
    t.timers.advance(100);
    t.timers.advance(200); // the closing animation
    assert.equal(host.removed, true);
  });

  it('the other states keep their words', () => {
    assert.equal(title(toastPage({}, 'copied').root), 'Copied and saved');
    assert.equal(title(toastPage({}, 'pending').root), 'Copying…');
    assert.equal(title(toastPage({}, 'failed').root), 'Saved, not copied');
  });
});

// ---------------------------------------------------------------------------------------------
// The agent skips the clipboard
// ---------------------------------------------------------------------------------------------

describe('the agent and copyOnDone', () => {
  it('on (the default): Done writes the clipboard in the gesture, and the toast starts as "pending"', async () => {
    const a = agentPage({});
    await a.begin();
    a.done();
    assert.equal(a.writes.length, 1, 'clipboard.write ran in the task of Done');
    await flush();
    await flush();
    assert.ok(a.types().includes(MSG.PAGE_GET_CLIPBOARD));
    assert.equal(a.toasts.length, 1);
    assert.equal(a.toasts[0].copy, 'pending');
    assert.deepEqual(a.copies, ['copied']);
  });

  it('an older config with no copyOnDone key counts as on', async () => {
    const b = agentPage({ copyOnDone: /** @type {any} */ (undefined) });
    await b.begin();
    b.done();
    assert.equal(b.writes.length, 1);
  });

  it('off: Done writes nothing, asks for no image, and the toast is "skipped"', async () => {
    const a = agentPage({ copyOnDone: false });
    await a.begin();
    a.done();
    assert.equal(a.writes.length, 0, 'no clipboard.write');
    await flush();
    await flush();
    await flush();
    // The capture still finishes (the files are saved by the worker).
    assert.equal(a.types().filter((t) => t === MSG.PAGE_FINISH).length, 1);
    // The full image never leaves the offscreen document: no get-clipboard, no fallback.
    assert.ok(!a.types().includes(MSG.PAGE_GET_CLIPBOARD));
    assert.ok(!a.types().includes(MSG.PAGE_CLIPBOARD_FALLBACK));
    assert.equal(a.toasts.length, 1);
    assert.equal(a.toasts[0].copy, 'skipped');
    assert.deepEqual(a.copies, [], 'the toast is not told about a copy');
    assert.equal(a.toasts[0].summary.sessionId, SESSION_A);
  });

  it('off: the toast gets the config and the summary like before', async () => {
    const a = agentPage({ copyOnDone: false });
    await a.begin();
    a.done();
    await flush();
    await flush();
    assert.equal(a.toasts[0].config.sessionId, SESSION_A);
    assert.equal(a.toasts[0].summary.tileCount, 3);
  });
});
