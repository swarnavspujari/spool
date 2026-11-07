// @ts-check
/**
 * Pure model of the setup screens (docs/contracts.md section 6.3): the welcome page that opens on
 * install, the same page for "Set up" on the toast, and the card for "Reconnect". It holds the
 * words and the choices, and no DOM and no `chrome.*`, so Node can test it.
 *
 * Text may mark a part in bold with `**`. The page turns each pair into a `<strong>` element with
 * `createElement` (never markup).
 */

import { defaultShortcut, platformKind, plainPasteLabel, pasteLabel } from '../lib/keys.js';
import { joinPlace } from '../lib/labels.js';
import { DEFAULT_SUBFOLDER } from '../shared/constants.js';

export { platformKind };

/** @typedef {import('../lib/keys.js').Platform} Platform */

/** The place that the one-click setup uses. */
export const PICTURES_PLACE = joinPlace('Pictures', DEFAULT_SUBFOLDER);

/**
 * Words that depend on the system.
 * @param {Platform} platform
 * @returns {{ selectFolder: string, paste: string, plainPaste: string }}
 *   `selectFolder`: the button of the folder window. `plainPaste`: the chord that pastes text only.
 */
export function systemWords(platform) {
  return {
    selectFolder: platform === 'windows' ? 'Select Folder' : 'Open',
    paste: pasteLabel(platform).text,
    plainPaste: plainPasteLabel(platform).text,
  };
}

/**
 * The keys that the manifest suggests on Windows and Linux. A Mac has its own: `defaultShortcut`
 * in src/lib/keys.js gives the keys of every system.
 */
export const DEFAULT_KEYS = Object.freeze({ start: 'Alt+Shift+S', insert: 'Alt+Shift+V' });

/**
 * @typedef {Object} ActionView
 * @property {'pictures' | 'other' | 'downloads' | 'again' | 'change'} id
 * @property {string} label
 * @property {'primary' | 'secondary' | 'quiet'} tone
 * @property {boolean} disabled
 */

/**
 * @typedef {Object} SetupView
 * @property {string} heading
 * @property {string} lead
 * @property {ActionView[]} actions
 * @property {string[]} next      "What happens next": short paragraphs. Only while picking.
 * @property {{ title: string, text: string } | null} callout  A tinted note.
 * @property {{ level: 'info' | 'error', title: string, text: string } | null} message
 *   What the last try gave (a cancel, a blocked folder). `title` may be empty.
 */

/**
 * @typedef {'pick' | 'waiting' | 'connected' | 'downloads' | 'no-picker'} SetupPhase
 */

/**
 * What the last try gave, to show above the buttons.
 * @typedef {'cancelled' | 'blocked' | 'failed'} SetupProblem
 */

/**
 * @param {string} text
 * @returns {string}
 */
function bold(text) {
  return `**${text}**`;
}

/**
 * The words for "press <key>" or, when the browser has no key for the command, a click on the
 * toolbar button.
 * @param {string} key
 * @returns {string}
 */
function startPhrase(key) {
  return key === '' ? 'click the Spool button in the toolbar' : `press ${bold(key)}`;
}

/**
 * The screen of the welcome page for one phase.
 * @param {{
 *   phase: SetupPhase,
 *   intro?: 'welcome' | 'setup',
 *   kind?: 'pictures' | 'other',
 *   platform: Platform,
 *   label?: string,
 *   downloads: string,
 *   startKey?: string,
 *   problem?: SetupProblem | null,
 * }} input
 *   `kind`: what the user is picking (while `waiting`). `label`: the place that is set (when
 *   `connected`). `downloads`: "Downloads › Spool". `startKey`: the key that starts a capture.
 * @returns {SetupView}
 */
export function describeSetup(input) {
  const { phase, platform, downloads } = input;
  const system = systemWords(platform);
  const startKey = input.startKey ?? defaultShortcut(platform, 'start');
  const label = input.label ?? '';
  const busy = phase === 'waiting';
  /** @param {ActionView['id']} id @param {string} text @param {ActionView['tone']} tone */
  const action = (id, text, tone) => ({ id, label: text, tone, disabled: busy });

  /** @type {SetupView} */
  const view = {
    heading: '',
    lead: '',
    actions: [],
    next: [],
    callout: null,
    message: null,
  };

  if (phase === 'no-picker') {
    view.heading = "This browser can't pick folders.";
    view.lead = `Screenshots save to ${downloads} instead. Everything else works.`;
    return view;
  }

  if (phase === 'connected') {
    view.heading = "You're set.";
    view.lead =
      `Screenshots now save to ${bold(label || 'the folder you chose')}. ` +
      `Go to any long page and ${startPhrase(startKey)}.`;
    view.callout = {
      title: 'One more click, once',
      text:
        'Your browser may forget this folder when you close this tab or restart. ' +
        `If a capture lands in Downloads, click Reconnect and choose ${bold('Allow on every visit')}. ` +
        "It won't ask again.",
    };
    view.actions = [action('change', 'Change folder', 'quiet')];
    return view;
  }

  if (phase === 'downloads') {
    view.heading = 'Downloads it is.';
    view.lead =
      `Screenshots save to ${bold(downloads)}. Change this any time in Settings. ` +
      `${startPhrase(startKey).replace(/^./, (c) => c.toUpperCase())} on any long page to start.`;
    view.actions = [action('again', 'Choose a folder instead', 'secondary')];
    return view;
  }

  view.actions = [
    action('pictures', `Save to ${PICTURES_PLACE}`, 'primary'),
    action('other', 'Choose another folder', 'secondary'),
    action('downloads', 'Keep using Downloads', 'quiet'),
  ];

  if (phase === 'waiting') {
    const where = input.kind === 'other' ? 'a folder' : 'Pictures';
    view.heading = `Choose ${where} in the window.`;
    view.lead =
      `Press ${bold(system.selectFolder)}, then ${bold('Edit files')} when your browser asks.`;
    return view;
  }

  // phase === 'pick'
  if (input.intro === 'setup') {
    view.heading = 'Where should screenshots go?';
    view.lead =
      'Pick a folder, and your browser will remember it. ' +
      `Until then, Spool saves to ${downloads}.`;
  } else {
    view.heading = 'One click and Spool is ready.';
    view.lead =
      'Select. Scroll. Paste. Pick where your screenshots go, and your browser will remember it.';
  }
  view.next = [
    `A folder window opens in Pictures. Press ${bold(system.selectFolder)}, then ` +
      `${bold('Edit files')}. Spool creates a ${DEFAULT_SUBFOLDER} folder if you don't have one.`,
    'Your browser will say Spool can edit Pictures. ' +
      `Spool only ever writes inside ${DEFAULT_SUBFOLDER}.`,
  ];
  if (input.problem === 'cancelled') {
    view.message = { level: 'info', title: '', text: 'No folder was chosen. Nothing changed.' };
  } else if (input.problem === 'blocked') {
    view.message = {
      level: 'error',
      title: 'Your browser blocks that folder.',
      text: 'Browsers refuse system folders, Desktop and Downloads themselves. Pictures works.',
    };
  } else if (input.problem === 'failed') {
    view.message = {
      level: 'error',
      title: '',
      text: 'Spool could not use that folder. Try again.',
    };
  }
  return view;
}

/**
 * The side column of the welcome page: what each capture leaves on disk.
 * @param {{ place: string, base: string, tilesFolder: string, tileName: (i: number) => string }} f
 *   `place`: where it goes ("Pictures › Screenshots"). `base`: a sample name without the
 *   extension. `tileName(i)`: the file name of AI screenshot `i` (0-based) of three.
 * @returns {{ place: string, lines: Array<{ depth: number, text: string, strong: boolean }>,
 *   notes: { full: string, ai: string } }}
 */
export function describeLayout({ place, base, tilesFolder, tileName }) {
  return {
    place,
    lines: [
      { depth: 1, text: `${base}.png`, strong: true },
      { depth: 1, text: tilesFolder, strong: true },
      { depth: 2, text: base, strong: false },
      { depth: 3, text: tileName(0), strong: false },
      { depth: 3, text: tileName(1), strong: false },
      { depth: 3, text: tileName(2), strong: false },
    ],
    notes: {
      full: 'The full image. Also on your clipboard.',
      ai: 'Sized so your AI reads every line.',
    },
  };
}

/**
 * "Your three moves": the keys, and the warning about the chord that pastes text only.
 * @param {{ platform: Platform, startKey?: string, insertKey?: string }} f
 *   An empty key means that the browser has none for the command.
 * @returns {{ rows: Array<{ label: string, keys: string }>, warning: string }}
 */
export function describeMoves({ platform, startKey, insertKey }) {
  const system = systemWords(platform);
  const start = startKey ?? defaultShortcut(platform, 'start');
  const insert = insertKey ?? defaultShortcut(platform, 'insert');
  return {
    rows: [
      { label: 'Spool a page', keys: start || 'Not set' },
      { label: 'Paste the full image', keys: system.paste },
      { label: 'Insert all AI screenshots', keys: insert || 'Not set' },
    ],
    warning:
      `Use ${system.paste}, not ${system.plainPaste}: ` +
      'that one pastes text only, so images vanish.',
  };
}

/**
 * The notice about what Spool keeps (the file and the clipboard copy of every capture).
 * @returns {{ title: string, text: string, link: string }}
 */
export function describeKeeping() {
  return {
    title: 'What Spool keeps',
    text:
      'Each capture is saved as files and copied to your clipboard. The files stay until you ' +
      'delete them, and your clipboard history may keep the image.',
    link: 'Change this in Settings',
  };
}

/**
 * @typedef {'idle' | 'waiting' | 'done' | 'declined' | 'missing'} ReconnectPhase
 */

/**
 * @typedef {Object} ReconnectView
 * @property {string} heading
 * @property {string} lead
 * @property {string} tip         A line under the buttons. May be empty.
 * @property {Array<{ id: 'reconnect' | 'pictures' | 'downloads', label: string,
 *   tone: 'primary' | 'secondary', disabled: boolean }>} actions
 */

/**
 * The card that helps when the browser has dropped access to the folder.
 * @param {{
 *   phase: ReconnectPhase,
 *   label: string,
 *   downloads: string,
 *   reconnects?: number,
 * }} input
 *   `label`: the place that lost access. `reconnects`: how many times the user has used the card
 *   before. From the third time on, the card says that the browser keeps forgetting.
 * @returns {ReconnectView}
 */
export function describeReconnect({ phase, label, downloads, reconnects = 0 }) {
  const place = label || 'the folder you chose';
  const reconnect = (/** @type {boolean} */ disabled) => ({
    id: /** @type {const} */ ('reconnect'),
    label: `Reconnect ${place}`,
    tone: /** @type {const} */ ('primary'),
    disabled,
  });
  if (phase === 'missing') {
    return {
      heading: 'That folder is gone.',
      lead: 'It may have moved or been deleted. Pick it again.',
      tip: '',
      actions: [
        { id: 'pictures', label: `Save to ${PICTURES_PLACE}`, tone: 'primary', disabled: false },
      ],
    };
  }
  if (phase === 'done') {
    return {
      heading: 'Reconnected.',
      lead: `New screenshots save to ${place}.`,
      tip: '',
      actions: [],
    };
  }
  const repeated = reconnects >= 2;
  const actions = [reconnect(phase === 'waiting')];
  if (repeated) {
    actions.push({
      id: /** @type {any} */ ('downloads'),
      label: 'Use Downloads',
      tone: /** @type {any} */ ('secondary'),
      disabled: phase === 'waiting',
    });
  }
  const declined =
    phase === 'declined'
      ? `Not reconnected yet. Spool saves to ${downloads} until you allow it.`
      : '';
  if (repeated) {
    return {
      heading: 'Your browser keeps forgetting.',
      lead:
        declined ||
        `Pick ${bold('Allow on every visit')} next time. If that option never shows, ` +
          'keep one Spool tab open, or use Downloads.',
      tip: '',
      actions,
    };
  }
  return {
    heading: 'Your browser forgot this folder.',
    lead:
      declined ||
      'It can do this after the last Spool tab closes, or after a restart. ' +
        'One click brings it back.',
    tip: `Choose ${bold('Allow on every visit')} when asked.`,
    actions,
  };
}

/**
 * Splits text at `**` into plain and bold parts.
 * @param {string} text
 * @returns {Array<{ text: string, strong: boolean }>}
 */
export function richParts(text) {
  return text
    .split('**')
    .map((part, i) => ({ text: part, strong: i % 2 === 1 }))
    .filter((part) => part.text !== '');
}
