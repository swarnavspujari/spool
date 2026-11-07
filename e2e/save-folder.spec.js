// @ts-check
/**
 * Where the files go, in a real browser (docs/contracts.md 6.3, 7.3, 7.5, 7.10): the welcome page
 * that opens on install, "Save to Pictures › Screenshots", the Save location row, the reconnect
 * card, the files that Done writes in the chosen folder, and the questions of the toast.
 *
 * What is a stand-in, and why. The folder window of the operating system and the browser prompt
 * for write access cannot be driven from a test. The spec replaces `showDirectoryPicker` on the
 * extension page with a function that returns a folder of the origin private file system (the one
 * real `FileSystemDirectoryHandle` that a test can make), called "Pictures". Everything after the
 * pick is the real code: IndexedDB keeps the handle, the offscreen document reads it, makes
 * `Screenshots` and writes the files. A real folder on disk, the folder window, the prompt, "Allow
 * on every visit" and a permission that lapses are manual checks (see the report of this change).
 *
 * The test build holds back `runtime.onInstalled` (see e2e/build-extension.mjs), so a test does not
 * get a welcome tab that it did not ask for. One spec builds the extension without that hold and
 * sees the real install.
 */
import fs from 'node:fs/promises';
import { buildExtension } from './build-extension.mjs';
import {
  expect,
  launchExtensionContext,
  recordDownloads,
  savedDownloads,
  test,
  waitForResult,
} from './fixtures.js';
import { dismissToast, pressCardButton, waitForText } from './driver.js';
import { captureChatAndFinish, savedFileProblems, waitForCopiedToast } from './post-capture.js';
import { savePathProblems } from './save-check.js';
import { pollUntil } from './util.js';

/** The title of the fixture page chat-inner.html: it is in the names of the saved files. */
const PAGE_TITLE = 'Chat with an inner scroller';

/** @typedef {import('@playwright/test').Page} Page */
/** @typedef {import('@playwright/test').BrowserContext} BrowserContext */
/** @typedef {import('@playwright/test').Worker} Worker */

/**
 * Opens the options page of the test build at an address.
 * @param {BrowserContext} context
 * @param {Worker} serviceWorker
 * @param {string} [hash]
 * @returns {Promise<Page>}
 */
async function openOptions(context, serviceWorker, hash = '') {
  const page = await context.newPage();
  const extensionId = new URL(serviceWorker.url()).host;
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html${hash}`);
  await expect(page.locator('#settings-form')).toHaveAttribute('aria-busy', 'false');
  // The page shows the view of its address a moment later. A click on a button of the other view
  // would wait for ever: the browser keeps the element that it found first, and that one is hidden.
  const welcome = hash === '#welcome' || hash === '#setup';
  await expect(page.locator('body')).toHaveAttribute('data-view', welcome ? 'welcome' : 'settings');
  if (welcome) await expect(page.locator('#welcome-heading')).not.toHaveText('');
  return page;
}

/**
 * Replaces `showDirectoryPicker` on an extension page. The stand-in records its options in
 * `__pickerCalls`, and gives a folder of the origin private file system, or throws.
 * @param {Page} page
 * @param {{ name?: string, throws?: string, missing?: boolean }} behavior
 *   `name`: the folder that the "user" picks. `throws`: a DOMException name (the user closes the
 *   window: AbortError; a blocked folder: SecurityError). `missing`: no picker in this browser.
 */
async function stubPicker(page, behavior) {
  await page.evaluate(({ name, throws, missing }) => {
    const g = /** @type {any} */ (globalThis);
    g.__pickerCalls = [];
    if (missing) {
      Object.defineProperty(g, 'showDirectoryPicker', { value: undefined, configurable: true });
      return;
    }
    Object.defineProperty(g, 'showDirectoryPicker', {
      configurable: true,
      value: async (/** @type {unknown} */ options) => {
        g.__pickerCalls.push(options);
        if (throws) throw new DOMException('A test closed the window.', throws);
        const root = await navigator.storage.getDirectory();
        return root.getDirectoryHandle(name ?? 'Pictures', { create: true });
      },
    });
  }, behavior);
}

/**
 * The options that the page gave to the stand-in picker.
 * @param {Page} page
 * @returns {Promise<any[]>}
 */
function pickerCalls(page) {
  return page.evaluate(() => /** @type {any} */ (globalThis).__pickerCalls ?? []);
}

/**
 * Every file and folder in the origin private file system of the extension, as paths. A folder
 * ends with "/". Sorted.
 * @param {Page} page
 * @returns {Promise<string[]>}
 */
function opfsEntries(page) {
  return page.evaluate(async () => {
    /** @type {string[]} */
    const out = [];
    /** @param {any} dir @param {string} prefix */
    async function walk(dir, prefix) {
      for await (const [name, handle] of dir.entries()) {
        if (handle.kind === 'directory') {
          out.push(`${prefix}${name}/`);
          await walk(handle, `${prefix}${name}/`);
        } else {
          out.push(`${prefix}${name}`);
        }
      }
    }
    await walk(await navigator.storage.getDirectory(), '');
    return out.sort();
  });
}

/**
 * A file of the origin private file system, as bytes.
 * @param {Page} page
 * @param {string} path
 * @returns {Promise<Buffer>}
 */
async function readOpfsFile(page, path) {
  const base64 = await page.evaluate(async (wanted) => {
    const parts = wanted.split('/');
    const name = /** @type {string} */ (parts.pop());
    let dir = await navigator.storage.getDirectory();
    for (const part of parts) dir = await dir.getDirectoryHandle(part);
    const file = await (await dir.getFileHandle(name)).getFile();
    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
      reader.readAsDataURL(file);
    });
  }, path);
  return Buffer.from(String(base64), 'base64');
}

/**
 * Removes a folder of the origin private file system: the user deleted it.
 * @param {Page} page
 * @param {string} name
 */
function removeOpfsFolder(page, name) {
  return page.evaluate(async (wanted) => {
    const root = await navigator.storage.getDirectory();
    await root.removeEntry(wanted, { recursive: true });
  }, name);
}

/**
 * Sets up "Pictures › Screenshots" through the welcome page, with the stand-in picker.
 * @param {BrowserContext} context
 * @param {Worker} serviceWorker
 * @returns {Promise<Page>}  The options page. It stays open: the file system is read through it.
 */
async function setUpPictures(context, serviceWorker) {
  const page = await openOptions(context, serviceWorker, '#welcome');
  await stubPicker(page, { name: 'Pictures' });
  await page.getByRole('button', { name: 'Save to Pictures › Screenshots' }).click();
  await expect(page.locator('#welcome-heading')).toHaveText("You're set.");
  return page;
}

// ---------------------------------------------------------------------------------------------
// The welcome page opens on install
// ---------------------------------------------------------------------------------------------

test('welcome: a new install opens the welcome page by itself', async () => {
  // A build that does not hold back the install event: the real thing, in a new profile.
  const extensionDir = await buildExtension({ holdInstall: false });
  const { context, profileDir } = await launchExtensionContext({
    extensionDir,
    width: 1000,
    height: 800,
    scale: 1,
  });
  try {
    const welcome = await pollUntil(
      () => context.pages().find((p) => p.url().endsWith('/src/options/options.html#welcome')),
      { timeoutMs: 20_000, intervalMs: 100, message: 'no welcome tab opened after the install' },
    );
    await expect(welcome.locator('#welcome-heading')).toHaveText('One click and Spool is ready.');
    await expect(welcome).toHaveTitle('Welcome to Spool');
    // One welcome tab, and not a second one a moment later.
    await welcome.waitForTimeout(1500);
    expect(context.pages().filter((p) => p.url().includes('#welcome'))).toHaveLength(1);
  } finally {
    await context.close().catch(() => undefined);
    await fs
      .rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      .catch(() => undefined);
  }
});

test('welcome: an update or a browser update opens nothing, and an install opens the page', async ({
  context,
  serviceWorker,
}) => {
  const before = context.pages().length;
  for (const reason of ['update', 'chrome_update', 'shared_module_update']) {
    await serviceWorker.evaluate((r) => globalThis.__spoolTest.fireInstalled({ reason: r }), reason);
  }
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(context.pages(), 'no new tab').toHaveLength(before);

  const opened = context.waitForEvent('page');
  await serviceWorker.evaluate(() => globalThis.__spoolTest.fireInstalled({ reason: 'install' }));
  const welcome = await opened;
  await welcome.waitForLoadState();
  expect(welcome.url()).toMatch(/\/src\/options\/options\.html#welcome$/);
  await expect(welcome.locator('#welcome-heading')).toHaveText('One click and Spool is ready.');
});

// ---------------------------------------------------------------------------------------------
// The welcome page
// ---------------------------------------------------------------------------------------------

test('welcome: three choices, 44 px high, reached with the keyboard, no side scroll', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '#welcome');
  await stubPicker(page, { name: 'Pictures' });
  await expect(page.locator('#welcome')).toBeVisible();
  await expect(page.locator('#settings-view')).toBeHidden();

  const names = ['Save to Pictures › Screenshots', 'Choose another folder', 'Keep using Downloads'];
  for (const name of names) {
    const box = await page.getByRole('button', { name }).boundingBox();
    expect(box, name).not.toBeNull();
    expect(box?.height ?? 0, `${name} is at least 44 px high`).toBeGreaterThanOrEqual(44);
  }
  // The main choice is the first stop of the Tab key, and Enter does it.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: names[0] ?? '' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: names[1] ?? '' })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Enter');
  await expect(page.locator('#welcome-heading')).toHaveText("You're set.");
  // The focus is on a control, so the keyboard user does not start again at the top.
  await expect(page.getByRole('button', { name: 'Change folder' })).toBeFocused();

  const scrolls = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
  expect(scrolls, 'no horizontal scroll').toBe(false);
});

test('welcome: tells what Chrome will ask, what stays on disk, and which key pastes', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '#welcome');
  const text = (await page.locator('#welcome').innerText()).replace(/\s+/g, ' ');
  expect(text).toContain('A folder window opens in Pictures.');
  expect(text).toContain('then Edit files');
  expect(text).toContain('Spool only ever writes inside Screenshots.');
  // What Spool keeps, on the first page that people see.
  expect(text).toContain('Each capture is saved as files and copied to your clipboard.');
  expect(text).toContain('your clipboard history may keep the image');
  // The layout and the keys.
  expect(text).toContain('Every capture gives you');
  expect(text).toContain('Spool for AI');
  expect(text).toMatch(/screenshot-01-of-03\.png/);
  expect(text).toContain('Your three moves');
  expect(text).toMatch(/Use (Ctrl|⌘)\+?V, not (Ctrl\+Shift\+V|⌘⇧V): that one pastes text only/);
  // The keys are the ones of the browser, not words that the page made up.
  const keys = await serviceWorker.evaluate(async () =>
    (await chrome.commands.getAll()).map((c) => c.shortcut ?? ''),
  );
  for (const key of keys.filter((k) => k !== '')) expect(text).toContain(key);
  // The link goes to the settings.
  await page.getByRole('button', { name: 'Change this in Settings' }).click();
  await expect(page.locator('#settings-view')).toBeVisible();
  await expect(page.locator('#welcome')).toBeHidden();
});

test('welcome: "Save to Pictures › Screenshots" makes Screenshots below the picked folder', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '#welcome');
  await stubPicker(page, { name: 'Pictures' });
  await page.getByRole('button', { name: 'Save to Pictures › Screenshots' }).click();

  await expect(page.locator('#welcome-heading')).toHaveText("You're set.");
  await expect(page.locator('#welcome-lead')).toContainText('Screenshots now save to Pictures › Screenshots.');
  await expect(page.locator('#welcome-callout')).toContainText('Allow on every visit');
  expect(await pickerCalls(page), 'the picker opens in Pictures with its own id').toEqual([
    { id: 'spool-pictures', mode: 'readwrite', startIn: 'pictures' },
  ]);
  expect(await opfsEntries(page)).toEqual(['Pictures/', 'Pictures/Screenshots/']);

  // The folder row shows the same place, and the choice is still there after a reload.
  await page.goto(page.url().replace('#welcome', '#save'));
  await expect(page.locator('#settings-form')).toHaveAttribute('aria-busy', 'false');
  await page.reload();
  await expect(page.locator('#folder-name')).toHaveText('Pictures › Screenshots');
  await expect(page.locator('#folder-help')).toHaveText('Connected.');
});

test('welcome: a pick that is already named Screenshots is used as it is', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '#welcome');
  await stubPicker(page, { name: 'Screenshots' });
  await page.getByRole('button', { name: 'Save to Pictures › Screenshots' }).click();
  await expect(page.locator('#welcome-heading')).toHaveText("You're set.");
  await expect(page.locator('#welcome-lead')).toContainText('Screenshots now save to Screenshots.');
  expect(await opfsEntries(page), 'no Screenshots inside Screenshots').toEqual(['Screenshots/']);
});

test('welcome: "Choose another folder" keeps the folder as it is, with the id of the other picker', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '#welcome');
  await stubPicker(page, { name: 'Work' });
  await page.getByRole('button', { name: 'Choose another folder' }).click();
  await expect(page.locator('#welcome-heading')).toHaveText("You're set.");
  await expect(page.locator('#welcome-lead')).toContainText('Screenshots now save to Work.');
  expect(await pickerCalls(page)).toEqual([{ id: 'spool-shots', mode: 'readwrite', startIn: 'pictures' }]);
  expect(await opfsEntries(page), 'nothing is made in the folder').toEqual(['Work/']);
});

test('welcome: closing the folder window changes nothing and says so', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '#welcome');
  await stubPicker(page, { throws: 'AbortError' });
  await page.getByRole('button', { name: 'Save to Pictures › Screenshots' }).click();
  await expect(page.locator('#welcome-message')).toContainText('No folder was chosen. Nothing changed.');
  await expect(page.locator('#welcome-heading')).toHaveText('One click and Spool is ready.');
  await expect(page.getByRole('button', { name: 'Save to Pictures › Screenshots' })).toBeEnabled();
  expect(await opfsEntries(page)).toEqual([]);
});

test('welcome: a folder that the browser blocks says so, and the choices stay', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '#welcome');
  await stubPicker(page, { throws: 'SecurityError' });
  await page.getByRole('button', { name: 'Choose another folder' }).click();
  const message = page.locator('#welcome-message');
  await expect(message).toContainText('Your browser blocks that folder.');
  await expect(message).toContainText('Pictures works.');
  await expect(message).toHaveAttribute('role', 'alert');
  await expect(page.getByRole('button', { name: 'Save to Pictures › Screenshots' })).toBeEnabled();
});

test('welcome: "Keep using Downloads" ends the question on the toast and keeps Downloads', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '#welcome');
  await page.getByRole('button', { name: 'Keep using Downloads' }).click();
  await expect(page.locator('#welcome-heading')).toHaveText('Downloads it is.');
  await expect(page.locator('#welcome-lead')).toContainText('Screenshots save to Downloads › Spool.');
  const asks = await serviceWorker.evaluate(
    async () => (await chrome.storage.local.get('saveFolderAsks'))['saveFolderAsks'],
  );
  expect(asks, 'the toast does not ask again').toBe(3);
  await page.getByRole('button', { name: 'Choose a folder instead' }).click();
  await expect(page.locator('#welcome-heading')).toHaveText('One click and Spool is ready.');
});

test('welcome: a browser without a folder picker uses Downloads and shows no choice', async ({
  context,
  serviceWorker,
}) => {
  const page = await context.newPage();
  await page.addInitScript(() => {
    Object.defineProperty(globalThis, 'showDirectoryPicker', { value: undefined, configurable: true });
  });
  const extensionId = new URL(serviceWorker.url()).host;
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html#welcome`);
  await expect(page.locator('#welcome-heading')).toHaveText("This browser can't pick folders.");
  await expect(page.locator('#welcome-lead')).toContainText('Screenshots save to Downloads › Spool instead.');
  await expect(page.locator('#welcome-actions button')).toHaveCount(0);
});

// ---------------------------------------------------------------------------------------------
// The Save location row and the reconnect card
// ---------------------------------------------------------------------------------------------

test('settings: the row goes from Downloads to the folder and back', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '');
  await stubPicker(page, { name: 'Pictures' });
  await expect(page.locator('#folder-name')).toHaveText('Downloads › Spool');
  await expect(page.locator('#folder-help')).toHaveText('Default until you pick.');
  await expect(page.getByRole('button', { name: 'Choose another folder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Use Downloads instead' })).toBeHidden();

  await page.getByRole('button', { name: 'Save to Pictures › Screenshots' }).click();
  await expect(page.locator('#folder-name')).toHaveText('Pictures › Screenshots');
  await expect(page.locator('#folder-help')).toHaveText('Connected.');
  await expect(page.locator('#folder-note')).toContainText('Allow on every visit');
  await expect(page.locator('#status')).toHaveText('Save folder set to Pictures › Screenshots.');
  await expect(page.getByRole('button', { name: 'Change folder' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save to Pictures › Screenshots' })).toBeHidden();

  await page.getByRole('button', { name: 'Use Downloads instead' }).click();
  await expect(page.locator('#folder-name')).toHaveText('Downloads › Spool');
  await expect(page.locator('#status')).toHaveText('Spool saves to Downloads.');
});

test('settings: a blocked folder is a plain sentence in the status line', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker, '');
  await stubPicker(page, { throws: 'SecurityError' });
  await page.getByRole('button', { name: 'Save to Pictures › Screenshots' }).click();
  await expect(page.locator('#status')).toHaveText(
    'Your browser blocks that folder. Choose Pictures or a folder inside it.',
  );
  await expect(page.locator('#folder-name')).toHaveText('Downloads › Spool');
});

test('reconnect: with a folder that is there the card says it is back, and with none it stays away', async ({
  context,
  serviceWorker,
}) => {
  const none = await openOptions(context, serviceWorker, '#reconnect');
  await expect(none.locator('#reconnect')).toBeHidden();
  await setUpPictures(context, serviceWorker);
  const page = await openOptions(context, serviceWorker, '#reconnect');
  await expect(page.locator('#reconnect')).toBeVisible();
  await expect(page.locator('#reconnect-heading')).toHaveText('Reconnected.');
  await expect(page.locator('#reconnect-lead')).toHaveText('New screenshots save to Pictures › Screenshots.');
});

test('reconnect: a folder that was deleted says so, and offers to pick it again', async ({
  context,
  serviceWorker,
}) => {
  const welcome = await setUpPictures(context, serviceWorker);
  await removeOpfsFolder(welcome, 'Pictures');
  const page = await openOptions(context, serviceWorker, '#reconnect');
  await expect(page.locator('#reconnect-heading')).toHaveText('That folder is gone.');
  await expect(page.locator('#reconnect-lead')).toHaveText('It may have moved or been deleted. Pick it again.');
  // The row says the same, with the button that fixes it.
  await expect(page.locator('#folder-name')).toHaveText('Folder not found');
  await expect(page.locator('#folder-help')).toHaveText('Saving to Downloads › Spool until you pick again.');
  await stubPicker(page, { name: 'Pictures' });
  await page.locator('#reconnect-actions').getByRole('button', { name: 'Save to Pictures › Screenshots' }).click();
  await expect(page.locator('#reconnect-heading')).toHaveText('Reconnected.');
  await expect(page.locator('#folder-name')).toHaveText('Pictures › Screenshots');
  expect(await opfsEntries(page)).toEqual(['Pictures/', 'Pictures/Screenshots/']);
});

// ---------------------------------------------------------------------------------------------
// Done
// ---------------------------------------------------------------------------------------------

test('done: the files go to Pictures › Screenshots, the full image flat and the AI screenshots below', async ({
  page,
  context,
  server,
  serviceWorker,
}) => {
  const options = await setUpPictures(context, serviceWorker);
  await recordDownloads(context);
  const startedAt = Date.now();
  await page.bringToFront();
  await captureChatAndFinish(page, server, { bands: 900, auto: true });

  expect(await waitForText(page, /Saved to Pictures › Screenshots$/, 90_000)).toBeTruthy();
  const result = await waitForResult(context);
  const summary = await result.offscreenSummary();
  const tileCount = result.tilePlan.length;
  expect(tileCount, 'a long capture has several AI screenshots').toBeGreaterThan(1);
  expect(summary.save).toMatchObject({
    location: 'folder',
    label: 'Pictures/Screenshots',
    files: 1 + tileCount,
    needsPermission: false,
  });

  const files = (await opfsEntries(options)).filter((entry) => !entry.endsWith('/'));
  expect(
    savePathProblems(files, {
      folder: 'Pictures/Screenshots',
      title: PAGE_TITLE,
      tileCount,
      notBefore: startedAt,
      notAfter: Date.now() + 2000,
    }),
    'files in the folder',
  ).toEqual([]);
  expect(files.every((f) => f.includes('/Spool for AI/') || /^Pictures\/Screenshots\/[^/]+\.png$/.test(f))).toBe(
    true,
  );
  // The full image in the folder is the full image of the capture, byte for byte.
  const flat = files.find((f) => !f.includes('/Spool for AI/')) ?? '';
  expect(Buffer.compare(await readOpfsFile(options, flat), Buffer.from(await result.fullPng()))).toBe(0);
  // Nothing went to Downloads.
  expect(await savedDownloads(context), 'no download').toEqual([]);
  // The toast offers no question and no link to change a folder that works.
  const toastTexts = await page.evaluate(() => document.body.innerText);
  expect(toastTexts).not.toContain('Reconnect');
  await dismissToast(page);
});

test('done: the first capture without a folder asks "Save to Pictures › Screenshots?", and Set up opens the page', async ({
  page,
  context,
  server,
}) => {
  await recordDownloads(context);
  const startedAt = Date.now();
  await captureChatAndFinish(page, server, { bands: 100 });
  expect(await waitForCopiedToast(page)).toBe('Copied and saved');
  await waitForText(page, 'Save to Pictures › Screenshots?');
  await waitForText(page, /Saved to Downloads › Spool$/);

  const opened = context.waitForEvent('page');
  await pressCardButton(page, 'Set up');
  const setup = await opened;
  await setup.waitForLoadState();
  expect(setup.url()).toMatch(/\/src\/options\/options\.html#setup$/);
  await expect(setup.locator('#welcome-heading')).toHaveText('Where should screenshots go?');
  await expect(setup.getByRole('button', { name: 'Save to Pictures › Screenshots' })).toBeVisible();

  // The capture itself went to Downloads, as before, in the new layout.
  const result = await waitForResult(context);
  expect(await savedFileProblems(context, result, { title: PAGE_TITLE, notBefore: startedAt }), 'saved files').toEqual(
    [],
  );
});

test('done: the link "Change" is on every save in Downloads and opens the setup page', async ({
  page,
  context,
  server,
  serviceWorker,
}) => {
  // The question is over (the user chose Downloads once), the link stays.
  await serviceWorker.evaluate(() => chrome.storage.local.set({ saveFolderAsks: 3 }));
  await captureChatAndFinish(page, server, { bands: 100 });
  expect(await waitForCopiedToast(page)).toBe('Copied and saved');
  await waitForText(page, /Saved to Downloads › Spool$/);
  const opened = context.waitForEvent('page');
  await pressCardButton(page, 'Change the save location');
  const setup = await opened;
  await setup.waitForLoadState();
  expect(setup.url()).toMatch(/#setup$/);
});

test('done: a folder that is gone goes to Downloads and the toast offers Reconnect', async ({
  page,
  context,
  server,
  serviceWorker,
}) => {
  const options = await setUpPictures(context, serviceWorker);
  await removeOpfsFolder(options, 'Pictures'); // The user deleted Pictures, or the drive left.
  await recordDownloads(context);
  const startedAt = Date.now();
  await page.bringToFront();
  await captureChatAndFinish(page, server, { bands: 100 });

  expect(await waitForCopiedToast(page)).toBe('Copied and saved');
  await waitForText(page, 'Reconnect Pictures › Screenshots?');
  await waitForText(page, /Saved to Downloads › Spool this time$/);
  const result = await waitForResult(context);
  expect(await savedFileProblems(context, result, { title: PAGE_TITLE, notBefore: startedAt }), 'saved files').toEqual(
    [],
  );
  const summary = await result.offscreenSummary();
  expect(summary.save).toMatchObject({
    location: 'downloads',
    needsPermission: true,
    folderLabel: 'Pictures/Screenshots',
  });

  const opened = context.waitForEvent('page');
  await pressCardButton(page, 'Reconnect');
  const reconnect = await opened;
  await reconnect.waitForLoadState();
  expect(reconnect.url()).toMatch(/\/src\/options\/options\.html#reconnect$/);
  await expect(reconnect.locator('#reconnect-heading')).toHaveText('That folder is gone.');
});
