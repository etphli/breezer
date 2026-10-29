// Hidden shortcuts are local preferences, never deletions from history/bookmarks.
export const HIDDEN_SITES_KEY = 'newtab.hiddenSites.v1';
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function shortcutKey(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported shortcut.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export class ShortcutPreferences {
  constructor(api) { this.storage = api?.storage?.local; this.hidden = new Set(); this.queue = Promise.resolve(); }
  async load() {
    const values = await this.storage?.get(HIDDEN_SITES_KEY);
    this.hidden = new Set(Array.isArray(values?.[HIDDEN_SITES_KEY]) ? values[HIDDEN_SITES_KEY].filter(validKey).slice(-500) : []);
    return this;
  }
  change(update) {
    const run = async () => {
      if (!this.storage?.set) throw new Error('Shortcut preferences are unavailable.');
      await this.load(); update(this.hidden);
      const keys = [...this.hidden].slice(-500);
      await this.storage.set({ [HIDDEN_SITES_KEY]: keys }); this.hidden = new Set(keys);
    };
    const operation = this.queue.then(() => globalThis.navigator?.locks?.request
      ? navigator.locks.request('breezer.hidden-shortcuts', run) : run());
    this.queue = operation.catch(() => {}); return operation;
  }
  async hide(url) { const key = await shortcutKey(url); await this.change(set => set.add(key)); return key; }
  async restore(key) { if (!validKey(key)) throw new Error('Invalid shortcut preference.'); await this.change(set => set.delete(key)); }
  async reset() { await this.change(set => set.clear()); }
  async filter(sites) {
    const checked = await Promise.all((Array.isArray(sites) ? sites : []).map(async site => {
      try { return this.hidden.has(await shortcutKey(site.url)) ? null : site; } catch { return null; }
    }));
    return checked.filter(Boolean);
  }
}

export function installShortcutActions({ root, remove }) {
  const list = root.getElementById('sites'), events = new AbortController();
  let menu, menuLink;
  const closeMenu = (focus = false) => { const origin = menuLink; menu?.remove(); menu = null; menuLink = null; if (focus && origin?.isConnected) origin.focus(); };
  const linkAt = target => target.closest?.('.site')?.querySelector('.site-link');
  const hide = link => { closeMenu(); void remove({ url: link.href, title: link.querySelector('.site-name')?.textContent || 'Site' }); };
  list.addEventListener('click', event => {
    const link = linkAt(event.target); if (!link) return;
    if (event.target.closest('.site-remove')) { event.preventDefault(); hide(link); return; }
  }, { signal: events.signal });
  list.addEventListener('contextmenu', event => {
    const link = event.target.closest?.('.site-link'); if (!link) return;
    event.preventDefault(); closeMenu();
    menuLink = link; menu = root.createElement('div'); menu.className = 'shortcut-menu'; menu.setAttribute('role', 'menu');
    const button = root.createElement('button'); button.type = 'button'; button.setAttribute('role', 'menuitem'); button.textContent = 'Remove shortcut'; button.addEventListener('click', () => hide(link)); menu.append(button);
    const bounds = link.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(event.clientX || bounds.left, root.documentElement.clientWidth - 190))}px`;
    menu.style.top = `${Math.max(8, Math.min(event.clientY || bounds.bottom, root.documentElement.clientHeight - 54))}px`;
    root.body.append(menu); button.focus();
  }, { signal: events.signal });
  root.addEventListener('pointerdown', event => { if (menu && !menu.contains(event.target)) closeMenu(); }, { signal: events.signal });
  root.addEventListener('keydown', event => { if (event.key === 'Escape' && menu) { closeMenu(true); } }, { signal: events.signal });
  return () => { closeMenu(); events.abort(); };
}
