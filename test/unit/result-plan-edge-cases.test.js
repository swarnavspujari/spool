// @ts-check
/**
 * Tests added by mutation testing for the formatters of
 * the result page (src/result/save-plan.js) and the option presets of the form model
 * (src/options/form-model.js). Each pins a value or a boundary that a mutation run showed to be
 * unchecked.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FIELDS, formatValue } from '../../src/options/form-model.js';
import { base64ToBytes } from '../../src/render/util.js';
import {
  formatBytes,
  formatDateTime,
  formatInt,
  saveInfoLine,
} from '../../src/result/save-plan.js';

describe('formatBytes: units and rounding', () => {
  it('uses 1024-based steps', () => {
    assert.equal(formatBytes(1), '1 B');
    assert.equal(formatBytes(1023), '1023 B');
    assert.equal(formatBytes(1024), '1.0 KB');
    assert.equal(formatBytes(1536), '1.5 KB');
    assert.equal(formatBytes(1024 * 1024), '1.0 MB');
    assert.equal(formatBytes(1024 ** 3), '1.0 GB');
    assert.equal(formatBytes(5 * 1024 ** 3), '5.0 GB');
  });

  it('keeps one decimal below 100 and none from 100', () => {
    assert.equal(formatBytes(99.9 * 1024), '99.9 KB');
    assert.equal(formatBytes(100 * 1024), '100 KB');
    assert.equal(formatBytes(512.4 * 1024), '512 KB');
  });

  it('moves to the next unit when the value rounds to 1024', () => {
    // 1023.96 KB shows as 1024.0 KB when rounded to one decimal: it is 1.0 MB.
    assert.equal(formatBytes(1023.96 * 1024), '1.0 MB');
    // 1023.94 KB rounds to 1023.9 KB and stays.
    assert.equal(formatBytes(1023.94 * 1024), '1024 KB');
    assert.equal(formatBytes(1023.96 * 1024 * 1024), '1.0 GB');
  });

  it('stays at GB for very large values and gives "0 B" for nothing', () => {
    assert.equal(formatBytes(2000 * 1024 ** 3), '2000 GB');
    assert.equal(formatBytes(0), '0 B');
    assert.equal(formatBytes(-5), '0 B');
    assert.equal(formatBytes(Number.NaN), '0 B');
    assert.equal(formatBytes(0.4), '0 B');
  });

  it('rounds a size below 1 KB to whole bytes', () => {
    assert.equal(formatBytes(1.4), '1 B');
    assert.equal(formatBytes(1022.6), '1023 B');
  });
});

describe('formatInt', () => {
  it('rounds to the nearest whole number', () => {
    assert.equal(formatInt(1234.5), '1,235');
    assert.equal(formatInt(1234.4), '1,234');
  });

  it('puts a comma between every three digits, and never at the start', () => {
    assert.equal(formatInt(999), '999');
    assert.equal(formatInt(1000), '1,000');
    assert.equal(formatInt(123_456), '123,456');
    assert.equal(formatInt(1_234_567), '1,234,567');
    assert.equal(formatInt(-1234), '-1,234');
    assert.equal(formatInt(Number.NaN), '0');
  });
});

describe('formatDateTime', () => {
  it('gives an empty string for what is not a time', () => {
    assert.equal(formatDateTime(Number.NaN), '');
    assert.equal(formatDateTime(Number.POSITIVE_INFINITY), '');
    assert.equal(formatDateTime(8.64e15 + 1), '');
  });

  it('writes the English short form, with an ordinary space before AM or PM', () => {
    const text = formatDateTime(Date.UTC(2026, 10, 6, 15, 22, 0), 'UTC');
    assert.equal(text, 'Nov 6, 2026, 3:22 PM');
    assert.ok(!/[  ]/.test(text), 'no non-breaking space');
  });
});

describe('base64ToBytes of the result page: input without padding', () => {
  it('has the length floor(3/4 * characters), with no extra zero byte', () => {
    assert.deepEqual([...base64ToBytes('QQ')], [0x41]);
    assert.deepEqual([...base64ToBytes('QUI')], [0x41, 0x42]);
  });
});

describe('saveInfoLine', () => {
  const NOT_SAVED = 'Not saved. Turn on AI screenshots or the full image in Settings.';

  it('no file or no location: not saved, with the hint, or with the reason as an error', () => {
    assert.deepEqual(saveInfoLine({ location: 'none', label: 'Not saved', files: 0, needsPermission: false }), {
      text: NOT_SAVED,
      tone: 'info',
      needsPermission: false,
    });
    assert.deepEqual(saveInfoLine({ location: 'downloads', label: 'Downloads/Spool', files: 0, needsPermission: false }), {
      text: NOT_SAVED,
      tone: 'info',
      needsPermission: false,
    });
    assert.deepEqual(
      saveInfoLine({ location: 'none', label: 'Not saved', files: 0, needsPermission: false, error: 'Could not save the files.' }),
      { text: 'Not saved. Could not save the files.', tone: 'error', needsPermission: false },
    );
    // The location wins over a file count.
    assert.equal(saveInfoLine({ location: 'none', label: 'x', files: 5, needsPermission: false }).text, NOT_SAVED);
  });

  it('one file saved: ok; with an error: error; with a missing permission: ask for access', () => {
    assert.deepEqual(saveInfoLine({ location: 'downloads', label: 'Downloads/Spool', files: 1, needsPermission: false }), {
      text: 'Saved 1 file in Downloads › Spool.',
      tone: 'ok',
      needsPermission: false,
    });
    const partial = saveInfoLine({ location: 'downloads', label: 'Downloads/Spool', files: 2, needsPermission: false, error: 'Some files could not be saved.' });
    assert.equal(partial.tone, 'error');
    assert.equal(partial.text, 'Saved 2 files in Downloads › Spool. Some files could not be saved.');
    const ask = saveInfoLine({ location: 'downloads', label: 'Downloads/Spool', files: 3, needsPermission: true });
    assert.equal(ask.tone, 'info');
    assert.equal(ask.needsPermission, true);
    assert.ok(ask.text.startsWith('Saved 3 files in Downloads › Spool. Spool could not use your chosen folder.'));
  });
});

describe('form model: the preset lists of the number fields', () => {
  /** @param {string} key */
  function presetsOf(key) {
    const field = FIELDS.find((f) => f.key === key);
    assert.ok(field && field.type === 'number', `field ${key}`);
    return [...field.presets];
  }

  it('wait after each scroll offers 150, 350, 600, 1000 and 2000 ms', () => {
    assert.deepEqual(presetsOf('settleMs'), [150, 350, 600, 1000, 2000]);
  });

  it('maximum length offers 20,000, 40,000 and 100,000 px', () => {
    assert.deepEqual(presetsOf('maxHeightCss'), [20_000, 40_000, 100_000]);
  });

  it('overlap offers 32, 64, 80, 96 and 128 px', () => {
    assert.deepEqual(presetsOf('overlapCss'), [32, 64, 80, 96, 128]);
  });
});

describe('form model: formatValue', () => {
  it('shows a time from one second in seconds with one decimal, rounded to the nearest 0.1 s', () => {
    assert.equal(formatValue(999, 'ms'), '999 ms');
    assert.equal(formatValue(1000, 'ms'), '1 s');
    assert.equal(formatValue(1040, 'ms'), '1 s');
    assert.equal(formatValue(1050, 'ms'), '1.1 s');
    assert.equal(formatValue(1949, 'ms'), '1.9 s');
    assert.equal(formatValue(1950, 'ms'), '2 s');
    assert.equal(formatValue(2000, 'ms'), '2 s');
    assert.equal(formatValue(20_000, 'px'), '20,000 px');
  });
});
