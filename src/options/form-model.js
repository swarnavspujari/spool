// @ts-check
/**
 * Pure model of the options form: field metadata, and conversion between Settings and the
 * values of the form. No DOM and no chrome.* here, so Node can test it.
 *
 * All validation rules live in `normalizeSettings` (src/shared/settings.js). This module only
 * turns strings from form controls into the types that `normalizeSettings` expects.
 */

import { shortcutParts } from '../lib/keys.js';
import { downloadsPlace } from '../lib/labels.js';
import { TILE_TIERS } from '../shared/constants.js';
import { DEFAULT_SETTINGS, SETTINGS_LIMITS, normalizeSettings } from '../shared/settings.js';
import { PICTURES_PLACE } from './setup-model.js';

/** @typedef {import('../shared/types.js').Settings} Settings */

// The keys of a shortcut text, one for each keycap (src/lib/keys.js).
export { shortcutParts };

/**
 * Values of the form controls, by setting name. Numbers are strings (like `input.value`).
 * Checkboxes are booleans. A missing key means "use the default".
 * @typedef {Readonly<Partial<Record<keyof Settings, string | boolean>>>} FormRecord
 */

/**
 * @typedef {Object} FieldBase
 * @property {keyof Settings} key
 * @property {string} group   One of GROUPS[].id.
 * @property {string} label   Short, plain English.
 * @property {string} help    One short line. Shown under the label.
 * @property {string} [noun]   The name of the setting inside a sentence ("folder name"). The
 *                             label in lower case when missing.
 */
/**
 * A number that the page shows as a list of `presets`. A saved value that is not in the list
 * (an older version, or storage that was edited) stays in the list as its own entry, so the
 * form never changes it by accident. Every preset is inside [min, max].
 * @typedef {FieldBase & { type: 'number', unit: 'px' | 'ms', presets: readonly number[],
 *   min: number, max: number, step: number, defaultValue: number }} NumberField
 */
/** @typedef {FieldBase & { type: 'boolean', defaultValue: boolean }} BooleanField */
/**
 * One choice. `aside` is a short note after the label, `detail` a second line (cards only).
 * @typedef {Object} ChoiceOption
 * @property {string} value
 * @property {string} label
 * @property {string} [aside]
 * @property {string} [detail]
 */
/**
 * @typedef {FieldBase & { type: 'choice', options: ReadonlyArray<ChoiceOption>,
 *   defaultValue: string }} ChoiceField
 */
/** @typedef {FieldBase & { type: 'text', maxLength: number, defaultValue: string }} TextField */
/** @typedef {NumberField | BooleanField | ChoiceField | TextField} FieldMeta */

/**
 * @typedef {Object} Adjustment
 * @property {keyof Settings} key
 * @property {string} label
 * @property {string} entered  What the user typed. Empty string when nothing was usable.
 * @property {string} saved    What Spool stored instead.
 */

/** Longest folder name. `normalizeSettings` cuts the name at this length. */
export const FOLDER_NAME_MAX_LENGTH = 40;

/**
 * Form sections, in display order. The page adds the "Shortcut" section itself: the browser
 * owns that key, so it is not a setting of Spool.
 */
export const GROUPS = Object.freeze([
  Object.freeze({ id: 'capture', title: 'Capture' }),
  Object.freeze({ id: 'output', title: 'Output' }),
  Object.freeze({ id: 'location', title: 'Save location' }),
]);

/**
 * @param {'overlapCss' | 'settleMs' | 'maxHeightCss'} key
 * @param {{ group: string, label: string, help: string, unit: 'px' | 'ms' }} text
 * @param {readonly number[]} presets  Ascending. Include the default.
 * @returns {NumberField}
 */
function numberField(key, text, presets) {
  const limits = SETTINGS_LIMITS[key];
  return Object.freeze({
    type: 'number',
    key,
    ...text,
    presets: Object.freeze([...presets]),
    min: limits[0],
    max: limits[1],
    step: 1,
    defaultValue: DEFAULT_SETTINGS[key],
  });
}

/**
 * @param {'hideOverlays' | 'saveTiles' | 'saveFull' | 'copyOnDone'} key
 * @param {{ group: string, label: string, help: string }} text
 * @returns {BooleanField}
 */
function booleanField(key, text) {
  return Object.freeze({ type: 'boolean', key, ...text, defaultValue: DEFAULT_SETTINGS[key] });
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatNumber(n) {
  return n.toLocaleString('en-US');
}

/**
 * The tile size cards. The numbers come from the tiers in the constants.
 * @type {Readonly<Record<string, { label: string, aside: string, detail: string }>>}
 */
const TIER_TEXT = Object.freeze({
  high: Object.freeze({
    label: 'High resolution',
    aside: 'current models',
    detail: `Long edge ${formatNumber(TILE_TIERS.high.maxLongEdgePx)} px · fewer screenshots`,
  }),
  standard: Object.freeze({
    label: 'Standard',
    aside: 'older models',
    detail: `Long edge ${formatNumber(TILE_TIERS.standard.maxLongEdgePx)} px · more screenshots`,
  }),
});

const tierKeys = Object.keys(TILE_TIERS);

/** Form fields, in display order. One entry for each key of `Settings`. */
export const FIELDS = /** @type {readonly FieldMeta[]} */ (
  Object.freeze([
    numberField(
      'overlapCss',
      {
        group: 'capture',
        label: 'Overlap between steps',
        unit: 'px',
        help: 'Repeats a thin strip so no line is cut in half.',
      },
      [32, 64, 80, 96, 128],
    ),
    numberField(
      'settleMs',
      {
        group: 'capture',
        label: 'Wait after each scroll',
        unit: 'ms',
        help: 'More time for pages that load as you scroll.',
      },
      [150, 350, 600, 1000, 2000],
    ),
    numberField(
      'maxHeightCss',
      {
        group: 'capture',
        label: 'Maximum length',
        unit: 'px',
        help: 'A safety stop for endless feeds. Counted in page pixels.',
      },
      [20_000, 40_000, 100_000],
    ),
    booleanField('hideOverlays', {
      group: 'capture',
      label: 'Hide sticky and fixed bars',
      help: 'Keeps headers and footers from repeating down the image.',
    }),
    Object.freeze({
      type: 'choice',
      key: 'tileTier',
      group: 'output',
      label: 'AI screenshot size',
      help: 'How Spool cuts the tall image for your AI.',
      options: Object.freeze(
        tierKeys.map((value) =>
          Object.freeze({
            value,
            label: TIER_TEXT[value]?.label ?? value,
            ...(TIER_TEXT[value]
              ? { aside: TIER_TEXT[value].aside, detail: TIER_TEXT[value].detail }
              : {}),
          }),
        ),
      ),
      defaultValue: DEFAULT_SETTINGS.tileTier,
    }),
    booleanField('saveTiles', {
      group: 'output',
      label: 'Save AI screenshots',
      help: 'One PNG each. Save all includes them.',
    }),
    booleanField('saveFull', {
      group: 'output',
      label: 'Save full image',
      help: 'One tall PNG for people and for your records.',
    }),
    booleanField('copyOnDone', {
      group: 'output',
      label: 'Copy the full image when you finish',
      help:
        'Some systems keep a history of what you copy (Windows, and a Mac with Universal ' +
        'Clipboard). Turn this off to copy only when you ask.',
    }),
    Object.freeze({
      type: 'text',
      key: 'folderName',
      group: 'location',
      label: 'Downloads folder name',
      noun: 'folder name',
      help:
        'Spool saves here when no folder is chosen. It makes this folder in Downloads, and ' +
        'replaces characters that some systems do not allow.',
      maxLength: FOLDER_NAME_MAX_LENGTH,
      defaultValue: DEFAULT_SETTINGS.folderName,
    }),
  ])
);

/**
 * A number with its unit, as the form shows it: "80 px", "20,000 px", "350 ms", "1 s".
 * @param {number} value
 * @param {'px' | 'ms'} unit
 * @returns {string}
 */
export function formatValue(value, unit) {
  if (unit === 'ms' && value >= 1000) {
    const seconds = Math.round(value / 100) / 10;
    return `${formatNumber(seconds)} s`;
  }
  return `${formatNumber(value)} ${unit}`;
}

/**
 * The text of a choice: its label, and its aside in brackets. "High resolution (current models)".
 * @param {ChoiceOption} option
 * @returns {string}
 */
export function optionText(option) {
  return option.aside ? `${option.label} (${option.aside})` : option.label;
}

/**
 * The entries of the list for a number field: the presets, and the current value when it is
 * not one of them. In ascending order. Values are strings (like `select.value`).
 * @param {NumberField} field
 * @param {unknown} current  The value that the form must show (a number or a numeric string).
 * @returns {Array<{ value: string, label: string }>}
 */
export function numberOptions(field, current) {
  const numbers = new Set(field.presets);
  const shown = parseNumberInput(current);
  if (shown !== undefined) numbers.add(shown);
  return [...numbers]
    .sort((a, b) => a - b)
    .map((n) => ({ value: String(n), label: formatValue(n, field.unit) }));
}

/**
 * One line that tells the user the allowed values and the default of a field. The page shows
 * it as the tooltip of the control.
 * @param {FieldMeta} field
 * @returns {string}
 */
export function fieldHint(field) {
  switch (field.type) {
    case 'number':
      return (
        `Allowed: ${formatNumber(field.min)} to ${formatNumber(field.max)} ${field.unit}. ` +
        `Default: ${formatNumber(field.defaultValue)} ${field.unit}.`
      );
    case 'boolean':
      return `Default: ${field.defaultValue ? 'on' : 'off'}.`;
    case 'choice': {
      const option = field.options.find((o) => o.value === field.defaultValue);
      return `Default: ${option ? optionText(option) : field.defaultValue}.`;
    }
    case 'text':
      return `Default: ${field.defaultValue}. Maximum: ${field.maxLength} characters.`;
  }
}

// ---------------------------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------------------------

const DECIMAL_RE = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Reads a number from a form value. Accepts plain decimal text only: no exponent, no hex, no
 * unit text. Returns undefined when the value is not usable.
 * @param {unknown} value
 * @returns {number | undefined}
 */
export function parseNumberInput(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value !== 'string') return undefined;
  const text = value.trim();
  if (!DECIMAL_RE.test(text)) return undefined;
  const n = Number(text);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * @param {unknown} value
 * @returns {boolean | undefined}
 */
function parseBooleanInput(value) {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  if (text === 'true' || text === 'on') return true;
  if (text === 'false' || text === 'off') return false;
  return undefined;
}

/**
 * Converts settings to form values. Any input is safe: it goes through `normalizeSettings`.
 * @param {unknown} settings
 * @returns {Record<keyof Settings, string | boolean>}
 */
export function settingsToForm(settings) {
  const s = normalizeSettings(settings);
  return {
    overlapCss: String(s.overlapCss),
    settleMs: String(s.settleMs),
    maxHeightCss: String(s.maxHeightCss),
    hideOverlays: s.hideOverlays,
    tileTier: s.tileTier,
    saveTiles: s.saveTiles,
    saveFull: s.saveFull,
    copyOnDone: s.copyOnDone,
    folderName: s.folderName,
  };
}

/**
 * Converts form values to complete, valid settings. A number that is empty or not a plain
 * decimal becomes the default. A number outside the limits is moved to the nearest limit.
 * Unknown keys are ignored.
 * @param {FormRecord | null | undefined} record
 * @returns {Settings}
 */
export function formToSettings(record) {
  const r = /** @type {Record<string, unknown>} */ (
    typeof record === 'object' && record !== null && !Array.isArray(record) ? record : {}
  );
  return normalizeSettings({
    overlapCss: parseNumberInput(r.overlapCss),
    settleMs: parseNumberInput(r.settleMs),
    maxHeightCss: parseNumberInput(r.maxHeightCss),
    hideOverlays: parseBooleanInput(r.hideOverlays),
    tileTier: typeof r.tileTier === 'string' ? r.tileTier.trim() : undefined,
    saveTiles: parseBooleanInput(r.saveTiles),
    saveFull: parseBooleanInput(r.saveFull),
    copyOnDone: parseBooleanInput(r.copyOnDone),
    folderName: r.folderName,
  });
}

// ---------------------------------------------------------------------------------------------
// Messages for the status line
// ---------------------------------------------------------------------------------------------

/**
 * Lists the fields where the saved value differs from what the user entered. A field that
 * is missing from `record` is skipped.
 * @param {FormRecord | null | undefined} record  What the user entered.
 * @param {unknown} settings                      What Spool stored.
 * @returns {Adjustment[]}
 */
export function findAdjustments(record, settings) {
  const r = /** @type {Record<string, unknown>} */ (
    typeof record === 'object' && record !== null && !Array.isArray(record) ? record : {}
  );
  const saved = settingsToForm(settings);
  /** @type {Adjustment[]} */
  const out = [];
  for (const field of FIELDS) {
    const entered = r[field.key];
    if (entered === undefined) continue;
    const kept = String(saved[field.key]);
    let same;
    switch (field.type) {
      case 'number': {
        const n = parseNumberInput(entered);
        same = n !== undefined && String(n) === kept;
        break;
      }
      case 'boolean': {
        const b = parseBooleanInput(entered);
        same = b !== undefined && String(b) === kept;
        break;
      }
      case 'choice':
      case 'text':
        same = typeof entered === 'string' && entered.trim() === kept;
        break;
    }
    if (!same) {
      out.push({
        key: field.key,
        label: field.label,
        entered: typeof entered === 'string' ? entered.trim() : '',
        saved: field.type === 'boolean' ? (saved[field.key] ? 'on' : 'off') : kept,
      });
    }
  }
  return out;
}

/**
 * The sentence for a value that was empty: The folder name was empty, so Spool used "Spool".
 * @param {Adjustment} a
 * @returns {string}
 */
function describeEmpty(a) {
  const field = FIELDS.find((f) => f.key === a.key);
  const noun = field?.noun ?? a.label.toLowerCase();
  const used =
    field?.type === 'number'
      ? formatValue(Number(a.saved), field.unit)
      : field?.type === 'text'
        ? `"${a.saved}"`
        : a.saved;
  return `The ${noun} was empty, so Spool used ${used}.`;
}

/**
 * Plain-English text for a list of adjustments. Empty string when the list is empty. A value
 * that the browser moved into the limits says what it became. A value that was empty says what
 * Spool used, as a plain sentence.
 * @param {readonly Adjustment[]} adjustments
 * @returns {string}
 */
export function describeAdjustments(adjustments) {
  if (adjustments.length === 0) return '';
  const moved = adjustments.filter((a) => a.entered !== '');
  const empty = adjustments.filter((a) => a.entered === '');
  /** @type {string[]} */
  const parts = [];
  if (moved.length > 0) {
    const count = moved.length === 1 ? '1 value' : `${moved.length} values`;
    parts.push(
      `Spool changed ${count} to fit the limits.`,
      ...moved.map((a) => `${a.label}: ${a.entered} became ${a.saved}.`),
    );
  }
  parts.push(...empty.map(describeEmpty));
  return parts.join(' ');
}

/**
 * Warnings about a combination of settings that is valid but not useful.
 * @param {unknown} settings
 * @returns {string[]}
 */
export function settingsWarnings(settings) {
  const s = normalizeSettings(settings);
  /** @type {string[]} */
  const out = [];
  if (!s.saveTiles && !s.saveFull) {
    out.push('Save all will have nothing to save. Turn on AI screenshots, the full image, or both.');
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// Save folder (the "Save location" group)
// ---------------------------------------------------------------------------------------------

/** @typedef {'granted' | 'prompt' | 'denied'} FolderPermission */

/**
 * What the page shows about the chosen save folder.
 * @typedef {Object} SaveFolderView
 * @property {string} title        The place ("Pictures › Screenshots"), or the Downloads place
 *                                 when no folder is chosen.
 * @property {'none' | FolderPermission} state
 * @property {string} help         One line under the title.
 * @property {string} note         The line about the permission lifetime. Empty when it does not
 *                                 apply.
 * @property {{ id: 'pictures' | 'other' | 'reconnect', label: string } | null} primary
 *   The button that fixes the state (amber). `pictures` and `other` open the picker.
 * @property {boolean} showChange  "Change folder" (the user picks another folder).
 * @property {boolean} showOther   "Choose another folder" (no folder is chosen yet).
 * @property {boolean} showClear   "Use Downloads instead" (a folder is chosen).
 */

/**
 * Chrome ends the permission of a folder when the last page of the extension closes, unless
 * the user chooses "Allow on every visit" in the prompt (docs/browser-behavior.md).
 */
const PERMISSION_NOTE =
  'Your browser may forget this folder when you close this tab or restart. ' +
  'When you reconnect, choose “Allow on every visit” to stop that.';

/**
 * Text and buttons for the save folder, from what the page knows: the place of the chosen
 * folder (null when none), its permission state, whether it was made below a picked folder, and
 * the name of the Downloads folder.
 * @param {{ label: string | null, permission: FolderPermission, folderName: string,
 *   subPath?: readonly string[] }} input
 *   `label`: the place of the target ("Pictures › Screenshots"), made with `targetPlace`.
 * @returns {SaveFolderView}
 */
export function describeSaveFolder({ label, permission, folderName, subPath = [] }) {
  const downloads = downloadsPlace(folderName);
  if (label === null) {
    return {
      title: downloads,
      state: 'none',
      help: 'Default until you pick.',
      note: '',
      primary: { id: 'pictures', label: `Save to ${PICTURES_PLACE}` },
      showChange: false,
      showOther: true,
      showClear: false,
    };
  }
  const place = label === '' ? 'Chosen folder' : label;
  if (permission === 'denied') {
    return {
      title: 'Folder not found',
      state: 'denied',
      help: `Saving to ${downloads} until you pick again.`,
      note: '',
      primary: { id: subPath.length > 0 ? 'pictures' : 'other', label: 'Pick again' },
      showChange: false,
      showOther: false,
      showClear: true,
    };
  }
  const granted = permission === 'granted';
  return {
    title: place,
    state: permission,
    help: granted ? 'Connected.' : `Needs one click. Saving to ${downloads} until then.`,
    note: PERMISSION_NOTE,
    primary: granted ? null : { id: 'reconnect', label: 'Reconnect' },
    showChange: true,
    showOther: false,
    showClear: true,
  };
}
