// @ts-check
/**
 * Tests for the toast of a long capture that teaches the keys (src/page/toast.js):
 *  - "Copied. Press Ctrl+V for the full image.", the shelf key in a tinted block, and the line
 *    for a desktop app ("Desktop app: drag them from Pictures › Screenshots › Spool for AI."),
 *    with the keys of the system (a Mac: ⌘V and ⌃⇧V);
 *  - "Too tall to copy. Saved instead.";
 *  - "Show in folder" for a save in Downloads only;
 *  - the toast of the first long captures stays until it is dismissed.
 * Same fake page as toast.test.js.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { TILES_FOLDER_NAME } from '../../src/lib/names.js';
import { ERR, MSG, PROTOCOL_VERSION, TARGET } from '../../src/shared/protocol.js';
import { findAll, findOne, flush, setupCards, textOf } from '../helpers/fake-card-dom.js';

const SESSION = '11111111-1111-4111-8111-111111111111';
const PNG_BASE64 = 'iVBORw0KGgo=';

const MAC_KEYS = Object.freeze({
  start: { parts: ['⌃', '⇧', 'S'], text: '⌃⇧S' },
  insert: { parts: ['⌃', '⇧', 'V'], text: '⌃⇧V' },
  paste: { parts: ['⌘', 'V'], text: '⌘V' },
});

/** @param {Record<string, unknown>} [more] */
function config(more = {}) {
  return { protocolVersion: PROTOCOL_VERSION, sessionId: SESSION, msg: MSG, err: ERR, target: TARGET, ...more };
}

/** A long capture: five tiles, saved in Pictures. @param {Record<string, unknown>} [more] */
function longSummary(more = {}) {
  return {
    sessionId: SESSION,
    title: 'Draft 3 review',
    createdAt: Date.now(),
    widthPx: 1500,
    heightPx: 9000,
    tileCount: 5,
    tileTier: 'standard',
    fitsOneImage: false,
    fullBytes: 1000,
    thumbnailPngBase64: PNG_BASE64,
    thumbnailWidthPx: 320,
    thumbnailHeightPx: 480,
    save: { location: 'folder', label: 'Pictures/Screenshots', files: 6, needsPermission: false },
    warnings: [],
    ...more,
  };
}

const DOWNLOADS = { location: 'downloads', label: 'Downloads/Spool', files: 6, needsPermission: false };

/**
 * @param {{ cfg?: Record<string, unknown>, info?: Record<string, unknown>,
 *   copy?: 'pending' | 'copied' | 'failed' | 'skipped' | 'toolarge',
 *   replies?: Record<string, (msg: any) => unknown>, platform?: string }} [options]
 */
function show({ cfg = {}, info = longSummary(), copy = 'copied', replies = {}, platform } = {}) {
  const t = setupCards({ files: ['src/page/ui-kit.js', 'src/page/toast.js'], replies, platform });
  const handle = t.ns.toast.show({ config: config(cfg), summary: info, copy });
  const host = /** @type {import('../helpers/fake-card-dom.js').FakeElement} */ (t.hosts().at(-1));
  const root = t.rootOf(host);
  const byClass = (/** @type {string} */ name) => findAll(root, (e) => e.className === name);
  return {
    t,
    handle,
    host,
    root,
    byClass,
    title: () => textOf(findOne(root, (e) => e.className === 'title', 'title')),
    text: () => textOf(root),
    hint: () => textOf(byClass('hint')[0]),
    note: () => textOf(byClass('caption').find((e) => e.style.display === 'block')),
    buttons: () => findAll(root, (e) => e.tagName === 'BUTTON').map((b) => textOf(b).trim()),
    button: (/** @type {string} */ label) =>
      findOne(
        root,
        (e) => e.tagName === 'BUTTON' && (textOf(e).trim() === label || e.attributes.get('aria-label') === label),
        `button "${label}"`,
      ),
    caps: () => findAll(findOne(root, (e) => e.className === 'hint', 'hint'), (e) => e.tagName === 'KBD').map(textOf),
  };
}

describe('the long toast teaches the keys', () => {
  it('the title says which key pastes the full image', () => {
    assert.equal(show().title(), 'Copied. Press Ctrl+V for the full image.');
  });

  it('on a Mac it says ⌘V, and the shelf key is the key of the Mac', () => {
    const toast = show({ cfg: { keys: MAC_KEYS } });
    assert.equal(toast.title(), 'Copied. Press ⌘V for the full image.');
    assert.equal(toast.hint(), 'Long capture? In your chat tab, press ⌃⇧V to insert all 5 screenshots.');
    assert.deepEqual(toast.caps(), ['⌃', '⇧', 'V']);
    assert.equal(findAll(toast.root, (e) => e.className === 'plus').length, 0, 'no "+" between glyphs');
  });

  it('on a PC the keycaps have a "+" between them', () => {
    const toast = show();
    assert.deepEqual(toast.caps(), ['Alt', 'Shift', 'V']);
    assert.equal(findAll(toast.root, (e) => e.className === 'plus').length, 2);
  });

  it('the block says "Long capture? In your chat tab, press [keys] to insert all N screenshots."', () => {
    assert.equal(
      show().hint(),
      'Long capture? In your chat tab, press Alt+Shift+V to insert all 5 screenshots.',
    );
  });

  it('the paste hint of a short toast uses the keycaps of the system: ⌘ V on a Mac', () => {
    const info = longSummary({ tileCount: 1, fitsOneImage: true, heightPx: 2000 });
    const mac = show({ info, cfg: { keys: MAC_KEYS } });
    assert.equal(textOf(mac.byClass('paste small')[0]), 'Paste⌘V');
    const pc = show({ info });
    assert.equal(textOf(pc.byClass('paste small')[0]), 'PasteCtrlV');
  });

  it('a Mac is also found by the platform when the config has no keys', () => {
    const toast = show({ platform: 'MacIntel' });
    assert.equal(toast.title(), 'Copied. Press ⌘V for the full image.');
  });

  it('names no key when the shelf command has none, and says what to do', () => {
    const toast = show({ cfg: { shortcuts: { start: 'Alt+Shift+S', insert: '' } } });
    assert.equal(toast.caps().length, 0);
    assert.equal(
      toast.hint(),
      'Set a shortcut for "Insert last capture" in your browser. ' +
        'Then press it in your chat tab to insert all 5 screenshots.',
    );
  });

  describe('the line for a desktop app', () => {
    it('names the folder of the AI screenshots, below the place of the save', () => {
      assert.ok(
        show().text().includes('Desktop app: drag them from Pictures › Screenshots › Spool for AI.'),
      );
    });

    it('a save in Downloads names Downloads › Spool › Spool for AI', () => {
      const toast = show({ info: longSummary({ save: DOWNLOADS }) });
      assert.ok(toast.text().includes('Desktop app: drag them from Downloads › Spool › Spool for AI.'));
    });

    it('is left out when nothing was saved, and when the setting does not save the tiles', () => {
      const none = show({
        info: longSummary({ save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false } }),
      });
      assert.ok(!none.text().includes('Desktop app'));
      const noTiles = show({ cfg: { settings: { saveTiles: false } } });
      assert.ok(!noTiles.text().includes('Desktop app'), 'the folder is not made');
      const yesTiles = show({ cfg: { settings: { saveTiles: true } } });
      assert.ok(yesTiles.text().includes('Desktop app'));
    });

    it('is not on a short toast', () => {
      const toast = show({ info: longSummary({ tileCount: 1, fitsOneImage: true }) });
      assert.ok(!toast.text().includes('Desktop app'));
    });

    it('a place from the page is text only', () => {
      const toast = show({
        info: longSummary({ save: { location: 'folder', label: '<b>bold', files: 1, needsPermission: false } }),
      });
      assert.ok(toast.text().includes('<b>bold › Spool for AI'));
      assert.ok(!toast.t.createdTags.includes('b'));
    });
  });

  it('the folder name that the toast shows is the one that the files are saved in', () => {
    const source = readFileSync(new URL('../../src/page/toast.js', import.meta.url), 'utf8');
    const copy = /TILES_FOLDER = '([^']+)'/.exec(source)?.[1];
    assert.equal(copy, TILES_FOLDER_NAME);
    const shelf = readFileSync(new URL('../../src/page/shelf.js', import.meta.url), 'utf8');
    assert.equal(/TILES_FOLDER = '([^']+)'/.exec(shelf)?.[1], TILES_FOLDER_NAME);
  });
});

describe('a capture that is too tall to copy', () => {
  it('says so, and that the files are saved', () => {
    const toast = show({ copy: 'toolarge' });
    assert.equal(toast.title(), 'Too tall to copy. Saved instead.');
    assert.equal(toast.byClass('title')[0]?.dataset['level'], 'info');
  });

  it('points to the shelf key without "Long capture?": nothing was copied', () => {
    const toast = show({ copy: 'toolarge', cfg: { keys: MAC_KEYS } });
    assert.equal(toast.hint(), 'Press ⌃⇧V in your chat to insert the 5 screenshots.');
  });

  it('keeps the line for a desktop app and the tile chips', () => {
    const toast = show({ copy: 'toolarge' });
    assert.ok(toast.text().includes('Desktop app: drag them from Pictures › Screenshots › Spool for AI.'));
    assert.equal(toast.byClass('chip').length, 5);
  });

  it('has no paste hint: the Paste key would paste something else', () => {
    const toast = show({ copy: 'toolarge' });
    assert.ok(!toast.title().includes('Ctrl+V'));
    assert.ok(!toast.text().includes('for the full image'));
  });

  it('not saved: "Too tall to copy." and a note that points to Open', () => {
    const toast = show({
      copy: 'toolarge',
      info: longSummary({ save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false } }),
    });
    assert.equal(toast.title(), 'Too tall to copy.');
    assert.equal(toast.note(), 'Open the capture to save it.');
  });

  it('some files did not save: says how many, in the title', () => {
    const toast = show({
      copy: 'toolarge',
      info: longSummary({
        save: { location: 'downloads', label: 'Downloads/Spool', files: 4, needsPermission: false, error: 'Some files could not be saved.', failed: 2 },
      }),
    });
    assert.equal(toast.title(), "Too tall to copy. 2 of 6 files didn't save.");
  });

  it('arrives late: the toast shows "Copying…" first, then the final state', () => {
    const toast = show({ copy: 'pending' });
    assert.equal(toast.title(), 'Copying…');
    toast.handle?.setCopy('toolarge');
    assert.equal(toast.title(), 'Too tall to copy. Saved instead.');
    assert.equal(toast.hint(), 'Press Alt+Shift+V in your chat to insert the 5 screenshots.');
  });

  it('the countdown starts when the state is final', () => {
    const toast = show({ copy: 'toolarge' });
    toast.t.timers.advance(5900);
    assert.equal(toast.host.removed, false);
    toast.t.timers.advance(100 + 167);
    assert.equal(toast.host.removed, true);
  });
});

describe('Show in folder', () => {
  it('shows for a save in Downloads, on a short and a long toast', () => {
    const long = show({ info: longSummary({ save: DOWNLOADS }) });
    assert.ok(long.buttons().includes('Show in folder'));
    const short = show({
      info: longSummary({ tileCount: 1, fitsOneImage: true, save: { ...DOWNLOADS, files: 1 } }),
    });
    assert.ok(short.buttons().includes('Show in folder'));
  });

  it('does not show for a folder that the user picked: the browser cannot reveal it', () => {
    assert.ok(!show().buttons().includes('Show in folder'));
    assert.ok(!show({ info: longSummary({ tileCount: 1, fitsOneImage: true }) }).buttons().includes('Show in folder'));
  });

  it('does not show when nothing was saved', () => {
    const toast = show({
      info: longSummary({ save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false } }),
    });
    assert.ok(!toast.buttons().includes('Show in folder'));
  });

  it('a click sends page/show-in-folder with the session ID, and nothing else', async () => {
    const toast = show({ info: longSummary({ save: DOWNLOADS }) });
    toast.button('Show in folder').dispatch('click');
    await flush();
    assert.deepEqual(toast.t.sent, [
      { v: 1, target: 'sw', type: 'page/show-in-folder', sessionId: SESSION },
    ]);
    assert.equal(toast.host.removed, false, 'the toast stays');
  });

  it('a click that is not trusted does nothing', async () => {
    const toast = show({ info: longSummary({ save: DOWNLOADS }) });
    toast.button('Show in folder').dispatch('click', { isTrusted: false });
    await flush();
    assert.deepEqual(toast.t.sent, []);
  });

  it('shows the message of the worker when it cannot reveal the files', async () => {
    const toast = show({
      info: longSummary({ save: DOWNLOADS }),
      replies: {
        [MSG.PAGE_SHOW_IN_FOLDER]: () => ({
          ok: false,
          error: { code: ERR.SESSION_NOT_FOUND, message: 'Spool cannot find the saved files. Open your Downloads folder.' },
        }),
      },
    });
    toast.button('Show in folder').dispatch('click');
    await flush();
    await flush();
    assert.equal(toast.note(), 'Spool cannot find the saved files. Open your Downloads folder.');
    assert.equal(toast.host.removed, false);
  });

  it('does nothing visible when it works', async () => {
    const toast = show({ info: longSummary({ save: DOWNLOADS }), replies: { [MSG.PAGE_SHOW_IN_FOLDER]: () => ({ ok: true }) } });
    toast.button('Show in folder').dispatch('click');
    await flush();
    await flush();
    assert.equal(
      findAll(toast.root, (e) => e.className === 'caption' && e.style.display === 'block').length,
      0,
      'no note',
    );
  });
});

describe('the first long captures stay until they are dismissed', () => {
  it('a toast with `teach` does not hide by itself', () => {
    const toast = show({ info: longSummary({ teach: true }) });
    toast.t.timers.advance(60_000);
    assert.equal(toast.host.removed, false);
    assert.equal('closing' in toast.root.dataset, false);
    assert.equal(toast.root.dataset['timing'], undefined, 'no countdown bar');
  });

  it('it closes with Esc, the close button and Open', async () => {
    const esc = show({ info: longSummary({ teach: true }) });
    esc.t.win.dispatch('keydown', { key: 'Escape' });
    esc.t.timers.advance(167);
    assert.equal(esc.host.removed, true);

    const close = show({ info: longSummary({ teach: true }) });
    close.button('Close (Esc)').dispatch('click');
    close.t.timers.advance(167);
    assert.equal(close.host.removed, true);

    const open = show({ info: longSummary({ teach: true }) });
    findOne(open.root, (e) => e.className === 'link' && textOf(e).startsWith('Open'), 'Open').dispatch('click');
    await flush();
    open.t.timers.advance(167);
    assert.equal(open.host.removed, true);
  });

  it('hover and focus do not start a countdown that was not there', () => {
    const toast = show({ info: longSummary({ teach: true }) });
    const card = findOne(toast.root, (e) => e.className === 'card', 'card');
    card.dispatch('pointerenter');
    card.dispatch('pointerleave');
    card.dispatch('focusin');
    card.dispatch('focusout');
    toast.t.timers.advance(60_000);
    assert.equal(toast.host.removed, false);
    assert.equal(toast.t.timers.pending, 1, 'only the watchdog of the card');
  });

  it('a toast of a copy that is still pending, then final, also stays', () => {
    const toast = show({ info: longSummary({ teach: true }), copy: 'pending' });
    toast.handle?.setCopy('copied');
    toast.t.timers.advance(60_000);
    assert.equal(toast.host.removed, false);
  });

  it('a long capture without `teach` hides after 6 s, as before', () => {
    const toast = show({ info: longSummary() });
    toast.t.timers.advance(6000 + 167);
    assert.equal(toast.host.removed, true);
  });

  it('a short capture never stays: `teach` is for long captures', () => {
    const toast = show({ info: longSummary({ tileCount: 1, fitsOneImage: true, teach: true }) });
    toast.t.timers.advance(6000 + 167);
    assert.equal(toast.host.removed, true);
  });

  it('only `teach: true` counts', () => {
    for (const teach of [false, 'true', 1, null]) {
      const toast = show({ info: longSummary({ teach }) });
      toast.t.timers.advance(6000 + 167);
      assert.equal(toast.host.removed, true, String(teach));
    }
  });

  it('a new toast closes the one that stays', () => {
    const t = setupCards({ files: ['src/page/ui-kit.js', 'src/page/toast.js'] });
    t.ns.toast.show({ config: config(), summary: longSummary({ teach: true }), copy: 'copied' });
    const first = /** @type {import('../helpers/fake-card-dom.js').FakeElement} */ (t.hosts().at(-1));
    t.ns.toast.show({ config: config(), summary: longSummary(), copy: 'copied' });
    assert.equal(first.removed, true);
  });
});
