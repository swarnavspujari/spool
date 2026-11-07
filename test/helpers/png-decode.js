// @ts-check
/**
 * Minimal strict PNG decoder for tests (Node only). It checks the signature, the chunk order
 * and the CRC of every chunk, and it supports colour types 2 (RGB) and 6 (RGBA) at bit depth 8
 * without interlace. It uses node:zlib for both the CRC and the inflate step, so it shares no
 * code with the encoder under test.
 */

import { crc32, inflateSync } from 'node:zlib';

/**
 * @typedef {Object} DecodedPng
 * @property {number} width
 * @property {number} height
 * @property {number} channels  3 (colour type 2, RGB) or 4 (colour type 6, RGBA).
 * @property {Uint8Array} data  `width * height * channels` bytes, row by row.
 * @property {Uint8Array} filters  Filter type (0-4) of every row.
 * @property {{ type: string, length: number }[]} chunks  Every chunk in file order.
 */

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Colour type -> channels per pixel. */
const CHANNELS = new Map([
  [2, 3],
  [6, 4],
]);
/** Critical chunks other than IHDR, IDAT and IEND that a decoder may skip for types 2 and 6. */
const IGNORED_CRITICAL = new Set(['PLTE']);

/**
 * @param {number} a
 * @param {number} b
 * @param {number} c
 * @returns {number}
 */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Decodes a PNG file. Throws an Error on anything that is not valid or not supported.
 * @param {Uint8Array | ArrayBuffer} input
 * @returns {DecodedPng}
 */
export function decodePng(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((v, i) => bytes[i] !== v)) {
    throw new Error('Bad PNG signature');
  }

  /** @type {DecodedPng['chunks']} */
  const chunks = [];
  /** @type {Uint8Array[]} */
  const idat = [];
  /** @type {{ width: number, height: number, channels: number } | null} */
  let header = null;
  let pos = SIGNATURE.length;
  let ended = false;
  while (!ended) {
    if (pos + 12 > bytes.length) throw new Error('Truncated PNG: chunk header or CRC missing');
    const length = view.getUint32(pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    if (!/^[A-Za-z]{4}$/.test(type)) throw new Error('Bad chunk type');
    if (length > 0x7fffffff || pos + 12 + length > bytes.length) {
      throw new Error(`Truncated PNG: ${type} chunk is cut off`);
    }
    const data = bytes.subarray(pos + 8, pos + 8 + length);
    const stored = view.getUint32(pos + 8 + length);
    if (crc32(bytes.subarray(pos + 4, pos + 8 + length)) !== stored) {
      throw new Error(`Bad CRC in ${type} chunk`);
    }
    const first = chunks.length === 0;
    if (first !== (type === 'IHDR')) throw new Error('IHDR must be the first and only header');
    if (type === 'IDAT') {
      const previous = chunks[chunks.length - 1];
      if (previous && previous.type !== 'IDAT' && idat.length > 0) {
        throw new Error('IDAT chunks must be contiguous');
      }
      idat.push(data);
    } else if (type === 'IHDR') {
      header = parseHeader(data);
    } else if (type === 'IEND') {
      if (length !== 0) throw new Error('IEND must be empty');
      ended = true;
    } else if (type[0] === type[0].toUpperCase() && !IGNORED_CRITICAL.has(type)) {
      throw new Error(`Unsupported critical chunk ${type}`);
    }
    chunks.push({ type, length });
    pos += 12 + length;
  }
  if (pos !== bytes.length) throw new Error('Data after IEND');
  if (header === null || idat.length === 0) throw new Error('PNG has no image data');

  const { width, height, channels } = header;
  const stride = width * channels;
  const raw = inflateSync(Buffer.concat(idat));
  if (raw.length !== height * (stride + 1)) {
    throw new Error(`Inflated size ${raw.length} does not match ${height * (stride + 1)}`);
  }

  const data = new Uint8Array(height * stride);
  const filters = new Uint8Array(height);
  for (let y = 0; y < height; y++) {
    const type = raw[y * (stride + 1)];
    if (type > 4) throw new Error(`Bad filter type ${type} in row ${y}`);
    filters[y] = type;
    const src = y * (stride + 1) + 1;
    const dst = y * stride;
    for (let i = 0; i < stride; i++) {
      const x = raw[src + i];
      const a = i >= channels ? data[dst + i - channels] : 0;
      const b = y > 0 ? data[dst - stride + i] : 0;
      const c = y > 0 && i >= channels ? data[dst - stride + i - channels] : 0;
      let predictor = 0;
      if (type === 1) predictor = a;
      else if (type === 2) predictor = b;
      else if (type === 3) predictor = (a + b) >> 1;
      else if (type === 4) predictor = paeth(a, b, c);
      data[dst + i] = x + predictor;
    }
  }
  return { width, height, channels, data, filters, chunks };
}

/**
 * @param {Uint8Array} data  IHDR payload.
 * @returns {{ width: number, height: number, channels: number }}
 */
function parseHeader(data) {
  if (data.length !== 13) throw new Error('IHDR must be 13 bytes');
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  if (width < 1 || height < 1 || width > 0x7fffffff || height > 0x7fffffff) {
    throw new Error('Bad image size');
  }
  const [bitDepth, colorType, compression, filter, interlace] = data.subarray(8);
  const channels = CHANNELS.get(colorType);
  if (bitDepth !== 8 || channels === undefined) {
    throw new Error(`Unsupported format: bit depth ${bitDepth}, colour type ${colorType}`);
  }
  if (compression !== 0 || filter !== 0 || interlace !== 0) {
    throw new Error('Unsupported compression, filter method or interlace');
  }
  return { width, height, channels };
}
