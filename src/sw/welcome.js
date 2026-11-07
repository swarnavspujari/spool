// @ts-check
/**
 * The page that opens once, when Spool is installed: the options page in its welcome form. It
 * asks where screenshots should go. Nothing opens for an update, a reload of the extension, or a
 * browser update: the person has seen it, or has chosen already.
 */

import { PATHS, WELCOME_HASH } from '../shared/constants.js';

/**
 * Opens the welcome page in a new tab. Never throws.
 * @returns {Promise<boolean>}  True when the tab opened.
 */
export async function openWelcome() {
  try {
    await chrome.tabs.create({ url: `${chrome.runtime.getURL(PATHS.options)}#${WELCOME_HASH}` });
    return true;
  } catch {
    return false;
  }
}

/**
 * The listener of `chrome.runtime.onInstalled`. Only the reason `install` opens the page.
 * @param {{ reason?: string }} details
 * @returns {Promise<boolean>}  True when the page opened.
 */
export async function onInstalled(details) {
  return details?.reason === 'install' ? openWelcome() : false;
}
