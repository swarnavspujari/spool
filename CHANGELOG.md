# Changelog

All notable changes to Spool are listed here. The format follows
[Keep a Changelog 1.1.0](https://keepachangelog.com/en/1.1.0/). The project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.1.0] - 2026-11-07

First public release. It builds on 1.0.0, which was never published.

### What is new for you

- **Spool asks where to save, once, and remembers.** A Welcome tab opens when you install Spool.
  One click on **Save to Pictures › Screenshots** sets the default folder. In 1.0.0 everything
  went to Downloads unless you found the folder setting.
- **Mac and Linux keys.** On a Mac the shortcuts are Control+Shift+S (start) and Control+Shift+V
  (Insert last capture), and Spool shows them as Mac key symbols. Windows and Linux keep
  Alt+Shift+S and Alt+Shift+V. Mac and Linux have not been tested on real hardware yet.
- **Paste works the way the toast says.** After a long capture the toast tells you to press Ctrl+V
  (Cmd+V on a Mac) for the full image, and the first three long toasts stay until you close them.
  Ctrl+Shift+V pastes text only, so an image pastes nothing. The Welcome tab says so, and Spool does
  not bind that key.
- **Insert last capture is safer and clearer.** The card names where the pixels came from and where
  they will go. It ignores a click until it has been visible and still for 400 ms, and while
  something covers it. It inserts at most 20 AI screenshots at a time and offers the rest next.
  When a chat refuses the paste, it walks you through copying one screenshot at a time.
- **Plainer words.** The finish button says **Copy & save** (or **Save** when copying is off). The
  cut-up images are **AI screenshots**. The settings page is **Settings**, and the page behind the
  toast's **Open** button is the capture page.
- **New file layout.** The full image is `Spool <date time> <title>.png`. The AI screenshots are in
  `Spool for AI/<same name>/screenshot-NN-of-MM.png`. In 1.0.0 the folder was `Spool tiles`, with
  `tile-NN-of-MM.png` files.
- **Reconnect in one click.** When the browser forgets the folder permission, files go to
  Downloads, the toast says so, and **Reconnect** restores the folder. After the third time, Spool
  suggests **Allow on every visit** or the Downloads folder.
- **No more crashed tabs on very tall captures.** Spool does not put a full image on the clipboard
  when the browser would need more than 256 MiB to decode it (about 44,800 px high at 1,500 px
  wide). The files still save, and the toast says so.

### Added

- Welcome tab on install (`options.html#welcome`), with the choices **Save to Pictures ›
  Screenshots**, **Choose another folder** and **Keep using Downloads**, and the notice "What Spool
  keeps".
- Default save folder `Pictures/Screenshots`. The browser grants the picked Pictures folder and
  Spool writes only inside `Screenshots`. Spool makes `Screenshots` again if you delete it.
- A save question on the toast, "Save to Pictures › Screenshots?", for the first three captures
  that go to Downloads because no folder is chosen. A **Change** link stays on every toast that
  saved to Downloads.
- Mac keys (`MacCtrl+Shift+S` and `MacCtrl+Shift+V`) and key labels that follow the system.
- Batches of 20 in Insert last capture, with the source host and the destination host on the card.
- A Chrome Web Store upload job in the release workflow. It is off until the repository variable
  `CWS_ENABLED` is `true`, and it has not run against the live store yet.
- Build attestations for the release zip, and immutable releases.
- Guides for install, update, troubleshooting, using Spool, releasing and publishing to the store,
  plus a privacy policy, a threat model and a store listing draft.

### Changed

- A release has two files: the zip and its `.sha256` file. The Windows install script is gone,
  because the store and the zip cover every system.
- The permissions, the Content Security Policy and the manifest keys are the same as in 1.0.0.
- The overlay readout reads "N steps · N px · N AI screenshots", and warnings say "seam" and
  "step".
- Error messages no longer name a button. They say "Finish now to keep what you have."
- CI runs the end-to-end tests in one job for each device scale plus a performance job, and a smoke
  job on macOS and Windows.
- The Welcome tab, Settings and the guides say that the browser may forget the folder permission when
  you close the tab where you picked the folder, and after a restart. The first capture after that can
  land in Downloads, and one click on **Reconnect** with **Allow on every visit** fixes it.
- Spool retries the browser's "image readback failed" capture error twice, after a short wait,
  before it shows a failure. Each retry keeps the rate limit and checks again that you are still on the
  tab.

### Fixed

- A page title with several dots or shell-folder extensions no longer makes a save fail. The file
  name cleaner now gives the same result when you apply it twice.
- Insert last capture fetches at most three screenshots at a time and never more than one batch.
- A click on the Insert card while a page element covers it does nothing, instead of inserting.
- Cancel and Esc no longer close the bar while **Copy & save** is saving and the files still save.
  They do nothing then, and the toast reports the result. A save that takes more than three minutes
  stops waiting and gives you the bar back with a message.
- **Show in folder** reveals the file that Spool saved, and no longer a file in another folder with the
  same name.

### Security

- The Welcome tab states that every capture is saved as files and copied to the clipboard, and
  links to the Settings that turn each off.
- The click-through guard on the Insert card, the batch cap and the file name fix above close the
  security findings found before this release.
- No new permission: `activeTab`, `clipboardWrite`, `downloads`, `offscreen`, `scripting` and
  `storage`.

## [1.0.0] - 2026-11-06

First version. It was never published.

### Added

Capture:

- Capture of a scrolling area in Chrome, Brave and Perplexity Comet (tested on Windows).
- Area selection. Drag a box, or click a panel to select all of it. The panel under the pointer
  gets an outline.
- Detection of the element that scrolls under the selected area. This includes inner panels of
  chat apps, mail apps and web apps.
- Step-by-step capture with the buttons **↓ Scroll**, **↑ Up**, **Auto**, **Done** and **Cancel**.
- Keyboard keys for the capture: `Space` or `↓`, `↑` or `Shift+Space`, `A`, `Enter` and `Esc`.
- Keyboard shortcut `Alt+Shift+S` and a toolbar icon to start a capture.
- Capture at the real pixel density of the screen.
- Option to hide sticky and fixed elements during the capture. A sticky element shows once, at its
  natural place. A fixed element is hidden. Spool restores both when the capture ends.
- Seam check between steps. It corrects small shifts and warns about joins that it cannot check.
- Scroll up, to add content above the first step. Auto scrolls down only.
- Stop rules for Auto: end of the content, maximum length, no new content (three duplicate frames
  in a row), a failed step, and a hidden tab.
- A frame that failed is captured again at the next step, so a failed step leaves no gap.
- Refusal of restricted pages. The toolbar icon shows `!` for 4 seconds.
- Restore of the page after a capture. This covers the scroll position, the inline styles and the
  overlay.
- Rate limit for captures, to keep inside the browser limit of 2 captures each second.
- A scroll that the user makes during a capture (a wheel notch that reaches the page) does not
  break the next steps: before each step the page goes back to the place of the last frame.
- The toolbar button shows an amber dot on the tab while a capture is open.
- The toast and the shelf name the real shortcut keys (read with `chrome.commands.getAll`).
- The first capture that goes to Downloads with no folder chosen asks once "Save to a folder?".
- The setting "Copy the full image when you press Done".

Output:

- Full-height image, saved as one PNG file.
- Tiles for AI vision models, in two tiers. The high resolution tier has a long edge of at most
  2,576 px and at most 4,784 patches. The standard tier has 1,568 px and 1,568 patches.
- Overlap of 56 px between neighbouring tiles.
- **Done** builds the tiles, a thumbnail and the full image in one step. No result tab opens by
  default.
- Smart clipboard. **Done** copies the full image to the clipboard in the gesture of the key press
  or click. When the page blocks the write, the service worker writes it (permission
  `clipboardWrite`). An image over 40 MiB is not copied, and the toast says so.
- Toast after **Done**. It shows the thumbnail, the size and the save location. A long capture
  shows "Full image copied", the hint for the shelf, and one chip for each tile. A chip copies one
  tile. The button **Open** opens the result page.
- Shelf. The command `Alt+Shift+V` opens the shelf in any tab. **Insert N tiles** pastes all tiles
  of the last capture into the field that had the focus. Chips copy one tile. **Copy full image**
  copies the full image.
- Save folder. In the settings, the user chooses a folder, for example `Pictures\Screenshots`.
  **Done** writes the files there. The browser asks for access. When the access is missing, Spool
  saves to `Downloads\Spool`, and the toast offers a way to allow the folder again. The settings
  page explains the browser choice "Allow on every visit".
- File layout: the full image is one flat file, `Spool <date time> <title>.png`. The tiles are in
  `Spool tiles\<same name>\tile-NN-of-MM.png`. A capture with one tile gives one flat file. A name
  that exists gets a number, and Spool never replaces a file.
- Warnings on the result page. A warning shows when a capture has more than 20 tiles, or when the
  full image is too large for most chat apps.
- The last capture stays in memory for at most 60 minutes, until the next capture finishes, or
  until a new frame needs the memory.

Pages:

- Result page with the views **For AI** and **For people**, copy buttons, save buttons, warnings
  and **Show in folder**. It opens next to the page when the user clicks **Open**.
- Options page with these settings:
  - Overlap between steps
  - Wait after each scroll
  - Maximum length (1,000 to 100,000 px)
  - Hide sticky and fixed bars
  - AI tile size
  - Save AI tiles
  - Save full image
  - Downloads folder name
  - Save folder (choose a folder, allow access, use Downloads instead)
- Display of the keyboard shortcut on the options page, with a button that opens the shortcuts
  page.
- A shared look for the extension pages and the page cards: quiet and native, light and dark,
  reduced motion and high contrast.

Quality and release:

- Policy check (`npm run policy`) for the manifest permissions, the CSP and the code rules.
- Unit tests, end-to-end tests, and a type check with JSDoc types. The end-to-end tests load a test
  copy of the extension in Chromium. They run at the device scales 1, 1.25, 1.5 and 2, and check
  the images against bands of known colors.
- Mutation testing of the libraries. The score of the library tests rose from 80.4% to 95.6%.
- Release package (`npm run package`) with a SHA-256 checksum file.
- GitHub workflows. CI has a plan job, a check job, a supply-chain job, an end-to-end matrix with
  one job for each device scale, a package job and one gate job, **CI result**. A tag with the name
  `v<version>` starts the release workflow, which publishes the zip and the checksum file.
- Documents: README, security notes, architecture, interface contracts, contributing rules and a
  maintenance guide.

### Security

- No host permission. The permission `clipboardWrite` is for the clipboard fallback only. Spool
  never reads the clipboard, and the policy check forbids it.
- Spool does not run in private windows (`"incognito": "not_allowed"`).
- The CSP of the extension pages requires Trusted Types and allows no policy.
- The overlay, the toast and the shelf act only on trusted events (real keys and clicks). A script
  on the page cannot press **Done** or **Cancel**, select an area or scroll the capture with a fake
  event.
- The page scripts read names that page markup can shadow (DOM clobbering) through the prototypes.
  The namespace is an own property.
- The overlay host has no attribute that shows its state. The page cannot see the moment of a
  capture in the host element.
- The service worker closes the tab-switch race. A temporary `tabs.onActivated` listener fails a
  capture when the user switches tabs during it. A frame of another tab never reaches the store.
- The page agent gets only the numbers that it uses from the service worker. The pixel-derived
  values stay in the worker.
- The page gets image bytes only after **Done**: the full image for the clipboard, the thumbnail,
  and the tiles. The service worker checks each request against the tab of the capture.
- Shelf tokens. The service worker makes a random token for each `Alt+Shift+V`. It works for one
  tab, for the last capture only, and ends after 10 minutes.
- Limits on size: 512 MiB for one capture, 1 GiB for all captures with the last one, 300,000 px
  for the image height, and 40 MiB for a message. A frame that would pass a limit is refused.
- An unfinished capture is dropped after 30 minutes without a frame (`SESSION_IDLE_MS`). A closed
  tab or a new page load drops the unfinished captures of that tab.
- The service worker creates the offscreen document and sends the first message of a session in
  one locked step. The idle check cannot close the document in between.
- The service worker accepts a download only for a `blob:` URL of its own extension and a clean
  relative path.
- The release workflow has two jobs. The job that runs the development tools has no write access.
  The job that publishes has no checkout and runs no npm command. The tag must match the manifest
  version and must be on `main`.
- All actions in the workflows are pinned by commit hash. Each job has the least permission.
- The end-to-end test copy has another name, another icon and a temporary folder, so that nobody
  loads it by mistake.

### Fixed

These changes improve the correctness of the capture.

- Keyboard selection. `Tab` and `Shift+Tab` move between scroll panels and `Enter` selects one. A
  screen reader announces each panel.
- The Stop button works during Auto. An invisible layer takes clicks while a frame is captured.
- A stray scroll during a capture no longer stops it. Spool returns to the last captured position
  before the next step.
- Stricter seam check. A join is valid only when the mean difference is at most 3 and no single row
  of the overlap has a mean difference above 24 (`maxRowDiff`). A mostly blank overlap with a few
  different rows no longer passes. Spool now reports more joins that it cannot confirm.
- Crop rounding that keeps only inner pixels. The crop holds only the device pixels that the area
  covers. It no longer adds a row or a column when the size has a fraction of .5 or more.
- Sticky and fixed elements. From the first frame on, a sticky element becomes static and shows
  once, at its natural place. A fixed element is hidden. A fixed element that contains the scrolled
  panel is never hidden. A full scan also finds pinned elements that take no pointer events, for
  example a fade above a chat box.
- The agent counts only the frames that got an `ok` reply. It sends a failed frame again with the
  same number, before it scrolls.
- A refused **Done** keeps the session open. **Done** before the first frame cancels the capture.
- After a rejected area or a refused session, the agent shows the error and starts the selection
  again.
- A duplicate frame does not count toward the covered height. Auto stops after three duplicate
  frames in a row.
- The agent sends no frame when the area no longer fits the window. It shows an error.
- A page that jumps its scroll position cannot make a gap or a very tall image. Spool refuses a
  frame that touches none of the parts that it has.
- The overlay stays above a modal dialog, a popover or a fullscreen element of the page.
- File names. Spool removes the characters that Windows and the browser refuse, and tries the save
  again without the page title when the browser refuses a name.
- The full image is built in chunks of at most 512 rows. Spool paints rows that no part covers
  white, and keeps at most 2 decoded images in memory.
