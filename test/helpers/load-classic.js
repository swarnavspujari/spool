// @ts-check
/**
 * Loads a classic page script (an IIFE that registers itself on `globalThis.__spool`) into a
 * node:vm context, so that unit tests can reach what the script registers.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const REPO_ROOT = new URL('../../', import.meta.url);

/** @typedef {import('../../types/page-globals.js').SpoolNamespace} SpoolNamespace */
/** @typedef {Record<string, unknown> & { __spool?: SpoolNamespace }} ClassicContext */

/**
 * Runs `file` as a classic script. The script sees `globals` (fakes for `document`,
 * `getComputedStyle`, `requestAnimationFrame` and so on) as its global object and nothing else
 * of Node.
 *
 * To load a second script into the same context (overlay.js needs page-lib.js), pass the
 * context that the first call returned instead of a plain globals object.
 *
 * Objects that the script creates belong to the context's own realm: `assert.deepStrictEqual`
 * against objects of the test's realm fails on the prototypes. Compare their fields, or copy
 * them with JSON first.
 *
 * @param {string} file  Path from the repository root, for example `src/page/page-lib.js`.
 * @param {Record<string, unknown>} [globals]  Plain globals, or a context from an earlier call.
 * @returns {ClassicContext}  The global object of the context. The script's namespace is
 *   `context.__spool`.
 */
export function loadClassic(file, globals = {}) {
  const url = new URL(file, REPO_ROOT);
  const script = new vm.Script(readFileSync(url, 'utf8'), { filename: fileURLToPath(url) });
  const context = vm.isContext(globals) ? globals : vm.createContext({ ...globals });
  script.runInContext(context);
  return context;
}
