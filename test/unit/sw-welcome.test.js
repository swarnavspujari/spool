// @ts-check
/**
 * The welcome page that opens once, on install (src/sw/welcome.js, docs/contracts.md 7.10).
 */

import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { PATHS } from '../../src/shared/constants.js';
import { onInstalled, openWelcome } from '../../src/sw/welcome.js';
import { EXTENSION_ORIGIN, installFakeChrome, macrotask } from '../helpers/fake-chrome.js';

const WELCOME_URL = `${EXTENSION_ORIGIN}${PATHS.options}#welcome`;

describe('the welcome page', () => {
  /** @type {ReturnType<typeof installFakeChrome>} */
  let fake;

  beforeEach(() => {
    fake = installFakeChrome();
  });
  afterEach(() => {
    fake.uninstall();
  });

  it('install opens options.html#welcome in a new tab', async () => {
    assert.equal(await onInstalled({ reason: 'install' }), true);
    assert.deepEqual(fake.argsOf('tabs.create'), [[{ url: WELCOME_URL }]]);
  });

  it('update, chrome_update, shared_module_update and a missing reason open nothing', async () => {
    for (const reason of ['update', 'chrome_update', 'shared_module_update', 'other', '', undefined]) {
      assert.equal(await onInstalled({ reason }), false, String(reason));
    }
    assert.equal(await onInstalled(/** @type {any} */ (undefined)), false);
    assert.equal(fake.argsOf('tabs.create').length, 0);
  });

  it('a tab that cannot open is not an error: the answer is false and nothing is thrown', async () => {
    fake.behavior.tabsCreate = async () => {
      throw new Error('No window.');
    };
    assert.equal(await openWelcome(), false);
    assert.equal(await onInstalled({ reason: 'install' }), false);
  });

  it('the worker registers the listener and opens the page on install only', async () => {
    const entry = 'welcome';
    await import(`../../src/sw/service-worker.js?case=${entry}`);
    assert.equal(fake.events.installed.listeners.length, 1);
    fake.events.installed.dispatch({ reason: 'update' });
    await macrotask();
    assert.equal(fake.argsOf('tabs.create').length, 0);
    fake.events.installed.dispatch({ reason: 'install' });
    await macrotask();
    assert.deepEqual(fake.argsOf('tabs.create'), [[{ url: WELCOME_URL }]]);
  });
});
