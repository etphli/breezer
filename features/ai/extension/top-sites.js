// Hidden shortcuts are local preferences, never deletions from history/bookmarks.
export const HIDDEN_SITES_KEY = 'newtab.hiddenSites.v1';
export const CUSTOM_SITES_KEY = 'newtab.customSites.v1';
export function shortcutUrl(value) {
  const input = String(value || '').trim();
  if (!input || /\s/.test(input)) throw new Error('Enter a web address like example.com.');
  const hasScheme = /^[a-z][a-z\d+.-]*:/i.test(input) && !/^[^/]+:\d+(?:\/|$)/.test(input);
  const url = new URL(hasScheme ? input : `https://${input}`);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || (!url.hostname.includes('.') && !['localhost', '[::1]'].includes(url.hostname))) throw new Error('Enter a web address like example.com.');
  return url.href;
}
const validKey = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export async function shortcutKey(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('Unsupported shortcut.');
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(url.href));
  return [...new Uint8Array(digest)].map(value => value.toString(16).padStart(2, '0')).join('');
}
export class ShortcutPreferences {
  constructor(api) { this.storage = api?.storage?.local; this.hidden = new Set(); this.custom = []; this.queue = Promise.resolve(); }
  async load() {
    const values = await this.storage?.get(HIDDEN_SITES_KEY);
    this.hidden = new Set(Array.isArray(values?.[HIDDEN_SITES_KEY]) ? values[HIDDEN_SITES_KEY].filter(validKey).slice(-500) : []);
    const saved = await this.storage?.get(CUSTOM_SITES_KEY);
    const seen = new Set();
    this.custom = (Array.isArray(saved?.[CUSTOM_SITES_KEY]) ? saved[CUSTOM_SITES_KEY] : []).flatMap(site => {
      try {
        const url = shortcutUrl(site.url);
        if (seen.has(url)) return [];
        seen.add(url);
        return [{ url, title: typeof site.title === 'string' ? site.title.slice(0, 60) : new URL(url).hostname }];
      } catch { return []; }
    }).slice(-100);
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
  add(site) {
    const run = async () => {
      if (!this.storage?.set) throw new Error('Shortcut preferences are unavailable.');
      const url = shortcutUrl(site.url), key = await shortcutKey(url);
      await this.load();
      if ((await this.filter([])).length >= 8 && !this.custom.some(item => item.url === url)) throw new Error('Remove a saved shortcut before adding another.');
      this.custom = [...this.custom.filter(item => item.url !== url), { url, title: String(site.title || new URL(url).hostname).slice(0, 60) }].slice(-100);
      this.hidden.delete(key);
      await this.storage.set({ [CUSTOM_SITES_KEY]: this.custom, [HIDDEN_SITES_KEY]: [...this.hidden] });
    };
    const operation = this.queue.then(() => globalThis.navigator?.locks?.request ? navigator.locks.request('breezer.hidden-shortcuts', run) : run());
    this.queue = operation.catch(() => {});
    return operation;
  }
  async filter(sites, limit = Infinity) {
    const customUrls = new Set(this.custom.map(site => site.url));
    const combined = [...(Array.isArray(sites) ? sites : []).filter(site => !customUrls.has(site.url)), ...this.custom];
    const checked = await Promise.all(combined.map(async site => {
      try { return this.hidden.has(await shortcutKey(site.url)) ? null : site; } catch { return null; }
    }));
    const visible = checked.filter(Boolean);
    const saved = visible.filter(site => customUrls.has(site.url)).slice(-limit);
    return [...visible.filter(site => !customUrls.has(site.url)).slice(0, Math.max(0, limit - saved.length)), ...saved];
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
