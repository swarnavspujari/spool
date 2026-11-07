// @ts-check
/**
 * Service worker side of the post-capture flow (docs/contracts.md section 7): clipboard, tiles,
 * result and options pages, the shelf, and the download request of the offscreen document.
 * The sender rules are tested here too: a session request needs the tab of the session (the
 * worker takes it from `sender.tab`), a shelf request the tab of the token.
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PATHS } from '../../src/shared/constants.js';
import { ERR, MSG, SpoolError, makeMessage } from '../../src/shared/protocol.js';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';
import { createHandlers } from '../../src/sw/handlers.js';
import { createRouter } from '../../src/sw/router.js';
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  contentSender,
  installFakeChrome,
} from '../helpers/fake-chrome.js';

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';
const TOKEN = '0c9d6a52-7b1e-4f3a-9a40-2d8e5b7c1f66';
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUg==';
const SUMMARY = {
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
  save: { location: 'folder', label: 'Screenshots', files: 3, needsPermission: false },
  warnings: ['one'],
};

/** A fake offscreen API. It records what the handlers send, and replies from `replies`. */
function makeOffscreen() {
  /** @type {{ type: string, fields: Record<string, any> }[]} */
  const sent = [];
  /** @type {Record<string, unknown>} */
  const errors = {};
  /** @type {Record<string, Record<string, unknown>>} */
  const replies = {};
  const api = {
    exists: true,
    sent,
    errors,
    replies,
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

/** @param {Parameters<typeof createHandlers>[0]} [overrides] */
function setup(overrides = {}) {
  const offscreen = makeOffscreen();
  /** @type {string[]} */
  const clipboard = [];
  /** @type {{ path: string, url: string }[][]} */
  const downloads = [];
  const state = { copied: true };
  const handlers = createHandlers({
    offscreen,
    capture: async () => 'data:image/png;base64,AAAA',
    loadSettings: async () => ({ ...DEFAULT_SETTINGS }),
    writeClipboard: async (png) => {
      clipboard.push(png);
      return state.copied;
    },
    downloadFiles: async (files) => {
      downloads.push(files);
      return { saved: files.length, rejected: 0, interrupted: 0 };
    },
    ...overrides,
  });
  return { handlers, offscreen, clipboard, downloads, state };
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

/** @param {string} code @param {string} [message] */
function spoolError(code, message) {
  return (/** @type {unknown} */ e) => {
    assert.ok(e instanceof SpoolError, `expected SpoolError, got ${String(e)}`);
    assert.equal(e.code, code);
    if (message !== undefined) assert.equal(e.message, message);
    return true;
  };
}

/** @param {string} path */
function extensionPageSender(path) {
  return /** @type {chrome.runtime.MessageSender} */ (
    /** @type {any} */ ({ id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}${path}` })
  );
}

describe('post-capture handlers', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  describe('page/get-clipboard: the clipboard always gets the full image', () => {
    it('asks the offscreen document for the full image of the session and the tab', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_GET_OUTPUT] = { ok: true, pngBase64: PNG_B64 };
      const reply = await call(
        handlers,
        MSG.PAGE_GET_CLIPBOARD,
        { sessionId: SESSION_ID },
        contentSender({ tabId: 7 }),
      );
      assert.deepEqual(reply, { pngBase64: PNG_B64 });
      assert.deepEqual(offscreen.sent, [
        { type: MSG.OFF_GET_OUTPUT, fields: { sessionId: SESSION_ID, tabId: 7, item: 'full' } },
      ]);
    });

    it('takes the tab from the sender, so another tab cannot read the session', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_GET_OUTPUT] = new SpoolError(ERR.SESSION_NOT_FOUND, 'gone');
      await assert.rejects(
        call(handlers, MSG.PAGE_GET_CLIPBOARD, { sessionId: SESSION_ID }, contentSender({ tabId: 99 })),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
      assert.equal(offscreen.sent[0]?.fields.tabId, 99);
    });

    it('fails with E_SESSION_NOT_FOUND when there is no offscreen document', async () => {
      const { handlers, offscreen } = setup();
      offscreen.exists = false;
      await assert.rejects(
        call(handlers, MSG.PAGE_GET_CLIPBOARD, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
      assert.deepEqual(offscreen.sent, []);
    });

    it('passes on E_SESSION_TOO_LARGE for an image over the message limit', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_GET_OUTPUT] = new SpoolError(
        ERR.SESSION_TOO_LARGE,
        'This image is too large to copy. Use the AI screenshots.',
      );
      await assert.rejects(
        call(handlers, MSG.PAGE_GET_CLIPBOARD, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.SESSION_TOO_LARGE, 'This image is too large to copy. Use the AI screenshots.'),
      );
    });

    it('replies E_INTERNAL when the offscreen reply has no image', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_GET_OUTPUT] = { ok: true };
      await assert.rejects(
        call(handlers, MSG.PAGE_GET_CLIPBOARD, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.INTERNAL),
      );
    });

    it('refuses a sender without a tab', async () => {
      const { handlers, offscreen } = setup();
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_GET_CLIPBOARD,
          { sessionId: SESSION_ID },
          extensionPageSender(PATHS.options),
        ),
        spoolError(ERR.FORBIDDEN_SENDER),
      );
      assert.deepEqual(offscreen.sent, []);
    });
  });

  describe('page/clipboard-fallback', () => {
    it('writes the full image with the worker clipboard', async () => {
      const { handlers, offscreen, clipboard } = setup();
      offscreen.replies[MSG.OFF_GET_OUTPUT] = { ok: true, pngBase64: PNG_B64 };
      const reply = await call(
        handlers,
        MSG.PAGE_CLIPBOARD_FALLBACK,
        { sessionId: SESSION_ID },
        contentSender({ tabId: 7 }),
      );
      assert.deepEqual(reply, { copied: true });
      assert.deepEqual(clipboard, [PNG_B64]);
      // Never a tile: the rule is the full image.
      assert.deepEqual(offscreen.sent, [
        { type: MSG.OFF_GET_OUTPUT, fields: { sessionId: SESSION_ID, tabId: 7, item: 'full' } },
      ]);
    });

    it('replies copied false when the clipboard write fails', async () => {
      const { handlers, offscreen, state } = setup();
      offscreen.replies[MSG.OFF_GET_OUTPUT] = { ok: true, pngBase64: PNG_B64 };
      state.copied = false;
      assert.deepEqual(
        await call(handlers, MSG.PAGE_CLIPBOARD_FALLBACK, { sessionId: SESSION_ID }, contentSender()),
        { copied: false },
      );
    });

    it('replies copied false, and writes nothing, for an image that is too large', async () => {
      const { handlers, offscreen, clipboard } = setup();
      offscreen.errors[MSG.OFF_GET_OUTPUT] = new SpoolError(ERR.SESSION_TOO_LARGE, 'big');
      assert.deepEqual(
        await call(handlers, MSG.PAGE_CLIPBOARD_FALLBACK, { sessionId: SESSION_ID }, contentSender()),
        { copied: false },
      );
      assert.deepEqual(clipboard, []);
    });

    it('replies copied false when the full image was not built', async () => {
      const { handlers, offscreen, clipboard } = setup();
      offscreen.errors[MSG.OFF_GET_OUTPUT] = new SpoolError(ERR.INTERNAL, 'no full');
      assert.deepEqual(
        await call(handlers, MSG.PAGE_CLIPBOARD_FALLBACK, { sessionId: SESSION_ID }, contentSender()),
        { copied: false },
      );
      assert.deepEqual(clipboard, []);
    });

    it('passes on an error about the session (not the capture of this tab)', async () => {
      const { handlers, offscreen, clipboard } = setup();
      offscreen.errors[MSG.OFF_GET_OUTPUT] = new SpoolError(ERR.SESSION_NOT_FOUND, 'gone');
      await assert.rejects(
        call(handlers, MSG.PAGE_CLIPBOARD_FALLBACK, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
      assert.deepEqual(clipboard, []);
    });

    it('fails with E_SESSION_NOT_FOUND when there is no offscreen document', async () => {
      const { handlers, offscreen } = setup();
      offscreen.exists = false;
      await assert.rejects(
        call(handlers, MSG.PAGE_CLIPBOARD_FALLBACK, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
    });
  });

  describe('page/get-tile', () => {
    it('asks for one tile of the session and the tab of the sender', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_GET_OUTPUT] = { ok: true, pngBase64: PNG_B64 };
      const reply = await call(
        handlers,
        MSG.PAGE_GET_TILE,
        { sessionId: SESSION_ID, index: 3 },
        contentSender({ tabId: 5 }),
      );
      assert.deepEqual(reply, { pngBase64: PNG_B64 });
      assert.deepEqual(offscreen.sent, [
        { type: MSG.OFF_GET_OUTPUT, fields: { sessionId: SESSION_ID, tabId: 5, item: 3 } },
      ]);
    });

    it('passes on E_BAD_MESSAGE for a tile that does not exist', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_GET_OUTPUT] = new SpoolError(ERR.BAD_MESSAGE, 'Unknown part.');
      await assert.rejects(
        call(handlers, MSG.PAGE_GET_TILE, { sessionId: SESSION_ID, index: 40 }, contentSender()),
        spoolError(ERR.BAD_MESSAGE, 'Unknown part.'),
      );
    });
  });

  describe('page/open-result', () => {
    it('checks the capture, then opens the result page next to the tab', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_OUTPUT_INFO] = { ok: true, summary: SUMMARY };
      const reply = await call(
        handlers,
        MSG.PAGE_OPEN_RESULT,
        { sessionId: SESSION_ID },
        contentSender({ tabId: 7, windowId: 3, index: 4 }),
      );
      assert.deepEqual(reply, {});
      assert.deepEqual(offscreen.sent, [
        { type: MSG.OFF_OUTPUT_INFO, fields: { sessionId: SESSION_ID, tabId: 7 } },
      ]);
      assert.deepEqual(fake.argsOf('tabs.create'), [
        [
          {
            url: `${EXTENSION_ORIGIN}${PATHS.result}#${SESSION_ID}`,
            windowId: 3,
            index: 5,
            openerTabId: 7,
          },
        ],
      ]);
    });

    it('opens nothing for a session that is not the capture of this tab', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_OUTPUT_INFO] = new SpoolError(ERR.SESSION_NOT_FOUND, 'gone');
      await assert.rejects(
        call(handlers, MSG.PAGE_OPEN_RESULT, { sessionId: SESSION_ID }, contentSender({ tabId: 99 })),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
      assert.equal(fake.argsOf('tabs.create').length, 0);
      assert.equal(offscreen.sent[0]?.fields.tabId, 99);
    });

    it('opens nothing when there is no offscreen document', async () => {
      const { handlers, offscreen } = setup();
      offscreen.exists = false;
      await assert.rejects(
        call(handlers, MSG.PAGE_OPEN_RESULT, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
      assert.equal(fake.argsOf('tabs.create').length, 0);
    });

    it('fails with a plain message when the tab cannot open', async () => {
      const { handlers } = setup();
      fake.behavior.tabsCreate = async () => {
        throw new Error('Tab opener must be in the same window.');
      };
      await assert.rejects(
        call(handlers, MSG.PAGE_OPEN_RESULT, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.INTERNAL, 'Could not open the capture page. Try again.'),
      );
    });
  });

  describe('page/open-options', () => {
    it('opens the options page at the save section, next to the tab', async () => {
      const { handlers, offscreen } = setup();
      const reply = await call(
        handlers,
        MSG.PAGE_OPEN_OPTIONS,
        { section: 'save' },
        contentSender({ tabId: 7, windowId: 3, index: 0 }),
      );
      assert.deepEqual(reply, {});
      assert.deepEqual(fake.argsOf('tabs.create'), [
        [
          {
            url: `${EXTENSION_ORIGIN}${PATHS.options}#save`,
            windowId: 3,
            index: 1,
            openerTabId: 7,
          },
        ],
      ]);
      assert.deepEqual(offscreen.sent, [], 'needs no offscreen document');
    });

    it('fails with a plain message when the tab cannot open', async () => {
      const { handlers } = setup();
      fake.behavior.tabsCreate = async () => {
        throw new Error('no');
      };
      await assert.rejects(
        call(handlers, MSG.PAGE_OPEN_OPTIONS, { section: 'save' }, contentSender()),
        spoolError(ERR.INTERNAL, 'Could not open Settings. Try again.'),
      );
    });

    it('refuses a sender without a tab', async () => {
      const { handlers } = setup();
      await assert.rejects(
        call(handlers, MSG.PAGE_OPEN_OPTIONS, { section: 'save' }, extensionPageSender(PATHS.result)),
        spoolError(ERR.FORBIDDEN_SENDER),
      );
      assert.equal(fake.argsOf('tabs.create').length, 0);
    });
  });

  describe('page/shelf-info', () => {
    it('asks with the token and the tab of the sender, and returns the checked, trimmed summary', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_SHELF_INFO] = { ok: true, summary: { ...SUMMARY, extra: 1 } };
      const reply = await call(
        handlers,
        MSG.PAGE_SHELF_INFO,
        { token: TOKEN },
        contentSender({ tabId: 12 }),
      );
      // The shelf runs in any tab: it gets the size, the age, the host name of the captured page,
      // the place of the files and the thumbnail, not the title.
      assert.deepEqual(reply, {
        summary: {
          tileCount: SUMMARY.tileCount,
          widthPx: SUMMARY.widthPx,
          heightPx: SUMMARY.heightPx,
          createdAt: SUMMARY.createdAt,
          sourceHost: SUMMARY.sourceHost,
          saveLabel: SUMMARY.save.label,
          thumbnailPngBase64: SUMMARY.thumbnailPngBase64,
          thumbnailWidthPx: SUMMARY.thumbnailWidthPx,
          thumbnailHeightPx: SUMMARY.thumbnailHeightPx,
        },
      });
      assert.deepEqual(offscreen.sent, [
        { type: MSG.OFF_SHELF_INFO, fields: { token: TOKEN, tabId: 12 } },
      ]);
    });

    it('replies summary null when there is no last capture', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_SHELF_INFO] = { ok: true, summary: null };
      assert.deepEqual(
        await call(handlers, MSG.PAGE_SHELF_INFO, { token: TOKEN }, contentSender()),
        { summary: null },
      );
    });

    it('replies summary null, and sends nothing, when there is no offscreen document', async () => {
      const { handlers, offscreen } = setup();
      offscreen.exists = false;
      assert.deepEqual(
        await call(handlers, MSG.PAGE_SHELF_INFO, { token: TOKEN }, contentSender()),
        { summary: null },
      );
      assert.deepEqual(offscreen.sent, []);
    });

    it('passes on the refusal for a token of another tab', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_SHELF_INFO] = new SpoolError(ERR.FORBIDDEN_SENDER, 'Sender not allowed.');
      await assert.rejects(
        call(handlers, MSG.PAGE_SHELF_INFO, { token: TOKEN }, contentSender({ tabId: 99 })),
        spoolError(ERR.FORBIDDEN_SENDER),
      );
      assert.equal(offscreen.sent[0]?.fields.tabId, 99);
    });

    it('passes on the error for an expired token', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_SHELF_INFO] = new SpoolError(ERR.SESSION_NOT_FOUND, 'expired');
      await assert.rejects(
        call(handlers, MSG.PAGE_SHELF_INFO, { token: TOKEN }, contentSender()),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
    });

    it('replies E_INTERNAL for a summary that does not fit the contract', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_SHELF_INFO] = { ok: true, summary: { ...SUMMARY, widthPx: 0 } };
      await assert.rejects(
        call(handlers, MSG.PAGE_SHELF_INFO, { token: TOKEN }, contentSender()),
        spoolError(ERR.INTERNAL),
      );
    });
  });

  describe('page/shelf-get', () => {
    it('reads a tile or the full image with the token and the tab of the sender', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_SHELF_GET] = { ok: true, pngBase64: PNG_B64 };
      for (const item of [0, 4, 'full']) {
        offscreen.sent.length = 0;
        const reply = await call(
          handlers,
          MSG.PAGE_SHELF_GET,
          { token: TOKEN, item },
          contentSender({ tabId: 12 }),
        );
        assert.deepEqual(reply, { pngBase64: PNG_B64 });
        assert.deepEqual(offscreen.sent, [
          { type: MSG.OFF_SHELF_GET, fields: { token: TOKEN, tabId: 12, item } },
        ]);
      }
    });

    it('fails with E_SESSION_NOT_FOUND when there is no offscreen document', async () => {
      const { handlers, offscreen } = setup();
      offscreen.exists = false;
      await assert.rejects(
        call(handlers, MSG.PAGE_SHELF_GET, { token: TOKEN, item: 'full' }, contentSender()),
        spoolError(
          ERR.SESSION_NOT_FOUND,
          'Nothing to insert yet. Press Alt+Shift+S to spool a page.',
        ),
      );
      assert.deepEqual(offscreen.sent, []);
    });

    it('passes on the refusal for a token of another tab', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_SHELF_GET] = new SpoolError(ERR.FORBIDDEN_SENDER, 'Sender not allowed.');
      await assert.rejects(
        call(handlers, MSG.PAGE_SHELF_GET, { token: TOKEN, item: 0 }, contentSender({ tabId: 99 })),
        spoolError(ERR.FORBIDDEN_SENDER),
      );
    });

    it('replies E_INTERNAL when the offscreen reply has no image', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_SHELF_GET] = { ok: true, pngBase64: '' };
      await assert.rejects(
        call(handlers, MSG.PAGE_SHELF_GET, { token: TOKEN, item: 0 }, contentSender()),
        spoolError(ERR.INTERNAL),
      );
    });
  });

  describe('sw/download', () => {
    const goodUrl = `blob:${EXTENSION_ORIGIN}6f1c2e84-3b7a-4d19-8c55-0a9e4b2d7f13`;
    const offscreenSender = () => extensionPageSender(PATHS.offscreen);

    it('downloads the files and replies with the counts', async () => {
      const { handlers, downloads } = setup({
        downloadFiles: async (files) => ({ saved: files.length - 1, rejected: 1, interrupted: 0 }),
      });
      const files = [
        { path: 'Spool/Spool 2026-11-06 15.22.48 A.png', url: goodUrl },
        { path: 'Spool/Spool for AI/B/screenshot-01-of-02.png', url: goodUrl },
      ];
      const reply = await call(handlers, MSG.SW_DOWNLOAD, { files }, offscreenSender());
      assert.deepEqual(reply, { saved: 1, rejected: 1, interrupted: 0 });
      assert.deepEqual(downloads, []);
    });

    it('keeps the ID of the first complete file for "Show in folder", and tells the offscreen document nothing about it', async () => {
      /** @type {number[]} */
      const kept = [];
      const { handlers } = setup({
        downloadFiles: async (files, onComplete) => {
          onComplete?.(41); // the full image
          onComplete?.(42); // the first tile
          return { saved: files.length, rejected: 0, interrupted: 0 };
        },
        rememberDownload: async (id) => {
          kept.push(id);
        },
      });
      const reply = await call(
        handlers,
        MSG.SW_DOWNLOAD,
        { files: [{ path: 'Spool/a.png', url: goodUrl }] },
        offscreenSender(),
      );
      assert.deepEqual(kept, [41]);
      assert.deepEqual(reply, { saved: 1, rejected: 0, interrupted: 0 }, 'the reply has the counts only');
    });

    it('keeps no ID when no file is complete', async () => {
      /** @type {number[]} */
      const kept = [];
      const { handlers } = setup({
        downloadFiles: async () => ({ saved: 0, rejected: 1, interrupted: 1 }),
        rememberDownload: async (id) => {
          kept.push(id);
        },
      });
      await call(
        handlers,
        MSG.SW_DOWNLOAD,
        { files: [{ path: 'Spool/a.png', url: goodUrl }] },
        offscreenSender(),
      );
      assert.deepEqual(kept, []);
    });

    it('passes the files to the downloader unchanged', async () => {
      /** @type {{ path: string, url: string }[][]} */
      const seen = [];
      const { handlers } = setup({
        downloadFiles: async (files) => {
          seen.push(files);
          return { saved: files.length, rejected: 0, interrupted: 0 };
        },
      });
      const files = [{ path: 'Spool/a.png', url: goodUrl }];
      await call(handlers, MSG.SW_DOWNLOAD, { files }, offscreenSender());
      assert.deepEqual(seen, [files]);
    });

    it('refuses a blob URL of another extension and downloads nothing', async () => {
      const { handlers, downloads } = setup();
      const foreign = 'blob:chrome-extension://zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz/6f1c2e84-3b7a-4d19-8c55-0a9e4b2d7f13';
      await assert.rejects(
        call(
          handlers,
          MSG.SW_DOWNLOAD,
          {
            files: [
              { path: 'Spool/a.png', url: goodUrl },
              { path: 'Spool/b.png', url: foreign },
            ],
          },
          offscreenSender(),
        ),
        spoolError(ERR.BAD_MESSAGE),
      );
      assert.deepEqual(downloads, []);
    });
  });

  describe('through the router (sender rules)', () => {
    /** @param {Record<string, unknown>} msg @param {chrome.runtime.MessageSender} sender */
    async function send(msg, sender) {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_GET_OUTPUT] = { ok: true, pngBase64: PNG_B64 };
      const router = createRouter(handlers, { runtimeId: EXTENSION_ID, origin: EXTENSION_ORIGIN });
      return new Promise((resolve) => {
        const kept = router(msg, sender, resolve);
        if (!kept) resolve(undefined);
      });
    }

    it('answers the page of a tab', async () => {
      const reply = await send(
        makeMessage(MSG.PAGE_GET_TILE, { sessionId: SESSION_ID, index: 0 }),
        contentSender(),
      );
      assert.deepEqual(reply, { ok: true, pngBase64: PNG_B64 });
    });

    it('refuses every page message from the extension pages and from a sub frame', async () => {
      const messages = [
        makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }),
        makeMessage(MSG.PAGE_GET_CLIPBOARD, { sessionId: SESSION_ID }),
        makeMessage(MSG.PAGE_CLIPBOARD_FALLBACK, { sessionId: SESSION_ID }),
        makeMessage(MSG.PAGE_GET_TILE, { sessionId: SESSION_ID, index: 0 }),
        makeMessage(MSG.PAGE_OPEN_RESULT, { sessionId: SESSION_ID }),
        makeMessage(MSG.PAGE_OPEN_OPTIONS, { section: 'save' }),
        makeMessage(MSG.PAGE_SHELF_INFO, { token: TOKEN }),
        makeMessage(MSG.PAGE_SHELF_GET, { token: TOKEN, item: 'full' }),
      ];
      const senders = [
        extensionPageSender(PATHS.result),
        extensionPageSender(PATHS.options),
        extensionPageSender(PATHS.offscreen),
        extensionPageSender(PATHS.serviceWorker),
        contentSender({ frameId: 2 }),
        contentSender({ id: 'some-other-extension-id' }),
      ];
      for (const msg of messages) {
        for (const sender of senders) {
          const reply = /** @type {any} */ (await send(msg, sender));
          assert.equal(reply?.ok, false, `${String(msg.type)}`);
          assert.equal(reply?.error?.code, ERR.FORBIDDEN_SENDER, `${String(msg.type)}`);
        }
      }
    });

    it('lets only the offscreen document ask for downloads', async () => {
      const msg = makeMessage(MSG.SW_DOWNLOAD, {
        files: [
          { path: 'Spool/a.png', url: `blob:${EXTENSION_ORIGIN}6f1c2e84-3b7a-4d19-8c55-0a9e4b2d7f13` },
        ],
      });
      const ok = /** @type {any} */ (await send(msg, extensionPageSender(PATHS.offscreen)));
      assert.equal(ok.ok, true);
      for (const sender of [
        contentSender(),
        extensionPageSender(PATHS.result),
        extensionPageSender(PATHS.options),
        extensionPageSender(PATHS.serviceWorker),
      ]) {
        const reply = /** @type {any} */ (await send(msg, sender));
        assert.equal(reply?.error?.code, ERR.FORBIDDEN_SENDER);
      }
    });

    it('does not let the page send a tab id', async () => {
      const reply = /** @type {any} */ (
        await send(
          { ...makeMessage(MSG.PAGE_GET_CLIPBOARD, { sessionId: SESSION_ID }), tabId: 1 },
          contentSender(),
        )
      );
      assert.equal(reply.error.code, ERR.BAD_MESSAGE);
    });
  });
});

describe('page/open-options: the sections that the toast opens', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  for (const section of ['setup', 'reconnect']) {
    it(`opens the options page at #${section}, next to the tab`, async () => {
      const handlers = createHandlers({
        offscreen: /** @type {any} */ ({}),
        loadSettings: async () => ({ ...DEFAULT_SETTINGS }),
      });
      const handler = handlers[MSG.PAGE_OPEN_OPTIONS];
      assert.ok(handler);
      const reply = await handler(
        makeMessage(MSG.PAGE_OPEN_OPTIONS, { section }),
        contentSender({ tabId: 7, windowId: 3, index: 0 }),
      );
      assert.deepEqual(reply, {});
      assert.equal(
        /** @type {any} */ (fake.argsOf('tabs.create')[0]?.[0]).url,
        `${EXTENSION_ORIGIN}${PATHS.options}#${section}`,
      );
    });
  }
});
