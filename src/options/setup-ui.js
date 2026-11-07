// @ts-check
/**
 * The welcome page and the reconnect card of the options page. The words and the choices are in
 * setup-model.js, the actions in save-actions.js. This file builds the DOM from them with
 * `createElement` and `textContent` (never markup) and moves the focus after each change.
 *
 * It does not touch the folder itself: the page gives it `host`, whose functions pick a folder,
 * reconnect it and use Downloads. Each of them starts the picker or the permission prompt in its
 * first statement, so the call in a click handler below must be the first thing that it does.
 */

import { defaultShortcut, keyLabel } from '../lib/keys.js';
import { downloadsPlace, targetPlace } from '../lib/labels.js';
import { TILES_FOLDER_NAME, captureBaseName, tileFileName } from '../lib/names.js';
import { COMMANDS } from '../shared/constants.js';
import {
  PICTURES_PLACE,
  describeKeeping,
  describeLayout,
  describeMoves,
  describeReconnect,
  describeSetup,
  platformKind,
  richParts,
} from './setup-model.js';

/** @typedef {import('./setup-model.js').SetupPhase} SetupPhase */
/** @typedef {import('./setup-model.js').SetupProblem} SetupProblem */
/** @typedef {import('./setup-model.js').ReconnectPhase} ReconnectPhase */
/** @typedef {import('./save-actions.js').PickOutcome} PickOutcome */
/** @typedef {import('./save-actions.js').ReconnectOutcome} ReconnectOutcome */
/** @typedef {import('../ui/folder-store.js').SaveTarget} SaveTarget */
/** @typedef {import('../ui/folder-store.js').FolderPermission} FolderPermission */

/**
 * What the page gives to the setup UI.
 * @typedef {Object} SetupHost
 * @property {() => SaveTarget | null} target        The stored folder, as the page last read it.
 * @property {() => FolderPermission} permission
 * @property {() => string} folderName               The Downloads folder name as typed now.
 * @property {(kind: 'pictures' | 'other') => Promise<PickOutcome>} pick
 *   Picks and stores a folder. Starts the picker before its first `await`.
 * @property {() => Promise<ReconnectOutcome>} reconnect
 *   Asks for access again. Starts the prompt before its first `await`.
 * @property {() => Promise<void>} useDownloads
 * @property {() => Promise<number>} reconnects      How many times the card brought it back.
 * @property {() => void} openSettings               Leaves the welcome page for the settings.
 */

/**
 * @template {HTMLElement} T
 * @param {string} id
 * @param {new () => T} type
 * @returns {T}
 */
function byId(id, type) {
  const node = document.getElementById(id);
  if (!(node instanceof type)) throw new Error(`Missing element: ${id}`);
  return node;
}

/**
 * Sets the text of an element. A part between `**` becomes `<strong>`.
 * @param {HTMLElement} node
 * @param {string} text
 */
function setRich(node, text) {
  node.replaceChildren(
    ...richParts(text).map((part) => {
      if (!part.strong) return document.createTextNode(part.text);
      const strong = document.createElement('strong');
      strong.textContent = part.text;
      return strong;
    }),
  );
}

/**
 * @param {string} tag
 * @param {string} className
 * @param {string} [text]
 * @returns {HTMLElement}
 */
function make(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

/**
 * @param {Array<{ id: string, label: string, tone: string, disabled: boolean }>} actions
 * @param {HTMLElement} host
 * @param {(id: string) => void} onClick
 * @returns {HTMLButtonElement[]}
 */
function renderActions(actions, host, onClick) {
  const buttons = actions.map((action) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sp-btn sp-btn-lg${
      action.tone === 'primary' ? ' sp-btn-primary' : action.tone === 'quiet' ? ' sp-btn-quiet' : ''
    }`;
    button.textContent = action.label;
    button.disabled = action.disabled;
    button.dataset['action'] = action.id;
    button.addEventListener('click', () => onClick(action.id));
    return button;
  });
  host.replaceChildren(...buttons);
  return buttons;
}

/** True when this browser can show a folder picker. */
function canPick() {
  return typeof (/** @type {any} */ (globalThis).showDirectoryPicker) === 'function';
}

/**
 * @param {SetupHost} host
 */
export function createSetupUi(host) {
  const platform = platformKind(
    /** @type {any} */ (globalThis.navigator)?.userAgentData?.platform ??
      globalThis.navigator?.platform ??
      '',
  );

  // ---- Welcome ---------------------------------------------------------------------------------
  const welcome = byId('welcome', HTMLElement);
  const heading = byId('welcome-heading', HTMLElement);
  const lead = byId('welcome-lead', HTMLElement);
  const message = byId('welcome-message', HTMLElement);
  const messageTitle = byId('welcome-message-title', HTMLElement);
  const messageText = byId('welcome-message-text', HTMLElement);
  const actionsHost = byId('welcome-actions', HTMLElement);
  const callout = byId('welcome-callout', HTMLElement);
  const calloutTitle = byId('welcome-callout-title', HTMLElement);
  const calloutText = byId('welcome-callout-text', HTMLElement);
  const next = byId('welcome-next', HTMLElement);
  const nextText = byId('welcome-next-text', HTMLElement);
  const keepingTitle = byId('keeping-title', HTMLElement);
  const keepingText = byId('keeping-text', HTMLElement);
  const openSettings = byId('open-settings', HTMLButtonElement);
  const layoutPlace = byId('layout-place', HTMLElement);
  const layoutTree = byId('layout-tree', HTMLElement);
  const movesList = byId('moves-list', HTMLElement);
  const movesWarning = byId('moves-warning', HTMLElement);

  /**
   * @type {{ phase: SetupPhase, intro: 'welcome' | 'setup', kind: 'pictures' | 'other',
   *   problem: SetupProblem | null, label: string, startKey: string, insertKey: string }}
   */
  const flow = {
    phase: 'pick',
    intro: 'welcome',
    kind: 'pictures',
    problem: null,
    label: '',
    startKey: '',
    insertKey: '',
  };

  /** The place that "Every capture gives you" shows. */
  function layoutLabel() {
    if (flow.phase === 'connected') return flow.label || PICTURES_PLACE;
    if (flow.phase === 'downloads' || flow.phase === 'no-picker') {
      return downloadsPlace(host.folderName());
    }
    return PICTURES_PLACE;
  }

  /** @param {{ focus?: boolean }} [options] */
  function renderWelcome({ focus = false } = {}) {
    const downloads = downloadsPlace(host.folderName());
    const view = describeSetup({
      phase: flow.phase,
      intro: flow.intro,
      kind: flow.kind,
      platform,
      label: flow.label,
      downloads,
      startKey: flow.startKey,
      problem: flow.problem,
    });
    heading.textContent = view.heading;
    setRich(lead, view.lead);

    message.hidden = view.message === null;
    if (view.message) {
      message.dataset['level'] = view.message.level;
      message.setAttribute('role', view.message.level === 'error' ? 'alert' : 'status');
      messageTitle.hidden = view.message.title === '';
      messageTitle.textContent = view.message.title;
      messageText.textContent = view.message.text;
    }

    callout.hidden = view.callout === null;
    if (view.callout) {
      calloutTitle.textContent = view.callout.title;
      setRich(calloutText, view.callout.text);
    }

    next.hidden = view.next.length === 0;
    nextText.replaceChildren(
      ...view.next.map((text) => {
        const p = make('p', '');
        setRich(p, text);
        return p;
      }),
    );

    const buttons = renderActions(view.actions, actionsHost, (id) => void onWelcomeAction(id));

    const keeping = describeKeeping();
    keepingTitle.textContent = keeping.title;
    keepingText.textContent = keeping.text;
    openSettings.textContent = keeping.link;

    const layout = describeLayout({
      place: layoutLabel(),
      base: captureBaseName(new Date(), ''),
      tilesFolder: TILES_FOLDER_NAME,
      tileName: (i) => tileFileName(i, 3),
    });
    layoutPlace.textContent = layout.place;
    layoutTree.replaceChildren(
      ...layout.lines.map((line) => {
        const li = make('li', `tree-line${line.strong ? ' sp-strong' : ''}`, line.text);
        li.style.setProperty('--depth', String(line.depth));
        return li;
      }),
      make('li', 'tree-note', layout.notes.full),
      make('li', 'tree-note', layout.notes.ai),
    );

    const moves = describeMoves({
      platform,
      startKey: flow.startKey,
      insertKey: flow.insertKey,
    });
    movesList.replaceChildren(
      ...moves.rows.flatMap((row) => [
        make('dt', '', row.label),
        make('dd', 'sp-strong', row.keys),
      ]),
    );
    movesWarning.textContent = moves.warning;

    if (focus) {
      const target = buttons.find((b) => !b.disabled);
      (target ?? heading).focus();
    }
  }

  /** @param {PickOutcome} outcome */
  function applyPick(outcome) {
    flow.problem = null;
    if (outcome.status === 'saved') {
      flow.phase = 'connected';
      flow.label = targetPlace(outcome.handle.name, outcome.subPath);
    } else if (outcome.status === 'no-picker') {
      flow.phase = 'no-picker';
    } else {
      flow.phase = 'pick';
      flow.problem = outcome.status;
    }
  }

  /** @param {string} id */
  async function onWelcomeAction(id) {
    if (id === 'pictures' || id === 'other') {
      // The picker needs this click: start it before anything is awaited.
      const picking = host.pick(id);
      flow.kind = id;
      flow.phase = 'waiting';
      renderWelcome();
      applyPick(await picking);
      renderWelcome({ focus: true });
    } else if (id === 'downloads') {
      await host.useDownloads();
      flow.phase = 'downloads';
      flow.problem = null;
      renderWelcome({ focus: true });
    } else if (id === 'again' || id === 'change') {
      flow.phase = 'pick';
      flow.problem = null;
      renderWelcome({ focus: true });
    }
  }

  /** Reads the keys of the two commands, for the lead and the list of moves. */
  async function readKeys() {
    try {
      const commands = await chrome.commands.getAll();
      const keyOf = (/** @type {string} */ name) =>
        commands.find((c) => c.name === name)?.shortcut ?? '';
      // Written for the system: a Mac gets "⌃⇧S", a PC "Alt+Shift+S".
      flow.startKey = keyLabel(keyOf(COMMANDS.START), platform).text;
      flow.insertKey = keyLabel(keyOf(COMMANDS.INSERT), platform).text;
    } catch {
      flow.startKey = keyLabel(defaultShortcut(platform, 'start'), platform).text;
      flow.insertKey = keyLabel(defaultShortcut(platform, 'insert'), platform).text;
    }
  }

  openSettings.addEventListener('click', () => host.openSettings());

  // ---- Reconnect card --------------------------------------------------------------------------
  const card = byId('reconnect', HTMLElement);
  const cardHeading = byId('reconnect-heading', HTMLElement);
  const cardLead = byId('reconnect-lead', HTMLElement);
  const cardActions = byId('reconnect-actions', HTMLElement);
  const cardTip = byId('reconnect-tip', HTMLElement);

  /** @type {{ phase: ReconnectPhase, reconnects: number, label: string | null }} */
  const fix = { phase: 'idle', reconnects: 0, label: null };
  /** True once the card was asked for. A card that was not asked for stays hidden. */
  let active = false;

  function targetLabel() {
    const target = host.target();
    return target === null ? '' : targetPlace(target.handle.name, target.subPath);
  }

  /** @param {{ focus?: boolean }} [options] */
  function renderCard({ focus = false } = {}) {
    const view = describeReconnect({
      phase: fix.phase,
      label: fix.label ?? targetLabel(),
      downloads: downloadsPlace(host.folderName()),
      reconnects: fix.reconnects,
    });
    cardHeading.textContent = view.heading;
    setRich(cardLead, view.lead);
    cardTip.hidden = view.tip === '';
    setRich(cardTip, view.tip);
    const buttons = renderActions(view.actions, cardActions, (id) => void onCardAction(id));
    if (focus) {
      const target = buttons.find((b) => !b.disabled);
      (target ?? cardHeading).focus();
    }
  }

  /** @param {string} id */
  async function onCardAction(id) {
    const target = host.target();
    if (id === 'reconnect' && target !== null) {
      // The permission prompt needs this click: start it before anything is awaited.
      const asking = host.reconnect();
      fix.phase = 'waiting';
      renderCard();
      const outcome = await asking;
      if (outcome === 'granted') {
        fix.phase = 'done';
        fix.reconnects += 1;
      } else if (outcome === 'missing') {
        fix.phase = 'missing';
      } else {
        fix.phase = 'declined';
      }
      fix.label = null;
      renderCard({ focus: true });
    } else if (id === 'pictures') {
      const picking = host.pick('pictures');
      fix.phase = 'waiting';
      renderCard();
      const outcome = await picking;
      fix.phase = outcome.status === 'saved' ? 'done' : 'missing';
      if (outcome.status === 'saved') {
        fix.reconnects = 0;
        fix.label = targetPlace(outcome.handle.name, outcome.subPath);
      }
      renderCard({ focus: true });
    } else if (id === 'downloads') {
      await host.useDownloads();
      card.hidden = true;
    }
  }

  return {
    /**
     * Shows the welcome page (options.html#welcome, or #setup for the toast).
     * @param {'welcome' | 'setup'} intro
     */
    async showWelcome(intro) {
      flow.intro = intro;
      flow.problem = null;
      flow.kind = 'pictures';
      const target = host.target();
      if (!canPick()) flow.phase = 'no-picker';
      else if (target !== null && host.permission() === 'granted') {
        flow.phase = 'connected';
        flow.label = targetPlace(target.handle.name, target.subPath);
      } else flow.phase = 'pick';
      welcome.hidden = false;
      renderWelcome();
      await readKeys();
      renderWelcome();
    },

    hideWelcome() {
      welcome.hidden = true;
    },

    /**
     * Shows the reconnect card for the stored folder (options.html#reconnect), and moves the
     * focus to its main button.
     */
    async showCard() {
      const target = host.target();
      if (target === null) {
        card.hidden = true;
        return;
      }
      active = true;
      fix.reconnects = await host.reconnects();
      const permission = host.permission();
      fix.phase = permission === 'granted' ? 'done' : permission === 'denied' ? 'missing' : 'idle';
      fix.label = null;
      card.hidden = false;
      renderCard({ focus: true });
    },

    /** Draws the card again after the page read the folder again. */
    refreshCard() {
      if (!active) return;
      if (host.target() === null) {
        card.hidden = true;
        return;
      }
      if (fix.phase !== 'waiting' && host.permission() === 'granted') fix.phase = 'done';
      card.hidden = false;
      renderCard();
    },

  };
}
