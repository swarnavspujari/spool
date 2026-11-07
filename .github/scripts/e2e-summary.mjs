// @ts-check
/**
 * Writes the job summary of one Playwright run and reports flaky tests.
 *
 * Usage: node .github/scripts/e2e-summary.mjs <results.json> [label]
 *
 * - <results.json> is the file of the Playwright "json" reporter (see playwright.config.js).
 * - The Markdown goes to the file in $GITHUB_STEP_SUMMARY. Without that variable it goes to stdout.
 * - Workflow commands go to stdout: a "warning" for each flaky test (a test that failed, then
 *   passed on a retry) and an "error" for each failed test. A retry must not hide a flaky test.
 * - With $GITHUB_OUTPUT set, it writes the step outputs "flaky", "failed" and "total" (counts).
 * - The exit code is always 0. The Playwright step decides if the job fails. This step must not
 *   change the result, and it must not fail when the file is missing.
 *
 * The script reads the file only. It uses no package and no network.
 */

import { appendFileSync, existsSync, readFileSync } from 'node:fs';

const MAX_ROWS = 20;
const MAX_MESSAGE = 200;
const SLOWEST = 5;

/**
 * @typedef {{ status: string, duration: number, retry: number,
 *   error?: { message?: string }, errors?: { message?: string }[] }} Attempt
 * @typedef {{ project: string, title: string, file: string, line: number, status: string,
 *   attempts: Attempt[], annotations: string[] }} Row
 */

/** @param {string} text @returns {string} The text without ANSI color codes. */
function stripAnsi(text) {
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/** @param {string} text @returns {string} First non-empty line, short, for a table cell. */
function firstLine(text) {
  const line =
    stripAnsi(text)
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l !== '') ?? '';
  return line.length > MAX_MESSAGE ? `${line.slice(0, MAX_MESSAGE)}...` : line;
}

/** @param {string} text @returns {string} Text that is safe in a Markdown table cell. */
function cell(text) {
  return text.replace(/\|/g, '\\|').replace(/[\r\n]+/g, ' ').replace(/`/g, "'");
}

/** @param {string} text @returns {string} Text for the data of a workflow command. */
function commandData(text) {
  return text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

/** @param {number} ms @returns {string} For example "1m 12s" or "7.9s". */
function duration(ms) {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

/**
 * Collects every test of a Playwright JSON report.
 * @param {any} suite
 * @param {Row[]} rows
 */
function collect(suite, rows) {
  for (const spec of suite.specs ?? []) {
    for (const test of spec.tests ?? []) {
      rows.push({
        project: String(test.projectName ?? ''),
        title: String(spec.title ?? ''),
        file: String(spec.file ?? ''),
        line: Number(spec.line ?? 0),
        status: String(test.status ?? ''),
        attempts: test.results ?? [],
        annotations: (test.annotations ?? []).map(
          (/** @type {any} */ a) => `${a.type}: ${a.description ?? ''}`,
        ),
      });
    }
  }
  for (const child of suite.suites ?? []) collect(child, rows);
}

/** @param {Row} row @returns {string} The first error of the first failed attempt. */
function firstError(row) {
  const failed = row.attempts.find((a) => a.status !== 'passed' && a.status !== 'skipped');
  const message = failed?.error?.message ?? failed?.errors?.[0]?.message ?? failed?.status ?? '';
  return firstLine(message);
}

/** @param {string[]} lines Markdown. */
function emit(lines) {
  const text = `${lines.join('\n')}\n`;
  const target = process.env['GITHUB_STEP_SUMMARY'];
  if (target) appendFileSync(target, text);
  else process.stdout.write(text);
}

function main() {
  const [file, label = 'End-to-end tests'] = process.argv.slice(2);
  if (!file) {
    console.error('usage: node e2e-summary.mjs <results.json> [label]');
    return;
  }
  if (!existsSync(file)) {
    emit([`### ${label}`, '', `No result file (\`${file}\`). The test run stopped before it wrote a report.`]);
    return;
  }

  /** @type {any} */
  let report;
  try {
    report = JSON.parse(readFileSync(file, 'utf8'));
  } catch (error) {
    emit([`### ${label}`, '', `The result file could not be read: ${cell(String(error))}`]);
    return;
  }

  /** @type {Row[]} */
  const rows = [];
  for (const suite of report.suites ?? []) collect(suite, rows);

  const count = (/** @type {string} */ status) => rows.filter((r) => r.status === status).length;
  const passed = count('expected');
  const flaky = rows.filter((r) => r.status === 'flaky');
  const failed = rows.filter((r) => r.status === 'unexpected');
  const skipped = count('skipped');
  const testTime = rows.reduce(
    (sum, r) => sum + r.attempts.reduce((s, a) => s + (a.duration ?? 0), 0),
    0,
  );
  const wall = Number(report.stats?.duration ?? 0);
  const workers = report.config?.metadata?.actualWorkers ?? report.config?.workers;
  const verdict = failed.length > 0 ? 'FAILED' : flaky.length > 0 ? 'passed with flaky tests' : 'passed';

  /** @type {string[]} */
  const out = [`### ${label}: ${verdict}`, ''];
  out.push('| Passed | Flaky | Failed | Skipped | Wall time | Test time (sum) | Workers |');
  out.push('| ---: | ---: | ---: | ---: | ---: | ---: | ---: |');
  out.push(
    `| ${passed} | ${flaky.length} | ${failed.length} | ${skipped} | ${duration(wall)} | ${duration(testTime)} | ${workers ?? '?'} |`,
  );

  /** @param {string} heading @param {Row[]} list @param {string} what */
  const table = (heading, list, what) => {
    if (list.length === 0) return;
    out.push('', `**${heading}**`, '', `| Project | Test | ${what} |`, '| --- | --- | --- |');
    for (const row of list.slice(0, MAX_ROWS)) {
      out.push(`| ${cell(row.project)} | ${cell(`${row.file}:${row.line} ${row.title}`)} | ${cell(firstError(row))} |`);
    }
    if (list.length > MAX_ROWS) out.push('', `(${list.length - MAX_ROWS} more not shown)`);
  };
  table('Failed tests', failed, 'First error');
  table(
    'Flaky tests (failed, then passed on a retry). A retry does not fix a flaky test: find the cause.',
    flaky,
    'Error of the failed attempt',
  );

  const slow = rows
    .map((r) => ({ r, ms: r.attempts.at(-1)?.duration ?? 0 }))
    .sort((a, b) => b.ms - a.ms)
    .slice(0, SLOWEST);
  if (slow.length > 0) {
    out.push('', `**Slowest ${slow.length} tests**`, '', '| Project | Test | Time |', '| --- | --- | ---: |');
    for (const { r, ms } of slow) out.push(`| ${cell(r.project)} | ${cell(`${r.file}:${r.line} ${r.title}`)} | ${duration(ms)} |`);
  }

  const notes = rows.flatMap((r) =>
    r.annotations.filter((a) => a.startsWith('teardown')).map((a) => `${r.project} ${r.file}:${r.line} ${a}`),
  );
  if (notes.length > 0) {
    out.push('', '**Browser teardown problems**', '');
    for (const note of notes.slice(0, MAX_ROWS)) out.push(`- ${cell(note)}`);
  }

  emit(out);

  // Step outputs: the workflow uploads the report of a run that had flaky tests.
  const outputFile = process.env['GITHUB_OUTPUT'];
  if (outputFile) {
    appendFileSync(outputFile, `flaky=${flaky.length}\nfailed=${failed.length}\ntotal=${rows.length}\n`);
  }

  for (const row of flaky) {
    const retries = row.attempts.length - 1;
    console.log(
      `::warning title=Flaky e2e test::${commandData(
        `${row.project} ${row.file}:${row.line} "${row.title}" failed ${retries} time(s) and then passed: ${firstError(row)}`,
      )}`,
    );
  }
  for (const row of failed) {
    console.log(
      `::error title=Failed e2e test::${commandData(`${row.project} ${row.file}:${row.line} "${row.title}": ${firstError(row)}`)}`,
    );
  }
}

try {
  main();
} catch (error) {
  // The summary is a help. It must never change the result of the job.
  console.log(`::warning title=e2e summary::${commandData(`The summary script failed: ${String(error)}`)}`);
}
