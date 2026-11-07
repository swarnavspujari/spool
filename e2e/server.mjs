// @ts-check
/**
 * Tiny static file server for the fixture pages. Dependency-free (node:http).
 *
 * - Binds to 127.0.0.1 on a random free port.
 * - Serves the files below `root` (default: e2e/fixtures). Only GET and HEAD.
 * - `/bands.js` is a special route to e2e/bands.js: fixture pages import it, so that the pages
 *   and the verifier share one colour code (see e2e/bands.js).
 * - Every response has `Cache-Control: no-store`, so a page never comes from a stale cache.
 * - A request with `?noclip` gets `Permissions-Policy: clipboard-write=()`: the page cannot write
 *   to the clipboard, so a content script cannot either (e2e/done-flow.spec.js, the fallback).
 */

import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Default document root: the fixture pages. */
export const FIXTURES_DIR = path.join(HERE, 'fixtures');

/** URL path -> absolute file outside the root that may be served. */
const SPECIAL_ROUTES = Object.freeze({
  '/bands.js': path.join(HERE, 'bands.js'),
});

/** @type {Readonly<Record<string, string>>} */
const CONTENT_TYPES = Object.freeze({
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
});

/**
 * @typedef {Object} FixtureServer
 * @property {string} origin  For example `http://127.0.0.1:41234` (no trailing slash).
 * @property {number} port
 * @property {(pathname: string) => string} url  Full URL of a path such as `/long-document.html`.
 * @property {() => Promise<void>} close
 */

/**
 * Maps a request path to a file path, or null when the path is not allowed.
 * @param {string} root  Absolute root directory.
 * @param {string} pathname  Decoded URL path, starts with '/'.
 * @returns {string | null}
 */
export function resolveRequestPath(root, pathname) {
  if (Object.hasOwn(SPECIAL_ROUTES, pathname)) {
    return /** @type {Record<string, string>} */ (SPECIAL_ROUTES)[pathname] ?? null;
  }
  if (pathname.includes('\0') || pathname.includes('\\')) return null;
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  const resolved = path.resolve(root, relative);
  const rootWithSep = root.endsWith(path.sep) ? root : root + path.sep;
  return resolved.startsWith(rootWithSep) ? resolved : null;
}

/**
 * Starts the server.
 * @param {{ root?: string }} [options]
 * @returns {Promise<FixtureServer>}
 */
export async function startServer(options = {}) {
  const root = path.resolve(options.root ?? FIXTURES_DIR);

  const server = http.createServer((req, res) => {
    void handle(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });

  /**
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   */
  async function handle(req, res) {
    const method = req.method ?? 'GET';
    if (method !== 'GET' && method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      res.end();
      return;
    }
    let pathname;
    let noClipboard = false;
    try {
      const requested = new URL(req.url ?? '/', 'http://localhost');
      pathname = decodeURIComponent(requested.pathname);
      noClipboard = requested.searchParams.has('noclip');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    const file = resolveRequestPath(root, pathname);
    if (file === null) {
      res.writeHead(403);
      res.end();
      return;
    }
    try {
      const info = await stat(file);
      if (!info.isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
        'Content-Length': body.length,
        'Cache-Control': 'no-store',
        ...(noClipboard ? { 'Permissions-Policy': 'clipboard-write=()' } : {}),
      });
      res.end(method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end('Not found');
    }
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve(undefined));
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('Server has no port');
  const origin = `http://127.0.0.1:${address.port}`;

  return {
    origin,
    port: address.port,
    url: (pathname) => origin + pathname,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}
