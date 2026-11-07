// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PATHS, SEAM_STATUSES } from '../../src/shared/constants.js';
import { ERR, MSG, SpoolError, makeMessage } from '../../src/shared/protocol.js';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '../../src/shared/settings.js';
import { createHandlers, dropTabSessions } from '../../src/sw/handlers.js';
import {
  closeIfIdle,
  ensureAndSend,
  ensureOffscreen,
  offscreenExists,
  sendToOffscreen,
} from '../../src/sw/offscreen-client.js';
import { createRouter } from '../../src/sw/router.js';
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  PNG_DATA_URL,
  contentSender,
  deferred,
  installFakeChrome,
  macrotask,
} from '../helpers/fake-chrome.js';

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';
const OTHER_SESSION_ID = '0a1b2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d';
const META = {
  direction: 'down',
  viewport: { width: 1000, height: 800 },
  rect: { x: 10, y: 20, width: 500, height: 400 },
  contentY: 320,
};
/** What the offscreen document replies to a stored frame (an IntakeResult). */
const INTAKE = {
  index: 1,
  sliceCount: 2,
  widthPx: 1000,
  totalHeightPx: 1600,
  tileCount: 1,
  seam: { status: 'exact', shiftPx: 0, meanDiff: 0.5 },
  storedBytes: 4096,
};
/** What the page gets: only the fields that the agent uses (a PageIntake). */
const PAGE_INTAKE = {
  index: 1,
  sliceCount: 2,
  totalHeightPx: 1600,
  tileCount: 1,
  seam: { status: 'exact' },
};

/** What the offscreen document replies to `offscreen/finalize` (a FinishSummary). */
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
  save: { location: 'downloads', label: 'Downloads/Spool', files: 3, needsPermission: false },
  warnings: [],
};

/**
 * A fake offscreen API for the handlers. Records every call in `order` and `sent`.
 * @param {string[]} order
 */
function makeOffscreen(order) {
  /** @type {{ type: string, fields: Record<string, unknown> }[]} */
  const sent = [];
  /** @type {{ type: string, fields: Record<string, unknown> }[]} */
  const ensured = [];
  /** @type {Record<string, unknown>} Errors that `sendToOffscreen` throws, by type. */
  const errors = {};
  /** @type {Record<string, Record<string, unknown>>} */
  const replies = {
    [MSG.OFF_ADD_FRAME]: { ok: true, intake: INTAKE },
    [MSG.OFF_SESSION_DROP]: { ok: true, remaining: 0 },
  };
  const api = {
    exists: true,
    sent,
    ensured,
    errors,
    replies,
    closed: 0,
    async offscreenExists() {
      order.push('exists');
      return api.exists;
    },
    /** @param {string} type @param {Record<string, unknown>} [fields] */
    async ensureAndSend(type, fields = {}) {
      order.push(`ensureAndSend:${type}`);
      ensured.push({ type, fields });
      if (Object.hasOwn(errors, type)) throw errors[type];
      return { ok: true };
    },
    /** @param {string} type @param {Record<string, unknown>} [fields] */
    async sendToOffscreen(type, fields = {}) {
      order.push(`send:${type}`);
      sent.push({ type, fields });
      if (Object.hasOwn(errors, type)) throw errors[type];
      return replies[type] ?? { ok: true };
    },
    async closeIfIdle() {
      order.push('closeIfIdle');
      api.closed += 1;
      return true;
    },
  };
  return api;
}

/** Handlers wired to fakes. Every dependency can be replaced. */
function setup(/** @type {Parameters<typeof createHandlers>[0]} */ overrides = {}) {
  /** @type {string[]} */
  const order = [];
  const offscreen = makeOffscreen(order);
  /** @type {number[]} */
  const captured = [];
  const handlers = createHandlers({
    offscreen,
    capture: async (windowId) => {
      order.push('capture');
      captured.push(windowId);
      return PNG_DATA_URL;
    },
    loadSettings: async () => ({ ...DEFAULT_SETTINGS }),
    ...overrides,
  });
  return { handlers, offscreen, order, captured };
}

/**
 * Calls the handler of `type` like the router does.
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

/** @param {number} tabId @param {number} windowId */
function activeTabs(tabId, windowId) {
  return [{ id: tabId, windowId, active: true, index: 0 }];
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

describe('handlers', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  describe('page/session-open', () => {
    it('creates the offscreen document and opens the session with the sender tab', async () => {
      const { handlers, offscreen } = setup({
        loadSettings: async () => ({ ...DEFAULT_SETTINGS, tileTier: 'standard' }),
      });
      const reply = await call(
        handlers,
        MSG.PAGE_SESSION_OPEN,
        { sessionId: SESSION_ID, title: 'My page' },
        contentSender({ tabId: 7, windowId: 3 }),
      );
      assert.deepEqual(reply, {});
      assert.deepEqual(offscreen.ensured, [
        {
          type: MSG.OFF_SESSION_OPEN,
          fields: {
            sessionId: SESSION_ID,
            tabId: 7,
            title: 'My page',
            host: 'example.com',
            tileTier: 'standard',
          },
        },
      ]);
    });

    it('takes the host from the sender, never from the message', async () => {
      const { handlers, offscreen } = setup();
      await call(
        handlers,
        MSG.PAGE_SESSION_OPEN,
        { sessionId: SESSION_ID, title: 'github.com', host: 'bank.example' },
        contentSender({ url: 'https://Github.com:8443/pulls?q=secret#top' }),
      );
      assert.equal(offscreen.ensured[0]?.fields.host, 'github.com');
    });

    it('keeps only the host name: no path, no query, no port; none for a local file', async () => {
      for (const [url, host] of [
        ['https://mail.example.com/u/0/#inbox', 'mail.example.com'],
        ['http://localhost:3000/app', 'localhost'],
        ['http://[::1]:8080/', '[::1]'],
        ['https://bücher.example/', 'xn--bcher-kva.example'],
        ['file:///C:/Users/me/report.html', ''],
        ['about:blank', ''],
        ['not a url', ''],
        [undefined, ''],
      ]) {
        const { handlers, offscreen } = setup();
        await call(
          handlers,
          MSG.PAGE_SESSION_OPEN,
          { sessionId: SESSION_ID, title: 't' },
          contentSender(url === undefined ? { url: '' } : { url }),
        );
        assert.equal(offscreen.ensured[0]?.fields.host, host, String(url));
      }
    });

    it('passes the high tier from the default settings', async () => {
      const { handlers, offscreen } = setup();
      await call(
        handlers,
        MSG.PAGE_SESSION_OPEN,
        { sessionId: SESSION_ID, title: '' },
        contentSender(),
      );
      assert.equal(offscreen.ensured[0]?.fields.tileTier, 'high');
    });

    it('reads the tile tier from chrome.storage.sync by default', async () => {
      fake.state.storage[SETTINGS_STORAGE_KEY] = { tileTier: 'standard' };
      /** @type {string[]} */
      const order = [];
      const offscreen = makeOffscreen(order);
      const handlers = createHandlers({ offscreen });
      await call(
        handlers,
        MSG.PAGE_SESSION_OPEN,
        { sessionId: SESSION_ID, title: 't' },
        contentSender(),
      );
      assert.equal(offscreen.ensured[0]?.fields.tileTier, 'standard');
    });

    it('falls back to the default tier when the settings cannot be read', async () => {
      const { handlers, offscreen } = setup({
        loadSettings: async () => {
          throw new Error('storage unavailable');
        },
      });
      await call(
        handlers,
        MSG.PAGE_SESSION_OPEN,
        { sessionId: SESSION_ID, title: '' },
        contentSender(),
      );
      assert.equal(offscreen.ensured[0]?.fields.tileTier, DEFAULT_SETTINGS.tileTier);
    });

    it('takes tabId only from the sender, never from the message', async () => {
      const { handlers, offscreen } = setup();
      const handler = handlers[MSG.PAGE_SESSION_OPEN];
      assert.ok(handler);
      await handler(
        { ...makeMessage(MSG.PAGE_SESSION_OPEN, { sessionId: SESSION_ID, title: '' }), tabId: 99 },
        contentSender({ tabId: 7 }),
      );
      assert.equal(offscreen.ensured[0]?.fields.tabId, 7);
    });

    it('refuses a sender without a usable tab', async () => {
      const { handlers, offscreen } = setup();
      const fields = { sessionId: SESSION_ID, title: '' };
      const senders = [
        extensionPageSender('src/result/result.html'),
        /** @type {any} */ ({ id: EXTENSION_ID, tab: {} }),
        /** @type {any} */ ({ id: EXTENSION_ID, tab: { id: -1, windowId: 1 } }),
        /** @type {any} */ ({ id: EXTENSION_ID, tab: { id: 1 } }),
        /** @type {any} */ ({ id: EXTENSION_ID, tab: { id: 1.5, windowId: 1 } }),
      ];
      for (const sender of senders) {
        await assert.rejects(
          call(handlers, MSG.PAGE_SESSION_OPEN, fields, sender),
          spoolError(ERR.FORBIDDEN_SENDER),
        );
      }
      assert.deepEqual(offscreen.ensured, []);
    });

    it('passes on an error of the offscreen document', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_SESSION_OPEN] = new SpoolError(ERR.INTERNAL, 'No store.');
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_SESSION_OPEN,
          { sessionId: SESSION_ID, title: '' },
          contentSender(),
        ),
        spoolError(ERR.INTERNAL, 'No store.'),
      );
    });
  });

  describe('page/capture-frame', () => {
    it('checks the tab, captures, checks the tab again, then stores the frame', async () => {
      const { handlers, offscreen, order, captured } = setup();
      fake.behavior.tabsQuery = async (q) => {
        order.push('query');
        assert.deepEqual(q, { active: true, windowId: 3 });
        return activeTabs(7, 3);
      };
      const reply = await call(
        handlers,
        MSG.PAGE_CAPTURE_FRAME,
        { sessionId: SESSION_ID, meta: META },
        contentSender({ tabId: 7, windowId: 3 }),
      );
      assert.deepEqual(reply, { intake: PAGE_INTAKE });
      assert.deepEqual(order, [
        'exists',
        'query',
        'capture',
        'query',
        `send:${MSG.OFF_ADD_FRAME}`,
      ]);
      assert.deepEqual(captured, [3], 'the window of the sender');
      assert.deepEqual(offscreen.sent, [
        {
          type: MSG.OFF_ADD_FRAME,
          fields: { sessionId: SESSION_ID, tabId: 7, dataUrl: PNG_DATA_URL, meta: META },
        },
      ]);
    });

    it('refuses when the tab is not the active tab of its window, before capturing', async () => {
      const { handlers, offscreen, captured } = setup();
      fake.behavior.tabsQuery = async () => activeTabs(8, 3); // Another tab is active.
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_CAPTURE_FRAME,
          { sessionId: SESSION_ID, meta: META },
          contentSender({ tabId: 7, windowId: 3 }),
        ),
        spoolError(ERR.TAB_NOT_VISIBLE, 'Go back to this tab to continue.'),
      );
      assert.deepEqual(captured, []);
      assert.deepEqual(offscreen.sent, []);
    });

    it('refuses when no tab is active in the window', async () => {
      const { handlers, captured } = setup();
      fake.behavior.tabsQuery = async () => [];
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_CAPTURE_FRAME,
          { sessionId: SESSION_ID, meta: META },
          contentSender(),
        ),
        spoolError(ERR.TAB_NOT_VISIBLE),
      );
      assert.deepEqual(captured, []);
    });

    it('discards the image when the user left the tab during the capture', async () => {
      const { handlers, offscreen, captured } = setup();
      let queries = 0;
      fake.behavior.tabsQuery = async () => (queries++ === 0 ? activeTabs(7, 3) : activeTabs(8, 3));
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_CAPTURE_FRAME,
          { sessionId: SESSION_ID, meta: META },
          contentSender({ tabId: 7, windowId: 3 }),
        ),
        spoolError(ERR.TAB_NOT_VISIBLE, 'Go back to this tab to continue.'),
      );
      assert.deepEqual(captured, [3], 'the capture ran');
      assert.deepEqual(offscreen.sent, [], 'but the image was not stored');
    });

    it('works with a different tab id and window for each call', async () => {
      const { handlers, captured } = setup();
      fake.behavior.tabsQuery = async (q) => activeTabs(q.windowId === 3 ? 7 : 20, q.windowId);
      await call(
        handlers,
        MSG.PAGE_CAPTURE_FRAME,
        { sessionId: SESSION_ID, meta: META },
        contentSender({ tabId: 7, windowId: 3 }),
      );
      await call(
        handlers,
        MSG.PAGE_CAPTURE_FRAME,
        { sessionId: OTHER_SESSION_ID, meta: META },
        contentSender({ tabId: 20, windowId: 9 }),
      );
      assert.deepEqual(captured, [3, 9]);
    });

    it('passes on a capture error and does not store anything', async () => {
      const { handlers, offscreen } = setup({
        capture: async () => {
          throw new SpoolError(ERR.CAPTURE_FAILED, 'Could not capture the tab. Try again.');
        },
      });
      fake.behavior.tabsQuery = async () => activeTabs(7, 1);
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_CAPTURE_FRAME,
          { sessionId: SESSION_ID, meta: META },
          contentSender({ tabId: 7, windowId: 1 }),
        ),
        spoolError(ERR.CAPTURE_FAILED),
      );
      assert.deepEqual(offscreen.sent, []);
      assert.equal(fake.argsOf('tabs.query').length, 1, 'no second check after a failed capture');
    });

    it('fails with E_SESSION_NOT_FOUND, without capturing, if there is no document', async () => {
      const { handlers, offscreen, captured } = setup();
      offscreen.exists = false;
      fake.behavior.tabsQuery = async () => activeTabs(7, 1);
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_CAPTURE_FRAME,
          { sessionId: SESSION_ID, meta: META },
          contentSender({ tabId: 7, windowId: 1 }),
        ),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
      assert.deepEqual(captured, []);
      assert.deepEqual(offscreen.ensured, [], 'must not create a document');
    });

    it('passes on the error of the offscreen document', async () => {
      const { handlers, offscreen } = setup();
      fake.behavior.tabsQuery = async () => activeTabs(7, 1);
      offscreen.errors[MSG.OFF_ADD_FRAME] = new SpoolError(
        ERR.SESSION_TOO_LARGE,
        'The capture is too large.',
      );
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_CAPTURE_FRAME,
          { sessionId: SESSION_ID, meta: META },
          contentSender({ tabId: 7, windowId: 1 }),
        ),
        spoolError(ERR.SESSION_TOO_LARGE, 'The capture is too large.'),
      );
    });

    it('fails when the offscreen reply has no intake result', async () => {
      const { handlers, offscreen } = setup();
      fake.behavior.tabsQuery = async () => activeTabs(7, 1);
      offscreen.replies[MSG.OFF_ADD_FRAME] = { ok: true };
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_CAPTURE_FRAME,
          { sessionId: SESSION_ID, meta: META },
          contentSender({ tabId: 7, windowId: 1 }),
        ),
        spoolError(ERR.INTERNAL),
      );
    });

    it('refuses a sender without a tab before any chrome call', async () => {
      const { handlers, captured, order } = setup();
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_CAPTURE_FRAME,
          { sessionId: SESSION_ID, meta: META },
          extensionPageSender('src/result/result.html'),
        ),
        spoolError(ERR.FORBIDDEN_SENDER),
      );
      assert.deepEqual(captured, []);
      assert.deepEqual(order, []);
      assert.equal(fake.calls.length, 0);
    });
  });

  describe('page/capture-frame: the reply to the page', () => {
    const sender = contentSender({ tabId: 7, windowId: 1 });
    const send = (/** @type {ReturnType<typeof setup>['handlers']} */ handlers) =>
      call(handlers, MSG.PAGE_CAPTURE_FRAME, { sessionId: SESSION_ID, meta: META }, sender);

    beforeEach(() => {
      fake.behavior.tabsQuery = async () => activeTabs(7, 1);
    });

    it('has only index, sliceCount, totalHeightPx, tileCount and seam.status', async () => {
      const { handlers } = setup();
      const reply = await send(handlers);
      assert.deepEqual(Object.keys(reply), ['intake']);
      assert.deepEqual(Object.keys(reply.intake).sort(), [
        'index',
        'seam',
        'sliceCount',
        'tileCount',
        'totalHeightPx',
      ]);
      assert.deepEqual(Object.keys(reply.intake.seam), ['status']);
    });

    it('does not pass on the numbers that come from the pixels', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_ADD_FRAME] = {
        ok: true,
        intake: {
          ...INTAKE,
          widthPx: 1234,
          storedBytes: 987_654,
          seam: { status: 'corrected', shiftPx: -7, meanDiff: 2.5, extra: 'x' },
          extra: { more: 1 },
        },
      };
      const reply = await send(handlers);
      assert.deepEqual(reply, { intake: { ...PAGE_INTAKE, seam: { status: 'corrected' } } });
      const text = JSON.stringify(reply);
      for (const secret of ['1234', '987654', 'shiftPx', 'meanDiff', 'storedBytes', 'widthPx']) {
        assert.ok(!text.includes(secret), secret);
      }
    });

    it('keeps index -1 of a duplicate, and every seam status', async () => {
      for (const status of SEAM_STATUSES) {
        const { handlers, offscreen } = setup();
        offscreen.replies[MSG.OFF_ADD_FRAME] = {
          ok: true,
          intake: { ...INTAKE, index: status === 'duplicate' ? -1 : 3, seam: { status } },
        };
        const reply = await send(handlers);
        assert.equal(reply.intake.seam.status, status);
        assert.equal(reply.intake.index, status === 'duplicate' ? -1 : 3);
      }
    });

    it('fails with E_INTERNAL when the intake is missing or incomplete', async () => {
      const broken = [
        undefined,
        null,
        'text',
        5,
        [],
        {},
        { ...INTAKE, index: undefined },
        { ...INTAKE, index: '1' },
        { ...INTAKE, sliceCount: NaN },
        { ...INTAKE, totalHeightPx: Infinity },
        { ...INTAKE, tileCount: null },
        { ...INTAKE, seam: undefined },
        { ...INTAKE, seam: null },
        { ...INTAKE, seam: {} },
        { ...INTAKE, seam: { status: 5 } },
        { ...INTAKE, seam: { status: 'made-up' } },
        { ...INTAKE, seam: { status: 'toString' } },
        { ...INTAKE, seam: 'exact' },
      ];
      for (const intake of broken) {
        const { handlers, offscreen } = setup();
        offscreen.replies[MSG.OFF_ADD_FRAME] = { ok: true, intake };
        await assert.rejects(
          send(handlers),
          spoolError(ERR.INTERNAL, 'Something went wrong. Try again.'),
          JSON.stringify(intake),
        );
      }
    });
  });

  describe('page/capture-frame: a tab switch during the call', () => {
    const sender = contentSender({ tabId: 7, windowId: 3 });
    const NOT_VISIBLE = 'Go back to this tab to continue.';
    const frameFields = { sessionId: SESSION_ID, meta: META };
    /** Pretends that the user switched to a tab of a window. */
    const switchTo = (/** @type {number} */ tabId, windowId = 3) =>
      fake.events.tabActivated.dispatch({ tabId, windowId });

    beforeEach(() => {
      // Both checks of the tab say "active": only the activation events can show a switch.
      fake.behavior.tabsQuery = async () => activeTabs(7, 3);
    });

    it('refuses the frame when the user left the tab and came back in the capture', async () => {
      // The real race: the first check passes, the user presses Ctrl+Tab and Ctrl+Shift+Tab
      // while the capture waits for its slot, the second check passes. The image shows the
      // other tab.
      const { handlers, offscreen, captured } = setup({
        capture: async (windowId) => {
          captured.push(windowId);
          switchTo(8);
          switchTo(7);
          return PNG_DATA_URL;
        },
      });
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.TAB_NOT_VISIBLE, NOT_VISIBLE),
      );
      assert.deepEqual(captured, [3], 'the capture ran');
      assert.deepEqual(offscreen.sent, [], 'the image was not sent to the offscreen document');
    });

    it('refuses the frame for a single switch during the capture', async () => {
      const { handlers, offscreen } = setup({
        capture: async () => {
          switchTo(8);
          return PNG_DATA_URL;
        },
      });
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.TAB_NOT_VISIBLE, NOT_VISIBLE),
      );
      assert.deepEqual(offscreen.sent, []);
    });

    it('counts the activation of the sender tab itself', async () => {
      const { handlers, offscreen } = setup({
        capture: async () => {
          switchTo(7);
          return PNG_DATA_URL;
        },
      });
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.TAB_NOT_VISIBLE, NOT_VISIBLE),
      );
      assert.deepEqual(offscreen.sent, []);
    });

    it('refuses the frame for a switch while the capture waits for its slot', async () => {
      const gate = deferred();
      const { handlers, offscreen } = setup({
        capture: async () => {
          await gate.promise; // The queue waits for the rate limit.
          return PNG_DATA_URL;
        },
      });
      const pending = call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      const outcome = assert.rejects(pending, spoolError(ERR.TAB_NOT_VISIBLE, NOT_VISIBLE));
      await macrotask();
      switchTo(8);
      switchTo(7);
      gate.resolve();
      await outcome;
      assert.deepEqual(offscreen.sent, []);
    });

    it('does not capture when the user left the tab during the first check', async () => {
      const { handlers, offscreen, captured } = setup();
      let queries = 0;
      fake.behavior.tabsQuery = async () => {
        if (queries++ === 0) {
          switchTo(8);
          switchTo(7);
        }
        return activeTabs(7, 3);
      };
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.TAB_NOT_VISIBLE, NOT_VISIBLE),
      );
      assert.deepEqual(captured, [], 'no image of another tab is taken');
      assert.deepEqual(offscreen.sent, []);
      assert.equal(queries, 1, 'and no second check');
    });

    it('refuses the frame when the switch happens during the second check', async () => {
      const { handlers, offscreen } = setup();
      let queries = 0;
      fake.behavior.tabsQuery = async () => {
        if (queries++ === 1) switchTo(8);
        return activeTabs(7, 3);
      };
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.TAB_NOT_VISIBLE, NOT_VISIBLE),
      );
      assert.deepEqual(offscreen.sent, []);
    });

    it('gives the capture a check that it runs before every attempt, a retry included', async () => {
      /** @type {string[]} */
      const attempts = [];
      const { handlers, offscreen } = setup({
        capture: async (_windowId, options) => {
          // Like the queue: a first call that fails with a transient error, then a retry.
          await options?.beforeAttempt?.();
          attempts.push('first call');
          await options?.beforeAttempt?.();
          attempts.push('retry');
          return PNG_DATA_URL;
        },
      });
      const reply = await call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      assert.deepEqual(reply, { intake: PAGE_INTAKE });
      assert.deepEqual(attempts, ['first call', 'retry']);
      assert.equal(offscreen.sent.length, 1);
    });

    it('refuses a retry after the user switched tabs, even when the user came back', async () => {
      /** @type {string[]} */
      const attempts = [];
      const { handlers, offscreen } = setup({
        capture: async (_windowId, options) => {
          await options?.beforeAttempt?.();
          attempts.push('first call');
          switchTo(8); // The user leaves the tab while the retry waits ...
          switchTo(7); // ... and comes back before the retry starts.
          await options?.beforeAttempt?.();
          attempts.push('retry');
          return PNG_DATA_URL;
        },
      });
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.TAB_NOT_VISIBLE, NOT_VISIBLE),
      );
      assert.deepEqual(attempts, ['first call'], 'the retry did not run');
      assert.deepEqual(offscreen.sent, []);
    });

    it('refuses a retry when another tab is active at that moment', async () => {
      /** @type {string[]} */
      const attempts = [];
      const { handlers, offscreen } = setup({
        capture: async (_windowId, options) => {
          await options?.beforeAttempt?.();
          attempts.push('first call');
          fake.behavior.tabsQuery = async () => activeTabs(8, 3);
          await options?.beforeAttempt?.();
          attempts.push('retry');
          return PNG_DATA_URL;
        },
      });
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.TAB_NOT_VISIBLE, NOT_VISIBLE),
      );
      assert.deepEqual(attempts, ['first call']);
      assert.deepEqual(offscreen.sent, []);
    });

    it('stores the frame when nothing was activated', async () => {
      const { handlers, offscreen } = setup();
      const reply = await call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      assert.deepEqual(reply, { intake: PAGE_INTAKE });
      assert.equal(offscreen.sent.length, 1);
    });

    it('ignores a switch in another window', async () => {
      const { handlers, offscreen } = setup({
        capture: async () => {
          switchTo(30, 9);
          switchTo(31, 2);
          return PNG_DATA_URL;
        },
      });
      const reply = await call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      assert.deepEqual(reply, { intake: PAGE_INTAKE });
      assert.equal(offscreen.sent.length, 1);
    });

    it('registers the listener before the first check, removes it after the second', async () => {
      const { handlers } = setup({
        capture: async () => {
          assert.equal(fake.events.tabActivated.listeners.length, 1, 'during the capture');
          return PNG_DATA_URL;
        },
      });
      /** @type {number[]} */
      const during = [];
      fake.behavior.tabsQuery = async () => {
        during.push(fake.events.tabActivated.listeners.length);
        return activeTabs(7, 3);
      };
      assert.equal(fake.events.tabActivated.listeners.length, 0);
      await call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      assert.deepEqual(during, [1, 1], 'at the first and at the second check');
      assert.equal(fake.events.tabActivated.listeners.length, 0, 'removed after the call');
    });

    it('removes the listener on every way out', async () => {
      const failures = [
        {
          name: 'the first check says another tab',
          query: async () => activeTabs(8, 3),
          overrides: {},
        },
        {
          name: 'the capture fails',
          query: async () => activeTabs(7, 3),
          overrides: {
            capture: async () => {
              throw new SpoolError(ERR.CAPTURE_FAILED, 'Could not capture the tab. Try again.');
            },
          },
        },
        {
          name: 'the capture throws something else',
          query: async () => activeTabs(7, 3),
          overrides: {
            capture: async () => {
              throw new Error('boom');
            },
          },
        },
        {
          name: 'the query fails',
          query: async () => {
            throw new Error('tabs.query failed');
          },
          overrides: {},
        },
        {
          name: 'a switch happened',
          query: async () => activeTabs(7, 3),
          overrides: {
            capture: async () => {
              switchTo(8);
              return PNG_DATA_URL;
            },
          },
        },
      ];
      for (const { name, query, overrides } of failures) {
        const { handlers } = setup(overrides);
        fake.behavior.tabsQuery = query;
        await assert.rejects(call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender), name);
        assert.equal(fake.events.tabActivated.listeners.length, 0, name);
      }
      // The offscreen document refuses the frame: the listener is already gone by then.
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_ADD_FRAME] = new SpoolError(ERR.SESSION_TOO_LARGE, 'Too big.');
      fake.behavior.tabsQuery = async () => activeTabs(7, 3);
      await assert.rejects(call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender));
      assert.equal(fake.events.tabActivated.listeners.length, 0, 'offscreen error');
    });

    it('does not register a listener when there is no offscreen document', async () => {
      const { handlers, offscreen } = setup();
      offscreen.exists = false;
      let added = 0;
      const add = fake.events.tabActivated.addListener;
      fake.events.tabActivated.addListener = (fn) => {
        added += 1;
        add(fn);
      };
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
      assert.equal(added, 0);
    });

    it('does not carry a switch over to the next call', async () => {
      const { handlers, offscreen } = setup();
      const first = await call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      assert.deepEqual(first, { intake: PAGE_INTAKE });
      switchTo(8); // After the call: nobody listens, and it must not count later.
      switchTo(7);
      const second = await call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      assert.deepEqual(second, { intake: PAGE_INTAKE });
      assert.equal(offscreen.sent.length, 2);
    });

    it('allows the next frame after a refused one (the agent sends it again)', async () => {
      let first = true;
      const { handlers, offscreen } = setup({
        capture: async () => {
          if (first) {
            first = false;
            switchTo(8);
            switchTo(7);
          }
          return PNG_DATA_URL;
        },
      });
      await assert.rejects(
        call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender),
        spoolError(ERR.TAB_NOT_VISIBLE),
      );
      const reply = await call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      assert.deepEqual(reply, { intake: PAGE_INTAKE });
      assert.equal(offscreen.sent.length, 1, 'only the second image was sent');
    });

    it('keeps two calls in two windows apart', async () => {
      const gates = { w3: deferred(), w9: deferred() };
      /** @type {number[]} */
      const started = [];
      const { handlers, offscreen } = setup({
        capture: async (windowId) => {
          started.push(windowId);
          await (windowId === 3 ? gates.w3.promise : gates.w9.promise);
          return PNG_DATA_URL;
        },
      });
      fake.behavior.tabsQuery = async (q) => activeTabs(q.windowId === 3 ? 7 : 20, q.windowId);
      const inWindow3 = call(handlers, MSG.PAGE_CAPTURE_FRAME, frameFields, sender);
      const inWindow9 = call(
        handlers,
        MSG.PAGE_CAPTURE_FRAME,
        { sessionId: OTHER_SESSION_ID, meta: META },
        contentSender({ tabId: 20, windowId: 9 }),
      );
      const outcome3 = inWindow3.then((r) => r);
      const outcome9 = assert.rejects(inWindow9, spoolError(ERR.TAB_NOT_VISIBLE));
      await macrotask();
      assert.deepEqual(started.sort(), [3, 9]);
      assert.equal(fake.events.tabActivated.listeners.length, 2);
      switchTo(21, 9); // Only window 9 changed.
      gates.w3.resolve();
      gates.w9.resolve();
      assert.deepEqual(await outcome3, { intake: PAGE_INTAKE });
      await outcome9;
      assert.equal(offscreen.sent.length, 1);
      assert.equal(offscreen.sent[0]?.fields.sessionId, SESSION_ID);
      assert.equal(fake.events.tabActivated.listeners.length, 0);
    });

    it('answers a switch with E_TAB_NOT_VISIBLE through the router', async () => {
      const { handlers } = setup({
        capture: async () => {
          switchTo(8);
          switchTo(7);
          return PNG_DATA_URL;
        },
      });
      const router = createRouter(handlers, { runtimeId: EXTENSION_ID, origin: EXTENSION_ORIGIN });
      /** @type {unknown[]} */
      const responses = [];
      router(
        makeMessage(MSG.PAGE_CAPTURE_FRAME, frameFields),
        sender,
        (r) => void responses.push(r),
      );
      for (let i = 0; i < 4; i += 1) await macrotask();
      assert.deepEqual(responses, [
        { ok: false, error: { code: ERR.TAB_NOT_VISIBLE, message: NOT_VISIBLE } },
      ]);
    });
  });

  describe('page/finish', () => {
    it('finalizes the session in the offscreen document and returns the summary', async () => {
      const { handlers, offscreen, order } = setup();
      offscreen.replies[MSG.OFF_FINALIZE] = { ok: true, summary: SUMMARY };
      const reply = await call(
        handlers,
        MSG.PAGE_FINISH,
        { sessionId: SESSION_ID },
        contentSender({ tabId: 7, windowId: 3, index: 4 }),
      );
      assert.deepEqual(reply, { summary: SUMMARY });
      assert.deepEqual(order, ['exists', `send:${MSG.OFF_FINALIZE}`]);
      assert.deepEqual(offscreen.sent, [
        {
          type: MSG.OFF_FINALIZE,
          fields: {
            sessionId: SESSION_ID,
            tabId: 7, // from the sender tab
            saveTiles: true,
            saveFull: true,
            folderName: 'Spool',
          },
        },
      ]);
      // No result tab opens any more.
      assert.equal(fake.argsOf('tabs.create').length, 0);
    });

    it('passes the save settings of the user', async () => {
      const { handlers, offscreen } = setup({
        loadSettings: async () => ({
          ...DEFAULT_SETTINGS,
          saveTiles: false,
          saveFull: true,
          folderName: 'Shots',
        }),
      });
      offscreen.replies[MSG.OFF_FINALIZE] = { ok: true, summary: SUMMARY };
      await call(handlers, MSG.PAGE_FINISH, { sessionId: SESSION_ID }, contentSender());
      assert.deepEqual(offscreen.sent[0]?.fields, {
        sessionId: SESSION_ID,
        tabId: 7,
        saveTiles: false,
        saveFull: true,
        folderName: 'Shots',
      });
    });

    it('uses the default settings when the storage fails', async () => {
      const { handlers, offscreen } = setup({
        loadSettings: async () => {
          throw new Error('storage is gone');
        },
      });
      offscreen.replies[MSG.OFF_FINALIZE] = { ok: true, summary: SUMMARY };
      await call(handlers, MSG.PAGE_FINISH, { sessionId: SESSION_ID }, contentSender());
      assert.deepEqual(offscreen.sent[0]?.fields, {
        sessionId: SESSION_ID,
        tabId: 7,
        saveTiles: DEFAULT_SETTINGS.saveTiles,
        saveFull: DEFAULT_SETTINGS.saveFull,
        folderName: DEFAULT_SETTINGS.folderName,
      });
    });

    it('does nothing when there is no offscreen document', async () => {
      const { handlers, offscreen } = setup();
      offscreen.exists = false;
      await assert.rejects(
        call(handlers, MSG.PAGE_FINISH, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.SESSION_NOT_FOUND),
      );
      assert.deepEqual(offscreen.sent, []);
    });

    it('passes on the error of the offscreen document (so Done can be tried again)', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_FINALIZE] = new SpoolError(
        ERR.INTERNAL,
        'Could not build the images. Try again.',
      );
      await assert.rejects(
        call(handlers, MSG.PAGE_FINISH, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.INTERNAL, 'Could not build the images. Try again.'),
      );
    });

    it('gives the page a copy with the known fields only', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_FINALIZE] = {
        ok: true,
        summary: { ...SUMMARY, secret: 'x', save: { ...SUMMARY.save, handle: {} } },
      };
      const reply = await call(handlers, MSG.PAGE_FINISH, { sessionId: SESSION_ID }, contentSender());
      assert.deepEqual(reply, { summary: SUMMARY });
      assert.ok(!('secret' in reply.summary));
    });

    it('replies E_INTERNAL when the summary does not fit the contract', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_FINALIZE] = { ok: true, summary: { ...SUMMARY, tileCount: 'many' } };
      await assert.rejects(
        call(handlers, MSG.PAGE_FINISH, { sessionId: SESSION_ID }, contentSender()),
        spoolError(ERR.INTERNAL, 'Something went wrong. Try again.'),
      );
    });

    it('refuses a sender without a tab', async () => {
      const { handlers, offscreen } = setup();
      await assert.rejects(
        call(
          handlers,
          MSG.PAGE_FINISH,
          { sessionId: SESSION_ID },
          extensionPageSender('src/options/options.html'),
        ),
        spoolError(ERR.FORBIDDEN_SENDER),
      );
      assert.deepEqual(offscreen.sent, []);
    });
  });

  // page/cancel ends a session: the offscreen document drops an UNFINISHED session of the sender
  // tab.
  for (const { type, sender, offType, offFields } of [
    {
      type: MSG.PAGE_CANCEL,
      sender: contentSender({ tabId: 7, windowId: 3 }),
      offType: MSG.OFF_SESSION_DROP,
      offFields: { sessionId: SESSION_ID, tabId: 7 },
    },
  ]) {
    describe(type, () => {
      it('removes the session with the offscreen message of its kind', async () => {
        const { handlers, offscreen } = setup();
        const reply = await call(handlers, type, { sessionId: SESSION_ID }, sender);
        assert.deepEqual(reply, {});
        assert.deepEqual(offscreen.sent, [{ type: offType, fields: offFields }]);
      });

      it('does nothing, and creates no document, when there is no offscreen document', async () => {
        const { handlers, offscreen } = setup();
        offscreen.exists = false;
        const reply = await call(handlers, type, { sessionId: SESSION_ID }, sender);
        assert.deepEqual(reply, {});
        assert.deepEqual(offscreen.sent, []);
        assert.deepEqual(offscreen.ensured, []);
      });

      it('can be repeated: an unknown session is not an error', async () => {
        const { handlers, offscreen } = setup();
        offscreen.errors[offType] = new SpoolError(
          ERR.SESSION_NOT_FOUND,
          'Session not found.',
        );
        assert.deepEqual(await call(handlers, type, { sessionId: SESSION_ID }, sender), {});
      });

      it('passes on other errors', async () => {
        const { handlers, offscreen } = setup();
        offscreen.errors[offType] = new SpoolError(ERR.INTERNAL, 'broken');
        await assert.rejects(
          call(handlers, type, { sessionId: SESSION_ID }, sender),
          spoolError(ERR.INTERNAL, 'broken'),
        );
      });
    });
  }

  describe('page/cancel: the tab of the session', () => {
    it('sends the tab of the sender, never a tab from the message', async () => {
      const { handlers, offscreen } = setup();
      const handler = handlers[MSG.PAGE_CANCEL];
      assert.ok(handler);
      await handler(
        { ...makeMessage(MSG.PAGE_CANCEL, { sessionId: SESSION_ID }), tabId: 99 },
        contentSender({ tabId: 7, windowId: 3 }),
      );
      assert.deepEqual(offscreen.sent, [
        { type: MSG.OFF_SESSION_DROP, fields: { sessionId: SESSION_ID, tabId: 7 } },
      ]);
    });

    it('uses tab id 0', async () => {
      const { handlers, offscreen } = setup();
      await call(
        handlers,
        MSG.PAGE_CANCEL,
        { sessionId: SESSION_ID },
        contentSender({ tabId: 0, windowId: 1 }),
      );
      assert.deepEqual(offscreen.sent[0]?.fields, { sessionId: SESSION_ID, tabId: 0 });
    });

    it('refuses a sender without a usable tab, and sends nothing', async () => {
      const { handlers, offscreen, order } = setup();
      const senders = [
        extensionPageSender('src/result/result.html'),
        /** @type {any} */ ({ id: EXTENSION_ID, tab: {} }),
        /** @type {any} */ ({ id: EXTENSION_ID, tab: { id: -1, windowId: 1 } }),
        /** @type {any} */ ({ id: EXTENSION_ID, tab: { id: 1 } }),
      ];
      for (const sender of senders) {
        await assert.rejects(
          call(handlers, MSG.PAGE_CANCEL, { sessionId: SESSION_ID }, sender),
          spoolError(ERR.FORBIDDEN_SENDER),
        );
      }
      assert.deepEqual(offscreen.sent, []);
      assert.deepEqual(order, []);
    });

    it('replies ok when the offscreen document leaves the session alone (other tab)', async () => {
      // The document answers with the sessions that are left. The cancel of a page that does not
      // own the session changes nothing, and it is no error.
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_SESSION_DROP] = { ok: true, remaining: 2 };
      const reply = await call(
        handlers,
        MSG.PAGE_CANCEL,
        { sessionId: SESSION_ID },
        contentSender({ tabId: 8, windowId: 3 }),
      );
      assert.deepEqual(reply, {});
      assert.equal(offscreen.closed, 0);
    });
  });

  describe('page/cancel: closing an idle offscreen document', () => {
    /** @param {ReturnType<typeof createHandlers>} handlers */
    const cancel = (handlers) =>
      call(handlers, MSG.PAGE_CANCEL, { sessionId: SESSION_ID }, contentSender());

    it('runs closeIfIdle after the drop when no session is left', async () => {
      const { handlers, offscreen, order } = setup();
      offscreen.replies[MSG.OFF_SESSION_DROP] = { ok: true, remaining: 0 };
      const reply = await cancel(handlers);
      assert.deepEqual(reply, {});
      assert.deepEqual(order, ['exists', `send:${MSG.OFF_SESSION_DROP}`, 'closeIfIdle']);
    });

    it('does not run closeIfIdle while other sessions remain', async () => {
      const { handlers, offscreen } = setup();
      offscreen.replies[MSG.OFF_SESSION_DROP] = { ok: true, remaining: 2 };
      await cancel(handlers);
      assert.equal(offscreen.closed, 0);
    });

    it('does not run closeIfIdle when the reply has no usable remaining count', async () => {
      const { handlers, offscreen } = setup();
      const replies = [{ ok: true }, { ok: true, remaining: '0' }, { ok: true, remaining: null }];
      for (const reply of replies) {
        offscreen.replies[MSG.OFF_SESSION_DROP] = reply;
        await cancel(handlers);
      }
      assert.equal(offscreen.closed, 0);
    });

    it('replies ok for an unknown session and does not close anything', async () => {
      const { handlers, offscreen } = setup();
      offscreen.errors[MSG.OFF_SESSION_DROP] = new SpoolError(
        ERR.SESSION_NOT_FOUND,
        'Session not found.',
      );
      const reply = await cancel(handlers);
      assert.deepEqual(reply, {});
      assert.equal(offscreen.closed, 0);
    });

    it('replies ok and does nothing else when there is no offscreen document', async () => {
      const { handlers, offscreen, order } = setup();
      offscreen.exists = false;
      const reply = await cancel(handlers);
      assert.deepEqual(reply, {});
      assert.deepEqual(order, ['exists'], 'no drop, no close, no create');
      assert.deepEqual(offscreen.ensured, []);
    });

    it('still replies ok when closeIfIdle fails', async () => {
      const { handlers, offscreen } = setup();
      offscreen.closeIfIdle = async () => {
        throw new Error('close failed');
      };
      const reply = await cancel(handlers);
      assert.deepEqual(reply, {});
    });

    describe('with the real offscreen client', () => {
      const env = { runtimeId: EXTENSION_ID, origin: EXTENSION_ORIGIN };

      async function cancelThroughRouter() {
        const router = createRouter(createHandlers(), env);
        /** @type {unknown[]} */
        const responses = [];
        router(
          makeMessage(MSG.PAGE_CANCEL, { sessionId: SESSION_ID }),
          contentSender(),
          (r) => void responses.push(r),
        );
        for (let i = 0; i < 8; i += 1) await macrotask();
        return responses;
      }

      it('creates no document and sends nothing when none exists', async () => {
        const responses = await cancelThroughRouter();
        assert.deepEqual(responses, [{ ok: true }]);
        assert.equal(fake.argsOf('offscreen.createDocument').length, 0);
        assert.equal(fake.argsOf('runtime.sendMessage').length, 0);
      });

      it('drops the session, then closes the document when it is empty', async () => {
        fake.addOffscreenDocument();
        fake.behavior.sendMessage = async (message) =>
          message.type === MSG.OFF_SESSION_DROP
            ? { ok: true, remaining: 0 }
            : { ok: true, sessions: 0 };
        const responses = await cancelThroughRouter();
        assert.deepEqual(responses, [{ ok: true }]);
        assert.deepEqual(
          fake.argsOf('runtime.sendMessage').map((a) => /** @type {any} */ (a[0]).type),
          [MSG.OFF_SESSION_DROP, MSG.OFF_PING],
        );
        assert.equal(fake.state.closedDocuments, 1);
        assert.equal(fake.argsOf('offscreen.createDocument').length, 0);
      });

      it('keeps the document when a session is still open', async () => {
        fake.addOffscreenDocument();
        fake.behavior.sendMessage = async (message) =>
          message.type === MSG.OFF_SESSION_DROP
            ? { ok: true, remaining: 1 }
            : { ok: true, sessions: 1 };
        const responses = await cancelThroughRouter();
        assert.deepEqual(responses, [{ ok: true }]);
        assert.equal(fake.state.closedDocuments, 0);
        assert.deepEqual(
          fake.argsOf('runtime.sendMessage').map((a) => /** @type {any} */ (a[0]).type),
          [MSG.OFF_SESSION_DROP],
        );
      });

      it('sends the tab of the sender in the cancel, and nothing else of the page', async () => {
        fake.addOffscreenDocument();
        fake.behavior.sendMessage = async () => ({ ok: true, remaining: 1 });
        const router = createRouter(createHandlers(), env);
        router(
          makeMessage(MSG.PAGE_CANCEL, { sessionId: SESSION_ID }),
          contentSender({ tabId: 42, windowId: 5 }),
          () => undefined,
        );
        for (let i = 0; i < 8; i += 1) await macrotask();
        assert.deepEqual(fake.argsOf('runtime.sendMessage'), [
          [
            {
              v: 1,
              target: 'offscreen',
              type: MSG.OFF_SESSION_DROP,
              sessionId: SESSION_ID,
              tabId: 42,
            },
          ],
        ]);
      });

      it('refuses a cancel from a page that is not a content script', async () => {
        fake.addOffscreenDocument();
        const router = createRouter(createHandlers(), env);
        /** @type {any[]} */
        const responses = [];
        router(
          makeMessage(MSG.PAGE_CANCEL, { sessionId: SESSION_ID }),
          extensionPageSender('src/result/result.html#x'),
          (r) => void responses.push(r),
        );
        await macrotask();
        assert.equal(responses[0]?.ok, false);
        assert.equal(responses[0]?.error.code, ERR.FORBIDDEN_SENDER);
        assert.equal(fake.argsOf('runtime.sendMessage').length, 0);
      });
    });
  });

  describe('sw/offscreen-idle', () => {
    it('asks the client to close the document when idle', async () => {
      const { handlers, offscreen } = setup();
      const reply = await call(
        handlers,
        MSG.SW_OFFSCREEN_IDLE,
        {},
        extensionPageSender('src/offscreen/offscreen.html'),
      );
      assert.deepEqual(reply, {});
      assert.equal(offscreen.closed, 1);
    });
  });

  describe('handler table', () => {
    it('has exactly the handlers of the service worker', () => {
      const { handlers } = setup();
      assert.deepEqual(
        Object.keys(handlers).sort(),
        [
          MSG.PAGE_CANCEL,
          MSG.PAGE_CAPTURE_FRAME,
          MSG.PAGE_CLIPBOARD_FALLBACK,
          MSG.PAGE_FINISH,
          MSG.PAGE_GET_CLIPBOARD,
          MSG.PAGE_GET_TILE,
          MSG.PAGE_OPEN_OPTIONS,
          MSG.PAGE_OPEN_RESULT,
          MSG.PAGE_SESSION_OPEN,
          MSG.PAGE_SHELF_GET,
          MSG.PAGE_SHELF_INFO,
          MSG.PAGE_SHOW_IN_FOLDER,
          MSG.SW_DOWNLOAD,
          MSG.SW_OFFSCREEN_IDLE,
        ].sort(),
      );
    });
  });

  describe('through the router', () => {
    it('answers a capture-frame of a hidden tab with E_TAB_NOT_VISIBLE', async () => {
      const { handlers } = setup();
      fake.behavior.tabsQuery = async () => activeTabs(99, 1);
      const router = createRouter(handlers, { runtimeId: EXTENSION_ID, origin: EXTENSION_ORIGIN });
      /** @type {unknown[]} */
      const responses = [];
      const keep = router(
        makeMessage(MSG.PAGE_CAPTURE_FRAME, { sessionId: SESSION_ID, meta: META }),
        contentSender({ tabId: 7, windowId: 1 }),
        (r) => void responses.push(r),
      );
      assert.equal(keep, true);
      await macrotask();
      assert.deepEqual(responses, [
        {
          ok: false,
          error: { code: ERR.TAB_NOT_VISIBLE, message: 'Go back to this tab to continue.' },
        },
      ]);
    });

    it('answers a capture-frame with the intake result', async () => {
      const { handlers } = setup();
      fake.behavior.tabsQuery = async () => activeTabs(7, 1);
      const router = createRouter(handlers, { runtimeId: EXTENSION_ID, origin: EXTENSION_ORIGIN });
      /** @type {unknown[]} */
      const responses = [];
      router(
        makeMessage(MSG.PAGE_CAPTURE_FRAME, { sessionId: SESSION_ID, meta: META }),
        contentSender({ tabId: 7, windowId: 1 }),
        (r) => void responses.push(r),
      );
      await macrotask();
      assert.deepEqual(responses, [{ ok: true, intake: PAGE_INTAKE }]);
    });
  });
});

describe('dropTabSessions', () => {
  it('does nothing when there is no offscreen document', async () => {
    /** @type {string[]} */
    const order = [];
    const offscreen = makeOffscreen(order);
    offscreen.exists = false;
    await dropTabSessions(7, offscreen);
    assert.deepEqual(offscreen.sent, []);
    assert.deepEqual(offscreen.ensured, []);
  });

  it('asks the offscreen document to drop the unfinished sessions of the tab', async () => {
    /** @type {string[]} */
    const order = [];
    const offscreen = makeOffscreen(order);
    await dropTabSessions(7, offscreen);
    assert.deepEqual(offscreen.sent, [{ type: MSG.OFF_DROP_TAB, fields: { tabId: 7 } }]);
  });

  it('ignores tab ids that cannot belong to a session', async () => {
    /** @type {string[]} */
    const order = [];
    const offscreen = makeOffscreen(order);
    for (const id of [-1, 1.5, NaN, Infinity, '3', null, undefined]) {
      await dropTabSessions(/** @type {any} */ (id), offscreen);
    }
    assert.deepEqual(order, []);
  });

  it('never rejects', async () => {
    /** @type {string[]} */
    const order = [];
    const offscreen = makeOffscreen(order);
    offscreen.errors[MSG.OFF_DROP_TAB] = new Error('Receiving end does not exist.');
    await dropTabSessions(7, offscreen);
    const broken = {
      ...offscreen,
      offscreenExists: async () => {
        throw new Error('getContexts failed');
      },
    };
    await dropTabSessions(7, broken);
  });
});

describe('offscreen client', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  /**
   * A tiny offscreen document behind runtime.sendMessage: it counts sessions.
   * @param {{ onPing?: () => Promise<void> }} [opts]
   */
  function installOffscreenModel(opts = {}) {
    /** @type {{ sessions: number, received: any[] }} */
    const model = { sessions: 0, received: [] };
    fake.behavior.sendMessage = async (message) => {
      model.received.push(message);
      if (message.type === MSG.OFF_SESSION_OPEN) model.sessions += 1;
      if (message.type === MSG.OFF_SESSION_DROP) model.sessions = Math.max(0, model.sessions - 1);
      if (message.type === MSG.OFF_PING) {
        await opts.onPing?.();
        return { ok: true, sessions: model.sessions };
      }
      return { ok: true };
    };
    return model;
  }

  describe('fake self-check', () => {
    it('rejects a second createDocument while the first is pending', async () => {
      const params = { url: PATHS.offscreen, reasons: ['BLOBS'], justification: 'x' };
      const first = fake.chrome.offscreen.createDocument(params);
      const second = fake.chrome.offscreen.createDocument(params);
      await assert.rejects(second, /single offscreen document/);
      await first;
      assert.equal(fake.state.createdDocuments, 1);
    });
  });

  describe('ensureOffscreen', () => {
    it('creates the document with the documented parameters', async () => {
      await ensureOffscreen();
      assert.deepEqual(fake.argsOf('offscreen.createDocument'), [
        [
          {
            url: PATHS.offscreen,
            reasons: ['BLOBS'],
            justification:
              'Holds screenshot slices in memory during a capture, and the last finished capture afterwards.',
          },
        ],
      ]);
      assert.deepEqual(fake.argsOf('runtime.getContexts')[0], [
        { contextTypes: ['OFFSCREEN_DOCUMENT'] },
      ]);
    });

    it('does not create a second document when one exists', async () => {
      fake.addOffscreenDocument();
      await ensureOffscreen();
      await ensureOffscreen();
      assert.equal(fake.argsOf('offscreen.createDocument').length, 0);
    });

    it('never creates two documents under many concurrent calls', async () => {
      await Promise.all(Array.from({ length: 12 }, () => ensureOffscreen()));
      assert.equal(fake.state.createdDocuments, 1);
      assert.equal(fake.state.rejectedCreates, 0);
      assert.equal(fake.argsOf('offscreen.createDocument').length, 1);
    });

    it('never creates two documents when ensure calls come in waves', async () => {
      const first = Promise.all([ensureOffscreen(), ensureOffscreen()]);
      await macrotask();
      const second = Promise.all([ensureOffscreen(), ensureOffscreen()]);
      await Promise.all([first, second]);
      assert.equal(fake.argsOf('offscreen.createDocument').length, 1);
      assert.equal(fake.state.rejectedCreates, 0);
    });

    it('fails with a plain SpoolError when Chrome cannot create the document', async () => {
      fake.behavior.createDocument = async () => {
        throw new Error('Offscreen failure with internal detail');
      };
      await assert.rejects(ensureOffscreen(), (e) => {
        assert.ok(e instanceof SpoolError);
        assert.equal(e.code, ERR.INTERNAL);
        assert.doesNotMatch(e.message, /internal detail/);
        return true;
      });
    });

    it('is not stuck after a failure', async () => {
      let fail = true;
      fake.behavior.createDocument = async () => {
        if (fail) throw new Error('first try fails');
        await macrotask();
      };
      await assert.rejects(ensureOffscreen());
      fail = false;
      await ensureOffscreen();
      assert.equal(fake.state.createdDocuments, 1);
    });

    it('accepts a document that another caller created in the meantime', async () => {
      fake.behavior.createDocument = async () => {
        fake.addOffscreenDocument(); // The "other creator" wins.
        throw new Error('Only a single offscreen document may be created.');
      };
      await ensureOffscreen();
    });
  });

  describe('offscreenExists', () => {
    it('reports the state and never creates a document', async () => {
      assert.equal(await offscreenExists(), false);
      fake.addOffscreenDocument();
      assert.equal(await offscreenExists(), true);
      assert.equal(fake.argsOf('offscreen.createDocument').length, 0);
    });
  });

  describe('sendToOffscreen', () => {
    it('sends an enveloped message and returns the reply', async () => {
      fake.behavior.sendMessage = async () => ({ ok: true, remaining: 2 });
      const reply = await sendToOffscreen(MSG.OFF_SESSION_DROP, { sessionId: SESSION_ID });
      assert.deepEqual(reply, { ok: true, remaining: 2 });
      assert.deepEqual(fake.argsOf('runtime.sendMessage'), [
        [{ v: 1, target: 'offscreen', type: MSG.OFF_SESSION_DROP, sessionId: SESSION_ID }],
      ]);
    });

    it('works without fields', async () => {
      await sendToOffscreen(MSG.OFF_PING);
      assert.deepEqual(fake.argsOf('runtime.sendMessage'), [
        [{ v: 1, target: 'offscreen', type: MSG.OFF_PING }],
      ]);
    });

    it('does not create the document', async () => {
      await sendToOffscreen(MSG.OFF_PING);
      assert.equal(fake.argsOf('offscreen.createDocument').length, 0);
    });

    it('turns { ok: false } into a SpoolError with the same code and message', async () => {
      fake.behavior.sendMessage = async () => ({
        ok: false,
        error: { code: ERR.SESSION_NOT_FOUND, message: 'Session not found.' },
      });
      await assert.rejects(
        sendToOffscreen(MSG.OFF_SESSION_DROP, { sessionId: SESSION_ID }),
        spoolError(ERR.SESSION_NOT_FOUND, 'Session not found.'),
      );
    });

    it('maps unknown error codes and malformed errors to E_INTERNAL', async () => {
      const replies = [
        { ok: false, error: { code: 'E_MADE_UP', message: 'Made up.' } },
        { ok: false, error: { code: ERR.SESSION_TOO_LARGE } },
        { ok: false },
        { ok: false, error: 'text' },
      ];
      for (const reply of replies) {
        fake.behavior.sendMessage = async () => reply;
        await assert.rejects(sendToOffscreen(MSG.OFF_PING), (e) => {
          assert.ok(e instanceof SpoolError);
          assert.ok(e.message.length > 0);
          return true;
        });
      }
      fake.behavior.sendMessage = async () => replies[0];
      await assert.rejects(sendToOffscreen(MSG.OFF_PING), spoolError(ERR.INTERNAL, 'Made up.'));
      fake.behavior.sendMessage = async () => replies[1];
      await assert.rejects(
        sendToOffscreen(MSG.OFF_PING),
        spoolError(ERR.SESSION_TOO_LARGE, 'Something went wrong. Try again.'),
      );
    });

    it('fails with E_INTERNAL when nobody answers', async () => {
      for (const behavior of [
        async () => {
          throw new Error('Could not establish connection. Receiving end does not exist.');
        },
        async () => undefined,
        async () => null,
        async () => 'text',
        async () => ({}),
        async () => ({ ok: 'yes' }),
      ]) {
        fake.behavior.sendMessage = behavior;
        await assert.rejects(sendToOffscreen(MSG.OFF_PING), spoolError(ERR.INTERNAL));
      }
    });

    it('rejects an unknown message type', async () => {
      await assert.rejects(sendToOffscreen('offscreen/nope'), spoolError(ERR.BAD_MESSAGE));
    });
  });

  describe('ensureAndSend', () => {
    it('creates the document first, then sends', async () => {
      installOffscreenModel();
      const reply = await ensureAndSend(MSG.OFF_SESSION_OPEN, {
        sessionId: SESSION_ID,
        tabId: 7,
        title: 't',
        tileTier: 'high',
      });
      assert.equal(reply.ok, true);
      assert.deepEqual(
        fake.names().filter((n) => n === 'offscreen.createDocument' || n === 'runtime.sendMessage'),
        ['offscreen.createDocument', 'runtime.sendMessage'],
      );
    });

    it('creates one document for many concurrent session starts', async () => {
      const model = installOffscreenModel();
      await Promise.all(
        Array.from({ length: 5 }, () =>
          ensureAndSend(MSG.OFF_SESSION_OPEN, {
            sessionId: SESSION_ID,
            tabId: 7,
            title: 't',
            tileTier: 'high',
          }),
        ),
      );
      assert.equal(fake.state.createdDocuments, 1);
      assert.equal(fake.state.rejectedCreates, 0);
      assert.equal(model.sessions, 5);
    });

    it('does not send when the document cannot be created', async () => {
      fake.behavior.createDocument = async () => {
        throw new Error('no');
      };
      await assert.rejects(ensureAndSend(MSG.OFF_SESSION_OPEN, {}), spoolError(ERR.INTERNAL));
      assert.equal(fake.argsOf('runtime.sendMessage').length, 0);
    });
  });

  describe('closeIfIdle', () => {
    it('does nothing when there is no document', async () => {
      assert.equal(await closeIfIdle(), false);
      assert.equal(fake.argsOf('runtime.sendMessage').length, 0);
      assert.equal(fake.argsOf('offscreen.closeDocument').length, 0);
    });

    it('closes the document when it holds no session', async () => {
      fake.addOffscreenDocument();
      installOffscreenModel();
      assert.equal(await closeIfIdle(), true);
      assert.deepEqual(
        fake.names().filter((n) => n !== 'runtime.getContexts'),
        ['runtime.sendMessage', 'offscreen.closeDocument'],
        'ping, then close',
      );
      assert.equal(fake.state.closedDocuments, 1);
      assert.equal(await offscreenExists(), false);
    });

    it('does not close the document when a session is open', async () => {
      fake.addOffscreenDocument();
      const model = installOffscreenModel();
      model.sessions = 1;
      assert.equal(await closeIfIdle(), false);
      assert.equal(fake.argsOf('offscreen.closeDocument').length, 0);
      assert.equal(await offscreenExists(), true);
    });

    it('does not close the document when the ping reply is not a clean 0', async () => {
      fake.addOffscreenDocument();
      for (const reply of [{ ok: true, sessions: 3 }, { ok: true }, { ok: true, sessions: '0' }]) {
        fake.behavior.sendMessage = async () => reply;
        assert.equal(await closeIfIdle(), false);
      }
      assert.equal(fake.argsOf('offscreen.closeDocument').length, 0);
    });

    it('does not close and does not throw when the ping fails', async () => {
      fake.addOffscreenDocument();
      fake.behavior.sendMessage = async () => {
        throw new Error('Receiving end does not exist.');
      };
      assert.equal(await closeIfIdle(), false);
      assert.equal(fake.argsOf('offscreen.closeDocument').length, 0);
    });

    it('does not throw when closing fails', async () => {
      fake.addOffscreenDocument();
      installOffscreenModel();
      fake.behavior.closeDocument = async () => {
        throw new Error('close failed');
      };
      assert.equal(await closeIfIdle(), false);
    });

    it('closes once when called many times at once', async () => {
      fake.addOffscreenDocument();
      installOffscreenModel();
      const results = await Promise.all([closeIfIdle(), closeIfIdle(), closeIfIdle()]);
      assert.deepEqual(results.sort(), [false, false, true]);
      assert.equal(fake.state.closedDocuments, 1);
    });

    it('does not close the document between a pending session start and its message', async () => {
      // The document exists with 0 sessions. closeIfIdle starts first and its ping is slow.
      // A session start arrives meanwhile. The start must wait for the close and then create a
      // new document: it must never send into a document that is about to be closed.
      fake.addOffscreenDocument();
      const pingGate = deferred();
      const model = installOffscreenModel({ onPing: () => pingGate.promise });
      const idle = closeIfIdle();
      await macrotask();
      const start = ensureAndSend(MSG.OFF_SESSION_OPEN, {
        sessionId: SESSION_ID,
        tabId: 7,
        title: 't',
        tileTier: 'high',
      });
      await macrotask();
      assert.equal(fake.argsOf('offscreen.createDocument').length, 0, 'start waits for the lock');
      pingGate.resolve();
      assert.equal(await idle, true);
      await start;
      assert.deepEqual(
        fake.names().filter((n) => n !== 'runtime.getContexts'),
        [
          'runtime.sendMessage', // ping
          'offscreen.closeDocument',
          'offscreen.createDocument',
          'runtime.sendMessage', // session-open
        ],
      );
      assert.equal(model.sessions, 1);
      assert.equal(await offscreenExists(), true, 'the new session has a document');
    });

    it('sees the session of a start that came first and keeps the document', async () => {
      fake.addOffscreenDocument();
      const model = installOffscreenModel();
      const start = ensureAndSend(MSG.OFF_SESSION_OPEN, {
        sessionId: SESSION_ID,
        tabId: 7,
        title: 't',
        tileTier: 'high',
      });
      const idle = closeIfIdle();
      await start;
      assert.equal(await idle, false);
      assert.equal(model.sessions, 1);
      assert.equal(fake.argsOf('offscreen.closeDocument').length, 0);
    });
  });
});
