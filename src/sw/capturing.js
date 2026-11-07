// @ts-check
/**
 * The "capturing" state of the toolbar button: while a capture
 * session is open in a tab, the button shows an amber dot badge on that tab, and a title that says
 * so. The state is only UI:
 * the service worker keeps no session state, and a badge that is wrong does no harm. Chrome
 * clears a tab-specific badge when the tab navigates or closes.
 *
 * Every function here never throws and never rejects: a tab that is gone, or an API that is
 * missing, is not an error.
 */

/** The dot. A badge shows a few characters: one is enough. */
export const CAPTURING_BADGE_TEXT = '●';
/** The amber of the Spool glyph. */
export const CAPTURING_BADGE_COLOR = '#FFB224';
/** Dark text on the amber, for contrast. */
export const CAPTURING_BADGE_TEXT_COLOR = '#1C1D20';
export const CAPTURING_TITLE = 'Spool is capturing this tab. Press Esc to cancel.';

/** @returns {string} The title of the button when nothing runs (the manifest title). */
function defaultTitle() {
  /** @type {any} */
  const manifest = chrome.runtime.getManifest();
  const title = manifest?.action?.default_title;
  return typeof title === 'string' ? title : 'Spool';
}

/**
 * Shows or clears the capturing state on the button of one tab.
 * @param {number} tabId
 * @param {boolean} on
 * @returns {Promise<void>}
 */
export async function setCapturing(tabId, on) {
  try {
    if (!Number.isInteger(tabId) || tabId < 0) return;
    const action = chrome.action;
    if (on) {
      await Promise.all([
        action.setBadgeText({ tabId, text: CAPTURING_BADGE_TEXT }),
        action.setBadgeBackgroundColor({ tabId, color: CAPTURING_BADGE_COLOR }),
        action.setTitle({ tabId, title: CAPTURING_TITLE }),
      ]);
      // Not in every browser (Chromium 110 and later). The default text color is only less clear.
      await action.setBadgeTextColor?.({ tabId, color: CAPTURING_BADGE_TEXT_COLOR });
    } else {
      await Promise.all([
        action.setBadgeText({ tabId, text: '' }),
        action.setTitle({ tabId, title: defaultTitle() }),
      ]);
    }
  } catch {
    // The tab is gone, or the API is not there.
  }
}
