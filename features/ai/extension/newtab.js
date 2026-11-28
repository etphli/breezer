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
import { PERSONALITIES, glassMode, handoffKey, listChats, openChatKey, readExperiments, recentChats, watchExperiments, wireClearChats, CHAT_INDEX_KEY, CONVERSATION_PREFIX, FULL_CHAT_PATH, FULL_CHAT_PREFIX, MAX_RECENT_CHATS, MAX_SAVED_CHATS } from './experiments.js';

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
    async accept(url, img) {
      try {
        const png = rasterize(img);
        defaultPng ??= readDefault(img.ownerDocument).catch(() => null);
        if (png === await defaultPng) return false;
        if (storage?.set && url.length <= 4096 && png.length <= FAVICON_MAX_LENGTH) {
          const entry = { url, png, expires: Date.now() + FAVICON_TTL_MS };
          remember(icons, entry);
          remember(dirty, entry);
          saveTimer ??= setTimeout(() => void flush().catch(() => {}), 30);
        }
      } catch { /* A usable image can still be shown when it can't be cached. */ }
      return true;
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
    img.addEventListener('load', async () => {
      if (cached || !favicons || await favicons.accept(site.url, img)) icon.classList.add('has-icon');
      else img.remove();
    }, { once: true });
    img.addEventListener('error', () => {
      if (cached) { cached = null; img.src = src; }
      else img.remove();
    });
    img.src = cached || src;
    if (cached && img.complete && img.naturalWidth) icon.classList.add('has-icon');
    icon.append(img);
  }
  const name = el('span', 'site-name');
  name.textContent = site.title;
  const host = new URL(site.url).hostname.replace(/^www\./, '');
  const isHost = site.title.toLowerCase().replace(/^www\./, '') === host;
  if (isHost) name.classList.add('hostname');
  const caption = el('span', 'site-caption');
  caption.append(name);
  if (!isHost && site.title.length >= 36) {
    const domain = el('span', 'site-host', { 'aria-hidden': 'true' });
    domain.textContent = host;
    caption.append(domain);
  }
  link.append(icon, caption);
  item.append(link, removeButton(site));
  return item;
}

function removeButton(site) {
  const remove = el('button', 'site-remove', { type: 'button', title: 'Remove shortcut', 'aria-label': `Remove ${site.title} shortcut` });
  remove.textContent = '×';
  return remove;
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

// When a saved chat was last used. Chats are kept for seven days, so from six
// days back a weekday alone could mean this week's day; those show the date.
export function chatDay(time, now = Date.now()) {
  const days = daysUntil(new Date(now), new Date(time));
  if (days <= 0) return 'Today';
  if (days === 1) return 'Yesterday';
  return days < 6 ? new Intl.DateTimeFormat(undefined, { weekday: 'long' }).format(time) : monthDay.format(time);
}

function itemRow(item, now, list) {
  const days = item.due ? daysUntil(item.due, now) : null;
  const row = el('li', 'item', { 'data-urgency': urgency(days) });

  const stub = el('span', 'stub', { 'aria-hidden': 'true' });
  if (list === 'upcoming' && item.due) {
    const day = el('span', 'stub-day');
    const week = el('span', 'stub-week');
    day.textContent = String(item.due.getDate());
    week.textContent = weekday.format(item.due);
    stub.append(day, week);
  }

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
    const shown = items.slice(0, limit).map((item) => itemRow(item, now, list));
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
    lanes.querySelector(`button[data-lane="${list}"] .lane-count`).textContent = String(items.length);
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

// ------------------------------------------------------------------ experiments
// Settings > Experiments can swap the shortcut grid for one Search / Ask box and
// give the page glass surfaces. Nothing below runs its feature code until the
// stored record says that experiment is on.

// The last record this page saw, kept in page storage so a reopened tab can
// lay itself out before chrome.storage answers. chrome.storage stays the truth.
export const EXPERIMENT_MIRROR_KEY = 'breezer.newtab.experiments';

const HOST = /^(?:localhost|(?:[\p{L}\p{N}](?:[\p{L}\p{N}\p{M}-]{0,61}[\p{L}\p{N}\p{M}])?\.)+(?:xn--[a-z0-9-]{2,59}|[\p{L}\p{M}]{2,63})\.?|\d{1,3}(?:\.\d{1,3}){3}|\[[0-9a-f:]+\])(?::\d{1,5})?$/iu;

// An address the box can open directly, or null for a search or a question.
// Only one http(s) token counts, so "what is example.com" stays a search.
export function toAddress(input) {
  const value = typeof input === 'string' ? input.trim() : '';
  if (!value || /\s/.test(value) || value.length > 2048) return null;
  if (/^https?:\/\//i.test(value)) return safeUrl(value);
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[^/]+:\d+(?:[/?#]|$)/.test(value)) return null;
  const host = value.split(/[/?#]/, 1)[0];
  if (!HOST.test(host)) return null;
  const local = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[)/i.test(host);
  return safeUrl(`${local ? 'http' : 'https'}://${value}`);
}

// ------------------------------------------------------------------ address
// Address-bar suggestions for the box. chrome.breezerPrivate runs the browser's
// own omnibox providers and decides URL or search; the page only shows what it
// answers and sends back which row was chosen. Without that bridge this stays
// idle and submit() below opens addresses itself.

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
const MAX_SUGGESTIONS = 8;
// The browser refuses omnibox text over 8192 UTF-8 bytes (kMaxInputBytes in
// omnibox_api.cc), so the length is measured the same way.
const MAX_ADDRESS_BYTES = 8192;
export const fitsAddressText = (text) => new TextEncoder().encode(text).length <= MAX_ADDRESS_BYTES;

const oneLine = (value) => value.replace(/[\r\n]+/g, ' ');

function searchGlyph(root) {
  const svg = root.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  const circle = root.createElementNS(SVG_NAMESPACE, 'circle');
  for (const [key, value] of Object.entries({ cx: 7, cy: 7, r: 4.25 })) circle.setAttribute(key, value);
  const path = root.createElementNS(SVG_NAMESPACE, 'path');
  path.setAttribute('d', 'm10.2 10.2 3.3 3.3');
  svg.append(circle, path);
  return svg;
}

export function installAddressSuggestions({ api, root, input, list, favicon = () => null, isActive, onOpen, onCount = () => {} }) {
  const bridge = api?.breezerPrivate;
  const available = typeof bridge?.queryOmnibox === 'function' && typeof bridge.openOmnibox === 'function';
  let typed = '', matches = [], revision = null, answered = null;
  let active = 0, moved = false, preventInline = false, token = 0, querying = false;

  const isOpen = () => !list.hidden;
  const caretAtEnd = () => input.selectionStart === input.value.length && input.selectionEnd === input.value.length;
  // What the box shows while it is still the text the person typed.
  const completion = () => (!moved && !preventInline && matches[0]?.isDefault ? matches[0].inlineAutocompletion || '' : '');

  const hide = () => {
    list.hidden = true;
    list.replaceChildren();
    input.removeAttribute('aria-activedescendant');
    onCount(null);
  };

  // Forgets the query. The browser stops its providers when one was running.
  const close = ({ restore = false } = {}) => {
    token += 1;
    // A row or ending that was only offered is not part of the draft.
    const ending = completion();
    const offered = moved || (ending && input.value === typed + ending && input.selectionStart === typed.length);
    if (restore && offered) {
      input.value = typed;
      input.setSelectionRange(typed.length, typed.length);
    }
    const stop = querying;
    querying = false;
    matches = []; revision = null; answered = null; active = 0; moved = false;
    hide();
    if (stop) void Promise.resolve(bridge.queryOmnibox({ text: '', preventInline: true })).catch(() => {});
  };

  const mark = () => {
    [...list.children].forEach((row, index) => row.setAttribute('aria-selected', String(index === active)));
    const row = list.children[active];
    if (moved && row) {
      input.setAttribute('aria-activedescendant', row.id);
      row.scrollIntoView({ block: 'nearest' });
    } else input.removeAttribute('aria-activedescendant');
  };

  const render = () => {
    if (!matches.length) { hide(); return; }
    list.replaceChildren(...matches.map((match, index) => {
      const row = root.createElement('li');
      row.id = `${list.id}-${index}`;
      row.className = 'suggestion';
      row.dataset.kind = match.kind;
      row.setAttribute('role', 'option');
      const icon = root.createElement('span');
      icon.className = 'suggestion-icon';
      icon.setAttribute('aria-hidden', 'true');
      const src = match.kind === 'url' ? favicon(match.url) : null;
      if (src) {
        const img = root.createElement('img');
        img.alt = ''; img.width = 16; img.height = 16;
        img.addEventListener('error', () => img.remove());
        img.src = src;
        icon.append(img);
      } else if (match.kind === 'search') icon.append(searchGlyph(root));
      const title = root.createElement('span');
      title.className = 'suggestion-title';
      const detail = root.createElement('span');
      detail.className = 'suggestion-detail';
      const url = match.kind === 'url';
      title.textContent = (url && match.description) || match.contents || match.fillIntoEdit;
      detail.textContent = url ? (match.description ? match.contents : '') : match.description;
      row.append(icon, title, detail);
      // Keeps the caret in the box; the click still chooses the row.
      row.addEventListener('mousedown', (event) => event.preventDefault());
      row.addEventListener('click', () => { active = index; moved = true; onOpen(); });
      return row;
    }));
    list.hidden = false;
    mark();
    onCount(matches.length);
  };

  // Shows the default match's ending, selected, so typing on replaces it.
  const complete = (wasEnding) => {
    if (root.activeElement !== input || moved) return;
    const untouched = input.value === typed && caretAtEnd();
    const showing = wasEnding && input.value === typed + wasEnding && input.selectionStart === typed.length;
    if (!untouched && !showing) return;
    const ending = completion();
    if (ending === (showing ? wasEnding : '')) return;
    input.value = typed + ending;
    input.setSelectionRange(typed.length, typed.length + ending.length);
  };

  const accept = (result) => {
    const wasEnding = completion();
    const chosen = moved ? matches[active] : null;
    matches = (Array.isArray(result?.matches) ? result.matches : []).slice(0, MAX_SUGGESTIONS);
    revision = result?.revision;
    answered = typed;
    if (chosen) {
      const index = matches.findIndex((match) => match.url === chosen.url && match.fillIntoEdit === chosen.fillIntoEdit);
      if (index >= 0) active = index;
      else {
        // The chosen row is gone. Go back to the typed text, never to another row.
        moved = false; active = 0;
        input.value = typed;
        input.setSelectionRange(typed.length, typed.length);
      }
    } else active = 0;
    complete(wasEnding);
    render();
  };

  const query = async () => {
    const mine = ++token;
    querying = true;
    try {
      let result = await bridge.queryOmnibox({ text: oneLine(typed), preventInline });
      while (mine === token) {
        accept(result);
        if (result.done || typeof bridge.nextOmniboxResult !== 'function') { querying = false; return; }
        result = await bridge.nextOmniboxResult(result.revision);
      }
    } catch {
      if (mine === token) close();
    }
  };

  const update = (event) => {
    if (!available) return;
    if (!isActive() || !input.value.trim() || !fitsAddressText(oneLine(input.value))) { close(); return; }
    typed = input.value;
    moved = false;
    matches = []; answered = null;
    // Deleting, pasting or editing in the middle must not add text back.
    const kind = event?.inputType ?? '';
    preventInline = !(kind.startsWith('insert') && kind !== 'insertFromPaste' && kind !== 'insertFromDrop' && caretAtEnd()) || /[\r\n]/.test(typed);
    void query();
  };

  input.addEventListener('input', (event) => { if (!event.isComposing) update(event); });
  input.addEventListener('compositionend', () => update());

  return {
    available,
    close,
    // True when the key belonged to the suggestions.
    key(key) {
      if (!isOpen()) return false;
      if (key === 'Escape') { close({ restore: true }); return true; }
      const step = { ArrowDown: 1, ArrowUp: -1 }[key];
      if (!step) return false;
      active = (active + step + matches.length) % matches.length;
      moved = true;
      input.value = matches[active].fillIntoEdit;
      input.setSelectionRange(input.value.length, input.value.length);
      mark();
      return true;
    },
    // Opens the chosen row, or what the browser decides the text means. Rejects
    // when the browser could not open it, so the caller can still act on Enter.
    async open({ tabId } = {}) {
      const text = oneLine(input.value.trim());
      const request = { text };
      if (tabId !== undefined) request.tabId = tabId;
      const fresh = answered !== null && answered === typed && matches.length > 0;
      const unchanged = fresh && matches[0].isDefault && input.value === typed + completion()
        && completion() === (matches[0].inlineAutocompletion || '');
      if (fresh && (moved || unchanged)) Object.assign(request, { revision, index: active });
      token += 1;
      querying = false;
      hide();
      try { await bridge.openOmnibox(request); } finally { matches = []; answered = null; moved = false; }
    },
  };
}

const storageGet = (key) => { try { return globalThis.localStorage?.getItem(key) ?? null; } catch { return null; } };
const storageSet = (key, value) => { try { globalThis.localStorage?.setItem(key, value); } catch { /* per-viewer convenience only */ } };

function applyExperimentLayout(root, { composer, glass, glassOpacity, personality }) {
  const html = root.documentElement;
  if (composer) html.dataset.composer = 'on'; else delete html.dataset.composer;
  if (personality && personality !== 'off' && Object.hasOwn(PERSONALITIES, personality)) html.dataset.personality = personality;
  else delete html.dataset.personality;
  html.dataset.glass = glass;
  html.style.setProperty('--glass-opacity', Number.isInteger(glassOpacity) && glassOpacity >= 0 && glassOpacity <= 100
    ? `${glassOpacity}%` : '66%');
}

export function startNewTabExperiments({ api = globalThis.chrome, root = document, win = globalThis } = {}) {
  const composer = root.getElementById('composer');
  const box = root.getElementById('composer-form');
  const input = root.getElementById('composer-input');
  const modes = root.getElementById('composer-modes');
  const send = root.getElementById('composer-send');
  const status = root.getElementById('composer-status');
  const style = root.getElementById('composer-style');
  const suggestionList = root.getElementById('composer-suggestions');
  const suggestionCount = root.getElementById('composer-suggestion-count');
  const sitesList = root.getElementById('composer-sites');
  const chatsSection = root.getElementById('recent-chats');
  const chatsList = root.getElementById('recent-chats-list');
  const chatsMore = root.getElementById('recent-chats-more');
  const chatsClear = root.getElementById('recent-chats-clear');
  const canAsk = HAS_NATIVE_HELPER && typeof api?.tabs?.update === 'function' && typeof api?.runtime?.getURL === 'function';
  const query = (text) => win.matchMedia?.(text) ?? { matches: false, addEventListener() {}, removeEventListener() {} };
  const fullscreenQuery = query('(display-mode: fullscreen)');
  const transparencyQuery = query('(prefers-reduced-transparency: reduce)');
  const forcedQuery = query('(forced-colors: active)');
  let experiments = null, sites = [], windowId = null, tabId = null, mode = 'search', disposed = false;
  let windowFullscreen = false, chatsRequest = 0, allChats = false, askPort = null, openingChat = false, recoveredDraft = false;
  const cleanups = [];

  let mirror = {};
  try { mirror = JSON.parse(storageGet(EXPERIMENT_MIRROR_KEY) || '{}') || {}; } catch { mirror = {}; }
  const layout = () => {
    const on = experiments ?? { newTabComposer: mirror.composer === true, glass: mirror.glass === true, glassOpacity: mirror.glassOpacity, personality: mirror.personality };
    applyExperimentLayout(root, {
      composer: on.newTabComposer,
      personality: on.personality,
      glassOpacity: on.glassOpacity,
      glass: glassMode({ enabled: on.glass, fullscreen: fullscreenQuery.matches || windowFullscreen, reducedTransparency: transparencyQuery.matches || forcedQuery.matches }),
    });
  };
  layout();

  const say = (text, state = '') => { status.textContent = text; status.dataset.state = state; };

  const suggestions = installAddressSuggestions({
    api, root, input, list: suggestionList,
    favicon: (url) => (safeUrl(url) ? faviconUrl(api, url) : null),
    isActive: () => mode === 'search' && !openingChat,
    onOpen: () => void submit(),
    onCount: (count) => { suggestionCount.textContent = count ? `${count} ${count === 1 ? 'suggestion' : 'suggestions'}` : ''; },
  });

  const placeThumb = () => {
    const checked = modes.querySelector('[aria-checked="true"]');
    if (!checked) return;
    modes.style.setProperty('--thumb-x', `${checked.offsetLeft - 3}px`);
    modes.style.setProperty('--thumb-w', `${checked.offsetWidth}px`);
  };
  // Selecting Ask starts the local helper, so the models are ready by the first
  // Send. The worker ignores a hidden or closed page and ends an unused helper.
  const releaseAsk = () => {
    const port = askPort;
    askPort = null;
    try { port?.disconnect(); } catch { /* The worker already closed it. */ }
  };
  const prewarmAsk = () => {
    if (openingChat) return;
    if (mode !== 'ask' || root.hidden || disposed) { releaseAsk(); return; }
    if (askPort) return;
    try {
      const port = api.runtime.connect({ name: 'breezer-ask' });
      askPort = port;
      port.onDisconnect?.addListener(() => { if (askPort === port) askPort = null; });
      port.postMessage({ type: 'prewarm' });
    } catch { askPort = null; }
  };
  const setMode = (next) => {
    mode = next === 'ask' && canAsk && experiments?.newTabComposer ? 'ask' : 'search';
    box.dataset.mode = mode;
    if (status.dataset.state === 'hint') say('');
    if (mode === 'ask') suggestions.close({ restore: true });
    for (const [name, value] of [['aria-autocomplete', 'both'], ['aria-controls', suggestionList.id]]) {
      if (mode === 'search' && suggestions.available) input.setAttribute(name, value);
      else input.removeAttribute(name);
    }
    for (const button of modes.querySelectorAll('[role="radio"]')) {
      const checked = button.dataset.mode === mode;
      button.setAttribute('aria-checked', String(checked));
      button.tabIndex = checked ? 0 : -1;
    }
    const placeholder = mode === 'ask' ? 'Ask Breezer AI anything' : 'Search the web or type an address';
    input.placeholder = placeholder;
    input.setAttribute('aria-label', placeholder);
    send.setAttribute('aria-label', mode === 'ask' ? 'Ask Breezer AI' : 'Search');
    renderStyle();
    placeThumb();
    prewarmAsk();
  };
  const renderStyle = () => {
    const preset = experiments?.personality && experiments.personality !== 'off' ? PERSONALITIES[experiments.personality] : null;
    style.hidden = !(preset && mode === 'ask');
    if (preset) {
      style.textContent = `${preset.label} replies`;
      style.title = `${preset.description} Change it in Settings.`;
    }
  };
  const grow = () => {
    input.style.height = '';
    if (input.value) input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
  };

  const renderSites = () => {
    root.getElementById('shortcut-feedback').hidden = Boolean(experiments?.newTabComposer && !experiments.newTabShortcuts);
    const show = experiments?.newTabComposer && experiments.newTabShortcuts && sites.length;
    sitesList.hidden = !show;
    if (!show) { sitesList.replaceChildren(); return; }
    sitesList.replaceChildren(...sites.map((site) => {
      const item = el('li');
      const link = el('a', 'composer-site', { href: site.url, title: site.title, 'aria-label': site.title });
      const letter = [...site.title.replace(/[^\p{L}\p{N}]/gu, '')][0]?.toUpperCase() || '?';
      link.textContent = letter;
      const src = faviconUrl(api, site.url);
      if (src) {
        const img = el('img', '', { alt: '', width: '22', height: '22' });
        img.addEventListener('load', () => { link.replaceChildren(img); }, { once: true });
        img.src = src;
      }
      item.append(link, removeButton(site));
      return item;
    }));
  };

  const renderChats = async () => {
    const want = experiments?.newTabComposer && experiments.newTabRecentChats && canAsk;
    const request = ++chatsRequest;
    if (!want) { chatsSection.hidden = true; chatsList.replaceChildren(); return; }
    let chats = [];
    // One more than the short list shows whether there is anything to expand.
    try { chats = await recentChats(api, windowId, allChats ? MAX_SAVED_CHATS * 2 : MAX_RECENT_CHATS + 1); } catch { chats = []; }
    if (disposed || request !== chatsRequest) return;
    if (chatsMore) {
      chatsMore.hidden = chats.length <= MAX_RECENT_CHATS;
      chatsMore.textContent = allChats ? 'Show fewer' : 'Show all';
      chatsMore.setAttribute('aria-expanded', String(allChats));
    }
    if (allChats) chatsList.dataset.expanded = 'true';
    else { delete chatsList.dataset.expanded; chats = chats.slice(0, MAX_RECENT_CHATS); }
    chatsSection.hidden = !chats.length;
    const focusedChat = chatsList.contains(root.activeElement) ? root.activeElement.dataset.chat : null;
    chatsList.replaceChildren(...chats.map((chat) => {
      const item = el('li');
      const fullChat = Number.isInteger(chat.tabId);
      const identity = fullChat ? `tab-${chat.tabId}` : chat.id ? `saved-${chat.id}` : `window-${chat.windowId}`;
      const button = el('button', 'recent-chat', { type: 'button', 'data-chat': identity });
      const title = el('span', 'recent-chat-title');
      title.textContent = chat.title;
      const preview = el('span', 'recent-chat-preview');
      preview.textContent = chat.preview || `${chat.messages} messages`;
      const where = el('span', 'recent-chat-where');
      where.textContent = chat.id ? chatDay(chat.lastActivity) : chat.current ? 'This window' : 'Other window';
      button.append(title, preview, where);
      button.addEventListener('click', async () => {
        if (openingChat) return;
        try {
          if (chat.id) { await openSavedChat(chat.id); return; }
          let targetWindow = chat.windowId;
          if (fullChat) {
            const tab = await api.tabs.get(chat.tabId);
            if (tab.incognito || tab.url !== api.runtime.getURL(FULL_CHAT_PATH) || (tab.pendingUrl && tab.pendingUrl !== tab.url)) {
              throw new Error('The chat tab has navigated.');
            }
            const active = await api.tabs.update(tab.id, { active: true });
            targetWindow = active.windowId;
          } else {
            // The sidebar API requires the original click gesture.
            await api.sidePanel.open({ windowId: targetWindow });
          }
          if (targetWindow !== windowId) await api.windows.update(targetWindow, { focused: true });
        } catch {
          say('Breezer AI couldn’t open that conversation.', 'error');
          void renderChats();
        }
      });
      item.append(button);
      return item;
    }));
    if (focusedChat) {
      [...chatsList.querySelectorAll('button')].find(button => button.dataset.chat === focusedChat)?.focus({ preventScroll: true });
    }
  };

  // Opens a saved chat here, as Ask does. An unsent question stays with this New
  // Tab for Back and never goes into the chat being opened.
  const openSavedChat = async (id) => {
    if (!Number.isInteger(tabId) || !(await listChats(api)).some((chat) => chat.id === id)) throw new Error('That chat is no longer saved.');
    if (openingChat) return;
    openingChat = true;
    try {
      if (mode === 'ask' && input.value.trim()) win.sessionStorage.setItem(handoffKey(tabId), JSON.stringify({ prompt: input.value }));
      win.sessionStorage.setItem(openChatKey(tabId), id);
      await api.tabs.update(tabId, { url: api.runtime.getURL(FULL_CHAT_PATH) });
    } catch (error) {
      openingChat = false;
      try { win.sessionStorage.removeItem(openChatKey(tabId)); } catch { /* Nothing was stored. */ }
      throw error;
    }
  };

  const recoverAsk = () => {
    if (!canAsk || !experiments?.newTabComposer || !Number.isInteger(tabId)) return;
    const key = handoffKey(tabId);
    try {
      const draft = JSON.parse(win.sessionStorage.getItem(key));
      if (typeof draft?.prompt !== 'string' || !draft.prompt) {
        if (recoveredDraft) {
          recoveredDraft = false;
          input.value = '';
          grow();
        }
        return;
      }
      // Back takes over the question. Keep it through reload, but remove
      // the timestamp that authorized the chat tab to send it automatically.
      win.sessionStorage.setItem(key, JSON.stringify({ prompt: draft.prompt }));
      recoveredDraft = true;
      input.value = draft.prompt;
      setMode('ask');
      grow();
    } catch { /* The composer can still be used if session storage is unavailable. */ }
  };

  const ask = async (text) => {
    if (!Number.isInteger(tabId)) { say('Breezer is still getting this tab ready. Try again in a moment.', 'error'); return; }
    const key = handoffKey(tabId);
    const value = input.value;
    openingChat = true;
    input.readOnly = true;
    send.disabled = true;
    say('Opening Breezer AI…');
    try {
      win.sessionStorage.removeItem(openChatKey(tabId));
      win.sessionStorage.setItem(key, JSON.stringify({ prompt: text, createdAt: Date.now() }));
      input.value = '';
      grow();
      await api.tabs.update(tabId, { url: api.runtime.getURL(FULL_CHAT_PATH) });
    } catch {
      input.value = value;
      grow();
      try {
        if (recoveredDraft) win.sessionStorage.setItem(key, JSON.stringify({ prompt: value }));
        else win.sessionStorage.removeItem(key);
      } catch { /* The question is still in the composer. */ }
      openingChat = false;
      input.readOnly = false;
      send.disabled = false;
      say('Breezer AI couldn’t open. Your question is still here. Try again.', 'error');
    }
  };

  const search = (text) => {
    if (typeof api?.search?.query !== 'function') { say('Search isn’t available here. Type a full web address instead.', 'error'); return; }
    Promise.resolve(api.search.query({ text, ...(Number.isInteger(tabId) ? { tabId } : { disposition: 'CURRENT_TAB' }) }))
      .catch(() => say('Search didn’t start. Try again.', 'error'));
  };

  const submit = async () => {
    const text = input.value.trim();
    if (!text || openingChat) return;
    say('');
    if (mode === 'ask') { ask(text.slice(0, 24000)); return; }
    if (suggestions.available) {
      try { await suggestions.open(); return; } catch { /* The page can still open it below. */ }
      if (disposed) return;
    }
    const address = toAddress(text);
    if (address) win.location.assign(address); else search(text.slice(0, 2048));
  };

  const start = () => {
    box.addEventListener('submit', (event) => { event.preventDefault(); void submit(); });
    // Tab in the box turns on Ask once. Escape, or a second Tab, gives the normal
    // tab order back, and returning to the box turns the shortcut on again.
    let tabAsks = true;
    input.addEventListener('focus', () => { tabAsks = true; });
    box.addEventListener('focusout', (event) => {
      if (!box.contains(event.relatedTarget)) suggestions.close({ restore: true });
    });
    input.addEventListener('keydown', (event) => {
      if (event.isComposing) return;
      const plain = !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey;
      if (plain && suggestions.key(event.key)) { event.preventDefault(); grow(); return; }
      if (event.key === 'Tab') {
        if (plain && tabAsks && mode === 'search' && canAsk && experiments?.newTabComposer && !openingChat) {
          event.preventDefault();
          setMode('ask');
          grow();
          say('Enter asks Breezer. Press Esc to search instead.', 'hint');
        } else suggestions.close({ restore: true });
      } else if (event.key === 'Escape' && plain) {
        tabAsks = false;
        if (mode !== 'ask' || openingChat) return;
        event.preventDefault();
        setMode('search');
        say('Enter searches again.', 'hint');
      } else if (event.key === 'Enter' && !event.shiftKey) {
        event.preventDefault();
        void submit();
      }
    });
    input.addEventListener('input', () => {
      grow();
      tabAsks = true;
      if (['error', 'hint'].includes(status.dataset.state)) say('');
      if (recoveredDraft) {
        try {
          const key = handoffKey(tabId);
          if (!input.value.trim()) {
            win.sessionStorage.removeItem(key);
            recoveredDraft = false;
          } else if (mode === 'ask') {
            win.sessionStorage.setItem(key, JSON.stringify({ prompt: input.value }));
          }
        } catch { /* The question is still in the composer. */ }
      }
    });
    modes.addEventListener('click', (event) => {
      const button = event.target.closest('[role="radio"]');
      if (!button) return;
      setMode(button.dataset.mode);
      input.focus();
    });
    modes.addEventListener('keydown', (event) => {
      const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!step) return;
      event.preventDefault();
      setMode(mode === 'ask' ? 'search' : 'ask');
      modes.querySelector('[aria-checked="true"]').focus();
    });
    const onResize = () => placeThumb();
    win.addEventListener?.('resize', onResize);
    cleanups.push(() => win.removeEventListener?.('resize', onResize));
    const session = api?.storage?.session?.onChanged;
    if (session?.addListener) {
      const onSession = (changes) => {
        if (Object.keys(changes).some(key => key.startsWith(CONVERSATION_PREFIX) || key.startsWith(FULL_CHAT_PREFIX))) void renderChats();
      };
      session.addListener(onSession);
      cleanups.push(() => session.removeListener?.(onSession));
    }
    const savedChats = localStorageChanges(api);
    if (savedChats) {
      const onSaved = (changes) => { if (changes?.[CHAT_INDEX_KEY]) void renderChats(); };
      savedChats.addListener(onSaved);
      cleanups.push(() => savedChats.removeListener?.(onSaved));
    }
    chatsMore?.addEventListener('click', () => { allChats = !allChats; void renderChats(); });
    if (chatsClear) wireClearChats(chatsClear, api, {
      onCleared: () => { say('Chats cleared.'); input.focus({ preventScroll: true }); void renderChats(); },
      onError: () => say('Breezer AI couldn’t clear your chats. Try again.', 'error'),
    });
    const isListed = (id) => chatsList.querySelector(`[data-chat="tab-${id}"]`);
    const onTabUpdated = (id, { url }) => {
      if (url && (isListed(id) || url === api.runtime.getURL(FULL_CHAT_PATH))) void renderChats();
    };
    const onTabRemoved = (id) => { if (isListed(id)) void renderChats(); };
    const onTabAttached = (id, { newWindowId }) => {
      if (id === tabId) windowId = newWindowId;
      void renderChats();
    };
    for (const [event, listener] of [[api.tabs?.onUpdated, onTabUpdated], [api.tabs?.onRemoved, onTabRemoved], [api.tabs?.onAttached, onTabAttached]]) {
      if (!event?.addListener) continue;
      event.addListener(listener);
      cleanups.push(() => event.removeListener?.(listener));
    }
    // Fonts can change button widths after the first layout.
    void root.fonts?.ready?.then(() => { if (!disposed) placeThumb(); });
    win.requestAnimationFrame?.(() => { modes.dataset.ready = "true"; });
  };

  const apply = (next) => {
    experiments = next;
    mirror = { composer: next.newTabComposer, glass: next.glass, glassOpacity: next.glassOpacity, personality: next.personality };
    storageSet(EXPERIMENT_MIRROR_KEY, JSON.stringify(mirror));
    layout();
    modes.hidden = !canAsk || !next.newTabComposer;
    composer.setAttribute('aria-label', modes.hidden ? 'Web search' : 'Search or ask');
    setMode(mode);
    renderSites();
    void renderChats();
  };

  // Glass follows fullscreen: the display-mode query covers browser fullscreen,
  // and the window state covers platforms where it does not match.
  const checkWindow = async () => {
    if (!experiments?.glass || typeof api?.windows?.getCurrent !== 'function') return;
    try { windowFullscreen = (await api.windows.getCurrent())?.state === 'fullscreen'; } catch { windowFullscreen = false; }
    if (!disposed) layout();
  };
  const onLayoutChange = () => { layout(); void checkWindow(); };
  for (const media of [fullscreenQuery, transparencyQuery, forcedQuery]) {
    media.addEventListener?.('change', onLayoutChange);
    cleanups.push(() => media.removeEventListener?.('change', onLayoutChange));
  }
  win.addEventListener?.('resize', onLayoutChange);
  cleanups.push(() => win.removeEventListener?.('resize', onLayoutChange));

  const focusSearch = () => {
    if (disposed || root.hidden) return;
    root.removeEventListener('visibilitychange', focusSearch);
    if (root.activeElement === root.body) input.focus({ preventScroll: true });
  };
  const onPageShow = (event) => {
    if (!event.persisted) { focusSearch(); return; }
    if (openingChat) setMode('search');
    openingChat = false;
    input.readOnly = false;
    send.disabled = false;
    say('');
    recoverAsk();
    prewarmAsk();
    void renderChats();
  };
  win.addEventListener?.('pageshow', onPageShow);
  cleanups.push(() => win.removeEventListener?.('pageshow', onPageShow));
  root.addEventListener('visibilitychange', prewarmAsk);
  cleanups.push(() => root.removeEventListener('visibilitychange', prewarmAsk), releaseAsk);
  root.addEventListener('visibilitychange', focusSearch);
  cleanups.push(() => root.removeEventListener('visibilitychange', focusSearch));
  start();
  focusSearch();
  cleanups.push(watchExperiments(api, (next) => apply(next)));
  const ready = Promise.all([
    readExperiments(api),
    Promise.resolve(api?.tabs?.getCurrent?.()).then((tab) => { windowId = tab?.windowId ?? null; tabId = tab?.id ?? null; }, () => {}),
  ]).then(([value]) => {
    if (disposed) return;
    apply(value);
    recoverAsk();
    focusSearch();
    void checkWindow();
  });

  return {
    ready,
    setSites(next) { sites = Array.isArray(next) ? next : []; renderSites(); },
    dispose() {
      disposed = true;
      for (const cleanup of cleanups.splice(0)) cleanup();
    },
  };
}

// ------------------------------------------------------------------ page

export function startNewTab({ api = globalThis.chrome, root = document, now = () => new Date() } = {}) {
  const experiments = startNewTabExperiments({ api, root });
  const lanes = root.getElementById('organato-lists');
  const laneButtons = lanes.querySelectorAll('.agenda-switch button');
  for (const button of laneButtons) {
    button.addEventListener('click', () => {
      lanes.dataset.lane = button.dataset.lane;
      for (const choice of laneButtons) choice.setAttribute('aria-pressed', String(choice === button));
    });
  }
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
  let allSites = null, visibleSites = null, paintedSites = null, siteRevision = 0, undoKey, undoUrl;
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
    try { undoKey = await shortcuts.hide(site.url); undoUrl = site.url; await updateSites(); status.textContent = 'Shortcut removed.'; undo.hidden = false; undo.focus(); }
    catch { status.textContent = 'Could not save shortcut preferences. Try again.'; }
  } });
  undo.addEventListener('click', async () => {
    if (!undoKey) return;
    try {
      await shortcuts.restore(undoKey); await updateSites(); undoKey = null; undo.hidden = true; status.textContent = 'Shortcut restored.';
      // Undo has gone, so the keyboard continues from the shortcut it brought back.
      [...root.querySelectorAll('.site-link, .composer-site')].find(link => link.href === undoUrl && link.offsetParent)?.focus();
    }
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
    experiments.dispose();
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
      experiments.setSites(visibleSites);
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
    const recoverSites = async () => {
      if (allSites?.length) return;
      let sites;
      try { sites = await api.topSites?.get(); } catch { /* Visits may be unavailable. */ }
      await acceptSites(sites);
    };
    const accept = async result => {
      if (disposed) return;
      if (result.dashboardEnabled === false) {
        globalThis.location.replace('chrome://new-tab-page/');
        return;
      }
      if (result.organato?.error && !result.topSites?.length) await recoverSites();
      else await acceptSites(result.topSites);
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
      if (!visibleSites) await recoverSites();
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
