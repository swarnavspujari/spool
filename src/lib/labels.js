// @ts-check
/**
 * One format for the place where Spool saves a capture: "Downloads › Spool", "Screenshots".
 * The toast, the result page and Options all show it, so the text comes from here.
 *
 * Pure: no `chrome.*`, no DOM. The page scripts of the toast cannot import a module. The toast
 * has its own copy of `formatSaveLabel` (src/page/toast.js, `placeLabel`), and
 * `test/unit/labels.test.js` checks that both give the same text.
 */

/** Between the parts of a place. A real arrow, with a space on each side. */
export const PLACE_SEPARATOR = ' › ';

/**
 * Joins the parts of a place. A part that is empty (after trimming) is left out.
 * @param {...string} parts
 * @returns {string}
 */
export function joinPlace(...parts) {
  return parts
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .join(PLACE_SEPARATOR);
}

/**
 * The place for a save in the Downloads folder: "Downloads › Spool".
 * @param {string} folderName  The folder that Spool makes in Downloads (the setting).
 * @returns {string}
 */
export function downloadsPlace(folderName) {
  return joinPlace('Downloads', folderName);
}

/**
 * The text for `SaveInfo.label`. The offscreen document writes "Downloads/Spool" for a save in
 * Downloads, and the name of the chosen folder ("Screenshots", the name of its handle) for a
 * save in a folder. Both show with the same separator. A label that has no "/" stays as it is.
 * @param {unknown} label
 * @returns {string}
 */
export function formatSaveLabel(label) {
  return typeof label === 'string' ? joinPlace(...label.split('/')) : '';
}

/**
 * The place of a save target: the name of the picked folder, then the folders below it
 * ("Pictures › Screenshots"). An empty name (the root of a drive) is left out.
 * @param {string} name  `FileSystemDirectoryHandle.name`.
 * @param {readonly string[]} subPath
 * @returns {string}
 */
export function targetPlace(name, subPath) {
  return joinPlace(name, ...subPath);
}
