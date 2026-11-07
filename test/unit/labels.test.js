// @ts-check
/**
 * Tests for src/lib/labels.js (one format for the place of a save) and for the copies of
 * it that a page script cannot import: the toast has its own `placeLabel` and `keyParts`. The
 * toast and the helper must give the same text, so these tests run both on the same input.
 * They also check the long toast: the tinted block with keycaps and the numbered chips.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PLACE_SEPARATOR,
  downloadsPlace,
  formatSaveLabel,
  joinPlace,
  targetPlace,
} from '../../src/lib/labels.js';
import { describeSaveFolder, shortcutParts } from '../../src/options/form-model.js';
import { PICTURES_PLACE } from '../../src/options/setup-model.js';
import { saveInfoLine } from '../../src/result/save-plan.js';
import { ERR, MSG, PROTOCOL_VERSION, TARGET } from '../../src/shared/protocol.js';
import { findAll, findOne, setupCards, textOf } from '../helpers/fake-card-dom.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const BASE_CONFIG = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  sessionId: SESSION,
  msg: MSG,
  err: ERR,
  target: TARGET,
});

/** @param {Record<string, unknown>} [more] */
function summary(more = {}) {
  return {
    sessionId: SESSION,
    title: 'Draft 3 review',
    createdAt: Date.now(),
    widthPx: 1500,
    heightPx: 2210,
    tileCount: 1,
    tileTier: 'standard',
    fitsOneImage: true,
    fullBytes: 1000,
    thumbnailPngBase64: 'iVBORw0KGgo=',
    thumbnailWidthPx: 320,
    thumbnailHeightPx: 480,
    save: { location: 'downloads', label: 'Downloads/Spool', files: 1, needsPermission: false },
    warnings: [],
    ...more,
  };
}

/** A long capture: five tiles. @param {Record<string, unknown>} [more] */
function longSummary(more = {}) {
  return summary({ heightPx: 9000, tileCount: 5, fitsOneImage: false, ...more });
}

/**
 * Shows a toast and gives its card.
 * @param {Record<string, unknown>} info
 * @param {Record<string, unknown>} [config]
 */
function showToast(info, config = {}) {
  const t = setupCards({ files: ['src/page/ui-kit.js', 'src/page/toast.js'], replies: {} });
  t.ns.toast.show({ config: { ...BASE_CONFIG, ...config }, summary: info, copy: 'copied' });
  const host = t.hosts().at(-1);
  assert.ok(host, 'a toast host is on screen');
  const root = t.rootOf(host);
  const byClass = (/** @type {string} */ name) => findAll(root, (e) => e.className === name);
  return { t, root, byClass };
}

describe('labels.js', () => {
  it('uses one separator: a real arrow with a space on each side', () => {
    assert.equal(PLACE_SEPARATOR, ' › ');
    assert.equal(joinPlace('Pictures', 'Screenshots'), 'Pictures › Screenshots');
  });

  it('joinPlace leaves out empty parts and trims the others', () => {
    assert.equal(joinPlace(' Downloads ', '', '  ', 'Spool'), 'Downloads › Spool');
    assert.equal(joinPlace(''), '');
    assert.equal(joinPlace(), '');
  });

  it('downloadsPlace names the folder of Downloads', () => {
    assert.equal(downloadsPlace('Spool'), 'Downloads › Spool');
    assert.equal(downloadsPlace('My Shots'), 'Downloads › My Shots');
    assert.equal(downloadsPlace(''), 'Downloads');
  });

  it('formatSaveLabel: "Downloads/Spool" and a folder name show in one format', () => {
    assert.equal(formatSaveLabel('Downloads/Spool'), 'Downloads › Spool');
    assert.equal(formatSaveLabel('Screenshots'), 'Screenshots');
    assert.equal(formatSaveLabel('Pictures › Screenshots'), 'Pictures › Screenshots');
    assert.equal(formatSaveLabel('/Downloads//Spool/'), 'Downloads › Spool');
    assert.equal(formatSaveLabel('Downloads / My Shots'), 'Downloads › My Shots');
  });

  it('formatSaveLabel: no label gives no text', () => {
    assert.equal(formatSaveLabel(''), '');
    assert.equal(formatSaveLabel('/'), '');
    assert.equal(formatSaveLabel(undefined), '');
    assert.equal(formatSaveLabel(42), '');
  });

  it('the result page says the place in the same format', () => {
    /** @param {string} label */
    const line = (label) =>
      saveInfoLine({ location: 'downloads', label, files: 2, needsPermission: false }).text;
    assert.equal(line('Downloads/Spool'), 'Saved 2 files in Downloads › Spool.');
    assert.equal(line('Screenshots'), 'Saved 2 files in Screenshots.');
    assert.equal(line(''), 'Saved 2 files in the chosen folder.');
  });
});

describe('toast.js and labels.js agree', () => {
  const labels = [
    'Downloads/Spool',
    'Downloads/My Shots',
    'Screenshots',
    'Pictures › Screenshots',
    '/Downloads//Spool/',
    'Downloads / Spool',
  ];

  for (const label of labels) {
    it(`the short toast shows "${label}" as the helper does`, () => {
      const { byClass } = showToast(
        summary({ save: { location: 'downloads', label, files: 1, needsPermission: false } }),
      );
      assert.equal(
        textOf(byClass('caption')[0]),
        `1,500 × 2,210 px · Saved to ${formatSaveLabel(label)} · Change`,
      );
    });

    it(`the long toast shows "${label}" as the helper does`, () => {
      const { byClass } = showToast(
        longSummary({ save: { location: 'downloads', label, files: 5, needsPermission: false } }),
      );
      assert.equal(
        textOf(byClass('caption')[0]),
        `5 AI screenshots ready · Saved to ${formatSaveLabel(label)} · Change`,
      );
    });
  }

  it('an empty label falls back to "Downloads"', () => {
    const { byClass } = showToast(
      summary({ save: { location: 'downloads', label: '', files: 1, needsPermission: false } }),
    );
    assert.equal(textOf(byClass('caption')[0]), '1,500 × 2,210 px · Saved to Downloads · Change');
  });

  it('the question about the folder names the place in the same format', () => {
    const { root } = showToast(
      summary({
        save: {
          location: 'downloads',
          label: 'Downloads/Spool',
          files: 1,
          needsPermission: false,
          askFolder: true,
        },
      }),
    );
    assert.ok(textOf(root).includes(`Saved to ${downloadsPlace('Spool')}`));
    assert.ok(textOf(root).includes('Save to Pictures › Screenshots?'));
  });
});

describe('toast.js: the long toast', () => {
  /** @param {Record<string, unknown>} [config] */
  const long = (config) => showToast(longSummary(), config);

  it('has a tinted block with the route, and the keys are keycaps', () => {
    const { byClass } = long();
    const hint = byClass('hint')[0];
    assert.ok(hint, 'the block');
    assert.equal(hint.tagName, 'P');
    assert.equal(
      textOf(hint),
      'Long capture? In your chat tab, press Alt+Shift+V to insert all 5 screenshots.',
    );
    const caps = findAll(hint, (e) => e.tagName === 'KBD').map(textOf);
    assert.deepEqual(caps, ['Alt', 'Shift', 'V']);
    const plus = findAll(hint, (e) => e.className === 'plus').map(textOf);
    assert.deepEqual(plus, ['+', '+']);
  });

  it('the keycaps follow the real key of the config, as shortcutParts splits it', () => {
    for (const insert of ['Ctrl+Shift+Comma', 'Alt+Shift+V', 'F9', ' Ctrl + Shift + Y ']) {
      const { byClass } = long({ shortcuts: { start: 'Alt+Shift+S', insert } });
      const hint = /** @type {any} */ (byClass('hint')[0]);
      const caps = findAll(hint, (e) => e.tagName === 'KBD');
      assert.deepEqual(caps.map(textOf), shortcutParts(insert), insert);
    }
  });

  it('the block names no key and has no keycap when the command has no key', () => {
    const { byClass } = long({ shortcuts: { start: 'Alt+Shift+S', insert: '' } });
    const hint = /** @type {any} */ (byClass('hint')[0]);
    assert.equal(findAll(hint, (e) => e.tagName === 'KBD').length, 0);
    assert.equal(
      textOf(hint),
      'Set a shortcut for "Insert last capture" in your browser. ' +
        'Then press it in your chat tab to insert all 5 screenshots.',
    );
  });

  it('has one chip for each tile, labelled "1" ... and named "Copy screenshot N"', () => {
    const { byClass } = long();
    const chips = byClass('chip');
    assert.deepEqual(chips.map(textOf), ['1', '2', '3', '4', '5']);
    assert.deepEqual(
      chips.map((c) => c.attributes.get('aria-label')),
      ['Copy screenshot 1', 'Copy screenshot 2', 'Copy screenshot 3', 'Copy screenshot 4', 'Copy screenshot 5'],
    );
    for (const chip of chips) {
      // WCAG 2.5.3: the name of a control contains the words that it shows.
      assert.ok(
        String(chip.attributes.get('aria-label')).toLowerCase().includes(textOf(chip).toLowerCase()),
      );
    }
  });

  it('keeps Open and adds no menu: the toast has no action behind a "more" button', () => {
    const { root, byClass } = long();
    const open = findOne(
      root,
      (e) => e.className === 'link' && textOf(e).startsWith('Open'),
      'Open link',
    );
    assert.ok(open);
    const buttons = findAll(root, (e) => e.tagName === 'BUTTON');
    for (const button of buttons) {
      assert.equal(button.attributes.has('aria-haspopup'), false);
      assert.ok(!/more actions/i.test(String(button.attributes.get('aria-label'))));
    }
    assert.equal(byClass('chip').length, 5);
  });
});

describe('a folder below the picked folder: Pictures/Screenshots', () => {
  it('formatSaveLabel and targetPlace give one text', () => {
    assert.equal(formatSaveLabel('Pictures/Screenshots'), 'Pictures › Screenshots');
    assert.equal(targetPlace('Pictures', ['Screenshots']), 'Pictures › Screenshots');
    assert.equal(formatSaveLabel('Work/A/B'), targetPlace('Work', ['A', 'B']));
    assert.equal(formatSaveLabel('/Screenshots'), targetPlace('', ['Screenshots']));
  });

  it('the toast shows it in the caption, short and long', () => {
    const info = { location: 'folder', label: 'Pictures/Screenshots', files: 4, needsPermission: false };
    const short = showToast(summary({ save: info }));
    assert.equal(textOf(short.byClass('caption')[0]), '1,500 × 2,210 px · Saved to Pictures › Screenshots');
    const long = showToast(longSummary({ save: info }));
    assert.equal(textOf(long.byClass('caption')[0]), '5 AI screenshots ready · Saved to Pictures › Screenshots');
  });

  it('the result page says it the same way', () => {
    const line = saveInfoLine({
      location: 'folder',
      label: 'Pictures/Screenshots',
      files: 4,
      needsPermission: false,
    });
    assert.equal(line.text, 'Saved 4 files in Pictures › Screenshots.');
  });

  it('Options shows it as the title of the folder row', () => {
    const view = describeSaveFolder({
      label: targetPlace('Pictures', ['Screenshots']),
      permission: 'granted',
      folderName: 'Spool',
      subPath: ['Screenshots'],
    });
    assert.equal(view.title, 'Pictures › Screenshots');
  });

  it('the toast and the setup page name the same place for "Set up"', () => {
    const question = showToast(
      summary({
        save: {
          location: 'downloads',
          label: 'Downloads/Spool',
          files: 1,
          needsPermission: false,
          askFolder: true,
        },
      }),
    );
    assert.ok(textOf(question.root).includes(`Save to ${PICTURES_PLACE}?`));
    assert.ok(textOf(question.root).includes('Saved to Downloads › Spool'));
  });
});
