// @ts-check
/**
 * Browser implementation of the finalize step's RenderOps (see finalize.js): it joins the slice
 * store and the renderer of src/render/render.js. Only src/render touches OffscreenCanvas and
 * createImageBitmap for the output images, so finalize stays testable in Node.
 */

import { createRenderer, createSliceStore } from '../render/render.js';

/** @typedef {import('./finalize.js').RenderOps} RenderOps */

/** @returns {RenderOps} */
export function createRenderOps() {
  return {
    open({ blobs, pieces, widthPx, totalHeight }) {
      const store = createSliceStore();
      for (const [index, blob] of blobs) store.add(index, blob);
      const renderer = createRenderer({ store, pieces, widthPx, totalHeight });
      return {
        renderTile: (plan) => renderer.renderTile(plan),
        buildFullPng: () => renderer.buildFullPng(),
        dispose: () => store.dispose(),
      };
    },
  };
}
