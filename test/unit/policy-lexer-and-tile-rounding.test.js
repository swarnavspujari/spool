// @ts-check
/**
 * Extra tests for two library defects that mutation testing found:
 *  1. scripts/lib/policy.mjs: a regex literal after `if (...)`, `while (...)`, `for (...)` and
 *     `with (...)` was read as a division, so a `//` inside it hid the rest of the line.
 *  2. src/lib/tiles.js: `Math.floor(tileHeightOut / scale)` lost one row at some widths.
 * The tests of the two modules (policy.test.js, tiles.test.js) hold the case that was reported.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { checkJs, stripComments } from '../../scripts/lib/policy.mjs';
import { TILE_OVERLAP_PX, TILE_TIERS } from '../../src/shared/constants.js';
import { planTiles, tileGeometry } from '../../src/lib/tiles.js';

/** Number of findings that `eval(` causes in `code`. @param {string} code */
const evalFindings = (code) => checkJs('src/a.js', code).filter((f) => /eval/.test(f.message)).length;

describe('policy: a slash after the closing ")" of a statement head starts a regex', () => {
  // The regex holds `//`. Read as a division, the lexer takes the rest of the line as a comment and
  // `eval(1)` stays hidden. Read as a regex, the code after it is visible.
  const REGEX = String.raw`/\/\//.test(s) || eval(1);`;

  it('after if, while, for and with', () => {
    for (const head of ['if (a)', 'while (a)', 'for (;;)', 'for (const x of y)', 'with (o)']) {
      assert.equal(evalFindings(`${head} ${REGEX}`), 1, head);
    }
  });

  it('after else if, and with no space or a line break', () => {
    assert.equal(evalFindings(`if (a) b(); else if (c) ${REGEX}`), 1);
    assert.equal(evalFindings(String.raw`if(a)/\/\//.test(s)||eval(1);`), 1);
    assert.equal(evalFindings(`if (a)\n${REGEX}`), 1);
    assert.equal(evalFindings(`if (a)\n\t  ${REGEX}`), 1);
  });

  it('with parentheses inside the head: calls, groups, strings and regexes', () => {
    assert.equal(evalFindings(`if (f(a) && (b || g(c))) ${REGEX}`), 1);
    assert.equal(evalFindings(`if (s === ')') ${REGEX}`), 1);
    assert.equal(evalFindings(`if (s === "(") ${REGEX}`), 1);
    assert.equal(evalFindings(`if (/\\)/.test(s)) ${REGEX}`), 1);
    assert.equal(evalFindings(`if (a /* ) */) ${REGEX}`), 1);
    assert.equal(evalFindings(`if (\`\${f(a)})\`) ${REGEX}`), 1);
  });

  it('after the head of a statement inside a block or a template expression', () => {
    assert.equal(evalFindings(`function f() { if (a) ${REGEX} }`), 1);
    assert.equal(evalFindings(`x = \`\${(() => { if (a) ${REGEX} })()}\`;`), 1);
  });

  it('a regex after the head can hold a quote or a slash in a class, and flags', () => {
    assert.equal(evalFindings(`if (a) /["']/g.test(s) || eval(1);`), 1);
    assert.equal(evalFindings(`if (a) /[/]\\//i.test(s) || eval(1);`), 1);
  });

  it('keeps a division after a call or a group a division (the comment after it is a comment)', () => {
    for (const code of [
      'x = f(a) / 2; // eval(1)',
      'x = (a + b) / 2 // eval(1)',
      'x = g(f(a)) / h(b) / 2; // eval(1)',
      'x = a[0](b) / 2 // eval(1)',
      'x = f(a)\n/ 2 // eval(1)',
    ]) {
      assert.equal(evalFindings(code), 0, code);
    }
  });

  it('keeps a division after the head of a call that is named like a statement', () => {
    // `x.if` and `o.while` are properties, `if_` and `iff` are other names.
    for (const code of ['x = o.if(a) / 2 // eval(1)', 'x = o.while(a) / 2 // eval(1)', 'x = iff(a) / 2 // eval(1)', 'x = if_(a) / 2 // eval(1)']) {
      assert.equal(evalFindings(code), 0, code);
    }
  });

  it('a division in the body after the head is still a division', () => {
    assert.equal(evalFindings('if (a) b = c / d; // eval(1)'), 0);
    assert.equal(evalFindings('while (i--) x = y / z // eval(1)'), 0);
  });

  it('does not throw for parentheses that do not match', () => {
    for (const code of ['a) /\\//.test(s) || eval(1)', 'if (a /\\//.test(s) || eval(1)', ')))', '((((', 'if (', 'if (a)', 'if (a) /']) {
      assert.doesNotThrow(() => stripComments(code), code);
    }
  });

  it('keeps the length and the line breaks of the text', () => {
    const code = `if (a) ${REGEX}\nwhile (b) /x/.test(c); // note\n`;
    const out = stripComments(code);
    assert.equal(out.length, code.length);
    assert.equal(out.split('\n').length, code.split('\n').length);
    assert.ok(out.includes('eval(1)'));
    assert.ok(!out.includes('note'));
  });
});

describe('tiles: the source tile is the largest one that fits (exact integer arithmetic)', () => {
  const TIERS = /** @type {const} */ (['high', 'standard']);

  it('equals floor(tileHeightOut * widthPx / maxLongEdgePx) in BigInt for every width up to 100,000', () => {
    for (const tier of TIERS) {
      const edge = BigInt(TILE_TIERS[tier].maxLongEdgePx);
      for (let width = 1; width <= 100_000; width += 1) {
        const { tileHeightSrc, tileHeightOut } = tileGeometry(width, tier);
        const expected = BigInt(width) > edge ? (BigInt(tileHeightOut) * BigInt(width)) / edge : BigInt(tileHeightOut);
        assert.equal(BigInt(tileHeightSrc), expected, `${tier} ${width}`);
      }
    }
  });

  it('width 3174 at the high tier gives 1794 rows (the width of the report), not 1793', () => {
    const geometry = tileGeometry(3174, 'high');
    assert.equal(geometry.outWidth, 2576);
    assert.equal(geometry.tileHeightOut, 1456); // 1456 * 3174 / 2576 = 1794 exactly
    assert.equal(geometry.tileHeightSrc, 1794);
    assert.equal(Math.floor(geometry.tileHeightOut / geometry.scale), 1793, 'the old formula');
  });

  it('is never below the old value, and below the next row it would not fit', () => {
    for (const tier of TIERS) {
      const edge = TILE_TIERS[tier].maxLongEdgePx;
      for (let width = edge + 1; width <= 12_000; width += 1) {
        const { tileHeightSrc, tileHeightOut } = tileGeometry(width, tier);
        // One row more would not fit: (src + 1) * edge > out * width. And src fits: src * edge <= out * width.
        assert.ok(tileHeightSrc * edge <= tileHeightOut * width, `${tier} ${width}: fits`);
        assert.ok((tileHeightSrc + 1) * edge > tileHeightOut * width, `${tier} ${width}: largest`);
      }
    }
  });

  it('does not change a width that is not scaled', () => {
    for (const tier of TIERS) {
      for (const width of [1, 100, 1000, TILE_TIERS[tier].maxLongEdgePx]) {
        const { tileHeightSrc, tileHeightOut, scale } = tileGeometry(width, tier);
        assert.equal(scale, 1);
        assert.equal(tileHeightSrc, tileHeightOut);
      }
    }
  });

  it('the tile plan stays valid at the widths where the old formula lost a row', () => {
    for (const tier of TIERS) {
      for (const width of [3174, 3175, 4148, 5000, 7777, 12_000]) {
        for (const height of [1, 50, 3000, 9999, 123_456]) {
          const { tileHeightSrc, tileHeightOut, scale, outWidth } = tileGeometry(width, tier);
          const tiles = planTiles(width, height, tier);
          // The rows of the tiles cover the image from the top to the bottom, with the overlap.
          assert.equal(tiles[0]?.srcY, 0);
          const last = tiles.at(-1);
          assert.equal((last?.srcY ?? 0) + (last?.srcHeight ?? 0), height);
          const stepSrc = tileHeightSrc - Math.round(TILE_OVERLAP_PX / scale);
          tiles.forEach((tile, i) => {
            assert.equal(tile.index, i);
            assert.equal(tile.srcY, i * stepSrc, `${tier} ${width}x${height} tile ${i}`);
            assert.ok(tile.srcHeight >= 1 && tile.srcHeight <= tileHeightSrc);
            assert.ok(tile.outHeight >= 1 && tile.outHeight <= tileHeightOut);
            assert.equal(tile.outWidth, outWidth);
            // The renderer draws the source rows into outWidth x outHeight: the scale is the same
            // for rows and columns, up to the rounding of one output row.
            assert.ok(Math.abs(tile.outHeight - tile.srcHeight * scale) <= 1, `${tier} ${width}x${height}`);
          });
          // The next tile starts inside the rows of this one (an overlap, never a gap).
          for (let i = 1; i < tiles.length; i += 1) {
            const previous = /** @type {NonNullable<(typeof tiles)[number]>} */ (tiles[i - 1]);
            assert.ok((tiles[i]?.srcY ?? 0) <= previous.srcY + previous.srcHeight);
          }
        }
      }
    }
  });
});
