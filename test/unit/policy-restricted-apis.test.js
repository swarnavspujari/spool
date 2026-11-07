// @ts-check
/**
 * Policy rules for APIs that only some places may use (storage, pickers, permission prompt,
 * clipboard read, synthetic paste) and the manifest baseline of the post-capture flow
 * (docs/contracts.md 7.5 and 7.7).
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readFileSync } from 'node:fs';

import { checkJs, checkManifest, checkSourceFile } from '../../scripts/lib/policy.mjs';

/** @param {string} file @param {string} code @returns {string[]} Messages of the findings. */
function messages(file, code) {
  return checkJs(file, code).map((f) => f.message);
}

describe('IndexedDB', () => {
  const code = "const db = indexedDB.open('x');";

  it('is allowed in src/ui/folder-store.js only', () => {
    assert.deepEqual(messages('src/ui/folder-store.js', code), []);
    for (const file of [
      'src/offscreen/offscreen.js',
      'src/sw/service-worker.js',
      'src/result/result.js',
      'src/options/options.js',
      'src/page/agent.js',
      'src/ui/other.js',
      'src/ui/folder-store.js.bak.js',
      'src/ui/sub/folder-store.js',
    ]) {
      const found = messages(file, code);
      assert.equal(found.length, 1, file);
      assert.match(found[0] ?? '', /IndexedDB is allowed only in src\/ui\/folder-store\.js/);
    }
  });

  it('finds the other names of the API', () => {
    for (const text of ['webkitIndexedDB.open()', 'new IDBFactory()', 'self.indexedDB']) {
      assert.equal(messages('src/result/result.js', text).length, 1, text);
    }
  });

  it('does not report a comment, and does not match a longer name', () => {
    assert.deepEqual(messages('src/result/result.js', '// indexedDB is not used here\nconst a = 1;'), []);
    assert.deepEqual(messages('src/result/result.js', '/* indexedDB */ const a = 1;'), []);
    assert.deepEqual(messages('src/result/result.js', 'const myindexedDBish = 1;'), []);
  });

  it('reports the line of the finding', () => {
    const found = checkJs('src/result/result.js', 'const a = 1;\nconst b = 2;\nindexedDB.open("x");\n');
    assert.deepEqual(found.map((f) => f.line), [3]);
  });
});

describe('web storage, Cache Storage and the origin private file system', () => {
  it('are forbidden everywhere, also in src/ui/folder-store.js', () => {
    for (const text of [
      'localStorage.setItem("a", "b")',
      'sessionStorage.getItem("a")',
      'openDatabase("x")',
      'const c = new CacheStorage()',
      'await caches.open("x")',
      'const root = await navigator.storage.getDirectory();',
    ]) {
      for (const file of ['src/result/result.js', 'src/ui/folder-store.js', 'src/offscreen/save.js']) {
        assert.equal(messages(file, text).length, 1, `${file}: ${text}`);
      }
    }
  });

  it('does not report getDirectoryHandle, which the folder writer uses', () => {
    assert.deepEqual(
      messages('src/offscreen/folder-writer.js', 'await dir.getDirectoryHandle(name, { create: true });'),
      [],
    );
  });

  it('does not report a word that only contains "caches"', () => {
    assert.deepEqual(messages('src/page/page-lib.js', 'const matches = 1; const scaches = 2;'), []);
  });
});

describe('file pickers', () => {
  const code = 'const handle = await window.showDirectoryPicker({ mode: "readwrite" });';

  it('are allowed in src/options/ and src/ui/', () => {
    assert.deepEqual(messages('src/options/options.js', code), []);
    assert.deepEqual(messages('src/ui/folder-store.js', code), []);
  });

  it('are refused in every other place, for all three pickers', () => {
    for (const picker of ['showDirectoryPicker', 'showSaveFilePicker', 'showOpenFilePicker']) {
      for (const file of ['src/offscreen/offscreen.js', 'src/sw/handlers.js', 'src/result/result.js', 'src/page/agent.js']) {
        const found = messages(file, `await ${picker}();`);
        assert.equal(found.length, 1, `${file} ${picker}`);
        assert.match(found[0] ?? '', /file pickers are allowed only in src\/options\/ and src\/ui\//);
      }
    }
  });
});

describe('requestPermission', () => {
  const code = 'const state = await handle.requestPermission({ mode: "readwrite" });';

  it('is allowed in src/options/, src/result/ and src/ui/ (pages with a user click)', () => {
    for (const file of ['src/options/options.js', 'src/result/result.js', 'src/ui/folder-store.js']) {
      assert.deepEqual(messages(file, code), [], file);
    }
  });

  it('is refused in the offscreen document, the worker and the page scripts', () => {
    for (const file of [
      'src/offscreen/save.js',
      'src/offscreen/offscreen.js',
      'src/sw/handlers.js',
      'src/page/toast.js',
      'src/page/shelf.js',
    ]) {
      const found = messages(file, code);
      assert.equal(found.length, 1, file);
      assert.match(found[0] ?? '', /requestPermission is allowed only in/);
    }
  });

  it('does not report requestFolderPermission or queryPermission', () => {
    assert.deepEqual(messages('src/offscreen/save.js', 'await folderStore.folderPermission(h);'), []);
    assert.deepEqual(messages('src/offscreen/save.js', 'await h.queryPermission({ mode: "readwrite" });'), []);
    assert.deepEqual(messages('src/page/toast.js', 'requestFolderPermission(handle);'), []);
  });
});

describe('reading the clipboard', () => {
  it('is forbidden everywhere, in every spelling', () => {
    for (const text of [
      'await navigator.clipboard.readText()',
      'await navigator.clipboard.read()',
      'await navigator.clipboard?.read()',
      'await navigator.clipboard . read ()',
      'await navigator.clipboard\n  .readText()',
      'const { clipboard } = navigator; clipboard.read()',
    ]) {
      for (const file of ['src/page/agent.js', 'src/sw/clipboard.js', 'src/result/result.js']) {
        assert.equal(messages(file, text).length, 1, `${file}: ${JSON.stringify(text)}`);
      }
    }
  });

  it('allows writing', () => {
    assert.deepEqual(
      messages('src/sw/clipboard.js', 'await navigator.clipboard.write([new ClipboardItem({})]);'),
      [],
    );
    assert.deepEqual(messages('src/page/agent.js', 'await navigator.clipboard.writeText("x");'), []);
  });

  it('does not report the read of a stream reader', () => {
    assert.deepEqual(messages('src/lib/png-stream.js', 'const { value } = await reader.read();'), []);
  });
});

describe('synthetic paste and drop events', () => {
  const code = "const event = new ClipboardEvent('paste', { clipboardData: data });";

  it('are allowed in src/page/', () => {
    assert.deepEqual(messages('src/page/shelf.js', code), []);
    assert.deepEqual(messages('src/page/shelf.js', "new DragEvent('drop')"), []);
  });

  it('are refused everywhere else', () => {
    for (const file of ['src/sw/handlers.js', 'src/offscreen/offscreen.js', 'src/result/result.js', 'src/options/options.js']) {
      assert.equal(messages(file, code).length, 1, file);
      assert.equal(messages(file, "new DragEvent('drop')").length, 1, file);
    }
  });

  it('does not report a mention in a comment', () => {
    assert.deepEqual(messages('src/sw/handlers.js', '// new ClipboardEvent is only in the shelf\n'), []);
  });
});

describe('checkSourceFile', () => {
  it('applies the rules to .js files with the right path', () => {
    const header = '// @ts-check\n';
    assert.equal(checkSourceFile('src/result/result.js', `${header}indexedDB.open("x");`).length, 1);
    assert.equal(checkSourceFile('src/ui/folder-store.js', `${header}indexedDB.open("x");`).length, 0);
  });

  it('accepts a path with backslashes', () => {
    assert.equal(checkJs('src\\ui\\folder-store.js', 'indexedDB.open("x");').length, 0);
    assert.equal(checkJs('src\\result\\result.js', 'indexedDB.open("x");').length, 1);
  });
});

describe('the real source files', () => {
  it('src/ui/folder-store.js is the one file that uses IndexedDB', () => {
    const source = readFileSync(new URL('../../src/ui/folder-store.js', import.meta.url), 'utf8');
    assert.match(source, /indexedDB/);
  });
});

describe('the manifest of the post-capture flow', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'));
  const baseline = JSON.parse(
    readFileSync(new URL('../../scripts/permissions-baseline.json', import.meta.url), 'utf8'),
  );

  it('has clipboardWrite and nothing else new, and the baseline says the same', () => {
    assert.deepEqual([...manifest.permissions].sort(), [
      'activeTab',
      'clipboardWrite',
      'downloads',
      'offscreen',
      'scripting',
      'storage',
    ]);
    assert.deepEqual(baseline.permissions, [...manifest.permissions].sort());
    assert.deepEqual(
      checkManifest(manifest, baseline, () => true),
      [],
    );
  });

  it('has the two commands and no host permission', () => {
    assert.deepEqual(Object.keys(manifest.commands).sort(), ['insert-capture', 'start-capture']);
    assert.equal(manifest.commands['insert-capture'].suggested_key.default, 'Alt+Shift+V');
    assert.equal(manifest.commands['start-capture'].suggested_key.default, 'Alt+Shift+S');
    assert.ok(!('host_permissions' in manifest));
    assert.ok(!('content_scripts' in manifest));
  });

  it('is refused when clipboardWrite is missing from the baseline', () => {
    const oldBaseline = { ...baseline, permissions: baseline.permissions.filter((/** @type {string} */ p) => p !== 'clipboardWrite') };
    const found = checkManifest(manifest, oldBaseline, () => true);
    assert.equal(found.length, 1);
    assert.match(found[0]?.message ?? '', /permissions must equal the baseline/);
  });
});
