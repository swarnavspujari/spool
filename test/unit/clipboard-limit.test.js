// @ts-check
/**
 * Tests for the clipboard size guard: src/lib/clipboard-limit.js, and the copies of it that a page
 * script cannot import (`exceedsClipboard` in src/page/ui-kit.js, the built-in limits in
 * src/page/agent.js and src/page/shelf.js). Both functions run on the same input.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { exceedsClipboardLimit } from '../../src/lib/clipboard-limit.js';
import { MAX_CLIPBOARD_BITMAP_BYTES, MAX_IMAGES_PER_MESSAGE } from '../../src/shared/constants.js';
import { setupCards } from '../helpers/fake-card-dom.js';

const MIB = 1024 * 1024;

describe('exceedsClipboardLimit', () => {
  it('is 256 MiB of decoded pixels: a 1,500 px wide capture may be about 44,800 px high', () => {
    assert.equal(MAX_CLIPBOARD_BITMAP_BYTES, 256 * MIB);
    assert.equal(exceedsClipboardLimit(1500, 44_739, MAX_CLIPBOARD_BITMAP_BYTES), false);
    assert.equal(exceedsClipboardLimit(1500, 44_740, MAX_CLIPBOARD_BITMAP_BYTES), true);
  });

  it('refuses the sizes that crashed a tab: 1,500 x 70,000 and more', () => {
    for (const heightPx of [70_000, 80_000, 100_000, 300_000]) {
      assert.equal(exceedsClipboardLimit(1500, heightPx, MAX_CLIPBOARD_BITMAP_BYTES), true, String(heightPx));
    }
  });

  it('lets through the sizes that wrote without a problem: up to 1,500 x 40,000', () => {
    for (const heightPx of [1, 8_000, 20_000, 40_000]) {
      assert.equal(exceedsClipboardLimit(1500, heightPx, MAX_CLIPBOARD_BITMAP_BYTES), false, String(heightPx));
    }
  });

  it('a size of exactly the limit is allowed, one byte more is not', () => {
    assert.equal(exceedsClipboardLimit(1024, 1024 * 64, 256 * MIB), false);
    assert.equal(exceedsClipboardLimit(1024, 1024 * 64 + 1, 256 * MIB), true);
  });

  it('counts a size that is not a number as too large, so a bad value never lets a write through', () => {
    for (const [w, h] of [
      [Number.NaN, 100],
      [100, Number.NaN],
      [Number.POSITIVE_INFINITY, 1],
      [undefined, 100],
      [100, undefined],
    ]) {
      assert.equal(
        exceedsClipboardLimit(/** @type {any} */ (w), /** @type {any} */ (h), MAX_CLIPBOARD_BITMAP_BYTES),
        true,
        `${w} x ${h}`,
      );
    }
  });
});

describe('the copy in the page kit', () => {
  const { ns } = setupCards({ files: ['src/page/ui-kit.js'] });

  it('gives the same answer as the module, on a grid of sizes and limits', () => {
    for (const limit of [0, 1, 1000, 10 * MIB, MAX_CLIPBOARD_BITMAP_BYTES]) {
      for (const w of [0, 1, 600, 1500, 8000, Number.NaN]) {
        for (const h of [0, 1, 1200, 44_739, 44_740, 70_000, 300_000, Number.NaN]) {
          assert.equal(
            ns.ui.exceedsClipboard(w, h, limit),
            exceedsClipboardLimit(w, h, limit),
            `${w} x ${h} at ${limit}`,
          );
        }
      }
    }
  });
});

describe('the numbers that a page script has built in', () => {
  /** @param {string} file @param {RegExp} pattern @returns {string} */
  const read = (file, pattern) => {
    const text = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
    const found = pattern.exec(text);
    assert.ok(found, `${file} has ${pattern}`);
    return /** @type {string} */ (found[1]);
  };

  it('agent.js and shelf.js use the same clipboard limit as constants.js', () => {
    const pattern = /DEFAULT_MAX_CLIPBOARD_(?:BITMAP_)?BYTES = ([\d* ]+);/;
    for (const file of ['src/page/agent.js', 'src/page/shelf.js']) {
      const value = read(file, pattern)
        .split('*')
        .reduce((product, part) => product * Number(part.trim()), 1);
      assert.equal(value, MAX_CLIPBOARD_BITMAP_BYTES, file);
    }
  });

  it('shelf.js inserts as many images as constants.js says a chat takes', () => {
    assert.equal(Number(read('src/page/shelf.js', /DEFAULT_MAX_IMAGES = (\d+);/)), MAX_IMAGES_PER_MESSAGE);
    assert.equal(MAX_IMAGES_PER_MESSAGE, 20);
  });
});
