// Types for the page-script namespace globalThis.__spool (see docs/contracts.md section 5).
// Page scripts are classic scripts and cannot import; this file gives them types under checkJs.

import type { FinishSummary, PageConfig, Rect } from '../src/shared/types.js';

/** A reply of the service worker, as the page scripts read it (see `ui.send`). */
export type Reply =
  | { ok: true; data: Record<string, any> }
  | { ok: false; code: string; message: string };

export type ScrollTarget = { kind: 'document' | 'element'; el: Element; box: Rect };
export type OverlayCommand = 'down' | 'up' | 'auto' | 'done' | 'cancel';
export type OverlayStatus = {
  slices: number;
  heightPx: number;
  tiles: number;
  auto: boolean;
  level: 'info' | 'warn' | 'error';
  message: string;
  /** Scroll position of the target along its scroll range, 0 (top) to 1 (bottom). */
  progress: number;
  /** The end of the panel is reached: nothing more below. */
  atEnd: boolean;
  /**
   * Done is saving the capture. The Cancel button is disabled and Esc does nothing until the
   * agent reports a status without this flag (a failure) or closes the overlay.
   */
  finishing?: boolean;
};

export interface StyleJar {
  set(el: Element, prop: string, value: string): void;
  restoreAll(): void;
  readonly size: number;
}

/** Why an element stays at the same place on screen while the page scrolls. */
export type PinnedKind = 'fixed' | 'sticky';
export type PinnedElement = { el: Element; kind: PinnedKind };

export interface OverlayScanner {
  /** Fixed and sticky elements that cover part of `rect` (viewport coordinates), now. */
  collect(rect: Rect): PinnedElement[];
}

export interface PageLib {
  findScrollTarget(rect: Rect): ScrollTarget;
  /** The scroll panels on screen in reading order (the page itself when it scrolls). Never empty. */
  listScrollTargets(): ScrollTarget[];
  clipRect(a: Rect, b: Rect): Rect | null;
  getScrollTop(t: ScrollTarget): number;
  maxScrollTop(t: ScrollTarget): number;
  setScrollTop(t: ScrollTarget, top: number): void;
  contentYOf(t: ScrollTarget, rect: Rect): number;
  createOverlayScanner(ignore: Element | null, target: ScrollTarget): OverlayScanner;
  createStyleJar(): StyleJar;
  nextFrames(n?: number): Promise<void>;
  sleep(ms: number): Promise<void>;
}

export interface OverlayHandle {
  readonly host: Element;
  beginSelect(): void;
  showSession(rect: Rect): void;
  setStatus(status: OverlayStatus): void;
  setBusy(busy: boolean): void;
  hideForCapture(): Promise<void>;
  showAfterCapture(): void;
  /** Keeps the overlay above what the page opens later (a modal dialog, a popover). */
  keepOnTop(): void;
  destroy(): void;
}

export interface OverlayModule {
  createOverlay(opts: {
    onRegion(rect: Rect): void;
    onCommand(cmd: OverlayCommand): void;
    /** False when the setting is off: the finish button says "Save". Default: true. */
    copyOnDone?: boolean;
  }): OverlayHandle;
}

export interface AgentModule {
  start(): void;
  isActive(): boolean;
}

/**
 * State of the copy to the clipboard, as the toast shows it. 'skipped': the setting `copyOnDone`
 * is off, so nothing is copied and the toast says "Saved". 'toolarge': the image is too large to
 * copy as one image (the files are saved, and the tiles are still there).
 */
export type CopyState = 'pending' | 'copied' | 'failed' | 'skipped' | 'toolarge';

export interface ToastHandle {
  /**
   * The copy finished (or failed): the title changes and the countdown to hide starts. `detail` is
   * a short text for a failure (for example "This image is too large to copy. Use the tiles.").
   */
  setCopy(state: CopyState, detail?: string): void;
  close(): void;
}

export interface ToastModule {
  /** Shows the toast after a capture. Closes the toast that is on screen. Null for a bad summary. */
  show(opts: { config: PageConfig; summary: FinishSummary; copy: CopyState }): ToastHandle | null;
  dismiss(): void;
}

export interface ShelfModule {
  /** Opens the shelf (mode 'shelf' of `__spool.config`). */
  start(): void;
  dismiss(): void;
}

export type IconName =
  | 'check'
  | 'close'
  | 'open'
  | 'warn'
  | 'folder'
  | 'copy'
  | 'insert'
  | 'spinner';

/** A card (toast, shelf): a host with a closed shadow root in the top layer. */
export interface CardHost {
  readonly host: Element;
  readonly shadow: ShadowRoot;
  /** The container inside the shadow root. */
  readonly root: HTMLElement;
  /** A listener that acts only on trusted events and never throws. Removed by `destroy()`. */
  listen<K extends keyof HTMLElementEventMap>(
    target: EventTarget,
    type: K,
    handler: (event: HTMLElementEventMap[K]) => void,
    options?: AddEventListenerOptions | boolean,
  ): void;
  keepOnTop(): void;
  /** Puts the card above everything in the top layer, also above a page element that is not
   *  seen by a hit test (`pointer-events: none`). */
  raise(): void;
  destroy(): void;
  isDestroyed(): boolean;
}

/** The kind of place that `findPasteTarget` found. */
export type PasteTargetKind = 'focused' | 'composer' | 'other' | 'none';

/** Shared pieces of the cards (see src/page/ui-kit.js). */
export interface UiKit {
  FONT: string;
  BASE_CSS: string;
  el<K extends keyof HTMLElementTagNameMap>(
    tag: K,
    className?: string,
    text?: string,
  ): HTMLElementTagNameMap[K];
  text(value: string): Text;
  svg(tag: string, attrs: Record<string, string>): Element;
  icon(name: IconName, className?: string, size?: number): Element;
  glyph(): Element;
  num(n: number): string;
  sizeText(widthPx: number, heightPx: number): string;
  tileFileName(index: number, count: number): string;
  contextValid(): boolean;
  /** Sends a message to the service worker. `key` is a name in `config.msg`. Never throws. */
  send(config: PageConfig, key: string, fields?: Record<string, unknown>): Promise<Reply>;
  pngBlob(base64: unknown): Blob;
  /** Clipboard write of an image; call it with no `await` before it (user gesture). */
  copyImage(blob: Promise<Blob>): Promise<boolean>;
  drawPng(canvas: HTMLCanvasElement, base64: string): Promise<boolean>;
  focusedElement(): Element | null;
  /** True for a field or an editable element: a paste has a place in it. */
  takesPaste(element: Element | null): boolean;
  /** The composer among editors: the lowest, then the largest. Pure. */
  pickComposer<T>(
    candidates: { item: T; top: number; bottom: number; left: number; right: number }[],
  ): T | null;
  /** Looks for the message box of a chat on the screen (the page and open shadow roots). */
  findComposer(): Element | null;
  /** Where a paste goes: the focused editor, a remembered one, a composer, or the body. */
  findPasteTarget(options?: {
    remembered?: Element | null;
    ignore?: Element | null;
  }): { element: Element; kind: PasteTargetKind };
  /** Cuts a count into batches of at most `limit`. `end` is exclusive. */
  planBatches(count: number, limit: number): { start: number; end: number }[];
  /** Runs work for 0..count-1, at most `limit` at once; fails with the first error. */
  mapLimit<T>(count: number, limit: number, work: (index: number) => Promise<T>): Promise<T[]>;
  /** True when width x height x 4 bytes is more than `maxBytes` (too large to copy). */
  exceedsClipboard(widthPx: number, heightPx: number, maxBytes: number): boolean;
  /** True for an element that holds another document (iframe, frame, object, embed). */
  isFrameOwner(element: Element | null): boolean;
  /** The key of a command as the browser has it ('' when none is set). */
  shortcutOf(config: PageConfig | undefined, name: 'start' | 'insert'): string;
  /** A key as it shows on screen, for the system of the user. No parts: the command has no key. */
  keysOf(
    config: PageConfig | undefined,
    name: 'start' | 'insert' | 'paste',
  ): { parts: string[]; text: string };
  /** Puts the real keys into a text that names the default keys. */
  withKeys(config: PageConfig | undefined, text: string): string;
  /** Closes every card, also the cards of an earlier injection. Never throws. */
  dismissCards(): void;
  createCardHost(css: string, options?: { onOrphan?: () => void; onDismiss?: () => void }): CardHost;
}

export interface SpoolNamespace {
  config?: PageConfig;
  lib?: PageLib;
  ui?: UiKit;
  overlay?: OverlayModule;
  toast?: ToastModule;
  shelf?: ShelfModule;
  agent?: AgentModule;
  /** The overlay hosts that this world made and did not remove yet (see overlay.js). */
  overlayHosts?: Set<Element>;
  /** The same for the toast and the shelf (see ui-kit.js). */
  cardHosts?: Set<Element>;
  /** One function for each card that is on screen: it closes that card (see ui-kit.js). */
  cardClosers?: Set<() => void>;
}

declare global {
  // `var` (not let/const) is required to declare a property of globalThis.
  var __spool: SpoolNamespace | undefined;
}
