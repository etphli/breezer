// Breezer new tab: one row of frequently visited sites and the Organato
// exams, assignments and to-dos that are coming up. The page asks the
// background over a 'breezer-newtab' port once on load and again only when the
// Refresh button is pressed; the background owns persistence and every HTTP call.
// Everything received is untrusted: text goes in with textContent and only
// http(s) URLs become links.
import { startPanelTheme } from './panel-theme.js';

export const PORT_NAME = 'breezer-newtab';
export const REQUEST_TIMEOUT_MS = 65000;
export const MAX_SITES = 8;
export const MAX_ITEMS = 6;
export const SETTINGS_URL = 'workspace.html#/settings';
const LISTS = ['exams', 'assignments', 'todos'];
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

function normalizeItem(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const title = text(raw.title);
  if (!title) return null;
  const allDay = raw.allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(raw.dueAt ?? '');
  return { id: text(String(raw.id ?? index), 80), title, due: parseDue(raw.dueAt), allDay, subject: text(raw.subject, 60) || null, url: safeUrl(raw.url) };
}

function normalizeList(value) {
  const items = (Array.isArray(value) ? value : []).map(normalizeItem).filter(Boolean);
  // Soonest first; undated to-dos keep their given order at the end.
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
  const organato = {
    // Organato is on unless the background explicitly says it was turned off.
    enabled: source.enabled !== false,
    connected: source.connected === true,
    error: text(source.error, 240) || null,
  };
  for (const list of LISTS) organato[list] = normalizeList(source[list]);
  return { topSites, organato };
}

export function organatoState(organato) {
  if (!organato) return 'unavailable';
  if (!organato.enabled) return 'disabled';
  const hasItems = LISTS.some((list) => organato[list].length);
  if (organato.error && !hasItems) return 'error';
  if (!organato.connected && !hasItems) return 'setup';
  return 'ready';
}

// Opens a port, sends one request and waits for its matching answer. The port
// is closed on the first answer, disconnect or timeout, so nothing lingers.
export function requestView(api, { refresh = false, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    if (typeof api?.runtime?.connect !== 'function') {
      reject(new Error('Breezer is not available on this page.'));
      return;
    }
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    let port = null;
    let settled = false;
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
        if (message?.type === 'view' && message.id === id) finish(resolve, message);
      });
      port.onDisconnect.addListener(() => finish(reject, new Error('Breezer closed the connection.')));
      port.postMessage({ type: 'view', id, refresh });
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

function faviconUrl(api, url) {
  const canFavicon = api?.runtime?.getManifest?.().permissions?.includes('favicon');
  return canFavicon && typeof api.runtime.getURL === 'function'
    ? api.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(url)}&size=64`)
    : null;
}

function siteTile(api, site) {
  const item = el('li', 'site');
  const link = el('a', 'site-link', { href: site.url, title: `${site.title}\n${site.url}` });
  const icon = el('span', 'site-icon', { 'aria-hidden': 'true' });
  const monogram = el('span', 'site-monogram');
  monogram.textContent = [...site.title][0]?.toUpperCase() || '?';
  icon.append(monogram);
  const src = faviconUrl(api, site.url);
  if (src) {
    const img = el('img', '', { alt: '', width: '28', height: '28', decoding: 'async' });
    img.addEventListener('load', () => icon.classList.add('has-icon'));
    img.addEventListener('error', () => img.remove());
    img.src = src;
    icon.append(img);
  }
  const name = el('span', 'site-name');
  name.textContent = site.title;
  link.append(icon, name);
  item.append(link);
  return item;
}

export function renderSites(api, root, sites) {
  const list = root.getElementById('sites');
  list.replaceChildren(...sites.map((site) => siteTile(api, site)));
  list.removeAttribute('aria-busy');
  list.hidden = !sites.length;
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
  if (item.subject) {
    const subject = el('span', 'item-subject');
    subject.textContent = item.subject;
    meta.append(subject);
  }
  body.append(title, meta);
  row.append(stub, body);
  return row;
}

const EMPTY = { exams: 'No exams coming up.', assignments: 'No assignments due.', todos: 'Nothing on your to-do list.' };

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
  section.dataset.state = state;
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
    status.textContent = 'Organato is turned off.';
    action.append(settingsLink('Turn on Organato in Settings'));
    action.hidden = false;
    return;
  }
  if (state === 'setup') {
    status.textContent = 'Connect Organato to see your upcoming exams, assignments and to-dos here.';
    action.append(settingsLink('Add your Organato API key in Settings'));
    action.hidden = false;
    return;
  }
  if (state === 'error') {
    status.textContent = `Organato did not load: ${organato.error}`;
    action.append(settingsLink('Review Organato in Settings'));
    action.hidden = false;
    return;
  }

  // Ready. A refresh error with older items still on hand keeps them visible.
  if (organato.error) status.textContent = `Showing the last update. Organato did not refresh: ${organato.error}`;
  else if (problem) status.textContent = `Showing the last update. ${problem}`;
  else status.hidden = true;
  for (const list of LISTS) {
    const items = organato[list];
    const target = lanes.querySelector(`[data-list="${list}"]`);
    const shown = items.slice(0, MAX_ITEMS).map((item) => itemRow(item, now));
    if (!items.length) {
      const empty = el('li', 'item-empty');
      empty.textContent = EMPTY[list];
      shown.push(empty);
    } else if (items.length > MAX_ITEMS) {
      const more = el('li', 'item-more');
      more.textContent = `${items.length - MAX_ITEMS} more in Organato`;
      shown.push(more);
    }
    target.replaceChildren(...shown);
    lanes.querySelector(`[data-count="${list}"]`).textContent = items.length ? String(items.length) : '';
  }
}

function renderToday(root, now) {
  root.getElementById('today').textContent = longDate.format(now);
}

// ------------------------------------------------------------------ page

export function startNewTab({ api = globalThis.chrome, root = document, now = () => new Date() } = {}) {
  let view = null;
  let problem = null;
  let pending = false;
  const refreshButton = root.getElementById('refresh');

  const paint = () => {
    const at = now();
    renderToday(root, at);
    if (view) renderSites(api, root, view.topSites);
    renderOrganato(root, view?.organato ?? null, at, problem);
  };

  const load = async (refresh) => {
    if (pending) return;
    pending = true;
    refreshButton.disabled = true;
    refreshButton.setAttribute('aria-busy', 'true');
    try {
      const result = await requestView(api, { refresh });
      if (result.dashboardEnabled === false) {
        globalThis.location.replace('chrome://new-tab-page/');
        return;
      }
      view = normalizeView(result);
      problem = null;
    } catch (error) {
      problem = text(error?.message, 160) || null;
      if (!view) view = { topSites: [], organato: null };
    } finally {
      pending = false;
      refreshButton.disabled = false;
      refreshButton.removeAttribute('aria-busy');
    }
    paint();
    root.documentElement.dataset.loaded = 'true';
  };

  // "Today" and "Tomorrow" move at midnight; repaint without asking again.
  const scheduleMidnight = () => {
    const at = now();
    const next = new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1).getTime() - at.getTime();
    setTimeout(() => { paint(); scheduleMidnight(); }, next + 1000);
  };

  renderToday(root, now());
  renderPlaceholders(root);
  refreshButton.addEventListener('click', () => void load(true));
  scheduleMidnight();
  return load(false);
}

if (typeof document !== 'undefined' && document.getElementById('organato')) {
  void startPanelTheme();
  void startNewTab();
}
