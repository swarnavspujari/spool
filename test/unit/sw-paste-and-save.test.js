// @ts-check
/**
 * Tests for the service worker side of the paste work:
 *  - `page/show-in-folder` ("Show in folder" of the toast, for a save in Downloads only);
 *  - `page/finish` marks one of the first long captures with `teach`;
 *  - the config that the starter injects has `keys` (written for the system) and `limits`;
 *  - the keys of the manifest are the fallback when the browser says nothing, for each system.
 */
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { MAX_CLIPBOARD_BITMAP_BYTES, MAX_IMAGES_PER_MESSAGE } from '../../src/shared/constants.js';
import { ERR, MSG, SpoolError, makeMessage } from '../../src/shared/protocol.js';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';
import { createHandlers } from '../../src/sw/handlers.js';
import { createStarter, readShortcuts, systemPlatform } from '../../src/sw/start.js';
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  contentSender,
  installFakeChrome,
} from '../helpers/fake-chrome.js';

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';

/** @param {string} path */
function extensionPageSender(path) {
  return /** @type {chrome.runtime.MessageSender} */ (
    /** @type {any} */ ({ id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}${path}` })
  );
}

/** @param {Record<string, unknown>} [save] */
function summary(save = {}) {
  return {
    sessionId: SESSION_ID,
    title: 'My page',
    sourceHost: 'example.com',
    createdAt: 1_760_000_000_000,
    widthPx: 1000,
    heightPx: 5000,
    tileCount: 2,
    tileTier: 'high',
    fitsOneImage: false,
    fullBytes: 123_456,
    thumbnailPngBase64: 'iVBORw0KGgo=',
    thumbnailWidthPx: 320,
    thumbnailHeightPx: 480,
    save: { location: 'downloads', label: 'Downloads/Spool', files: 3, needsPermission: false, ...save },
    warnings: [],
  };
}

function makeOffscreen() {
  /** @type {{ type: string, fields: Record<string, unknown> }[]} */
  const sent = [];
  /** @type {Record<string, Record<string, unknown>>} */
  const replies = {};
  /** @type {Record<string, unknown>} */
  const errors = {};
  const api = {
    exists: true,
    sent,
    replies,
    errors,
    async offscreenExists() {
      return api.exists;
    },
    /** @param {string} type @param {Record<string, unknown>} [fields] */
    async ensureAndSend(type, fields = {}) {
      sent.push({ type, fields });
      return { ok: true };
    },
    /** @param {string} type @param {Record<string, unknown>} [fields] */
    async sendToOffscreen(type, fields = {}) {
      sent.push({ type, fields });
      if (Object.hasOwn(errors, type)) throw errors[type];
      return replies[type] ?? { ok: true };
    },
    async closeIfIdle() {
      return true;
    },
  };
  return api;
}

/**
 * @param {{ found?: { id: number }[], remembered?: number | null,
 *   teach?: (s: any) => Promise<any> }} [options]
 *   `remembered`: the download ID that the last save kept (default 41; null: none).
 */
function setup({ found = [{ id: 41 }], remembered = 41, teach } = {}) {
  const offscreen = makeOffscreen();
  /** @type {Record<string, unknown>[]} */
  const searches = [];
  /** @type {number[]} */
  const shown = [];
  const handlers = createHandlers({
    offscreen,
    capture: async () => 'data:image/png;base64,AAAA',
    loadSettings: async () => ({ ...DEFAULT_SETTINGS }),
    recallDownload: async () => remembered ?? undefined,
    searchDownloads: async (query) => {
      searches.push(query);
      return found;
    },
    showDownload: (id) => {
      shown.push(id);
    },
    firstSave: async (s) => s,
    ...(teach ? { teach } : { teach: async (s) => s }),
  });
  return { handlers, offscreen, searches, shown };
}

/**
 * @param {ReturnType<typeof createHandlers>} handlers
 * @param {string} type
 * @param {Record<string, unknown>} fields
 * @param {chrome.runtime.MessageSender} sender
 */
function call(handlers, type, fields, sender) {
  const handler = handlers[type];
  assert.ok(handler, `handler for ${type}`);
  return /** @type {Promise<any>} */ (Promise.resolve(handler(makeMessage(type, fields), sender)));
}

/** @param {string} code */
const spoolError = (code) => (/** @type {unknown} */ e) => {
  assert.ok(e instanceof SpoolError, `expected SpoolError, got ${String(e)}`);
  assert.equal(e.code, code);
  return true;
};

describe('page/show-in-folder', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it('reveals the file that the save made, by the ID that was kept', async () => {
    const { handlers, offscreen, searches, shown } = setup({ found: [{ id: 41 }] });
    offscreen.replies[MSG.OFF_OUTPUT_INFO] = { ok: true, summary: summary() };
    const reply = await call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender({ tabId: 7 }));
    assert.deepEqual(reply, {});
    assert.deepEqual(shown, [41]);
    assert.deepEqual(offscreen.sent, [
      { type: MSG.OFF_OUTPUT_INFO, fields: { sessionId: SESSION_ID, tabId: 7 } },
    ]);
    assert.deepEqual(searches, [{ id: 41, state: 'complete', exists: true, limit: 1 }]);
  });

  it('never looks for a file by the name of a folder: another folder can have that name', async () => {
    // The old search matched any download below a folder called "Spool", so it could reveal a
    // file of an unrelated "Spool" folder. The search is now by ID only.
    const { handlers, offscreen, searches, shown } = setup({
      remembered: 41,
      found: [{ id: 41 }],
    });
    offscreen.replies[MSG.OFF_OUTPUT_INFO] = { ok: true, summary: summary({ label: 'Downloads/Spool' }) };
    await call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender());
    assert.equal(searches.length, 1);
    assert.deepEqual(Object.keys(searches[0] ?? {}).sort(), ['exists', 'id', 'limit', 'state']);
    assert.equal('filenameRegex' in (searches[0] ?? {}), false);
    assert.equal('orderBy' in (searches[0] ?? {}), false);
    assert.deepEqual(shown, [41]);
  });

  it('reveals nothing when a different file answers the search', async () => {
    const { handlers, offscreen, shown } = setup({ remembered: 41, found: [{ id: 99 }] });
    offscreen.replies[MSG.OFF_OUTPUT_INFO] = { ok: true, summary: summary() };
    await assert.rejects(
      call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender()),
      spoolError(ERR.SESSION_NOT_FOUND),
    );
    assert.deepEqual(shown, []);
  });

  it('does nothing harmful when no download ID was kept (the browser restarted)', async () => {
    const { handlers, offscreen, searches, shown } = setup({ remembered: null });
    offscreen.replies[MSG.OFF_OUTPUT_INFO] = { ok: true, summary: summary() };
    await assert.rejects(
      call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender()),
      (e) => spoolError(ERR.SESSION_NOT_FOUND)(e) && /Spool cannot find the saved files/.test(String(/** @type {any} */ (e).message)),
    );
    assert.deepEqual(searches, [], 'no search without an ID');
    assert.deepEqual(shown, []);
  });

  it('refuses a save in a picked folder: the browser has no call to reveal it', async () => {
    const { handlers, offscreen, searches, shown } = setup();
    offscreen.replies[MSG.OFF_OUTPUT_INFO] = {
      ok: true,
      summary: summary({ location: 'folder', label: 'Pictures/Screenshots' }),
    };
    await assert.rejects(
      call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender()),
      spoolError(ERR.INTERNAL),
    );
    assert.deepEqual(searches, []);
    assert.deepEqual(shown, []);
  });

  it('refuses when nothing was saved', async () => {
    const { handlers, offscreen, shown } = setup();
    offscreen.replies[MSG.OFF_OUTPUT_INFO] = {
      ok: true,
      summary: summary({ location: 'none', label: 'Not saved', files: 0 }),
    };
    await assert.rejects(
      call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender()),
      spoolError(ERR.INTERNAL),
    );
    assert.deepEqual(shown, []);
  });

  it('says that the file is gone when the person deleted it', async () => {
    const { handlers, offscreen, shown } = setup({ found: [] });
    offscreen.replies[MSG.OFF_OUTPUT_INFO] = { ok: true, summary: summary() };
    await assert.rejects(
      call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender()),
      (e) => spoolError(ERR.SESSION_NOT_FOUND)(e) && /Spool cannot find the saved files/.test(String(/** @type {any} */ (e).message)),
    );
    assert.deepEqual(shown, []);
  });

  it('works only for the last capture of the tab that asks: another tab gets E_SESSION_NOT_FOUND', async () => {
    const { handlers, offscreen, searches } = setup();
    offscreen.errors[MSG.OFF_OUTPUT_INFO] = new SpoolError(ERR.SESSION_NOT_FOUND, 'gone');
    await assert.rejects(
      call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender({ tabId: 99 })),
      spoolError(ERR.SESSION_NOT_FOUND),
    );
    assert.equal(offscreen.sent[0]?.fields['tabId'], 99, 'the tab of the sender, never one from the message');
    assert.deepEqual(searches, []);
  });

  it('fails when there is no offscreen document: there is no capture', async () => {
    const { handlers, offscreen } = setup();
    offscreen.exists = false;
    await assert.rejects(
      call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, contentSender()),
      spoolError(ERR.SESSION_NOT_FOUND),
    );
  });

  it('refuses a sender that has no tab', async () => {
    const { handlers } = setup();
    await assert.rejects(
      call(handlers, MSG.PAGE_SHOW_IN_FOLDER, { sessionId: SESSION_ID }, extensionPageSender('/src/result/result.html')),
      spoolError(ERR.FORBIDDEN_SENDER),
    );
  });
});

describe('page/finish and the first long captures', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it('gives the summary to the marker, and replies with what it returns', async () => {
    /** @type {any[]} */
    const seen = [];
    const { handlers, offscreen } = setup({
      teach: async (s) => {
        seen.push(s);
        s.teach = true;
        return s;
      },
    });
    offscreen.replies[MSG.OFF_FINALIZE] = { ok: true, summary: summary() };
    const reply = await call(handlers, MSG.PAGE_FINISH, { sessionId: SESSION_ID }, contentSender());
    assert.equal(seen.length, 1);
    assert.equal(seen[0].tileCount, 2);
    assert.equal(reply.summary.teach, true);
    assert.equal(reply.summary.sourceHost, 'example.com');
  });

  it('uses the counter in chrome.storage.local by default: three long captures, then none', async () => {
    /** @type {Record<string, unknown>} */
    const local = {};
    /** @type {any} */ (fake.chrome).storage.local = {
      get: async (/** @type {string} */ key) => (Object.hasOwn(local, key) ? { [key]: local[key] } : {}),
      set: async (/** @type {Record<string, unknown>} */ items) => {
        Object.assign(local, items);
      },
    };
    const handlers = createHandlers({
      offscreen: /** @type {any} */ (
        (() => {
          const o = makeOffscreen();
          o.replies[MSG.OFF_FINALIZE] = { ok: true, summary: summary() };
          return o;
        })()
      ),
      loadSettings: async () => ({ ...DEFAULT_SETTINGS }),
      firstSave: async (s) => s,
    });
    /** @type {boolean[]} */
    const marks = [];
    for (let i = 0; i < 5; i += 1) {
      const reply = await call(handlers, MSG.PAGE_FINISH, { sessionId: SESSION_ID }, contentSender());
      marks.push(reply.summary.teach === true);
    }
    assert.deepEqual(marks, [true, true, true, false, false]);
    assert.deepEqual(local, { longToastsShown: 3 });
  });
});

describe('the config of the page scripts: keys and limits', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  /**
   * Starts a capture and gives the config that reached the page.
   * @param {Parameters<typeof createStarter>[0]} deps
   */
  async function configOf(deps) {
    const starter = createStarter({ schedule: () => 0, cancel: () => {}, ...deps });
    await starter.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
    return /** @type {any} */ (fake.argsOf('scripting.executeScript')[0]?.[0]).args[0];
  }

  it('has the limits that the page cannot import', async () => {
    const config = await configOf({});
    assert.deepEqual(config.limits, {
      maxImagesPerMessage: MAX_IMAGES_PER_MESSAGE,
      maxClipboardBitmapBytes: MAX_CLIPBOARD_BITMAP_BYTES,
    });
  });

  it('writes the keys for a PC: "Alt+Shift+V" in parts, and Ctrl+V to paste', async () => {
    const config = await configOf({
      platform: 'windows',
      readShortcutKeys: async () => ({ start: 'Alt+Shift+S', insert: 'Alt+Shift+V' }),
    });
    assert.deepEqual(config.keys, {
      start: { parts: ['Alt', 'Shift', 'S'], text: 'Alt+Shift+S' },
      insert: { parts: ['Alt', 'Shift', 'V'], text: 'Alt+Shift+V' },
      paste: { parts: ['Ctrl', 'V'], text: 'Ctrl+V' },
    });
    assert.deepEqual(config.shortcuts, { start: 'Alt+Shift+S', insert: 'Alt+Shift+V' }, 'raw, as before');
  });

  it('writes the keys for a Mac: glyph keycaps, and ⌘V to paste', async () => {
    const config = await configOf({
      platform: 'mac',
      readShortcutKeys: async () => ({ start: '⌃⇧S', insert: '⌃⇧V' }),
    });
    assert.deepEqual(config.keys.insert, { parts: ['⌃', '⇧', 'V'], text: '⌃⇧V' });
    assert.deepEqual(config.keys.start, { parts: ['⌃', '⇧', 'S'], text: '⌃⇧S' });
    assert.deepEqual(config.keys.paste, { parts: ['⌘', 'V'], text: '⌘V' });
  });

  it('follows a key that the user changed, and a command that has none', async () => {
    const config = await configOf({
      platform: 'windows',
      readShortcutKeys: async () => ({ start: 'Ctrl+Shift+Y', insert: '' }),
    });
    assert.deepEqual(config.keys.start, { parts: ['Ctrl', 'Shift', 'Y'], text: 'Ctrl+Shift+Y' });
    assert.deepEqual(config.keys.insert, { parts: [], text: '' });
  });

  it('a shelf config has the same keys and limits', async () => {
    const starter = createStarter({
      schedule: () => 0,
      cancel: () => {},
      platform: 'mac',
      readShortcutKeys: async () => ({ start: '⌃⇧S', insert: '⌃⇧V' }),
      registerShelfToken: async () => {},
    });
    await starter.startShelf(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
    const config = /** @type {any} */ (fake.argsOf('scripting.executeScript')[0]?.[0]).args[0];
    assert.equal(config.mode, 'shelf');
    assert.equal(config.keys.insert.text, '⌃⇧V');
    assert.equal(config.limits.maxImagesPerMessage, 20);
  });

  it('when the browser says nothing, the keys of the manifest for the system are used', async () => {
    const win = await configOf({
      platform: 'windows',
      readShortcutKeys: async () => {
        throw new Error('no');
      },
    });
    assert.equal(win.keys.insert.text, 'Alt+Shift+V');
    assert.equal(win.keys.start.text, 'Alt+Shift+S');
    fake.uninstall();
    fake = installFakeChrome();
    const mac = await configOf({
      platform: 'mac',
      readShortcutKeys: async () => {
        throw new Error('no');
      },
    });
    assert.equal(mac.keys.insert.text, '⌃⇧V');
    assert.equal(mac.keys.start.text, '⌃⇧S');
  });

  it('readShortcuts gives the manifest key of the system for a missing command', async () => {
    /** @type {any} */ (fake.chrome).commands = {
      onCommand: fake.chrome.commands.onCommand,
      getAll: async () => [],
    };
    assert.deepEqual(await readShortcuts('mac'), { start: '⌃⇧S', insert: '⌃⇧V' });
    assert.deepEqual(await readShortcuts('windows'), { start: 'Alt+Shift+S', insert: 'Alt+Shift+V' });
    assert.deepEqual(await readShortcuts(), { start: 'Alt+Shift+S', insert: 'Alt+Shift+V' });
  });

  it('systemPlatform reads navigator, and falls back to a PC without it', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
    try {
      for (const [value, kind] of [
        [{ userAgentData: { platform: 'macOS' }, platform: 'MacIntel' }, 'mac'],
        [{ platform: 'MacIntel' }, 'mac'],
        [{ platform: 'Win32' }, 'windows'],
        [{ userAgentData: { platform: 'Linux' }, platform: 'Linux x86_64' }, 'linux'],
      ]) {
        Object.defineProperty(globalThis, 'navigator', { value, configurable: true });
        assert.equal(systemPlatform(), kind, JSON.stringify(value));
      }
      Object.defineProperty(globalThis, 'navigator', { value: undefined, configurable: true });
      assert.equal(systemPlatform(), 'linux');
    } finally {
      if (original) Object.defineProperty(globalThis, 'navigator', original);
      else delete (/** @type {any} */ (globalThis).navigator);
    }
  });
});
