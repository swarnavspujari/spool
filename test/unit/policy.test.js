// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  checkCss,
  checkHtml,
  checkJs,
  checkManifest,
  checkRemoteUrls,
  checkSourceFile,
  checkTsCheckHeader,
  formatFinding,
  manifestReferencedFiles,
  stripComments,
  SCANNED_EXTENSIONS,
  checkPackagedFileTypes,
  checkSvg,
  isPackagedSourceFile,
} from '../../scripts/lib/policy.mjs';

/** @param {ReadonlyArray<{ line: number }>} findings @returns {number[]} */
const linesOf = (findings) => findings.map((finding) => finding.line);

/** @param {string} text @returns {number[]} Offsets of the line break characters. */
const lineBreaks = (text) => [...text.matchAll(/[\n\r]/g)].map((match) => match.index);

describe('stripComments', () => {
  it('blanks line and block comments and keeps the code', () => {
    const source = 'a(); // eval(x)\nb(); /* eval(y) */ c();';
    const out = stripComments(source);
    assert.equal(out.length, source.length);
    assert.equal(out.replace(/ +/g, ' '), 'a(); \nb(); c();');
  });

  it('keeps every offset and line break', () => {
    const source = 'x /* one\ntwo\nthree */ y // end\r\nz /* open';
    const out = stripComments(source);
    assert.equal(out.length, source.length);
    assert.deepEqual(lineBreaks(out), lineBreaks(source));
    assert.ok(out.includes('x '));
    assert.ok(out.includes(' y '));
    assert.ok(out.includes('z '));
    assert.ok(!/one|two|three|end|open/.test(out));
  });

  it('ends a line comment at a CRLF line break', () => {
    assert.equal(stripComments('a // c\r\nb'), 'a     \r\nb');
  });

  it('does not start a comment inside a string', () => {
    for (const source of [
      "const u = 'chrome-extension://x'; eval(code);",
      'const u = "chrome-extension://x"; eval(code);',
      'const u = `chrome-extension://x`; eval(code);',
      "const s = '/* not a comment */'; eval(code);",
      "const s = 'it\\'s // still a string'; eval(code);",
    ]) {
      assert.equal(stripComments(source), source, source);
    }
  });

  it('ends a string that has no closing quote at the line end', () => {
    const out = stripComments("const s = 'oops;\neval(1); // gone");
    assert.equal(out, "const s = 'oops;\neval(1);        ");
  });

  it('continues a string after a backslash at the line end', () => {
    const source = "const s = 'a \\\n// b'; // gone";
    assert.equal(stripComments(source), "const s = 'a \\\n// b';        ");
  });

  it('handles comment markers in template literals and in their expressions', () => {
    const source = 'const t = `x // ${ fn(`y`) /* hidden */ } z // text`; // gone\nafter();';
    const out = stripComments(source);
    assert.ok(out.includes('`x // ${ fn(`y`) '));
    assert.ok(out.includes('} z // text`;'));
    assert.ok(!out.includes('hidden') && !out.includes('gone'));
    assert.ok(out.endsWith('\nafter();'));
  });

  it('counts braces inside a template expression', () => {
    const source = 'const t = `${ { a: 1 }.a } // text`; // gone';
    assert.equal(stripComments(source), 'const t = `${ { a: 1 }.a } // text`;        ');
  });

  it('reads regex literals as regexes', () => {
    for (const code of [
      'const r = /[/*]/; eval(1);', // the class would start a block comment if read as code
      "const r = /'/g;", // the quote would start a string that hides the comment
      'return /"/.test(s);',
      'x = a ? /\\//.test(s) : 0;',
    ]) {
      assert.equal(stripComments(`${code} // c`).trimEnd(), code, code);
    }
  });

  it('reads a slash after a value as a division', () => {
    for (const code of ['x = a / 2;', 'y = (b) / 4 / c;', 'z = 6 / 3 / 2;', 'w = a[1] / b;']) {
      assert.equal(stripComments(`${code} // c`).trimEnd(), code, code);
    }
  });

  it('blanks an unterminated block comment to the end', () => {
    assert.equal(stripComments('a /* open\nb'), 'a        \n ');
  });
});

describe('checkJs', () => {
  const forbidden = [
    "eval('1')",
    'window.eval (x)',
    "new Function('a', 'return a')",
    "Function('return 1')()",
    "setTimeout('run()', 10)",
    'setInterval("run()", 10)',
    'setTimeout(`run()`, 10)',
    'el.innerHTML = x',
    'el.outerHTML',
    "el.insertAdjacentHTML('beforeend', x)",
    'document.write(x)',
    'document . writeln(x)',
    'await fetch(url)',
    'new XMLHttpRequest()',
    'new WebSocket(address)',
    'new EventSource(address)',
    'navigator.sendBeacon(address, data)',
    "importScripts('a.js')",
    "await import('./a.js')",
    'import ("./a.js").then(run)',
    'const m = await import\n(`./${name}.js`)',
    'globalThis.spoolDebug = debug',
    "/** @type {any} */ (globalThis)['spoolDebug'] = debug",
    'globalThis.__spoolTest.startCapture(tab)',
  ];
  for (const code of forbidden) {
    it(`flags ${code}`, () => {
      const findings = checkJs('src/a.js', `${code};`);
      assert.equal(findings.length, 1);
      assert.deepEqual(findings[0], { file: 'src/a.js', line: 1, message: findings[0]?.message });
      assert.match(findings[0]?.message ?? '', /forbidden/);
    });
  }

  const allowed = [
    'setTimeout(() => {}, 5)',
    'setTimeout(fn, 5)',
    'setInterval(tick, 1000)',
    'prefetch(x)',
    'retrieval(x)',
    'evaluate(x)',
    'isFunction(x)',
    "typeof x === 'function'",
    'const innerHTMLLength = 1',
    'el.textContent = x',
    "document.createElement('div')",
    "// eval('x'); el.innerHTML = x",
    '/* new Function() and fetch(url) */',
    '/**\n * Do not call document.write(x).\n */',
    "import { a } from './a.js';",
    "import './a.js';",
    "export { b } from './b.js';",
    'const url = import.meta.url;',
    "/** @typedef {import('./a.js').A} A */",
    "// await import('./a.js')",
    'tool.import(file)',
    'tool?.import (file)',
    'const reimport = 1; reimport(file); my_import(file); $import(file);',
    '// globalThis.spoolDebug is added by the test build',
    'export const debugApi = {};',
    'const myspoolDebugger = 1;',
  ];
  for (const code of allowed) {
    it(`allows ${JSON.stringify(code)}`, () => {
      assert.deepEqual(checkJs('src/a.js', code), []);
    });
  }

  it('reports the line of the match', () => {
    assert.deepEqual(linesOf(checkJs('src/a.js', 'a();\nb();\neval(1);\n')), [3]);
    assert.deepEqual(linesOf(checkJs('src/a.js', '/*\n\n*/ eval(1)')), [3]);
  });

  it('finds a string argument on a later line', () => {
    assert.deepEqual(linesOf(checkJs('src/a.js', "setTimeout(\n  'x',\n  1);")), [1]);
  });

  it('sees code after a string that contains //', () => {
    const findings = checkJs('src/a.js', "const u = 'chrome-extension://x'; eval(code);");
    assert.equal(findings.length, 1);
  });

  it('ignores a comment after a string that contains //', () => {
    assert.deepEqual(checkJs('src/a.js', 'const s = "a // b"; // eval(x)'), []);
  });

  it('reports each match', () => {
    assert.deepEqual(linesOf(checkJs('src/a.js', 'eval(1);\nel.innerHTML = fetch(u);')), [1, 2, 2]);
  });
});

describe('checkJs: runtime message listeners (result and options pages)', () => {
  const listeners = [
    'chrome.runtime.onMessage.addListener(handler);',
    'browser.runtime.onMessage.addListener(handler);',
    'chrome.runtime?.onMessage.addListener(handler);',
    'chrome . runtime . onMessage . addListener(handler);',
    'chrome.runtime\n  .onMessage\n  .addListener(handler);',
    'chrome.runtime.onMessageExternal.addListener(handler);',
    "chrome.runtime['onMessage'].addListener(handler);",
    'const { onMessage } = chrome.runtime;',
  ];
  for (const dir of ['src/result/', 'src/options/']) {
    for (const code of listeners) {
      it(`flags ${JSON.stringify(code)} in ${dir}`, () => {
        const findings = checkJs(`${dir}x.js`, code);
        assert.equal(findings.length, 1);
        assert.match(findings[0]?.message ?? '', /runtime\.onMessage is forbidden/);
        assert.match(findings[0]?.message ?? '', /service worker and the offscreen document/);
      });
    }
  }

  it('reports the line of the listener', () => {
    const source = 'a();\nb();\nchrome.runtime.onMessage.addListener(c);\n';
    assert.deepEqual(linesOf(checkJs('src/result/result.js', source)), [3]);
  });

  it('flags a listener in a nested path and with a Windows path separator', () => {
    const code = 'chrome.runtime.onMessage.addListener(h);';
    assert.equal(checkJs('src/result/deep/x.js', code).length, 1);
    assert.equal(checkJs('src\\options\\x.js', code).length, 1);
  });

  it('allows the listeners of the service worker and the offscreen document', () => {
    const code = 'chrome.runtime.onMessage.addListener(router);';
    const files = ['src/sw/service-worker.js', 'src/offscreen/offscreen.js', 'src/sw/router.js'];
    for (const file of files) {
      assert.deepEqual(checkJs(file, code), [], file);
    }
  });

  it('does not apply to folders whose name only starts like the two folders', () => {
    const code = 'chrome.runtime.onMessage.addListener(h);';
    for (const file of ['src/results/x.js', 'src/options-old/x.js', 'src/lib/result/x.js']) {
      assert.deepEqual(checkJs(file, code), [], file);
    }
  });

  it('allows sending messages and the events of a Port', () => {
    const code = [
      'await chrome.runtime.sendMessage(message);',
      'port.onMessage.addListener(handler);',
      'const port = chrome.runtime.connect(); port.onMessage.addListener(handler);',
      'window.onmessage = null;',
      "addEventListener('message', handler);",
      'const onMessageCount = 1;',
    ].join('\n');
    assert.deepEqual(checkJs('src/result/result.js', code), []);
  });

  it('ignores a listener that appears only in a comment', () => {
    const code = '// chrome.runtime.onMessage.addListener(h)\n/* runtime.onMessage */';
    assert.deepEqual(checkJs('src/options/options.js', code), []);
  });
});

describe('checkTsCheckHeader', () => {
  it('accepts // @ts-check on the first line', () => {
    assert.deepEqual(checkTsCheckHeader('src/a.js', '// @ts-check\nexport {};\n'), []);
    assert.deepEqual(checkTsCheckHeader('src/a.js', '// @ts-check\r\nexport {};\r\n'), []);
    assert.deepEqual(checkTsCheckHeader('src/a.js', '// @ts-check'), []);
    assert.deepEqual(checkTsCheckHeader('src/a.js', '﻿// @ts-check\n'), []);
  });

  for (const source of [
    '',
    'export {};\n',
    '\n// @ts-check\n',
    '/** Doc. */\n// @ts-check\n',
    '// @ts-nocheck\n',
    '// @ts-check extra\n',
    '/* @ts-check */\n',
  ]) {
    it(`rejects ${JSON.stringify(source)}`, () => {
      const findings = checkTsCheckHeader('src/a.js', source);
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.line, 1);
    });
  }
});

describe('checkRemoteUrls', () => {
  it('flags http:// and https:// in code, strings and comments', () => {
    const source = "// see https://example.com\nconst a = 'http://a.test';\nx = HTTPS://B.TEST;";
    assert.deepEqual(linesOf(checkRemoteUrls('src/a.js', source)), [1, 2, 3]);
  });

  it('allows other schemes and words', () => {
    const source = [
      'chrome-extension://abc',
      'blob:null/1',
      'data:image/png;base64,AAAA',
      'https is a word',
      'localhost://x',
    ].join('\n');
    assert.deepEqual(checkRemoteUrls('src/a.js', source), []);
  });
});

describe('checkHtml', () => {
  const cleanPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Options</title>
  <link rel="stylesheet" href="options.css">
</head>
<body class="onclick">
  <button id="save" data-on="x" title="javascript is fun">Save</button>
  <script type="module" src="options.js"></script>
</body>
</html>
`;

  it('accepts a page with module scripts and a linked stylesheet', () => {
    assert.deepEqual(checkHtml('src/a.html', cleanPage), []);
  });

  it('accepts unquoted values, upper case and boolean attributes', () => {
    const html = '<SCRIPT SRC="a.js" TYPE="Module"></SCRIPT>\n<script src=b.js type=module defer>';
    assert.deepEqual(checkHtml('src/a.html', html), []);
  });

  it('flags an inline script', () => {
    const findings = checkHtml('src/a.html', '<script type="module">run();</script>');
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? '', /inline <script>/);
  });

  it('flags a script without type="module"', () => {
    for (const tag of [
      '<script src="a.js"></script>',
      '<script src="a.js" type="text/javascript"></script>',
      '<script src="a.js" type=""></script>',
    ]) {
      const findings = checkHtml('src/a.html', tag);
      assert.equal(findings.length, 1, tag);
      assert.match(findings[0]?.message ?? '', /type="module"/);
    }
  });

  it('reports an inline script without a type twice', () => {
    assert.equal(checkHtml('src/a.html', '<script>run();</script>').length, 2);
  });

  it('flags <style>', () => {
    for (const tag of ['<style>a{}</style>', '<STYLE media="print">a{}</STYLE>']) {
      const findings = checkHtml('src/a.html', tag);
      assert.equal(findings.length, 1, tag);
      assert.match(findings[0]?.message ?? '', /<style>/);
    }
  });

  it('flags a style attribute', () => {
    for (const tag of ['<p style="color:red">', "<p STYLE='x'>", '<p style=x>', '<p style>']) {
      const findings = checkHtml('src/a.html', tag);
      assert.equal(findings.length, 1, tag);
      assert.match(findings[0]?.message ?? '', /style="\.\.\."/);
    }
  });

  it('flags event handler attributes', () => {
    for (const tag of ['<button onclick="x()">', '<img onerror=x>', '<body onLoad="x()">']) {
      const findings = checkHtml('src/a.html', tag);
      assert.equal(findings.length, 1, tag);
      assert.match(findings[0]?.message ?? '', /handler/);
    }
  });

  it('flags javascript: URLs, also with spaces and mixed case', () => {
    for (const tag of [
      '<a href="javascript:void(0)">',
      '<a href=" JavaScript:x()">',
      '<a href="java\tscript:x()">',
      "<form action='javascript:x()'>",
    ]) {
      const findings = checkHtml('src/a.html', tag);
      assert.equal(findings.length, 1, tag);
      assert.match(findings[0]?.message ?? '', /javascript:/);
    }
  });

  it('reads a tag whose quoted value contains ">"', () => {
    const findings = checkHtml('src/a.html', '<div title="a > b" onclick="x()">');
    assert.equal(findings.length, 1);
  });

  it('ignores HTML comments and keeps line numbers', () => {
    const html = '<!-- <script>run()</script>\n<p onclick="x"> -->\n<p style="a">';
    assert.deepEqual(linesOf(checkHtml('src/a.html', html)), [3]);
  });

  it('reports the line of the tag', () => {
    const html = '<html>\n<body>\n  <p onclick="x">\n</body>';
    assert.deepEqual(linesOf(checkHtml('src/a.html', html)), [3]);
  });

  it('does not treat text as a tag', () => {
    assert.deepEqual(checkHtml('src/a.html', '<p>1 < 2 and onclick=x and style=y</p>'), []);
  });
});

describe('checkCss', () => {
  it('flags @import', () => {
    for (const css of ['@import url("a.css");', "@IMPORT 'a.css';", 'a{}\n@import"a.css";']) {
      assert.equal(checkCss('src/a.css', css).length, 1, css);
    }
  });

  it('flags remote url()', () => {
    for (const css of [
      'a{background:url(https://example.test/a.png)}',
      "a{background:url('http://example.test/a.png')}",
      'a{background:url( "//cdn.test/a.png" )}',
      'a{background:URL(//cdn.test/a.png)}',
    ]) {
      const findings = checkCss('src/a.css', css);
      assert.equal(findings.length, 1, css);
      assert.match(findings[0]?.message ?? '', /remote url\(\)/);
    }
  });

  it('allows local url() and similar words', () => {
    const css = [
      'a{background:url(icon.png)}',
      'b{background:url("data:image/png;base64,AAAA")}',
      'c{fill:url(#gradient)}',
      'd{content:"@importance"}',
      'e{background:url(../img/a.png)}',
    ].join('\n');
    assert.deepEqual(checkCss('src/a.css', css), []);
  });

  it('ignores comments and keeps line numbers', () => {
    const css = '/* @import "a.css";\n   url(http://x.test) */\n@import "b.css";';
    assert.deepEqual(linesOf(checkCss('src/a.css', css)), [3]);
  });
});

describe('checkSourceFile', () => {
  it('runs the JS rules, the header rule and the URL rule on .js files', () => {
    const findings = checkSourceFile('src/a.js', "eval('x'); // https://example.test");
    assert.equal(findings.length, 3);
    assert.deepEqual(findings.map((f) => f.file), ['src/a.js', 'src/a.js', 'src/a.js']);
  });

  it('applies the listener rule by path', () => {
    const code = '// @ts-check\nchrome.runtime.onMessage.addListener(h);\n';
    assert.equal(checkSourceFile('src/result/result.js', code).length, 1);
    assert.equal(checkSourceFile('src/options/options.js', code).length, 1);
    assert.deepEqual(checkSourceFile('src/offscreen/offscreen.js', code), []);
  });

  it('flags dynamic import() in any .js file', () => {
    const findings = checkSourceFile('src/lib/a.js', "// @ts-check\nawait import('./b.js');\n");
    assert.deepEqual(linesOf(findings), [2]);
  });

  it('accepts a clean .js file', () => {
    assert.deepEqual(checkSourceFile('src/a.js', '// @ts-check\nexport const a = 1;\n'), []);
  });

  it('runs the HTML and URL rules on .html files, whatever the case of the extension', () => {
    const findings = checkSourceFile('src/A.HTML', '<a href="https://example.test" onclick="x">');
    assert.equal(findings.length, 2);
  });

  it('runs the CSS rules on .css files', () => {
    assert.equal(checkSourceFile('src/a.css', '@import "a.css";').length, 1);
  });

  it('skips other file types', () => {
    assert.deepEqual(checkSourceFile('src/a.json', '{"u":"https://example.test"}'), []);
    assert.deepEqual(checkSourceFile('src/a.d.ts', 'eval(1)'), []);
  });
});

describe('manifestReferencedFiles', () => {
  it('lists icons, action icon and popup, service worker and options page', () => {
    const manifest = {
      icons: { 16: 'icons/16.png', 48: 'icons/48.png' },
      action: { default_icon: { 16: 'icons/16.png', 32: 'icons/32.png' }, default_popup: 'p.html' },
      background: { service_worker: 'sw.js' },
      options_ui: { page: 'options.html' },
      options_page: 'old-options.html',
    };
    assert.deepEqual(manifestReferencedFiles(manifest), [
      'icons/16.png',
      'icons/48.png',
      'icons/32.png',
      'p.html',
      'sw.js',
      'options.html',
      'old-options.html',
    ]);
  });

  it('accepts a string as the action icon', () => {
    assert.deepEqual(manifestReferencedFiles({ action: { default_icon: 'a.png' } }), ['a.png']);
  });

  it('ignores missing, empty and non-string values', () => {
    assert.deepEqual(manifestReferencedFiles({}), []);
    const manifest = { icons: { 16: '', 32: 5, 48: null }, background: { service_worker: 7 } };
    assert.deepEqual(manifestReferencedFiles(manifest), []);
  });
});

describe('checkManifest', () => {
  const baseline = { permissions: ['activeTab', 'downloads'], csp: "default-src 'none'" };
  const manifest = () => ({
    manifest_version: 3,
    incognito: 'not_allowed',
    icons: { 16: 'icons/a.png', 32: 'icons/b.png' },
    action: { default_icon: { 16: 'icons/a.png' } },
    background: { service_worker: 'src/sw.js', type: 'module' },
    options_ui: { page: 'src/options.html' },
    permissions: ['downloads', 'activeTab'],
    content_security_policy: { extension_pages: "default-src 'none'" },
  });
  const everythingExists = () => true;

  /** @param {Record<string, unknown>} changes @returns {string[]} The messages. */
  const messagesFor = (changes) =>
    checkManifest({ ...manifest(), ...changes }, baseline, everythingExists).map((f) => f.message);

  it('accepts a manifest that matches the baseline, whatever the order of permissions', () => {
    assert.deepEqual(checkManifest(manifest(), baseline, everythingExists), []);
  });

  it('flags a manifest_version other than 3', () => {
    assert.deepEqual(messagesFor({ manifest_version: 2 }), ['manifest_version must be 3']);
  });

  it('flags a background that is not a module service worker', () => {
    const expected = ['background.type must be "module"'];
    assert.deepEqual(messagesFor({ background: { service_worker: 'src/sw.js' } }), expected);
    assert.deepEqual(
      messagesFor({ background: { service_worker: 'src/sw.js', type: 'classic' } }),
      expected,
    );
  });

  it('flags a permission that is not in the baseline', () => {
    const messages = messagesFor({ permissions: ['activeTab', 'downloads', 'tabs'] });
    assert.equal(messages.length, 1);
    assert.match(messages[0] ?? '', /permissions must equal the baseline/);
    assert.match(messages[0] ?? '', /\[activeTab, downloads, tabs\]/);
  });

  it('flags a missing, an extra and a duplicate permission', () => {
    assert.equal(messagesFor({ permissions: ['activeTab'] }).length, 1);
    assert.equal(messagesFor({ permissions: [] }).length, 1);
    assert.equal(messagesFor({ permissions: undefined }).length, 1);
    assert.equal(messagesFor({ permissions: ['activeTab', 'activeTab', 'downloads'] }).length, 1);
    assert.equal(messagesFor({ permissions: 'activeTab' }).length, 1);
  });

  it('flags a CSP that differs from the baseline', () => {
    const expected = ['content_security_policy.extension_pages must equal the baseline CSP'];
    for (const content_security_policy of [
      { extension_pages: "default-src 'self'" },
      { extension_pages: "default-src 'none' " },
      {},
      "default-src 'none'",
      undefined,
    ]) {
      assert.deepEqual(messagesFor({ content_security_policy }), expected);
    }
  });

  const forbiddenKeys = [
    'host_permissions',
    'optional_host_permissions',
    'optional_permissions',
    'content_scripts',
    'web_accessible_resources',
    'externally_connectable',
    'sandbox',
    'oauth2',
    'update_url',
    'key',
    'chrome_url_overrides',
    'devtools_page',
    'side_panel',
    'sidebar_action',
    'declarative_net_request',
  ];
  for (const key of forbiddenKeys) {
    it(`flags the key ${key}, also when it is empty`, () => {
      assert.deepEqual(messagesFor({ [key]: [] }), [`"${key}" is forbidden`]);
      assert.deepEqual(messagesFor({ [key]: {} }), [`"${key}" is forbidden`]);
      assert.deepEqual(messagesFor({ [key]: '' }), [`"${key}" is forbidden`]);
      assert.deepEqual(messagesFor({ [key]: null }), [`"${key}" is forbidden`]);
    });
  }

  it('requires incognito to be "not_allowed"', () => {
    const expected = [
      '"incognito" must be "not_allowed": captures must not run in private windows',
    ];
    assert.deepEqual(messagesFor({ incognito: 'spanning' }), expected);
    assert.deepEqual(messagesFor({ incognito: 'split' }), expected);
    assert.deepEqual(messagesFor({ incognito: 'Not_Allowed' }), expected);
    assert.deepEqual(messagesFor({ incognito: ' not_allowed' }), expected);
    assert.deepEqual(messagesFor({ incognito: true }), expected);
    assert.deepEqual(messagesFor({ incognito: null }), expected);
    assert.deepEqual(messagesFor({ incognito: undefined }), expected, 'a missing key fails');
    assert.deepEqual(messagesFor({ incognito: 'not_allowed' }), []);
  });

  it('flags background.scripts, also when the service worker is set', () => {
    const expected = [
      '"background.scripts" is forbidden: the only background code is "service_worker"',
    ];
    const background = { service_worker: 'src/sw.js', type: 'module' };
    assert.deepEqual(messagesFor({ background: { ...background, scripts: ['a.js'] } }), expected);
    assert.deepEqual(messagesFor({ background: { ...background, scripts: [] } }), expected);
  });

  it('does not fail on a background that is not an object', () => {
    for (const background of [null, 'src/sw.js', 5, [], undefined]) {
      const messages = messagesFor({ background });
      assert.ok(messages.includes('background.type must be "module"'), String(background));
      assert.ok(!messages.some((m) => m.includes('background.scripts')), String(background));
    }
  });

  it('flags every referenced file that does not exist, once', () => {
    const present = new Set(['icons/b.png', 'src/sw.js']);
    const findings = checkManifest(manifest(), baseline, (path) => present.has(path));
    assert.deepEqual(
      findings.map((f) => f.message),
      [
        'the file "icons/a.png" is referenced but missing',
        'the file "src/options.html" is referenced but missing',
      ],
    );
  });

  it('reports findings against manifest.json', () => {
    const [finding] = checkManifest({ ...manifest(), manifest_version: 2 }, baseline, () => true);
    assert.equal(finding && formatFinding(finding), 'manifest.json:1: manifest_version must be 3');
  });
});

describe('formatFinding', () => {
  it('prints file:line: message', () => {
    assert.equal(formatFinding({ file: 'src/a.js', line: 12, message: 'bad' }), 'src/a.js:12: bad');
  });
});

// ---------------------------------------------------------------------------------------------
// Added by mutation testing. Each case here fails for a mutant
// of scripts/lib/policy.mjs that the earlier cases let through.
// ---------------------------------------------------------------------------------------------

describe('stripComments: where a comment hides or shows', () => {
  /**
   * `code` is followed by a line comment that holds `eval(1)`. A lexer that lost its place in
   * `code` (a string, a regex or a template that ends too late) would leave `eval(1)` visible.
   * @param {string} code
   * @returns {number} Findings for the eval inside the comment: 0 when the comment is hidden.
   */
  const evalSeenAfter = (code) => checkJs('src/a.js', `${code} // eval(1)`).length;

  it('blanks a comment that follows each kind of token', () => {
    const codes = [
      "const s = '';", // empty string
      "const s = '\\\\';", // a string that holds one backslash
      "const s = 'a'", // comment right after the closing quote (no space)
      'const t = ``;', // empty template
      'const t = `${a}`;',
      'const t = `a`',
      'x = /a/;', // regex with no flags
      "x = /\\/'/;", // regex that holds an escaped slash and a quote
      "const r = /[/']/;", // slash and quote inside a character class
      'x = COUNT / 2', // identifier that ends in a letter of the mutated prefix string
      'x = $return / 2', // keyword text inside an identifier with $
      'a(); return /"/.test(s);', // keyword after other code
    ];
    for (const code of codes) {
      assert.equal(evalSeenAfter(code), 0, code);
    }
  });

  it('blanks a comment that follows a string or a template with no space between', () => {
    assert.deepEqual(checkJs('src/a.js', "const s = 'a'// eval(1)"), []);
    assert.deepEqual(checkJs('src/a.js', 'const t = `a`// eval(1)'), []);
    assert.deepEqual(checkJs('src/a.js', "const s = 'a'/* eval(1) */"), []);
  });

  it('ends a string that has no closing quote at a lone CR', () => {
    assert.deepEqual(checkJs('src/a.js', "const s = 'oops;\r// eval(1)"), []);
  });

  it('ends a regex search at a lone CR', () => {
    assert.deepEqual(checkJs('src/a.js', 'x = {}\r/ 2; a()\r// eval(1)\r'), []);
  });

  it('shows code that follows a block comment directly', () => {
    assert.equal(checkJs('src/a.js', 'a(); /* c */eval(1);').length, 1);
    assert.equal(checkJs('src/a.js', 'a /**/ eval(1)').length, 1);
    // `/*/` does not close itself: the comment runs on to the real `*/`.
    assert.deepEqual(checkJs('src/a.js', 'a /*/ eval(1) */ b'), []);
  });

  it('reads a slash that has no closing slash on its line as a division', () => {
    // After `}` a slash may start a regex, but this line has no closing slash. A regex cannot
    // run over a line break, so the `//` comment on the next line must still be a comment.
    assert.deepEqual(checkJs('src/a.js', 'x = {}\n/ 2; a()\n// eval(1)\n'), []);
    assert.equal(stripComments('x = {}\n/ 2; a()\n// c\n'), 'x = {}\n/ 2; a()\n    \n');
  });

  // Fixed defect found by mutation testing. After `)` the lexer read a slash
  // as a division, so a regex that follows `if (...)` was read as code. The `//` inside the regex
  // then started a "comment" that blanked the rest of the line, and `eval(1)` was not found.
  it('finds eval() after a regex literal that follows if (...)', () => {
    const code = String.raw`if (a) /\/\//.test(s) || eval(1);`;
    assert.equal(checkJs('src/a.js', code).length, 1);
  });

  it('does not end a regex at a slash inside its character class', () => {
    assert.equal(stripComments("r = /[/']/; // c"), "r = /[/']/;     ");
    // An unterminated class at the end of the file: the rest is not a regex.
    assert.equal(stripComments('x = /[ // eval(1)'), `x = /[${' '.repeat(11)}`);
  });

  it('keeps regex flags with the regex', () => {
    assert.equal(stripComments('r = /a/gi; // c'), 'r = /a/gi;     ');
    // The comment starts right after the closing slash of the regex.
    assert.equal(stripComments('r = /x///c'), 'r = /x/   ');
  });

  it('reads a regex at the start of a file, after white space', () => {
    assert.deepEqual(checkJs('src/a.js', ' /"/.test(s) // eval(1)'), []);
    assert.deepEqual(checkJs('src/a.js', '\n\t/"/.test(s) // eval(1)'), []);
  });

  it('reads a slash after each keyword that can end before a value as a regex', () => {
    const keywords = [
      'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete',
      'instanceof', 'throw', 'new',
    ];
    for (const keyword of keywords) {
      assert.equal(evalSeenAfter(`${keyword} /"/.test(s);`), 0, keyword);
    }
  });

  it('reads a slash after each punctuation mark that cannot end a value as a regex', () => {
    for (const mark of '(,=:[!&|?{};+-*%<>~^') {
      assert.equal(evalSeenAfter(`a ${mark} /"/.test(s);`), 0, mark);
    }
  });

  it('reads a slash after an identifier as a division, whatever its last letter', () => {
    for (const name of ['NUM', 'MUT', 'T', 'M', 'U', 'a$', '$x', 'x_1']) {
      assert.equal(evalSeenAfter(`y = ${name} / 2;`), 0, name);
    }
  });

  it('keeps line breaks of every kind inside a block comment', () => {
    const source = 'x /* a\r\nb\rc\nd */ y';
    const out = stripComments(source);
    assert.equal(out.length, source.length);
    assert.deepEqual(lineBreaks(out), lineBreaks(source));
  });

  it('ends a line comment at a lone CR', () => {
    assert.equal(checkJs('src/a.js', 'a(); // c\reval(1);').length, 1);
  });
});

describe('stripComments: template literals', () => {
  it('keeps text after an escaped backtick or an escaped backslash inside the template', () => {
    const escapedTick = 'const t = `a\\`b // text`; eval(1); // c';
    assert.equal(stripComments(escapedTick), 'const t = `a\\`b // text`; eval(1);     ');
    const escapedSlash = 'const t = `\\\\`; eval(1); // c';
    assert.equal(stripComments(escapedSlash), 'const t = `\\\\`; eval(1);     ');
    assert.equal(checkJs('src/a.js', escapedSlash).length, 1);
  });

  it('does not open an expression for a $ that has no { after it', () => {
    const source = 'const t = `price $5 // text`; eval(1);';
    assert.equal(stripComments(source), source);
    assert.equal(stripComments('const t = `a{b}// text`;'), 'const t = `a{b}// text`;');
  });

  it('leaves a closing brace after a template to the code', () => {
    const source = 'function f() {\n  const t = `x`;\n}\n// eval(1)\n';
    assert.deepEqual(checkJs('src/a.js', source), []);
    const withExpr = 'function f() {\n  const t = `${a}`;\n}\n// eval(1)\n';
    assert.deepEqual(checkJs('src/a.js', withExpr), []);
  });

  it('counts braces at every depth inside an expression', () => {
    const oneLevel = 'const t = `${ {/* h1 */ a: 1}/* h2 */.a /* h3 */ } z`; // gone';
    const out = stripComments(oneLevel);
    assert.ok(!/h1|h2|h3|gone/.test(out), out);
    assert.ok(out.includes(' z`;'), out);

    const twoLevels = 'const t = `${ { b: { c: 1 } }.b /* hidden */ } z`; // gone';
    assert.ok(!/hidden|gone/.test(stripComments(twoLevels)));
  });

  it('reads a comment right after the opening of an expression', () => {
    const out = stripComments('const t = `${/* hidden */ a}`; // gone');
    assert.ok(!/hidden|gone/.test(out), out);
  });

  it('closes the inner expression of a nested template that holds an object literal', () => {
    const source = 'const t = `${ `${ { a: 1 }.a }` /* hidden */ }`; // gone';
    const out = stripComments(source);
    assert.ok(!/hidden|gone/.test(out), out);
    assert.equal(out.length, source.length);
  });

  it('reads templates inside expressions of templates', () => {
    const source = 'const t = `a${ `b${ c /* h1 */ }` /* h2 */ }d // text`; // gone';
    const out = stripComments(source);
    assert.ok(!/h1|h2|gone/.test(out), out);
    assert.ok(out.includes('d // text`;'), 'the template text keeps its // text');

    const nested = 'const t = `${ `${ { a: 1 }.a /* hidden */ }` }`; // gone';
    assert.ok(!/hidden|gone/.test(stripComments(nested)));
  });
});

describe('checkJs: rules apply to the whole word only', () => {
  const lookalikes = [
    'const x = new FunctionBuilder();',
    'const newFunction = 1;',
    "mysetTimeout('x', 1)",
    "setTimeoutLater('x', 1)",
    'preinnerHTML = 1',
    'outerHTMLCount = 2',
    'xinsertAdjacentHTML(1)',
    'insertAdjacentHTMLs(1)',
    'xdocument.write(1)',
    'document.writeable = 1',
    'document.writer(1)',
    'myfetch(url)',
    'fetchAll(url)',
    'MyWebSocketServer()',
    'WebSocketLike()',
    'xEventSource = 1',
    'xsendBeacon(1)',
    'myimportScripts(1)',
    'importScriptsLater()',
    'xspoolDebug = 1',
    'spoolDebugX = 1',
    'x__spoolTest = 1',
    '__spoolTesting = 1',
  ];
  for (const code of lookalikes) {
    it(`allows ${JSON.stringify(code)}`, () => {
      assert.deepEqual(checkJs('src/a.js', code), []);
    });
  }

  it('flags a forbidden word that has a dot in front of it', () => {
    for (const code of ["window.setTimeout('x', 1)", 'self.eval(1)', 'a.b.fetch(url)']) {
      assert.equal(checkJs('src/a.js', code).length, 1, code);
    }
  });

  it('allows names that only contain onMessage or runtime', () => {
    const code = [
      'const myonMessage = 1;',
      'const $onMessage = 2;',
      'const a_onMessage = 3;',
      'const myruntime = {}; myruntime.onMessageCount = 1;',
      'ruler.onMessage = null;',
      'myruntime.onMessage.addListener(h);',
      'chrome.runtime.onMessageCount = 1;',
      'chrome.runtime.onMessageExternalX = 1;',
    ].join('\n');
    assert.deepEqual(checkJs('src/result/result.js', code), []);
  });

  it('flags each rule with the message of that rule', () => {
    const hint = 'build DOM with createElement and textContent';
    const noNetwork = 'the extension makes no network requests';
    /** @type {[string, string][]} */
    const table = [
      ["eval('1')", 'eval() is forbidden'],
      ["new Function('a')", 'the Function constructor is forbidden'],
      ["setTimeout('run()', 10)", 'a string argument to setTimeout or setInterval is forbidden'],
      ['el.innerHTML = x', `innerHTML and outerHTML are forbidden: ${hint}`],
      ['el.outerHTML = x', `innerHTML and outerHTML are forbidden: ${hint}`],
      ["el.insertAdjacentHTML('a', x)", `insertAdjacentHTML is forbidden: ${hint}`],
      ['document.write(x)', 'document.write is forbidden'],
      ['fetch(url)', `fetch() is forbidden: ${noNetwork}`],
      ['new XMLHttpRequest()', `network API is forbidden: ${noNetwork}`],
      ["importScripts('a.js')", 'importScripts is forbidden: no dynamic code loading'],
      [
        'globalThis.spoolDebug = 1',
        'test hooks are forbidden in src/: only e2e/build-extension.mjs adds them to its copy',
      ],
      [
        "import('./a.js')",
        'dynamic import() is forbidden: no dynamic code loading, use static imports',
      ],
    ];
    for (const [code, message] of table) {
      const findings = checkJs('src/a.js', code);
      assert.equal(findings.length, 1, code);
      assert.equal(findings[0]?.message, message, code);
    }
  });

  it('flags a runtime message listener in the result and options pages with its message', () => {
    const findings = checkJs('src/result/x.js', 'chrome.runtime.onMessage.addListener(h);');
    assert.deepEqual(
      findings.map((finding) => finding.message),
      [
        'runtime.onMessage is forbidden in the result and options pages: only the service worker ' +
          'and the offscreen document may listen (full frames are broadcast with runtime.sendMessage)',
      ],
    );
  });
});

describe('line numbers and text of findings', () => {
  it('counts a leading blank line', () => {
    assert.deepEqual(linesOf(checkJs('src/a.js', '\n\neval(1)')), [3]);
    assert.deepEqual(linesOf(checkRemoteUrls('src/a.js', '\nhttps://a.test')), [2]);
  });

  it('words the other checks as written in CONTRIBUTING.md', () => {
    assert.equal(
      checkTsCheckHeader('a.js', 'x')[0]?.message,
      'the first line must be "// @ts-check"',
    );
    assert.equal(
      checkRemoteUrls('a.js', 'http://a.test')[0]?.message,
      'http(s):// URLs are forbidden: the extension makes no network requests',
    );
  });

  it('flags a byte order mark that is not the first character of the file', () => {
    assert.equal(checkTsCheckHeader('src/a.js', '// @ts-check﻿\n').length, 1);
    assert.deepEqual(checkTsCheckHeader('src/a.js', '﻿// @ts-check\n'), []);
  });

  it('scans .js, .mjs, .html, .css and .svg, and checkSourceFile checks each of them', () => {
    assert.deepEqual([...SCANNED_EXTENSIONS], ['.js', '.mjs', '.html', '.css', '.svg']);
    assert.ok(Object.isFrozen(SCANNED_EXTENSIONS));
    /** @type {Record<string, string>} */
    const bad = {
      '.js': 'eval(1);',
      '.mjs': '// @ts-check\nfetch("x");',
      '.svg': '<svg><script>x()</script></svg>',
      '.html': '<p onclick="x">',
      '.css': '@import "a.css";',
    };
    for (const extension of SCANNED_EXTENSIONS) {
      const sample = bad[extension];
      assert.ok(sample, `a bad sample for ${extension}`);
      assert.ok(checkSourceFile(`src/a${extension}`, sample).length > 0, extension);
    }
  });
});

describe('checkHtml: ways to hide a forbidden tag or attribute', () => {
  it('reads a tag whose name is followed by a slash instead of a space', () => {
    assert.equal(checkHtml('src/a.html', '<script/>run()</script>').length, 2);
    assert.match(checkHtml('src/a.html', '<img/onerror=x>')[0]?.message ?? '', /onerror.*handler/);
    assert.match(checkHtml('src/a.html', '<a href=x /onclick=y>')[0]?.message ?? '', /onclick/);
    assert.equal(checkHtml('src/a.html', '<style/>a{}</style>').length, 1);
  });

  it('reads single letter tags and tags without attributes', () => {
    assert.equal(checkHtml('src/a.html', '<p style="a">').length, 1);
    assert.equal(checkHtml('src/a.html', '<a onclick=x>').length, 1);
    assert.equal(checkHtml('src/a.html', '<script>run()</script>').length, 2);
  });

  it('reads attributes with an empty value', () => {
    assert.equal(checkHtml('src/a.html', '<p style="">').length, 1);
    assert.equal(checkHtml('src/a.html', "<p style=''>").length, 1);
    assert.equal(checkHtml('src/a.html', '<p onclick="">').length, 1);
  });

  it('allows attribute names that only contain "on", in the middle', () => {
    const html = '<div aria-controls="a" data-condition="b" data-icon="c" title="learn more">';
    assert.deepEqual(checkHtml('src/a.html', html), []);
  });

  it('flags javascript: only at the start of the value, after any white space or control', () => {
    assert.deepEqual(checkHtml('src/a.html', '<p title="see javascript: docs">'), []);
    assert.deepEqual(checkHtml('src/a.html', '<a href="page.html#javascript:x">'), []);
    const values = ['java\t\n script:x()', ' \tjavascript:x()', '\u0001javascript:x()', 'JaVa  Script:x'];
    for (const value of values) {
      assert.equal(checkHtml('src/a.html', `<a href="${value}">`).length, 1, JSON.stringify(value));
    }
  });

  it('ignores every comment, also an empty one, and an unterminated one hides the rest', () => {
    const two = '<!-- <p onclick="x"> -->\n<p>\n<!-- <p style="a"> -->\n<p title="b">';
    assert.deepEqual(checkHtml('src/a.html', two), []);
    assert.deepEqual(linesOf(checkHtml('src/a.html', '<!----><p onclick="x">')), [1]);
    assert.deepEqual(checkHtml('src/a.html', '<!-- <p onclick="x">'), []);
  });

  it('words each finding as written in CONTRIBUTING.md', () => {
    /** @type {[string, string][]} */
    const table = [
      ['<script type="module">x</script>', 'inline <script> is forbidden: use a module file'],
      ['<script src="a.js"></script>', '<script> must have type="module"'],
      ['<style>a{}</style>', '<style> is forbidden: use a stylesheet file'],
      ['<p style="a">', 'style="..." attribute is forbidden: use a stylesheet file'],
      ['<p onclick="a">', 'onclick="..." handler is forbidden'],
      ['<a href="javascript:a()">', 'javascript: URLs are forbidden'],
    ];
    for (const [html, message] of table) {
      assert.deepEqual(
        checkHtml('src/a.html', html).map((finding) => finding.message),
        [message],
        html,
      );
    }
  });
});

describe('checkCss: comments', () => {
  it('ignores every comment, also an empty one', () => {
    const css = '/* @import "a.css"; */\na{}\n/* url(http://x.test) */\n/**/ @import "b.css";';
    assert.deepEqual(linesOf(checkCss('src/a.css', css)), [4]);
  });

  it('treats an unterminated comment as a comment to the end of the file', () => {
    assert.deepEqual(checkCss('src/a.css', '/* @import "a.css";'), []);
  });

  it('words each finding as written in CONTRIBUTING.md', () => {
    assert.equal(
      checkCss('src/a.css', '@import "a.css";')[0]?.message,
      '@import is forbidden: the CSP allows own files only',
    );
    assert.equal(
      checkCss('src/a.css', 'a{background:url(//x.test/a.png)}')[0]?.message,
      'remote url() is forbidden',
    );
  });
});

describe('checkSvg', () => {
  const NS = 'xmlns="http://www.w3.org/2000/svg"';

  it('accepts a plain icon, with its namespace declaration', () => {
    assert.deepEqual(
      checkSvg('src/a.svg', `<svg ${NS} viewBox="0 0 1 1"><path d="M0 0" fill="none"/></svg>`),
      [],
    );
  });

  it('flags scripts, foreign content, styles, handlers and javascript: URLs', () => {
    const bad = [
      '<svg><script>x()</script></svg>',
      '<svg><foreignObject><p/></foreignObject></svg>',
      '<svg><style>a{}</style></svg>',
      '<svg onload="x()"></svg>',
      '<svg><a href="javascript:x()"><rect/></a></svg>',
      '<!DOCTYPE svg [<!ENTITY x "y">]><svg/>',
    ];
    for (const source of bad) assert.ok(checkSvg('src/a.svg', source).length > 0, source);
  });

  it('flags a reference to another file or a remote URL, and allows #id', () => {
    assert.equal(checkSvg('src/a.svg', '<svg><use href="#a"/></svg>').length, 0);
    assert.equal(checkSvg('src/a.svg', '<svg><use href="b.svg#a"/></svg>').length, 1);
    assert.equal(checkSvg('src/a.svg', '<svg><image xlink:href="//x.test/a.png"/></svg>').length, 1);
    assert.equal(checkSvg('src/a.svg', '<svg><rect fill="url(https://x.test/a)"/></svg>').length, 1);
  });

  it('ignores commented-out code and reports the line', () => {
    assert.deepEqual(checkSvg('src/a.svg', '<svg><!-- <script>x()</script> --></svg>'), []);
    assert.equal(checkSvg('src/a.svg', '<svg>\n\n<script/></svg>')[0]?.line, 3);
  });
});

describe('checkPackagedFileTypes', () => {
  it('passes the scanned types and fails the rest', () => {
    assert.deepEqual(checkPackagedFileTypes(['src/a.js', 'src/b.MJS', 'src/c.svg', 'src/d.css']), []);
    const found = checkPackagedFileTypes(['src/a.js', 'src/.DS_Store', 'src/b.json', 'src/c.wasm']);
    assert.deepEqual(
      found.map((f) => f.file),
      ['src/.DS_Store', 'src/b.json', 'src/c.wasm'],
    );
    assert.match(found[1]?.message ?? '', /does not scan it/);
  });

  it('leaves declaration files out of the package', () => {
    assert.equal(isPackagedSourceFile('src/a.d.ts'), false);
    assert.equal(isPackagedSourceFile('src/a.ts'), true);
    assert.equal(isPackagedSourceFile('src/a.js'), true);
  });
});
