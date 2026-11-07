// @ts-check
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32, deflateSync } from 'node:zlib';
import { crc32, createPngEncoder } from '../../src/lib/png-stream.js';
import { decodePng } from '../helpers/png-decode.js';

/**
 * Small seeded random generator (mulberry32), so every run sees the same images.
 * @param {number} seed
 * @returns {() => number}  Floats in [0, 1).
 */
function createRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * RGBA noise. Alpha is random too, so a test notices if the encoder keeps it.
 * @param {number} width
 * @param {number} height
 * @param {number} seed
 * @returns {Uint8Array}
 */
function noiseImage(width, height, seed) {
  const random = createRandom(seed);
  return Uint8Array.from({ length: width * height * 4 }, () => Math.floor(random() * 256));
}

/**
 * RGBA image made of horizontal bands, each one built to favour one filter:
 * 0 flat black (None), 1 horizontal gradient with a random start per row (Sub; Paeth predicts
 * the same bytes there, so the two compete), 2 vertical gradient over random columns (Up),
 * 3 horizontal stripes on the left half and vertical stripes on the right half (Paeth),
 * 4 noise. Alpha is random.
 * @param {number} width
 * @param {number} height
 * @param {number} seed
 * @param {number} bandHeight
 * @returns {Uint8Array}
 */
function bandedImage(width, height, seed, bandHeight) {
  const random = createRandom(seed);
  const byte = () => Math.floor(random() * 256);
  const column = Uint8Array.from({ length: width * 3 }, byte);
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    const kind = Math.floor(y / bandHeight) % 5;
    const rowValue = [byte(), byte(), byte()];
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        if (kind === 0) rgba[i + ch] = 0;
        else if (kind === 1) rgba[i + ch] = 2 * x + rowValue[ch];
        else if (kind === 2) rgba[i + ch] = column[x * 3 + ch] + 3 * y;
        else if (kind === 3) rgba[i + ch] = x < width / 2 ? rowValue[ch] : column[x * 3 + ch];
        else rgba[i + ch] = byte();
      }
      rgba[i + 3] = byte();
    }
  }
  return rgba;
}

/**
 * Encodes with `writeRows` calls of the given sizes (repeated in a cycle) and returns the file.
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array | Uint8ClampedArray} rgba
 * @param {number[]} rowsPerCall
 * @returns {Promise<Uint8Array>}
 */
async function encode(width, height, rgba, rowsPerCall) {
  const encoder = createPngEncoder({ width, height });
  for (let row = 0, call = 0; row < height; call++) {
    const rows = Math.min(rowsPerCall[call % rowsPerCall.length], height - row);
    await encoder.writeRows(rgba.subarray(row * width * 4, (row + rows) * width * 4), rows);
    row += rows;
  }
  const blob = await encoder.finish();
  assert.equal(blob.type, 'image/png');
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Decodes `file` and checks that it holds exactly the RGB part of `rgba`.
 * @param {Uint8Array} file
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array | Uint8ClampedArray} rgba
 * @returns {import('../helpers/png-decode.js').DecodedPng}
 */
function decodeAndCompare(file, width, height, rgba) {
  const png = decodePng(file);
  assert.deepEqual([png.width, png.height, png.channels], [width, height, 3]);
  const expected = new Uint8Array(width * height * 3);
  for (let p = 0; p < width * height; p++) {
    expected[3 * p] = rgba[4 * p];
    expected[3 * p + 1] = rgba[4 * p + 1];
    expected[3 * p + 2] = rgba[4 * p + 2];
  }
  if (Buffer.compare(png.data, expected) !== 0) {
    const at = png.data.findIndex((v, i) => v !== expected[i]);
    assert.fail(`pixels differ, first at RGB byte ${at}: ${png.data[at]} !== ${expected[at]}`);
  }
  return png;
}

describe('crc32', () => {
  const bytesOf = (/** @type {string} */ text) => new TextEncoder().encode(text);

  test('matches known vectors', () => {
    assert.equal(crc32(new Uint8Array(0)), 0);
    assert.equal(crc32(bytesOf('123456789')), 0xcbf43926);
    assert.equal(crc32(bytesOf('a')), 0xe8b7be43);
    assert.equal(crc32(bytesOf('The quick brown fox jumps over the lazy dog')), 0x414fa339);
    assert.equal(crc32(new Uint8Array(32)), 0x190a55ad);
  });

  test('returns an unsigned number', () => {
    const value = crc32(bytesOf('123456789'));
    assert.ok(value > 0x7fffffff && value <= 0xffffffff);
  });

  test('continues from a seed: crc32(b, crc32(a)) equals crc32(a + b)', () => {
    const whole = bytesOf('123456789');
    for (let split = 0; split <= whole.length; split++) {
      const head = whole.subarray(0, split);
      const tail = whole.subarray(split);
      assert.equal(crc32(tail, crc32(head)), 0xcbf43926, `split at ${split}`);
    }
  });

  test('agrees with node:zlib on random data, also for views into a larger buffer', () => {
    const data = noiseImage(100, 100, 1);
    assert.equal(crc32(data), zlibCrc32(data));
    assert.equal(crc32(data.subarray(13, 9001)), zlibCrc32(data.subarray(13, 9001)));
    assert.equal(crc32(data.subarray(500), 12345), zlibCrc32(data.subarray(500), 12345));
  });

  test('accepts the largest seed (2^32 - 1) and refuses 2^32', () => {
    const data = bytesOf('123456789');
    assert.equal(crc32(new Uint8Array(0), 0xffffffff), 0xffffffff);
    assert.equal(crc32(data, 0xffffffff), zlibCrc32(data, 0xffffffff));
    assert.throws(() => crc32(data, 0x100000000), /seed must be an integer from 0 to 4294967295/);
  });

  test('rejects bad arguments', () => {
    assert.throws(() => crc32(/** @type {any} */ ([1, 2, 3])), TypeError);
    assert.throws(() => crc32(new Uint8Array(1), -1), RangeError);
    assert.throws(() => crc32(new Uint8Array(1), 2 ** 32), RangeError);
    assert.throws(() => crc32(new Uint8Array(1), 1.5), RangeError);
    assert.throws(() => crc32(new Uint8Array(1), /** @type {any} */ ('0')), TypeError);
  });
});

describe('createPngEncoder round trip', () => {
  /** @type {[number, number][]} */
  const sizes = [
    [1, 1],
    [1, 50],
    [50, 1],
    [7, 13],
    [300, 200],
  ];
  for (const [width, height] of sizes) {
    test(`${width}x${height}: one call, then one row per call`, async () => {
      const rgba = noiseImage(width, height, width * 1000 + height);
      decodeAndCompare(await encode(width, height, rgba, [height]), width, height, rgba);
      decodeAndCompare(await encode(width, height, rgba, [1]), width, height, rgba);
    });

    test(`${width}x${height}: banded content in uneven calls`, async () => {
      const rgba = bandedImage(width, height, 5, 4);
      decodeAndCompare(await encode(width, height, rgba, [3, 1, 5, 2]), width, height, rgba);
    });
  }

  test('1500x6000 in uneven calls of 1, 17, 333 rows and more', async () => {
    const width = 1500;
    const height = 6000;
    const rgba = bandedImage(width, height, 77, 300);
    const file = await encode(width, height, rgba, [1, 17, 333, 1000, 2, 4096, 64]);
    decodeAndCompare(file, width, height, rgba);
  });

  test('accepts a Uint8ClampedArray, as ImageData.data is one', async () => {
    const rgba = noiseImage(20, 9, 3);
    const clamped = new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.length);
    decodeAndCompare(await encode(20, 9, clamped, [4]), 20, 9, rgba);
  });

  test('writes a valid file layout: signature, IHDR, IDAT chunks, IEND', async () => {
    const file = await encode(10, 10, noiseImage(10, 10, 4), [10]);
    assert.deepEqual([...file.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
    const { chunks } = decodePng(file);
    assert.equal(chunks[0]?.type, 'IHDR');
    assert.equal(chunks[0]?.length, 13);
    assert.equal(chunks[chunks.length - 1]?.type, 'IEND');
    assert.ok(chunks.slice(1, -1).length >= 1);
    assert.ok(chunks.slice(1, -1).every((chunk) => chunk.type === 'IDAT'));
  });

  test('splits large output into IDAT chunks of at most 1 MiB', async () => {
    // Noise does not compress, so 800x600 RGB (1.4 MB) needs at least two chunks.
    const rgba = noiseImage(800, 600, 6);
    const file = await encode(800, 600, rgba, [100]);
    const { chunks } = decodeAndCompare(file, 800, 600, rgba);
    const idat = chunks.filter((chunk) => chunk.type === 'IDAT');
    assert.ok(idat.length >= 2, `only ${idat.length} IDAT chunk(s)`);
    assert.ok(idat.every((chunk) => chunk.length <= 1024 * 1024));
    // Every chunk but the last one is full: the output is cut by size, not after every read.
    const total = idat.reduce((sum, chunk) => sum + chunk.length, 0);
    assert.equal(idat.length, Math.ceil(total / (1024 * 1024)), 'number of IDAT chunks');
    for (const chunk of idat.slice(0, -1)) assert.equal(chunk.length, 1024 * 1024);
  });
});

describe('createPngEncoder filters', () => {
  /**
   * The PNG filters, written out from the specification for the checks below.
   * @param {number} type
   * @param {Uint8Array} row
   * @param {Uint8Array} prev
   * @returns {Uint8Array}
   */
  function filterReference(type, row, prev) {
    const out = new Uint8Array(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= 3 ? row[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      let predictor = 0;
      if (type === 1) predictor = a;
      if (type === 2) predictor = b;
      if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = row[i] - predictor;
    }
    return out;
  }

  /** @param {Uint8Array} bytes */
  const absoluteSum = (bytes) => new Int8Array(bytes.buffer).reduce((s, v) => s + Math.abs(v), 0);

  test('picks the filter with the smallest sum of absolute signed bytes in every row', async () => {
    const width = 120;
    const height = 120;
    const rgba = bandedImage(width, height, 9, 24);
    const png = decodeAndCompare(await encode(width, height, rgba, [7]), width, height, rgba);
    const stride = width * 3;
    for (let y = 0; y < height; y++) {
      const row = png.data.subarray(y * stride, (y + 1) * stride);
      const prev = y > 0 ? png.data.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
      let best = 0;
      let bestSum = absoluteSum(filterReference(0, row, prev));
      for (const type of [1, 2, 4]) {
        const sum = absoluteSum(filterReference(type, row, prev));
        if (sum < bestSum) {
          best = type;
          bestSum = sum;
        }
      }
      assert.equal(png.filters[y], best, `row ${y}`);
    }
  });

  test('uses None, Sub, Up and Paeth where their bands call for them, not Average', async () => {
    const width = 120;
    const height = 120;
    const rgba = bandedImage(width, height, 9, 24);
    const png = decodeAndCompare(await encode(width, height, rgba, [24]), width, height, rgba);
    assert.deepEqual([...new Set(png.filters)].sort(), [0, 1, 2, 4]);
    /** @param {number} band @param {number} filter */
    const rowsWith = (band, filter) =>
      [...png.filters.subarray(band * 24 + 1, (band + 1) * 24)].filter((f) => f === filter).length;
    assert.ok(rowsWith(0, 0) >= 23, 'flat black band');
    assert.ok(rowsWith(1, 1) >= 10, 'horizontal gradient band');
    assert.ok(rowsWith(2, 2) >= 20, 'vertical gradient band');
    assert.ok(rowsWith(3, 4) >= 20, 'mixed stripes band');
  });

  test('flat white uses Sub for the first row and Up after it, flat black uses None', async () => {
    const white = new Uint8Array(8 * 6 * 4).fill(255);
    const whitePng = decodeAndCompare(await encode(8, 6, white, [6]), 8, 6, white);
    assert.deepEqual([...whitePng.filters], [1, 2, 2, 2, 2, 2]);
    const black = new Uint8Array(8 * 6 * 4);
    for (let i = 3; i < black.length; i += 4) black[i] = 255;
    const blackPng = decodeAndCompare(await encode(8, 6, black, [6]), 8, 6, black);
    assert.deepEqual([...blackPng.filters], [0, 0, 0, 0, 0, 0]);
  });
});

describe('createPngEncoder errors', () => {
  const row = new Uint8Array(4 * 4);

  test('createPngEncoder rejects bad options', () => {
    assert.throws(() => createPngEncoder(/** @type {any} */ (undefined)), TypeError);
    const stringWidth = /** @type {any} */ ({ width: '4', height: 4 });
    assert.throws(() => createPngEncoder(stringWidth), TypeError);
    assert.throws(() => createPngEncoder({ width: 0, height: 4 }), RangeError);
    assert.throws(() => createPngEncoder({ width: 4, height: -1 }), RangeError);
    assert.throws(() => createPngEncoder({ width: 4.5, height: 4 }), RangeError);
    assert.throws(() => createPngEncoder({ width: 2 ** 31, height: 4 }), RangeError);
  });

  test('finish rejects while rows are missing, and the encoder stays usable', async () => {
    const encoder = createPngEncoder({ width: 4, height: 4 });
    await assert.rejects(encoder.finish(), { name: 'RangeError', message: /0 of 4 rows/ });
    await encoder.writeRows(new Uint8Array(4 * 4 * 3), 3);
    await assert.rejects(encoder.finish(), { name: 'RangeError', message: /3 of 4 rows/ });
    await encoder.writeRows(row, 1);
    const png = decodePng(new Uint8Array(await (await encoder.finish()).arrayBuffer()));
    assert.equal(png.height, 4);
  });

  test('writeRows rejects a wrong byte length', async () => {
    const encoder = createPngEncoder({ width: 4, height: 4 });
    await assert.rejects(encoder.writeRows(new Uint8Array(15), 1), RangeError);
    await assert.rejects(encoder.writeRows(new Uint8Array(17), 1), RangeError);
    await assert.rejects(encoder.writeRows(row, 2), RangeError);
    await assert.rejects(encoder.writeRows(new Uint8Array(4 * 3), 1), RangeError);
    await assert.rejects(encoder.writeRows(new Uint8Array(0), 1), RangeError);
  });

  test('writeRows rejects bad types and row counts', async () => {
    const encoder = createPngEncoder({ width: 4, height: 4 });
    await assert.rejects(encoder.writeRows(/** @type {any} */ ([...row]), 1), TypeError);
    await assert.rejects(encoder.writeRows(row, /** @type {any} */ ('1')), TypeError);
    await assert.rejects(encoder.writeRows(new Uint8Array(0), 0), RangeError);
    await assert.rejects(encoder.writeRows(row, -1), RangeError);
    await assert.rejects(encoder.writeRows(row, 0.5), RangeError);
  });

  test('writeRows rejects rows past the image height, and the encoder stays usable', async () => {
    const encoder = createPngEncoder({ width: 4, height: 4 });
    await assert.rejects(encoder.writeRows(new Uint8Array(4 * 4 * 5), 5), RangeError);
    await encoder.writeRows(new Uint8Array(4 * 4 * 3), 3);
    await assert.rejects(encoder.writeRows(new Uint8Array(4 * 4 * 2), 2), RangeError);
    await encoder.writeRows(row, 1);
    await assert.rejects(encoder.writeRows(row, 1), RangeError);
    assert.equal(decodePng(new Uint8Array(await (await encoder.finish()).arrayBuffer())).height, 4);
  });

  test('calls must not overlap, and nothing works after finish', async () => {
    const encoder = createPngEncoder({ width: 4, height: 4 });
    const first = encoder.writeRows(row, 1);
    const second = encoder.writeRows(row, 1);
    const early = encoder.finish();
    await assert.rejects(second, /Await each/);
    await assert.rejects(early, /Await each/);
    await first;
    await encoder.writeRows(new Uint8Array(4 * 4 * 3), 3);
    await encoder.finish();
    await assert.rejects(encoder.finish(), /already finished/);
    await assert.rejects(encoder.writeRows(row, 1), /already finished/);
  });
});

describe('createPngEncoder: calls that fail leave the image as it was', () => {
  test('rejected calls leave no trace in the image', async () => {
    const width = 4;
    const height = 4;
    const rgba = noiseImage(width, height, 12);
    const rowBytes = width * 4;
    const encoder = createPngEncoder({ width, height });
    await assert.rejects(encoder.writeRows(rgba.subarray(0, rowBytes - 1), 1), RangeError);
    await encoder.writeRows(rgba.subarray(0, 2 * rowBytes), 2);
    // Too many rows, a wrong byte length, and a finish with rows missing.
    await assert.rejects(encoder.writeRows(rgba.subarray(0, 5 * rowBytes), 5), RangeError);
    await assert.rejects(encoder.writeRows(rgba.subarray(0, rowBytes), 2), RangeError);
    await assert.rejects(encoder.writeRows(/** @type {any} */ ('x'), 1), TypeError);
    await assert.rejects(encoder.finish(), RangeError);
    await encoder.writeRows(rgba.subarray(2 * rowBytes), 2);
    const file = new Uint8Array(await (await encoder.finish()).arrayBuffer());
    decodeAndCompare(file, width, height, rgba);
  });

  test('a call that overlaps another one is refused and writes nothing', async () => {
    const rgba = noiseImage(4, 4, 13);
    const encoder = createPngEncoder({ width: 4, height: 4 });
    const first = encoder.writeRows(rgba.subarray(0, 16), 1);
    const second = encoder.writeRows(rgba.subarray(16, 32), 1);
    const early = encoder.finish();
    await assert.rejects(second, /Await each/);
    await assert.rejects(early, /Await each/);
    await first;
    await encoder.writeRows(rgba.subarray(16), 3);
    const file = new Uint8Array(await (await encoder.finish()).arrayBuffer());
    decodeAndCompare(file, 4, 4, rgba);
  });

  test('a call during finish() is refused as an overlapping call', async () => {
    const rgba = noiseImage(4, 1, 14);
    const encoder = createPngEncoder({ width: 4, height: 1 });
    await encoder.writeRows(rgba, 1);
    const finishing = encoder.finish();
    const write = encoder.writeRows(rgba, 1);
    const second = encoder.finish();
    await assert.rejects(write, /Await each/);
    await assert.rejects(second, /Await each/);
    decodeAndCompare(new Uint8Array(await (await finishing).arrayBuffer()), 4, 1, rgba);
  });

  test('names the argument that is not valid', async () => {
    assert.throws(
      () => createPngEncoder({ width: 0, height: 4 }),
      /^RangeError: width must be an integer from 1 to 2147483647/,
    );
    assert.throws(
      () => createPngEncoder({ width: 4, height: 0 }),
      /^RangeError: height must be an integer from 1 to 2147483647/,
    );
    assert.throws(
      () => createPngEncoder(/** @type {any} */ ({ width: 4, height: '4' })),
      /^TypeError: height must be a number/,
    );
    assert.throws(
      () => createPngEncoder(/** @type {any} */ (null)),
      /^TypeError: options must be an object/,
    );
    const encoder = createPngEncoder({ width: 4, height: 4 });
    await assert.rejects(encoder.writeRows(new Uint8Array(16), 0), /rowCount must be an integer/);
    await assert.rejects(
      encoder.writeRows(new Uint8Array(15), 1),
      /rowCount \* width \* 4 = 16 bytes/,
    );
    await assert.rejects(
      encoder.writeRows(new Uint8Array(80), 5),
      /Writing 5 rows exceeds the image height of 4/,
    );
    await assert.rejects(
      encoder.writeRows(/** @type {any} */ ([1, 2, 3, 4]), 1),
      /^TypeError: rgba must be a Uint8Array or a Uint8ClampedArray/,
    );
  });
});

describe('createPngEncoder: size limits', () => {
  test('accepts the largest PNG height and refuses one more', () => {
    assert.doesNotThrow(() => createPngEncoder({ width: 1, height: 2 ** 31 - 1 }));
    assert.throws(() => createPngEncoder({ width: 1, height: 2 ** 31 }), RangeError);
    assert.throws(() => createPngEncoder({ width: 2 ** 31, height: 1 }), RangeError);
  });

  test('refuses a height of 0 and a width of 0', () => {
    assert.throws(() => createPngEncoder({ width: 4, height: 0 }), RangeError);
    assert.throws(() => createPngEncoder({ width: 0, height: 4 }), RangeError);
  });

  test('encodes rows that are wider than one batch of the compressor', async () => {
    // One row of 349526 pixels is 1,048,579 filtered bytes: more than the 1 MiB that goes to
    // the compressor in one write. Such a row must still go through, one row at a time.
    const width = 349_526;
    const height = 2;
    const rgba = bandedImage(width, height, 21, 1);
    const file = await encode(width, height, rgba, [1, 1]);
    decodeAndCompare(file, width, height, rgba);
  });
});

describe('createPngEncoder: filter choice on small images', () => {
  /**
   * The PNG filters, written out from the specification.
   * @param {number} type
   * @param {Uint8Array} row
   * @param {Uint8Array} prev
   * @returns {Uint8Array}
   */
  function filtered(type, row, prev) {
    const out = new Uint8Array(row.length);
    for (let i = 0; i < row.length; i++) {
      const a = i >= 3 ? row[i - 3] : 0;
      const b = prev[i];
      const c = i >= 3 ? prev[i - 3] : 0;
      let predictor = 0;
      if (type === 1) predictor = a;
      if (type === 2) predictor = b;
      if (type === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        predictor = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      out[i] = row[i] - predictor;
    }
    return out;
  }

  /** @param {Uint8Array} bytes  @returns {number} Sum of the absolute values of signed bytes. */
  const cost = (bytes) => Array.from(bytes, (v) => Math.abs(v << 24 >> 24)).reduce((a, b) => a + b, 0);

  /** @param {Uint8Array} row @param {Uint8Array} prev @returns {number} */
  function bestFilter(row, prev) {
    let best = 0;
    let bestCost = cost(filtered(0, row, prev));
    for (const type of [1, 2, 4]) {
      const next = cost(filtered(type, row, prev));
      if (next < bestCost) {
        best = type;
        bestCost = next;
      }
    }
    return best;
  }

  test('picks the cheapest filter for 400 seeded images of a few distinct values', async () => {
    // Few distinct values near 0, 127/128 and 255 make ties and one-point differences between
    // the four filters common, and they make bytes of both signs appear in the filtered rows.
    const random = createRandom(2468);
    const palette = [0, 1, 2, 3, 126, 127, 128, 129, 130, 253, 254, 255];
    const seen = new Set();
    for (let round = 0; round < 400; round++) {
      const width = 1 + Math.floor(random() * 4);
      const height = 2 + Math.floor(random() * 3);
      const values = Array.from({ length: 2 + Math.floor(random() * 3) }, () => {
        return palette[Math.floor(random() * palette.length)] ?? 0;
      });
      const rgba = Uint8Array.from({ length: width * height * 4 }, (_, i) =>
        i % 4 === 3 ? 255 : (values[Math.floor(random() * values.length)] ?? 0),
      );
      const png = decodeAndCompare(await encode(width, height, rgba, [height]), width, height, rgba);
      const stride = width * 3;
      for (let y = 0; y < height; y++) {
        const row = png.data.subarray(y * stride, (y + 1) * stride);
        const prev = y > 0 ? png.data.subarray((y - 1) * stride, y * stride) : new Uint8Array(stride);
        assert.equal(png.filters[y], bestFilter(row, prev), `round ${round}, row ${y}`);
        seen.add(png.filters[y]);
      }
    }
    assert.deepEqual([...seen].sort(), [0, 1, 2, 4], 'every filter was chosen at least once');
  });

  test('weighs a filtered byte by its signed size: 127 costs 127 and 129 costs 127', async () => {
    // One pixel wide, two rows. Row 2 is (127, 100, 0) over row 1 (1, 0, 2).
    // None and Sub: 127 + 100 + 0 = 227. Up and Paeth: 126 + 100 + 2 = 228. None wins by 1.
    // If the byte 127 were weighed as 129, the cost of None would be 229 and Up would win.
    const rgba = Uint8Array.of(1, 0, 2, 255, 127, 100, 0, 255);
    const png = decodeAndCompare(await encode(1, 2, rgba, [2]), 1, 2, rgba);
    assert.equal(png.filters[1], 0);
  });
});

describe('createPngEncoder: IDAT chunks and a compressor of our own', () => {
  const MIB = 1024 * 1024;

  /**
   * The output of a compressor that was cut into these chunk sizes, as one byte array.
   * @param {number[]} sizes
   * @returns {Uint8Array[]}
   */
  function pieces(sizes) {
    let offset = 0;
    return sizes.map((size) => {
      const piece = new Uint8Array(size);
      for (let i = 0; i < size; i++) piece[i] = (offset + i) % 251;
      offset += size;
      return piece;
    });
  }

  /**
   * A stand-in for `new CompressionStream('deflate')`. It ignores what it is given. When its
   * writable side closes, it hands out `output` through its readable side, after `delayMs`.
   * @param {Uint8Array[]} output
   * @param {number} [delayMs]
   */
  function fakeCompressor(output, delayMs = 0) {
    /** @type {ReadableStreamDefaultController<Uint8Array>} */
    let controller;
    const readable = new ReadableStream({
      start(c) {
        controller = c;
      },
    });
    const writable = new WritableStream({
      write() {},
      close() {
        const send = () => {
          for (const piece of output) controller.enqueue(piece);
          controller.close();
        };
        if (delayMs > 0) setTimeout(send, delayMs);
        else send();
      },
    });
    return { readable, writable };
  }

  /**
   * Runs `body` with `CompressionStream` replaced, and puts the real one back.
   * @template T
   * @param {() => { readable: ReadableStream, writable: WritableStream }} make
   * @param {() => Promise<T>} body
   * @returns {Promise<T>}
   */
  async function withCompressor(make, body) {
    const global = /** @type {any} */ (globalThis);
    const original = global.CompressionStream;
    global.CompressionStream = class {
      constructor() {
        Object.assign(this, make());
      }
    };
    try {
      return await body();
    } finally {
      global.CompressionStream = original;
    }
  }

  /**
   * Splits a PNG file into its chunks and checks the length and the CRC of each one.
   * @param {Uint8Array} file
   * @returns {{ type: string, data: Uint8Array }[]}
   */
  function readChunks(file) {
    const view = new DataView(file.buffer, file.byteOffset, file.byteLength);
    const chunks = [];
    for (let at = 8; at < file.length; ) {
      const length = view.getUint32(at);
      const type = new TextDecoder().decode(file.subarray(at + 4, at + 8));
      const data = file.subarray(at + 8, at + 8 + length);
      assert.equal(view.getUint32(at + 8 + length), zlibCrc32(file.subarray(at + 4, at + 8 + length)), type);
      chunks.push({ type, data });
      at += 12 + length;
    }
    return chunks;
  }

  /**
   * Encodes one pixel with the given fake compressor output.
   * @param {Uint8Array[]} output
   * @param {number} [delayMs]
   */
  async function encodeWith(output, delayMs = 0) {
    return withCompressor(
      () => fakeCompressor(output, delayMs),
      async () => {
        const encoder = createPngEncoder({ width: 1, height: 1 });
        await encoder.writeRows(Uint8Array.of(1, 2, 3, 255), 1);
        return readChunks(new Uint8Array(await (await encoder.finish()).arrayBuffer()));
      },
    );
  }

  /** @param {{ type: string, data: Uint8Array }[]} chunks @returns {number[]} */
  const idatLengths = (chunks) =>
    chunks.filter((chunk) => chunk.type === 'IDAT').map((chunk) => chunk.data.length);

  /** @param {Uint8Array[]} list @returns {Buffer} */
  const concat = (list) => Buffer.concat(list);

  test('cuts the output into IDAT chunks of exactly 1 MiB, and one shorter at the end', async () => {
    // Reads of 700000, 700000, 900000 and 5 bytes: a chunk boundary falls inside a read.
    const output = pieces([700_000, 700_000, 900_000, 5]);
    const chunks = await encodeWith(output);
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IDAT', 'IDAT', 'IEND']);
    assert.deepEqual(idatLengths(chunks), [MIB, MIB, 2_300_005 - 2 * MIB]);
    const joined = concat(chunks.filter((c) => c.type === 'IDAT').map((c) => c.data));
    assert.ok(joined.equals(concat(output)), 'no byte lost or moved');
  });

  test('hands the compressor batches of at most 1 MiB, not a whole call at once', async () => {
    // docs/contracts.md section 4: "Memory: no full-image buffer". One call with 3.6 MB of
    // RGBA gives 2.7 MB of filtered rows. They must reach the compressor in several writes.
    const width = 300;
    const height = 3000;
    /** @type {number[]} */
    const writes = [];
    await withCompressor(
      () => {
        /** @type {ReadableStreamDefaultController<Uint8Array>} */
        let controller;
        const readable = new ReadableStream({
          start(c) {
            controller = c;
          },
        });
        const writable = new WritableStream({
          write(chunk) {
            writes.push(chunk.length);
          },
          close() {
            controller.enqueue(Uint8Array.of(1));
            controller.close();
          },
        });
        return { readable, writable };
      },
      async () => {
        const encoder = createPngEncoder({ width, height });
        await encoder.writeRows(new Uint8Array(width * height * 4), height);
        await encoder.finish();
      },
    );
    assert.equal(
      writes.reduce((sum, size) => sum + size, 0),
      height * (1 + width * 3),
      'every filtered byte is written once',
    );
    assert.ok(writes.length >= 3, `only ${writes.length} write(s)`);
    assert.ok(writes.every((size) => size <= MIB), `a write of ${Math.max(...writes)} bytes`);
  });

  test('writes no empty IDAT chunk when the output is an exact multiple of 1 MiB', async () => {
    const chunks = await encodeWith(pieces([MIB, MIB]));
    assert.deepEqual(idatLengths(chunks), [MIB, MIB]);
  });

  test('keeps a last chunk of one byte, and an output of one byte', async () => {
    assert.deepEqual(idatLengths(await encodeWith(pieces([MIB + 1]))), [MIB, 1]);
    assert.deepEqual(idatLengths(await encodeWith(pieces([1]))), [1]);
  });

  test('an output that arrives in many small reads gives the same chunks', async () => {
    const sizes = Array.from({ length: 300 }, (_, i) => 10_000 + (i % 7) * 777);
    const total = sizes.reduce((a, b) => a + b, 0);
    const chunks = await encodeWith(pieces(sizes));
    const lengths = idatLengths(chunks);
    assert.equal(lengths.length, Math.ceil(total / MIB));
    assert.ok(lengths.slice(0, -1).every((length) => length === MIB));
    assert.equal(lengths.reduce((a, b) => a + b, 0), total);
  });

  test('finish() waits for the compressor output that comes after it closed its input', async () => {
    // The readable side delivers 3 bytes 30 ms after the writable side closed. A file that is
    // built before that is missing its image data.
    const chunks = await encodeWith([Uint8Array.of(1, 2, 3)], 30);
    assert.deepEqual(chunks.map((chunk) => chunk.type), ['IHDR', 'IDAT', 'IEND']);
    assert.deepEqual([...(chunks[1]?.data ?? [])], [1, 2, 3]);
  });

  test('a failing compressor does not leave an unhandled rejection behind', async () => {
    /** @type {unknown[]} */
    const unhandled = [];
    const listener = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      await withCompressor(
        () => {
          const failure = new Error('compressor failed');
          /** @type {ReadableStreamDefaultController<Uint8Array>} */
          let controller;
          const readable = new ReadableStream({
            start(c) {
              controller = c;
            },
          });
          const writable = new WritableStream({
            write() {
              controller.error(failure);
              throw failure;
            },
          });
          return { readable, writable };
        },
        async () => {
          const encoder = createPngEncoder({ width: 1, height: 2 });
          await assert.rejects(encoder.writeRows(Uint8Array.of(1, 2, 3, 255), 1), /compressor failed/);
          // Nobody calls finish(). Give a rejected promise time to reach the process.
          await new Promise((resolve) => setImmediate(resolve));
          await new Promise((resolve) => setTimeout(resolve, 10));
        },
      );
    } finally {
      process.off('unhandledRejection', listener);
    }
    assert.deepEqual(unhandled, []);
  });
});

describe('PNG decoder helper (test infrastructure)', () => {
  /**
   * @param {string} type
   * @param {Uint8Array} data
   * @returns {Uint8Array}
   */
  function chunk(type, data) {
    const out = new Uint8Array(12 + data.length);
    const view = new DataView(out.buffer);
    view.setUint32(0, data.length);
    out.set(new TextEncoder().encode(type), 4);
    out.set(data, 8);
    view.setUint32(8 + data.length, zlibCrc32(out.subarray(4, 8 + data.length)));
    return out;
  }

  /**
   * @param {number} width
   * @param {number} height
   * @param {number} colorType
   * @param {Uint8Array} raw  Scanlines with their filter bytes.
   * @param {Uint8Array[]} [middle]  Chunks to put between IHDR and the image data.
   * @returns {Uint8Array[]}  Signature, IHDR, IDAT, IEND, as separate pieces.
   */
  function pngPieces(width, height, colorType, raw, middle = []) {
    const ihdr = new Uint8Array(13);
    const view = new DataView(ihdr.buffer);
    view.setUint32(0, width);
    view.setUint32(4, height);
    ihdr.set([8, colorType, 0, 0, 0], 8);
    return [
      Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
      chunk('IHDR', ihdr),
      ...middle,
      chunk('IDAT', deflateSync(raw)),
      chunk('IEND', new Uint8Array(0)),
    ];
  }

  /** @param {Uint8Array[]} pieces */
  const join = (pieces) => Uint8Array.from(pieces.flatMap((piece) => [...piece]));

  /**
   * Scanlines for `data`, each row with the filter type from `types`.
   * @param {Uint8Array} data
   * @param {number} stride
   * @param {number} bpp
   * @param {number[]} types
   * @returns {Uint8Array}
   */
  function scanlines(data, stride, bpp, types) {
    const rows = types.length;
    const raw = new Uint8Array(rows * (stride + 1));
    for (let y = 0; y < rows; y++) {
      raw[y * (stride + 1)] = types[y];
      for (let i = 0; i < stride; i++) {
        const x = data[y * stride + i];
        const a = i >= bpp ? data[y * stride + i - bpp] : 0;
        const b = y > 0 ? data[(y - 1) * stride + i] : 0;
        const c = y > 0 && i >= bpp ? data[(y - 1) * stride + i - bpp] : 0;
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const paeth = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        const predictor = [0, a, b, (a + b) >> 1, paeth][types[y]];
        raw[y * (stride + 1) + 1 + i] = x - predictor;
      }
    }
    return raw;
  }

  for (const [colorType, channels] of [[2, 3], [6, 4]]) {
    test(`decodes all five filter types, colour type ${colorType}`, () => {
      const width = 5;
      const types = [0, 1, 2, 3, 4, 4, 3, 2, 1, 0];
      const data = noiseImage(width, types.length, 8).subarray(0, width * types.length * channels);
      const raw = scanlines(data, width * channels, channels, types);
      const png = decodePng(join(pngPieces(width, types.length, colorType, raw)));
      assert.deepEqual([png.width, png.height, png.channels], [width, types.length, channels]);
      assert.deepEqual([...png.filters], types);
      assert.deepEqual([...png.data], [...data]);
    });
  }

  test('skips ancillary chunks and checks their CRC', () => {
    const raw = scanlines(Uint8Array.of(1, 2, 3), 3, 3, [0]);
    const text = chunk('tEXt', new TextEncoder().encode('Comment\0hello'));
    assert.deepEqual([...decodePng(join(pngPieces(1, 1, 2, raw, [text]))).data], [1, 2, 3]);
    const broken = Uint8Array.from(text);
    broken[10] ^= 0xff;
    assert.throws(() => decodePng(join(pngPieces(1, 1, 2, raw, [broken]))), /Bad CRC in tEXt/);
  });

  test('rejects damaged or unsupported files', () => {
    const raw = scanlines(Uint8Array.of(1, 2, 3), 3, 3, [0]);
    const good = join(pngPieces(1, 1, 2, raw));
    assert.doesNotThrow(() => decodePng(good));

    const badSignature = Uint8Array.from(good);
    badSignature[1] = 0;
    assert.throws(() => decodePng(badSignature), /signature/);

    const badCrc = Uint8Array.from(good);
    badCrc[badCrc.length - 20] ^= 1; // inside IDAT
    assert.throws(() => decodePng(badCrc), /Bad CRC/);

    assert.throws(() => decodePng(good.subarray(0, good.length - 5)), /Truncated/);
    assert.throws(() => decodePng(join([good, Uint8Array.of(0)])), /Data after IEND/);
    assert.throws(() => decodePng(join(pngPieces(1, 1, 0, raw))), /Unsupported format/);
    const badFilter = join(pngPieces(1, 1, 2, Uint8Array.of(5, 1, 2, 3)));
    assert.throws(() => decodePng(badFilter), /filter type 5/);
    assert.throws(() => decodePng(join(pngPieces(2, 1, 2, raw))), /Inflated size/);
    const empty = new Uint8Array(0);
    const ancillary = chunk('abCD', empty);
    assert.doesNotThrow(() => decodePng(join(pngPieces(1, 1, 2, raw, [ancillary]))));
    const critical = join(pngPieces(1, 1, 2, raw, [ancillary, chunk('CgBI', empty)]));
    assert.throws(() => decodePng(critical), /critical chunk CgBI/);

    const pieces = pngPieces(1, 1, 2, raw);
    assert.throws(() => decodePng(join([pieces[0], pieces[2], pieces[1], pieces[3]])), /IHDR/);
    const idat = pieces[2];
    const text = chunk('tEXt', new Uint8Array(1));
    const split = join([pieces[0], pieces[1], idat, text, idat, pieces[3]]);
    assert.throws(() => decodePng(split), /contiguous/);
  });
});
