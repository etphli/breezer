// Category navigation and search for the settings page (workspace.html#/settings/<category>).
// The search index is read from the rendered page, so settings mounted by feature modules
// are found by their headings, labels, descriptions, buttons and data-search-terms.

export const NATIVE_SETTINGS_URL = 'chrome://settings/';
export const DEFAULT_CATEGORY = 'general';
const RESULT_LIMIT = 24;

export function categoryFromHash(hash) {
  const match = /^#\/settings\/([a-z][a-z0-9-]*)/.exec(String(hash || ''));
  return match ? match[1] : null;
}

export function normalizeText(text) {
  return String(text || '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
}

// Every query word must match somewhere. Title matches outrank keywords, the category name
// and descriptions; word starts outrank matches inside a word.
export function rankEntries(entries, query, limit = RESULT_LIMIT) {
  const words = normalizeText(query).split(' ').filter(Boolean);
  if (!words.length) return [];
  const whole = words.join(' ');
  const ranked = [];
  entries.forEach((entry, order) => {
    const fields = {
      title: ` ${normalizeText(entry.title)}`,
      terms: ` ${normalizeText(entry.terms)}`,
      category: ` ${normalizeText(entry.categoryLabel)}`,
      description: ` ${normalizeText(entry.description)}`,
    };
    let score = 0;
    for (const word of words) {
      const start = (field) => fields[field].includes(` ${word}`);
      const inside = (field) => fields[field].includes(word);
      if (start('title')) score += 8;
      else if (inside('title')) score += 5;
      else if (start('terms')) score += 4;
      else if (start('category')) score += 3;
      else if (start('description')) score += 2;
      else if (inside('terms') || inside('description')) score += 1;
      else return;
    }
    if (fields.title.trim() === whole) score += 10;
    else if (fields.title.trim().startsWith(whole)) score += 4;
    if (entry.kind === 'category') score += 2;
    if (entry.kind === 'native') score -= 1;
    ranked.push({ entry, score, order });
  });
  ranked.sort((a, b) => b.score - a.score || a.order - b.order);
  return ranked.slice(0, limit).map(({ entry }) => entry);
}

// Results grouped by category; groups appear in the order of their best result.
export function groupResults(results) {
  const groups = new Map();
  for (const entry of results) {
    const key = entry.kind === 'native' ? 'native' : entry.category;
    if (!groups.has(key)) groups.set(key, { key, label: entry.kind === 'native' ? 'Browser settings' : entry.categoryLabel, entries: [] });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()];
}

// Text of a label without its <small> description.
function ownText(node) {
  let text = '';
  for (const child of node.childNodes) {
    if (child.nodeType === 3) text += child.textContent;
    else if (child.nodeType === 1 && child.tagName !== 'SMALL') text += ownText(child);
  }
  return text.replace(/\s+/g, ' ').trim();
}

const clean = (text) => String(text || '').replace(/\s+/g, ' ').trim();
const terms = (node) => node?.getAttribute?.('data-search-terms') || '';
// Hidden inside its page (pages themselves are hidden while results show).
const hiddenIn = (node, page) => { for (let at = node; at && at !== page; at = at.parentElement) if (at.hidden) return true; return false; };

export function collectEntries(root, categories) {
  const entries = [];
  for (const page of root.querySelectorAll('.settings-page[data-page]')) {
    const category = page.dataset.page;
    const info = categories.get(category);
    if (!info || !info.available()) continue;
    const base = { category, categoryLabel: info.label };
    const add = (entry) => { if (entry.title) entries.push({ ...base, ...entry }); };
    const seen = new Set();
    add({ kind: 'category', title: info.label, description: '', terms: '', target: page });
    for (const section of page.querySelectorAll('.settings-section, .onboarding')) {
      const heading = section.querySelector('h2');
      if (!heading || hiddenIn(section, page)) continue;
      const mount = section.parentElement?.closest('[data-search-terms]');
      add({
        kind: 'section', title: clean(heading.textContent),
        description: clean(section.querySelector('.section-note, .onboarding-intro')?.textContent),
        terms: `${terms(section)} ${mount && page.contains(mount) ? terms(mount) : ''}`, target: section,
      });
      seen.add(heading);
    }
    for (const row of page.querySelectorAll('.setting-row, .key-field')) {
      if (hiddenIn(row, page)) continue;
      const label = row.querySelector('.setting-label, label');
      if (!label) continue;
      add({ kind: 'setting', title: ownText(label), description: clean(label.querySelector('small')?.textContent), currentValue: clean(row.querySelector('.segmented [aria-checked="true"]')?.textContent), terms: terms(row), target: row });
    }
    // Actions and disclosures that are not inside a row, such as the password manager links.
    for (const item of page.querySelectorAll('button.text-button, summary, [data-search-item]')) {
      if (item.closest('.setting-row, .link-list') || hiddenIn(item, page) || seen.has(item)) continue;
      add({ kind: 'setting', title: clean(item.textContent), description: '', terms: terms(item), target: item });
    }
    for (const item of page.querySelectorAll('.link-list li')) {
      const button = item.querySelector('[data-url]');
      if (!button) continue;
      entries.push({
        kind: 'native', category, categoryLabel: info.label, title: clean(button.textContent),
        description: clean(item.querySelector('small')?.textContent), terms: terms(item), target: button,
      });
    }
  }
  return entries;
}

export function mountSettingsNav({ api, document: doc = globalThis.document, location: loc = globalThis.location }) {
  const $ = (id) => doc.getElementById(id);
  const root = $('settings');
  const nav = $('settings-categories');
  const search = $('settings-search');
  const results = $('settings-results');
  const status = $('settings-search-status');
  const crumb = $('settings-crumb');
  const scroller = $('settings-scroll');
  const pages = new Map([...root.querySelectorAll('.settings-page[data-page]')].map((page) => [page.dataset.page, page]));
  const links = [...nav.querySelectorAll('a.nav-item[data-category]')];
  const native = $('open-native-settings');
  const categorySelect = $('settings-category-select');
  const categories = new Map(links.map((link) => {
    const page = pages.get(link.dataset.category);
    const available = () => Boolean(page) && (!page.hasAttribute('data-optional') || page.querySelector('[id] > *') !== null);
    return [link.dataset.category, { label: clean(link.textContent), link, page, available }];
  }));
  for (const [value, category] of categories) {
    const option = doc.createElement('option');
    option.value = value; option.textContent = category.label;
    categorySelect.append(option);
  }
  const allSettings = doc.createElement('option');
  allSettings.value = 'all'; allSettings.textContent = 'All browser settings';
  categorySelect.append(allSettings);
  const reduceMotion = () => Boolean(globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches);
  let current = null;
  let options = [];
  let active = -1;
  let flash = null;

  function refreshAvailability() {
    for (const { link, available } of categories.values()) link.closest('li').hidden = !available();
    for (const option of categorySelect.options) if (categories.has(option.value)) option.hidden = !categories.get(option.value).available();
    if (current && !categories.get(current)?.available()) show(DEFAULT_CATEGORY);
    if (searching()) render();
  }

  function show(category, { scrollTop = true } = {}) {
    const next = categories.get(category)?.available() ? category : DEFAULT_CATEGORY;
    current = next;
    categorySelect.value = next;
    for (const [name, page] of pages) page.hidden = name !== next || searching();
    for (const [name, { link }] of categories) {
      const selected = name === next;
      if (selected) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
      link.tabIndex = selected ? 0 : -1;
    }
    native.tabIndex = -1;
    // Desktop navigation keeps the selected category in view; narrow windows use the select.
    categories.get(next).link.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
    crumb.textContent = searching() ? 'Search' : categories.get(next).label;
    doc.title = searching() ? 'Settings' : `${categories.get(next).label} – Settings`;
    if (scrollTop && scroller) scroller.scrollTop = 0;
  }

  const searching = () => search.value.trim() !== '';

  // ------------------------------------------------------------ categories

  // Shows the page now; the hash records it for Back, Forward and reloads.
  function navigate(category) {
    show(category);
    const hash = `#/settings/${current}`;
    if (loc && loc.hash !== hash) loc.hash = hash;
  }
  categorySelect.addEventListener('change', () => {
    const category = categorySelect.value;
    if (category === 'all') { categorySelect.value = current; void openNativeSettings(); }
    else { if (searching()) clearSearch(); navigate(category); }
  });

  nav.addEventListener('click', (event) => {
    const link = event.target.closest('a.nav-item[data-category]');
    if (!link) return;
    event.preventDefault();
    if (searching()) clearSearch();
    navigate(link.dataset.category);
  });

  // Arrow keys move between visible categories (roving tabindex), as in a native sidebar.
  nav.addEventListener('keydown', (event) => {
    const items = [...nav.querySelectorAll('.nav-item')].filter((item) => !item.closest('li')?.hidden);
    const at = items.indexOf(event.target.closest('.nav-item'));
    if (at < 0) return;
    const target = { ArrowDown: at + 1, ArrowUp: at - 1, Home: 0, End: items.length - 1 }[event.key];
    if (target === undefined) return;
    event.preventDefault();
    const next = items[(target + items.length) % items.length];
    for (const item of items) item.tabIndex = item === next ? 0 : -1;
    next.focus();
  });
  nav.addEventListener('focusout', (event) => {
    if (nav.contains(event.relatedTarget)) return;
    // Leaving the list resets the tab stop to the selected category.
    for (const [name, { link }] of categories) link.tabIndex = name === current ? 0 : -1;
    native.tabIndex = -1;
  });

  globalThis.addEventListener?.('hashchange', () => {
    const category = categoryFromHash(loc?.hash) || DEFAULT_CATEGORY;
    if (category === current) return;
    if (searching()) clearSearch();
    show(category);
  });

  // ------------------------------------------------------------ Other: native settings

  async function openNativeSettings() {
    const error = $('native-settings-error');
    error.hidden = true;
    try {
      // Same tab, like moving between categories. Back returns to these settings. The browser only
      // redirects the Settings command to this page, never a chrome://settings/ navigation, so this
      // cannot loop.
      const tab = await api?.tabs?.getCurrent?.();
      if (tab?.id !== undefined && api.tabs.update) await api.tabs.update(tab.id, { url: NATIVE_SETTINGS_URL });
      else if (api?.tabs?.create) await api.tabs.create({ url: NATIVE_SETTINGS_URL });
      else throw new Error('Open this page in Breezer to continue.');
    } catch (failure) {
      error.textContent = `Couldn’t open browser settings. ${failure instanceof Error ? failure.message : String(failure)} Enter chrome://settings/ in the address bar instead.`;
      error.hidden = false;
    }
  }
  native.addEventListener('click', () => void openNativeSettings());

  // ------------------------------------------------------------ search

  const node = (tag, className, text) => {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    if (text) element.textContent = text;
    return element;
  };

  function setActive(index) {
    options.forEach((option, at) => option.setAttribute('aria-selected', String(at === index)));
    active = index;
    if (index < 0) { search.removeAttribute('aria-activedescendant'); return; }
    search.setAttribute('aria-activedescendant', options[index].id);
    options[index].scrollIntoView?.({ block: 'nearest' });
  }

  function render() {
    const query = search.value.trim();
    const open = query !== '';
    search.setAttribute('aria-expanded', String(open));
    results.hidden = !open;
    root.classList.toggle('is-searching', open);
    show(current, { scrollTop: false });
    options = [];
    active = -1;
    if (!open) { results.replaceChildren(); status.textContent = ''; search.removeAttribute('aria-activedescendant'); return; }

    const found = rankEntries(collectEntries(root, categories), query);
    const fragment = [];
    let index = 0;
    const option = (entry, title, description, meta) => {
      const item = node('div', `result${entry.kind === 'native' ? ' is-native' : ''}`);
      item.id = `settings-result-${index++}`;
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', 'false');
      const text = node('span', 'result-text');
      text.append(node('span', 'result-title', title));
      if (description) text.append(node('span', 'result-description', description));
      item.append(text);
      if (meta) item.append(node('span', 'result-meta', meta));
      const cue = node('span', 'result-action');
      cue.setAttribute('aria-hidden', 'true');
      item.append(cue);
      item.addEventListener('pointerdown', (event) => event.preventDefault()); // keep focus in the field
      item.addEventListener('click', () => activate(entry));
      options.push(item);
      return item;
    };
    const head = (label, id) => { const heading = node('div', 'results-heading', label); heading.id = id; return heading; };

    if (!found.length) {
      const empty = node('div', 'results-empty');
      empty.append(node('p', 'results-empty-title', `No Breezer settings match “${query}”.`),
        node('p', 'results-empty-note', 'Try a shorter word, or search all browser settings.'));
      fragment.push(empty);
    }
    groupResults(found).forEach((group, groupIndex) => {
      const wrap = node('div', 'results-group');
      wrap.setAttribute('role', 'group');
      const id = `settings-results-group-${groupIndex}`;
      wrap.setAttribute('aria-labelledby', id);
      wrap.append(head(group.label, id));
      for (const entry of group.entries) {
        const title = entry.kind === 'category' ? `All ${entry.title} settings` : entry.title;
        wrap.append(option(entry, title, entry.description, entry.kind === 'native' ? 'Opens in a new tab' : entry.currentValue));
      }
      fragment.push(wrap);
    });
    // Always offer Chromium's own search for whatever was typed.
    const fallback = node('div', 'results-group');
    fallback.setAttribute('role', 'group');
    fallback.setAttribute('aria-labelledby', 'settings-results-native');
    fallback.append(head('All browser settings', 'settings-results-native'),
      option({ kind: 'native-search', query }, `Search browser settings for “${query}”`, '', 'Opens in a new tab'));
    fragment.push(fallback);
    results.replaceChildren(...fragment);
    status.textContent = found.length
      ? `${found.length} ${found.length === 1 ? 'result' : 'results'}. Use the arrow keys to choose one.`
      : `No Breezer settings match ${query}. Press Enter to search browser settings.`;
    setActive(found.length ? 0 : options.length - 1);
  }

  function clearSearch() {
    search.value = '';
    render();
  }

  async function openBeside(url) {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    await api.tabs.create({ url, ...(tab ? { index: tab.index + 1, windowId: tab.windowId } : {}) });
  }

  function activate(entry) {
    if (entry.kind === 'native-search') {
      void openBeside(`${NATIVE_SETTINGS_URL}?search=${encodeURIComponent(entry.query)}`).catch(() => {
        status.textContent = 'Couldn’t open browser settings.';
      });
      return;
    }
    if (entry.kind === 'native') {
      // The Browser settings rows own opening and error reporting.
      entry.target.click();
      return;
    }
    clearSearch();
    navigate(entry.category);
    reveal(entry.target);
  }

  // Scroll to a setting, focus its control and briefly highlight it.
  function reveal(target) {
    if (target.classList.contains('settings-page')) { $('settings-title').focus(); return; }
    target.scrollIntoView?.({ block: 'center', behavior: reduceMotion() ? 'auto' : 'smooth' });
    const usable = (item) => !item.disabled && !hiddenIn(item, target);
    // A radio group takes focus on its checked option, as Tab would.
    const control = [...target.querySelectorAll('[role="radio"][aria-checked="true"]')].find(usable)
      || [...target.querySelectorAll('button:not([role="radio"]), [role="radio"], input, select, textarea, summary, a[href]')].find(usable)
      || (target.matches('button, summary, input') ? target : null);
    if (control) control.focus({ preventScroll: true });
    else { target.tabIndex = -1; target.focus({ preventScroll: true }); }
    clearTimeout(flash?.timer);
    flash?.target.classList.remove('search-hit');
    target.classList.add('search-hit');
    flash = { target, timer: setTimeout(() => target.classList.remove('search-hit'), 1600) };
  }

  search.addEventListener('input', render);
  search.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      if (searching()) { event.preventDefault(); clearSearch(); }
      return;
    }
    if (!options.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((active + step + options.length) % options.length);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      options[active].click();
    }
  });

  // "/" jumps to search unless the user is typing somewhere.
  doc.addEventListener('keydown', (event) => {
    if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
    const target = event.target;
    if (target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
    event.preventDefault();
    search.focus();
    search.select?.();
  });

  refreshAvailability();
  show(categoryFromHash(loc?.hash) || DEFAULT_CATEGORY);
  return Object.freeze({
    open: navigate,
    refreshAvailability,
    get category() { return current; },
  });
}
