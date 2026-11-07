// @ts-check
/**
 * Spool service worker (ES module). Entry point.
 *
 * Chrome wakes the worker for an event only when the listener is registered while the script
 * first runs. So every listener is registered here, synchronously, at the top level.
 * The worker keeps no session state: the offscreen document owns it (docs/contracts.md).
 */

import { createHandlers, dropTabSessions } from './handlers.js';
import { createRouter } from './router.js';
import { startCapture, startFromCommand } from './start.js';
import { onInstalled } from './welcome.js';

const router = createRouter(createHandlers(), {
  runtimeId: chrome.runtime.id,
  origin: chrome.runtime.getURL(''),
  onError: (e) => console.error('Spool: unexpected error', e),
});

chrome.action.onClicked.addListener((tab) => {
  void startCapture(tab);
});

chrome.commands.onCommand.addListener((command, tab) => {
  void startFromCommand(command, tab);
});

chrome.runtime.onMessage.addListener(router);

// The welcome page opens on install only (not on an update or a reload).
chrome.runtime.onInstalled.addListener((details) => {
  void onInstalled(details);
});

// A closed tab ends the page agent: drop the unfinished sessions of that tab. dropTabSessions()
// does nothing when no offscreen document exists. There is no listener for a page load: Chrome
// has no filter for `tabs.onUpdated`, so it would wake the worker on every status change of every
// tab. A page that unloads makes the agent send `page/cancel` (`pagehide`), and the idle timer
// of the session store covers a page that died without it.
chrome.tabs.onRemoved.addListener((tabId) => {
  void dropTabSessions(tabId);
});
