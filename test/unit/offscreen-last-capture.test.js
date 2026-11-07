// @ts-check
/**
 * The last finished capture and the shelf tokens (docs/contracts.md 7.6 and 7.8): lifetime, memory
 * and the tab rules.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createLastCapture, pickOutput } from '../../src/offscreen/last-capture.js';
import { createShelfTokens } from '../../src/offscreen/shelf-tokens.js';
import {
  LAST_CAPTURE_TTL_MS,
  MAX_SHELF_TOKENS,
  MAX_TRANSFER_BYTES,
  SHELF_TOKEN_TTL_MS,
} from '../../src/shared/constants.js';
import { ERR, SpoolError } from '../../src/shared/protocol.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const TOKEN_1 = '0c9d6a52-7b1e-4f3a-9a40-2d8e5b7c1f66';
const TOKEN_2 = '9a7e1d34-2c58-4e0b-8f63-1b4d7a9c2e05';

/** @param {unknown} e @param {string} code @param {string} [message] */
function isSpoolError(e, code, message) {
  assert.ok(e instanceof SpoolError, `expected SpoolError, got ${String(e)}`);
  assert.equal(e.code, code);
  if (message !== undefined) assert.equal(e.message, message);
  return true;
}

/** Fake timers on a virtual clock. */
function fakeTimers() {
  /** @type {{ fn: () => void, ms: number, cancelled: boolean, fired: boolean }[]} */
  const list = [];
  return {
    list,
    set(/** @type {() => void} */ fn, /** @type {number} */ ms) {
      const timer = { fn, ms, cancelled: false, fired: false };
      list.push(timer);
      return timer;
    },
    clear(/** @type {any} */ handle) {
      handle.cancelled = true;
    },
    fire(/** @type {number} */ index) {
      const timer = list[index];
      assert.ok(timer);
      timer.fired = true;
      timer.fn();
    },
  };
}

/** @param {string} sessionId @param {number} tabId @param {number[]} [tileSizes] @param {number | null} [fullSize] */
function entry(sessionId, tabId, tileSizes = [10, 20], fullSize = 100) {
  return {
    sessionId,
    tabId,
    summary: /** @type {any} */ ({ sessionId }),
    tiles: tileSizes.map((n) => new Blob([new Uint8Array(n)])),
    full: fullSize === null ? null : new Blob([new Uint8Array(fullSize)]),
  };
}

describe('createLastCapture', () => {
  it('starts empty', () => {
    const last = createLastCapture();
    assert.equal(last.has(), false);
    assert.equal(last.latest(), null);
    assert.equal(last.bytes(), 0);
    assert.throws(() => last.require(SESSION), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
  });

  it('keeps one capture and finds it by session and tab', () => {
    const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
    const e = entry(SESSION, 7);
    last.set(e);
    assert.equal(last.has(), true);
    assert.equal(last.latest(), e);
    assert.equal(last.require(SESSION), e, 'no tab asked: the result page');
    assert.equal(last.require(SESSION, 7), e);
  });

  it('does not answer for another tab or another session (the same error as for none)', () => {
    const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
    last.set(entry(SESSION, 7));
    for (const [sessionId, tabId] of /** @type {const} */ ([
      [SESSION, 8],
      [OTHER, 7],
      [OTHER, 8],
    ])) {
      assert.throws(
        () => last.require(sessionId, tabId),
        (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND, 'This capture has ended. Start a new capture.'),
      );
    }
  });

  it('a new capture replaces the old one', () => {
    const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
    last.set(entry(SESSION, 7));
    last.set(entry(OTHER, 8));
    assert.equal(last.latest()?.sessionId, OTHER);
    assert.throws(() => last.require(SESSION), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
  });

  it('ends after LAST_CAPTURE_TTL_MS (60 minutes), counted from set', () => {
    assert.equal(LAST_CAPTURE_TTL_MS, 60 * 60 * 1000);
    const timers = fakeTimers();
    const last = createLastCapture({ setTimer: timers.set, clearTimer: timers.clear });
    last.set(entry(SESSION, 7));
    assert.equal(timers.list.length, 1);
    assert.equal(timers.list[0]?.ms, LAST_CAPTURE_TTL_MS);
    // Reading does not start the time again.
    last.require(SESSION, 7);
    last.latest();
    assert.equal(timers.list.length, 1);
    timers.fire(0);
    assert.equal(last.has(), false);
    assert.equal(last.bytes(), 0);
  });

  it('a new capture restarts the time, and the old timer does nothing when it fires late', () => {
    const timers = fakeTimers();
    const last = createLastCapture({ setTimer: timers.set, clearTimer: timers.clear });
    last.set(entry(SESSION, 7));
    last.set(entry(OTHER, 8));
    assert.equal(timers.list[0]?.cancelled, true);
    timers.fire(0); // The stale timer fires anyway.
    assert.equal(last.latest()?.sessionId, OTHER);
    timers.fire(1);
    assert.equal(last.has(), false);
  });

  it('clear ends the capture and its timer', () => {
    const timers = fakeTimers();
    const last = createLastCapture({ setTimer: timers.set, clearTimer: timers.clear });
    last.set(entry(SESSION, 7));
    last.clear();
    assert.equal(last.has(), false);
    assert.equal(timers.list[0]?.cancelled, true);
    last.clear(); // Safe to repeat.
  });

  it('calls onChange after set, clear and expiry, but not for a clear of nothing', () => {
    const timers = fakeTimers();
    let changes = 0;
    const last = createLastCapture({
      setTimer: timers.set,
      clearTimer: timers.clear,
      onChange: () => {
        changes += 1;
      },
    });
    last.clear();
    assert.equal(changes, 0);
    last.set(entry(SESSION, 7));
    assert.equal(changes, 1);
    last.clear();
    assert.equal(changes, 2);
    last.set(entry(SESSION, 7));
    timers.fire(1);
    assert.equal(changes, 4);
  });

  it('ignores a failing onChange', () => {
    const last = createLastCapture({
      setTimer: () => 0,
      clearTimer: () => {},
      onChange: () => {
        throw new Error('callback bug');
      },
    });
    assert.doesNotThrow(() => last.set(entry(SESSION, 7)));
    assert.doesNotThrow(() => last.clear());
  });

  it('counts the bytes of the outputs, a Blob that is in the list twice once', () => {
    const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
    const e = entry(SESSION, 7, [10, 20], 100);
    last.set(e);
    assert.equal(last.bytes(), 130);
    const shared = entry(SESSION, 7, [], 100);
    shared.tiles = [/** @type {Blob} */ (shared.full)];
    last.set(shared);
    assert.equal(last.bytes(), 100);
    last.set(entry(SESSION, 7, [10], null));
    assert.equal(last.bytes(), 10);
  });

  it('replaces the summary only for the capture of that session', () => {
    const last = createLastCapture({ setTimer: () => 0, clearTimer: () => {} });
    last.set(entry(SESSION, 7));
    const next = /** @type {any} */ ({ sessionId: SESSION, marker: 1 });
    last.setSummary(next);
    assert.equal(last.latest()?.summary, next);
    last.setSummary(/** @type {any} */ ({ sessionId: OTHER, marker: 2 }));
    assert.equal(last.latest()?.summary, next);
  });
});

describe('pickOutput', () => {
  it('picks a tile by index and the full image', () => {
    const e = entry(SESSION, 7, [10, 20, 30], 100);
    assert.equal(pickOutput(e, 0, 1000), e.tiles[0]);
    assert.equal(pickOutput(e, 2, 1000), e.tiles[2]);
    assert.equal(pickOutput(e, 'full', 1000), e.full);
  });

  it('refuses a tile that does not exist with E_BAD_MESSAGE', () => {
    const e = entry(SESSION, 7, [10, 20], 100);
    for (const item of [2, 99, -1, 1.5, NaN]) {
      assert.throws(
        () => pickOutput(e, /** @type {any} */ (item), 1000),
        (err) => isSpoolError(err, ERR.BAD_MESSAGE, 'Unknown part.'),
        String(item),
      );
    }
  });

  it('refuses an image over the message limit with E_SESSION_TOO_LARGE', () => {
    const e = entry(SESSION, 7, [10, 2000], 1500);
    assert.equal(pickOutput(e, 0, 1500), e.tiles[0]);
    assert.equal(pickOutput(e, 'full', 1500), e.full, 'exactly at the limit is fine');
    assert.throws(() => pickOutput(e, 'full', 1499), (err) =>
      isSpoolError(err, ERR.SESSION_TOO_LARGE, 'This image is too large to copy. Use the AI screenshots.'),
    );
    assert.throws(() => pickOutput(e, 1, 1999), (err) => isSpoolError(err, ERR.SESSION_TOO_LARGE));
  });

  it('refuses the full image when it was not built', () => {
    const e = entry(SESSION, 7, [10], null);
    assert.throws(() => pickOutput(e, 'full', 1000), (err) => isSpoolError(err, ERR.INTERNAL));
    assert.equal(pickOutput(e, 0, 1000), e.tiles[0]);
  });

  it('keeps the message limit below what one runtime message carries', () => {
    // Chrome stops a message at 64 MiB. base64 adds a third.
    assert.equal(MAX_TRANSFER_BYTES, 40 * 1024 * 1024);
    assert.ok(Math.ceil((MAX_TRANSFER_BYTES * 4) / 3) < 64 * 1024 * 1024);
  });
});

describe('createShelfTokens', () => {
  /** @param {number} start */
  function clock(start = 1000) {
    let t = start;
    return { now: () => t, advance: (/** @type {number} */ ms) => void (t += ms) };
  }

  it('accepts a granted token for its tab', () => {
    const tokens = createShelfTokens({ now: clock().now });
    tokens.grant(TOKEN_1, 7);
    assert.doesNotThrow(() => tokens.check(TOKEN_1, 7));
    assert.equal(tokens.size, 1);
  });

  it('refuses a token of another tab with E_FORBIDDEN_SENDER', () => {
    const tokens = createShelfTokens({ now: clock().now });
    tokens.grant(TOKEN_1, 7);
    assert.throws(() => tokens.check(TOKEN_1, 8), (e) => isSpoolError(e, ERR.FORBIDDEN_SENDER));
  });

  it('refuses an unknown token with E_SESSION_NOT_FOUND', () => {
    const tokens = createShelfTokens({ now: clock().now });
    assert.throws(
      () => tokens.check(TOKEN_1, 7),
      (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND, 'This capture has expired here. Press Alt+Shift+V again.'),
    );
  });

  it('ends after SHELF_TOKEN_TTL_MS (10 minutes)', () => {
    assert.equal(SHELF_TOKEN_TTL_MS, 10 * 60 * 1000);
    const c = clock();
    const tokens = createShelfTokens({ now: c.now });
    tokens.grant(TOKEN_1, 7);
    c.advance(SHELF_TOKEN_TTL_MS - 1);
    assert.doesNotThrow(() => tokens.check(TOKEN_1, 7));
    c.advance(1);
    assert.throws(() => tokens.check(TOKEN_1, 7), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
    assert.equal(tokens.size, 0);
  });

  it('a new token for the same tab ends the old one', () => {
    const tokens = createShelfTokens({ now: clock().now });
    tokens.grant(TOKEN_1, 7);
    tokens.grant(TOKEN_2, 7);
    assert.throws(() => tokens.check(TOKEN_1, 7), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
    assert.doesNotThrow(() => tokens.check(TOKEN_2, 7));
    assert.equal(tokens.size, 1);
  });

  it('tokens of different tabs live side by side', () => {
    const tokens = createShelfTokens({ now: clock().now });
    tokens.grant(TOKEN_1, 7);
    tokens.grant(TOKEN_2, 8);
    assert.doesNotThrow(() => tokens.check(TOKEN_1, 7));
    assert.doesNotThrow(() => tokens.check(TOKEN_2, 8));
  });

  it('a token that is granted again for another tab belongs to the new tab only', () => {
    const tokens = createShelfTokens({ now: clock().now });
    tokens.grant(TOKEN_1, 7);
    tokens.grant(TOKEN_1, 8);
    assert.throws(() => tokens.check(TOKEN_1, 7), (e) => isSpoolError(e, ERR.FORBIDDEN_SENDER));
    assert.doesNotThrow(() => tokens.check(TOKEN_1, 8));
  });

  it('revokeTab ends every token of that tab and no other', () => {
    const tokens = createShelfTokens({ now: clock().now });
    tokens.grant(TOKEN_1, 7);
    tokens.grant(TOKEN_2, 8);
    tokens.revokeTab(7);
    assert.throws(() => tokens.check(TOKEN_1, 7), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
    assert.doesNotThrow(() => tokens.check(TOKEN_2, 8));
    tokens.revokeTab(99); // Nothing to revoke: no error.
  });

  it('keeps at most MAX_SHELF_TOKENS tokens, and the oldest one goes first', () => {
    assert.equal(MAX_SHELF_TOKENS, 8);
    const tokens = createShelfTokens({ now: clock().now });
    /** @type {string[]} */
    const ids = [];
    for (let i = 0; i < MAX_SHELF_TOKENS + 2; i++) {
      const id = `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
      ids.push(id);
      tokens.grant(id, 100 + i);
    }
    assert.equal(tokens.size, MAX_SHELF_TOKENS);
    assert.throws(() => tokens.check(ids[0] ?? '', 100), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
    assert.throws(() => tokens.check(ids[1] ?? '', 101), (e) => isSpoolError(e, ERR.SESSION_NOT_FOUND));
    assert.doesNotThrow(() => tokens.check(ids[2] ?? '', 102));
    assert.doesNotThrow(() => tokens.check(ids[MAX_SHELF_TOKENS + 1] ?? '', 100 + MAX_SHELF_TOKENS + 1));
  });

  it('removes the expired tokens before it counts for the limit', () => {
    const c = clock();
    const tokens = createShelfTokens({ now: c.now, max: 2 });
    tokens.grant(TOKEN_1, 7);
    c.advance(SHELF_TOKEN_TTL_MS + 1);
    tokens.grant(TOKEN_2, 8);
    assert.equal(tokens.size, 1);
    assert.doesNotThrow(() => tokens.check(TOKEN_2, 8));
  });
});
