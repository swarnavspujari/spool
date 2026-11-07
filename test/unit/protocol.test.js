// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PATHS } from '../../src/shared/constants.js';
import {
  ERR,
  MSG,
  PROTOCOL_VERSION,
  TARGET,
  SpoolError,
  classifySender,
  errorResponse,
  isFrameMeta,
  isNonNegativeInt,
  isSessionId,
  makeMessage,
  routeCheck,
  toErrorResponse,
} from '../../src/shared/protocol.js';

const RUNTIME_ID = 'testextensionidtestextensionid1';
const ORIGIN = `chrome-extension://${RUNTIME_ID}/`;
const ENV = { runtimeId: RUNTIME_ID, origin: ORIGIN };

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';
const TOKEN = '0c9d6a52-7b1e-4f3a-9a40-2d8e5b7c1f66';
const BLOB_URL = `blob:chrome-extension://${RUNTIME_ID}/6f1c2e84-3b7a-4d19-8c55-0a9e4b2d7f13`;
const PNG_PREFIX = 'data:image/png;base64,';

/** A valid FrameMeta. Tests change one thing at a time. */
function validMeta() {
  return {
    direction: 'initial',
    viewport: { width: 1280, height: 800 },
    rect: { x: 10, y: 20, width: 600, height: 400 },
    contentY: 0,
  };
}

/** Sender objects, one per kind that routeCheck distinguishes. */
const SENDERS = {
  content: { id: RUNTIME_ID, url: 'https://example.com/page', tab: { id: 5 }, frameId: 0 },
  result: { id: RUNTIME_ID, url: `${ORIGIN}${PATHS.result}#${SESSION_ID}`, tab: { id: 6 } },
  options: { id: RUNTIME_ID, url: `${ORIGIN}${PATHS.options}` },
  offscreen: { id: RUNTIME_ID, url: `${ORIGIN}${PATHS.offscreen}` },
  worker: { id: RUNTIME_ID, url: `${ORIGIN}${PATHS.serviceWorker}` },
  unknown: { id: 'some-other-extension', url: 'https://example.com/', tab: { id: 5 }, frameId: 0 },
};

/** @param {keyof typeof SENDERS} kind @returns {chrome.runtime.MessageSender} */
function senderOf(kind) {
  return /** @type {any} */ (SENDERS[kind]);
}

/**
 * @typedef {Object} ContractEntry
 * @property {string} target
 * @property {(keyof typeof SENDERS)[]} from
 * @property {() => Record<string, unknown>} fields
 */

/**
 * What the contract says for every message type: target, allowed sender kinds, and a valid
 * message body (the fields without the envelope). This table is written out by hand on purpose:
 * it must not be derived from the code under test.
 * @type {Record<string, ContractEntry>}
 */
const CONTRACT = {
  'page/session-open': {
    target: 'sw',
    from: ['content'],
    fields: () => ({ sessionId: SESSION_ID, title: 'A page' }),
  },
  'page/capture-frame': {
    target: 'sw',
    from: ['content'],
    fields: () => ({ sessionId: SESSION_ID, meta: validMeta() }),
  },
  'page/finish': { target: 'sw', from: ['content'], fields: () => ({ sessionId: SESSION_ID }) },
  'page/cancel': { target: 'sw', from: ['content'], fields: () => ({ sessionId: SESSION_ID }) },
  // Post-capture flow (docs/contracts.md section 7.4).
  'page/get-clipboard': {
    target: 'sw',
    from: ['content'],
    fields: () => ({ sessionId: SESSION_ID }),
  },
  'page/clipboard-fallback': {
    target: 'sw',
    from: ['content'],
    fields: () => ({ sessionId: SESSION_ID }),
  },
  'page/get-tile': {
    target: 'sw',
    from: ['content'],
    fields: () => ({ sessionId: SESSION_ID, index: 2 }),
  },
  'page/open-result': {
    target: 'sw',
    from: ['content'],
    fields: () => ({ sessionId: SESSION_ID }),
  },
  'page/open-options': { target: 'sw', from: ['content'], fields: () => ({ section: 'save' }) },
  'page/show-in-folder': {
    target: 'sw',
    from: ['content'],
    fields: () => ({ sessionId: SESSION_ID }),
  },
  'page/shelf-info': { target: 'sw', from: ['content'], fields: () => ({ token: TOKEN }) },
  'page/shelf-get': {
    target: 'sw',
    from: ['content'],
    fields: () => ({ token: TOKEN, item: 'full' }),
  },
  'sw/download': {
    target: 'sw',
    from: ['offscreen'],
    fields: () => ({ files: [{ path: 'Spool/Spool 2026-11-06 15.22.48 A page.png', url: BLOB_URL }] }),
  },
  'sw/offscreen-idle': { target: 'sw', from: ['offscreen'], fields: () => ({}) },
  'offscreen/session-open': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({
      sessionId: SESSION_ID,
      tabId: 5,
      title: 'A page',
      host: 'github.com',
      tileTier: 'high',
    }),
  },
  'offscreen/add-frame': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({
      sessionId: SESSION_ID,
      tabId: 5,
      dataUrl: `${PNG_PREFIX}AAAA`,
      meta: validMeta(),
    }),
  },
  // Cancel: an unfinished session of that tab. It needs the tab (from the sender tab).
  'offscreen/session-drop': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({ sessionId: SESSION_ID, tabId: 5 }),
  },
  'offscreen/drop-tab': { target: 'offscreen', from: ['worker'], fields: () => ({ tabId: 5 }) },
  'offscreen/ping': { target: 'offscreen', from: ['worker'], fields: () => ({}) },
  'offscreen/finalize': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({
      sessionId: SESSION_ID,
      tabId: 5,
      saveTiles: true,
      saveFull: false,
      folderName: 'Spool',
    }),
  },
  'offscreen/output-info': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({ sessionId: SESSION_ID, tabId: 5 }),
  },
  'offscreen/get-output': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({ sessionId: SESSION_ID, tabId: 5, item: 0 }),
  },
  'offscreen/shelf-grant': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({ token: TOKEN, tabId: 5 }),
  },
  'offscreen/shelf-info': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({ token: TOKEN, tabId: 5 }),
  },
  'offscreen/shelf-get': {
    target: 'offscreen',
    from: ['worker'],
    fields: () => ({ token: TOKEN, tabId: 5, item: 'full' }),
  },
  'offscreen/last-info': {
    target: 'offscreen',
    from: ['result'],
    fields: () => ({ sessionId: SESSION_ID }),
  },
  'offscreen/last-get': {
    target: 'offscreen',
    from: ['result'],
    fields: () => ({ sessionId: SESSION_ID, item: 'full' }),
  },
};

/** Values that each field validator must refuse, by field name. */
const BAD_VALUES = {
  sessionId: [
    undefined,
    null,
    '',
    'nope',
    123,
    {},
    SESSION_ID.toUpperCase(), // lower case only
    SESSION_ID.replace('-4b6f-', '-1b6f-'), // not version 4
    SESSION_ID.replace('-8a21-', '-0a21-'), // bad variant
    `${SESSION_ID}0`, // too long
    SESSION_ID.slice(1), // too short
    ` ${SESSION_ID}`,
    `${SESSION_ID}\n`, // $ must not allow a trailing newline
    SESSION_ID.replace('3f2b8c1e', '3f2b8c1g'), // not hex
  ],
  title: [undefined, null, 5, {}, [], 'x'.repeat(513)],
  host: [undefined, null, 5, {}, [], 'GitHub.com', 'a.b/c', 'a b', 'a:443/x', 'x'.repeat(254)],
  tabId: [undefined, null, '5', -1, 1.5, NaN, Infinity, -Infinity, 2 ** 53, {}, [], true],
  tileTier: [undefined, null, '', 'low', 'High', 'HIGH', 'standard ', 5, {}, 'toString'],
  dataUrl: [
    undefined,
    null,
    5,
    '',
    'data:image/jpeg;base64,AAAA',
    'data:image/png;base64', // no comma
    'DATA:IMAGE/PNG;BASE64,AAAA',
    ' data:image/png;base64,AAAA',
    'https://example.com/a.png',
    `${PNG_PREFIX.slice(0, -1)}`,
  ],
  index: [undefined, null, '0', -1, 1.5, NaN, Infinity, 2 ** 53, {}, []],
  meta: [undefined, null, 'x', 5, [], {}, { ...validMeta(), extra: 1 }, { seq: 0 }],
  // Post-capture flow.
  token: [
    undefined,
    null,
    '',
    'nope',
    5,
    {},
    TOKEN.toUpperCase(),
    TOKEN.replace('-4f3a-', '-1f3a-'),
    `${TOKEN}0`,
    `${TOKEN}\n`,
  ],
  item: [undefined, null, '', 'Full', 'FULL', 'full ', 'tile', '0', -1, 1.5, NaN, Infinity, {}, []],
  section: [undefined, null, '', 'Save', 'general', 'save ', '#save', 0, {}, []],
  saveTiles: [undefined, null, 'true', 1, 0, {}, []],
  saveFull: [undefined, null, 'false', 1, 0, {}, []],
  folderName: [
    undefined,
    null,
    '',
    5,
    {},
    'a/b',
    '..',
    ' Spool',
    'Spool ',
    'a\\b',
    'x'.repeat(41),
    'con',
    'Spool.',
  ],
  files: [
    undefined,
    null,
    'x',
    5,
    {},
    [],
    [{}],
    [{ path: 'a.png' }],
    [{ url: BLOB_URL }],
    [{ path: 'a.png', url: BLOB_URL, extra: 1 }],
    [{ path: '/a.png', url: BLOB_URL }],
    [{ path: 'a/', url: BLOB_URL }],
    [{ path: 'a//b.png', url: BLOB_URL }],
    [{ path: '../a.png', url: BLOB_URL }],
    [{ path: 'a/../b.png', url: BLOB_URL }],
    [{ path: 'C:/a.png', url: BLOB_URL }],
    [{ path: 'a\\b.png', url: BLOB_URL }],
    [{ path: 'a.png', url: 'https://example.com/a' }],
    [{ path: 'a.png', url: 'data:image/png;base64,AAAA' }],
    [{ path: 'a.png', url: 'blob:https://example.com/6f1c2e84-3b7a-4d19-8c55-0a9e4b2d7f13' }],
    [{ path: 'a.png', url: `${BLOB_URL}x` }],
    [{ path: 'a/b/c/d/e.png', url: BLOB_URL }], // five segments
    [{ path: 'a.png', url: BLOB_URL }, 5],
    Array.from({ length: 1001 }, () => ({ path: 'a.png', url: BLOB_URL })),
  ],
};

describe('constants', () => {
  it('has protocol version 1 and the two targets', () => {
    assert.equal(PROTOCOL_VERSION, 1);
    assert.deepEqual({ ...TARGET }, { SW: 'sw', OFFSCREEN: 'offscreen' });
  });

  it('keeps MSG and ERR values unique and frozen', () => {
    const msgs = Object.values(MSG);
    assert.equal(new Set(msgs).size, msgs.length);
    const errs = Object.values(ERR);
    assert.equal(new Set(errs).size, errs.length);
    assert.ok(Object.isFrozen(MSG));
    assert.ok(Object.isFrozen(ERR));
    assert.ok(Object.isFrozen(TARGET));
    for (const code of errs) assert.match(code, /^E_[A-Z_]+$/);
  });

  it('the test table covers every message type, and nothing else', () => {
    assert.deepEqual(Object.values(MSG).sort(), Object.keys(CONTRACT).sort());
  });
});

describe('SpoolError, errorResponse, toErrorResponse', () => {
  it('SpoolError is an Error with a code and a name', () => {
    const e = new SpoolError(ERR.CAPTURE_FAILED, 'Could not capture.');
    assert.ok(e instanceof Error);
    assert.ok(e instanceof SpoolError);
    assert.equal(e.name, 'SpoolError');
    assert.equal(e.code, 'E_CAPTURE_FAILED');
    assert.equal(e.message, 'Could not capture.');
    assert.ok(e.stack?.includes('Could not capture.'));
  });

  it('errorResponse builds the reply shape', () => {
    assert.deepEqual(errorResponse('E_X', 'Text.'), {
      ok: false,
      error: { code: 'E_X', message: 'Text.' },
    });
  });

  it('toErrorResponse keeps the code and message of a SpoolError', () => {
    assert.deepEqual(toErrorResponse(new SpoolError(ERR.TAB_NOT_VISIBLE, 'Go back.')), {
      ok: false,
      error: { code: 'E_TAB_NOT_VISIBLE', message: 'Go back.' },
    });
  });

  it('toErrorResponse hides the details of every other failure', () => {
    for (const thrown of [
      new Error('secret https://private.example'),
      new TypeError('x is not a function'),
      'a string with a secret',
      { code: 'E_BAD_MESSAGE', message: 'forged' },
      null,
      undefined,
      42,
    ]) {
      const reply = toErrorResponse(thrown);
      assert.equal(reply.ok, false);
      assert.equal(reply.error.code, ERR.INTERNAL);
      assert.equal(reply.error.message, 'Something went wrong. Try again.');
    }
  });
});

describe('makeMessage', () => {
  it('builds the envelope with the target of the type', () => {
    for (const [type, spec] of Object.entries(CONTRACT)) {
      const msg = makeMessage(type, spec.fields());
      assert.equal(msg.v, 1, type);
      assert.equal(msg.target, spec.target, type);
      assert.equal(msg.type, type);
    }
  });

  it('puts the fields beside the envelope and works without fields', () => {
    assert.deepEqual(makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID }), {
      v: 1,
      target: 'sw',
      type: 'page/finish',
      sessionId: SESSION_ID,
    });
    assert.deepEqual(makeMessage(MSG.OFF_PING), {
      v: 1,
      target: 'offscreen',
      type: 'offscreen/ping',
    });
  });

  it('throws E_BAD_MESSAGE for an unknown type', () => {
    for (const type of ['nope', '', 'page/unknown', 'PAGE/FINISH']) {
      assert.throws(
        () => makeMessage(type),
        (e) => e instanceof SpoolError && e.code === ERR.BAD_MESSAGE,
        type,
      );
    }
  });

  // Regression: a type that exists only on Object.prototype must not resolve to a spec.
  it(
    'throws E_BAD_MESSAGE for a type that exists only on the prototype',
    () => {
      for (const type of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
        assert.throws(
          () => makeMessage(type),
          (e) => e instanceof SpoolError && e.code === ERR.BAD_MESSAGE,
          type,
        );
      }
    },
  );

  it('builds messages that routeCheck accepts', () => {
    for (const [type, spec] of Object.entries(CONTRACT)) {
      const msg = makeMessage(type, spec.fields());
      for (const kind of spec.from) {
        const result = routeCheck(msg, senderOf(kind), spec.target, ENV);
        assert.deepEqual(result, { ok: true, type, kind }, `${type} from ${kind}`);
      }
    }
  });

  // Regression: a field called `v`, `target` or `type` must not replace the envelope.
  it(
    'does not let fields replace the envelope',
    () => {
      const msg = makeMessage(MSG.PAGE_FINISH, { type: 'x', v: 9, target: 'y', sessionId: 'a' });
      assert.equal(msg.v, 1);
      assert.equal(msg.target, 'sw');
      assert.equal(msg.type, 'page/finish');
    },
  );
});

describe('isNonNegativeInt and isSessionId', () => {
  it('isNonNegativeInt accepts only safe non-negative integers', () => {
    for (const v of [0, 1, 5, 2 ** 31, Number.MAX_SAFE_INTEGER]) {
      assert.equal(isNonNegativeInt(v), true);
    }
    for (const v of [-1, 0.5, NaN, Infinity, 2 ** 53, '3', null, undefined, {}, [], true]) {
      assert.equal(isNonNegativeInt(v), false, String(v));
    }
    assert.equal(isNonNegativeInt(-0), true);
  });

  it('isSessionId accepts version 4 UUIDs in lower case', () => {
    assert.equal(isSessionId(SESSION_ID), true);
    assert.equal(isSessionId(crypto.randomUUID()), true);
    for (let i = 0; i < 50; i += 1) assert.equal(isSessionId(crypto.randomUUID()), true);
    for (const v of BAD_VALUES.sessionId) assert.equal(isSessionId(v), false, String(v));
  });
});

describe('classifySender', () => {
  /** @param {unknown} sender */
  const kind = (sender) =>
    classifySender(/** @type {any} */ (sender), RUNTIME_ID, ORIGIN);

  it('content: a tab, frame 0, a web URL of this extension', () => {
    assert.equal(kind(SENDERS.content), 'content');
    assert.equal(
      kind({ id: RUNTIME_ID, url: 'file:///C:/page.html', tab: { id: 0 }, frameId: 0 }),
      'content',
      'tab id 0 is valid',
    );
  });

  it('a sub frame is unknown', () => {
    assert.equal(kind({ ...SENDERS.content, frameId: 1 }), 'unknown');
    assert.equal(kind({ ...SENDERS.content, frameId: 42 }), 'unknown');
    const { frameId: _frameId, ...noFrame } = SENDERS.content;
    assert.equal(kind(noFrame), 'unknown');
  });

  it('a bad tab is unknown', () => {
    assert.equal(kind({ ...SENDERS.content, tab: {} }), 'unknown');
    assert.equal(kind({ ...SENDERS.content, tab: { id: -1 } }), 'unknown');
    assert.equal(kind({ ...SENDERS.content, tab: { id: 1.5 } }), 'unknown');
    assert.equal(kind({ ...SENDERS.content, tab: { id: '5' } }), 'unknown');
    const { tab: _tab, ...noTab } = SENDERS.content;
    assert.equal(kind(noTab), 'unknown');
  });

  it('a foreign extension id is unknown for every kind of page', () => {
    const kinds = /** @type {const} */ (['content', 'result', 'options', 'offscreen', 'worker']);
    for (const k of kinds) {
      assert.equal(kind({ ...SENDERS[k], id: 'other-extension-id' }), 'unknown', k);
      assert.equal(kind({ ...SENDERS[k], id: undefined }), 'unknown', k);
    }
  });

  it('missing or empty sender is unknown', () => {
    assert.equal(kind(undefined), 'unknown');
    assert.equal(kind(null), 'unknown');
    assert.equal(kind({}), 'unknown');
  });

  it('result, options and offscreen pages are recognised by their path', () => {
    assert.equal(kind(SENDERS.result), 'result');
    assert.equal(kind(SENDERS.options), 'options');
    assert.equal(kind(SENDERS.offscreen), 'offscreen');
  });

  it('a result page in a tab is still a result page (not a content script)', () => {
    assert.equal(kind({ ...SENDERS.result, tab: { id: 9 }, frameId: 0 }), 'result');
    assert.equal(kind({ ...SENDERS.options, tab: { id: 9 }, frameId: 0 }), 'options');
  });

  it('ignores the query string and the hash of the URL', () => {
    assert.equal(kind({ id: RUNTIME_ID, url: `${ORIGIN}${PATHS.result}?x=1#y` }), 'result');
    assert.equal(kind({ id: RUNTIME_ID, url: `${ORIGIN}${PATHS.result}#${SESSION_ID}` }), 'result');
    assert.equal(kind({ id: RUNTIME_ID, url: `${ORIGIN}${PATHS.offscreen}?a=b` }), 'offscreen');
  });

  it('the worker: the URL of its script, without a tab', () => {
    assert.equal(kind(SENDERS.worker), 'worker');
    assert.equal(kind({ id: RUNTIME_ID, url: `${ORIGIN}${PATHS.serviceWorker}?x=1#y` }), 'worker');
  });

  it('a sender without a URL is unknown, with a tab or without (no worker fallback)', () => {
    assert.equal(kind({ id: RUNTIME_ID }), 'unknown');
    assert.equal(kind({ id: RUNTIME_ID, url: '' }), 'unknown');
    assert.equal(kind({ id: RUNTIME_ID, tab: { id: 1 } }), 'unknown');
    assert.equal(kind({ id: RUNTIME_ID, tab: { id: 1 }, frameId: 0 }), 'unknown');
    assert.equal(kind({ id: RUNTIME_ID, url: '', tab: { id: 1 }, frameId: 0 }), 'unknown');
  });

  it('the service worker URL with a tab is unknown', () => {
    assert.equal(kind({ ...SENDERS.worker, tab: { id: 1 } }), 'unknown');
    assert.equal(kind({ ...SENDERS.worker, tab: { id: 1 }, frameId: 0 }), 'unknown');
  });

  it('other pages of the extension are unknown, also in a tab, frame 0', () => {
    for (const path of [
      'other.html',
      'src/result/result.htm',
      'src/result/result.html/extra',
      'src/result/result.html/../x',
      'src/result/',
      '',
      'src/offscreen/offscreen.js',
    ]) {
      assert.equal(kind({ id: RUNTIME_ID, url: `${ORIGIN}${path}` }), 'unknown', path);
      assert.equal(
        kind({ id: RUNTIME_ID, url: `${ORIGIN}${path}`, tab: { id: 1 }, frameId: 0 }),
        'unknown',
        path,
      );
    }
  });

  it('does not accept a URL that only starts like the origin', () => {
    const lookalike = `chrome-extension://${RUNTIME_ID}x/${PATHS.result}`;
    assert.equal(kind({ id: RUNTIME_ID, url: lookalike }), 'unknown');
    assert.equal(kind({ id: RUNTIME_ID, url: lookalike, tab: { id: 1 }, frameId: 0 }), 'content');
    // ^ Documents the current rule: a web-like URL in a tab at frame 0 is a content script.
    //   Chrome never reports such a URL for another extension's page with our id.
  });

  it('a URL that is not a string counts as no URL', () => {
    assert.equal(kind({ id: RUNTIME_ID, url: 5 }), 'unknown');
    assert.equal(kind({ id: RUNTIME_ID, url: 5, tab: { id: 1 } }), 'unknown');
    assert.equal(kind({ id: RUNTIME_ID, url: null, tab: { id: 1 }, frameId: 0 }), 'unknown');
  });
});

describe('isFrameMeta', () => {
  /** @param {(m: any) => void} change */
  const withChange = (change) => {
    const m = validMeta();
    change(m);
    return m;
  };

  it('accepts a valid meta, for each direction', () => {
    assert.equal(isFrameMeta(validMeta()), true);
    for (const direction of ['initial', 'down', 'up']) {
      assert.equal(isFrameMeta({ ...validMeta(), direction }), true, direction);
    }
  });

  it('refuses things that are not objects', () => {
    for (const v of [null, undefined, 'x', 5, true, [], [validMeta()]]) {
      assert.equal(isFrameMeta(v), false, String(v));
    }
  });

  it('refuses a missing key or an extra key, at every level', () => {
    for (const key of Object.keys(validMeta())) {
      assert.equal(
        isFrameMeta(withChange((m) => delete m[key])),
        false,
        `missing ${key}`,
      );
    }
    assert.equal(isFrameMeta({ ...validMeta(), extra: 1 }), false);
    assert.equal(isFrameMeta(withChange((m) => (m.viewport.extra = 1))), false);
    assert.equal(isFrameMeta(withChange((m) => (m.rect.extra = 1))), false);
    assert.equal(isFrameMeta(withChange((m) => delete m.viewport.width)), false);
    assert.equal(isFrameMeta(withChange((m) => delete m.rect.x)), false);
  });

  it('has no seq and no dpr any more: a frame that carries them is refused', () => {
    assert.equal(isFrameMeta({ ...validMeta(), seq: 0 }), false);
    assert.equal(isFrameMeta({ ...validMeta(), dpr: 2 }), false);
  });

  it('direction must be one of the three words', () => {
    for (const direction of ['left', '', 'Down', 'DOWN', 5, null, undefined, ['down']]) {
      assert.equal(isFrameMeta({ ...validMeta(), direction }), false, String(direction));
    }
  });

  it('viewport sizes must be positive, finite and at most 100000', () => {
    const ok = (/** @type {any} */ viewport) => isFrameMeta({ ...validMeta(), viewport });
    assert.equal(ok({ width: 1, height: 1 }), false, 'the rect would not fit');
    assert.equal(
      isFrameMeta({ ...validMeta(), viewport: { width: 100_000, height: 100_000 } }),
      true,
    );
    for (const bad of [0, -1, NaN, Infinity, 100_001, '800', null, undefined]) {
      assert.equal(ok({ width: bad, height: 800 }), false, `width ${String(bad)}`);
      assert.equal(ok({ width: 1280, height: bad }), false, `height ${String(bad)}`);
    }
  });

  it('rect width and height must be at least 1', () => {
    const ok = (/** @type {any} */ rect) => isFrameMeta({ ...validMeta(), rect });
    assert.equal(ok({ x: 0, y: 0, width: 1, height: 1 }), true);
    assert.equal(ok({ x: 0, y: 0, width: 0.99, height: 10 }), false);
    assert.equal(ok({ x: 0, y: 0, width: 10, height: 0.99 }), false);
    assert.equal(ok({ x: 0, y: 0, width: 0, height: 0 }), false);
    assert.equal(ok({ x: 0, y: 0, width: -5, height: 10 }), false);
    for (const bad of [NaN, Infinity, '5', null, undefined]) {
      assert.equal(ok({ x: 0, y: 0, width: bad, height: 10 }), false, `width ${String(bad)}`);
      assert.equal(ok({ x: bad, y: 0, width: 10, height: 10 }), false, `x ${String(bad)}`);
      assert.equal(ok({ x: 0, y: bad, width: 10, height: 10 }), false, `y ${String(bad)}`);
    }
  });

  it('rect may start 1 px outside the top left of the viewport, not more', () => {
    const ok = (/** @type {number} */ x, /** @type {number} */ y) =>
      isFrameMeta({ ...validMeta(), rect: { x, y, width: 100, height: 100 } });
    assert.equal(ok(-1, -1), true);
    assert.equal(ok(-1.01, 0), false);
    assert.equal(ok(0, -1.01), false);
    assert.equal(ok(-50, 0), false);
  });

  it('rect may end 1 px outside the bottom right of the viewport, not more', () => {
    const viewport = { width: 1000, height: 800 };
    const ok = (/** @type {any} */ rect) => isFrameMeta({ ...validMeta(), viewport, rect });
    assert.equal(ok({ x: 0, y: 0, width: 1000, height: 800 }), true);
    assert.equal(ok({ x: 0, y: 0, width: 1001, height: 801 }), true, '1 px tolerance');
    assert.equal(ok({ x: 0, y: 0, width: 1001.01, height: 800 }), false);
    assert.equal(ok({ x: 0, y: 0, width: 1000, height: 801.01 }), false);
    assert.equal(ok({ x: 500, y: 0, width: 501, height: 800 }), true);
    assert.equal(ok({ x: 500, y: 0, width: 502, height: 800 }), false);
    assert.equal(ok({ x: 0, y: 400, width: 100, height: 401 }), true);
    assert.equal(ok({ x: 0, y: 400, width: 100, height: 402 }), false);
  });

  it('contentY must be finite, at least -1 and at most 10 million', () => {
    for (const contentY of [-1, 0, 123.5, 200_000, 9_999_999, 10_000_000]) {
      assert.equal(isFrameMeta({ ...validMeta(), contentY }), true, String(contentY));
    }
    const bad = [-1.01, -100, NaN, Infinity, -Infinity, '0', null, undefined];
    for (const contentY of [...bad, 10_000_000.5, 10_000_001, 30_000_000, 1e9, Number.MAX_VALUE]) {
      assert.equal(isFrameMeta({ ...validMeta(), contentY }), false, String(contentY));
    }
  });

});

describe('routeCheck', () => {
  describe('messages that are not for this receiver', () => {
    it('returns null for a different target', () => {
      for (const [type, spec] of Object.entries(CONTRACT)) {
        const msg = makeMessage(type, spec.fields());
        const other = spec.target === 'sw' ? TARGET.OFFSCREEN : TARGET.SW;
        const sender = senderOf(spec.from[0] ?? 'unknown');
        assert.equal(routeCheck(msg, sender, other, ENV), null, type);
      }
    });

    it('returns null for something that is not a plain message object', () => {
      for (const msg of [null, undefined, 'text', 5, true, [], [{ target: 'sw' }]]) {
        assert.equal(routeCheck(msg, senderOf('content'), TARGET.SW, ENV), null, String(msg));
      }
    });

    it('returns null when the target field is missing, wrong or of another type', () => {
      for (const target of [undefined, null, 'SW', 'service-worker', 5, ['sw'], {}]) {
        const msg = { v: 1, target, type: MSG.PAGE_FINISH, sessionId: SESSION_ID };
        assert.equal(routeCheck(msg, senderOf('content'), TARGET.SW, ENV), null, String(target));
      }
    });

    it('returns null before looking at the sender', () => {
      const msg = { v: 99, target: 'offscreen', type: 'garbage' };
      assert.equal(routeCheck(msg, undefined, TARGET.SW, ENV), null);
    });
  });

  describe('every message type', () => {
    for (const [type, spec] of Object.entries(CONTRACT)) {
      describe(type, () => {
        const target = spec.target;
        const fresh = () => makeMessage(type, spec.fields());

        it('accepts a valid message from each allowed sender kind', () => {
          for (const kind of spec.from) {
            assert.deepEqual(routeCheck(fresh(), senderOf(kind), target, ENV), {
              ok: true,
              type,
              kind,
            });
          }
        });

        it('refuses every sender kind that is not allowed', () => {
          for (const kind of /** @type {(keyof typeof SENDERS)[]} */ (Object.keys(SENDERS))) {
            if (spec.from.includes(kind)) continue;
            assert.deepEqual(
              routeCheck(fresh(), senderOf(kind), target, ENV),
              errorResponse(ERR.FORBIDDEN_SENDER, 'Sender not allowed.'),
              `${type} from ${kind}`,
            );
          }
          assert.equal(routeCheck(fresh(), undefined, target, ENV)?.ok, false);
        });

        it('refuses a sub frame of the content script', () => {
          if (!spec.from.includes('content')) return;
          const sub = { ...SENDERS.content, frameId: 3 };
          assert.deepEqual(
            routeCheck(fresh(), /** @type {any} */ (sub), target, ENV),
            errorResponse(ERR.FORBIDDEN_SENDER, 'Sender not allowed.'),
          );
        });

        it('refuses a bad protocol version', () => {
          for (const v of [0, 2, '1', 1.5, null, undefined, true, [1]]) {
            assert.deepEqual(
              routeCheck({ ...fresh(), v }, senderOf(spec.from[0] ?? 'unknown'), target, ENV),
              errorResponse(ERR.BAD_MESSAGE, 'Unsupported message.'),
              `v = ${String(v)}`,
            );
          }
          const noVersion = fresh();
          delete noVersion.v;
          assert.equal(
            routeCheck(noVersion, senderOf(spec.from[0] ?? 'unknown'), target, ENV)?.ok,
            false,
          );
        });

        it('refuses an extra field, and names it', () => {
          const result = routeCheck(
            { ...fresh(), extra: 'x' },
            senderOf(spec.from[0] ?? 'unknown'),
            target,
            ENV,
          );
          assert.deepEqual(result, errorResponse(ERR.BAD_MESSAGE, 'Unexpected field: extra'));
          // A tab id in a message of the page is the typical attack: it must not be accepted
          // for a type that does not declare it.
          if (!Object.hasOwn(spec.fields(), 'tabId')) {
            assert.deepEqual(
              routeCheck(
                { ...fresh(), tabId: 5 },
                senderOf(spec.from[0] ?? 'unknown'),
                target,
                ENV,
              ),
              errorResponse(ERR.BAD_MESSAGE, 'Unexpected field: tabId'),
            );
          }
        });

        for (const field of Object.keys(spec.fields())) {
          it(`refuses a missing field ${field}`, () => {
            const msg = fresh();
            delete msg[field];
            assert.deepEqual(
              routeCheck(msg, senderOf(spec.from[0] ?? 'unknown'), target, ENV),
              errorResponse(ERR.BAD_MESSAGE, `Bad field: ${field}`),
            );
          });

          it(`refuses bad values of ${field}`, () => {
            const bad = /** @type {Record<string, unknown[]>} */ (BAD_VALUES)[field];
            assert.ok(bad, `test values for ${field}`);
            for (const value of bad) {
              const result = routeCheck(
                { ...fresh(), [field]: value },
                senderOf(spec.from[0] ?? 'unknown'),
                target,
                ENV,
              );
              assert.deepEqual(
                result,
                errorResponse(ERR.BAD_MESSAGE, `Bad field: ${field}`),
                `${type}.${field} = ${JSON.stringify(value)?.slice(0, 60)}`,
              );
            }
          });
        }
      });
    }
  });

  describe('unknown and spoofed types', () => {
    it('refuses an unknown type with the right target', () => {
      for (const type of ['page/unknown', 'sw/', '', 'PAGE/FINISH', ' page/finish']) {
        assert.deepEqual(
          routeCheck({ v: 1, target: 'sw', type }, senderOf('content'), TARGET.SW, ENV),
          errorResponse(ERR.BAD_MESSAGE, 'Unknown message.'),
          JSON.stringify(type),
        );
      }
    });

    it('refuses a type that is not a string', () => {
      for (const type of [undefined, null, 5, {}, ['page/finish'], true]) {
        assert.deepEqual(
          routeCheck({ v: 1, target: 'sw', type }, senderOf('content'), TARGET.SW, ENV),
          errorResponse(ERR.BAD_MESSAGE, 'Unsupported message.'),
          String(type),
        );
      }
    });

    it('does not read types from the prototype of the spec table', () => {
      for (const type of ['constructor', 'toString', '__proto__', 'hasOwnProperty', 'valueOf']) {
        assert.deepEqual(
          routeCheck({ v: 1, target: 'sw', type }, senderOf('content'), TARGET.SW, ENV),
          errorResponse(ERR.BAD_MESSAGE, 'Unknown message.'),
          type,
        );
      }
    });

    it('refuses a type that belongs to the other target', () => {
      // A message that claims target "sw" but carries an offscreen type, and the reverse.
      assert.deepEqual(
        routeCheck(
          { v: 1, target: 'sw', type: MSG.OFF_PING },
          senderOf('worker'),
          TARGET.SW,
          ENV,
        ),
        errorResponse(ERR.BAD_MESSAGE, 'Unknown message.'),
      );
      assert.deepEqual(
        routeCheck(
          { v: 1, target: 'offscreen', type: MSG.PAGE_FINISH, sessionId: SESSION_ID },
          senderOf('content'),
          TARGET.OFFSCREEN,
          ENV,
        ),
        errorResponse(ERR.BAD_MESSAGE, 'Unknown message.'),
      );
    });
  });

  describe('order of the checks', () => {
    const good = () => makeMessage(MSG.PAGE_FINISH, { sessionId: SESSION_ID });

    it('version before sender', () => {
      assert.deepEqual(
        routeCheck({ ...good(), v: 2 }, senderOf('unknown'), TARGET.SW, ENV),
        errorResponse(ERR.BAD_MESSAGE, 'Unsupported message.'),
      );
    });

    it('sender before extra fields and bad fields', () => {
      assert.deepEqual(
        routeCheck({ ...good(), extra: 1 }, senderOf('result'), TARGET.SW, ENV),
        errorResponse(ERR.FORBIDDEN_SENDER, 'Sender not allowed.'),
      );
      assert.deepEqual(
        routeCheck({ ...good(), sessionId: 'x' }, senderOf('result'), TARGET.SW, ENV),
        errorResponse(ERR.FORBIDDEN_SENDER, 'Sender not allowed.'),
      );
    });

    it('extra fields before bad fields', () => {
      assert.deepEqual(
        routeCheck({ ...good(), sessionId: 'x', extra: 1 }, senderOf('content'), TARGET.SW, ENV),
        errorResponse(ERR.BAD_MESSAGE, 'Unexpected field: extra'),
      );
    });
  });

  describe('hostile input', () => {
    it('refuses an own __proto__ key (as JSON.parse creates it)', () => {
      const msg = JSON.parse(
        `{"v":1,"target":"sw","type":"page/finish","sessionId":"${SESSION_ID}",` +
          '"__proto__":{"x":1}}',
      );
      assert.deepEqual(
        routeCheck(msg, senderOf('content'), TARGET.SW, ENV),
        errorResponse(ERR.BAD_MESSAGE, 'Unexpected field: __proto__'),
      );
    });

    // Original case, kept as it was. Its name says the opposite of what it asserts: it asserts
    // that the inherited field IS accepted. See the case after it.
    it('does not accept inherited fields as present fields', () => {
      const proto = { sessionId: SESSION_ID };
      const own = { v: 1, target: 'sw', type: MSG.PAGE_FINISH };
      const msg = Object.assign(Object.create(proto), own);
      // `sessionId` exists only on the prototype. The check reads msg[name], so it passes.
      // This documents the behaviour: runtime messages are JSON, so they have no prototype.
      const result = routeCheck(msg, senderOf('content'), TARGET.SW, ENV);
      assert.ok(result && result.ok === true);
    });

    // Added by mutation testing. Documents the current behaviour under a name that says what the
    // code does: it reads `msg[name]`, so a field that exists only on the prototype counts as
    // present. Runtime messages are structured clones (plain objects), so a real message never
    // has a prototype chain.
    it('accepts a required field that only the prototype of the message has', () => {
      const proto = { sessionId: SESSION_ID };
      const own = { v: 1, target: 'sw', type: MSG.PAGE_FINISH };
      const msg = Object.assign(Object.create(proto), own);
      const result = routeCheck(msg, senderOf('content'), TARGET.SW, ENV);
      assert.deepEqual(result, { ok: true, type: 'page/finish', kind: 'content' });
    });

    // Original case, kept as it was. It only checks that nothing throws, not what comes back.
    it('does not throw for any odd message', () => {
      const odd = [
        Object.create(null),
        Object.assign(Object.create(null), { v: 1, target: 'sw', type: 'page/finish' }),
        new Date(),
        new Map(),
        { v: 1, target: 'sw', type: 'page/finish', sessionId: { toString: () => SESSION_ID } },
      ];
      for (const msg of odd) {
        assert.doesNotThrow(() => routeCheck(msg, senderOf('content'), TARGET.SW, ENV));
      }
    });

    // Added by mutation testing: the same odd messages, with the answer that each one must get.
    it('gives a defined answer for every odd message, and never throws', () => {
      const content = senderOf('content');
      const finish = { v: 1, target: 'sw', type: 'page/finish' };
      /** @type {[string, unknown, unknown][]} */
      const odd = [
        // Not addressed to this receiver: null.
        ['null-prototype object without a target', Object.create(null), null],
        ['a Date', new Date(), null],
        ['a Map', new Map(), null],
        // A null-prototype object is still a plain message object, so it is checked in full.
        [
          'null-prototype message without its field',
          Object.assign(Object.create(null), finish),
          errorResponse(ERR.BAD_MESSAGE, 'Bad field: sessionId'),
        ],
        [
          'null-prototype message with its field',
          Object.assign(Object.create(null), finish, { sessionId: SESSION_ID }),
          { ok: true, type: 'page/finish', kind: 'content' },
        ],
        // A string-like object is not a string.
        [
          'an object that prints as a session id',
          { ...finish, sessionId: { toString: () => SESSION_ID } },
          errorResponse(ERR.BAD_MESSAGE, 'Bad field: sessionId'),
        ],
        // A key counts as a field even when its value is undefined (JSON would drop it, a
        // structured clone does not).
        [
          'an extra key whose value is undefined',
          { ...finish, sessionId: SESSION_ID, extra: undefined },
          errorResponse(ERR.BAD_MESSAGE, 'Unexpected field: extra'),
        ],
      ];
      for (const [label, msg, expected] of odd) {
        assert.deepEqual(routeCheck(msg, content, TARGET.SW, ENV), expected, label);
      }
    });

    it('accepts a title of exactly 512 characters and refuses 513', () => {
      const make = (/** @type {number} */ n) =>
        makeMessage(MSG.PAGE_SESSION_OPEN, { sessionId: SESSION_ID, title: 'x'.repeat(n) });
      assert.equal(routeCheck(make(512), senderOf('content'), TARGET.SW, ENV)?.ok, true);
      assert.equal(routeCheck(make(0), senderOf('content'), TARGET.SW, ENV)?.ok, true);
      assert.equal(routeCheck(make(513), senderOf('content'), TARGET.SW, ENV)?.ok, false);
    });

    it('accepts a PNG data URL of exactly 60 MiB and refuses one character more', () => {
      const limit = 60 * 1024 * 1024;
      const body = (/** @type {number} */ total) =>
        PNG_PREFIX + 'A'.repeat(total - PNG_PREFIX.length);
      const make = (/** @type {string} */ dataUrl) =>
        makeMessage(MSG.OFF_ADD_FRAME, {
          sessionId: SESSION_ID,
          tabId: 5,
          dataUrl,
          meta: validMeta(),
        });
      const accepted = routeCheck(make(body(limit)), senderOf('worker'), TARGET.OFFSCREEN, ENV);
      assert.equal(accepted?.ok, true);
      assert.deepEqual(
        routeCheck(make(body(limit + 1)), senderOf('worker'), TARGET.OFFSCREEN, ENV),
        errorResponse(ERR.BAD_MESSAGE, 'Bad field: dataUrl'),
      );
    });

    it('accepts tab id 0 and refuses tab id -1 (chrome.tabs.TAB_ID_NONE)', () => {
      const make = (/** @type {number} */ tabId) => makeMessage(MSG.OFF_DROP_TAB, { tabId });
      assert.equal(routeCheck(make(0), senderOf('worker'), TARGET.OFFSCREEN, ENV)?.ok, true);
      assert.equal(routeCheck(make(-1), senderOf('worker'), TARGET.OFFSCREEN, ENV)?.ok, false);
    });

    it('session-drop needs a tab id', () => {
      const worker = senderOf('worker');
      const drop = (/** @type {Record<string, unknown>} */ f) =>
        makeMessage(MSG.OFF_SESSION_DROP, f);
      assert.equal(
        routeCheck(drop({ sessionId: SESSION_ID, tabId: 0 }), worker, TARGET.OFFSCREEN, ENV)?.ok,
        true,
      );
      assert.deepEqual(
        routeCheck(drop({ sessionId: SESSION_ID }), worker, TARGET.OFFSCREEN, ENV),
        errorResponse(ERR.BAD_MESSAGE, 'Bad field: tabId'),
      );
    });

    it('no page of the extension can drop a session by itself', () => {
      // Only the worker sends the offscreen write messages. The content script asks the worker
      // (page/cancel).
      for (const [type, fields] of /** @type {const} */ ([
        [MSG.OFF_SESSION_DROP, { sessionId: SESSION_ID, tabId: 5 }],
      ])) {
        for (const kind of /** @type {const} */ (['result', 'options', 'offscreen', 'content'])) {
          assert.deepEqual(
            routeCheck(makeMessage(type, fields), senderOf(kind), TARGET.OFFSCREEN, ENV),
            errorResponse(ERR.FORBIDDEN_SENDER, 'Sender not allowed.'),
            `${type} from ${kind}`,
          );
        }
      }
    });

    it('refuses an offscreen write message from a sender without a URL', () => {
      // Before, "this extension, no URL, no tab" counted as the worker. Now it is unknown.
      const noUrl = /** @type {any} */ ({ id: RUNTIME_ID });
      for (const [type, fields] of /** @type {const} */ ([
        [MSG.OFF_SESSION_DROP, { sessionId: SESSION_ID, tabId: 5 }],
        [MSG.OFF_DROP_TAB, { tabId: 5 }],
        [MSG.OFF_PING, {}],
      ])) {
        assert.deepEqual(
          routeCheck(makeMessage(type, fields), noUrl, TARGET.OFFSCREEN, ENV),
          errorResponse(ERR.FORBIDDEN_SENDER, 'Sender not allowed.'),
          type,
        );
      }
    });

    it('accepts both tile tiers for session-open and nothing else', () => {
      const make = (/** @type {unknown} */ tileTier) =>
        makeMessage(MSG.OFF_SESSION_OPEN, {
          sessionId: SESSION_ID,
          tabId: 1,
          title: '',
          host: '',
          tileTier,
        });
      for (const tier of ['high', 'standard']) {
        assert.equal(routeCheck(make(tier), senderOf('worker'), TARGET.OFFSCREEN, ENV)?.ok, true);
      }
      const refused = routeCheck(make('medium'), senderOf('worker'), TARGET.OFFSCREEN, ENV);
      assert.equal(refused?.ok, false);
    });
  });
});
// ---------------------------------------------------------------------------------------------
// Added by mutation testing. Cases only: nothing above changed.
// ---------------------------------------------------------------------------------------------

describe('error codes on the wire', () => {
  // The strings are a wire contract: page scripts cannot import this module, and the table in
  // docs/contracts.md section 3 lists them. The table here is written out by hand on purpose.
  it('keeps the code strings of docs/contracts.md section 3', () => {
    const wire = {
      BAD_MESSAGE: 'E_BAD_MESSAGE',
      FORBIDDEN_SENDER: 'E_FORBIDDEN_SENDER',
      TAB_NOT_VISIBLE: 'E_TAB_NOT_VISIBLE',
      CAPTURE_FAILED: 'E_CAPTURE_FAILED',
      SESSION_NOT_FOUND: 'E_SESSION_NOT_FOUND',
      SESSION_TOO_LARGE: 'E_SESSION_TOO_LARGE',
      INTERNAL: 'E_INTERNAL',
    };
    for (const [name, code] of Object.entries(wire)) {
      assert.equal(/** @type {Record<string, string>} */ (ERR)[name], code, name);
    }
  });

  it('puts the code of a SpoolError into the reply, for every code', () => {
    for (const code of Object.values(ERR)) {
      assert.deepEqual(toErrorResponse(new SpoolError(code, 'Text.')), errorResponse(code, 'Text.'));
    }
  });
});

describe('isFrameMeta: the viewport', () => {
  it('refuses a viewport side of 0 or less when the rect still fits through the 1 px tolerance', () => {
    // x -1 and width 1 end at 0, which is within 0 + 1. Only the viewport check can refuse it.
    const rect = { x: -1, y: -1, width: 1, height: 1 };
    const viewports = [
      { width: 0, height: 800 },
      { width: 1280, height: 0 },
      { width: -0.5, height: 800 },
      { width: 1280, height: -0.5 },
    ];
    for (const viewport of viewports) {
      assert.equal(isFrameMeta({ ...validMeta(), viewport, rect }), false, JSON.stringify(viewport));
    }
  });

  it('accepts the smallest viewport, 1 x 1, with a 1 x 1 rect', () => {
    const meta = {
      ...validMeta(),
      viewport: { width: 1, height: 1 },
      rect: { x: 0, y: 0, width: 1, height: 1 },
    };
    assert.equal(isFrameMeta(meta), true);
  });
});
describe('sw/download and offscreen/finalize: limits', () => {
  // Boundary cases that a mutation run of the post-capture validators (isDownloadPath, the blob
  // URL check, the file list and the folder name) found untested. The limits come from
  // src/shared/constants.js (MAX_DOWNLOAD_*) and are read from there, not copied.
  const BLOB = `blob:chrome-extension://${RUNTIME_ID}/6f1c2e84-3b7a-4d19-8c55-0a9e4b2d7f13`;
  const entry = (/** @type {string} */ path, url = BLOB) => ({ path, url });
  const download = (/** @type {unknown} */ files) =>
    routeCheck(makeMessage('sw/download', { files }), senderOf('offscreen'), TARGET.SW, ENV);
  const accepted = { ok: true, type: 'sw/download', kind: 'offscreen' };
  const refused = errorResponse(ERR.BAD_MESSAGE, 'Bad field: files');
  const segment = (/** @type {number} */ n) => 'a'.repeat(n);

  it('accepts exactly MAX_DOWNLOAD_FILES files and refuses one more', async () => {
    const { MAX_DOWNLOAD_FILES } = await import('../../src/shared/constants.js');
    const list = (/** @type {number} */ n) => Array.from({ length: n }, () => entry('a.png'));
    assert.deepEqual(download(list(MAX_DOWNLOAD_FILES)), accepted);
    assert.deepEqual(download(list(MAX_DOWNLOAD_FILES + 1)), refused);
    assert.deepEqual(download(list(1)), accepted);
    assert.deepEqual(download(list(0)), refused);
  });

  it('accepts a path of exactly MAX_DOWNLOAD_PATH_LENGTH characters and refuses one more', async () => {
    const { MAX_DOWNLOAD_PATH_LENGTH } = await import('../../src/shared/constants.js');
    // 3 slashes and 4 segments of at most 100 characters each.
    const pathOfLength = (/** @type {number} */ total) => {
      const rest = total - 3;
      return [segment(100), segment(100), segment(100), segment(rest - 300)].join('/');
    };
    assert.equal(pathOfLength(MAX_DOWNLOAD_PATH_LENGTH).length, MAX_DOWNLOAD_PATH_LENGTH);
    assert.deepEqual(download([entry(pathOfLength(MAX_DOWNLOAD_PATH_LENGTH))]), accepted);
    assert.deepEqual(download([entry(pathOfLength(MAX_DOWNLOAD_PATH_LENGTH + 1))]), refused);
  });

  it('accepts MAX_DOWNLOAD_PATH_SEGMENTS folder levels and refuses one more', async () => {
    const { MAX_DOWNLOAD_PATH_SEGMENTS } = await import('../../src/shared/constants.js');
    const levels = (/** @type {number} */ n) =>
      Array.from({ length: n }, (_, i) => `d${i}`).join('/') + '/f.png';
    // The file name counts as a segment: n - 1 folders and a file.
    assert.deepEqual(download([entry(levels(MAX_DOWNLOAD_PATH_SEGMENTS - 1))]), accepted);
    assert.deepEqual(download([entry(levels(MAX_DOWNLOAD_PATH_SEGMENTS))]), refused);
  });

  it('accepts a segment of 120 characters and refuses one of 121', () => {
    assert.deepEqual(download([entry(`${segment(120)}`)]), accepted);
    assert.deepEqual(download([entry(`${segment(121)}`)]), refused);
    assert.deepEqual(download([entry(`Spool/${segment(121)}.png`)]), refused);
  });

  it('refuses an empty path and a path that is not a string', () => {
    for (const path of ['', undefined, null, 5, ['a.png']]) {
      assert.deepEqual(download([entry(/** @type {any} */ (path))]), refused, String(path));
    }
  });

  it('accepts a blob URL of this extension only, with an id of 1 to 64 characters', () => {
    const uuid = '6f1c2e84-3b7a-4d19-8c55-0a9e4b2d7f13';
    const url = (/** @type {string} */ id) => `blob:chrome-extension://${id}/${uuid}`;
    assert.deepEqual(download([entry('a.png', url('a'))]), accepted);
    assert.deepEqual(download([entry('a.png', url('a'.repeat(64)))]), accepted);
    assert.deepEqual(download([entry('a.png', url('a'.repeat(65)))]), refused);
    assert.deepEqual(download([entry('a.png', url(''))]), refused);
    assert.deepEqual(download([entry('a.png', url('UPPER'))]), refused);
    // Text in front of the URL must not pass: the pattern starts at the first character.
    assert.deepEqual(download([entry('a.png', `x${url('a')}`)]), refused);
    assert.deepEqual(download([entry('a.png', ` ${url('a')}`)]), refused);
    assert.deepEqual(download([entry('a.png', `${url('a')}\n`)]), refused);
    assert.deepEqual(download([entry('a.png', url('a').toUpperCase())]), refused);
  });

  it('accepts a folder name of exactly 40 characters and refuses 41', () => {
    const finalize = (/** @type {string} */ folderName) =>
      routeCheck(
        makeMessage('offscreen/finalize', {
          sessionId: SESSION_ID,
          tabId: 5,
          saveTiles: true,
          saveFull: true,
          folderName,
        }),
        senderOf('worker'),
        TARGET.OFFSCREEN,
        ENV,
      );
    assert.equal(finalize('x'.repeat(40))?.ok, true);
    assert.deepEqual(finalize('x'.repeat(41)), errorResponse(ERR.BAD_MESSAGE, 'Bad field: folderName'));
  });
});

describe('offscreen/session-open: the host name of the captured page', () => {
  const open = (/** @type {unknown} */ host) =>
    routeCheck(
      makeMessage('offscreen/session-open', {
        sessionId: SESSION_ID,
        tabId: 5,
        title: 'A page',
        host,
        tileTier: 'high',
      }),
      senderOf('worker'),
      TARGET.OFFSCREEN,
      ENV,
    );

  it('accepts what URL.hostname gives, and an empty host (a local file)', () => {
    for (const host of [
      'github.com',
      'a-b_c.example.co.uk',
      'localhost',
      '127.0.0.1',
      '[::1]',
      '[2001:db8::1]',
      'xn--bcher-kva.example',
      '',
      'a'.repeat(253),
    ]) {
      assert.deepEqual(open(host), { ok: true, type: 'offscreen/session-open', kind: 'worker' }, host);
    }
  });

  it('refuses anything that is more than a host name: a path, a port, a scheme, upper case', () => {
    const refused = errorResponse(ERR.BAD_MESSAGE, 'Bad field: host');
    for (const host of [
      'github.com/pulls',
      'github.com:443',
      'https://github.com',
      'user@github.com',
      'GitHub.com',
      'git hub.com',
      'github.com?x=1',
      'github.com#top',
      'münchen.de',
      'a'.repeat(254),
      7,
      null,
      undefined,
      ['github.com'],
    ]) {
      assert.deepEqual(open(host), refused, JSON.stringify(host));
    }
  });

  it('needs the field: a message without a host is refused', () => {
    const message = makeMessage('offscreen/session-open', {
      sessionId: SESSION_ID,
      tabId: 5,
      title: 'A page',
      tileTier: 'high',
    });
    assert.deepEqual(
      routeCheck(message, senderOf('worker'), TARGET.OFFSCREEN, ENV),
      errorResponse(ERR.BAD_MESSAGE, 'Bad field: host'),
    );
  });

  it('page/session-open has no host: the page cannot say where it is', () => {
    const message = makeMessage('page/session-open', {
      sessionId: SESSION_ID,
      title: 'A page',
      host: 'bank.example',
    });
    assert.deepEqual(
      routeCheck(message, senderOf('content'), TARGET.SW, ENV),
      errorResponse(ERR.BAD_MESSAGE, 'Unexpected field: host'),
    );
  });
});

describe('page/show-in-folder', () => {
  const show = (/** @type {Record<string, unknown>} */ fields, kind = 'content') =>
    routeCheck(
      makeMessage('page/show-in-folder', fields),
      senderOf(/** @type {any} */ (kind)),
      TARGET.SW,
      ENV,
    );

  it('takes a session ID from a content script, and nothing else', () => {
    assert.deepEqual(show({ sessionId: SESSION_ID }), {
      ok: true,
      type: 'page/show-in-folder',
      kind: 'content',
    });
    assert.deepEqual(
      show({ sessionId: SESSION_ID, path: 'C:\\Users' }),
      errorResponse(ERR.BAD_MESSAGE, 'Unexpected field: path'),
    );
    assert.deepEqual(show({ sessionId: 'x' }), errorResponse(ERR.BAD_MESSAGE, 'Bad field: sessionId'));
    assert.deepEqual(show({}), errorResponse(ERR.BAD_MESSAGE, 'Bad field: sessionId'));
  });

  it('is refused from every sender except a content script', () => {
    for (const kind of ['worker', 'offscreen', 'result', 'options', 'unknown']) {
      assert.deepEqual(
        show({ sessionId: SESSION_ID }, kind),
        errorResponse(ERR.FORBIDDEN_SENDER, 'Sender not allowed.'),
        kind,
      );
    }
  });
});

describe('page/open-options: the sections of the options page', () => {
  const open = (/** @type {unknown} */ section) =>
    routeCheck(makeMessage('page/open-options', { section }), senderOf('content'), TARGET.SW, ENV);

  it('accepts save, setup and reconnect', () => {
    for (const section of ['save', 'setup', 'reconnect']) {
      assert.deepEqual(open(section), { ok: true, type: 'page/open-options', kind: 'content' }, section);
    }
  });

  it('accepts nothing else: not another page of the extension, not a script, not a type', () => {
    const refused = errorResponse(ERR.BAD_MESSAGE, 'Bad field: section');
    for (const section of [
      'welcome', // Only the worker opens it, on install.
      'Save',
      'save ',
      '#save',
      '../result/result.html',
      'javascript:alert(1)',
      '',
      7,
      null,
      undefined,
      ['save'],
      { toString: () => 'save' },
    ]) {
      assert.deepEqual(open(section), refused, JSON.stringify(section));
    }
  });

  it('OPTIONS_SECTIONS lists exactly these three', async () => {
    const { OPTIONS_SECTIONS } = await import('../../src/shared/constants.js');
    assert.deepEqual([...OPTIONS_SECTIONS].sort(), ['reconnect', 'save', 'setup']);
  });
});

describe('offscreen/finalize: a folder name that needed several passes', () => {
  const finalize = (/** @type {unknown} */ folderName) =>
    routeCheck(
      makeMessage('offscreen/finalize', {
        sessionId: SESSION_ID,
        tabId: 5,
        saveTiles: true,
        saveFull: true,
        folderName,
      }),
      senderOf('worker'),
      TARGET.OFFSCREEN,
      ENV,
    );

  it('accepts the folder name that the settings keep for my.{x}.{y}', async () => {
    const { normalizeSettings } = await import('../../src/shared/settings.js');
    const kept = normalizeSettings({ folderName: 'my.{x}.{y}' }).folderName;
    assert.equal(kept, 'my_{x}_{y}');
    assert.deepEqual(finalize(kept), { ok: true, type: 'offscreen/finalize', kind: 'worker' });
    // The saved value goes through the settings again at every start: it must not move.
    assert.equal(normalizeSettings({ folderName: kept }).folderName, kept);
  });

  it('still refuses a name that is not clean', () => {
    assert.deepEqual(finalize('my.{x}.{y}'), errorResponse(ERR.BAD_MESSAGE, 'Bad field: folderName'));
  });
});
