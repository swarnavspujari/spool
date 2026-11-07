// @ts-check
/**
 * Shared type definitions (JSDoc only, no runtime code).
 * Import a type in another file with a JSDoc typedef of import('../shared/types.js').Rect.
 *
 * Units: plain names are CSS px. Names that end in `Px` are device px
 * (the pixels of a captureVisibleTab image). Names that end in `Ms` are milliseconds.
 */

/** @typedef {{ x: number, y: number, width: number, height: number }} Rect */
/** @typedef {{ width: number, height: number }} Size */
/** @typedef {'initial' | 'down' | 'up'} Direction */
/** @typedef {'high' | 'standard'} TileTier */

/**
 * User settings (stored in chrome.storage.sync under the key "settings").
 * @typedef {Object} Settings
 * @property {number} overlapCss     Overlap between capture steps, CSS px.
 * @property {number} settleMs       Wait after each scroll before capture.
 * @property {number} maxHeightCss   Stop when the covered height reaches this, CSS px.
 * @property {boolean} hideOverlays  Hide fixed/sticky elements that would repeat.
 * @property {TileTier} tileTier     Tile size preset for AI vision models.
 * @property {boolean} saveTiles     "Save all" includes the tiles.
 * @property {boolean} saveFull      "Save all" includes the full image.
 * @property {boolean} copyOnDone    Done copies the full image to the clipboard.
 * @property {string} folderName     Subfolder of Downloads. Already sanitized.
 */

/**
 * Data the page agent sends with each frame. Everything is CSS px in viewport coordinates.
 * @typedef {Object} FrameMeta
 * @property {Direction} direction
 * @property {Size} viewport      window.innerWidth / window.innerHeight at capture time.
 * @property {Rect} rect          Capture rect. Clipped to the scroll target's visible box.
 *                                The same for every frame of a session.
 * @property {number} contentY    Content coordinate (inside the scroll target) of rect's top edge.
 */

/** @typedef {'first'|'exact'|'corrected'|'ambiguous'|'unmatched'|'duplicate'} SeamStatus */

/**
 * Result of a seam search between two vertically overlapping slices (src/lib/seam.js).
 * @typedef {Object} SeamMatch
 * @property {SeamStatus} status  'exact' | 'corrected' | 'ambiguous' | 'unmatched'
 * @property {number} shift       Rows to ADD to the lower slice's expected offset. 0 unless corrected.
 * @property {number} meanDiff    Mean absolute difference at the chosen shift (0-255).
 */

/** @typedef {{ status: SeamStatus, shiftPx: number, meanDiff: number }} SeamResult */

/**
 * Offscreen reply to a stored frame. It goes from the offscreen document to the service worker.
 * The page gets only PageIntake.
 * @typedef {Object} IntakeResult
 * @property {number} index          Stored slice index, or -1 when seam.status is 'duplicate'.
 * @property {number} sliceCount
 * @property {number} widthPx
 * @property {number} totalHeightPx  Height of the assembled image so far.
 * @property {number} tileCount      Tiles the image needs so far, for the session's tile tier.
 * @property {SeamResult} seam
 * @property {number} storedBytes    Sum of stored PNG bytes in this session.
 */

/**
 * The part of an IntakeResult that the service worker passes to the page agent (reply of
 * `page/capture-frame`). The page is the least trusted context, so it gets only what it uses for
 * its status line and its stop rules. `widthPx`, `storedBytes`, `seam.shiftPx` and
 * `seam.meanDiff` stay in the service worker: they come from the pixels of the capture.
 * @typedef {Object} PageIntake
 * @property {number} index          Stored slice index, or -1 when seam.status is 'duplicate'.
 * @property {number} sliceCount
 * @property {number} totalHeightPx  Height of the assembled image so far.
 * @property {number} tileCount
 * @property {{ status: SeamStatus }} seam
 */

/** @typedef {{ index: number, yPx: number, heightPx: number, seamStatus: SeamStatus }} SliceInfo */

/**
 * @typedef {Object} SessionManifest
 * @property {string} sessionId
 * @property {string} title          Page title at session start (may be empty).
 * @property {string} sourceHost     Host name of the captured page ("github.com"), or '' when it has
 *                                   none (a local file). The worker reads it from the sender, never
 *                                   from the page's message.
 * @property {number} createdAt      Epoch ms.
 * @property {number} widthPx
 * @property {number} totalHeightPx
 * @property {number} scale          Device px per CSS px.
 * @property {SliceInfo[]} slices    Sorted by yPx ascending. yPx is normalized: the first is 0.
 * @property {string[]} warnings     Short, plain-English lines for the result page.
 */

/**
 * One copy operation of the assembly plan (src/lib/assemble.js). Device px.
 * @typedef {Object} Piece
 * @property {number} sliceIndex  SliceInfo.index of the source slice.
 * @property {number} srcY        First row inside the source slice.
 * @property {number} dstY        First row in the destination (full image or range).
 * @property {number} height      Row count.
 */

/**
 * One output tile (src/lib/tiles.js). src* are rows of the full image; out* are after scaling.
 * @typedef {Object} TilePlan
 * @property {number} index
 * @property {number} srcY
 * @property {number} srcHeight
 * @property {number} outWidth
 * @property {number} outHeight
 */

/** @typedef {{ code: string, message: string }} ErrorInfo */
/** @typedef {{ ok: false, error: ErrorInfo }} ErrorResponse */

/**
 * Where a finished capture was saved (docs/contracts.md section 7.3).
 * 'folder': the folder that the user chose in Options. 'downloads': chrome.downloads, below
 * Downloads. 'none': nothing was saved (the user turned both off, or the save failed).
 * @typedef {'folder' | 'downloads' | 'none'} SaveLocation
 */

/**
 * Result of the save step. `label` is short text for the toast: the names of the chosen folder
 * and its sub folders joined by "/" ("Pictures/Screenshots"), or "Downloads/<folderName>", or
 * "Not saved".
 * @typedef {Object} SaveInfo
 * @property {SaveLocation} location
 * @property {string} label
 * @property {number} files            Files that were saved.
 * @property {boolean} needsPermission A folder is chosen, but the browser has not granted access
 *                                     now, or the folder is gone: the files went to Downloads.
 *                                     The toast offers "Reconnect".
 * @property {string} [error]          Short, plain message when something failed.
 * @property {number} [failed]         With `error`, when some files were saved and others were not:
 *                                     how many files did not save. The files that did are `files`.
 * @property {string} [folderLabel]    With `needsPermission`: the chosen folder that could not be
 *                                     used, like `label` ("Pictures/Screenshots").
 * @property {boolean} [askFolder]     Set by the service worker, for the toast only: this is the one
 *                                     capture that asks "Save to Pictures › Screenshots?" (no folder
 *                                     is chosen, and the save went to Downloads).
 */

/**
 * What the page agent, the shelf and the result page know about a finished capture. The service
 * worker passes it on field by field (`toPageSummary` in src/sw/handlers.js). It holds the user's
 * own capture bytes only as the thumbnail.
 * @typedef {Object} FinishSummary
 * @property {string} sessionId
 * @property {string} title                 Page title at the start (may be empty).
 * @property {string} sourceHost            Host name of the captured page, or '' (a local file).
 * @property {number} createdAt             Epoch ms of the start of the session.
 * @property {number} widthPx
 * @property {number} heightPx              Height of the full image.
 * @property {number} tileCount             `planTiles(widthPx, heightPx, tileTier).length`.
 * @property {TileTier} tileTier
 * @property {boolean} fitsOneImage         `fitsOneImage(planTiles(...), widthPx)`: one tile that
 *                                         is the full image 1:1. A scaled single tile is false.
 * @property {number} fullBytes             Size of the full PNG.
 * @property {string} thumbnailPngBase64    The top of the image, at most 320 x 480 px.
 * @property {number} thumbnailWidthPx
 * @property {number} thumbnailHeightPx
 * @property {SaveInfo} save
 * @property {string[]} warnings            Short, plain-English lines.
 * @property {boolean} [teach]              Set by the service worker, for the toast only: one of the
 *                                          first captures of more than one tile. The toast stays until
 *                                          the user dismisses it (it teaches the keys).
 */

/**
 * What the shelf gets about the last capture (reply of `page/shelf-info`). The shelf runs in
 * ANY tab, so it gets only what it shows: the size, the age, the host name of the captured page
 * (the user sees where the pixels come from), the place of the saved files (for the hint about a
 * desktop app) and the thumbnail. No title, no session ID and no warnings, because the shelf page
 * must learn nothing that it does not show.
 * @typedef {Object} ShelfSummary
 * @property {number} tileCount
 * @property {number} widthPx
 * @property {number} heightPx
 * @property {number} createdAt             Epoch ms of the start of the session.
 * @property {string} sourceHost            Host name of the captured page, or '' (a local file).
 * @property {string} saveLabel             `SaveInfo.label` of a save that wrote files, else ''.
 * @property {string} thumbnailPngBase64
 * @property {number} thumbnailWidthPx
 * @property {number} thumbnailHeightPx
 */

/**
 * The keys of the commands, for the texts of the toast and the shelf. Read in the service worker with `chrome.commands.getAll()`.
 * @typedef {Object} Shortcuts
 * @property {string} start   `start-capture` (default Alt+Shift+S). Empty: no key set.
 * @property {string} insert  `insert-capture` (default Alt+Shift+V). Empty: no key set.
 */

/**
 * A key as it shows on screen (src/lib/keys.js): the keycaps, and the same keys in one piece.
 * @typedef {{ parts: string[], text: string }} KeyLabel
 */

/**
 * The keys of the texts, made by the service worker for the system of the user ("⌥" and "⌘" on a
 * Mac): the two commands as the browser has them now, and the Paste key.
 * @typedef {Object} KeyLabels
 * @property {KeyLabel} start   `start-capture`. No parts: no key set.
 * @property {KeyLabel} insert  `insert-capture`. No parts: no key set.
 * @property {KeyLabel} paste   Ctrl+V, or ⌘V on a Mac.
 */

/**
 * Numbers that a page script needs and cannot import (docs/contracts.md section 5).
 * @typedef {Object} PageLimits
 * @property {number} maxImagesPerMessage      `MAX_IMAGES_PER_MESSAGE`: most images that the shelf
 *                                             inserts in one paste.
 * @property {number} maxClipboardBitmapBytes  `MAX_CLIPBOARD_BITMAP_BYTES`.
 */

/** @typedef {'capture' | 'shelf'} PageMode */

/**
 * Object the service worker injects as globalThis.__spool.config before the page scripts.
 * @typedef {Object} PageConfig
 * @property {number} protocolVersion
 * @property {string} sessionId             A new capture session (mode 'capture'). In mode
 *                                          'shelf' it is only a fresh ID that no session uses.
 * @property {Settings} settings
 * @property {PageMode} [mode]             'capture' starts the selection overlay. 'shelf' shows
 *                                          the last capture (docs/contracts.md section 7.1). The
 *                                          service worker always sets it. A missing value means
 *                                          'capture'.
 * @property {string} [shelfToken]          Token of the shelf (mode 'shelf'). An empty string in
 *                                          mode 'capture'.
 * @property {Shortcuts} [shortcuts]        The keys of the two commands as the browser has them
 *                                          now (the user can change them). An empty string: no key
 *                                          is set. A missing value: the page shows the defaults.
 * @property {KeyLabels} [keys]             The same keys, written for the system (a Mac gets
 *                                          "⌃⇧V", a PC "Alt+Shift+V"), and the Paste key. A missing
 *                                          value: the page writes `shortcuts` as they are.
 * @property {PageLimits} [limits]          Limits of the service worker. A missing value: the page
 *                                          uses the same numbers that it has built in.
 * @property {Readonly<Record<string, string>>} msg     MSG table from protocol.js.
 * @property {Readonly<Record<string, string>>} err     ERR table from protocol.js.
 * @property {Readonly<Record<string, string>>} target  TARGET table from protocol.js.
 */

export {};
