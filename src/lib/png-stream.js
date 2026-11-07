// @ts-check
/**
 * CRC-32 and a streaming PNG encoder. Pure library: web-standard APIs only (CompressionStream,
 * Blob, Uint8Array), so it runs in extension pages, the offscreen document and Node tests.
 *
 * The encoder writes an 8-bit RGB image (colour type 2, no interlace). Rows go through the
 * compressor as they arrive. Only the previous row is kept, and the compressed output is cut
 * into IDAT chunks of at most 1 MiB while it streams out.
 */

/**
 * @typedef {Object} PngEncoder
 * @property {(rgba: Uint8ClampedArray | Uint8Array, rowCount: number) => Promise<void>} writeRows
 *   Appends `rowCount` rows from `rowCount * width * 4` RGBA bytes. Alpha is dropped.
 *   Await each call before the next call.
 * @property {() => Promise<Blob>} finish
 *   Closes the stream after all `height` rows were written. Resolves to an `image/png` Blob.
 */

const PNG_SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
const MAX_DIMENSION = 0x7fffffff;
const BYTES_PER_PIXEL = 3;
/** Largest data length of one IDAT chunk. */
const IDAT_MAX_BYTES = 1024 * 1024;
/** Filtered bytes that go to the compressor in one write. */
const BATCH_BYTES = 1024 * 1024;
/** Chunk bytes around the data: length (4), type (4) and CRC (4). */
const CHUNK_OVERHEAD = 12;
const CHUNK_DATA_OFFSET = 8;

const FILTER_NONE = 0;
const FILTER_SUB = 1;
const FILTER_UP = 2;
const FILTER_PAETH = 4;

/** @returns {Uint32Array} */
function buildCrcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c;
  }
  return table;
}
const CRC_TABLE = buildCrcTable();

/** Size of a filtered byte read as a signed value: the cost that the filter choice minimizes. */
const ABS_SIGNED = Uint8Array.from({ length: 256 }, (_, v) => (v < 128 ? v : 256 - v));

/**
 * @param {string} name
 * @param {unknown} value
 * @param {number} min
 * @param {number} [max]
 * @returns {asserts value is number}
 */
function assertInt(name, value, min, max = Number.MAX_SAFE_INTEGER) {
  if (typeof value !== 'number') throw new TypeError(`${name} must be a number`);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
}

/**
 * @param {unknown} value
 * @returns {asserts value is Uint8Array | Uint8ClampedArray}
 */
function assertBytes(value) {
  if (!(value instanceof Uint8Array || value instanceof Uint8ClampedArray)) {
    throw new TypeError('rgba must be a Uint8Array or a Uint8ClampedArray');
  }
}

/**
 * CRC-32 (IEEE 802.3, the PNG and zlib checksum).
 * @param {Uint8Array} bytes
 * @param {number} [seed]  CRC of the bytes before these (0 to start). Lets a CRC run over
 *   several pieces: `crc32(b, crc32(a))` equals `crc32(a followed by b)`.
 * @returns {number}  Unsigned 32-bit value.
 */
export function crc32(bytes, seed = 0) {
  if (!(bytes instanceof Uint8Array)) throw new TypeError('bytes must be a Uint8Array');
  assertInt('seed', seed, 0, 0xffffffff);
  let crc = seed ^ 0xffffffff;
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * Writes the length, type and CRC around data that already sits at offset 8 of `chunk`.
 * @param {Uint8Array<ArrayBuffer>} chunk  At least `dataLength + 12` bytes.
 * @param {string} type       Four ASCII letters.
 * @param {number} dataLength
 * @returns {Uint8Array<ArrayBuffer>}  The finished chunk (a view on `chunk`).
 */
function sealChunk(chunk, type, dataLength) {
  const view = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
  view.setUint32(0, dataLength);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  const crcOffset = CHUNK_DATA_OFFSET + dataLength;
  view.setUint32(crcOffset, crc32(chunk.subarray(4, crcOffset)));
  return chunk.subarray(0, crcOffset + 4);
}

/**
 * @param {string} type
 * @param {Uint8Array} data
 * @returns {Uint8Array<ArrayBuffer>}
 */
function buildChunk(type, data) {
  const chunk = new Uint8Array(CHUNK_OVERHEAD + data.length);
  chunk.set(data, CHUNK_DATA_OFFSET);
  return sealChunk(chunk, type, data.length);
}

/**
 * Reads the compressed stream to its end and appends it to `parts` as IDAT chunks.
 * Start it before the first write and keep it running: a compressor whose output nobody reads
 * stops accepting input.
 * @param {ReadableStreamDefaultReader<Uint8Array>} reader
 * @param {BlobPart[]} parts
 * @returns {Promise<void>}
 */
async function collectIdat(reader, parts) {
  let chunk = new Uint8Array(CHUNK_OVERHEAD + IDAT_MAX_BYTES);
  let used = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    for (let offset = 0; offset < value.length; ) {
      const take = Math.min(value.length - offset, IDAT_MAX_BYTES - used);
      chunk.set(value.subarray(offset, offset + take), CHUNK_DATA_OFFSET + used);
      offset += take;
      used += take;
      if (used === IDAT_MAX_BYTES) {
        parts.push(new Blob([sealChunk(chunk, 'IDAT', used)]));
        chunk = new Uint8Array(CHUNK_OVERHEAD + IDAT_MAX_BYTES);
        used = 0;
      }
    }
  }
  if (used > 0) parts.push(new Blob([sealChunk(chunk, 'IDAT', used)]));
}

/**
 * PNG Paeth predictor. With p = a + b - c, the distances |p - a|, |p - b| and |p - c| reduce to
 * the three terms below.
 * @param {number} a  Left byte.
 * @param {number} b  Byte above.
 * @param {number} c  Byte above left.
 * @returns {number}
 */
function paethPredictor(a, b, c) {
  const pa = Math.abs(b - c);
  const pb = Math.abs(a - c);
  const pc = Math.abs(a + b - 2 * c);
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Copies one RGBA row into `row` at offset 3 without the alpha bytes.
 * @param {Uint8Array | Uint8ClampedArray} rgba
 * @param {number} start  Index of the row's first byte in `rgba`.
 * @param {Uint8Array} row  3 zero bytes (never written) followed by the RGB row.
 */
function copyRgb(rgba, start, row) {
  for (let s = start, d = BYTES_PER_PIXEL; d < row.length; s += 4, d += 3) {
    row[d] = rgba[s];
    row[d + 1] = rgba[s + 1];
    row[d + 2] = rgba[s + 2];
  }
}

/**
 * Picks the filter with the smallest sum of absolute signed filtered bytes. On a tie the first
 * of None, Sub, Up, Paeth wins.
 * Both rows hold 3 zero bytes before the RGB data, so the left neighbour of the first pixel
 * reads as 0 without a branch.
 * @param {Uint8Array} cur
 * @param {Uint8Array} prev  The previous row, or all zeros for the first row.
 * @returns {number}
 */
function chooseFilter(cur, prev) {
  let none = 0;
  let sub = 0;
  let up = 0;
  let paeth = 0;
  for (let i = BYTES_PER_PIXEL; i < cur.length; i++) {
    const x = cur[i];
    const a = cur[i - BYTES_PER_PIXEL];
    const b = prev[i];
    const c = prev[i - BYTES_PER_PIXEL];
    none += ABS_SIGNED[x];
    sub += ABS_SIGNED[(x - a) & 0xff];
    up += ABS_SIGNED[(x - b) & 0xff];
    paeth += ABS_SIGNED[(x - paethPredictor(a, b, c)) & 0xff];
  }
  let type = FILTER_NONE;
  let best = none;
  if (sub < best) {
    type = FILTER_SUB;
    best = sub;
  }
  if (up < best) {
    type = FILTER_UP;
    best = up;
  }
  if (paeth < best) type = FILTER_PAETH;
  return type;
}

/**
 * Writes the filter type byte at `out[offset]` and the filtered row after it.
 * @param {number} type
 * @param {Uint8Array} cur
 * @param {Uint8Array} prev
 * @param {Uint8Array} out
 * @param {number} offset
 */
function writeFiltered(type, cur, prev, out, offset) {
  out[offset] = type;
  // Index in `out` of `cur[i]` is `i + shift`.
  const shift = offset + 1 - BYTES_PER_PIXEL;
  if (type === FILTER_NONE) {
    out.set(cur.subarray(BYTES_PER_PIXEL), offset + 1);
  } else if (type === FILTER_SUB) {
    for (let i = BYTES_PER_PIXEL; i < cur.length; i++) {
      out[i + shift] = cur[i] - cur[i - BYTES_PER_PIXEL];
    }
  } else if (type === FILTER_UP) {
    for (let i = BYTES_PER_PIXEL; i < cur.length; i++) out[i + shift] = cur[i] - prev[i];
  } else {
    for (let i = BYTES_PER_PIXEL; i < cur.length; i++) {
      out[i + shift] =
        cur[i] - paethPredictor(cur[i - BYTES_PER_PIXEL], prev[i], prev[i - BYTES_PER_PIXEL]);
    }
  }
}

/**
 * Starts an 8-bit RGB PNG. Rows are filtered per row (None, Sub, Up or Paeth, whichever gives
 * the smallest sum of absolute signed bytes) and compressed with `CompressionStream('deflate')`.
 *
 * Calls to `writeRows` and `finish` must not overlap. A call with bad arguments rejects without
 * changing the encoder. An encoder that was abandoned before `finish` needs no cleanup.
 *
 * @param {{ width: number, height: number }} options
 * @returns {PngEncoder}
 */
export function createPngEncoder(options) {
  if (options === null || typeof options !== 'object') {
    throw new TypeError('options must be an object');
  }
  const { width, height } = options;
  assertInt('width', width, 1, MAX_DIMENSION);
  assertInt('height', height, 1, MAX_DIMENSION);

  const rgbaRowBytes = width * 4;
  const outRowBytes = 1 + width * BYTES_PER_PIXEL;
  const rowsPerBatch = Math.max(1, Math.floor(BATCH_BYTES / outRowBytes));

  const ihdr = new Uint8Array(13);
  const ihdrView = new DataView(ihdr.buffer);
  ihdrView.setUint32(0, width);
  ihdrView.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: RGB
  // Compression, filter method and interlace stay 0.

  /** @type {BlobPart[]} */
  const parts = [PNG_SIGNATURE, buildChunk('IHDR', ihdr)];
  const compressor = new CompressionStream('deflate');
  const writer = compressor.writable.getWriter();
  const output = collectIdat(compressor.readable.getReader(), parts);
  // A stream failure reaches the caller through writeRows() or finish(). This only keeps the
  // output promise from reporting an unhandled rejection when nobody calls finish().
  output.catch(() => {});

  // Each row buffer starts with 3 zero bytes that are never written (see chooseFilter).
  let cur = new Uint8Array(BYTES_PER_PIXEL + width * BYTES_PER_PIXEL);
  let prev = new Uint8Array(cur.length);
  let rowsWritten = 0;
  let busy = false;
  let finished = false;

  /** Throws if the PNG is complete or another call is still running. */
  function assertIdle() {
    if (finished) throw new Error('The PNG encoder is already finished');
    if (busy) throw new Error('Await each writeRows() or finish() call before the next one');
  }

  return {
    async writeRows(rgba, rowCount) {
      assertIdle();
      assertBytes(rgba);
      assertInt('rowCount', rowCount, 1);
      const expectedBytes = rowCount * rgbaRowBytes;
      if (rgba.length !== expectedBytes) {
        throw new RangeError(`rgba must have rowCount * width * 4 = ${expectedBytes} bytes`);
      }
      if (rowCount > height - rowsWritten) {
        throw new RangeError(`Writing ${rowCount} rows exceeds the image height of ${height}`);
      }
      busy = true;
      try {
        for (let done = 0; done < rowCount; ) {
          const batchRows = Math.min(rowsPerBatch, rowCount - done);
          const batch = new Uint8Array(batchRows * outRowBytes);
          for (let r = 0; r < batchRows; r++) {
            copyRgb(rgba, (done + r) * rgbaRowBytes, cur);
            writeFiltered(chooseFilter(cur, prev), cur, prev, batch, r * outRowBytes);
            [cur, prev] = [prev, cur];
          }
          await writer.write(batch);
          done += batchRows;
          rowsWritten += batchRows;
        }
      } finally {
        busy = false;
      }
    },

    async finish() {
      assertIdle();
      if (rowsWritten !== height) {
        throw new RangeError(`Only ${rowsWritten} of ${height} rows were written`);
      }
      busy = true;
      try {
        await writer.close();
        await output;
      } finally {
        busy = false;
      }
      finished = true;
      parts.push(buildChunk('IEND', new Uint8Array(0)));
      return new Blob(parts, { type: 'image/png' });
    },
  };
}
