// @ts-check
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { writeImageToClipboard } from '../../src/sw/clipboard.js';

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString('base64');

/**
 * A fake worker global scope with a clipboard.
 * @param {{ fail?: boolean }} [options]
 */
function makeEnv(options = {}) {
  /** @type {{ items: any[], self: unknown }[]} */
  const writes = [];
  const clipboard = {
    async write(/** @type {any[]} */ items) {
      writes.push({ items, self: this });
      if (options.fail) throw new DOMException('Write permission denied.', 'NotAllowedError');
    },
  };
  class FakeClipboardItem {
    /** @param {Record<string, Blob>} data */
    constructor(data) {
      this.data = data;
    }
  }
  return { writes, clipboard, env: { navigator: { clipboard }, ClipboardItem: FakeClipboardItem } };
}

describe('writeImageToClipboard', () => {
  it('writes one image/png item with the bytes and says true', async () => {
    const { writes, env } = makeEnv();
    assert.equal(await writeImageToClipboard(PNG_B64, env), true);
    assert.equal(writes.length, 1);
    const [item] = writes[0]?.items ?? [];
    assert.deepEqual(Object.keys(item.data), ['image/png']);
    const blob = item.data['image/png'];
    assert.equal(blob.type, 'image/png');
    assert.deepEqual(new Uint8Array(await blob.arrayBuffer()), PNG_BYTES);
  });

  it('calls write as a method of the clipboard', async () => {
    const { writes, clipboard, env } = makeEnv();
    await writeImageToClipboard(PNG_B64, env);
    assert.equal(writes[0]?.self, clipboard);
  });

  it('says false when the write is refused', async () => {
    const { env } = makeEnv({ fail: true });
    assert.equal(await writeImageToClipboard(PNG_B64, env), false);
  });

  it('says false, without an error, when the browser has no clipboard API', async () => {
    assert.equal(await writeImageToClipboard(PNG_B64, {}), false);
    assert.equal(await writeImageToClipboard(PNG_B64, { navigator: {} }), false);
    assert.equal(await writeImageToClipboard(PNG_B64, { navigator: { clipboard: {} } }), false);
  });

  it('says false when ClipboardItem is missing', async () => {
    const { clipboard } = makeEnv();
    assert.equal(await writeImageToClipboard(PNG_B64, { navigator: { clipboard } }), false);
  });

  it('says false for data that is not base64', async () => {
    const { writes, env } = makeEnv();
    assert.equal(await writeImageToClipboard('***not base64***', env), false);
    assert.equal(writes.length, 0);
  });
});
