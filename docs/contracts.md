# Module contracts

This file is the source of truth for the interfaces between modules. Change it only together
with all affected modules. Types are in `src/shared/types.js`. Message rules are in
`src/shared/protocol.js`. Constants are in `src/shared/constants.js`.

Words: in the code and in this file a cut of the full image is a **tile**. In the user interface the
same thing is an **AI screenshot** (in code: `tile*`). A scroll step of the user is a `slice` in the code
and a **step** in the interface. The overlay and the toast are the HUD and the toast; the shelf (a card
that inserts the last capture) is never named in the interface.

Units: plain names are CSS px. Names that end in `Px` are device px (pixels of a
`captureVisibleTab` image). Names that end in `Ms` are milliseconds.

## 1. Contexts and ownership

| Context | Files | Owns |
|---|---|---|
| Service worker (ES module) | `src/sw/*` | Entry points, injection, capture, offscreen lifecycle. **Holds no session state** (it can restart at any time). |
| Page agent (classic scripts, isolated world) | `src/page/page-lib.js`, `overlay.js`, `agent.js` | Selection UI, scrolling, page style changes and their restore. |
| Offscreen document (ES module) | `src/offscreen/*`, `src/render/*` | Session store: cropped slices (PNG blobs) and seam data, in memory only. Finalize: tiles, full PNG, thumbnail, the last capture, the save step (section 7). |
| Result page (ES module) | `src/result/*` | Shows the last capture, copy and save (section 6, section 7.4). |
| Options page (ES module) | `src/options/*` | Settings form. |
| Pure libraries (ES module) | `src/lib/*`, `src/shared/*` | No `chrome.*` and no DOM unless stated. Unit-tested in Node. |

The service worker registers all its listeners at the top level of `src/sw/service-worker.js`,
when the script first runs. Chrome wakes the worker only for listeners that exist at that time.
The listeners are: `action.onClicked`, `commands.onCommand`, `runtime.onMessage`,
and `tabs.onRemoved`.

The service worker is known by its script URL, `PATHS.serviceWorker`
(`src/sw/service-worker.js`). Do not rename this file, and do not change
`background.service_worker` in `manifest.json`. The sender check (section 3) recognizes a
message from the worker by this URL. The end-to-end tests load a copy of the extension. The
copy keeps this URL.

## 2. Capture flow

1. Toolbar click or command `start-capture` → SW `startCapture(tab)`. A second start for the
   same tab is ignored while the first start runs.
2. SW refuses restricted URLs (`RESTRICTED_SCHEMES`, `RESTRICTED_HOSTS`): badge `!` for 4 s.
   The badge title gives the reason. A failed injection shows the same badge.
3. SW reads the settings (the defaults when the storage fails) and the keys of the two commands
   (`chrome.commands.getAll()`: an empty string for a command with no key, the manifest keys when
   the API fails), makes a session ID (a random UUID), and builds the `PageConfig` (with
   `shortcuts: { start, insert }`). It injects into the top frame, isolated world:
   a. `func` that returns `true` when `globalThis.__spool.agent?.isActive()` is true. It then
      leaves `config` unchanged, and SW stops here: the running session keeps its own config.
      Otherwise it sets `globalThis.__spool.config = PageConfig` and returns `false`.
   b. `files: PATHS.pageScripts` (each file is an IIFE and is safe to inject twice),
   c. `func` that calls `globalThis.__spool.agent.start()`. It returns `false` when no agent
      is registered (SW shows the `!` badge). `start()` does nothing for a malformed config.
4. Agent shows the selection overlay. The user drags a box, or clicks a panel.
5. Agent finds the scroll target and clips the box to the target's visible box and to the
   viewport. It sends `page/session-open`. SW reads the tile tier from the settings, then calls
   `ensureAndSend` of the offscreen client: it creates the offscreen document when needed and
   sends `offscreen/session-open` under one lock, so `closeIfIdle` cannot close the document in
   between. When nothing is left of the box, or SW refuses the session, the agent shows the
   error and calls `beginSelect()` again.
6. Agent captures the initial frame (see section 5), then waits for commands. When this capture
   fails, the next step captures the initial frame first.
7. Each step: agent first puts the target back at the scroll position of the last frame, when
   something else moved it (a wheel notch that reached the page, a key): the next frame is then
   measured from the last one, and the offscreen document does not refuse it as "The page moved
   too far". Then it scrolls the target, waits, then sends `page/capture-frame`. The agent sends
   no frame when the box no longer fits the viewport (the window was resized). It shows an error.
   SW needs the offscreen document (else `E_SESSION_NOT_FOUND`). It then registers a temporary
   `tabs.onActivated` listener for the window of the sender, checks that the tab is the active
   tab of its window, calls `captureVisibleTab` (rate-limited), checks again, and removes the
   listener. The queue retries two transient Chrome errors, each a bounded number of times: the
   per-second quota (3 retries, 600 ms apart) and `image readback failed` (2 retries, 100 ms apart:
   the tab has not presented a frame yet). Every retry waits for a rate slot, and runs the active-tab
   check and the switch count again right before the call. A tab switch in that window at any time
   in between, even one that the two checks do not see, gives `E_TAB_NOT_VISIBLE`, and the image is
   not sent on (see "Tab switch during a capture" in section 3). Then SW sends `offscreen/add-frame`.
   Offscreen crops, checks the seam and the limits (section 4), stores the slice, and replies with
   `IntakeResult`. SW gives the agent only the part that it uses, `PageIntake`.
8. Done → agent sends `page/finish`. SW needs the offscreen document and sends
   `offscreen/finalize` with the save settings (section 7.9). The offscreen document finishes the
   session, builds the tiles, the thumbnail and the full PNG, frees the slices, keeps the outputs as
   the last capture and saves the files. SW replies `{ summary }` (a `FinishSummary`). **No result
   tab opens.**
   - When SW replies with an error, the agent keeps the session open: it shows the message, and
     Done and Cancel stay available. The session is finished in the store, so Done can be tried
     again (`offscreen/finalize` builds again).
   - When SW replies `ok`, the agent restores the page, removes the overlay and shows the toast.
   - When the agent has stored no frame, Done sends nothing. The agent stays open and shows
     "Nothing was captured yet. Scroll once, or Cancel." (error level, so the finish button goes
     back to its label). Cancel closes it and sends `page/cancel`.
9. The user can open the result page from the toast (`page/open-result`: SW checks that the last
   capture is the capture of this session and this tab, then opens `result.html#<sessionId>`). The
   result page reads the outputs of the last capture (`offscreen/last-info`, `offscreen/last-get`).
   Reading does not drop them. When the offscreen store is empty **and** no last capture is kept,
   the offscreen document sends `sw/offscreen-idle`; SW then pings the document and closes it if it
   has 0 sessions and no last capture (`closeIfIdle`: ping and close run under the same lock that
   creates the document).
10. Cancel → agent sends `page/cancel`, restores the page. SW sends `offscreen/session-drop` with
    the tab of the sender. The offscreen document drops the session only when it is unfinished
    and belongs to that tab. When no session is left, SW calls `closeIfIdle`.
11. The page unloads (`pagehide`) → the agent restores the page and sends `page/cancel` on a
    best-effort basis. It does not send it while it finishes (the result page needs the session).
12. A tab closes (`tabs.onRemoved`) → SW sends `offscreen/drop-tab`: the offscreen document drops
    the unfinished sessions of the tab and ends its shelf tokens. The handler does nothing when no
    offscreen document exists. It never creates one. There is no listener for a page load:
    Chrome has no filter for `tabs.onUpdated`, so it would wake the worker on every status change
    of every tab. A page that unloads makes the agent send `page/cancel` (step 11), and the idle
    timer of the session store drops a session whose page died without it.
13. Command `insert-capture` → SW opens the shelf in the active tab (section 7.1, step 5): the same
    injection as step 3, with `config.mode = 'shelf'` and a new `config.shelfToken`.

## 3. Messages

Envelope: `{ v: 1, target: 'sw' | 'offscreen', type, ...fields }`. Build with
`makeMessage(type, fields)` (page scripts build the same shape from `PageConfig`).
Reply: `{ ok: true, ...data }` or `{ ok: false, error: { code, message } }`.
Every receiver calls `routeCheck(msg, sender, target, env)` first:
`null` → ignore (return `false` from the listener), error → reply with it.
Senders use `chrome.runtime.sendMessage`. Listeners use `sendResponse` and return `true`.

| Type | From → To | Fields | Reply data |
|---|---|---|---|
| `page/session-open` | content → SW | `sessionId, title` | `{}` |
| `page/capture-frame` | content → SW | `sessionId, meta: FrameMeta` | `{ intake: PageIntake }` |
| `page/finish` | content → SW | `sessionId` | `{ summary: FinishSummary }` |
| `page/cancel` | content → SW | `sessionId` | `{}` |
| `page/get-clipboard`, `page/clipboard-fallback`, `page/get-tile`, `page/open-result`, `page/open-options`, `page/show-in-folder`, `page/shelf-info`, `page/shelf-get` | content → SW | section 7.4 | section 7.4 |
| `sw/offscreen-idle` | offscreen → SW | none | `{}` |
| `sw/download` | offscreen → SW | `files: [{ path, url }]` | `{ saved, rejected, interrupted }` |
| `offscreen/session-open` | worker → offscreen | `sessionId, tabId, title, host, tileTier` | `{}` |
| `offscreen/add-frame` | worker → offscreen | `sessionId, tabId, dataUrl, meta` | `{ intake: IntakeResult }` |
| `offscreen/session-drop` | worker → offscreen | `sessionId, tabId` | `{ remaining: number }` |
| `offscreen/drop-tab` | worker → offscreen | `tabId` | `{ remaining: number }` |
| `offscreen/ping` | worker → offscreen | none | `{ sessions: number, lastCapture: boolean }` |
| `offscreen/finalize`, `offscreen/output-info`, `offscreen/get-output`, `offscreen/shelf-grant`, `offscreen/shelf-info`, `offscreen/shelf-get` | worker → offscreen | section 7.4 | section 7.4 |
| `offscreen/last-info`, `offscreen/last-get` | result → offscreen | section 7.4 | section 7.4 |

Rules:
- The SW derives `tabId` and `windowId` from `sender.tab`, never from message fields. A message
  from a content script is valid only from the top frame of a tab (`frameId === 0`).
- A message must have exactly the fields of its type. An extra field, a missing field or a bad
  value gives `E_BAD_MESSAGE`. `sessionId` is a lowercase UUID v4. `title` has at most 512
  characters. `dataUrl` is a PNG data URL. `meta` has exactly the keys `direction`,
  `viewport`, `rect` and `contentY`, and its `rect` lies inside its `viewport` (1 px
  tolerance). `contentY` is at least -1 and at most 10,000,000 (CSS px).
- `host` (`offscreen/session-open`) is the host name of the captured page: what `URL.hostname` gives (lower case
  letters, digits, `.`, `-`, `_`; an IPv6 address in brackets; punycode for other letters), at most 253
  characters, or an empty string for a page with no host (a local file). The worker reads it from
  `sender.url` (`sourceHostOf` in `src/lib/source-host.js`): no scheme, port, path, query or fragment, and
  `page/session-open` has no such field, so the page cannot say where it is. `isSourceHost` in
  `src/shared/protocol.js` checks it.
- `meta` has no frame number and no pixel ratio: the offscreen document needs neither (it takes
  the scale from the bitmap and the viewport). The agent counts the frames that got an `ok` reply
  for itself, to know whether there is anything to finish. A frame that fails is not counted. This
  includes `E_TAB_NOT_VISIBLE`. A frame that the offscreen document reports as a duplicate
  (`index` −1) counts.
- Offscreen checks `session.tabId === tabId` for every worker message that carries `tabId`.
  Mismatch → `E_SESSION_NOT_FOUND`.
- `offscreen/drop-tab` drops only **unfinished** sessions of that tab (finished sessions wait
  for their result page or for `SESSION_TTL_MS`).
- `offscreen/session-drop` (cancel) drops only an **unfinished** session that belongs to the
  given `tabId`. The SW takes the tab from `sender.tab`, so a page can cancel only its own
  capture. In every other case (unknown id, other tab, other state) the offscreen document
  changes nothing and replies `{ remaining }` without an error. So a cancel can be repeated, and it
  tells the caller nothing about the state of a session. A finished session is freed by
  `offscreen/finalize` itself (7.9), by `SESSION_TTL_MS`, or by the next capture: no message
  releases it.
- The offscreen document knows the worker only by the URL of its script (`PATHS.serviceWorker`),
  without a tab. A sender with no URL is `unknown`, also when it has no tab.
- Errors shown to the user use the `message` text. Keep it short and plain.
- The router replies exactly once to every message that it accepts. A handler that throws
  `SpoolError` gives `{ ok: false, error }`. Any other error gives `E_INTERNAL` with the
  text "Something went wrong. Try again." The details go only to the console of the worker.

SW handlers:

| Message | What the SW does |
|---|---|
| `page/session-open` | Reads the tile tier from the settings (the default when the storage fails) and the host name from `sender.url`. Calls `ensureAndSend('offscreen/session-open', ...)`. Then shows the "capturing" state on the toolbar button of the tab: the badge `●` (amber) and a title (`src/sw/capturing.js`; best effort, never an error). |
| `page/capture-frame` | Needs the offscreen document, else `E_SESSION_NOT_FOUND` with the text "This capture has ended. Start a new capture." Registers the temporary `tabs.onActivated` listener, checks the active tab, captures, checks the active tab again, removes the listener, sends `offscreen/add-frame`. Replies with `PageIntake` only. |
| `page/finish` | Needs the offscreen document (same error). Sends `offscreen/finalize` with `sessionId`, the `tabId` of the sender and `saveTiles`, `saveFull`, `folderName` of the settings (the defaults when the storage fails). Replies `{ summary }`: `parseSummary` in `src/sw/summary.js` checks it and copies only the known fields (`E_INTERNAL` when it does not fit). Clears the badge of the tab. For a capture that goes to Downloads with no folder chosen, one of the first three, it sets `summary.save.askFolder`, and for one of the first three captures of more than one tile it sets `summary.teach` (7.10). Opens no tab. |
| `page/get-clipboard`, `page/get-tile` | Need the offscreen document. Send `offscreen/get-output` with the `tabId` of the sender (`item` `'full'` or the tile index). Reply `{ pngBase64 }`. |
| `page/clipboard-fallback` | Like `page/get-clipboard` for `'full'`, then writes the clipboard in the worker (`src/sw/clipboard.js`, feature-detected). Replies `{ copied }`. An image over the message limit or no full image: `{ copied: false }`. |
| `page/open-result` | Sends `offscreen/output-info` (same tab rule), then opens the result tab next to the sender tab. |
| `page/open-options` | Opens `options.html#<section>` next to the sender tab. `section` is `save`, `setup` or `reconnect` (7.4). Needs no offscreen document. |
| `page/show-in-folder` | "Show in folder" of the toast. Sends `offscreen/output-info` (same tab rule), and needs a save in Downloads (`save.location` `downloads`): the browser can reveal a file that it downloaded and has no call for a folder that the user picked, so the toast shows the button for Downloads only. Reads the download ID that `sw/download` kept for the last save (the first complete file: the full image when there is one), asks `chrome.downloads.search({ id, state: 'complete', exists: true, limit: 1 })` whether that file is still there, and calls `chrome.downloads.show(id)`. It never looks for a file by the name of a folder. Needs no permission that the extension does not have. `E_INTERNAL` "Spool cannot show these files. Open your Downloads folder." for a save elsewhere, `E_SESSION_NOT_FOUND` "Spool cannot find the saved files. Open your Downloads folder." when no ID was kept (the browser restarted) or the file is gone. |
| `page/shelf-info`, `page/shelf-get` | Send `offscreen/shelf-info` or `offscreen/shelf-get` with the token and the `tabId` of the sender. Without an offscreen document: `{ summary: null }` and `E_SESSION_NOT_FOUND`. `page/shelf-info` checks the whole summary and replies only the `ShelfSummary` (7.4): the shelf runs in any tab. |
| `sw/download` | Refuses a `blob:` URL of another extension ID. Starts the files with `src/sw/downloads.js` (section 7.9). |
| `page/cancel` | Clears the badge of the tab. Sends `offscreen/session-drop` with `sessionId` and the `tabId` of the sender. Does nothing, and replies `{}`, when no offscreen document exists, when no such session exists, or when the session is finished or belongs to another tab. It never creates the offscreen document. When no session remains, it calls `closeIfIdle`. |
| `sw/offscreen-idle` | Calls `closeIfIdle`. |

Tab switch during a capture (`captureOwnTab` in `src/sw/handlers.js`):
- `captureVisibleTab(windowId)` captures the tab that is visible at that moment, not the tab of
  the sender. The capture queue can wait for a rate slot (550 ms) and for retries (quota: 600 ms
  each, `image readback failed`: 100 ms each) between the first check and the capture. A tab that
  the user used before keeps its `activeTab` grant. Two "is this tab active" checks are not enough: the user can leave the tab after the
  first check and come back before the second one, and both pass.
- So `page/capture-frame` registers a `chrome.tabs.onActivated` listener for the call, before the
  first check, and removes it in a `finally` after the second check. Any activation with the
  `windowId` of the sender in that time fails the call with `E_TAB_NOT_VISIBLE` ("Go back to this
  tab to continue."). The activation of the sender tab itself counts too. A switch that is seen
  before the capture also skips the capture. In every failure the image is not sent to the
  offscreen document.
- The queue also calls a check before every attempt of one capture (`beforeAttempt`, awaited after the
  wait for the slot): the active-tab check and the switch count. A user who left the tab while a retry
  waited gets `E_TAB_NOT_VISIBLE` and no more call to `captureVisibleTab` is made, also when the
  user came back before the retry started.
- The listener is temporary on purpose. The worker is awake while it handles the message. A
  listener at the top level would wake the worker at every tab switch of every window.
- The events and the replies of `tabs.query` use different channels, so an event can arrive a
  little after a later reply. This cannot hide a wrong image: a tab that the capture shows was
  activated before the capture started, so its event is older than the capture and than the second
  check.
- The agent treats `E_TAB_NOT_VISIBLE` as before: it pauses Auto, and the next step captures the
  same frame again.

Data for the page (`toPageIntake` in `src/sw/handlers.js`):
- The page agent is the least trusted context. `page/capture-frame` replies with
  `{ intake: PageIntake }`: `index`, `sliceCount`, `totalHeightPx`, `tileCount` and
  `seam: { status }`. These are the fields that `agent.js` reads. `widthPx`, `storedBytes`,
  `seam.shiftPx` and `seam.meanDiff` stay in the worker: they are derived from the pixels of the
  capture, and `meanDiff` would let a compromised renderer measure the content of a cross-origin
  frame. When the offscreen reply lacks one of the fields, or `seam.status` is not a `SeamStatus`,
  SW replies `E_INTERNAL` instead of a partial answer.
- A new field for the page needs a change of `PageIntake` and of this section, and a reason why
  the page needs it.

Offscreen client (`src/sw/offscreen-client.js`):
- Create, close and the idle check run one at a time, under one lock in the memory of the worker.
  After a restart of the worker the lock is gone. `chrome.runtime.getContexts()` then tells
  whether the document exists.
- `ensureAndSend(type, fields)` creates the document when needed and sends the message, as one
  step under the lock. Use it for the message that starts a session.
- `closeIfIdle()` pings the document and closes it only when the reply says `sessions: 0` and
  `lastCapture: false`. Any failure means "do not close". It runs under the same lock.
- `sendToOffscreen(type, fields)` takes no lock and never creates the document.
  `offscreenExists()` never creates it.

Error codes (`ERR` in `src/shared/protocol.js`):

| Code | Meaning |
|---|---|
| `E_BAD_MESSAGE` | Unknown type or version, or a bad or extra field. |
| `E_FORBIDDEN_SENDER` | The sender is not allowed to send this type. |
| `E_TAB_NOT_VISIBLE` | The tab is not the active tab of its window. The agent pauses Auto. |
| `E_CAPTURE_FAILED` | `captureVisibleTab` failed (after the retries of the two transient errors), the image could not be read, the page zoom changed, or the page moved too far (the frame does not touch the captured rows). |
| `E_SESSION_NOT_FOUND` | No such session, no offscreen document, a session of another tab, or a session in the wrong state. |
| `E_SESSION_TOO_LARGE` | A limit of the store would be passed: the PNG data of the session (`SESSION_MAX_BYTES`), the PNG data of all sessions (`TOTAL_MAX_BYTES`), or the height of the image (`MAX_TOTAL_HEIGHT_PX`). |
| `E_INTERNAL` | Any other failure, for example the result tab cannot open. |

## 4. Pure library APIs (`src/lib`)

The libraries have no `chrome.*` and no DOM. Wrong types throw `TypeError`. Wrong values throw
`RangeError`.

### `geometry.js`
- `cropRectPx(rect: Rect, viewport: Size, bitmapWidth: number, bitmapHeight: number)`
  → `{ sx, sy, sw, sh, scale }`. `scale = bitmapWidth / viewport.width`. It does not use
  `devicePixelRatio`: browser zoom and fractional display scaling make the two differ.
  - Rounding works on **edges** and rounds **inwards**. The crop holds only device pixels that
    the rect covers, so it never has a row or a column outside the element.
    `sx = ceil(x*scale − EPS)`, `sy = ceil(y*scale − EPS)`,
    `ex = floor((x+width)*scale + EPS)`, `ey = floor((y+height)*scale + EPS)`,
    `sw = ex − sx`, `sh = ey − sy`.
  - `EPS = 0.01` device px. A pixel counts when at least 99% of it is inside the rect. The margin
    absorbs floating-point error: `311 * (342 / 311)` is `341.99999999999994`, and an edge on a
    pixel boundary must stay on it.
  - Why not `round(height*scale)`: at scale 1.25 an element of 882.5 device rows gave 883 rows,
    one white row too many. The edge rule gives 882.
  - Then the crop is clamped into the bitmap: `sx, sy` into `[0, bitmap − 1]`, `ex, ey` into
    `[sx + 1, bitmap]`. So `sw, sh >= 1` (also for a sub-pixel rect) and the crop never leaves
    the bitmap. A rect that reaches the viewport edge ends exactly on the bitmap edge.
  - The result depends only on the arguments. Every frame of a session (same rect, viewport and
    bitmap size) gets the same crop.
- `contentYToPx(contentY: number, scale: number)` → `Math.round(contentY * scale)`.

### `seam.js`
- `rowSignature(rgba: Uint8ClampedArray | Uint8Array, width: number, height: number, cols: number)`
  → `Uint8Array` of `height * cols`, row by row. Each value is the mean luminance of one row
  inside one column bin. Per pixel the luminance is `(77R + 150G + 29B) >> 8` (alpha is
  ignored). The bin mean is rounded to the nearest integer.
  - Bin `k` covers the pixel columns `[floor(k*width/cols), floor((k+1)*width/cols))`. When
    `width` is not a multiple of `cols`, bins differ by one pixel.
  - `cols` may be larger than `width`. Every bin still covers at least one pixel, and
    neighbouring bins repeat the same pixel.
  - Callers use `cols = Math.min(SIGNATURE_MAX_COLS, width)`.
- `matchSeam({ upper, lower, cols, upperHeight, lowerHeight, expectedOffset, maxShift, minOverlap, threshold, maxRowDiff, flatStdDev })`
  → `SeamMatch { status, shift, meanDiff }`. `upper` and `lower` are signatures. All parameters
  are required. The store passes the values of `SEAM` (`threshold` 3, `maxRowDiff` 24,
  `flatStdDev` 2, `minOverlapRows` 16, `maxShiftRows` 256).
  - `expectedOffset` = rows from the top of `upper` to the top of `lower`. For a shift `d`
    (`|d| <= maxShift`, `expectedOffset + d >= 0`), `upper` rows `[expectedOffset + d, upperHeight)`
    are compared with `lower` rows from 0. The overlap has
    `min(upperHeight − expectedOffset − d, lowerHeight)` rows. A shift with fewer than
    `minOverlap` rows is skipped. `shift` in the result is the `d` to ADD to the expected offset.
  - `meanDiff(d)` is the mean absolute difference over all values of the overlap (0–255).
    `rowDiff(d)` is the largest mean absolute difference of one row of the overlap.
  - A shift is **acceptable** when `meanDiff(d) <= threshold` **and** `rowDiff(d) <= maxRowDiff`.
    The row rule is for mostly blank overlaps: a few rows that differ completely (for example
    2 rows of 300) hardly move the mean, but they show that the slices do not match there. It
    applies to `exact` and to `corrected`.
  - A shift is **flat** when the standard deviation of all values of its overlap (upper and
    lower together) is below `flatStdDev`.
  - Decision order:
    1. The overlap at `d = 0` is flat → `ambiguous`, shift 0.
    2. `d = 0` is acceptable → `exact`, shift 0.
    3. Else the acceptable `d` with the lowest `meanDiff` → `corrected`, shift `d`. Ties go to the
       smallest `|d|`, then to the positive shift. A shift whose own overlap is flat never wins:
       a blank region matches any other blank region, so it proves nothing.
    4. Else → `unmatched`, shift 0.
  - `meanDiff` of the result is the value at the reported shift. For `unmatched` it is the value
    at `d = 0`, or 255 when the overlap at `d = 0` has fewer than `minOverlap` rows (nothing was
    compared there).
  - The work for a shift stops as soon as it cannot be acceptable or cannot beat the best
    candidate. The result is the same as for a full comparison of every shift.

### `tiles.js`
- `tileGeometry(widthPx: number, tier: TileTier)` → `{ outWidth, scale, tileHeightOut, tileHeightSrc }`.
  `scale = min(1, maxLongEdgePx / widthPx)`, `outWidth = round(widthPx * scale)`,
  `tileHeightOut = min(maxLongEdgePx, floor(maxPatches / ceil(outWidth / PATCH_PX)) * PATCH_PX)`,
  `tileHeightSrc = floor(tileHeightOut / scale)`. An unknown tier throws `RangeError`.
- `planTiles(widthPx, heightPx, tier, overlapPx = TILE_OVERLAP_PX)` → `TilePlan[]`.
  - `overlapPx` is in **output** px (after scaling), a finite number >= 0.
    `overlapSrc = round(overlapPx / scale)`. Tiles start at
    `srcY = k * (tileHeightSrc − overlapSrc)`.
  - If `tileHeightSrc − overlapSrc < 1` (the overlap leaves no step), it throws `RangeError`.
  - `srcHeight = min(tileHeightSrc, heightPx − srcY)`. The last tile ends exactly at `heightPx`
    (shorter tile, no empty rows). One tile if the image fits. Every source row is in at least
    one tile.
  - `outHeight = max(1, round(srcHeight * scale))`. The floor of 1 is for a very short last tile
    of a strongly scaled image. `outHeight` never exceeds `tileHeightOut`.
- `isScaledTile(plan, widthPx)` → true when the tile is not the source rows 1:1.
  `fitsOneImage(plans, widthPx)` → true for exactly one tile that is the image 1:1. Then the tile
  and the full image are one picture and one file holds both. A single tile that is scaled (an image
  wider than the long edge of its tier) is a different picture: it is built, saved and offered on
  its own.

### `assemble.js`
- `planAssembly(slices: SliceInfo[])` → `{ totalHeight, pieces: Piece[] }`. It reads `index`,
  `yPx` and `heightPx` of each slice (whole numbers; `index >= 0`, `heightPx >= 1`) and ignores
  `seamStatus`. `yPx` may be relative to any origin: the result starts at the smallest one.
  - The input need not be sorted. Slices are ordered by `yPx` (the longer slice first when
    `yPx` is equal).
  - A slice that the others cover gives no piece: a slice inside another one, and a slice that
    its two neighbours cover together. Each remaining slice keeps at least one row.
  - Between neighbours A (upper) and B (lower) that overlap or touch, cut in the middle of the
    overlap: `cut = B.yPx + floor((A.yPx + A.heightPx − B.yPx) / 2)`. A gives the rows above
    `cut`, B gives the rows from `cut`.
  - Gaps (no overlap) are allowed. Each slice keeps its own edge, and `planAssembly` gives no
    piece for the gap rows. The renderer fills rows that no piece covers with white (the PNG is
    RGB and has no alpha, so unfilled rows would turn black).
  - `pieces` are sorted by `dstY` and never overlap. `dstY` counts from the smallest `yPx`.
    `totalHeight = max(yPx + heightPx) − min(yPx)`.
  - Empty input → `{ totalHeight: 0, pieces: [] }`.
- `piecesForRange(pieces: Piece[], y: number, height: number)` → `Piece[]` cut at the edges of
  the range, with `dstY` relative to `y`. `y` is a whole number >= 0 and `height` >= 1. A range
  that no piece touches gives `[]`.

### `png-stream.js`
- `crc32(bytes: Uint8Array, seed = 0)` → `number` (unsigned). `crc32(b, crc32(a))` equals the
  CRC of `a` followed by `b`.
- `createPngEncoder({ width, height })` → `{ writeRows(rgba, rowCount): Promise<void>, finish(): Promise<Blob> }`.
  Writes an 8-bit RGB PNG (alpha dropped). Uses `CompressionStream('deflate')` (zlib).
  Per-row adaptive filter (None/Sub/Up/Paeth, minimum sum of absolute values).
  Memory: no full-image buffer.
  - `writeRows` takes `rowCount * width * 4` bytes and at most the rows that are left.
    `finish` rejects with `RangeError` if fewer than `height` rows were written. It resolves to
    an `image/png` Blob.
  - **Calls must not overlap.** Await each `writeRows` and `finish` before the next call. A call
    that starts while another one runs rejects and changes nothing, and so does a call after
    `finish`.
  - A call with bad arguments rejects (`TypeError` or `RangeError`) without changing the encoder.

### `names.js` (done)
`sanitizePathSegment` (idempotent: sanitizing a result gives the same result, also for a name with
several dots such as `a.{b}.{c}`, which becomes `a_{b}_{c}`; `isDownloadPath` and `isFolderName`
rely on this), `tileFileName(index, count)` →
`screenshot-NN-of-MM.png` (the numbers have at least two digits and grow with the count).
Names of a finished capture (section 7.3): `captureStamp(date)` → `YYYY-MM-DD HH.mm.ss` (local
time, no colon); `captureBaseName(date, title)` → `Spool <stamp> <title>` (the title is sanitized
and cut at 48 code points; it is left out when nothing usable remains);
`captureFiles({ base, tileCount, saveTiles, saveFull, fitsOneImage })` → `{ kind, index?, path:
string[] }[]` in write order (full image first). One tile that is the full image 1:1
(`fitsOneImage`, default `tileCount === 1`) gives one flat file (the full image, or else the tile).
Any other capture, also one scaled tile, gives `<base>.png` and
`Spool for AI/<base>/screenshot-NN-of-MM.png`. Constants:
`CAPTURE_PREFIX`, `TILES_FOLDER_NAME` (`Spool for AI`), `CAPTURE_TITLE_MAX_LENGTH`.

### Image pipeline (`src/render`)
- `util.js` (pure): `planRowChunks`, `base64ToBytes` (the one decoder: the result page imports it too), `bytesToBase64`,
  `blobToBase64Text`,
  `createAsyncLru`, `thumbnailPlan(widthPx, heightPx)` (a `TilePlan` for the top of the image, at
  most 320 × 480, never scaled up) and `outputWarnings(...)`.
- `render.js` (browser): `createSliceStore`, `createRenderer`, `base64ToBlob`,
  `MAX_DECODED_SLICES`, `FULL_CHUNK_ROWS`. Moved from `src/result/render.js`. The memory rules are
  those of section 6 (at most 2 decoded bitmaps, the full PNG in chunks of at most 512 rows).

### Offscreen store (`src/offscreen/session-store.js`)
`createSessionStore({ imageOps, now, setTimer, clearTimer, onEmpty, maxBytes, totalMaxBytes, maxHeightPx, ttlMs, idleMs })`
→ `{ open, addFrame, finish, drop, release, dropTab, ping, manifest, getSlice, takeForAssembly,
stateOf }`. `offscreen.js` and `handlers.js` connect the messages of section 3 to these methods.
Two more options, `heldBytes()` and `releaseHeld()`, let the bytes of the last capture count in
`totalMaxBytes`: before the store refuses a frame for the total limit it calls `releaseHeld()` once. The store has no browser dependency: image
work goes through `imageOps`, time through `now`, `setTimer` and `clearTimer`. Defaults:
`maxBytes = SESSION_MAX_BYTES`, `totalMaxBytes = TOTAL_MAX_BYTES`, `maxHeightPx =
MAX_TOTAL_HEIGHT_PX`, `ttlMs = SESSION_TTL_MS`, `idleMs = SESSION_IDLE_MS`. Every failure is a
`SpoolError`.

Memory: the slices are `Blob` data, and the browser owns Blob storage. The store writes nothing to
any storage. But under memory pressure, Chromium may page Blob data to a temporary file in the
profile folder (`blob_storage`) and delete it when the Blob is freed. The extension cannot prevent
or observe this. "In memory" therefore means "the extension writes nothing", not "the data never
reaches the disk". The limits (`SESSION_MAX_BYTES` for one session, `TOTAL_MAX_BYTES` for all
sessions, `MAX_TOTAL_HEIGHT_PX` for one image) keep the amount small and bounded, and the timers
free a session that nobody claims.

- **`imageOps`** (browser version in `image-ops.js`, a fake in the unit tests):
  `{ decode(dataUrl): Promise<{ widthPx, heightPx, crop(box), close() }> }`.
  `widthPx` and `heightPx` are the size of the whole bitmap. `crop({ sx, sy, sw, sh })` copies
  that box (device px, inside the bitmap, no scaling) and returns
  `{ blob: Blob, signature: Uint8Array, cols, width, height }`: the PNG of the box and its
  `rowSignature` (`height * cols` values). `close()` frees the pixels. The store calls it for
  every decoded frame, also when the frame fails. A failure inside `imageOps` becomes
  `E_CAPTURE_FAILED` "Could not read the captured image. Try again." (the original error stays
  in `cause`).
- **`addFrame(sessionId, tabId, dataUrl, meta)`** → `IntakeResult`.
  - Frames of one session run one at a time, in call order. A frame is checked against every
    earlier frame, also when the caller does not wait for replies.
  - The crop is `cropRectPx(meta.rect, meta.viewport, bitmap size)`. The first frame fixes the
    session `widthPx` and `scale`. Every later frame needs a scale within 0.01 and a crop width
    within 2 px of `widthPx`, or it fails with `E_CAPTURE_FAILED` "Page zoom changed. Finish
    now to keep what you have." It is then cropped to `widthPx`.
  - Position: `yPx = contentYToPx(meta.contentY, scale)`. A stored slice with the same height
    and a `yPx` within 1 px makes the frame a duplicate: nothing is stored, `index` is -1 and
    `seam.status` is `duplicate`.
  - Jump limit: a frame whose slice neither overlaps nor touches the rows that the session
    covers (from the top of the highest slice to the bottom of the lowest one) fails with
    `E_CAPTURE_FAILED` "The page moved too far. Finish now to keep what you have." It is checked
    before the crop, after the duplicate check, and it does not apply to the first slice. A slice
    that touches the covered rows (no overlap) is accepted, with `seam.status` `unmatched`. Why:
    a page can jump its own scroll position (a script, a virtual list, a hostile page), and a
    slice far from the others would leave a gap and make the image very tall. The agent keeps the
    session open, so the user can finish.
  - Size limits (all give `E_SESSION_TOO_LARGE`; the stored slices stay):
    - `storedBytes + blob.size > maxBytes`: "This capture is too large. Finish now to keep what
      you have."
    - The stored bytes of all sessions (finished ones included, until they are released or expire)
      plus `blob.size` pass `totalMaxBytes`: "This capture is using too much memory. Finish now to
      keep what you have." The check and the store run without an `await` in between, so two
      sessions cannot pass the limit together.
    - The height of the image with the new slice, at its **final** position (after the seam
      correction), passes `maxHeightPx`: "The capture reached its maximum length. Finish now to
      keep what you have." This is a hard limit that does not depend on the page or on the
      settings; the agent's own limit (`settings.maxHeightCss`) normally stops first.
  - Seam: for `initial` and `down` the new slice is compared with the slice above that overlaps
    it, for `up` with the slice below (the nearest one; the other side if only that side
    overlaps). `matchSeam` gets the `SEAM` constants.
  - `IntakeResult = { index, sliceCount, widthPx, totalHeightPx, tileCount, seam, storedBytes }`.
    `index` is the stable insertion number of the slice (never changes). `totalHeightPx` is the
    height of the assembled image so far. `tileCount` is `planTiles` for the tile tier of the
    session. `seam.shiftPx` is the **change applied to the new slice's `yPx`** (positive =
    down): `+shift` when the new slice is the lower one, `−shift` when it is the upper one
    (direction `up`). `seam.status` is `first` for the first slice, `duplicate` (see above),
    `unmatched` with `meanDiff` 255 when no stored slice overlaps the new one, and else the
    result of `matchSeam`.
- **Warnings** (`manifest.warnings`). Steps are numbered from 1 in manifest order. A seam that
  could not be verified is a slice with `seamStatus` `unmatched` or `ambiguous` ("Spool could not
  verify 1 seam, near step 3. Check that area."). A list shows 8 steps at most, then "and N more".
  There is **no gap warning**: the jump limit makes a gap impossible. Every stored slice overlaps
  or touches the rows that were covered before it. A seam correction moves a slice only to a place
  where it overlaps the slice that it was compared with (`matchSeam` skips a shift with less than
  `minOverlapRows`). So the union of the slices is one stretch. (Before the jump limit, a frame
  that overlapped nothing was stored and the manifest warned "Parts 1 and 2 may have a gap.")
  `planAssembly` still supports gaps: it is a library, and it fills them with white.
- **`takeForAssembly(sessionId, tabId)`** (finalize, section 7.9) needs a finished session of this
  tab and returns `{ manifest, tileTier, blobs: Map<index, Blob> }`; the session stays until
  `release`. **`stateOf(sessionId, tabId)`** is `'open'`, `'finished'` or `null`.
- **`takeForAssembly(sessionId, tabId)` needs a finished session** (there is no other way to read
  a manifest: no message asks for it). An unknown or unfinished session gives
  `E_SESSION_NOT_FOUND`. A finished session with no slice gives `E_CAPTURE_FAILED` "Nothing was
  captured." The manifest lists the slices sorted by `yPx`, with `yPx` normalized so that the first
  slice is 0. `SliceInfo.index` is the insertion number.
- **Other methods.** `open(sessionId, tabId, title, tileTier)`: the same id and tab again keeps
  the session; the same id on another tab fails with `E_SESSION_NOT_FOUND`. `finish` waits for
  the frames in progress; frames after it fail with `E_SESSION_NOT_FOUND`; a second call does
  nothing. `drop(sessionId, tabId)` (cancel) removes an **unfinished** session of that tab.
  `release(sessionId)` (the result page has read the session) removes a **finished** session of
  any tab. `dropTab(tabId)` removes the unfinished sessions of a tab. All three return
  `{ remaining }`. `drop` and `release` do nothing, and give no error, in every other case (unknown
  id, other tab, other state): see the rules in section 3.
  `ping()` returns `{ sessions }`. `onEmpty` is called when a removal leaves no session (a
  failing callback is ignored).
- **Timeouts.** One timer per session, and it ends the session with the same effect as `drop`.
  - Unfinished session: `SESSION_IDLE_MS` (30 min) after the last `open` or `addFrame`. Every
    frame of the session restarts it, also a frame that fails. A frame for another tab or for an
    unknown session does not. `finish`, `drop` and `drop-tab` stop it.
  - Finished session: `SESSION_TTL_MS` (15 min) after `finish`, unless `release` took it earlier.
    `offscreen/finalize` releases the session as soon as the outputs exist, so this timer only
    covers a finalize that failed (Done can be tried again).
  - A frame that is in progress when its session expires fails with `E_SESSION_NOT_FOUND`, and
    its bitmap is closed.

## 5. Page scripts (`src/page`, namespace `globalThis.__spool`)

Each file: `(() => { 'use strict'; ... })();` and registers its module on every injection on
the shared namespace `ns` (next subsection): `ns.lib = Object.freeze({...})`.
There is **no** "already loaded" guard: the isolated world survives an extension reload, so a
guard would keep stale code. The SW does not inject while an agent is active (step 3a).
No module syntax. No globals except `__spool`. Types for the namespace are in
`types/page-globals.d.ts`. `ns.overlayHosts` is a `Set` of the overlay hosts that this world made
and did not remove (see `overlay.js`). `ns.cardHosts` is the same for the toast and the shelf (see
`ui-kit.js`). The files are injected in this order (`PATHS.pageScripts`): `page-lib.js`,
`ui-kit.js`, `overlay.js`, `toast.js`, `shelf.js`, `agent.js`.

### Names that the page can shadow (DOM clobbering)
Page markup can replace names that a script reads: `<img name="title">` replaces `document.title`,
`<form><input name="style">` replaces `form.style`, and an element with `id="__spool"`
replaces `globalThis.__spool`. The page cannot change the prototypes or the built-ins of the
isolated world. So every page script follows these rules:
- Namespace: `__spool` is an **own, non-enumerable** property of the global that holds a plain
  object (`Object.prototype.toString.call(v) === '[object Object]'`; this test also works across
  realms). A file uses the existing one when `Object.hasOwn(globalThis, '__spool')` and the
  value is a plain object. Else it defines a new one with `Object.defineProperty(globalThis,
  '__spool', { value: {}, writable: true, configurable: true, enumerable: false })`. Never
  `globalThis.__spool ??= {}`, and never a read that can reach a named element. The functions
  that the SW injects (`installConfig`, `startAgent` in `src/sw/start.js`) follow the same rule.
- DOM reads: each read of an entry point of `document` and each read of an element property uses
  the accessor that was taken from the prototype when the script loaded, called with
  `.call`/`.apply`. These are: `Document.prototype` (`documentElement`, `body`,
  `scrollingElement`, `title`, `elementsFromPoint`, `createTreeWalker`, `createElement`,
  `createTextNode`, `querySelectorAll`), `ShadowRoot.prototype` (`host`, `elementsFromPoint`),
  `Node.prototype` (`parentElement`, `nodeType`, `getRootNode`), `Element.prototype`
  (`shadowRoot`, `assignedSlot`, `clientLeft`, `clientTop`, `clientWidth`, `clientHeight`,
  `scrollHeight`, `scrollTop`, `scrollTo`, `getBoundingClientRect`, `append`) and the `style`
  getter of `HTMLElement.prototype` and `SVGElement.prototype`. Without a prototype (a unit test
  with a fake DOM) the plain property is used.
- Built-ins of the global (`innerWidth`, `getComputedStyle`, `chrome`) are own properties:
  markup cannot shadow them.

### `page-lib.js` → `__spool.lib`
- `findScrollTarget(rect: Rect)` → `{ kind: 'document' | 'element', el: Element, box: Rect }`.
  Sample points in `rect` with `document.elementsFromPoint`; walk up from the hit (cross
  shadow roots through `host`); the first element with `scrollHeight > clientHeight + 1` and
  computed `overflow-y` in `auto | scroll | overlay` wins. Ignore the overlay host. Fallback:
  `document.scrollingElement` (kind `document`, box = viewport minus scrollbars).
  `box` = the element's visible client box in viewport coords (border and scrollbars excluded,
  intersected with the viewport and with clipping ancestors).
- `listScrollTargets()` → `ScrollTarget[]`: the scroll panels that are on screen, in reading order
  (top to bottom, then left to right; the larger one first when two start at the same place). The
  overlay uses it for the keyboard selection (Tab, Shift+Tab). The panels are the same ones that
  `findScrollTarget` can return for a point (the same sampling of `document.elementsFromPoint`
  over the whole viewport, the same `box`), so a panel that a click can select can be reached
  with the keyboard. The page itself is in the list when it scrolls. A panel that is smaller than
  24 px in either direction is left out, and the list stops at 24 panels. The list is never empty:
  when nothing scrolls, it holds the page itself (kind `document`), as a click on the page does.
- `clipRect(a: Rect, b: Rect)` → `Rect | null` (null if the area is < 1 px high or wide).
- `getScrollTop(t)`, `maxScrollTop(t)`, `setScrollTop(t, top)` (instant; ignores
  `scroll-behavior`), `contentYOf(t, rect)` (= scrollTop + rect.y − box.y for elements,
  scrollY + rect.y for the document).
- `createOverlayScanner(ignore: Element | null, target: ScrollTarget)` →
  `{ collect(rect: Rect): Array<{ el: Element, kind: 'fixed' | 'sticky' }> }`. `collect` returns
  each pinned element (computed `position` `fixed` or `sticky`, given as `kind`) whose border box
  meets `rect` (viewport coordinates, clipped to the viewport). It never returns `ignore` or its
  descendants, `html`, `body`, `target.el` or any ancestor of `target.el` (a fixed app wrapper
  that holds the scroller: hiding it would hide the capture). Two sources are merged:
  1. Hit test, on every call: a grid of points in `rect` (step 32 px, at most 24 × 24) with
     `elementsFromPoint` (open shadow roots included). Each hit and each of its ancestors is a
     candidate. This also finds a fixed wrapper that has no box of its own (its child is hit).
  2. Full scan, once per scanner (at the first `collect`): a `TreeWalker` over the document and
     over every open shadow root, `getComputedStyle(el).position` of each element, at most
     50 000 elements. It finds pinned elements that a hit test cannot see (`pointer-events: none`,
     for example a fade above a chat composer). Later calls only check these candidates again
     (still pinned? box meets `rect`?). A pinned element that is created after the scan and takes
     no pointer events is not found. A scan that throws is ignored (the hit test result stays).
- `createStyleJar()` → `{ set(el, prop, value), restoreAll(), get size() }`. `set` applies an
  inline `!important` value and records the old value and priority once per (el, prop).
  `restoreAll` restores in reverse order and never throws.
- `nextFrames(n = 2)` → `Promise<void>` (n × requestAnimationFrame). `sleep(ms)`.

### `overlay.js` → `__spool.overlay`
- `createOverlay({ onRegion(rect: Rect), onCommand(cmd), copyOnDone?: boolean })` → handle.
  `copyOnDone` is the setting of the same name (default `true`): the agent passes it, and the finish
  button says "Copy & save", or "Save" when it is `false`.
  `cmd` is `'down' | 'up' | 'auto' | 'done' | 'cancel'`.
- Host element: one `div` with a **closed** shadow root, `position: fixed; inset: 0;
  z-index: 2147483647`. Styles only through a constructable `CSSStyleSheet` in
  `adoptedStyleSheets` (page CSP can block `<style>`). No `innerHTML`.
- The page sees as little of the host as possible. The host has **no attribute that shows its
  state or its identity**: no `data-*` marker and no "hidden" flag (the page could watch it and
  learn the moment of a capture). The only attribute is `popover="manual"` (see below). All state
  lives inside the closed shadow root. An orphan host of an earlier injection is found in
  `ns.overlayHosts` (and by the old marker attribute `data-spool-host`, which only older
  versions set) and removed when the next overlay starts.
- Top layer: a large `z-index` does not put the host above a modal `<dialog>`, a popover or a
  fullscreen element. The host is a manual popover: `host.popover = 'manual'`, then
  `host.showPopover()`. A modal dialog makes everything outside it inert, so while one is open
  (`dialog:modal`, the last one) the host is a child of that dialog (a top-layer element is
  placed against the viewport, so its box does not change). Else it is a child of `<html>`. Without
  popover support, or when `showPopover()` throws (the `popover` attribute is then removed), the
  host stays an ordinary fixed element.
- Handle API:
  - `host: Element` (the `ignore` argument of `createOverlayScanner`). It can be under
    `<html>` or under an open modal dialog, so do not look for it by its place.
  - `beginSelect()`: page dim and a crosshair cursor over the viewport; drag a box (min 24×24)
    with a live size label ("200 × 240"); release → `onRegion(rect)`. A click without a drag
    (movement < 4 px) selects the whole visible scroll area under the pointer:
    `onRegion(lib.findScrollTarget(pointRect).box)`. Esc → `onCommand('cancel')`.
    Hover: the scroll panel under the pointer gets an amber outline and the label "Click to spool
    this panel". The hit test is `lib.findScrollTarget` of a 1 × 1 rect at the pointer, at most once
    per animation frame (a `pointermove` or a `scroll` only schedules it). No hover test during a
    drag, after a pick or in a session. The hint pill, centred at the top: "Click a panel or drag
    an area · Esc to cancel". A message (an error of the agent, "That box is too small. Drag a
    larger box.") shows in a pill under it. The label of a panel never lies under the hint pill: when
    the place above the panel would touch the pill (a panel that starts beside a sidebar, or just
    below the pill), the label moves inside the panel, to its top edge (below the pill when the pill
    is there too).
    - Keyboard selection. The overlay is a dialog (`role="dialog"`, `aria-modal="true"`,
      `aria-label` "Spool: choose what to capture") and **takes the keyboard focus** when the selection
      starts (`tabindex="-1"` on the layer, a script focuses it). `Tab` and `Shift+Tab` move the
      highlight over `lib.listScrollTargets()`: the first `Tab` goes to the first panel, the first
      `Shift+Tab` to the last one, and the list is a ring. The highlight looks like a hover (outline
      and label); the label says "Press Enter to spool this panel". The list is read again at each key.
      When the pointer put the highlight on a panel, the next `Tab` goes on from that panel. A
      pointer move takes the highlight back, and a hover test that is on its way is dropped when a
      key moves the highlight. `Enter` selects the highlighted panel (`onRegion(box)`, with the box
      as it is at that moment). With no highlight, `Enter` selects the main panel: the one that
      `lib.findScrollTarget` finds at the middle of the window. A held `Enter` selects once. After
      the pick the keys do nothing until the session starts (or the agent rejects the area and
      `beginSelect()` runs again). `Escape` cancels, as before. Only these three keys are claimed
      in this mode, and only without Ctrl, Alt or Meta (`Ctrl+Tab` stays with the browser).
    - Announcement. A live region (`role="status"`, `aria-live="polite"`, hidden from the eye, and
      the `aria-describedby` of the dialog) holds the hint: "Choose what to capture. Press Tab or
      Shift and Tab to move between the scroll panels, Enter to select the highlighted panel, or
      Escape to cancel. You can also click a panel or drag an area." Each highlight by the keyboard
      replaces it with the panel: "Scroll panel 2 of 3, 520 by 704 pixels. Press Enter to select it,
      or Tab for the next one." ("Whole page" for the page itself, no "2 of 3" and no "next" for a
      list of one). `showSession()` empties it. The hint pill and the live region both stay in the
      accessibility tree.
  - `showSession(rect)`: amber outline around `rect` and the dim outside it (a hole in the dim,
    no second layer), the **HUD** and the **thread**. The layer blocks page pointer events
    during the session.
    - HUD (`role="toolbar"`, always dark graphite): `Scroll ↓ [Space]`, `↑`, `Auto [A]`, the
      readout, `Copy & save [Enter]` (the only filled amber button; `Save [Enter]` when the setting
      `copyOnDone` is off) and `Cancel [Esc]` (icon button).
      Every button has an `aria-label` of the form "Name (key)": "Scroll down (Space)", "Scroll up
      (Shift+Space)", "Auto scroll (A)" (while Auto runs: "Stop auto (A)"), "Copy and save (Enter)" ("Save (Enter)" when the setting
      `copyOnDone` is off; the tooltip has the same text) and "Cancel (Esc)". Centred under the selection with a 12 px gap; above it, else
      inside at the bottom, when there is no room. A message of the agent shows in a pill on the
      side of the HUD that has room. A narrow window (up to 820 px) puts the readout on its own row.
    - Done pressed: the button says "Finishing…" with a turning spool (no check, no keycap), its
      `aria-label` is "Finishing" and it has `aria-disabled="true"`. It does so while the agent is
      busy after the press, until the toast takes over (the overlay is removed). The Cancel button is
      disabled while the agent reports `finishing`. A message of the error level (the finish failed,
      or there was nothing to finish) or a new `beginSelect()` / `showSession()` puts the label back.
      The agent's own message pill is separate (see `agent.js`).
    - Input while hidden. The layer keeps its place in the viewport for the whole capture (see
      `hideForCapture`): a click, a press or a wheel turn is never a click on the page.
      `pointerdown`, `click` and `wheel` on the layer do what they do while the overlay shows:
      a press on the panel (not on the HUD) stops Auto, the wheel stops Auto and is kept from the
      page, and a click on the place of a HUD button presses that button (the HUD keeps its layout
      while it is hidden, so the overlay compares the point with the box of each button; a disabled
      button does nothing). So Stop, Scroll, Up, Done and Cancel all work during a capture; Done and
      Cancel reach the agent at once, which honours them after the step (section 5, `agent.js`). A
      press that began while the overlay was hidden counts where it began, also when the click ends
      after the overlay shows again.
    - Readout (`role="status"`, polite): "4 steps · 6,240 px · 3 AI screenshots" (singular: "1 step",
      "1 AI screenshot"). At the end of the panel: "End of panel · 3 AI screenshots".
    - Auto running: the Auto button is pressed, its label is "Stop [A]" and its icon is a turning
      spool (1.2 s per turn; still under `prefers-reduced-motion`). While Auto runs, any other
      input stops it with the same `'auto'` command: `Space`, `ArrowDown`, `ArrowUp`, the wheel, a
      click on the panel, the Scroll and Up buttons. One request is sent per run (a flag clears when
      the status says `auto: false`).
    - Thread: a 3 px line 6 px right of the selection (inside it when the window edge is too
      near). The amber fill, three ticks and a dot follow `progress`; the dot grows from 11 to
      15 px at the end.
    - End of panel (`atEnd`): the Scroll button looks off and says "Nothing more below" on hover
      or focus (it still works: the page can have grown). Only then does the button have
      `aria-describedby` for that tip (the tip itself is `aria-hidden`: a screen reader reads it as
      the description at the end, and never before). The thread is full and **Done gets the
      focus** with a visible ring, so Enter finishes. The overlay holds the focus on Done (also
      after a capture, when a hidden button loses it) until the user presses Tab. While it holds
      it, `Enter` and `Space` keep their overlay meaning (Done, Scroll) instead of pressing the
      focused button. The focus goes away when `atEnd` turns false again (it goes back to the
      layer). The same holds while the layer itself has the focus (the normal case: a mouse press
      does not move the focus).
  - `setStatus({ slices, heightPx, tiles, auto, level, message, progress, atEnd, finishing })` (`level`:
    info | warn | error). `progress` is 0..1 (scroll position of the target / its maximum), `atEnd`
    is a boolean. Both are supplied by the agent. `finishing` (optional, default false) is true while
    the save of Done is under way: the Cancel button is disabled (`disabled`), and Cancel and Esc do
    nothing (Esc is still kept from the page). `beginSelect()` and `showSession()` reset it.
  - `setBusy(busy)`: disables step buttons (Done and Cancel stay active, except while `finishing`).
  - `hideForCapture()` → `Promise<void>`: adds the class `hidden` (`visibility: hidden`) to the
    root element **inside** the closed shadow root, then `nextFrames(2)`. Nothing on the host
    changes. Everything that the user sees is hidden: the capture holds no pixel of the overlay.
    One element is excepted: the **input layer** (`.shield`, the last child of the root, `aria-hidden`).
    It has no fill, no border, no shadow and no outline (`background: transparent`), so it paints
    nothing. While the class is set it is `visibility: visible`, so it takes the pointer and the
    wheel over the whole viewport; without the class it is `visibility: hidden`. The host stays the
    element that `elementFromPoint` finds at every point and at every moment. It remembers which part of the
    overlay had the focus, because a hidden element loses it.
  - `showAfterCapture()`: removes the class. The focus goes back to Done at the end of the panel,
    else to the part of the overlay that had it.
  - `keepOnTop()`: makes sure the overlay is above what the page opened later. If an open modal
    dialog exists and the host is not its child (or none exists and the host is not under
    `<html>`), it moves the host there and shows the popover again. Else, if the host is not the
    topmost element at the middle of the viewport (`elementsFromPoint`), it hides and shows the
    popover again. It does nothing before `beginSelect()`, while the overlay is hidden for a
    capture, and after `destroy()`. The agent calls it from its watchdog.
  - `destroy()`: removes the host and all listeners. Idempotent. The focus goes back to the element
    of the page that had it before the overlay opened (open shadow roots included), when it is still
    in the page and the user did not move the focus since. A capture that starts in a chat editor
    so ends with the focus in that editor (the user pastes the result there).
- Look: brand "Spool", quiet and native. HUD graphite `#1C1D20`, text `#EDEEF0`, muted `#A1A4AA`,
  line `#2A2C30`, accent `#FFB224` (text on it `#1B1C1E`). An amber outline on the page carries a
  1 px dark halo. system font stack (`system-ui, -apple-system`, then Segoe UI Variable for Windows, Roboto; no web fonts; the same order in `ui-kit.js` and `overlay.js`), radii 8 and 12, keycaps are small
  outlined chips, icons are inline SVG with a 1.5 px stroke (made with `createElementNS`; the
  namespace name is written in two parts so that the policy scan for URLs does not flag it).
  Motion: 83, 167 and 250 ms; enter `cubic-bezier(0, 0, 0, 1)`, exit `cubic-bezier(1, 0, 1, 1)`.
  `prefers-reduced-motion: reduce` leaves only opacity changes. `forced-colors: active` uses system
  colours and an outline instead of the dim.
- Keyboard (window, capture phase, only while the overlay exists): `Space` / `ArrowDown` →
  down, `ArrowUp` / `Shift+Space` → up, `a` → auto (toggle; also the key in the place of A on a layout with no Latin letters: `e.code === 'KeyA'` with a letter of another script, so a Latin layout that has another letter there, like AZERTY, keeps it), `Enter` → done, `Escape` → cancel.
  While selecting, `Escape` is the only command. `Tab`, `Shift+Tab` and `Enter` choose a panel then
  (see `beginSelect()`). Call `preventDefault()` and `stopImmediatePropagation()` only for these keys.
  A key with Ctrl, Alt or Meta is not claimed. Keys and pointer events work the same while the host is
  inside a modal dialog.
- Trusted input only: every listener of the overlay (keyboard, pointer, wheel, button clicks,
  resize) ignores an event whose `isTrusted` is not `true`. A page script can dispatch fake events
  into the window; those do not select, scroll, step, finish or cancel. A fake event is not
  stopped, so the page still receives it.

### `ui-kit.js` → `__spool.ui`
Shared pieces of the toast and the shelf (the overlay keeps its own, older copy).
- `createCardHost(css, { onOrphan, onDismiss })` → `{ host, shadow, root, listen, keepOnTop, destroy,
  isDestroyed }`. The host has a **closed** shadow root, styles only through a constructable
  `CSSStyleSheet` (`BASE_CSS` + `css`), no attribute but `popover="manual"`, and the same top layer
  rules as the overlay (a child of `<html>`, or of the open modal dialog). A watchdog (1000 ms)
  calls `keepOnTop()`, and when the extension context is invalid it destroys the card and calls
  `onOrphan`. A new card closes the earlier cards. The registry `ns.cardClosers` holds one closer for each card
  on screen (`onDismiss`, then `destroy()`), also for a card of an earlier injection: each
  injection loads new instances of the scripts, and only the registry in the namespace survives.
  `dismissCards()` calls every closer, so an old toast does not stay on the page and does not take the
  Esc key of a new capture. `listen(target,
  type, handler, options)` acts only on trusted events, never throws, and is removed by `destroy()`.
- `send(config, key, fields)` → `Promise<{ ok: true, data } | { ok: false, code, message }>`: one
  message to the service worker; `key` is a name in `config.msg` (for example `PAGE_GET_TILE`).
  Never throws.
- `copyImage(promiseOfBlob)` → `Promise<boolean>`: `navigator.clipboard.write([new ClipboardItem({
  'image/png': promise })])`. The call is made at once, so the caller must be in the task of the
  user's gesture with no `await` before. False when the browser refuses, the API is missing or the
  image fails. `pngBlob(base64)`, `drawPng(canvas, base64)` (uses `createImageBitmap`, never an
  `<img>` or a blob URL, so the CSP of the page cannot block it), `focusedElement()` (looks into open
  shadow roots; `null` for `<body>`), `isFrameOwner(element)` (`iframe`, `frame`, `object`, `embed`),
  `shortcutOf(config, 'start' | 'insert')` (the key of `config.shortcuts`, `''` when the command has none,
  the manifest key when the config has no keys), `withKeys(config, text)` (puts the real keys into
  "Press Alt+Shift+V again." and "Press Alt+Shift+S to spool a page."), `dismissCards()`, `icon(name)`, `glyph()`, `num`, `sizeText`, `tileFileName`.
- `keysOf(config, 'start' | 'insert' | 'paste')` → `{ parts, text }`: a key as it shows on screen. The worker writes the keys for
  the system of the user into `config.keys` (`src/lib/keys.js`: "Alt+Shift+V" on Windows and Linux, "⌃⇧V" on a Mac;
  the Paste key is "Ctrl+V" or "⌘V"). A config without `keys` gets `config.shortcuts` split at "+" and the Paste key of
  `navigator.platform`. No parts: the command has no key. `withKeys` puts these texts into the messages.
- `findPasteTarget({ remembered, ignore })` → `{ element, kind }`: where a paste goes. In this order: the element that has the
  focus when it `takesPaste` (a textarea, an input, an editable element; connected to the page; not `ignore`), then `remembered`
  when it is still in the page and takes a paste, then the composer that `findComposer()` finds, then any focused element
  (`kind` `'other'`), then the body (`'none'`). `findComposer()` looks at the editable elements that are on the screen, in the page
  and in open shadow roots (at most 60,000 elements and 200 roots), and `pickComposer` takes the one that sits lowest, among
  editors whose bottom edges are within 48 px the largest. Nothing takes the focus.
- `planBatches(count, limit)` cuts into batches of at most `limit`; `mapLimit(count, limit, work)` runs `work(i)` with at most
  `limit` at once and stops at the first failure; `exceedsClipboard(widthPx, heightPx, maxBytes)` is `width × height × 4`
  against the limit (a copy of `exceedsClipboardLimit` in `src/lib/clipboard-limit.js`: `test/unit/clipboard-limit.test.js`).
  `createCardHost` also gives `raise()`: hide the popover and show it again, which puts the card last in the top layer, above a
  page element that a hit test does not see (`pointer-events: none`).
- Names that markup can shadow are read through the prototypes (see "Names that the page can
  shadow"), like in the other files.

### `toast.js` → `__spool.toast`
- `show({ config, summary, copy })` → `{ setCopy(state, detail?), close() } | null`. `summary` is the
  `FinishSummary` (section 7.4), `copy` is `'pending' | 'copied' | 'failed' | 'skipped'`
  (`'skipped'`: the setting `copyOnDone` is off, nothing is copied, the state is final at once). A fifth state, `'toolarge'`: the
  image is too tall to copy as one image: "Too tall to copy. Saved instead." (not saved: "Too tall to copy.", with the note
  "Open the capture to save it."; some files not saved: "Too tall to copy. 2 of 6 files didn't save."). The block says "Press [keys]
  in your chat to insert the N screenshots." (no "Long capture?", no paste hint), and the line for a desktop app stays. It closes the toast
  that is on screen. `null` for a summary without a session ID. `dismiss()` closes the current toast.
- Short capture (`fitsOneImage`): thumbnail on a `<canvas>` (the top of the image), the title,
  "1,500 × 2,210 px · Saved to <place>" (the place: see below), **Open** (`page/open-result`) and
  "Paste [Ctrl] [V]" (`config.keys.paste`: "⌘ V" on a Mac).
  Long capture: stacked thumbnail, "Copied. Press Ctrl+V for the full image." ("⌘V" on a Mac: the title teaches
  the key that pastes the full image), "N AI screenshots ready · Saved to <label>", a tinted block (the main route) with "Long capture? In
  your chat tab, press [Alt]+[Shift]+[V] to insert all N screenshots." (the key is `config.keys.insert`, one keycap for each key,
  with a "+" between them except for the glyphs of a Mac; with no key: "Set a shortcut for "Insert last capture" in your browser.
  Then press it in your chat tab to insert all N screenshots.", no keycaps), the line "Desktop app: drag them from Pictures ›
  Screenshots › Spool for AI." (the place of the save, then the folder of the AI screenshots: `TILES_FOLDER` in the toast is a copy of
  `TILES_FOLDER_NAME` in `src/lib/names.js`, and `test/unit/toast-teaching.test.js` checks it; only for a save that wrote files, with
  the setting `saveTiles` on), then "Or copy one at a time" with the links **Open** and, for a save in Downloads, **Show in folder** on
  the same row, and one chip for each AI screenshot, labelled "1",
  "2" … (`aria-label` "Copy screenshot N"; a trusted click calls `clipboard.write` with a promise of
  `page/get-tile`; the chip says "N · Copied" for 2 s, with `aria-label` "Screenshot N copied"). The toast has no "more actions" menu: no
  action is behind it. There is **no** "drag all tiles" chip: Chromium cannot drag several files to
  another tab.
- **Show in folder** (a button on a short toast, a link on a long one) shows for a save in Downloads with files saved (also with
  `needsPermission`: the files are in Downloads). A trusted click sends `page/show-in-folder { sessionId }`. The toast stays; when the
  worker refuses, its message shows in the note. It does not show for a folder that the user picked: the browser has no call to reveal it.
- **Open** (tooltip "See it, copy or save it again"), **Set up**, **Reconnect** and **Change** wait for the
  reply of the worker (`page/open-result` or `page/open-options`). The toast closes when the reply is
  `ok`. When it is not (the capture is gone, the tab did not open, the worker did not answer), the toast
  stays, shows the message in the note, and the countdown waits while the request runs. A second press
  while a request runs does nothing.
- A save in Downloads (`save.location` `downloads`, files saved, no `needsPermission`) adds a link
  **Change** to the caption ("... · Saved to Downloads › Spool · Change", `aria-label` "Change the save
  location"). It opens `page/open-options` with section `setup`. It is the standing way to a folder.
- Questions (a block with a heading and two buttons; each stays 15 s):
  - `save.askFolder` (no folder is chosen, one of the first three captures, 7.10): "Save to Pictures ›
    Screenshots?" with **Set up** (`page/open-options`, section `setup`) and **Not now** (closes the
    toast, stores nothing).
  - `save.needsPermission` (a folder is chosen, but the browser has not granted access now, or the folder is
    gone; the files went to Downloads): "Reconnect <folder>?" ("<folder>" is `save.folderLabel` in the
    format of the place; "your folder" when the reply has none) with **Reconnect** (`page/open-options`,
    section `reconnect`) and **Not now**. The caption says "Saved to Downloads › Spool this time", and has
    no **Change** link. This block wins over `askFolder`.
- Some files did not save (`save.error` with `save.files` > 0; `save.failed` is how many): the title is
  "Copied, but 2 of 6 files didn't save." (`pending` "Copying…" first; `skipped`: "2 of 6 files didn't
  save."; `failed`: "Not copied. 2 of 6 files didn't save."; without `failed`: "some files"), with a warning
  level, **Open** as the main button, and the note "The full image is on your clipboard. Open the capture
  to save the rest." The note shows first, and the first line of `summary.warnings` follows it.
- Titles: `pending` "Copying…"; `skipped` "Saved" (not saved: "Not saved"); `copied` "Copied and saved"
  (not saved: "Copied", the caption says why); long "Full image copied"; `failed` "Saved, not copied" or "Not copied", with `detail` (for
  example "This image is too large to copy. Use the AI screenshots.") or "Use Open to copy or save it."
  as a second line. The first line of `summary.warnings` shows under the caption.
- The place of the save (`<label>`) shows in one format in the toast, the result page and Options:
  "Downloads › Spool" for a save in Downloads, the names of the folder and of the folders below it for a
  chosen folder ("Pictures › Screenshots"; "Screenshots" when the user picked a folder of that name).
  `SaveInfo.label` on the wire is `Downloads/<folderName>` or the names joined with "/";
  `formatSaveLabel()` in `src/lib/labels.js` makes the text (the result page, Options). The toast has
  its own copy, `placeLabel`, because a page script cannot import a module;
  `test/unit/labels.test.js` checks that both give the same text.
- `summary.teach === true` (one of the first three captures of more than one tile, 7.10): the toast has no countdown and no bar. It
  stays until the user closes it (Esc, the close button, **Open**) or a new capture closes it. Hover and focus change nothing.
- Countdown: 6 s, which starts when the copy is not `pending` any more. Hover, focus inside the toast
  and a tile that is being copied hold it. **Esc closes the toast and the page does not get that key**
  (a modal dialog of the page stays open). The close button has `aria-label` "Close (Esc)".
- The toast never takes the focus, never uses `innerHTML` (all text of the capture goes through
  `textContent`), has `role="status"` and `aria-live="polite"`. Motion: in 250 ms (y +8 px), out
  167 ms; `prefers-reduced-motion`: opacity only and no countdown bar.

### `shelf.js` → `__spool.shelf`
- `start()` opens the shelf; `dismiss()` closes it. Needs `config.mode === 'shelf'` and a
  `config.shelfToken` (1 to 64 characters), else it does nothing. `agent.start()` calls it in that
  mode (the service worker always calls `agent.start()`).
- It finds the place of the paste first (`ui.findPasteTarget`, see `ui-kit.js`), asks `page/shelf-info`, and shows the capture
  that its token is bound to: the thumbnail, the title "Insert into this chat?", the line "5 AI screenshots from github.com, 4 min
  ago." (the host name is `ShelfSummary.sourceHost`: where the pixels come from; "from a local page" when it is empty; the age
  is "just now", "N min ago", "N h ago") and "Into chat.example.com" (the host of the page that the shelf is in: where they would go; it
  reads `location.hostname`, which markup cannot replace). The reply is the `ShelfSummary`: size, age, host, the place of the saved
  files (for the hint about a desktop app), thumbnail; no title, no session ID, no warnings. Then **Insert N screenshots** ("Insert 1
  screenshot"), one chip for each tile, and **Copy full image**. `{ summary: null }` → "Nothing to insert yet. Press Alt+Shift+S to
  spool a page.", "Captures stay ready for 60 minutes." and "Desktop app? This shortcut works in browser tabs only. Capture a
  page, then press Ctrl+V in the app, or drag the screenshots from the Spool for AI folder."; an error reply shows its message alone. The shelf asks for image
  bytes only after a click: **Insert** reads every tile, a chip reads its tile, **Copy full image**
  reads the full image. A refusal on the click (for example "A newer capture exists. Press
  Alt+Shift+V again.") shows in the status line in place of the usual texts. The texts show the real keys
  (`ui.withKeys`).
- When the recorded element is a frame owner (`ui.isFrameOwner`: `iframe`, `frame`, `object`,
  `embed`, also inside an open shadow root), the page scripts cannot reach into that frame, and an event
  that they dispatch at it goes to the scripts of the top page. The shelf then does not dispatch. It
  shows "Spool cannot insert into an embedded frame. Click a number to copy one instead." ("... Click Copy
  full image." for one tile), turns **Insert** off and reads no tile. Chips and **Copy full image** work as usual.
- **The place of the paste** is found at the open and again at the click (the editor can be made again, or the focus can move):
  the focused editor, else the one that the shelf remembered, else a composer that it finds on the screen, else any focused
  element, else the body. With no editor to paste into, the status line says "Click your message box first. Spool inserts where
  your cursor is. Press Alt+Shift+V again after you click." and **Insert** still works (a page can take a paste anywhere). The
  shelf never takes the focus.
- Insert fetches the tiles of one batch with `page/shelf-get { token, item }`, **at most three at a time** (`mapLimit`), makes
  `File`s `screenshot-01-of-05.png` (`image/png`, the number is the place among all tiles) in a `DataTransfer`, and dispatches
  `new ClipboardEvent('paste', { clipboardData, bubbles: true, cancelable: true, composed: true })` at the place of the paste, with
  the `dispatchEvent` of the prototype. A tile that fails stops the fetch, and nothing is pasted. `defaultPrevented` → "Inserted 5
  screenshots." and the shelf closes after 2 s. The event is not trusted: a page can refuse it. Then the **steps**.
- **More than `limits.maxImagesPerMessage` (20) tiles** go in batches of that size. The card says "Insert the first 20?" and "Most
  AI chats take up to 20 images in one message. This capture has 26.", with the buttons **Insert first 20** and **Insert the other 6
  next** ("Insert the next 20" when more than one batch is left). After a batch the shelf stays open and says "Inserted 1–20 of 26.
  Send your message, then insert the rest."; the other button becomes the main one (a batch that was skipped stays on the main button, so nothing is lost behind a later batch). The last batch says "Inserted 21–26 of 26." and
  closes after 2 s. The shelf says what it did: it handed these files to the page, and the page took the event. It cannot see what
  the chat keeps.
- **The steps** (a page refused the paste): "This chat won't take them all at once." ("This chat didn't take the paste." for one
  image), "Copy one, press Ctrl+V, then come back." ("⌘V" on a Mac), the button **Copy screenshot 1 of 5**, a progress bar (`role`
  `progressbar`), and "Desktop app? Press Ctrl+V for the full image, or drag the screenshots from Pictures › Screenshots › Spool for
  AI." (without the place when nothing was saved). Each click starts `clipboard.write` with a promise of `page/shelf-get`; the status
  says "Copied screenshot 1 of 5. Press Ctrl+V in your chat." and the button moves to the next one; after the last it says "All copied".
  The steps start at the first screenshot of the batch that was refused. Each paste is the user's own, so it works on every site.
- **Clickjacking guard.** A page can open its own element over the card, also one with `pointer-events: none`, and draw a fake
  button there. **Insert** is off (`disabled`) while the card is new and for 400 ms after it became visible, and while
  `IntersectionObserver` v2 (`trackVisibility: true`, `delay: 100`) says that the card is not visible. The observer watches the
  card, not a button: a disabled button is drawn at 45% opacity, which counts as not visible. In Chromium 151 an element over the card
  with `pointer-events: none` makes `isVisible` false at once (`e2e/shelf-composer.spec.js`). A click that arrives while the guard is
  off does nothing and the card says "Something on this page covers Spool. Click again in a moment." The card puts itself back above
  what covers it (`raise()`, at most once a second). A browser without v2 has the wait of 400 ms alone. Cross-origin insert needs no
  second confirmation: every use of the shelf is cross-origin, so a second prompt would show every time and turn into a reflex;
  automation that clicks once clicks twice. The card instead names both ends (the source host and the host of the page).
- **Copy full image** is left out for a capture that is too tall to copy as one image (`width × height × 4` over
  `limits.maxClipboardBitmapBytes`, 256 MiB): "Too tall to copy as one image. Use the screenshots." The browser would decode it in
  this tab, and a tab crashes far above the limit. Chips (a tile is small) still work. Chips and **Copy full image** start
  `clipboard.write` in a trusted click with a promise of `page/shelf-get`; "Could not copy on this page." when the browser refuses.
- A press on the shelf does not move the focus (the editor keeps it). Esc closes the shelf and the
  page does not get that key. Same host rules as the toast.

### `agent.js` → `__spool.agent`
- `start()`, `isActive()`. In `config.mode === 'shelf'`, `start()` calls `__spool.shelf.start()` and
  nothing else (no overlay, no session). A capture start closes the toast and the shelf of an
  earlier capture: it calls `toast.dismiss()`, `shelf.dismiss()` and `ui.dismissCards()` (the registry
  also closes the cards of an earlier injection). `isActive()` returns false, and closes the session, when the
  extension context is invalidated (`chrome.runtime?.id` is undefined). A `sendMessage`
  failure because the context is invalidated also closes the session (restore the page).
- Status line: `slices`, `heightPx` (= `totalHeightPx`) and `tiles` (= `tileCount`) come from
  the last `IntakeResult`. `progress` = `getScrollTop(target) / maxScrollTop(target)` (0..1; 1 when
  the range is not more than 1 px; 0 before the area is picked or when the range cannot be read).
  `atEnd` is true when the target is at most 1 px from the bottom of its range, and after a
  downward step that did not move (the end of the content, also when the range says more). The
  next step that moves clears it. Both are computed from the live scroll position on every status.
- State machine: `idle → selecting → ready ⇄ stepping / auto → finishing → closed`.
  `cancel` from any other state than `finishing` → `closed`. Once `finishing` starts, Cancel can no
  longer cancel: the overlay disables the Cancel button and ignores Esc (the status carries
  `finishing: true`), and the agent ignores a `cancel` command in that state. The save completes, the
  overlay closes, and the toast reports the result. One step at a time (busy flag). While Done saves, the
  status line says "Saving and copying…" ("Saving…" when `copyOnDone` is off), and "Still saving. A long
  capture takes a few seconds." after 2 s (the watchdog tick).
  The wait for `page/finish` is bounded (`FINISH_TIMEOUT_MS`, 180 s, checked by the watchdog). When it
  ends, the clipboard write fails, the state goes back to `ready`, the status is an error "Saving is
  taking too long. Try Done again, or Cancel.", and Cancel works again. A second Done joins the finalize
  that is still running (one finalize for each session), and a Cancel closes the overlay and sends
  `page/cancel`, which the offscreen document ignores for a finished session. A `pagehide` while
  finishing closes the overlay and sends no `page/cancel`, as before.
- Resync: before a step (and before the capture of a frame that failed), when `getScrollTop` is not
  the position of the last frame that was taken or tried (a stray scroll of the user), the agent scrolls
  back to that position, waits like for a step (`nextFrames(2)`, `sleep(settleMs)`), and goes on from
  there. A difference below 0.5 px is no scroll.
- Step: `before = getScrollTop`; scroll by `±(rect.height − overlapCss)` (min 8 px);
  `nextFrames(2)`; `sleep(settleMs)`; if `|after − before| < 0.5` → end in that direction
  (auto stops). Downward: `atEnd` is set and the message stays empty (the HUD says "End of
  panel"); upward: the message "Reached the top.". Stop when covered height ≥ `maxHeightCss`.
- A frame that failed is captured again first. If the last frame was not stored (its capture
  failed with any error or exception; at the start this is the initial frame), the next step
  does not scroll. It captures that frame again at the current scroll position, with the direction
  it had. It scrolls only after that capture is stored. If the capture fails
  again, the step ends there and the page stays where it is. This holds for a manual step and for
  Auto (for example after `E_TAB_NOT_VISIBLE`), so a failed capture never leaves a gap in the
  image. A duplicate that the service worker accepted counts as stored.
- Capture: if `hideOverlays`, before every frame (the first one too) call `scanner.collect(rect)`.
  The agent makes one scanner per session at the first capture:
  `createOverlayScanner(host, target)`. Each `sticky` element gets `position: static` and each
  `fixed` element gets `visibility: hidden`, both through the style jar. At the start of the session (before the first frame) the
  scroll target and `<html>` also get `scrollbar-width: none` through the jar, so that an overlay scrollbar (macOS, Windows 11 with
  auto-hide) is not in the crop; the jar puts it back. A sticky element keeps
  its space in the flow, so nothing moves. It stops following the scroll and shows once, at its
  place in the content (a header at the top, a date divider between its messages). Hiding it
  would leave a gap. A fixed element is not content and would repeat in every frame, so it is
  hidden. Then `overlay.hideForCapture()`; send `page/capture-frame`; `overlay.showAfterCapture()`.
- `E_TAB_NOT_VISIBLE` → pause auto, warn "Go back to this tab to continue." Other errors →
  show the message; Done and Cancel stay available. After either, the next step captures the
  failed frame again (see above).
- Done while auto runs: stop after the current step, then finish. The clipboard write starts at
  once, in the gesture (see below), and `page/finish` waits behind a gate until the step is over.
  Cancel after that drops the Done: nothing is finished and the write fails. Done with no frame
  stored (`seq` 0 in the agent) does not close the session: the message "Nothing was captured yet.
  Scroll once, or Cancel." shows at the error level and the state goes back to `ready`.
- Done (section 7.1): `finishSession` runs in the task of the trusted key press or click and starts
  the write **before its first `await`**: `beginFinish` sends `page/finish` and calls
  `ui.copyImage(promise)` where the promise waits for the `page/finish` reply, sends
  `page/get-clipboard` and decodes `pngBase64` to a PNG `Blob`. With `settings.copyOnDone === false` there
  is no write, no `page/get-clipboard` and no `page/clipboard-fallback`: the toast shows with copy state
  `'skipped'` ("Saved"). A second Done while it runs does nothing. When `page/finish` fails the session stays open (the message shows, Done and Cancel stay)
  and the next Done starts a new write. When it works: restore the page, remove the overlay, then
  `toast.show({ config, summary, copy: 'pending' })` in the same task, then wait for the write. A
  write that the browser refused (or no clipboard API, or no `ui`) sends `page/clipboard-fallback`
  and the answer `{ copied }` is the final state: `toast.setCopy('copied' | 'failed', reason)`, where
  `reason` is the message of a failed `page/get-clipboard` (for example the 40 MiB limit). A capture that is too large to copy as one
  image (width of the area in device px × height so far × 4 bytes over `limits.maxClipboardBitmapBytes`, 256 MiB) gets **no write at
  all**: `copy` is false, the toast shows with copy state `'toolarge'`, and the files still save. When Done came in during a step, the
  estimate can be one frame short, so the write starts, and when the summary shows the real size the write is given up before
  `page/get-clipboard` (also no `page/clipboard-fallback`: the worker would decode it as well) and the toast gets `setCopy('toolarge')`.
  The browser decodes the whole image in the page that writes it: in Chromium 151 a 1,500 px wide image wrote up to 60,000 px high and
  crashed the tab from 70,000. A reply of
  `page/finish` without a summary still closes the session. Nothing in this path throws into the
  page.
- `pagehide`: the listener acts only on a trusted event (`event.isTrusted === true`). A fake
  `pagehide` that a page script dispatches is ignored (the page must not be able to cancel the
  capture). The agent has no other listener.
- Watchdog: while a session is open (from `start()` until close), an interval of 1000 ms checks
  `chrome.runtime?.id`. When the extension context is invalid (reload, update, removal: the
  page script gets no event then) it closes the session and restores the page, like any other
  close, without a message to the SW. Otherwise it calls `overlay.keepOnTop()` (errors are
  ignored). The timer is cleared on every close. A tick after the close does nothing.
- The agent reads `document.title` and `document.documentElement` through the prototype
  accessors, and the namespace through the own-property rule (see "Names that the page can
  shadow").
- Close (done, cancel, error, `pagehide`, invalid context): clear the watchdog timer,
  `jar.restoreAll()`, restore the original scroll position, `overlay.destroy()`, set state
  `closed`. The restore runs in `finally`.

## 6. Extension pages: result, options, shared look

Owner: `src/result/*`, `src/options/*`, `src/ui/*`. Both pages link `../ui/tokens.css`, then
`../ui/base.css`, then their own stylesheet (no `@import`: the CSP allows own files only).

### 6.1 Shared look (`src/ui/`)
- `tokens.css`: the colors of the Spool look as custom properties for light and,
  with `prefers-color-scheme: dark`, dark (background, surface, text, muted, line, outline, amber
  accent, accent text, and the tints made from them), the type stack (system fonts only: `system-ui, -apple-system`
  first, so macOS and Linux use their own UI font, then the Segoe UI family, Roboto and Cantarell) and the type ramp (caption 12/16, body 14/20, subtitle 20/28, title 28/36),
  radii 4, 8, 10 and 12, and the motion tokens (83, 167 and 250 ms, enter `cubic-bezier(0, 0, 0, 1)`,
  exit `cubic-bezier(1, 0, 1, 1)`). `prefers-reduced-motion: reduce` sets every duration to 0.
- `base.css`: reset, type classes, the app bar (`sp-appbar`), buttons (`sp-btn`, `sp-btn-primary`,
  `sp-btn-lg`, `sp-btn-icon`, `sp-btn-link`; `data-flash` shows "Copied"), the segmented control
  (`sp-seg`), keycaps (`sp-kbd`), cards, the notice box, the progress bar, and the focus ring (a
  2 px amber ring with a 1 px dark halo outside it). `forced-colors: active` uses system colors.
- Icons are SVG files in `src/ui/icons/`, drawn as CSS masks (`sp-icon-copy` and so on), so they
  take the text color. The glyph is `src/ui/glyph.svg`. Page code makes icons with a class name,
  never with markup (the policy forbids `http://` in `src/`, and an SVG namespace is such a URL).
- `folder-store.js`: the chosen save folder (section 7.5).
- The toolbar icons (`icons/icon-16|32|48|128.png`) are made by `npm run icons`
  (`scripts/make-icons.mjs`): the spool glyph, drawn in three versions (16, 32, and
  128 also used for 48), so the edges stay sharp.

### 6.2 Result page
- It opens only when the user asks (the toast "Open" button, `page/open-result`). Done does not
  open it. It reads `sessionId` from `location.hash`. A value that is not a session ID, a missing
  receiver, or `E_SESSION_NOT_FOUND` shows "This capture is no longer in memory. Start a new
  capture."
- Data. The offscreen document built the images when Done was pressed, so the page assembles
  nothing and holds no decoded bitmaps of its own. `offscreen/last-info { sessionId }` gives the
  `FinishSummary`. The tile plan is `planTiles(widthPx, heightPx, tileTier)` and must have
  `tileCount` tiles, else "Something is wrong with this capture. Start a new capture." Each tile is one
  `offscreen/last-get { sessionId, item: index }` message (`pngBase64` → `Blob`), in order, and each
  tile shows when it is loaded. The full image is one `offscreen/last-get` with `item: 'full'`. It
  loads on the first Copy image or Save, not at the start (`fullBytes` of the summary gives its
  size). Opening the page does not drop the capture (section 7.6).
- The full image is blocked when `fullBytes` is 0 ("The full image could not be built. You can
  still use the AI screenshots.") or over `MAX_TRANSFER_BYTES` ("The full image is too large to copy or save
  here. Use the AI screenshots."). Copy image and Save are then disabled, and the AI screenshots stay usable. A
  failure of one `last-get` shows its message in the status bar.
- Layout: app bar (glyph, "Spool", Settings button); the page
  title; the line "Nov 6, 2026, 10:42 AM · 1,500 × 11,980 px"; the segmented control
  **For AI** (N screenshots) | **For people** (1 image), For AI first.
  - For AI: **Save all** with the note "AI reads each screenshot at full size." and what Save all
    saves; for more than one tile also "In your chat, press Alt+Shift+V to insert all N screenshots."
    (the keys are the shortcut that the browser has for the `insert-capture` command, read with
    `chrome.commands.getAll()` and written for the system: glyph keycaps on a Mac; the key of the manifest for the system when it does
    not say). **Copy image** does nothing for a capture that is too tall to copy as one image and says "Too tall to copy as one image.
    Save it, or copy the AI screenshots." Then the grid: each card has
    the preview, "Screenshot 2 of 5 · 1,500 × 2,576 px", **Copy** and **Save**. There is no "drag all":
    Chromium cannot drag more than one file to another tab ([browser-behavior.md](browser-behavior.md)).
  - For people: **Copy image**, **Save**, the size and bytes of the full image, and one tall column
    in a scroll area. The column stacks the tiles and cuts off the rows that the tile above
    already shows (`stackLayout`), so it needs no second decode of the full image.
  - Warnings: `summary.warnings`, in a notice box. A progress line shows "Loading tile 2 of 5".
  - Status bar (sticky at the bottom, a polite live region): first what Done saved
    (`saveInfoLine(summary.save)`), then the result of each copy or save. **Show in folder** after a
    save of this page. **Allow folder access** when `save.needsPermission` is true: it opens
    `options.html#save`.
- Save: `savePlan` gives the file paths of section 7.3 (`captureFiles()` in `src/lib/names.js`),
  all below `Downloads/<Settings.folderName>/`. Save all follows `saveTiles` and `saveFull`; the
  Save button of a tile and the Save button of For people save that one file. The page saves one
  file after the other with `chrome.downloads.download({ conflictAction: 'uniquify', saveAs: false
  })` and waits until each download is complete. This page writes to Downloads only; Done writes
  to the chosen folder (section 7.3).
- Save, fallback name: Chrome can refuse a path that its file name rules do not accept (the call
  rejects, for example "Invalid filename"). `names.js` removes the known cases, but a title can
  still contain something new. When the call rejects, `startDownload()` (`save-plan.js`) tries the
  same file once more with `captureBaseName(date, '')` (no page title). The page then saves all
  later files of this capture with that name, and the status line says that the title is not in
  the names. The error shows only when the second call is refused as well. An interrupted or
  canceled download is not retried. There is no retry when the fallback is the path that failed.
- Copy: `navigator.clipboard.write` with an `image/png` `ClipboardItem`. The call starts directly
  in the click handler (no `await` before it), so the user click is the permission. For the full
  image the item holds a promise of the `Blob`. The extension needs no `clipboardWrite` permission
  for this page. Each button shows "Copied" with a check for 1.5 s.
- Test hook (extension page only): `document.body.dataset.state` = `loading | ready | error`.
  `ready` is set when the summary and all tiles are loaded (the full image loads on demand).
  `error` is set for a fatal failure. `result.js` exports
  `debugApi = { summary, manifest, tilePlan, getTileBase64(i), getFullBase64() }`. `summary` is the
  `FinishSummary`. `manifest` has its fields in the shape of a `SessionManifest`, but `slices` is
  empty and `scale` is 0: the slices are gone and the scale is not known here. `getTileBase64(i)`
  and `getFullBase64()` are **async**: they return a promise of the PNG as a base64 string (no
  `data:` prefix). `getTileBase64` waits until all tiles are loaded; `getFullBase64` loads the full
  image. Both reject when the data is not there.
  The production page does **not** publish `debugApi`: there is no `globalThis.spoolDebug`, so no
  other script can ask the page for image data. The test build (`e2e/build-extension.mjs`) adds
  `<script type="module" src="debug-hook.js">` to its own copy of `result.html` (after the
  `result.js` line) and writes `debug-hook.js`. That file imports `{ debugApi }` from
  `./result.js` (the same module instance as the page) and sets `globalThis.spoolDebug =
  debugApi`. The e2e helpers read `spoolDebug` only. `npm run policy` forbids the names
  `spoolDebug` and `__spoolTest` in `src/`.
- Messages: the result page only sends (`runtime.sendMessage`). It has no `runtime.onMessage`
  listener, because the service worker broadcasts full frames with `runtime.sendMessage` and a
  listener in this page would receive them, also the area outside the selection. Only the
  service worker and the offscreen document may listen. `npm run policy` enforces this for
  `src/result/` and `src/options/`.
- Trusted Types: the CSP of the extension pages has
  `require-trusted-types-for 'script'; trusted-types 'none'`. These pages use no DOM sink that
  takes markup or code (`textContent`, `createElement`, `append`, `img.src` with a blob URL), and
  they create no policy. A change that needs `innerHTML` or the like does not work. That is
  intended.
- Test build: the e2e copy has another name ("Spool TEST BUILD — do not install"), another
  icon tint, the badge "TEST", and a folder below `os.tmpdir()` that is deleted when the run
  ends. It is never made in the repository folder (see `e2e/build-extension.mjs`).

### 6.3 Options page
- Layout: app bar; "Settings"; groups **Capture**, **Output**,
  **Save location** (the form), then **Shortcut**: one row for each command, "Start Spool"
  (`start-capture`) and "Insert last capture" (`insert-capture`). The key belongs to the browser:
  each row shows the keycaps that `chrome.commands.getAll()` gives, or "Not set" when the command
  has no key, and a **Change** button (`aria-label` "Change shortcut", described by the row label)
  that opens the shortcuts page of the browser. Each setting is a row: label, one help line, the
  control on the right.
  - Capture: overlap between steps, wait after each scroll, maximum length (each a list of
    presets, `NumberField.presets`: a saved value that is not a preset stays in the list as its own
    entry, so the form never changes it by accident), hide sticky and fixed bars (a switch).
  - Output: AI tile size (two cards, one for each tier, with the long edge of the tier), save AI
    tiles, save full image, "Copy the full image when you press Done" (`copyOnDone`, on by default)
    (switches).
  - Save location: the chosen folder (below), and the name of the folder in Downloads.
- A bar at the bottom (sticky) holds the status line, **Discard** (back to the saved values, active
  when the form changed) and **Save**. Values still go through `normalizeSettings`, and the status
  line tells what the browser changed: "Spool changed N value(s) to fit the limits. <name>: <typed>
  became <saved>." for a value that the browser moved, and a plain sentence for an empty value ("The
  folder name was empty, so Spool used "Spool"."). **Reset to defaults** is a text button in the
  footer.
- Save folder (section 7.5): the chosen folder is not a setting in `chrome.storage`. Its handle and the
  names of the folders below it are in IndexedDB (`folder-store.js`). The row has a title, one help line,
  and the buttons that fit its state (`describeSaveFolder` in `form-model.js`; the actions are in
  `save-actions.js`):
  - No folder: title "Downloads › Spool", "Default until you pick.", **Save to Pictures › Screenshots**
    (main button) and **Choose another folder**.
  - Connected (permission `granted` and the folder exists): the place ("Pictures › Screenshots"),
    "Connected.", **Change folder** and **Use Downloads instead**, and the line "Your browser may forget this
    folder when you close this tab or restart. When you reconnect, choose “Allow on every visit” to stop that."
  - Needs permission (`prompt`): the place, "Needs one click. Saving to Downloads › Spool until then.",
    **Reconnect** (main button), **Change folder**, **Use Downloads instead**, and the same line.
  - Folder not found (`denied`, or `granted` while the folder is gone: `folderExists`): "Folder not found",
    "Saving to Downloads › Spool until you pick again.", **Pick again** (main button) and **Use Downloads
    instead**.
  **Save to Pictures › Screenshots** calls `showDirectoryPicker({ id: 'spool-pictures', mode: 'readwrite',
  startIn: 'pictures' })` directly in the click, makes `Screenshots` in the picked folder, and stores the
  picked handle with the sub path `['Screenshots']` (a pick that is already named Screenshots gets `[]`).
  **Choose another folder**, **Change folder** and **Pick again** (after a folder that was picked as it is)
  call `showDirectoryPicker({ id: 'spool-shots', mode: 'readwrite', startIn: 'pictures' })` and store the
  handle with `[]`. **Reconnect** calls `requestFolderPermission` directly in the click, and then makes the
  sub folder again (which shows that the picked folder still exists). **Use Downloads instead** clears the
  folder and ends the question of the toast (`saveFolderAsks` is set to its limit). A browser that has no
  `showDirectoryPicker` shows none of the picker buttons. The page reads the folder again when it gets the
  focus.
- Addresses (the hash of `options.html`):
  - `#welcome`: the welcome page replaces the settings. The service worker opens it once, when the
    extension is installed (7.10).
  - `#setup`: the same page with the heading "Where should screenshots go?". The toast opens it (**Set up**
    and **Change**).
  - `#reconnect`: the settings, with the reconnect card above them. The toast opens it (**Reconnect**).
  - `#save`: scrolls to the Save location group and shows it with a ring for 1.6 s.
- Welcome page (`setup-ui.js`, the words in `setup-model.js`). Two columns (one when the window is narrow). Main column:
  the heading and the lead for the phase, the three choices (**Save to Pictures › Screenshots**, **Choose
  another folder**, **Keep using Downloads**; each button is 44 px high), "What happens next" (the folder
  window, with the button of the system: "Select Folder" on Windows, "Open" on Mac and Linux, then "Edit
  files"; Spool only writes inside Screenshots), and the notice "What Spool keeps" (each capture is
  saved as files and copied to the clipboard; the files stay until deleted, clipboard history may keep the
  image; the link **Change this in Settings** opens the settings). Side column: "Every capture gives you"
  (the layout of 7.3 with real names) and "Your three moves" (the keys of `chrome.commands.getAll()`, the
  paste key of the system, and "Use Ctrl+V, not Ctrl+Shift+V: that one pastes text only, so images vanish.").
  Phases: `pick`; `waiting` (the buttons are disabled; "Choose Pictures in the window."); `connected`
  ("You're set." with the callout "One more click, once": the browser may forget the folder when the tab
  closes or on a restart, and if a capture lands in Downloads, **Reconnect** and "Allow on every visit"
  fix it); `downloads` ("Downloads it is."); `no-picker`
  ("This browser can't pick folders."). A try that gives nothing shows a line above the buttons: the picker
  was closed ("No folder was chosen. Nothing changed."), the browser blocks the folder (`SecurityError`:
  "Your browser blocks that folder."), or another error. The text lives in a polite live region, and the focus
  moves to the first enabled button (or the heading) after each change. **Keep using Downloads** clears the
  folder and sets `saveFolderAsks` to its limit.
- Reconnect card (`describeReconnect`): "Your browser forgot this folder." ("It can do this after the last
  Spool tab closes, or after a restart. One click brings it back.") with **Reconnect <place>** and the
  tip "Choose Allow on every visit when asked."; after the third use it says "Your browser keeps forgetting."
  and adds **Use Downloads** (the count is `saveReconnects` in `chrome.storage.local`; a new folder resets
  it); "Reconnected." when access is back; "Not reconnected yet." when the user closes the prompt; "That
  folder is gone." with **Save to Pictures › Screenshots** when the folder does not exist.
- The permission prompt and the picker need the click: `requestFolderPermission` and the picker call start
  in the first statement of the click handler, before any `await`.

## 7. Post-capture flow (Done, clipboard, save, toast, shelf)

The browser facts behind these decisions are in [browser-behavior.md](browser-behavior.md).
No result tab opens by default. Owners: pipeline (`src/shared`, `src/sw`, `src/offscreen`,
`src/render`), page (`src/page`), extension pages (`src/result`, `src/options`, `src/ui`).
The names of the messages, their fields and their replies are in 7.4. They are frozen: a change
needs this section and every user of the message.

### 7.1 Flow
1. **Done** (trusted Enter or click). In the same task, with no `await` before it, the agent calls
   `navigator.clipboard.write([new ClipboardItem({ 'image/png': promise })])` when the API exists
   and the setting `copyOnDone` is on (the default). `promise` = `page/finish`, then
   `page/get-clipboard`, then base64 → `Blob`. With `copyOnDone` off the agent only sends `page/finish`.
2. SW `page/finish` → `offscreen/finalize` (7.9): mark finished, assemble the tiles and the full
   PNG (`src/render`), save the files (7.3), keep the outputs as the **last capture** (7.6), reply
   with a `FinishSummary`. The SW opens no tab. A failure gives an error reply and the agent keeps
   the session open (Done and Cancel stay), as in section 2.
3. The agent restores the page and shows the **toast** (`src/page/toast.js`). If the clipboard
   write rejected or the API is missing, the agent sends `page/clipboard-fallback`; the SW writes
   with `navigator.clipboard` in the worker (`clipboardWrite`, feature-detected) and replies
   `{ copied }`. The toast shows the final state (`'skipped'`, "Saved", when `copyOnDone` is off).
4. Toast: thumbnail, "Copied and saved" (or what failed, also how many files did not save), size and
   save location. Actions: **Open** (`page/open-result`), tile chips for captures with more than one tile
   (a click calls `clipboard.write` with a promise of `page/get-tile`), **Reconnect** when
   `save.needsPermission` is true (`page/open-options` with section `reconnect`), **Set up** for a capture
   that asks where to save (section `setup`), and the link **Change** on a save in Downloads (section
   `setup`). Long captures show the
   hint "Long capture? In your chat tab, press Alt+Shift+V to insert all N screenshots." (a Mac: ⌃⇧V) and, for a save that wrote the tiles,
   "Desktop app: drag them from <place> › Spool for AI." **Show in folder** for a save in Downloads. Auto-hide after 6 s (the first three
   long captures stay until the user closes them, 7.10); hover or focus pauses it; Esc closes it.
5. **Shelf**: command `insert-capture` (Alt+Shift+V) in any tab. The SW injects the page scripts
   with `config.mode = 'shelf'` and a one-time `config.shelfToken` bound to that tab and to the capture
   that is the last one now (7.8). In mode
   `shelf` the agent's `start()` opens the shelf, not the selection overlay. The shelf asks
   `page/shelf-info` and shows the last capture: **Insert N screenshots** reads every tile with
   `page/shelf-get` (after the click, never before; three at a time; at most 20 tiles for one paste, the rest in the next batch) and
   dispatches a synthetic `paste` event with a `DataTransfer` holding the PNG `File`s (`screenshot-01-of-05.png` …) at the editor that
   has the focus at the click, or a composer that the shelf finds when none has it. `defaultPrevented === true` → "Inserted 5
   screenshots." Else → the steps: "This chat won't take them all at once." with "Copy screenshot 1 of 5" (a trusted copy for each
   screenshot, then the user's own Ctrl+V). The click is acted on only while the card is visible and not covered (5, clickjacking
   guard). When the focus is in a frame owner (`iframe`, `frame`, `object`, `embed`) the
   shelf does not dispatch: "Spool cannot insert into an embedded frame. Click a number to copy one
   instead." A newer capture than the one of the token → "A newer capture exists. Press Alt+Shift+V again." Chips and
   **Copy full image** use trusted clicks and `page/shelf-get`.
   `{ summary: null }` → "Nothing to insert yet. Press Alt+Shift+S to spool a page."

### 7.2 Clipboard rule
The clipboard gets the **full image** (`page/get-clipboard` and `page/clipboard-fallback`
send `item: 'full'`) on **Done**, unless the setting `copyOnDone` is off. One tile that is the image 1:1 (`fitsOneImage`) → it is also the best image for an AI. Any other capture,
also one scaled tile → people get the full image; an AI gets the tiles through the shelf or the chips.
A full image over `MAX_TRANSFER_BYTES` (40 MiB) cannot travel in a runtime message (Chrome stops a
message at 64 MiB, and base64 adds a third). A separate limit guards the page: `navigator.clipboard.write` decodes `width × height ×
4` bytes in the renderer of the page that calls it, so an image over `MAX_CLIPBOARD_BITMAP_BYTES` (256 MiB, about 44,800 px high at
1,500 px wide) is **not written**: the agent skips the write (state `'toolarge'`, "Too tall to copy. Saved instead."), the shelf has no
**Copy full image**, and the result page does not copy it. The files, the tiles and the shelf are unchanged. Below that size, a
`page/get-clipboard` over the message limit fails with
`E_SESSION_TOO_LARGE` ("This image is too large to copy. Use the AI screenshots."), `page/clipboard-fallback`
replies `{ copied: false }`, and the toast says so. The same limit applies to every `pngBase64`.

### 7.3 Saving
- A folder is chosen (handle and `subPath` in IndexedDB, 7.5) and `folderPermission(handle)` is `granted`
  → write in `<handle>/<subPath...>`. `ensureSubPath` makes each folder of the sub path that is missing, so
  a deleted `Screenshots` is made again at the next save. `SaveInfo.label` is `<handle.name>/<subPath...>`,
  for example `Pictures/Screenshots` (the toast and Options show "Pictures › Screenshots"). A handle that
  was stored without a sub path (version 1.0.0) has `[]`: the files go into the picked folder itself.
  Never call `requestPermission` outside an extension-page click.
- Else `chrome.downloads` with the same layout under `Downloads/<Settings.folderName>/` (default
  `Downloads/Spool/`). The files go through `sw/download` (7.9).
- Layout (`captureFiles()` in `src/lib/names.js`), with `base = captureBaseName(date, title)` =
  `Spool <YYYY-MM-DD HH.mm.ss> <title>` (local time, the title is sanitized and cut at 48
  characters, left out when empty). The time is the **start** of the capture
  (`FinishSummary.createdAt`) for Done and for **Save all** on the result page: both write the
  same names, so a second save does not make a second set under other names:
  - Full image (`saveFull`): flat as `<base>.png`.
  - Tiles (`saveTiles`) of a capture that is not `fitsOneImage`: `Spool for AI/<base>/screenshot-NN-of-MM.png`.
  - One tile that is the image 1:1 (`fitsOneImage`): one flat file `<base>.png`, the full image
    when `saveFull`, else the tile when only `saveTiles` is on. Never both. Both off: no file
    (`save.location` `none`). One tile that is **scaled** (an image wider than the long edge of the
    tier) is not the image: it is a tile in the folder, next to the flat full image.
- A name that exists is not replaced: the folder writer adds ` (2)`, ` (3)` … to `<base>`;
  `chrome.downloads` uses `conflictAction: 'uniquify'`.
- If Chrome refuses the first download (`chrome.downloads.download` rejects, for example "Invalid
  filename"), the pipeline tries the whole set once more with `base` without the title.
- If the folder is chosen but not granted, the files go to Downloads and `save.needsPermission` is
  `true`. The same when the picked folder is gone (`NotFoundError` while the sub path is made or a file is
  written). `save.folderLabel` then holds the label of the folder, for the toast ("Reconnect Pictures ›
  Screenshots?"). If a write in the granted folder fails for another reason, the files go to Downloads
  too, and `warnings` gets "Could not write to the chosen folder. Saved to Downloads instead." When
  some files were written before the failure (a write stops at the first failure and keeps what it
  wrote), the warning says so: "Writing to Pictures › Screenshots stopped after 2 of 4 files. They stay
  there. All files went to Downloads instead." It leaves out the last sentence when Downloads failed too.
- If only some of the downloads complete, `save.location` is `downloads`, `save.files` is the number that
  completed, `save.failed` the number that did not, and `save.error` is "Some files could not be saved.".
- Blob URL vs. data URL (checked in Chromium 158, headless, with the production manifest and CSP):
  `chrome.downloads.download` works with a `blob:chrome-extension://<id>/<uuid>` URL that the
  offscreen document made and the service worker uses (50 KB, 5 MB and 60 MB files: complete in
  under a second, `fileSize` equals the Blob size). A revoked URL fails (`NETWORK_FAILED`), so the
  offscreen document revokes after the SW replied. The worker has no `URL.createObjectURL`, so the
  offscreen document must make the URL. A data URL also works (up to the 20 MB tried), but it needs
  the bytes in a message (64 MiB limit, 4/3 base64 growth) and a copy in the worker. Chrome made
  `Spool/Spool for AI/<base>/screenshot-01-of-02.png` with the folders, `uniquify` gave ` (1)`, and a name
  with `:` or `~` was refused with "Invalid filename" (the fallback without the title covers it).
  Decision: blob URLs. No file bytes travel in a message.

### 7.4 Types and messages
`FinishSummary` and `SaveInfo` are in `src/shared/types.js`. In short:
`FinishSummary = { sessionId, title, sourceHost, createdAt, widthPx, heightPx, tileCount, tileTier,
fitsOneImage (`fitsOneImage(planTiles(...), widthPx)`: one tile that is the image 1:1), fullBytes, thumbnailPngBase64, thumbnailWidthPx, thumbnailHeightPx, save, warnings }`
(`sourceHost`: the host name of the captured page, `''` for a local file; `parseSummary` shows `''` for a value that fails `isSourceHost`
instead of failing the capture; the worker may also set `teach: true`, 7.10);
`SaveInfo = { location: 'folder' | 'downloads' | 'none', label, files, needsPermission, error?, failed?,
folderLabel? }`: `failed` is the number of files that did not save (with `error`, when some did);
`folderLabel` is the label of the chosen folder that could not be used (with `needsPermission`).
`SaveInfo` may also have `askFolder` (the worker sets it in the reply of `page/finish` for a capture that
asks "Save to Pictures › Screenshots?", 7.10). `ShelfSummary = { tileCount, widthPx, heightPx, createdAt, sourceHost,
saveLabel, thumbnailPngBase64, thumbnailWidthPx, thumbnailHeightPx }`: the part of a summary that the shelf gets
(`toShelfSummary` in `src/sw/summary.js`). The shelf runs in any tab, so it gets no title, no session ID, no
warnings and none of the other details of the save. It gets the host name of the captured page (so the user sees where the
pixels come from before they put them into another page) and `saveLabel` (the label of a save that wrote files, `''` otherwise: for
the hint about a desktop app). The host is stored in the session in the offscreen document and goes only into the summary; it is
not written to storage, to a file name, to a log or to an error message, and no page gets it except the shelf in its closed shadow
root. `PageConfig` (`src/shared/types.js`) has `keys` (`{ start, insert, paste }`, each `{ parts, text }`, written by the worker
for the system with `src/lib/keys.js`) and `limits` (`{ maxImagesPerMessage, maxClipboardBitmapBytes }`) next to `shortcuts`; a
config without them gets the built-in values.
The thumbnail is the top of the image, at most 320 × 480 px (`THUMBNAIL_MAX_*`). `label` is the name
of the chosen folder, `Downloads/<folderName>`, or `Not saved`.
Tile `i` of the capture is `planTiles(widthPx, heightPx, tileTier)[i]` (`src/lib/tiles.js`): the
summary has no tile list. `item` is a tile index (whole number ≥ 0) or the string `'full'`.

Page → SW (content script, top frame only). The keys of `MSG` (also in `config.msg`) are
`PAGE_FINISH`, `PAGE_GET_CLIPBOARD`, `PAGE_CLIPBOARD_FALLBACK`, `PAGE_GET_TILE`, `PAGE_OPEN_RESULT`,
`PAGE_OPEN_OPTIONS`, `PAGE_SHOW_IN_FOLDER`, `PAGE_SHELF_INFO`, `PAGE_SHELF_GET`.

| Type | Fields | Reply data | Who may ask |
|---|---|---|---|
| `page/finish` | `sessionId` | `{ summary: FinishSummary }` | the tab of the session |
| `page/get-clipboard` | `sessionId` | `{ pngBase64 }` (the full image) | the tab of the session |
| `page/clipboard-fallback` | `sessionId` | `{ copied: boolean }` | the tab of the session |
| `page/get-tile` | `sessionId, index` | `{ pngBase64 }` | the tab of the session |
| `page/open-result` | `sessionId` | `{}` (opens `result.html#<sessionId>` next to the tab) | the tab of the session |
| `page/open-options` | `section` (`'save' \| 'setup' \| 'reconnect'`, `OPTIONS_SECTIONS`) | `{}` (opens `options.html#<section>` next to the tab) | any tab |
| `page/show-in-folder` | `sessionId` | `{}` (reveals the first file of the last save in the file manager; a save in Downloads only) | the tab of the session |
| `page/shelf-info` | `token` | `{ summary: ShelfSummary \| null }` | the tab of the token |
| `page/shelf-get` | `token, item` | `{ pngBase64 }` | the tab of the token |

The page `options.html#welcome` is not a section: only the worker opens it, on install (7.10).

Error codes of these messages: `E_SESSION_NOT_FOUND` (no last capture of this session and tab; no
offscreen document; an unknown or expired token; a shelf token whose capture was replaced: "A newer
capture exists. Press Alt+Shift+V again."; a shelf token whose capture ended: "This capture has ended.
Press Alt+Shift+V again."), `E_FORBIDDEN_SENDER` (a token of another tab),
`E_BAD_MESSAGE` (a tile index that does not exist: "Unknown part."), `E_SESSION_TOO_LARGE` (the
image is over `MAX_TRANSFER_BYTES`), `E_INTERNAL` (the images could not be built: "Could not build
the images. Try again.").

Result page → offscreen. The result page reads the last capture by its session ID (the URL
hash). Opening the page does not drop the capture.

| Type | Fields | Reply data |
|---|---|---|
| `offscreen/last-info` | `sessionId` | `{ summary: FinishSummary }`, or `E_SESSION_NOT_FOUND` |
| `offscreen/last-get` | `sessionId, item` | `{ pngBase64 }` |

Other messages (the pages never send them): worker → offscreen: `offscreen/session-open`
`{ sessionId, tabId, title, host, tileTier }` → `{}`; `offscreen/finalize`
`{ sessionId, tabId, saveTiles, saveFull, folderName }` → `{ summary }`; `offscreen/output-info`
`{ sessionId, tabId }` → `{ summary }`; `offscreen/get-output` `{ sessionId, tabId, item }` →
`{ pngBase64 }`; `offscreen/shelf-grant` `{ token, tabId }` → `{ hasCapture }`;
`offscreen/shelf-info` `{ token, tabId }` → `{ summary | null }`; `offscreen/shelf-get`
`{ token, tabId, item }` → `{ pngBase64 }`. Offscreen → worker: `sw/download`
`{ files: [{ path, url }] }` → `{ saved, rejected, interrupted }`. `offscreen/ping` now replies
`{ sessions, lastCapture }`; the worker closes the document only when `sessions` is 0 and
`lastCapture` is `false`. A finished session lives only for the time of `offscreen/finalize`
(7.9). The messages `offscreen/get-manifest`, `offscreen/get-slice`, `offscreen/session-finish`,
`offscreen/session-release` and `sw/release` do not exist any more: nothing sent them.

### 7.5 Folder store (`src/ui/folder-store.js`)
ES module used by the options page and the offscreen document. The save target is a handle plus a
`subPath`: the user picks Pictures, and Spool writes into `Pictures/Screenshots`. **The stored handle can be
a parent of the folder that Spool writes in.** The browser grants write access to the picked folder and
everything below it, so the grant covers all of Pictures, and Spool itself writes only below the sub path.
- `getSaveTarget()` → `Promise<{ handle, subPath: string[] } | null>`. `subPath` has at most two names, each
  unchanged by `sanitizePathSegment` (`cleanSubPath`); anything else reads as `[]`. A handle stored without
  a sub path (version 1.0.0) reads as `[]`, so a 1.0.0 user keeps the folder, and nothing is migrated.
  Never throws.
- `getSaveFolder()` → the handle only (`Promise<FileSystemDirectoryHandle | null>`). Never throws.
- `setSaveFolder(handle, subPath = [])` stores both in one transaction (an invalid `subPath` is a
  `TypeError`). `clearSaveFolder()` deletes both. Keys in the store `handles` of the database
  `spool-folder` (version 1): `saveFolder` (the handle, as in 1.0.0) and `saveSubPath` (a list of names).
- `ensureSubPath(root, subPath)` makes each folder that is missing (`getDirectoryHandle(name, { create:
  true })`) and gives the last one. It throws what the browser throws: `NotAllowedError` without write
  access, `NotFoundError` when `root` is gone.
- `folderPermission(handle)` → `'granted' | 'prompt' | 'denied'` (never throws; a handle that cannot be
  queried is `'denied'`). `folderExists(handle)` reads the first entry of the folder: false only for
  `NotFoundError` (the browser keeps a permission by path, so a deleted folder can still read as
  `granted`). `requestFolderPermission(handle)`: extension-page click only.
- Pickers (extension page, in a click, before any `await`): `PICKER_OPTIONS` = `{ id: 'spool-shots', mode:
  'readwrite', startIn: 'pictures' }` for "Choose another folder"; `SETUP_PICKER_OPTIONS` = `{ id:
  'spool-pictures', mode: 'readwrite', startIn: 'pictures' }` for "Save to Pictures › Screenshots" (its own
  id: the remembered folder of an id replaces `startIn`). `chooseScreenshotsFolder(picker)` picks, makes
  `Screenshots` (not for a pick named Screenshots) to show that the browser lets Spool write, and gives
  `{ handle, subPath }`; `null` when the user closes the picker; `SecurityError` for a blocked folder.
IndexedDB holds the directory handle and the folder names only, never image data. The offscreen document
calls `getSaveTarget` and `folderPermission` only (and `ensureSubPath`, which asks for nothing); the first
two never throw into the pipeline: it treats a failure as "no folder". `npm run policy` allows `indexedDB`
in this file only, and `showDirectoryPicker` and `requestPermission` in `src/ui/`, `src/options/` and
`src/result/`.

### 7.6 Lifetime
The offscreen document keeps one **last capture** (outputs, not slices: the tiles, the full image,
the thumbnail, the summary) until the next capture finishes (`offscreen/finalize` drops it first),
`LAST_CAPTURE_TTL_MS` (60 min) passes, or a new frame needs its memory: the bytes of the last
capture count in `TOTAL_MAX_BYTES`, and the store drops the capture before it refuses a frame for
the total limit. The slices of a session are freed as soon as the outputs are built. The result page
reads these outputs; opening it no longer drops them. While the last capture exists, the worker
does not close the offscreen document. The outputs are `Blob`s that the browser owns, like the
slices (see "Memory" in section 4).

### 7.7 Permissions
Add `clipboardWrite` (worker fallback) and the command `insert-capture` (Alt+Shift+V; `MacCtrl+Shift+V` on a Mac). Nothing
else. The keys of a Mac are Control+Shift+S and Control+Shift+V (`suggested_key.mac`): Option+Shift+letter types a character in a text
field on a Mac, and Chrome handles a chord with Command or Control before the page, so a Mac key with Control is the safe choice;
Command+Shift+S is "Save As" and Command+Shift+V pastes text only (the bug that this key set is not allowed to repeat). Spool binds no Ctrl+V
and no Ctrl+Shift+V (plain paste drops an image). A key written in the manifest cannot follow a remap, so the title of the toolbar
button names no key. `test/unit/keys.test.js` checks the manifest keys. The File System Access API needs no manifest permission.

### 7.8 Shelf tokens
- The SW makes a token with `crypto.randomUUID()` for each `insert-capture`, after it has seen that
  no agent is active in the tab, and registers it with `offscreen/shelf-grant` (only when an
  offscreen document exists: without one there is no last capture, and the SW does not create it).
- A token belongs to one tab, and to one capture: `offscreen/shelf-grant` stores the session ID of the
  last capture at that moment (null when there is none). `offscreen/shelf-info` and
  `offscreen/shelf-get` serve only that capture. When the last capture is another one now (a newer
  capture), the reply is `E_SESSION_NOT_FOUND` with "A newer capture exists. Press Alt+Shift+V again."
  When there is no capture any more, "This capture has ended. Press Alt+Shift+V again." A token that
  was granted with no capture gets `{ summary: null }` and "Nothing to insert yet. ..." while there is
  still none, and "A newer capture exists. ..." after one appears. A new token for the same tab ends
  the old one. It ends after
  `SHELF_TOKEN_TTL_MS` (10 min), when the tab closes (`tabs.onRemoved` sends `offscreen/drop-tab`),
  and when the offscreen document closes. At most `MAX_SHELF_TOKENS` (8) tokens live at once, and
  the oldest goes first. A page load in the tab does not end a token: the worker has no
  `tabs.onUpdated` listener (section 2, step 12). The shelf card and the page script that holds the token are gone
  with the page, and the token cannot be used from another tab or for another capture, so a token
  that is left over stays unused until one of the endings above.
- The SW reads the tab from `sender.tab`, never from a field. The offscreen document checks the
  tab: a token of another tab → `E_FORBIDDEN_SENDER`; an unknown or expired token →
  `E_SESSION_NOT_FOUND` ("This capture has expired here. Press Alt+Shift+V again."). When no offscreen
  document exists, `page/shelf-info` replies `{ summary: null }` and `page/shelf-get` fails with
  `E_SESSION_NOT_FOUND`.
- A shelf never gets data of another capture than the one that was the last capture when its token was
  granted. To use a newer capture, the user opens the shelf again.

### 7.9 Finalize and save (offscreen document)
`offscreen/finalize { sessionId, tabId, saveTiles, saveFull, folderName }`:
1. The session must exist and belong to `tabId` (`E_SESSION_NOT_FOUND` otherwise; a session of
   another tab looks like an unknown one). The same session and tab, finalized before, returns its
   summary again (a second Done, or a retry after a lost reply, does not build twice). Two calls
   at the same time share one build.
2. One finalize runs at a time. The old last capture is dropped. The session is finished (frames in
   progress end first) and read with `takeForAssembly`.
3. `planAssembly`, `planTiles`; `src/render` builds each tile with at most 2 decoded bitmaps, then
   the thumbnail, then the full PNG in chunks of at most 512 rows (`png-stream.js`). One tile that
   is not scaled (`fitsOneImage`) is the same `Blob` as the full image. One tile that is scaled is
   built on its own, and `fitsOneImage` is false.
4. The session is released (its slices are freed) and the outputs become the last capture.
5. The files are saved (7.3) and `summary.save` is set. A save failure never fails the finalize:
   it sets `save.error` (and `location` `none`).
6. Failure in step 3: `E_INTERNAL`. The session stays finished until `SESSION_TTL_MS`, so Done can
   be tried again.

`sw/download { files }` (offscreen → SW): each file is `{ path, url }`. `path` is relative to
Downloads: 1 to 4 clean segments (`isDownloadPath`), the first one is `folderName`. `url` is
`blob:chrome-extension://<own id>/<uuid>`. The SW starts the files one after the other with
`chrome.downloads.download({ url, filename: path, conflictAction: 'uniquify', saveAs: false })`
and waits until each one is complete or interrupted (at most 120 s each). `saved` counts the
complete ones, `rejected` the calls that Chrome refused, `interrupted` the others. The offscreen
document revokes the URLs after the reply. The SW keeps the browser's download ID of the first
complete file in `chrome.storage.session` (`lastSaveDownloadId`, one number, replaced by the next
save, cleared when the browser closes) for **Show in folder**. The reply to the offscreen document has
the counts only.

### 7.10 Toolbar state and the first-save question
- **Capturing state** (`src/sw/capturing.js`). While a capture session is open in a tab, the toolbar
  button shows a badge `●` (amber, `#FFB224`, dark text) on that tab, with the title "Spool is capturing
  this tab. Press Esc to cancel." The worker sets it after `page/session-open` worked, and clears it (empty
  badge, the title of the manifest) when `page/finish` worked and on `page/cancel`. Chrome clears a
  tab-specific badge when the tab navigates or closes. The state is only UI: a failing call is
  ignored, and it never fails a message. It is separate from the `!` badge of a failed start.
- **Welcome page on install** (`src/sw/welcome.js`). The worker registers `chrome.runtime.onInstalled` at the top
  level. For the reason `install` (and no other: not `update`, `chrome_update` or `shared_module_update`; a
  reload of the extension is an `update`) it opens `options.html#welcome` in a new tab. It needs no
  permission and never throws (a tab that cannot open gives `false`). This is the one tab that Spool opens by
  itself; the result tab still never opens by default.
- **Save question** (`src/sw/first-save.js`). A capture that Spool saves to Downloads because no folder is
  chosen (`save.location === 'downloads'`, files saved, `needsPermission` false, no `save.error`, no warning in
  the summary) gets `summary.save.askFolder = true` in the reply of `page/finish`, on the first
  `MAX_SAVE_ASKS` (3) such captures. The worker keeps the number of asks in `chrome.storage.local`
  (`saveFolderAsks`) and adds one before it answers; a flag `firstSavePrompted === true` of version 1.0.0
  counts as one. Two captures that finish together take the asks one after the other. A storage that fails
  counts as "do not ask". Why three: the toast can be missed (the user closes the tab at once), and a question
  that is spent when it is handed out is gone for good. The toast shows "Save to Pictures › Screenshots?"
  with **Set up** and **Not now** (section 5); **Not now** stores nothing. The user ends the question with
  **Keep using Downloads** (welcome page) or **Use Downloads instead** (settings), which set the count to its
  limit. After the third ask only the link **Change** of the caption remains. The question is not asked for a
  capture that has `needsPermission` (that has its own block), for a folder that failed, or when nothing was
  saved. No image data goes into `chrome.storage`.
- **Teaching toast** (`src/sw/teach.js`). The toast of a long capture teaches the key that pastes the full image and the shelf key,
  and a toast that hides after 6 s teaches nothing to a person who looks at the page. For the first `MAX_STICKY_LONG_TOASTS` (3)
  captures of more than one tile the worker sets `summary.teach = true` in the reply of `page/finish`, and the toast stays until the
  user closes it. The count is one number in `chrome.storage.local` (`longToastsShown`), taken one capture after the other; a storage
  that fails gives a toast that hides by itself. After the third, a long toast has its normal 6 s.
- **Shortcut keys.** The worker reads `chrome.commands.getAll()` for each start and puts
  `shortcuts: { start, insert }` into the `PageConfig` as the browser spells them, and `keys` written for the system. Windows and
  Linux give words joined by "+", a Mac gives glyphs with no "+" ("⌃⇧V"); `shortcutParts` in `src/lib/keys.js` reads both on every system and
  on a Mac turns the words into glyphs. The result page, the options page and the welcome page use the same functions. The toast hint
  and the shelf texts show these keys. The texts that come from the worker or the offscreen document name the default keys; the page
  replaces them (`ui.withKeys`).
