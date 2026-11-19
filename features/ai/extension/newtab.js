import { localStorageChanges } from './storage-events.js';
import { installShortcutAdder } from './shortcut-add.js';
import { ShortcutPreferences, installShortcutActions, HIDDEN_SITES_KEY, CUSTOM_SITES_KEY } from './top-sites.js';
// Breezer new tab: one row of frequently visited sites and what's coming up in
// Organato: one Upcoming list (exams and assignments together) and To-dos.
// The page asks the background over a 'breezer-newtab' port once on load and
// again only when the Refresh button is pressed; the background owns persistence and every HTTP call.
// Everything received is untrusted: text goes in with textContent and only
// http(s) URLs become links.
import { startPanelTheme } from './panel-theme.js';
// Applied AI theme artwork paints behind the page in a sandboxed, inert frame.
import { startThemeArtwork } from './browser-theme.js';
import { HAS_NATIVE_HELPER } from './platform.js';

export const PORT_NAME = 'breezer-newtab';
export const REQUEST_TIMEOUT_MS = 65000;
export const MAX_SITES = 8;
export const MAX_ITEMS = { upcoming: 8, todos: 6 };
export const SETTINGS_URL = 'workspace.html#/settings';
// The background's local copy of the Organato switches (background.js keeps the
// same name). Reading it lets an open new tab follow Settings and setup at once.
export const ORGANATO_SWITCHES_KEY = 'organato.switches.v1';
const LISTS = ['upcoming', 'todos'];
const TEXT_LIMIT = 200;
const DAY_MS = 86400000;

const text = (value, limit = TEXT_LIMIT) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '');

export function safeUrl(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

export function siteLabel({ title, url }) {
  const name = text(title, 60);
  if (name) return name;
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return url; }
}

// Date-only values ("2026-10-30") are local calendar days, never UTC midnight.
export function parseDue(value) {
  if (typeof value !== 'string' || !value) return null;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  const date = day ? new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3])) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

const midnight = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
export const daysUntil = (due, now) => Math.round((midnight(due) - midnight(now)) / DAY_MS);

export function relativeDay(days) {
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days === -1) return 'Due yesterday';
  if (days < 0) return `${-days} days overdue`;
  return `In ${days} days`;
}

export function urgency(days) {
  if (days == null) return 'none';
  if (days < 0) return 'overdue';
  if (days === 0) return 'today';
  return days <= 3 ? 'soon' : 'later';
}

// Organato's own ID, or null when there is none. Only a real ID can say two
// rows are the same item; matching titles never do.
const stableId = (raw) => (typeof raw?.id === 'string' || Number.isFinite(raw?.id) ? text(String(raw.id), 80) || null : null);

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title);
  if (!title) return null;
  const allDay = raw.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(raw.dueAt ?? '');
  return { id: stableId(raw), title, due: parseDue(raw.dueAt), allDay, subject: text(raw.subject, 60) || null, url: safeUrl(raw.url), exam: false };
}

// Builds one list from several arrays, keeping the first copy of each ID.
// Rows from an array marked `exam` (or repeats of them) are tagged as exams.
function collect(sources, skip = new Set()) {
  const byId = new Map();
  const items = [];
  for (const { value, exam = false } of sources) {
    for (const raw of Array.isArray(value) ? value : []) {
      const item = normalizeItem(raw);
      if (!item || (item.id && skip.has(item.id))) continue;
      const known = item.id && byId.get(item.id);
      if (known) { known.exam ||= exam; continue; }
      item.exam = exam;
      if (item.id) byId.set(item.id, item);
      items.push(item);
    }
  }
  return sortByDue(items);
}

function sortByDue(items) {
  // Soonest first; undated items keep their given order at the end.
  return items
    .map((item, order) => ({ item, order }))
    .sort((a, b) => ((a.item.due?.getTime() ?? Infinity) - (b.item.due?.getTime() ?? Infinity)) || (a.order - b.order))
    .map(({ item }) => item);
}

export function normalizeView(raw) {
  const seen = new Set();
  const topSites = [];
  for (const site of Array.isArray(raw?.topSites) ? raw.topSites : []) {
    const url = safeUrl(site?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    topSites.push({ url, title: siteLabel({ title: site.title, url }) });
    if (topSites.length === MAX_SITES) break;
  }
  const source = raw?.organato && typeof raw.organato === 'object' ? raw.organato : {};
  // Organato is on unless the background explicitly says it was turned off. Off
  // never carries account state or items, even if an older answer included them.
  if (source.enabled === false) return { topSites, organato: { enabled: false, connected: false, error: null, todos: [], upcoming: [] } };
  const organato = {
    enabled: true,
    connected: source.connected === true,
    error: text(source.error, 240) || null,
    stale: source.stale === true,
    updatedAt: Number.isFinite(source.updatedAt) ? source.updatedAt : null,
    cached: source.cached === true,
    syncedAt: typeof source.syncedAt === 'string' && Number.isFinite(Date.parse(source.syncedAt)) ? source.syncedAt : null,
  };
  // The background still sends exams and assignments separately, and an item
  // classified as both arrives in each. They become one Upcoming list here,
  // shown once per Organato ID. To-dos stay on their own and never repeat in
  // Upcoming, whether they are recognised by ID or by `kind: 'todo'`.
  organato.todos = collect([{ value: source.todos }]);
  const todoIds = new Set(organato.todos.map((item) => item.id).filter(Boolean));
  const work = (value) => (Array.isArray(value) ? value.filter((raw) => raw?.kind !== 'todo') : []);
  organato.upcoming = collect([{ value: work(source.exams), exam: true }, { value: work(source.assignments) }], todoIds);
  return { topSites, organato };
}

export function organatoState(organato) {
  if (!organato) return 'unavailable';
  if (!organato.enabled) return 'disabled';
  const hasItems = LISTS.some((list) => organato[list].length);
  if (organato.error && !hasItems && !organato.stale && !organato.cached) return 'error';
  if (!organato.connected && !hasItems) return 'setup';
  return 'ready';
}

// Saved data can arrive before the final live answer. Keep the port open until
// that final answer, a disconnect or the timeout.
export function requestView(api, { refresh = false, timeoutMs = REQUEST_TIMEOUT_MS, onUpdate = () => {}, onSites } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof api?.runtime?.connect !== 'function') {
      reject(new Error('Breezer is not available on this page.'));
      return;
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let port = null;
    let settled = false;
    let updates = Promise.resolve();
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { port?.disconnect(); } catch { /* already closed */ }
      fn(value);
    };
    const timer = setTimeout(() => finish(reject, new Error('Breezer took too long to answer.')), timeoutMs);
    try {
      port = api.runtime.connect({ name: PORT_NAME });
      port.onMessage.addListener((message) => {
        if (settled || message?.id !== id || !['sites', 'view'].includes(message.type)) return;
        if (message.type === 'sites' || message.pending === true) {
          updates = updates.then(() => {
            if (!settled) return message.type === 'sites' ? onSites?.(message.topSites) : onUpdate(message);
          });
          void updates.catch(error => finish(reject, error));
        } else {
          void updates.then(() => finish(resolve, message), error => finish(reject, error));
        }
      });
      port.onDisconnect.addListener(() => finish(reject, new Error('Breezer closed the connection.')));
      port.postMessage({ type: 'view', id, refresh, ...(onSites ? { earlySites: true } : {}) });
    } catch (error) {
      finish(reject, error);
    }
  });
}

// ------------------------------------------------------------------ rendering

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

function faviconUrl(api, url, retry = false) {
  const canFavicon = api?.runtime?.getManifest?.().permissions?.includes('favicon');
  return canFavicon && typeof api.runtime.getURL === 'function'
    ? api.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=64${retry ? `&retry=${Date.now()}` : ''}`)
    : null;
}

const FAVICON_CACHE_KEY = 'newtab.icons.v1';
const FAVICON_SIZE = 64;
const FAVICON_MAX_LENGTH = 32 * 1024;
const FAVICON_TTL_MS = 15 * 60 * 1000;

function createFaviconCache(api) {
  const storage = api?.storage?.session;
  const icons = new Map();
  const dirty = new Map();
  let saveTimer, defaultPng;
  const read = async () => {
    const values = await storage?.get(FAVICON_CACHE_KEY);
    const saved = values?.[FAVICON_CACHE_KEY];
    const entries = Array.isArray(saved) ? saved.slice(-MAX_SITES).filter(Boolean) : [];
    return entries.filter(({ url, png, expires }) =>
      typeof url === 'string' && url.length <= 4096 && typeof png === 'string'
          && png.length <= FAVICON_MAX_LENGTH && png.startsWith('data:image/png;base64,iVBORw0KGgo')
          && expires > Date.now());
  };
  const remember = (cache, entry) => {
    cache.delete(entry.url);
    cache.set(entry.url, entry);
    if (cache.size > MAX_SITES) cache.delete(cache.keys().next().value);
  };
  const rasterize = img => {
    const canvas = img.ownerDocument.createElement('canvas');
    canvas.width = canvas.height = FAVICON_SIZE;
    canvas.getContext('2d').drawImage(img, 0, 0, FAVICON_SIZE, FAVICON_SIZE);
    return canvas.toDataURL('image/png');
  };
  const readDefault = async doc => {
    // Chromium serves a theme-dependent generic bitmap when no site icon is known.
    const img = doc.createElement('img');
    img.src = faviconUrl(api, 'about:blank');
    await img.decode();
    return rasterize(img);
  };
  const flush = async () => {
    saveTimer = undefined;
    const batch = [...dirty.values()];
    dirty.clear();
    const write = async () => {
      const shared = new Map((await read()).map(entry => [entry.url, entry]));
      for (const entry of batch) remember(shared, entry);
      await storage.set({ [FAVICON_CACHE_KEY]: [...shared.values()] });
    };
    const locks = globalThis.navigator?.locks;
    if (locks) await locks.request(FAVICON_CACHE_KEY, write);
    else await write();
  };
  return {
    ready: read().then(entries => { for (const entry of entries) remember(icons, entry); }).catch(() => {}),
    get(url) {
      const icon = icons.get(url);
      return icon?.expires > Date.now() ? icon.png : null;
    },
    async save(url, img) {
      if (!storage?.set || url.length > 4096) return;
      try {
        const png = rasterize(img);
        if (png.length > FAVICON_MAX_LENGTH) return;
        defaultPng ??= readDefault(img.ownerDocument);
        if (png === await defaultPng) return;
        const entry = { url, png, expires: Date.now() + FAVICON_TTL_MS };
        remember(icons, entry);
        remember(dirty, entry);
      } catch { return; }
      if (saveTimer) return;
      saveTimer = setTimeout(() => void flush().catch(() => {}), 30);
    },
  };
}

function siteTile(api, site, favicons, retryIcons) {
  const item = el('li', 'site');
  const link = el('a', 'site-link', { href: site.url, title: `${site.title}\n${site.url}` });
  const icon = el('span', 'site-icon', { 'aria-hidden': 'true' });
  const monogram = el('span', 'site-monogram');
  monogram.textContent = [...site.title.replace(/[^\p{L}\p{N}]/gu, '')].slice(0, 2).join('').toUpperCase() || '?';
  icon.append(monogram);
  const src = faviconUrl(api, site.url, retryIcons);
  if (src) {
    const img = el('img', '', { alt: '', width: '28', height: '28', decoding: 'sync' });
    let cached = favicons?.get(site.url);
    img.addEventListener('load', () => {
      icon.classList.add('has-icon');
      if (!cached) void favicons?.save(site.url, img);
    }, { once: true });
    img.addEventListener('error', () => {
      if (cached) { cached = null; img.src = src; }
      else img.remove();
    });
    img.src = cached || src;
    if (img.complete && img.naturalWidth) icon.classList.add('has-icon');
    icon.append(img);
  }
  const name = el('span', 'site-name');
  name.textContent = site.title;
  if (site.title.toLowerCase().replace(/^www\./, '') === new URL(site.url).hostname.replace(/^www\./, '')) name.classList.add('hostname');
  link.append(icon, name);
  const remove = el('button', 'site-remove', { type: 'button', title: 'Remove shortcut', 'aria-label': `Remove ${site.title} shortcut` });
  remove.textContent = '×';
  item.append(link, remove);
  return item;
}

export function renderSites(api, root, sites, favicons, retryIcons) {
  const list = root.getElementById('sites');
  list.replaceChildren(...sites.map(site => siteTile(api, site, favicons, retryIcons)));
  const add = el('li', 'site site-add');
  const button = el('button', 'site-link site-add-button', { type: 'button', popovertarget: 'shortcut-add', 'aria-haspopup': 'dialog' });
  const icon = el('span', 'site-icon', { 'aria-hidden': 'true' }); icon.textContent = '+';
  const label = el('span', 'site-name'); label.textContent = 'Add shortcut';
  button.append(icon, label); add.append(button); list.append(add);
  list.removeAttribute('aria-busy');
  list.hidden = false;
  root.getElementById('sites-empty').hidden = Boolean(sites.length);
}

function renderPlaceholders(root) {
  const list = root.getElementById('sites');
  list.replaceChildren(...Array.from({ length: MAX_SITES }, () => {
    const item = el('li', 'site placeholder', { 'aria-hidden': 'true' });
    item.append(el('span', 'site-icon'), el('span', 'site-name'));
    return item;
  }));
}

const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'short' });
const monthDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
const clock = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const longDate = new Intl.DateTimeFormat(undefined, { weekday: 'long', day: 'numeric', month: 'long' });

function itemRow(item, now) {
  const days = item.due ? daysUntil(item.due, now) : null;
  const row = el('li', 'item', { 'data-urgency': urgency(days) });

  const stub = el('span', 'stub', { 'aria-hidden': 'true' });
  const day = el('span', 'stub-day');
  const week = el('span', 'stub-week');
  if (item.due) {
    day.textContent = String(item.due.getDate());
    week.textContent = weekday.format(item.due);
  }
  stub.append(day, week);

  const body = el('span', 'item-body');
  const title = item.url ? el('a', 'item-title', { href: item.url }) : el('span', 'item-title');
  title.textContent = item.title;
  const meta = el('span', 'item-meta');
  if (item.due) {
    const when = el('time', 'item-when', { datetime: item.due.toISOString() });
    const parts = [relativeDay(days)];
    if (Math.abs(days) > 1) parts.push(monthDay.format(item.due));
    if (!item.allDay) parts.push(clock.format(item.due));
    when.textContent = parts.join(', ');
    meta.append(when);
  } else {
    const when = el('span', 'item-when');
    when.textContent = 'No due date';
    meta.append(when);
  }
  if (item.exam) {
    const kind = el('span', 'item-kind');
    kind.textContent = 'Exam';
    meta.append(kind);
  }
  if (item.subject) {
    const subject = el('span', 'item-subject');
    subject.textContent = item.subject;
    meta.append(subject);
  }
  body.append(title, meta);
  row.append(stub, body);
  return row;
}

const EMPTY = { upcoming: 'No exams or assignments coming up.', todos: 'Nothing on your to-do list.' };

function settingsLink(label) {
  const link = el('a', 'action-link', { href: SETTINGS_URL });
  link.textContent = label;
  return link;
}

export function renderOrganato(root, organato, now = new Date(), problem = null) {
  const section = root.getElementById('organato');
  const status = root.getElementById('organato-status');
  const action = root.getElementById('organato-action');
  const lanes = root.getElementById('organato-lists');
  const state = organatoState(organato);
  const error = /\b401\b/.test(organato?.error || '') ? 'The API key was rejected. Review it in Settings.' : organato?.error;
  section.dataset.state = state;
  section.dataset.stale = String(state === 'ready' && Boolean(organato.cached || organato.stale || organato.error || problem));
  section.removeAttribute('aria-busy');
  action.replaceChildren();
  action.hidden = true;
  lanes.hidden = state !== 'ready';
  status.hidden = false;

  if (state === 'unavailable') {
    status.textContent = `${problem || 'Breezer could not load this section.'} Press Refresh to try again.`;
    return;
  }
  if (state === 'disabled') {
    // The page hides the whole sheet; nothing here should be read out or focused.
    status.textContent = '';
    for (const list of root.querySelectorAll('[data-list]')) list.replaceChildren();
    for (const count of root.querySelectorAll('[data-count]')) count.textContent = '';
    return;
  }
  if (state === 'setup') {
    status.textContent = 'Connect Organato to see your upcoming exams, assignments and to-dos here.';
    action.append(settingsLink('Add your Organato API key in Settings'));
    action.hidden = false;
    return;
  }
  if (state === 'error') {
    status.textContent = `Organato did not load: ${error}`;
    action.append(settingsLink('Review Organato in Settings'));
    action.hidden = false;
    return;
  }

  // Ready. A refresh error with older items still on hand keeps them visible.
  if (organato.cached) {
    const saved = organato.syncedAt ? ` from ${new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(organato.syncedAt))}` : '';
    status.textContent = `Showing saved data${saved}. ${organato.error || problem ? 'Could not refresh Organato. Try Refresh on a working connection.' : 'Refreshing…'}`;
  } else if (organato.stale) status.textContent = `Showing the last update${organato.updatedAt !== null ? ` (${new Date(organato.updatedAt).toLocaleString()})` : ''}. ${error || problem || 'Organato did not refresh.'}`;
  else if (organato.error) status.textContent = `Showing the last update. ${error}`;
  else if (problem) status.textContent = `Showing the last update. ${problem}`;
  else status.hidden = true;
  for (const list of LISTS) {
    const items = organato[list];
    const target = lanes.querySelector(`[data-list="${list}"]`);
    const limit = MAX_ITEMS[list];
    const shown = items.slice(0, limit).map((item) => itemRow(item, now));
    if (!items.length) {
      const empty = el('li', 'item-empty');
      empty.textContent = EMPTY[list];
      shown.push(empty);
    } else if (items.length > limit) {
      const more = el('li', 'item-more');
      more.textContent = `${items.length - limit} more in Organato`;
      shown.push(more);
    }
    target.replaceChildren(...shown);
    lanes.querySelector(`[data-count="${list}"]`).textContent = items.length ? String(items.length) : '';
  }
}

// Off removes the whole Organato sheet: no heading, Refresh, rows or reserved
// space, so the date and sites have the page to themselves.
export function showOrganato(root, on) {
  root.documentElement.dataset.organato = on ? 'on' : 'off';
  root.querySelector('.sheet').hidden = !on;
}

function renderLoading(root) {
  const section = root.getElementById('organato');
  section.dataset.state = 'loading';
  section.dataset.stale = 'false';
  section.setAttribute('aria-busy', 'true');
  root.getElementById('organato-lists').hidden = true;
  root.getElementById('organato-action').hidden = true;
  const status = root.getElementById('organato-status');
  status.hidden = false;
  status.textContent = 'Loading your exams, assignments and to-dos…';
}

const switchedOff = (value) => value?.enabled === false;
const OFF = normalizeView({ organato: { enabled: false } }).organato;

function renderToday(root, now) {
  root.getElementById('today').textContent = longDate.format(now);
}

// ------------------------------------------------------------------ page

export function startNewTab({ api = globalThis.chrome, root = document, now = () => new Date() } = {}) {
  let view = null;
  let problem = null;
  let pending = false;
  let again = false;
  let disposed = false, midnightTimer;
  // The saved switch wins over any answer: turning Organato off hides it at
  // once, including over an answer still on its way.
  let off = !HAS_NATIVE_HELPER, organatoDay;
  const refreshButton = root.getElementById('refresh');
  const shortcuts = new ShortcutPreferences(api);
  const favicons = createFaviconCache(api);
  const status = root.getElementById('shortcut-status'), undo = root.getElementById('shortcut-undo'), reset = root.getElementById('sites-reset');
  let allSites = null, visibleSites = null, paintedSites = null, siteRevision = 0, undoKey;
  const filterSites = async (reload = false) => {
    if (disposed) return;
    const revision = ++siteRevision;
    if (reload) await shortcuts.load();
    if (disposed) return;
    const [sites] = await Promise.all([shortcuts.filter(allSites, MAX_SITES), favicons.ready]);
    if (disposed || revision !== siteRevision || !allSites) return;
    visibleSites = normalizeView({ topSites: sites }).topSites;
  };
  const updateSites = async () => {
    await filterSites(true);
    paint({ sitesOnly: true });
  };
  installShortcutAdder({ api, root, preferences: shortcuts, update: updateSites });
  const disposeShortcuts = installShortcutActions({ root, remove: async site => {
    try { undoKey = await shortcuts.hide(site.url); await updateSites(); status.textContent = 'Shortcut removed.'; undo.hidden = false; undo.focus(); }
    catch { status.textContent = 'Could not save shortcut preferences. Try again.'; }
  } });
  undo.addEventListener('click', async () => {
    if (!undoKey) return;
    try { await shortcuts.restore(undoKey); await updateSites(); undoKey = null; undo.hidden = true; status.textContent = 'Shortcut restored.'; }
    catch { status.textContent = 'Could not restore the shortcut. Try again.'; }
  });
  reset.addEventListener('click', async () => {
    try { await shortcuts.reset(); await updateSites(); undoKey = null; undo.hidden = true; status.textContent = 'Shortcuts restored.'; }
    catch { status.textContent = 'Could not restore shortcuts. Try again.'; }
  });
  const changed = (changes) => {
    if (changes[HIDDEN_SITES_KEY] || changes[CUSTOM_SITES_KEY]) void updateSites().catch(() => { status.textContent = 'Could not refresh shortcuts. Reload this tab to try again.'; });
    if (HAS_NATIVE_HELPER && changes[ORGANATO_SWITCHES_KEY]) {
      const nowOff = switchedOff(changes[ORGANATO_SWITCHES_KEY].newValue);
      if (nowOff === off) return;
      off = nowOff;
      if (off) { paint(); return; }
      // Turned back on: show the loading sheet and ask again.
      if (view) view.organato = undefined;
      showOrganato(root, true);
      renderLoading(root);
      void load(false);
    }
  };
  const storageChanges = localStorageChanges(api);
  storageChanges?.addListener(changed);
  const dispose = (event) => {
    // A back-forward cached page will resume with its existing listeners.
    if (event?.persisted) return;
    disposed = true;
    again = false;
    siteRevision++;
    clearTimeout(midnightTimer);
    disposeShortcuts();
    storageChanges?.removeListener(changed);
    globalThis.removeEventListener?.('pagehide', dispose);
  };
  globalThis.addEventListener?.('pagehide', dispose);

  const paint = ({ sitesOnly = false, retryIcons = false } = {}) => {
    if (disposed) return;
    const at = now();
    refreshButton.disabled = pending || off || organatoState(view?.organato) === 'setup';
    refreshButton.hidden = refreshButton.disabled;
    renderToday(root, at);
    if (visibleSites && (retryIcons || paintedSites?.length !== visibleSites.length ||
        visibleSites.some((site, index) => site.url !== paintedSites[index].url || site.title !== paintedSites[index].title))) {
      renderSites(api, root, visibleSites, favicons, retryIcons);
      paintedSites = visibleSites;
    }
    if (visibleSites?.length === 0) {
      root.getElementById('sites-empty').textContent = shortcuts.hidden.size
        ? 'No visible shortcuts. Restore shortcuts or visit more sites.'
        : 'Sites you visit often will appear here.';
    }
    reset.hidden = shortcuts.hidden.size === 0;
    const calendarDay = midnight(at);
    if (sitesOnly && organatoDay === calendarDay) return;
    if (off) { showOrganato(root, false); renderOrganato(root, OFF, at); organatoDay = calendarDay; return; }
    // Still waiting for the first answer (or the one after turning back on).
    if (!view || view.organato === undefined) { showOrganato(root, true); return; }
    showOrganato(root, view.organato?.enabled !== false);
    renderOrganato(root, view.organato, at, problem);
    organatoDay = calendarDay;
  };

  const load = async (refresh) => {
    if (disposed) return;
    if (pending) { again = true; return; }
    pending = true;
    refreshButton.disabled = true;
    refreshButton.hidden = true;
    refreshButton.setAttribute('aria-busy', 'true');
    const acceptSites = async sites => {
      if (disposed) return;
      allSites = Array.isArray(sites) ? sites : [];
      await filterSites();
    };
    const accept = async result => {
      if (disposed) return;
      if (result.dashboardEnabled === false) {
        globalThis.location.replace('chrome://new-tab-page/');
        return;
      }
      await acceptSites(result.topSites);
      if (disposed) return;
      view = normalizeView({ organato: result.organato });
      problem = null;
    };
    try {
      const preferences = shortcuts.load();
      const [result] = await Promise.all([requestView(api, {
        refresh,
        onSites: async sites => {
          await preferences;
          await acceptSites(sites);
          paint({ sitesOnly: true });
        },
        onUpdate: async cached => {
          await preferences;
          await accept(cached);
          paint();
        },
      }), preferences]);
      await accept(result);
    } catch (error) {
      if (disposed) return;
      problem = text(error?.message, 160) || null;
      if (!view) view = { organato: null };
      if (!visibleSites) await acceptSites([]);
    } finally {
      pending = false;
      if (!disposed) {
        refreshButton.disabled = false;
        refreshButton.removeAttribute('aria-busy');
      }
    }
    if (disposed) return;
    paint({ retryIcons: refresh });
    root.documentElement.dataset.loaded = 'true';
    // A switch flipped on while an answer was in flight asks once more.
    if (again) { again = false; if (!off) await load(false); }
  };

  // "Today" and "Tomorrow" move at midnight; repaint without asking again.
  const scheduleMidnight = () => {
    if (disposed) return;
    const at = now();
    const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime() - at.getTime();
    midnightTimer = setTimeout(() => { paint(); scheduleMidnight(); }, next + 1000);
  };

  renderToday(root, now());
  renderPlaceholders(root);
  refreshButton.addEventListener('click', () => void load(true));
  scheduleMidnight();
  // A saved "off" hides the sheet before the first answer, so it never flashes.
  const saved = Promise.resolve(HAS_NATIVE_HELPER && api?.storage?.local?.get?.(ORGANATO_SWITCHES_KEY)).then((value) => {
    if (switchedOff(value?.[ORGANATO_SWITCHES_KEY])) off = true;
  }, () => {});
  return saved.then(() => {
    if (!disposed) showOrganato(root, !off);
    return load(false);
  });
}

if (typeof document !== 'undefined' && document.getElementById('organato')) {
  void startPanelTheme();
  void startThemeArtwork();
  void startNewTab();
}
