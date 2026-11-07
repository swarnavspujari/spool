// @ts-check
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  PATHS,
  RESTRICTED_HOSTS,
  RESTRICTED_SCHEMES,
} from '../../src/shared/constants.js';
import { ERR, MSG, PROTOCOL_VERSION, TARGET, isSessionId } from '../../src/shared/protocol.js';
import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '../../src/shared/settings.js';
import {
  BADGE_CLEAR_MS,
  BADGE_COLOR,
  MSG_INJECT_FAILED,
  MSG_RESTRICTED,
  createStarter,
  isRestrictedUrl,
} from '../../src/sw/start.js';
import { DEFAULT_TITLE, deferred, installFakeChrome, macrotask } from '../helpers/fake-chrome.js';

const FIXED_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';

/**
 * A starter with recorded timers and a fixed session id.
 * @param {Parameters<typeof createStarter>[0]} [extra]
 */
function makeStarter(extra = {}) {
  /** @type {{ fn: () => void, ms: number, handle: number, cancelled: boolean }[]} */
  const timers = [];
  const starter = createStarter({
    schedule: (fn, ms) => {
      const handle = timers.length + 1;
      timers.push({ fn, ms, handle, cancelled: false });
      return handle;
    },
    cancel: (handle) => {
      const t = timers.find((x) => x.handle === handle);
      if (t) t.cancelled = true;
    },
    newSessionId: () => FIXED_ID,
    ...extra,
  });
  return { ...starter, timers };
}

describe('isRestrictedUrl', () => {
  it('treats a missing or invalid URL as restricted', () => {
    for (const url of [undefined, '', 'not a url', '://x', '   ']) {
      assert.equal(isRestrictedUrl(url), true, String(url));
    }
    assert.equal(isRestrictedUrl(/** @type {any} */ (null)), true);
    assert.equal(isRestrictedUrl(/** @type {any} */ (42)), true);
  });

  it('refuses every restricted scheme', () => {
    for (const scheme of RESTRICTED_SCHEMES) {
      assert.equal(isRestrictedUrl(`${scheme}//example/page`), true, scheme);
      assert.equal(isRestrictedUrl(`${scheme.toUpperCase()}//example/page`), true, scheme);
    }
    assert.equal(isRestrictedUrl('chrome://extensions/'), true);
    assert.equal(isRestrictedUrl('view-source:https://example.com/'), true);
    assert.equal(isRestrictedUrl('about:blank'), true);
    assert.equal(isRestrictedUrl('devtools://devtools/bundled/devtools_app.html'), true);
    assert.equal(isRestrictedUrl('chrome-extension://abc/src/result/result.html'), true);
  });

  it('refuses every restricted host, also in other letter case and with a trailing dot', () => {
    for (const host of RESTRICTED_HOSTS) {
      assert.equal(isRestrictedUrl(`https://${host}/detail/x`), true, host);
      assert.equal(isRestrictedUrl(`https://${host.toUpperCase()}/`), true, host);
      assert.equal(isRestrictedUrl(`https://${host}./`), true, host);
      assert.equal(isRestrictedUrl(`http://${host}:8080/`), true, host);
    }
  });

  it('allows normal pages', () => {
    const allowed = [
      'https://example.com/',
      'http://localhost:3000/app',
      'file:///C:/Users/me/page.html',
      'https://www.google.com/search?q=chrome',
      'https://example.com/?next=chrome://settings',
      'https://example.com/#about:blank',
      // Similar names are other hosts.
      'https://notchromewebstore.google.com/',
      'https://chromewebstore.google.com.example.org/',
      'https://google.com/chromewebstore',
    ];
    for (const url of allowed) assert.equal(isRestrictedUrl(url), false, url);
  });
});

describe('startCapture', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;
  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  describe('restricted pages', () => {
    it('shows the badge, the title and a 4 second timer, and injects nothing', async () => {
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 5, url: 'chrome://extensions/' }));
      assert.deepEqual(fake.argsOf('action.setBadgeText'), [[{ tabId: 5, text: '!' }]]);
      assert.deepEqual(fake.argsOf('action.setBadgeBackgroundColor'), [
        [{ tabId: 5, color: BADGE_COLOR }],
      ]);
      assert.deepEqual(fake.argsOf('action.setTitle'), [[{ tabId: 5, title: MSG_RESTRICTED }]]);
      assert.equal(fake.argsOf('scripting.executeScript').length, 0);
      assert.equal(fake.argsOf('storage.sync.get').length, 0, 'no need to read settings');
      assert.equal(s.timers.length, 1);
      assert.equal(s.timers[0]?.ms, BADGE_CLEAR_MS);
      assert.equal(BADGE_CLEAR_MS, 4000);
    });

    it('clears the badge and restores the title when the timer fires', async () => {
      const s = makeStarter();
      const store = /** @type {any} */ ({ id: 5, url: 'https://chromewebstore.google.com/' });
      await s.startCapture(store);
      s.timers[0]?.fn();
      await macrotask();
      assert.deepEqual(fake.argsOf('action.setBadgeText')[1], [{ tabId: 5, text: '' }]);
      assert.deepEqual(fake.argsOf('action.setTitle')[1], [{ tabId: 5, title: DEFAULT_TITLE }]);
    });

    it('treats a tab without a URL as restricted', async () => {
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 5 }));
      assert.deepEqual(fake.argsOf('action.setBadgeText'), [[{ tabId: 5, text: '!' }]]);
      assert.equal(fake.argsOf('scripting.executeScript').length, 0);
    });

    it('replaces a pending clear timer of the same tab', async () => {
      const s = makeStarter();
      const tab = /** @type {any} */ ({ id: 5, url: 'about:blank' });
      await s.startCapture(tab);
      await s.startCapture(tab);
      assert.equal(s.timers.length, 2);
      assert.equal(s.timers[0]?.cancelled, true);
      assert.equal(s.timers[1]?.cancelled, false);
    });

    it('does not fail when the tab closed before the badge was set', async () => {
      const s = makeStarter();
      fake.chrome.action.setBadgeText = async () => {
        throw new Error('No tab with id: 5.');
      };
      await s.startCapture(/** @type {any} */ ({ id: 5, url: 'about:blank' }));
      assert.equal(s.timers.length, 0, 'no timer for a tab that is gone');
    });

    it('does not fail when the tab closed before the badge was cleared', async () => {
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 5, url: 'about:blank' }));
      fake.chrome.action.setBadgeText = async () => {
        throw new Error('No tab with id: 5.');
      };
      s.timers[0]?.fn();
      await macrotask();
    });
  });

  describe('tabs without an id', () => {
    it('does nothing', async () => {
      const s = makeStarter();
      await s.startCapture(undefined);
      await s.startCapture(/** @type {any} */ ({ url: 'https://example.com/' }));
      await s.startCapture(/** @type {any} */ ({ id: -1, url: 'https://example.com/' }));
      assert.deepEqual(fake.calls, []);
    });
  });

  describe('injection', () => {
    it('injects in the contract order: config func, page scripts, start func', async () => {
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      const injections = fake
        .argsOf('scripting.executeScript')
        .map((a) => /** @type {any} */ (a[0]));
      assert.equal(injections.length, 3);

      const [config, files, start] = injections;
      for (const inj of injections) {
        assert.deepEqual(inj.target, { tabId: 7, frameIds: [0] }, 'top frame only');
        assert.equal(inj.world, 'ISOLATED');
      }
      assert.equal(typeof config.func, 'function');
      assert.equal(config.args.length, 1);
      assert.equal(config.files, undefined);
      assert.deepEqual(files.files, PATHS.pageScripts);
      assert.equal(files.func, undefined);
      assert.equal(typeof start.func, 'function');
      assert.equal(start.args, undefined);
      assert.equal(fake.argsOf('action.setBadgeText').length, 0, 'no badge on success');
    });

    it('builds the PageConfig from the stored settings', async () => {
      fake.state.storage[SETTINGS_STORAGE_KEY] = { settleMs: 900, tileTier: 'standard', junk: 1 };
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      const config = /** @type {any} */ (fake.argsOf('scripting.executeScript')[0]?.[0]).args[0];
      assert.equal(config.protocolVersion, PROTOCOL_VERSION);
      assert.equal(config.sessionId, FIXED_ID);
      assert.deepEqual(config.settings, {
        ...DEFAULT_SETTINGS,
        settleMs: 900,
        tileTier: 'standard',
      });
      assert.deepEqual(config.msg, { ...MSG });
      assert.deepEqual(config.err, { ...ERR });
      assert.deepEqual(config.target, { ...TARGET });
    });

    it('passes a config that survives JSON serialization', async () => {
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      const config = /** @type {any} */ (fake.argsOf('scripting.executeScript')[0]?.[0]).args[0];
      assert.deepEqual(JSON.parse(JSON.stringify(config)), config);
    });

    it('uses a new valid session id for each start', async () => {
      const s = createStarter({ schedule: () => 0, cancel: () => {} });
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      const ids = fake
        .argsOf('scripting.executeScript')
        .map((a) => /** @type {any} */ (a[0]))
        .filter((inj) => inj.args)
        .map((inj) => inj.args[0].sessionId);
      assert.equal(ids.length, 2);
      assert.ok(ids.every(isSessionId));
      assert.notEqual(ids[0], ids[1]);
    });

    it('falls back to default settings when storage fails', async () => {
      fake.chrome.storage.sync.get = async () => {
        throw new Error('storage unavailable');
      };
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      const config = /** @type {any} */ (fake.argsOf('scripting.executeScript')[0]?.[0]).args[0];
      assert.deepEqual(config.settings, { ...DEFAULT_SETTINGS });
      assert.equal(fake.argsOf('scripting.executeScript').length, 3);
    });

    it('stops after the first injection when an agent is already active', async () => {
      fake.behavior.executeScript = async () => [{ frameId: 0, result: true }];
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      assert.equal(fake.argsOf('scripting.executeScript').length, 1);
      assert.equal(fake.argsOf('action.setBadgeText').length, 0, 'not an error');
    });

    it('does not start twice while a start of the same tab is running', async () => {
      const gate = deferred();
      const base = fake.behavior.executeScript;
      let first = true;
      fake.behavior.executeScript = async (inj, i) => {
        if (first) {
          first = false;
          await gate.promise;
        }
        return base(inj, i);
      };
      const s = makeStarter();
      const tab = /** @type {any} */ ({ id: 7, url: 'https://example.com/' });
      const p1 = s.startCapture(tab);
      const p2 = s.startCapture(tab);
      const other = s.startCapture(/** @type {any} */ ({ id: 8, url: 'https://example.com/' }));
      await p2;
      gate.resolve();
      await Promise.all([p1, other]);
      const tabs = fake
        .argsOf('scripting.executeScript')
        .map((a) => /** @type {any} */ (a[0]).target.tabId);
      assert.equal(tabs.filter((t) => t === 7).length, 3, 'one start for tab 7');
      assert.equal(tabs.filter((t) => t === 8).length, 3, 'tab 8 is independent');

      // A later start of the same tab works again.
      await s.startCapture(tab);
      assert.equal(fake.argsOf('scripting.executeScript').length, 9);
    });
  });

  describe('injection errors', () => {
    for (const failingStep of [0, 1, 2]) {
      it(`shows a plain badge message when injection step ${failingStep + 1} fails`, async () => {
        const base = fake.behavior.executeScript;
        fake.behavior.executeScript = async (inj, i) => {
          if (i === failingStep) {
            throw new Error('Cannot access contents of the page at https://private.example/');
          }
          return base(inj, i);
        };
        const s = makeStarter();
        await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
        assert.equal(fake.argsOf('scripting.executeScript').length, failingStep + 1);
        assert.deepEqual(fake.argsOf('action.setBadgeText'), [[{ tabId: 7, text: '!' }]]);
        assert.deepEqual(fake.argsOf('action.setTitle'), [
          [{ tabId: 7, title: MSG_INJECT_FAILED }],
        ]);
        assert.doesNotMatch(MSG_INJECT_FAILED, /private|Cannot access/);
        assert.equal(s.timers[0]?.ms, 4000);
      });
    }

    it('shows the badge when the page scripts did not register an agent', async () => {
      const base = fake.behavior.executeScript;
      fake.behavior.executeScript = async (inj, i) =>
        inj.func && !inj.args ? [{ frameId: 0, result: false }] : base(inj, i);
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      assert.deepEqual(fake.argsOf('action.setTitle'), [[{ tabId: 7, title: MSG_INJECT_FAILED }]]);
    });

    it('allows a new start after a failure', async () => {
      let failures = 1;
      const base = fake.behavior.executeScript;
      fake.behavior.executeScript = async (inj, i) => {
        if (failures-- > 0) throw new Error('first try fails');
        return base(inj, i);
      };
      const s = makeStarter();
      const tab = /** @type {any} */ ({ id: 7, url: 'https://example.com/' });
      await s.startCapture(tab);
      await s.startCapture(tab);
      assert.equal(fake.argsOf('scripting.executeScript').length, 1 + 3);
    });

    it('never rejects, even when everything fails', async () => {
      fake.behavior.executeScript = async () => {
        throw new Error('no');
      };
      fake.chrome.action.setBadgeText = async () => {
        throw new Error('no');
      };
      fake.chrome.action.setTitle = async () => {
        throw new Error('no');
      };
      const s = makeStarter({
        newSessionId: () => {
          throw new Error('no');
        },
      });
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
    });
  });

  describe('functions that run in the page', () => {
    /** @type {any} */
    const g = globalThis;
    /** @type {unknown} */
    let savedNamespace;
    /** @type {boolean} */
    let hadNamespace;
    beforeEach(() => {
      hadNamespace = Object.hasOwn(g, '__spool');
      savedNamespace = g.__spool;
      delete g.__spool;
    });
    afterEach(() => {
      if (hadNamespace) g.__spool = savedNamespace;
      else delete g.__spool;
    });

    async function injectedFunctions() {
      const s = makeStarter();
      await s.startCapture(/** @type {any} */ ({ id: 7, url: 'https://example.com/' }));
      const [configInj, , startInj] = fake
        .argsOf('scripting.executeScript')
        .map((a) => /** @type {any} */ (a[0]));
      return {
        config: configInj.args[0],
        /** @type {(config: any) => boolean} */
        installConfig: configInj.func,
        /** @type {() => boolean} */
        startAgent: startInj.func,
      };
    }

    it('installConfig creates the namespace and stores the config', async () => {
      const { config, installConfig } = await injectedFunctions();
      assert.equal(installConfig(config), false);
      assert.equal(g.__spool.config, config);
    });

    it('installConfig keeps the existing modules and replaces an old config', async () => {
      const { config, installConfig } = await injectedFunctions();
      const lib = { marker: 'lib' };
      g.__spool = { lib, config: { old: true }, agent: { isActive: () => false } };
      assert.equal(installConfig(config), false);
      assert.equal(g.__spool.lib, lib);
      assert.equal(g.__spool.config, config);
    });

    it('installConfig returns true and keeps the config while an agent is active', async () => {
      const { config, installConfig } = await injectedFunctions();
      const running = { sessionId: 'running' };
      g.__spool = { config: running, agent: { isActive: () => true } };
      assert.equal(installConfig(config), true);
      assert.equal(g.__spool.config, running, 'the running session keeps its config');
    });

    it('startAgent starts the agent and reports it', async () => {
      const { startAgent } = await injectedFunctions();
      assert.equal(startAgent(), false, 'no agent registered');
      let started = 0;
      g.__spool = {
        agent: {
          start: () => {
            started += 1;
          },
        },
      };
      assert.equal(startAgent(), true);
      assert.equal(started, 1);
    });

    it('the functions do not use any variable of the service worker module', async () => {
      const { installConfig, startAgent } = await injectedFunctions();
      // chrome.scripting serializes a function by its source text. Rebuild each function from
      // that text in an empty realm: it must still run there.
      const context = vm.createContext({
        __spool: { agent: { isActive: () => false, start() {} } },
      });
      const rebuiltInstall = vm.runInContext(`(${installConfig.toString()})`, context);
      const rebuiltStart = vm.runInContext(`(${startAgent.toString()})`, context);
      assert.equal(rebuiltInstall({ sessionId: 'x' }), false);
      assert.equal(vm.runInContext('__spool.config.sessionId', context), 'x');
      assert.equal(rebuiltStart(), true);
    });
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

  it('ignores other commands', async () => {
    const s = makeStarter();
    await s.startFromCommand('other', /** @type {any} */ ({ id: 1, url: 'https://example.com/' }));
    assert.deepEqual(fake.calls, []);
  });

  it('starts the tab that Chrome passes', async () => {
    const s = makeStarter();
    await s.startFromCommand(
      'start-capture',
      /** @type {any} */ ({ id: 3, url: 'https://example.com/' }),
    );
    assert.equal(fake.argsOf('tabs.query').length, 0);
    assert.equal(fake.argsOf('scripting.executeScript').length, 3);
  });

  it('uses the active tab of the focused window when Chrome passes none', async () => {
    fake.addTab({ id: 11, windowId: 2, active: true, url: 'https://example.com/' });
    fake.behavior.tabsQuery = async (q) => {
      assert.deepEqual(q, { active: true, lastFocusedWindow: true });
      return fake.state.tabs;
    };
    const s = makeStarter();
    await s.startFromCommand('start-capture', undefined);
    const targets = fake
      .argsOf('scripting.executeScript')
      .map((a) => /** @type {any} */ (a[0]).target.tabId);
    assert.deepEqual(targets, [11, 11, 11]);
  });

  it('does nothing when there is no active tab or the query fails', async () => {
    const s = makeStarter();
    fake.behavior.tabsQuery = async () => [];
    await s.startFromCommand('start-capture', undefined);
    fake.behavior.tabsQuery = async () => {
      throw new Error('no window');
    };
    await s.startFromCommand('start-capture', undefined);
    assert.equal(fake.argsOf('scripting.executeScript').length, 0);
    assert.equal(fake.argsOf('action.setBadgeText').length, 0);
  });

  it('shows the badge when the active tab is a restricted page', async () => {
    const s = makeStarter();
    await s.startFromCommand(
      'start-capture',
      /** @type {any} */ ({ id: 3, url: 'chrome://settings' }),
    );
    assert.deepEqual(fake.argsOf('action.setBadgeText'), [[{ tabId: 3, text: '!' }]]);
  });
});
