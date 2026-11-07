// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { crc32, deflateRawSync, inflateRawSync } from 'node:zlib';
import { DOS_EPOCH, createZip, toDosDateTime } from '../../scripts/lib/zip.mjs';

const LOCAL_SIGNATURE = 0x04034b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const END_SIGNATURE = 0x06054b50;

/**
 * @typedef {object} ParsedEntry
 * @property {string} name
 * @property {number} method
 * @property {number} flags
 * @property {number} time
 * @property {number} date
 * @property {number} crc
 * @property {number} compressedSize
 * @property {number} size
 * @property {number} localOffset
 * @property {Buffer} data Inflated content.
 */

/**
 * Reads a ZIP archive: end record, central directory, then each local header and its data.
 * Checks the structure on the way, so a broken archive fails with a clear message.
 * @param {Buffer} zip
 * @returns {ParsedEntry[]} In central directory order.
 */
function parseZip(zip) {
  const endOffset = zip.length - 22;
  assert.equal(zip.readUInt32LE(endOffset), END_SIGNATURE, 'end record at the end, no comment');
  const count = zip.readUInt16LE(endOffset + 10);
  assert.equal(zip.readUInt16LE(endOffset + 8), count);
  assert.equal(zip.readUInt16LE(endOffset + 20), 0, 'comment length');
  const directorySize = zip.readUInt32LE(endOffset + 12);
  const directoryOffset = zip.readUInt32LE(endOffset + 16);
  assert.equal(directoryOffset + directorySize, endOffset, 'directory ends at the end record');

  /** @type {ParsedEntry[]} */
  const entries = [];
  let position = directoryOffset;
  for (let i = 0; i < count; i++) {
    assert.equal(zip.readUInt32LE(position), CENTRAL_SIGNATURE);
    const nameLength = zip.readUInt16LE(position + 28);
    assert.equal(zip.readUInt16LE(position + 30), 0, 'extra field length');
    assert.equal(zip.readUInt16LE(position + 32), 0, 'comment length');
    const name = zip.toString('utf8', position + 46, position + 46 + nameLength);
    /** @type {ParsedEntry} */
    const entry = {
      name,
      flags: zip.readUInt16LE(position + 8),
      method: zip.readUInt16LE(position + 10),
      time: zip.readUInt16LE(position + 12),
      date: zip.readUInt16LE(position + 14),
      crc: zip.readUInt32LE(position + 16),
      compressedSize: zip.readUInt32LE(position + 20),
      size: zip.readUInt32LE(position + 24),
      localOffset: zip.readUInt32LE(position + 42),
      data: Buffer.alloc(0),
    };
    entry.data = readLocalFile(zip, entry);
    entries.push(entry);
    position += 46 + nameLength;
  }
  assert.equal(position, endOffset, 'the directory holds exactly `count` entries');
  return entries;
}

/**
 * @param {Buffer} zip
 * @param {ParsedEntry} entry From the central directory.
 * @returns {Buffer} The inflated content, after the local header matches the directory.
 */
function readLocalFile(zip, entry) {
  const at = entry.localOffset;
  assert.equal(zip.readUInt32LE(at), LOCAL_SIGNATURE, `local header of ${entry.name}`);
  assert.equal(zip.readUInt16LE(at + 6), entry.flags);
  assert.equal(zip.readUInt16LE(at + 8), entry.method);
  assert.equal(zip.readUInt16LE(at + 10), entry.time);
  assert.equal(zip.readUInt16LE(at + 12), entry.date);
  assert.equal(zip.readUInt32LE(at + 14), entry.crc);
  assert.equal(zip.readUInt32LE(at + 18), entry.compressedSize);
  assert.equal(zip.readUInt32LE(at + 22), entry.size);
  const nameLength = zip.readUInt16LE(at + 26);
  assert.equal(zip.readUInt16LE(at + 28), 0, 'extra field length');
  assert.equal(zip.toString('utf8', at + 30, at + 30 + nameLength), entry.name);
  const start = at + 30 + nameLength;
  const stored = zip.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return stored;
  assert.equal(entry.method, 8);
  return inflateRawSync(stored);
}

/**
 * @param {string} name
 * @param {string | Uint8Array} content
 * @returns {{ name: string, data: Uint8Array }}
 */
const file = (name, content) => ({
  name,
  data: typeof content === 'string' ? Buffer.from(content) : content,
});

const text = 'Spool keeps one tall screenshot. '.repeat(40);

describe('createZip', () => {
  it('round-trips names, sizes, CRCs and contents', () => {
    const entries = [
      file('manifest.json', '{"name":"Spool"}'),
      file('src/a.js', text),
      file('src/lib/b.js', 'export const b = 2;\n'),
    ];
    const parsed = parseZip(createZip(entries));
    assert.deepEqual(
      parsed.map((entry) => entry.name),
      ['manifest.json', 'src/a.js', 'src/lib/b.js'],
    );
    for (const [i, entry] of parsed.entries()) {
      const original = Buffer.from(entries[i]?.data ?? []);
      assert.deepEqual(entry.data, original, entry.name);
      assert.equal(entry.size, original.length, entry.name);
      assert.equal(entry.crc, crc32(original), entry.name);
    }
  });

  it('deflates data that gets smaller and stores data that does not', () => {
    const incompressible = Uint8Array.from({ length: 64 }, (_, i) => (i * 167 + 13) & 0xff);
    const parsed = parseZip(
      createZip([file('text.txt', text), file('noise.bin', incompressible), file('empty', '')]),
    );
    const byName = new Map(parsed.map((entry) => [entry.name, entry]));
    const textEntry = byName.get('text.txt');
    assert.equal(textEntry?.method, 8);
    assert.ok((textEntry?.compressedSize ?? Infinity) < text.length);
    assert.equal(byName.get('noise.bin')?.method, 0);
    assert.equal(byName.get('noise.bin')?.compressedSize, 64);
    assert.equal(byName.get('empty')?.method, 0);
    assert.equal(byName.get('empty')?.size, 0);
    assert.equal(byName.get('empty')?.crc, 0);
  });

  it('writes sorted entries, whatever the input order', () => {
    const parsed = parseZip(
      createZip([file('b.txt', 'b'), file('src/z.js', 'z'), file('B.txt', 'B'), file('a/b', 'x')]),
    );
    assert.deepEqual(
      parsed.map((entry) => entry.name),
      ['B.txt', 'a/b', 'b.txt', 'src/z.js'],
    );
  });

  it('gives the same bytes for the same input', () => {
    const entries = [file('one.txt', text), file('two/three.txt', 'three'), file('four', '')];
    const first = createZip(entries);
    const second = createZip(entries);
    const reordered = createZip([...entries].reverse());
    assert.ok(first.equals(second));
    assert.ok(first.equals(reordered));
  });

  it('does not change its input', () => {
    const entries = [file('b', 'b'), file('a', 'a')];
    createZip(entries);
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['b', 'a'],
    );
  });

  it('writes an empty archive', () => {
    const zip = createZip([]);
    assert.equal(zip.length, 22);
    assert.deepEqual(parseZip(zip), []);
  });

  it('uses the DOS epoch (1980-01-01 00:00:00) by default', () => {
    const [entry] = parseZip(createZip([file('a', 'a')]));
    assert.equal(entry?.time, 0);
    assert.equal(entry?.date, (0 << 9) | (1 << 5) | 1);
  });

  it('stamps every entry with `modified`', () => {
    const modified = new Date(Date.UTC(2024, 5, 7, 8, 9, 11));
    const parsed = parseZip(createZip([file('a', 'a'), file('b', 'b')], { modified }));
    for (const entry of parsed) {
      assert.equal(entry.time, (8 << 11) | (9 << 5) | 5, 'seconds are halved');
      assert.equal(entry.date, ((2024 - 1980) << 9) | (6 << 5) | 7);
    }
  });

  it('flags names as UTF-8 and round-trips non-ASCII names', () => {
    const [entry] = parseZip(createZip([file('src/über/日本.txt', 'x')]));
    assert.equal(entry?.name, 'src/über/日本.txt');
    assert.equal((entry?.flags ?? 0) & 0x0800, 0x0800);
  });

  it('rejects names that could leave the target folder or that are malformed', () => {
    for (const name of [
      '',
      '/abs.txt',
      'dir/',
      '../up.txt',
      'a/../b.txt',
      'a/./b.txt',
      'a//b.txt',
      'back\\slash.txt',
      'nul\0.txt',
    ]) {
      assert.throws(() => createZip([file(name, 'x')]), RangeError, JSON.stringify(name));
    }
  });

  it('rejects duplicate names', () => {
    assert.throws(() => createZip([file('a.txt', '1'), file('a.txt', '2')]), /Duplicate/);
  });

  it('keeps names that differ only by case, and does not trim or fold them', () => {
    const parsed = parseZip(createZip([file('A.txt', '1'), file('a.txt', '2'), file(' a', '3')]));
    assert.deepEqual(
      parsed.map((entry) => entry.name),
      [' a', 'A.txt', 'a.txt'],
    );
  });

  it('sorts by UTF-16 code unit, never by locale', () => {
    // A locale order would put "a" before "B" and "é" before "f". Code unit order does not.
    const names = ['f', 'é', 'B', 'a', 'Z', '_', '0'];
    const parsed = parseZip(createZip(names.map((name) => file(name, name))));
    assert.deepEqual(
      parsed.map((entry) => entry.name),
      ['0', 'B', 'Z', '_', 'a', 'f', 'é'],
    );
  });

  it('sorts a long list of shuffled names by code unit (the sort of V8 changes at 64 items)', () => {
    // Up to 64 items V8 sorts by binary insertion, which only asks "is it below?". Above that it
    // merges runs and also asks "is it above?". A comparator that is wrong on one answer needs
    // the longer list to show.
    let state = 99;
    const next = () => {
      state = (state * 1103515245 + 12345) & 0x7fffffff;
      return state / 0x7fffffff;
    };
    const alphabet = 'abAB_.-0é日';
    const names = new Set();
    while (names.size < 400) {
      const length = 1 + Math.floor(next() * 6);
      let name = '';
      for (let i = 0; i < length; i++) name += alphabet[Math.floor(next() * alphabet.length)];
      // A dot at the start or a name of dots only would be refused by the writer.
      if (!/^\.+$/.test(name)) names.add(name);
    }
    const shuffled = [...names].sort(() => next() - 0.5);
    const parsed = parseZip(createZip(shuffled.map((name) => file(name, name))));
    const expected = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(
      parsed.map((entry) => entry.name),
      expected,
    );
  });

  describe('header fields that extraction tools read', () => {
    /**
     * @param {Buffer} zip
     * @returns {{ madeBy: number, needed: number, internal: number, external: number,
     *   disk: number, localNeeded: number }[]}
     */
    function centralFields(zip) {
      const endOffset = zip.length - 22;
      const count = zip.readUInt16LE(endOffset + 10);
      const rows = [];
      let position = zip.readUInt32LE(endOffset + 16);
      for (let i = 0; i < count; i++) {
        const localOffset = zip.readUInt32LE(position + 42);
        rows.push({
          madeBy: zip.readUInt16LE(position + 4),
          needed: zip.readUInt16LE(position + 6),
          disk: zip.readUInt16LE(position + 34),
          internal: zip.readUInt16LE(position + 36),
          external: zip.readUInt32LE(position + 38),
          localNeeded: zip.readUInt16LE(localOffset + 4),
        });
        position += 46 + zip.readUInt16LE(position + 28);
      }
      return rows;
    }

    it('marks every file as a regular file with mode rw-r--r-- made on Unix', () => {
      const zip = createZip([file('a.txt', text), file('b.bin', 'x')]);
      for (const row of centralFields(zip)) {
        // Host system 3 (Unix) in the high byte, ZIP specification 2.0 (20) in the low byte.
        assert.equal(row.madeBy, 0x0314);
        // Unix mode in the high 16 bits: S_IFREG | 0644. The DOS attribute bits stay 0.
        assert.equal(row.external >>> 16, 0o100644);
        assert.equal(row.external & 0xffff, 0);
        assert.equal(row.internal, 0);
        assert.equal(row.disk, 0);
      }
    });

    it('asks for version 2.0 to extract deflated data and 1.0 for stored data', () => {
      const zip = createZip([file('deflated.txt', text), file('stored.bin', 'x')]);
      const parsed = parseZip(zip);
      const rows = centralFields(zip);
      assert.deepEqual(
        parsed.map((entry) => entry.method),
        [8, 0],
      );
      assert.deepEqual(
        rows.map((row) => row.needed),
        [20, 10],
      );
      assert.deepEqual(
        rows.map((row) => row.localNeeded),
        [20, 10],
        'the local header says the same as the directory',
      );
    });

    it('sets only the UTF-8 name flag: no encryption, no data descriptor', () => {
      const zip = createZip([file('a.txt', text), file('b', 'b')]);
      for (const entry of parseZip(zip)) {
        // Bit 0 is encryption and bit 3 is a data descriptor. Only bit 11 (UTF-8) is set.
        assert.equal(entry.flags, 0x0800, entry.name);
      }
    });

    it('writes the end record for a single disk', () => {
      const zip = createZip([file('a', 'a')]);
      const end = zip.length - 22;
      assert.equal(zip.readUInt16LE(end + 4), 0, 'this disk');
      assert.equal(zip.readUInt16LE(end + 6), 0, 'disk of the directory');
      assert.equal(zip.readUInt16LE(end + 8), 1);
      assert.equal(zip.readUInt16LE(end + 10), 1);
    });

    it('puts each local header where the directory says, one after the other', () => {
      const zip = createZip([file('a.txt', text), file('b.txt', 'bb'), file('c.txt', text)]);
      const parsed = parseZip(zip);
      let expected = 0;
      for (const entry of parsed) {
        assert.equal(entry.localOffset, expected, entry.name);
        expected += 30 + Buffer.byteLength(entry.name) + entry.compressedSize;
      }
      assert.equal(zip.readUInt32LE(zip.length - 22 + 16), expected, 'the directory follows');
    });
  });

  describe('stored or deflated', () => {
    /**
     * Finds, with the same zlib call as the writer, a short input that deflate makes exactly as
     * long as it is. The search is seeded, so every run finds the same input.
     * @returns {Buffer}
     */
    function inputThatDeflateDoesNotShrink() {
      let state = 1;
      const next = () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
      };
      for (let attempt = 0; attempt < 200_000; attempt++) {
        const length = 4 + Math.floor(next() * 30);
        const letters = 2 + Math.floor(next() * 3);
        const data = Buffer.from(Array.from({ length }, () => 97 + Math.floor(next() * letters)));
        if (deflateRawSync(data, { level: 9 }).length === length) return data;
      }
      throw new Error('no input of equal deflated length found: the test needs a new search');
    }

    it('stores data that deflate leaves exactly as long as it was', () => {
      const data = inputThatDeflateDoesNotShrink();
      const [entry] = parseZip(createZip([file('same.txt', data)]));
      assert.equal(entry?.method, 0);
      assert.equal(entry?.compressedSize, data.length);
      assert.deepEqual(entry?.data, data);
    });

    it('deflates data when it gets at least one byte smaller', () => {
      const data = Buffer.from('a'.repeat(64));
      assert.ok(deflateRawSync(data, { level: 9 }).length < data.length);
      const [entry] = parseZip(createZip([file('small.txt', data)]));
      assert.equal(entry?.method, 8);
      assert.deepEqual(entry?.data, data);
    });
  });

  describe('limits of the format (no ZIP64)', () => {
    it('rejects 65536 entries, before it reads one of them', () => {
      const entry = file('a', 'a');
      assert.throws(() => createZip(new Array(65536).fill(entry)), /Too many entries/);
    });

    it('passes the entry count check with 65535 entries', () => {
      // The same name 65535 times: the count is fine, so the next check (duplicates) fails.
      const entry = file('a', 'a');
      assert.throws(() => createZip(new Array(65535).fill(entry)), /Duplicate/);
    });

    it('rejects data of more than 4 GiB without reading it', () => {
      const huge = { name: 'big.bin', data: /** @type {any} */ ({ length: 2 ** 32 }) };
      assert.throws(() => createZip([huge]), /"big\.bin" is too large/);
    });

    it('does not call data of 4 GiB - 1 byte too large (it fits in 32 bits)', () => {
      // The fake has no bytes, so the deflate step fails. That is a different failure from
      // "too large", and it proves that the size check let the entry through.
      const limit = { name: 'limit.bin', data: /** @type {any} */ ({ length: 0xffffffff }) };
      assert.throws(
        () => createZip([limit]),
        (error) => error instanceof Error && !/too large/.test(error.message),
      );
    });

    it('accepts a name of 65535 bytes and rejects one of 65536 bytes', () => {
      const longest = 'a'.repeat(65535);
      assert.equal(parseZip(createZip([file(longest, 'x')]))[0]?.name, longest);
      assert.throws(() => createZip([file('a'.repeat(65536), 'x')]), /Name too long/);
      // The limit is in bytes: 32768 characters of 2 bytes each are 65536 bytes.
      assert.throws(() => createZip([file('é'.repeat(32768), 'x')]), /Name too long/);
      assert.equal(parseZip(createZip([file('é'.repeat(32767), 'x')]))[0]?.size, 1);
    });

    it('rejects an invalid timestamp', () => {
      assert.throws(() => createZip([file('a', 'a')], { modified: new Date(Number.NaN) }), RangeError);
    });
  });
});

describe('toDosDateTime', () => {
  it('encodes the date and the time of day in UTC with 2 s resolution', () => {
    assert.deepEqual(toDosDateTime(new Date(Date.UTC(2026, 10, 6, 13, 45, 59))), {
      time: (13 << 11) | (45 << 5) | 29,
      date: ((2026 - 1980) << 9) | (11 << 5) | 6,
    });
  });

  it('clamps times before 1980 and after 2107', () => {
    assert.deepEqual(toDosDateTime(new Date(Date.UTC(1970, 0, 1))), toDosDateTime(DOS_EPOCH));
    assert.deepEqual(toDosDateTime(new Date(Date.UTC(2200, 0, 1))), {
      time: (23 << 11) | (59 << 5) | 29,
      date: (127 << 9) | (12 << 5) | 31,
    });
  });

  it('rejects an invalid date', () => {
    assert.throws(() => toDosDateTime(new Date(Number.NaN)), RangeError);
  });
});
