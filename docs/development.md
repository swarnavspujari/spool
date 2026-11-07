# Development

How to set up a machine, run the checks, read CI and change Spool safely. For the rules of the
code, read [CONTRIBUTING.md](../CONTRIBUTING.md). For how the parts fit, read
[architecture.md](architecture.md). For the interfaces, read [contracts.md](contracts.md).

## Set up

You need Git and Node.js. `.nvmrc` names the version that CI uses (24). The `engines` field in
`package.json` requires 22.12 or later. You need a Chromium browser, version 120 or later, to load
the extension. The GitHub CLI (`gh`) is optional and only needed for repository and release work.

1. Clone the repository: `git clone https://github.com/swarnavspujari/spool` and open the folder.
2. Install the development tools from the lock file: `npm ci`. CI uses `npm ci --ignore-scripts`,
   and no development package needs an install script. Use the same option when you want the safer
   install.
3. Run `npm run check`. The policy check, the type check and the unit tests must pass.
4. To run end-to-end tests, tell Playwright to use the Chromium inside `node_modules`. In
   PowerShell run `$env:PLAYWRIGHT_BROWSERS_PATH = '0'`, then `npx playwright install chromium`.
   In a Bash shell, write the variable before each command: `PLAYWRIGHT_BROWSERS_PATH=0 npx
   playwright install chromium`. Set it for both `install` and `test`, so they see the same
   browser path. CI does not set it.
5. Run one spec to test the browser:
   `npx playwright test e2e/harness.spec.js --project=scale-1`.

## Load the extension

There is no build step. Open `chrome://extensions`, turn on **Developer mode**, click **Load
unpacked** and pick the repository folder. After each edit, click **Reload** on the Spool card.

Never load the folder that the end-to-end tests build in the temporary directory, and never load
`dist/`. The test copy has the host permission `<all_urls>`.

The extension ID comes from the folder path. A new path is a new extension with default settings.

## Commands

| Task | Command |
|---|---|
| Policy, type check and unit tests | `npm run check` |
| The policy check only | `npm run policy` |
| The type check only | `npm run typecheck` |
| All unit tests | `npm test` |
| One unit test file | `node --test test/unit/tiles.test.js` |
| Unit tests that match a name | `node --test --test-name-pattern="seam" test/unit/seam.test.js` |
| All end-to-end tests | `npm run test:e2e` |
| Build the release zip | `npm run package` |
| Make the icon files again | `npm run icons` |

Run `npm run check` before every commit.

### Run one end-to-end spec

1. Set `PLAYWRIGHT_BROWSERS_PATH=0` (see Set up).
2. Run the spec and a project:

   ```text
   npx playwright test e2e/done-flow.spec.js --project=scale-1
   ```

3. To run one test of the spec, add `-g` and part of its name:
   `npx playwright test e2e/done-flow.spec.js --project=scale-1 -g "long capture"`.
4. To read the report of the last run, run `npx playwright show-report`.

Notes:

- The projects are `scale-1`, `scale-1.25`, `scale-1.5`, `scale-2` and `perf`. `scale-1` runs every
  spec except the performance test. The scaled projects run only tests tagged `@core`. `perf` runs
  the performance test.
- A run builds a test copy of the extension in a temporary folder and deletes it when the run ends.
- Each test starts its own browser. Local runs use one worker.
- Run one Playwright run at a time. Two runs, or other heavy work, share the CPU, and a loaded
  machine makes a test time out. A timeout is not a bug of the extension. Run the test again when
  the machine is quiet.
- The browser must be able to show a tab, because `captureVisibleTab` needs a visible tab.

## Continuous integration

`.github/workflows/ci.yml` runs on every push to `main`, on every pull request and on demand. A new
push to a pull request cancels the older run of the same pull request. A run on `main` is never
cancelled.

| Job | Name on GitHub | What it does |
|---|---|---|
| `verify` | Verify | Checks the lock file, builds the zip twice and compares the two, installs the tools, checks the npm signatures, and runs `npm run check`. |
| `e2e` | E2E (scale-1), E2E (scale-1.25), E2E (scale-1.5), E2E (scale-2), E2E (perf) | One job for each Playwright project. |
| `gate` | **CI result** | Passes only when every other job passed. |

Rules:

- **CI result** is the one check to require before a merge. It always runs. Do not require the other
  jobs: a matrix job has one name for each project.
- Playwright retries a failed test once in CI. A test that passes only on the retry is flaky. The job
  summary lists it, and the job keeps its report. Do not raise the retries. Find the cause.
- On a failure, open the run page, read the job summary, download the artifact
  `playwright-report-<project>`, and run `npx playwright show-report <folder>` on it.
- The browser is cached. The cache key has the hash of `package-lock.json`.
- Browsers per job come from the repository variable `E2E_WORKERS` (default 3), read as
  `SPOOL_E2E_WORKERS`. The value must be a whole number from 1 to 8.
- All actions are pinned by full commit hash with the version in a comment. Dependabot proposes
  updates. Review each pull request and keep the hash pin.
- **New device scale.** Add it to `CORE_SCALES` in `playwright.config.js` and to the e2e matrix and
  `SPOOL_E2E_EXPECTED_PROJECTS` in the workflow. If the lists differ, every e2e job stops with a
  message that names both.

`.github/workflows/platforms.yml` runs the unit tests and the package build on macOS and Windows after
each push to `main`. It is not a required check. A red run means "go and look". There is no
end-to-end step on purpose: the tests compare pixels against Chromium on the Linux runner image,
and what matters on a Mac or a Windows PC (shortcut labels, the Option key, Retina capture) a
headless run cannot see. A person checks those by hand before a release.

## Add a permission

A permission gives the extension more access to the browser. Add one only when a feature needs it
and no smaller permission works. A new permission with an install warning also disables the
extension for every store user until they accept it. `clipboardWrite` is an example of a permission
that earns its place: the service worker needs it to write the clipboard when the page cannot.

1. Write down the feature, the reason, and why no smaller permission works.
2. Do a security review. Describe what the permission allows in practice and what the code limits
   itself to. The tables under "What `activeTab`, `downloads` and `clipboardWrite` allow in
   practice" in [threat-model.md](threat-model.md) show the format. Ask a second person to review.
3. Add the permission to `manifest.json`.
4. Add it to `scripts/permissions-baseline.json`, and keep the list sorted. The policy check fails
   when the manifest and the baseline differ.
5. Update the documents in the same commit:
   - [threat-model.md](threat-model.md): the permission table and the table of what it allows.
   - [privacy.md](privacy.md): the permission table.
   - [store/listing.md](store/listing.md): the justification text.
   - [contracts.md](contracts.md): section 7.7 or the section that uses the permission.
   - [../CHANGELOG.md](../CHANGELOG.md): the Security section.
6. Run `npm run check`. The policy check and `test/unit/policy.test.js` must pass.
7. Release as usual. The release notes compare the permissions with the previous tag and call out a
   change in bold.

Do not add `host_permissions`, `optional_permissions`, `content_scripts`,
`web_accessible_resources` or `externally_connectable`. The policy check forbids these keys. A
change to the list of forbidden keys needs its own review.

## Repository layout

| Path | Content |
|---|---|
| `manifest.json` | The extension manifest (Manifest V3). |
| `src/sw/` | Service worker: entry points, injection, capture queue, offscreen client, downloads, clipboard fallback, Welcome tab, save question. |
| `src/page/` | Page scripts: scroll and style logic, overlay, toast, Insert card, agent. They run in the isolated world. |
| `src/offscreen/` | Offscreen document: session store, finalize, last capture, save step, Insert tokens. |
| `src/render/` | Image pipeline for the tiles, the thumbnail and the full PNG. |
| `src/result/` | The capture page: AI screenshots, full image, copy and save. |
| `src/options/` | The Settings page, the Welcome tab and the Reconnect card. |
| `src/ui/` | The shared look of the extension pages, icons and the folder store. |
| `src/lib/` | Pure functions: geometry, seam search, tiles, assembly, PNG encoder, file names, key labels. |
| `src/shared/` | Constants, types, settings and the message protocol. |
| `types/` | Type declarations for the page scripts. |
| `icons/` | Extension icons. |
| `scripts/` | Policy check, packaging, icon and repository settings scripts, and the permissions baseline. |
| `test/unit/` | Unit tests (`node:test`) and their helpers. |
| `e2e/` | End-to-end tests (Playwright), the builder of the test copy, and the test pages. |
| `playwright.config.js` | Playwright projects and options. |
| `.github/` | Workflows for CI, platforms and release, helper scripts, issue and pull request templates, the release notes template, Dependabot settings. |
| `docs/` | The documentation. See below. |
| `SECURITY.md` | The vulnerability reporting policy. |
| `CHANGELOG.md` | Version history. |
| `CONTRIBUTING.md` | The rules for contributors. |
| `NOTICE.md` | Third-party notices. |
| `LICENSE` | The MIT license. |

### Documentation map

| File | Audience | Content |
|---|---|---|
| `README.md` | Everyone | What Spool does, install in three steps, shortcuts, where files go. |
| `docs/guides/install.md`, `update.md`, `troubleshooting.md`, `using-spool.md` | Users | Step-by-step help with no jargon. |
| `docs/guides/releasing.md`, `publishing-to-chrome-web-store.md` | The maintainer | How to release and how to publish to the store. |
| `docs/privacy.md` | Users and the store | The privacy policy. |
| `docs/store/listing.md` | The maintainer | The store listing text and asset checklist. |
| `docs/threat-model.md` | Reviewers | What Spool can access, why, and what protects it. |
| `docs/architecture.md` | Engineers | How it works and why. |
| `docs/contracts.md` | Engineers | The interfaces between modules. The source of truth. |
| `docs/browser-behavior.md` | Engineers | Browser facts that shaped the design. |
| `docs/development.md` | Contributors | This page. |

## Pitfalls

- `captureVisibleTab` captures the visible tab, not the tab of the message. The tab-switch check in
  `src/sw/handlers.js` is a security control. Do not remove it.
- Playwright's `deviceScaleFactor` does not change the capture pixels. The tests use
  `--force-device-scale-factor`.
- Chromium cannot drag several files to another tab. Spool has the Insert card instead. Check again
  when the feature `DragAndDropJSFileObjects` ships.
- The folder permission ends when the last Spool page closes. The offscreen document must never
  ask for it. Only a click on an extension page can.
- The extension ID comes from the install folder path. A new path loses settings and the folder
  permission.
- A zip is comparable only when you build it with the same Node.js major version. A different
  version can compress differently.
- A message listener in the capture page or the Settings page would receive the full frames that the
  service worker broadcasts. The policy check forbids it.
