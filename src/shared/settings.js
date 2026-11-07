// @ts-check
/**
 * User settings: defaults, validation and storage. Settings are not sensitive and are stored in
 * chrome.storage.sync. Image data is never stored.
 */

import { TILE_TIERS } from './constants.js';
import { sanitizePathSegment } from '../lib/names.js';

/** @typedef {import('./types.js').Settings} Settings */

/** @type {Readonly<Settings>} */
export const DEFAULT_SETTINGS = Object.freeze({
  overlapCss: 80,
  settleMs: 350,
  maxHeightCss: 40_000,
  hideOverlays: true,
  tileTier: 'high',
  saveTiles: true,
  saveFull: true,
  copyOnDone: true,
  folderName: 'Spool',
});

/** Inclusive [min, max] for numeric settings. */
export const SETTINGS_LIMITS = Object.freeze({
  overlapCss: Object.freeze([16, 400]),
  settleMs: Object.freeze([0, 3000]),
  // 100,000 CSS px stays under MAX_TOTAL_HEIGHT_PX (300,000 device px) up to 3x device scale.
  maxHeightCss: Object.freeze([1000, 100_000]),
});

export const SETTINGS_STORAGE_KEY = 'settings';

/**
 * @param {unknown} v
 * @param {readonly number[]} limits
 * @param {number} fallback
 */
function clampInt(v, limits, fallback) {
  if (typeof v !== 'number' || !Number.isFinite(v)) return fallback;
  const [min = fallback, max = fallback] = limits;
  return Math.min(max, Math.max(min, Math.round(v)));
}

/**
 * @param {unknown} v
 * @param {boolean} fallback
 */
function bool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

/**
 * Returns complete, valid settings from any input. Unknown keys are dropped; bad values fall back
 * to defaults; numbers are rounded and clamped.
 * @param {unknown} raw
 * @returns {Settings}
 */
export function normalizeSettings(raw) {
  const r = typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
  const d = DEFAULT_SETTINGS;
  const tier = typeof r.tileTier === 'string' && Object.hasOwn(TILE_TIERS, r.tileTier) ? r.tileTier : d.tileTier;
  return {
    overlapCss: clampInt(r.overlapCss, SETTINGS_LIMITS.overlapCss, d.overlapCss),
    settleMs: clampInt(r.settleMs, SETTINGS_LIMITS.settleMs, d.settleMs),
    maxHeightCss: clampInt(r.maxHeightCss, SETTINGS_LIMITS.maxHeightCss, d.maxHeightCss),
    hideOverlays: bool(r.hideOverlays, d.hideOverlays),
    tileTier: /** @type {Settings['tileTier']} */ (tier),
    saveTiles: bool(r.saveTiles, d.saveTiles),
    saveFull: bool(r.saveFull, d.saveFull),
    copyOnDone: bool(r.copyOnDone, d.copyOnDone),
    folderName: sanitizePathSegment(r.folderName, 40, d.folderName),
  };
}

/**
 * @param {chrome.storage.StorageArea} [area]
 * @returns {Promise<Settings>}
 */
export async function loadSettings(area = chrome.storage.sync) {
  const got = await area.get(SETTINGS_STORAGE_KEY);
  return normalizeSettings(got?.[SETTINGS_STORAGE_KEY]);
}

/**
 * Merges `partial` into the stored settings, validates, stores and returns the result.
 * @param {Partial<Settings>} partial
 * @param {chrome.storage.StorageArea} [area]
 * @returns {Promise<Settings>}
 */
export async function saveSettings(partial, area = chrome.storage.sync) {
  const current = await loadSettings(area);
  const next = normalizeSettings({ ...current, ...partial });
  await area.set({ [SETTINGS_STORAGE_KEY]: next });
  return next;
}
