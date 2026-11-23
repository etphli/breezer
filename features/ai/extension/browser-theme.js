// AI theme proposals: a name, a native seed colour and colour mode, an
// optional background image the person attached (PNG, JPEG or WebP data URL),
// and optional background artwork (graphics-only HTML/SVG with CSS animation)
// layered over that image. The panel shows each proposal as a card with a live
// preview and Apply / Restore controls; the new tab paints the applied image
// and artwork behind its content.
//
// The native seed and mode go through chrome.breezerPrivate.setAppearance and
// the shared appearance.rev signal, exactly like Settings. Artwork never runs
// in an extension origin. It is:
//   1. reduced to an allowlist of SVG and layout elements, presentation
//      attributes and CSS with no text, links, images, fonts or remote URLs;
//   2. rendered only inside a sandbox="" iframe (opaque origin, no scripts,
//      forms, popups or navigation) that is inert and ignores the pointer;
//   3. served with a fixed CSP that forbids every fetch, placed before the
//      artwork so nothing in it can loosen it.
// The model output is untrusted; stored artwork is re-sanitized on every read.
// The image is never model output: the panel resolves the model's attachment
// index to the person's own attachment. It is still re-validated as a raster
// data: URL (never a URL or SVG) on every read and shown in a plain <img>.
import { ARTWORK_KEY, THEME_LOOKS, THEME_REFRESH_MESSAGE, activeLook } from './panel-theme.js';
import { localStorageChanges } from './storage-events.js';
import { APPEARANCE_REV_KEY, normalizeAppearance, validateAppearancePatch } from './workspace-store.js';

export { ARTWORK_KEY, THEME_LOOKS };
export const PREVIOUS_LOOK_KEY = 'theme.previous.v1';
// What Cancel returns to after a Breezer look: the browser theme, artwork and
// saved previous look from just before the first look was chosen.
export const LOOK_UNDO_KEY = 'theme.lookUndo.v1';
const FIRST_FRAME_KEY = 'theme.firstFrame.v1';
const MAX_NAME_LENGTH = 48;
const MAX_ARTWORK_LENGTH = 40000;
const MAX_STORED_ARTWORK_LENGTH = 120000;
const MAX_ARTWORK_ELEMENTS = 1500;
// The same limit the host applies to an attached image.
const MAX_IMAGE_LENGTH = 700000;
const IMAGE_DATA_URL = /^data:image\/(png|jpeg|webp);base64,((?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?)$/;
const BRIDGE_TIMEOUT_MS = 5000;
const COLOR_MODES = ['system', 'light', 'dark'];
const MODE_LABELS = { system: 'Follows system', light: 'Light', dark: 'Dark' };

export const ARTWORK_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src 'none'; font-src 'none'; media-src 'none'; connect-src 'none'; frame-src 'none'; child-src 'none'; object-src 'none'; script-src 'none'; base-uri 'none'; form-action 'none'";

// ------------------------------------------------------------------ proposals

// The file must also start with its type's signature, so a mislabelled file is refused.
const IMAGE_SIGNATURES = {
  png: (bytes) => bytes.startsWith('\x89PNG\r\n\x1a\n'),
  jpeg: (bytes) => bytes.startsWith('\xff\xd8\xff'),
  webp: (bytes) => bytes.startsWith('RIFF') && bytes.slice(8, 12) === 'WEBP',
};

export function normalizeThemeImage(value) {
  if (typeof value !== 'string') throw new TypeError('A theme image must be a PNG, JPEG or WebP image.');
  if (value.length > MAX_IMAGE_LENGTH) throw new RangeError('A theme image can be at most 512 KB.');
  const match = IMAGE_DATA_URL.exec(value);
  let bytes = '';
  try { bytes = match ? atob(match[2].slice(0, 16)) : ''; } catch { /* refused below */ }
  if (!match || !IMAGE_SIGNATURES[match[1]](bytes)) throw new TypeError('A theme image must be a PNG, JPEG or WebP image.');
  return value;
}

export function normalizeThemeProposal(raw, maxArtworkLength = MAX_ARTWORK_LENGTH) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('A theme proposal must be an object.');
  const name = typeof raw.name === 'string' ? raw.name.replace(/[\u0000-\u001f\u007f]/g, '').replace(/\s+/g, ' ').trim() : '';
  if (!name) throw new TypeError('A theme proposal needs a name.');
  if (name.length > MAX_NAME_LENGTH) throw new RangeError(`A theme name can be at most ${MAX_NAME_LENGTH} characters.`);
  if (typeof raw.theme !== 'string' || !/^#[0-9a-f]{6}$/i.test(raw.theme)) throw new TypeError('A theme colour must be a #rrggbb hex value.');
  if (!COLOR_MODES.includes(raw.colorMode)) throw new TypeError('A theme colour mode must be system, light or dark.');
  const proposal = { name, theme: raw.theme.toLowerCase(), colorMode: raw.colorMode };
  if (raw.preset !== undefined && raw.preset !== null) {
    // A look's record always carries that look's own seed.
    if (!Object.hasOwn(THEME_LOOKS, raw.preset) || THEME_LOOKS[raw.preset].seed !== proposal.theme) throw new TypeError('Choose a listed Breezer look.');
    proposal.preset = raw.preset;
  }
  if (raw.html !== undefined && raw.html !== null) {
    if (typeof raw.html !== 'string') throw new TypeError('Theme artwork must be a string of HTML.');
    if (raw.html.length > maxArtworkLength) throw new RangeError(`Theme artwork can be at most ${maxArtworkLength} characters.`);
    if (raw.html.trim()) proposal.html = raw.html;
  }
  if (raw.image !== undefined && raw.image !== null) proposal.image = normalizeThemeImage(raw.image);
  return proposal;
}

// A short stable id so cards can tell whether their proposal is the one applied.
function proposalFingerprint({ name, theme, colorMode, html = '', image = '', preset = '' }) {
  let hash = 0x811c9dc5;
  // Without an image or look the text, and so the id, is unchanged from earlier builds.
  for (const char of `${name}\u0000${theme}\u0000${colorMode}\u0000${html}${image ? `\u0000${image}` : ''}${preset ? `\u0001${preset}` : ''}`) {
    hash ^= char.codePointAt(0);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

// ------------------------------------------------------------------------ CSS

const ALLOWED_AT_RULES = new Set(['keyframes', '-webkit-keyframes', 'media']);
// Functions that load or reference resources, or reach outside the frame.
const BLOCKED_FUNCTIONS = /\b(?:-webkit-)?(?:image-set|image|element|cross-fade|paint|src|expression|env)\s*\(/gi;

function stripAtRules(css) {
  let out = '';
  let i = 0;
  while (i < css.length) {
    const at = css.indexOf('@', i);
    if (at < 0) { out += css.slice(i); break; }
    out += css.slice(i, at);
    const name = /^@([-\w]+)/.exec(css.slice(at))?.[1]?.toLowerCase() ?? '';
    if (ALLOWED_AT_RULES.has(name)) {
      out += `@${name}`;
      i = at + 1 + name.length;
      continue;
    }
    // Drop the whole rule: up to its ';', or its balanced { } block.
    let j = at + 1;
    while (j < css.length && css[j] !== ';' && css[j] !== '{') j += 1;
    if (css[j] === '{') {
      let depth = 0;
      for (; j < css.length; j += 1) {
        if (css[j] === '{') depth += 1;
        else if (css[j] === '}' && --depth === 0) break;
      }
    }
    i = j + 1;
  }
  return out;
}

// Keeps only local fragment references such as url(#glow); everything else becomes `none`.
function neutralizeUrls(css) {
  return css.replace(/url\s*\(\s*(['"]?)([^'")]*)\1\s*\)/gi, (match, quote, target) => (/^#[-\w]+$/.test(target.trim()) ? `url(#${target.trim().slice(1)})` : 'none'))
    .replace(/url\s*\((?!#[-\w]+\))/gi, 'none(');
}

// The cap is the stored-artwork limit, not the proposal limit: sanitizing can
// lengthen CSS slightly (content:x becomes content:""), and stored artwork is
// sanitized again on every read, so a smaller cap would cut saved rules off.
export function sanitizeCss(input) {
  if (typeof input !== 'string') return '';
  let css = input.slice(0, MAX_STORED_ARTWORK_LENGTH);
  // Escapes and '<' are never needed for artwork; removing them first means the
  // checks below see the exact text the browser will parse.
  css = css.replace(/[\\<\u0000]/g, '');
  css = css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '');
  css = stripAtRules(css);
  css = neutralizeUrls(css);
  css = css.replace(BLOCKED_FUNCTIONS, 'none(');
  css = css.replace(/!\s*important/gi, '');
  css = css.replace(/(?:-moz-binding|behavior)\s*:/gi, 'x-blocked:');
  // Artwork carries no words: generated content may only be empty.
  css = css.replace(/(^|[;{\s])content\s*:\s*([^;}]*)/gi, (match, lead, value) => `${lead}content:${/^\s*(?:''|""|none|normal)\s*$/.test(value) ? value.trim() : '""'}`);
  return css.trim();
}

// ----------------------------------------------------------------- HTML / SVG

const SVG_NS = 'http://www.w3.org/2000/svg';
const HTML_NS = 'http://www.w3.org/1999/xhtml';
const HTML_ELEMENTS = new Set(['div', 'span']);
const SVG_ELEMENTS = new Set([
  'svg', 'g', 'defs', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon',
  'linearGradient', 'radialGradient', 'stop', 'pattern', 'clipPath', 'mask', 'filter',
  'feGaussianBlur', 'feTurbulence', 'feColorMatrix', 'feOffset', 'feBlend', 'feMerge', 'feMergeNode',
  'feDisplacementMap', 'feComposite', 'feFlood', 'feMorphology', 'feComponentTransfer',
  'feFuncR', 'feFuncG', 'feFuncB', 'feFuncA', 'feDropShadow',
]);
const ATTRIBUTES = new Set([
  'class', 'id', 'style', 'viewBox', 'preserveAspectRatio', 'width', 'height', 'x', 'y', 'x1', 'y1', 'x2', 'y2',
  'cx', 'cy', 'r', 'rx', 'ry', 'fx', 'fy', 'fr', 'd', 'points', 'pathLength', 'transform', 'transform-origin',
  'fill', 'fill-opacity', 'fill-rule', 'stroke', 'stroke-width', 'stroke-opacity', 'stroke-linecap', 'stroke-linejoin',
  'stroke-dasharray', 'stroke-dashoffset', 'stroke-miterlimit', 'opacity', 'color', 'mix-blend-mode', 'vector-effect',
  'gradientUnits', 'gradientTransform', 'spreadMethod', 'offset', 'stop-color', 'stop-opacity',
  'patternUnits', 'patternContentUnits', 'patternTransform', 'clip-path', 'clip-rule', 'clipPathUnits', 'mask', 'maskUnits',
  'maskContentUnits', 'filter', 'filterUnits', 'primitiveUnits', 'stdDeviation', 'baseFrequency', 'numOctaves', 'seed',
  'stitchTiles', 'type', 'values', 'tableValues', 'slope', 'intercept', 'amplitude', 'exponent', 'in', 'in2', 'result',
  'mode', 'operator', 'k1', 'k2', 'k3', 'k4', 'scale', 'radius', 'xChannelSelector', 'yChannelSelector', 'dx', 'dy',
  'flood-color', 'flood-opacity', 'xmlns', 'aria-hidden',
]);
const NAME_LIKE = new Set(['class', 'id', 'result', 'in', 'in2']);

function safeAttribute(name, value) {
  if (!ATTRIBUTES.has(name)) return null;
  if (name === 'style') return sanitizeCss(`x{${value}}`).replace(/^x\{|\}$/g, '').trim() || null;
  if (name === 'xmlns') return value === SVG_NS ? value : null;
  if (NAME_LIKE.has(name)) return /^[-\w ]{1,200}$/.test(value) ? value : null;
  if (/[\\<>]|&|:\s*\/\//.test(value) || /(?:javascript|data|vbscript)\s*:/i.test(value)) return null;
  if (/url\s*\(/i.test(value)) return /^url\(\s*#[-\w]+\s*\)$/i.test(value.trim()) ? value.trim() : null;
  return value.length <= 4000 ? value : null;
}

// Returns graphics-only markup: one <style> holding the sanitized CSS, followed
// by the allowed elements. Text, links, images, foreign content, SMIL and every
// unknown element are dropped together with their children.
//
// The untrusted markup is parsed into a disconnected <template>: its content
// belongs to the template's inert document, which has no browsing context, so
// nothing in it (img, link, iframe, style imports) is fetched or run while it
// is inspected. The clean copy is built in that same inert document.
function sanitizeArtwork(html, { doc = globalThis.document } = {}) {
  if (typeof html !== 'string' || !html.trim()) return '';
  if (typeof doc?.createElement !== 'function') throw new Error('Artwork can only be prepared in a page.');
  const source = doc.createElement('template');
  source.innerHTML = html.slice(0, MAX_STORED_ARTWORK_LENGTH);
  const inert = source.content.ownerDocument;
  const holder = inert.createElement('div');
  const styles = [];
  let count = 0;

  const copy = (node, parent, depth) => {
    if (node.nodeType !== 1 || depth > 32 || count >= MAX_ARTWORK_ELEMENTS) return;
    const svg = node.namespaceURI === SVG_NS;
    const name = node.localName;
    if (name === 'style' && (svg || node.namespaceURI === HTML_NS)) { styles.push(node.textContent); return; }
    if (!(svg ? SVG_ELEMENTS.has(name) : node.namespaceURI === HTML_NS && HTML_ELEMENTS.has(name))) return;
    count += 1;
    const clean = svg ? inert.createElementNS(SVG_NS, name) : inert.createElement(name);
    for (const { name: attribute, value, namespaceURI } of [...node.attributes]) {
      if (namespaceURI) continue;
      const safe = safeAttribute(attribute, value);
      if (safe !== null) clean.setAttribute(attribute, safe);
    }
    for (const child of node.childNodes) copy(child, clean, depth + 1);
    parent.append(clean);
  };

  for (const child of source.content.childNodes) copy(child, holder, 0);
  const css = sanitizeCss(styles.join('\n'));
  if (!holder.childNodes.length && !css) return '';
  return `${css ? `<style>${css}</style>` : ''}${holder.innerHTML}`;
}

const ARTWORK_LAYOUT = ':root{color-scheme:normal}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:transparent}body{position:relative}svg{display:block}';
const REDUCED_MOTION = '@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}';

// The complete srcdoc for an artwork frame. The CSP comes first and the
// reduced-motion rule last; sanitized CSS has no !important, so it cannot win.
export function artworkDocument(safeHtml) {
  return '<!doctype html><html><head>'
    + `<meta http-equiv="Content-Security-Policy" content="${ARTWORK_CSP}">`
    + '<meta name="referrer" content="no-referrer">'
    // color-scheme stays "normal" here and on the iframe, so Chrome keeps the frame transparent in dark pages.
    + `<style>${ARTWORK_LAYOUT}</style>`
    + `</head><body>${safeHtml}`
    + `<style>*,*::before,*::after{pointer-events:none!important;user-select:none!important}${REDUCED_MOTION}</style>`
    + '</body></html>';
}

// The person's image, shown as-is: an extension-page <img> of a validated raster
// data: URL loads nothing and runs nothing.
function createThemeImage(doc, image, { className = 'theme-image', decoding = 'async' } = {}) {
  const node = doc.createElement('img');
  node.className = className;
  node.alt = '';
  node.decoding = decoding;
  node.draggable = false;
  node.referrerPolicy = 'no-referrer';
  node.setAttribute('aria-hidden', 'true');
  node.src = image;
  return node;
}

function createArtworkFrame(doc, safeHtml, { className = 'theme-artwork' } = {}) {
  const frame = doc.createElement('iframe');
  frame.className = className;
  frame.setAttribute('sandbox', '');
  frame.setAttribute('csp', ARTWORK_CSP);
  frame.setAttribute('referrerpolicy', 'no-referrer');
  frame.setAttribute('allow', "camera 'none'; microphone 'none'; geolocation 'none'; fullscreen 'none'");
  frame.setAttribute('aria-hidden', 'true');
  frame.setAttribute('tabindex', '-1');
  frame.inert = true;
  frame.style.colorScheme = 'normal';
  frame.srcdoc = artworkDocument(safeHtml);
  return frame;
}

// --------------------------------------------------------------------- bridge

function callBridge(api, name, ...args) {
  const target = api?.breezerPrivate;
  if (typeof target?.[name] !== 'function') return Promise.reject(Object.assign(new Error('The appearance bridge is unavailable.'), { unavailable: true }));
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, value) => { if (!settled) { settled = true; clearTimeout(timer); fn(value); } };
    const timer = setTimeout(() => settle(reject, new Error('The browser did not answer.')), BRIDGE_TIMEOUT_MS);
    try {
      const result = target[name](...args, (value) => {
        const lastError = api.runtime?.lastError;
        if (lastError) settle(reject, new Error(lastError.message || 'The browser rejected the change.'));
        else settle(resolve, value);
      });
      if (result && typeof result.then === 'function') result.then((value) => settle(resolve, value), (error) => settle(reject, error));
    } catch (error) {
      settle(reject, error);
    }
  });
}

const hasBridge = (api) => typeof api?.breezerPrivate?.setAppearance === 'function' && typeof api?.breezerPrivate?.getAppearance === 'function';

function storageArea(api) {
  const area = api?.storage?.local;
  if (typeof area?.get !== 'function' || typeof area?.set !== 'function') throw new Error('Theme storage is unavailable.');
  return area;
}

async function readKeys(area, keys) {
  const values = await area.get(keys);
  return values && typeof values === 'object' ? values : {};
}

function themeState(value) {
  const { theme, colorMode, nativeDefaultTheme } = value ?? {};
  return { theme, colorMode, ...(nativeDefaultTheme === undefined ? {} : { nativeDefaultTheme }) };
}

const sameThemeState = (a, b) => Boolean(a && b) && a.theme === b.theme
  && a.colorMode === b.colorMode && a.nativeDefaultTheme === b.nativeDefaultTheme;

// Writes a seed and mode only if the browser still shows `expected`: the native
// side compares and refuses, so a look someone picked meanwhile is never
// overwritten. Resolves with the normalized result and the raw theme state the
// browser reports, which is what a later compare must name.
async function writeAppearance(api, patch, expected) {
  const { nativeDefaultTheme, ...themePatch } = patch;
  const request = { ...validateAppearancePatch(themePatch), expectedThemeState: themeState(expected) };
  if (nativeDefaultTheme !== undefined) request.nativeDefaultTheme = nativeDefaultTheme;
  let result = await callBridge(api, 'setAppearance', request);
  if (!result || typeof result !== 'object') result = await callBridge(api, 'getAppearance');
  return { appearance: normalizeAppearance(result), actual: themeState(result) };
}

async function readRestorableAppearance(api) {
  const current = await callBridge(api, 'getAppearance');
  if (current?.themeCanRestore !== true) {
    throw new Error('Choose a Breezer theme in Appearance settings first so your previous look can be restored.');
  }
  return themeState(current);
}

// Tells open pages to re-read the appearance. The revision is a tiny write that
// can succeed when the full save did not; without storage the runtime message
// reaches other extension pages and the window event reaches this one.
async function signalAppearanceRefresh(api, area, now) {
  try {
    await area.set({ [APPEARANCE_REV_KEY]: now() });
    return;
  } catch { /* storage is unavailable: fall back to messages */ }
  try { Promise.resolve(api?.runtime?.sendMessage?.({ type: THEME_REFRESH_MESSAGE })).catch(() => {}); } catch { /* no other pages */ }
  try { globalThis.dispatchEvent?.(new Event(THEME_REFRESH_MESSAGE)); } catch { /* not a page */ }
}

// Puts the browser back to `current` after a failed save, unless someone chose
// a newer look since `written` landed. Returns the error to report.
async function rollBack(api, area, current, written, error, now) {
  let failure = error;
  try {
    await writeAppearance(api, current, written.actual);
  } catch {
    const actual = await callBridge(api, 'getAppearance').then(themeState, () => null);
    if (actual && !sameThemeState(actual, current) && !sameThemeState(actual, written.actual)) {
      failure = new Error(`${errorText(error)} Your newer browser colors were kept.`, { cause: error });
    } else if (!sameThemeState(actual, current)) {
      failure = new Error('Couldn’t save the artwork or restore the previous browser colors. Check Appearance settings.', { cause: error });
    }
  }
  await signalAppearanceRefresh(api, area, now);
  return failure;
}

async function saveLook(api, area, current, next, values, now) {
  const written = next ? await writeAppearance(api, next, current) : null;
  try {
    await area.set(values);
  } catch (error) {
    throw written ? await rollBack(api, area, current, written, error, now) : error;
  }
  return written?.appearance ?? null;
}

function readArtworkRecord(value) {
  if (!value || typeof value !== 'object') return null;
  try {
    const proposal = normalizeThemeProposal(value, MAX_STORED_ARTWORK_LENGTH);
    return { ...proposal, fingerprint: typeof value.fingerprint === 'string' ? value.fingerprint : proposalFingerprint(proposal) };
  } catch {
    return null;
  }
}

// What the theme cards and new tab need: the applied proposal, if any, and
// whether there is an earlier look to go back to.
export async function readThemeState({ api = globalThis.chrome } = {}) {
  const values = await readKeys(storageArea(api), [ARTWORK_KEY, PREVIOUS_LOOK_KEY]);
  return { applied: readArtworkRecord(values[ARTWORK_KEY]), canRestore: Boolean(values[PREVIOUS_LOOK_KEY]) };
}

const THEME_LOCK_NAME = 'breezer.theme';

// Apply and restore read, then write, several keys; one at a time across every
// panel and new tab keeps the saved previous look consistent.
function exclusive(task) {
  const locks = globalThis.navigator?.locks;
  return typeof locks?.request === 'function' ? locks.request(THEME_LOCK_NAME, task) : task();
}

// Applies the seed and mode natively (when the bridge exists) and stores the
// sanitized artwork. The look from before the first applied proposal is kept
// once, so Restore always returns to what the person had chosen themselves.
export async function applyThemeProposal(raw, { api = globalThis.chrome, now = Date.now, doc = globalThis.document } = {}) {
  const proposal = normalizeThemeProposal(raw);
  const area = storageArea(api);
  const html = proposal.html ? sanitizeArtwork(proposal.html, { doc }) : '';
  if (html.length > MAX_STORED_ARTWORK_LENGTH) throw new Error('The rendered artwork is too large to save.');
  return exclusive(() => applyLocked(api, area, proposal, html, now));
}

async function applyLocked(api, area, proposal, html, now) {
  const values = await readKeys(area, [ARTWORK_KEY, PREVIOUS_LOOK_KEY]);
  const native = hasBridge(api);
  const current = native ? await readRestorableAppearance(api) : null;
  const previous = values[PREVIOUS_LOOK_KEY] || { appearance: current, artwork: readArtworkRecord(values[ARTWORK_KEY]) };
  const record = {
    name: proposal.name, theme: proposal.theme, colorMode: proposal.colorMode,
    ...(html ? { html } : {}), ...(proposal.image ? { image: proposal.image } : {}), ...(proposal.preset ? { preset: proposal.preset } : {}), fingerprint: proposalFingerprint(proposal),
  };
  const next = native ? { theme: proposal.theme, colorMode: proposal.colorMode } : null;
  const appearance = await saveLook(api, area, current, next, {
    [ARTWORK_KEY]: record, [FIRST_FRAME_KEY]: null, [PREVIOUS_LOOK_KEY]: previous, [APPEARANCE_REV_KEY]: now(),
  }, now);
  const kept = appearance && (appearance.theme.toLowerCase() !== proposal.theme || appearance.colorMode !== proposal.colorMode);
  return { applied: record, native, appearance, kept: Boolean(kept) };
}

// ---------------------------------------------------------------------- looks

// Choosing a plain color ends a built-in look even if the color is its seed.
// Keep user artwork and the normal Restore history separate from look Cancel.
export async function applyThemeColor(theme, { api = globalThis.chrome, now = Date.now } = {}) {
  const patch = validateAppearancePatch({ theme });
  const area = storageArea(api);
  return exclusive(async () => {
    const values = await readKeys(area, [ARTWORK_KEY, LOOK_UNDO_KEY]);
    const preset = readArtworkRecord(values[ARTWORK_KEY])?.preset;
    if (preset || values[LOOK_UNDO_KEY]) {
      const current = themeState(await callBridge(api, 'getAppearance'));
      return saveLook(api, area, current, patch, {
        ...(preset ? { [ARTWORK_KEY]: null, [FIRST_FRAME_KEY]: null } : {}),
        [LOOK_UNDO_KEY]: null,
        [APPEARANCE_REV_KEY]: now(),
      }, now);
    }
    let appearance = await callBridge(api, 'setAppearance', patch);
    if (!appearance || typeof appearance !== 'object') appearance = await callBridge(api, 'getAppearance');
    await signalAppearanceRefresh(api, area, now);
    return normalizeAppearance(appearance);
  });
}

// Applies a Breezer look: its seed goes to the browser through the custom-colour
// bridge (the person's colour mode is kept) and its record tells pages which art
// to draw. The look from before the first one is kept for Cancel, also across
// restarts; switching between looks keeps that same starting point.
export async function applyThemeLook(id, { api = globalThis.chrome, now = Date.now } = {}) {
  if (!Object.hasOwn(THEME_LOOKS, id)) throw new TypeError('Choose a listed Breezer look.');
  const area = storageArea(api);
  return exclusive(() => applyLookLocked(api, area, id, now));
}

async function applyLookLocked(api, area, id, now) {
  const look = THEME_LOOKS[id];
  const values = await readKeys(area, [ARTWORK_KEY, PREVIOUS_LOOK_KEY, LOOK_UNDO_KEY]);
  const native = hasBridge(api);
  const raw = native ? await callBridge(api, 'getAppearance') : null;
  if (native && raw?.themeCanRestore !== true) {
    throw new Error('Choose a Breezer theme in Appearance settings first so your previous look can be restored.');
  }
  const current = native ? themeState(raw) : null;
  const currentRecord = readArtworkRecord(values[ARTWORK_KEY]);
  const continuing = activeLook(currentRecord, native ? raw.theme : null) && values[LOOK_UNDO_KEY];
  const undo = continuing ? values[LOOK_UNDO_KEY] : { appearance: current, artwork: currentRecord, previous: values[PREVIOUS_LOOK_KEY] ?? null };
  const colorMode = native ? normalizeAppearance(raw).colorMode : 'system';
  const proposal = { name: look.name, theme: look.seed, colorMode, preset: id };
  const record = { ...proposal, fingerprint: proposalFingerprint(proposal) };
  const previous = values[PREVIOUS_LOOK_KEY] || { appearance: current, artwork: currentRecord };
  const appearance = await saveLook(api, area, current, native ? { theme: look.seed } : null, {
    [ARTWORK_KEY]: record, [FIRST_FRAME_KEY]: null, [PREVIOUS_LOOK_KEY]: previous, [LOOK_UNDO_KEY]: undo, [APPEARANCE_REV_KEY]: now(),
  }, now);
  const kept = Boolean(appearance && appearance.theme.toLowerCase() !== look.seed);
  return { look: id, native, appearance, kept };
}

// The look pages should draw and whether Cancel has somewhere to go back to.
// theme is the browser's current theme, or null when there is no bridge.
export async function readThemeLook({ api = globalThis.chrome, theme = null } = {}) {
  const values = await readKeys(storageArea(api), [ARTWORK_KEY, LOOK_UNDO_KEY]);
  const look = activeLook(readArtworkRecord(values[ARTWORK_KEY]), theme);
  return { look, canCancel: Boolean(look && values[LOOK_UNDO_KEY]) };
}

// Puts back the theme, artwork and saved previous look from before the first
// look. The colour mode stays as it is now. Does nothing once another theme
// has replaced the look.
export async function cancelThemeLook({ api = globalThis.chrome, now = Date.now } = {}) {
  const area = storageArea(api);
  return exclusive(() => cancelLookLocked(api, area, now));
}

async function cancelLookLocked(api, area, now) {
  const values = await readKeys(area, [ARTWORK_KEY, LOOK_UNDO_KEY]);
  const undo = values[LOOK_UNDO_KEY];
  if (!undo || typeof undo !== 'object') return { cancelled: false };
  const native = hasBridge(api);
  const raw = native ? await callBridge(api, 'getAppearance') : null;
  if (!activeLook(readArtworkRecord(values[ARTWORK_KEY]), native ? raw?.theme : null)) {
    await area.set({ [LOOK_UNDO_KEY]: null });
    return { cancelled: false };
  }
  const current = native ? themeState(raw) : null;
  const before = undo.appearance;
  const target = native && before?.theme ? {
    theme: before.theme, colorMode: current.colorMode,
    ...(before.nativeDefaultTheme === undefined ? {} : { nativeDefaultTheme: before.nativeDefaultTheme }),
  } : null;
  const artwork = readArtworkRecord(undo.artwork);
  const appearance = await saveLook(api, area, current, target, {
    [ARTWORK_KEY]: artwork, [FIRST_FRAME_KEY]: null, [PREVIOUS_LOOK_KEY]: undo.previous ?? null, [LOOK_UNDO_KEY]: null, [APPEARANCE_REV_KEY]: now(),
  }, now);
  return { cancelled: true, appearance, artwork };
}

export async function restorePreviousLook({ api = globalThis.chrome, now = Date.now } = {}) {
  const area = storageArea(api);
  return exclusive(() => restoreLocked(api, area, now));
}

async function restoreLocked(api, area, now) {
  const values = await readKeys(area, [PREVIOUS_LOOK_KEY]);
  const previous = values[PREVIOUS_LOOK_KEY];
  if (!previous || typeof previous !== 'object') return { restored: false };
  if (previous.appearance && !hasBridge(api)) throw new Error('Browser appearance is unavailable in this build.');
  const current = previous.appearance ? await readRestorableAppearance(api) : null;
  const artwork = readArtworkRecord(previous.artwork);
  const appearance = await saveLook(api, area, current, previous.appearance, {
    [ARTWORK_KEY]: artwork, [FIRST_FRAME_KEY]: null, [PREVIOUS_LOOK_KEY]: null, [APPEARANCE_REV_KEY]: now(),
  }, now);
  return { restored: true, appearance, artwork };
}

// ---------------------------------------------------------------------- cards

function element(doc, tag, className, text) {
  const node = doc.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function errorText(error) {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return message.trim().replace(/\.?$/, '.');
}

function proposalExtras({ image, html }) {
  if (image && html) return ', with your image and background art';
  if (image) return ', with your image';
  return html ? ', with background art' : '';
}

// Appends a proposal card to container and returns { element, apply, restore, destroy }.
// Throws (like normalizeThemeProposal) when the proposal is invalid.
export function renderThemeProposal(container, raw, { api = globalThis.chrome } = {}) {
  const proposal = normalizeThemeProposal(raw);
  const doc = container.ownerDocument;
  const fingerprint = proposalFingerprint(proposal);
  const card = element(doc, 'section', 'theme-proposal');
  card.dataset.mode = proposal.colorMode;
  card.style.setProperty('--proposal-seed', proposal.theme);
  card.setAttribute('aria-label', `Theme proposal: ${proposal.name}`);

  const stage = element(doc, 'div', 'theme-proposal-stage');
  // The image fills the stage like the new tab's background; the artwork frame,
  // which is transparent wherever it draws nothing, sits over it.
  if (proposal.image) {
    const image = createThemeImage(doc, proposal.image, { className: 'theme-proposal-image' });
    Object.assign(image.style, { position: 'absolute', inset: '0', display: 'block', width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none', userSelect: 'none' });
    stage.append(image);
  }
  if (proposal.html) stage.append(createArtworkFrame(doc, sanitizeArtwork(proposal.html, { doc }), { className: 'theme-proposal-art' }));
  if (!proposal.image && !proposal.html) stage.classList.add('theme-proposal-stage-plain');
  // A sketch of the new tab's sheet, so the preview shows how content sits on the art.
  const sketch = element(doc, 'div', 'theme-proposal-sketch');
  sketch.setAttribute('aria-hidden', 'true');
  sketch.append(element(doc, 'i'), element(doc, 'i'), element(doc, 'i'));
  stage.append(sketch);

  const body = element(doc, 'div', 'theme-proposal-body');
  const heading = element(doc, 'h3', 'theme-proposal-name', proposal.name);
  const meta = element(doc, 'p', 'theme-proposal-meta');
  const swatch = element(doc, 'span', 'theme-proposal-swatch');
  swatch.setAttribute('aria-hidden', 'true');
  meta.append(swatch, doc.createTextNode(`${proposal.theme.toUpperCase()}, ${MODE_LABELS[proposal.colorMode].toLowerCase()}${proposalExtras(proposal)}`));
  const actions = element(doc, 'div', 'theme-proposal-actions');
  const applyButton = element(doc, 'button', 'theme-proposal-apply', 'Apply theme');
  applyButton.type = 'button';
  const restoreButton = element(doc, 'button', 'theme-proposal-restore', 'Restore previous look');
  restoreButton.type = 'button';
  restoreButton.hidden = true;
  actions.append(applyButton, restoreButton);
  const status = element(doc, 'p', 'theme-proposal-status');
  status.setAttribute('role', 'status');
  status.setAttribute('aria-live', 'polite');
  body.append(heading, meta, actions, status);
  card.append(stage, body);
  container.append(card);

  let busy = false;
  let state = { applied: null, canRestore: false };
  const paint = () => {
    const isApplied = state.applied?.fingerprint === fingerprint;
    card.dataset.applied = String(isApplied);
    applyButton.textContent = isApplied ? 'Applied' : 'Apply theme';
    applyButton.disabled = busy || isApplied;
    restoreButton.hidden = !state.canRestore;
    restoreButton.disabled = busy;
    card.setAttribute('aria-busy', String(busy));
  };
  const refresh = async () => {
    try { state = await readThemeState({ api }); } catch { /* keeps the last state */ }
    paint();
  };
  const run = async (task, done) => {
    if (busy) return;
    busy = true;
    paint();
    status.dataset.tone = '';
    try {
      status.textContent = done(await task());
    } catch (error) {
      status.dataset.tone = 'error';
      status.textContent = `Couldn’t change the theme. ${errorText(error)}`;
    } finally {
      busy = false;
      await refresh();
    }
  };

  const apply = () => run(() => applyThemeProposal(proposal, { api, doc }), (result) => {
    if (!result.native) return `Applied “${proposal.name}” to the new tab. Browser colours aren’t available in this build.`;
    if (result.kept) return `Applied “${proposal.name}”, but the browser kept some of your colours.`;
    return `Applied “${proposal.name}”.`;
  });
  const restore = () => run(() => restorePreviousLook({ api }), (result) => (result.restored ? 'Restored your previous look.' : 'There’s no previous look to restore.'));
  applyButton.addEventListener('click', () => void apply());
  restoreButton.addEventListener('click', () => void restore());

  const changes = localStorageChanges(api);
  const onChange = (delta) => {
    if (!card.isConnected) { changes?.removeListener?.(onChange); return; }
    if (delta?.[ARTWORK_KEY] || delta?.[PREVIOUS_LOOK_KEY]) void refresh();
  };
  changes?.addListener(onChange);
  paint();
  const ready = refresh();
  return {
    element: card,
    ready,
    apply,
    restore,
    destroy() { changes?.removeListener?.(onChange); card.remove(); },
  };
}

// ------------------------------------------------------------------- new tab

function firstFrameViewport(view, { fingerprint }) {
  const { innerWidth: width, innerHeight: height } = view;
  if (!width || !height || width > 4096 || height > 4096 || view.matchMedia('(forced-colors: active)').matches) return null;
  const dark = view.matchMedia('(prefers-color-scheme: dark)').matches;
  const reducedMotion = view.matchMedia('(prefers-reduced-motion: reduce)').matches;
  return { width, height, key: `${fingerprint}:${width}x${height}:${dark}:${reducedMotion}` };
}

function rasterArtworkCss(css) {
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(css);
  const retargetRoot = (rules) => {
    for (const rule of rules) {
      if (rule instanceof CSSStyleRule) {
        const selector = rule.selectorText.replace(/"[^"]*"|'[^']*'|:root(?![\w-])/gi,
          (token) => token.toLowerCase() === ':root' ? '[data-artwork-root]' : token);
        if (selector !== rule.selectorText) rule.selectorText = selector;
      }
      if (rule.cssRules) retargetRoot(rule.cssRules);
    }
  };
  retargetRoot(sheet.cssRules);
  return Array.from(sheet.cssRules, (rule) => rule.cssText).join('\n');
}

async function rasterizeFirstFrame(doc, safeHtml, { width, height }) {
  // SVG image mode has no scripts or external resources. Use the same sanitized
  // graphics as the live frame, with the CSS timeline paused on its first frame.
  const template = doc.createElement('template');
  template.innerHTML = safeHtml;
  const still = doc.implementation.createHTMLDocument();
  // The outer SVG is :root in image mode. Retarget artwork selectors to the
  // embedded HTML element with the same CSS specificity.
  still.documentElement.setAttribute('data-artwork-root', '');
  const styles = template.content.querySelector('style');
  if (styles && /:root/i.test(styles.textContent)) styles.textContent = rasterArtworkCss(styles.textContent);
  const layout = still.createElement('style');
  layout.textContent = ARTWORK_LAYOUT;
  still.head.append(layout);
  const pause = still.createElement('style');
  pause.textContent = `*,*::before,*::after{animation-play-state:paused!important;transition:none!important}${REDUCED_MOTION}`;
  still.body.append(template.content, pause);
  const markup = new XMLSerializer().serializeToString(still.documentElement);
  const svg = `<svg xmlns="${SVG_NS}" width="${width}" height="${height}"><foreignObject width="100%" height="100%">${markup}</foreignObject></svg>`;
  const source = doc.createElement('img');
  source.src = `data:image/svg+xml,${encodeURIComponent(svg)}`;
  await source.decode();
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = doc.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height);
  return normalizeThemeImage(canvas.toDataURL('image/webp', 0.85));
}

function afterArtworkPaint(view) {
  return new Promise((resolve) => view.requestAnimationFrame(() => view.requestAnimationFrame(resolve)));
}

// Paints the applied image and artwork behind the page and follows later
// applies and restores. root gets data-artwork="on" while either is showing,
// and data-theme-image="on" while the image is.
export function startThemeArtwork({ api = globalThis.chrome, doc = globalThis.document } = {}) {
  const root = doc.documentElement;
  const view = doc.defaultView;
  let artwork = null;
  let picture = null;
  let shownHtml = '';
  let shownImage = '';
  let request = 0;
  const mark = () => {
    if (artwork?.frame || artwork?.poster || picture) root.dataset.artwork = 'on';
    else delete root.dataset.artwork;
    if (picture) root.dataset.themeImage = 'on';
    else delete root.dataset.themeImage;
  };
  const insertArtwork = (node) => {
    if (picture) picture.after(node);
    else doc.body.prepend(node);
  };
  const clearArtwork = () => {
    artwork?.frame?.remove();
    artwork?.poster?.remove();
    artwork = null;
    shownHtml = '';
  };
  const loadArtwork = async (active, record, cached) => {
    const viewport = firstFrameViewport(view, record);
    if (viewport && cached?.key === viewport.key) {
      try {
        const poster = createThemeImage(doc, normalizeThemeImage(cached.image), { className: 'theme-first-frame' });
        await poster.decode();
        if (artwork !== active) return;
        active.poster = poster;
        insertArtwork(poster);
        mark();
        await afterArtworkPaint(view);
      } catch { /* a missing or undecodable still falls back to live artwork */ }
    }
    if (artwork !== active) return;
    const safeHtml = sanitizeArtwork(record.html, { doc });
    const frame = createArtworkFrame(doc, safeHtml);
    active.frame = frame;
    if (active.poster) frame.style.opacity = '0';
    frame.addEventListener('load', async () => {
      await afterArtworkPaint(view);
      if (artwork !== active) return;
      if (active.poster) {
        frame.style.removeProperty('opacity');
        active.poster.remove();
        active.poster = null;
        return;
      }
      if (!viewport) return;
      view.requestIdleCallback(async () => {
        if (artwork !== active) return;
        try {
          const image = await rasterizeFirstFrame(doc, safeHtml, viewport);
          await exclusive(async () => {
            if (artwork !== active) return;
            const area = storageArea(api);
            const values = await readKeys(area, [ARTWORK_KEY, FIRST_FRAME_KEY]);
            const current = readArtworkRecord(values[ARTWORK_KEY]);
            if (current?.html !== record.html || current?.fingerprint !== record.fingerprint) return;
            if (values[FIRST_FRAME_KEY]?.key === viewport.key && values[FIRST_FRAME_KEY]?.image === image) return;
            await area.set({ [FIRST_FRAME_KEY]: { key: viewport.key, image } });
          });
        } catch { /* caching is optional */ }
      });
    }, { once: true });
    insertArtwork(frame);
    mark();
  };
  const show = (record, cached) => {
    const html = record?.html ?? '';
    const image = record?.image ?? '';
    if (image !== shownImage) {
      shownImage = image;
      picture?.remove();
      picture = null;
      try {
        if (image) {
          const node = createThemeImage(doc, image, { decoding: 'sync' });
          node.addEventListener('error', () => { if (picture === node) { node.remove(); picture = null; mark(); } }, { once: true });
          picture = node;
        }
      } catch { picture = null; }
    }
    if (picture && doc.body.firstElementChild !== picture) doc.body.prepend(picture);
    if (html !== shownHtml) {
      clearArtwork();
      shownHtml = html;
      artwork = html ? { frame: null, poster: null } : null;
      if (artwork) void loadArtwork(artwork, record, cached).catch(() => {});
    }
    mark();
  };
  const refresh = async () => {
    const id = ++request;
    if (doc.hidden) {
      clearArtwork();
      mark();
      return;
    }
    let values;
    try {
      values = await readKeys(storageArea(api), [ARTWORK_KEY, FIRST_FRAME_KEY]);
    } catch { return; }
    if (id === request) show(readArtworkRecord(values[ARTWORK_KEY]), values[FIRST_FRAME_KEY]);
  };
  localStorageChanges(api)?.addListener((changes) => {
    if (changes?.[ARTWORK_KEY]) void refresh();
  });
  doc.addEventListener('visibilitychange', () => void refresh());
  return refresh();
}
