# Browser behavior that shapes Spool

Spool's design follows what Chromium allows an extension to do. This page records those facts, how
we know them, and the decision each one led to. [contracts.md](contracts.md) section 7 has the
resulting flow.

Evidence labels:

- **OBS**: observed in a run. The runs used Chromium 158.0.8127.18 with Playwright 1.65 in the
  new headless mode, on 2026-11-06, unless a row says another version.
- **SRC**: read in the Chromium source.
- **UNVERIFIED**: needs a real native dialog, a real operating system drag, or hardware that we
  did not have. A person has to check it by hand.

## Clipboard

| Question | Result | Evidence |
|---|---|---|
| A page script writes an image in a trusted key press with `clipboard.write([ClipboardItem({'image/png': promise})])`, and the bytes arrive 1 to 8 seconds later | Works. No prompt. It works after the activation ends. | OBS |
| Focus is lost after the call | Works. The browser checks focus at call time only. | OBS |
| The page sends `Permissions-Policy: clipboard-write=()` | Fails with `NotAllowedError`. The `clipboardWrite` permission does not help a page script. | OBS |
| An `http:` page | `navigator.clipboard` is undefined in the page script. | OBS |
| A page with a strict Content Security Policy | Works, including the toast that uses `adoptedStyleSheets`. | OBS |
| An extension page, with or without `clipboardWrite` | Works only when its tab has focus. | OBS |
| The offscreen document | Fails with "Document is not focused". `execCommand('copy')` copies text only. | OBS |
| The service worker | `navigator.clipboard` exists for extension workers. With `clipboardWrite` an image write works with no focus, no gesture and no tab. Without it: "Write permission denied". Feature-detect it. | OBS, SRC |
| A prompt for writing | None. Only reading prompts. Spool never reads the clipboard. | OBS |
| A tall image written by a page | A 1,500 px wide PNG wrote and read back at every height from 8,000 to 60,000 px (up to 360 MB decoded). From 70,000 px (420 MB) the tab's renderer crashed. The same image decodes fine with `createImageBitmap`. Measured in headless Chromium 151. | OBS |

Decisions:

- Write from the page script in the **Copy & save** gesture, with a promise for the bytes, so the
  gesture covers the wait. Fall back to the service worker with `clipboardWrite`. The last fallbacks
  are the numbered chips (a trusted click) and the capture page.
- Do not write an image whose decoded size exceeds 256 MiB (`MAX_CLIPBOARD_BITMAP_BYTES`). That is
  a margin below the first measured crash, not a measured limit. A 1,500 px wide image reaches it at
  about 44,800 px. The write runs in the page that the person is reading, so a crash would kill
  that tab. The files and the AI screenshots are unaffected.
- A runtime message holds 64 MiB, and base64 adds a third. Spool does not send an image over 40 MiB
  in a message (`MAX_TRANSFER_BYTES`).

## Paste keys

| Question | Result | Evidence |
|---|---|---|
| What does Ctrl+Shift+V do in a text field? | It runs the browser's "paste and match style" command, which builds a text-only paste. With an image on the clipboard, the page gets a `paste` event with empty `clipboardData`, and nothing is inserted. | OBS, SRC |
| An image and text on the clipboard | Ctrl+Shift+V pastes only the text. | OBS |
| Ctrl+V with an image on the clipboard | Delivers one `image/png` file. | OBS |
| Do desktop apps built on Chromium behave the same? | Their windows use the same engine and the same paste command, so expect the same. Their own menu bindings were not inspected. | SRC |
| Can an extension bind Ctrl+Shift+V? | Yes. `chrome.commands.getAll()` reports it as assigned. | OBS |

Decision: **Spool binds neither Ctrl+V nor Ctrl+Shift+V.** By the Chromium source, the browser
handles an extension command before the renderer sees the key, so a command on Ctrl+Shift+V would
replace plain-text paste on every site (we read this in the source and did not press a real key).
A command could not paste anyway, because Spool never reads the clipboard. It would also break a
person's everyday plain-text paste. Instead Spool teaches Ctrl+V (Cmd+V on a Mac) for the full
image, and says on the Welcome tab that Ctrl+Shift+V pastes text only.

The Insert last capture shortcut works only in browser tabs, because Spool injects its card into a
page. In a desktop app, the routes are Ctrl+V for the full image and dragging the files out of the
`Spool for AI` folder. The toast and the card say so.

### Keys on each system

- **Windows and Linux:** Alt+Shift+S and Alt+Shift+V.
- **Mac:** Control+Shift+S and Control+Shift+V (`MacCtrl` in the manifest). Option with a letter
  types a symbol in a text field. Chrome handles a chord with Command or Control before the page.
  Command+Shift+S is Save As, and Command+Shift+V is paste-as-plain-text.
- `chrome.commands.getAll()` returns words joined by "+" on Windows and Linux ("Alt+Shift+V") and
  glyphs with no "+" on a Mac ("⌃⇧V"). `shortcutParts` in `src/lib/keys.js` reads both on every
  system and turns the words into glyphs on a Mac.
- With two or more keyboard layouts, Alt+Shift alone switches the layout on key release. A chord
  with a letter does not. Some Linux desktops bind Alt+Shift+Tab, and not letters.

UNVERIFIED: the real Mac keys on hardware, and the Linux desktops.

## Insert last capture against real pages

The shelf dispatches a synthetic `paste` event with the files, and reads `defaultPrevented` to see
whether the page took it. A synthetic event has `isTrusted` set to false, so a site can refuse it.
Tests against hand-made composers showed:

| Composer behavior | Result |
|---|---|
| A delegated handler that accepts only when the target is inside the composer, focus in the editor | Inserted |
| The same, with focus on the page background | Refused |
| The same, after the page replaced the editor node | Refused |
| A document-level handler | Inserted |
| A handler that ignores untrusted events | Refused |
| A handler that ignores paste for files | Refused |

So the card finds the paste target again at the click, tries the focused editor, then a composer on
the screen, then the page, and falls back to copying one screenshot at a time. Whether a given chat
site accepts the synthetic paste is UNVERIFIED for each site.

`activeTab` is granted to the tab where the shortcut is pressed, so the card works in a chat tab
even after the person switched tabs. It lasts until that tab navigates. UNVERIFIED on a real
keyboard shortcut with `activeTab` only.

## Save folder (File System Access)

| Question | Result | Evidence |
|---|---|---|
| Where can `showDirectoryPicker` run? | In an extension page, with a user gesture. Not in the service worker. Not usable in the offscreen document, which has no gesture. | OBS |
| Arguments | `startIn: 'pictures'` is accepted. An `id` may hold letters, digits, `_` and `-`. An `id` makes the picker reopen at the last pick for that `id`, which overrides `startIn`. | OBS, SRC |
| Can the handle be stored? | In the extension's IndexedDB. It is usable after a reload, in the offscreen document and in the service worker. | OBS |
| `queryPermission` | Origin-wide state: granted while a grant is active or an extended grant exists, else prompt. | SRC |
| `requestPermission` | Needs a user activation, except when an extended persistent grant exists. | SRC |
| Which folders may be picked? | Pictures and Pictures/Screenshots, yes. Home, Desktop, Documents and Downloads themselves are blocked as targets. System folders are blocked with their children. | SRC |
| A folder made below a granted handle | Writable at once, and it gets a persisted grant. | SRC |
| "Allow on every visit" for a `chrome-extension://` origin | Probably offered, because the feature is on by default on desktop and has no scheme check. Not yet seen on screen. | SRC |
| Grant lifetime | Ends when the last tab of the extension origin closes (the offscreen document and the worker do not count), and after about 16 hours with every page of the origin in the background, unless "Allow on every visit". | SRC |

How the grant behaves for the person:

- Picking the folder in a Settings tab and closing that tab ends the grant. The next capture finds
  `queryPermission` at `prompt` and saves to Downloads.
- After a browser restart, the stored grant is dormant until a click on an extension page calls
  `requestPermission`. That prompt offers "Allow on every visit", "Allow this time" and "Don't
  allow". "Allow on every visit" sets an extended permission for the origin. From then on the
  state is granted with no prompt, including for `queryPermission` in the offscreen document.
- The first pick in a session shows a plain new-permission prompt with no "every visit" choice. The
  choice appears only in the restore prompt. Spool cannot set it ahead of time, so it teaches it on
  the Welcome tab and the Reconnect card.
- After three denials or dismissals, Chromium holds back the restore prompt and shows the plain one.
- A forked browser can lack the feature. Then the grant needs a click each session, and keeping one
  Spool tab open is the workaround. The Reconnect card says so after the third use.

Decisions:

- Make the first pick one click on a folder the system already opens: **Save to Pictures ›
  Screenshots** calls the picker in Pictures, makes `Screenshots` in the picked folder, and stores
  the picked handle with the sub path `['Screenshots']`. One grant then covers the whole Pictures
  tree, the label is honest, and a deleted `Screenshots` is made again at the next save. Spool
  writes only inside the sub path, and the Welcome tab says the browser grants Pictures.
- Write to the folder only when `queryPermission` is `granted`. Otherwise save with
  `chrome.downloads` to `Downloads/Spool` and offer **Reconnect**, which opens an extension page
  where a click calls `requestPermission`.
- A native messaging host would write to Pictures with no click, and it was rejected. It needs a
  signed binary per system, per-browser registration, the extension ID in `allowed_origins`, and
  the `nativeMessaging` permission, and it runs outside the sandbox. It breaks the no-build rule.
- A person can also set the browser's own download folder to `Pictures/Screenshots`. Then
  `Downloads/Spool` lands under it. That moves all of the browser's downloads, so it is an advanced
  tip and not the default.

### The Pictures folder on each system

- **Windows:** `startIn: 'pictures'` follows the known folder, including OneDrive redirection, so
  the files can sync to the cloud. `Pictures\Screenshots` exists once the Windows screenshot
  shortcut or Snipping Tool has run. Spool's files all start with "Spool ".
- **macOS:** `~/Pictures` exists, and `Screenshots` does not. Spool creates it. The system may
  show its own privacy prompt the first time the browser reads Pictures.
- **Linux:** `startIn: 'pictures'` uses the XDG Pictures folder, which can have a translated name.
  Spool creates `Screenshots` when it is missing. A Flatpak or Snap browser goes through a portal
  and may behave differently.

UNVERIFIED: the full grant lifecycle (pick, tab close, restart, restore prompt, "Allow on every
visit") on a real extension origin in Chrome, Brave and Comet. The native dialog could not be
driven by an automated run.

## Drag and drop

| Question | Result | Evidence |
|---|---|---|
| A drag from a page carries one or three `File` objects. Does another tab get them? | No. It gets 0 files. Chromium sends only the names as `text/plain`. | OBS, SRC |
| Why | JavaScript `File` objects leave the renderer only with the `DragAndDropJSFileObjects` feature, which is in test mode in Chromium 158. Even then a drag carries at most one file's contents. | SRC |
| `DownloadURL` for one file | It works for a drop on the desktop or in a file manager only. A page in another tab sees nothing. | OBS, SRC |
| A synthetic `paste` or `drop` with files, dispatched by a page script in the destination tab | Works at DOM level. `isTrusted` is false, so a site that checks it can refuse. | OBS |

Decision: Spool has no "drag all". It has the Insert last capture card in the destination tab. Check
this again when a Chromium version enables the feature.

## Hostile page listeners

| Case | Result |
|---|---|
| A bubble-phase page listener, with Spool's handler in a closed shadow root that stops propagation | The page listener never runs. |
| The same without stopping propagation (the control) | The page sees the files and can replace them. |
| A window capture-phase page listener | It runs first and sees empty data. Clearing the items removes its data. It can only cancel the event. |
| A main-world patch of `DataTransferItemList.add` | It does not see calls from the isolated world. |
| A closed shadow root | `composedPath()` has no shadow nodes. The page sees only the host element. |

## Other limits

- `captureVisibleTab` runs at most 2 times a second. Spool waits at least 0.55 seconds between
  captures and retries the quota error.
- `captureVisibleTab` answers "image readback failed" when the tab has not presented a frame yet.
  In the test browser this happened on the first capture after `page.goto`, at every device scale,
  and a second call 100 to 200 ms later worked. The overlay waits two animation frames before each
  capture, and no capture of the end-to-end runs through the product path hit it. Spool retries it
  twice (100 ms apart, each retry after a rate slot) as a precaution.
- The browser can capture only the visible tab. A tab switch during a capture fails the step.
- A runtime message is limited to 64 MiB.
- Spool injects into the top frame only. It cannot scroll an area inside a cross-origin frame.
- The built-in PDF viewer, browser pages and the web stores are closed to extensions.
- The Comet assistant side panel is part of the browser. Spool cannot capture it.
- Chromium can page `Blob` data to a temporary file under memory pressure. The extension cannot
  prevent or see it.
- Chrome does not verify the files of an unpacked extension, and it does not ask the person to
  approve a permission change for one.
- Comet with an unpacked extension is UNVERIFIED.

## Checks that a person still has to do

Run these by hand on real hardware and record the results in the release notes.

1. **Insert last capture in a real chat site**, with the composer focused and unfocused, and after
   starting a new chat.
2. **Grant lifecycle.** Set up the folder, close the Settings tab, capture (expect Downloads and the
   Reconnect block), reconnect and choose "Allow on every visit", restart the browser, capture
   (expect the file in Pictures). If no three-button prompt appears, that browser lacks persistent
   permissions.
3. **A desktop app.** With an image on the clipboard, press Ctrl+Shift+V and then Ctrl+V in the
   composer. Expect nothing, then the image.
4. **A Mac.** Check the keys on `chrome://extensions/shortcuts`, press the chord in a text field,
   and check that the shortcuts show as glyphs.
5. **A very tall capture.** Capture a 1,500 px wide area at 60,000 px and at 80,000 px high. Copy &
   save must never crash the tab.
6. **Linux.** Pick in Pictures, check that `Screenshots` exists afterwards, and try the shortcuts
   under GNOME, KDE and XFCE.
7. **`clipboardWrite` and the worker fallback.** On real stable Chrome, open the service worker
   console (`chrome://extensions`, **Inspect views**, service worker) and run
   `'clipboard' in navigator`. If it is `false`, the `clipboardWrite` permission and the worker
   fallback have no effect in that browser, and both should be removed in a later release. Do not
   remove them before this check: the table above records the worker clipboard from test runs in
   Chromium and from the source, not from stable Chrome.
