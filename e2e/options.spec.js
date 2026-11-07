// @ts-check
/**
 * The Options page in a real browser (docs/contracts.md section 6.3): the Shortcut group shows
 * both commands with the keys that the browser has now, the buttons have names that say
 * what they change, and an empty folder name gets a plain sentence. The folder row, the
 * welcome page and the reconnect card are in save-folder.spec.js.
 */
import { expect, test } from './fixtures.js';

/**
 * Opens the Options page of the test build and waits until the shortcuts are read.
 * @param {import('@playwright/test').BrowserContext} context
 * @param {import('@playwright/test').Worker} serviceWorker
 */
async function openOptions(context, serviceWorker) {
  const page = await context.newPage();
  const extensionId = new URL(serviceWorker.url()).host;
  await page.goto(`chrome-extension://${extensionId}/src/options/options.html`);
  await expect(page.locator('#settings-form')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#shortcut-start')).not.toHaveText('Loading…');
  await expect(page.locator('#shortcut-insert')).not.toHaveText('Loading…');
  return page;
}

test('options: the Shortcut group shows both commands with the keys of the browser', async ({
  context,
  serviceWorker,
}) => {
  const commands = await serviceWorker.evaluate(async () =>
    (await chrome.commands.getAll()).map((c) => ({ name: c.name, shortcut: c.shortcut ?? '' })),
  );
  const keyOf = (/** @type {string} */ name) => commands.find((c) => c.name === name)?.shortcut ?? '';
  const page = await openOptions(context, serviceWorker);

  // One row for each command. A key shows as keycaps with "+", no key shows "Not set".
  for (const [id, command] of [
    ['shortcut-start', 'start-capture'],
    ['shortcut-insert', 'insert-capture'],
  ]) {
    const key = keyOf(String(command));
    const row = page.locator(`#${id}`);
    if (key === '') {
      await expect(row).toHaveText('Not set');
    } else {
      const caps = key.split('+').map((part) => part.trim());
      await expect(row.locator('kbd')).toHaveText(caps);
      await expect(row).toHaveText(caps.join('+'));
    }
  }
  await expect(page.getByText('Start Spool', { exact: true })).toBeVisible();
  await expect(page.getByText('Insert last capture', { exact: true })).toBeVisible();
  await page.close();
});

test('options: the buttons say what they change', async ({ context, serviceWorker }) => {
  const page = await openOptions(context, serviceWorker);
  // Two shortcut rows: two buttons with the same name. The row says which one it is.
  const changeShortcut = page.getByRole('button', { name: 'Change shortcut' });
  await expect(changeShortcut).toHaveCount(2);
  await expect(changeShortcut.nth(0)).toHaveAccessibleDescription('Start Spool');
  await expect(changeShortcut.nth(1)).toHaveAccessibleDescription('Insert last capture');
  // No folder is chosen in a new profile: the main button says where it saves, the other one
  // says what it picks, and "Change" alone does not exist as a name.
  await expect(page.getByRole('button', { name: 'Save to Pictures › Screenshots' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Choose another folder' })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Change folder' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change', exact: true })).toHaveCount(0);
  await page.close();
});

test('options: an empty folder name says what Spool used, as a plain sentence', async ({
  context,
  serviceWorker,
}) => {
  const page = await openOptions(context, serviceWorker);
  await page.locator('#field-folderName').fill('');
  await page.locator('#save-settings').click();
  await expect(page.locator('#status')).toHaveText(
    'Settings saved. The folder name was empty, so Spool used "Spool".',
  );
  await expect(page.locator('#field-folderName')).toHaveValue('Spool');
  await page.close();
});
