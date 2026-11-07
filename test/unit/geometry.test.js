// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { contentYToPx, cropRectPx } from '../../src/lib/geometry.js';

/** Same value as EDGE_EPS in geometry.js: a pixel counts when 99% of it is inside the rect. */
const EPS = 0.01;

describe('cropRectPx', () => {
  it('keeps only the pixels inside the rect at scale 1', () => {
    // x 10.4 to 109.9 holds the whole columns 11 to 108. y 20.6 to 51.1 holds the rows 21 to 50.
    const rect = { x: 10.4, y: 20.6, width: 99.5, height: 30.5 };
    assert.deepEqual(cropRectPx(rect, { width: 1000, height: 800 }, 1000, 800), {
      sx: 11,
      sy: 21,
      sw: 98,
      sh: 30,
      scale: 1,
    });
  });

  // All products below are exact in binary floating point, so the expected values are exact.
  // Each case is worked out by hand: the first and the last whole pixel inside the rect.
  const scaleCases = [
    {
      name: 'scale 1.25',
      viewport: { width: 800, height: 600 },
      bitmap: [1000, 750],
      // x 12.5 to 138.75, y 26.25 to 67.5.
      rect: { x: 10, y: 21, width: 101, height: 33 },
      expected: { sx: 13, sy: 27, sw: 125, sh: 40, scale: 1.25 },
    },
    {
      name: 'scale 1.5',
      viewport: { width: 1000, height: 500 },
      bitmap: [1500, 750],
      // x 4.5 to 12, y 4.5 to 15.
      rect: { x: 3, y: 3, width: 5, height: 7 },
      expected: { sx: 5, sy: 5, sw: 7, sh: 10, scale: 1.5 },
    },
    {
      name: 'scale 1.75 (Windows 175%)',
      viewport: { width: 1280, height: 720 },
      bitmap: [2240, 1260],
      // Every edge is on a pixel boundary: nothing is cut.
      rect: { x: 100, y: 200, width: 800, height: 400 },
      expected: { sx: 175, sy: 350, sw: 1400, sh: 700, scale: 1.75 },
    },
    {
      name: 'scale 2',
      viewport: { width: 400, height: 300 },
      bitmap: [800, 600],
      // x 25 to 225, y 14.5 to 116.
      rect: { x: 12.5, y: 7.25, width: 100, height: 50.75 },
      expected: { sx: 25, sy: 15, sw: 200, sh: 101, scale: 2 },
    },
    {
      name: 'scale 2.5',
      viewport: { width: 400, height: 300 },
      bitmap: [1000, 750],
      // x 1.25 to 27.5, y 0.625 to 51.25.
      rect: { x: 0.5, y: 0.25, width: 10.5, height: 20.25 },
      expected: { sx: 2, sy: 1, sw: 25, sh: 50, scale: 2.5 },
    },
  ];
  for (const { name, viewport, bitmap, rect, expected } of scaleCases) {
    it(`converts at ${name}`, () => {
      assert.deepEqual(cropRectPx(rect, viewport, bitmap[0], bitmap[1]), expected);
    });
  }

  it('does not add a row for a half pixel (882.5 device rows give 882, not 883)', () => {
    // The e2e finding: at scale 1.25 a height of 706 CSS px is 882.5 device rows. Rounding the
    // size gave 883 rows, one more than the element has, and the extra row was white.
    const viewport = { width: 800, height: 800 };
    const atTop = cropRectPx({ x: 0, y: 0, width: 800, height: 706 }, viewport, 1000, 1000);
    assert.deepEqual(atTop, { sx: 0, sy: 0, sw: 1000, sh: 882, scale: 1.25 });
    // Moved down by 10 CSS px (12.5 device px): the half row at the top is not taken either.
    const moved = cropRectPx({ x: 0, y: 10, width: 800, height: 706 }, viewport, 1000, 1000);
    assert.deepEqual(moved, { sx: 0, sy: 13, sw: 1000, sh: 882, scale: 1.25 });
  });

  it('derives the scale from the bitmap width, not from the device pixel ratio', () => {
    // Browser zoom makes innerWidth odd: 1920 device px over 1164 CSS px.
    const viewport = { width: 1164, height: 650 };
    const crop = cropRectPx({ x: 0, y: 0, width: 1164, height: 650 }, viewport, 1920, 1072);
    assert.equal(crop.scale, 1920 / 1164);
    assert.equal(crop.sw, 1920);
  });

  it('gives the same crop for every frame of a session', () => {
    // The page agent sends equal values in every frame. Fresh copies of them, in any number of
    // calls, must give one crop.
    const sessions = [
      { viewport: { width: 937, height: 611 }, bitmap: [1171, 764] },
      { viewport: { width: 1164, height: 650 }, bitmap: [1920, 1072] },
      { viewport: { width: 800, height: 600 }, bitmap: [1000, 750] },
    ];
    for (const { viewport, bitmap } of sessions) {
      const call = () =>
        cropRectPx(
          { x: 13.3, y: 40.7, width: 411.1, height: 333.3 },
          { ...viewport },
          bitmap[0],
          bitmap[1],
        );
      const first = call();
      for (let frame = 1; frame < 20; frame++) assert.deepEqual(call(), first);
    }
  });

  it('keeps an edge on a pixel boundary against floating-point noise', () => {
    // 311 * (342 / 311) is 341.99999999999994: without the margin the last column would go.
    const crop = cropRectPx(
      { x: 0, y: 0, width: 311, height: 200 },
      { width: 311, height: 200 },
      342,
      220,
    );
    assert.equal(crop.sw, 342);
    // Edges at whole device pixels, nudged by 1e-9 CSS px in either direction.
    for (const factor of [1, 1.25, 1.5, 2, 2.5]) {
      const viewport = { width: 400, height: 300 };
      const size = [400 * factor, 300 * factor];
      const want = cropRectPx({ x: 20, y: 10, width: 100, height: 60 }, viewport, size[0], size[1]);
      for (const noise of [-1e-9, 1e-9]) {
        const rect = { x: 20 + noise, y: 10 + noise, width: 100 + noise, height: 60 + noise };
        assert.deepEqual(cropRectPx(rect, viewport, size[0], size[1]), want, `factor ${factor}`);
      }
    }
  });

  it('counts a pixel when 99% of it is inside the rect', () => {
    const viewport = { width: 100, height: 100 };
    /** @param {number} x @param {number} width */
    const columns = (x, width) => {
      const { sx, sw } = cropRectPx({ x, y: 0, width, height: 50 }, viewport, 100, 100);
      return [sx, sx + sw];
    };
    // Near edge: column 10 starts at 10. From 10.005 it is 99.5% covered (kept). From 9.995 the
    // column 9 is covered by 0.5% only (dropped). From 10.02 the column 10 is 98% covered
    // (dropped).
    assert.deepEqual(columns(10.005, 49.995), [10, 60]);
    assert.deepEqual(columns(9.995, 50.005), [10, 60]);
    assert.deepEqual(columns(10.02, 49.98), [11, 60]);
    // Far edge: column 59 ends at 60.
    assert.deepEqual(columns(10, 49.995), [10, 60]);
    assert.deepEqual(columns(10, 49.99), [10, 60]);
    assert.deepEqual(columns(10, 49.98), [10, 59]);
  });

  it('reaches the bitmap edge when the rect reaches the viewport edge, for any scale', () => {
    for (let viewportWidth = 300; viewportWidth <= 3000; viewportWidth += 7) {
      for (const factor of [1, 1.1, 1.25, 4 / 3, 1.5, 1.75, 2, 2.5, 3]) {
        const bitmapWidth = Math.round(viewportWidth * factor);
        const viewport = { width: viewportWidth, height: 500 };
        const crop = cropRectPx(
          { x: 0, y: 0, width: viewportWidth, height: 500 },
          viewport,
          bitmapWidth,
          Math.round(500 * (bitmapWidth / viewportWidth)),
        );
        assert.equal(crop.sx, 0);
        assert.equal(crop.sw, bitmapWidth, `viewport ${viewportWidth}, bitmap ${bitmapWidth}`);
      }
    }
  });

  it('ends exactly at the bitmap edge for a rect that touches an edge, at every scale', () => {
    // The rect starts at a fractional position and runs to the right and bottom viewport edge.
    // The origin moves inwards, the far edge stays on the bitmap edge.
    for (const factor of [1, 1.25, 1.5, 2, 2.5]) {
      const viewport = { width: 800, height: 600 };
      const bitmapWidth = 800 * factor;
      const bitmapHeight = 600 * factor;
      const x = 700.3;
      const y = 500.7;
      const crop = cropRectPx(
        { x, y, width: 800 - x, height: 600 - y },
        viewport,
        bitmapWidth,
        bitmapHeight,
      );
      assert.equal(crop.sx, Math.ceil(x * factor - EPS), `factor ${factor}`);
      assert.equal(crop.sy, Math.ceil(y * factor - EPS), `factor ${factor}`);
      assert.equal(crop.sx + crop.sw, bitmapWidth, `factor ${factor}`);
      assert.equal(crop.sy + crop.sh, bitmapHeight, `factor ${factor}`);
    }
    // A rect that touches the left and top edge starts at 0 (and not at -0).
    for (const factor of [1, 1.25, 1.5, 2, 2.5]) {
      const crop = cropRectPx(
        { x: 0, y: 0, width: 30.3, height: 20.2 },
        { width: 400, height: 300 },
        400 * factor,
        300 * factor,
      );
      assert.ok(Object.is(crop.sx, 0) && Object.is(crop.sy, 0), `factor ${factor}`);
    }
  });

  it('holds only pixels inside the rect and loses less than 1 px per edge', () => {
    const viewport = { width: 937, height: 611 };
    const eps = EPS + 1e-9;
    for (const factor of [1, 1.25, 1.5, 2, 2.5]) {
      const bitmapWidth = Math.round(viewport.width * factor);
      const bitmapHeight = Math.round(viewport.height * factor);
      const scale = bitmapWidth / viewport.width;
      for (let x = 0; x <= 400; x += 37.3) {
        for (let y = 0; y <= 300; y += 29.9) {
          for (const [width, height] of [[3.3, 4.7], [64.5, 99.25], [500.1, 200.9]]) {
            const crop = cropRectPx({ x, y, width, height }, viewport, bitmapWidth, bitmapHeight);
            const label = JSON.stringify({ factor, x, y, width, height, crop });
            const right = (x + width) * scale;
            const bottom = (y + height) * scale;
            // Inside the rect, up to the margin.
            assert.ok(crop.sx >= x * scale - eps, label);
            assert.ok(crop.sx + crop.sw <= right + eps, label);
            assert.ok(crop.sy >= y * scale - eps, label);
            assert.ok(crop.sy + crop.sh <= bottom + eps, label);
            // At most one pixel lost on each edge.
            assert.ok(crop.sx - x * scale < 1, label);
            assert.ok(right - (crop.sx + crop.sw) < 1, label);
            assert.ok(crop.sy - y * scale < 1, label);
            assert.ok(bottom - (crop.sy + crop.sh) < 1, label);
          }
        }
      }
    }
  });

  it('cuts the size at the bitmap edge when the rect reaches past the viewport', () => {
    const viewport = { width: 10, height: 8 };
    const right = cropRectPx({ x: 3, y: 0, width: 20, height: 8 }, viewport, 15, 12);
    assert.deepEqual(right, { sx: 5, sy: 0, sw: 10, sh: 12, scale: 1.5 });
    const bottom = cropRectPx({ x: 0, y: 3, width: 10, height: 20 }, viewport, 15, 12);
    assert.deepEqual(bottom, { sx: 0, sy: 5, sw: 15, sh: 7, scale: 1.5 });
  });

  it('cuts the size to a bitmap that is shorter than the viewport implies', () => {
    const viewport = { width: 1000, height: 800 };
    const crop = cropRectPx({ x: 0, y: 700, width: 1000, height: 100 }, viewport, 1000, 790);
    assert.deepEqual(crop, { sx: 0, sy: 700, sw: 1000, sh: 90, scale: 1 });
  });

  it('gives at least 1 px, also for a sub-pixel rect', () => {
    const viewport = { width: 100, height: 100 };
    const crop = cropRectPx({ x: 5, y: 5, width: 0.2, height: 0.1 }, viewport, 100, 100);
    assert.deepEqual(crop, { sx: 5, sy: 5, sw: 1, sh: 1, scale: 1 });
    // A sliver between two pixel boundaries: no whole pixel inside, still 1 px.
    const sliver = cropRectPx({ x: 5.2, y: 5.3, width: 0.4, height: 0.4 }, viewport, 100, 100);
    assert.deepEqual(sliver, { sx: 6, sy: 6, sw: 1, sh: 1, scale: 1 });
  });

  it('moves an origin outside the bitmap to the nearest edge pixel', () => {
    const viewport = { width: 1000, height: 800 };
    assert.deepEqual(cropRectPx({ x: 5000, y: 5000, width: 10, height: 10 }, viewport, 1000, 800), {
      sx: 999,
      sy: 799,
      sw: 1,
      sh: 1,
      scale: 1,
    });
    const negative = cropRectPx({ x: -20, y: -5, width: 50, height: 10 }, viewport, 1000, 800);
    assert.equal(negative.sx, 0);
    assert.equal(negative.sy, 0);
  });

  it('never leaves the bitmap and never returns an empty crop', () => {
    const viewport = { width: 937, height: 611 };
    const sizes = [[0.3, 0.3], [1, 1], [64.5, 99.25], [937, 611], [4000, 4000]];
    for (const factor of [1, 1.25, 1.5, 2, 2.5]) {
      const bitmapWidth = Math.round(viewport.width * factor);
      const bitmapHeight = Math.round(viewport.height * factor);
      for (let x = -50; x <= 1000; x += 41) {
        for (let y = -50; y <= 700; y += 37) {
          for (const [width, height] of sizes) {
            const crop = cropRectPx({ x, y, width, height }, viewport, bitmapWidth, bitmapHeight);
            const label = JSON.stringify({ factor, x, y, width, height });
            assert.ok(crop.sx >= 0 && crop.sy >= 0, label);
            assert.ok(crop.sw >= 1 && crop.sh >= 1, label);
            assert.ok(crop.sx + crop.sw <= bitmapWidth, label);
            assert.ok(crop.sy + crop.sh <= bitmapHeight, label);
          }
        }
      }
    }
  });

  it('does not change the rect that it receives', () => {
    const rect = Object.freeze({ x: 1, y: 2, width: 3, height: 4 });
    const viewport = Object.freeze({ width: 10, height: 10 });
    assert.doesNotThrow(() => cropRectPx(rect, viewport, 20, 20));
  });

  describe('input validation', () => {
    const rect = { x: 0, y: 0, width: 10, height: 10 };
    const viewport = { width: 100, height: 100 };

    it('rejects a rect with no area or a non-finite value', () => {
      assert.throws(() => cropRectPx({ ...rect, width: 0 }, viewport, 100, 100), RangeError);
      assert.throws(() => cropRectPx({ ...rect, height: -1 }, viewport, 100, 100), RangeError);
      assert.throws(() => cropRectPx({ ...rect, x: NaN }, viewport, 100, 100), RangeError);
      assert.throws(() => cropRectPx({ ...rect, y: Infinity }, viewport, 100, 100), RangeError);
    });

    it('rejects a viewport with no area', () => {
      assert.throws(() => cropRectPx(rect, { width: 0, height: 100 }, 100, 100), RangeError);
      assert.throws(() => cropRectPx(rect, { width: 100, height: -5 }, 100, 100), RangeError);
    });

    it('rejects a bitmap size that is not a positive whole number', () => {
      assert.throws(() => cropRectPx(rect, viewport, 0, 100), RangeError);
      assert.throws(() => cropRectPx(rect, viewport, 100, -1), RangeError);
      assert.throws(() => cropRectPx(rect, viewport, 100.5, 100), RangeError);
      assert.throws(() => cropRectPx(rect, viewport, 100, NaN), RangeError);
    });

    it('names the field that is not valid', () => {
      /** @type {[string, () => unknown, ErrorConstructor][]} */
      const cases = [
        ['rect.x', () => cropRectPx({ ...rect, x: NaN }, viewport, 100, 100), RangeError],
        ['rect.y', () => cropRectPx({ ...rect, y: Infinity }, viewport, 100, 100), RangeError],
        ['rect.width', () => cropRectPx({ ...rect, width: 0 }, viewport, 100, 100), RangeError],
        ['rect.height', () => cropRectPx({ ...rect, height: -1 }, viewport, 100, 100), RangeError],
        ['viewport.width', () => cropRectPx(rect, { width: 0, height: 100 }, 100, 100), RangeError],
        ['viewport.height', () => cropRectPx(rect, { width: 100, height: 0 }, 100, 100), RangeError],
        ['bitmapWidth', () => cropRectPx(rect, viewport, 0.5, 100), RangeError],
        ['bitmapHeight', () => cropRectPx(rect, viewport, 100, 0.5), RangeError],
        // @ts-expect-error wrong type on purpose
        ['rect.y', () => cropRectPx({ ...rect, y: '5' }, viewport, 100, 100), TypeError],
        // @ts-expect-error wrong type on purpose
        ['rect.height', () => cropRectPx({ ...rect, height: null }, viewport, 100, 100), TypeError],
        // @ts-expect-error wrong type on purpose
        ['viewport.width', () => cropRectPx(rect, { ...viewport, width: '9' }, 100, 100), TypeError],
        // @ts-expect-error wrong type on purpose
        ['bitmapHeight', () => cropRectPx(rect, viewport, 100, '100'), TypeError],
      ];
      for (const [field, call, errorType] of cases) {
        assert.throws(
          call,
          (error) =>
            error instanceof errorType &&
            error.message.startsWith(`${field} must`),
          field,
        );
      }
    });

    it('rejects values that are not numbers', () => {
      // @ts-expect-error wrong type on purpose
      assert.throws(() => cropRectPx({ ...rect, x: '5' }, viewport, 100, 100), TypeError);
      // @ts-expect-error wrong type on purpose
      assert.throws(() => cropRectPx(rect, viewport, '100', 100), TypeError);
    });
  });
});

describe('contentYToPx', () => {
  it('rounds the product', () => {
    assert.equal(contentYToPx(0, 1.5), 0);
    assert.equal(contentYToPx(100, 1), 100);
    assert.equal(contentYToPx(100, 1.25), 125);
    assert.equal(contentYToPx(3, 1.5), 5);
    assert.equal(contentYToPx(10.2, 2), 20);
    assert.equal(contentYToPx(1234.5, 2.5), 3086);
  });

  it('accepts a content position above the origin', () => {
    assert.equal(contentYToPx(-100, 1.5), -150);
  });

  it('agrees with cropRectPx on the scale it returns', () => {
    const viewport = { width: 1164, height: 650 };
    const { scale } = cropRectPx({ x: 0, y: 0, width: 10, height: 10 }, viewport, 1920, 1072);
    assert.equal(contentYToPx(1164, scale), 1920);
  });

  it('rounds half a pixel up, also below zero (Math.round, not symmetric rounding)', () => {
    assert.equal(contentYToPx(5, 0.5), 3);
    assert.equal(contentYToPx(-5, 0.5), -2);
    assert.equal(contentYToPx(-7, 0.5), -3);
  });

  it('names the argument that is not valid', () => {
    assert.throws(() => contentYToPx(NaN, 1), /^RangeError: contentY must/);
    assert.throws(() => contentYToPx(1, 0), /^RangeError: scale must/);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => contentYToPx('1', 1), /^TypeError: contentY must/);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => contentYToPx(1, '1'), /^TypeError: scale must/);
  });

  it('rejects a scale that is not positive and finite, and a position that is not finite', () => {
    assert.throws(() => contentYToPx(10, 0), RangeError);
    assert.throws(() => contentYToPx(10, -1), RangeError);
    assert.throws(() => contentYToPx(10, NaN), RangeError);
    assert.throws(() => contentYToPx(NaN, 1), RangeError);
    assert.throws(() => contentYToPx(Infinity, 1), RangeError);
    // @ts-expect-error wrong type on purpose
    assert.throws(() => contentYToPx('10', 1), TypeError);
  });
});
