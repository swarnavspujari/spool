// @ts-check
/**
 * Playwright global setup: builds the test copy of the extension once per run and tells the
 * workers where it is (environment variables set here are visible in the worker processes).
 */

import { EXTENSION_DIR_ENV, buildExtension } from './build-extension.mjs';

export default async function globalSetup() {
  const outDir = process.env['SPOOL_E2E_BUILD_DIR'];
  const dir = await buildExtension(outDir ? { outDir } : {});
  process.env[EXTENSION_DIR_ENV] = dir;
}
