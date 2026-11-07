// @ts-check
/**
 * The save step of a finished capture (docs/contracts.md 7.3):
 *
 * 1. A folder is chosen and the browser has granted write access now → write the files in its
 *    sub folder (`Pictures` + `Screenshots`), which is made when it is missing
 *    (folder-writer.js). The offscreen document never asks for access: only an extension page can,
 *    in a click.
 * 2. Else, or when the write fails → `chrome.downloads` through the service worker
 *    (`sw/download`), with blob URLs made here. No file bytes travel in a message.
 *
 * The layout and the names come from src/lib/names.js. Browser calls are injected (`folderStore`,
 * `requestDownloads`, `makeUrl`, `revokeUrl`), so unit tests run this with fakes.
 *
 * `save` never rejects: every failure becomes `SaveInfo.error`.
 */

import { formatSaveLabel } from '../lib/labels.js';
import { captureBaseName, captureFiles } from '../lib/names.js';
import { ensureSubPath } from '../ui/folder-store.js';
import { isAccessError, isMissingError, pickFreeBase, writeFiles } from './folder-writer.js';

/** @typedef {import('../shared/types.js').SaveInfo} SaveInfo */
/** @typedef {import('../lib/names.js').CaptureFile} CaptureFile */

/** @typedef {import('../ui/folder-store.js').SaveTarget} SaveTarget */

/**
 * @typedef {Object} FolderStore  The part of src/ui/folder-store.js that the pipeline uses.
 * @property {() => Promise<SaveTarget | null>} getSaveTarget
 * @property {(handle: FileSystemDirectoryHandle) => Promise<'granted' | 'prompt' | 'denied'>} folderPermission
 */

/**
 * @typedef {Object} DownloadResult
 * @property {number} saved        Files that are complete.
 * @property {number} rejected     Files that Chrome refused to start (for example a bad name).
 * @property {number} interrupted  Files that started and did not finish.
 */

/**
 * @typedef {Object} SaverDeps
 * @property {FolderStore} folderStore
 * @property {(files: { path: string, url: string }[]) => Promise<DownloadResult>} requestDownloads
 *   Asks the service worker to download the files. Paths are relative to Downloads.
 * @property {(blob: Blob) => string} makeUrl     URL.createObjectURL.
 * @property {(url: string) => void} revokeUrl    URL.revokeObjectURL.
 */

/**
 * @typedef {Object} SaveRequest
 * @property {Date} date                 The time in the names (local time).
 * @property {string} title              Page title. The names sanitize it.
 * @property {number} tileCount
 * @property {boolean} [fitsOneImage]    One tile that is the full image 1:1 (one flat file).
 *                                       Default: `tileCount === 1`.
 * @property {Blob[]} tiles              Tile PNGs by index. An entry may be the full Blob.
 * @property {Blob | null} full          The full PNG, or null when it could not be built.
 * @property {boolean} saveTiles
 * @property {boolean} saveFull
 * @property {string} folderName         Root folder below Downloads. Already sanitized.
 */

/**
 * The files of the capture for one base name.
 * @param {SaveRequest} request
 * @returns {(base: string) => CaptureFile[]}
 */
function layoutOf(request) {
  return (base) =>
    captureFiles({
      base,
      tileCount: request.tileCount,
      ...(request.fitsOneImage === undefined ? {} : { fitsOneImage: request.fitsOneImage }),
      saveTiles: request.saveTiles,
      saveFull: request.saveFull,
    });
}

const LABEL_NONE = 'Not saved';
const MSG_FAILED = 'Could not save the files.';
const MSG_SOME_FAILED = 'Some files could not be saved.';

/**
 * The warning for a folder write that failed. It says what is true: how many files stay in the
 * folder (a write stops at the first failure and keeps the files before it), and whether the files
 * went to Downloads.
 * @param {{ place: string, written: number, planned: number, toDownloads: boolean }} f
 * @returns {string}
 */
function folderFailedWarning({ place, written, planned, toDownloads }) {
  const instead = toDownloads ? ' All files went to Downloads instead.' : '';
  if (written > 0) {
    const done = `Writing to ${place} stopped after ${written} of ${planned} files.`;
    return `${done} They stay there.${instead}`;
  }
  return toDownloads
    ? 'Could not write to the chosen folder. Saved to Downloads instead.'
    : 'Could not write to the chosen folder.';
}

/**
 * @param {SaverDeps} deps
 */
export function createSaver(deps) {
  const { folderStore, requestDownloads, makeUrl, revokeUrl } = deps;

  /**
   * The files with their data. A file with no data (the full image that could not be built) is
   * left out.
   * @param {CaptureFile[]} files
   * @param {SaveRequest} request
   * @returns {(CaptureFile & { blob: Blob })[]}
   */
  function withBlobs(files, request) {
    /** @type {(CaptureFile & { blob: Blob })[]} */
    const out = [];
    for (const file of files) {
      const blob = file.kind === 'full' ? request.full : request.tiles[file.index ?? -1];
      if (blob) out.push({ ...file, blob });
    }
    return out;
  }

  /**
   * @param {SaveRequest} request
   * @param {(base: string) => CaptureFile[]} makeFiles
   * @param {string} base
   * @returns {Promise<DownloadResult & { total: number }>}
   */
  async function downloadAll(request, makeFiles, base) {
    const files = withBlobs(makeFiles(base), request);
    /** @type {string[]} */
    const urls = [];
    try {
      const list = files.map((file) => {
        const url = makeUrl(file.blob);
        urls.push(url);
        return { path: [request.folderName, ...file.path].join('/'), url };
      });
      return { total: list.length, ...(await requestDownloads(list)) };
    } finally {
      // Chrome has read the files (or given up) when the service worker replied.
      for (const url of urls) revokeUrl(url);
    }
  }

  /**
   * @param {SaveRequest} request
   * @param {boolean} needsPermission
   * @returns {Promise<SaveInfo>}
   */
  async function saveToDownloads(request, needsPermission) {
    const makeFiles = layoutOf(request);
    const label = `Downloads/${request.folderName}`;
    try {
      const wanted = captureBaseName(request.date, request.title);
      let result = await downloadAll(request, makeFiles, wanted);
      // Chrome refuses a name that its rules do not accept. The sanitized title can still hold
      // something new. Then the whole set goes again, once, without the title.
      if (result.saved === 0 && result.rejected > 0) {
        const bare = captureBaseName(request.date, '');
        if (bare !== wanted) result = await downloadAll(request, makeFiles, bare);
      }
      if (result.saved === result.total) {
        return { location: 'downloads', label, files: result.saved, needsPermission };
      }
      return result.saved > 0
        ? {
            location: 'downloads',
            label,
            files: result.saved,
            needsPermission,
            failed: result.total - result.saved,
            error: MSG_SOME_FAILED,
          }
        : { location: 'none', label: LABEL_NONE, files: 0, needsPermission, error: MSG_FAILED };
    } catch {
      return { location: 'none', label: LABEL_NONE, files: 0, needsPermission, error: MSG_FAILED };
    }
  }

  return Object.freeze({
    /**
     * Saves the capture. Never rejects.
     * @param {SaveRequest} request
     * @returns {Promise<{ save: SaveInfo, warnings: string[] }>}  `warnings` are lines to add to
     *   the summary.
     */
    async save(request) {
      const makeFiles = layoutOf(request);
      const wanted = captureBaseName(request.date, request.title);
      if (withBlobs(makeFiles(wanted), request).length === 0) {
        return {
          save: { location: 'none', label: LABEL_NONE, files: 0, needsPermission: false },
          warnings: [],
        };
      }

      let needsPermission = false;
      /** @type {string[]} */
      const warnings = [];
      /** @type {SaveTarget | null} */
      let target = null;
      try {
        target = await folderStore.getSaveTarget();
      } catch {
        target = null; // An unreadable store counts as "no folder chosen".
      }
      /** @type {{ place: string, written: number, planned: number } | null} */
      let folderFailure = null;
      if (target !== null) {
        const { handle, subPath } = target;
        /** @type {'granted' | 'prompt' | 'denied'} */
        let permission = 'denied';
        try {
          permission = await folderStore.folderPermission(handle);
        } catch {
          permission = 'denied';
        }
        if (permission === 'granted') {
          const label = [String(handle.name ?? ''), ...subPath].join('/');
          const progress = { written: 0 };
          let planned = 0;
          try {
            // Makes a missing sub folder again. Throws when the picked folder is gone.
            const root = await ensureSubPath(handle, subPath);
            const base = await pickFreeBase(root, wanted, makeFiles);
            const files = withBlobs(makeFiles(base), request);
            planned = files.length;
            const written = await writeFiles(root, files, progress);
            return {
              save: { location: 'folder', label, files: written, needsPermission: false },
              warnings,
            };
          } catch (e) {
            folderFailure = { place: formatSaveLabel(label), written: progress.written, planned };
            // No access now, or the folder is gone: the toast offers "Reconnect".
            needsPermission = isAccessError(e) || isMissingError(e);
          }
        } else {
          needsPermission = true;
        }
      }
      const save = await saveToDownloads(request, needsPermission);
      // The toast names the folder that it asks the user to reconnect.
      if (needsPermission && target !== null) {
        save.folderLabel = [String(target.handle.name ?? ''), ...target.subPath].join('/');
      }
      if (folderFailure !== null) {
        const toDownloads = save.location === 'downloads' && save.error === undefined;
        warnings.push(folderFailedWarning({ ...folderFailure, toDownloads }));
      }
      return { save, warnings };
    },
  });
}
