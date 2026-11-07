// @ts-check
/**
 * The toast after a capture: a small dark card at the bottom right of the page. It shows the top
 * of the image, what happened ("Copied and saved"), the size and the place, and the actions.
 *
 * Classic script for the page's isolated world. Contract: docs/contracts.md section 5 and 7.1.
 * Every injection replaces `__spool.toast` (no "already loaded" guard). Needs ui-kit.js.
 *
 * Short capture (one tile): thumbnail, title, caption, [Open], [Show in folder] and the paste
 * hint.
 * Long capture (more tiles): stacked thumbnail, "Copied. Press Ctrl+V for the full image.", a
 * tinted block with the main route ("Long capture? In your chat tab, press [Alt]+[Shift]+[V] to
 * insert all N screenshots." with keycaps for the real key), a line for a desktop app ("Desktop
 * app: drag them from Pictures › Screenshots › Spool for AI."), chips "1", "2" ... (a
 * click copies that screenshot), [Open] and [Show in folder]. There is NO "drag all tiles" chip:
 * Chromium cannot drag several files to another tab. [Show in folder] shows for a save in
 * Downloads only: the browser can reveal a file that it downloaded, and has no call for a folder
 * that the user picked.
 * An image that is too tall to copy (state 'toolarge') says so: "Too tall to copy. Saved
 * instead." The first few long captures stay until the user dismisses them (`summary.teach`).
 * The place of the save shows as "Downloads › Spool" (see `placeLabel`). A save in Downloads
 * adds a link "Change" to the caption (the standing way to set up a folder).
 * No folder is chosen and this capture asks: a block "Save to Pictures › Screenshots?" with
 * [Set up] and [Not now]. The save went to Downloads although a folder is chosen: a block
 * "Reconnect Pictures › Screenshots?" with [Reconnect] and [Not now].
 * Some files did not save: the title says how many, and the note says what to do.
 *
 * Rules: the toast never takes the focus. It hides after 6 s; a hovered or focused toast, or one
 * that is copying, waits. A long capture that teaches (`summary.teach`) does not hide by itself.
 * Esc closes it. The thumbnail is drawn on a <canvas> from the bytes (no <img>, no blob URL: the
 * CSP of the page cannot block it). Every listener acts only on trusted
 * events. The text of the capture (title, folder, errors) is set with `textContent` only.
 */
(() => {
  'use strict';

  /** @typedef {import('../../types/page-globals.js').ToastHandle} ToastHandle */
  /** @typedef {import('../../types/page-globals.js').ToastModule} ToastModule */
  /** @typedef {import('../../types/page-globals.js').CopyState} CopyState */
  /** @typedef {import('../shared/types.js').FinishSummary} FinishSummary */
  /** @typedef {import('../shared/types.js').PageConfig} PageConfig */

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
  if (!loadedUi) throw new Error('Spool: ui-kit.js must load before toast.js.');
  const ui = loadedUi;

  /** The toast hides after this long (counted while nothing holds it). */
  const AUTO_HIDE_MS = 6000;
  /** A block that asks for a decision ("Set up", "Reconnect") stays longer. */
  const PERMISSION_HIDE_MS = 15000;
  /** "Copied" on a tile chip goes back to the number after this long. */
  const CHIP_RESET_MS = 2000;
  /** Length of the closing animation (same as `--out` timing in ui-kit.js). */
  const CLOSE_MS = 167;
  const THUMB_WIDTH = 56;
  const THUMB_MAX_HEIGHT = 82;
  const STACK_THUMB_WIDTH = 30;
  const STACK_THUMB_MAX_HEIGHT = 60;
  const MAX_TEXT_LENGTH = 200;
  /** The place that "Set up" makes. A copy of `PICTURES_PLACE` in src/options/setup-model.js. */
  const PICTURES_PLACE = 'Pictures › Screenshots';
  /** The folder of the AI screenshots. A copy of `TILES_FOLDER_NAME` in src/lib/names.js. */
  const TILES_FOLDER = 'Spool for AI';

  const CSS = `
.main { display: flex; align-items: flex-start; gap: 12px; }
.thumb {
  position: relative; flex: none; border-radius: 6px; background: #FFFFFF; overflow: hidden;
  box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.08);
}
.thumb canvas { display: block; width: 100%; height: 100%; }
.stack { position: relative; flex: none; width: 44px; height: 64px; }
.stack .layer { position: absolute; border-radius: 4px; width: 30px; height: 60px; }
.stack .back { left: 10px; top: 0; background: var(--raised-line); }
.stack .mid { left: 5px; top: 2px; background: var(--key); }
.stack .thumb { left: 0; top: 4px; border-radius: 4px; }
.body { flex: 1; min-width: 0; display: flex; flex-direction: column; align-self: stretch; }
.head { display: flex; align-items: flex-start; gap: 6px; }
.head .title { flex: 1; min-width: 0; padding-top: 2px; }
.head .icon-btn { margin: -6px -6px 0 0; width: 28px; height: 28px; flex: none; }
.actions { margin-top: auto; padding-top: 8px; display: flex; align-items: center; gap: 6px; }
.grow { flex: 1; }
.paste { display: flex; align-items: center; gap: 4px; color: var(--muted); }
.hint {
  display: flex; align-items: center; gap: 10px; margin: 0; padding: 10px 12px;
  border: 1px solid rgba(255, 178, 36, 0.6); border-radius: 10px;
  background: rgba(255, 178, 36, 0.12); color: var(--text); line-height: 24px;
}
.hint svg { flex: none; color: var(--accent-text); }
.hint .say { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.keys { display: inline-flex; align-items: center; gap: 3px; vertical-align: middle; }
.keys .plus { color: var(--muted); }
.tiles { display: flex; flex-direction: column; gap: 6px; }
.tilehead { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.tilehead .link { height: 28px; }
.links { display: flex; align-items: center; gap: 6px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; }
.permission {
  display: flex; flex-direction: column; gap: 8px; padding: 12px; border-radius: 8px;
  background: var(--raised);
}
.permission h2 { margin: 0; font: 400 14px/20px ${ui.FONT}; overflow-wrap: anywhere; }
.permission .buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.btn.quiet { border-color: transparent; background: transparent; }
.btn.quiet:hover:not(:disabled) { background: var(--line); }
.caption .link {
  display: inline; height: auto; padding: 0 2px; font: inherit; font-weight: 600;
  line-height: inherit;
}
.bar {
  position: absolute; left: 0; right: 0; bottom: 0; height: 2px; background: var(--line);
  display: none;
}
.root[data-timing] .bar { display: block; }
.bar span {
  display: block; height: 2px; background: var(--key); transform-origin: 0 50%;
  animation: drain var(--hide, 6s) linear forwards; animation-play-state: running;
}
.root[data-paused] .bar span { animation-play-state: paused; }
@keyframes drain { from { transform: scaleX(1); } to { transform: scaleX(0); } }
@media (prefers-reduced-motion: reduce) {
  .bar { display: none !important; }
}
@media (forced-colors: active) {
  .hint { border-color: CanvasText; background: Canvas; }
}
`;

  /**
   * The toast that is on screen, if any.
   * @type {{ token: object, close(immediately?: boolean): void } | null}
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
   * The text for the place of a save: "Downloads › Spool", "Screenshots". The offscreen document
   * writes "Downloads/Spool" for a save in Downloads. The result page and Options show the same
   * place with the same separator. This is a copy of `formatSaveLabel` in src/lib/labels.js (a
   * page script cannot import a module); test/unit/labels.test.js checks that both agree.
   * @param {string} label
   * @returns {string}
   */
  function placeLabel(label) {
    return label
      .split('/')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .join(' › ');
  }

  /**
   * One keycap for each key, with a "+" between them (not on a Mac: "⌃⇧V" are three keycaps).
   * The keys come from `ui.keysOf`: written for the system of the user.
   * @param {{ parts: string[], text: string }} label
   * @returns {HTMLElement}
   */
  function keycaps({ parts, text }) {
    const keys = ui.el('span', 'keys');
    const plus = text.includes('+');
    parts.forEach((part, i) => {
      if (i > 0 && plus) keys.append(ui.el('span', 'plus', '+'));
      keys.append(ui.el('kbd', '', part));
    });
    return keys;
  }

  /**
   * What the toast says for a capture and the state of the copy.
   * @param {{ saved: boolean, long: boolean, tiles: number, label: string, size: string,
   *   error: string, partial: boolean, missing: string, thisTime: boolean, paste: string }} f
   *   `partial`: some files saved and others did not. `missing`: how many, in words ("2 of 6
   *   files didn't save"). `thisTime`: the folder needs a reconnect, so this save is a one-off.
   *   `paste`: the Paste key for the system ("Ctrl+V", "⌘V").
   * @param {CopyState} copy
   */
  function words(f, copy) {
    /** @type {'info' | 'warn' | 'error'} */
    let level = 'info';
    let title;
    if (copy === 'pending') title = 'Copying…';
    else if (copy === 'toolarge') {
      // The image is too tall to put on the clipboard. The files are what the person has.
      title = f.partial
        ? `Too tall to copy. ${capitalize(f.missing)}.`
        : f.saved
          ? 'Too tall to copy. Saved instead.'
          : 'Too tall to copy.';
      level = f.saved && !f.partial ? 'info' : 'warn';
    } else if (copy === 'skipped') {
      title = f.partial ? `${capitalize(f.missing)}.` : f.saved ? 'Saved' : 'Not saved';
      if (f.partial) level = 'warn';
    } else if (copy === 'failed') {
      title = f.partial
        ? `Not copied. ${capitalize(f.missing)}.`
        : f.saved
          ? 'Saved, not copied'
          : 'Not copied';
      level = 'error';
    } else if (f.partial) {
      title = `Copied, but ${f.missing}.`;
      level = 'warn';
    } else if (f.long) title = `Copied. Press ${f.paste} for the full image.`;
    else title = f.saved ? 'Copied and saved' : 'Copied';

    const where = f.saved
      ? `Saved to ${f.label}${f.thisTime ? ' this time' : ''}`
      : f.error || 'Not saved';
    const caption = f.long
      ? `${ui.num(f.tiles)} AI screenshots ready · ${where}`
      : `${f.size} · ${where}`;
    return { title, level, caption };
  }

  /** @param {string} text */
  function capitalize(text) {
    return text.slice(0, 1).toUpperCase() + text.slice(1);
  }

  /**
   * How many files did not save, in words. A reply can come without the count: then it is
   * "some files".
   * @param {number} saved  Files that saved.
   * @param {number} failed  Files that did not (0 when the count is not known).
   * @returns {string}
   */
  function missingText(saved, failed) {
    return failed > 0
      ? `${ui.num(failed)} of ${ui.num(saved + failed)} files didn't save`
      : "some files didn't save";
  }

  /**
   * @param {{ config: PageConfig, summary: FinishSummary, copy: CopyState }} opts
   * @returns {ToastHandle | null}
   */
  function show({ config, summary, copy }) {
    current?.close(true);
    const sessionId = safeText(summary?.sessionId, 64);
    if (!sessionId) return null;

    const tiles = Math.max(1, safeCount(summary.tileCount));
    const long = tiles > 1 && summary.fitsOneImage !== true;
    // One of the first long captures: it stays until the user dismisses it (it teaches the keys).
    const sticky = long && summary.teach === true;
    const insertKeys = ui.keysOf(config, 'insert');
    const pasteKeys = ui.keysOf(config, 'paste');
    const save = summary.save ?? { location: 'none', label: '', files: 0, needsPermission: false };
    const saved = save.location !== 'none' && safeCount(save.files) > 0;
    const error = safeText(save.error, 120);
    // Some files saved and others did not: the toast must not say "Copied and saved".
    const partial = saved && error !== '';
    const facts = {
      saved,
      long,
      tiles,
      label: placeLabel(safeText(save.label, 80)) || 'Downloads',
      size: ui.sizeText(safeCount(summary.widthPx), safeCount(summary.heightPx)),
      error,
      partial,
      missing: partial ? missingText(safeCount(save.files), safeCount(save.failed)) : '',
      thisTime: save.needsPermission === true,
      paste: pasteKeys.text,
    };
    const needsPermission = save.needsPermission === true;
    // No folder is chosen and this capture asks "Save to Pictures › Screenshots?". A folder that
    // needs permission has its own question ("Reconnect").
    const askFolder = save.askFolder === true && !needsPermission;
    const hasQuestion = needsPermission || askFolder;
    // The link "Change" shows on every save in Downloads, as the standing way to a folder.
    const canChange = save.location === 'downloads' && saved && !needsPermission;
    // "Show in folder": the browser can reveal a file that it downloaded. It cannot reveal a folder
    // that the user picked, so the button shows for a save in Downloads only.
    const canReveal = save.location === 'downloads' && saved;
    // The folder of the AI screenshots exists only when the tiles were saved.
    const tilesPlace =
      saved && config.settings?.saveTiles !== false
        ? `${placeLabel(safeText(save.label, 80)) || 'Downloads'} › ${TILES_FOLDER}`
        : '';
    const folderPlace = placeLabel(safeText(save.folderLabel, 80));
    const warning = Array.isArray(summary.warnings) ? safeText(summary.warnings[0], 140) : '';

    let state = copy;
    let detail = '';
    /** Why a button did not work (the message of the service worker), or ''. */
    let actionMessage = '';
    let closed = false;
    const token = {};
    const card = ui.createCardHost(CSS, {
      onOrphan: () => close(true),
      onDismiss: () => close(true),
    });
    const { root } = card;

    // ---- Build -------------------------------------------------------------------------------
    const surface = ui.el('div', 'card');
    surface.setAttribute('role', 'status');
    surface.setAttribute('aria-live', 'polite');
    surface.setAttribute('aria-label', 'Spool: capture result');

    // Thumbnail: the top of the image, drawn on a canvas.
    const ratio =
      safeCount(summary.thumbnailWidthPx) > 0 && safeCount(summary.thumbnailHeightPx) > 0
        ? safeCount(summary.thumbnailHeightPx) / safeCount(summary.thumbnailWidthPx)
        : 1.5;
    const thumbWidth = long ? STACK_THUMB_WIDTH : THUMB_WIDTH;
    const thumbMax = long ? STACK_THUMB_MAX_HEIGHT : THUMB_MAX_HEIGHT;
    const thumbHeight = Math.round(Math.min(thumbMax, Math.max(28, thumbWidth * ratio)));
    const thumb = ui.el('div', 'thumb');
    thumb.setAttribute('aria-hidden', 'true');
    thumb.style.width = `${thumbWidth}px`;
    thumb.style.height = `${thumbHeight}px`;
    const canvas = ui.el('canvas');
    const dpr = Math.max(1, Math.min(3, Number(globalThis.devicePixelRatio) || 1));
    canvas.width = Math.round(thumbWidth * dpr);
    canvas.height = Math.round(thumbHeight * dpr);
    thumb.append(canvas);
    let lead = thumb;
    if (long) {
      const stack = ui.el('div', 'stack');
      stack.setAttribute('aria-hidden', 'true');
      stack.append(ui.el('span', 'layer back'), ui.el('span', 'layer mid'), thumb);
      lead = stack;
    }
    void ui.drawPng(canvas, safeText(summary.thumbnailPngBase64, 400_000));

    // Title and caption.
    const iconSlot = ui.el('span', 'icon-slot');
    iconSlot.style.display = 'inline-flex';
    const titleText = ui.text('');
    const title = ui.el('div', 'title');
    title.append(iconSlot, titleText);
    const captionText = ui.text('');
    const caption = ui.el('div', 'caption');
    caption.append(captionText);
    /** @type {HTMLButtonElement | null} */
    let changeLink = null;
    if (canChange) {
      changeLink = ui.el('button', 'link change', 'Change');
      changeLink.type = 'button';
      changeLink.setAttribute('aria-label', 'Change the save location');
      caption.append(ui.text(' · '), changeLink);
    }
    const note = ui.el('div', 'caption');
    note.style.display = 'none';
    const close_ = ui.el('button', 'icon-btn');
    close_.type = 'button';
    close_.setAttribute('aria-label', 'Close (Esc)');
    close_.title = 'Close (Esc)';
    close_.append(ui.icon('close'));
    const head = ui.el('div', 'head');
    head.append(title, close_);

    const body = ui.el('div', 'body');
    body.append(head, caption, note);

    // Actions of the short toast.
    const openButton = ui.el('button', partial ? 'btn primary' : 'btn');
    openButton.type = 'button';
    openButton.append(ui.icon('open'), ui.text('Open'));
    openButton.title = 'See it, copy or save it again';
    const pasteHint = ui.el('span', 'paste small');
    pasteHint.append(ui.text('Paste'), ...pasteKeys.parts.map((part) => ui.el('kbd', '', part)));
    /** @type {HTMLButtonElement | null} */
    let revealButton = null;
    if (canReveal) {
      revealButton = ui.el('button', 'btn');
      revealButton.type = 'button';
      revealButton.append(ui.icon('folder'), ui.text('Show in folder'));
    }
    if (!long) {
      const actions = ui.el('div', 'actions');
      actions.append(openButton);
      if (revealButton) actions.append(revealButton);
      actions.append(ui.el('span', 'grow'), pasteHint);
      body.append(actions);
    }

    const main = ui.el('div', 'main');
    main.append(lead, body);
    surface.append(main);

    // Long toast: the hint, then one chip for each tile and the Open link.
    /** @type {HTMLButtonElement[]} */
    const chips = [];
    /** @type {HTMLButtonElement | null} */
    let openLink = null;
    /** @type {HTMLElement | null} */
    let say = null;
    /** @type {HTMLElement | null} */
    let desktopLine = null;
    if (long) {
      // The main route: a tinted block with the real key as keycaps. The words depend on the state
      // of the copy: see renderHint().
      say = ui.el('span', 'say');
      const hint = ui.el('p', 'hint');
      hint.append(ui.icon('insert'), say);
      // For a desktop chat app: the shelf cannot work there, but the files are in a folder.
      if (tilesPlace) {
        desktopLine = ui.el('p', 'caption', `Desktop app: drag them from ${tilesPlace}.`);
        desktopLine.style.margin = '0';
      }
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
      openLink = ui.el('button', 'link');
      openLink.type = 'button';
      openLink.append(ui.text('Open'), ui.icon('open', '', 14));
      const links = ui.el('span', 'links');
      links.append(openLink);
      if (revealButton) {
        revealButton.className = 'link';
        links.append(revealButton);
      }
      const tileHead = ui.el('div', 'tilehead');
      tileHead.append(label, links);
      const wrap = ui.el('div', 'tiles');
      wrap.append(tileHead, group);
      surface.append(hint);
      if (desktopLine) surface.append(desktopLine);
      surface.append(wrap);
    }

    // A decision for the user: set up a folder (none is chosen), or reconnect it (the browser
    // dropped access, and this capture went to Downloads).
    /** @type {HTMLButtonElement | null} */
    let allowButton = null;
    /** @type {HTMLButtonElement | null} */
    let laterButton = null;
    if (hasQuestion) {
      const question = askFolder
        ? `Save to ${PICTURES_PLACE}?`
        : `Reconnect ${folderPlace || 'your folder'}?`;
      const heading = ui.el('h2', '', question);
      allowButton = ui.el('button', 'btn primary');
      allowButton.type = 'button';
      allowButton.textContent = askFolder ? 'Set up' : 'Reconnect';
      laterButton = ui.el('button', 'btn quiet');
      laterButton.type = 'button';
      laterButton.textContent = 'Not now';
      laterButton.style.height = '36px';
      const buttons = ui.el('div', 'buttons');
      buttons.append(allowButton, laterButton);
      const block = ui.el('div', 'permission');
      block.setAttribute('role', 'group');
      block.setAttribute('aria-label', askFolder ? 'Save to a folder' : 'Reconnect your folder');
      block.append(heading, buttons);
      surface.append(block);
    }

    const bar = ui.el('div', 'bar');
    bar.setAttribute('aria-hidden', 'true');
    bar.append(ui.el('span'));
    surface.append(bar);
    root.append(surface);

    // ---- State -------------------------------------------------------------------------------
    /** Why the countdown waits: hover, focus, a tile that is being copied. */
    const holds = new Set();
    let started = false;
    let paused = false;
    let remaining = hasQuestion ? PERMISSION_HIDE_MS : AUTO_HIDE_MS;
    // A toast that teaches has no countdown: the user closes it (Esc, the close button, Open).
    let startedAt = 0;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let hideTimer = null;
    /** @type {Set<ReturnType<typeof setTimeout>>} */
    const chipTimers = new Set();

    function now() {
      return typeof performance?.now === 'function' ? performance.now() : Date.now();
    }

    function stopTimer() {
      if (hideTimer !== null) clearTimeout(hideTimer);
      hideTimer = null;
    }

    function armTimer() {
      if (sticky) return;
      stopTimer();
      startedAt = now();
      hideTimer = setTimeout(() => close(false), Math.max(0, remaining));
    }

    /** The countdown runs when nothing holds the toast and the copy is not pending. */
    function syncTimer() {
      if (closed || !started || sticky) return;
      const hold = holds.size > 0;
      if (hold && !paused) {
        paused = true;
        stopTimer();
        remaining -= now() - startedAt;
        root.dataset.paused = '';
      } else if (!hold && paused) {
        paused = false;
        delete root.dataset.paused;
        armTimer();
      }
    }

    function startCountdown() {
      if (started || closed) return;
      started = true;
      if (sticky) return;
      root.style.setProperty('--hide', `${remaining}ms`);
      root.dataset.timing = '';
      if (holds.size > 0) {
        paused = true;
        root.dataset.paused = '';
      } else {
        armTimer();
      }
    }

    /** @param {string} reason @param {boolean} on */
    function hold(reason, on) {
      if (on) holds.add(reason);
      else holds.delete(reason);
      syncTimer();
    }

    /** @param {boolean} [immediately] No closing animation. */
    function close(immediately = false) {
      if (closed) return;
      closed = true;
      stopTimer();
      for (const timer of chipTimers) clearTimeout(timer);
      chipTimers.clear();
      if (current?.token === token) current = null;
      const finish = () => card.destroy();
      if (immediately) {
        finish();
        return;
      }
      root.dataset.closing = '';
      setTimeout(finish, CLOSE_MS);
    }

    // ---- Texts -------------------------------------------------------------------------------
    /** The words of the tinted block: the route into a chat. */
    function renderHint() {
      if (!say) return;
      const count = ui.num(tiles);
      // An image that was not copied has no "Ctrl+V" route: the screenshots are the way.
      const lead = state === 'toolarge' ? 'Press ' : 'Long capture? In your chat tab, press ';
      const tail =
        state === 'toolarge'
          ? ` in your chat to insert the ${count} screenshots.`
          : ` to insert all ${count} screenshots.`;
      if (insertKeys.parts.length > 0) {
        say.replaceChildren(ui.text(lead), keycaps(insertKeys), ui.text(tail));
      } else {
        say.replaceChildren(
          ui.text(
            'Set a shortcut for "Insert last capture" in your browser. Then press it in your ' +
              `chat tab to insert all ${count} screenshots.`,
          ),
        );
      }
    }

    function render() {
      renderHint();
      const said = words(facts, state);
      titleText.data = said.title;
      title.dataset.level = said.level;
      iconSlot.replaceChildren(
        state === 'pending'
          ? ui.icon('spinner', 'spin')
          : said.level !== 'info'
            ? ui.icon('warn')
            : ui.icon('check'),
      );
      captionText.data = said.caption;
      caption.dataset.level = facts.saved || state === 'pending' ? 'info' : 'warn';
      // What the person must know comes first: a failed copy, then files that did not save, then
      // the first warning of the capture.
      /** @type {string[]} */
      const lines = [];
      if (state === 'failed') {
        lines.push(detail || 'Use Open to copy or save it.');
      } else if (state === 'toolarge') {
        // Saved: the files are the result. Not saved: Open is the only way left to keep it.
        if (!facts.saved) lines.push('Open the capture to save it.');
      } else if (partial && state !== 'pending') {
        lines.push(
          state === 'copied'
            ? 'The full image is on your clipboard. Open the capture to save the rest.'
            : 'Open the capture to save the rest.',
        );
      }
      if (actionMessage) lines.push(actionMessage);
      if (warning) lines.push(warning);
      const extra = lines.join(' ');
      note.style.display = extra ? 'block' : 'none';
      note.textContent = extra;
      note.dataset.level = state === 'failed' || partial ? 'error' : 'warn';
      pasteHint.style.display = state === 'copied' ? 'flex' : 'none';
    }

    // ---- Actions -----------------------------------------------------------------------------
    /** True while a request of a button waits for its answer. */
    let acting = false;

    /**
     * Sends the request of a button and waits for the answer: the toast closes when it worked, and
     * the note says why when it did not (the capture is gone, the tab did not open). The countdown
     * waits while the request runs.
     * @param {string} key
     * @param {Record<string, unknown>} fields
     */
    function act(key, fields) {
      if (acting) return;
      acting = true;
      hold('action', true);
      void ui.send(config, key, fields).then((reply) => {
        acting = false;
        hold('action', false);
        if (closed) return;
        if (reply.ok) {
          close(false);
          return;
        }
        actionMessage = safeText(reply.message, 140);
        render();
      });
    }

    function open() {
      act('PAGE_OPEN_RESULT', { sessionId });
    }

    /**
     * Copies one tile. The clipboard write starts in this click (no await before it); the tile
     * arrives later, as a promise.
     * @param {number} index
     * @param {HTMLButtonElement} chip
     */
    function copyTile(index, chip) {
      if (chip.dataset['state'] === 'pending') return;
      const blob = ui
        .send(config, 'PAGE_GET_TILE', { sessionId, index })
        .then((reply) => {
          if (!reply.ok) throw new Error(reply.message);
          return ui.pngBlob(reply.data['pngBase64']);
        });
      setChip(chip, index, 'pending');
      hold(`tile ${index}`, true);
      void ui.copyImage(blob).then((ok) => {
        hold(`tile ${index}`, false);
        if (closed) return;
        setChip(chip, index, ok ? 'copied' : 'failed');
        const timer = setTimeout(() => {
          chipTimers.delete(timer);
          if (!closed) setChip(chip, index, 'idle');
        }, CHIP_RESET_MS);
        chipTimers.add(timer);
      });
    }

    /**
     * @param {HTMLButtonElement} chip
     * @param {number} index
     * @param {'idle' | 'pending' | 'copied' | 'failed'} next
     */
    function setChip(chip, index, next) {
      const n = String(index + 1);
      chip.dataset['state'] = next;
      chip.replaceChildren();
      if (next === 'copied') {
        chip.append(ui.icon('check', '', 14), ui.text(`${n} · Copied`));
        chip.setAttribute('aria-label', `Screenshot ${n} copied`);
      } else if (next === 'failed') {
        chip.append(ui.text(`${n} · Failed`));
        chip.setAttribute('aria-label', `Screenshot ${n} could not be copied`);
      } else if (next === 'pending') {
        chip.append(ui.icon('spinner', 'spin', 14), ui.text(n));
        chip.setAttribute('aria-label', `Copying screenshot ${n}`);
      } else {
        chip.append(ui.text(n));
        chip.setAttribute('aria-label', `Copy screenshot ${n}`);
      }
    }

    /**
     * Reveals the saved file in the file manager. The toast stays: a failure shows in the note.
     */
    function reveal() {
      void ui.send(config, 'PAGE_SHOW_IN_FOLDER', { sessionId }).then((reply) => {
        if (closed || reply.ok) return;
        actionMessage = safeText(reply.message, 140);
        render();
      });
    }

    card.listen(close_, 'click', () => close(false));
    card.listen(openButton, 'click', open);
    if (openLink) card.listen(openLink, 'click', open);
    if (revealButton) card.listen(revealButton, 'click', reveal);
    chips.forEach((chip, i) => card.listen(chip, 'click', () => copyTile(i, chip)));
    if (allowButton) {
      card.listen(allowButton, 'click', () => {
        act('PAGE_OPEN_OPTIONS', { section: askFolder ? 'setup' : 'reconnect' });
      });
    }
    if (laterButton) card.listen(laterButton, 'click', () => close(false));
    if (changeLink) {
      card.listen(changeLink, 'click', () => {
        act('PAGE_OPEN_OPTIONS', { section: 'setup' });
      });
    }

    // Hover and focus hold the countdown. A press does not take the focus from the page.
    card.listen(surface, 'pointerenter', () => hold('hover', true));
    card.listen(surface, 'pointerleave', () => hold('hover', false));
    card.listen(surface, 'focusin', () => hold('focus', true));
    card.listen(surface, 'focusout', () => hold('focus', false));
    card.listen(surface, 'mousedown', (e) => e.preventDefault());

    // Esc closes the toast, and only the toast: the page does not get this key (an open dialog of
    // the page stays; the next Esc is its own).
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

    // ---- Handle ------------------------------------------------------------------------------
    /** @type {ToastHandle} */
    const handle = {
      setCopy(next, why = '') {
        if (closed) return;
        const text = safeText(why, 160);
        if (next === state && text === detail) return;
        state = next;
        detail = text;
        render();
        if (state !== 'pending') startCountdown();
      },
      close() {
        close(false);
      },
    };

    chips.forEach((chip, i) => setChip(chip, i, 'idle'));
    render();
    current = {
      token,
      close(immediately) {
        close(immediately === true);
      },
    };
    // Show: the card starts hidden; reading its size lets the transition start from there.
    void surface.offsetWidth;
    root.dataset.open = '';
    if (state !== 'pending') startCountdown();
    return handle;
  }

  function dismiss() {
    current?.close(false);
  }

  ns.toast = Object.freeze(/** @type {ToastModule} */ ({ show, dismiss }));
})();
