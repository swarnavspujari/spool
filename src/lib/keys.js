// @ts-check
/**
 * How keys are written on screen: one place for every text that names a shortcut (the toast, the
 * shelf, the result page, the options page, the welcome page).
 *
 * `chrome.commands.getAll()` gives the key as the browser spells it. Windows and Linux give words
 * joined by "+" ("Alt+Shift+V", in the language of the browser). macOS gives glyphs with no "+"
 * ("⌃⇧V"). The code here accepts both on every system, so a browser that spells it the other way
 * still shows up as separate keycaps. On a Mac the words turn into the glyphs that a Mac user
 * knows (Alt is Option: ⌥).
 *
 * Pure: no `chrome.*`, no DOM. A page script cannot import a module, so the service worker makes
 * the labels with this file and gives them to the page in `PageConfig.keys`.
 */

/** @typedef {'windows' | 'mac' | 'linux'} Platform */
/**
 * @typedef {Object} KeyLabel
 * @property {string[]} parts  One entry for each keycap. Empty: the command has no key.
 * @property {string} text     The same keys in one piece: "Alt+Shift+V" or "⌃⇧V". Empty for no key.
 */

/**
 * @param {unknown} name  The platform string of the browser (`navigator.userAgentData.platform`
 *   or `navigator.platform`).
 * @returns {Platform}
 */
export function platformKind(name) {
  const text = typeof name === 'string' ? name : '';
  if (/mac|iphone|ipad/i.test(text)) return 'mac';
  if (/win/i.test(text)) return 'windows';
  return 'linux';
}

/** The glyphs of the modifier keys on a Mac, in the order that a Mac writes them. */
const MAC_MODIFIERS = '⌃⌥⇧⌘';

/** Words of a modifier key, and the glyph that a Mac shows for it. */
const MAC_GLYPH = Object.freeze({
  ctrl: '⌃',
  control: '⌃',
  macctrl: '⌃',
  alt: '⌥',
  option: '⌥',
  shift: '⇧',
  command: '⌘',
  cmd: '⌘',
});

/**
 * The keys of a shortcut text, one entry for each keycap.
 * "Alt+Shift+S" gives ["Alt", "Shift", "S"]. The glyph text "⌃⇧V" gives ["⌃", "⇧", "V"]. On a Mac the
 * words of a modifier become its glyph ("Alt+Shift+S" gives ["⌥", "⇧", "S"]). An empty or missing
 * shortcut gives [].
 * @param {unknown} shortcut
 * @param {Platform} [platform]  Default: a system that writes words.
 * @returns {string[]}
 */
export function shortcutParts(shortcut, platform = 'windows') {
  if (typeof shortcut !== 'string') return [];
  const text = shortcut.trim();
  if (text === '') return [];
  if (text.includes('+')) {
    return text
      .split('+')
      .map((part) => part.trim())
      .filter((part) => part !== '')
      .map((part) => {
        if (platform !== 'mac') return part;
        const glyph = /** @type {Record<string, string>} */ (MAC_GLYPH)[part.toLowerCase()];
        return glyph ?? part;
      });
  }
  // No "+": glyphs, written together. Leading modifier glyphs are one key each, the rest is the key.
  const chars = [...text];
  /** @type {string[]} */
  const parts = [];
  let i = 0;
  while (i < chars.length && MAC_MODIFIERS.includes(/** @type {string} */ (chars[i]))) {
    parts.push(/** @type {string} */ (chars[i]));
    i += 1;
  }
  const rest = chars.slice(i).join('').trim();
  if (rest !== '') parts.push(rest);
  return parts;
}

/**
 * The keys in one piece: "Alt+Shift+V", or "⌥⇧V" on a Mac.
 * @param {readonly string[]} parts
 * @param {Platform} [platform]
 * @returns {string}
 */
export function joinKeys(parts, platform = 'windows') {
  return parts.join(platform === 'mac' ? '' : '+');
}

/**
 * @param {unknown} shortcut  What `chrome.commands.getAll()` gives for a command. '' or missing:
 *   the command has no key.
 * @param {Platform} [platform]
 * @returns {KeyLabel}
 */
export function keyLabel(shortcut, platform = 'windows') {
  const parts = shortcutParts(shortcut, platform);
  return { parts, text: joinKeys(parts, platform) };
}

/**
 * The key of the manifest when the browser does not say (the API fails, or the command is not
 * listed). The same keys as `suggested_key` in manifest.json: `default` for Windows and Linux,
 * `mac` for a Mac.
 * @param {Platform} platform
 * @param {'start' | 'insert'} name
 * @returns {string}  In the spelling of the platform.
 */
export function defaultShortcut(platform, name) {
  if (platform === 'mac') return name === 'start' ? '⌃⇧S' : '⌃⇧V';
  return name === 'start' ? 'Alt+Shift+S' : 'Alt+Shift+V';
}

/**
 * The Paste key of the system: Ctrl+V, or ⌘V on a Mac.
 * @param {Platform} platform
 * @returns {KeyLabel}
 */
export function pasteLabel(platform) {
  const parts = platform === 'mac' ? ['⌘', 'V'] : ['Ctrl', 'V'];
  return { parts, text: joinKeys(parts, platform) };
}

/**
 * The key that pastes text only (and drops an image). A warning names it.
 * @param {Platform} platform
 * @returns {KeyLabel}
 */
export function plainPasteLabel(platform) {
  const parts = platform === 'mac' ? ['⌘', '⇧', 'V'] : ['Ctrl', 'Shift', 'V'];
  return { parts, text: joinKeys(parts, platform) };
}
