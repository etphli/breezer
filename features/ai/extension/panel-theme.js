import { localStorageChanges } from './storage-events.js';
// Keeps the assistant panel on the profile's Breezer tone and color mode. The
// appearance comes from chrome.breezerPrivate.getAppearance; workspace pages bump
// storage.local['appearance.rev'] after every change, so an open panel follows
// along. Builds without the bridge (and test fixtures) keep the OS color scheme.
import { APPEARANCE_REV_KEY, DEFAULT_APPEARANCE, normalizeAppearance } from './workspace-store.js';

export const APPEARANCE_TIMEOUT_MS = 1500;
// Sent (as a runtime message, and as a window event in the sending page) when
// the browser appearance changed but appearance.rev could not be written, such
// as after a theme rollback with storage unavailable.
export const THEME_REFRESH_MESSAGE = 'breezer.theme.refresh';
// The applied theme record (see browser-theme.js). Kept here so every themed
// page can read it without loading the artwork sanitizer.
export const ARTWORK_KEY = 'theme.artwork.v1';

// Breezer looks: a native seed colour plus page art drawn in CSS, so they need no
// extra extension resources and load nothing. The browser frame is painted from
// the seed through the custom-colour bridge; New Tab, the assistant panel and
// Command-K mark <html data-look="…"> and draw the rest. Each look keeps the
// person's colour mode and has its own light and dark variant.
export const THEME_LOOKS = Object.freeze({
  charcoal: Object.freeze({ name: 'Charcoal', seed: '#2e2f33', description: 'Graphite night with a dotted horizon and a few far lights.' }),
  plum: Object.freeze({ name: 'Plum', seed: '#5b3a6e', description: 'Plum twilight over a fine, drifting dot field.' }),
  sage: Object.freeze({ name: 'Sage', seed: '#7b9384', description: 'Muted green behind frosted panes. Glossier with Glass on.' }),
  umber: Object.freeze({ name: 'Umber', seed: '#8a5034', description: 'Warm clay and umber, late in the evening.' }),
  fathom: Object.freeze({ name: 'Fathom', seed: '#1f3b5a', description: 'Deep water drawn as a sea chart, its depth lines rippling out.' }),
  linen: Object.freeze({ name: 'Linen', seed: '#d8cbb1', description: 'Ivory cloth with a fine weave, one soft fold and ink-blue type.' }),
  lune: Object.freeze({ name: 'Lune', seed: '#2b2f3d', description: 'A quiet night and a soft moon, its shadow edge in fine stipple.' }),
  vesper: Object.freeze({ name: 'Vesper', seed: '#8d3550', description: 'Rose evening light falling through slatted blinds.' }),
});

// The look a page should draw: the applied record names one and the browser
// still shows its seed. Picking another theme in Settings ends the look without
// touching the record. Without a bridge (theme === null) the record decides.
export function activeLook(record, theme) {
  const id = record && typeof record === 'object' ? record.preset : null;
  const look = typeof id === 'string' && Object.hasOwn(THEME_LOOKS, id) ? THEME_LOOKS[id] : null;
  if (!look || record.theme !== look.seed) return null;
  if (theme === null || theme === undefined) return id;
  return typeof theme === 'string' && theme.toLowerCase() === look.seed ? id : null;
}

export function resolveTheme(appearance, systemDark) {
  const { theme, colorMode } = normalizeAppearance(appearance);
  return { tone: theme, scheme: colorMode === 'system' ? (systemDark ? 'dark' : 'light') : colorMode };
}

export function applyTheme(root, { tone, scheme, look = null }) {
  const custom = /^#[0-9a-f]{6}$/i.test(tone);
  if (look && Object.hasOwn(THEME_LOOKS, look)) root.dataset.look = look;
  else delete root.dataset.look;
  root.dataset.tone = custom ? 'custom' : tone;
  if (custom) root.style.setProperty('--custom-seed', tone);
  else root.style.removeProperty('--custom-seed');
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
}

// Accepts promise- or callback-style bridges, and never waits longer than timeoutMs.
export function readAppearance(api, timeoutMs = APPEARANCE_TIMEOUT_MS) {
  const bridge = api?.breezerPrivate;
  if (typeof bridge?.getAppearance !== 'function') return Promise.resolve(null);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value && typeof value === 'object' ? value : null);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    try {
      const result = bridge.getAppearance((value) => finish(api.runtime?.lastError ? null : value));
      if (result && typeof result.then === 'function') result.then(finish, () => finish(null));
    } catch {
      finish(null);
    }
  });
}

// The last resolved look, so a reopened page paints it before the bridge answers.
const MIRROR_KEY = 'breezer.theme.mirror';
const pageStorage = (root) => { try { return root.ownerDocument?.defaultView?.localStorage ?? null; } catch { return null; } };

function readMirror(root) {
  try {
    const value = JSON.parse(pageStorage(root)?.getItem(MIRROR_KEY) || 'null');
    if (!value || typeof value !== 'object') return null;
    return { appearance: normalizeAppearance(value), look: Object.hasOwn(THEME_LOOKS, value.look) ? value.look : null };
  } catch { return null; }
}

async function readThemeRecord(api) {
  const area = api?.storage?.local;
  if (typeof area?.get !== 'function') return null;
  try {
    const values = await area.get(ARTWORK_KEY);
    return values?.[ARTWORK_KEY] ?? null;
  } catch { return null; }
}

export function startPanelTheme({ api = globalThis.chrome, root = document.documentElement, darkQuery = matchMedia('(prefers-color-scheme: dark)'), timeoutMs } = {}) {
  let appearance = { ...DEFAULT_APPEARANCE };
  let record = null;
  let bridged = false;
  let request = 0;
  const apply = () => {
    const resolved = resolveTheme(appearance, darkQuery.matches);
    const look = activeLook(record, bridged ? appearance.theme : null);
    applyTheme(root, { ...resolved, look });
    if (bridged || look) {
      try { pageStorage(root)?.setItem(MIRROR_KEY, JSON.stringify({ theme: appearance.theme, colorMode: appearance.colorMode, look })); } catch { /* a convenience only */ }
    }
  };
  const refresh = async () => {
    const id = ++request;
    const [value, stored] = await Promise.all([readAppearance(api, timeoutMs), readThemeRecord(api)]);
    // A slower, older read must not overwrite a newer one; a failed read keeps the last good value.
    if (id !== request) return;
    record = stored;
    if (value) {
      appearance = normalizeAppearance(value);
      bridged = true;
    }
    if (value || stored) apply();
  };

  const mirror = readMirror(root);
  const paintMirror = () => applyTheme(root, { ...resolveTheme(mirror.appearance, darkQuery.matches), look: mirror.look });
  if (mirror) paintMirror();
  else apply();
  // Until the first answer, an OS switch repaints the mirrored look rather than the default.
  darkQuery.addEventListener?.('change', () => (mirror && !bridged && !record ? paintMirror() : apply()));
  localStorageChanges(api)?.addListener((changes) => {
    if (changes?.[APPEARANCE_REV_KEY] || changes?.[ARTWORK_KEY]) void refresh();
  });
  api?.runtime?.onMessage?.addListener?.((message) => {
    if (message?.type === THEME_REFRESH_MESSAGE) void refresh();
  });
  root.ownerDocument?.defaultView?.addEventListener?.(THEME_REFRESH_MESSAGE, () => void refresh());
  return refresh();
}
