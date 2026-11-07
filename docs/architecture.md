# Architecture

This document explains how Spool works and why. [contracts.md](contracts.md) defines the exact
interfaces. This document explains the reasons and the algorithms.

Units: plain names are CSS px. Names that end in `Px` are device px, the pixels of a
`captureVisibleTab` image. Names that end in `Ms` are milliseconds.

Words: the code and this document say **tile** for one cut of the full image. The interface says
**AI screenshot**. The code says **slice** for the image of one scroll step. The interface says
**step**. The Insert last capture card is `shelf` in the code, and the page behind **Open** is the
`result` page in the code and the **capture page** in the interface. **Copy & save** is `finish`.

## 1. Design rules

- The service worker holds no session state. The browser can stop it at any time.
- The offscreen document owns the image data. It keeps the data in memory only. It holds the
  slices of open captures and the outputs of the last finished capture.
- The page scripts do the work that needs the page. They select, scroll, restore, and show the
  toast and the Insert card.
- During a capture, the page scripts get no image data. After **Copy & save**, they get the bytes
  of the user's own capture: the full image for the clipboard, the thumbnail and the tiles.
- Pure functions in `src/lib/` do the math. They have no DOM and no `chrome.*` calls. Node tests
  run them.
- The extension has zero runtime dependencies and no build step.
- No capture page opens by default. **Copy & save** copies, saves and shows a toast. The one tab
  that Spool opens by itself is the Welcome tab, once, when the extension is installed.
- Anything that needs a user click, such as the folder picker or the folder permission prompt,
  runs in an extension page and starts in the first statement of the click handler.

## 2. Contexts

| Context | Files | Lifetime | Holds |
|---|---|---|---|
| Service worker (ES module) | `src/sw/*` | Wakes for an event and stops when idle. | Nothing that must survive a restart. |
| Page scripts (classic scripts, isolated world) | `src/page/*` | From the start of a capture to the close of its toast. For the Insert card: from the shortcut to the close of the card. | The agent state, the overlay, the style jar, the toast, the card. |
| Offscreen document (ES module) | `src/offscreen/*`, `src/render/*` | From the first capture until no session and no last capture remain. | The sessions (PNG slices and seam data), the last capture (tiles, full image, thumbnail), the Insert tokens. |
| Capture page (ES module) | `src/result/*` | While its tab is open. The user opens it with **Open** on the toast. | The tiles and the full image of the last capture. |
| Settings page (ES module) | `src/options/*`, `src/ui/*` | While its tab is open. It also shows the Welcome tab and the Reconnect card. | The form values. The folder handle is in IndexedDB. |

The page agent is the script `agent.js`. It drives a capture inside the page. The word "agent" in
this document always means this script.

The page scripts are injected in this order: `page-lib.js`, `ui-kit.js`, `overlay.js`, `toast.js`,
`shelf.js`, `agent.js`.

## 3. Data flow

```text
            Toolbar click, start shortcut or Insert last capture shortcut
            (user gesture: the browser grants activeTab)
                            |
                            v
 +------------------------+  1 inject   +----------------------------+
 |  Service worker        |------------>|  Page (isolated world)     |
 |  src/sw/*              |             |  page-lib, ui-kit,         |
 |  no session state      |<------------|  overlay, toast, shelf,    |
 +------------------------+  2 page/*   |  agent                     |
      |      ^                messages   +----------------------------+
      |      |
      | 3 captureVisibleTab,    5 sw/download (blob URLs)
      |   offscreen/add-frame,        |
      |   offscreen/finalize          |
      v                               |
 +----------------------------------------+      +-------------------------+
 |  Offscreen document                    |----->|  Folder that the user   |
 |  src/offscreen/*, src/render/*         |  4   |  chose (File System     |
 |  slices, last capture, Insert tokens   |      |  Access), or Downloads  |
 +----------------------------------------+      +-------------------------+
```

Steps of one capture:

1. The user starts the capture. The service worker injects the page scripts into the top frame.
2. The agent in the page selects the area and sends `page/*` messages.
3. For each frame, the service worker captures the tab. It sends the image to the offscreen
   document. The offscreen document crops it, checks the seam and stores the slice.
4. When the user clicks **Copy & save**, the offscreen document builds the tiles, the thumbnail and
   the full image. It frees the slices, keeps the outputs as the last capture and saves the files.
5. The page gets a summary and shows the toast. The full image goes to the clipboard.
6. The user can open the Insert card in any browser tab and insert the tiles of the last capture,
   or open the capture page from the toast.

One frame in detail:

```text
 agent                  service worker                 offscreen
   |                          |                            |
   | scroll, wait             |                            |
   | free pinned elements     |                            |
   | hide overlay             |                            |
   |-- page/capture-frame --->|                            |
   |                          | tab is active?             |
   |                          | captureVisibleTab          |
   |                          | tab is still active?       |
   |                          |-- offscreen/add-frame ---->|
   |                          |                            | decode, crop
   |                          |                            | seam check, store
   |                          |<-- IntakeResult -----------|
   |<-- PageIntake -----------|                            |
   | show overlay             |                            |
```

The agent never receives image data during a capture. The `PageIntake` has numbers and a seam
status only.

## 4. Capture algorithm

### 4.1 Start

1. The service worker refuses a restricted URL. It shows a `!` badge for 4 seconds.
2. The service worker reads the settings. It makes a session ID (a random UUID).
3. It injects three things in the isolated world: the config, the page scripts, and the call
   `agent.start()`. If an agent is already active, the first step leaves the config of the
   running session unchanged. The service worker then stops. `agent.start()` does nothing for a
   malformed config.
4. The agent shows the selection overlay. The user drags a box, or clicks a panel. The panel under
   the pointer gets an outline.
5. The agent finds the scroll target. It clips the box to the visible box of the target and to
   the viewport. If nothing is left, it shows "Select an area inside the page." and starts the
   selection again.
6. The agent sends `page/session-open`. The service worker creates the offscreen document when
   it does not exist, and opens the session in it. These two actions are one step under a lock,
   so the idle check cannot close the document in between. The service worker adds the tile size
   tier from the settings. If the service worker refuses the session, the agent shows the error
   and starts the selection again.
7. The agent captures the first frame. If this capture fails, the next step captures the first
   frame again before it scrolls.

The command `insert-capture` (`Alt+Shift+V`) uses the same injection with `config.mode = 'shelf'`.
In this mode, `agent.start()` opens the Insert card and nothing else. See section 7.6.

### 4.2 Scroll target

1. The agent samples a grid of points inside the box. The step is 80 CSS px. There are at most 12
   points on each axis. At each point it reads the whole stack of elements with
   `document.elementsFromPoint`, also in open shadow roots. It walks up from each hit. It crosses
   shadow roots through `host`.
2. An element is a candidate when it has these two properties:
   - `scrollHeight > clientHeight + 1`
   - computed `overflow-y` is `auto`, `scroll` or `overlay`

   The page itself is a candidate when it scrolls: its content is taller than the viewport, and
   the viewport does not have `overflow: hidden` or `clip`. `<html>` is not a candidate of its
   own. `<body>` is not one when it hands its overflow to the viewport.
3. Each candidate has a visible box. This is its client box (no border, no scrollbars), cut by
   the viewport and by every ancestor that clips it.
4. The share of a candidate is the part of the selected box that its visible box covers.
5. The agent picks the target:
   - Some candidates cover at least half of the selected box. The agent picks the innermost of
     them: the one that does not hold another of these candidates. On a tie, the one that is
     higher on the page wins.
   - No candidate covers half. The agent picks the candidate with the largest share.
   - There is no candidate. The agent uses `document.scrollingElement`.

This is how Spool scrolls the inner panel of a chat app instead of the page.

### 4.3 Coordinates

Each frame has a rectangle `rect` in the viewport. `contentY` is the position of the top edge of
`rect` inside the scroll content.

| Target | `contentY` |
|---|---|
| Element | `scrollTop + rect.y − box.y` |
| Document | `scrollY + rect.y` |

The offscreen document converts the CSS values to device px:

```text
scale = bitmapWidth / viewport.width
sx    = ceil(rect.x × scale − 0.01)                    first device column of the crop
ex    = floor((rect.x + rect.width) × scale + 0.01)    end of the crop
sw    = ex − sx                                        the same for sy, ey, sh
yPx   = round(contentY × scale)
```

The crop rounds inwards. It holds only the device pixels that the rect covers. A device pixel
belongs to the crop when at least 99% of it lies inside the rect. The margin of 0.01 px absorbs
the floating-point error of `scale`. The crop is clamped inside the bitmap, and `sw` and `sh` are
at least 1. The crop depends only on the rect, the viewport and the bitmap size, so every frame of
a session gets the same crop. Rounding the size instead would add a row or a column to the crop
when the size has a fraction of .5 or more.

Example: the area is 600 × 700 CSS px. The display scaling is 150%, so `scale` is 1.5.

- Each slice is 900 × 1,050 px.
- A step scrolls `700 − 80 = 620` CSS px. The overlap setting is 80 px.
- The second slice starts at `yPx = round(620 × 1.5) = 930`.
- The two slices share `1,050 − 930 = 120` rows. This equals 80 CSS px.

Spool uses the scroll position that the page reports after the scroll. It does not use the
requested distance. A page that stops early or scrolls less gives the right `contentY`.

### 4.4 One step

1. If the last frame is not stored (its capture failed), capture it first (section 4.5). At the
   start, this is the first frame. If this capture fails again, the step ends and the page stays
   where it is.
2. Read `before = scrollTop`.
3. Scroll by `±(rect.height − overlapCss)`. The distance is at least 8 px. The scroll is instant.
   It ignores `scroll-behavior`.
4. Wait for two animation frames. Then wait `settleMs`.
5. Read `scrollTop` again. If it moved less than 0.5 px, the area reached the end. A step down
   shows "End of panel". A step up shows "Reached the top." Auto stops.
6. Capture the frame (section 4.5).
7. Update the status with the numbers from the `PageIntake`.

Each frame has a number, `seq`. The first frame has `seq` 0. The agent counts only the frames that
got an `ok` reply. A frame that fails gets no number. The agent sends the next frame with the same
`seq`. This includes a frame that fails with `E_TAB_NOT_VISIBLE`.

A failed frame is captured again before the next scroll. This holds for a manual step and for
Auto. A failed capture therefore never leaves a gap in the image.

### 4.5 One capture

1. Check that the area still fits the viewport. If the window got smaller, send nothing and show
   "The window size changed. Cancel and select the area again."
2. If "Hide sticky and fixed bars" is on, change the pinned elements that cover the area.
   Do this before every frame, from the first frame on. A style jar records the old values.
   - A sticky element gets `position: static`. It keeps its space in the layout. It stops
     following the scroll. It appears once, at its natural place in the content, for example a
     header at the top or a date divider between its messages. Spool does not hide a sticky
     element, because this would leave a gap in the content.
   - A fixed element gets `visibility: hidden`. It is not part of the content. It would repeat
     in every frame. This covers headers, footers, chat composers and fade gradients.
   - Spool never changes the scroll target, an element that contains the scroll target (for
     example a fixed wrapper around the scrolled panel), the overlay, `html` or `body`.
3. Hide the overlay. Wait for two animation frames.
4. Send `page/capture-frame` with the frame metadata.
5. The service worker registers a temporary `tabs.onActivated` listener. It checks that the tab is
   the active tab of its window. It calls `captureVisibleTab` through a queue. The queue spaces
   the calls 550 ms apart and retries two transient errors a bounded number of times: the quota
   error, and `image readback failed` (Chrome has no frame of the tab yet, as on a page that has
   just loaded). Before every attempt the queue runs the active-tab check and the switch count again.
   After the call it checks the active tab again and removes the listener. Then it sends the image to the offscreen document.
   A tab switch at any time in this span fails the call with `E_TAB_NOT_VISIBLE`, and the image
   goes no further.
6. Show the overlay again. The page keeps the changed elements changed until the capture ends.

The overlay hides inside its closed shadow root. The host element has no attribute that shows the
state. A page script cannot see the moment of a capture in the host element.

The agent finds the pinned elements in two ways:

1. A hit test. The agent samples a grid of points in the area with `elementsFromPoint`. It
   inspects each element at a point, each ancestor of it, and the open shadow roots. This finds a
   fixed wrapper that has no box of its own, because its visible child is hit. It runs before
   every frame.
2. A full scan. The agent walks the whole document and its open shadow roots one time for each
   capture. This finds pinned elements that take no pointer events, for example a fade above a
   chat composer. Before each frame, the agent checks only these candidates again: is the element
   still pinned, and does its box meet the area. The scan does not find a pinned element that is
   created later and takes no pointer events. Only the hit test can find it.

The capture queue runs one capture at a time. It starts each call at least 550 ms after the
start of the previous call. Chrome allows 2 calls each second. If Chrome reports the quota error,
the queue waits 600 ms and tries again. It tries at most 3 more times.

### 4.6 Stop rules

| Rule | Result |
|---|---|
| The scroll does not move | End of the content. Auto stops. |
| Covered height is at least `maxHeightCss` | "Reached the length limit." The agent takes no more steps. |
| Three frames in a row are duplicates | Auto stops. "No new content found." |
| The tab is not visible | Auto pauses. "Go back to this tab to continue." |
| A step fails | Auto stops. The control bar shows the message. |
| The user presses Copy & save or Cancel while Auto runs | Auto finishes the current step. Then it ends. |
| The user presses Auto again | Auto finishes the current step. Then it stops. |

Auto scrolls down only. The covered height is the height between the top of the highest stored
frame and the bottom of the lowest stored frame. A duplicate frame (a stored slice has the same
place and height) is not stored, so it does not count toward the covered height.

The agent runs one step at a time. It ignores a step command while another step runs. A manual
step, the first capture and Copy & save set the busy flag: the overlay turns the step buttons off. Auto
does not set it, so the user can press Auto again to turn it off. Copy & save and Cancel stay active.

### 4.7 Limits that protect the capture

A page can jump its own scroll position, for example with a script or a virtual list. The
offscreen store has these limits. They do not depend on the page or on the settings.

| Limit | Value | Result |
|---|---|---|
| Jump limit | A new slice must overlap or touch the rows that the session covers. | Else `E_CAPTURE_FAILED`: "The page moved too far. Finish now to keep what you have." |
| Bytes of one capture | 512 MiB of PNG data (`SESSION_MAX_BYTES`) | `E_SESSION_TOO_LARGE`. |
| Bytes of all captures | 1 GiB, with the last capture (`TOTAL_MAX_BYTES`) | The store drops the last capture first. Then `E_SESSION_TOO_LARGE`. |
| Height of the image | 300,000 px (`MAX_TOTAL_HEIGHT_PX`) | `E_SESSION_TOO_LARGE`. |
| Page zoom | The scale and the crop width of each frame must match the first frame. | `E_CAPTURE_FAILED`: "Page zoom changed. Finish now to keep what you have." |

The jump limit makes a gap impossible. Every stored slice overlaps or touches the rows that were
covered before it. So Spool has no gap warning.

## 5. Seam check

The scroll positions give the expected place of each slice. The real place can differ by a few
rows. A page can load content late, animate, or round a scroll. The seam check finds the real
place.

### 5.1 Signature

`rowSignature` turns a slice into a small luminance image. It has one value for each row and each
column bin. A slice has at most 128 bins.

```text
luminance = (77 R + 150 G + 29 B) >> 8
value     = mean luminance of the pixels of one row inside one bin
```

The offscreen document builds the signature when it crops the frame. It keeps the signature with
the slice. It does not need the pixels again.

### 5.2 Match

Spool compares these slices:

- For a frame that moves down, Spool compares the new slice with the overlapping slice above it.
- For a frame that moves up, it compares the new slice with the overlapping slice below it.
- If only the other side overlaps, it uses that side and swaps the roles.

`matchSeam` gets the signatures of an upper and a lower slice. `expectedOffset` is the number of
rows from the top of the upper slice to the top of the lower slice.

Spool tries each shift `d` from `−maxShift` to `+maxShift`. For each shift, it compares two
groups of rows. The first group is the rows of the upper slice from `expectedOffset + d`. The second
group is the rows of the lower slice from row 0. Spool skips a shift that has fewer than
`minOverlap` rows.

`meanDiff` is the mean absolute difference between the two groups of values. It is a number from 0
to 255. The row difference of one row is the mean absolute difference of the values of that row
alone.

| Constant | Value | Meaning |
|---|---|---|
| `threshold` | 3 | Largest `meanDiff` that still counts as a match. |
| `maxRowDiff` | 24 | Largest row difference that any single row of the overlap may have. |
| `minOverlapRows` | 16 | Fewest rows that one comparison may use. |
| `maxShiftRows` | 256 | Largest absolute value of `d`, in device px. |
| `flatStdDev` | 2 | An overlap with a smaller standard deviation is flat. |

A shift is acceptable when its `meanDiff` is at most `threshold` and no row of its overlap has a
row difference above `maxRowDiff`. The row rule makes the check stricter. A mostly blank overlap
can pass the mean rule when a few rows are completely different. For example, 2 rows that differ
by 200 in 300 rows give a mean of about 1.3. Such rows show that the two slices do not show the
same content.
Two captures of the same content differ by a few levels in a row, because of anti-aliasing or a
blinking caret. A text row against other content differs by far more (about 120 in the unit
tests). The limit 24 is about 10% of the range. It lies above the noise and well below a real
mismatch.

The decision order is:

1. The overlap at `d = 0` is flat. The status is `ambiguous`.
2. The shift `d = 0` is acceptable. The status is `exact`.
3. Another shift `d` is acceptable, and its overlap is not flat. The one with the smallest
   `meanDiff` wins. Ties go to the smallest `|d|`, then to the positive shift. The status is
   `corrected`.
4. No shift is acceptable. The status is `unmatched`.

### 5.3 Result

| Status | Meaning | What Spool does |
|---|---|---|
| `first` | First slice of the session. | Stores it. |
| `exact` | The slices match at the expected place. | Stores the slice at `yPx`. |
| `corrected` | The slices match at a shift `d`. | Stores the slice at `yPx + d`. |
| `ambiguous` | The overlap is blank. A blank area matches any other blank area. | Stores the slice at `yPx`. Adds a warning. |
| `unmatched` | No shift is acceptable, or no stored slice overlaps the new slice. | Stores the slice at `yPx`. Adds a warning. |
| `duplicate` | A stored slice has the same place (within 1 px) and the same height. | Does not store it. Reports index −1. |

Each capture lists the steps whose seam Spool could not verify, in plain text: "Spool could not
verify 1 seam, near step 3. Check that area." The summary of the capture carries the warnings, and
the capture page shows them.

## 6. Assembly and tiling

### 6.1 Assembly

`planAssembly` gets the slices sorted by `yPx`. It returns a list of pieces. A piece copies rows of
one slice to a place in the image.

For two neighbours A (upper) and B (lower) that overlap, the cut is in the middle of the overlap:

```text
cut = B.yPx + floor((A.yPx + A.heightPx − B.yPx) / 2)
```

A gives the rows above `cut`. B gives the rows from `cut`. A slice that other slices fully cover
gives no piece.

Example: A starts at 0 and has 900 rows. B starts at 780 and has 900 rows. The overlap has 120
rows.

| Value | Result |
|---|---|
| `cut` | `780 + floor((900 − 780) / 2) = 840` |
| Piece of A | `srcY` 0, `dstY` 0, 840 rows |
| Piece of B | `srcY` 60, `dstY` 840, 840 rows |
| `totalHeight` | `max(0 + 900, 780 + 900) − 0 = 1,680` |

`totalHeight` is `max(yPx + heightPx) − min(yPx)`. The jump limit (section 4.7) keeps the slices
in one stretch, so a capture has no gap. The library still allows a gap. The renderer paints the
rows that no piece covers white, in the tiles and in the full image.

### 6.2 Tile geometry

A tile fits a tier when its long edge and its patch count are inside the limits. A patch is a
square of `PATCH_PX = 28` px.

```text
scale          = min(1, maxLongEdgePx / widthPx)
outWidth       = round(widthPx × scale)
patchColumns   = ceil(outWidth / 28)
tileHeightOut  = min(maxLongEdgePx, floor(maxPatches / patchColumns) × 28)
tileHeightSrc  = floor(tileHeightOut / scale)
```

| Tier | `maxLongEdgePx` | `maxPatches` |
|---|---|---|
| High resolution | 2,576 | 4,784 |
| Standard | 1,568 | 1,568 |

Examples for the high resolution tier:

| `widthPx` | `outWidth` | `tileHeightOut` | Patches |
|---|---|---|---|
| 1,200 | 1,200 | 2,576 | 43 × 92 = 3,956 |
| 1,500 | 1,500 | 2,464 | 54 × 88 = 4,752 |
| 1,920 | 1,920 | 1,932 | 69 × 69 = 4,761 |
| 2,400 | 2,400 | 1,540 | 86 × 55 = 4,730 |
| 3,000 | 2,576 (`scale` 0.8587) | 1,456 | 92 × 52 = 4,784 |

For a width of 3,000 px, `tileHeightSrc = floor(1,456 / 0.8587) = 1,695` rows.

### 6.3 Tile plan

`planTiles` cuts the full image from top to bottom. Two tiles share `TILE_OVERLAP_PX = 56`
rows in output px. This is two patches.

```text
overlapSrc = round(56 / scale)
step       = tileHeightSrc − overlapSrc
srcY(k)    = k × step
```

The last tile ends at `heightPx`. It is shorter. An image that fits in one tile gives one tile.
Every source row is in at least one tile.

Example: the image is 1,200 × 12,000 px, high resolution tier. `scale` is 1, `tileHeightSrc` is
2,576, and `step` is 2,520.

| Tile | `srcY` | Rows |
|---|---|---|
| 1 | 0 | 2,576 |
| 2 | 2,520 | 2,576 |
| 3 | 5,040 | 2,576 |
| 4 | 7,560 | 2,576 |
| 5 | 10,080 | 1,920 |

Example: the image is 3,000 × 6,000 px, high resolution tier. `scale` is 0.8587, `overlapSrc` is 65,
and `step` is 1,630. The tiles start at 0, 1,630, 3,260 and 4,890. Spool draws the source rows
of a tile 1:1 on an `OffscreenCanvas`. It then scales the finished rows one time to `outWidth` ×
`outHeight` with high quality smoothing. This gives no seam at the border of two pieces.

### 6.4 Full image and thumbnail

The offscreen document builds all outputs when the user clicks **Copy & save**. The capture page and the
Insert card do not build anything.

1. The renderer builds the tiles one by one. It decodes at most 2 slices at the same time.
2. It builds the thumbnail: the top of the image, at most 320 × 480 px, never scaled up.
3. It builds the full image as a PNG. It does not make one canvas of the full height. If the full
   image fails, the tiles stay usable, and the summary has a warning.
4. A capture with one tile that Spool does not scale gives one image. The tile and the full image
   are then the same `Blob`.

Steps of the full image:

1. Split the image into groups of at most 512 rows.
2. For each group, paint the pieces on a white canvas. Read the pixels.
3. Give the rows to the PNG encoder.

The encoder writes an 8-bit RGB PNG. It drops the alpha channel. For each row, it picks the
filter (None, Sub, Up or Paeth) with the smallest sum of absolute values. It compresses the rows
with `CompressionStream('deflate')`. The encoder does not keep a buffer of the full image.

## 7. Post-capture flow

This section describes what happens after **Copy & save**. [contracts.md](contracts.md) section 7
has the exact messages. [browser-behavior.md](browser-behavior.md) has the browser facts behind
each decision.

### 7.1 Copy & save and the clipboard

1. The user presses `Enter` or clicks **Copy & save**. Both are trusted events. With the setting
   `copyOnDone` off, the button is called **Save** and the agent skips the clipboard steps.
2. In the same task, with no `await` before it, the agent calls `navigator.clipboard.write` with a
   `ClipboardItem` that holds a promise of the PNG. The promise waits for `page/finish`, then
   sends `page/get-clipboard` and decodes the full image. The browser accepts the write at once,
   because the user gesture is still active, and the bytes can arrive a few seconds later.
3. The service worker sends `offscreen/finalize`. The offscreen document builds the outputs and
   saves the files (sections 7.2 and 7.3). The worker replies with a `FinishSummary`.
4. The agent restores the page, removes the overlay and shows the toast (section 7.5). The toast
   says "Copying…" while the write runs.
5. When the page write fails or the API is missing, the agent sends `page/clipboard-fallback`. The
   service worker writes the full image with `navigator.clipboard` in the worker. This needs the
   permission `clipboardWrite`, and it works with no focus and no gesture. The reply `{ copied }`
   is the final state.

The clipboard rule: the clipboard always gets the full image, which is the right image for people.
For a short capture the full image is also the one AI screenshot. A long capture has more tiles,
and the clipboard holds one image at a time, so an AI gets the tiles through the Insert card, the
chips on the toast, or the saved files.

Two limits stop a copy:

- A full image over 40 MiB (`MAX_TRANSFER_BYTES`) cannot travel in a runtime message. Chrome stops a
  message at 64 MiB, and base64 adds a third. The copy fails with "This image is too large to copy.
  Use the AI screenshots." The same limit applies to every `pngBase64`.
- A full image whose decoded size (`width × height × 4`) passes 256 MiB
  (`MAX_CLIPBOARD_BITMAP_BYTES`) is not written at all. The browser decodes it in the renderer of
  the page that writes it, and a tab crashed from 70,000 px high at 1,500 px wide in a test. The
  toast says "Too tall to copy. Saved instead." The files, the tiles and the Insert card are
  unchanged.

### 7.2 Finalize

`offscreen/finalize` runs in the offscreen document. One finalize runs at a time.

1. Check that the session exists and belongs to the tab. A second **Copy & save** for the same
   session returns the summary again and builds nothing.
2. Finish the session. Frames in progress end first.
3. Plan the assembly and the tiles. Build the tiles, the thumbnail and the full image
   (section 6.4).
4. Free the slices. Keep the outputs as the last capture. The old last capture goes first.
5. Save the files (section 7.3).
6. Reply with the `FinishSummary`: the title, the host name of the page, the size, the tile count,
   the thumbnail, the save result and the warnings.

If step 3 fails, the reply is `E_INTERNAL`: "Could not build the images. Try again." The session
stays finished for 15 minutes, so the user can try again. A save failure never fails the finalize.
It sets `save.error`.

### 7.3 Saving

The save step uses the first place that works:

1. The folder that the user chose. The offscreen document reads the folder handle and the sub path
   from IndexedDB, and checks the permission with `queryPermission`. When the state is `granted`,
   it makes each folder of the sub path that is missing and writes the files there. It never asks
   for the permission: only a click on an extension page can ask.
2. `chrome.downloads`, through the service worker. The offscreen document makes `blob:` URLs and
   sends them with `sw/download`. The worker starts each file with `conflictAction: 'uniquify'` and
   `saveAs: false`. The path is relative to Downloads and starts with the folder name from the
   settings (`Spool` by default). No file bytes travel in a message.

If the folder is chosen but the permission is missing, or the folder is gone, the files go to
Downloads and `save.needsPermission` is `true`. The toast then asks "Reconnect <place>?". If a write
to the granted folder fails for another reason, the files go to Downloads and the summary has a
warning.

**Why the default is a sub folder of Pictures.** The browser never lets an extension write outside
Downloads without one user pick. So the pick is the first-run step. **Save to Pictures ›
Screenshots** opens the picker in Pictures, makes `Screenshots` inside the picked folder, and stores
the picked handle with the sub path `['Screenshots']`. One grant then covers the whole Pictures
tree, the label is honest, and a deleted `Screenshots` is made again at the next save. Spool writes
only inside the sub path. A pick that is already named `Screenshots` is used as it is.

Layout, with `base = Spool <YYYY-MM-DD HH.mm.ss> <title>`. The time is the start of the capture, and
the title is cleaned and cut to 48 characters:

| Capture | Files |
|---|---|
| More than one tile, or one scaled tile | `<base>.png` (the full image) and `Spool for AI/<base>/screenshot-NN-of-MM.png` |
| One tile that is the image 1:1 | `<base>.png`: the full image, or the tile when only tiles are on. Never both. |
| Both save settings off | No file. |

A name that exists is not replaced. The folder writer adds ` (2)`, ` (3)` to `<base>`, and the
downloads API does the same with `uniquify`. If Chrome refuses the first download (for example
"Invalid filename"), Spool tries the whole set once more with a `base` without the title. The file
name cleaner is idempotent, because the download check compares a name with its own cleaned form.

Why blob URLs: the offscreen document can make them and the service worker can use them. A data
URL needs the bytes in a message and a copy in the worker.

### 7.4 First run, the save question and reconnecting

- **Welcome tab.** `runtime.onInstalled` with the reason `install` opens `options.html#welcome`. An
  update, a reload or a browser update opens nothing. The tab offers **Save to Pictures ›
  Screenshots**, **Choose another folder** and **Keep using Downloads**. It also shows what each
  capture leaves on disk, the three keys, and a notice that every capture is saved and copied.
- **Save question.** A capture that goes to Downloads because no folder is chosen gets
  `save.askFolder` on the first three such captures. The toast then asks "Save to Pictures ›
  Screenshots?" with **Set up** and **Not now**. The count is `saveFolderAsks` in
  `chrome.storage.local`. A question that was spent when it was handed out is lost if the user
  closes the tab at once, which is why Spool asks three times. **Keep using Downloads** and **Use
  Downloads instead** end the question.
- **Reconnect.** When the folder needs permission, the toast asks "Reconnect <place>?". **Reconnect**
  opens `options.html#reconnect`, where one click calls `requestPermission`. After the third use,
  the card says that the browser keeps forgetting and offers Downloads (`saveReconnects`).
- **Teaching toast.** For the first three captures with more than one tile, the toast stays until
  the user closes it, because a toast that hides after 6 seconds teaches nothing to a person who
  looks at the page (`longToastsShown`).

### 7.5 The toast

The toast is a card in a closed shadow root. It follows the same rules as the overlay:
constructable styles, trusted events only, and the top layer.

- A short capture shows the thumbnail, the title, the size and the save place, with **Open** and a
  reminder to paste with Ctrl+V (Cmd+V).
- A long capture shows "Copied. Press Ctrl+V for the full image.", the number of AI screenshots,
  the instruction to press the Insert last capture shortcut in the chat tab, a line for desktop
  apps that names the `Spool for AI` folder, and one chip per tile. A trusted click on a chip
  copies that tile with `clipboard.write` and a promise of `page/get-tile`.
- **Show in folder** shows for a save in Downloads, because the browser cannot reveal a folder that
  the user picked. It reveals the file whose download ID the service worker kept in
  `chrome.storage.session` when it saved. It does not search by folder name, because an unrelated
  folder can have the same name.
- The toast never takes focus. A countdown of 6 seconds starts when the copy ends. Hover and focus
  hold it. `Esc` closes it, and the page does not get the key.

### 7.6 Insert last capture

The card puts all tiles of the last capture into a chat field in one step. Chromium cannot drag more
than one file to another tab, so Spool has no "drag all".

1. The user presses the shortcut in the chat tab. The service worker checks that no agent is
   active in the tab.
2. The worker makes a token with `crypto.randomUUID()`, registers it with the offscreen document
   for this tab and for the last capture, and injects the page scripts with `config.mode = 'shelf'`.
3. The card finds the paste target, asks `page/shelf-info` and shows the last capture, its source
   host and the host it will go into.
4. After a trusted click, with the guard open (the card has been visible and still for 400 ms and
   nothing covers it), **Insert N screenshots** reads at most 20 tiles with `page/shelf-get`, three
   at a time. It makes `File` objects (`screenshot-01-of-05.png`) in a `DataTransfer` and sends a
   synthetic `paste` event at the paste target.
5. When the page cancels the event (`defaultPrevented`), the card says "Inserted". Otherwise it
   walks the user through copying one screenshot at a time. The event is not trusted, so a page can
   refuse it.
6. Chips and **Copy full image** use a trusted click and `clipboard.write`. This is the fallback
   that works on every site.

Token rules: a token belongs to one tab and to one capture, and ends after 10 minutes, when its tab
closes, when the offscreen document closes, or when a new token for the same tab replaces it. A page
load in the tab does not end it. At most 8 tokens live
at once. A token of another tab gets `E_FORBIDDEN_SENDER`.

The card works in browser tabs only. Spool cannot inject into a desktop app.

### 7.7 The capture page

The capture page opens only when the user clicks **Open** on the toast. It reads the outputs of the
last capture from the offscreen document. **For AI** shows the tiles, **Save all**, and **Copy** and
**Save** on each tile. **For people** shows the full image with **Copy image** and **Save**. It
saves to `Downloads/<folder name>/` with the same layout. Opening the page does not drop the last
capture.

### 7.8 Lifetime of the last capture

The offscreen document keeps one last capture. It ends when:

- the next capture finishes (`offscreen/finalize` drops it first),
- 60 minutes pass (`LAST_CAPTURE_TTL_MS`), or
- a new frame needs the memory. The bytes of the last capture count in the 1 GiB limit, and the
  store drops the capture before it refuses a frame.

While the last capture exists, the service worker does not close the offscreen document. The
outputs are `Blob` objects that the browser owns, like the slices.

## 8. Memory model

| Where | What is in memory | Bound |
|---|---|---|
| Service worker | One frame as a data URL, while it passes it on. | One frame. |
| Offscreen document | The PNG slices and their signatures. One decoded frame while it crops. At most 2 decoded slices and one canvas while it builds the outputs. The last capture (tiles, full image, thumbnail). | 512 MiB of stored PNG data for each session (`SESSION_MAX_BYTES`). 1 GiB for all sessions and the last capture (`TOTAL_MAX_BYTES`). |
| Page scripts | The base64 text of one image while it decodes it. The thumbnail in the toast. The tiles that the Insert card reads, while it inserts them. | The thumbnail, and the tiles of one insert (at most the last capture). |
| Capture page | The tiles and the full image of the last capture, as `Blob` objects. | The size of the last capture. |

Rules:

- Slices stay PNG-compressed. This keeps the memory low for a long capture.
- The offscreen document closes each decoded frame and canvas as soon as it does not need them.
- The offscreen document keeps at most 2 decoded slices (`MAX_DECODED_SLICES`). A cache closes the
  least recently used one before it decodes the next.
- The renderer builds one tile, encodes it, and then lets it go.
- Nothing goes to `chrome.storage`, IndexedDB or Cache Storage. IndexedDB holds the folder handle
  only. The saved files are the one place where image data leaves memory, and only when the
  user clicks **Copy & save** or **Save**.
- The browser owns `Blob` storage. It can move `Blob` data to a temporary file under memory
  pressure. The extension cannot prevent this. See [threat-model.md](threat-model.md).

Lifetime of a session:

| Event | What happens |
|---|---|
| The user clicks **Cancel** | The agent sends `page/cancel`. The store drops the session. |
| The user clicks **Copy & save** before the first frame is stored | Nothing is saved. The agent says "Nothing was captured yet. Scroll once, or Cancel." and the session stays open. |
| The user presses Cancel or Esc while **Copy & save** saves | Nothing happens: the button is off. The save ends, and the toast shows the result. The wait ends by itself after 3 minutes (`FINISH_TIMEOUT_MS`) and the session is ready again. |
| The page unloads (`pagehide`) | The agent sends `page/cancel` on a best-effort basis. It does not send it while it finishes. |
| The tab closes | The service worker sends `offscreen/drop-tab`. It drops the unfinished sessions of the tab and ends the Insert tokens of the tab. |
| An unfinished session gets no open and no frame for 30 minutes (`SESSION_IDLE_MS`) | The store drops the session. This frees the memory of a capture that the user left without **Copy & save** or **Cancel**. |
| The user clicks **Copy & save** | The offscreen document finalizes. It frees the slices when the outputs exist. |
| The finalize failed | A timer of 15 minutes (`SESSION_TTL_MS`) keeps the session. **Copy & save** can try again. Then the store drops it. |
| The store has no session left, and no last capture exists | The offscreen document sends `sw/offscreen-idle`. The service worker pings it. It closes the document if it has 0 sessions and no last capture. |

The message `page/cancel` does nothing when the offscreen document or the session does not exist.
It never creates the offscreen document. A repeat is safe.

## 9. Failure handling and state restore

### 9.1 Failures

| Failure | Found by | What the user sees |
|---|---|---|
| Restricted page or injection error | Service worker | A `!` badge for 4 seconds. The button title tells the reason. |
| Capture quota error | Capture queue | A retry after 600 ms, at most 3 times. Then "The browser is limiting screenshots. Wait a moment and try again." |
| The tab is not the active tab, or the user switched tabs during the capture | Service worker (`E_TAB_NOT_VISIBLE`) | Auto pauses. "Go back to this tab to continue." |
| The tab access ended | Service worker | "Spool lost access to this tab. Start a new capture." |
| The page zoom changed | Offscreen document | "Page zoom changed. Finish now to keep what you have." |
| The page moved too far | Offscreen document | "The page moved too far. Finish now to keep what you have." |
| The window size changed | Agent | The agent sends no frame. "The window size changed. Cancel and select the area again." |
| The selected area is not inside the page | Agent | "Select an area inside the page." The selection starts again. |
| The service worker refuses the session | Service worker | The message of the error. The selection starts again. |
| Too much image data | Offscreen document (`E_SESSION_TOO_LARGE`) | "This capture is too large. Finish now to keep what you have." |
| A seam that Spool cannot verify | Offscreen document | A warning on the capture page. |
| The session does not exist | Service worker or offscreen document (`E_SESSION_NOT_FOUND`) | "This capture has ended. Start a new capture." |
| The images cannot be built | Offscreen document (`E_INTERNAL`) | "Could not build the images. Try again." **Copy & save** and **Cancel** stay available. |
| The clipboard write fails | Page agent and service worker | The toast says "Saved, not copied" or "Not copied", with the reason. **Open** gives another way. |
| The image is over 40 MiB | Service worker (`E_SESSION_TOO_LARGE`) | "This image is too large to copy. Use the AI screenshots." |
| The save folder has no access | Offscreen document | The files go to Downloads. The toast asks "Reconnect <place>?" and offers **Reconnect**. |
| The save fails | Offscreen document | The summary has `save.error`. The toast says "Could not save the files." |
| The Insert token ended | Offscreen document | "This capture has expired here. Press Alt+Shift+V again." |
| The Insert card has no capture | Offscreen document | "Nothing to insert yet. Press Alt+Shift+S to spool a page." |
| The capture page link is old, or the capture is gone | Capture page | "This capture is no longer in memory. Start a new capture." |
| The full image cannot be built | Offscreen document | "The full image could not be built. You can still use the AI screenshots." |

A failed step does not end the session. **Copy & save** and **Cancel** stay available. The user can keep
the frames that exist. If the service worker refuses **Copy & save**, the session stays open and the
control bar shows the message.

### 9.2 State restore

The page agent changes the page. It scrolls the target, changes the style of sticky and fixed
elements, and shows an overlay. It restores all of this when the session closes. A session closes
in these cases:

- The user clicks **Copy & save** and the service worker accepts it.
- The user clicks **Cancel** (not while Done saves). The agent then sends `page/cancel`.
- The page fires a trusted `pagehide`. The agent sends `page/cancel` on a best-effort basis. It
  does not send it while it finishes. The agent ignores a fake `pagehide` from a page script.
- The extension reloads or updates. A watchdog (every second) finds that the extension context
  is not valid. It closes the session and removes the toast and the Insert card.

The restore steps run in this order:

1. Set the scroll position of the target to the original value.
2. Restore all inline styles with the style jar, in reverse order. The jar stores the old value
   and the old priority of each change once.
3. Remove the overlay and its listeners.

Each step runs on its own. If one step fails, the next step still runs. The close function can run
more than once without a second effect.

### 9.3 Service worker restart

The service worker holds no session state. Every message has the session ID. The service worker
derives the tab from the sender. The offscreen document holds the data. After a restart, the next
message continues the session.

The service worker registers all its listeners at the top level of its script. Chrome wakes the
worker only for listeners that exist when the script first runs. The listeners are
`action.onClicked`, `commands.onCommand`, `runtime.onMessage`, `runtime.onInstalled` and
`tabs.onRemoved`. The handler of `tabs.onRemoved` does nothing when no offscreen document exists,
and it never creates one. There is no listener for a page load: Chrome has no filter for
`tabs.onUpdated`, so it would wake the worker on every load in every tab. A page that unloads makes
the agent send `page/cancel`, and the idle timer of the session store drops a session whose page
died without it.

The listener `tabs.onActivated` is not at the top level. A capture registers it for the time of
one frame. A listener at the top level would wake the worker at each tab switch.

The worker creates, closes and checks the offscreen document one action at a time. It uses a lock
in its memory. `ensureAndSend` creates the document and sends the first message of a session under
one lock. The idle check (`closeIfIdle`) pings the document and closes it only when it holds 0
sessions and no last capture. The idle check cannot run between the creation of the document and
the first message. After a restart, the lock is gone. The call `chrome.runtime.getContexts()` then
tells whether the document exists.

If the offscreen document does not exist, the session is gone. The agent shows the message "This capture has ended. Start a new capture." The page stays as it is
until the user clicks **Cancel**. Spool then restores the page.

## 10. Build, CI and release

There is no build step for the extension. These parts support it:

- `npm run check` runs the policy check, the type check and the unit tests.
- `npm run package` builds `dist/spool-<version>.zip` and its `.sha256` file. The zip is
  reproducible: the entries are sorted, the time stamp is fixed, and the same input gives the same
  bytes. The zip holds `manifest.json`, `LICENSE`, `NOTICE.md`, `icons/*.png` and `src/` (without
  `.d.ts` files). It fails when `src/` has a file type that the policy check does not scan.
- CI (`.github/workflows/ci.yml`) has three kinds of job:
  - `verify` checks the lock file, builds the zip twice and compares the two, installs the tools
    with `npm ci --ignore-scripts`, checks the npm signatures, and runs `npm run check`.
  - `e2e` is a matrix with one job for each Playwright project: `scale-1`, `scale-1.25`,
    `scale-1.5`, `scale-2` and `perf`.
  - `gate`, named **CI result**, passes only when every job passed. It is the one check that a
    ruleset requires.
- The platform workflow (`.github/workflows/platforms.yml`) runs the unit tests and the package
  build on macOS and Windows. It is not a required check. It does not run the end-to-end tests,
  because those compare pixels against Chromium on the Linux runner and would add flaky failures.
- The release workflow (`.github/workflows/release.yml`) runs for a tag `v<version>`. See
  [guides/releasing.md](guides/releasing.md).

[development.md](development.md) has the steps for each task.

## 11. Tests

### 11.1 Unit tests

The unit tests use `node:test`. They are in `test/unit/` and run in Node. A fake of the `chrome.*`
APIs (`test/helpers/fake-chrome.js`) replaces the browser for the service worker code. A loader
(`test/helpers/load-classic.js`) runs the classic page scripts in a `node:vm` context with fake DOM
globals. Fake image operations replace the browser in the tests of the offscreen store and of the
finalize step.

### 11.2 End-to-end tests

The end-to-end tests use Playwright. They run a real Chromium with the extension. The tests are in
`e2e/` and the configuration is in `playwright.config.js`.

The test copy of the extension:

- The global setup (`e2e/global-setup.mjs`) builds the copy once for each run, in a temporary
  folder. The files of the real extension do not change. The copy has another name ("Spool TEST
  BUILD — do not install"), another icon tint and the badge "TEST".
- The copy adds `"host_permissions": ["<all_urls>"]` to its manifest. A test starts a capture from
  the service worker without a user gesture, so there is no `activeTab` grant. The host permission
  gives the test the same access. The real manifest has no host permission, and a test checks it.
- The copy moves `src/sw/service-worker.js` to `src/sw/service-worker.original.js`. A generated
  file with the old name loads a hook, then the original worker. The hook records the messages
  that the worker receives and sends: the type, the result, the error code and a few numbers. It
  records no image data. It publishes `globalThis.__spoolTest` with `startCapture`, `events`,
  `counts` and `fireInstalled`. The hook holds back the `runtime.onInstalled` listeners, because
  every test profile is a new install and the Welcome tab would change what the tests count.
- The copy adds a debug hook to its own capture page. The production page has no such hook.
- The worker URL stays the same, because the manifest still points to `src/sw/service-worker.js`.
  The sender check recognizes the worker by this URL. Another entry file would make the offscreen
  document reject every message of the worker with `E_FORBIDDEN_SENDER`.

The browser:

- Each test starts its own Chromium profile in a temporary folder, with the extension loaded. The
  mode is the new headless mode, which supports extensions.
- Locally, one worker runs the tests. In CI, `SPOOL_E2E_WORKERS` sets the number of browsers in a
  job (the repository variable `E2E_WORKERS`, default 3).
- The device scale is real. Playwright's `deviceScaleFactor` option only emulates the value of
  `devicePixelRatio`, and `captureVisibleTab` then still returns an image at scale 1. The tests
  start the browser with `--force-device-scale-factor` and with `viewport: null`. They resize the
  window through the DevTools protocol until the viewport is about 1000 × 800 CSS px. At a
  fractional scale, the window size is rounded to device pixels, so the viewport can differ by up
  to 3 px.
- The project `scale-1` runs all specs except the performance test. The projects `scale-1.25`,
  `scale-1.5` and `scale-2` run the specs that have the tag `@core`. The project `perf` runs the
  performance test.

What the tests check:

- The test pages (`e2e/fixtures/`) draw horizontal bands of 8 CSS px. The color of a band encodes
  its number. The tests read the full image and the tiles. The band numbers must rise by exactly 1
  from band to band, with no gap, no duplicate and no other content between bands.
- The specs cover: a long document, a page with `scroll-behavior: smooth`, an inner panel, an inner
  panel with sticky dividers and a fixed composer and fade, a list that grows at the bottom, a
  capture that moves up, a cancel that restores the page, a restricted page, fake keyboard and
  pointer events, a page whose markup shadows Spool's names, an overlay above a modal dialog or a
  popover, a stray scroll, a scrollbar, **Copy & save** with the clipboard and the toast, the
  save folder and the Welcome tab, the Settings page, the Insert card against several kinds of
  composer, and a performance budget for a long capture.

[development.md](development.md) shows how to run them.

### 11.3 Test quality

The library tests were checked with mutation testing, which raised their score from 80.4% to 95.6%.
The service worker, the offscreen document and the page scripts have no mutation score yet.
