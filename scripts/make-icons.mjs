// @ts-check
/**
 * Draws the Spool toolbar icons: a graphite rounded tile with a spool (two light flanges, an
 * amber body) and a thread of amber that leaves the spool and runs down the right side. The
 * shapes follow the Spool brand. The icon has three versions: one
 * for 128 px (also used at 48 px), one for 32 px and one for 16 px, each on a grid that keeps
 * its edges sharp at that size. This script draws the same three.
 *
 * No dependencies. Every pixel is the mean of 8 x 8 samples, so the edges are smooth. Shapes
 * are painted back to front with straight alpha, as in SVG. Writes icons/icon-<size>.png as
 * 8-bit RGBA PNG. The output is deterministic. Run it with `npm run icons`.
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';

const ICON_DIR = join(resolve(import.meta.dirname, '..'), 'icons');
const SIZES = [16, 32, 48, 128];
/** Samples per pixel along each axis. */
const SUPERSAMPLING = 8;

const GRAPHITE = [0x1c, 0x1d, 0x20];
const AMBER = [0xff, 0xb2, 0x24];
const AMBER_SHADE = [0xb8, 0x77, 0x00];
const FLANGE = [0xe6, 0xe7, 0xea];
const WHITE = [0xff, 0xff, 0xff];

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * @typedef {{ x: number, y: number }} Point
 * @typedef {{ left: number, top: number, right: number, bottom: number }} Box
 * @typedef {Object} Shape
 * @property {(p: Point) => boolean} contains  Point in the shape, in design units.
 * @property {number[]} color  RGB, 0 to 255.
 * @property {number} alpha    0 to 1.
 */

// ---------------------------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------------------------

/**
 * @param {number} x
 * @param {number} y
 * @param {number} width
 * @param {number} height
 * @returns {Box}
 */
function box(x, y, width, height) {
  return { left: x, top: y, right: x + width, bottom: y + height };
}

/** @param {Point} p @param {Box} b @param {number} radius @returns {boolean} */
function inRoundedRect(p, { left, top, right, bottom }, radius) {
  const dx = Math.max(left + radius - p.x, 0, p.x - (right - radius));
  const dy = Math.max(top + radius - p.y, 0, p.y - (bottom - radius));
  return dx * dx + dy * dy <= radius * radius;
}

/**
 * @param {Box} b
 * @param {number} radius
 * @param {number[]} color
 * @param {number} [alpha]
 * @returns {Shape}
 */
function fillRect(b, radius, color, alpha = 1) {
  return { contains: (p) => inRoundedRect(p, b, radius), color, alpha };
}

/**
 * A stroke of `width` centered on the edge of a rounded rectangle.
 * @param {Box} b The path of the stroke.
 * @param {number} radius
 * @param {number} width
 * @param {number[]} color
 * @param {number} alpha
 * @returns {Shape}
 */
function strokeRect(b, radius, width, color, alpha) {
  const h = width / 2;
  const outer = { left: b.left - h, top: b.top - h, right: b.right + h, bottom: b.bottom + h };
  const inner = { left: b.left + h, top: b.top + h, right: b.right - h, bottom: b.bottom - h };
  return {
    contains: (p) =>
      inRoundedRect(p, outer, radius + h) && !inRoundedRect(p, inner, Math.max(0, radius - h)),
    color,
    alpha,
  };
}

/** @param {Point} p @param {Point} a @param {Point} b @returns {number} Distance to segment ab. */
function distanceToSegment(p, a, b) {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / (abx * abx + aby * aby);
  const clamped = Math.min(1, Math.max(0, t));
  return Math.hypot(p.x - (a.x + clamped * abx), p.y - (a.y + clamped * aby));
}

/**
 * Distance to the quarter circle that runs from the top of the circle (12 o'clock) to its
 * right side (3 o'clock).
 * @param {Point} p
 * @param {Point} center
 * @param {number} radius
 * @returns {number}
 */
function distanceToQuarterArc(p, center, radius) {
  const dx = p.x - center.x;
  const dy = p.y - center.y;
  if (dx >= 0 && dy <= 0) return Math.abs(Math.hypot(dx, dy) - radius);
  return Math.min(
    Math.hypot(dx, dy + radius), // the top end
    Math.hypot(dx - radius, dy), // the right end
  );
}

/**
 * The thread: a line to the right, a quarter turn down, a line down. The stroke has round caps
 * and a round join, so it is every point within half the width of the path.
 * @param {{ from: Point, turnAt: number, radius: number, to: number, width: number }} thread
 *   `from` is the start. The line runs right to x = `turnAt`, turns down on a circle of
 *   `radius`, and ends at y = `to`.
 * @returns {Shape}
 */
function roundThread({ from, turnAt, radius, to, width }) {
  const corner = { x: turnAt + radius, y: from.y + radius };
  const half = width / 2;
  const top = { x: turnAt, y: from.y };
  const bottom = { x: corner.x, y: to };
  const center = { x: turnAt, y: from.y + radius };
  return {
    contains: (p) =>
      Math.min(
        distanceToSegment(p, from, top),
        distanceToQuarterArc(p, center, radius),
        distanceToSegment(p, { x: corner.x, y: corner.y }, bottom),
      ) <= half,
    color: AMBER,
    alpha: 1,
  };
}

/**
 * Union of boxes, for strokes with butt caps and a sharp corner.
 * @param {Box[]} boxes
 * @param {number[]} color
 * @returns {Shape}
 */
function unionOf(boxes, color) {
  return {
    contains: (p) =>
      boxes.some((b) => p.x >= b.left && p.x < b.right && p.y >= b.top && p.y < b.bottom),
    color,
    alpha: 1,
  };
}

// ---------------------------------------------------------------------------------------------
// The three drawings (design units = pixels of the drawing's viewBox)
// ---------------------------------------------------------------------------------------------

/** @returns {{ units: number, shapes: Shape[] }} For 128 px, and for 48 px (scaled). */
function drawLarge() {
  const shapes = [
    fillRect(box(0, 0, 128, 128), 28, GRAPHITE),
    strokeRect(box(1, 1, 126, 126), 27, 2, WHITE, 0.12),
    fillRect(box(30, 38, 60, 52), 0, AMBER),
    ...[47, 56, 65, 74, 83].map((y) => fillRect(box(30, y - 1, 60, 2), 0, AMBER_SHADE, 0.45)),
    fillRect(box(22, 26, 76, 14), 7, FLANGE),
    fillRect(box(22, 88, 76, 14), 7, FLANGE),
    roundThread({ from: { x: 90, y: 79 }, turnAt: 99, radius: 8, to: 114, width: 6 }),
  ];
  return { units: 128, shapes };
}

/** @returns {{ units: number, shapes: Shape[] }} For 32 px. */
function drawMedium() {
  const shapes = [
    fillRect(box(0, 0, 32, 32), 7, GRAPHITE),
    strokeRect(box(0.5, 0.5, 31, 31), 6.5, 1, WHITE, 0.14),
    fillRect(box(7, 9, 15, 14), 0, AMBER),
    fillRect(box(7, 13, 15, 1), 0, AMBER_SHADE, 0.5),
    fillRect(box(7, 18, 15, 1), 0, AMBER_SHADE, 0.5),
    fillRect(box(5, 6, 19, 4), 2, FLANGE),
    fillRect(box(5, 22, 19, 4), 2, FLANGE),
    roundThread({ from: { x: 22, y: 19.5 }, turnAt: 24.5, radius: 2.5, to: 27.5, width: 2 }),
  ];
  return { units: 32, shapes };
}

/** @returns {{ units: number, shapes: Shape[] }} For 16 px. */
function drawSmall() {
  const shapes = [
    fillRect(box(0, 0, 16, 16), 4, GRAPHITE),
    strokeRect(box(0.5, 0.5, 15, 15), 3.5, 1, WHITE, 0.16),
    fillRect(box(3, 4, 8, 8), 0, AMBER),
    fillRect(box(2, 3, 10, 2), 1, FLANGE),
    fillRect(box(2, 11, 10, 2), 1, FLANGE),
    // The thread: 1 px wide, butt caps, a sharp corner (path "M11 9.5 H13.5 V14").
    unionOf([box(11, 9, 3, 1), box(13, 9, 1, 5)], AMBER),
  ];
  return { units: 16, shapes };
}

/** @param {number} size @returns {{ units: number, shapes: Shape[] }} */
function drawingFor(size) {
  if (size <= 16) return drawSmall();
  if (size <= 32) return drawMedium();
  return drawLarge();
}

// ---------------------------------------------------------------------------------------------
// Rasterizer and PNG writer
// ---------------------------------------------------------------------------------------------

/** @param {number} size @returns {Buffer} RGBA pixels with straight (not premultiplied) alpha. */
function render(size) {
  const { units, shapes } = drawingFor(size);
  const rgba = Buffer.alloc(size * size * 4);
  const samples = SUPERSAMPLING * SUPERSAMPLING;
  for (let py = 0; py < size; py++) {
    for (let px = 0; px < size; px++) {
      // Premultiplied sums over the samples of this pixel.
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SUPERSAMPLING; sy++) {
        for (let sx = 0; sx < SUPERSAMPLING; sx++) {
          const point = {
            x: ((px + (sx + 0.5) / SUPERSAMPLING) / size) * units,
            y: ((py + (sy + 0.5) / SUPERSAMPLING) / size) * units,
          };
          let sr = 0;
          let sg = 0;
          let sb = 0;
          let sa = 0;
          for (const shape of shapes) {
            if (!shape.contains(point)) continue;
            const keep = 1 - shape.alpha;
            sr = (shape.color[0] ?? 0) * shape.alpha + sr * keep;
            sg = (shape.color[1] ?? 0) * shape.alpha + sg * keep;
            sb = (shape.color[2] ?? 0) * shape.alpha + sb * keep;
            sa = shape.alpha + sa * keep;
          }
          r += sr;
          g += sg;
          b += sb;
          a += sa;
        }
      }
      if (a === 0) continue;
      const offset = (py * size + px) * 4;
      rgba[offset] = Math.round(r / a);
      rgba[offset + 1] = Math.round(g / a);
      rgba[offset + 2] = Math.round(b / a);
      rgba[offset + 3] = Math.round((255 * a) / samples);
    }
  }
  return rgba;
}

/** @param {string} type @param {Buffer} data @returns {Buffer} One PNG chunk with its CRC. */
function pngChunk(type, data) {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 'ascii');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(chunk.subarray(4, 8 + data.length)), 8 + data.length);
  return chunk;
}

/** @param {number} size @param {Buffer} rgba @returns {Buffer} A square RGBA PNG file. */
function encodePng(size, rgba) {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // color type: RGBA. Compression, filter and interlace stay 0.

  const stride = size * 4;
  const scanlines = Buffer.alloc((stride + 1) * size); // each row starts with filter type 0
  for (let y = 0; y < size; y++) {
    rgba.copy(scanlines, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', header),
    pngChunk('IDAT', deflateSync(scanlines, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(ICON_DIR, { recursive: true });
for (const size of SIZES) {
  const png = encodePng(size, render(size));
  writeFileSync(join(ICON_DIR, `icon-${size}.png`), png);
  console.log(`icons/icon-${size}.png: ${png.length} bytes`);
}
