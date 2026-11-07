// @ts-check
/**
 * Unit tests for the end-to-end band verifier (e2e/bands.js). They use synthetic images that
 * are rendered the way a browser draws the fixture pages: solid bands, a darker line on every
 * 5th band, and area-weighted (antialiased) rows where a band edge falls inside a pixel row.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  BAND_CSS,
  FOREIGN_COLORS,
  LINE_CSS,
  analyzeColumn,
  bandRgb,
  describeResult,
  hasLine,
  indexOfRgb,
  lineRgb,
  verifyBands,
} from '../../e2e/bands.js';

/**
 * @typedef {{ from: number, to: number, rgb: readonly number[] }} Piece  CSS px range and colour.
 */

/**
 * CSS-space pieces for a list of band indexes, plus optional solid blocks.
 * @param {(number | { solid: readonly number[], css: number })[]} items
 * @returns {{ pieces: Piece[], cssHeight: number }}
 */
function layout(items) {
  /** @type {Piece[]} */
  const pieces = [];
  let y = 0;
  for (const item of items) {
    if (typeof item === 'number') {
      if (hasLine(item)) {
        pieces.push({ from: y, to: y + LINE_CSS, rgb: lineRgb(item) });
        pieces.push({ from: y + LINE_CSS, to: y + BAND_CSS, rgb: bandRgb(item) });
      } else {
        pieces.push({ from: y, to: y + BAND_CSS, rgb: bandRgb(item) });
      }
      y += BAND_CSS;
    } else {
      pieces.push({ from: y, to: y + item.css, rgb: item.solid });
      y += item.css;
    }
  }
  return { pieces, cssHeight: y };
}

/**
 * Renders `items` at `scale` into an RGB image. A row's colour is the average of the pieces it
 * covers, weighted by covered area: fractional edges produce blended rows, as in a browser.
 * @param {{ items: (number | { solid: readonly number[], css: number })[], scale: number, width?: number, crop?: { top?: number, bottom?: number } }} spec
 * @returns {import('../../e2e/bands.js').RawImage}
 */
function render({ items, scale, width = 12, crop = {} }) {
  const { pieces, cssHeight } = layout(items);
  const fullRows = Math.floor(cssHeight * scale + 1e-9);
  const top = crop.top ?? 0;
  const bottom = fullRows - (crop.bottom ?? 0);
  const height = bottom - top;
  const data = new Uint8Array(width * height * 3);
  for (let row = 0; row < height; row++) {
    const y0 = (top + row) / scale;
    const y1 = (top + row + 1) / scale;
    const sum = [0, 0, 0];
    let weight = 0;
    for (const p of pieces) {
      const w = Math.min(y1, p.to) - Math.max(y0, p.from);
      if (w <= 0) continue;
      weight += w;
      for (let c = 0; c < 3; c++) sum[c] = (sum[c] ?? 0) + (p.rgb[c] ?? 0) * w;
    }
    for (let x = 0; x < width; x++) {
      for (let c = 0; c < 3; c++) {
        data[(row * width + x) * 3 + c] = Math.round((sum[c] ?? 0) / (weight || 1));
      }
    }
  }
  return { width, height, channels: 3, data };
}

/** @param {number} from @param {number} count @returns {number[]} */
function seq(from, count) {
  return Array.from({ length: count }, (_, i) => from + i);
}

/** @param {import('../../e2e/bands.js').VerifyResult} res @param {number} scale */
function explain(res, scale) {
  return describeResult(res, scale);
}

for (const scale of [1, 1.25, 1.5, 2]) {
  test(`perfect image passes at scale ${scale}`, () => {
    const img = render({ items: seq(10, 60), scale });
    const res = verifyBands(img, { scale, expectedFirst: 10, expectedLast: 69 });
    assert.deepEqual(res.errors, [], explain(res, scale));
    assert.equal(res.ok, true);
    assert.equal(res.bands.length, 60);
    assert.equal(res.firstIndex, 10);
    assert.equal(res.lastIndex, 69);
    assert.deepEqual(res.foreign, []);
  });

  test(`duplicated band is reported at scale ${scale}`, () => {
    const items = [...seq(10, 20), 29, ...seq(30, 20)]; // 29 appears twice
    const img = render({ items, scale });
    const res = verifyBands(img, { scale });
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /band 29 appears twice/);
  });

  test(`missing band is reported at scale ${scale}`, () => {
    const items = [...seq(10, 20), ...seq(31, 20)]; // 30 is missing
    const img = render({ items, scale });
    const res = verifyBands(img, { scale });
    assert.equal(res.ok, false);
    assert.match(res.errors.join('\n'), /1 band\(s\) missing between 29 and 31/);
  });
}

test('fractional scale 1.3 (antialiased edge rows) passes', () => {
  const scale = 1.3;
  const img = render({ items: seq(0, 80), scale, width: 9 });
  const res = verifyBands(img, { scale, expectedFirst: 0, expectedLast: 79 });
  assert.deepEqual(res.errors, [], explain(res, scale));
});

test('index wrap from 255 to 256 (green channel steps) passes', () => {
  assert.deepEqual(bandRgb(255), [255, 0, 200]);
  assert.deepEqual(bandRgb(256), [0, 1, 200]);
  const img = render({ items: seq(250, 12), scale: 1 });
  const res = verifyBands(img, { scale: 1, expectedFirst: 250, expectedLast: 261 });
  assert.deepEqual(res.errors, [], explain(res, 1));
});

test('indexOfRgb inverts bandRgb', () => {
  for (const i of [0, 1, 5, 255, 256, 1199, 65535]) {
    const [r, g] = bandRgb(i);
    assert.equal(indexOfRgb(r, g), i);
  }
});

test('several missing bands are counted', () => {
  const img = render({ items: [...seq(100, 10), ...seq(115, 10)], scale: 1 });
  const res = verifyBands(img, { scale: 1 });
  assert.match(res.errors.join('\n'), /5 band\(s\) missing between 109 and 115/);
});

test('bands in the wrong order are reported', () => {
  const img = render({ items: [...seq(10, 5), 20, 19, ...seq(21, 5)], scale: 1 });
  const res = verifyBands(img, { scale: 1 });
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /order goes backwards|missing/);
});

test('wrong first or last index is reported', () => {
  const img = render({ items: seq(10, 30), scale: 1 });
  const res = verifyBands(img, { scale: 1, expectedFirst: 9, expectedLast: 40 });
  assert.match(res.errors.join('\n'), /first band is 10; expected 9/);
  assert.match(res.errors.join('\n'), /last band is 39; expected 40/);
});

test('a header before the bands and a footer after them are allowed', () => {
  const header = { solid: FOREIGN_COLORS.header, css: 48 };
  const footer = { solid: FOREIGN_COLORS.composer, css: 56 };
  const scale = 1.5;
  const img = render({ items: [header, ...seq(0, 40), footer], scale });
  const res = verifyBands(img, { scale, expectedFirst: 0, expectedLast: 39 });
  assert.deepEqual(res.errors, [], explain(res, scale));
  assert.deepEqual(
    res.foreign.map((f) => f.where),
    ['leading', 'trailing'],
  );
});

test('foreign content between bands is reported (a repeated sticky header)', () => {
  const header = { solid: FOREIGN_COLORS.header, css: 48 };
  const img = render({ items: [...seq(0, 20), header, ...seq(26, 20)], scale: 1 });
  const res = verifyBands(img, { scale: 1 });
  assert.equal(res.ok, false);
  const text = res.errors.join('\n');
  assert.match(text, /foreign content between band 19 and band 26/);
  assert.match(text, /rgb\(16,24,48\)/);
});

test('a header leak of one band height between bands is reported', () => {
  const leak = { solid: FOREIGN_COLORS.header, css: BAND_CSS };
  const img = render({ items: [...seq(0, 20), leak, ...seq(21, 20)], scale: 2 });
  const res = verifyBands(img, { scale: 2 });
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /foreign content between band 19 and band 21/);
});

test('bands drawn at the wrong scale fail the spacing rule', () => {
  const img = render({ items: seq(0, 30), scale: 1.5 });
  const res = verifyBands(img, { scale: 1 });
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /rows below band/);
});

test('a first band cut by the image top is accepted', () => {
  const scale = 2;
  // Drop the top 6 rows (3 CSS px) of band 10.
  const img = render({ items: seq(10, 30), scale, crop: { top: 6 } });
  const res = verifyBands(img, { scale, expectedFirst: 10, expectedLast: 39 });
  assert.deepEqual(res.errors, [], explain(res, scale));
  assert.equal(/** @type {import('../../e2e/bands.js').Band} */ (res.bands[0]).cutTop, true);
});

test('a last band cut by the image bottom is accepted', () => {
  const scale = 1;
  const img = render({ items: seq(10, 30), scale, crop: { bottom: 5 } });
  const res = verifyBands(img, { scale, expectedFirst: 10, expectedLast: 39 });
  assert.deepEqual(res.errors, [], explain(res, scale));
});

test('one boundary row of page background at the bottom is reported but accepted', () => {
  const scale = 1.25;
  const base = render({ items: seq(0, 30), scale });
  // Append one white row (the crop at a fractional scale can include a row beyond the element).
  const data = new Uint8Array(base.width * (base.height + 1) * 3).fill(255);
  data.set(base.data, 0);
  const img = { width: base.width, height: base.height + 1, channels: 3, data };
  const res = verifyBands(img, { scale, expectedFirst: 0, expectedLast: 29 });
  assert.deepEqual(res.errors, [], explain(res, scale));
  assert.deepEqual(res.foreign, []);
  assert.deepEqual(
    res.edgeRows.map((e) => [e.side, e.rows, [...e.color]]),
    [['bottom', 1, [255, 255, 255]]],
  );
});

test('a foreign block at the bottom that is taller than a boundary row is reported', () => {
  const footer = { solid: FOREIGN_COLORS.composer, css: 4 };
  const img = render({ items: [...seq(0, 30), footer], scale: 1 });
  const res = verifyBands(img, { scale: 1 });
  assert.equal(res.ok, true); // Trailing foreign content is allowed by the verifier ...
  assert.deepEqual(
    res.foreign.map((f) => f.where),
    ['trailing'], // ... but it is reported, so a test can reject it.
  );
  assert.deepEqual(res.edgeRows, []);
});

test('a column that differs from the centre column is reported', () => {
  const scale = 1;
  const img = render({ items: seq(0, 30), scale, width: 20 });
  // Overwrite the left quarter column with a shifted band sequence.
  const shifted = render({ items: seq(3, 30), scale, width: 20 });
  const x = 5;
  for (let y = 0; y < img.height; y++) {
    for (let c = 0; c < 3; c++) {
      /** @type {Uint8Array} */ (img.data)[(y * img.width + x) * 3 + c] =
        shifted.data[(y * img.width + x) * 3 + c] ?? 0;
    }
  }
  const res = verifyBands(img, { scale, columns: [x, 10, 15] });
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /column x=5 shows other bands than x=10/);
});

test('RGBA input is read like RGB', () => {
  const rgb = render({ items: seq(0, 20), scale: 1, width: 4 });
  const rgba = new Uint8Array(rgb.width * rgb.height * 4);
  for (let i = 0; i < rgb.width * rgb.height; i++) {
    rgba[i * 4] = rgb.data[i * 3] ?? 0;
    rgba[i * 4 + 1] = rgb.data[i * 3 + 1] ?? 0;
    rgba[i * 4 + 2] = rgb.data[i * 3 + 2] ?? 0;
    rgba[i * 4 + 3] = 255;
  }
  const res = verifyBands({ width: rgb.width, height: rgb.height, channels: 4, data: rgba }, { scale: 1 });
  assert.deepEqual(res.errors, []);
});

test('an image without bands fails with a clear message', () => {
  const img = render({ items: [{ solid: FOREIGN_COLORS.panel, css: 80 }], scale: 1 });
  const res = verifyBands(img, { scale: 1 });
  assert.equal(res.ok, false);
  assert.match(res.errors.join('\n'), /no bands found/);
});

test('analyzeColumn ignores the line rows and antialiased rows', () => {
  const scale = 1.25;
  const img = render({ items: seq(0, 12), scale, width: 3 });
  const a = analyzeColumn(img, 1, scale);
  assert.deepEqual(
    a.bands.map((b) => b.index),
    seq(0, 12),
  );
  assert.deepEqual(a.foreign, []);
});
