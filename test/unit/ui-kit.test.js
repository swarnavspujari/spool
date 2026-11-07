// @ts-check
/**
 * Tests for src/page/ui-kit.js: the helpers that the toast and the shelf share (text, messages to
 * the service worker, the clipboard write, the canvas thumbnail, the card host). The script is a
 * classic script in a node:vm context with the fake page of test/helpers/fake-card-dom.js.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ERR, MSG, PROTOCOL_VERSION, TARGET } from '../../src/shared/protocol.js';
import { loadClassic } from '../helpers/load-classic.js';
import {
  FakeElement,
  FakePopoverElement,
  findAll,
  flush,
  setupCards,
  textOf,
} from '../helpers/fake-card-dom.js';

const CONFIG = Object.freeze({
  protocolVersion: PROTOCOL_VERSION,
  sessionId: '11111111-1111-4111-8111-111111111111',
  msg: MSG,
  err: ERR,
  target: TARGET,
});
const PNG_BASE64 = 'iVBORw0KGgo=';

/** @param {Parameters<typeof setupCards>[0]} [options] */
function setup(options = { files: [] }) {
  const t = setupCards({ ...options, files: ['src/page/ui-kit.js'] });
  const ui = t.ns.ui;
  assert.ok(ui, 'ui-kit.js must register __spool.ui');
  return { ...t, ui };
}

describe('ui-kit.js: text helpers', () => {
  it('formats sizes, numbers and tile file names', () => {
    const { ui } = setup();
    assert.equal(ui.num(6240), '6,240');
    assert.equal(ui.sizeText(1500, 2210), '1,500 × 2,210 px');
    assert.equal(ui.tileFileName(0, 5), 'screenshot-01-of-05.png');
    assert.equal(ui.tileFileName(11, 12), 'screenshot-12-of-12.png');
    assert.equal(ui.tileFileName(99, 100), 'screenshot-100-of-100.png');
  });

  it('decodes base64 into a PNG blob and refuses a missing image', () => {
    const { ui } = setup();
    const blob = ui.pngBlob(PNG_BASE64);
    assert.equal(blob.type, 'image/png');
    assert.equal(blob.size, 8);
    assert.throws(() => ui.pngBlob(''), { name: 'TypeError' });
    assert.throws(() => ui.pngBlob(undefined), { name: 'TypeError' });
  });

  it('draws icons with createElementNS, and never with innerHTML', () => {
    const { ui, createdTags } = setup();
    const icon = /** @type {FakeElement} */ (/** @type {unknown} */ (ui.icon('check', 'x', 14)));
    assert.equal(icon.attributes.get('width'), '14');
    assert.equal(icon.attributes.get('stroke-width'), '1.5');
    assert.equal(icon.attributes.get('aria-hidden'), 'true');
    assert.equal(icon.attributes.get('class'), 'x');
    assert.equal(icon.children.length, 1);
    assert.ok(createdTags.includes('svg') && createdTags.includes('path'));
  });
});

describe('ui-kit.js: send', () => {
  it('sends the envelope that the protocol wants and gives back the data', async () => {
    const { ui, sent } = setup({
      files: [],
      replies: { [MSG.PAGE_GET_TILE]: () => ({ ok: true, pngBase64: PNG_BASE64 }) },
    });
    const reply = await ui.send(/** @type {any} */ (CONFIG), 'PAGE_GET_TILE', {
      sessionId: CONFIG.sessionId,
      index: 2,
    });
    assert.deepEqual(sent, [
      { v: 1, target: 'sw', type: 'page/get-tile', sessionId: CONFIG.sessionId, index: 2 },
    ]);
    assert.equal(reply.ok, true);
    assert.equal(reply.ok && reply.data['pngBase64'], PNG_BASE64);
  });

  it('turns an error reply into a failure with a short message', async () => {
    const long = 'x'.repeat(500);
    const { ui } = setup({
      files: [],
      replies: { [MSG.PAGE_OPEN_RESULT]: () => ({ ok: false, error: { code: 'E_X', message: long } }) },
    });
    const reply = await ui.send(/** @type {any} */ (CONFIG), 'PAGE_OPEN_RESULT', {});
    assert.equal(reply.ok, false);
    assert.ok(!reply.ok && reply.code === 'E_X' && reply.message.length === 200);
  });

  it('does not send for an unknown message name, or when the extension was reloaded', async () => {
    const t = setup();
    const unknown = await t.ui.send(/** @type {any} */ (CONFIG), 'PAGE_NOT_A_MESSAGE', {});
    assert.equal(unknown.ok, false);
    t.extension.id = undefined;
    const orphan = await t.ui.send(/** @type {any} */ (CONFIG), 'PAGE_OPEN_RESULT', {});
    assert.equal(orphan.ok, false);
    assert.deepEqual(t.sent, []);
  });

  it('a runtime that throws or rejects is a failure, never a throw', async () => {
    const t = setup();
    t.runtime.sendMessage = () => {
      throw new Error('Extension context invalidated.');
    };
    assert.equal((await t.ui.send(/** @type {any} */ (CONFIG), 'PAGE_OPEN_RESULT', {})).ok, false);
    t.runtime.sendMessage = () => Promise.reject(new Error('The message port closed.'));
    assert.equal((await t.ui.send(/** @type {any} */ (CONFIG), 'PAGE_OPEN_RESULT', {})).ok, false);
    t.runtime.sendMessage = () => Promise.resolve(undefined);
    const none = await t.ui.send(/** @type {any} */ (CONFIG), 'PAGE_OPEN_RESULT', {});
    assert.equal(none.ok, false, 'no answer is not a success');
  });
});

describe('ui-kit.js: copyImage', () => {
  it('calls clipboard.write at once (in the gesture), with a promise of the PNG', async () => {
    const t = setup();
    const image = Promise.resolve(t.ui.pngBlob(PNG_BASE64));
    const done = t.ui.copyImage(image);
    assert.equal(t.clipboard.writes.length, 1, 'the write is already made');
    assert.deepEqual(t.clipboard.writes[0]?.types, ['image/png']);
    assert.equal(await done, true);
  });

  it('is false when the browser refuses, the API is missing, or the image fails', async () => {
    const refuse = setup();
    refuse.clipboard.reject = true;
    assert.equal(await refuse.ui.copyImage(Promise.resolve(refuse.ui.pngBlob(PNG_BASE64))), false);

    const missing = setup();
    missing.clipboard.missing = true;
    assert.equal(await missing.ui.copyImage(Promise.resolve(missing.ui.pngBlob(PNG_BASE64))), false);
    assert.equal(missing.clipboard.writes.length, 0);

    const broken = setup();
    assert.equal(await broken.ui.copyImage(Promise.reject(new Error('no image'))), false);
  });

  it('does not leave an unhandled rejection when the image promise fails', async () => {
    const t = setup();
    t.clipboard.missing = true; // the promise is never given to the browser
    /** @type {unknown[]} */
    const unhandled = [];
    const listener = (/** @type {unknown} */ reason) => unhandled.push(reason);
    process.on('unhandledRejection', listener);
    try {
      await t.ui.copyImage(Promise.reject(new Error('lost')));
      await flush();
      await flush();
    } finally {
      process.off('unhandledRejection', listener);
    }
    assert.deepEqual(unhandled, []);
  });
});

describe('ui-kit.js: drawPng', () => {
  it('draws the top of the image scaled to the canvas width, with createImageBitmap', async () => {
    const t = setup();
    const canvas = /** @type {any} */ (new FakeElement('canvas'));
    canvas.width = 112;
    canvas.height = 164;
    assert.equal(await t.ui.drawPng(canvas, PNG_BASE64), true);
    assert.equal(canvas.drawn.length, 1);
    // 320 x 480 scaled to the width of 112: 112 x 168. The bitmap is closed afterwards.
    assert.deepEqual(canvas.drawn[0].args, [0, 0, 112, 168]);
    assert.equal(t.bitmaps.closed, 1);
  });

  it('is false for bad data and never throws; no <img> is made', async () => {
    const t = setup();
    const canvas = /** @type {any} */ (new FakeElement('canvas'));
    canvas.width = 56;
    assert.equal(await t.ui.drawPng(canvas, ''), false);
    t.bitmaps.fail = true;
    assert.equal(await t.ui.drawPng(canvas, PNG_BASE64), false);
    assert.ok(!t.createdTags.includes('img'));
  });
});

describe('ui-kit.js: card host', () => {
  it('makes a host with a closed shadow root, styles by constructable stylesheet and no attribute', () => {
    const t = setup({ files: [], popover: false });
    const card = t.ui.createCardHost('.extra { color: red; }');
    const host = /** @type {FakeElement} */ (card.host);
    assert.equal(host.shadow, card.shadow);
    const sheets = /** @type {any} */ (card.shadow).adoptedStyleSheets;
    assert.equal(sheets.length, 1);
    assert.ok(sheets[0].text.includes(':host') && sheets[0].text.includes('.extra'));
    assert.equal(host.attributes.size, 0, 'no marker and no state attribute');
    assert.equal(host.parentNode, t.documentElement);
    assert.deepEqual(t.hosts(), [host]);
    assert.equal(textOf(card.root), '');
    card.destroy();
  });

  it('shows the host as a manual popover, and inside an open modal dialog', () => {
    const t = setup();
    const dialog = new FakeElement('dialog');
    t.page.modals.push(dialog);
    const card = t.ui.createCardHost('');
    const host = /** @type {FakePopoverElement} */ (card.host);
    assert.equal(host.popover, 'manual');
    assert.equal(host.shown, 1);
    assert.equal(host.parentNode, dialog);
    t.page.modals.length = 0;
    card.keepOnTop();
    assert.equal(host.parentNode, t.documentElement, 'back under <html> when the dialog closed');
    assert.equal(host.shown, 2);
    card.destroy();
  });

  it('shows the popover again when something else is above it', () => {
    const t = setup();
    const card = t.ui.createCardHost('');
    const host = /** @type {FakePopoverElement} */ (card.host);
    card.keepOnTop();
    assert.equal(host.hidden, 0);
    t.page.stack = [new FakeElement('div'), host];
    card.keepOnTop();
    assert.equal(host.hidden, 1);
    assert.equal(host.shown, 2);
    card.destroy();
  });

  it('removes the host of an earlier card when a new one starts', () => {
    const t = setup();
    const first = t.ui.createCardHost('');
    const second = t.ui.createCardHost('');
    assert.equal(/** @type {FakeElement} */ (first.host).removed, true);
    assert.deepEqual(t.hosts(), [second.host]);
    second.destroy();
    assert.deepEqual(t.hosts(), []);
  });

  it('listens to trusted events only, and never throws into the page', () => {
    const t = setup();
    const card = t.ui.createCardHost('');
    const button = new FakeElement('button');
    /** @type {string[]} */
    const seen = [];
    card.listen(button, 'click', () => seen.push('click'));
    card.listen(button, 'keydown', () => {
      throw new Error('handler failed');
    });
    button.dispatch('click', { isTrusted: false });
    assert.deepEqual(seen, []);
    button.dispatch('click');
    assert.doesNotThrow(() => button.dispatch('keydown'));
    assert.deepEqual(seen, ['click']);
    assert.equal(t.consoleErrors.length, 1);
    card.destroy();
    assert.equal(button.listenerCount('click'), 0, 'destroy removes the listeners');
  });

  it('destroy removes the host and the timer, and is idempotent', () => {
    const t = setup();
    const card = t.ui.createCardHost('');
    assert.equal(t.timers.pending, 1, 'the watchdog');
    card.destroy();
    card.destroy();
    assert.equal(card.isDestroyed(), true);
    assert.equal(/** @type {FakeElement} */ (card.host).removed, true);
    assert.equal(t.timers.pending, 0);
  });

  it('the watchdog removes the card when the extension was reloaded', () => {
    const t = setup();
    let orphan = 0;
    const card = t.ui.createCardHost('', { onOrphan: () => (orphan += 1) });
    t.timers.advance(1000);
    assert.equal(card.isDestroyed(), false);
    t.extension.id = undefined;
    t.timers.advance(1000);
    assert.equal(card.isDestroyed(), true);
    assert.equal(orphan, 1);
  });
});

describe('ui-kit.js: focusedElement', () => {
  it('is null for the page body, else the element that has the focus', () => {
    const t = setup();
    assert.equal(t.ui.focusedElement(), null);
    const editor = new FakeElement('div');
    t.page.activeElement = editor;
    assert.equal(t.ui.focusedElement(), /** @type {any} */ (editor));
  });

  it('looks into an open shadow root', () => {
    const t = setup();
    const inner = new FakeElement('textarea');
    const outer = new FakeElement('my-editor');
    outer.shadowRoot = /** @type {any} */ ({ activeElement: inner });
    t.page.activeElement = outer;
    assert.equal(t.ui.focusedElement(), /** @type {any} */ (inner));
  });

  it('is null for <html> and when reading throws', () => {
    const t = setup();
    t.page.activeElement = t.documentElement;
    assert.equal(t.ui.focusedElement(), null);
    Object.defineProperty(t.page, 'activeElement', {
      get() {
        throw new Error('blocked');
      },
    });
    assert.equal(t.ui.focusedElement(), null);
    assert.deepEqual(findAll(t.body, () => true).length, 1);
  });
});

// ---------------------------------------------------------------------------------------------
// Mutation testing of the card kit: the namespace, edges of the
// numbers, the shapes of an error reply, the clipboard and canvas guards, and the card host.
// ---------------------------------------------------------------------------------------------

describe('ui-kit.js: the namespace', () => {
  it('does not trust a namespace that is not a plain object, and makes its own', () => {
    const clobbered = Object.create({ [Symbol.toStringTag]: 'HTMLFormElement' });
    const context = loadClassic('src/page/ui-kit.js', { __spool: clobbered });
    assert.notEqual(context.__spool, clobbered);
    assert.equal(typeof context.__spool?.ui?.num, 'function');
    assert.equal(clobbered.ui, undefined, 'the kit did not register on the element');
  });

  it('makes the namespace an own, hidden, replaceable property when there is none', () => {
    const context = loadClassic('src/page/ui-kit.js', {});
    const descriptor = Object.getOwnPropertyDescriptor(context, '__spool');
    assert.ok(descriptor, 'an own property of the global');
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, true);
    assert.equal(descriptor.configurable, true);
    assert.equal(typeof descriptor.value.ui.send, 'function');
  });
});

describe('ui-kit.js: text, icons and constants', () => {
  it('rounds the numbers of a size to the nearest whole number', () => {
    const { ui } = setup();
    assert.equal(ui.num(2.4), '2');
    assert.equal(ui.num(2.5), '3');
    assert.equal(ui.num(2.6), '3');
    assert.equal(ui.num(1234567.4), '1,234,567');
    assert.equal(ui.sizeText(1499.6, 2210.4), '1,500 × 2,210 px');
  });

  it('keeps the font stack in one piece', () => {
    const { ui } = setup();
    // The system font first (macOS, Linux), then the Segoe UI family for Windows, as in tokens.css.
    assert.ok(
      ui.FONT.startsWith(
        "system-ui, -apple-system, 'Segoe UI Variable Text', 'Segoe UI Variable', 'Segoe UI'",
      ),
    );
    assert.ok(ui.FONT.endsWith("Roboto, 'Helvetica Neue', Arial, sans-serif"));
  });

  it('draws the glyph as a 16 px svg of five shapes', () => {
    const { ui } = setup();
    const glyph = /** @type {FakeElement} */ (/** @type {unknown} */ (ui.glyph()));
    assert.equal(glyph.tagName, 'SVG');
    assert.equal(glyph.attributes.get('width'), '16');
    assert.equal(glyph.attributes.get('height'), '16');
    assert.equal(glyph.attributes.get('viewBox'), '0 0 16 16');
    assert.deepEqual(
      glyph.children.map((c) => c.tagName),
      ['RECT', 'RECT', 'RECT', 'RECT', 'PATH'],
    );
    assert.equal(glyph.children[0].attributes.get('fill'), '#2A2C30');
  });

  it('makes svg nodes in the SVG namespace', () => {
    const t = setup();
    /** @type {string[]} */
    const spaces = [];
    t.context.document.createElementNS = (/** @type {string} */ ns, /** @type {string} */ tag) => {
      spaces.push(ns);
      return new FakeElement(tag);
    };
    t.ui.icon('check');
    t.ui.glyph();
    assert.ok(spaces.length > 2);
    assert.ok(spaces.every((ns) => ns === 'http://www.w3.org/2000/svg'), spaces[0]);
  });

  it('decodes every byte of the image', async () => {
    const { ui } = setup();
    const bytes = new Uint8Array(await ui.pngBlob(PNG_BASE64).arrayBuffer());
    assert.deepEqual([...bytes], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  });
});

describe('ui-kit.js: the shapes of an error reply', () => {
  /**
   * @param {unknown} reply
   * @returns {Promise<{ ok: boolean, code?: string, message?: string }>}
   */
  async function answer(reply) {
    const { ui } = setup({ files: [], replies: { [MSG.PAGE_OPEN_RESULT]: () => reply } });
    return /** @type {any} */ (await ui.send(/** @type {any} */ (CONFIG), 'PAGE_OPEN_RESULT', {}));
  }
  const GENERIC = 'Something went wrong. Try again.';
  const UNREACHABLE = 'Could not reach the extension. Try again.';

  it('an error reply without a usable error is generic', async () => {
    for (const reply of [
      { ok: false },
      { ok: false, error: null },
      { ok: false, error: 'boom' },
      { ok: false, error: {} },
      { ok: false, error: { code: 5, message: 7 } },
    ]) {
      const got = await answer(reply);
      assert.equal(got.ok, false, JSON.stringify(reply));
      assert.equal(got.code, 'E_UNREACHABLE', JSON.stringify(reply));
      assert.equal(got.message, GENERIC, JSON.stringify(reply));
    }
  });

  it('takes the code and the message of the error, each on its own', async () => {
    const onlyCode = await answer({ ok: false, error: { code: 'E_X' } });
    assert.deepEqual([onlyCode.code, onlyCode.message], ['E_X', GENERIC]);
    const onlyMessage = await answer({ ok: false, error: { message: 'Short text.' } });
    assert.deepEqual([onlyMessage.code, onlyMessage.message], ['E_UNREACHABLE', 'Short text.']);
  });

  it('a reply that is not an object with ok is "could not reach"', async () => {
    for (const reply of [undefined, null, 'ok', 7, { fine: true }]) {
      const got = await answer(reply);
      assert.equal(got.ok, false, JSON.stringify(reply));
      assert.equal(got.message, UNREACHABLE, JSON.stringify(reply));
    }
  });
});

describe('ui-kit.js: copyImage guards', () => {
  it('is false, and does not throw, when clipboard.write is not a function', async () => {
    const t = setup();
    t.context.navigator = { clipboard: { write: 'not a function' } };
    assert.equal(await t.ui.copyImage(Promise.resolve(t.ui.pngBlob(PNG_BASE64))), false);
  });

  it('is false when the page has no ClipboardItem, and writes nothing', async () => {
    const t = setup();
    delete t.context.ClipboardItem;
    assert.equal(await t.ui.copyImage(Promise.resolve(t.ui.pngBlob(PNG_BASE64))), false);
    assert.equal(t.clipboard.writes.length, 0);
  });

  it('is false when clipboard.write throws at once', async () => {
    const t = setup();
    t.context.navigator = {
      clipboard: {
        write: () => {
          throw new Error('NotAllowedError');
        },
      },
    };
    assert.equal(await t.ui.copyImage(Promise.resolve(t.ui.pngBlob(PNG_BASE64))), false);
  });
});

describe('ui-kit.js: drawPng guards', () => {
  /** A canvas whose context the test holds. */
  function canvasWith(/** @type {any} */ context, width = 112) {
    const canvas = /** @type {any} */ (new FakeElement('canvas'));
    canvas.width = width;
    canvas.getContext = () => context;
    return canvas;
  }

  it('asks for high quality smoothing before it draws', async () => {
    const t = setup();
    /** @type {string[]} */
    const order = [];
    /** @type {any} */
    const context = {
      set imageSmoothingQuality(/** @type {string} */ value) {
        order.push(`quality:${value}`);
      },
      drawImage: () => order.push('draw'),
    };
    assert.equal(await t.ui.drawPng(canvasWith(context), PNG_BASE64), true);
    assert.deepEqual(order, ['quality:high', 'draw']);
  });

  it('is false, and frees the bitmap, when the canvas has no 2d context', async () => {
    const t = setup();
    assert.equal(await t.ui.drawPng(canvasWith(null), PNG_BASE64), false);
    assert.equal(t.bitmaps.closed, 1);
  });

  it('is false for an image with no width, and draws one that is 1 px wide', async () => {
    const t = setup();
    /** @type {number[][]} */
    const drawn = [];
    const context = { imageSmoothingQuality: '', drawImage: (/** @type {any} */ _b, /** @type {number[]} */ ...a) => drawn.push(a) };
    t.context.createImageBitmap = () =>
      Promise.resolve({ width: 0, height: 480, close: () => (t.bitmaps.closed += 1) });
    assert.equal(await t.ui.drawPng(canvasWith(context), PNG_BASE64), false);
    assert.deepEqual(drawn, []);
    assert.equal(t.bitmaps.closed, 1);

    t.context.createImageBitmap = () =>
      Promise.resolve({ width: 1, height: 4, close: () => (t.bitmaps.closed += 1) });
    assert.equal(await t.ui.drawPng(canvasWith(context, 10), PNG_BASE64), true);
    assert.deepEqual(drawn, [[0, 0, 10, 40]]);
  });
});

describe('ui-kit.js: the extension context', () => {
  it('a chrome.runtime that throws when read is an invalid context', () => {
    const t = setup();
    assert.equal(t.ui.contextValid(), true);
    t.context.chrome = {
      get runtime() {
        throw new Error('unloaded');
      },
    };
    assert.equal(t.ui.contextValid(), false);
  });
});

describe('ui-kit.js: focusedElement in nested shadow roots', () => {
  it('follows at most ten shadow roots down', () => {
    const t = setup();
    /** @type {FakeElement[]} */
    const chain = Array.from({ length: 13 }, (_, i) => new FakeElement(`level-${i}`));
    chain.forEach((host, i) => {
      const next = chain[i + 1];
      if (next) host.shadowRoot = /** @type {any} */ ({ activeElement: next });
    });
    t.page.activeElement = chain[0];
    assert.equal(t.ui.focusedElement(), /** @type {any} */ (chain[10]));

    const short = chain.slice(0, 4);
    t.page.activeElement = short[0];
    short[3].shadowRoot = null;
    assert.equal(t.ui.focusedElement(), /** @type {any} */ (short[3]), 'a short chain goes to its end');
  });
});

describe('ui-kit.js: card host, top layer and watchdog', () => {
  it('does not turn the host into a popover where the browser has none', () => {
    const t = setup({ files: [], popover: false });
    const card = t.ui.createCardHost('');
    assert.equal(/** @type {any} */ (card.host).popover, undefined);
    card.destroy();
  });

  it('takes the popover attribute off again when the browser refuses to show it', () => {
    const original = Object.getOwnPropertyDescriptor(FakePopoverElement.prototype, 'popover');
    // A browser reflects `popover` into the attribute: the fake does the same, and refuses to show.
    Object.defineProperty(FakePopoverElement.prototype, 'popover', {
      configurable: true,
      get() {
        return this.attributes.get('popover');
      },
      set(value) {
        if (value !== undefined) this.attributes.set('popover', value);
      },
    });
    const showPopover = FakePopoverElement.prototype.showPopover;
    FakePopoverElement.prototype.showPopover = () => {
      throw new Error('InvalidStateError');
    };
    try {
      const popoverTest = setupCards({ files: ['src/page/ui-kit.js'] });
      const card = popoverTest.ns.ui.createCardHost('');
      assert.equal(/** @type {FakeElement} */ (card.host).attributes.has('popover'), false);
      card.destroy();
    } finally {
      FakePopoverElement.prototype.showPopover = showPopover;
      if (original) Object.defineProperty(FakePopoverElement.prototype, 'popover', original);
      else delete (/** @type {any} */ (FakePopoverElement.prototype).popover);
    }
  });

  it('checks the top layer at 40 px from the bottom right corner of the window', () => {
    const t = setup();
    /** @type {number[][]} */
    const asked = [];
    const card = t.ui.createCardHost('');
    const host = /** @type {FakePopoverElement} */ (card.host);
    t.context.document.elementsFromPoint = (/** @type {number} */ x, /** @type {number} */ y) => {
      asked.push([x, y]);
      return [host];
    };
    card.keepOnTop();
    t.context.innerWidth = 500;
    t.context.innerHeight = 300;
    card.keepOnTop();
    assert.deepEqual(asked, [
      [960, 760],
      [460, 260],
    ]);
    assert.equal(host.hidden, 0, 'it is on top: nothing is shown again');
    card.destroy();
  });

  it('a destroyed card is not moved by keepOnTop', () => {
    const t = setup();
    const card = t.ui.createCardHost('');
    const host = /** @type {FakePopoverElement} */ (card.host);
    card.destroy();
    t.page.modals.push(new FakeElement('dialog'));
    const shown = host.shown;
    card.keepOnTop();
    assert.equal(host.parentNode, null);
    assert.equal(host.shown, shown);
  });

  it('the watchdog moves the card into a dialog that opened, and checks every second', () => {
    const t = setup();
    const card = t.ui.createCardHost('');
    const host = /** @type {FakePopoverElement} */ (card.host);
    const dialog = new FakeElement('dialog');
    t.page.modals.push(dialog);
    t.timers.advance(999);
    assert.equal(host.parentNode, t.documentElement, 'not before a second');
    t.timers.advance(1);
    assert.equal(host.parentNode, dialog);
    card.destroy();
  });

  it('the watchdog notices a reloaded extension after one second, not before', () => {
    const t = setup();
    let orphan = 0;
    const card = t.ui.createCardHost('', { onOrphan: () => (orphan += 1) });
    t.extension.id = undefined;
    t.timers.advance(999);
    assert.equal(card.isDestroyed(), false);
    t.timers.advance(1);
    assert.equal(card.isDestroyed(), true);
    assert.equal(orphan, 1);
  });

  it('puts the card in the topmost of several open modal dialogs', () => {
    const t = setup();
    const first = new FakeElement('dialog');
    const second = new FakeElement('dialog');
    t.page.modals.push(first, second);
    const card = t.ui.createCardHost('');
    assert.equal(/** @type {FakeElement} */ (card.host).parentNode, second);
    card.destroy();
  });
});

describe('ui-kit.js: icons and frame owners', () => {
  it('draws an icon at 16 px unless a size is given', () => {
    const { ui } = setup();
    const size = (/** @type {unknown} */ node) =>
      /** @type {FakeElement} */ (node).attributes.get('width');
    assert.equal(size(ui.icon('check')), '16');
    assert.equal(size(ui.icon('check', 'x', 14)), '14');
    assert.equal(/** @type {FakeElement} */ (/** @type {unknown} */ (ui.icon('check'))).attributes.get('height'), '16');
  });

  it('knows the elements that hold another document, in any letter case', () => {
    const { ui } = setup();
    for (const tag of ['iframe', 'FRAME', 'Object', 'embed']) {
      assert.equal(ui.isFrameOwner(/** @type {any} */ ({ tagName: tag })), true, tag);
    }
    for (const tag of ['div', 'BODY', 'IFRAMES', '']) {
      assert.equal(ui.isFrameOwner(/** @type {any} */ ({ tagName: tag })), false, tag);
    }
    assert.equal(ui.isFrameOwner(null), false);
    assert.equal(ui.isFrameOwner(new FakeElement('iframe')), true);
  });

  it('is false, and does not throw, when the tag cannot be read', () => {
    const { ui } = setup();
    const hostile = {
      get tagName() {
        throw new Error('blocked');
      },
    };
    assert.equal(ui.isFrameOwner(/** @type {any} */ (hostile)), false);
  });
});
