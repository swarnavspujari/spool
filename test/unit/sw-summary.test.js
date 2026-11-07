// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ERR, SpoolError } from '../../src/shared/protocol.js';
import { parsePngBase64, parseSummary, toShelfSummary } from '../../src/sw/summary.js';

const SESSION_ID = '3f2b8c1e-9d4a-4b6f-8a21-5c7e9d0b1a34';

function valid() {
  return {
    sessionId: SESSION_ID,
    title: 'My page',
    sourceHost: 'example.com',
    createdAt: 1_760_000_000_000,
    widthPx: 1000,
    heightPx: 5000,
    tileCount: 2,
    tileTier: 'high',
    fitsOneImage: false,
    fullBytes: 123_456,
    thumbnailPngBase64: 'iVBORw0KGgo=',
    thumbnailWidthPx: 320,
    thumbnailHeightPx: 480,
    save: {
      location: 'downloads',
      label: 'Downloads/Spool',
      files: 3,
      needsPermission: true,
      error: 'Some files could not be saved.',
    },
    warnings: ['a', 'b'],
  };
}

/** @param {unknown} e */
function isInternal(e) {
  return e instanceof SpoolError && e.code === ERR.INTERNAL && e.message === 'Something went wrong. Try again.';
}

describe('parseSummary', () => {
  it('returns a copy of a valid summary', () => {
    const input = valid();
    const out = parseSummary(input);
    assert.deepEqual(out, input);
    assert.notEqual(out, input);
    assert.notEqual(out.save, input.save);
    assert.notEqual(out.warnings, input.warnings);
  });

  it('leaves out the error when there is none', () => {
    const input = valid();
    delete (/** @type {any} */ (input.save).error);
    assert.ok(!('error' in parseSummary(input).save));
  });

  it('keeps the number of files that did not save, and the folder that needs a reconnect', () => {
    const save = { ...valid().save, failed: 2, folderLabel: 'Pictures/Screenshots' };
    const out = parseSummary({ ...valid(), save }).save;
    assert.equal(out.failed, 2);
    assert.equal(out.folderLabel, 'Pictures/Screenshots');
    const plain = parseSummary(valid()).save;
    assert.ok(!('failed' in plain));
    assert.ok(!('folderLabel' in plain));
  });

  it('copies only the known fields, at both levels', () => {
    const input = { ...valid(), extra: 1, __proto__: { sneaky: true } };
    const out = /** @type {any} */ (parseSummary({ ...input, save: { ...valid().save, handle: {} } }));
    assert.ok(!('extra' in out));
    assert.ok(!('handle' in out.save));
    assert.equal(Object.getPrototypeOf(out), Object.prototype);
  });

  it('accepts every save location and both tiers', () => {
    for (const location of ['folder', 'downloads', 'none']) {
      assert.equal(parseSummary({ ...valid(), save: { ...valid().save, location } }).save.location, location);
    }
    for (const tileTier of ['high', 'standard']) {
      assert.equal(parseSummary({ ...valid(), tileTier }).tileTier, tileTier);
    }
  });

  it('accepts a full image of 0 bytes (it could not be built)', () => {
    assert.equal(parseSummary({ ...valid(), fullBytes: 0 }).fullBytes, 0);
  });

  /** @type {[string, unknown][]} */
  const bad = [
    ['sessionId', 'nope'],
    ['sessionId', undefined],
    ['title', 5],
    ['title', 'x'.repeat(513)],
    ['createdAt', 'now'],
    ['createdAt', NaN],
    ['widthPx', 0],
    ['widthPx', 1.5],
    ['widthPx', -3],
    ['heightPx', 0],
    ['tileCount', 0],
    ['tileCount', '2'],
    ['tileTier', 'low'],
    ['fitsOneImage', 'yes'],
    ['fullBytes', -1],
    ['fullBytes', 1.5],
    ['thumbnailPngBase64', ''],
    ['thumbnailPngBase64', 5],
    ['thumbnailPngBase64', 'A'.repeat(4 * 1024 * 1024 + 1)],
    ['thumbnailWidthPx', 0],
    ['thumbnailHeightPx', 0],
    ['save', null],
    ['save', 'x'],
    ['save', { ...valid().save, location: 'cloud' }],
    ['save', { ...valid().save, label: 5 }],
    ['save', { ...valid().save, files: -1 }],
    ['save', { ...valid().save, needsPermission: 'no' }],
    ['save', { ...valid().save, error: 5 }],
    ['save', { ...valid().save, failed: -1 }],
    ['save', { ...valid().save, failed: 1.5 }],
    ['save', { ...valid().save, failed: '2' }],
    ['save', { ...valid().save, folderLabel: 5 }],
    ['save', { ...valid().save, folderLabel: 'x'.repeat(513) }],
    ['warnings', 'one'],
    ['warnings', [5]],
    ['warnings', Array.from({ length: 21 }, () => 'w')],
    ['warnings', ['x'.repeat(513)]],
  ];
  for (const [field, value] of bad) {
    it(`refuses ${field} = ${JSON.stringify(value)?.slice(0, 40)}`, () => {
      assert.throws(() => parseSummary({ ...valid(), [field]: value }), isInternal);
    });
  }

  it('refuses anything that is not an object', () => {
    for (const value of [undefined, null, 'x', 5, []]) {
      assert.throws(() => parseSummary(value), isInternal);
    }
  });
});

describe('parseSummary: the host name of the captured page', () => {
  it('keeps a host name that passes the same check as the message', () => {
    for (const host of ['github.com', '[::1]', 'xn--bcher-kva.example', '']) {
      assert.equal(parseSummary({ ...valid(), sourceHost: host }).sourceHost, host);
    }
  });

  it('shows no host for one that does not pass, and does not fail the capture', () => {
    for (const host of ['GitHub.com', 'a.b/c', 'a:1', 'x'.repeat(254), 7, null, undefined, {}]) {
      assert.equal(parseSummary({ ...valid(), sourceHost: host }).sourceHost, '', String(host));
    }
  });
});

describe('toShelfSummary: what the shelf shows of a capture', () => {
  it('has the host and the place of the saved files, and nothing of the page but its host', () => {
    const shelf = toShelfSummary(parseSummary({ ...valid(), sourceHost: 'github.com' }));
    assert.equal(shelf.sourceHost, 'github.com');
    assert.equal(shelf.saveLabel, 'Downloads/Spool');
    assert.deepEqual(Object.keys(shelf).sort(), [
      'createdAt',
      'heightPx',
      'saveLabel',
      'sourceHost',
      'thumbnailHeightPx',
      'thumbnailPngBase64',
      'thumbnailWidthPx',
      'tileCount',
      'widthPx',
    ]);
  });

  it('gives no place when nothing was saved', () => {
    const none = parseSummary({
      ...valid(),
      save: { location: 'none', label: 'Not saved', files: 0, needsPermission: false },
    });
    assert.equal(toShelfSummary(none).saveLabel, '');
  });
});

describe('parsePngBase64', () => {
  it('returns the image', () => {
    assert.equal(parsePngBase64({ ok: true, pngBase64: 'AAAA' }), 'AAAA');
  });

  it('refuses a reply with no image or a bad one', () => {
    for (const reply of [undefined, null, {}, { pngBase64: '' }, { pngBase64: 5 }]) {
      assert.throws(() => parsePngBase64(reply), isInternal);
    }
  });
});
