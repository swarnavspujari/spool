// @ts-check
/**
 * Options page. Builds the form from the field metadata, loads and saves the settings, and
 * shows the two shortcuts (start a capture, insert the last capture). The rules are in
 * form-model.js and src/shared/settings.js.
 * The address picks the view: #welcome (opened once on install) and #setup (the toast) show the
 * welcome page, #reconnect shows the settings with the reconnect card, #save scrolls to the Save
 * location group. The words of the welcome page and the card are in setup-model.js, their DOM in
 * setup-ui.js, and the folder actions in save-actions.js.
 * The page builds all DOM with createElement and textContent.
 */

import { platformKind, shortcutParts } from '../lib/keys.js';
import { downloadsPlace, targetPlace } from '../lib/labels.js';
import { COMMANDS, WELCOME_HASH } from '../shared/constants.js';
import { DEFAULT_SETTINGS, loadSettings, saveSettings } from '../shared/settings.js';
import { folderExists, folderPermission, getSaveTarget } from '../ui/folder-store.js';
import {
  FIELDS,
  GROUPS,
  describeAdjustments,
  describeSaveFolder,
  fieldHint,
  findAdjustments,
  formToSettings,
  numberOptions,
  settingsToForm,
  settingsWarnings,
} from './form-model.js';
import {
  chooseFolder,
  readReconnects,
  reconnectFolder,
  useDownloads,
  writeReconnects,
} from './save-actions.js';
import { createSetupUi } from './setup-ui.js';

/** @typedef {import('./form-model.js').FieldMeta} FieldMeta */
/** @typedef {import('./form-model.js').FormRecord} FormRecord */
/** @typedef {'info' | 'ok' | 'warn' | 'error'} StatusLevel */

/**
 * One control of the form, whatever its kind (list, switch, cards, text).
 * @typedef {Object} Control
 * @property {() => string | boolean} read
 * @property {(value: string | boolean) => void} write
 */

/**
 * The two commands of manifest.json, with the elements of their rows in options.html. The key of
 * a command is the key that the browser has now (the user can change it on its shortcuts page).
 */
const SHORTCUT_ROWS = Object.freeze([
  Object.freeze({
    command: COMMANDS.START,
    valueId: 'shortcut-start',
    buttonId: 'change-shortcut-start',
  }),
  Object.freeze({
    command: COMMANDS.INSERT,
    valueId: 'shortcut-insert',
    buttonId: 'change-shortcut-insert',
  }),
]);
/** Chromium browsers map this address to their own scheme (brave://, comet://). */
/** The system of the browser: the keys are written for it (a Mac gets glyphs). */
const PLATFORM = platformKind(
  /** @type {any} */ (globalThis.navigator)?.userAgentData?.platform ?? globalThis.navigator?.platform,
);

const SHORTCUTS_URL = 'chrome://extensions/shortcuts';

const TEXT = Object.freeze({
  idle: 'Changes apply to your next capture.',
  unsaved: 'Unsaved changes. They apply to your next capture.',
});

/**
 * Finds an element that options.html must contain.
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
 * Creates an element. Children can be nodes or text. Text never becomes markup.
 * @template {keyof HTMLElementTagNameMap} K
 * @param {K} tag
 * @param {Record<string, string>} attrs
 * @param {...(Node | string)} children
 * @returns {HTMLElementTagNameMap[K]}
 */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  node.append(...children);
  return node;
}

/**
 * An icon from src/ui/base.css.
 * @param {'folder'} name
 * @returns {HTMLSpanElement}
 */
function icon(name) {
  return el('span', { class: `sp-icon sp-icon-${name}`, 'aria-hidden': 'true' });
}

const form = byId('settings-form', HTMLFormElement);
const fieldsHost = byId('fields', HTMLElement);
const saveButton = byId('save-settings', HTMLButtonElement);
const discardButton = byId('discard', HTMLButtonElement);
const resetButton = byId('reset', HTMLButtonElement);
const statusLine = byId('status', HTMLElement);
const shortcutRows = SHORTCUT_ROWS.map((row) => ({
  command: row.command,
  value: byId(row.valueId, HTMLElement),
  button: byId(row.buttonId, HTMLButtonElement),
}));
const versionLine = byId('version', HTMLElement);

/** @type {Map<string, Control>} */
const controls = new Map();

/** The form as it was last loaded or saved (JSON of readForm()). Differences are unsaved. */
let baseline = '';
/** True while the status line shows the "unsaved changes" text (not a result message). */
let showingUnsaved = false;
let busy = false;

// ---------------------------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------------------------

/**
 * Row with the label and a help line on the left and a control on the right.
 * @param {FieldMeta} field
 * @param {Node} label  The label element (or any element) with the name of the setting.
 * @param {...Node} controlNodes
 * @returns {HTMLElement}
 */
function createRow(field, label, ...controlNodes) {
  return el(
    'div',
    { class: 'row' },
    el(
      'div',
      { class: 'row-text' },
      label,
      el('div', { id: `help-${field.key}`, class: 'row-help' }, field.help),
    ),
    el('div', { class: 'row-control' }, ...controlNodes),
  );
}

/**
 * A number: a list of presets (and the saved value when it is not a preset).
 * @param {import('./form-model.js').NumberField} field
 * @returns {HTMLElement}
 */
function createNumberRow(field) {
  const id = `field-${field.key}`;
  const select = el('select', {
    id,
    class: 'select',
    'aria-describedby': `help-${field.key}`,
    title: fieldHint(field),
  });
  /** @param {unknown} current */
  const fill = (current) => {
    select.replaceChildren(
      ...numberOptions(field, current).map((o) => el('option', { value: o.value }, o.label)),
    );
  };
  fill(field.defaultValue);
  controls.set(field.key, {
    read: () => select.value,
    write: (value) => {
      fill(value);
      select.value = String(value);
    },
  });
  return createRow(field, el('label', { for: id }, field.label), select);
}

/**
 * @param {import('./form-model.js').BooleanField} field
 * @returns {HTMLElement}
 */
function createSwitchRow(field) {
  const id = `field-${field.key}`;
  const input = el('input', {
    id,
    type: 'checkbox',
    role: 'switch',
    class: 'switch',
    'aria-describedby': `help-${field.key}`,
    title: fieldHint(field),
  });
  const state = el('span', { class: 'switch-state', 'aria-hidden': 'true' }, 'Off');
  const sync = () => {
    state.textContent = input.checked ? 'On' : 'Off';
  };
  input.addEventListener('change', sync);
  controls.set(field.key, {
    read: () => input.checked,
    write: (value) => {
      input.checked = value === true;
      sync();
    },
  });
  return createRow(field, el('label', { for: id }, field.label), state, input);
}

/**
 * A choice with a card for each option (the tile size).
 * @param {import('./form-model.js').ChoiceField} field
 * @returns {HTMLElement}
 */
function createCardsRow(field) {
  const name = `field-${field.key}`;
  const radios = field.options.map((option) =>
    el('input', { type: 'radio', name, value: option.value }),
  );
  const cards = field.options.map((option, i) =>
    el(
      'label',
      { class: 'card-option' },
      radios[i] ?? '',
      el(
        'span',
        {},
        el(
          'span',
          { class: 'card-title' },
          option.label,
          option.aside ? el('span', { class: 'card-aside' }, ` (${option.aside})`) : '',
        ),
        option.detail ? el('span', { class: 'card-detail' }, option.detail) : '',
      ),
    ),
  );
  controls.set(field.key, {
    read: () => radios.find((r) => r.checked)?.value ?? '',
    write: (value) => {
      for (const radio of radios) radio.checked = radio.value === String(value);
    },
  });
  return el(
    'fieldset',
    { class: 'row row-fieldset', 'aria-describedby': `help-${field.key}` },
    el(
      'legend',
      {},
      el('span', { class: 'row-label' }, field.label),
      el('div', { id: `help-${field.key}`, class: 'row-help' }, field.help),
    ),
    el('div', { class: 'cards' }, ...cards),
  );
}

/**
 * The name of the folder that Spool makes in Downloads. The row shows the path as it is typed.
 * @param {import('./form-model.js').TextField} field
 * @returns {HTMLElement}
 */
function createFolderNameRow(field) {
  const id = `field-${field.key}`;
  const path = el('span', {}, '');
  const input = el('input', {
    id,
    type: 'text',
    class: 'text-input',
    maxlength: String(field.maxLength),
    placeholder: field.defaultValue,
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-describedby': `help-${field.key}`,
    title: fieldHint(field),
  });
  const sync = () => {
    path.textContent = downloadsPlace(input.value.trim() || field.defaultValue);
    // The help of the chosen folder names this folder too.
    if (folderUi['title']) renderSaveFolder();
  };
  input.addEventListener('input', sync);
  controls.set(field.key, {
    read: () => input.value,
    write: (value) => {
      input.value = String(value);
      sync();
    },
  });
  const title = el('div', { class: 'row-title' }, icon('folder'), path);
  return el(
    'div',
    { class: 'row' },
    el(
      'div',
      { class: 'row-text' },
      title,
      el('div', { id: `help-${field.key}`, class: 'row-help' }, field.help),
    ),
    el(
      'div',
      { class: 'row-control' },
      el('label', { class: 'sp-visually-hidden', for: id }, field.label),
      input,
    ),
  );
}

// ---------------------------------------------------------------------------------------------
// Save folder (not a setting of chrome.storage: the handle lives in IndexedDB, see folder-store.js)
// ---------------------------------------------------------------------------------------------

/**
 * The chosen folder and its permission state, as the page last read them.
 * @type {{ target: import('../ui/folder-store.js').SaveTarget | null,
 *   permission: 'granted' | 'prompt' | 'denied' }}
 */
const saveFolder = { target: null, permission: 'prompt' };

/** Elements of the folder row. Set by createFolderRow(). @type {Record<string, HTMLElement>} */
const folderUi = {};

/** @returns {string} The name of the Downloads folder as it is typed now. */
function currentFolderName() {
  const value = controls.get('folderName')?.read();
  return typeof value === 'string' && value.trim() !== ''
    ? value.trim()
    : DEFAULT_SETTINGS.folderName;
}

/** @returns {string | null} The place of the chosen folder, "Pictures › Screenshots". */
function currentPlace() {
  const target = saveFolder.target;
  return target === null ? null : targetPlace(String(target.handle.name ?? ''), target.subPath);
}

/** A browser that has no folder picker cannot choose a folder: the buttons stay out. */
function canPickFolder() {
  return typeof (/** @type {any} */ (globalThis).showDirectoryPicker) === 'function';
}

/** Shows the folder, its state and the buttons that fit the state. */
function renderSaveFolder() {
  const view = describeSaveFolder({
    label: currentPlace(),
    permission: saveFolder.permission,
    folderName: currentFolderName(),
    subPath: saveFolder.target?.subPath ?? [],
  });
  const { title, help, note, primary, change, other, clear } = folderUi;
  if (!title || !help || !note || !primary || !change || !other || !clear) return;
  title.textContent = view.title;
  title.dataset['state'] = view.state;
  help.textContent = view.help;
  note.textContent = view.note;
  note.hidden = view.note === '';
  primary.hidden = view.primary === null || !canPickFolder();
  if (view.primary) {
    primary.textContent = view.primary.label;
    primary.dataset['action'] = view.primary.id;
  }
  change.hidden = !view.showChange || !canPickFolder();
  other.hidden = !view.showOther || !canPickFolder();
  clear.hidden = !view.showClear;
}

/**
 * The permission of a folder, as the page shows it. A folder that is gone counts as 'denied'
 * ("Folder not found"), also when the browser still reports 'granted' for its path.
 * @param {FileSystemDirectoryHandle} handle
 * @returns {Promise<'granted' | 'prompt' | 'denied'>}
 */
async function readPermission(handle) {
  const permission = await folderPermission(handle);
  return permission === 'granted' && !(await folderExists(handle)) ? 'denied' : permission;
}

/** Reads the folder and its permission again (the user can change them in another tab). */
async function refreshSaveFolder() {
  const target = await getSaveTarget();
  saveFolder.target = target;
  saveFolder.permission = target ? await readPermission(target.handle) : 'prompt';
  renderSaveFolder();
  setupUi.refreshCard();
}

/** @param {boolean} value */
function setFolderBusy(value) {
  for (const key of ['primary', 'change', 'other', 'clear']) {
    const button = folderUi[key];
    if (button instanceof HTMLButtonElement) button.disabled = value;
  }
}

/**
 * Picks a folder and keeps it. The picker needs the click that called this: nothing is awaited
 * before `chooseFolder`, which opens the picker in its first statement.
 * @param {'pictures' | 'other'} kind
 * @returns {Promise<import('./save-actions.js').PickOutcome>}
 */
async function pickFolder(kind) {
  const picking = chooseFolder(kind);
  setFolderBusy(true);
  try {
    const outcome = await picking;
    if (outcome.status === 'saved') {
      saveFolder.target = { handle: outcome.handle, subPath: outcome.subPath };
      saveFolder.permission = await readPermission(outcome.handle);
      await writeReconnects(0);
      renderSaveFolder();
      setupUi.refreshCard();
    }
    return outcome;
  } finally {
    setFolderBusy(false);
  }
}

/**
 * Asks for access to the stored folder again. The permission prompt needs the click that called
 * this: `reconnectFolder` asks in its first statement.
 * @returns {Promise<import('./save-actions.js').ReconnectOutcome>}
 */
async function reconnect() {
  const target = saveFolder.target;
  if (target === null) return 'failed';
  const asking = reconnectFolder(target);
  setFolderBusy(true);
  try {
    const outcome = await asking;
    saveFolder.permission = await readPermission(target.handle);
    if (outcome === 'granted') await writeReconnects((await readReconnects()) + 1);
    renderSaveFolder();
    return outcome;
  } finally {
    setFolderBusy(false);
  }
}

/** Forgets the folder: Spool saves to Downloads, and the question on the toast ends. */
async function dropFolder() {
  setFolderBusy(true);
  try {
    await useDownloads();
    saveFolder.target = null;
    saveFolder.permission = 'prompt';
    renderSaveFolder();
    setupUi.refreshCard();
  } finally {
    setFolderBusy(false);
  }
}

/** Status text for what a pick gave. @param {import('./save-actions.js').PickOutcome} outcome */
function reportPick(outcome) {
  if (outcome.status === 'saved') {
    setStatus(`Save folder set to ${currentPlace() || 'the chosen folder'}.`, 'ok');
  } else if (outcome.status === 'blocked') {
    setStatus('Your browser blocks that folder. Choose Pictures or a folder inside it.', 'error');
  } else if (outcome.status === 'failed') {
    setStatus('Spool could not use that folder. Try again.', 'error');
  } else if (outcome.status === 'no-picker') {
    setStatus("This browser can't pick folders. Spool saves to Downloads.", 'warn');
  }
}

/** Click on the main button of the row: pick Pictures, reconnect, or pick again. */
async function onPrimary() {
  const action = folderUi['primary']?.dataset['action'];
  if (action === 'reconnect') {
    const outcome = await reconnect();
    if (outcome === 'granted') {
      setStatus('Reconnected. Spool can save to the folder.', 'ok');
    } else if (outcome === 'missing') {
      setStatus('That folder is gone. Pick it again.', 'error');
      await setupUi.showCard();
    } else {
      setStatus('Not reconnected yet. Spool saves to Downloads until you allow it.', 'warn');
    }
    return;
  }
  reportPick(await pickFolder(action === 'other' ? 'other' : 'pictures'));
}

/** @returns {HTMLElement} The row with the chosen folder and its buttons. */
function createFolderRow() {
  const title = el('span', { id: 'folder-name', class: 'row-title-text' });
  const help = el('div', { id: 'folder-help', class: 'row-help' });
  const note = el('div', { id: 'folder-note', class: 'row-help' });
  const primary = el('button', {
    type: 'button',
    id: 'folder-primary',
    class: 'sp-btn sp-btn-primary',
  });
  const change = el(
    'button',
    { type: 'button', id: 'change-folder', class: 'sp-btn' },
    'Change folder',
  );
  const other = el(
    'button',
    { type: 'button', id: 'other-folder', class: 'sp-btn' },
    'Choose another folder',
  );
  const clear = el(
    'button',
    { type: 'button', id: 'clear-folder', class: 'sp-btn' },
    'Use Downloads instead',
  );
  Object.assign(folderUi, { title, help, note, primary, change, other, clear });
  primary.setAttribute('aria-describedby', 'folder-name folder-help');
  change.setAttribute('aria-describedby', 'folder-name');
  primary.addEventListener('click', () => void onPrimary());
  change.addEventListener('click', () => void pickFolder('other').then(reportPick));
  other.addEventListener('click', () => void pickFolder('other').then(reportPick));
  clear.addEventListener('click', () => {
    dropFolder().then(
      () => setStatus('Spool saves to Downloads.', 'ok'),
      () => setStatus('Spool could not clear the folder. Try again.', 'error'),
    );
  });
  return el(
    'div',
    { class: 'row' },
    el(
      'div',
      { class: 'row-text' },
      el('div', { class: 'row-title' }, icon('folder'), title),
      help,
      note,
    ),
    el('div', { class: 'row-control row-buttons' }, primary, change, other, clear),
  );
}

/**
 * @param {FieldMeta} field
 * @returns {HTMLElement}
 */
function createField(field) {
  switch (field.type) {
    case 'number':
      return createNumberRow(field);
    case 'boolean':
      return createSwitchRow(field);
    case 'choice':
      return createCardsRow(field);
    case 'text':
      return createFolderNameRow(field);
  }
}

function renderFields() {
  for (const group of GROUPS) {
    const rows = el('div', { class: 'group-rows' });
    if (group.id === 'location') rows.append(createFolderRow());
    for (const field of FIELDS) {
      if (field.group === group.id) rows.append(createField(field));
    }
    fieldsHost.append(
      el(
        'section',
        {
          class: 'group',
          // The page agent opens options.html#save (the Save location group).
          id: group.id === 'location' ? 'save' : `group-${group.id}-section`,
          'aria-labelledby': `group-${group.id}`,
        },
        el('h2', { id: `group-${group.id}`, class: 'group-title' }, group.title),
        rows,
      ),
    );
  }
}

/** @returns {FormRecord} */
function readForm() {
  /** @type {Record<string, string | boolean>} */
  const record = {};
  for (const field of FIELDS) {
    const control = controls.get(field.key);
    if (control) record[field.key] = control.read();
  }
  return record;
}

/** @param {FormRecord} record */
function writeForm(record) {
  for (const field of FIELDS) {
    const control = controls.get(field.key);
    const value = record[field.key];
    if (control && value !== undefined) control.write(value);
  }
}

// ---------------------------------------------------------------------------------------------
// Save bar
// ---------------------------------------------------------------------------------------------

/**
 * @param {string} text
 * @param {StatusLevel} [level]
 */
function setStatus(text, level = 'info') {
  statusLine.dataset.level = level;
  statusLine.textContent = text;
}

/** @returns {boolean} */
function isDirty() {
  return JSON.stringify(readForm()) !== baseline;
}

/** Marks the form as saved: the values now in the form are the baseline. */
function markClean() {
  baseline = JSON.stringify(readForm());
  showingUnsaved = false;
  discardButton.disabled = true;
}

/** Updates the Discard button and the text of the save bar after an edit. */
function refreshBar() {
  const dirty = isDirty();
  discardButton.disabled = !dirty || busy;
  if (dirty) {
    showingUnsaved = true;
    setStatus(TEXT.unsaved);
  } else if (showingUnsaved) {
    showingUnsaved = false;
    setStatus(TEXT.idle);
  }
}

/** @param {boolean} value */
function setBusy(value) {
  busy = value;
  saveButton.disabled = value;
  resetButton.disabled = value;
  discardButton.disabled = value || !isDirty();
  form.setAttribute('aria-busy', String(value));
}

// ---------------------------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------------------------

/** @param {SubmitEvent} event */
async function onSubmit(event) {
  event.preventDefault();
  const entered = readForm();
  setBusy(true);
  try {
    const saved = await saveSettings(formToSettings(entered));
    writeForm(settingsToForm(saved));
    markClean();
    const parts = ['Settings saved.'];
    const changes = describeAdjustments(findAdjustments(entered, saved));
    if (changes) parts.push(changes);
    const warnings = settingsWarnings(saved);
    parts.push(...warnings);
    if (!changes && warnings.length === 0) parts.push(TEXT.idle);
    setStatus(parts.join(' '), changes || warnings.length > 0 ? 'warn' : 'ok');
  } catch {
    setStatus('Spool could not save the settings. Try again.', 'error');
  } finally {
    setBusy(false);
  }
}

function onDiscard() {
  writeForm(JSON.parse(baseline));
  showingUnsaved = false;
  discardButton.disabled = true;
  setStatus(TEXT.idle);
}

async function onReset() {
  setBusy(true);
  try {
    const saved = await saveSettings({ ...DEFAULT_SETTINGS });
    writeForm(settingsToForm(saved));
    markClean();
    setStatus('Defaults restored and saved.', 'ok');
  } catch {
    setStatus('Spool could not restore the defaults. Try again.', 'error');
  } finally {
    setBusy(false);
  }
}

// ---------------------------------------------------------------------------------------------
// Shortcut
// ---------------------------------------------------------------------------------------------

/**
 * @param {HTMLElement} host
 * @param {string[]} parts  The key names. Empty: the command has no key.
 */
function renderShortcut(host, parts) {
  host.replaceChildren();
  if (parts.length === 0) {
    host.textContent = 'Not set';
    return;
  }
  parts.forEach((part, i) => {
    if (i > 0 && PLATFORM !== 'mac') host.append('+');
    host.append(el('kbd', { class: 'sp-kbd' }, part));
  });
}

/** Reads the keys of both commands from the browser and shows them. */
async function refreshShortcut() {
  try {
    const commands = await chrome.commands.getAll();
    for (const row of shortcutRows) {
      const command = commands.find((c) => c.name === row.command);
      renderShortcut(row.value, shortcutParts(command?.shortcut, PLATFORM));
    }
  } catch {
    for (const row of shortcutRows) row.value.textContent = 'Unknown';
  }
}

async function onChangeShortcut() {
  try {
    await chrome.tabs.create({ url: SHORTCUTS_URL });
  } catch {
    setStatus(
      'Spool could not open the shortcuts page. Open the extensions page of your browser, ' +
        'then choose Keyboard shortcuts.',
      'error',
    );
  }
}

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

/** How long the group that the URL hash points to stays highlighted. */
const TARGET_MS = 1600;

const welcomeView = byId('welcome', HTMLElement);
const settingsView = byId('settings-view', HTMLElement);

/** The welcome page and the reconnect card. They use the same actions as the Save location row. */
const setupUi = createSetupUi({
  target: () => saveFolder.target,
  permission: () => saveFolder.permission,
  folderName: currentFolderName,
  pick: pickFolder,
  reconnect,
  useDownloads: async () => {
    await dropFolder();
  },
  reconnects: () => readReconnects(),
  openSettings: () => {
    location.hash = '';
  },
});

/** options.html#save: scroll to the Save location group and show it for a moment. */
function showTarget() {
  const section = document.getElementById('save');
  if (!section) return;
  section.scrollIntoView({ block: 'center' });
  section.classList.add('is-target');
  setTimeout(() => section.classList.remove('is-target'), TARGET_MS);
}

/**
 * Shows the page that the address asks for. `#welcome` (opens once on install) and `#setup` (the
 * toast: "Set up") show the welcome page. `#reconnect` (the toast: "Reconnect") shows the settings
 * with the reconnect card on top. `#save` scrolls to the Save location group.
 */
async function route() {
  const hash = location.hash;
  const welcome = hash === `#${WELCOME_HASH}` || hash === '#setup';
  welcomeView.hidden = !welcome;
  settingsView.hidden = welcome;
  document.body.dataset['view'] = welcome ? 'welcome' : 'settings';
  document.title = welcome ? 'Welcome to Spool' : 'Spool settings';
  if (welcome) {
    await setupUi.showWelcome(hash === '#setup' ? 'setup' : 'welcome');
    return;
  }
  setupUi.hideWelcome();
  if (hash === '#reconnect') await setupUi.showCard();
  else if (hash === '#save') showTarget();
}

async function init() {
  renderFields();
  versionLine.textContent = `Spool version ${chrome.runtime.getManifest().version}`;
  setStatus(TEXT.idle);

  form.addEventListener('submit', (event) => void onSubmit(event));
  // Edits come from lists, switches, cards and text, so listen on the form.
  form.addEventListener('input', refreshBar);
  form.addEventListener('change', refreshBar);
  discardButton.addEventListener('click', onDiscard);
  resetButton.addEventListener('click', () => void onReset());
  for (const row of shortcutRows) {
    row.button.addEventListener('click', () => void onChangeShortcut());
  }
  // The user can change the shortcut in another tab. Read it again when this tab is back.
  window.addEventListener('focus', () => {
    void refreshShortcut();
    void refreshSaveFolder();
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) {
      void refreshShortcut();
      void refreshSaveFolder();
    }
  });
  window.addEventListener('hashchange', () => void route());

  try {
    writeForm(settingsToForm(await loadSettings()));
  } catch {
    writeForm(settingsToForm(DEFAULT_SETTINGS));
    setStatus('Spool could not read the saved settings. The form shows the defaults.', 'error');
  }
  markClean();
  form.setAttribute('aria-busy', 'false');
  await Promise.all([refreshShortcut(), refreshSaveFolder()]);
  await route();
}

void init();
