// @ts-check
/**
 * Playwright configuration for the Spool end-to-end tests.
 *
 * - Workers: every test launches its own Chromium process with its own temporary profile folder
 *   and the extension loaded. The fixture server of a worker binds a random port, and the
 *   extension copy is built once per run and only read by the tests. Tests share no state (see
 *   e2e/fixtures.js), so more than one worker is safe. Local runs use one worker (the default, the
 *   simplest and most stable on a busy machine). CI sets SPOOL_E2E_WORKERS from the
 *   repository variable E2E_WORKERS (default 3; see .github/workflows/ci.yml); the value is the
 *   number of browsers that run at the same time.
 * - fullyParallel: tests are independent, so the workers share the tests of a project, not only the
 *   files. This evens out the load: one test takes up to 27 s, and one file holds several tests.
 * - The core scenarios (tag @core) run at four device scale factors. All other specs run at 1.
 *   The scale is the custom option `scale` (a real device scale factor of the browser, not
 *   Playwright's emulation: see e2e/fixtures.js).
 * - CI runs one project per job (`--project scale-1.5`). The workflow sets
 *   SPOOL_E2E_EXPECTED_PROJECTS to the project names that it runs. When this file defines other
 *   projects, the run stops at once, so that a new device scale cannot be left out of CI.
 * - CI retries a failed test once. A test that passes only on the retry is "flaky": it is not a
 *   failure, but .github/scripts/e2e-summary.mjs reports it in the job summary with an annotation.
 * - Local runs: set PLAYWRIGHT_BROWSERS_PATH=0 to use the Chromium inside node_modules. CI uses
 *   the default browser path. This file does not set it.
 */

import { defineConfig } from '@playwright/test';

/**
 * Options of the e2e fixtures (see e2e/fixtures.js).
 * @typedef {Object} SpoolOptions
 * @property {number} scale
 * @property {{ width: number, height: number }} viewportSize
 */

const isCI = Boolean(process.env['CI']);

/** Largest accepted value of SPOOL_E2E_WORKERS (one Chromium per worker). */
const MAX_WORKERS = 8;

/**
 * @returns {number} Number of workers: SPOOL_E2E_WORKERS, or 1.
 */
function workerCount() {
  const raw = process.env['SPOOL_E2E_WORKERS'];
  if (raw === undefined || raw === '') return 1;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > MAX_WORKERS) {
    throw new Error(`SPOOL_E2E_WORKERS must be a whole number from 1 to ${MAX_WORKERS}, not "${raw}"`);
  }
  return count;
}

/** Viewport (CSS px) of the test page. Height and width are multiples of 8 and of 4 on purpose. */
const viewportSize = { width: 1000, height: 800 };

/** Device scale factors of the core scenarios. */
const CORE_SCALES = [1.25, 1.5, 2];

const projects = [
  // The performance test runs in its own project, so CI runs it as a parallel job.
  { name: 'scale-1', use: { scale: 1 }, grepInvert: /@perf/ },
  ...CORE_SCALES.map((scale) => ({
    name: `scale-${scale}`,
    use: { scale },
    grep: /@core/,
    grepInvert: /@perf/,
  })),
  { name: 'perf', use: { scale: 1 }, grep: /@perf/ },
];

// CI guard: the workflow lists the projects it runs (one job each).
const expected = process.env['SPOOL_E2E_EXPECTED_PROJECTS'];
if (expected !== undefined && expected !== '') {
  const have = projects.map((project) => project.name).join(',');
  if (have !== expected) {
    throw new Error(
      `playwright.config.js defines the projects "${have}", but the CI workflow runs "${expected}". ` +
        'Update the project list in .github/workflows/ci.yml (the e2e matrix and SPOOL_E2E_EXPECTED_PROJECTS).',
    );
  }
}

export default defineConfig(/** @type {import('@playwright/test').PlaywrightTestConfig<SpoolOptions>} */ ({
  testDir: 'e2e',
  testMatch: '**/*.spec.js',
  outputDir: 'test-results',
  globalSetup: './e2e/global-setup.mjs',
  fullyParallel: true,
  workers: workerCount(),
  retries: isCI ? 1 : 0,
  forbidOnly: isCI,
  // CI: stop the run with a report before the step timeout of the workflow (6 min) kills it
  // without one. One project takes about 2 min in CI.
  globalTimeout: isCI ? 5 * 60_000 : 0,
  timeout: 120_000,
  expect: { timeout: 10_000 },
  reporter: isCI
    ? [
        ['list'],
        ['html', { open: 'never' }],
        // Read by .github/scripts/e2e-summary.mjs (job summary, flaky-test report).
        ['json', { outputFile: 'test-results/results.json' }],
      ]
    : [['list'], ['html', { open: 'never' }]],
  use: { viewportSize },
  projects,
}));
