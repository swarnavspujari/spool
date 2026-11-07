// @ts-check
/**
 * The shelf command `insert-capture` (docs/contracts.md 7.1 step 5 and 7.8): the worker injects the
 * page scripts with `config.mode = 'shelf'` and a new token for the tab, and registers the token
 * with the offscreen document (only when one exists, and only when no agent is active).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { COMMANDS, PAGE_MODES, PATHS } from '../../src/shared/constants.js';
import { ERR, MSG, TARGET, isToken } from '../../src/shared/protocol.js';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';
import {
  BADGE_CLEAR_MS,
  INSERT_COMMAND,
  MSG_INJECT_FAILED,
  MSG_RESTRICTED,
  START_COMMAND,
  createStarter,
} from '../../src/sw/start.js';
import { closeIfIdle } from '../../src/sw/offscreen-client.js';
import { installFakeChrome, macrotask } from '../helpers/fake-chrome.js';

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';
const TOKEN_A = '0c9d6a52-7b1e-4f3a-9a40-2d8e5b7c1f66';
const TOKEN_B = '9a7e1d34-2c58-4e0b-8f63-1b4d7a9c2e05';

/** @param {Parameters<typeof createStarter>[0]} [extra] */
function makeStarter(extra = {}) {
  /** @type {{ token: string, tabId: number }[]} */
  const registered = [];
  /** @type {string[]} */
  const tokens = [TOKEN_A, TOKEN_B];
  const starter = createStarter({
    schedule: () => 0,
    cancel: () => {},
    newSessionId: () => SESSION_ID,
    newToken: () => tokens.shift() ?? TOKEN_B,
    registerShelfToken: async (token, tabId) => {
      registered.push({ token, tabId });
    },
    ...extra,
  });
  return { ...starter, registered };
}

describe('constants of the commands', () => {
  it('names the two commands of the manifest', () => {
    assert.equal(START_COMMAND, 'start-capture');
    assert.equal(INSERT_COMMAND, 'insert-capture');
    assert.deepEqual({ ...COMMANDS }, { START: 'start-capture', INSERT: 'insert-capture' });
  });
});

describe('startShelf', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  const tab = /** @type {any} */ ({ id: 7, url: 'https://example.com/' });

  /** @returns {any[]} The injections of the fake, in order. */
  const injections = () => fake.argsOf('scripting.executeScript').map((a) => a[0]);

  it('injects the config in shelf mode with a token, then the scripts, then starts', async () => {
    const s = makeStarter();
    await s.startShelf(tab);
    const [config, files, start] = injections();
    assert.equal(config.args.length, 1);
    const cfg = config.args[0];
    assert.equal(cfg.mode, 'shelf');
    assert.equal(cfg.mode, PAGE_MODES.SHELF);
    assert.equal(cfg.shelfToken, TOKEN_A);
    assert.ok(isToken(cfg.shelfToken));
    assert.equal(cfg.sessionId, SESSION_ID);
    assert.deepEqual(cfg.settings, { ...DEFAULT_SETTINGS });
    assert.deepEqual(cfg.msg.PAGE_SHELF_INFO, MSG.PAGE_SHELF_INFO);
    assert.deepEqual(cfg.target, { ...TARGET });
    assert.deepEqual(cfg.err, { ...ERR });
    assert.deepEqual(files.files, PATHS.pageScripts);
    assert.equal(typeof start.func, 'function');
    assert.deepEqual(config.target, { tabId: 7, frameIds: [0] });
    assert.equal(fake.argsOf('action.setBadgeText').length, 0, 'no badge on success');
  });

  it('registers the token for the tab after the config and before the agent starts', async () => {
    /** @type {string[]} */
    const order = [];
    fake.behavior.executeScript = async (injection) => {
      order.push(injection.files ? 'files' : injection.args ? 'config' : 'start');
      if (injection.files) return [{ frameId: 0 }];
      return [{ frameId: 0, result: !injection.args }];
    };
    const s = makeStarter({
      registerShelfToken: async () => {
        order.push('register');
      },
    });
    await s.startShelf(tab);
    assert.deepEqual(order, ['config', 'register', 'files', 'start']);
  });

  it('registers the token that is in the config, with the tab', async () => {
    const s = makeStarter();
    await s.startShelf(tab);
    assert.deepEqual(s.registered, [{ token: TOKEN_A, tabId: 7 }]);
  });

  it('uses a new token for each press', async () => {
    const s = makeStarter();
    await s.startShelf(tab);
    await s.startShelf(tab);
    assert.deepEqual(
      s.registered.map((r) => r.token),
      [TOKEN_A, TOKEN_B],
    );
    const configs = injections().filter((i) => i.args);
    assert.deepEqual(
      configs.map((c) => c.args[0].shelfToken),
      [TOKEN_A, TOKEN_B],
    );
  });

  it('does not register a token when an agent is active (a capture or an open shelf)', async () => {
    fake.behavior.executeScript = async () => [{ frameId: 0, result: true }];
    const s = makeStarter();
    await s.startShelf(tab);
    assert.deepEqual(s.registered, []);
    assert.equal(injections().length, 1, 'stops after the config step');
    assert.equal(fake.argsOf('action.setBadgeText').length, 0, 'not an error');
  });

  it('shows the badge and does not start when the token cannot be registered', async () => {
    const s = makeStarter({
      registerShelfToken: async () => {
        throw new Error('offscreen is gone');
      },
    });
    await s.startShelf(tab);
    assert.equal(injections().filter((i) => i.files || (!i.args && i.func)).length, 0);
    assert.deepEqual(fake.argsOf('action.setBadgeText'), [[{ tabId: 7, text: '!' }]]);
    assert.deepEqual(fake.argsOf('action.setTitle'), [[{ tabId: 7, title: MSG_INJECT_FAILED }]]);
  });

  it('shows the badge when the page scripts do not register an agent', async () => {
    fake.behavior.executeScript = async (injection) => {
      if (injection.files) return [{ frameId: 0 }];
      return [{ frameId: 0, result: injection.args ? false : false }];
    };
    const s = makeStarter();
    await s.startShelf(tab);
    assert.deepEqual(fake.argsOf('action.setTitle'), [[{ tabId: 7, title: MSG_INJECT_FAILED }]]);
  });

  it('refuses a restricted page with the badge and injects nothing', async () => {
    const s = makeStarter();
    await s.startShelf(/** @type {any} */ ({ id: 7, url: 'chrome://extensions/' }));
    assert.equal(injections().length, 0);
    assert.deepEqual(s.registered, []);
    assert.deepEqual(fake.argsOf('action.setTitle'), [[{ tabId: 7, title: MSG_RESTRICTED }]]);
    assert.equal(BADGE_CLEAR_MS, 4000);
  });

  it('ignores a tab without an id', async () => {
    const s = makeStarter();
    await s.startShelf(undefined);
    await s.startShelf(/** @type {any} */ ({ url: 'https://example.com/' }));
    await s.startShelf(/** @type {any} */ ({ id: -1, url: 'https://example.com/' }));
    assert.equal(injections().length, 0);
  });

  it('does not run twice at the same time for one tab', async () => {
    const s = makeStarter();
    await Promise.all([s.startShelf(tab), s.startShelf(tab)]);
    assert.equal(s.registered.length, 1);
  });

  it('never rejects', async () => {
    fake.behavior.executeScript = async () => {
      throw new Error('Cannot access contents of the page.');
    };
    const s = makeStarter();
    await assert.doesNotReject(s.startShelf(tab));
    assert.deepEqual(fake.argsOf('action.setTitle'), [[{ tabId: 7, title: MSG_INJECT_FAILED }]]);
  });
});

describe('startFromCommand', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  const tab = /** @type {any} */ ({ id: 7, url: 'https://example.com/' });

  it('insert-capture opens the shelf, start-capture starts a capture', async () => {
    const s = makeStarter();
    await s.startFromCommand(INSERT_COMMAND, tab);
    const shelfConfig = fake
      .argsOf('scripting.executeScript')
      .map((a) => /** @type {any} */ (a[0]))
      .find((i) => i.args)?.args[0];
    assert.equal(shelfConfig.mode, 'shelf');
    assert.equal(s.registered.length, 1);

    fake.calls.length = 0;
    await s.startFromCommand(START_COMMAND, tab);
    const captureConfig = fake
      .argsOf('scripting.executeScript')
      .map((a) => /** @type {any} */ (a[0]))
      .find((i) => i.args)?.args[0];
    assert.equal(captureConfig.mode, 'capture');
    assert.equal(captureConfig.shelfToken, '');
    assert.equal(s.registered.length, 1, 'a capture registers no token');
  });

  it('ignores any other command', async () => {
    const s = makeStarter();
    await s.startFromCommand('something-else', tab);
    assert.equal(fake.argsOf('scripting.executeScript').length, 0);
  });

  it('uses the active tab when Chrome passes none', async () => {
    fake.addTab({ id: 12, active: true, url: 'https://example.com/a' });
    const s = makeStarter();
    await s.startFromCommand(INSERT_COMMAND, undefined);
    assert.deepEqual(s.registered, [{ token: TOKEN_A, tabId: 12 }]);
  });
});

describe('the default token registration', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  const tab = /** @type {any} */ ({ id: 7, url: 'https://example.com/' });

  it('sends offscreen/shelf-grant with the token and the tab when a document exists', async () => {
    fake.addOffscreenDocument();
    const s = createStarter({ schedule: () => 0, cancel: () => {}, newToken: () => TOKEN_A });
    await s.startShelf(tab);
    const grants = fake
      .argsOf('runtime.sendMessage')
      .map((a) => /** @type {any} */ (a[0]))
      .filter((m) => m.type === MSG.OFF_SHELF_GRANT);
    assert.equal(grants.length, 1);
    assert.equal(grants[0].token, TOKEN_A);
    assert.equal(grants[0].tabId, 7);
    assert.equal(grants[0].target, 'offscreen');
  });

  it('sends nothing, and creates no document, when none exists (there is no last capture)', async () => {
    const s = createStarter({ schedule: () => 0, cancel: () => {}, newToken: () => TOKEN_A });
    await s.startShelf(tab);
    assert.equal(fake.argsOf('runtime.sendMessage').length, 0);
    assert.equal(fake.argsOf('offscreen.createDocument').length, 0);
    // The shelf still starts: it shows "Nothing to insert yet".
    assert.equal(fake.argsOf('action.setBadgeText').length, 0);
    await macrotask();
  });
});

describe('the offscreen document stays while it holds the last capture', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it('closeIfIdle closes when there is no session and no last capture', async () => {
    fake.addOffscreenDocument();
    fake.behavior.sendMessage = async () => ({ ok: true, sessions: 0, lastCapture: false });
    assert.equal(await closeIfIdle(), true);
    assert.equal(fake.state.closedDocuments, 1);
  });

  it('closeIfIdle does not close while the last capture is kept', async () => {
    fake.addOffscreenDocument();
    fake.behavior.sendMessage = async () => ({ ok: true, sessions: 0, lastCapture: true });
    assert.equal(await closeIfIdle(), false);
    assert.equal(fake.state.closedDocuments, 0);
  });

  it('closeIfIdle does not close while a session is open', async () => {
    fake.addOffscreenDocument();
    fake.behavior.sendMessage = async () => ({ ok: true, sessions: 1, lastCapture: false });
    assert.equal(await closeIfIdle(), false);
  });
});
