// @ts-check
/**
 * The words and the choices of the welcome page and the reconnect card (src/options/
 * setup-model.js), and the checks of the markup and the styles that no browser run covers here:
 * every element that a script needs exists, the buttons of the welcome page are 44 px high, and
 * the colors that carry text pass the contrast rule in both color schemes.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import { downloadsPlace, targetPlace } from '../../src/lib/labels.js';
import {
  DEFAULT_KEYS,
  PICTURES_PLACE,
  describeKeeping,
  describeLayout,
  describeMoves,
  describeReconnect,
  describeSetup,
  platformKind,
  richParts,
  systemWords,
} from '../../src/options/setup-model.js';

const DOWNLOADS = downloadsPlace('Spool');

/**
 * @param {Partial<Parameters<typeof describeSetup>[0]>} over
 */
const setup = (over = {}) =>
  describeSetup({ phase: 'pick', platform: 'windows', downloads: DOWNLOADS, ...over });

describe('platformKind and systemWords', () => {
  it('knows Windows, Mac and Linux from the platform string of the browser', () => {
    assert.equal(platformKind('Win32'), 'windows');
    assert.equal(platformKind('Windows'), 'windows');
    assert.equal(platformKind('MacIntel'), 'mac');
    assert.equal(platformKind('macOS'), 'mac');
    assert.equal(platformKind('Linux x86_64'), 'linux');
    assert.equal(platformKind('CrOS'), 'linux');
    assert.equal(platformKind(''), 'linux');
    assert.equal(platformKind(undefined), 'linux');
  });

  it('names the button of the folder window, the paste key and the key for text only', () => {
    assert.deepEqual(systemWords('windows'), {
      selectFolder: 'Select Folder',
      paste: 'Ctrl+V',
      plainPaste: 'Ctrl+Shift+V',
    });
    assert.deepEqual(systemWords('mac'), { selectFolder: 'Open', paste: '⌘V', plainPaste: '⌘⇧V' });
    assert.deepEqual(systemWords('linux'), {
      selectFolder: 'Open',
      paste: 'Ctrl+V',
      plainPaste: 'Ctrl+Shift+V',
    });
  });
});

describe('describeSetup: the welcome page', () => {
  it('first run: one click, three choices in the order of the design', () => {
    const view = setup({ intro: 'welcome' });
    assert.equal(view.heading, 'One click and Spool is ready.');
    assert.equal(
      view.lead,
      'Select. Scroll. Paste. Pick where your screenshots go, and your browser will remember it.',
    );
    assert.deepEqual(
      view.actions.map((a) => [a.id, a.label, a.tone, a.disabled]),
      [
        ['pictures', 'Save to Pictures › Screenshots', 'primary', false],
        ['other', 'Choose another folder', 'secondary', false],
        ['downloads', 'Keep using Downloads', 'quiet', false],
      ],
    );
    assert.equal(view.message, null);
    assert.equal(view.callout, null);
  });

  it('"Set up" from the toast has its own heading and says where it saves until then', () => {
    const view = setup({ intro: 'setup' });
    assert.equal(view.heading, 'Where should screenshots go?');
    assert.ok(view.lead.includes(DOWNLOADS));
    assert.equal(view.actions[0]?.label, 'Save to Pictures › Screenshots');
  });

  it('says what the folder window and the browser will ask, with the key of the system', () => {
    for (const [platform, button] of /** @type {const} */ ([
      ['windows', 'Select Folder'],
      ['mac', 'Open'],
      ['linux', 'Open'],
    ])) {
      const view = setup({ platform });
      assert.equal(
        view.next[0],
        `A folder window opens in Pictures. Press **${button}**, then **Edit files**. ` +
          "Spool creates a Screenshots folder if you don't have one.",
        platform,
      );
      assert.equal(
        view.next[1],
        'Your browser will say Spool can edit Pictures. Spool only ever writes inside Screenshots.',
      );
    }
  });

  it('while the folder window is open: nothing to click, and the words for this system', () => {
    const view = setup({ phase: 'waiting', kind: 'pictures', platform: 'windows' });
    assert.equal(view.heading, 'Choose Pictures in the window.');
    assert.equal(view.lead, 'Press **Select Folder**, then **Edit files** when your browser asks.');
    assert.ok(view.actions.length > 0 && view.actions.every((a) => a.disabled));
    assert.equal(setup({ phase: 'waiting', kind: 'other' }).heading, 'Choose a folder in the window.');
    assert.equal(
      setup({ phase: 'waiting', platform: 'mac' }).lead,
      'Press **Open**, then **Edit files** when your browser asks.',
    );
  });

  it('connected: names the place, the key to start, and the tip about "Allow on every visit"', () => {
    const view = setup({ phase: 'connected', label: 'Pictures › Screenshots', startKey: 'Alt+Shift+S' });
    assert.equal(view.heading, "You're set.");
    assert.equal(
      view.lead,
      'Screenshots now save to **Pictures › Screenshots**. ' +
        'Go to any long page and press **Alt+Shift+S**.',
    );
    assert.deepEqual(view.callout, {
      title: 'One more click, once',
      text:
        'Your browser may forget this folder when you close this tab or restart. ' +
        'If a capture lands in Downloads, click Reconnect and choose **Allow on every visit**. ' +
        "It won't ask again.",
    });
    assert.deepEqual(
      view.actions.map((a) => [a.id, a.label]),
      [['change', 'Change folder']],
    );
  });

  it('connected without a key for the command: says to click the toolbar button', () => {
    const view = setup({ phase: 'connected', label: 'Pictures › Screenshots', startKey: '' });
    assert.ok(view.lead.endsWith('click the Spool button in the toolbar.'));
  });

  it('downloads: says where, how to change it, and offers a folder again', () => {
    const view = setup({ phase: 'downloads', startKey: 'Alt+Shift+S' });
    assert.equal(view.heading, 'Downloads it is.');
    assert.equal(
      view.lead,
      'Screenshots save to **Downloads › Spool**. Change this any time in Settings. ' +
        'Press **Alt+Shift+S** on any long page to start.',
    );
    assert.deepEqual(
      view.actions.map((a) => [a.id, a.label, a.tone]),
      [['again', 'Choose a folder instead', 'secondary']],
    );
  });

  it('a browser that cannot pick folders: Downloads, and no buttons', () => {
    const view = setup({ phase: 'no-picker' });
    assert.equal(view.heading, "This browser can't pick folders.");
    assert.equal(view.lead, 'Screenshots save to Downloads › Spool instead. Everything else works.');
    assert.deepEqual(view.actions, []);
  });

  it('what the last try gave: cancelled, blocked, failed', () => {
    assert.deepEqual(setup({ problem: 'cancelled' }).message, {
      level: 'info',
      title: '',
      text: 'No folder was chosen. Nothing changed.',
    });
    assert.deepEqual(setup({ problem: 'blocked' }).message, {
      level: 'error',
      title: 'Your browser blocks that folder.',
      text: 'Browsers refuse system folders, Desktop and Downloads themselves. Pictures works.',
    });
    assert.deepEqual(setup({ problem: 'failed' }).message, {
      level: 'error',
      title: '',
      text: 'Spool could not use that folder. Try again.',
    });
    assert.equal(setup({ problem: null }).message, null);
    // A failed try keeps the three choices, so the user can try again.
    assert.equal(setup({ problem: 'blocked' }).actions.length, 3);
  });

  it('every sentence is short and no text holds markup', () => {
    for (const phase of /** @type {const} */ (['pick', 'waiting', 'connected', 'downloads', 'no-picker'])) {
      for (const platform of /** @type {const} */ (['windows', 'mac', 'linux'])) {
        const view = setup({ phase, platform, label: 'Pictures › Screenshots', problem: 'blocked' });
        const texts = [
          view.heading,
          view.lead,
          ...view.next,
          ...(view.callout ? [view.callout.title, view.callout.text] : []),
          ...(view.message ? [view.message.title, view.message.text] : []),
          ...view.actions.map((a) => a.label),
        ];
        for (const text of texts) {
          assert.doesNotMatch(text, /[<>&]/, text);
          for (const sentence of text.replace(/\*\*/g, '').split(/(?<=[.?!])\s+/)) {
            assert.ok(sentence.split(/\s+/).length <= 25, `Sentence is too long: ${sentence}`);
          }
        }
      }
    }
  });
});

describe('describeLayout, describeMoves and describeKeeping', () => {
  it('shows the layout on disk with the real names', () => {
    const layout = describeLayout({
      place: 'Pictures › Screenshots',
      base: 'Spool 2026-11-06 14.03.05',
      tilesFolder: 'Spool for AI',
      tileName: (i) => `screenshot-0${i + 1}-of-03.png`,
    });
    assert.equal(layout.place, 'Pictures › Screenshots');
    assert.deepEqual(
      layout.lines.map((l) => [l.depth, l.text]),
      [
        [1, 'Spool 2026-11-06 14.03.05.png'],
        [1, 'Spool for AI'],
        [2, 'Spool 2026-11-06 14.03.05'],
        [3, 'screenshot-01-of-03.png'],
        [3, 'screenshot-02-of-03.png'],
        [3, 'screenshot-03-of-03.png'],
      ],
    );
    assert.deepEqual(layout.notes, {
      full: 'The full image. Also on your clipboard.',
      ai: 'Sized so your AI reads every line.',
    });
  });

  it('lists the three moves with the keys, and warns about the key that pastes text only', () => {
    const windows = describeMoves({ platform: 'windows', startKey: 'Alt+Shift+S', insertKey: 'Alt+Shift+V' });
    assert.deepEqual(windows.rows, [
      { label: 'Spool a page', keys: 'Alt+Shift+S' },
      { label: 'Paste the full image', keys: 'Ctrl+V' },
      { label: 'Insert all AI screenshots', keys: 'Alt+Shift+V' },
    ]);
    assert.equal(
      windows.warning,
      'Use Ctrl+V, not Ctrl+Shift+V: that one pastes text only, so images vanish.',
    );
    assert.equal(
      describeMoves({ platform: 'mac' }).warning,
      'Use ⌘V, not ⌘⇧V: that one pastes text only, so images vanish.',
    );
  });

  it('uses the keys of the manifest when it is not told, and says "Not set" for no key', () => {
    const rows = describeMoves({ platform: 'linux' }).rows;
    assert.equal(rows[0]?.keys, DEFAULT_KEYS.start);
    assert.equal(rows[2]?.keys, DEFAULT_KEYS.insert);
    const none = describeMoves({ platform: 'linux', startKey: '', insertKey: '' }).rows;
    assert.equal(none[0]?.keys, 'Not set');
    assert.equal(none[2]?.keys, 'Not set');
  });

  it('the notice says that captures stay on disk and may stay in the clipboard history', () => {
    const keeping = describeKeeping();
    assert.match(keeping.text, /saved as files/);
    assert.match(keeping.text, /copied to your clipboard/);
    assert.match(keeping.text, /stay until you delete them/);
    assert.match(keeping.text, /clipboard history/);
    assert.equal(keeping.link, 'Change this in Settings');
  });
});

describe('describeReconnect', () => {
  const base = { label: 'Pictures › Screenshots', downloads: DOWNLOADS };

  it('default: one button with the name of the folder, and the tip', () => {
    const view = describeReconnect({ ...base, phase: 'idle' });
    assert.equal(view.heading, 'Your browser forgot this folder.');
    assert.equal(
      view.lead,
      'It can do this after the last Spool tab closes, or after a restart. ' +
        'One click brings it back.',
    );
    assert.equal(view.tip, 'Choose **Allow on every visit** when asked.');
    assert.deepEqual(
      view.actions.map((a) => [a.id, a.label, a.tone, a.disabled]),
      [['reconnect', 'Reconnect Pictures › Screenshots', 'primary', false]],
    );
  });

  it('while the prompt is open the button waits', () => {
    const view = describeReconnect({ ...base, phase: 'waiting' });
    assert.equal(view.actions[0]?.disabled, true);
  });

  it('success says where new screenshots go', () => {
    const view = describeReconnect({ ...base, phase: 'done' });
    assert.equal(view.heading, 'Reconnected.');
    assert.equal(view.lead, 'New screenshots save to Pictures › Screenshots.');
    assert.deepEqual(view.actions, []);
  });

  it('repeated: says that the browser keeps forgetting, and offers Downloads', () => {
    for (const reconnects of [2, 3, 10]) {
      const view = describeReconnect({ ...base, phase: 'idle', reconnects });
      assert.equal(view.heading, 'Your browser keeps forgetting.');
      assert.equal(
        view.lead,
        'Pick **Allow on every visit** next time. If that option never shows, ' +
          'keep one Spool tab open, or use Downloads.',
      );
      assert.deepEqual(
        view.actions.map((a) => [a.id, a.label, a.tone]),
        [
          ['reconnect', 'Reconnect Pictures › Screenshots', 'primary'],
          ['downloads', 'Use Downloads', 'secondary'],
        ],
      );
    }
    assert.equal(describeReconnect({ ...base, phase: 'idle', reconnects: 1 }).heading, 'Your browser forgot this folder.');
  });

  it('the folder is gone: pick it again in Pictures', () => {
    const view = describeReconnect({ ...base, phase: 'missing' });
    assert.equal(view.heading, 'That folder is gone.');
    assert.equal(view.lead, 'It may have moved or been deleted. Pick it again.');
    assert.deepEqual(
      view.actions.map((a) => [a.id, a.label]),
      [['pictures', 'Save to Pictures › Screenshots']],
    );
  });

  it('declined: says that nothing changed and where Spool saves until then', () => {
    const view = describeReconnect({ ...base, phase: 'declined' });
    assert.equal(
      view.lead,
      'Not reconnected yet. Spool saves to Downloads › Spool until you allow it.',
    );
    assert.equal(view.actions[0]?.id, 'reconnect', 'the user can try again');
  });

  it('a folder with no name has a plain place', () => {
    const view = describeReconnect({ ...base, label: '', phase: 'idle' });
    assert.equal(view.actions[0]?.label, 'Reconnect the folder you chose');
  });
});

describe('richParts and the places', () => {
  it('splits text at ** into plain and bold parts', () => {
    assert.deepEqual(richParts('Press **Open**, then **Edit files** now.'), [
      { text: 'Press ', strong: false },
      { text: 'Open', strong: true },
      { text: ', then ', strong: false },
      { text: 'Edit files', strong: true },
      { text: ' now.', strong: false },
    ]);
    assert.deepEqual(richParts('plain'), [{ text: 'plain', strong: false }]);
    assert.deepEqual(richParts(''), []);
  });

  it('the places use one separator everywhere', () => {
    assert.equal(PICTURES_PLACE, 'Pictures › Screenshots');
    assert.equal(targetPlace('Pictures', ['Screenshots']), PICTURES_PLACE);
    assert.equal(targetPlace('Screenshots', []), 'Screenshots');
    assert.equal(targetPlace('', ['Screenshots']), 'Screenshots', 'the root of a drive has no name');
    assert.equal(targetPlace('Work', ['A', 'B']), 'Work › A › B');
  });
});

// ---------------------------------------------------------------------------------------------
// Markup and styles
// ---------------------------------------------------------------------------------------------

const read = (/** @type {string} */ path) =>
  readFileSync(new URL(`../../${path}`, import.meta.url), 'utf8');
const HTML = read('src/options/options.html');
const CSS = read('src/options/options.css');
const BASE_CSS = read('src/ui/base.css');
const TOKENS = read('src/ui/tokens.css');

describe('options.html has every element that the scripts need', () => {
  for (const file of ['src/options/setup-ui.js', 'src/options/options.js']) {
    it(`${file}`, () => {
      const source = read(file);
      const ids = [...source.matchAll(/byId\('([^']+)'/g)].map((m) => m[1]);
      assert.ok(ids.length > 0);
      for (const id of ids) {
        assert.match(HTML, new RegExp(`\\bid="${id}"`), `#${id}`);
      }
    });
  }

  it('the welcome page and the reconnect card start hidden, and the headings can take focus', () => {
    assert.match(HTML, /<div id="welcome" class="welcome" hidden>/);
    assert.match(HTML, /<section\s+id="reconnect"[^>]*\bhidden\b/);
    assert.match(HTML, /id="welcome-heading"[^>]*tabindex="-1"/);
    assert.match(HTML, /id="reconnect-heading"[^>]*tabindex="-1"/);
  });

  it('the changing text is a live region', () => {
    assert.match(HTML, /id="welcome-live"[^>]*aria-live="polite"/);
    assert.match(HTML, /id="reconnect"[^>]*aria-live="polite"/);
  });
});

describe('styles: 44 px targets, focus, motion', () => {
  it('the large button is 44 px high, and the welcome page uses it for every choice', () => {
    assert.match(BASE_CSS, /\.sp-btn-lg\s*\{[^}]*height:\s*44px/);
    const source = read('src/options/setup-ui.js');
    assert.match(source, /sp-btn sp-btn-lg/);
    assert.match(CSS, /\.welcome \.sp-btn-link\s*\{[^}]*min-height:\s*44px/);
  });

  it('keeps the focus ring and removes motion for people who ask', () => {
    assert.match(BASE_CSS, /:focus-visible\s*\{[^}]*box-shadow/);
    assert.match(TOKENS, /prefers-reduced-motion: reduce[\s\S]*--dur-base:\s*0\.01ms/);
  });

  it('the system font comes first, with the Segoe UI family behind it', () => {
    const text = /--font-text:\s*([^;]+);/.exec(TOKENS)?.[1] ?? '';
    assert.ok(text.trim().startsWith('system-ui, -apple-system,'), text);
    assert.match(text, /'Segoe UI Variable Text'.*'Segoe UI'/s);
    const display = /--font-display:\s*([^;]+);/.exec(TOKENS)?.[1] ?? '';
    assert.ok(display.trim().startsWith('system-ui, -apple-system,'), display);
  });
});

describe('styles: text colors pass the contrast rule (4.5 to 1) in both color schemes', () => {
  /** @param {string} css @returns {Record<string, string>} */
  function tokensOf(css) {
    /** @type {Record<string, string>} */
    const out = {};
    for (const m of css.matchAll(/--([a-z-]+):\s*(#[0-9a-fA-F]{6})\s*;/g)) out[m[1] ?? ''] = m[2] ?? '';
    return out;
  }
  const light = tokensOf(TOKENS.slice(0, TOKENS.indexOf('@media (prefers-color-scheme: dark)')));
  const darkOnly = tokensOf(
    TOKENS.slice(
      TOKENS.indexOf('@media (prefers-color-scheme: dark)'),
      TOKENS.indexOf('/* Reduced motion'),
    ),
  );
  const dark = { ...light, ...darkOnly };

  /** @param {string} hex */
  function luminance(hex) {
    const channel = (/** @type {number} */ i) => {
      const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
  }
  /** @param {string} a @param {string} b */
  function ratio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
  }

  // Text color on the ground that the welcome page and the reconnect card put it on.
  const pairs = [
    ['text', 'bg'],
    ['text', 'surface'],
    ['muted', 'bg'],
    ['muted', 'surface'],
    ['on-accent', 'accent'],
    ['on-accent', 'accent-hover'],
    ['text', 'accent-tint'],
    ['accent-text', 'surface'],
    ['accent-text', 'bg'],
    ['danger', 'danger-bg'],
    ['muted', 'hover'],
    ['text', 'hover'],
  ];
  for (const [scheme, tokens] of /** @type {const} */ ([
    ['light', light],
    ['dark', dark],
  ])) {
    for (const [fg, bg] of pairs) {
      it(`${scheme}: ${fg} on ${bg}`, () => {
        const a = tokens[fg ?? ''];
        const b = tokens[bg ?? ''];
        assert.ok(a && b, `${fg} and ${bg} are tokens`);
        assert.ok(ratio(a, b) >= 4.5, `${fg} on ${bg} is ${ratio(a, b).toFixed(2)} to 1`);
      });
    }
  }
});
