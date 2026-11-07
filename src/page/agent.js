// @ts-check
/**
 * Page agent. Runs one capture session inside the page (classic script, isolated world).
 * Contract: docs/contracts.md section 5, "agent.js".
 *
 * The user selects an area. The agent finds the element that scrolls under it, scrolls it step
 * by step, asks the service worker to capture every frame, and shows the progress in the overlay.
 * The page is ALWAYS restored when the session closes: scroll position, inline styles and
 * overlay (done, cancel, error, invalid extension context, pagehide). Closing is idempotent.
 *
 * Done (docs/contracts.md section 7.1): in the same task as the key press or click, with no await
 * before it, the agent starts the clipboard write of the full image (a promise: page/finish, then
 * page/get-clipboard). When the service worker has finished the capture, the page is restored and
 * the toast (toast.js) shows the result. A rejected write or a missing clipboard API goes to the
 * service worker (page/clipboard-fallback). A capture that is too large to copy as one image
 * (width x height x 4 bytes over `limits.maxClipboardBitmapBytes`) gets no write at all: the
 * browser decodes the whole image in this page, and a tab crashes far above the limit. The files
 * still save. In mode 'shelf', start() opens the shelf (shelf.js).
 *
 * Nothing in this file may throw into the page: every listener and every promise is guarded. The
 * page cannot drive the agent: it acts only on trusted `pagehide` events, and it reads the page's
 * DOM and its own namespace in ways that page markup cannot shadow (see page-lib.js).
 */
(() => {
  'use strict';

  /** @typedef {import('../shared/types.js').Rect} Rect */
  /** @typedef {import('../shared/types.js').Settings} Settings */
  /** @typedef {import('../shared/types.js').PageConfig} PageConfig */
  /** @typedef {import('../shared/types.js').FrameMeta} FrameMeta */
  /** @typedef {import('../shared/types.js').Direction} Direction */
  /** @typedef {import('../../types/page-globals.js').ScrollTarget} ScrollTarget */
  /** @typedef {import('../../types/page-globals.js').PageLib} PageLib */
  /** @typedef {import('../../types/page-globals.js').StyleJar} StyleJar */
  /** @typedef {import('../../types/page-globals.js').OverlayScanner} OverlayScanner */
  /** @typedef {import('../../types/page-globals.js').OverlayHandle} OverlayHandle */
  /** @typedef {import('../../types/page-globals.js').OverlayCommand} OverlayCommand */

  /**
   * @typedef {'idle' | 'selecting' | 'ready' | 'stepping' | 'auto' | 'finishing' | 'closed'} State
   */
  /** @typedef {'info' | 'warn' | 'error'} Level */
  /** @typedef {'ok' | 'end' | 'limit' | 'paused' | 'error' | 'closed'} Outcome */
  /** @typedef {{ ok: true, data: Record<string, any> }} ReplyOk */
  /** @typedef {{ ok: false, code: string, message: string }} ReplyFail */
  /** @typedef {ReplyOk | ReplyFail} Reply */
  /**
   * The capture area. `scanner` finds the fixed and sticky elements over it; it is created at the
   * first capture (its full scan runs once per session).
   * @typedef {{ target: ScrollTarget, rect: Rect, originalScrollTop: number,
   *   scanner: OverlayScanner | null }} Area
   */
  /**
   * The outcome of page/finish: the summary of the capture, or the message to show.
   * @typedef {{ ok: true, summary: unknown } | { ok: false, message: string }} FinishOutcome
   */
  /**
   * A gate that holds page/finish back while a step runs (Done came in during it).
   * @typedef {{ promise: Promise<boolean>, open(go: boolean): void }} Gate
   */
  /**
   * Done under way: the answer of page/finish, whether the capture copies to the clipboard
   * (`copy`: the setting `copyOnDone`; when false there is no write and no fetch of the image),
   * the clipboard write (resolves true when the browser accepted it; never rejects), and the
   * reason when the image could not be fetched (the message of the service worker, for the toast).
   * `tooLarge()` is true when the image is over the clipboard limit: then there is no write (or
   * the write was given up before it fetched the image) and no fallback.
   * @typedef {{ finish: Promise<FinishOutcome>, copy: boolean, copied: Promise<boolean>,
   *   reason: () => string, tooLarge: () => boolean }} FinishRun
   */
  /**
   * The part of an IntakeResult that the agent uses.
   * @typedef {{ index: number, sliceCount: number, totalHeightPx: number, tileCount: number,
   *   seamStatus: string }} Intake
   */

  /**
   * @typedef {Object} Session
   * @property {PageConfig} config      Copied at start(). A later injection replaces the global.
   * @property {Settings} settings
   * @property {PageLib} lib
   * @property {OverlayHandle} overlay
   * @property {StyleJar} jar
   * @property {State} state
   * @property {Area | null} area       Set when the service worker accepted the session.
   * @property {boolean} sessionOpened  The service worker holds a session for us.
   * @property {number} seq             Frames stored so far (0: nothing to finish yet).
   * @property {Direction | null} retry The frame whose capture failed last (or has not been
   *   tried yet: 'initial' at the start), by its direction. The page has scrolled to it already.
   *   The next step captures it first, at the current position, and scrolls on only when it
   *   is stored. Null when every frame so far was stored.
   * @property {number | null} lastScrollTop  Scroll position of the last frame that was taken or
   *   tried (null before the first one). A step starts there: see `resync()`.
   * @property {number} finishingSince  Epoch ms when Done started the save (for the elapsed hint
   *   and the time limit).
   * @property {(() => void) | null} limitFinish  Ends the wait for page/finish with the time-out
   *   message. Set by beginFinish(); the watchdog calls it when the save takes too long.
   * @property {number} minContentY     Smallest contentY of a stored frame.
   * @property {number} maxContentY     Largest contentY of a stored frame.
   * @property {boolean} lastStored     The last frame added a slice (it was not a duplicate).
   * @property {{ slices: number, heightPx: number, tiles: number }} totals
   * @property {boolean} limitReached   Covered height reached settings.maxHeightCss.
   * @property {boolean} endHit         The last downward scroll did not move: the end of the panel,
   *   also when the scroll range says otherwise. Cleared by the next scroll that moves.
   * @property {'done' | 'cancel' | null} pendingEnd  Honoured after the current step.
   * @property {FinishRun | null} finishRun  Done pressed during a step: the clipboard write was
   *   started in that gesture and waits behind `gate`. Used by finishSession().
   * @property {Gate | null} gate
   * @property {boolean} autoStop       The user toggled Auto off while it runs.
   * @property {Level} level            Last status line.
   * @property {string} message
   * @property {(event: Event) => void} pageHide  The pagehide listener of this session.
   * @property {ReturnType<typeof setInterval> | null} watch  The watchdog timer (see watchdog()).
   */

  const SUPPORTED_PROTOCOL = 1;
  /**
   * Same value as MAX_CLIPBOARD_BITMAP_BYTES in src/shared/constants.js (a page script cannot
   * import). The worker sends the real one in `config.limits`; this is for a config without it.
   * test/unit/constants.test.js checks that both are the same.
   */
  const DEFAULT_MAX_CLIPBOARD_BITMAP_BYTES = 256 * 1024 * 1024;
  /** How often a session checks that the extension is still there, and that its overlay is on top. */
  const WATCH_INTERVAL_MS = 1000;
  /** Done is still saving after this long: the status line says so. */
  const FINISHING_HINT_MS = 2000;
  /**
   * Done waits this long for page/finish. Then the session is ready again, with a message, and
   * Cancel works: a save that hangs cannot hold the person in "Finishing…". A long capture builds
   * and saves in well under a minute; the browser's own wait for one download is 2 minutes.
   */
  const FINISH_TIMEOUT_MS = 180_000;
  /** Smallest scroll step, CSS px. */
  const MIN_STEP_CSS = 8;
  /** A scroll that moves less than this did not move: the end of the content. */
  const END_EPSILON_CSS = 0.5;
  /** At most this far from the bottom of the scroll range counts as the end of the panel. */
  const AT_END_SLACK_CSS = 1;
  const MAX_TITLE_LENGTH = 200;
  const MAX_ERROR_LENGTH = 200;
  /** Auto stops after this many frames in a row that added nothing. */
  const MAX_STALE_FRAMES = 3;
  /** Same tolerance as isFrameMeta() in src/shared/protocol.js. */
  const VIEWPORT_TOLERANCE_CSS = 1;
  const REQUIRED_MSG = Object.freeze([
    'PAGE_SESSION_OPEN',
    'PAGE_CAPTURE_FRAME',
    'PAGE_FINISH',
    'PAGE_CANCEL',
  ]);
  /** Local error code for failures that have no protocol code. */
  const CODE_UNREACHABLE = 'E_UNREACHABLE';

  const TEXT = Object.freeze({
    outside: 'Select an area inside the page.',
    endUp: 'Reached the top.',
    limit: 'Reached the length limit.',
    unmatched: 'Spool could not verify the last seam.',
    tabHidden: 'Go back to this tab to continue.',
    stopping: 'Stopping after this step.',
    finishing: 'Saving and copying…',
    finishingNoCopy: 'Saving…',
    finishingLong: 'Still saving. A long capture takes a few seconds.',
    finishTimeout: 'Saving is taking too long. Try Done again, or Cancel.',
    tooLargeToCopy: 'Too tall to copy as one image.',
    nothingYet: 'Nothing was captured yet. Scroll once, or Cancel.',
    noNewContent: 'No new content found.',
    resized: 'The window size changed. Cancel and select the area again.',
    generic: 'Something went wrong. Try again.',
    unreachable: 'Could not reach the extension. Try again.',
  });

  /**
   * The session that is not closed, if any.
   * @type {Session | null}
   */
  let current = null;

  // -------------------------------------------------------------------------------------------
  // Page-proof access to the DOM and to the namespace (see page-lib.js)
  // -------------------------------------------------------------------------------------------
  // `<img name="title">` replaces `document.title`, an element with `id="__spool"` replaces the
  // namespace. The accessors come from the prototypes when the script loads; without a prototype
  // (a unit test with a fake DOM) the plain property is used.

  /**
   * @param {object | undefined} proto
   * @param {string} name
   * @returns {(self: any) => any}
   */
  function getterFrom(proto, name) {
    const get = proto ? Object.getOwnPropertyDescriptor(proto, name)?.get : undefined;
    return get ? (self) => get.call(self) : (self) => self[name];
  }

  const DocumentProto = globalThis.Document?.prototype;
  const docTitle = getterFrom(DocumentProto, 'title');
  const docElement = getterFrom(DocumentProto, 'documentElement');

  /**
   * The shared namespace: an own, plain-object property of the global. Another kind of value, for
   * example an element that markup put there, is not trusted: a fresh namespace takes its place.
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

  // -------------------------------------------------------------------------------------------
  // Small helpers
  // -------------------------------------------------------------------------------------------

  function noop() {}

  /** Runs `fn` and ignores any error: the page must keep working. @param {() => void} fn */
  function attempt(fn) {
    try {
      fn();
    } catch {
      // ignored on purpose
    }
  }

  /** @param {Promise<unknown>} promise */
  function fireAndForget(promise) {
    promise.catch(noop);
  }

  /** @param {Session} s */
  function isClosed(s) {
    return s.state === 'closed';
  }

  /** @param {unknown} e @returns {string} */
  function messageOf(e) {
    if (typeof e === 'object' && e !== null && 'message' in e) return String(e.message);
    return String(e);
  }

  /** False when the extension was reloaded, updated or removed (this script is orphaned). */
  function contextValid() {
    try {
      return Boolean(globalThis.chrome?.runtime?.id);
    } catch {
      return false;
    }
  }

  /** @param {unknown} e */
  function isContextInvalidated(e) {
    return !contextValid() || /context invalidated/i.test(messageOf(e));
  }

  /** @returns {Rect} The viewport as a rect. */
  function viewportRect() {
    return { x: 0, y: 0, width: innerWidth, height: innerHeight };
  }

  /**
   * True when `r` lies inside the viewport (same tolerance as the check in the service worker).
   * @param {Rect} r
   */
  function fitsViewport(r) {
    const t = VIEWPORT_TOLERANCE_CSS;
    return (
      r.x >= -t &&
      r.y >= -t &&
      r.x + r.width <= innerWidth + t &&
      r.y + r.height <= innerHeight + t
    );
  }

  // -------------------------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------------------------

  /**
   * Sends one message. The envelope is the one makeMessage() builds in src/shared/protocol.js.
   * @param {PageConfig} config
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @returns {Promise<any>}
   */
  function sendRaw(config, type, fields) {
    return chrome.runtime.sendMessage({
      v: config.protocolVersion,
      target: config.target['SW'],
      type,
      ...fields,
    });
  }

  /**
   * Turns a reply into a Reply. A reply that is missing, or is not { ok: true }, is an error.
   * @param {unknown} raw
   * @returns {Reply}
   */
  function parseReply(raw) {
    if (typeof raw === 'object' && raw !== null && 'ok' in raw) {
      if (raw.ok === true) return { ok: true, data: /** @type {Record<string, any>} */ (raw) };
      const e = 'error' in raw && typeof raw.error === 'object' ? raw.error : null;
      const code = e && 'code' in e && typeof e.code === 'string' ? e.code : CODE_UNREACHABLE;
      const text = e && 'message' in e && typeof e.message === 'string' ? e.message : '';
      return { ok: false, code, message: text.slice(0, MAX_ERROR_LENGTH) || TEXT.generic };
    }
    return { ok: false, code: CODE_UNREACHABLE, message: TEXT.unreachable };
  }

  /**
   * Sends a message for session `s` and waits for the reply. Never throws. When the extension
   * context is invalid, it closes the session (the page is restored) and returns a failure.
   * @param {Session} s
   * @param {string} type
   * @param {Record<string, unknown>} fields
   * @returns {Promise<Reply>}
   */
  async function send(s, type, fields) {
    if (!contextValid()) {
      closeSession(s, false);
      return { ok: false, code: CODE_UNREACHABLE, message: TEXT.unreachable };
    }
    try {
      return parseReply(await sendRaw(s.config, type, fields));
    } catch (e) {
      if (isContextInvalidated(e)) closeSession(s, false);
      return { ok: false, code: CODE_UNREACHABLE, message: TEXT.unreachable };
    }
  }

  /**
   * Best effort: tells the service worker to drop the session. Never throws, never waits.
   * @param {Session} s
   */
  function notifyCancel(s) {
    if (!contextValid()) return;
    try {
      const sent = sendRaw(s.config, s.config.msg['PAGE_CANCEL'] ?? '', {
        sessionId: s.config.sessionId,
      });
      Promise.resolve(sent).catch(noop);
    } catch {
      // ignored on purpose
    }
  }

  /**
   * Reads the fields of an IntakeResult that the agent needs. Null when the reply is malformed.
   * @param {any} v
   * @returns {Intake | null}
   */
  function readIntake(v) {
    if (typeof v !== 'object' || v === null) return null;
    const { index, sliceCount, totalHeightPx, tileCount, seam } = v;
    const numbers = [index, sliceCount, totalHeightPx, tileCount];
    if (!numbers.every((n) => typeof n === 'number' && Number.isFinite(n))) return null;
    if (typeof seam !== 'object' || seam === null || typeof seam.status !== 'string') return null;
    return { index, sliceCount, totalHeightPx, tileCount, seamStatus: seam.status };
  }

  // -------------------------------------------------------------------------------------------
  // Status line and close
  // -------------------------------------------------------------------------------------------

  /**
   * Where the target is along its scroll range. `progress` is 0 at the top and 1 at the bottom
   * (1 when there is nothing to scroll). `atEnd` is true at the bottom, and after a downward
   * scroll that did not move.
   * @param {Session} s
   * @returns {{ progress: number, atEnd: boolean }}
   */
  function scrollProgress(s) {
    const area = s.area;
    if (!area) return { progress: 0, atEnd: false };
    try {
      const max = s.lib.maxScrollTop(area.target);
      const top = s.lib.getScrollTop(area.target);
      if (!(max > AT_END_SLACK_CSS)) return { progress: 1, atEnd: true };
      const ratio = top / max;
      return {
        progress: Number.isFinite(ratio) ? Math.min(1, Math.max(0, ratio)) : 0,
        atEnd: s.endHit || max - top <= AT_END_SLACK_CSS,
      };
    } catch {
      return { progress: 0, atEnd: s.endHit };
    }
  }

  /** Sends the current status to the overlay. @param {Session} s */
  function refreshStatus(s) {
    if (isClosed(s)) return;
    const { progress, atEnd } = scrollProgress(s);
    attempt(() =>
      s.overlay.setStatus({
        slices: s.totals.slices,
        heightPx: s.totals.heightPx,
        tiles: s.totals.tiles,
        auto: s.state === 'auto',
        finishing: s.state === 'finishing',
        level: s.level,
        message: s.message,
        progress,
        atEnd,
      }),
    );
  }

  /** @param {Session} s @param {Level} level @param {string} message */
  function publish(s, level, message) {
    s.level = level;
    s.message = message;
    refreshStatus(s);
  }

  /** @param {Session} s @param {boolean} busy */
  function setBusy(s, busy) {
    if (!isClosed(s)) attempt(() => s.overlay.setBusy(busy));
  }

  /**
   * Restores the page and removes the overlay. Idempotent and never throws. The restore steps are
   * independent: one that fails does not skip the next.
   * @param {Session} s
   * @param {boolean} notify  Also tell the service worker (best effort) to drop the session.
   *   Not sent while finishing: the service worker keeps a finished session for the result page.
   */
  function closeSession(s, notify) {
    if (isClosed(s)) return;
    const wasFinishing = s.state === 'finishing';
    s.state = 'closed';
    if (current === s) current = null;
    attempt(() => removeEventListener('pagehide', s.pageHide));
    stopWatch(s);
    s.gate?.open(false); // a Done that waited for a step does not finish a closed session
    const area = s.area;
    // Scroll first: scroll-behavior is still 'auto' (the jar restores it next).
    if (area) attempt(() => s.lib.setScrollTop(area.target, area.originalScrollTop));
    attempt(() => s.jar.restoreAll());
    attempt(() => s.overlay.destroy());
    if (notify && s.sessionOpened && !wasFinishing) notifyCancel(s);
  }

  // -------------------------------------------------------------------------------------------
  // Watchdog
  // -------------------------------------------------------------------------------------------

  /**
   * Runs every WATCH_INTERVAL_MS while a session is open. When the extension was reloaded,
   * updated or removed, nothing else would tell this script (it gets no event), so the page
   * would stay changed: fixed elements hidden, sticky ones static, the overlay on screen. The
   * session closes then and the page is restored. Otherwise the overlay is kept above what the
   * page opens later (a modal dialog, a popover).
   * @param {Session} s
   */
  function watchdog(s) {
    if (isClosed(s)) return;
    if (!contextValid()) {
      closeSession(s, false);
      return;
    }
    attempt(() => s.overlay.keepOnTop());
    // A long capture takes seconds to build: after 2 s the pill says that it is still working.
    const waited = Date.now() - s.finishingSince;
    const hintDue = s.state === 'finishing' && waited >= FINISHING_HINT_MS;
    if (hintDue && s.message !== TEXT.finishingLong) publish(s, 'info', TEXT.finishingLong);
    // Cancel is off while it saves, so the wait has an end: see FINISH_TIMEOUT_MS.
    if (s.state === 'finishing' && waited >= FINISH_TIMEOUT_MS) s.limitFinish?.();
  }

  /** @param {Session} s */
  function startWatch(s) {
    s.watch = setInterval(() => attempt(() => watchdog(s)), WATCH_INTERVAL_MS);
  }

  /** @param {Session} s */
  function stopWatch(s) {
    const timer = s.watch;
    s.watch = null;
    if (timer !== null) attempt(() => clearInterval(timer));
  }

  // -------------------------------------------------------------------------------------------
  // Capture and steps
  // -------------------------------------------------------------------------------------------

  /**
   * Adds the intake of a stored frame to the session and updates the status line.
   * @param {Session} s
   * @param {Area} area
   * @param {FrameMeta} meta
   * @param {Intake} intake
   * @returns {Outcome}
   */
  function acceptFrame(s, area, meta, intake) {
    s.seq += 1;
    s.retry = null;
    s.totals = {
      slices: intake.sliceCount,
      heightPx: intake.totalHeightPx,
      tiles: intake.tileCount,
    };
    // A duplicate was not stored: it covers nothing new.
    s.lastStored = intake.index >= 0;
    if (s.lastStored) {
      s.minContentY = Math.min(s.minContentY, meta.contentY);
      s.maxContentY = Math.max(s.maxContentY, meta.contentY);
    }
    const coveredCss = s.maxContentY + area.rect.height - s.minContentY;
    if (coveredCss >= s.settings.maxHeightCss) {
      s.limitReached = true;
      publish(s, 'warn', TEXT.limit);
      return 'limit';
    }
    if (intake.seamStatus === 'unmatched') publish(s, 'warn', TEXT.unmatched);
    else publish(s, 'info', '');
    return 'ok';
  }

  /**
   * Makes every fixed and sticky element over the capture area show once, at its own place, in
   * the stitched image. Runs before every frame (new ones can appear while the page scrolls).
   * Every change goes through the style jar and is undone when the session closes.
   *  - sticky: `position: static`. The element keeps its space in the flow, so nothing moves; it
   *    stops following the scroll and appears only where it sits in the content (a header at the
   *    top, a date divider between its messages). Hiding it would leave a gap.
   *  - fixed: `visibility: hidden`. It is not part of the content and would repeat in every
   *    frame. The elements below it show instead.
   * @param {Session} s
   * @param {Area} area
   */
  function releasePinned(s, area) {
    area.scanner ??= s.lib.createOverlayScanner(s.overlay.host, area.target);
    for (const { el, kind } of area.scanner.collect(area.rect)) {
      if (kind === 'sticky') s.jar.set(el, 'position', 'static');
      else s.jar.set(el, 'visibility', 'hidden');
    }
  }

  /**
   * Captures one frame: frees fixed and sticky elements and hides the overlay, asks the service
   * worker for the capture, shows the overlay again. Throws only on unexpected errors; the caller
   * catches.
   * @param {Session} s
   * @param {Area} area
   * @param {Direction} direction
   * @returns {Promise<Outcome>}
   */
  async function captureFrame(s, area, direction) {
    const { rect, target } = area;
    // Cleared only when the frame is stored (acceptFrame): every other way out, an error or an
    // exception included, leaves it set.
    s.retry = direction;
    if (!fitsViewport(rect)) {
      publish(s, 'error', TEXT.resized);
      return 'error';
    }
    s.lastScrollTop = s.lib.getScrollTop(target);
    try {
      if (s.settings.hideOverlays) releasePinned(s, area);
      await s.overlay.hideForCapture();
      if (isClosed(s)) return 'closed';
      /** @type {FrameMeta} */
      const meta = {
        direction,
        viewport: { width: innerWidth, height: innerHeight },
        rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
        contentY: s.lib.contentYOf(target, rect),
      };
      const reply = await send(s, s.config.msg['PAGE_CAPTURE_FRAME'] ?? '', {
        sessionId: s.config.sessionId,
        meta,
      });
      if (isClosed(s)) return 'closed';
      if (!reply.ok) {
        if (reply.code === s.config.err['TAB_NOT_VISIBLE']) {
          publish(s, 'warn', TEXT.tabHidden);
          return 'paused';
        }
        publish(s, 'error', reply.message);
        return 'error';
      }
      const intake = readIntake(reply.data['intake']);
      if (!intake) {
        publish(s, 'error', TEXT.unreachable);
        return 'error';
      }
      return acceptFrame(s, area, meta, intake);
    } finally {
      if (!isClosed(s)) attempt(() => s.overlay.showAfterCapture());
    }
  }

  /**
   * Puts the page back where the last frame was taken, when something else moved it (a wheel
   * notch that reached the page, a key, the user's own scroll while Auto ran). Every step is
   * measured from the last frame: from another place the next frame lies too far from the last
   * one, the service worker refuses it ("The page moved too far."), and every later step fails the
   * same way. The scroll back waits like a normal step does.
   * @param {Session} s
   * @param {Area} area
   * @returns {Promise<boolean>} False when the session closed meanwhile.
   */
  async function resync(s, area) {
    const at = s.lastScrollTop;
    if (at === null) return true;
    const { target } = area;
    if (Math.abs(s.lib.getScrollTop(target) - at) < END_EPSILON_CSS) return true;
    s.lib.setScrollTop(target, at);
    await s.lib.nextFrames(2);
    if (isClosed(s)) return false;
    await s.lib.sleep(s.settings.settleMs);
    return !isClosed(s);
  }

  /**
   * One step: scroll, wait, capture. Reports 'end' when the scroll did not move. When the last
   * frame is not stored (Session.retry), that frame is captured first, before any scroll. Before
   * either, the page goes back to the place of the last frame (`resync`).
   * @param {Session} s
   * @param {Area} area
   * @param {'down' | 'up'} direction
   * @returns {Promise<Outcome>}
   */
  async function runStep(s, area, direction) {
    if (s.limitReached) {
      publish(s, 'warn', TEXT.limit);
      return 'limit';
    }
    if (!(await resync(s, area))) return 'closed';
    if (s.retry !== null) {
      // The last frame is not stored (its capture failed, or it was never tried), and the page
      // is already scrolled to it. Capture it now, at the current position and without scrolling:
      // a scroll first would skip the content of that frame and leave a gap in the image.
      const missed = await captureFrame(s, area, s.retry);
      if (missed !== 'ok') return missed;
    }
    const { target, rect } = area;
    const before = s.lib.getScrollTop(target);
    const distance = Math.max(MIN_STEP_CSS, rect.height - s.settings.overlapCss);
    const to = direction === 'down' ? before + distance : Math.max(0, before - distance);
    s.lib.setScrollTop(target, to);
    await s.lib.nextFrames(2);
    if (isClosed(s)) return 'closed';
    await s.lib.sleep(s.settings.settleMs);
    if (isClosed(s)) return 'closed';
    if (Math.abs(s.lib.getScrollTop(target) - before) < END_EPSILON_CSS) {
      // The overlay shows "End of panel" for the bottom (atEnd). The top gets a message.
      s.endHit = direction === 'down';
      publish(s, 'info', direction === 'down' ? '' : TEXT.endUp);
      return 'end';
    }
    s.endHit = false;
    return captureFrame(s, area, direction);
  }

  /**
   * Auto mode: scroll down until the end, the length limit, an error, a pause request, Done or
   * Cancel.
   * @param {Session} s
   * @param {Area} area
   */
  async function autoLoop(s, area) {
    let stale = 0;
    while (!isClosed(s) && s.pendingEnd === null && !s.autoStop) {
      const outcome = await runStep(s, area, 'down');
      if (outcome !== 'ok') return;
      stale = s.lastStored ? 0 : stale + 1;
      if (stale >= MAX_STALE_FRAMES) {
        publish(s, 'info', TEXT.noNewContent);
        return;
      }
    }
  }

  /**
   * Runs after every step: back to 'ready', then the Done or Cancel that came in meanwhile.
   * @param {Session} s
   */
  async function settle(s) {
    if (isClosed(s)) return;
    s.state = 'ready';
    setBusy(s, false);
    refreshStatus(s);
    const pending = s.pendingEnd;
    s.pendingEnd = null;
    if (pending === 'cancel') closeSession(s, true);
    else if (pending === 'done') {
      s.gate?.open(true);
      await finishSession(s);
    }
  }

  /**
   * Runs one command (a manual step or Auto) while the state is 'ready'.
   * @param {Session} s
   * @param {'down' | 'up' | 'auto'} cmd
   */
  async function drive(s, cmd) {
    const area = s.area;
    if (!area) return;
    const auto = cmd === 'auto';
    s.autoStop = false;
    s.state = auto ? 'auto' : 'stepping';
    // Auto keeps the buttons enabled so the user can toggle it off.
    setBusy(s, !auto);
    publish(s, 'info', '');
    try {
      if (auto) await autoLoop(s, area);
      else await runStep(s, area, /** @type {'down' | 'up'} */ (cmd));
    } catch {
      if (!isClosed(s)) publish(s, 'error', TEXT.generic);
    }
    await settle(s);
  }

  // -------------------------------------------------------------------------------------------
  // Done, Cancel, region
  // -------------------------------------------------------------------------------------------

  /** @returns {Gate} */
  function makeGate() {
    /** @type {(go: boolean) => void} */
    let open = noop;
    const promise = new Promise((resolve) => {
      open = resolve;
    });
    return { promise, open };
  }

  /**
   * Writes the image to the clipboard. It must run in the task of the user's key press or click,
   * with no await before it (docs/contracts.md section 7.1).
   * @param {Promise<Blob>} image
   * @returns {Promise<boolean>}
   */
  function writeClipboard(image) {
    const ui = sharedNamespace().ui;
    if (ui) return ui.copyImage(image);
    image.catch(noop);
    return Promise.resolve(false);
  }

  /**
   * Starts Done: asks the service worker to finish the capture and starts the clipboard write at
   * once. The image is a promise that waits for page/finish and then page/get-clipboard, so the
   * write runs in the gesture and the bytes arrive when they are ready. Nothing in here awaits
   * before the write.
   * @param {Session} s
   * @param {Gate | null} gate  Holds page/finish back until it opens (true), or drops it (false).
   * @returns {FinishRun}
   */
  function beginFinish(s, gate) {
    const sessionId = s.config.sessionId;
    // The watchdog opens this when the save has taken FINISH_TIMEOUT_MS. The clipboard write
    // below waits on `finish`, so it fails at the same moment and does not copy later.
    const limit = makeGate();
    s.limitFinish = () => limit.open(false);
    /** @type {Promise<FinishOutcome>} */
    const finish = (async () => {
      if (gate && !(await gate.promise)) return { ok: false, message: TEXT.generic };
      const reply = await Promise.race([
        send(s, s.config.msg['PAGE_FINISH'] ?? '', { sessionId }),
        limit.promise.then(() => null),
      ]);
      if (reply === null) return { ok: false, message: TEXT.finishTimeout };
      return reply.ok
        ? { ok: true, summary: reply.data['summary'] }
        : { ok: false, message: reply.message };
    })();
    // The setting `copyOnDone` is on unless it is false (an older config has no such key).
    // Off: no clipboard write, and the full image never leaves the offscreen document.
    if (s.settings.copyOnDone === false) {
      return {
        finish,
        copy: false,
        copied: Promise.resolve(false),
        reason: () => '',
        tooLarge: () => false,
      };
    }
    const maxBytes = clipboardLimit(s);
    // Known before page/finish: the width of the area and the height so far. The browser decodes
    // the whole image in this page, so a very tall one is not written at all.
    if (willExceedClipboard(s, maxBytes)) {
      finish.catch(noop);
      return {
        finish,
        copy: false,
        copied: Promise.resolve(false),
        reason: () => '',
        tooLarge: () => true,
      };
    }
    let reason = '';
    let tooLarge = false;
    const image = finish.then(async (outcome) => {
      if (!outcome.ok) throw new Error(outcome.message);
      if (isClosed(s)) throw new Error(TEXT.generic); // Cancel came in while it was finishing
      // The exact size is in the summary. It can differ from the estimate when Done came in
      // during a step, and one more frame was added after the gesture.
      if (summaryExceedsClipboard(outcome.summary, maxBytes)) {
        tooLarge = true;
        throw new Error(TEXT.tooLargeToCopy);
      }
      const reply = await send(s, s.config.msg['PAGE_GET_CLIPBOARD'] ?? '', { sessionId });
      if (!reply.ok) {
        reason = reply.message;
        throw new Error(reply.message);
      }
      const ui = sharedNamespace().ui;
      if (!ui) throw new Error(TEXT.generic);
      return ui.pngBlob(reply.data['pngBase64']);
    });
    return {
      finish,
      copy: true,
      copied: writeClipboard(image),
      reason: () => reason,
      tooLarge: () => tooLarge,
    };
  }

  /**
   * The most decoded bytes that this capture may put on the clipboard (`config.limits`, else the
   * built-in number).
   * @param {Session} s
   * @returns {number}
   */
  function clipboardLimit(s) {
    const given = s.config.limits?.maxClipboardBitmapBytes;
    return typeof given === 'number' && Number.isFinite(given) && given > 0
      ? given
      : DEFAULT_MAX_CLIPBOARD_BITMAP_BYTES;
  }

  /**
   * True when the image that Done will build is too large to copy: width of the area in device
   * px, height of the stitched image so far.
   * @param {Session} s
   * @param {number} maxBytes
   * @returns {boolean}
   */
  function willExceedClipboard(s, maxBytes) {
    const ui = sharedNamespace().ui;
    if (!ui || !s.area) return false;
    const widthPx = Math.round(s.area.rect.width * (Number(devicePixelRatio) || 1));
    return ui.exceedsClipboard(widthPx, s.totals.heightPx, maxBytes);
  }

  /**
   * @param {unknown} summary  The summary of page/finish.
   * @param {number} maxBytes
   * @returns {boolean}
   */
  function summaryExceedsClipboard(summary, maxBytes) {
    const ui = sharedNamespace().ui;
    const s = /** @type {Record<string, unknown> | null} */ (
      typeof summary === 'object' ? summary : null
    );
    if (!ui || !s) return false;
    const { widthPx, heightPx } = s;
    if (typeof widthPx !== 'number' || typeof heightPx !== 'number') return false;
    return ui.exceedsClipboard(widthPx, heightPx, maxBytes);
  }

  /**
   * After the page is restored: shows the toast, then tells it how the copy ended (when the
   * setting `copyOnDone` is off there is no copy: the toast says "Saved"). A copy that
   * the browser refused (or that has no API) goes to the service worker, which writes it with
   * its own clipboard permission. Never throws.
   * @param {Session} s
   * @param {unknown} summary
   * @param {FinishRun} run
   */
  async function presentResult(s, summary, run) {
    const ns = sharedNamespace();
    /** @type {{ handle: import('../../types/page-globals.js').ToastHandle | null }} */
    const toast = { handle: null };
    attempt(() => {
      toast.handle =
        ns.toast?.show({
          config: s.config,
          summary: /** @type {any} */ (summary),
          copy: run.copy ? 'pending' : run.tooLarge() ? 'toolarge' : 'skipped',
        }) ?? null;
    });
    if (!run.copy) return; // The toast says "Saved" or "Too tall to copy": nothing was copied.
    let done = await run.copied;
    if (!done && run.tooLarge()) {
      // The exact size came late: no fallback either (the worker would decode it as well).
      attempt(() => toast.handle?.setCopy('toolarge'));
      return;
    }
    if (!done) {
      const reply = await send(s, s.config.msg['PAGE_CLIPBOARD_FALLBACK'] ?? '', {
        sessionId: s.config.sessionId,
      });
      done = reply.ok && reply.data['copied'] === true;
    }
    attempt(() => toast.handle?.setCopy(done ? 'copied' : 'failed', done ? '' : run.reason()));
  }

  /**
   * Done: the clipboard write starts first (it needs the gesture), the service worker finishes the
   * capture, the page is restored and the overlay removed, and the toast shows the result. When
   * the service worker refuses, the session stays open (Done and Cancel stay available) with the
   * message shown.
   * @param {Session} s
   */
  async function finishSession(s) {
    if (s.seq === 0) {
      // Nothing was captured: there is nothing to finish. Say so and stay open, so the press
      // does not look like a success that left no trace.
      s.state = 'ready';
      publish(s, 'error', TEXT.nothingYet);
      return;
    }
    s.state = 'finishing';
    setBusy(s, true);
    s.finishingSince = Date.now();
    publish(s, 'info', s.settings.copyOnDone === false ? TEXT.finishingNoCopy : TEXT.finishing);
    // The clipboard write starts here, in the task of the key press or click (no await before it).
    // When Done came in during a step, it started then and waits behind the gate.
    const run = s.finishRun ?? beginFinish(s, null);
    s.finishRun = null;
    s.gate = null;
    const outcome = await run.finish;
    s.limitFinish = null;
    if (isClosed(s)) return;
    if (outcome.ok) {
      closeSession(s, false);
      fireAndForget(presentResult(s, outcome.summary, run));
      return;
    }
    s.state = 'ready';
    setBusy(s, false);
    publish(s, 'error', outcome.message);
  }

  /**
   * Done or Cancel. While a step runs it waits for the step to end (the page is not restored in
   * the middle of a scroll). Cancel is final: a pending Done becomes Cancel.
   * @param {Session} s
   * @param {'done' | 'cancel'} kind
   */
  async function requestEnd(s, kind) {
    switch (s.state) {
      case 'idle':
      case 'selecting':
        closeSession(s, false); // nothing was opened yet
        return;
      case 'ready':
        if (kind === 'cancel') closeSession(s, true);
        else await finishSession(s);
        return;
      case 'stepping':
      case 'auto':
        if (kind === 'cancel' || s.pendingEnd === null) s.pendingEnd = kind;
        if (kind === 'done' && s.seq > 0 && s.finishRun === null) {
          // The gesture is now: start the clipboard write, and hold page/finish back until the
          // step is over (settle() opens the gate).
          s.gate = makeGate();
          s.finishRun = beginFinish(s, s.gate);
        }
        publish(s, 'info', TEXT.stopping);
        return;
      case 'finishing':
        // Too late to cancel: the build and the save are under way in the offscreen document, and
        // the toast will report the result. The overlay disables Cancel and ignores Esc; this keeps
        // the same rule for any other caller. A save that hangs ends by itself (FINISH_TIMEOUT_MS),
        // and the session is then ready again.
        return;
      default:
        return; // 'closed' has nothing left to do
    }
  }

  /** @param {Session} s @param {OverlayCommand} cmd */
  async function onCommand(s, cmd) {
    if (isClosed(s)) return;
    if (cmd === 'cancel' || cmd === 'done') {
      await requestEnd(s, cmd);
      return;
    }
    if (cmd === 'auto' && s.state === 'auto') {
      s.autoStop = true; // toggle off: stops after the current step
      return;
    }
    if (s.state !== 'ready') return; // one step at a time: ignore while busy
    await drive(s, cmd);
  }

  /**
   * Back to area selection with an error message (the region was rejected or the service worker
   * refused the session).
   * @param {Session} s
   * @param {string} message
   */
  function returnToSelecting(s, message) {
    if (s.pendingEnd !== null) {
      closeSession(s, false); // Done or Cancel came in while the region was being opened
      return;
    }
    s.state = 'selecting';
    s.area = null;
    publish(s, 'error', message);
    try {
      s.overlay.beginSelect();
    } catch {
      closeSession(s, false);
    }
  }

  /**
   * Finds the scroll target under the region and clips the region to it and to the viewport.
   * @param {Session} s
   * @param {Rect} region
   * @returns {Area | null} Null when nothing is left of the region.
   */
  function pickArea(s, region) {
    const target = s.lib.findScrollTarget(region);
    const inTarget = s.lib.clipRect(region, target.box);
    const rect = inTarget && s.lib.clipRect(inTarget, viewportRect());
    if (!rect) return null;
    return {
      target,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      originalScrollTop: s.lib.getScrollTop(target),
      scanner: null,
    };
  }

  /**
   * The user selected a region: open the session, capture the initial frame.
   * @param {Session} s
   * @param {Rect} region
   */
  async function onRegion(s, region) {
    if (s.state !== 'selecting') return;
    s.state = 'stepping'; // busy: commands wait until the initial frame is done
    try {
      const area = pickArea(s, region);
      if (!area) {
        returnToSelecting(s, TEXT.outside);
        return;
      }
      const title = String(docTitle(document)).slice(0, MAX_TITLE_LENGTH);
      const reply = await send(s, s.config.msg['PAGE_SESSION_OPEN'] ?? '', {
        sessionId: s.config.sessionId,
        title,
      });
      if (isClosed(s)) {
        if (reply.ok) notifyCancel(s); // the page closed while the service worker opened it
        return;
      }
      if (!reply.ok) {
        returnToSelecting(s, reply.message);
        return;
      }
      s.sessionOpened = true;
      s.area = area;
      if (s.pendingEnd === null) {
        s.jar.set(area.target.el, 'scroll-behavior', 'auto');
        s.jar.set(docElement(document), 'scroll-behavior', 'auto');
        // An overlay scrollbar (macOS, Windows 11 with auto-hide) is drawn over the content and
        // would be in the crop, at a new height in every frame. No scrollbar, no thumb. The jar
        // puts it back when the session closes.
        s.jar.set(area.target.el, 'scrollbar-width', 'none');
        s.jar.set(docElement(document), 'scrollbar-width', 'none');
        s.overlay.showSession(area.rect);
        setBusy(s, true);
        publish(s, 'info', '');
        await captureFrame(s, area, 'initial');
      }
    } catch {
      if (isClosed(s)) return;
      if (!s.sessionOpened) {
        returnToSelecting(s, TEXT.generic);
        return;
      }
      publish(s, 'error', TEXT.generic);
    }
    await settle(s);
  }

  // -------------------------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------------------------

  /**
   * Returns the config only when this agent can use it.
   * @param {unknown} raw
   * @returns {PageConfig | null}
   */
  function readConfig(raw) {
    const c = /** @type {Partial<PageConfig> | null | undefined} */ (raw);
    if (!c || c.protocolVersion !== SUPPORTED_PROTOCOL) return null;
    const { sessionId, settings, msg, err, target } = c;
    if (typeof sessionId !== 'string' || sessionId === '') return null;
    if (!settings || !msg || !err || !target) return null;
    if (typeof target['SW'] !== 'string' || typeof err['TAB_NOT_VISIBLE'] !== 'string') return null;
    if (!REQUIRED_MSG.every((key) => typeof msg[key] === 'string')) return null;
    const { overlapCss, settleMs, maxHeightCss, hideOverlays } = settings;
    if (![overlapCss, settleMs, maxHeightCss].every((n) => Number.isFinite(n))) return null;
    if (typeof hideOverlays !== 'boolean') return null;
    return /** @type {PageConfig} */ (c);
  }

  /**
   * Starts a session: shows the selection overlay. Does nothing without a valid config (the
   * service worker sets globalThis.__spool.config before it calls this).
   */
  function start() {
    try {
      if (isActive()) return;
      const ns = sharedNamespace();
      // The command Alt+Shift+V opens the shelf with the last capture, not a capture.
      if (ns.config?.mode === 'shelf') {
        ns.shelf?.start();
        return;
      }
      const config = readConfig(ns.config);
      const lib = ns.lib;
      const overlayModule = ns.overlay;
      if (!config || !lib || !overlayModule) return;
      // A new capture closes the toast and the shelf of the earlier one.
      attempt(() => ns.toast?.dismiss());
      attempt(() => ns.shelf?.dismiss());
      // Each injection loads new instances of the toast and the shelf: they have no state for the
      // card of an earlier capture. The registry in the shared kit closes every card.
      attempt(() => ns.ui?.dismissCards());

      const jar = lib.createStyleJar();
      // The overlay needs its callbacks before the session exists: they call through `bridge`.
      const bridge = {
        /** @type {(rect: Rect) => void} */
        onRegion: noop,
        /** @type {(cmd: OverlayCommand) => void} */
        onCommand: noop,
      };
      const overlay = overlayModule.createOverlay({
        onRegion: (rect) => bridge.onRegion(rect),
        onCommand: (cmd) => bridge.onCommand(cmd),
        copyOnDone: config.settings.copyOnDone !== false,
      });
      /** @type {Session} */
      const s = {
        config,
        settings: config.settings,
        lib,
        overlay,
        jar,
        state: 'idle',
        area: null,
        sessionOpened: false,
        seq: 0,
        retry: 'initial',
        lastScrollTop: null,
        finishingSince: 0,
        limitFinish: null,
        minContentY: Infinity,
        maxContentY: -Infinity,
        lastStored: true,
        totals: { slices: 0, heightPx: 0, tiles: 0 },
        limitReached: false,
        endHit: false,
        pendingEnd: null,
        finishRun: null,
        gate: null,
        autoStop: false,
        level: 'info',
        message: '',
        // A script of the page can dispatch a fake pagehide: only the browser's own counts.
        pageHide: (event) => {
          if (event.isTrusted === true) closeSession(s, true);
        },
        watch: null,
      };
      bridge.onRegion = (rect) => fireAndForget(onRegion(s, rect));
      bridge.onCommand = (cmd) => fireAndForget(onCommand(s, cmd));
      current = s;
      try {
        addEventListener('pagehide', s.pageHide);
        startWatch(s);
        s.state = 'selecting';
        overlay.beginSelect();
      } catch {
        closeSession(s, false);
      }
    } catch {
      // Never throw into the page.
    }
  }

  /**
   * True while a session runs. When the extension context is invalid (the extension was
   * reloaded or removed), it closes the session, restores the page and returns false.
   * @returns {boolean}
   */
  function isActive() {
    try {
      const s = current;
      if (!s || isClosed(s)) return false;
      if (!contextValid()) {
        closeSession(s, false);
        return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  // No "already loaded" guard: this registers on every injection, so stale code is replaced.
  const ns = sharedNamespace();
  ns.agent = Object.freeze({ start, isActive });
})();
