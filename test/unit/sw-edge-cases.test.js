// @ts-check
/**
 * Tests added by mutation testing for the service
 * worker modules: each one pins behaviour that a mutation run showed to be unchecked by the older
 * tests. The router, the summary check, the capture queue, the downloader, the starter, the
 * capturing badge and the first-save question.
 */

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ERR, MSG, SpoolError, makeMessage } from '../../src/shared/protocol.js';
import { createCaptureQueue } from '../../src/sw/capture.js';
import { DOWNLOAD_WAIT_MS, createDownloader } from '../../src/sw/downloads.js';
import {
  CAPTURING_BADGE_COLOR,
  CAPTURING_BADGE_TEXT_COLOR,
  setCapturing,
} from '../../src/sw/capturing.js';
import {
  LEGACY_FIRST_SAVE_KEY,
  SAVE_ASKS_KEY,
  takeFirstSaveQuestion,
} from '../../src/sw/first-save.js';
import { createRouter } from '../../src/sw/router.js';
import { BADGE_COLOR, createStarter } from '../../src/sw/start.js';
import { parseSummary } from '../../src/sw/summary.js';
import {
  EXTENSION_ID,
  EXTENSION_ORIGIN,
  contentSender,
  installFakeChrome,
  macrotask,
} from '../helpers/fake-chrome.js';

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';

// ---------------------------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------------------------

describe('router: a message type without a handler', () => {
  it('replies "Unknown message." once and returns exactly false (no channel stays open)', () => {
    const router = createRouter({}, { runtimeId: EXTENSION_ID, origin: EXTENSION_ORIGIN });
    /** @type {unknown[]} */
    const responses = [];
    const message = makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID });
    const result = router(message, contentSender(), (r) => void responses.push(r));
    assert.strictEqual(result, false);
    assert.equal(responses.length, 1);
    const reply = /** @type {any} */ (responses[0]);
    assert.equal(reply.ok, false);
    assert.equal(reply.error.code, ERR.BAD_MESSAGE);
    assert.equal(reply.error.message, 'Unknown message.');
  });
});

describe('router: a message that fails the route check', () => {
  it('gets its error reply and the listener returns exactly false', () => {
    let called = 0;
    const router = createRouter(
      {
        [MSG.PAGE_FINISH]: () => {
          called += 1;
        },
      },
      { runtimeId: EXTENSION_ID, origin: EXTENSION_ORIGIN },
    );
    /** @type {unknown[]} */
    const responses = [];
    const message = makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID });
    // The sender is another extension.
    const stranger = /** @type {any} */ ({ id: 'z'.repeat(32), url: 'https://example.com/', tab: { id: 1, windowId: 1 } });
    const result = router(message, stranger, (r) => void responses.push(r));
    assert.strictEqual(result, false);
    assert.equal(called, 0, 'the handler did not run');
    assert.equal(responses.length, 1);
    assert.equal(/** @type {any} */ (responses[0]).ok, false);
  });
});

// ---------------------------------------------------------------------------------------------
// parseSummary: limits at the exact boundary
// ---------------------------------------------------------------------------------------------

/** A valid summary from the offscreen document. */
function validSummary() {
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
    save: { location: 'downloads', label: 'Downloads/Spool', files: 3, needsPermission: false },
    warnings: ['a', 'b'],
  };
}

/** @param {unknown} e */
function isInternal(e) {
  return e instanceof SpoolError && e.code === ERR.INTERNAL && e.message === 'Something went wrong. Try again.';
}

describe('parseSummary: limits', () => {
  /**
   * @param {string} name
   * @param {(s: ReturnType<typeof validSummary>, value: any) => void} apply
   * @param {any} good  The largest value that must pass.
   * @param {any} bad   The smallest value that must fail.
   */
  function boundary(name, apply, good, bad) {
    it(`${name}: the largest value passes, one more fails`, () => {
      const ok = validSummary();
      apply(ok, good);
      assert.doesNotThrow(() => parseSummary(ok));
      const over = validSummary();
      apply(over, bad);
      assert.throws(() => parseSummary(over), isInternal);
    });
  }

  boundary('title length', (s, v) => void (s.title = v), 'x'.repeat(512), 'x'.repeat(513));
  boundary('save label length', (s, v) => void (s.save.label = v), 'x'.repeat(512), 'x'.repeat(513));
  boundary(
    'save error length',
    (s, v) => void (/** @type {any} */ (s.save).error = v),
    'x'.repeat(512),
    'x'.repeat(513),
  );
  boundary('a warning length', (s, v) => void (s.warnings = [v]), 'x'.repeat(512), 'x'.repeat(513));
  boundary(
    'number of warnings',
    (s, v) => void (s.warnings = Array.from({ length: v }, () => 'w')),
    20,
    21,
  );
  boundary(
    'thumbnail length (base64 characters)',
    (s, v) => void (s.thumbnailPngBase64 = 'A'.repeat(v)),
    4 * 1024 * 1024,
    4 * 1024 * 1024 + 1,
  );

  for (const field of ['widthPx', 'heightPx', 'tileCount', 'thumbnailWidthPx', 'thumbnailHeightPx']) {
    it(`${field}: 1 passes, 0 fails`, () => {
      const one = /** @type {any} */ (validSummary());
      one[field] = 1;
      assert.equal(/** @type {any} */ (parseSummary(one))[field], 1);
      const zero = /** @type {any} */ (validSummary());
      zero[field] = 0;
      assert.throws(() => parseSummary(zero), isInternal);
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Capture queue
// ---------------------------------------------------------------------------------------------

describe('capture queue: errors and options', () => {
  const QUOTA = 'This request exceeds the MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota.';

  /** @param {string} message @param {{ retryLimit?: number }} [o] */
  function queueThatFails(message, o = {}) {
    let t = 0;
    return createCaptureQueue({
      captureFn: async () => {
        throw new Error(message);
      },
      retryLimit: o.retryLimit ?? 1,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
    });
  }

  it('a quota error that outlasts the retries says that Chrome limits screenshots', async () => {
    await assert.rejects(queueThatFails(QUOTA).capture(1), (e) => {
      assert.ok(e instanceof SpoolError);
      assert.equal(e.code, ERR.CAPTURE_FAILED);
      assert.equal(e.message, 'The browser is limiting screenshots. Wait a moment and try again.');
      return true;
    });
  });

  for (const text of [
    'Cannot access contents of the page.',
    'The extension has no activeTab permission for this page.',
    'Missing host permission: <all_urls> is needed.',
    'CANNOT ACCESS contents of url "https://x"',
  ]) {
    it(`"${text.slice(0, 40)}" says that access to the tab was lost`, async () => {
      await assert.rejects(queueThatFails(text).capture(1), (e) => {
        assert.ok(e instanceof SpoolError);
        assert.equal(e.message, 'Spool lost access to this tab. Start a new capture.');
        return true;
      });
    });
  }

  it('any other failure gives the plain message and never the text of Chrome', async () => {
    await assert.rejects(queueThatFails('Something at https://secret.example/page').capture(1), (e) => {
      assert.ok(e instanceof SpoolError);
      assert.equal(e.message, 'Could not capture the tab. Try again.');
      return true;
    });
  });

  it('names the option in the RangeError and knows which options may have a fraction', () => {
    assert.throws(() => createCaptureQueue({ minIntervalMs: -1 }), /minIntervalMs must be a non-negative number/);
    assert.throws(() => createCaptureQueue({ retryDelayMs: -1 }), /retryDelayMs must be a non-negative number/);
    assert.throws(() => createCaptureQueue({ retryLimit: 1.5 }), /retryLimit must be a non-negative integer/);
    assert.throws(() => createCaptureQueue({ retryLimit: -1 }), /retryLimit must be a non-negative integer/);
    // A fraction of a millisecond is a valid time.
    assert.doesNotThrow(() => createCaptureQueue({ minIntervalMs: 550.5, retryDelayMs: 600.25 }));
  });

  it('waits for a slot of less than 1 ms', async () => {
    let t = 10_000;
    /** @type {number[]} */
    const sleeps = [];
    const queue = createCaptureQueue({
      minIntervalMs: 100,
      captureFn: async () => 'data:image/png;base64,AA==',
      now: () => t,
      sleep: async (ms) => {
        sleeps.push(ms);
        t += ms;
      },
    });
    await queue.capture(1);
    t += 99.5; // 0.5 ms short of the interval.
    await queue.capture(1);
    assert.deepEqual(sleeps, [0.5]);
  });
});

// ---------------------------------------------------------------------------------------------
// Downloader
// ---------------------------------------------------------------------------------------------

describe('downloader: waiting rules', () => {
  /**
   * @param {{ fireBefore?: 'complete' | 'interrupted', searchState?: string, searchThrows?: boolean }} [o]
   */
  function makeApi(o = {}) {
    /** @type {((delta: any) => void)[]} */
    const listeners = [];
    const stats = { searches: 0 };
    return {
      stats,
      api: {
        async download() {
          if (o.fireBefore) for (const fn of [...listeners]) fn({ id: 1, state: { current: o.fireBefore } });
          return 1;
        },
        async search() {
          stats.searches += 1;
          if (o.searchThrows) throw new Error('search failed');
          return [{ state: o.searchState ?? 'in_progress' }];
        },
        onChanged: {
          addListener: (/** @type {(d: any) => void} */ fn) => void listeners.push(fn),
          removeListener(/** @type {(d: any) => void} */ fn) {
            const i = listeners.indexOf(fn);
            if (i >= 0) listeners.splice(i, 1);
          },
        },
      },
    };
  }

  const FILE = [{ path: 'Spool/a.png', url: 'blob:chrome-extension://x/1' }];

  it('waits 120 s by default for one file (the value is part of the contract)', async () => {
    assert.equal(DOWNLOAD_WAIT_MS, 120_000);
    const { api } = makeApi();
    /** @type {number[]} */
    const asked = [];
    const downloader = createDownloader({
      api: /** @type {any} */ (api),
      setTimer: (fn, ms) => {
        asked.push(ms);
        fn(); // The time is up at once.
        return 0;
      },
      clearTimer: () => {},
    });
    assert.deepEqual(await downloader.downloadFiles(FILE), { saved: 0, rejected: 0, interrupted: 1 });
    assert.deepEqual(asked, [120_000]);
  });

  it('a state that arrived before download() returned is used without a search', async () => {
    const { api, stats } = makeApi({ fireBefore: 'complete', searchState: 'in_progress' });
    const downloader = createDownloader({
      api: /** @type {any} */ (api),
      setTimer: (fn) => {
        fn();
        return 0;
      },
      clearTimer: () => {},
    });
    assert.deepEqual(await downloader.downloadFiles(FILE), { saved: 1, rejected: 0, interrupted: 0 });
    assert.equal(stats.searches, 0, 'the early event was enough');
  });

  it('an interrupted download that the search reports sets no timer', async () => {
    const { api } = makeApi({ searchState: 'interrupted' });
    let timers = 0;
    const downloader = createDownloader({
      api: /** @type {any} */ (api),
      setTimer: () => {
        timers += 1;
        return 0;
      },
      clearTimer: () => {},
    });
    assert.deepEqual(await downloader.downloadFiles(FILE), { saved: 0, rejected: 0, interrupted: 1 });
    assert.equal(timers, 0);
  });

  it('a complete download that the search reports sets no timer either', async () => {
    const { api } = makeApi({ searchState: 'complete' });
    let timers = 0;
    const downloader = createDownloader({
      api: /** @type {any} */ (api),
      setTimer: () => {
        timers += 1;
        return 0;
      },
      clearTimer: () => {},
    });
    assert.deepEqual(await downloader.downloadFiles(FILE), { saved: 1, rejected: 0, interrupted: 0 });
    assert.equal(timers, 0);
  });
});

// ---------------------------------------------------------------------------------------------
// Starter
// ---------------------------------------------------------------------------------------------

/** @param {Parameters<typeof createStarter>[0]} [extra] */
function makeStarter(extra = {}) {
  /** @type {{ fn: () => void, ms: number, handle: number }[]} */
  const timers = [];
  /** @type {number[]} */
  const cancelled = [];
  const starter = createStarter({
    schedule: (fn, ms) => {
      const handle = timers.length + 1;
      timers.push({ fn, ms, handle });
      return handle;
    },
    cancel: (handle) => void cancelled.push(/** @type {number} */ (handle)),
    newSessionId: () => '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34',
    newToken: () => '4a2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a35',
    ...extra,
  });
  return { ...starter, timers, cancelled };
}

describe('starter', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it('the badge of a refused page is red (#b3261e)', async () => {
    assert.equal(BADGE_COLOR, '#b3261e');
    const s = makeStarter();
    await s.startCapture(/** @type {any} */ ({ id: 5, url: 'about:blank' }));
    assert.deepEqual(fake.argsOf('action.setBadgeBackgroundColor'), [[{ tabId: 5, color: '#b3261e' }]]);
  });

  it('restores the plain title "Spool" when the manifest has no title', async () => {
    fake.state.manifest = {};
    const s = makeStarter();
    await s.startCapture(/** @type {any} */ ({ id: 5, url: 'about:blank' }));
    s.timers[0]?.fn();
    await macrotask();
    assert.deepEqual(fake.argsOf('action.setTitle')[1], [{ tabId: 5, title: 'Spool' }]);
  });

  it('does not cancel a timer that has already fired', async () => {
    const s = makeStarter();
    const tab = /** @type {any} */ ({ id: 5, url: 'about:blank' });
    await s.startCapture(tab);
    s.timers[0]?.fn(); // The 4 s are over: the badge is cleared.
    await macrotask();
    await s.startCapture(tab);
    assert.deepEqual(s.cancelled, [], 'nothing was pending, so nothing is cancelled');
  });

  it('a pending timer is cancelled by the next flag of the same tab, and only once', async () => {
    const s = makeStarter();
    const tab = /** @type {any} */ ({ id: 5, url: 'about:blank' });
    await s.startCapture(tab);
    await s.startCapture(tab);
    await s.startCapture(tab);
    assert.deepEqual(s.cancelled, [1, 2]);
  });

  it('tab 0 is a tab: capture and shelf start there; a negative tab does not', async () => {
    const s = makeStarter();
    await s.startCapture(/** @type {any} */ ({ id: 0, url: 'https://example.com/' }));
    const afterCapture = fake.argsOf('scripting.executeScript').length;
    assert.ok(afterCapture >= 1, 'a capture started in tab 0');
    await s.startShelf(/** @type {any} */ ({ id: 0, url: 'https://example.com/' }));
    assert.ok(fake.argsOf('scripting.executeScript').length > afterCapture, 'a shelf started in tab 0');
    const before = fake.calls.length;
    await s.startCapture(/** @type {any} */ ({ id: -1, url: 'https://example.com/' }));
    await s.startShelf(/** @type {any} */ ({ id: -1, url: 'https://example.com/' }));
    assert.equal(fake.calls.length, before, 'a negative tab id makes no call');
  });

  describe('the functions that run in the page', () => {
    /** @type {any} */
    const g = globalThis;
    /** @type {unknown} */
    let saved;
    /** @type {boolean} */
    let had;
    beforeEach(() => {
      had = Object.hasOwn(g, '__spool');
      saved = g.__spool;
      delete g.__spool;
    });
    afterEach(() => {
      if (had) g.__spool = saved;
      else delete g.__spool;
    });

    async function injected() {
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      const [configInj, , startInj] = fake
        .argsOf('scripting.executeScript')
        .map((a) => /** @type {any} */ (a[0]));
      return { config: configInj.args[0], installConfig: configInj.func, startAgent: startInj.func };
    }

    it('the namespace is hidden from enumeration, but a script can replace and delete it', async () => {
      const { config, installConfig } = await injected();
      installConfig(config);
      const descriptor = Object.getOwnPropertyDescriptor(g, '__spool');
      assert.ok(descriptor);
      assert.equal(descriptor.enumerable, false, 'not listed by for...in or Object.keys');
      assert.equal(descriptor.writable, true);
      assert.equal(descriptor.configurable, true);
      assert.ok(!Object.keys(g).includes('__spool'));
    });

    it('a namespace that the page made (not our own plain object) is replaced', async () => {
      const { config, installConfig } = await injected();
      g.__spool = ['not', 'ours'];
      assert.equal(installConfig(config), false);
      assert.equal(Object.prototype.toString.call(g.__spool), '[object Object]');
      assert.equal(g.__spool.config, config);
    });

    it('startAgent returns false, and does not throw, without an agent or without a start function', async () => {
      const { startAgent } = await injected();
      g.__spool = {};
      assert.equal(startAgent(), false, 'a namespace without an agent');
      g.__spool = { agent: {} };
      assert.equal(startAgent(), false, 'an agent without start()');
      g.__spool = { agent: { start: 'not a function' } };
      assert.equal(startAgent(), false);
    });

    it('both functions run in an empty realm and the namespace they make is not enumerable there', async () => {
      const { config, installConfig } = await injected();
      const context = vm.createContext({});
      const rebuilt = vm.runInContext(`(${installConfig.toString()})`, context);
      assert.equal(rebuilt(config), false);
      assert.equal(vm.runInContext("Object.getOwnPropertyDescriptor(globalThis, '__spool').enumerable", context), false);
    });
  });
});

// ---------------------------------------------------------------------------------------------
// Capturing badge and first-save question
// ---------------------------------------------------------------------------------------------

describe('capturing state of the toolbar button', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it('the colours are the amber of the glyph and dark text', async () => {
    assert.equal(CAPTURING_BADGE_COLOR, '#FFB224');
    assert.equal(CAPTURING_BADGE_TEXT_COLOR, '#1C1D20');
    /** @type {any[]} */
    const textColor = [];
    /** @type {any} */ (fake.chrome.action).setBadgeTextColor = async (/** @type {any} */ d) => void textColor.push(d);
    await setCapturing(3, true);
    assert.deepEqual(textColor, [{ tabId: 3, color: '#1C1D20' }]);
    assert.deepEqual(fake.argsOf('action.setBadgeBackgroundColor'), [[{ tabId: 3, color: '#FFB224' }]]);
  });

  it('off: the title goes back to the title of the manifest, or to "Spool" without one', async () => {
    await setCapturing(3, false);
    assert.deepEqual(fake.argsOf('action.setTitle')[0], [
      { tabId: 3, title: 'Spool it' },
    ]);
    fake.state.manifest = { action: {} };
    await setCapturing(3, false);
    assert.deepEqual(fake.argsOf('action.setTitle')[1], [{ tabId: 3, title: 'Spool' }]);
    fake.state.manifest = { action: { default_title: 7 } };
    await setCapturing(3, false);
    assert.deepEqual(fake.argsOf('action.setTitle')[2], [{ tabId: 3, title: 'Spool' }]);
  });

  it('tab 0 is a tab, tab -1 is not', async () => {
    await setCapturing(0, true);
    assert.equal(fake.argsOf('action.setBadgeText').length, 1);
    await setCapturing(-1, true);
    assert.equal(fake.argsOf('action.setBadgeText').length, 1);
  });
});

describe('first-save question: what is stored', () => {
  it('reads the count "saveFolderAsks" (and the old flag), writes the count, and nothing else', async () => {
    assert.equal(SAVE_ASKS_KEY, 'saveFolderAsks');
    assert.equal(LEGACY_FIRST_SAVE_KEY, 'firstSavePrompted');
    /** @type {unknown[]} */
    const gets = [];
    /** @type {unknown[]} */
    const sets = [];
    const area = /** @type {any} */ ({
      async get(/** @type {unknown} */ key) {
        gets.push(key);
        return {};
      },
      async set(/** @type {unknown} */ items) {
        sets.push(items);
      },
    });
    assert.equal(await takeFirstSaveQuestion(area), true);
    assert.deepEqual(gets, [['saveFolderAsks', 'firstSavePrompted']]);
    assert.deepEqual(sets, [{ saveFolderAsks: 1 }]);
  });
});
