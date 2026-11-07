// @ts-check
import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MAX_TOTAL_HEIGHT_PX, TILE_TIERS } from '../../src/shared/constants.js';
import {
  DEFAULT_SETTINGS,
  SETTINGS_LIMITS,
  SETTINGS_STORAGE_KEY,
  loadSettings,
  normalizeSettings,
  saveSettings,
} from '../../src/shared/settings.js';
import { installFakeChrome } from '../helpers/fake-chrome.js';

const DEFAULTS = {
  overlapCss: 80,
  settleMs: 350,
  maxHeightCss: 40_000,
  hideOverlays: true,
  tileTier: 'high',
  saveTiles: true,
  saveFull: true,
  copyOnDone: true,
  folderName: 'Spool',
};

const NUMERIC_KEYS = /** @type {const} */ (['overlapCss', 'settleMs', 'maxHeightCss']);
const BOOLEAN_KEYS = /** @type {const} */ (['hideOverlays', 'saveTiles', 'saveFull', 'copyOnDone']);

/**
 * In-memory stand-in for a chrome.storage area. Records every call.
 * @param {Record<string, unknown>} [initial]
 */
function memoryArea(initial = {}) {
  /** @type {Record<string, unknown>} */
  const data = { ...initial };
  /** @type {[string, unknown][]} */
  const calls = [];
  const area = {
    data,
    calls,
    /** @param {string} key */
    async get(key) {
      calls.push(['get', key]);
      return Object.hasOwn(data, key) ? { [key]: data[key] } : {};
    },
    /** @param {Record<string, unknown>} items */
    async set(items) {
      calls.push(['set', items]);
      Object.assign(data, structuredClone(items));
    },
  };
  return area;
}

/** @param {ReturnType<typeof memoryArea>} area */
function asArea(area) {
  return /** @type {chrome.storage.StorageArea} */ (/** @type {unknown} */ (area));
}

describe('defaults and limits', () => {
  it('DEFAULT_SETTINGS has the documented values and is frozen', () => {
    assert.deepEqual({ ...DEFAULT_SETTINGS }, DEFAULTS);
    assert.ok(Object.isFrozen(DEFAULT_SETTINGS));
  });

  it('SETTINGS_LIMITS has the documented ranges and is frozen', () => {
    assert.deepEqual(
      { ...SETTINGS_LIMITS },
      { overlapCss: [16, 400], settleMs: [0, 3000], maxHeightCss: [1000, 100_000] },
    );
    assert.ok(Object.isFrozen(SETTINGS_LIMITS));
  });

  it('every default is inside its own limits', () => {
    for (const key of NUMERIC_KEYS) {
      const [min, max] = SETTINGS_LIMITS[key];
      assert.ok(DEFAULT_SETTINGS[key] >= /** @type {number} */ (min), key);
      assert.ok(DEFAULT_SETTINGS[key] <= /** @type {number} */ (max), key);
    }
    assert.ok(Object.hasOwn(TILE_TIERS, DEFAULT_SETTINGS.tileTier));
  });

  it('the largest maxHeightCss stays under MAX_TOTAL_HEIGHT_PX up to 3x device scale', () => {
    // The comment in settings.js gives this reason for the limit of 100,000 CSS px: the hard
    // limit of the offscreen store is in device px, and the user limit is reached first.
    const [, max] = SETTINGS_LIMITS.maxHeightCss;
    assert.ok(max * 3 <= MAX_TOTAL_HEIGHT_PX, `${max} * 3 > ${MAX_TOTAL_HEIGHT_PX}`);
  });

  it('every limit is a whole-number range with min <= max', () => {
    for (const [key, [min, max]] of Object.entries(SETTINGS_LIMITS)) {
      assert.ok(Number.isInteger(min) && Number.isInteger(max), key);
      assert.ok(min <= max, key);
    }
  });

  it('uses the storage key "settings"', () => {
    assert.equal(SETTINGS_STORAGE_KEY, 'settings');
  });
});

describe('normalizeSettings: input that is not an object', () => {
  it('returns the defaults', () => {
    for (const raw of [undefined, null, 'text', 42, true, false, [], [1, 2, 3], () => 1]) {
      assert.deepEqual(normalizeSettings(raw), DEFAULTS, String(raw));
    }
    assert.deepEqual(normalizeSettings({}), DEFAULTS);
  });

  it('returns a new object each time, so callers cannot change the defaults', () => {
    const a = normalizeSettings(undefined);
    assert.notEqual(a, DEFAULT_SETTINGS);
    a.overlapCss = 999;
    assert.equal(DEFAULT_SETTINGS.overlapCss, 80);
    assert.equal(normalizeSettings(undefined).overlapCss, 80);
    assert.notEqual(normalizeSettings({}), normalizeSettings({}));
  });
});

describe('normalizeSettings: numbers', () => {
  for (const key of NUMERIC_KEYS) {
    const [min, max] = /** @type {[number, number]} */ (SETTINGS_LIMITS[key]);
    const fallback = DEFAULTS[key];

    describe(key, () => {
      it('keeps a value inside the range', () => {
        for (const v of [min, min + 1, Math.round((min + max) / 2), max - 1, max]) {
          assert.equal(normalizeSettings({ [key]: v })[key], v, String(v));
        }
      });

      it('clamps to the minimum and the maximum', () => {
        const tooLow = [min - 1, min - 1000, -1, -1e9, Number.MIN_SAFE_INTEGER, -Number.MAX_VALUE];
        for (const v of tooLow) {
          assert.equal(normalizeSettings({ [key]: v })[key], min, String(v));
        }
        for (const v of [max + 1, max * 10, 1e12, Number.MAX_SAFE_INTEGER, Number.MAX_VALUE]) {
          assert.equal(normalizeSettings({ [key]: v })[key], max, String(v));
        }
      });

      it('rounds to an integer before it clamps', () => {
        const mid = Math.round((min + max) / 2);
        assert.equal(normalizeSettings({ [key]: mid + 0.4 })[key], mid);
        assert.equal(normalizeSettings({ [key]: mid + 0.5 })[key], mid + 1);
        assert.equal(normalizeSettings({ [key]: mid + 0.6 })[key], mid + 1);
        assert.equal(normalizeSettings({ [key]: min - 0.4 })[key], min);
        assert.equal(normalizeSettings({ [key]: max + 0.4 })[key], max);
        assert.equal(normalizeSettings({ [key]: max - 0.5 })[key], max);
      });

      it('uses the default for a value that is not a finite number', () => {
        for (const v of [
          NaN,
          Infinity,
          -Infinity,
          '100',
          '',
          null,
          undefined,
          true,
          {},
          [],
          [100],
          new Number(100),
          10n,
          () => 100,
        ]) {
          assert.equal(normalizeSettings({ [key]: v })[key], fallback, String(v));
        }
      });

      it('never returns -0', () => {
        assert.ok(!Object.is(normalizeSettings({ [key]: -0.4 })[key], -0));
        assert.ok(!Object.is(normalizeSettings({ [key]: -0 })[key], -0));
      });
    });
  }

  it('the documented example values from the plan', () => {
    const s = normalizeSettings({ overlapCss: 80.5, settleMs: -0.4, maxHeightCss: 1e9 });
    assert.equal(s.overlapCss, 81);
    assert.equal(s.settleMs, 0);
    assert.equal(s.maxHeightCss, 100_000);
  });
});

describe('normalizeSettings: booleans', () => {
  for (const key of BOOLEAN_KEYS) {
    it(`${key}: keeps true and false`, () => {
      assert.equal(normalizeSettings({ [key]: true })[key], true);
      assert.equal(normalizeSettings({ [key]: false })[key], false);
    });

    it(`${key}: uses the default for anything else`, () => {
      for (const v of ['true', 'false', 0, 1, null, undefined, {}, [], 'yes', new Boolean(false)]) {
        assert.equal(normalizeSettings({ [key]: v })[key], true, String(v));
      }
    });
  }
});

describe('normalizeSettings: tileTier', () => {
  it('keeps every tier of TILE_TIERS', () => {
    for (const tier of Object.keys(TILE_TIERS)) {
      assert.equal(normalizeSettings({ tileTier: tier }).tileTier, tier);
    }
    assert.deepEqual(Object.keys(TILE_TIERS).sort(), ['high', 'standard']);
  });

  it('uses the default for any other value', () => {
    for (const v of [
      'low',
      'High',
      'STANDARD',
      ' high',
      'high ',
      '',
      null,
      undefined,
      5,
      {},
      ['high'],
      // Names that exist on every object: they must not count as tiers.
      'toString',
      'constructor',
      '__proto__',
      'hasOwnProperty',
      'valueOf',
    ]) {
      assert.equal(normalizeSettings({ tileTier: v }).tileTier, 'high', String(v));
    }
  });
});

describe('normalizeSettings: folderName', () => {
  /** @param {unknown} v */
  const folder = (v) => normalizeSettings({ folderName: v }).folderName;

  it('keeps a good name', () => {
    assert.equal(folder('My Shots'), 'My Shots');
    assert.equal(folder('Spool-2026_v2'), 'Spool-2026_v2');
  });

  it('replaces characters that a file name cannot contain', () => {
    assert.equal(folder('a/b'), 'a b');
    assert.equal(folder('a\\b'), 'a b');
    assert.equal(folder('a:b*c?d"e<f>g|h'), 'a b c d e f g h');
    assert.equal(folder('../../etc'), 'etc');
    assert.equal(folder('C:\\Windows'), 'C Windows');
  });

  it('cannot become a path that leaves the Downloads folder', () => {
    for (const v of ['..', '../..', '/abs', '\\\\server\\share', '~/x', '.', '...', ' . ']) {
      const out = folder(v);
      assert.ok(!out.includes('/') && !out.includes('\\'), v);
      assert.ok(!out.startsWith('.'), v);
      assert.ok(out !== '' && out !== '..', v);
    }
  });

  it('uses the default for names that are empty or reserved', () => {
    const unusable = ['', ' ', '   ', '.', '..', '<>', 'CON', 'nul', 'aux.txt', 'COM1', 'lpt9'];
    for (const v of unusable) {
      assert.equal(folder(v), 'Spool', JSON.stringify(v));
    }
  });

  it('uses the default for anything that is not a string', () => {
    for (const v of [undefined, null, 5, true, {}, [], ['name']]) {
      assert.equal(folder(v), 'Spool', String(v));
    }
  });

  it('cuts the name to 40 characters', () => {
    assert.equal(folder('x'.repeat(100)), 'x'.repeat(40));
    assert.equal(folder('x'.repeat(40)), 'x'.repeat(40));
    const cutAtSpace = folder(`${'x'.repeat(39)} yyyy`);
    assert.equal(cutAtSpace, 'x'.repeat(39), 'no trailing space after the cut');
  });

  it('collapses white space and trims', () => {
    assert.equal(folder('  a   b\t\nc  '), 'a b c');
  });

  it('normalizes Unicode to NFC and keeps non-Latin letters', () => {
    assert.equal(folder('Cafe\u0301'), 'Caf\u00e9');
    assert.equal(folder('スクリーンショット'), 'スクリーンショット');
  });
});

describe('normalizeSettings: other input rules', () => {
  it('drops unknown keys', () => {
    const out = normalizeSettings({ ...DEFAULTS, extra: 1, __secret: 'x', password: 'p' });
    assert.deepEqual(Object.keys(out).sort(), Object.keys(DEFAULTS).sort());
    assert.deepEqual(out, DEFAULTS);
  });

  it('does not change its input', () => {
    const input = { overlapCss: 9999, folderName: 'a/b', extra: 1, tileTier: 'nope' };
    const copy = structuredClone(input);
    normalizeSettings(input);
    assert.deepEqual(input, copy);
  });

  it('is not changed by prototype keys in the input', () => {
    const raw = JSON.parse('{"__proto__":{"overlapCss":5,"polluted":true},"constructor":{"x":1}}');
    const out = normalizeSettings(raw);
    assert.deepEqual(out, DEFAULTS);
    assert.equal(/** @type {any} */ ({}).polluted, undefined);
  });

  it('handles all fields at once', () => {
    const out = normalizeSettings({
      overlapCss: 120,
      settleMs: 1000,
      maxHeightCss: 5000,
      hideOverlays: false,
      tileTier: 'standard',
      saveTiles: false,
      saveFull: false,
      copyOnDone: false,
      folderName: 'Work shots',
    });
    assert.deepEqual(out, {
      overlapCss: 120,
      settleMs: 1000,
      maxHeightCss: 5000,
      hideOverlays: false,
      tileTier: 'standard',
      saveTiles: false,
      saveFull: false,
      copyOnDone: false,
      folderName: 'Work shots',
    });
  });

  it('is idempotent: normalizing a result changes nothing', () => {
    const inputs = [
      undefined,
      {},
      { overlapCss: 1e6, settleMs: -5, maxHeightCss: 'big', tileTier: 'x', folderName: 'a/b' },
      { overlapCss: 12.5, settleMs: 2999.5, hideOverlays: 'no', folderName: '  ..  ' },
      { saveTiles: false, saveFull: false, tileTier: 'standard', folderName: 'é'.repeat(80) },
      { folderName: '😀'.repeat(30) },
    ];
    for (const raw of inputs) {
      const once = normalizeSettings(raw);
      assert.deepEqual(normalizeSettings(once), once, JSON.stringify(raw));
    }
  });
});

describe('loadSettings and saveSettings', () => {
  it('loadSettings returns the defaults when nothing is stored', async () => {
    const area = memoryArea();
    assert.deepEqual(await loadSettings(asArea(area)), DEFAULTS);
    assert.deepEqual(area.calls, [['get', 'settings']]);
  });

  it('loadSettings normalizes what is stored', async () => {
    const area = memoryArea({
      settings: { overlapCss: 5000, tileTier: 'standard', junk: 1, folderName: 'x/y' },
    });
    assert.deepEqual(await loadSettings(asArea(area)), {
      ...DEFAULTS,
      overlapCss: 400,
      tileTier: 'standard',
      folderName: 'x y',
    });
  });

  it('loadSettings returns the defaults for stored data that is not an object', async () => {
    for (const stored of ['text', 5, null, true, []]) {
      const area = memoryArea({ settings: stored });
      assert.deepEqual(await loadSettings(asArea(area)), DEFAULTS, String(stored));
    }
  });

  it('loadSettings copes with a storage area that returns nothing', async () => {
    const area = /** @type {any} */ ({ get: async () => undefined });
    assert.deepEqual(await loadSettings(area), DEFAULTS);
  });

  it('loadSettings passes on a storage failure', async () => {
    const area = /** @type {any} */ ({
      get: async () => {
        throw new Error('storage down');
      },
    });
    await assert.rejects(loadSettings(area), /storage down/);
  });

  it('saveSettings merges into what is stored, writes it all and returns it', async () => {
    const area = memoryArea({ settings: { settleMs: 700, saveFull: false } });
    const out = await saveSettings({ overlapCss: 120 }, asArea(area));
    const expected = { ...DEFAULTS, settleMs: 700, saveFull: false, overlapCss: 120 };
    assert.deepEqual(out, expected);
    assert.deepEqual(area.data.settings, expected);
    assert.deepEqual(
      area.calls.filter(([name]) => name === 'set'),
      [['set', { settings: expected }]],
    );
  });

  it('saveSettings writes the defaults plus the change when nothing was stored', async () => {
    const area = memoryArea();
    await saveSettings({ tileTier: 'standard' }, asArea(area));
    assert.deepEqual(area.data.settings, { ...DEFAULTS, tileTier: 'standard' });
  });

  it('saveSettings validates: clamps, sanitizes, and drops unknown keys', async () => {
    const area = memoryArea();
    const out = await saveSettings(
      /** @type {any} */ ({
        overlapCss: 99999,
        folderName: 'a/b',
        evil: '<script>',
        tileTier: 'x',
      }),
      asArea(area),
    );
    assert.deepEqual(out, { ...DEFAULTS, overlapCss: 400, folderName: 'a b' });
    assert.ok(!('evil' in /** @type {object} */ (area.data.settings)));
  });

  it('saveSettings keeps earlier changes over several saves', async () => {
    const area = memoryArea();
    await saveSettings({ overlapCss: 100 }, asArea(area));
    await saveSettings({ saveTiles: false }, asArea(area));
    const out = await saveSettings({ folderName: 'Mine' }, asArea(area));
    assert.deepEqual(out, { ...DEFAULTS, overlapCss: 100, saveTiles: false, folderName: 'Mine' });
    assert.deepEqual(await loadSettings(asArea(area)), out);
  });

  it('saveSettings passes on storage failures and does not claim success', async () => {
    const failingSet = /** @type {any} */ ({
      get: async () => ({}),
      set: async () => {
        throw new Error('quota exceeded');
      },
    });
    await assert.rejects(saveSettings({ overlapCss: 100 }, failingSet), /quota exceeded/);
    const failingGet = /** @type {any} */ ({
      get: async () => {
        throw new Error('read failed');
      },
      set: async () => assert.fail('must not write after a failed read'),
    });
    await assert.rejects(saveSettings({ overlapCss: 100 }, failingGet), /read failed/);
  });

  describe('with chrome.storage.sync as the default area', () => {
    /** @type {ReturnType<typeof installFakeChrome>} */
    let fake;
    beforeEach(() => {
      fake = installFakeChrome();
    });
    afterEach(() => {
      fake.uninstall();
    });

    it('loadSettings reads chrome.storage.sync', async () => {
      fake.state.storage.settings = { settleMs: 1234 };
      assert.deepEqual(await loadSettings(), { ...DEFAULTS, settleMs: 1234 });
      assert.deepEqual(fake.argsOf('storage.sync.get'), [['settings']]);
    });

    it('saveSettings writes chrome.storage.sync', async () => {
      await saveSettings({ saveFull: false });
      assert.deepEqual(fake.state.storage.settings, { ...DEFAULTS, saveFull: false });
    });
  });
});
