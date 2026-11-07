// @ts-check
/**
 * Tests for src/lib/keys.js: how a shortcut is written on screen, for Windows, Linux and a Mac.
 * `chrome.commands.getAll()` gives words joined by "+" on Windows and Linux ("Alt+Shift+V") and
 * glyphs on a Mac ("⌃⇧V"). The code accepts both everywhere. The last block checks the keys of
 * the manifest against the defaults that the code falls back to.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  defaultShortcut,
  joinKeys,
  keyLabel,
  pasteLabel,
  plainPasteLabel,
  platformKind,
  shortcutParts,
} from '../../src/lib/keys.js';
import { shortcutParts as formModelParts } from '../../src/options/form-model.js';

const MANIFEST = JSON.parse(
  readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'),
);

describe('platformKind', () => {
  it('knows a Mac, an iPad and an iPhone by their platform strings, in any case', () => {
    for (const name of ['MacIntel', 'macOS', 'MACINTEL', 'iPhone', 'iPad', 'Macintosh']) {
      assert.equal(platformKind(name), 'mac', name);
    }
  });

  it('knows Windows, and takes everything else for Linux', () => {
    for (const name of ['Win32', 'Windows', 'win64']) assert.equal(platformKind(name), 'windows', name);
    for (const name of ['Linux x86_64', 'CrOS', 'Android', '', 'FreeBSD']) {
      assert.equal(platformKind(name), 'linux', name);
    }
  });

  it('takes a value that is not a string for Linux', () => {
    for (const value of [undefined, null, 7, {}, ['Mac']]) assert.equal(platformKind(value), 'linux');
  });
});

describe('shortcutParts: words joined by "+"', () => {
  it('splits Windows and Linux text into one part for each key', () => {
    assert.deepEqual(shortcutParts('Alt+Shift+S'), ['Alt', 'Shift', 'S']);
    assert.deepEqual(shortcutParts('Ctrl+Shift+V'), ['Ctrl', 'Shift', 'V']);
    assert.deepEqual(shortcutParts(' Ctrl + Shift + Comma '), ['Ctrl', 'Shift', 'Comma']);
    assert.deepEqual(shortcutParts('F9'), ['F9']);
    assert.deepEqual(shortcutParts('Alt+Shift+S', 'windows'), ['Alt', 'Shift', 'S']);
    assert.deepEqual(shortcutParts('Alt+Shift+S', 'linux'), ['Alt', 'Shift', 'S']);
  });

  it('keeps the words of a browser in another language as they are', () => {
    assert.deepEqual(shortcutParts('Strg+Umschalt+V'), ['Strg', 'Umschalt', 'V']);
  });

  it('gives nothing for an empty or missing shortcut, and for a value that is not text', () => {
    for (const value of ['', '   ', '+', '++', undefined, null, 42, {}, ['Alt+S']]) {
      assert.deepEqual(shortcutParts(value), [], JSON.stringify(value));
    }
  });

  it('on a Mac turns the words of a modifier into its glyph, in any case', () => {
    assert.deepEqual(shortcutParts('Alt+Shift+S', 'mac'), ['⌥', '⇧', 'S']);
    assert.deepEqual(shortcutParts('Option+Shift+S', 'mac'), ['⌥', '⇧', 'S']);
    assert.deepEqual(shortcutParts('Command+Shift+Y', 'mac'), ['⌘', '⇧', 'Y']);
    assert.deepEqual(shortcutParts('Cmd+Y', 'mac'), ['⌘', 'Y']);
    assert.deepEqual(shortcutParts('Ctrl+Shift+V', 'mac'), ['⌃', '⇧', 'V']);
    assert.deepEqual(shortcutParts('MacCtrl+Shift+V', 'mac'), ['⌃', '⇧', 'V']);
    assert.deepEqual(shortcutParts('control+shift+v', 'mac'), ['⌃', '⇧', 'v']);
  });

  it('does not touch the words on Windows and Linux (Command cannot be there, Alt stays Alt)', () => {
    assert.deepEqual(shortcutParts('Alt+Shift+S', 'windows'), ['Alt', 'Shift', 'S']);
    assert.deepEqual(shortcutParts('Ctrl+Alt+Delete', 'linux'), ['Ctrl', 'Alt', 'Delete']);
  });
});

describe('shortcutParts: glyphs written together (a Mac)', () => {
  it('gives one part for each modifier glyph and one for the key', () => {
    assert.deepEqual(shortcutParts('⌃⇧V', 'mac'), ['⌃', '⇧', 'V']);
    assert.deepEqual(shortcutParts('⌥⇧S', 'mac'), ['⌥', '⇧', 'S']);
    assert.deepEqual(shortcutParts('⌘⇧Y', 'mac'), ['⌘', '⇧', 'Y']);
    assert.deepEqual(shortcutParts('⌃⌥⇧⌘K', 'mac'), ['⌃', '⌥', '⇧', '⌘', 'K']);
  });

  it('keeps a key that has a name as one part: F5, Space, an arrow', () => {
    assert.deepEqual(shortcutParts('⌘F5', 'mac'), ['⌘', 'F5']);
    assert.deepEqual(shortcutParts('⌥Space', 'mac'), ['⌥', 'Space']);
    assert.deepEqual(shortcutParts('⌃⇧PageUp', 'mac'), ['⌃', '⇧', 'PageUp']);
    assert.deepEqual(shortcutParts('⌘←', 'mac'), ['⌘', '←']);
  });

  it('splits the glyphs on every system: a browser that spells it so is not shown as one key', () => {
    assert.deepEqual(shortcutParts('⌃⇧V', 'windows'), ['⌃', '⇧', 'V']);
    assert.deepEqual(shortcutParts('⌃⇧V'), ['⌃', '⇧', 'V']);
  });

  it('a single key with no modifier is one part', () => {
    assert.deepEqual(shortcutParts('V', 'mac'), ['V']);
    assert.deepEqual(shortcutParts('⌘', 'mac'), ['⌘']);
  });
});

describe('joinKeys, keyLabel', () => {
  it('joins with "+" on Windows and Linux and with nothing on a Mac', () => {
    assert.equal(joinKeys(['Alt', 'Shift', 'V'], 'windows'), 'Alt+Shift+V');
    assert.equal(joinKeys(['Alt', 'Shift', 'V']), 'Alt+Shift+V');
    assert.equal(joinKeys(['⌃', '⇧', 'V'], 'mac'), '⌃⇧V');
    assert.equal(joinKeys([], 'mac'), '');
  });

  it('gives the parts and the text of a key, for the system', () => {
    assert.deepEqual(keyLabel('Alt+Shift+V', 'windows'), {
      parts: ['Alt', 'Shift', 'V'],
      text: 'Alt+Shift+V',
    });
    assert.deepEqual(keyLabel('⌃⇧V', 'mac'), { parts: ['⌃', '⇧', 'V'], text: '⌃⇧V' });
    assert.deepEqual(keyLabel('Alt+Shift+V', 'mac'), { parts: ['⌥', '⇧', 'V'], text: '⌥⇧V' });
  });

  it('a command with no key has no parts and no text', () => {
    for (const none of ['', undefined, null]) {
      assert.deepEqual(keyLabel(none, 'mac'), { parts: [], text: '' });
      assert.deepEqual(keyLabel(none, 'windows'), { parts: [], text: '' });
    }
  });

  it('the options page uses the same function', () => {
    assert.equal(formModelParts, shortcutParts);
  });
});

describe('the Paste key, and the key that pastes text only', () => {
  it('is Ctrl+V on Windows and Linux and ⌘V on a Mac', () => {
    assert.deepEqual(pasteLabel('windows'), { parts: ['Ctrl', 'V'], text: 'Ctrl+V' });
    assert.deepEqual(pasteLabel('linux'), { parts: ['Ctrl', 'V'], text: 'Ctrl+V' });
    assert.deepEqual(pasteLabel('mac'), { parts: ['⌘', 'V'], text: '⌘V' });
  });

  it('plain paste is Ctrl+Shift+V, and ⌘⇧V on a Mac', () => {
    assert.equal(plainPasteLabel('windows').text, 'Ctrl+Shift+V');
    assert.equal(plainPasteLabel('linux').text, 'Ctrl+Shift+V');
    assert.equal(plainPasteLabel('mac').text, '⌘⇧V');
  });

  it('Spool binds neither: plain paste would take the shortcut of the browser away on every site', () => {
    for (const command of Object.values(MANIFEST.commands)) {
      const { default: any, mac } = /** @type {any} */ (command).suggested_key;
      // Windows and Linux: not Ctrl+V, not Ctrl+Shift+V.
      assert.ok(!/ctrl\+shift\+v/i.test(any), any);
      assert.ok(!/^ctrl\+v$/i.test(any), any);
      // A Mac: "Ctrl" in a key means Command there, and Command+Shift+V pastes text only. A key of
      // Spool for a Mac is MacCtrl (the Control key) or Alt (Option), never Ctrl or Command.
      assert.ok(/^MacCtrl\+/.test(mac), mac);
    }
  });
});

describe('the keys of the manifest and the defaults of the code', () => {
  const keyOf = (/** @type {string} */ command, /** @type {string} */ platform) =>
    MANIFEST.commands[command].suggested_key[platform];

  it('Windows and Linux: the default key of the manifest is the one the code falls back to', () => {
    assert.equal(keyOf('start-capture', 'default'), defaultShortcut('windows', 'start'));
    assert.equal(keyOf('insert-capture', 'default'), defaultShortcut('windows', 'insert'));
    assert.equal(defaultShortcut('linux', 'start'), defaultShortcut('windows', 'start'));
    assert.equal(defaultShortcut('linux', 'insert'), defaultShortcut('windows', 'insert'));
  });

  it('a Mac has its own keys: Control+Shift, not Option+Shift, not Command', () => {
    assert.equal(keyOf('start-capture', 'mac'), 'MacCtrl+Shift+S');
    assert.equal(keyOf('insert-capture', 'mac'), 'MacCtrl+Shift+V');
    // The glyph form of the manifest key is the fallback text of the code.
    assert.equal(keyLabel(keyOf('start-capture', 'mac'), 'mac').text, defaultShortcut('mac', 'start'));
    assert.equal(keyLabel(keyOf('insert-capture', 'mac'), 'mac').text, defaultShortcut('mac', 'insert'));
    assert.equal(defaultShortcut('mac', 'start'), '⌃⇧S');
    assert.equal(defaultShortcut('mac', 'insert'), '⌃⇧V');
  });

  it('no key of the manifest is Option+letter (it types a character) or Command+Shift+V/S', () => {
    for (const command of Object.values(MANIFEST.commands)) {
      const mac = /** @type {any} */ (command).suggested_key.mac;
      assert.ok(!/^(alt|option)\b/i.test(mac), mac);
      assert.ok(!/command|cmd/i.test(mac), mac);
    }
  });

  it('the toolbar title names no key: a key in it would be wrong after a remap', () => {
    assert.ok(!/\(.*\)/.test(MANIFEST.action.default_title), MANIFEST.action.default_title);
    assert.ok(!/alt|shift|ctrl|option|⌥|⌘/i.test(MANIFEST.action.default_title));
  });
});
