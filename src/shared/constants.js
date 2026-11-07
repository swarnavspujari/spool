// @ts-check
/**
 * Domain constants shared by the service worker, the offscreen document and extension pages.
 * Page scripts (src/page/*) cannot import modules; the service worker passes them what they need
 * in PageConfig.
 */

/** Chrome allows at most 2 captureVisibleTab calls per second. Keep a safety margin. */
export const CAPTURE_MIN_INTERVAL_MS = 550;
/** Retries when captureVisibleTab reports the per-second quota error. */
export const CAPTURE_RETRY_LIMIT = 3;
/** Wait before a quota retry. */
export const CAPTURE_RETRY_DELAY_MS = 600;
/**
 * Retries when captureVisibleTab reports "image readback failed": the tab has not presented a
 * frame yet (a page that has just loaded or just become visible). The error is transient.
 */
export const CAPTURE_READBACK_RETRY_LIMIT = 2;
/** Wait before a readback retry: a few frames at 60 Hz. The call spacing still applies. */
export const CAPTURE_READBACK_RETRY_DELAY_MS = 100;

/** Vision models read images in square patches of this size (device px). */
export const PATCH_PX = 28;

/**
 * Image tiers for AI vision models. A tile that fits a tier is not downscaled by the model.
 * high: current models (long edge 2576 px, 4784 patches). standard: older models.
 */
export const TILE_TIERS = Object.freeze({
  high: Object.freeze({ maxLongEdgePx: 2576, maxPatches: 4784 }),
  standard: Object.freeze({ maxLongEdgePx: 1568, maxPatches: 1568 }),
});

/** Vertical overlap between adjacent tiles (2 patches), so no text line is cut in every tile. */
export const TILE_OVERLAP_PX = 56;
/** Upload limits of the target chat app. Used for warnings only. */
export const MAX_IMAGES_PER_MESSAGE = 20;
export const MAX_IMAGE_DIMENSION_PX = 8000;
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * Most decoded bytes (width x height x 4) that Spool puts on the clipboard as one image. The
 * browser decodes the whole image in the renderer of the page that writes it. In headless
 * Chromium 151 a 1500 px wide PNG wrote fine up to 60,000 px high (360 MB decoded) and crashed the
 * tab from 70,000 px (420 MB). 256 MiB is a margin below the first crash, not a measured limit:
 * 1500 px wide gives about 44,800 px high. Above it the copy is skipped and the files still save.
 */
export const MAX_CLIPBOARD_BITMAP_BYTES = 256 * 1024 * 1024;

/** The longest host name that a capture remembers as its source (DNS allows 253 characters). */
export const MAX_SOURCE_HOST_LENGTH = 253;

/**
 * The toast of a long capture stays until the user dismisses it for this many captures. It teaches
 * the keys (Ctrl+V for the full image, the shelf key for the screenshots), and a toast that
 * hides after 6 s teaches nothing to a person who looks at the page.
 */
export const MAX_STICKY_LONG_TOASTS = 3;

/**
 * Every value of `SeamStatus` (types.js). The service worker passes only these on to the page.
 */
export const SEAM_STATUSES = Object.freeze([
  'first',
  'exact',
  'corrected',
  'ambiguous',
  'unmatched',
  'duplicate',
]);

/** Seam matching (see src/lib/seam.js). */
export const SIGNATURE_MAX_COLS = 128;
export const SEAM = Object.freeze({
  /** Mean absolute luminance difference (0-255) that still counts as a match. */
  threshold: 3,
  /** Fewest overlapping rows that a comparison may use. */
  minOverlapRows: 16,
  /** Largest shift (device px) the search tries in either direction. */
  maxShiftRows: 256,
  /** Overlap rows with a luminance standard deviation below this are "flat": no reliable match. */
  flatStdDev: 2,
  /**
   * Largest mean absolute luminance difference (0-255) that any single overlap row may have.
   * The mean threshold alone lets a mostly blank overlap pass although a few rows are completely
   * different (2 rows that differ by 200 in 300 rows give a mean of 1.3). Two captures of the
   * same content differ by a few levels per row: anti-aliasing noise on glyph edges, a blinking
   * caret (one bin of 128, at most 2 per row). A text row against other content differs by far
   * more (about 120 for the text pages in the unit tests). 24 is about 10% of the range and 8
   * times the mean threshold: above the noise, well below a real mismatch.
   */
  maxRowDiff: 24,
});

/** Memory guard for one capture session in the offscreen document (sum of stored PNG bytes). */
export const SESSION_MAX_BYTES = 512 * 1024 * 1024;
/**
 * Memory guard for all sessions together (sum of stored PNG bytes of every session in the
 * offscreen document). SESSION_MAX_BYTES limits one capture. Without this limit, the number of
 * sessions was free: each tab can start one, so memory was bounded only by the number of tabs.
 * 1 GiB is two full sessions: one capture at its limit, plus another capture or a finished one
 * that waits for its result page (up to SESSION_TTL_MS).
 *
 * The stored data is `Blob` data. The browser owns Blob storage, not this extension. Under
 * memory pressure, Chromium may page Blob data to a temporary file in the profile folder
 * (`blob_storage`) and delete it when the Blob is freed. The extension cannot prevent or observe
 * this. So "in memory" means that the extension writes nothing itself, not that the data never
 * reaches the disk. This limit keeps the amount small and bounded.
 */
export const TOTAL_MAX_BYTES = 1024 * 1024 * 1024;
/**
 * Largest height of one assembled image (device px): from the top of the highest slice to the
 * bottom of the lowest one. The offscreen store rejects a frame that would pass it.
 *
 * Why 300,000: the setting `maxHeightCss` is at most 100,000 CSS px (40,000 by default), so the
 * user limit is reached first for every normal use (the default is 80,000 device px at 2x). The
 * user limit is in CSS px and the agent checks it after the frame is stored, so a page that
 * jumps its scroll position (or a setting of 100,000 at 3x) could pass it. This is the hard
 * limit that does not depend on the page or on the settings. It also bounds the work of the
 * result page: at most 300,000 rows to plan as tiles (about 125 tiles at the high tier, about
 * 400 at the standard tier for a 1500 px wide area) and to encode as PNG rows (streamed, so
 * memory stays flat).
 */
export const MAX_TOTAL_HEIGHT_PX = 300_000;
/** A finished session that no result page claims is dropped after this time. */
export const SESSION_TTL_MS = 15 * 60 * 1000;
/**
 * An unfinished session is dropped after this time without an open or a frame. It frees the
 * memory of a capture that the user left (closed laptop, forgotten tab) without Done or Cancel.
 */
export const SESSION_IDLE_MS = 30 * 60 * 1000;

/**
 * How long the offscreen document keeps the outputs of the last finished capture (the tiles and
 * the full image, not the slices) for the toast, the shelf and the result page. The next finished
 * capture, this time, or the need for memory ends it first (docs/contracts.md section 7.6).
 */
export const LAST_CAPTURE_TTL_MS = 60 * 60 * 1000;

/** Largest thumbnail of a finished capture (device px): the top of the full image, scaled down. */
export const THUMBNAIL_MAX_WIDTH_PX = 320;
export const THUMBNAIL_MAX_HEIGHT_PX = 480;

/**
 * Largest PNG (bytes) that one runtime message carries as base64. Chrome stops a message at
 * 64 MiB, and base64 adds a third (40 MiB become 53.4 MiB). A bigger image is not sent: the
 * service worker replies `E_SESSION_TOO_LARGE` and the user saves the files or uses the tiles.
 */
export const MAX_TRANSFER_BYTES = 40 * 1024 * 1024;

/**
 * A shelf token (docs/contracts.md section 7.1) works for this long after the command, for the
 * tab that got it. Pressing the command again gives a new token and ends the old one.
 */
export const SHELF_TOKEN_TTL_MS = 10 * 60 * 1000;
/** Most shelf tokens that the offscreen document keeps at one time. The oldest one goes first. */
export const MAX_SHELF_TOKENS = 8;

/** Most files that one `sw/download` message asks for (tiles of the longest capture, and more). */
export const MAX_DOWNLOAD_FILES = 1000;
/** Longest relative download path (characters) and most folder levels in it. */
export const MAX_DOWNLOAD_PATH_LENGTH = 400;
export const MAX_DOWNLOAD_PATH_SEGMENTS = 4;

/**
 * Sections of the options page that the page agent may open (the URL hash). `save`: the Save
 * location group. `setup`: pick a folder. `reconnect`: the browser dropped access to the folder.
 */
export const OPTIONS_SECTIONS = Object.freeze(['save', 'setup', 'reconnect']);

/** The folder that Spool makes inside the folder that the user picks (Pictures). */
export const DEFAULT_SUBFOLDER = 'Screenshots';
/** Most folder names in `subPath` of the save target. */
export const MAX_SUBPATH_SEGMENTS = 2;

/** The one-time page that opens on install is the options page with this hash. */
export const WELCOME_HASH = 'welcome';

/** Mode of the injected page scripts (`PageConfig.mode`). */
export const PAGE_MODES = Object.freeze({ CAPTURE: 'capture', SHELF: 'shelf' });

/** Commands of the manifest. */
export const COMMANDS = Object.freeze({ START: 'start-capture', INSERT: 'insert-capture' });

/** Pages where extensions cannot run scripts. The service worker refuses these early. */
export const RESTRICTED_SCHEMES = Object.freeze([
  'chrome:',
  'chrome-extension:',
  'chrome-untrusted:',
  'chrome-search:',
  'devtools:',
  'view-source:',
  'about:',
  'edge:',
  'brave:',
  'comet:',
  'opera:',
  'vivaldi:',
]);
export const RESTRICTED_HOSTS = Object.freeze([
  'chromewebstore.google.com',
  'chrome.google.com',
  'microsoftedge.microsoft.com',
]);

/** Extension-relative paths of the extension's own pages and scripts. */
export const PATHS = Object.freeze({
  serviceWorker: 'src/sw/service-worker.js',
  offscreen: 'src/offscreen/offscreen.html',
  result: 'src/result/result.html',
  options: 'src/options/options.html',
  /** Injected into the page in this order (classic scripts, isolated world). */
  pageScripts: Object.freeze([
    'src/page/page-lib.js',
    'src/page/ui-kit.js',
    'src/page/overlay.js',
    'src/page/toast.js',
    'src/page/shelf.js',
    'src/page/agent.js',
  ]),
});
