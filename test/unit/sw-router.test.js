// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { ERR, MSG, TARGET, SpoolError, makeMessage } from '../../src/shared/protocol.js';
import { createRouter } from '../../src/sw/router.js';
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  contentSender,
  deferred,
  installFakeChrome,
  macrotask,
} from '../helpers/fake-chrome.js';

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';
const ENV = { runtimeId: EXTENSION_ID, origin: EXTENSION_ORIGIN };

/** Message types that the service worker receives, with a valid message for each. */
const SW_MESSAGES = {
  [MSG.PAGE_SESSION_OPEN]: { sessionId: SESSION_ID, title: 'Title' },
  [MSG.PAGE_CAPTURE_FRAME]: {
    sessionId: SESSION_ID,
    meta: {
      direction: 'initial',
      viewport: { width: 1000, height: 800 },
      rect: { x: 0, y: 0, width: 500, height: 400 },
      contentY: 0,
    },
  },
  [MSG.PAGE_FINISH]: { sessionId: SESSION_ID },
  [MSG.PAGE_CANCEL]: { sessionId: SESSION_ID },
  [MSG.SW_OFFSCREEN_IDLE]: {},
};

/** @param {string} path @returns {chrome.runtime.MessageSender} */
function extensionPageSender(path) {
  return /** @type {any} */ ({ id: EXTENSION_ID, url: `${EXTENSION_ORIGIN}${path}` });
}

/** Sender that is allowed to send `type`. */
function senderFor(/** @type {string} */ type) {
  if (type === MSG.SW_OFFSCREEN_IDLE) return extensionPageSender('src/offscreen/offscreen.html');
  return contentSender();
}

/**
 * Records every sendResponse call.
 * @returns {{ responses: unknown[], send: (r?: any) => void }}
 */
function responder() {
  /** @type {unknown[]} */
  const responses = [];
  return { responses, send: (r) => void responses.push(r) };
}

describe('createRouter: messages that are not for the service worker', () => {
  it('ignores them: returns false, no reply, no handler call', () => {
    let called = 0;
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: () => {
          called += 1;
        },
      },
      ENV,
    );
    const r = responder();
    const offscreenMsg = makeMessage(MSG.OFF_PING);
    const ignored = [offscreenMsg, null, undefined, 'text', 5, [], { type: MSG.PAGE_FINISH }];
    for (const msg of ignored) {
      assert.equal(router(msg, contentSender(), r.send), false);
    }
    assert.deepEqual(r.responses, []);
    assert.equal(called, 0);
  });
});

describe('createRouter: rejected messages', () => {
  it('replies once with the routeCheck error and does not run the handler', () => {
    let called = 0;
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: () => {
          called += 1;
        },
      },
      ENV,
    );
    const good = makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID });
    const cases = [
      [{ ...good, v: 2 }, contentSender(), ERR.BAD_MESSAGE],
      [{ ...good, sessionId: 'nope' }, contentSender(), ERR.BAD_MESSAGE],
      [{ ...good, extra: 1 }, contentSender(), ERR.BAD_MESSAGE],
      [good, extensionPageSender('src/result/result.html'), ERR.FORBIDDEN_SENDER],
      [good, undefined, ERR.FORBIDDEN_SENDER],
      [good, { id: 'other-extension', tab: { id: 1 }, frameId: 0 }, ERR.FORBIDDEN_SENDER],
      [good, contentSender({ frameId: 2 }), ERR.FORBIDDEN_SENDER],
      [{ ...good, type: 'page/unknown' }, contentSender(), ERR.BAD_MESSAGE],
    ];
    for (const [msg, sender, code] of cases) {
      const r = responder();
      const keep = router(msg, /** @type {any} */ (sender), r.send);
      assert.equal(keep, false, 'a sync reply needs no open channel');
      assert.equal(r.responses.length, 1);
      assert.equal(/** @type {any} */ (r.responses[0]).ok, false);
      assert.equal(/** @type {any} */ (r.responses[0]).error.code, code);
    }
    assert.equal(called, 0);
  });

  it('replies BAD_MESSAGE when a valid type has no handler', () => {
    const router = createRouter({}, ENV);
    const r = responder();
    const msg = makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID });
    const keep = router(msg, contentSender(), r.send);
    assert.equal(keep, false);
    assert.equal(r.responses.length, 1);
    assert.equal(/** @type {any} */ (r.responses[0]).error.code, ERR.BAD_MESSAGE);
  });

  it('does not take handlers from the object prototype', () => {
    const router = createRouter({}, ENV);
    for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      const r = responder();
      router({ v: 1, target: TARGET.SW, type }, contentSender(), r.send);
      assert.equal(r.responses.length, 1);
      assert.equal(/** @type {any} */ (r.responses[0]).ok, false);
    }
  });
});

describe('createRouter: accepted messages', () => {
  it('runs the handler with the message and the sender, then replies { ok: true }', async () => {
    /** @type {unknown[][]} */
    const seen = [];
    const gate = deferred();
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: async (msg, sender) => {
          seen.push([msg, sender]);
          await gate.promise;
        },
      },
      ENV,
    );
    const msg = makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID });
    const sender = contentSender();
    const r = responder();
    assert.equal(router(msg, sender, r.send), true, 'the channel must stay open');
    await macrotask();
    assert.deepEqual(r.responses, [], 'no reply before the handler is done');
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.[0], msg);
    assert.equal(seen[0]?.[1], sender);
    gate.resolve();
    await macrotask();
    assert.deepEqual(r.responses, [{ ok: true }]);
  });

  it('merges plain object results into the reply', async () => {
    const router = createRouter({ [MSG.PAGE_FINISH]: () => ({ intake: { index: 2 } }) }, ENV);
    const r = responder();
    router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), r.send);
    await macrotask();
    assert.deepEqual(r.responses, [{ ok: true, intake: { index: 2 } }]);
  });

  it('keeps ok: true even when the result says otherwise', async () => {
    const router = createRouter({ [MSG.PAGE_FINISH]: () => ({ ok: false, x: 1 }) }, ENV);
    const r = responder();
    router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), r.send);
    await macrotask();
    assert.deepEqual(r.responses, [{ ok: true, x: 1 }]);
  });

  it('ignores results that are not plain objects', async () => {
    for (const result of [undefined, null, 'text', 7, [1, 2], true]) {
      const router = createRouter({ [MSG.PAGE_FINISH]: () => result }, ENV);
      const r = responder();
      router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), r.send);
      await macrotask();
      assert.deepEqual(r.responses, [{ ok: true }], `result ${String(result)}`);
    }
  });

  it('converts a SpoolError to an error reply and does not log it', async () => {
    /** @type {unknown[]} */
    const logged = [];
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: () => {
          throw new SpoolError(ERR.TAB_NOT_VISIBLE, 'Go back to this tab to continue.');
        },
      },
      { ...ENV, onError: (e) => void logged.push(e) },
    );
    const r = responder();
    assert.equal(
      router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), r.send),
      true,
    );
    await macrotask();
    assert.deepEqual(r.responses, [
      {
        ok: false,
        error: { code: ERR.TAB_NOT_VISIBLE, message: 'Go back to this tab to continue.' },
      },
    ]);
    assert.deepEqual(logged, []);
  });

  it('hides unexpected errors behind E_INTERNAL and logs them', async () => {
    /** @type {unknown[]} */
    const logged = [];
    const failure = new Error('secret detail from https://private.example');
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: async () => {
          throw failure;
        },
      },
      { ...ENV, onError: (e) => void logged.push(e) },
    );
    const r = responder();
    router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), r.send);
    await macrotask();
    assert.equal(r.responses.length, 1);
    const reply = /** @type {any} */ (r.responses[0]);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, ERR.INTERNAL);
    assert.doesNotMatch(JSON.stringify(reply), /secret|private/);
    assert.deepEqual(logged, [failure]);
  });

  it('replies once when the handler throws synchronously', async () => {
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: () => {
          throw new Error('sync failure');
        },
      },
      ENV,
    );
    const r = responder();
    assert.equal(
      router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), r.send),
      true,
    );
    await macrotask();
    assert.equal(r.responses.length, 1);
    assert.equal(/** @type {any} */ (r.responses[0]).error.code, ERR.INTERNAL);
  });

  it('handles handlers that reject with a value that is not an Error', async () => {
    for (const thrown of ['text', undefined, null, 5]) {
      const router = createRouter(
        { [MSG.PAGE_FINISH]: () => Promise.reject(thrown) },
        { ...ENV, onError: () => {} },
      );
      const r = responder();
      router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), r.send);
      await macrotask();
      assert.equal(r.responses.length, 1);
      assert.equal(/** @type {any} */ (r.responses[0]).error.code, ERR.INTERNAL);
    }
  });

  it('still replies once when the logger throws', async () => {
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: () => {
          throw new Error('x');
        },
      },
      {
        ...ENV,
        onError: () => {
          throw new Error('logger failed');
        },
      },
    );
    const r = responder();
    router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), r.send);
    await macrotask();
    assert.equal(r.responses.length, 1);
  });

  it('does not produce an unhandled rejection when sendResponse throws', async () => {
    /** @type {unknown[]} */
    const unhandled = [];
    /** @param {unknown} reason */
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let attempts = 0;
      const router = createRouter({ [MSG.PAGE_FINISH]: () => ({}) }, ENV);
      router(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), contentSender(), () => {
        attempts += 1;
        throw new Error('The message port closed before a response was received.');
      });
      await macrotask();
      await macrotask();
      assert.equal(attempts, 1, 'must not retry the reply');
      assert.deepEqual(unhandled, []);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('sends the reply of each message to its own sendResponse', async () => {
    const gates = [deferred(), deferred()];
    let n = 0;
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: async () => {
          const i = n++;
          await gates[i]?.promise;
          return { i };
        },
      },
      ENV,
    );
    const a = responder();
    const b = responder();
    const msg = makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID });
    router(msg, contentSender({ tabId: 1 }), a.send);
    router(msg, contentSender({ tabId: 2 }), b.send);
    await macrotask();
    gates[1]?.resolve(); // The second handler finishes first.
    await macrotask();
    assert.deepEqual(a.responses, []);
    assert.deepEqual(b.responses, [{ ok: true, i: 1 }]);
    gates[0]?.resolve();
    await macrotask();
    assert.deepEqual(a.responses, [{ ok: true, i: 0 }]);
    assert.equal(b.responses.length, 1);
  });

  it('replies exactly once for every message type of the service worker', async () => {
    /** @type {Record<string, (msg: any, sender: any) => unknown>} */
    const handlers = {};
    for (const type of Object.keys(SW_MESSAGES)) handlers[type] = () => ({ handled: type });
    const router = createRouter(handlers, ENV);
    for (const [type, fields] of Object.entries(SW_MESSAGES)) {
      const r = responder();
      const keep = router(makeMessage(type, fields), senderFor(type), r.send);
      assert.equal(keep, true, type);
      await macrotask();
      assert.deepEqual(r.responses, [{ ok: true, handled: type }], type);
    }
  });
});

describe('service worker entry point', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  let importCount = 0;

  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  /** Imports a fresh copy of the entry module while the fake is installed. */
  async function loadEntry() {
    importCount += 1;
    await import(`../../src/sw/service-worker.js?case=${importCount}`);
  }

  async function flush() {
    for (let i = 0; i < 6; i += 1) await macrotask();
  }

  it('registers all listeners during module evaluation and calls no chrome API', async () => {
    await loadEntry();
    assert.equal(fake.events.actionClicked.listeners.length, 1);
    assert.equal(fake.events.command.listeners.length, 1);
    assert.equal(fake.events.message.listeners.length, 1);
    assert.equal(fake.events.tabRemoved.listeners.length, 1);
    assert.equal(fake.events.tabUpdated.listeners.length, 0);
    assert.equal(fake.events.installed.listeners.length, 1);
    assert.deepEqual(fake.calls, [], 'start-up must not run async chrome calls');
  });

  it('routes runtime messages: ignores other targets, answers its own', async () => {
    await loadEntry();
    const [listener] = fake.events.message.listeners;
    assert.ok(listener);
    const ignored = responder();
    assert.equal(listener(makeMessage(MSG.OFF_PING), contentSender(), ignored.send), false);
    assert.deepEqual(ignored.responses, []);

    const r = responder();
    const msg = makeMessage(MSG.PAGE_CANCEL, { sessionId: SESSION_ID });
    assert.equal(listener(msg, contentSender(), r.send), true);
    await flush();
    assert.deepEqual(r.responses, [{ ok: true }]); // No offscreen document: nothing to drop.
    assert.equal(fake.argsOf('offscreen.createDocument').length, 0);
  });

  it('refuses messages from a web page that is not a content script of the extension', async () => {
    await loadEntry();
    const [listener] = fake.events.message.listeners;
    assert.ok(listener);
    const r = responder();
    const foreign = /** @type {any} */ ({
      url: 'https://evil.example/',
      tab: { id: 1 },
      frameId: 0,
    });
    listener(makeMessage(MSG.PAGE_CANCEL, { sessionId: SESSION_ID }), foreign, r.send);
    await flush();
    assert.equal(/** @type {any} */ (r.responses[0]).error.code, ERR.FORBIDDEN_SENDER);
  });

  it('a toolbar click on a restricted page shows the badge', async () => {
    mock.timers.enable({ apis: ['setTimeout'] }); // The badge clear timer must not keep Node alive.
    try {
      await loadEntry();
      fake.events.actionClicked.dispatch({ id: 4, url: 'chrome://extensions/' });
      await flush();
      assert.deepEqual(fake.argsOf('action.setBadgeText')[0], [{ tabId: 4, text: '!' }]);
      mock.timers.tick(4000);
      await flush();
      assert.deepEqual(fake.argsOf('action.setBadgeText')[1], [{ tabId: 4, text: '' }]);
    } finally {
      mock.timers.reset();
    }
  });

  it('ignores commands other than start-capture', async () => {
    await loadEntry();
    fake.events.command.dispatch('something-else', { id: 4, url: 'chrome://extensions/' });
    await flush();
    assert.deepEqual(fake.calls, []);
  });

  it('start-capture command starts the capture of the given tab', async () => {
    await loadEntry();
    fake.events.command.dispatch('start-capture', { id: 4, url: 'https://example.com/' });
    await flush();
    assert.ok(fake.argsOf('scripting.executeScript').length >= 1);
  });

  describe('tab events', () => {
    it('onRemoved drops the tab when an offscreen document exists', async () => {
      await loadEntry();
      fake.addOffscreenDocument();
      fake.events.tabRemoved.dispatch(12, {});
      await flush();
      assert.deepEqual(fake.argsOf('runtime.sendMessage'), [
        [{ v: 1, target: 'offscreen', type: MSG.OFF_DROP_TAB, tabId: 12 }],
      ]);
    });

    it('has no onUpdated listener: a page load does not wake the worker', async () => {
      await loadEntry();
      fake.addOffscreenDocument();
      assert.equal(fake.events.tabUpdated.listeners.length, 0);
      fake.events.tabUpdated.dispatch(12, { status: 'loading' }, {});
      await flush();
      assert.deepEqual(fake.calls.filter((c) => c.api !== 'runtime.getContexts'), []);
    });

    it('never creates an offscreen document just to drop a tab', async () => {
      await loadEntry();
      fake.events.tabRemoved.dispatch(12, {});
      await flush();
      assert.equal(fake.argsOf('offscreen.createDocument').length, 0);
      assert.equal(fake.argsOf('runtime.sendMessage').length, 0);
      assert.equal(fake.state.createdDocuments, 0);
    });

    it('does not throw or reject when the offscreen document does not answer', async () => {
      await loadEntry();
      fake.addOffscreenDocument();
      fake.behavior.sendMessage = async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      };
      /** @type {unknown[]} */
      const unhandled = [];
      /** @param {unknown} reason */
      const onUnhandled = (reason) => unhandled.push(reason);
      process.on('unhandledRejection', onUnhandled);
      try {
        fake.events.tabRemoved.dispatch(12, {});
        await flush();
        assert.deepEqual(unhandled, []);
      } finally {
        process.off('unhandledRejection', onUnhandled);
      }
    });
  });
});
