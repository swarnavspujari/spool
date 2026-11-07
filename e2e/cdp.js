// @ts-check
/**
 * A small Chrome DevTools Protocol client for the offscreen document.
 *
 * The offscreen document is not a Playwright page, so Playwright cannot attach to it. When the
 * browser runs with `--remote-debugging-port=<port>`, it lists the document at
 * `http://127.0.0.1:<port>/json/list` as a target of type `background_page` with its own
 * WebSocket URL (checked in Chromium 158 headless). This file talks to that URL with the global
 * `WebSocket` of Node. Only e2e/perf.spec.js uses it.
 */

import { delay } from './util.js';

/** The path that identifies the offscreen document in the target list. */
const OFFSCREEN_PAGE_SUFFIX = '/src/offscreen/offscreen.html';

/**
 * @typedef {Object} HeapSample
 * @property {number} t      Epoch ms (Date.now), the same clock as the service worker events.
 * @property {number} used   JSHeapUsedSize, bytes.
 * @property {number} total  JSHeapTotalSize, bytes.
 */

/**
 * @param {number} port  The `--remote-debugging-port` of the browser.
 * @returns {Promise<{ url: string, webSocketDebuggerUrl: string } | null>}  The offscreen document,
 *   or null when it does not exist (now).
 */
export async function findOffscreenTarget(port) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`);
  /** @type {{ url?: unknown, webSocketDebuggerUrl?: unknown }[]} */
  const targets = await response.json();
  for (const target of targets) {
    if (
      typeof target.url === 'string' &&
      target.url.endsWith(OFFSCREEN_PAGE_SUFFIX) &&
      typeof target.webSocketDebuggerUrl === 'string'
    ) {
      return { url: target.url, webSocketDebuggerUrl: target.webSocketDebuggerUrl };
    }
  }
  return null;
}

/** A connection to one CDP target. */
export class CdpClient {
  /**
   * @param {WebSocket} socket  An open socket.
   */
  constructor(socket) {
    this.socket = socket;
    this.nextId = 1;
    /** @type {Map<number, { resolve: (value: any) => void, reject: (error: Error) => void }>} */
    this.pending = new Map();
    this.closed = false;
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      const entry = this.pending.get(message.id);
      if (!entry) return; // An event, not a reply.
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`${message.error.message} (${JSON.stringify(message.error)})`));
      else entry.resolve(message.result);
    });
    socket.addEventListener('close', () => {
      this.closed = true;
      for (const entry of this.pending.values()) entry.reject(new Error('The DevTools connection closed.'));
      this.pending.clear();
    });
  }

  /**
   * @param {string} url  A `webSocketDebuggerUrl`.
   * @returns {Promise<CdpClient>}
   */
  static connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.addEventListener('open', () => resolve(new CdpClient(socket)), { once: true });
      socket.addEventListener('error', () => reject(new Error(`Cannot connect to ${url}`)), { once: true });
    });
  }

  /**
   * @param {string} method  For example 'Performance.getMetrics'.
   * @param {Record<string, unknown>} [params]
   * @returns {Promise<any>}
   */
  send(method, params = {}) {
    if (this.closed) return Promise.reject(new Error('The DevTools connection is closed.'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /**
   * Runs JavaScript in the target (the page's main world) and returns the value.
   * @param {string} expression
   * @returns {Promise<any>}
   */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(`The script failed: ${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    }
    return result.result?.value;
  }

  /**
   * The JavaScript heap of the target now.
   * @returns {Promise<{ used: number, total: number }>}
   */
  async heap() {
    const { metrics } = await this.send('Performance.getMetrics');
    /** @param {string} name */
    const read = (name) => Number(metrics.find((/** @type {{ name: string }} */ m) => m.name === name)?.value ?? NaN);
    return { used: read('JSHeapUsedSize'), total: read('JSHeapTotalSize') };
  }

  /** Runs a full garbage collection in the target. */
  async collectGarbage() {
    await this.send('HeapProfiler.collectGarbage');
  }

  close() {
    this.socket.close();
  }
}

/**
 * Samples the JavaScript heap of the offscreen document at a fixed interval, from the moment the
 * document exists until `stop()`. The sampler waits for the document (it is created when a
 * capture starts), connects, and keeps the connection in `client()` for other commands.
 * @param {number} port
 * @param {{ intervalMs?: number }} [options]
 */
export function startHeapSampler(port, { intervalMs = 100 } = {}) {
  /** @type {HeapSample[]} */
  const samples = [];
  /** @type {CdpClient | null} */
  let client = null;
  let stopped = false;
  /** @type {(client: CdpClient) => void} */
  let announce = () => {};
  /** @type {Promise<CdpClient>} */
  const ready = new Promise((resolve) => {
    announce = resolve;
  });

  const loop = (async () => {
    while (!stopped) {
      if (client === null || client.closed) {
        client = null;
        const target = await findOffscreenTarget(port).catch(() => null);
        if (target) {
          try {
            const connected = await CdpClient.connect(target.webSocketDebuggerUrl);
            await connected.send('Performance.enable');
            client = connected;
            announce(connected);
          } catch {
            client = null;
          }
        }
      }
      if (client !== null) {
        try {
          const { used, total } = await client.heap();
          samples.push({ t: Date.now(), used, total });
        } catch {
          client = null; // The document closed. The loop looks for the next one.
        }
      }
      await delay(intervalMs);
    }
  })();

  return {
    samples,
    /** Resolves with the connection as soon as the document has been found. */
    ready,
    /** @returns {CdpClient | null} The current connection, or null. */
    client: () => client,
    /** Stops sampling and closes the connection. */
    async stop() {
      stopped = true;
      await loop;
      client?.close();
    },
  };
}
