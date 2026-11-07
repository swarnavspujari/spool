// @ts-check
/**
 * The words of the options and welcome pages that depend on the system: the keys are written for
 * the system, the copy does not say "Windows" where it is true everywhere, and the code that the
 * pages share lives in one place (src/lib/keys.js).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { defaultShortcut, platformKind as libPlatformKind } from '../../src/lib/keys.js';
import { FIELDS, shortcutParts } from '../../src/options/form-model.js';
import {
  describeMoves,
  describeSetup,
  platformKind,
  systemWords,
} from '../../src/options/setup-model.js';
import { shortcutParts as libShortcutParts } from '../../src/lib/keys.js';

describe('one implementation of the key code', () => {
  it('the welcome page and the options page use the functions of src/lib/keys.js', () => {
    assert.equal(platformKind, libPlatformKind);
    assert.equal(shortcutParts, libShortcutParts);
  });

  it('systemWords gives the Paste key and the plain-paste key of each system', () => {
    assert.deepEqual(systemWords('windows'), {
      selectFolder: 'Select Folder',
      paste: 'Ctrl+V',
      plainPaste: 'Ctrl+Shift+V',
    });
    assert.deepEqual(systemWords('linux'), {
      selectFolder: 'Open',
      paste: 'Ctrl+V',
      plainPaste: 'Ctrl+Shift+V',
    });
    assert.deepEqual(systemWords('mac'), { selectFolder: 'Open', paste: '⌘V', plainPaste: '⌘⇧V' });
  });
});

describe('the keys that the welcome page names', () => {
  it('a Mac with no answer from the browser gets the keys of the manifest for a Mac', () => {
    const moves = describeMoves({ platform: 'mac' });
    assert.deepEqual(
      moves.rows.map((r) => r.keys),
      [defaultShortcut('mac', 'start'), '⌘V', defaultShortcut('mac', 'insert')],
    );
    assert.deepEqual(
      moves.rows.map((r) => r.keys),
      ['⌃⇧S', '⌘V', '⌃⇧V'],
    );
    assert.equal(moves.warning, 'Use ⌘V, not ⌘⇧V: that one pastes text only, so images vanish.');
  });

  it('Windows and Linux keep Alt+Shift', () => {
    for (const platform of /** @type {const} */ (['windows', 'linux'])) {
      assert.deepEqual(
        describeMoves({ platform }).rows.map((r) => r.keys),
        ['Alt+Shift+S', 'Ctrl+V', 'Alt+Shift+V'],
        platform,
      );
    }
  });

  it('a key that the browser gives is shown as it is (the page writes it for the system first)', () => {
    const moves = describeMoves({ platform: 'mac', startKey: '⌥⇧S', insertKey: '' });
    assert.deepEqual(
      moves.rows.map((r) => r.keys),
      ['⌥⇧S', '⌘V', 'Not set'],
    );
  });

  it('the lead of the connected page says which key starts a capture, per system', () => {
    const mac = describeSetup({
      phase: 'connected',
      platform: 'mac',
      label: 'Pictures › Screenshots',
      downloads: 'Downloads › Spool',
    });
    assert.ok(mac.lead.includes('press **⌃⇧S**'));
    const pc = describeSetup({
      phase: 'connected',
      platform: 'windows',
      label: 'Pictures › Screenshots',
      downloads: 'Downloads › Spool',
    });
    assert.ok(pc.lead.includes('press **Alt+Shift+S**'));
  });
});

describe('copy that is not about one system', () => {
  const texts = FIELDS.flatMap((f) => [f.label, f.help]);

  it('does not talk as if Windows were the only system, in the help of a setting', () => {
    for (const text of texts) {
      assert.ok(!/^Windows|that Windows|in Windows/.test(text), text);
    }
  });

  it('the clipboard setting names the systems that keep a history of what you copy', () => {
    const field = FIELDS.find((f) => f.key === 'copyOnDone');
    assert.ok(field);
    assert.equal(
      field.help,
      'Some systems keep a history of what you copy (Windows, and a Mac with Universal Clipboard). ' +
        'Turn this off to copy only when you ask.',
    );
  });

  it('the folder name setting says that some systems do not allow some characters', () => {
    const field = FIELDS.find((f) => f.key === 'folderName');
    assert.ok(field);
    assert.ok(field.help.includes('replaces characters that some systems do not allow.'));
  });
});

describe('what in the code still depends on the system, and why', () => {
  /** @param {string} file */
  const read = (file) => readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');

  it('the font stack of the cards starts with the system font, as tokens.css does', () => {
    const tokens = read('src/ui/tokens.css');
    assert.ok(/--font-text:\s*system-ui, -apple-system, 'Segoe UI Variable Text'/.test(tokens));
    for (const file of ['src/page/ui-kit.js', 'src/page/overlay.js']) {
      const text = read(file);
      const stack = /const FONT =\s*"([^"]+)" \+\s*"([^"]+)"/.exec(text);
      assert.ok(stack, file);
      assert.equal(
        `${stack[1]}${stack[2]}`,
        "system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI', " +
          "Roboto, 'Helvetica Neue', Arial, sans-serif",
        file,
      );
    }
  });

  it('the page scripts have the same default keys as the manifest', () => {
    const manifest = JSON.parse(read('manifest.json'));
    const text = read('src/page/ui-kit.js');
    const defaults = /DEFAULT_SHORTCUTS = Object\.freeze\(\{ start: '([^']+)', insert: '([^']+)' \}\)/.exec(text);
    assert.ok(defaults);
    assert.equal(defaults[1], manifest.commands['start-capture'].suggested_key.default);
    assert.equal(defaults[2], manifest.commands['insert-capture'].suggested_key.default);
  });
});
