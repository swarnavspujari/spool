// @ts-check
/**
 * The shelf: a small dark card, in any tab, with the last capture. It opens with the command
 * Alt+Shift+V (docs/contracts.md section 7.1). The service worker injects the page scripts with
 * `config.mode = 'shelf'` and a one-time `config.shelfToken` that belongs to this tab.
 *
 * Classic script for the page's isolated world. Every injection replaces `__spool.shelf` (no
 * "already loaded" guard). Needs ui-kit.js.
 *
 * What it does:
 *  - The shelf gets only the summary (size, age, the host name of the captured page, the thumbnail)
 *    when it opens. It asks for tile or image bytes only after a click: the tiles of a batch on
 *    "Insert", one tile on a chip or a step, the full image on "Copy full image". Its token is
 *    bound to the capture that was the last one when the shelf opened: when a newer capture
 *    exists, the service worker refuses and the shelf shows why.
 *  - The card says where the pixels come from and into which page they go: "5 AI screenshots from
 *    github.com, 4 min ago." and "Into chat.example.com".
 *  - "Insert N screenshots": dispatches a synthetic `paste` event that holds the PNG files (a
 *    DataTransfer with `screenshot-01-of-05.png` and so on). The place is found at the click
 *    (`ui.findPasteTarget`): the editor that has the focus, else the composer that the shelf finds
 *    on the screen, else the page. `defaultPrevented` tells that the page took it: "Inserted".
 *    More than `limits.maxImagesPerMessage` (20) tiles go in batches ("Insert first 20", "Insert
 *    the other 6 next"): the tiles are fetched three at a time, and the shelf says how many it
 *    inserted. A synthetic event has `isTrusted: false`, and a page may refuse it: then the shelf
 *    offers one screenshot at a time ("Copy screenshot 1 of 5"). Each copy starts in a trusted
 *    click and each paste is the user's own, so that works on every site.
 *  - The shelf cannot reach into a frame. When the focus is in an `<iframe>`, the event would go to
 *    the scripts of the top page, not to the frame, so the shelf does not dispatch: "Spool cannot
 *    insert into this frame. Click a tile to copy it."
 *  - A chip for each tile and "Copy full image": the clipboard write starts in a trusted click
 *    (no await before it); the image arrives later, as a promise. An image that is too tall to
 *    copy as one image (`limits.maxClipboardBitmapBytes`) has no such button: the browser would
 *    decode it in this tab, and a tab crashes far above the limit.
 *  - Clickjacking: a page can open an element over the card (even one that ignores the pointer)
 *    and draw its own button there. "Insert" stays off until the card has been visible and still
 *    for 400 ms, and while IntersectionObserver v2 says that something covers the button (or the
 *    card is not visible). The card puts itself above what covers it.
 *  - No last capture: "Nothing to insert yet. Press Alt+Shift+S to spool a page."
 *  - Esc closes the shelf.
 *
 * The shelf never takes the focus from the page: a press on it does not move the focus, so the
 * editor stays focused. Every listener acts only on trusted events.
 */
(() => {
  'use strict';

  /** @typedef {import('../../types/page-globals.js').ShelfModule} ShelfModule */
  /** @typedef {import('../shared/types.js').PageConfig} PageConfig */

  /**
   * @param {object | undefined} proto
   * @param {string} name
   * @returns {(self: any, ...args: any[]) => any}
   */
  function methodFrom(proto, name) {
    const fn = proto ? Object.getOwnPropertyDescriptor(proto, name)?.value : undefined;
    return typeof fn === 'function'
      ? (self, ...args) => fn.apply(self, args)
      : (self, ...args) => self[name](...args);
  }

  const targetDispatch = methodFrom(globalThis.EventTarget?.prototype, 'dispatchEvent');

  /**
   * @returns {import('../../types/page-globals.js').SpoolNamespace}
   */
  function sharedNamespace() {
    if (Object.hasOwn(globalThis, '__spool')) {
      const existing = globalThis.__spool;
      if (existing && Object.prototype.toString.call(existing) === '[object Object]') return existing;
    }
    /** @type {import('../../types/page-globals.js').SpoolNamespace} */
    const fresh = {};
    Object.defineProperty(globalThis, '__spool', {
      value: fresh,
      writable: true,
      configurable: true,
      enumerable: false,
    });
    return fresh;
  }

  const ns = sharedNamespace();
  const loadedUi = ns.ui;
  if (!loadedUi) throw new Error('Spool: ui-kit.js must load before shelf.js.');
  const ui = loadedUi;

  const SUPPORTED_PROTOCOL = 1;
  /** "Inserted" stays this long, then the shelf closes. */
  const INSERTED_HIDE_MS = 2000;
  /** "Copied" on a chip or on the full-image button goes back after this long. */
  const CHIP_RESET_MS = 2000;
  const CLOSE_MS = 167;
  const THUMB_WIDTH = 56;
  const THUMB_MAX_HEIGHT = 82;
  const MAX_TEXT_LENGTH = 200;
  const MAX_HOST_LENGTH = 253;
  const MAX_TOKEN_LENGTH = 64;
  /** Tiles that Insert fetches at the same time. Each is a few MB of base64 in two processes. */
  const FETCH_LANES = 3;
  /** Insert stays off until the card has been visible and still for this long. */
  const DWELL_MS = 400;
  /** The least time between two answers of IntersectionObserver v2 (the API needs 100 or more). */
  const VISIBILITY_DELAY_MS = 100;
  /** The card goes above what covers it at most this often. */
  const RAISE_EVERY_MS = 1000;
  /**
   * Same values as MAX_IMAGES_PER_MESSAGE and MAX_CLIPBOARD_BITMAP_BYTES in
   * src/shared/constants.js (a page script cannot import). The worker sends the real ones in
   * `config.limits`; these are for a config without it. test/unit/constants.test.js checks them.
   */
  const DEFAULT_MAX_IMAGES = 20;
  const DEFAULT_MAX_CLIPBOARD_BYTES = 256 * 1024 * 1024;
  /** The folder of the AI screenshots. A copy of `TILES_FOLDER_NAME` in src/lib/names.js. */
  const TILES_FOLDER = 'Spool for AI';

  const TEXT = Object.freeze({
    empty: 'Nothing to insert yet. Press Alt+Shift+S to spool a page.', // The keys: ui.withKeys.
    emptyKeep: 'Captures stay ready for 60 minutes.',
    frame: 'Spool cannot insert into an embedded frame. Click a number to copy one instead.',
    frameOne: 'Spool cannot insert into an embedded frame. Click Copy full image.',
    inserted: 'Inserted',
    inserting: 'Inserting…',
    copyFailed: 'Could not copy on this page.',
    unreachable: 'Could not reach the extension. Try again.',
    covered: 'Something on this page covers Spool. Click again in a moment.',
    tooTall: 'Too tall to copy as one image. Use the screenshots.',
    heading: 'Insert into this chat?',
    headingRest: 'Insert the rest?',
    noBox: 'Click your message box first.',
    stepHeading: "This chat won't take them all at once.",
    stepHeadingOne: "This chat didn't take the paste.",
  });

  const CSS = `
.main { display: flex; align-items: flex-start; gap: 12px; }
.thumb {
  position: relative; flex: none; border-radius: 6px; background: #FFFFFF; overflow: hidden;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.thumb canvas { display: block; width: 100%; height: 100%; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; }
.head { display: flex; align-items: flex-start; gap: 6px; }
.head .title { flex: 1; min-width: 0; padding-top: 2px; }
.head .title svg { color: var(--muted); }
.head .icon-btn { margin: -6px -6px 0 0; width: 28px; height: 28px; flex: none; }
.status {
  display: flex; align-items: center; gap: 6px; min-height: 16px; font-size: 12px;
  line-height: 16px; color: var(--muted);
}
.status:empty { display: none; }
.status svg { flex: none; }
.status[data-level='ok'] { color: var(--accent-text); }
.status[data-level='error'] { color: var(--error); }
.tiles { display: flex; flex-direction: column; gap: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.row { display: flex; align-items: center; gap: 6px; }
.empty { display: flex; align-items: flex-start; gap: 12px; }
.empty .tile {
  width: 40px; height: 40px; flex: none; border-radius: 8px; background: var(--line);
  display: flex; align-items: center; justify-content: center;
}
.empty p { margin: 0; padding-top: 10px; }
.emptytext { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 6px; }
.emptytext p { padding-top: 0; }
.emptytext .lead { padding-top: 10px; }
.hintline { margin: 0; }
.stack { display: flex; flex-direction: column; gap: 8px; }
.progress { height: 4px; border-radius: 2px; background: var(--raised-line); overflow: hidden; }
.progress span {
  display: block; height: 4px; border-radius: 2px; background: var(--accent);
  transition: width 167ms var(--in);
}
@media (prefers-reduced-motion: reduce) {
  .progress span { transition: none; }
}
`;

  /**
   * The shelf on screen, if any.
   * @type {{ token: object, host: Element, target: Element | null,
   *   close(immediately?: boolean): void } | null}
   */
  let current = null;

  /** @param {unknown} v @param {number} [max] @returns {string} */
  function safeText(v, max = MAX_TEXT_LENGTH) {
    return typeof v === 'string' ? v.slice(0, max) : '';
  }

  /** @param {unknown} v @returns {number} */
  function safeCount(v) {
    return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
  }

  /**
   * "just now", "3 min ago", "2 h ago". Empty when the time is not known.
   * @param {unknown} createdAt  Epoch ms.
   */
  function ageText(createdAt) {
    if (typeof createdAt !== 'number' || !Number.isFinite(createdAt)) return '';
    const minutes = Math.floor((Date.now() - createdAt) / 60000);
    if (minutes < 1) return 'just now';
    if (minutes < 60) return `${minutes} min ago`;
    return `${Math.floor(minutes / 60)} h ago`;
  }

  /** The time that the page and the guard count in. @returns {number} */
  function clock() {
    return typeof performance?.now === 'function' ? performance.now() : Date.now();
  }

  /**
   * The host name of the page that the shelf is in: where the screenshots would go. `location`
   * cannot be replaced by page markup. Empty when it has no host (a local file).
   * @returns {string}
   */
  function destinationHost() {
    try {
      return safeText(globalThis.location?.hostname, MAX_HOST_LENGTH);
    } catch {
      return '';
    }
  }

  /**
   * Returns the config only when the shelf can use it.
   * @param {unknown} raw
   * @returns {PageConfig | null}
   */
  function readConfig(raw) {
    const c = /** @type {Partial<PageConfig> | null | undefined} */ (raw);
    if (!c || c.protocolVersion !== SUPPORTED_PROTOCOL || c.mode !== 'shelf') return null;
    const { shelfToken, msg, err, target } = c;
    if (typeof shelfToken !== 'string' || shelfToken === '') return null;
    if (shelfToken.length > MAX_TOKEN_LENGTH || !msg || !err || !target) return null;
    if (typeof target['SW'] !== 'string') return null;
    return /** @type {PageConfig} */ (c);
  }

  /**
   * Reads what the shelf needs from the summary (the `ShelfSummary` of the service worker: size,
   * age, host name, place of the files, thumbnail). Null when it is not a summary.
   * @param {unknown} raw
   */
  function readSummary(raw) {
    if (typeof raw !== 'object' || raw === null) return null;
    const s = /** @type {Record<string, any>} */ (raw);
    const tiles = safeCount(s['tileCount']);
    if (tiles < 1) return null;
    return {
      tiles,
      widthPx: safeCount(s['widthPx']),
      heightPx: safeCount(s['heightPx']),
      createdAt: s['createdAt'],
      sourceHost: safeText(s['sourceHost'], MAX_HOST_LENGTH),
      saveLabel: safeText(s['saveLabel'], 80),
      thumbnail: safeText(s['thumbnailPngBase64'], 400_000),
      thumbWidth: safeCount(s['thumbnailWidthPx']),
      thumbHeight: safeCount(s['thumbnailHeightPx']),
    };
  }

  /**
   * The place of the saved AI screenshots for a text: "Pictures › Screenshots › Spool for AI".
   * @param {string} saveLabel  `SaveInfo.label` ("Pictures/Screenshots", "Downloads/Spool").
   * @returns {string}  Empty when nothing was saved.
   */
  function tilesPlace(saveLabel) {
    const parts = saveLabel
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part !== '');
    return parts.length === 0 ? '' : [...parts, TILES_FOLDER].join(' › ');
  }

  /**
   * Tells when it is safe to act on a click on the card. A page can open an element over the card
   * (also one with `pointer-events: none`, which a click goes through) and draw its own button
   * there. So the card is "ready" only while the browser says that nothing covers the button
   * (IntersectionObserver v2: `isVisible`), and only 400 ms after it became visible. Without v2 the
   * wait alone applies. `onChange` runs when the answer may have changed.
   * @param {Element} element  The card.
   * @param {{ onChange: () => void, raise: () => void }} hooks  `raise` puts the card above
   *   what covers it.
   */
  function watchVisibility(element, { onChange, raise }) {
    let visible = true;
    let since = clock();
    let raisedAt = -Infinity;
    let stopped = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {IntersectionObserver | null} */
    let observer = null;

    function stopTimer() {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }

    function restart() {
      since = clock();
      stopTimer();
      timer = setTimeout(() => {
        timer = null;
        if (!stopped) onChange();
      }, DWELL_MS);
    }

    restart();
    try {
      if (typeof IntersectionObserver === 'function') {
        observer = new IntersectionObserver(
          (entries) => {
            const entry = entries[entries.length - 1];
            if (!entry || stopped) return;
            // `isVisible` is missing without v2: then only the wait counts.
            const seen = entry.isIntersecting && /** @type {any} */ (entry).isVisible !== false;
            if (seen === visible) return;
            visible = seen;
            if (seen) {
              restart();
            } else {
              stopTimer();
              if (clock() - raisedAt >= RAISE_EVERY_MS) {
                raisedAt = clock();
                raise();
              }
              onChange();
            }
          },
          // trackVisibility and delay are IntersectionObserver v2: not in the DOM typings.
          /** @type {IntersectionObserverInit} */ (
            /** @type {unknown} */ ({
              threshold: [0, 1],
              trackVisibility: true,
              delay: VISIBILITY_DELAY_MS,
            })
          ),
        );
        observer.observe(element);
      }
    } catch {
      observer = null;
    }

    return {
      /** True when a click may act now. */
      ready() {
        return !stopped && visible && clock() - since >= DWELL_MS;
      },
      /** True when the browser says that something covers the card. */
      covered() {
        return !visible;
      },
      stop() {
        stopped = true;
        stopTimer();
        try {
          observer?.disconnect();
        } catch {
          // Gone already.
        }
      },
    };
  }

  function start() {
    try {
      open();
    } catch {
      // Never throw into the page.
    }
  }

  function open() {
    const read = readConfig(ns.config);
    if (!read) return;
    /** @type {PageConfig} */
    const config = read;
    const token = config.shelfToken ?? '';
    const limits = config.limits;
    const maxImages =
      typeof limits?.maxImagesPerMessage === 'number' && limits.maxImagesPerMessage >= 1
        ? Math.floor(limits.maxImagesPerMessage)
        : DEFAULT_MAX_IMAGES;
    const maxClipboardBytes =
      typeof limits?.maxClipboardBitmapBytes === 'number' && limits.maxClipboardBitmapBytes > 0
        ? limits.maxClipboardBitmapBytes
        : DEFAULT_MAX_CLIPBOARD_BYTES;
    const paste = ui.keysOf(config, 'paste').text;
    const insertKey = ui.keysOf(config, 'insert').text;

    // The place of a paste is found now, and again at the click (the page may change in between).
    // A shelf that is open already gives its own target back when the focus sits on its host.
    const previous = current;
    const live = ui.focusedElement();
    const onOldHost = live !== null && previous !== null && live === previous.host;
    const focus = onOldHost ? (previous?.target ?? null) : live;
    // A frame has the focus: the paste would go to the top page, not into the frame. So it is not
    // sent anywhere, also when the page has a composer of its own.
    const frameTarget = ui.isFrameOwner(focus);
    const found = ui.findPasteTarget({
      remembered: previous?.target ?? null,
      ignore: previous?.host ?? null,
    });
    const insertTarget = frameTarget ? focus : found.element;
    // No editor to paste into: the card says to click the message box first.
    const noBox = !frameTarget && (found.kind === 'other' || found.kind === 'none');
    previous?.close(true);

    let closed = false;
    const mark = {};
    const card = ui.createCardHost(CSS, {
      onOrphan: () => close(true),
      onDismiss: () => close(true),
    });
    const { root } = card;
    const surface = ui.el('div', 'card');
    surface.setAttribute('role', 'dialog');
    surface.setAttribute('aria-label', 'Spool: last capture');
    root.append(surface);

    /** @type {ReturnType<typeof setTimeout> | null} */
    let hideTimer = null;
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    const timers = new Set();
    /** @type {ReturnType<typeof watchVisibility> | null} */
    let guard = null;

    /** @param {boolean} [immediately] */
    function close(immediately = false) {
      if (closed) return;
      closed = true;
      if (hideTimer !== null) clearTimeout(hideTimer);
      for (const timer of timers) clearTimeout(timer);
      timers.clear();
      guard?.stop();
      if (current?.token === mark) current = null;
      if (immediately) {
        card.destroy();
        return;
      }
      root.dataset.closing = '';
      setTimeout(() => card.destroy(), CLOSE_MS);
    }

    current = { token: mark, host: card.host, target: insertTarget, close };

    // The same close button and status line for every state.
    const closeButton = ui.el('button', 'icon-btn');
    closeButton.type = 'button';
    closeButton.setAttribute('aria-label', 'Close (Esc)');
    closeButton.title = 'Close (Esc)';
    closeButton.append(ui.icon('close'));
    card.listen(closeButton, 'click', () => close(false));

    const statusText = ui.text('');
    const status = ui.el('div', 'status');
    status.setAttribute('role', 'status');
    status.setAttribute('aria-live', 'polite');
    status.append(statusText);

    /**
     * @param {string} message
     * @param {'info' | 'ok' | 'error'} [level]
     */
    function say(message, level = 'info') {
      status.dataset.level = level;
      /** @type {Record<'ok' | 'error', import('../../types/page-globals.js').IconName>} */
      const marks = { ok: 'check', error: 'warn' };
      const mark = level === 'info' ? null : ui.icon(marks[level], '', 14);
      status.replaceChildren(...(mark ? [mark] : []), ui.text(message));
    }

    // A shelf starts as a card that asks the service worker for the last capture.
    surface.append(ui.el('div', 'small muted', 'Loading…'));
    root.dataset.open = '';

    card.listen(surface, 'mousedown', (e) => e.preventDefault());
    // Esc closes the shelf, and only the shelf: the page does not get this key.
    card.listen(
      window,
      'keydown',
      (e) => {
        if (e.key !== 'Escape' || e.isComposing || e.ctrlKey || e.metaKey || e.altKey) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        close(false);
      },
      true,
    );

    /**
     * What a desktop chat app can do: the shelf runs in browser tabs only, but Ctrl+V pastes the
     * full image, and the AI screenshots are files in a folder.
     * @param {string} text
     */
    function hintLine(text) {
      const line = ui.el('p', 'small muted hintline', text);
      line.setAttribute('role', 'note');
      return line;
    }

    /**
     * @param {string} message
     * @param {boolean} nothingYet  There is no capture: say how long one stays, and what a desktop
     *   app can do. Else `message` is a refusal of the service worker, and it stands alone.
     */
    function showEmpty(message, nothingYet) {
      surface.replaceChildren();
      const tile = ui.el('span', 'tile');
      tile.setAttribute('aria-hidden', 'true');
      tile.append(ui.glyph());
      const text = ui.el('div', 'emptytext');
      text.append(ui.el('p', 'lead', message));
      if (nothingYet) {
        text.append(
          ui.el('p', 'small muted', TEXT.emptyKeep),
          hintLine(
            'Desktop app? This shortcut works in browser tabs only. Capture a page, then press ' +
              `${paste} in the app, or drag the screenshots from the ${TILES_FOLDER} folder.`,
          ),
        );
      }
      const row = ui.el('div', 'empty');
      row.setAttribute('role', 'status');
      row.append(tile, text);
      const top = ui.el('div', 'head');
      top.append(row, closeButton);
      surface.append(top);
      void surface.offsetWidth;
    }

    /** @param {NonNullable<ReturnType<typeof readSummary>>} info */
    function showCapture(info) {
      surface.replaceChildren();
      const { tiles } = info;
      const many = tiles > 1;
      const batches = ui.planBatches(tiles, maxImages);
      const capped = batches.length > 1;
      /** The batches that are in the page already. A capture of 20 tiles or fewer has one. */
      const inserted = new Set();
      /** The batches that are still to do, in order. */
      const todo = () => batches.map((_, i) => i).filter((i) => !inserted.has(i));
      /** The batch of the main button, and the one after it (-1: none). */
      let primary = 0;
      let secondary = -1;
      const tooTall = ui.exceedsClipboard(info.widthPx, info.heightPx, maxClipboardBytes);
      const place = tilesPlace(info.saveLabel);

      // Thumbnail, title, caption.
      const known = info.thumbWidth > 0 && info.thumbHeight > 0;
      const ratio = known ? info.thumbHeight / info.thumbWidth : 1.5;
      const thumbHeight = Math.round(Math.min(THUMB_MAX_HEIGHT, Math.max(28, THUMB_WIDTH * ratio)));
      const thumb = ui.el('div', 'thumb');
      thumb.setAttribute('aria-hidden', 'true');
      thumb.style.width = `${THUMB_WIDTH}px`;
      thumb.style.height = `${thumbHeight}px`;
      const canvas = ui.el('canvas');
      const dpr = Math.max(1, Math.min(3, Number(globalThis.devicePixelRatio) || 1));
      canvas.width = Math.round(THUMB_WIDTH * dpr);
      canvas.height = Math.round(thumbHeight * dpr);
      thumb.append(canvas);
      void ui.drawPng(canvas, info.thumbnail);

      const titleText = ui.text('');
      const title = ui.el('div', 'title');
      title.append(ui.glyph(), titleText);
      // Where the pixels come from, and how old they are: the user sees it before they go into
      // another page.
      const age = ageText(info.createdAt);
      const count = `${ui.num(tiles)} AI screenshot${many ? 's' : ''}`;
      const from = info.sourceHost ? `from ${info.sourceHost}` : 'from a local page';
      const sourceLine = `${count} ${from}${age ? `, ${age}` : ''}.`;
      const caption = ui.el('div', 'caption', sourceLine);
      // More tiles than a chat takes in one message: say so (only for such a capture).
      const capNote = ui.el(
        'div',
        'caption',
        `Most AI chats take up to ${ui.num(maxImages)} images in one message. ` +
          `This capture has ${ui.num(tiles)} AI screenshots.`,
      );
      const into = destinationHost();
      const destination = ui.el('div', 'caption', into ? `Into ${into}` : '');
      destination.style.display = into ? 'block' : 'none';
      const head = ui.el('div', 'head');
      head.append(title, closeButton);
      const body = ui.el('div', 'body');
      body.append(head, caption);
      if (capped) body.append(capNote);
      body.append(destination);
      const main = ui.el('div', 'main');
      main.append(thumb, body);

      // Insert: one button, or two when the capture has more tiles than a chat takes.
      const insert = ui.el('button', 'btn primary wide');
      insert.type = 'button';
      const insertLabel = ui.text('');
      insert.append(ui.icon('insert'), insertLabel);
      const insertNext = ui.el('button', 'btn wide');
      insertNext.type = 'button';
      const insertNextLabel = ui.text('');
      insertNext.append(ui.icon('insert'), insertNextLabel);

      /**
       * The label of the button for batch `index`: "Insert 5 screenshots" (one batch), "Insert
       * first 20", "Insert the next 20", "Insert the other 6 next".
       * @param {number} index
       */
      function batchLabel(index) {
        const b = batches[index];
        if (!b) return '';
        const size = b.end - b.start;
        if (!capped) return `Insert ${ui.num(size)} screenshot${size === 1 ? '' : 's'}`;
        if (index === 0) return `Insert first ${ui.num(size)}`;
        return index === batches.length - 1
          ? `Insert the other ${ui.num(size)} next`
          : `Insert the next ${ui.num(size)}`;
      }

      // One chip for each tile, and the full image.
      /** @type {HTMLButtonElement[]} */
      const chips = [];
      /** @type {HTMLElement | null} */
      let tilesBox = null;
      if (many) {
        const label = ui.el('div', 'small muted', 'Or copy one at a time');
        label.id = 'tile-label';
        const group = ui.el('div', 'chips');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-labelledby', 'tile-label');
        for (let i = 0; i < tiles; i += 1) {
          const chip = ui.el('button', 'chip', String(i + 1));
          chip.type = 'button';
          chip.setAttribute('aria-label', `Copy screenshot ${i + 1}`);
          chips.push(chip);
          group.append(chip);
        }
        tilesBox = ui.el('div', 'tiles');
        tilesBox.append(label, group);
      }
      const full = ui.el('button', 'btn');
      full.type = 'button';
      const fullLabel = ui.text('Copy full image');
      full.append(ui.icon('copy'), fullLabel);
      const fullRow = ui.el('div', 'row');
      // A very tall image decodes to hundreds of MB. Writing it would crash this tab.
      if (tooTall) fullRow.append(ui.el('div', 'small muted', TEXT.tooTall));
      else fullRow.append(full);

      surface.append(main, insert);
      if (capped) surface.append(insertNext);
      surface.append(status);
      if (tilesBox) surface.append(tilesBox);
      surface.append(fullRow);
      void surface.offsetWidth;

      let busy = false;
      /** The message of the last refusal of the service worker ("A newer capture exists."). */
      let refusal = '';

      /** Words of the card for the batches that are still to do, and the state of its buttons. */
      function render() {
        const [first, second] = todo();
        primary = first ?? 0;
        secondary = second ?? -1;
        const started = inserted.size > 0;
        titleText.data =
          capped && started
            ? TEXT.headingRest
            : capped
              ? `Insert the first ${ui.num(batches[0]?.end ?? maxImages)}?`
              : TEXT.heading;
        capNote.style.display = started ? 'none' : 'block';
        insertLabel.data = batchLabel(primary);
        insertNext.style.display = secondary >= 0 ? 'inline-flex' : 'none';
        insertNextLabel.data = secondary >= 0 ? batchLabel(secondary) : '';
        refresh();
      }

      /** Turns the Insert buttons on and off. */
      function refresh() {
        const off = busy || frameTarget || (guard !== null && !guard.ready());
        insert.disabled = off;
        insertNext.disabled = off;
      }

      let coveredShown = false;
      /** The guard has a new answer: the buttons, and a line that says why they are off. */
      function guardChanged() {
        if (closed) return;
        refresh();
        if (guard?.covered()) {
          coveredShown = true;
          say(TEXT.covered, 'error');
        } else if (coveredShown) {
          coveredShown = false;
          say('');
        }
      }

      /**
       * Gets one output of the capture of this shelf from the service worker, as a Blob. Called
       * only after a click. A refusal (a newer capture exists, the shelf expired) is kept in
       * `refusal`, so the shelf can show it.
       * @param {number | 'full'} item
       * @returns {Promise<Blob>}
       */
      const fetchPng = (item) =>
        ui.send(config, 'PAGE_SHELF_GET', { token, item }).then((reply) => {
          if (!reply.ok) {
            refusal = safeText(reply.message);
            throw new Error(reply.message);
          }
          return ui.pngBlob(reply.data['pngBase64']);
        });

      /**
       * A copy that starts in a trusted click.
       * @param {number | 'full'} item
       * @param {(state: 'pending' | 'copied' | 'failed' | 'idle') => void} paint
       */
      function copy(item, paint) {
        paint('pending');
        refusal = '';
        void ui.copyImage(fetchPng(item)).then((ok) => {
          if (closed) return;
          paint(ok ? 'copied' : 'failed');
          if (!ok) say(refusal ? ui.withKeys(config, refusal) : TEXT.copyFailed, 'error');
          const timer = setTimeout(() => {
            timers.delete(timer);
            if (!closed) paint('idle');
          }, CHIP_RESET_MS);
          timers.add(timer);
        });
      }

      chips.forEach((chip, i) => {
        const n = String(i + 1);
        /** @param {'pending' | 'copied' | 'failed' | 'idle'} next */
        const paint = (next) => {
          chip.dataset['state'] = next;
          chip.replaceChildren();
          if (next === 'copied') chip.append(ui.icon('check', '', 14), ui.text(`${n} · Copied`));
          else if (next === 'failed') chip.append(ui.text(`${n} · Failed`));
          else if (next === 'pending') chip.append(ui.icon('spinner', 'spin', 14), ui.text(n));
          else chip.append(ui.text(n));
          const names = {
            copied: `Screenshot ${n} copied`,
            failed: `Screenshot ${n} not copied`,
            pending: `Copy screenshot ${n}`,
            idle: `Copy screenshot ${n}`,
          };
          chip.setAttribute('aria-label', names[next]);
        };
        paint('idle');
        card.listen(chip, 'click', () => {
          if (chip.dataset['state'] !== 'pending') copy(i, paint);
        });
      });
      card.listen(full, 'click', () => {
        if (full.dataset['state'] === 'pending') return;
        copy('full', (next) => {
          full.dataset['state'] = next;
          fullLabel.data =
            next === 'copied' ? 'Copied' : next === 'failed' ? 'Not copied' : 'Copy full image';
        });
      });

      /**
       * The page did not take the paste: one screenshot at a time. Each copy starts in a trusted
       * click and each paste is the user's own, so a page that ignores a synthetic paste still
       * takes these.
       * @param {number} startAt  The first screenshot (0-based).
       */
      function showSteps(startAt) {
        // The Insert button is gone: its guard has nothing left to watch.
        guard?.stop();
        guard = null;
        surface.replaceChildren();
        let next = startAt;
        let stepBusy = false;
        const stepTitle = ui.el('div', 'title', many ? TEXT.stepHeading : TEXT.stepHeadingOne);
        const stepHead = ui.el('div', 'head');
        stepHead.append(stepTitle, closeButton);
        const stepText = ui.el(
          'div',
          'caption',
          many
            ? `Copy one, press ${paste}, then come back.`
            : `Copy it, then press ${paste} in your chat.`,
        );
        const step = ui.el('button', 'btn primary wide');
        step.type = 'button';
        const stepLabel = ui.text('');
        step.append(ui.icon('copy'), stepLabel);
        const bar = ui.el('span');
        const progress = ui.el('div', 'progress');
        progress.setAttribute('role', 'progressbar');
        progress.setAttribute('aria-label', 'Screenshots to copy');
        progress.setAttribute('aria-valuemin', '0');
        progress.setAttribute('aria-valuemax', String(tiles));
        progress.append(bar);
        const wrap = ui.el('div', 'stack');
        wrap.append(stepHead, stepText, step, progress, status);
        if (many) wrap.append(hintLine(desktopHint()));
        surface.append(wrap);
        void surface.offsetWidth;

        function paintStep() {
          const done = next >= tiles;
          stepLabel.data = done
            ? 'All copied'
            : many
              ? `Copy screenshot ${ui.num(next + 1)} of ${ui.num(tiles)}`
              : 'Copy the image';
          step.disabled = stepBusy || done;
          const position = Math.min(tiles, next + 1);
          bar.style.width = `${Math.round((position / tiles) * 100)}%`;
          progress.setAttribute('aria-valuenow', String(position));
        }
        paintStep();
        say('');

        card.listen(step, 'click', () => {
          if (stepBusy || next >= tiles) return;
          const index = next;
          stepBusy = true;
          refusal = '';
          paintStep();
          // The write starts in this click; the image arrives later.
          void ui.copyImage(fetchPng(index)).then((ok) => {
            stepBusy = false;
            if (closed) return;
            if (ok) {
              next = index + 1;
              say(
                many
                  ? `Copied screenshot ${ui.num(index + 1)} of ${ui.num(tiles)}. ` +
                      `Press ${paste} in your chat.`
                  : `Copied. Press ${paste} in your chat.`,
                'ok',
              );
            } else {
              say(refusal ? ui.withKeys(config, refusal) : TEXT.copyFailed, 'error');
            }
            paintStep();
          });
        });
      }

      /** The words for a desktop chat app, after a refused paste. @returns {string} */
      function desktopHint() {
        return (
          `Desktop app? Press ${paste} for the full image` +
          (place ? `, or drag the screenshots from ${place}.` : '.')
        );
      }

      const frameText = many ? TEXT.frame : TEXT.frameOne;
      if (frameTarget) {
        // The focus was in a frame: there is nothing to paste into. The tiles can still be copied.
        say(frameText, 'error');
      } else if (noBox) {
        // Nothing to paste into yet. Insert still works for a page that takes a paste anywhere.
        const again = insertKey ? `Press ${insertKey} again` : 'Run Insert last capture again';
        say(`${TEXT.noBox} Spool inserts where your cursor is. ${again} after you click.`);
      }

      // The guard watches the card. Not a button: a disabled button is drawn at 45% opacity, and
      // the browser then says that it is not visible (so it would never turn on). What covers part
      // of the card, also what ignores the pointer, makes the answer "not visible".
      guard = watchVisibility(surface, { onChange: guardChanged, raise: () => card.raise() });
      render();

      /**
       * Makes a File of each tile of the batch and dispatches one synthetic `paste` event that holds
       * them, at the place that `findPasteTarget` gives now. The page took it when it called
       * preventDefault(). The tiles are fetched three at a time.
       * @param {{ start: number, end: number }} range
       * @returns {Promise<boolean>}
       */
      async function insertRange({ start, end }) {
        try {
          const blobs = await ui.mapLimit(end - start, FETCH_LANES, (i) => fetchPng(start + i));
          if (closed) return false;
          const data = new DataTransfer();
          blobs.forEach((blob, i) => {
            data.items.add(
              new File([blob], ui.tileFileName(start + i, tiles), { type: 'image/png' }),
            );
          });
          const event = new ClipboardEvent('paste', {
            clipboardData: data,
            bubbles: true,
            cancelable: true,
            composed: true,
          });
          // The editor may have been made again since the shelf opened: look again.
          const where = ui.findPasteTarget({ remembered: insertTarget, ignore: card.host });
          targetDispatch(where.element, event);
          return event.defaultPrevented === true;
        } catch {
          return false;
        }
      }

      /**
       * Inserts one batch. Does nothing while a batch is under way, when the focus is in a frame,
       * and while something covers the card or the card has only just appeared.
       * @param {number} index
       */
      function insertBatch(index) {
        if (busy) return;
        if (frameTarget) {
          say(frameText, 'error');
          return;
        }
        // A click while something covers the card, or just after it appeared, is not acted on.
        if (guard && !guard.ready()) {
          say(TEXT.covered, 'error');
          return;
        }
        const range = batches[index];
        if (!range) return;
        busy = true;
        refresh();
        refusal = '';
        say(TEXT.inserting);
        void insertRange(range).then((accepted) => {
          busy = false;
          if (closed) return;
          if (!accepted) {
            if (refusal) {
              say(ui.withKeys(config, refusal), 'error'); // for example: a newer capture exists
              refresh();
            } else {
              showSteps(range.start);
            }
            return;
          }
          // What the shelf says is what it did: it handed these files to the page, and the page
          // took the event. It cannot see what the chat keeps.
          const n = range.end - range.start;
          const range1 = `${ui.num(range.start + 1)}–${ui.num(range.end)} of ${ui.num(tiles)}`;
          inserted.add(index);
          if (todo().length === 0) {
            say(
              capped
                ? `${TEXT.inserted} ${range1}.`
                : `${TEXT.inserted} ${ui.num(n)} screenshot${n === 1 ? '' : 's'}.`,
              'ok',
            );
            hideTimer = setTimeout(() => close(false), INSERTED_HIDE_MS);
          } else {
            // The rest waits: a chat takes one batch for each message.
            say(`${TEXT.inserted} ${range1}. Send your message, then insert the rest.`, 'ok');
          }
          render();
        });
      }

      card.listen(insert, 'click', () => insertBatch(primary));
      card.listen(insertNext, 'click', () => insertBatch(secondary));
    }

    // Ask for the last capture.
    void ui.send(config, 'PAGE_SHELF_INFO', { token }).then((reply) => {
      if (closed) return;
      if (!reply.ok) {
        showEmpty(ui.withKeys(config, reply.message || TEXT.unreachable), false);
        return;
      }
      const info = readSummary(reply.data['summary']);
      if (!info) showEmpty(ui.withKeys(config, TEXT.empty), true);
      else showCapture(info);
    });
  }

  function dismiss() {
    current?.close(false);
  }

  ns.shelf = Object.freeze(/** @type {ShelfModule} */ ({ start, dismiss }));
})();
