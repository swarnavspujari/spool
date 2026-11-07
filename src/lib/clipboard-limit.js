// @ts-check
/**
 * The size above which Spool does not put an image on the clipboard as one image.
 *
 * `navigator.clipboard.write` decodes the whole image (width x height x 4 bytes) in the renderer
 * of the page that calls it. A PNG of a very tall capture is a few MB, and its decoded size is
 * hundreds of MB: in headless Chromium 151 a 1500 px wide image crashed the tab from 70,000 px
 * high (420 MB). The page that writes is the page that the user reads, or the chat tab of the
 * shelf, so a crash costs an unsent draft. `MAX_CLIPBOARD_BITMAP_BYTES` has a margin.
 *
 * Pure. The page scripts have a copy of the function (`exceedsClipboard` in src/page/ui-kit.js,
 * a page script cannot import); test/unit/clipboard-limit.test.js runs both on the same input.
 */

/**
 * True when the decoded image is more than `maxBytes`. Anything that is not a usable size counts as
 * too large, so a bad number never lets a write through.
 * @param {number} widthPx
 * @param {number} heightPx
 * @param {number} maxBytes  `MAX_CLIPBOARD_BITMAP_BYTES`.
 * @returns {boolean}
 */
export function exceedsClipboardLimit(widthPx, heightPx, maxBytes) {
  return !(widthPx * heightPx * 4 <= maxBytes);
}
