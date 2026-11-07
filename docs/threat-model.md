# Threat model

This document says what Spool can access, why it needs each permission, what protects each asset,
and which risks remain. It is written for reviewers, for store reviewers, and for people who want
to know what they are installing. To report a vulnerability, read [SECURITY.md](../SECURITY.md).
For the exact interfaces, read [contracts.md](contracts.md).

## Summary

- Spool runs only after the user starts it, with the toolbar button or a shortcut. The start
  shortcut is Alt+Shift+S (Control+Shift+S on a Mac). The Insert last capture shortcut is
  Alt+Shift+V (Control+Shift+V on a Mac).
- Spool has no host permission. It reaches the active tab only through `activeTab`.
- No content script loads at page load. The service worker injects the page scripts on demand, into
  the top frame, in the isolated world. The overlay, the toast and the Insert card live in closed
  shadow roots.
- The page scripts act only on trusted events: real keys and clicks. A script on the page cannot
  press Spool's buttons or send it commands.
- Spool has no network access. No code makes a network request, and the Content Security Policy
  blocks it on the extension pages.
- Spool checks the sender and the exact shape of every message.
- Spool does not run in private windows (`"incognito": "not_allowed"`).
- The extension writes no image data to disk by itself. Image data stays in memory until the user
  clicks **Copy & save**. Then Spool saves the files (to the folder the user chose, or to
  Downloads) and copies the full image to the clipboard. The browser can page `Blob` memory to
  disk. See [Image data and the disk](#image-data-and-the-disk).
- During a capture, page scripts receive no image data. After **Copy & save**, they receive the
  user's own capture bytes: the full image for the clipboard, the thumbnail, and one AI screenshot
  per click on a chip.
- The setting "Copy the full image when you finish" (`copyOnDone`, on by default) turns the
  clipboard write off. Then the full image does not enter the page at all.
- The Insert last capture card pastes with a synthetic paste event, only after a trusted click, only
  while it is visible and uncovered, and only for the capture that was the last one when it
  opened. It never inserts into a frame.
- A Chrome Web Store install is signed by the store and updated by the browser. A zip install is
  not verified by the browser. See [Distribution and update trust](#distribution-and-update-trust).

## Assets and actors

| Asset | Why it matters |
|---|---|
| The content of the page the user selects | It can hold personal or confidential data. |
| The captured images and the saved files | They show the same data. |
| The user's browser session | An extension with wide access can act as the user. |

| Actor | What it can do |
|---|---|
| A web page the user captures | Run its own scripts. Change its own content. Watch events in its own DOM. |
| A web page that hosts a chat the user inserts into | Receive the pasted files. Refuse the paste. |
| Another extension | Run in the same browser, with its own permissions. |
| Another program on the computer | Run as the same system user. Read and write the user's files and clipboard. |
| A browser assistant that clicks for the user | Produce trusted-looking input, depending on the browser. |
| The supplier of the release zip or of a development tool | Change the code before the user installs it. |

## What the extension can access, and when

| Context | Access | When |
|---|---|---|
| Service worker | Messages, `chrome.tabs`, `chrome.scripting`, `chrome.storage`, `chrome.offscreen`, `chrome.downloads`, and the clipboard (write only). | It wakes for an event and stops when idle. It holds no session state. |
| Page scripts | The DOM and the scroll position of the top frame of the active tab. After **Copy & save**: the full image (for the clipboard), the thumbnail, and AI screenshots on request. | After the user starts a capture or opens the Insert card. They stop when the capture ends or the card closes. |
| Offscreen document | The image steps of open captures. The outputs of the last finished capture (AI screenshots, full image, thumbnail). The handle of the chosen save folder, and write access to that folder. | Steps: from the first frame until **Copy & save** has built the outputs. Outputs: until the next capture finishes, 60 minutes, or the need for memory. |
| Capture page | The outputs of the last capture. `chrome.downloads`. The clipboard, on a click. The chosen folder, with a click for the permission. | While its tab is open. |
| Settings page | The settings in `chrome.storage.sync`. The folder picker and the handle of the save folder. | While its tab is open. |

### Events that wake the service worker

| Event | Why Spool listens |
|---|---|
| `action.onClicked`, `commands.onCommand` | The user starts a capture (`start-capture`) or opens the Insert card (`insert-capture`). |
| `runtime.onMessage` | Messages from page scripts, the offscreen document and extension pages. `routeCheck()` checks each one first. |
| `runtime.onInstalled` | Opens the Welcome tab, for the reason `install` only. |
| `tabs.onRemoved` | A closed tab ends that tab's unfinished captures and its Insert tokens. |

A capture registers `tabs.onActivated` for the time of one frame and removes it. Spool has no
listener for page loads, because Chrome has no filter for `tabs.onUpdated`, and the event would
wake the worker on every load in every tab. A page that unloads makes the page agent send
`page/cancel`, and an idle timer drops a capture whose page died without it. The manifest has no
`tabs` permission.

### Access to a tab

- `activeTab` gives temporary access to one tab, only after a user gesture on the extension: a click
  on the toolbar button or a shortcut. The access ends when the tab navigates or closes.
- The service worker checks the URL before it injects. It refuses browser pages and the web stores.
- The service worker takes the tab ID and window ID from `sender.tab`, never from a message field.
- The service worker checks that the tab is the active tab of its window before and after each
  capture. A capture that shows another tab never reaches the store.
- The offscreen document checks that a session belongs to the tab that sends the message.

### Isolation from the page

- The page scripts run in the isolated world. The page cannot read their variables or call their
  functions.
- The overlay, toast and card are in closed shadow roots. The page cannot reach them with
  `element.shadowRoot`, and it sees only the host element. The host has no attribute that shows the
  state of a capture.
- Their styles use a constructable stylesheet, which works when the page's Content Security Policy
  blocks `<style>` elements.
- During a capture, page scripts receive no image data. The service worker sends each frame to the
  offscreen document. The agent gets only numbers: counts, heights and a seam status.
- After **Copy & save**, the page renderer of the captured tab receives the user's own capture
  bytes: the full image for the clipboard write (unless `copyOnDone` is off), the thumbnail for the
  toast, and one AI screenshot per click on a chip. The page agent is the least trusted context, so
  the service worker checks each request and gives the page a copy of the summary with only the
  known fields. A page script cannot ask for these bytes, because the messages are sent from the
  isolated world only.
- The Insert card runs in any tab, also a tab of another site than the captured one. When it opens
  it receives only what it shows: the screenshot count, the size, the age, the host name of the
  captured page, the place of the saved files and the thumbnail (`toShelfSummary` in
  `src/sw/summary.js`). It gets no page title, no session ID and no warnings. It reads image bytes
  only after a trusted click.
- The page scripts change the inline style of sticky and fixed elements over the capture area. A
  style jar records each old value and restores it when the capture ends. This never changes the
  scrolled panel or an element that contains it. They also set `scroll-behavior: auto` on the
  scrolled element and on `<html>`, with the same restore.
- The page scripts read page-controlled names (such as `document.title`) through the prototype
  accessors, so markup that shadows a name cannot change what Spool reads. The namespace
  `__spool` is an own property that markup cannot replace.
- Every listener acts only on trusted events (`event.isTrusted`). A page can send fake keyboard and
  pointer events to the window, and Spool ignores them. A page cannot press **Copy & save** or
  Cancel, select an area, or scroll the capture with a fake event. A fake `pagehide` does not cancel
  a capture either.

A trusted event is real input from the browser. A browser assistant that clicks for the user can
produce trusted input, depending on the browser. Do not let such an assistant act in a tab while
the Insert card is open.

### The Insert card guard

A page can open its own element over the card, even one that ignores the pointer, and draw a fake
button there. A click on the fake button would reach **Insert**, and the page would receive the
full content of the last capture. The card guards against this:

- **Insert** is off while the card is new and for 400 ms after it became visible.
- **Insert** is off while `IntersectionObserver` v2 (`trackVisibility`, `delay: 100`) says that
  something covers the card or that it is not visible. A browser without v2 keeps the 400 ms wait.
- A click that arrives while the guard is off does nothing, and the card says "Something on this
  page covers Spool. Click again in a moment."
- The card puts itself back above what covers it, at most once a second.
- The card names both ends: "5 AI screenshots from github.com" and "Into chat.example.com". It reads
  the destination from `location.hostname`, which markup cannot replace.
- It inserts at most 20 AI screenshots per click, and it fetches three at a time.

Every use of the card is cross-origin, so a second confirmation would show every time and turn into
a reflex. The card names both ends instead.

### Messages

- Every receiver calls `routeCheck()` first. It checks the target, the protocol version, the type,
  the sender and every field.
- The sender check uses the extension ID and the sender URL. A message from a page script is valid
  only from the top frame of a tab. Extension pages are known by their path.
- Each message type has a list of allowed senders. The capture page cannot send a message that only
  the service worker may send.
- A message with an extra field is not valid. Session IDs are random UUIDs.
- `page/cancel` does nothing when the session does not exist or no offscreen
  document exists. They never create the offscreen document, so a repeat or a late message has no
  effect.
- A request for the outputs of a capture works only from the tab of that capture. The service
  worker takes the tab from `sender.tab`, and the offscreen document checks that the last capture
  belongs to that session and tab. Another tab gets the same error as for a capture that does not
  exist.
- The Insert card uses a token. The service worker makes a random token (a UUID) for each press of
  the shortcut, only when no agent is active in the tab, and registers it with the offscreen
  document for that tab. The token ends after 10 minutes, when its tab closes, when a new token is
  made for the same tab, when more than 8 tokens exist (the oldest goes first), and when the offscreen
  document closes. A page load does not end it: the worker has no listener for page loads.
- A token is bound to a capture, not only to a tab. The offscreen document stores the session ID of
  the last capture at the time of the grant, and serves only that capture. When a newer capture
  exists, the card says "A newer capture exists. Press Alt+Shift+V again." (it shows the real key).
  So an open card cannot hand out the capture that the user made later in another tab.
- Only the offscreen document may send `sw/download`. The service worker accepts only `blob:` URLs
  of its own extension and only clean relative paths (no `..`, no drive letter, no forbidden
  character, at most 4 folder levels). It starts them with `saveAs: false` and
  `conflictAction: 'uniquify'`.
- An image over 40 MiB (`MAX_TRANSFER_BYTES`) does not travel in a message. The request fails and
  the user uses the saved files or the AI screenshots.
- The service worker creates, closes and checks the offscreen document one action at a time, and
  sends the first message of a session in the same locked step that creates the document.
- The manifest has no `externally_connectable` entry, so web pages and other extensions cannot send
  messages to Spool. It has no `web_accessible_resources` entry, so a page cannot load Spool's files.

### Data in memory

- The service worker passes each frame to the offscreen document at once and does not keep it.
- The offscreen document stores each step as a PNG blob, plus a small luminance signature for the
  seam check.
- After **Copy & save**, it builds the AI screenshots, the thumbnail and the full image. It keeps at
  most 2 decoded images in memory, closes the others at once, and encodes the full PNG in strips of
  512 rows. Then it frees the steps.
- It keeps the outputs of one capture, the **last capture**. A new finished capture replaces it. It
  also ends after 60 minutes (`LAST_CAPTURE_TTL_MS`), or when a new frame needs the memory. While it
  exists, the offscreen document stays open.
- Spool never writes image data to `chrome.storage`, IndexedDB, Cache Storage or the origin private
  file system. The saves of a finished capture are the one exception: files go into the chosen
  folder (File System Access API) or, through `chrome.downloads`, into Downloads.
- IndexedDB holds one thing: the handle of the chosen folder and the names of the folders below it
  (`src/ui/folder-store.js`). A handle is a reference, not data. `npm run policy` allows IndexedDB
  in this file only.

## Permissions

Each permission, why it exists, and what it does not allow:

| Permission | Why Spool needs it | What it does not allow |
|---|---|---|
| `activeTab` | Temporary access to the tab where the user starts a capture. Spool needs it to inject the page scripts, read the tab URL and call `captureVisibleTab`. | Access to any other tab. Access without a user gesture. |
| `scripting` | `chrome.scripting.executeScript` injects the page scripts into the top frame of the active tab. | Injection into a tab without `activeTab` access. The alternative, `content_scripts` on all sites, would need host access. |
| `offscreen` | The service worker has no DOM and can stop at any time. The offscreen document decodes and crops images, holds the session store, and makes the `blob:` URLs that downloads need (a worker has no `URL.createObjectURL`). It uses the reason `BLOBS`. | Access to web pages. It is an extension page. |
| `storage` | Settings in `chrome.storage.sync` under the key `settings`, and three small counters in `chrome.storage.local`: `saveFolderAsks`, `longToastsShown` and `saveReconnects`, and one number in `chrome.storage.session`: `lastSaveDownloadId`, the browser's ID of the first file of the last save to Downloads, for **Show in folder**. | Storage of image data. |
| `downloads` | When no save folder is allowed, Spool saves the files to the Downloads folder with `chrome.downloads.download`, `saveAs: false` and `conflictAction: 'uniquify'`. The capture page also saves through it. It reads the state of its own downloads by ID, to see when a save is complete, and reveals the last file that it saved. | Saving without **Copy & save** or a save button. Spool ignores downloads that it did not start. It never deletes a download. |
| `clipboardWrite` | The fallback for the clipboard. The page agent writes the full image in the **Copy & save** gesture. When that fails (for example the page sets a permissions policy that blocks it), the service worker writes it with `navigator.clipboard.write`, which an extension worker may do with this permission. | Reading the clipboard. Spool never reads it, and `npm run policy` forbids `clipboard.read` and `clipboard.readText` in `src/`. |

The manifest does not request these:

| Not requested | Reason |
|---|---|
| Host permissions and `<all_urls>` | `activeTab` is enough. |
| `tabs` | The URL of the active tab is available through `activeTab`. |
| `unlimitedStorage`, `nativeMessaging`, `fileSystem*` | The File System Access API needs no manifest permission. The folder picker runs in an extension page, in a click. |
| `debugger` | It shows a warning bar and gives very wide access. |
| `webRequest`, `cookies`, `history`, `bookmarks` | Spool has no use for this data. |

`npm run policy` compares the manifest with `scripts/permissions-baseline.json` and fails when
someone adds a permission. A new permission needs a security review. An update that adds a
permission with a warning disables the extension for every store user until they accept it.

### What `activeTab`, `downloads` and `clipboardWrite` allow in practice

A permission name says little. This section says what each of the three allows an extension to do,
and what Spool's code limits itself to.

**`activeTab`**

| In practice, an extension with this permission can | What Spool does |
|---|---|
| Run code in the tab with `chrome.scripting`, also in the main world. The code can read and change the whole page. | It injects only after a click on the button or a shortcut. It injects only into the top frame and only in the isolated world. |
| Read the URL and the title of the tab. | It reads the URL to refuse browser and store pages, and the host name to label the capture. It takes the page title (cut to 200 characters) for the file names. |
| Capture the visible area with `captureVisibleTab`, also outside the selected area. | It crops each frame in the offscreen document to the selected area and drops the rest. |
| Keep the access for a long time. A single-page app can stay on one page all day. | It injects only after a new gesture. A session is bound to one tab, and the worker checks that the tab is the active tab before and after each capture. |

**`downloads`**

| In practice, an extension with this permission can | What Spool does |
|---|---|
| Start a download of any URL. The browser sends the cookies of that site with the request. | It downloads only a `blob:` URL of its own extension, made by the offscreen document for its own image. The worker checks the extension ID in the URL and the path of each file. |
| Read the whole download history with `downloads.search`. | It searches only for the ID of its own download. |
| Pause, resume or cancel any download. Remove a file from the disk. Delete history entries. | It calls none of these functions. |
| Show any downloaded file in its folder. | It shows only the last file that it saved. |

`downloads.open` needs a second permission, `downloads.open`. Spool does not request it.

**`clipboardWrite`**

| In practice, an extension with this permission can | What Spool does |
|---|---|
| Write text, HTML and images to the clipboard from the service worker, with no click and no tab. Every program that runs as the user can read the clipboard, and clipboard history can keep it. | The worker writes only after the page agent asked for the fallback for a capture of its own tab, and it writes only the full image of that capture. It never writes text. |
| Reading needs no permission, but the browser asks the user. | Spool never reads the clipboard. |

If an attacker found a way to run code in a Spool extension page, the attacker would gain the
abilities in the left column of these tables. These rules reduce that risk: the Content Security
Policy, the rule that no code uses `innerHTML` or similar functions, and the check of every message.

## The clipboard and the Insert card

- The clipboard gets the **full image** on **Copy & save**, unless `copyOnDone` is off. The page
  agent writes it in the gesture: it calls `navigator.clipboard.write` with a promise for the
  image, started by a trusted key press or click, with no `await` before it. The browser asks no
  question for a write. If the page blocks the write, the service worker writes it. With the
  setting off, the agent does not write, does not ask for the image and does not use the fallback.
- A full image whose decoded size would pass 256 MiB is not written, because the browser decodes it
  in the page's renderer and a tab crashes far above that. The files save as usual.
- The Insert card opens only after the shortcut, which the user presses, so no page can open it.
  **Insert N screenshots** sends a synthetic `paste` event, with the screenshots as files, to the
  element that has focus. This happens only after a trusted click, and only while the guard allows
  it. The event has `isTrusted` set to false, so a page can tell it from a real paste, and a page
  script can listen for it. The screenshots are the user's own capture, and the user pressed the
  button to put them in this page. If the page does not accept the paste, the card says so and the
  user copies one screenshot at a time.
- The card does not paste into a frame. Spool's page scripts run in the top frame only. When the
  focus is in an `<iframe>`, `<frame>`, `<object>` or `<embed>` (also inside an open shadow root),
  a synthetic paste at it would go to the scripts of the top page, such as analytics or
  session-replay scripts, and not into the frame. The card then does not dispatch.
- Every image a page receives is a part of the user's own capture. A compromised page renderer, such
  as a bug in the browser, could read it. For the captured tab this is mostly what the page already
  shows. A cross-origin frame is different: Site Isolation keeps its pixels out of the embedding
  page's process, and the full image of a capture that includes such a frame is decoded in that
  process. With `copyOnDone` off, the full image stays out of the captured page.

## Content Security Policy

The manifest sets this policy for the extension pages and the service worker:

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:;
connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';
require-trusted-types-for 'script'; trusted-types 'none'
```

| Directive | Effect |
|---|---|
| `default-src 'none'` | Blocks every resource type that no other directive allows. |
| `script-src 'self'` | Allows only scripts from the extension package. This blocks inline scripts, `eval` and remote code. |
| `style-src 'self'` | Allows only style sheets from the package. This blocks `<style>` elements and `style` attributes. |
| `img-src 'self' blob:` | Allows images from the package and blob URLs. The capture page shows the AI screenshots from blob URLs. |
| `connect-src 'none'` | Blocks `fetch`, `XMLHttpRequest`, `WebSocket` and `EventSource`. The extension pages cannot send data out. |
| `object-src 'none'` | Blocks plug-ins. |
| `base-uri 'none'` | Blocks a `<base>` element that could redirect relative URLs. |
| `form-action 'none'` | Blocks form submissions to other addresses. |
| `require-trusted-types-for 'script'` | Blocks a string that goes into a function that runs script, such as `innerHTML` or `eval`. |
| `trusted-types 'none'` | Allows no Trusted Types policy, so no code in an extension page can pass such a string. |

The policy does not cover the page scripts. They run in a web page and follow its policy. The code
rules of `npm run policy` cover them (see [CONTRIBUTING.md](../CONTRIBUTING.md)). That check is a
pattern-based lint. It catches mistakes and plain misuse, but computed names and aliases get past
it. Code review is the control for hostile code.

## Data handling

| Data | Where | How long | Who can read it |
|---|---|---|---|
| Frame from `captureVisibleTab` | In a message from the worker to the offscreen document | Until the offscreen document has stored it | Only the two extension contexts |
| Cropped steps (PNG blobs) | Memory of the offscreen document. The browser can page `Blob` data to a temporary file in the profile folder. | Until **Copy & save** has built the outputs, or 15 minutes after it when the build failed. An unfinished capture ends after 30 minutes without a new frame. | The extension. A temporary file: every program that runs as the user. |
| Page title and host name | Memory of the offscreen document | Same as the steps, then as the last capture | The extension |
| AI screenshots, full image, thumbnail of the last capture | Memory of the offscreen document (Blobs) | Until the next capture finishes, 60 minutes, or the need for memory | The extension. The page agent, the toast and the Insert card get the bytes they ask for. |
| Thumbnail and screenshots in the toast and the Insert card | Memory of the page, in a closed shadow root | Until the toast or card closes, or the page unloads | Spool's page scripts. The page sees only the host element. |
| AI screenshots and full image on the capture page | Memory of the capture page | Until its tab closes | The extension |
| Saved files | The chosen folder, or Downloads | Until the user deletes them | Every program that runs as the user |
| Folder handle and sub path | The extension's IndexedDB (`src/ui/folder-store.js`) | Until the user clears it in Settings or removes the extension | The extension. It is a reference, not data. |
| Insert token | Memory of the offscreen document and the page scripts | At most 10 minutes, for one capture. It ends earlier when its tab closes, when a new token is made for the same tab, when more than 8 tokens exist, or when the offscreen document closes. | The extension, and the tab that got it |
| Copied image | The system clipboard | Until another copy replaces it | Every program that runs as the user. Clipboard history can keep it. Only when `copyOnDone` is on. |
| Counters `saveFolderAsks`, `longToastsShown`, `saveReconnects` | `chrome.storage.local` | Until the user removes the extension | The extension. They hold no image data. |
| `lastSaveDownloadId`: the browser's ID number of the first file of the last save to Downloads | `chrome.storage.session` | Until the next save replaces it, or the browser closes | The extension. A number only: no name, no path, no image data. |
| Settings | `chrome.storage.sync` | Until the user resets them or removes the extension | The extension. The browser can sync them when sync is on. |

Other rules:

- Spool drops an unfinished capture when its tab closes, when the user clicks Cancel, when the page
  unloads during the capture, and after 30 minutes without a frame (`SESSION_IDLE_MS`).
- One capture holds at most 512 MiB of stored PNG data (`SESSION_MAX_BYTES`). All open captures and
  the last capture together hold at most 1 GiB (`TOTAL_MAX_BYTES`). The last capture goes first
  when a new frame needs the room. The image is at most 300,000 px high.
- A saved file name contains the time and the page title (`Spool <date time> <title>.png`, cut and
  cleaned). The browser's download history also records names of files saved to Downloads.
- If the save folder or Downloads syncs to cloud storage, the saved files sync with it.
- The browser's permission for the save folder is per origin. The browser ends it when the last
  tab of the extension closes, or after a time in the background, unless the user chooses "Allow on
  every visit". The offscreen document never asks for it, because only a click on an extension page
  can. When it is missing, the files go to Downloads and the toast offers **Reconnect**.
- Error messages for the user are short and contain no page data. Logs contain no image data and no
  page data.
- The Welcome tab tells the user, before the first capture, that every capture is saved as files
  and copied to the clipboard, and links to the Settings that change it.

## A page can detect the capture

Spool shows an overlay in the page. A page script can see changes in its own DOM, scroll events and
the style changes of fixed and sticky elements, so a page can know the moment of each capture.
Spool cannot remove this signal, because scroll events and the size of the viewport are also
visible to the page.

A page can use this signal to show other content only in the captured frames. The user sees it for
a very short time, or not at all, and the screenshots contain it.

This matters most when you give screenshots to an AI. A page can add text meant for the AI: small
text, low-contrast text, or text that appears only during a capture, such as a line that tells the
AI to ignore the user. This is prompt injection. A human reader does not see it, and the AI can
read it.

Rules for the user:

1. Look at each screenshot, or at the full image, before you give it to an AI.
2. Be careful with pages you do not trust. Do not give such screenshots to an AI that can use tools
   or reach your accounts.
3. Treat the AI's answer as untrusted when the screenshots come from an unknown page.

Spool cannot check that the content of a screenshot is the content that the user saw.

## Image data and the disk

The offscreen document stores each step as a `Blob`. The browser owns `Blob` storage. Under memory
pressure, Chromium can page `Blob` data to a temporary file in the profile folder (`blob_storage`)
and deletes it when the `Blob` is freed. We did not test this in each browser. The extension cannot
prevent or observe it.

- Spool's code writes no image data itself. The only files are the saves of a capture that the user
  finished with **Copy & save**, and the saves from the capture page.
- A temporary file in the profile folder is not encrypted. Every program that runs as the user can
  read it while it exists.
- The amount is small and bounded. See the limits above.
- Spool frees the steps as soon as **Copy & save** has built the outputs. It keeps the outputs
  until the next capture finishes, for at most 60 minutes, or until a new frame needs the memory.

Rules for the user: finish a capture with **Copy & save** or Cancel, close the capture page when
you are done, close the browser or start a new capture to end the last capture early, and use
full-disk encryption on the computer.

## Distribution and update trust

**Chrome Web Store (recommended).** The store signs the package. Chrome checks the files and
disables an extension that changed, and updates it automatically. Developer mode can stay off. The
store reviews each update, and an update that adds a warning permission needs the user's consent.
Brave, Edge and Comet install store items too.

**Zip (fallback).** The browser reads the extension from a folder at each start and at each
**Reload**, and does not check the files. Developer mode must be on. By default the folder is in the
user's own files, so every program that runs as that user can write to it. Such a program could
change `manifest.json` and the service worker, for example to add `<all_urls>` and `cookies`. At the
next browser start Spool would run the changed code with the new permissions, and the user would
see no change. We did not test whether each browser shows a prompt in that case. An attack needs
code that already runs on the computer, but it turns that code into access to every session in
every browser that loads the folder. Mitigations: use the store install, or put the folder where
only an administrator can write (for example under `C:\Program Files` on Windows).

A zip install derives the extension ID from the folder path, so a moved folder is a new extension
with default settings. The manifest forbids a `key`, so the ID cannot be pinned.

**Verify a release before you install the zip.**

1. Download `spool-<version>.zip` and `spool-<version>.zip.sha256` from the release page.
2. Check the hash: `shasum -a 256 -c spool-<version>.zip.sha256` on Mac and Linux, or
   `Get-FileHash .\spool-<version>.zip -Algorithm SHA256` on Windows.
3. Verify the build provenance: `gh attestation verify spool-<version>.zip --repo swarnavspujari/spool`.
   It ties the zip to the release workflow, the commit and the tag.
4. For an immutable release, run `gh release verify v<version> --repo swarnavspujari/spool` and
   `gh release verify-asset v<version> spool-<version>.zip --repo swarnavspujari/spool`.
5. Read the permissions line in the release notes. An unpacked extension does not ask you to
   approve a permission change.

The limits of these checks: the `.sha256` file and the zip come from the same release, so someone
who can replace one can replace both. Only the attestation and an immutable release add a check
that does not come from that channel. None of them detects a zip built from a bad commit on `main`,
so review the changes of each release. You can build the zip again: run `git checkout v<version>`
and `node scripts/package.mjs`. The bytes match when you use the same Node.js major version as the
release workflow (`.nvmrc`).

## Supply chain

- Spool has zero runtime dependencies. The release zip has no `node_modules` folder.
- Development dependencies are in `package.json` with exact versions, and `package-lock.json` pins
  them. `npm ci --ignore-scripts` installs them in CI. They are not in the zip.
- `npm run package` builds the zip in a repeatable way and writes a SHA-256 checksum file. CI builds
  it twice and compares the results.
- The release workflow has a read-only build job and a publish job that has write access but no
  checkout and runs no npm command. It checks the tag, builds the zip before installing any
  package, attests the zip, and publishes through a draft so that the release can be immutable.
  Details are in [guides/releasing.md](guides/releasing.md).
- Every workflow action is pinned by commit hash, only GitHub-owned actions are allowed, and each
  job has the least permission. Workflows get values through environment variables, never through
  script text.
- Repository rulesets require a pull request and **CI result** for `main`, and only administrators
  can create a `v*` tag. `scripts/repo-settings.sh` applies them.
- [NOTICE.md](../NOTICE.md) lists code that came from other projects. Spool takes code only from
  MIT, BSD and Apache-2.0 sources.

### Test build

The end-to-end tests load a copy of the extension from a temporary folder. The copy has the host
permission `<all_urls>` and a hook around the service worker, and it carries another name and icon
so nobody installs it by mistake. `npm run package` builds the zip from `manifest.json`, `icons/`
and `src/`, so the copy is never in a release. A test checks that the real manifest has no host
permission.

## Residual risks

| Risk | Note |
|---|---|
| The page can see that a capture runs, and it can change what it shows during one. | See [A page can detect the capture](#a-page-can-detect-the-capture). |
| A trusted-looking click from a browser assistant can reach **Insert**. | The guard stops a page overlay, not real or automated input. Do not use such an assistant while the card is open. |
| A zip install has no signature. | See [Distribution and update trust](#distribution-and-update-trust). |
| Image data can reach the disk without the extension. | The browser can page `Blob` data to a temporary file. |
| Saved screenshots are ordinary files. | Spool does not encrypt them. Treat them like the page they show. |
| The clipboard is readable by every program of the user. | System clipboard history can keep the full image after Spool drops it from memory, and cloud clipboard sync can send it to other devices. Spool writes it on every **Copy & save** by default. Turn "Copy the full image when you finish" off, and turn history and sync off in your system, if this matters. A site with a granted clipboard-read permission, or a remote-desktop web client that syncs the clipboard, can read a capture of another site. |
| The synthetic paste is not trusted. | A page can tell it from a real paste. It receives only the screenshots the user chose to insert there. |
| The `policy` check is a lint. | It does not stop hostile code. Review does. |
| Mac and Linux are untested on real hardware. | Spool relies on browser behavior that differs by system, such as the key bindings and the folder prompt. See [browser-behavior.md](browser-behavior.md). |
| Development tools run on the build machine. | The lock file pins them and CI installs them without install scripts. They are not in the zip. |
