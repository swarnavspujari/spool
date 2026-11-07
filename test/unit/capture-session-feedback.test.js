// @ts-check
/**
 * Tests for the feedback that a capture gives, across the page agent, the toast, the shelf, the
 * shared card kit and the service worker:
 *  - a stray scroll of the user does not make every later step fail;
 *  - the status while Done saves says what happens;
 *  - a new capture closes the toast and the shelf of an earlier capture, also after the
 *    scripts were injected again;
 *  - the toast and the shelf name the real shortcut keys;
 *  - the toolbar button shows a dot while a capture is open;
 *  - the first save with no folder asks "Save to a folder?" a few times.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ERR, MSG, PROTOCOL_VERSION, TARGET } from '../../src/shared/protocol.js';
import { createHandlers } from '../../src/sw/handlers.js';
import {
  CAPTURING_BADGE_COLOR,
  CAPTURING_BADGE_TEXT,
  CAPTURING_TITLE,
  setCapturing,
} from '../../src/sw/capturing.js';
import {
  MAX_SAVE_ASKS,
  SAVE_ASKS_KEY,
  savedToDownloadsByDefault,
  takeFirstSaveQuestion,
  withFirstSaveQuestion,
} from '../../src/sw/first-save.js';
import { DEFAULT_SHORTCUTS, createStarter, readShortcuts } from '../../src/sw/start.js';
import { STEP, agentPage, flush } from '../helpers/agent-page.js';
import { installFakeChrome } from '../helpers/fake-chrome.js';
import { loadClassic } from '../helpers/load-classic.js';
import { FakeElement, findAll, findOne, setupCards, textOf } from '../helpers/fake-card-dom.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const TOKEN = '0c9d6a52-7b1e-4f3a-9a40-2d8e5b7c1f66';
const PNG_BASE64 = 'iVBORw0KGgo=';

// ---------------------------------------------------------------------------------------------
// A stray scroll
// ---------------------------------------------------------------------------------------------

/** The contentY of the frames that were sent, minus the offset of the region in the box (20). */
const positions = (/** @type {ReturnType<typeof agentPage>} */ a) =>
  a.frames().map((/** @type {any} */ meta) => meta.contentY - 20);

describe('the page goes back to the last frame before a step', () => {
  it('a stray scroll down: the next step scrolls back first, then takes the normal step', async () => {
    const a = agentPage();
    await a.begin();
    await a.cmd('down');
    assert.deepEqual(positions(a), [0, STEP]);
    a.scrollLog.length = 0;

    a.page.scrollTop = STEP + 100; // one wheel notch that reached the page
    await a.cmd('down');
    // Back to the place of the last frame, then one step from there.
    assert.deepEqual(a.scrollLog, [STEP, 2 * STEP]);
    assert.deepEqual(positions(a), [0, STEP, 2 * STEP], 'no gap and no jump');
    assert.equal(a.status().level, 'info');
  });

  it('a stray scroll up, and a stray scroll far away, are corrected the same way', async () => {
    const a = agentPage();
    await a.begin();
    await a.cmd('down');
    await a.cmd('down');
    assert.deepEqual(positions(a), [0, STEP, 2 * STEP]);

    a.page.scrollTop = 40;
    await a.cmd('down');
    a.page.scrollTop = 1500;
    await a.cmd('down');
    assert.deepEqual(positions(a), [0, STEP, 2 * STEP, 3 * STEP, 4 * STEP]);
  });

  it('every step after a stray scroll works: the "moved too far" chain does not start', async () => {
    const a = agentPage();
    await a.begin();
    await a.cmd('down');
    a.page.scrollTop = 900;
    for (let i = 0; i < 4; i += 1) await a.cmd('down');
    assert.deepEqual(positions(a), [0, STEP, 2 * STEP, 3 * STEP, 4 * STEP, 5 * STEP]);
  });

  it('works for a step up too', async () => {
    const a = agentPage();
    await a.begin();
    await a.cmd('down');
    await a.cmd('down'); // at 2 * STEP
    a.page.scrollTop = 2 * STEP + 77;
    await a.cmd('up');
    assert.deepEqual(positions(a).slice(-2), [2 * STEP, STEP]);
  });

  it('does not touch the page when it is where the last frame was (no extra scroll)', async () => {
    const a = agentPage();
    await a.begin();
    await a.cmd('down');
    a.scrollLog.length = 0;
    await a.cmd('down');
    assert.deepEqual(a.scrollLog, [2 * STEP], 'only the step itself');
  });

  it('a difference below half a pixel is not a scroll', async () => {
    const a = agentPage();
    await a.begin();
    await a.cmd('down');
    a.scrollLog.length = 0;
    a.page.scrollTop = STEP + 0.4;
    await a.cmd('down');
    assert.equal(a.scrollLog.length, 1);
  });

  it('a frame that failed is taken again at ITS place, also after a stray scroll', async () => {
    const a = agentPage();
    await a.begin();
    await a.cmd('down'); // frames at 0 and STEP
    a.queueFrameReplies({
      ok: false,
      error: { code: ERR.TAB_NOT_VISIBLE, message: 'Go back to this tab to continue.' },
    });
    await a.cmd('down'); // scrolls to 2 * STEP, and the capture fails
    assert.deepEqual(positions(a), [0, STEP, 2 * STEP]);

    a.page.scrollTop = 2 * STEP + 120; // the user scrolls, then comes back
    a.scrollLog.length = 0;
    await a.cmd('down');
    // Back to 2 * STEP, the frame that failed is taken there, and the step goes on from there.
    assert.deepEqual(positions(a).slice(3), [2 * STEP, 3 * STEP]);
    assert.deepEqual(a.scrollLog, [2 * STEP, 3 * STEP]);
  });

  it('Auto starts from the last frame too', async () => {
    const a = agentPage({}, {});
    a.page.max = 3 * STEP;
    await a.begin();
    await a.cmd('down');
    a.page.scrollTop = STEP + 150;
    await a.cmd('auto');
    // Auto goes down to the end: 2 * STEP and 3 * STEP, then the end.
    assert.deepEqual(positions(a).slice(0, 4), [0, STEP, 2 * STEP, 3 * STEP]);
    assert.ok(!a.status().message.includes('moved'));
  });
});

// ---------------------------------------------------------------------------------------------
// What the status says while Done saves
// ---------------------------------------------------------------------------------------------

describe('the status while Done saves', () => {
  it('says "Saving and copying…", and after 2 s that it still works', async () => {
    const a = agentPage({}, { holdFinish: true });
    await a.begin();
    a.done();
    await flush();
    assert.equal(a.status().message, 'Saving and copying…');
    a.clock.now += 1900;
    await a.tick();
    assert.equal(a.status().message, 'Saving and copying…');
    a.clock.now += 200;
    await a.tick();
    assert.equal(a.status().message, 'Still saving. A long capture takes a few seconds.');
    a.releaseFinish();
    await flush();
    await flush();
    assert.equal(a.toasts.length, 1);
  });

  it('says "Saving…" when nothing is copied (copyOnDone is off)', async () => {
    const a = agentPage({ copyOnDone: false }, { holdFinish: true });
    await a.begin();
    a.done();
    await flush();
    assert.equal(a.status().message, 'Saving…');
    a.releaseFinish();
    await flush();
  });

  it('does not say "Opening the result." any more: no result page opens', async () => {
    const a = agentPage({}, { holdFinish: true });
    await a.begin();
    a.done();
    await flush();
    assert.ok(a.statuses.every((s) => s.message !== 'Opening the result.'));
    a.releaseFinish();
    await flush();
  });
});

// ---------------------------------------------------------------------------------------------
// A new capture closes the cards of an earlier capture
// ---------------------------------------------------------------------------------------------

/** A page with the cards loaded. @param {string[]} [files] */
function cardPage(files = ['src/page/ui-kit.js', 'src/page/toast.js', 'src/page/shelf.js']) {
  return setupCards({ files });
}

/** @param {Record<string, unknown>} [more] */
function captureConfig(more = {}) {
  return {
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    mode: 'capture',
    shelfToken: '',
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
    title: 'Page',
    createdAt: Date.now(),
    widthPx: 1500,
    heightPx: 1800,
    tileCount: 1,
    tileTier: 'standard',
    fitsOneImage: true,
    fullBytes: 1000,
    thumbnailPngBase64: PNG_BASE64,
    thumbnailWidthPx: 320,
    thumbnailHeightPx: 480,
    save: { location: 'downloads', label: 'Downloads/Spool', files: 1, needsPermission: false },
    warnings: [],
    ...more,
  };
}

describe('ui.dismissCards closes every card, also one of an earlier injection', () => {
  it('closes a toast that a later injection of the scripts cannot see', () => {
    const t = cardPage();
    t.ns.toast.show({ config: captureConfig(), summary: summary(), copy: 'copied' });
    assert.equal(t.hosts().length, 1);
    assert.equal(t.win.listenerCount('keydown'), 1, 'the toast listens for Esc');

    // The extension injects the scripts again for the next capture: new instances, no state.
    for (const file of ['src/page/ui-kit.js', 'src/page/toast.js', 'src/page/shelf.js']) {
      loadClassic(file, t.context);
    }
    t.ns.toast.dismiss();
    assert.equal(t.hosts().length, 1, 'the new toast module has no state for the old toast');

    t.ns.ui.dismissCards();
    assert.equal(t.hosts().length, 0, 'the host is gone');
    assert.equal(t.win.listenerCount('keydown'), 0, 'and so is its Esc listener');
  });

  it('closes a shelf too, and both at once', () => {
    const t = cardPage();
    t.ns.toast.show({ config: captureConfig(), summary: summary(), copy: 'copied' });
    t.ns.ui.dismissCards();
    t.ns.shelf.start();
    for (const file of ['src/page/ui-kit.js', 'src/page/shelf.js']) loadClassic(file, t.context);
    t.ns.ui.dismissCards();
    assert.equal(t.hosts().length, 0);
    assert.equal(t.win.listenerCount('keydown'), 0);
  });

  it('a card that is closed with the registry does not keep its timers: no late error', () => {
    const t = cardPage();
    t.ns.toast.show({ config: captureConfig(), summary: summary(), copy: 'copied' });
    t.ns.ui.dismissCards();
    t.timers.advance(10_000);
    assert.equal(t.consoleErrors.length, 0);
    assert.equal(t.hosts().length, 0);
  });

  it('a card that closes by itself leaves the registry (nothing piles up)', () => {
    const t = cardPage();
    for (let i = 0; i < 3; i += 1) {
      t.ns.toast.show({ config: captureConfig(), summary: summary(), copy: 'copied' });
      t.timers.advance(10_000); // the countdown ends, and the toast closes
    }
    assert.equal(t.hosts().length, 0);
    assert.equal(t.ns.cardClosers?.size, 0);
  });

  it('does nothing and does not throw when no card is open', () => {
    const t = cardPage();
    t.ns.ui.dismissCards();
    t.ns.ui.dismissCards();
    assert.equal(t.hosts().length, 0);
  });

  it('a new card still replaces the card that is on screen', () => {
    const t = cardPage();
    t.ns.toast.show({ config: captureConfig(), summary: summary(), copy: 'copied' });
    t.ns.toast.show({ config: captureConfig(), summary: summary(), copy: 'copied' });
    assert.equal(t.hosts().length, 1);
    assert.equal(t.win.listenerCount('keydown'), 1);
  });

  it('the agent closes the old cards when a new capture starts (Esc then cancels the capture)', () => {
    const t = cardPage(['src/page/ui-kit.js', 'src/page/toast.js', 'src/page/shelf.js', 'src/page/agent.js']);
    t.ns.toast.show({ config: captureConfig(), summary: summary(), copy: 'copied' });
    assert.equal(t.hosts().length, 1);
    // Another injection (the next capture): new module instances, and then the agent starts.
    for (const file of ['src/page/ui-kit.js', 'src/page/toast.js', 'src/page/shelf.js', 'src/page/agent.js']) {
      loadClassic(file, t.context);
    }
    t.ns.lib = /** @type {any} */ ({
      createStyleJar: () => ({ set() {}, restoreAll() {} }),
      findScrollTarget: () => null,
    });
    t.ns.overlay = /** @type {any} */ ({
      createOverlay: () => ({ beginSelect() {}, destroy() {}, keepOnTop() {}, setStatus() {}, setBusy() {} }),
    });
    t.ns.config = /** @type {any} */ ({
      ...captureConfig(),
      settings: { overlapCss: 80, settleMs: 0, maxHeightCss: 40000, hideOverlays: true },
    });
    t.ns.agent.start();
    assert.equal(t.hosts().length, 0, 'the old toast is gone');
    assert.equal(t.win.listenerCount('keydown'), 0, 'it no longer takes the Esc key');
  });
});

// ---------------------------------------------------------------------------------------------
// The real shortcut keys
// ---------------------------------------------------------------------------------------------

describe('readShortcuts and the config', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  /** @param {unknown} getAll */
  const withCommands = (getAll) => {
    /** @type {any} */ (fake.chrome).commands = { onCommand: fake.chrome.commands.onCommand, getAll };
  };

  it('reads the keys of the two commands as the browser has them', async () => {
    withCommands(async () => [
      { name: 'start-capture', shortcut: 'Ctrl+Shift+Y' },
      { name: 'insert-capture', shortcut: 'Alt+Shift+I' },
      { name: '_execute_action', shortcut: '' },
    ]);
    assert.deepEqual(await readShortcuts(), { start: 'Ctrl+Shift+Y', insert: 'Alt+Shift+I' });
  });

  it('a command with no key gives an empty string (not the default)', async () => {
    withCommands(async () => [
      { name: 'start-capture', shortcut: '' },
      { name: 'insert-capture' },
    ]);
    assert.deepEqual(await readShortcuts(), { start: '', insert: '' });
  });

  it('a command that is not in the list, a failing API and a missing API give the manifest keys', async () => {
    withCommands(async () => []);
    assert.deepEqual(await readShortcuts(), { ...DEFAULT_SHORTCUTS });
    withCommands(async () => {
      throw new Error('no');
    });
    assert.deepEqual(await readShortcuts(), { ...DEFAULT_SHORTCUTS });
    /** @type {any} */ (fake.chrome).commands = {};
    assert.deepEqual(await readShortcuts(), { ...DEFAULT_SHORTCUTS });
    assert.deepEqual({ ...DEFAULT_SHORTCUTS }, { start: 'Alt+Shift+S', insert: 'Alt+Shift+V' });
  });

  it('cuts a very long key text', async () => {
    withCommands(async () => [{ name: 'start-capture', shortcut: 'x'.repeat(200) }]);
    assert.equal((await readShortcuts()).start.length, 40);
  });

  it('the starter puts the keys into the config of a capture and of a shelf', async () => {
    withCommands(async () => [
      { name: 'start-capture', shortcut: 'Ctrl+Shift+Y' },
      { name: 'insert-capture', shortcut: '' },
    ]);
    const starter = createStarter({ schedule: () => 0, cancel: () => {}, registerShelfToken: async () => {} });
    await starter.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
    await starter.startShelf(/** @type {any} */ ({ id: 8, url: 'https://example.com/' }));
    const configs = fake
      .argsOf('scripting.executeScript')
      .map((a) => /** @type {any} */ (a[0]))
      .filter((inj) => inj.args)
      .map((inj) => inj.args[0]);
    assert.equal(configs.length, 2);
    for (const config of configs) {
      assert.deepEqual(config.shortcuts, { start: 'Ctrl+Shift+Y', insert: '' });
    }
  });

  it('a reader that fails does not stop the start: the config gets the manifest keys', async () => {
    const starter = createStarter({
      schedule: () => 0,
      cancel: () => {},
      platform: 'windows',
      readShortcutKeys: async () => {
        throw new Error('no');
      },
    });
    await starter.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
    const config = /** @type {any} */ (fake.argsOf('scripting.executeScript')[0]?.[0]).args[0];
    assert.deepEqual(config.shortcuts, { ...DEFAULT_SHORTCUTS });
  });
});

describe('the toast and the shelf show the real keys', () => {
  /** @param {Record<string, unknown> | undefined} shortcuts @param {number} [tiles] */
  function toastText(shortcuts, tiles = 3) {
    const t = cardPage(['src/page/ui-kit.js', 'src/page/toast.js']);
    t.ns.toast.show({
      config: captureConfig(shortcuts === undefined ? {} : { shortcuts }),
      summary: summary({ tileCount: tiles, fitsOneImage: tiles === 1 }),
      copy: 'copied',
    });
    const root = t.rootOf(/** @type {FakeElement} */ (t.hosts().at(-1)));
    return textOf(findAll(root, (e) => e.className === 'hint')[0]);
  }

  it('the toast hint names the key from the config', () => {
    assert.equal(
      toastText({ start: 'Ctrl+Shift+Y', insert: 'Ctrl+Shift+I' }),
      'Long capture? In your chat tab, press Ctrl+Shift+I to insert all 3 screenshots.',
    );
  });

  it('the toast hint keeps the manifest key when the config has no keys', () => {
    assert.equal(
      toastText(undefined),
      'Long capture? In your chat tab, press Alt+Shift+V to insert all 3 screenshots.',
    );
  });

  it('the toast hint names no key when the command has none', () => {
    const text = toastText({ start: 'Alt+Shift+S', insert: '' });
    assert.ok(!text.includes('Alt+Shift+V'));
    assert.ok(text.includes('Set a shortcut for "Insert last capture"'));
    assert.ok(text.includes('insert all 3 screenshots'));
  });

  /**
   * @param {Record<string, unknown> | undefined} shortcuts
   * @param {(msg: any) => unknown} infoReply
   */
  async function shelfText(shortcuts, infoReply) {
    const t = setupCards({
      files: ['src/page/ui-kit.js', 'src/page/shelf.js'],
      config: {
        protocolVersion: PROTOCOL_VERSION,
        sessionId: SESSION,
        mode: 'shelf',
        shelfToken: TOKEN,
        msg: MSG,
        err: ERR,
        target: TARGET,
        ...(shortcuts === undefined ? {} : { shortcuts }),
      },
      replies: { [MSG.PAGE_SHELF_INFO]: infoReply },
    });
    t.ns.shelf.start();
    await flush();
    await flush();
    return textOf(t.rootOf(/** @type {FakeElement} */ (t.hosts().at(-1))));
  }

  const nothing = () => ({ ok: true, summary: null });
  const refused = (/** @type {string} */ message) => () => ({
    ok: false,
    error: { code: ERR.SESSION_NOT_FOUND, message },
  });

  it('the empty shelf names the key that starts a capture', async () => {
    const text = await shelfText({ start: 'Ctrl+Shift+Y', insert: 'Ctrl+Shift+I' }, nothing);
    assert.ok(text.includes('Nothing to insert yet. Press Ctrl+Shift+Y to spool a page.'), text);
  });

  it('the empty shelf keeps the manifest key without keys in the config', async () => {
    const text = await shelfText(undefined, nothing);
    assert.ok(text.includes('Nothing to insert yet. Press Alt+Shift+S to spool a page.'), text);
  });

  it('the empty shelf names no key when the command has none', async () => {
    const text = await shelfText({ start: '', insert: '' }, nothing);
    assert.ok(text.includes('Nothing to insert yet. Click the Spool button to spool a page.'), text);
    assert.ok(!text.includes('Alt+Shift'));
  });

  it('a refusal of the worker or the offscreen document names the real insert key', async () => {
    const message = 'A newer capture exists. Press Alt+Shift+V again.';
    assert.ok(
      (await shelfText({ start: 'a', insert: 'Ctrl+Shift+I' }, refused(message))).includes(
        'A newer capture exists. Press Ctrl+Shift+I again.',
      ),
    );
    assert.ok(
      (await shelfText({ start: 'a', insert: '' }, refused(message))).includes(
        'A newer capture exists. Run Insert last capture again.',
      ),
    );
    // A message without a key stays as it is.
    assert.ok((await shelfText({ start: 'a', insert: 'b' }, refused('Sender not allowed.'))).includes('Sender not allowed.'));
  });
});

// ---------------------------------------------------------------------------------------------
// The capturing state of the toolbar button
// ---------------------------------------------------------------------------------------------

describe('setCapturing', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it('on: an amber dot badge and a title on the tab', async () => {
    /** @type {any[]} */
    const textColor = [];
    /** @type {any} */ (fake.chrome.action).setBadgeTextColor = async (/** @type {any} */ d) => void textColor.push(d);
    await setCapturing(7, true);
    assert.deepEqual(fake.argsOf('action.setBadgeText'), [[{ tabId: 7, text: CAPTURING_BADGE_TEXT }]]);
    assert.deepEqual(fake.argsOf('action.setBadgeBackgroundColor'), [
      [{ tabId: 7, color: CAPTURING_BADGE_COLOR }],
    ]);
    assert.deepEqual(fake.argsOf('action.setTitle'), [[{ tabId: 7, title: CAPTURING_TITLE }]]);
    assert.equal(textColor.length, 1);
    assert.equal(CAPTURING_BADGE_TEXT, '●');
  });

  it('off: no badge and the title of the manifest', async () => {
    await setCapturing(7, false);
    assert.deepEqual(fake.argsOf('action.setBadgeText'), [[{ tabId: 7, text: '' }]]);
    assert.equal(fake.argsOf('action.setTitle').length, 1);
    assert.notEqual(/** @type {any} */ (fake.argsOf('action.setTitle')[0]?.[0]).title, CAPTURING_TITLE);
  });

  it('never throws: a tab that is gone, a missing API, a bad tab ID', async () => {
    fake.chrome.action.setBadgeText = async () => {
      throw new Error('No tab with id: 7.');
    };
    await setCapturing(7, true);
    await setCapturing(7, false);
    await setCapturing(-1, true);
    await setCapturing(/** @type {any} */ ('7'), true);
    fake.uninstall();
    await setCapturing(7, true);
    fake = installFakeChrome();
  });

  it('a bad tab ID makes no call', async () => {
    await setCapturing(-1, true);
    await setCapturing(1.5, true);
    await setCapturing(/** @type {any} */ (undefined), false);
    assert.deepEqual(fake.calls, []);
  });
});

/**
 * Worker handlers with a fake offscreen document, and spies for the badge and the first-save
 * question.
 * @param {{ summary?: unknown, finishError?: Error }} [options]
 */
function workerPage(options = {}) {
  /** @type {Array<[number, boolean]>} */
  const badge = [];
  /** @type {any[]} */
  const asked = [];
  const offscreen = /** @type {any} */ ({
    offscreenExists: async () => true,
    ensureAndSend: async () => ({}),
    closeIfIdle: async () => false,
    sendToOffscreen: async (/** @type {string} */ type) => {
      if (type === MSG.OFF_FINALIZE) {
        if (options.finishError) throw options.finishError;
        return { summary: options.summary ?? summary() };
      }
      if (type === MSG.OFF_SESSION_DROP) return { remaining: 1 };
      return {};
    },
  });
  const handlers = createHandlers({
    offscreen,
    loadSettings: async () => ({ ...(await import('../../src/shared/settings.js')).DEFAULT_SETTINGS }),
    setCapturing: async (tabId, on) => void badge.push([tabId, on]),
    firstSave: async (s) => {
      asked.push(s);
      return s;
    },
  });
  /** @param {string} type @param {Record<string, unknown>} fields */
  const call = async (type, fields) => {
    const handler = handlers[type];
    assert.ok(handler);
    return handler({ type, ...fields }, /** @type {any} */ ({ tab: { id: 7, windowId: 1 }, frameId: 0 }));
  };
  return { call, badge, asked };
}

describe('the badge follows the session', () => {
  it('turns on when the session opens', async () => {
    const w = workerPage();
    await w.call(MSG.PAGE_SESSION_OPEN, { sessionId: SESSION, title: 'T' });
    await flush();
    assert.deepEqual(w.badge, [[7, true]]);
  });

  it('turns off when Done worked', async () => {
    const w = workerPage();
    await w.call(MSG.PAGE_FINISH, { sessionId: SESSION });
    await flush();
    assert.deepEqual(w.badge, [[7, false]]);
  });

  it('stays on when Done failed (the session is still open)', async () => {
    const w = workerPage({ finishError: new Error('boom') });
    await assert.rejects(w.call(MSG.PAGE_FINISH, { sessionId: SESSION }));
    await flush();
    assert.deepEqual(w.badge, []);
  });

  it('turns off on cancel', async () => {
    const w = workerPage();
    await w.call(MSG.PAGE_CANCEL, { sessionId: SESSION });
    await flush();
    assert.deepEqual(w.badge, [[7, false]]);
  });

  it('a badge that fails does not fail the message', async () => {
    const offscreen = /** @type {any} */ ({
      offscreenExists: async () => true,
      ensureAndSend: async () => ({}),
    });
    const handlers = createHandlers({
      offscreen,
      loadSettings: async () => ({ ...(await import('../../src/shared/settings.js')).DEFAULT_SETTINGS }),
      setCapturing: async () => {
        throw new Error('no badge');
      },
    });
    const open = handlers[MSG.PAGE_SESSION_OPEN];
    assert.ok(open);
    const reply = await open(
      { type: MSG.PAGE_SESSION_OPEN, sessionId: SESSION, title: 'T' },
      /** @type {any} */ ({ tab: { id: 7, windowId: 1 }, frameId: 0 }),
    );
    assert.deepEqual(reply, {});
  });
});

// ---------------------------------------------------------------------------------------------
// The first save with no folder asks once
// ---------------------------------------------------------------------------------------------

/** A storage area for the flag. @returns {any} */
function memoryArea() {
  /** @type {Record<string, unknown>} */
  const data = {};
  return {
    data,
    get: async (/** @type {string | string[]} */ key) =>
      Object.fromEntries(
        (Array.isArray(key) ? key : [key]).filter((k) => Object.hasOwn(data, k)).map((k) => [k, data[k]]),
      ),
    set: async (/** @type {Record<string, unknown>} */ items) => void Object.assign(data, items),
  };
}

describe('savedToDownloadsByDefault', () => {
  /** @param {Record<string, unknown>} [save] @param {string[]} [warnings] */
  const s = (save = {}, warnings = []) =>
    /** @type {any} */ (summary({ save: { location: 'downloads', label: 'Downloads/Spool', files: 4, needsPermission: false, ...save }, warnings }));

  it('is true for files in Downloads with no folder problem', () => {
    assert.equal(savedToDownloadsByDefault(s()), true);
  });

  it('is false when a folder is chosen (it saved there), needs permission, or failed', () => {
    assert.equal(savedToDownloadsByDefault(s({ location: 'folder', label: 'Pics' })), false);
    assert.equal(savedToDownloadsByDefault(s({ needsPermission: true })), false);
    assert.equal(
      savedToDownloadsByDefault(s({}, ['Could not write to the chosen folder. Saved to Downloads instead.'])),
      false,
    );
  });

  it('is false when nothing was saved or the save had an error', () => {
    assert.equal(savedToDownloadsByDefault(s({ location: 'none', files: 0 })), false);
    assert.equal(savedToDownloadsByDefault(s({ files: 0 })), false);
    assert.equal(savedToDownloadsByDefault(s({ error: 'Some files could not be saved.' })), false);
  });
});

describe('the question is taken a few times, then never', () => {
  it('takeFirstSaveQuestion is true for the first three captures and false after', async () => {
    const area = memoryArea();
    for (let n = 1; n <= MAX_SAVE_ASKS; n += 1) {
      assert.equal(await takeFirstSaveQuestion(area), true, `ask ${n}`);
      assert.equal(area.data[SAVE_ASKS_KEY], n);
    }
    assert.equal(await takeFirstSaveQuestion(area), false);
    assert.equal(await takeFirstSaveQuestion(area), false);
    assert.equal(area.data[SAVE_ASKS_KEY], MAX_SAVE_ASKS, 'the count stops');
  });

  it('a storage that fails never asks', async () => {
    const broken = {
      get: async () => {
        throw new Error('no');
      },
      set: async () => {},
    };
    assert.equal(await takeFirstSaveQuestion(broken), false);
    const noSet = { get: async () => ({}), set: async () => { throw new Error('no'); } };
    assert.equal(await takeFirstSaveQuestion(noSet), false);
  });

  it('withFirstSaveQuestion marks the summary of the first three eligible captures only', async () => {
    const area = memoryArea();
    for (let n = 1; n <= MAX_SAVE_ASKS; n += 1) {
      const asked = await withFirstSaveQuestion(/** @type {any} */ (summary()), area);
      assert.equal(asked.save.askFolder, true, `capture ${n}`);
    }
    const fourth = await withFirstSaveQuestion(/** @type {any} */ (summary()), area);
    assert.equal(fourth.save.askFolder, undefined);
  });

  it('an eligible capture that is not eligible does not use up the question', async () => {
    const area = memoryArea();
    const folder = await withFirstSaveQuestion(
      /** @type {any} */ (summary({ save: { location: 'folder', label: 'Pics', files: 1, needsPermission: false } })),
      area,
    );
    assert.equal(folder.save.askFolder, undefined);
    assert.equal(area.data[SAVE_ASKS_KEY], undefined, 'no ask was used');
    const later = await withFirstSaveQuestion(/** @type {any} */ (summary()), area);
    assert.equal(later.save.askFolder, true);
  });

  it('page/finish passes the summary through the question', async () => {
    const w = workerPage();
    const reply = /** @type {any} */ (await w.call(MSG.PAGE_FINISH, { sessionId: SESSION }));
    assert.equal(w.asked.length, 1);
    assert.equal(reply.summary.sessionId, SESSION);
  });
});

describe('the toast asks "Save to Pictures › Screenshots?"', () => {
  /** @param {Record<string, unknown>} save */
  function toastWith(save) {
    const t = cardPage(['src/page/ui-kit.js', 'src/page/toast.js']);
    t.ns.toast.show({
      config: captureConfig(),
      summary: summary({ save: { location: 'downloads', label: 'Downloads/Spool', files: 1, needsPermission: false, ...save } }),
      copy: 'copied',
    });
    const host = /** @type {FakeElement} */ (t.hosts().at(-1));
    const root = t.rootOf(host);
    return {
      t,
      host,
      root,
      button: (/** @type {string} */ label) =>
        findOne(root, (e) => e.tagName === 'BUTTON' && textOf(e).trim() === label, `button "${label}"`),
      has: (/** @type {string} */ label) =>
        findAll(root, (e) => e.tagName === 'BUTTON' && textOf(e).trim() === label).length > 0,
    };
  }

  it('shows the question, "Set up" and "Not now", for the capture that asks', () => {
    const x = toastWith({ askFolder: true });
    const text = textOf(x.root);
    assert.ok(text.includes('Save to Pictures › Screenshots?'));
    assert.ok(text.includes('Saved to Downloads › Spool'), 'the caption says where it went');
    assert.ok(x.has('Set up'));
    assert.ok(x.has('Not now'));
    assert.ok(!x.has('Reconnect'));
    assert.ok(!x.has('Choose folder'));
  });

  it('"Set up" opens the setup page, and closes the toast', async () => {
    const x = toastWith({ askFolder: true });
    x.button('Set up').dispatch('click');
    await flush();
    assert.deepEqual(
      x.t.sent.map((m) => [m.type, m.section]),
      [[MSG.PAGE_OPEN_OPTIONS, 'setup']],
    );
    x.t.timers.advance(300);
    assert.equal(x.host.removed, true);
  });

  it('the link "Change" in the caption opens the setup page, with or without the question', async () => {
    for (const askFolder of [true, false]) {
      const x = toastWith({ askFolder });
      const change = findOne(x.root, (e) => e.className === 'link change', 'Change');
      assert.equal(textOf(change), 'Change');
      change.dispatch('click');
      await flush();
      assert.deepEqual(
        x.t.sent.map((m) => [m.type, m.section]),
        [[MSG.PAGE_OPEN_OPTIONS, 'setup']],
      );
    }
  });

  it('"Not now" closes the toast and sends nothing', async () => {
    const x = toastWith({ askFolder: true });
    x.button('Not now').dispatch('click');
    await flush();
    assert.deepEqual(x.t.sent, []);
    x.t.timers.advance(300);
    assert.equal(x.host.removed, true);
  });

  it('stays 15 s like the other question, not 6 s', () => {
    const x = toastWith({ askFolder: true });
    x.t.timers.advance(14_000);
    assert.equal(x.host.removed, false);
    x.t.timers.advance(1_500);
    assert.equal(x.host.removed, true);
  });

  it('shows no question without the flag, but keeps the link "Change"', () => {
    const x = toastWith({});
    assert.ok(!x.has('Set up'));
    assert.ok(!textOf(x.root).includes('Save to Pictures › Screenshots?'));
    assert.ok(findAll(x.root, (e) => e.className === 'link change').length === 1);
  });

  it('a folder that needs permission keeps its own question, also with the flag', () => {
    const x = toastWith({ askFolder: true, needsPermission: true, folderLabel: 'Pictures/Screenshots' });
    const text = textOf(x.root);
    assert.ok(text.includes('Reconnect Pictures › Screenshots?'));
    assert.ok(x.has('Reconnect'));
    assert.ok(x.has('Not now'));
    assert.ok(!x.has('Set up'));
    assert.equal(findAll(x.root, (e) => e.className === 'link change').length, 0);
  });
});
