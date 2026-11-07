// @ts-check
/**
 * Policy checks for the extension. Pure functions: they take file text and return findings, so
 * they run in unit tests without a file system. scripts/check-policy.mjs reads the files.
 * The rules are listed in CONTRIBUTING.md ("Security rules").
 *
 * Limits: this is a regex lint that catches mistakes and plain misuse, not a sandbox. Computed
 * names, aliases and string tricks get past it, so code review stays the control for hostile code.
 */

import { extname } from 'node:path';

/**
 * @typedef {object} Finding
 * @property {string} file Path relative to the repository root, with forward slashes.
 * @property {number} line 1-based line number.
 * @property {string} message
 */

/**
 * @typedef {object} Baseline Reviewed manifest values (scripts/permissions-baseline.json).
 * @property {string[]} permissions Sorted.
 * @property {string} csp The exact `content_security_policy.extension_pages` string.
 */

/** @typedef {Record<string, any>} JsonObject Parsed JSON. The checks verify its shape. */

export const MANIFEST_FILE = 'manifest.json';

/** File types under src/ that the policy scans. The package may ship no other type from src/. */
export const SCANNED_EXTENSIONS = Object.freeze(['.js', '.mjs', '.html', '.css', '.svg']);

/** The only value of `incognito` that keeps captures out of private windows. */
const REQUIRED_INCOGNITO = 'not_allowed';

/**
 * Top-level manifest keys that must not exist. Each one adds a way in or a surface that no review
 * has covered: host access, pages that web pages can reach, other code entry points, a fixed
 * extension ID (`key`), or UI that replaces browser pages.
 */
const FORBIDDEN_MANIFEST_KEYS = Object.freeze([
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
  'sidebar_action', // The name of the side panel in Firefox and Opera.
  'declarative_net_request',
]);

const CREATE_DOM_HINT = 'build DOM with createElement and textContent';
const NO_NETWORK_HINT = 'the extension makes no network requests';

/**
 * Checked against JS with comments removed. Every pattern needs the `g` flag.
 * @type {ReadonlyArray<{ pattern: RegExp, message: string }>}
 */
const JS_RULES = [
  { pattern: /\beval\s*\(/g, message: 'eval() is forbidden' },
  {
    pattern: /\bnew\s+Function\b|\bFunction\s*\(/g,
    message: 'the Function constructor is forbidden',
  },
  {
    pattern: /\b(?:setTimeout|setInterval)\s*\(\s*['"`]/g,
    message: 'a string argument to setTimeout or setInterval is forbidden',
  },
  {
    pattern: /\b(?:innerHTML|outerHTML)\b/g,
    message: `innerHTML and outerHTML are forbidden: ${CREATE_DOM_HINT}`,
  },
  {
    pattern: /\binsertAdjacentHTML\b/g,
    message: `insertAdjacentHTML is forbidden: ${CREATE_DOM_HINT}`,
  },
  { pattern: /\bdocument\s*\.\s*write(?:ln)?\b/g, message: 'document.write is forbidden' },
  { pattern: /\bfetch\s*\(/g, message: `fetch() is forbidden: ${NO_NETWORK_HINT}` },
  {
    pattern: /\b(?:XMLHttpRequest|WebSocket|EventSource|sendBeacon)\b/g,
    message: `network API is forbidden: ${NO_NETWORK_HINT}`,
  },
  { pattern: /\bimportScripts\b/g, message: 'importScripts is forbidden: no dynamic code loading' },
  {
    // The end-to-end build adds these in its own copy (e2e/build-extension.mjs). Production code
    // must not have a hook that returns capture data or starts a capture.
    pattern: /\b(?:spoolDebug|__spoolTest)\b/g,
    message: 'test hooks are forbidden in src/: only e2e/build-extension.mjs adds them to its copy',
  },
  {
    // `obj.import(x)` is a method call, not the keyword, so a `.` before the word is skipped.
    pattern: /(?<![.\w$])import\s*\(/g,
    message: 'dynamic import() is forbidden: no dynamic code loading, use static imports',
  },
];

/**
 * Code that may not listen for runtime messages. The service worker broadcasts each full frame
 * with `runtime.sendMessage`, and every extension page that has an `onMessage` listener receives
 * it, also the area outside the selection. Only the service worker and the offscreen document
 * may listen.
 */
const NO_MESSAGE_LISTENER_DIRS = Object.freeze(['src/result/', 'src/options/']);

/**
 * `runtime.onMessage` (also `?.`, spaces and line breaks), and a bare `onMessage` name, for
 * example `const { onMessage } = chrome.runtime` or `runtime['onMessage']`. `port.onMessage` is
 * not a runtime message listener, so it stays allowed. Needs the `g` flag.
 */
const MESSAGE_LISTENER_PATTERN =
  /\bruntime\s*(?:\?\.|\.)\s*onMessage(?:External)?\b|(?<![.\w$])onMessage(?:External)?\b/g;
const MESSAGE_LISTENER_MESSAGE =
  'runtime.onMessage is forbidden in the result and options pages: only the service worker ' +
  'and the offscreen document may listen (full frames are broadcast with runtime.sendMessage)';

/**
 * APIs that only some places may use. A file or folder in `allowed` may use the API. A path that
 * ends in `/` is a folder, any other path is one file. An empty list means that no file may.
 * Every pattern needs the `g` flag. The files are scanned with comments removed.
 *
 * The rules keep image data out of storage (CONTRIBUTING.md): the only storage is the directory
 * handle of the chosen save folder in IndexedDB, and the user's own save. They also keep the
 * folder picker and the permission prompt in pages that have a user click, and the synthetic
 * paste of the shelf in the page scripts.
 * @type {ReadonlyArray<{ pattern: RegExp, allowed: readonly string[], message: string }>}
 */
const RESTRICTED_APIS = [
  {
    pattern: /\b(?:indexedDB|webkitIndexedDB|IDBFactory)\b/g,
    allowed: ['src/ui/folder-store.js'],
    message:
      'IndexedDB is allowed only in src/ui/folder-store.js (the folder handle, never image data)',
  },
  {
    pattern: /\b(?:localStorage|sessionStorage|openDatabase|CacheStorage)\b|\bcaches\s*\./g,
    allowed: [],
    message: 'web storage and Cache Storage are forbidden: image data is never stored',
  },
  {
    pattern: /\bgetDirectory\s*\(/g,
    allowed: [],
    message: 'the origin private file system is forbidden: image data is never stored',
  },
  {
    pattern: /\b(?:showDirectoryPicker|showSaveFilePicker|showOpenFilePicker)\b/g,
    allowed: ['src/options/', 'src/ui/'],
    message: 'file pickers are allowed only in src/options/ and src/ui/ (they need a user click)',
  },
  {
    pattern: /\brequestPermission\b/g,
    allowed: ['src/options/', 'src/result/', 'src/ui/'],
    message:
      'requestPermission is allowed only in src/options/, src/result/ and src/ui/ (it needs a ' +
      'click on an extension page)',
  },
  {
    pattern: /\bclipboard\s*(?:\?\.|\.)\s*read(?:Text)?\b/g,
    allowed: [],
    message: 'reading the clipboard is forbidden: Spool only writes it',
  },
  {
    pattern: /\bnew\s+(?:ClipboardEvent|DragEvent)\b/g,
    allowed: ['src/page/'],
    message: 'synthetic paste and drop events are allowed only in src/page/ (the shelf)',
  },
];

/** `return /x/` and similar: a `/` after one of these words starts a regex literal. */
const REGEX_KEYWORDS = new Set([
  'return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'void', 'yield', 'await', 'delete',
  'instanceof', 'throw', 'new',
]);
/** A `/` after one of these characters starts a regex literal. Otherwise it divides. */
const REGEX_PREFIX_CHARS = '(,=:[!&|?{};+-*%<>~^';
/**
 * `if (a) /x/.test(s)`: the `)` that closes the head of one of these statements ends a condition,
 * not a value, so a `/` after it starts a regex literal. A `)` that closes a call or a group
 * (`f(a) / 2`, `(a + b) / 2`) is the end of a value, and the `/` after it divides.
 */
const CONTROL_KEYWORDS = new Set(['if', 'while', 'for', 'with']);

/** @param {string} text @returns {string} The text with every character but line breaks blanked. */
function blank(text) {
  return text.replace(/[^\n\r]/g, ' ');
}

/** @param {string} char @returns {boolean} */
function isIdentifierChar(char) {
  return /[\w$]/.test(char);
}

/** @param {string} text @param {number} index @returns {number} 1-based line of `index`. */
function lineAt(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * @param {string} file
 * @param {string} text
 * @param {RegExp} pattern Needs the `g` flag.
 * @param {string} message
 * @returns {Finding[]}
 */
function findMatches(file, text, pattern, message) {
  return [...text.matchAll(pattern)].map((match) => ({
    file,
    line: lineAt(text, match.index),
    message,
  }));
}

/** @param {string} source @param {number} from @returns {number} Index of the next line break. */
function lineEndIndex(source, from) {
  const lineBreak = /[\n\r]/g;
  lineBreak.lastIndex = from;
  const match = lineBreak.exec(source);
  return match ? match.index : source.length;
}

/**
 * @param {string} source
 * @param {number} start Index of the opening quote.
 * @returns {number} Index after the closing quote. An unterminated string ends at the line end.
 */
function quotedEnd(source, start) {
  const quote = source[start];
  let i = start + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') i += 2;
    else if (char === quote) return i + 1;
    else if (char === '\n' || char === '\r') return i;
    else i++;
  }
  return source.length;
}

/**
 * @param {string} source
 * @param {number} start Index of the opening `/`.
 * @returns {number} Index after the closing `/` and flags, or -1 when the line has no closing `/`
 *   (then the `/` was a division after all).
 */
function regexEnd(source, start) {
  let inClass = false;
  let i = start + 1;
  while (i < source.length) {
    const char = source[i];
    if (char === '\n' || char === '\r') return -1;
    if (char === '\\') i += 2;
    else if (char === '/' && !inClass) {
      i++;
      while (i < source.length && /[a-z]/i.test(source[i] ?? '')) i++;
      return i;
    } else {
      if (char === '[') inClass = true;
      else if (char === ']') inClass = false;
      i++;
    }
  }
  return -1;
}

/**
 * @param {string} source
 * @param {number} start First character after the opening backtick or after the `}` that
 *   closes a `${...}`.
 * @returns {{ end: number, opensExpr: boolean }} `end` is after the closing backtick or after
 *   the next `${`.
 */
function templateTextEnd(source, start) {
  let i = start;
  while (i < source.length) {
    const char = source[i];
    if (char === '\\') i += 2;
    else if (char === '`') return { end: i + 1, opensExpr: false };
    else if (char === '$' && source[i + 1] === '{') return { end: i + 2, opensExpr: true };
    else i++;
  }
  return { end: source.length, opensExpr: false };
}

/**
 * The word that ends `code` (white space at the end is skipped), or '' when it ends in another
 * character. A word after a dot (`x.if`) is a property name, not a keyword: it gives ''.
 * @param {string} code
 * @returns {string}
 */
function lastWord(code) {
  let end = code.length;
  while (end > 0 && /\s/.test(code[end - 1] ?? '')) end--;
  let start = end;
  while (start > 0 && isIdentifierChar(code[start - 1] ?? '')) start--;
  if (start === end) return '';
  let before = start;
  while (before > 0 && /\s/.test(code[before - 1] ?? '')) before--;
  return code[before - 1] === '.' ? '' : code.slice(start, end);
}

/**
 * Guesses whether a `/` that follows `code` starts a regex literal (true) or divides (false).
 * @param {string} code Output so far.
 * @param {number} controlCloseAt Index in `code` just after the last `)` that closed the head of
 *   an `if`, `while`, `for` or `with` (-1 when there is none).
 * @returns {boolean}
 */
function startsRegex(code, controlCloseAt) {
  let end = code.length;
  while (end > 0 && /\s/.test(code[end - 1] ?? '')) end--;
  const previous = code[end - 1];
  if (previous === undefined || REGEX_PREFIX_CHARS.includes(previous)) return true;
  if (previous === ')') return end === controlCloseAt;
  if (!isIdentifierChar(previous)) return false;
  return REGEX_KEYWORDS.has(lastWord(code));
}

/**
 * Replaces JS comments with spaces. Line breaks stay, so line numbers do not change. Strings,
 * template literals (also nested `${}`) and regex literals keep their text, and `//` or `/*`
 * inside them do not start a comment. Regex literals are found by a heuristic, and an unusual
 * one can be read as code. A `/` after the `)` of `if`, `while`, `for` and `with` starts a regex
 * (the lexer pairs each `)` with its `(`). A string that has no closing quote ends at the line end.
 * @param {string} source
 * @returns {string}
 */
export function stripComments(source) {
  let out = '';
  let i = 0;
  /** @type {number[]} One entry per open `${`: the count of its unclosed `{`. */
  const exprBraces = [];
  /** @type {boolean[]} One entry per open `(`: it follows `if`, `while`, `for` or `with`. */
  const parens = [];
  /** Index in `out` just after the last `)` that closed such a head. */
  let controlCloseAt = -1;

  /** @param {number} end Copies source[i, end) unchanged. */
  const copyTo = (end) => {
    out += source.slice(i, end);
    i = end;
  };
  /** Copies one template part. source[i] is the opening backtick or the `}` that ends a `${`. */
  const copyTemplatePart = () => {
    const { end, opensExpr } = templateTextEnd(source, i + 1);
    copyTo(end);
    if (opensExpr) exprBraces.push(0);
  };

  while (i < source.length) {
    const char = source[i];
    const next = source[i + 1];
    const open = exprBraces.length - 1;
    if (char === '/' && next === '/') {
      const end = lineEndIndex(source, i);
      out += blank(source.slice(i, end));
      i = end;
    } else if (char === '/' && next === '*') {
      const close = source.indexOf('*/', i + 2);
      const end = close === -1 ? source.length : close + 2;
      out += blank(source.slice(i, end));
      i = end;
    } else if (char === '"' || char === "'") {
      copyTo(quotedEnd(source, i));
    } else if (char === '`') {
      copyTemplatePart();
    } else if (char === '/' && startsRegex(out, controlCloseAt)) {
      const end = regexEnd(source, i);
      copyTo(end === -1 ? i + 1 : end);
    } else if (char === '(') {
      parens.push(CONTROL_KEYWORDS.has(lastWord(out)));
      copyTo(i + 1);
    } else if (char === ')') {
      const control = parens.pop() === true;
      copyTo(i + 1);
      if (control) controlCloseAt = out.length;
    } else if (char === '{' && open >= 0) {
      exprBraces[open]++;
      copyTo(i + 1);
    } else if (char === '}' && open >= 0 && exprBraces[open] === 0) {
      exprBraces.pop();
      copyTemplatePart();
    } else if (char === '}' && open >= 0) {
      exprBraces[open]--;
      copyTo(i + 1);
    } else {
      copyTo(i + 1);
    }
  }
  return out;
}

/**
 * @param {string} file
 * @param {string} source
 * @returns {Finding[]} A finding when the first line is not `// @ts-check`.
 */
export function checkTsCheckHeader(file, source) {
  const firstLine = source.replace(/^﻿/, '').split(/\r?\n/, 1)[0];
  return firstLine === '// @ts-check'
    ? []
    : [{ file, line: 1, message: 'the first line must be "// @ts-check"' }];
}

/**
 * Forbidden APIs in JS code. Comments are ignored, strings are not. Files in the result and
 * options folders also may not listen for runtime messages (NO_MESSAGE_LISTENER_DIRS), and some
 * APIs are allowed in some places only (RESTRICTED_APIS).
 * @param {string} file Path relative to the repository root, with forward slashes.
 * @param {string} source
 * @returns {Finding[]}
 */
export function checkJs(file, source) {
  const code = stripComments(source);
  const findings = JS_RULES.flatMap(({ pattern, message }) =>
    findMatches(file, code, pattern, message),
  );
  const path = file.replaceAll('\\', '/');
  if (NO_MESSAGE_LISTENER_DIRS.some((dir) => path.startsWith(dir))) {
    findings.push(...findMatches(file, code, MESSAGE_LISTENER_PATTERN, MESSAGE_LISTENER_MESSAGE));
  }
  for (const { pattern, allowed, message } of RESTRICTED_APIS) {
    const isAllowed = allowed.some((place) =>
      place.endsWith('/') ? path.startsWith(place) : path === place,
    );
    if (!isAllowed) findings.push(...findMatches(file, code, pattern, message));
  }
  return findings;
}

/**
 * `http://` or `https://` anywhere, comments and strings included.
 * @param {string} file
 * @param {string} source
 * @returns {Finding[]}
 */
export function checkRemoteUrls(file, source) {
  return findMatches(
    file,
    source,
    /https?:\/\//gi,
    `http(s):// URLs are forbidden: ${NO_NETWORK_HINT}`,
  );
}

/**
 * Inline code, event handlers, `javascript:` URLs and non-module scripts in HTML.
 * The extension pages CSP blocks them, and this check finds them before the browser does.
 * HTML comments are ignored. Character references in attribute values are not decoded.
 * @param {string} file
 * @param {string} source
 * @returns {Finding[]}
 */
export function checkHtml(file, source) {
  const html = source.replace(/<!--[\s\S]*?(?:-->|$)/g, blank);
  // A tag name, then attributes. Quoted values may contain `>`.
  const tags = html.matchAll(/<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g);
  /** @type {Finding[]} */
  const findings = [];
  for (const tag of tags) {
    const name = (tag[1] ?? '').toLowerCase();
    const attributes = parseAttributes(tag[2] ?? '');
    const line = lineAt(html, tag.index);
    /** @param {string} message */
    const add = (message) => findings.push({ file, line, message });

    if (name === 'script') {
      if (!attributes.has('src')) add('inline <script> is forbidden: use a module file');
      if ((attributes.get('type') ?? '').trim().toLowerCase() !== 'module') {
        add('<script> must have type="module"');
      }
    }
    if (name === 'style') add('<style> is forbidden: use a stylesheet file');
    for (const [attribute, value] of attributes) {
      if (attribute === 'style') add('style="..." attribute is forbidden: use a stylesheet file');
      if (/^on[a-z]/.test(attribute)) add(`${attribute}="..." handler is forbidden`);
      // Browsers ignore tabs, line breaks and spaces inside the scheme.
      if (/^javascript:/i.test(value.replace(/[\u0000- ]/g, ''))) {
        add('javascript: URLs are forbidden');
      }
    }
  }
  return findings;
}

/**
 * @param {string} text The part of a tag after its name.
 * @returns {Map<string, string>} Attribute values by lower-case name. The first one wins.
 */
function parseAttributes(text) {
  const attributes = new Map();
  const pattern = /([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  for (const match of text.matchAll(pattern)) {
    const name = (match[1] ?? '').toLowerCase();
    if (!attributes.has(name)) attributes.set(name, match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attributes;
}

/**
 * `@import` and remote `url()` in CSS. CSS comments are ignored.
 * @param {string} file
 * @param {string} source
 * @returns {Finding[]}
 */
export function checkCss(file, source) {
  const css = source.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, blank);
  return [
    ...findMatches(file, css, /@import\b/gi, '@import is forbidden: the CSP allows own files only'),
    // Also protocol-relative URLs (//host), which the generic http(s):// rule does not see.
    ...findMatches(file, css, /url\(\s*["']?\s*(?:https?:)?\/\//gi, 'remote url() is forbidden'),
  ];
}

/**
 * Scripts, foreign content, handlers, `javascript:` URLs and references to other files in SVG.
 * The xmlns declarations are namespace names, not requests, so they are ignored.
 * @param {string} file
 * @param {string} source
 * @returns {Finding[]}
 */
export function checkSvg(file, source) {
  const svg = source
    .replace(/<!--[\s\S]*?(?:-->|$)/g, blank)
    .replace(/\sxmlns(?::[\w-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/g, blank);
  /** @type {Finding[]} */
  const findings = [];
  const tags = svg.matchAll(/<([a-zA-Z][^\s/>]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g);
  for (const tag of tags) {
    const name = (tag[1] ?? '').toLowerCase();
    const attributes = parseAttributes(tag[2] ?? '');
    const line = lineAt(svg, tag.index);
    /** @param {string} message */
    const add = (message) => findings.push({ file, line, message });
    if (name === 'script') add('<script> is forbidden in SVG');
    if (name === 'foreignobject') add('<foreignObject> is forbidden in SVG');
    if (name === 'style') add('<style> is forbidden in SVG: use attributes or a stylesheet file');
    for (const [attribute, value] of attributes) {
      if (/^on[a-z]/.test(attribute)) add(`${attribute}="..." handler is forbidden`);
      // Browsers ignore tabs, line breaks and spaces inside the scheme.
      if (/^javascript:/i.test(value.replace(/[\u0000- ]/g, ''))) {
        add('javascript: URLs are forbidden');
      }
      if (/^(?:xlink:)?href$/.test(attribute) && !value.trim().startsWith('#')) {
        add(`${attribute} may point only inside the file (#id) in SVG`);
      }
    }
  }
  findings.push(...findMatches(file, svg, /<!ENTITY\b/gi, 'XML entity declarations are forbidden'));
  findings.push(...checkRemoteUrls(file, svg));
  return findings;
}

/**
 * Fails for every file that the package would ship from src/ and that no rule scans, so a file
 * cannot reach the zip unchecked (a `.json`, a `.wasm`, or a stray `.DS_Store`).
 * @param {string[]} files Paths relative to the repository root, with forward slashes. The files
 *   under src/ that go into the zip (declaration files do not).
 * @returns {Finding[]}
 */
export function checkPackagedFileTypes(files) {
  return files
    .filter((file) => !SCANNED_EXTENSIONS.includes(extname(file).toLowerCase()))
    .map((file) => ({
      file,
      line: 1,
      message:
        `the package would ship this file type, but the policy does not scan it: remove the ` +
        `file, or add a scanner for ${extname(file) || 'files without an extension'}`,
    }));
}

/**
 * Whether the package ships a file of src/. Declaration files are only for the type check.
 * @param {string} file Path relative to the repository root, with forward slashes.
 * @returns {boolean}
 */
export function isPackagedSourceFile(file) {
  return !file.endsWith('.d.ts');
}

/**
 * Runs every rule that applies to one file under src/.
 * @param {string} file Path relative to the repository root, with forward slashes.
 * @param {string} source
 * @returns {Finding[]} Empty for file types that are not scanned.
 */
export function checkSourceFile(file, source) {
  switch (extname(file).toLowerCase()) {
    case '.js':
    case '.mjs':
      return [
        ...checkTsCheckHeader(file, source),
        ...checkJs(file, source),
        ...checkRemoteUrls(file, source),
      ];
    case '.html':
      return [...checkHtml(file, source), ...checkRemoteUrls(file, source)];
    case '.css':
      return [...checkCss(file, source), ...checkRemoteUrls(file, source)];
    case '.svg':
      return checkSvg(file, source);
    default:
      return [];
  }
}

/**
 * Extension-relative paths that the manifest points to (icons, service worker, pages).
 * @param {JsonObject} manifest
 * @returns {string[]} Without duplicates, in manifest order.
 */
export function manifestReferencedFiles(manifest) {
  /** @param {unknown} icons A path, or an object whose values are paths. @returns {unknown[]} */
  const iconPaths = (icons) => {
    if (typeof icons === 'string') return [icons];
    return icons !== null && typeof icons === 'object' ? Object.values(icons) : [];
  };
  const references = [
    ...iconPaths(manifest.icons),
    ...iconPaths(manifest.action?.default_icon),
    manifest.action?.default_popup,
    manifest.background?.service_worker,
    manifest.options_ui?.page,
    manifest.options_page,
  ];
  const paths = references.filter((path) => typeof path === 'string' && path !== '');
  return [...new Set(paths)];
}

/**
 * Compares the manifest with the reviewed baseline and the rules for the manifest.
 * @param {JsonObject} manifest
 * @param {Baseline} baseline
 * @param {(path: string) => boolean} exists Tells whether an extension-relative file exists.
 * @returns {Finding[]}
 */
export function checkManifest(manifest, baseline, exists) {
  /** @type {Finding[]} */
  const findings = [];
  /** @param {string} message */
  const add = (message) => findings.push({ file: MANIFEST_FILE, line: 1, message });

  if (manifest.manifest_version !== 3) add('manifest_version must be 3');
  if (manifest.background?.type !== 'module') add('background.type must be "module"');
  if (isObject(manifest.background) && Object.hasOwn(manifest.background, 'scripts')) {
    add('"background.scripts" is forbidden: the only background code is "service_worker"');
  }
  if (manifest.incognito !== REQUIRED_INCOGNITO) {
    add(`"incognito" must be "${REQUIRED_INCOGNITO}": captures must not run in private windows`);
  }

  const permissions = toStrings(manifest.permissions).sort();
  const reviewed = toStrings(baseline.permissions);
  if (permissions.join('\n') !== reviewed.join('\n')) {
    add(
      `permissions must equal the baseline [${reviewed.join(', ')}] but are ` +
        `[${permissions.join(', ')}]. Change the baseline only after a security review.`,
    );
  }
  if (manifest.content_security_policy?.extension_pages !== baseline.csp) {
    add('content_security_policy.extension_pages must equal the baseline CSP');
  }
  for (const key of FORBIDDEN_MANIFEST_KEYS) {
    if (Object.hasOwn(manifest, key)) add(`"${key}" is forbidden`);
  }
  for (const path of manifestReferencedFiles(manifest)) {
    if (!exists(path)) add(`the file "${path}" is referenced but missing`);
  }
  return findings;
}

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isObject(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {unknown} value @returns {string[]} A copy, or an empty list for a non-array. */
function toStrings(value) {
  return Array.isArray(value) ? value.map(String) : [];
}

/**
 * @param {Finding} finding
 * @returns {string} `file:line: message`
 */
export function formatFinding({ file, line, message }) {
  return `${file}:${line}: ${message}`;
}
