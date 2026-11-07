// @ts-check
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { TILE_TIERS } from '../../src/shared/constants.js';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, normalizeSettings } from '../../src/shared/settings.js';
import {
  FIELDS,
  FOLDER_NAME_MAX_LENGTH,
  GROUPS,
  describeAdjustments,
  describeSaveFolder,
  fieldHint,
  findAdjustments,
  formToSettings,
  formatValue,
  numberOptions,
  optionText,
  parseNumberInput,
  settingsToForm,
  settingsWarnings,
  shortcutParts,
} from '../../src/options/form-model.js';

/** @typedef {import('../../src/shared/types.js').Settings} Settings */

const SETTING_KEYS = Object.keys(DEFAULT_SETTINGS);

/**
 * Deterministic random numbers, so a failure is easy to repeat.
 * @param {number} seed
 */
function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/** @param {string} text */
function sentences(text) {
  return text.split(/(?<=[.!?])\s+/).filter((s) => s.trim() !== '');
}

/** @param {string} text */
function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// ---------------------------------------------------------------------------------------------
// Field metadata
// ---------------------------------------------------------------------------------------------

test('fields: one field for each setting, in the order of the form', () => {
  assert.deepEqual(
    FIELDS.map((f) => f.key),
    [
      'overlapCss',
      'settleMs',
      'maxHeightCss',
      'hideOverlays',
      'tileTier',
      'saveTiles',
      'saveFull',
      'copyOnDone',
      'folderName',
    ],
  );
  assert.deepEqual([...FIELDS.map((f) => f.key)].sort(), [...SETTING_KEYS].sort());
});

test('fields: every field has a known group, a label and help text', () => {
  /** @type {string[]} */
  const groupIds = GROUPS.map((g) => g.id);
  assert.equal(new Set(groupIds).size, groupIds.length);
  for (const field of FIELDS) {
    assert.ok(groupIds.includes(field.group), `${field.key}: unknown group ${field.group}`);
    assert.ok(field.label.length > 0, `${field.key}: no label`);
    assert.ok(field.help.length > 0, `${field.key}: no help`);
    assert.match(field.key, /^[A-Za-z]+$/, 'key is safe for use in an element id');
  }
  for (const group of GROUPS) {
    assert.ok(
      FIELDS.some((f) => f.group === group.id),
      `group ${group.id} is empty`,
    );
  }
});

test('fields: number fields use the limits and defaults of the settings module', () => {
  for (const field of FIELDS) {
    if (field.type !== 'number') continue;
    const limits = SETTINGS_LIMITS[/** @type {keyof typeof SETTINGS_LIMITS} */ (field.key)];
    assert.deepEqual([field.min, field.max], [...limits], field.key);
    assert.equal(field.defaultValue, DEFAULT_SETTINGS[field.key], field.key);
    assert.ok(field.min < field.max && field.step >= 1);
    assert.ok(field.unit.length > 0);
  }
  assert.equal(FIELDS.filter((f) => f.type === 'number').length, 3);
});

test('fields: tile size options match the tiers in the constants', () => {
  const tier = FIELDS.find((f) => f.key === 'tileTier');
  assert.ok(tier && tier.type === 'choice');
  assert.deepEqual(
    tier.options.map((o) => o.value),
    Object.keys(TILE_TIERS),
  );
  assert.deepEqual(
    tier.options.map(optionText),
    ['High resolution (current models)', 'Standard (older models)'],
  );
  assert.equal(tier.defaultValue, DEFAULT_SETTINGS.tileTier);
  // Each card names the long edge of its tier, from the constants.
  for (const option of tier.options) {
    const limit = TILE_TIERS[/** @type {keyof typeof TILE_TIERS} */ (option.value)];
    assert.ok(option.detail?.includes(limit.maxLongEdgePx.toLocaleString('en-US')), option.value);
  }
  assert.match(tier.options[0]?.detail ?? '', /fewer screenshots/);
  assert.match(tier.options[1]?.detail ?? '', /more screenshots/);
});

test('fields: number presets are in the limits, in order, and include the default', () => {
  for (const field of FIELDS) {
    if (field.type !== 'number') continue;
    const presets = [...field.presets];
    assert.ok(presets.length >= 3, field.key);
    assert.deepEqual(presets, [...presets].sort((a, b) => a - b), `${field.key}: ascending`);
    assert.equal(new Set(presets).size, presets.length, `${field.key}: no repeats`);
    assert.ok(presets.includes(field.defaultValue), `${field.key}: has the default`);
    for (const n of presets) {
      assert.ok(n >= field.min && n <= field.max, `${field.key}: ${n} is in the limits`);
      assert.equal(formToSettings({ [field.key]: String(n) })[field.key], n, `${field.key} ${n}`);
    }
  }
});

test('fields: the groups are Capture, Output and Save location', () => {
  assert.deepEqual(
    GROUPS.map((g) => g.title),
    ['Capture', 'Output', 'Save location'],
  );
  const groupOf = Object.fromEntries(FIELDS.map((f) => [f.key, f.group]));
  assert.deepEqual(groupOf, {
    overlapCss: 'capture',
    settleMs: 'capture',
    maxHeightCss: 'capture',
    hideOverlays: 'capture',
    tileTier: 'output',
    saveTiles: 'output',
    saveFull: 'output',
    copyOnDone: 'output',
    folderName: 'location',
  });
});

test('formatValue: a unit after the number, and seconds from 1 s', () => {
  assert.equal(formatValue(80, 'px'), '80 px');
  assert.equal(formatValue(20_000, 'px'), '20,000 px');
  assert.equal(formatValue(0, 'ms'), '0 ms');
  assert.equal(formatValue(350, 'ms'), '350 ms');
  assert.equal(formatValue(999, 'ms'), '999 ms');
  assert.equal(formatValue(1000, 'ms'), '1 s');
  assert.equal(formatValue(1500, 'ms'), '1.5 s');
  assert.equal(formatValue(2000, 'ms'), '2 s');
});

test('numberOptions: the presets, and a value that is not a preset stays in its place', () => {
  const overlap = FIELDS.find((f) => f.key === 'overlapCss');
  assert.ok(overlap && overlap.type === 'number');
  const values = (/** @type {unknown} */ current) =>
    numberOptions(overlap, current).map((o) => o.value);
  assert.deepEqual(values(80), ['32', '64', '80', '96', '128']);
  assert.deepEqual(values('64'), ['32', '64', '80', '96', '128']);
  assert.deepEqual(values(100), ['32', '64', '80', '96', '100', '128']);
  assert.deepEqual(values('400'), ['32', '64', '80', '96', '128', '400']);
  assert.deepEqual(values('16'), ['16', '32', '64', '80', '96', '128']);
  // Nothing usable: only the presets.
  assert.deepEqual(values(''), ['32', '64', '80', '96', '128']);
  assert.deepEqual(values(undefined), ['32', '64', '80', '96', '128']);
  assert.deepEqual(numberOptions(overlap, 100).find((o) => o.value === '100'), {
    value: '100',
    label: '100 px',
  });
});

test('numberOptions: every default is one of the entries of its list', () => {
  for (const field of FIELDS) {
    if (field.type !== 'number') continue;
    const entry = numberOptions(field, settingsToForm(DEFAULT_SETTINGS)[field.key]).find(
      (o) => o.value === String(field.defaultValue),
    );
    assert.ok(entry, field.key);
  }
});

test('optionText: the aside goes in brackets', () => {
  assert.equal(optionText({ value: 'a', label: 'One' }), 'One');
  assert.equal(optionText({ value: 'a', label: 'One', aside: 'two' }), 'One (two)');
});

test('fields: the folder name limit matches the limit of normalizeSettings', () => {
  const field = FIELDS.find((f) => f.key === 'folderName');
  assert.ok(field && field.type === 'text');
  assert.equal(field.maxLength, FOLDER_NAME_MAX_LENGTH);
  const saved = formToSettings({ folderName: 'a'.repeat(FOLDER_NAME_MAX_LENGTH * 3) });
  assert.equal(saved.folderName.length, FOLDER_NAME_MAX_LENGTH);
});

test('fields: text follows the style rules (labels 8 words, sentences 25 words)', () => {
  const texts = [
    ...FIELDS.map((f) => f.help),
    ...FIELDS.map((f) => fieldHint(f)),
    ...FIELDS.flatMap((f) => (f.type === 'choice' ? f.options.map((o) => o.detail ?? '') : [])),
  ];
  for (const text of texts) {
    for (const sentence of sentences(text)) {
      assert.ok(wordCount(sentence) <= 25, `Sentence is too long: ${sentence}`);
    }
    assert.doesNotMatch(text, /[<>&]/, 'no markup characters');
  }
  for (const field of FIELDS) {
    assert.ok(wordCount(field.label) <= 8, `Label is too long: ${field.label}`);
    // One short line under the label.
    assert.ok(wordCount(field.help) <= 30, `Help is too long: ${field.help}`);
  }
  for (const group of GROUPS) {
    assert.ok(wordCount(group.title) <= 3, `Group title is too long: ${group.title}`);
  }
});

test('fieldHint: states limits, default and unit', () => {
  const byKey = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
  assert.equal(fieldHint(byKey.overlapCss), 'Allowed: 16 to 400 px. Default: 80 px.');
  assert.equal(fieldHint(byKey.settleMs), 'Allowed: 0 to 3,000 ms. Default: 350 ms.');
  assert.equal(fieldHint(byKey.maxHeightCss), 'Allowed: 1,000 to 100,000 px. Default: 40,000 px.');
  assert.equal(fieldHint(byKey.hideOverlays), 'Default: on.');
  assert.equal(fieldHint(byKey.tileTier), 'Default: High resolution (current models).');
  assert.equal(fieldHint(byKey.folderName), 'Default: Spool. Maximum: 40 characters.');
});

// ---------------------------------------------------------------------------------------------
// settingsToForm
// ---------------------------------------------------------------------------------------------

test('settingsToForm: defaults become strings and booleans', () => {
  assert.deepEqual(settingsToForm(DEFAULT_SETTINGS), {
    overlapCss: '80',
    settleMs: '350',
    maxHeightCss: '40000',
    hideOverlays: true,
    tileTier: 'high',
    saveTiles: true,
    saveFull: true,
    copyOnDone: true,
    folderName: 'Spool',
  });
});

test('settingsToForm: bad input gives the form values of the defaults', () => {
  const expected = settingsToForm(DEFAULT_SETTINGS);
  for (const bad of [undefined, null, 5, 'x', [], {}, { overlapCss: 'abc', tileTier: 'huge' }]) {
    assert.deepEqual(settingsToForm(bad), expected);
  }
});

test('settingsToForm: shows the effective value of an out-of-range setting', () => {
  const form = settingsToForm({ overlapCss: 5, settleMs: 99_999, folderName: 'a/b' });
  assert.equal(form.overlapCss, '16');
  assert.equal(form.settleMs, '3000');
  assert.equal(form.folderName, 'a b');
});

// ---------------------------------------------------------------------------------------------
// formToSettings
// ---------------------------------------------------------------------------------------------

test('formToSettings: an empty record gives the defaults', () => {
  assert.deepEqual(formToSettings({}), { ...DEFAULT_SETTINGS });
});

test('formToSettings: reads every field', () => {
  assert.deepEqual(
    formToSettings({
      overlapCss: '120',
      settleMs: '800',
      maxHeightCss: '25000',
      hideOverlays: false,
      tileTier: 'standard',
      saveTiles: false,
      saveFull: true,
      copyOnDone: false,
      folderName: 'Shots',
    }),
    {
      overlapCss: 120,
      settleMs: 800,
      maxHeightCss: 25_000,
      hideOverlays: false,
      tileTier: 'standard',
      saveTiles: false,
      saveFull: true,
      copyOnDone: false,
      folderName: 'Shots',
    },
  );
});

test('formToSettings: round trip keeps valid settings, including both limits', () => {
  const random = makeRandom(20261106);
  /** @type {Settings[]} */
  const samples = [
    { ...DEFAULT_SETTINGS },
    {
      ...DEFAULT_SETTINGS,
      overlapCss: SETTINGS_LIMITS.overlapCss[0],
      settleMs: SETTINGS_LIMITS.settleMs[0],
      maxHeightCss: SETTINGS_LIMITS.maxHeightCss[0],
    },
    {
      ...DEFAULT_SETTINGS,
      overlapCss: SETTINGS_LIMITS.overlapCss[1],
      settleMs: SETTINGS_LIMITS.settleMs[1],
      maxHeightCss: SETTINGS_LIMITS.maxHeightCss[1],
    },
  ];
  /** @param {readonly number[]} limits */
  const span = (limits) => Math.round(limits[0] + random() * (limits[1] - limits[0]));
  for (let i = 0; i < 200; i += 1) {
    samples.push({
      overlapCss: span(SETTINGS_LIMITS.overlapCss),
      settleMs: span(SETTINGS_LIMITS.settleMs),
      maxHeightCss: span(SETTINGS_LIMITS.maxHeightCss),
      hideOverlays: random() < 0.5,
      tileTier: random() < 0.5 ? 'high' : 'standard',
      saveTiles: random() < 0.5,
      saveFull: random() < 0.5,
      copyOnDone: random() < 0.5,
      folderName: ['Spool', 'My shots', 'Work 2026', 'a.b'][Math.floor(random() * 4)] ?? 'x',
    });
  }
  for (const s of samples) {
    assert.deepEqual(formToSettings(settingsToForm(s)), s);
  }
});

test('formToSettings: number text is read as a plain decimal', () => {
  const cases = /** @type {Array<[string, number]>} */ ([
    ['80', 80],
    ['  120  ', 120],
    ['0120', 120],
    ['+150', 150],
    ['80.4', 80],
    ['80.5', 81],
    ['199.999', 200],
  ]);
  for (const [text, expected] of cases) {
    assert.equal(formToSettings({ overlapCss: text }).overlapCss, expected, text);
  }
});

test('formToSettings: a number outside the limits moves to the nearest limit', () => {
  assert.equal(formToSettings({ overlapCss: '5' }).overlapCss, 16);
  assert.equal(formToSettings({ overlapCss: '-30' }).overlapCss, 16);
  assert.equal(formToSettings({ overlapCss: '9999' }).overlapCss, 400);
  assert.equal(formToSettings({ settleMs: '-1' }).settleMs, 0);
  assert.equal(formToSettings({ settleMs: '3001' }).settleMs, 3000);
  assert.equal(formToSettings({ maxHeightCss: '0' }).maxHeightCss, 1000);
  assert.equal(formToSettings({ maxHeightCss: '250000' }).maxHeightCss, 100_000);
  assert.equal(formToSettings({ maxHeightCss: '1' + '0'.repeat(30) }).maxHeightCss, 100_000);
});

test('formToSettings: a number that is empty or not a plain decimal gives the default', () => {
  const bad = ['', ' ', 'abc', '12px', '1e3', '0x10', '1,000', '1 000', 'NaN', 'Infinity', '--5'];
  for (const text of bad) {
    const { overlapCss, settleMs } = formToSettings({ overlapCss: text, settleMs: text });
    assert.equal(overlapCss, DEFAULT_SETTINGS.overlapCss, text);
    assert.equal(settleMs, DEFAULT_SETTINGS.settleMs, text);
  }
  assert.equal(formToSettings({ maxHeightCss: '9'.repeat(400) }).maxHeightCss, 40_000);
});

test('formToSettings: checkboxes accept booleans and the strings true, false, on, off', () => {
  assert.equal(formToSettings({ hideOverlays: false }).hideOverlays, false);
  assert.equal(formToSettings({ hideOverlays: true }).hideOverlays, true);
  assert.equal(formToSettings({ saveTiles: 'off' }).saveTiles, false);
  assert.equal(formToSettings({ saveFull: 'FALSE' }).saveFull, false);
  assert.equal(formToSettings({ saveTiles: 'on' }).saveTiles, true);
  // A value that is not a boolean gives the default (true).
  assert.equal(formToSettings({ saveTiles: 'maybe' }).saveTiles, true);
  assert.equal(formToSettings({ saveTiles: '' }).saveTiles, true);
});

test('formToSettings: tile size accepts only known tiers', () => {
  assert.equal(formToSettings({ tileTier: 'standard' }).tileTier, 'standard');
  assert.equal(formToSettings({ tileTier: ' standard ' }).tileTier, 'standard');
  assert.equal(formToSettings({ tileTier: 'huge' }).tileTier, 'high');
  assert.equal(formToSettings({ tileTier: '' }).tileTier, 'high');
  assert.equal(formToSettings({ tileTier: 'toString' }).tileTier, 'high');
  assert.equal(formToSettings({ tileTier: '__proto__' }).tileTier, 'high');
});

test('formToSettings: folder name is made safe', () => {
  assert.equal(formToSettings({ folderName: ' My Shots ' }).folderName, 'My Shots');
  assert.equal(formToSettings({ folderName: 'a/b\\c:d' }).folderName, 'a b c d');
  assert.equal(formToSettings({ folderName: '..\\..\\Windows' }).folderName, 'Windows');
  assert.equal(formToSettings({ folderName: '' }).folderName, 'Spool');
  assert.equal(formToSettings({ folderName: '   ' }).folderName, 'Spool');
  assert.equal(formToSettings({ folderName: 'CON' }).folderName, 'Spool');
  assert.equal(formToSettings({ folderName: '...' }).folderName, 'Spool');
  assert.equal(formToSettings({ folderName: true }).folderName, 'Spool');
});

test('formToSettings: a record that is not an object gives the defaults', () => {
  for (const bad of [null, undefined, 'x', 5, true, []]) {
    assert.deepEqual(formToSettings(/** @type {any} */ (bad)), { ...DEFAULT_SETTINGS });
  }
});

test('formToSettings: unknown keys are ignored and nothing leaks into Object.prototype', () => {
  const record = JSON.parse(
    '{"__proto__":{"polluted":true},"constructor":"x","extra":1,"overlapCss":"100"}',
  );
  const result = formToSettings(record);
  assert.deepEqual(Object.keys(result).sort(), [...SETTING_KEYS].sort());
  assert.equal(result.overlapCss, 100);
  assert.equal(/** @type {any} */ ({}).polluted, undefined);
});

test('formToSettings: the result is always valid settings', () => {
  const random = makeRandom(7);
  const junk = ['', '0', '-1', '17', '3000', '3001', '1e9', 'x', ' 5 ', '40000.7', 'true', 'on'];
  for (let i = 0; i < 300; i += 1) {
    const pick = () => junk[Math.floor(random() * junk.length)] ?? '';
    const result = formToSettings({
      overlapCss: pick(),
      settleMs: pick(),
      maxHeightCss: pick(),
      hideOverlays: pick(),
      saveTiles: pick(),
      saveFull: pick(),
      tileTier: pick(),
      folderName: pick(),
    });
    assert.deepEqual(normalizeSettings(result), result);
  }
});

test('parseNumberInput: accepts numbers and plain decimal text only', () => {
  assert.equal(parseNumberInput(12), 12);
  assert.equal(parseNumberInput(Number.NaN), undefined);
  assert.equal(parseNumberInput(Number.POSITIVE_INFINITY), undefined);
  assert.equal(parseNumberInput('12'), 12);
  assert.equal(parseNumberInput('-0.5'), -0.5);
  assert.equal(parseNumberInput(''), undefined);
  assert.equal(parseNumberInput('.5'), undefined);
  assert.equal(parseNumberInput('5.'), undefined);
  assert.equal(parseNumberInput(null), undefined);
  assert.equal(parseNumberInput({}), undefined);
});

// ---------------------------------------------------------------------------------------------
// Status line text
// ---------------------------------------------------------------------------------------------

test('findAdjustments: nothing to report when the saved values equal the entered values', () => {
  const entered = settingsToForm(DEFAULT_SETTINGS);
  assert.deepEqual(findAdjustments(entered, formToSettings(entered)), []);
});

test('findAdjustments: formatting differences are not adjustments', () => {
  const entered = { overlapCss: ' +080.0 ', hideOverlays: 'on', folderName: ' Spool ' };
  assert.deepEqual(findAdjustments(entered, formToSettings(entered)), []);
});

test('findAdjustments: reports clamped, empty, invalid and cleaned values', () => {
  const entered = {
    overlapCss: '5',
    settleMs: '',
    maxHeightCss: '1e3',
    hideOverlays: true,
    tileTier: 'standard',
    saveTiles: true,
    saveFull: true,
    folderName: 'a/b',
  };
  const result = findAdjustments(entered, formToSettings(entered));
  assert.deepEqual(result, [
    { key: 'overlapCss', label: 'Overlap between steps', entered: '5', saved: '16' },
    { key: 'settleMs', label: 'Wait after each scroll', entered: '', saved: '350' },
    { key: 'maxHeightCss', label: 'Maximum length', entered: '1e3', saved: '40000' },
    { key: 'folderName', label: 'Downloads folder name', entered: 'a/b', saved: 'a b' },
  ]);
});

test('describeAdjustments: plain text, singular and plural', () => {
  assert.equal(describeAdjustments([]), '');
  assert.equal(
    describeAdjustments([
      { key: 'overlapCss', label: 'Overlap between steps', entered: '5', saved: '16' },
    ]),
    'Spool changed 1 value to fit the limits. Overlap between steps: 5 became 16.',
  );
  assert.equal(
    describeAdjustments([
      { key: 'overlapCss', label: 'Overlap between steps', entered: '5', saved: '16' },
      { key: 'settleMs', label: 'Wait after each scroll', entered: '', saved: '350' },
    ]),
    'Spool changed 1 value to fit the limits. Overlap between steps: 5 became 16. ' +
      'The wait after each scroll was empty, so Spool used 350 ms.',
  );
});

test('settingsWarnings: warns when Save all would save nothing', () => {
  assert.deepEqual(settingsWarnings(DEFAULT_SETTINGS), []);
  assert.deepEqual(settingsWarnings({ ...DEFAULT_SETTINGS, saveTiles: false }), []);
  assert.deepEqual(settingsWarnings({ ...DEFAULT_SETTINGS, saveFull: false }), []);
  const warnings = settingsWarnings({ ...DEFAULT_SETTINGS, saveTiles: false, saveFull: false });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0] ?? '', /nothing to save/);
});

test('shortcutParts: splits a shortcut text into key names', () => {
  assert.deepEqual(shortcutParts('Alt+Shift+S'), ['Alt', 'Shift', 'S']);
  assert.deepEqual(shortcutParts(' Ctrl + Shift + Comma '), ['Ctrl', 'Shift', 'Comma']);
  assert.deepEqual(shortcutParts('F9'), ['F9']);
  assert.deepEqual(shortcutParts(''), []);
  assert.deepEqual(shortcutParts(undefined), []);
  assert.deepEqual(shortcutParts(42), []);
});

// ---------------------------------------------------------------------------------------------
// Save folder
// ---------------------------------------------------------------------------------------------

test('describeSaveFolder: no folder shows Downloads and offers Pictures › Screenshots', () => {
  const view = describeSaveFolder({ label: null, permission: 'prompt', folderName: 'Spool' });
  assert.equal(view.title, 'Downloads › Spool');
  assert.equal(view.state, 'none');
  assert.equal(view.help, 'Default until you pick.');
  assert.deepEqual(view.primary, { id: 'pictures', label: 'Save to Pictures › Screenshots' });
  assert.equal(view.showOther, true, 'the user can pick another folder');
  assert.equal(view.showChange, false);
  assert.equal(view.showClear, false);
  assert.equal(view.note, '');
  const named = describeSaveFolder({ label: null, permission: 'prompt', folderName: 'My Shots' });
  assert.equal(named.title, 'Downloads › My Shots');
});

test('describeSaveFolder: a connected folder shows its place and needs no button', () => {
  const view = describeSaveFolder({
    label: 'Pictures › Screenshots',
    permission: 'granted',
    folderName: 'Spool',
    subPath: ['Screenshots'],
  });
  assert.equal(view.title, 'Pictures › Screenshots');
  assert.equal(view.state, 'granted');
  assert.equal(view.help, 'Connected.');
  assert.equal(view.primary, null);
  assert.equal(view.showChange, true);
  assert.equal(view.showClear, true);
  assert.equal(view.showOther, false);
});

test('describeSaveFolder: a folder that needs permission offers Reconnect', () => {
  const view = describeSaveFolder({
    label: 'Pictures › Screenshots',
    permission: 'prompt',
    folderName: 'My Shots',
    subPath: ['Screenshots'],
  });
  assert.equal(view.title, 'Pictures › Screenshots');
  assert.equal(view.help, 'Needs one click. Saving to Downloads › My Shots until then.');
  assert.deepEqual(view.primary, { id: 'reconnect', label: 'Reconnect' });
  assert.equal(view.showChange, true);
  assert.equal(view.showClear, true);
});

test('describeSaveFolder: a folder that is gone offers to pick it again', () => {
  const pictures = describeSaveFolder({
    label: 'Pictures › Screenshots',
    permission: 'denied',
    folderName: 'Spool',
    subPath: ['Screenshots'],
  });
  assert.equal(pictures.title, 'Folder not found');
  assert.equal(pictures.state, 'denied');
  assert.equal(pictures.help, 'Saving to Downloads › Spool until you pick again.');
  assert.deepEqual(pictures.primary, { id: 'pictures', label: 'Pick again' });
  assert.equal(pictures.showClear, true);
  assert.equal(pictures.showChange, false, 'one way to pick again, not two');
  // A folder that the user picked as it is (version 1.0.0, or "Choose another folder"): pick any.
  const custom = describeSaveFolder({ label: 'Work', permission: 'denied', folderName: 'Spool' });
  assert.deepEqual(custom.primary, { id: 'other', label: 'Pick again' });
});

test('describeSaveFolder: the permission note appears with a folder that exists', () => {
  for (const permission of /** @type {const} */ (['granted', 'prompt'])) {
    const view = describeSaveFolder({ label: 'Pictures', permission, folderName: 'Spool' });
    assert.match(view.note, /Allow on every visit/);
    assert.match(view.note, /close this tab or restart/);
    assert.equal(sentences(view.note).length, 2, 'one line, two short sentences');
  }
  assert.equal(describeSaveFolder({ label: null, permission: 'granted', folderName: 'Spool' }).note, '');
  assert.equal(describeSaveFolder({ label: 'X', permission: 'denied', folderName: 'Spool' }).note, '');
});

test('describeSaveFolder: a folder with no name still has a title', () => {
  const view = describeSaveFolder({ label: '', permission: 'granted', folderName: 'Spool' });
  assert.equal(view.title, 'Chosen folder');
  assert.equal(view.state, 'granted');
});

test('describeSaveFolder: the text is short and holds no markup', () => {
  for (const label of [null, 'Pictures › Screenshots']) {
    for (const permission of /** @type {const} */ (['granted', 'prompt', 'denied'])) {
      const view = describeSaveFolder({ label, permission, folderName: 'Spool' });
      const buttons = [view.primary?.label ?? ''];
      for (const text of [view.help, view.note, view.title, ...buttons]) {
        for (const sentence of sentences(text)) {
          assert.ok(wordCount(sentence) <= 25, `Sentence is too long: ${sentence}`);
        }
        assert.doesNotMatch(text, /[<>&]/);
      }
    }
  }
});
