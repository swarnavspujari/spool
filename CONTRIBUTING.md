# Contributing to Spool

Spool is small on purpose: no runtime dependencies, no build step, no network, and as few
permissions as the features allow. These rules keep it that way and keep each change easy to
review. Read [docs/development.md](docs/development.md) first for setup and the daily commands.

## Before you start

- Open an issue for anything bigger than a bug fix, so you do not build something that cannot
  merge. A change that adds a permission, a network call or a dependency needs a strong reason.
- Read [docs/contracts.md](docs/contracts.md) before you change a module. It defines every
  interface and is the source of truth for message types.
- Report a vulnerability privately, as described in [SECURITY.md](SECURITY.md).

## Setup and commands

```text
npm ci               Install the development tools from the lock file.
npm run check        Policy check, type check and unit tests. Run it before every commit.
npm run policy       The policy check alone.
npm run typecheck    The type check alone.
npm test             The unit tests alone.
npm run test:e2e     The end-to-end tests (Playwright, real Chromium).
npm run package      Build dist/spool-<version>.zip and its .sha256 file.
```

To try a change, load the repository folder with **Load unpacked** and click **Reload** on the
extension card after each edit. The details, including how to run one end-to-end spec, are in
[docs/development.md](docs/development.md).

## Code rules

- **Zero runtime dependencies.** The files in `src/` are the files the browser runs. Do not add a
  bundler or a build step.
- The service worker, the offscreen document and the extension pages are ES modules. Page scripts
  (`src/page/*`) are classic scripts injected into the page's isolated world. Each file is one
  IIFE that registers its module on `globalThis.__spool` at every injection. There is no "already
  loaded" guard, so a reloaded extension never runs stale code.
- Put logic in pure functions in `src/lib/` (no `chrome.*`, no DOM). Keep the code that touches
  browser APIs thin.
- The service worker holds no session state, because the browser can stop it at any time. The
  offscreen document owns the image data.
- Start every JavaScript file with `// @ts-check` and describe types with JSDoc.
  `npm run typecheck` must be clean.
- Use 2 spaces, single quotes, semicolons and lines up to 100 characters. The `.editorconfig`
  file sets the rest.
- Name units: a plain name is CSS px, `...Px` is device px, `...Ms` is milliseconds.
- Throw `SpoolError(code, message)` for expected failures. A message for the user is short, plain,
  and contains no page data.
- In the interface, say "AI screenshot", "Copy & save", "Settings" and "capture page". The code
  keeps its internal names (`tile`, `finish`, `options`, `result`). The glossary is at the top of
  [docs/contracts.md](docs/contracts.md).

## Security rules

Two groups of rules apply. `npm run policy` enforces the first group. A reviewer enforces the
second, because a script cannot.

### Enforced by `npm run policy`

The command reads `manifest.json` and every `.js`, `.mjs`, `.html`, `.css` and `.svg` file in
`src/`. It prints `file:line: message` for each finding and exits with code 1. The code is in
`scripts/lib/policy.mjs`, and the tests are `test/unit/policy.test.js` and
`test/unit/policy-restricted-apis.test.js`.

It is a pattern-based lint. It catches mistakes and plain misuse. It does not stop a determined
author, because computed names and aliases get past it. Review is the control for that.

- **Code from strings.** No `eval`, no `new Function`, no string argument to `setTimeout` or
  `setInterval`, no `importScripts` and no dynamic `import()`.
- **Markup from strings.** No `innerHTML`, `outerHTML`, `insertAdjacentHTML` or `document.write`.
  Build DOM with `createElement` and `textContent`.
- **Network.** No `fetch`, `XMLHttpRequest`, `WebSocket`, `EventSource` or `sendBeacon`. No
  `http://` or `https://` text in `src/`. No `@import` and no remote `url()` in CSS.
- **Inline code in HTML.** No inline `<script>` or `<style>`, no `style` attribute, no `on...`
  handler and no `javascript:` URL. Every script has `type="module"`.
- **Type check header.** Every JavaScript file in `src/` starts with `// @ts-check`.
- **Message listeners.** `src/result/` and `src/options/` have no `runtime.onMessage`. Only the
  service worker and the offscreen document may listen, because the worker broadcasts full frames.
- **Storage and file APIs.** IndexedDB only in `src/ui/folder-store.js`, and only for the folder
  handle. No `localStorage`, `sessionStorage`, Cache Storage or origin private file system. File
  pickers only in `src/options/` and `src/ui/`. `requestPermission` only in `src/options/`,
  `src/result/` and `src/ui/`. No `clipboard.read` and no `clipboard.readText`. Spool only writes
  the clipboard. `new ClipboardEvent` and `new DragEvent` only in `src/page/`.
- **Test hooks.** The names `spoolDebug` and `__spoolTest` do not appear in `src/`. Only
  `e2e/build-extension.mjs` adds them, to its own copy of the extension.
- **Manifest.** `permissions` equals `scripts/permissions-baseline.json`. The Content Security
  Policy of the extension pages equals the baseline. `incognito` is `not_allowed`. It is Manifest
  V3 with a module service worker. Keys that open new surfaces are forbidden, for example
  `host_permissions`, `content_scripts`, `web_accessible_resources`, `externally_connectable` and
  `key`. Every file that the manifest names exists.

### Enforced by review

Nothing in the policy command checks these. A reviewer looks for each one in every change.

1. **Constructable style sheets.** Overlay, toast and shelf styles use a constructable
   `CSSStyleSheet` (`adoptedStyleSheets`) in a closed shadow root. The page's Content Security
   Policy can block `<style>` elements.
2. **`routeCheck()` first.** Every message receiver calls `routeCheck()` from
   `src/shared/protocol.js` before it does anything else. The receivers are `src/sw/router.js` and
   `src/offscreen/offscreen.js`. A message has exactly the fields of its type.
3. **No image data in `chrome.storage`.** The policy blocks the other stores but not
   `chrome.storage`. Image data leaves memory only in the save step of a finished capture and in
   the **Save** buttons of the capture page.
4. **Trusted events only.** A page script that reacts to input checks `event.isTrusted`. A web page
   can send fake events. `e2e/synthetic-events.spec.js` tests the overlay.
5. **Names that markup can shadow.** A page script reads page-controlled names (`document.title`,
   `form.style` and others) through the prototype accessors. Section 5 of
   [docs/contracts.md](docs/contracts.md) lists the rules, and `e2e/clobbering.spec.js` tests them.
6. **One source of truth for messages.** A change to a message type changes
   [docs/contracts.md](docs/contracts.md) and every user of the message in the same commit.
7. **Permissions.** The policy command compares the manifest with the baseline, but a person
   decides whether a permission is right. A new permission needs a security review, and an update
   that adds a permission with a warning disables the extension for every store user until they
   accept it. The steps are in [docs/development.md](docs/development.md#add-a-permission).
8. **The clipboard is write-only.** Spool never reads it. A page-side write starts in a trusted
   gesture, with no `await` before it.
9. **The folder prompt needs a click.** `showDirectoryPicker` and `requestPermission` start in the
   first statement of a click handler on an extension page. The offscreen document never asks.

## Tests

- Unit tests use `node:test`, one file per module: `test/unit/<module>.test.js`. Run `npm test`.
- End-to-end tests use Playwright with the extension loaded in Chromium. Run `npm run test:e2e`.
  [docs/development.md](docs/development.md) shows how to run one spec.
- A fix comes with a test that fails without it.
- `npm run check` must pass before a commit. CI runs the same check, plus the end-to-end tests.

## Documents

- Change a document in the same commit as the code it describes.
- Write plainly: short sentences, active voice, one idea per sentence. Lead with what the reader
  needs. State the reason when a rule looks odd.
- Put user-facing steps in `docs/guides/`. Put engineering detail in the other files under `docs/`.

## Commits and pull requests

- Use Conventional Commits: `feat(scope): ...`, `fix(scope): ...`, `test(scope): ...`,
  `docs: ...`, `ci: ...`, `chore: ...`.
- The pull request title becomes the squash commit message, so write it as a Conventional Commit.
- Merge only when the **CI result** check is green.

## Borrowed code

Take code only from MIT, BSD or Apache-2.0 sources. Record each source in [NOTICE.md](NOTICE.md)
with its license. Do not copy code from GPL or AGPL projects.
