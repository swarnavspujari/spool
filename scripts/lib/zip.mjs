// @ts-check
/**
 * Deterministic ZIP writer (PKZIP 2.0 format, no ZIP64, no encryption, files only).
 * The same entries and the same timestamp always give the same bytes: entries are sorted by
 * name, and the archive has no data descriptors, extra fields or comments. Node's zlib builds
 * the deflate streams, so the bytes can change when Node updates its bundled zlib.
 */

import { crc32, deflateRawSync } from 'node:zlib';

/**
 * @typedef {object} ZipEntry
 * @property {string} name Path inside the archive. Forward slashes, relative, no `.` or `..`.
 * @property {Uint8Array} data
 */

/** The earliest time that a DOS timestamp can hold. */
export const DOS_EPOCH = new Date(Date.UTC(1980, 0, 1));
const DOS_LATEST = new Date(Date.UTC(2107, 11, 31, 23, 59, 58));

const LOCAL_HEADER_SIGNATURE = 0x04034b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const END_RECORD_SIGNATURE = 0x06054b50;
const LOCAL_HEADER_BYTES = 30;
const CENTRAL_HEADER_BYTES = 46;
const END_RECORD_BYTES = 22;

const METHOD_STORE = 0;
const METHOD_DEFLATE = 8;
const VERSION_STORE = 10;
const VERSION_DEFLATE = 20;
/** Host system 3 (Unix), ZIP spec version 2.0. */
const VERSION_MADE_BY = (3 << 8) | 20;
/** Bit 11: file names are UTF-8. */
const FLAG_UTF8_NAMES = 0x0800;
/** Unix mode in the high 16 bits: regular file, rw-r--r--. */
const EXTERNAL_ATTRIBUTES = (0o100644 << 16) >>> 0;

const MAX_UINT16 = 0xffff;
const MAX_UINT32 = 0xffffffff;

/**
 * @param {Date} date Read in UTC, so the result does not depend on the time zone.
 * @returns {{ time: number, date: number }} MS-DOS time and date fields (2 s resolution).
 *   Times before 1980 give 1980-01-01 00:00:00 and times after 2107 give the last valid time.
 */
export function toDosDateTime(date) {
  if (Number.isNaN(date.getTime())) throw new RangeError('Invalid timestamp');
  const clamped = date < DOS_EPOCH ? DOS_EPOCH : date > DOS_LATEST ? DOS_LATEST : date;
  return {
    time:
      (clamped.getUTCHours() << 11) |
      (clamped.getUTCMinutes() << 5) |
      (clamped.getUTCSeconds() >> 1),
    date:
      ((clamped.getUTCFullYear() - 1980) << 9) |
      ((clamped.getUTCMonth() + 1) << 5) |
      clamped.getUTCDate(),
  };
}

/**
 * Creates a ZIP archive.
 * @param {ReadonlyArray<ZipEntry>} entries In any order. The archive lists them sorted by name.
 * @param {{ modified?: Date }} [options] `modified` is the timestamp of every entry.
 * @returns {Buffer}
 */
export function createZip(entries, { modified = DOS_EPOCH } = {}) {
  if (entries.length > MAX_UINT16) throw new RangeError('Too many entries (no ZIP64 support)');
  const stamp = toDosDateTime(modified);
  const sorted = [...entries].sort((a, b) => compareNames(a.name, b.name));
  assertValidNames(sorted.map((entry) => entry.name));

  /** @type {Buffer[]} */
  const body = [];
  /** @type {Buffer[]} */
  const directory = [];
  let offset = 0;
  for (const { name, data } of sorted) {
    if (data.length > MAX_UINT32) throw new RangeError(`"${name}" is too large (no ZIP64 support)`);
    const { method, bytes } = compress(data);
    const file = {
      nameBytes: Buffer.from(name, 'utf8'),
      method,
      time: stamp.time,
      date: stamp.date,
      crc: crc32(data),
      compressedSize: bytes.length,
      size: data.length,
    };
    body.push(localHeader(file), Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
    directory.push(centralHeader(file, offset));
    offset += LOCAL_HEADER_BYTES + file.nameBytes.length + bytes.length;
  }
  const directorySize = directory.reduce((sum, header) => sum + header.length, 0);
  if (offset + directorySize > MAX_UINT32) throw new RangeError('Archive too large (no ZIP64)');
  return Buffer.concat([...body, ...directory, endRecord(sorted.length, directorySize, offset)]);
}

/** @param {string} a @param {string} b @returns {number} Plain UTF-16 order, never locale-based. */
function compareNames(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** @param {string[]} names Sorted. */
function assertValidNames(names) {
  names.forEach((name, index) => {
    const segments = name.split('/');
    const invalid =
      /[\\\0]/.test(name) || segments.some((s) => s === '' || s === '.' || s === '..');
    if (invalid) throw new RangeError(`Invalid entry name "${name}"`);
    if (name === names[index - 1]) throw new RangeError(`Duplicate entry name "${name}"`);
    if (Buffer.byteLength(name) > MAX_UINT16) throw new RangeError(`Name too long: "${name}"`);
  });
}

/**
 * Deflates at level 9, or keeps the data as it is when deflate does not make it smaller.
 * @param {Uint8Array} data
 * @returns {{ method: number, bytes: Uint8Array }}
 */
function compress(data) {
  const deflated = deflateRawSync(data, { level: 9 });
  return deflated.length < data.length
    ? { method: METHOD_DEFLATE, bytes: deflated }
    : { method: METHOD_STORE, bytes: data };
}

/**
 * @typedef {object} FileRecord
 * @property {Buffer} nameBytes
 * @property {number} method
 * @property {number} time
 * @property {number} date
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} size
 */

/** @param {number} method @returns {number} The ZIP version needed to extract. */
function versionNeeded(method) {
  return method === METHOD_DEFLATE ? VERSION_DEFLATE : VERSION_STORE;
}

/** @param {FileRecord} file @returns {Buffer} */
function localHeader(file) {
  const header = Buffer.alloc(LOCAL_HEADER_BYTES + file.nameBytes.length);
  header.writeUInt32LE(LOCAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(versionNeeded(file.method), 4);
  header.writeUInt16LE(FLAG_UTF8_NAMES, 6);
  header.writeUInt16LE(file.method, 8);
  header.writeUInt16LE(file.time, 10);
  header.writeUInt16LE(file.date, 12);
  header.writeUInt32LE(file.crc, 14);
  header.writeUInt32LE(file.compressedSize, 18);
  header.writeUInt32LE(file.size, 22);
  header.writeUInt16LE(file.nameBytes.length, 26);
  // Offset 28: extra field length 0.
  file.nameBytes.copy(header, LOCAL_HEADER_BYTES);
  return header;
}

/** @param {FileRecord} file @param {number} localOffset @returns {Buffer} */
function centralHeader(file, localOffset) {
  const header = Buffer.alloc(CENTRAL_HEADER_BYTES + file.nameBytes.length);
  header.writeUInt32LE(CENTRAL_HEADER_SIGNATURE, 0);
  header.writeUInt16LE(VERSION_MADE_BY, 4);
  header.writeUInt16LE(versionNeeded(file.method), 6);
  header.writeUInt16LE(FLAG_UTF8_NAMES, 8);
  header.writeUInt16LE(file.method, 10);
  header.writeUInt16LE(file.time, 12);
  header.writeUInt16LE(file.date, 14);
  header.writeUInt32LE(file.crc, 16);
  header.writeUInt32LE(file.compressedSize, 20);
  header.writeUInt32LE(file.size, 24);
  header.writeUInt16LE(file.nameBytes.length, 28);
  // Offsets 30-37: extra field, comment, disk number and internal attributes, all 0.
  header.writeUInt32LE(EXTERNAL_ATTRIBUTES, 38);
  header.writeUInt32LE(localOffset, 42);
  file.nameBytes.copy(header, CENTRAL_HEADER_BYTES);
  return header;
}

/**
 * @param {number} count
 * @param {number} directorySize
 * @param {number} directoryOffset
 * @returns {Buffer}
 */
function endRecord(count, directorySize, directoryOffset) {
  const record = Buffer.alloc(END_RECORD_BYTES);
  record.writeUInt32LE(END_RECORD_SIGNATURE, 0);
  // Offsets 4-7: disk numbers, 0.
  record.writeUInt16LE(count, 8);
  record.writeUInt16LE(count, 10);
  record.writeUInt32LE(directorySize, 12);
  record.writeUInt32LE(directoryOffset, 16);
  // Offset 20: comment length 0.
  return record;
}
