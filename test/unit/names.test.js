// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  sanitizePathSegment,
  tileFileName,
} from '../../src/lib/names.js';

/** Shorthand: sanitize with room to spare and the fallback "FB". */
const clean = (/** @type {unknown} */ v, max = 100) => sanitizePathSegment(v, max, 'FB');

describe('sanitizePathSegment: input type', () => {
  it('returns the fallback for values that are not strings', () => {
    for (const v of [undefined, null, 5, true, {}, [], ['a'], Symbol.iterator, () => 'a']) {
      assert.equal(clean(v), 'FB', String(typeof v));
    }
  });

  it('keeps a plain name', () => {
    assert.equal(clean('Inbox - Mail'), 'Inbox - Mail');
    assert.equal(clean('report_v2 (final)'), 'report_v2 (final)');
    assert.equal(clean('a'), 'a');
  });
});

describe('sanitizePathSegment: forbidden characters', () => {
  it('replaces each Windows-forbidden character with a space', () => {
    for (const ch of ['<', '>', ':', '"', '/', '\\', '|', '?', '*']) {
      assert.equal(clean(`a${ch}b`), 'a b', JSON.stringify(ch));
    }
  });

  it('collapses runs of forbidden characters and spaces into one space', () => {
    assert.equal(clean('a<>:"/\\|?*b'), 'a b');
    assert.equal(clean('a / b'), 'a b');
    assert.equal(clean('a   b'), 'a b');
  });

  it('replaces control characters, including tab, newline and DEL', () => {
    assert.equal(clean('a\tb\nc\rd'), 'a b c d');
    assert.equal(clean('a\u0000b'), 'a b');
    assert.equal(clean('a\u001fb'), 'a b');
    assert.equal(clean('a\u007fb'), 'a b');
    assert.equal(clean('\u0000\u0001\u0002'), 'FB');
  });

  it('treats other white space (no-break space, line separator) as a space', () => {
    assert.equal(clean('a\u00a0b'), 'a b');
    assert.equal(clean('a\u2028b'), 'a b');
    assert.equal(clean('a\u3000b'), 'a b');
  });

  it('returns the fallback when only forbidden characters remain', () => {
    assert.equal(clean('<>:"/\\|?*'), 'FB');
    assert.equal(clean('???'), 'FB');
  });

  it('never returns a string with a path separator', () => {
    const hostile = ['../../etc/passwd', '..\\..\\x', '/abs/path', 'C:\\x', 'a/../b', '\\\\srv\\x'];
    for (const v of hostile) {
      const out = clean(v);
      assert.ok(!/[/\\]/.test(out), `${v} -> ${out}`);
      assert.ok(!out.startsWith('.'), `${v} -> ${out}`);
    }
  });
});

describe('sanitizePathSegment: dots and spaces at the ends', () => {
  it('strips leading and trailing dots and spaces', () => {
    assert.equal(clean('  name  '), 'name');
    assert.equal(clean('...name'), 'name');
    assert.equal(clean('name...'), 'name');
    assert.equal(clean(' . name . '), 'name');
    assert.equal(clean('.hidden'), 'hidden');
  });

  it('keeps dots inside the name', () => {
    assert.equal(clean('a.b.c'), 'a.b.c');
    assert.equal(clean('v1.2 notes'), 'v1.2 notes');
  });

  it('returns the fallback for names made of dots and spaces', () => {
    for (const v of ['', ' ', '   ', '.', '..', '...', ' . . ', '. .']) {
      assert.equal(clean(v), 'FB', JSON.stringify(v));
    }
  });
});

describe('sanitizePathSegment: reserved Windows names', () => {
  it('refuses CON, PRN, AUX and NUL in any letter case', () => {
    for (const name of ['con', 'CON', 'Con', 'prn', 'PRN', 'aux', 'AUX', 'nul', 'NUL', 'NuL']) {
      assert.equal(clean(name), 'FB', name);
    }
  });

  it('refuses COM0 to COM9 and LPT0 to LPT9', () => {
    for (let i = 0; i <= 9; i += 1) {
      assert.equal(clean(`COM${i}`), 'FB', `COM${i}`);
      assert.equal(clean(`lpt${i}`), 'FB', `lpt${i}`);
    }
  });

  it('refuses a reserved name with an extension, because Windows ignores the extension', () => {
    for (const name of ['con.txt', 'NUL.tar.gz', 'aux.', 'com1.png', 'LPT3.log', 'prn.x.y.z']) {
      assert.equal(clean(name), 'FB', name);
    }
  });

  it('refuses a reserved name that only becomes reserved after trimming', () => {
    for (const name of ['CON ', ' nul', 'nul.', '  aux  ', '...com1...', 'con<', '/prn']) {
      assert.equal(clean(name), 'FB', JSON.stringify(name));
    }
  });

  it('refuses a name that is reserved after it is cut to the maximum length', () => {
    assert.equal(sanitizePathSegment('console', 3, 'FB'), 'FB');
    assert.equal(sanitizePathSegment('nullable', 3, 'FB'), 'FB');
    assert.equal(sanitizePathSegment('com12345', 4, 'FB'), 'FB');
  });

  it('keeps names that only look similar', () => {
    const similar = ['console', 'COM10', 'com', 'LPT10', 'nullable', 'auxiliary', 'prn1', 'my con'];
    for (const name of similar) {
      assert.equal(clean(name), name, name);
    }
    assert.equal(clean('Con .txt'), 'Con .txt'); // "Con " is not a reserved name
    assert.equal(clean('xcon.txt'), 'xcon.txt');
  });

  // Regression: Windows also reserves COM¹-³ and LPT¹-³ (superscript digits).
  it(
    'refuses COM¹, LPT² and the other superscript device names',
    () => {
      const names = ['COM\u00b9', 'COM\u00b2', 'COM\u00b3', 'LPT\u00b9', 'LPT\u00b2', 'LPT\u00b3'];
      for (const name of names) {
        assert.equal(clean(name), 'FB', name);
      }
    },
  );
});

describe('sanitizePathSegment: length', () => {
  it('cuts to the maximum length', () => {
    assert.equal(sanitizePathSegment('abcdef', 3, 'FB'), 'abc');
    assert.equal(sanitizePathSegment('abcdef', 6, 'FB'), 'abcdef');
    assert.equal(sanitizePathSegment('abcdef', 100, 'FB'), 'abcdef');
    assert.equal(sanitizePathSegment('x'.repeat(100), 48, 'FB'), 'x'.repeat(48));
  });

  it('trims a space or a dot that the cut leaves at the end', () => {
    assert.equal(sanitizePathSegment('ab cd', 3, 'FB'), 'ab');
    assert.equal(sanitizePathSegment('ab.cd', 3, 'FB'), 'ab');
    assert.equal(sanitizePathSegment('ab...cd', 4, 'FB'), 'ab');
  });

  it('returns the fallback for a maximum length of 0, a negative one or NaN', () => {
    assert.equal(sanitizePathSegment('abc', 0, 'FB'), 'FB');
    assert.equal(sanitizePathSegment('abc', -5, 'FB'), 'FB');
    assert.equal(sanitizePathSegment('abc', NaN, 'FB'), 'FB');
  });

  it('counts the cut after the forbidden characters were replaced', () => {
    assert.equal(sanitizePathSegment('<<<<abcdef', 3, 'FB'), 'abc');
  });

  // Regression: the cut must count code points, so an emoji at the limit is not split.
  it(
    'does not cut a surrogate pair in half',
    () => {
      const out = sanitizePathSegment(`${'a'.repeat(47)}\u{1F600}`, 48, 'FB');
      const loneHigh = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/;
      const loneLow = /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
      assert.ok(!loneHigh.test(out) && !loneLow.test(out), JSON.stringify(out));
    },
  );
});

describe('sanitizePathSegment: Unicode', () => {
  it('normalizes to NFC', () => {
    const out = clean('Cafe\u0301');
    assert.equal(out, 'Caf\u00e9');
    assert.equal(out.length, 4);
    assert.equal(clean('\u212b'), '\u00c5', 'ANGSTROM SIGN becomes A with ring');
  });

  it('keeps letters of other scripts and emoji', () => {
    assert.equal(clean('Ünïcödé'), 'Ünïcödé');
    assert.equal(clean('スクリーン'), 'スクリーン');
    assert.equal(clean('Привет мир'), 'Привет мир');
    assert.equal(clean('דף'), 'דף');
    assert.equal(clean('a \u{1F600} b'), 'a \u{1F600} b');
  });

  it('does not treat full-width look-alikes as forbidden characters', () => {
    assert.equal(clean('a\uff1ab'), 'a\uff1ab');
    assert.equal(clean('a\uff0fb'), 'a\uff0fb');
  });

  it('does not decode escapes or URL encoding', () => {
    assert.equal(clean('a%2Fb'), 'a%2Fb');
    assert.equal(clean('%2e%2e'), '%2e%2e');
  });
});

// Regression: Chromium refuses a download path that has `~`, a Cc or a Cf character, or a
// shell-integrated or dangerous final extension. One such page title made every save fail.
describe('sanitizePathSegment: control and format characters', () => {
  it('replaces C1 control characters with a space, like the C0 ones', () => {
    assert.equal(clean('a\u0085b'), 'a b'); // NEXT LINE
    assert.equal(clean('a\u0080b'), 'a b');
    assert.equal(clean('a\u009fb'), 'a b');
    assert.equal(clean('\u0085\u0090'), 'FB');
  });

  it('removes format characters without a space', () => {
    const removed = [
      ['soft hyphen', '\u{ad}'],
      ['zero-width space', '\u{200b}'],
      ['zero-width non-joiner', '\u{200c}'],
      ['zero-width joiner', '\u{200d}'],
      ['left-to-right mark', '\u{200e}'],
      ['right-to-left mark', '\u{200f}'],
      ['left-to-right embedding', '\u{202a}'],
      ['right-to-left embedding', '\u{202b}'],
      ['pop directional formatting', '\u{202c}'],
      ['left-to-right override', '\u{202d}'],
      ['right-to-left override', '\u{202e}'],
      ['word joiner', '\u{2060}'],
      ['invisible times', '\u{2062}'],
      ['left-to-right isolate', '\u{2066}'],
      ['pop directional isolate', '\u{2069}'],
      ['arabic letter mark', '\u{61c}'],
      ['byte order mark', '\u{feff}'],
      ['tag latin small letter a', '\u{e0061}'],
      ['cancel tag', '\u{e007f}'],
    ];
    for (const [name, ch] of removed) {
      assert.equal(clean(`ab${ch}cd`), 'abcd', name);
      assert.equal(clean(`ab ${ch} cd`), 'ab cd', `${name} between spaces`);
      assert.equal(clean(`${ch}${ch}x${ch}`), 'x', `${name} at the ends`);
    }
  });

  it('returns the fallback when only control and format characters remain', () => {
    assert.equal(clean('\u{200d}\u{200f}\u{202e}\u{ad}\u{feff}'), 'FB');
    assert.equal(clean('\u{200b} \u0085 \u{200b}'), 'FB');
  });

  it('does not leave a character of Cc or Cf in any result', () => {
    const hostile = [
      'a\u{200d}b',
      'Report\u{202e}txt.exe',
      'x\u0085y\u{2028}z',
      '\u{e0067}\u{e0062}\u{e007f}flag',
      'a\u{feff}b\u{ad}c',
    ];
    for (const v of hostile) {
      assert.doesNotMatch(clean(v), /[\p{Cc}\p{Cf}]/u, JSON.stringify(v));
    }
  });

  it('keeps an emoji sequence readable: the joiners go, the emoji stay', () => {
    // WOMAN + ZERO WIDTH JOINER + LAPTOP
    const joined = 'Team \u{1f469}\u{200d}\u{1f4bb} notes';
    assert.equal(clean(joined), 'Team \u{1f469}\u{1f4bb} notes');
    // Flag of England: black flag + tag letters + cancel tag.
    const england = '\u{1f3f4}\u{e0067}\u{e0062}\u{e0065}\u{e006e}\u{e0067}\u{e007f}';
    assert.equal(clean(england), '\u{1f3f4}');
  });

  it('keeps the letters of scripts that use joiners and marks', () => {
    // Hebrew with an RLM at the end.
    assert.equal(clean('\u{5d3}\u{5e3}\u{200f}'), '\u{5d3}\u{5e3}');
    const arabic = '\u{645}\u{631}\u{62d}\u{628}\u{627}';
    assert.equal(clean(arabic), arabic);
  });

  it('composes a letter and an accent that a joiner separated', () => {
    assert.equal(clean('e\u{200d}\u{301}'), '\u{e9}');
  });

  it('removes the format characters before it cuts to the maximum length', () => {
    assert.equal(sanitizePathSegment('a\u{200d}b\u{200d}c\u{200d}d', 3, 'FB'), 'abc');
  });

  it('does not let a format character hide a forbidden character or a reserved name', () => {
    assert.equal(clean('a\u{200b}/\u{200b}b'), 'a b');
    assert.equal(clean('C\u{200b}ON'), 'FB');
    assert.equal(clean('N\u{ad}UL.txt'), 'FB');
    assert.equal(clean('.\u{200b}.'), 'FB');
  });
});

describe('sanitizePathSegment: tilde', () => {
  it('replaces ~ with -', () => {
    assert.equal(clean('a~b'), 'a-b');
    assert.equal(clean('Pipeline ~ Q4 - CRM'), 'Pipeline - Q4 - CRM');
    assert.equal(clean('~~~'), '---');
    assert.equal(clean('PROGRA~1'), 'PROGRA-1');
    assert.equal(clean('~/x'), '- x');
  });

  it('has no ~ left, also for look-alikes that NFC does not change', () => {
    assert.ok(!clean('a~b~c').includes('~'));
    // FULLWIDTH TILDE and TILDE OPERATOR are other characters. Chromium accepts them.
    assert.equal(clean('a\u{ff5e}b'), 'a\u{ff5e}b');
    assert.equal(clean('a\u{223c}b'), 'a\u{223c}b');
  });
});

describe('sanitizePathSegment: dangerous final extension', () => {
  const dangerous = [
    'lnk', 'local', 'url', 'scf', 'exe', 'bat', 'cmd', 'com', 'ps1', 'vbs', 'js', 'msi',
  ];

  it('replaces the last dot with an underscore', () => {
    for (const ext of dangerous) {
      assert.equal(clean(`Report.${ext}`), `Report_${ext}`, ext);
      assert.equal(clean(`a b.${ext}`), `a b_${ext}`, ext);
    }
  });

  it('ignores the letter case and keeps it', () => {
    assert.equal(clean('Report.EXE'), 'Report_EXE');
    assert.equal(clean('x.Lnk'), 'x_Lnk');
    assert.equal(clean('x.LoCaL'), 'x_LoCaL');
  });

  it('changes only the last dot', () => {
    assert.equal(clean('a.b.exe'), 'a.b_exe');
    assert.equal(clean('v1.2.ps1'), 'v1.2_ps1');
    assert.equal(clean('a.exe.txt'), 'a.exe.txt');
    assert.equal(clean('a.txt.exe'), 'a.txt_exe');
  });

  it('works after the trim of dots and spaces', () => {
    assert.equal(clean('x.exe.'), 'x_exe');
    assert.equal(clean('x.exe...'), 'x_exe');
    assert.equal(clean('  x.lnk  '), 'x_lnk');
    assert.equal(clean('x. exe'), 'x_ exe');
  });

  it('works after the cut to the maximum length', () => {
    assert.equal(sanitizePathSegment('abc.exe.txt', 7, 'FB'), 'abc_exe');
    assert.equal(sanitizePathSegment('abc.exe.txt', 8, 'FB'), 'abc_exe'); // the dot is trimmed
    assert.equal(sanitizePathSegment('abc.exe.txt', 9, 'FB'), 'abc.exe.t');
  });

  it('works when a removed character hid the extension', () => {
    assert.equal(clean('x.\u{200b}exe'), 'x_exe');
    assert.equal(clean('x\u{202e}.lnk'), 'x_lnk');
    assert.equal(clean('x.l\u{ad}nk'), 'x_lnk');
  });

  it('also covers the shell folder extension .{...}', () => {
    const clsid = '{21EC2020-3AEA-1069-A2DD-08002B30309D}';
    assert.equal(clean(`x.${clsid}`), `x_${clsid}`);
    assert.equal(clean('x.{a}'), 'x_{a}');
    assert.equal(clean('a.{}'), 'a_{}');
    assert.equal(clean('a.{b'), 'a.{b');
    assert.equal(clean('a.b}'), 'a.b}');
  });

  it('keeps names with an extension that is not on the list', () => {
    const safe = [
      'photo.png', 'notes.txt', 'a.b.c', 'v1.2 notes', 'x.exe file', 'x.jsx', 'x.comic', 'x.cmdx',
      'x.js2', 'x.xjs', 'x.ex',
    ];
    for (const name of safe) {
      assert.equal(clean(name), name, name);
    }
  });

  it('keeps a word that only ends like an extension, without a dot', () => {
    for (const name of ['exe', 'my exe', 'lnk', 'index js', 'local']) {
      assert.equal(clean(name), name, name);
    }
  });

  it('keeps the reserved-name rule first: "con.exe" is still refused', () => {
    assert.equal(clean('con.exe'), 'FB');
    assert.equal(clean('NUL.lnk'), 'FB');
  });

  it('turns a page title such as "example.com" into a safe name', () => {
    assert.equal(clean('example.com'), 'example_com');
    assert.equal(clean('Inbox - example.com'), 'Inbox - example_com');
    assert.equal(clean('example.com - Inbox'), 'example.com - Inbox');
  });
});

describe('tileFileName', () => {
  it('numbers from 1 and pads to 2 digits', () => {
    assert.equal(tileFileName(0, 1), 'screenshot-01-of-01.png');
    assert.equal(tileFileName(2, 12), 'screenshot-03-of-12.png');
    assert.equal(tileFileName(8, 9), 'screenshot-09-of-09.png');
    assert.equal(tileFileName(9, 99), 'screenshot-10-of-99.png');
    assert.equal(tileFileName(98, 99), 'screenshot-99-of-99.png');
  });

  it('grows the width with the count', () => {
    assert.equal(tileFileName(99, 100), 'screenshot-100-of-100.png');
    assert.equal(tileFileName(0, 100), 'screenshot-001-of-100.png');
    assert.equal(tileFileName(0, 1000), 'screenshot-0001-of-1000.png');
    assert.equal(tileFileName(998, 1000), 'screenshot-0999-of-1000.png');
    assert.equal(tileFileName(0, 10_000), 'screenshot-00001-of-10000.png');
  });

  it('uses the same width for every tile of one capture, so files sort in order', () => {
    for (const count of [5, 12, 99, 100, 250, 1000]) {
      const names = Array.from({ length: count }, (_, i) => tileFileName(i, count));
      assert.deepEqual([...names].sort(), names, `count ${count}`);
      assert.equal(new Set(names).size, count);
      assert.equal(new Set(names.map((n) => n.length)).size, 1);
    }
  });

  it('always makes a safe .png name', () => {
    for (const [i, n] of [
      [0, 1],
      [4, 7],
      [11, 12],
      [123, 456],
    ]) {
      const name = tileFileName(/** @type {number} */ (i), /** @type {number} */ (n));
      assert.match(name, /^screenshot-\d+-of-\d+\.png$/);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// Added by mutation testing. Cases only: nothing above changed.
// ---------------------------------------------------------------------------------------------

describe('sanitizePathSegment: console device names', () => {
  it('refuses CONIN$ and CONOUT$ in any letter case, also with an extension', () => {
    const names = ['CONIN$', 'conout$', 'ConIn$', 'CONOUT$.txt', 'conin$.tar.gz', ' CONIN$ '];
    for (const name of names) {
      assert.equal(clean(name), 'FB', JSON.stringify(name));
    }
  });

  it('keeps names that only start like a console device name', () => {
    for (const name of ['conin', 'conout', 'CONIN$x', 'my CONIN$', 'CONOUT$ 1']) {
      assert.equal(clean(name), name, name);
    }
  });
});

describe('sanitizePathSegment: runs of white space', () => {
  it('collapses every run, not only the first one', () => {
    assert.equal(clean('a  b   c    d'), 'a b c d');
    assert.equal(clean('a		b  c'), 'a b c');
    assert.equal(clean('  a  b  '), 'a b');
    assert.equal(clean('x  y　　z'), 'x y z');
  });
});
