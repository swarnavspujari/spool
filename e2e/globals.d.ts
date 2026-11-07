// Types for the test hook that e2e/build-extension.mjs adds to the service worker of the test copy.

export {};

declare global {
  type WorkerEvent = {
    t: number;
    dir: 'in' | 'out';
    type: string;
    ok?: boolean;
    code?: string;
    threw?: string;
    seq?: number;
    sessionId?: string;
    intake?: any;
  };

  // `var` (not let/const) is required to declare a property of globalThis.
  var __spoolTest: {
    startCapture(tab: chrome.tabs.Tab | undefined): Promise<void>;
    startShelf(tab: chrome.tabs.Tab | undefined): Promise<void>;
    /** Runs the runtime.onInstalled listeners that the hook held back (see build-extension.mjs). */
    fireInstalled(details: { reason: string }): Promise<unknown[]>;
    events: WorkerEvent[];
    counts: Record<string, number>;
  };

  /** Set by recordDownloads() in e2e/fixtures.js: the downloads that the worker started. */
  var __spoolDownloads: { id: number; filename: string; conflictAction: string; urlScheme: string }[] | undefined;
}
