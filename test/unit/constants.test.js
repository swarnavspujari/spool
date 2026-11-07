// @ts-check
/**
 * Tests for src/shared/constants.js. Added by mutation testing.
 *
 * Before this file, no unit test looked at the values themselves: 136 of 162 mutants of the
 * module survived the tests of the libraries that use it. Two kinds of check are here:
 * - values that a source outside the code fixes (the documents in docs/, the
 *   limits of Chrome and of the chat apps). The source is named at each one, so a change must
 *   change a document too.
 * - facts that must hold between the constants, and between the constants and the repository.
 * The file adds no assertion for a constant that a later change may add or change.
 */

import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import * as constants from '../../src/shared/constants.js';
import { planTiles, tileGeometry } from '../../src/lib/tiles.js';

const {
  CAPTURE_MIN_INTERVAL_MS,
  CAPTURE_READBACK_RETRY_DELAY_MS,
  CAPTURE_READBACK_RETRY_LIMIT,
  CAPTURE_RETRY_DELAY_MS,
  CAPTURE_RETRY_LIMIT,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_DIMENSION_PX,
  MAX_IMAGES_PER_MESSAGE,
  MAX_TOTAL_HEIGHT_PX,
  PATCH_PX,
  PATHS,
  RESTRICTED_HOSTS,
  RESTRICTED_SCHEMES,
  SEAM,
  SEAM_STATUSES,
  SESSION_IDLE_MS,
  SESSION_MAX_BYTES,
  SESSION_TTL_MS,
  SIGNATURE_MAX_COLS,
  TILE_OVERLAP_PX,
  TILE_TIERS,
  TOTAL_MAX_BYTES,
} = constants;

const ROOT = join(import.meta.dirname, '..', '..');
const MIB = 1024 * 1024;

describe('capture rate (Chrome allows 2 captureVisibleTab calls per second)', () => {
  it('keeps the gap between calls at 500 ms or more, with a margin', () => {
    // docs/architecture.md: "starts each call at least 550 ms after the" one before.
    assert.ok(CAPTURE_MIN_INTERVAL_MS >= 500, 'at 2 calls per second the gap is 500 ms');
    assert.equal(CAPTURE_MIN_INTERVAL_MS, 550);
  });

  it('waits at least one gap before a retry, and retries a few times', () => {
    // docs/contracts.md section 2: "quota retries (600 ms each)", up to 3.
    assert.ok(CAPTURE_RETRY_DELAY_MS >= CAPTURE_MIN_INTERVAL_MS);
    assert.equal(CAPTURE_RETRY_DELAY_MS, 600);
    assert.ok(Number.isInteger(CAPTURE_RETRY_LIMIT) && CAPTURE_RETRY_LIMIT >= 1);
    assert.equal(CAPTURE_RETRY_LIMIT, 3);
  });

  it('retries "image readback failed" a few times, a few frames apart', () => {
    assert.ok(Number.isInteger(CAPTURE_READBACK_RETRY_LIMIT) && CAPTURE_READBACK_RETRY_LIMIT >= 1);
    assert.equal(CAPTURE_READBACK_RETRY_LIMIT, 2);
    assert.ok(CAPTURE_READBACK_RETRY_DELAY_MS >= 50 && CAPTURE_READBACK_RETRY_DELAY_MS <= 250);
    assert.equal(CAPTURE_READBACK_RETRY_DELAY_MS, 100);
  });
});

describe('tile tiers (image limits of the AI vision models)', () => {
  it('has the tiers high and standard with the limits of the vision models', () => {
    assert.equal(PATCH_PX, 28);
    assert.deepEqual({ ...TILE_TIERS.high }, { maxLongEdgePx: 2576, maxPatches: 4784 });
    assert.deepEqual({ ...TILE_TIERS.standard }, { maxLongEdgePx: 1568, maxPatches: 1568 });
  });

  it('is frozen, with frozen tiers, so no code can change a limit at run time', () => {
    assert.ok(Object.isFrozen(TILE_TIERS));
    for (const tier of Object.values(TILE_TIERS)) assert.ok(Object.isFrozen(tier));
  });

  it('has a long edge that is a whole number of patches, so a full tile has no partial patch', () => {
    for (const [name, { maxLongEdgePx }] of Object.entries(TILE_TIERS)) {
      assert.equal(maxLongEdgePx % PATCH_PX, 0, name);
    }
  });

  it('keeps every tile edge inside the upload limit of the chat apps', () => {
    for (const [name, { maxLongEdgePx }] of Object.entries(TILE_TIERS)) {
      assert.ok(maxLongEdgePx <= MAX_IMAGE_DIMENSION_PX, name);
    }
  });

  it('overlaps tiles by two patches, and always less than a tile is tall', () => {
    assert.equal(TILE_OVERLAP_PX, 2 * PATCH_PX);
    for (const [name, { maxLongEdgePx }] of Object.entries(TILE_TIERS)) {
      // The narrowest tile height of a tier is at the widest image: the long edge.
      assert.ok(TILE_OVERLAP_PX < tileGeometry(maxLongEdgePx, /** @type {any} */ (name)).tileHeightOut);
      // So the default overlap never makes planTiles throw, for any width up to the long edge.
      assert.doesNotThrow(() => planTiles(maxLongEdgePx, 10 * maxLongEdgePx, /** @type {any} */ (name)));
    }
  });

  it('states the limits of the chat apps (20 images and 8000 px)', () => {
    assert.equal(MAX_IMAGES_PER_MESSAGE, 20);
    assert.equal(MAX_IMAGE_DIMENSION_PX, 8000);
    assert.equal(MAX_IMAGE_BYTES, 10 * MIB);
  });
});

describe('seam matching (docs/contracts.md section 4)', () => {
  it('has the values that the contract gives for the offscreen store', () => {
    assert.equal(SEAM.threshold, 3);
    assert.equal(SEAM.maxRowDiff, 24);
    assert.equal(SEAM.flatStdDev, 2);
    assert.equal(SEAM.minOverlapRows, 16);
    assert.equal(SEAM.maxShiftRows, 256);
    assert.equal(SIGNATURE_MAX_COLS, 128);
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(SEAM));
    assert.ok(Object.isFrozen(SEAM_STATUSES));
  });

  it('lets one bad row fail an overlap that the mean would pass', () => {
    // The row rule exists because a mostly blank overlap passes the mean threshold. It must be
    // looser than the mean (or it would refuse noise), and the search must be able to move.
    assert.ok(SEAM.maxRowDiff > SEAM.threshold);
    assert.ok(SEAM.minOverlapRows >= 1);
    assert.ok(SEAM.maxShiftRows >= SEAM.minOverlapRows);
    assert.ok(SEAM.flatStdDev > 0);
  });

  it('lists the statuses of the SeamStatus type in src/shared/types.js, in the same order', () => {
    const types = readFileSync(join(ROOT, 'src/shared/types.js'), 'utf8');
    const match = /@typedef \{([^}]*)\} SeamStatus/.exec(types);
    assert.ok(match, 'the SeamStatus typedef');
    const declared = (match[1] ?? '').split('|').map((word) => word.trim().replaceAll("'", ''));
    assert.deepEqual([...SEAM_STATUSES], declared);
  });
});

describe('memory and time limits (docs/threat-model.md, docs/architecture.md)', () => {
  it('limits one session to 512 MiB and all sessions to 1 GiB, which is two sessions', () => {
    assert.equal(SESSION_MAX_BYTES, 512 * MIB);
    assert.equal(TOTAL_MAX_BYTES, 1024 * MIB);
    assert.equal(TOTAL_MAX_BYTES, 2 * SESSION_MAX_BYTES);
  });

  it('drops a finished session after 15 minutes and an idle one after 30', () => {
    assert.equal(SESSION_TTL_MS, 15 * 60 * 1000);
    assert.equal(SESSION_IDLE_MS, 30 * 60 * 1000);
  });

  it('limits the image height to 300,000 device px', () => {
    // docs/contracts.md section 3: E_SESSION_TOO_LARGE for MAX_TOTAL_HEIGHT_PX.
    assert.equal(MAX_TOTAL_HEIGHT_PX, 300_000);
    assert.ok(Number.isSafeInteger(MAX_TOTAL_HEIGHT_PX));
  });
});

describe('pages where extensions cannot run (RESTRICTED_SCHEMES, RESTRICTED_HOSTS)', () => {
  it('lists the schemes of the browser pages, the extension pages and the viewers', () => {
    const required = [
      'chrome:', 'chrome-extension:', 'chrome-untrusted:', 'chrome-search:', 'devtools:',
      'view-source:', 'about:', 'edge:', 'brave:', 'comet:', 'opera:', 'vivaldi:',
    ];
    assert.deepEqual([...RESTRICTED_SCHEMES].sort(), required.sort());
  });

  it('writes each scheme in lower case with a colon and nothing else', () => {
    for (const scheme of RESTRICTED_SCHEMES) {
      assert.match(scheme, /^[a-z][a-z-]*:$/, scheme);
    }
  });

  it('lists the web stores, as bare lower case host names', () => {
    assert.deepEqual([...RESTRICTED_HOSTS].sort(), [
      'chrome.google.com',
      'chromewebstore.google.com',
      'microsoftedge.microsoft.com',
    ]);
    for (const host of RESTRICTED_HOSTS) {
      assert.match(host, /^[a-z0-9.-]+$/, host);
    }
  });

  it('is frozen', () => {
    assert.ok(Object.isFrozen(RESTRICTED_SCHEMES));
    assert.ok(Object.isFrozen(RESTRICTED_HOSTS));
  });
});

describe('PATHS (extension-relative paths of its own pages and scripts)', () => {
  /** @param {unknown} value @returns {string[]} */
  const flatten = (value) =>
    Array.isArray(value)
      ? value.flatMap(flatten)
      : typeof value === 'string'
        ? [value]
        : value !== null && typeof value === 'object'
          ? Object.values(value).flatMap(flatten)
          : [];

  it('names files that exist in the repository', () => {
    const paths = flatten(PATHS);
    assert.ok(paths.length >= 7, 'service worker, 3 pages and the page scripts');
    for (const path of paths) {
      assert.ok(existsSync(join(ROOT, path)), `${path} does not exist`);
    }
  });

  it('agrees with manifest.json for the service worker and the options page', () => {
    const manifest = JSON.parse(readFileSync(join(ROOT, 'manifest.json'), 'utf8'));
    assert.equal(manifest.background.service_worker, PATHS.serviceWorker);
    assert.equal(manifest.options_ui.page, PATHS.options);
  });

  it('is frozen, also the list of page scripts', () => {
    assert.ok(Object.isFrozen(PATHS));
    assert.ok(Object.isFrozen(PATHS.pageScripts));
  });

  it('injects page-lib.js before the scripts that need it', () => {
    // The page scripts register on globalThis.__spool in this order (CONTRIBUTING.md).
    const scripts = [...PATHS.pageScripts];
    assert.equal(scripts[0], 'src/page/page-lib.js');
    for (const required of ['src/page/overlay.js', 'src/page/agent.js']) {
      assert.ok(scripts.includes(required), `${required} is injected`);
    }
    assert.ok(scripts.indexOf('src/page/overlay.js') < scripts.indexOf('src/page/agent.js'));
    assert.equal(new Set(scripts).size, scripts.length, 'no script twice');
  });
});
