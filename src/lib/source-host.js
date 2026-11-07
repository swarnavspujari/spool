// @ts-check
/**
 * The host name of the page that a capture comes from. The shelf shows it ("5 AI screenshots from
 * github.com, 4 min ago"), so that the user sees where the pixels come from before they put them
 * into another page.
 *
 * Only the host name is kept: no scheme, no port, no path, no query, no fragment. The caller
 * passes the URL of the sender of a message (the browser's own value), never a URL that the page
 * wrote in a field.
 *
 * Pure: no `chrome.*`, no DOM.
 */

import { isSourceHost } from '../shared/protocol.js';

/**
 * @param {unknown} url  For example `sender.url` of a message from a content script.
 * @returns {string}  `URL.hostname` ("github.com", "[::1]", punycode for a non-ASCII name), or ''
 *   when there is none (a local file, a page without a host, a value that is not a URL).
 */
export function sourceHostOf(url) {
  if (typeof url !== 'string' || url === '') return '';
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return '';
  }
  return isSourceHost(host) ? host : '';
}
