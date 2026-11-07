// @ts-check
/**
 * Tests for the Options polish: the plain sentence for an
 * empty value, the accessible name of the folder button, and the two rows of the Shortcut group
 * in options.html. options.js has no unit test (it needs a page), so the markup and the pure
 * form model carry the checks; the sentences come from form-model.js.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { COMMANDS } from '../../src/shared/constants.js';
import {
  FIELDS,
  describeAdjustments,
  describeSaveFolder,
  findAdjustments,
  formToSettings,
  settingsToForm,
} from '../../src/options/form-model.js';
import { DEFAULT_SETTINGS } from '../../src/shared/settings.js';

const HTML = readFileSync(new URL('../../src/options/options.html', import.meta.url), 'utf8');
const OPTIONS_JS = readFileSync(new URL('../../src/options/options.js', import.meta.url), 'utf8');

/**
 * The opening tag of the element with this id.
 * @param {string} id
 * @returns {string}
 */
function tagOf(id) {
  const match = new RegExp(`<[a-z]+\\s[^>]*\\bid="${id}"[^>]*>`, 'i').exec(HTML);
  assert.ok(match, `options.html has the element #${id}`);
  return match[0];
}

// ---------------------------------------------------------------------------------------------
// An empty value is a plain sentence
// ---------------------------------------------------------------------------------------------

test('an empty folder name says what Spool used, as a plain sentence', () => {
  const entered = { ...settingsToForm(DEFAULT_SETTINGS), folderName: '   ' };
  const saved = formToSettings(entered);
  const adjustments = findAdjustments(entered, saved);
  assert.equal(adjustments.length, 1);
  assert.equal(describeAdjustments(adjustments), 'The folder name was empty, so Spool used "Spool".');
});

test('the sentence names the folder that Spool used, not a fixed word', () => {
  assert.equal(
    describeAdjustments([
      { key: 'folderName', label: 'Downloads folder name', entered: '', saved: 'My Shots' },
    ]),
    'The folder name was empty, so Spool used "My Shots".',
  );
});

test('an empty number says the value with its unit', () => {
  assert.equal(
    describeAdjustments([{ key: 'settleMs', label: 'Wait after each scroll', entered: '', saved: '350' }]),
    'The wait after each scroll was empty, so Spool used 350 ms.',
  );
  assert.equal(
    describeAdjustments([{ key: 'maxHeightCss', label: 'Maximum length', entered: '', saved: '40000' }]),
    'The maximum length was empty, so Spool used 40,000 px.',
  );
});

test('no sentence says "nothing became"', () => {
  for (const field of FIELDS) {
    const saved = String(settingsToForm(DEFAULT_SETTINGS)[field.key]);
    const text = describeAdjustments([{ key: field.key, label: field.label, entered: '', saved }]);
    assert.ok(!/nothing became/.test(text), `${field.key}: ${text}`);
    assert.match(text, /was empty, so Spool used /);
  }
});

test('a value that was moved into the limits keeps its count line, singular and plural', () => {
  assert.equal(
    describeAdjustments([
      { key: 'overlapCss', label: 'Overlap between steps', entered: '5', saved: '16' },
    ]),
    'Spool changed 1 value to fit the limits. Overlap between steps: 5 became 16.',
  );
  assert.equal(
    describeAdjustments([
      { key: 'overlapCss', label: 'Overlap between steps', entered: '5', saved: '16' },
      { key: 'maxHeightCss', label: 'Maximum length', entered: '1e3', saved: '40000' },
    ]),
    'Spool changed 2 values to fit the limits. Overlap between steps: 5 became 16. ' +
      'Maximum length: 1e3 became 40000.',
  );
});

test('an empty value does not count as a change to fit the limits', () => {
  const text = describeAdjustments([
    { key: 'overlapCss', label: 'Overlap between steps', entered: '5', saved: '16' },
    { key: 'folderName', label: 'Downloads folder name', entered: '', saved: 'Spool' },
  ]);
  assert.equal(
    text,
    'Spool changed 1 value to fit the limits. Overlap between steps: 5 became 16. ' +
      'The folder name was empty, so Spool used "Spool".',
  );
});

test('the buttons of the folder row say what they change', () => {
  const none = describeSaveFolder({ label: null, permission: 'prompt', folderName: 'Spool' });
  assert.equal(none.primary?.label, 'Save to Pictures › Screenshots', 'the text is the name');
  assert.equal(none.showChange, false, '"Change folder" needs a folder to change');
  const chosen = describeSaveFolder({ label: 'Pictures', permission: 'granted', folderName: 'Spool' });
  assert.equal(chosen.showChange, true);
});

test('the Downloads place in the folder row uses the one separator', () => {
  const none = describeSaveFolder({ label: null, permission: 'prompt', folderName: 'Spool' });
  assert.equal(none.title, 'Downloads › Spool');
  const prompt = describeSaveFolder({ label: 'Pictures', permission: 'prompt', folderName: 'Spool' });
  assert.ok(prompt.help.includes('Saving to Downloads › Spool until then.'));
});

// ---------------------------------------------------------------------------------------------
// The Shortcut group
// ---------------------------------------------------------------------------------------------

test('the Shortcut group has a row for each command, each with its own value', () => {
  for (const name of ['start', 'insert']) {
    assert.match(tagOf(`shortcut-${name}`), /aria-live="polite"/);
    tagOf(`label-shortcut-${name}`);
  }
  assert.ok(HTML.includes('>Start Spool<'));
  assert.ok(HTML.includes('>Insert last capture<'));
});

test('each Change button of the shortcuts is named "Change shortcut" and says which row it is in', () => {
  for (const name of ['start', 'insert']) {
    const tag = tagOf(`change-shortcut-${name}`);
    assert.match(tag, /aria-label="Change shortcut"/);
    assert.match(tag, new RegExp(`aria-describedby="label-shortcut-${name}"`));
  }
  assert.ok(!/id="change-shortcut"/.test(HTML), 'the old single button is gone');
});

test('options.js reads both commands of the manifest and shows "Not set" for a command with no key', () => {
  assert.equal(COMMANDS.START, 'start-capture');
  assert.equal(COMMANDS.INSERT, 'insert-capture');
  assert.match(OPTIONS_JS, /command: COMMANDS\.START/);
  assert.match(OPTIONS_JS, /command: COMMANDS\.INSERT/);
  assert.match(OPTIONS_JS, /chrome\.commands\.getAll\(\)/);
  assert.match(OPTIONS_JS, /'Not set'/);
});
