// @ts-check
/**
 * The message handler of the offscreen document (docs/contracts.md 7.4): the rules for who gets
 * which output, with the real last capture and shelf tokens, and fakes for the store and the
 * finalizer.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createOffscreenHandler } from '../../src/offscreen/handlers.js';
import { createLastCapture } from '../../src/offscreen/last-capture.js';
import { createShelfTokens } from '../../src/offscreen/shelf-tokens.js';
import { ERR, MSG, SpoolError } from '../../src/shared/protocol.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN = '0c9d6a52-7b1e-4f3a-9a40-2d8e5b7c1f66';
const TOKEN_B = '9a7e1d34-2c58-4e0b-8f63-1b4d7a9c2e05';
const TAB = 7;

/** @param {unknown} e @param {string} code @param {string} [message] */
function isSpoolError(e, code, message) {
  assert.ok(e instanceof SpoolError, `expected SpoolError, got ${String(e)}`);
  assert.equal(e.code, code);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
}

function setup() {
  /** @type {any[]} */
  const storeCalls = [];
  const store = /** @type {any} */ (
    new Proxy(
      {
        ping: () => ({ sessions: 2 }),
        dropTab: (/** @type {number} */ tabId) => {
          storeCalls.push(['dropTab', tabId]);
          return { remaining: 1 };
        },
      },
      {
        get(target, prop) {
          if (prop in target) return /** @type {any} */ (target)[prop];
          return (/** @type {unknown[]} */ ...args) => {
            storeCalls.push([String(prop), ...args]);
            return { remaining: 0 };
          };
        },
      },
    )
  );
  const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
  const tokens = createShelfTokens();
  /** @type {any[]} */
  const finalized = [];
  const finalizer = /** @type {any} */ ({
    async finalize(/** @type {any} */ request) {
      finalized.push(request);
      return { sessionId: request.sessionId, marker: 'summary' };
    },
  });
  /** @param {Blob} b */
  const toBase64 = async (b) => `b64:${b.size}`;
  const handle = createOffscreenHandler({ store, last, tokens, finalizer, blobToBase64: toBase64 });
  return { handle, last, tokens, finalized, storeCalls };
}

/** @param {ReturnType<typeof setup>} s @param {string} sessionId @param {number} tabId */
function keep(s, sessionId = SESSION, tabId = TAB) {
  s.last.set({
    sessionId,
    tabId,
    summary: /** @type {any} */ ({ sessionId, marker: 'last' }),
    tiles: [new Blob([new Uint8Array(10)]), new Blob([new Uint8Array(20)])],
    full: new Blob([new Uint8Array(100)]),
  });
}

describe('offscreen handler: finalize', () => {
  it('finalizes with the fields of the message', async () => {
    const s = setup();
    const reply = await s.handle(MSG.OFF_FINALIZE, {
      sessionId: SESSION,
      tabId: TAB,
      saveTiles: false,
      saveFull: true,
      folderName: 'Shots',
    });
    assert.deepEqual(reply, { summary: { sessionId: SESSION, marker: 'summary' } });
    assert.deepEqual(s.finalized, [
      { sessionId: SESSION, tabId: TAB, saveTiles: false, saveFull: true, folderName: 'Shots' },
    ]);
  });
});

describe('offscreen handler: session requests need the tab of the session', () => {
  it('output-info answers for the right session and tab', async () => {
    const s = setup();
    keep(s);
    assert.deepEqual(await s.handle(MSG.OFF_OUTPUT_INFO, { sessionId: SESSION, tabId: TAB }), {
      summary: { sessionId: SESSION, marker: 'last' },
    });
  });

  it('get-output returns the full image, and a tile by index', async () => {
    const s = setup();
    keep(s);
    assert.deepEqual(
      await s.handle(MSG.OFF_GET_OUTPUT, { sessionId: SESSION, tabId: TAB, item: 'full' }),
      { pngBase64: 'b64:100' },
    );
    assert.deepEqual(
      await s.handle(MSG.OFF_GET_OUTPUT, { sessionId: SESSION, tabId: TAB, item: 1 }),
      { pngBase64: 'b64:20' },
    );
  });

  it('refuses another tab, another session and an empty document with E_SESSION_NOT_FOUND', async () => {
    const s = setup();
    for (const type of [MSG.OFF_OUTPUT_INFO, MSG.OFF_GET_OUTPUT]) {
      const fields = { item: 'full' };
      await assert.rejects(s.handle(type, { sessionId: SESSION, tabId: TAB, ...fields }), (e) =>
        isSpoolError(e, ERR.SESSION_NOT_FOUND),
      );
    }
    keep(s);
    for (const [sessionId, tabId] of /** @type {const} */ ([
      [SESSION, TAB + 1],
      [OTHER, TAB],
    ])) {
      for (const type of [MSG.OFF_OUTPUT_INFO, MSG.OFF_GET_OUTPUT]) {
        await assert.rejects(s.handle(type, { sessionId, tabId, item: 'full' }), (e) =>
          isSpoolError(e, ERR.SESSION_NOT_FOUND),
        );
      }
    }
  });

  it('refuses a tile that does not exist with E_BAD_MESSAGE', async () => {
    const s = setup();
    keep(s);
    await assert.rejects(
      s.handle(MSG.OFF_GET_OUTPUT, { sessionId: SESSION, tabId: TAB, item: 2 }),
      (e) => isSpoolError(e, ERR.BAD_MESSAGE, 'Unknown part.'),
    );
  });

  it('refuses an image over the limit with E_SESSION_TOO_LARGE', async () => {
    const s = setup();
    const small = createOffscreenHandler({
      store: /** @type {any} */ ({}),
      last: s.last,
      tokens: s.tokens,
      finalizer: /** @type {any} */ ({}),
      maxTransferBytes: 50,
      blobToBase64: async (b) => `b64:${b.size}`,
    });
    keep(s);
    await assert.rejects(
      small(MSG.OFF_GET_OUTPUT, { sessionId: SESSION, tabId: TAB, item: 'full' }),
      (e) => isSpoolError(e, ERR.SESSION_TOO_LARGE),
    );
    assert.deepEqual(await small(MSG.OFF_GET_OUTPUT, { sessionId: SESSION, tabId: TAB, item: 1 }), {
      pngBase64: 'b64:20',
    });
  });
});

describe('offscreen handler: the result page reads by session ID', () => {
  it('last-info and last-get answer for the session of the last capture, for any tab', async () => {
    const s = setup();
    keep(s, SESSION, 99);
    assert.deepEqual(await s.handle(MSG.OFF_LAST_INFO, { sessionId: SESSION }), {
      summary: { sessionId: SESSION, marker: 'last' },
    });
    assert.deepEqual(await s.handle(MSG.OFF_LAST_GET, { sessionId: SESSION, item: 'full' }), {
      pngBase64: 'b64:100',
    });
  });

  it('reading does not drop the capture', async () => {
    const s = setup();
    keep(s);
    await s.handle(MSG.OFF_LAST_INFO, { sessionId: SESSION });
    await s.handle(MSG.OFF_LAST_GET, { sessionId: SESSION, item: 0 });
    await s.handle(MSG.OFF_LAST_GET, { sessionId: SESSION, item: 0 });
    assert.equal(s.last.has(), true);
    assert.deepEqual(s.storeCalls, [], 'and releases no session');
  });

  it('refuses another session with E_SESSION_NOT_FOUND', async () => {
    const s = setup();
    keep(s);
    await assert.rejects(s.handle(MSG.OFF_LAST_INFO, { sessionId: OTHER }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
    await assert.rejects(s.handle(MSG.OFF_LAST_GET, { sessionId: OTHER, item: 'full' }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
  });
});

describe('offscreen handler: the shelf', () => {
  it('grants a token for a tab and says whether there is a capture', async () => {
    const s = setup();
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 }), {
      hasCapture: false,
    });
    keep(s);
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN_B, tabId: 4 }), {
      hasCapture: true,
    });
  });

  it('shelf-info gives the last capture of any session to the tab of the token', async () => {
    const s = setup();
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 3 }), { summary: null });
    keep(s, SESSION, 99); // finished in another tab: the shelf of tab 3 shows it
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 3 }), {
      summary: { sessionId: SESSION, marker: 'last' },
    });
  });

  it('shelf-get returns a tile or the full image', async () => {
    const s = setup();
    keep(s);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 'full' }), {
      pngBase64: 'b64:100',
    });
    assert.deepEqual(await s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), {
      pngBase64: 'b64:10',
    });
  });

  it('shelf-get with no capture says that there is nothing to insert', async () => {
    const s = setup();
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND, 'Nothing to insert yet. Press Alt+Shift+S to spool a page.'),
    );
  });

  it('refuses a token of another tab with E_FORBIDDEN_SENDER, for info and for get', async () => {
    const s = setup();
    keep(s);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    await assert.rejects(s.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 4 }), (e) =>
      isSpoolError(e, ERR.FORBIDDEN_SENDER),
    );
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 4, item: 0 }), (e) =>
      isSpoolError(e, ERR.FORBIDDEN_SENDER),
    );
  });

  it('refuses an unknown token', async () => {
    const s = setup();
    keep(s);
    await assert.rejects(s.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 3 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
    await assert.rejects(s.handle(MSG.OFF_SHELF_GET, { token: TOKEN, tabId: 3, item: 0 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
  });

  it('a session ID is not a shelf token (the shelf does not open the session API)', async () => {
    const s = setup();
    keep(s);
    await assert.rejects(s.handle(MSG.OFF_SHELF_INFO, { token: SESSION, tabId: TAB }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
  });

  it('a closed tab ends its shelf (drop-tab revokes the tokens)', async () => {
    const s = setup();
    keep(s);
    await s.handle(MSG.OFF_SHELF_GRANT, { token: TOKEN, tabId: 3 });
    const reply = await s.handle(MSG.OFF_DROP_TAB, { tabId: 3 });
    assert.deepEqual(reply, { remaining: 1 });
    assert.deepEqual(s.storeCalls, [['dropTab', 3]]);
    await assert.rejects(s.handle(MSG.OFF_SHELF_INFO, { token: TOKEN, tabId: 3 }), (e) =>
      isSpoolError(e, ERR.SESSION_NOT_FOUND),
    );
  });

  it('drop-tab keeps the last capture (finished work waits for its TTL)', async () => {
    const s = setup();
    keep(s, SESSION, 3);
    await s.handle(MSG.OFF_DROP_TAB, { tabId: 3 });
    assert.equal(s.last.has(), true);
  });
});

describe('offscreen handler: ping and the older messages', () => {
  it('ping tells the sessions and whether the last capture is kept', async () => {
    const s = setup();
    assert.deepEqual(await s.handle(MSG.OFF_PING, {}), { sessions: 2, lastCapture: false });
    keep(s);
    assert.deepEqual(await s.handle(MSG.OFF_PING, {}), { sessions: 2, lastCapture: true });
  });

  it('passes the session messages to the store', async () => {
    const s = setup();
    await s.handle(MSG.OFF_SESSION_OPEN, { sessionId: SESSION, tabId: TAB, title: 't', tileTier: 'high' });
    await s.handle(MSG.OFF_SESSION_DROP, { sessionId: SESSION, tabId: TAB });
    assert.deepEqual(
      s.storeCalls.map((c) => c[0]),
      ['open', 'drop'],
    );
  });

  it('refuses an unknown type', async () => {
    const s = setup();
    await assert.rejects(s.handle('offscreen/nope', {}), (e) => isSpoolError(e, ERR.BAD_MESSAGE));
  });
});
