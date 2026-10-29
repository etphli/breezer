// Keeps the assistant panel on the profile's Breezer tone and color mode. The
// appearance comes from chrome.breezerPrivate.getAppearance; workspace pages bump
// storage.session['appearance.rev'] after every change, so an open panel follows
// along. Builds without the bridge (and test fixtures) keep the OS color scheme.
import { APPEARANCE_REV_KEY, DEFAULT_APPEARANCE, normalizeAppearance } from './workspace-store.js';

export const APPEARANCE_TIMEOUT_MS = 1500;

export function resolveTheme(appearance, systemDark) {
  const { theme, colorMode } = normalizeAppearance(appearance);
  return { tone: theme, scheme: colorMode === 'system' ? (systemDark ? 'dark' : 'light') : colorMode };
}

export function applyTheme(root, { tone, scheme }) {
  const custom = /^#[0-9a-f]{6}$/i.test(tone);
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

export function startPanelTheme({ api = globalThis.chrome, root = document.documentElement, darkQuery = matchMedia('(prefers-color-scheme: dark)'), timeoutMs } = {}) {
  let appearance = { ...DEFAULT_APPEARANCE };
  let request = 0;
  const apply = () => applyTheme(root, resolveTheme(appearance, darkQuery.matches));
  const refresh = async () => {
    const id = ++request;
    const value = await readAppearance(api, timeoutMs);
    // A slower, older read must not overwrite a newer one; a failed read keeps the last good value.
    if (id !== request || !value) return;
    appearance = normalizeAppearance(value);
    apply();
  };

  apply();
  darkQuery.addEventListener?.('change', apply);
  api?.storage?.onChanged?.addListener?.((changes, area) => {
    if (area === 'session' && changes?.[APPEARANCE_REV_KEY]) void refresh();
  });
  return refresh();
}
