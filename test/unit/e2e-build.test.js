// @ts-check
/**
 * Tests of the end-to-end test build (e2e/build-extension.mjs): the marks that tell it apart
 * from the real extension, the debug hook of the result page, the folder, and the clean-up.
 * The build runs against the real repository files but writes only below os.tmpdir().
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';

import {
  BUILD_MARKER_FILE,
  BUILD_PARENT,
  REPO_ROOT,
  TEST_BUILD_NAME,
  addDebugHook,
  buildExtension,
  patchManifest,
  removeBuild,
  tintIcon,
} from '../../e2e/build-extension.mjs';
import { decodePng } from '../helpers/png-decode.js';

const BUILD_MODULE_URL = pathToFileURL(path.join(REPO_ROOT, 'e2e', 'build-extension.mjs')).href;

/** Folders that a test made, removed at the end. @type {string[]} */
const scratch = [];

/** @returns {Promise<string>} A new empty folder below os.tmpdir(). */
async function scratchDir() {
  const dir = await mkdtemp(path.join(tmpdir(), 'spool-e2e-build-test-'));
  scratch.push(dir);
  return dir;
}

after(async () => {
  for (const dir of scratch) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** @param {string} file Path relative to the repository root. @returns {Promise<string>} */
const readRepo = (file) => readFile(path.join(REPO_ROOT, file), 'utf8');

/**
 * @param {string} file
 * @returns {Promise<any>}
 */
async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf8'));
}

/**
 * A small RGB or RGBA PNG for the tint tests.
 * @param {number} width
 * @param {number} height
 * @param {number} channels
 * @param {number[]} pixels
 * @returns {Buffer}
 */
function makePng(width, height, channels, pixels) {
  /** @param {string} type @param {Buffer} data */
  const chunk = (type, data) => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'ascii');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = channels === 4 ? 6 : 2;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw.set(pixels.slice(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    signature,
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

describe('patchManifest', () => {
  const production = {
    manifest_version: 3,
    name: 'Spool',
    short_name: 'Spool',
    version: '1.2.3',
    description: 'The real extension.',
    incognito: 'not_allowed',
    action: { default_title: 'Spool: capture', default_icon: { 16: 'icons/icon-16.png' } },
    permissions: ['activeTab', 'downloads'],
    content_security_policy: { extension_pages: "default-src 'none'" },
  };

  it('names the copy as a test build that must not be installed, with the version', () => {
    const patched = patchManifest(production);
    assert.ok(patched['name'].startsWith('Spool TEST BUILD — do not install'));
    assert.ok(patched['name'].startsWith(TEST_BUILD_NAME));
    assert.match(patched['name'], /1\.2\.3/);
    assert.notEqual(patched['name'], production.name);
    assert.equal(patched['version'], '1.2.3', 'Chrome needs the plain number');
    assert.equal(patched['version_name'], '1.2.3-e2e-test');
  });

  it('changes every text that a user can see for the extension', () => {
    const patched = patchManifest(production);
    assert.notEqual(patched['short_name'], production.short_name);
    assert.match(patched['short_name'], /TEST/);
    assert.match(patched['description'], /TEST BUILD/);
    assert.match(patched['action'].default_title, /TEST BUILD/);
    assert.deepEqual(patched['action'].default_icon, production.action.default_icon);
  });

  it('adds host access once', () => {
    assert.deepEqual(patchManifest(production)['host_permissions'], ['<all_urls>']);
    const hosts = ['<all_urls>', 'https://a.test/*'];
    const again = patchManifest({ ...production, host_permissions: hosts });
    assert.deepEqual(again['host_permissions'], hosts);
  });

  it('keeps every other key: permissions, CSP, incognito and the rest are the real ones', () => {
    const patched = patchManifest(production);
    /** @param {Record<string, any>} object @param {string[]} keys */
    const without = (object, keys) =>
      Object.fromEntries(Object.entries(object).filter(([key]) => !keys.includes(key)));
    const changed = ['name', 'short_name', 'description', 'action'];
    assert.deepEqual(
      without(patched, [...changed, 'version_name', 'host_permissions']),
      without(production, changed),
    );
    assert.equal(patched['incognito'], 'not_allowed');
  });

  it('does not change its input', () => {
    const action = Object.freeze({ ...production.action });
    const frozen = Object.freeze({ ...production, action });
    assert.doesNotThrow(() => patchManifest(frozen));
    assert.equal(production.name, 'Spool');
  });

  it('works with a manifest that has no action and no version', () => {
    const patched = patchManifest({ manifest_version: 3 });
    assert.match(patched['name'], /TEST BUILD/);
    assert.equal(patched['version_name'], '0-e2e-test');
    assert.deepEqual(patched['host_permissions'], ['<all_urls>']);
  });

  it('gives the real manifest of the repository a different name', async () => {
    const real = await readJson(path.join(REPO_ROOT, 'manifest.json'));
    const patched = patchManifest(real);
    assert.notEqual(patched['name'], real.name);
    assert.deepEqual(patched['permissions'], real.permissions);
    assert.deepEqual(patched['content_security_policy'], real.content_security_policy);
    assert.equal(patched['incognito'], 'not_allowed');
  });
});

describe('addDebugHook', () => {
  const tag = '<script type="module" src="debug-hook.js"></script>';
  const page = [
    '<head>',
    '  <link rel="stylesheet" href="result.css" />',
    '  <script type="module" src="result.js"></script>',
    '</head>',
    '',
  ].join('\n');

  it('adds the hook script on the line after result.js, with the same indent', () => {
    const lines = addDebugHook(page).split('\n');
    const at = lines.indexOf('  <script type="module" src="result.js"></script>');
    assert.ok(at > 0);
    assert.equal(lines[at + 1], `  ${tag}`);
    assert.equal(lines.length, page.split('\n').length + 1);
  });

  it('keeps CRLF line ends', () => {
    const out = addDebugHook(page.replaceAll('\n', '\r\n'));
    assert.ok(out.includes(`result.js"></script>\r\n  ${tag}\r\n</head>`));
    assert.ok(!/[^\r]\n/.test(out), 'no bare LF');
  });

  it('adds nothing else', () => {
    assert.equal(addDebugHook(page).replace(`  ${tag}\n`, ''), page);
  });

  it('throws when result.js is not loaded, or is loaded twice', () => {
    assert.throws(() => addDebugHook('<head></head>'), /found 0/);
    const twice = `${page}${page}`;
    assert.throws(() => addDebugHook(twice), /found 2/);
  });

  it('works on the real result page: one hook, after the page script, in the head', async () => {
    const out = addDebugHook(await readRepo('src/result/result.html'));
    assert.equal(out.split('debug-hook.js').length - 1, 1);
    assert.ok(out.indexOf('src="result.js"') < out.indexOf('src="debug-hook.js"'));
    assert.ok(out.indexOf('debug-hook.js') < out.indexOf('</head>'));
  });
});

describe('tintIcon', () => {
  it('swaps red and blue, and keeps green, alpha and the size', () => {
    // 2 x 1 RGBA: opaque blue, half-transparent white.
    const png = makePng(2, 1, 4, [26, 98, 255, 255, 255, 255, 255, 128]);
    const out = decodePng(tintIcon(png));
    assert.equal(out.width, 2);
    assert.equal(out.height, 1);
    assert.equal(out.channels, 4);
    assert.deepEqual([...out.data], [255, 98, 26, 255, 255, 255, 255, 128]);
  });

  it('handles RGB pictures too', () => {
    const png = makePng(1, 2, 3, [1, 2, 3, 10, 20, 30]);
    const out = decodePng(tintIcon(png));
    assert.equal(out.channels, 3);
    assert.deepEqual([...out.data], [3, 2, 1, 30, 20, 10]);
  });

  it('is its own inverse', () => {
    const png = makePng(2, 2, 4, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]);
    assert.deepEqual([...decodePng(tintIcon(tintIcon(png))).data], [...decodePng(png).data]);
  });

  it('turns the blue of the real icons into another color at every size', async () => {
    for (const size of [16, 32, 48, 128]) {
      const file = await readFile(path.join(REPO_ROOT, 'icons', `icon-${size}.png`));
      const real = decodePng(file);
      const tinted = decodePng(tintIcon(file));
      assert.equal(tinted.width, size);
      let changed = 0;
      for (let i = 0; i < real.data.length; i += real.channels) {
        const [r, g, b, a] = [0, 1, 2, 3].map((c) => real.data[i + c] ?? 0);
        if (a === 0) continue;
        assert.equal(tinted.data[i], b);
        assert.equal(tinted.data[i + 1], g);
        assert.equal(tinted.data[i + 2], r);
        if (r !== b) changed++;
      }
      assert.ok(changed > 0, `icon-${size}: some pixels are not gray`);
    }
  });

  it('throws on a file that is not a PNG', () => {
    assert.throws(() => tintIcon(Buffer.from('not a png')));
  });
});

describe('buildExtension', () => {
  it('builds below os.tmpdir(), never in the repository', async () => {
    const dir = await buildExtension({ removeOnExit: false });
    try {
      assert.equal(path.dirname(dir), BUILD_PARENT);
      assert.ok(BUILD_PARENT.startsWith(path.resolve(tmpdir())), BUILD_PARENT);
      assert.ok(!dir.startsWith(REPO_ROOT + path.sep), 'outside the repository');
      assert.ok(existsSync(path.join(dir, BUILD_MARKER_FILE)));
      assert.ok(!dir.includes('.e2e-build'));
    } finally {
      await removeBuild(dir);
    }
    assert.ok(!existsSync(dir), 'removeBuild deletes it');
  });

  it('gives each build its own random folder', async () => {
    const a = await buildExtension({ removeOnExit: false });
    const b = await buildExtension({ removeOnExit: false });
    try {
      assert.notEqual(a, b);
    } finally {
      await removeBuild(a);
      await removeBuild(b);
    }
  });

  it('holds back the install event in the test hook, and leaves it alone with holdInstall: false', async () => {
    // Every test profile is a new install. The real worker opens the welcome page on install, so the
    // hook keeps the listeners of onInstalled; a spec runs them with __spoolTest.fireInstalled.
    const held = path.join(await scratchDir(), 'held');
    await buildExtension({ outDir: held });
    const heldHook = await readFile(path.join(held, 'src/sw/test-hook.js'), 'utf8');
    assert.match(heldHook, /chrome\.runtime\.onInstalled\.addListener = /);
    assert.match(heldHook, /fireInstalled/);
    assert.ok(!heldHook.includes('@@HOLD_INSTALL@@'), 'the mark is replaced');

    const open = path.join(await scratchDir(), 'open');
    await buildExtension({ outDir: open, holdInstall: false });
    const openHook = await readFile(path.join(open, 'src/sw/test-hook.js'), 'utf8');
    assert.ok(!/onInstalled\.addListener = /.test(openHook), 'the event is not touched');
    assert.match(openHook, /fireInstalled/, 'the function exists and has nothing to run');
    assert.ok(!openHook.includes('@@HOLD_INSTALL@@'));
    // The worker that runs after the hook is the production worker in both builds.
    assert.equal(
      await readFile(path.join(open, 'src/sw/service-worker.original.js'), 'utf8'),
      await readRepo('src/sw/service-worker.js'),
    );
  });

  it('makes a test build with the marks, the hooks and the real code', async () => {
    const out = path.join(await scratchDir(), 'build');
    assert.equal(await buildExtension({ outDir: out }), out);

    const manifest = await readJson(path.join(out, 'manifest.json'));
    const real = await readJson(path.join(REPO_ROOT, 'manifest.json'));
    assert.deepEqual(manifest, patchManifest(real));
    assert.ok(manifest.name.startsWith(TEST_BUILD_NAME));
    assert.deepEqual(manifest.host_permissions, ['<all_urls>']);

    const html = await readFile(path.join(out, 'src/result/result.html'), 'utf8');
    assert.match(html, /<script type="module" src="debug-hook\.js"><\/script>/);
    const hook = await readFile(path.join(out, 'src/result/debug-hook.js'), 'utf8');
    assert.match(hook, /import \{ debugApi \} from '\.\/result\.js';/);
    assert.match(hook, /globalThis\.spoolDebug = debugApi;/);

    const worker = await readFile(path.join(out, 'src/sw/service-worker.js'), 'utf8');
    assert.match(worker, /test-hook\.js/);
    const hookSource = await readFile(path.join(out, 'src/sw/test-hook.js'), 'utf8');
    assert.match(hookSource, /setBadgeText\(\{ text: 'TEST' \}\)/);
    assert.equal(
      await readFile(path.join(out, 'src/sw/service-worker.original.js'), 'utf8'),
      await readRepo('src/sw/service-worker.js'),
    );
    assert.equal(
      await readFile(path.join(out, 'src/result/result.js'), 'utf8'),
      await readRepo('src/result/result.js'),
      'the result page script is the production file',
    );

    const icon = decodePng(await readFile(path.join(out, 'icons/icon-128.png')));
    const realIcon = decodePng(await readFile(path.join(REPO_ROOT, 'icons/icon-128.png')));
    assert.notDeepEqual([...icon.data], [...realIcon.data]);
  });

  it('does not change a production file', async () => {
    const files = [
      'manifest.json',
      'src/result/result.html',
      'src/sw/service-worker.js',
      'icons/icon-16.png',
    ];
    const read = () => Promise.all(files.map((file) => readFile(path.join(REPO_ROOT, file))));
    const before = await read();
    await buildExtension({ outDir: path.join(await scratchDir(), 'build') });
    assert.deepEqual(await read(), before);
    assert.ok(!(await readRepo('src/result/result.html')).includes('debug-hook'));
    assert.ok(!existsSync(path.join(REPO_ROOT, 'src/result/debug-hook.js')));
  });

  it('replaces an earlier test build in the same folder', async () => {
    const out = path.join(await scratchDir(), 'build');
    await buildExtension({ outDir: out });
    await writeFile(path.join(out, 'stale.txt'), 'old');
    await buildExtension({ outDir: out });
    assert.ok(!existsSync(path.join(out, 'stale.txt')));
    assert.ok(existsSync(path.join(out, 'manifest.json')));
  });

  it('uses an empty folder that exists', async () => {
    const out = await scratchDir();
    await buildExtension({ outDir: out });
    assert.ok(existsSync(path.join(out, 'manifest.json')));
  });

  it('refuses to delete a folder that has files and no marker', async () => {
    const out = await scratchDir();
    await writeFile(path.join(out, 'my-document.txt'), 'keep me');
    await assert.rejects(buildExtension({ outDir: out }), /Refusing to replace/);
    assert.equal(await readFile(path.join(out, 'my-document.txt'), 'utf8'), 'keep me');
    assert.deepEqual(await readdir(out), ['my-document.txt']);
  });

  it('refuses the repository folder as output', async () => {
    await assert.rejects(buildExtension({ outDir: REPO_ROOT }), /Refusing to replace/);
    assert.ok(existsSync(path.join(REPO_ROOT, 'manifest.json')));
  });

  it('fails with a clear message when result.js does not export debugApi', async () => {
    const root = await scratchDir();
    for (const entry of ['src', 'icons', 'manifest.json']) {
      await cp(path.join(REPO_ROOT, entry), path.join(root, entry), { recursive: true });
    }
    const resultScript = path.join(root, 'src/result/result.js');
    const source = await readFile(resultScript, 'utf8');
    await writeFile(resultScript, source.replace('export const debugApi', 'const debugApi'));
    await assert.rejects(
      buildExtension({ root, outDir: path.join(await scratchDir(), 'build') }),
      /must export "debugApi"/,
    );
  });

  it('fails with a clear message when result.html does not load result.js', async () => {
    const root = await scratchDir();
    for (const entry of ['src', 'icons', 'manifest.json']) {
      await cp(path.join(REPO_ROOT, entry), path.join(root, entry), { recursive: true });
    }
    const page = path.join(root, 'src/result/result.html');
    const html = await readFile(page, 'utf8');
    await writeFile(page, html.replace('src="result.js"', 'src="other.js"'));
    await assert.rejects(
      buildExtension({ root, outDir: path.join(await scratchDir(), 'build') }),
      /found 0/,
    );
  });
});

describe('clean-up', () => {
  it('removeBuild does nothing for a missing folder or a folder without the marker', async () => {
    const dir = await scratchDir();
    await writeFile(path.join(dir, 'file.txt'), 'x');
    await removeBuild(dir);
    assert.ok(existsSync(path.join(dir, 'file.txt')));
    await removeBuild(path.join(dir, 'missing'));
  });

  it('deletes a default build when the process that built it exits', async () => {
    const script = [
      `import { buildExtension } from ${JSON.stringify(BUILD_MODULE_URL)};`,
      'console.log(await buildExtension());',
    ].join('\n');
    const printed = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
    }).trim();
    assert.equal(path.dirname(printed), BUILD_PARENT);
    assert.ok(!existsSync(printed), `${printed} must be gone after the process exit`);
  });

  it('keeps a build in a folder that the caller named, also after the process exit', async () => {
    const out = path.join(await scratchDir(), 'named');
    const script = [
      `import { buildExtension } from ${JSON.stringify(BUILD_MODULE_URL)};`,
      `await buildExtension({ outDir: ${JSON.stringify(out)} });`,
    ].join('\n');
    execFileSync(process.execPath, ['--input-type=module', '-e', script]);
    assert.ok(existsSync(path.join(out, 'manifest.json')));
  });
});
