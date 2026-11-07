// @ts-check
/**
 * Builds the extension copy that the end-to-end tests load.
 *
 * The production files are never changed. This script copies `manifest.json`, `icons/` and
 * `src/` to a temporary folder and patches only the copy:
 *
 *  1. `manifest.json` gets `"host_permissions": ["<all_urls>"]`. With it, the test can start a
 *     capture from the service worker without a user gesture (no `activeTab` grant), and
 *     `captureVisibleTab` works. This is far more access than the real extension has, so the
 *     copy must not be mistaken for it (see "Test build marks" below).
 *  2. `src/sw/service-worker.js` is moved to `src/sw/service-worker.original.js`. A generated
 *     `src/sw/service-worker.js` takes its place. It loads `test-hook.js`, then the original
 *     worker, then publishes `globalThis.__spoolTest = { startCapture, events, counts }`.
 *  3. `src/result/result.html` gets a second module script, `debug-hook.js`. It imports
 *     `{ debugApi }` from `./result.js` (the same module instance as the page's own script) and
 *     sets `globalThis.spoolDebug`. The production result page has no such global.
 *
 * Test build marks. The copy is a loadable extension with `<all_urls>` and a hook that starts
 * captures. A wrong click in "Load unpacked" must not give a browser that by accident:
 *  - The name is "Spool TEST BUILD — do not install (v<version>-e2e)", and the short name,
 *    description and toolbar title say the same.
 *  - The version name is "<version>-e2e-test".
 *  - Every icon has its red and blue channels swapped: the blue icon becomes orange.
 *  - The toolbar badge shows "TEST" (set by the worker hook).
 *  - The folder is below `os.tmpdir()`, in `spool-e2e/build-<random>`, never in the repository.
 *    A build in the default folder is deleted when the process that built it exits. A build in a
 *    folder that the caller named (`outDir`) stays, and an existing folder is replaced only when
 *    it has the marker file of an earlier test build.
 *
 * Why the wrapper keeps the file name `service-worker.js` (and the manifest keeps pointing to
 * it): Chrome reports the URL of the registered worker script as `sender.url` of every message
 * the worker sends. `classifySender()` in src/shared/protocol.js accepts a worker message only
 * when that URL is `PATHS.serviceWorker`. A different entry file (for example `test-entry.js`)
 * would make the offscreen document reject every worker message with E_FORBIDDEN_SENDER.
 *
 * `test-hook.js` mostly observes: it records messages the worker receives and sends (type, ok flag,
 * error code, intake summary; never image data) in `globalThis.__spoolTest.events`, so tests
 * can wait for real progress instead of sleeping. It changes one thing: it holds back the
 * `runtime.onInstalled` listeners (see HOLD_INSTALL_SOURCE), unless the build is made with
 * `holdInstall: false`.
 */

import { rmSync } from 'node:fs';
import { cp, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import { decodePng } from '../test/helpers/png-decode.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repository root. */
export const REPO_ROOT = path.resolve(HERE, '..');
/** Parent of the build folders: below the temporary folder of the OS, outside the repository. */
export const BUILD_PARENT = path.join(os.tmpdir(), 'spool-e2e');
/** Environment variable that carries the built folder from the global setup to the workers. */
export const EXTENSION_DIR_ENV = 'SPOOL_E2E_EXTENSION_DIR';
/** The start of the name of every test build. */
export const TEST_BUILD_NAME = 'Spool TEST BUILD — do not install';
/** A file in the root of a test build. A folder without it is not replaced (see buildExtension). */
export const BUILD_MARKER_FILE = '.spool-e2e-build';

const HOOK_FILE = 'src/sw/test-hook.js';
const WORKER_FILE = 'src/sw/service-worker.js';
const ORIGINAL_WORKER_FILE = 'src/sw/service-worker.original.js';
const RESULT_HTML_FILE = 'src/result/result.html';
const RESULT_SCRIPT_FILE = 'src/result/result.js';
const DEBUG_HOOK_FILE = 'src/result/debug-hook.js';

/** Where the hook takes the hold on the install event (see HOLD_INSTALL_SOURCE). */
const HOLD_INSTALL_MARK = '/*@@HOLD_INSTALL@@*/';

/**
 * The real worker opens the welcome page when the extension is installed. Every test profile is a
 * new install, so the tab would open in every test and change what the tests count (pages, tabs,
 * the active tab). The hook keeps the listeners of `runtime.onInstalled` and does not call them.
 * A test runs them with `__spoolTest.fireInstalled({ reason })`. A build with
 * `holdInstall: false` leaves the event alone, so a spec can see the real install.
 */
const HOLD_INSTALL_SOURCE = `
/** @type {((details: { reason: string }) => unknown)[]} */
const installListeners = [];
chrome.runtime.onInstalled.addListener = (listener) => {
  installListeners.push(listener);
};
`;

/** Content of the generated `src/sw/test-hook.js`. Runs inside the service worker. */
const HOOK_SOURCE = `// Generated by e2e/build-extension.mjs. Test only. Observes the service worker.
const MAX_EVENTS = 5000;

${HOLD_INSTALL_MARK}

// Mark the toolbar button: this build is not the real extension.
try {
  void chrome.action.setBadgeText({ text: 'TEST' });
  void chrome.action.setBadgeBackgroundColor({ color: '#d93025' });
} catch {
  // The badge is only a mark. A failure must not stop the tests.
}

/** @type {{ t: number, dir: 'in' | 'out', type: string, ok?: boolean, code?: string, sessionId?: string, intake?: unknown, threw?: string }[]} */
const events = [];
/** @type {Record<string, number>} Counts per "dir type" (for example "out offscreen/add-frame"). */
const counts = {};

/** @param {{ dir: 'in' | 'out', type: string, ok?: boolean }} entry */
function record(entry) {
  const key = entry.dir + ' ' + entry.type;
  counts[key] = (counts[key] ?? 0) + 1;
  if (entry.ok === true) counts[key + ' ok'] = (counts[key + ' ok'] ?? 0) + 1;
  events.push({ t: Date.now(), ...entry });
  if (events.length > MAX_EVENTS) events.shift();
}

/** Short, image-free summary of a reply. */
function summarizeReply(reply) {
  if (typeof reply !== 'object' || reply === null) return { ok: reply === undefined ? undefined : false };
  const out = { ok: reply.ok === true };
  if (reply.ok === false && reply.error) out.code = String(reply.error.code);
  const i = reply.intake;
  if (i && typeof i === 'object') {
    out.intake = {
      index: i.index,
      sliceCount: i.sliceCount,
      totalHeightPx: i.totalHeightPx,
      tileCount: i.tileCount,
      seam: i.seam,
    };
  }
  return out;
}

chrome.runtime.onMessage.addListener((msg) => {
  if (typeof msg === 'object' && msg !== null && typeof msg.type === 'string') {
    record({
      dir: 'in',
      type: msg.type,
      // The session of a message from the page (a UUID, no page data): the tests open the result
      // of a capture by it, because no result tab opens by itself any more.
      sessionId: typeof msg.sessionId === 'string' ? msg.sessionId : undefined,
    });
  }
  return false; // Never answers and never keeps the channel open.
});

const originalSend = chrome.runtime.sendMessage;
chrome.runtime.sendMessage = function (...args) {
  const msg = args[0];
  const type = typeof msg === 'object' && msg !== null ? String(msg.type) : '?';
  const result = originalSend.apply(chrome.runtime, args);
  if (result && typeof result.then === 'function') {
    result.then(
      (reply) => record({ dir: 'out', type, ...summarizeReply(reply) }),
      (error) => record({ dir: 'out', type, ok: false, threw: String(error && error.message) }),
    );
  }
  return result;
};

const originalCapture = chrome.tabs.captureVisibleTab;
chrome.tabs.captureVisibleTab = function (...args) {
  const result = originalCapture.apply(chrome.tabs, args);
  if (result && typeof result.then === 'function') {
    result.then(
      () => record({ dir: 'out', type: 'tabs.captureVisibleTab', ok: true }),
      (error) =>
        record({ dir: 'out', type: 'tabs.captureVisibleTab', ok: false, threw: String(error && error.message) }),
    );
  }
  return result;
};

/** Runs the held onInstalled listeners (none when the build does not hold them). */
function fireInstalled(details) {
  return Promise.all(typeof installListeners === 'undefined' ? [] : installListeners.map((l) => l(details)));
}

globalThis.__spoolTest = { events, counts, fireInstalled };
`;

/** Content of the generated service worker entry (it replaces `src/sw/service-worker.js`). */
const WORKER_SOURCE = `// Generated by e2e/build-extension.mjs. Test only.
import './test-hook.js';
import './service-worker.original.js';
import { startCapture, startShelf } from './start.js';

globalThis.__spoolTest.startCapture = startCapture;
globalThis.__spoolTest.startShelf = startShelf;
`;

/**
 * Content of the generated `src/result/debug-hook.js`. It runs in the result page, next to the
 * page's own script. The import gives the same module instance, so `debugApi` is the object
 * that the page fills.
 */
const DEBUG_HOOK_SOURCE = `// Generated by e2e/build-extension.mjs. Test only. Publishes the debug API of the result page.
import { debugApi } from './result.js';

globalThis.spoolDebug = debugApi;
`;

/** The script tag that is added to the copy of result.html. */
const DEBUG_HOOK_TAG = '<script type="module" src="debug-hook.js"></script>';

// ---------------------------------------------------------------------------------------------
// Pure parts (unit-tested in test/unit/e2e-build.test.js)
// ---------------------------------------------------------------------------------------------

/**
 * The manifest of the test build: the production manifest with host access, and with every mark
 * that tells it apart from the real extension (see "Test build marks" above). All other keys are
 * the production values, so the tests run against the real permissions, CSP and incognito rule.
 * @param {Record<string, any>} manifest The production manifest. It is not changed.
 * @returns {Record<string, any>}
 */
export function patchManifest(manifest) {
  const version = String(manifest['version'] ?? '0');
  return {
    ...manifest,
    name: `${TEST_BUILD_NAME} (v${version}-e2e)`,
    short_name: 'Spool TEST',
    version_name: `${version}-e2e-test`,
    description: 'TEST BUILD for automated tests. Do not install. It can read every site.',
    action: { ...manifest['action'], default_title: 'Spool TEST BUILD (do not install)' },
    host_permissions: [...new Set([...(manifest['host_permissions'] ?? []), '<all_urls>'])],
  };
}

/**
 * Adds the debug hook script after the script tag of result.js.
 * @param {string} html The text of src/result/result.html.
 * @returns {string}
 * @throws {Error} When the page has no tag for `result.js`, or has more than one.
 */
export function addDebugHook(html) {
  const tag = /^([ \t]*)<script\b[^>]*\bsrc="result\.js"[^>]*><\/script>[ \t]*(\r?\n)/gm;
  const found = [...html.matchAll(tag)];
  if (found.length !== 1) {
    throw new Error(
      `${RESULT_HTML_FILE}: expected one <script src="result.js"> line, found ${found.length}. ` +
        'The test build adds the debug hook after it.',
    );
  }
  return html.replace(tag, (line, indent, eol) => `${line}${indent}${DEBUG_HOOK_TAG}${eol}`);
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** @param {string} type @param {Buffer} data @returns {Buffer} One PNG chunk with its CRC. */
function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/**
 * @param {number} width
 * @param {number} height
 * @param {number} channels 3 (RGB) or 4 (RGBA). 8 bits each.
 * @param {Uint8Array} pixels Row by row, `width * height * channels` bytes.
 * @returns {Buffer} A PNG file. Every row has filter type 0.
 */
function encodePng(width, height, channels, pixels) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = channels === 4 ? 6 : 2; // color type. Compression, filter and interlace stay 0.
  const stride = width * channels;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    scanlines.set(pixels.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Swaps the red and the blue channel of a PNG. The blue icon becomes orange. White, black and
 * the alpha channel stay as they are, so the shape and the smooth edges stay as well.
 * @param {Uint8Array} png A PNG file with 8-bit RGB or RGBA pixels (the format of icons/).
 * @returns {Buffer}
 */
export function tintIcon(png) {
  const { width, height, channels, data } = decodePng(png);
  const pixels = Uint8Array.from(data);
  for (let i = 0; i < pixels.length; i += channels) {
    const red = pixels[i] ?? 0;
    pixels[i] = pixels[i + 2] ?? 0;
    pixels[i + 2] = red;
  }
  return encodePng(width, height, channels, pixels);
}

// ---------------------------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------------------------

/**
 * Files that must exist for the extension to load and run. Returns the missing ones.
 * @param {string} root
 * @param {any} manifest
 * @returns {Promise<string[]>}
 */
async function findMissingFiles(root, manifest) {
  const { PATHS } = await import(pathToFileURL(path.join(root, 'src/shared/constants.js')).href);
  /** @type {Set<string>} */
  const wanted = new Set([
    'src/sw/start.js',
    RESULT_SCRIPT_FILE,
    PATHS.serviceWorker,
    PATHS.offscreen,
    PATHS.result,
    PATHS.options,
    ...PATHS.pageScripts,
  ]);
  for (const value of Object.values(manifest.icons ?? {})) wanted.add(String(value));
  for (const value of Object.values(manifest.action?.default_icon ?? {})) wanted.add(String(value));
  if (manifest.background?.service_worker) wanted.add(String(manifest.background.service_worker));
  if (manifest.options_ui?.page) wanted.add(String(manifest.options_ui.page));

  /** @type {string[]} */
  const missing = [];
  for (const file of wanted) {
    try {
      if (!(await stat(path.join(root, file))).isFile()) missing.push(file);
    } catch {
      missing.push(file);
    }
  }
  return missing.sort();
}

/**
 * Throws unless `dir` is missing, empty, or a folder of an earlier test build. The build deletes
 * the folder first, so a wrong `outDir` (for example the repository or a Documents folder) must
 * never be deleted.
 * @param {string} dir
 * @returns {Promise<void>}
 */
async function assertReplaceable(dir) {
  /** @type {string[]} */
  let entries;
  try {
    entries = await readdir(dir);
  } catch (/** @type {any} */ e) {
    if (e?.code === 'ENOENT') return;
    throw e;
  }
  if (entries.length === 0 || entries.includes(BUILD_MARKER_FILE)) return;
  throw new Error(
    `Refusing to replace "${dir}": it has files and no ${BUILD_MARKER_FILE} marker, so it is not ` +
      'a test build. Use an empty or a new folder for the test build.',
  );
}

/**
 * Deletes a test build. Does nothing for a missing folder. Does not delete a folder that has no
 * marker file, so a wrong path cannot delete other files.
 * @param {string} dir
 * @returns {Promise<void>}
 */
export async function removeBuild(dir) {
  try {
    await stat(path.join(dir, BUILD_MARKER_FILE));
  } catch {
    return;
  }
  await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}

/**
 * Builds the test copy of the extension.
 * @param {{ root?: string, outDir?: string, removeOnExit?: boolean, holdInstall?: boolean }} [options]
 *   `outDir`: where to build. The default is a new folder in BUILD_PARENT (below os.tmpdir()).
 *   `removeOnExit`: delete the build when this process exits. The default is true for the
 *   default folder and false for an `outDir`. A kill that gives no `exit` event leaves the folder.
 * @returns {Promise<string>}  Absolute path of the folder to load with --load-extension.
 */
export async function buildExtension(options = {}) {
  const root = path.resolve(options.root ?? REPO_ROOT);
  const removeOnExit = options.removeOnExit ?? options.outDir === undefined;
  const holdInstall = options.holdInstall ?? true;

  /** @type {any} */
  const manifest = JSON.parse(await readFile(path.join(root, 'manifest.json'), 'utf8'));
  const missing = await findMissingFiles(root, manifest);
  if (missing.length > 0) {
    throw new Error(
      `Cannot build the test extension: ${missing.length} file(s) the extension needs do not exist yet:\n` +
        missing.map((f) => `  - ${f}`).join('\n'),
    );
  }
  if (manifest.background?.service_worker !== WORKER_FILE) {
    throw new Error(
      `manifest.json: background.service_worker is "${manifest.background?.service_worker}", ` +
        `the test build expects "${WORKER_FILE}".`,
    );
  }
  const resultSource = await readFile(path.join(root, RESULT_SCRIPT_FILE), 'utf8');
  if (!/export\s+(?:const|let|var)\s+debugApi\b/.test(resultSource)) {
    throw new Error(`${RESULT_SCRIPT_FILE} must export "debugApi": the test build publishes it.`);
  }
  const resultHtml = addDebugHook(await readFile(path.join(root, RESULT_HTML_FILE), 'utf8'));

  /** @type {string} */
  let outDir;
  if (options.outDir === undefined) {
    await mkdir(BUILD_PARENT, { recursive: true });
    outDir = await mkdtemp(path.join(BUILD_PARENT, 'build-'));
  } else {
    outDir = path.resolve(options.outDir);
    await assertReplaceable(outDir);
    await rm(outDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    await mkdir(outDir, { recursive: true });
  }
  if (removeOnExit) {
    const folder = outDir;
    process.once('exit', () => {
      try {
        rmSync(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch {
        // A browser can still hold a file. The folder is in the temporary folder of the OS.
      }
    });
  }

  const note = 'Test build of Spool. Do not install.\n';
  await writeFile(path.join(outDir, BUILD_MARKER_FILE), note);
  await cp(path.join(root, 'src'), path.join(outDir, 'src'), { recursive: true });
  try {
    await cp(path.join(root, 'icons'), path.join(outDir, 'icons'), { recursive: true });
  } catch (/** @type {any} */ e) {
    if (e?.code !== 'ENOENT') throw e;
  }

  // Patch 1: manifest, and icons with another tint.
  const patched = patchManifest(manifest);
  await writeFile(path.join(outDir, 'manifest.json'), JSON.stringify(patched, null, 2) + '\n');
  const iconDir = path.join(outDir, 'icons');
  const icons = await readdir(iconDir).catch(() => /** @type {string[]} */ ([]));
  for (const name of icons.filter((file) => file.endsWith('.png'))) {
    const file = path.join(iconDir, name);
    await writeFile(file, tintIcon(await readFile(file)));
  }

  // Patch 2: service worker wrapper.
  await rm(path.join(outDir, WORKER_FILE));
  await cp(path.join(root, WORKER_FILE), path.join(outDir, ORIGINAL_WORKER_FILE));
  await writeFile(path.join(outDir, WORKER_FILE), WORKER_SOURCE);
  await writeFile(
    path.join(outDir, HOOK_FILE),
    HOOK_SOURCE.replace(HOLD_INSTALL_MARK, holdInstall ? HOLD_INSTALL_SOURCE : ''),
  );

  // Patch 3: debug hook of the result page.
  await writeFile(path.join(outDir, RESULT_HTML_FILE), resultHtml);
  await writeFile(path.join(outDir, DEBUG_HOOK_FILE), DEBUG_HOOK_SOURCE);

  return outDir;
}

// Run as a script: node e2e/build-extension.mjs [outDir]. The build stays (for inspection).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  buildExtension({ removeOnExit: false, ...(process.argv[2] ? { outDir: process.argv[2] } : {}) })
    .then((dir) => console.log(`Test extension built: ${dir}`))
    .catch((e) => {
      console.error(e instanceof Error ? e.message : e);
      process.exitCode = 1;
    });
}
