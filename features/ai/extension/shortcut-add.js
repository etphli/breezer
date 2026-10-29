import { shortcutUrl } from './top-sites.js';

export function installShortcutAdder({ api, root, preferences, update }) {
  const form = root.getElementById('shortcut-add');
  const input = root.getElementById('shortcut-add-input');
  const list = root.getElementById('shortcut-add-tabs');
  const error = root.getElementById('shortcut-add-error');
  const submit = form.querySelector('[type=submit]');
  let tabs = [], shown = [], active = -1, saving = false, revision = 0;
  const focusTile = () => root.querySelector('.site-add-button')?.focus();
  const paint = () => {
    const query = input.value.trim().toLowerCase();
    shown = tabs.filter(tab => `${tab.title} ${tab.url}`.toLowerCase().includes(query));
    active = -1;
    input.removeAttribute('aria-activedescendant');
    list.replaceChildren(...shown.map((tab, index) => {
      const option = root.createElement('li');
      option.id = `shortcut-tab-${index}`; option.className = 'shortcut-add-tab';
      option.setAttribute('role', 'option'); option.setAttribute('aria-selected', 'false');
      const title = root.createElement('span'), host = root.createElement('span');
      title.textContent = tab.title; host.textContent = new URL(tab.url).hostname;
      host.className = 'shortcut-add-tab-host'; option.append(title, host);
      option.addEventListener('click', () => void save(tab));
      return option;
    }));
    if (!shown.length) {
      const empty = root.createElement('li'); empty.className = 'shortcut-add-empty';
      empty.textContent = query ? 'No matching open tabs.' : 'No other open tabs.'; list.append(empty);
    }
    submit.disabled = saving || !query;
  };
  const save = async site => {
    if (saving) return;
    saving = true; submit.disabled = true;
    try {
      const url = shortcutUrl(site?.url || input.value);
      await preferences.add({ url, title: site?.title });
      await update();
      form.hidePopover(); focusTile();
      root.getElementById('shortcut-status').textContent = 'Shortcut added.';
    } catch (problem) {
      error.textContent = problem.message || 'Could not add shortcut. Try again.';
      error.hidden = false; input.setAttribute('aria-invalid', 'true'); input.focus();
    } finally { saving = false; submit.disabled = !input.value.trim(); }
  };
  form.addEventListener('beforetoggle', event => {
    if (event.newState !== 'open') return;
    input.value = ''; error.hidden = true; input.removeAttribute('aria-invalid');
    tabs = []; paint();
  });
  form.addEventListener('toggle', async event => {
    if (event.newState !== 'open') { revision++; return; }
    const current = ++revision;
    input.focus();
    try {
      const seen = new Set();
      tabs = (await api.tabs.query({})).filter(tab => {
        if (tab.incognito) return false;
        try {
          const url = shortcutUrl(tab.url);
          if (seen.has(url)) return false;
          seen.add(url); return true;
        } catch { return false; }
      }).sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
      if (current === revision) paint();
    } catch {
      if (current === revision) { error.textContent = 'Open tabs could not load. You can still type a URL.'; error.hidden = false; }
    }
  });
  input.addEventListener('input', () => { error.hidden = true; input.removeAttribute('aria-invalid'); paint(); });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (['ArrowDown', 'ArrowUp'].includes(event.key) && shown.length) {
      event.preventDefault();
      active = active < 0 ? (event.key === 'ArrowDown' ? 0 : shown.length - 1)
        : (active + (event.key === 'ArrowDown' ? 1 : -1) + shown.length) % shown.length;
      [...list.children].forEach((node, index) => node.setAttribute('aria-selected', String(index === active)));
      input.setAttribute('aria-activedescendant', list.children[active].id);
      list.children[active].scrollIntoView({ block: 'nearest' }); submit.disabled = false;
    }
  });
  form.addEventListener('submit', event => { event.preventDefault(); void save(shown[active]); });
}
