// @ts-check
/**
 * Browser-side helper of the fixture pages: builds the band elements.
 * The colour code lives in e2e/bands.js (served as /bands.js), so the pages and the test
 * verifier cannot disagree.
 */

import { BAND_CSS, bandCss, hasLine, LINE_SHADOW } from '../bands.js';

/**
 * @param {number} index
 * @returns {HTMLDivElement}
 */
export function createBand(index) {
  const el = document.createElement('div');
  el.className = 'band';
  el.dataset['i'] = String(index);
  el.style.height = `${BAND_CSS}px`;
  el.style.background = bandCss(index);
  if (hasLine(index)) el.style.boxShadow = LINE_SHADOW;
  return el;
}

/**
 * Appends bands `from` up to (not including) `to`.
 * @param {Element} container
 * @param {number} from
 * @param {number} to
 */
export function appendBands(container, from, to) {
  const fragment = document.createDocumentFragment();
  for (let i = from; i < to; i++) fragment.appendChild(createBand(i));
  container.appendChild(fragment);
}

/**
 * Number of bands: the `bands` query parameter, or `fallback`.
 * @param {number} fallback
 * @returns {number}
 */
export function bandCountFromQuery(fallback) {
  const value = Number(new URLSearchParams(location.search).get('bands'));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}
