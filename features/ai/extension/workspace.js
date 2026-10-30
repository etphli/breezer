import {
  APPEARANCE_REV_KEY, DEFAULT_APPEARANCE, MAX_SPACES, STORE_KEY, TONES, TONE_NAMES,
  WorkspaceStore, addEntry, addFavorite, addFolder, addSpace, buildSidebarModel, displayTitle, findEntriesByUrl,
  findNode, hostLabel, isOpenableUrl, moveIndex, moveNode, normalizeAppearance, normalizeStore, parseRoute,
  removeNode, removeSpace, renameNode, renameSpace, resolveSpaceId, setFolderOpen, setSpaceTone, spaceOfTab,
  visibleTabs, windowStateKey,
} from './workspace-store.js';

const api = globalThis.chrome;
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const workspace = new WorkspaceStore({ storage: api.storage });

const ICONS = {
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  minus: 'M4 8h8',
  sound: 'M3 6.2h2.2L8.4 3.6v8.8L5.2 9.8H3zM10.6 5.6a3.4 3.4 0 0 1 0 4.8',
  muted: 'M3 6.2h2.2L8.4 3.6v8.8L5.2 9.8H3zM10.5 6.3l3 3M13.5 6.3l-3 3',
  chevron: 'M6 4.5L9.5 8 6 11.5',
  folder: 'M2.5 5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.4 1.6H12A1.5 1.5 0 0 1 13.5 6.6V11A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11z',
};

function icon(name, className = '') {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  if (className) svg.setAttribute('class', className);
  const path = document.createElementNS(SVG, 'path');
  path.setAttribute('d', ICONS[name]);
  svg.append(path);
  return svg;
}

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

const errorText = (error) => (error instanceof Error ? error.message : String(error || 'Something went wrong.'));

// ---------------------------------------------------------------- native bridge

export class BridgeUnavailable extends Error {
  constructor() { super('This Breezer build can’t change browser appearance yet.'); this.name = 'BridgeUnavailable'; }
}

// chrome.breezerPrivate is supplied by native Breezer code. Works with promise or callback style.
export function callBridge(name, ...args) {
  const target = api?.breezerPrivate;
  if (typeof target?.[name] !== 'function') return Promise.reject(new BridgeUnavailable());
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      const lastError = api.runtime?.lastError;
      if (lastError) reject(new Error(lastError.message || 'The browser rejected the change.'));
      else resolve(value);
    };
    try {
      const result = target[name](...args, finish);
      if (result && typeof result.then === 'function') {
        result.then((value) => { settled = true; resolve(value); }, (error) => { settled = true; reject(error); });
      }
    } catch (error) {
      reject(error);
    }
  });
}

export async function loadAppearance() {
  try {
    return { appearance: normalizeAppearance(await callBridge('getAppearance')), available: true, error: '' };
  } catch (error) {
    return { appearance: { ...DEFAULT_APPEARANCE }, available: false, error: error instanceof BridgeUnavailable ? '' : errorText(error) };
  }
}

// Native range for appearance.sidebarFontSize, in CSS pixels.
const SIDEBAR_FONT_SIZE = Object.freeze({ min: 12, max: 20, fallback: 15 });

export function sidebarFontSize(appearance) {
  const value = appearance?.sidebarFontSize;
  return Number.isInteger(value) && value >= SIDEBAR_FONT_SIZE.min && value <= SIDEBAR_FONT_SIZE.max
    ? value
    : SIDEBAR_FONT_SIZE.fallback;
}

export function applyAppearance(appearance) {
  const root = document.documentElement;
  const custom = /^#[0-9a-fA-F]{6}$/.test(appearance.theme);
  root.dataset.tone = custom ? 'custom' : appearance.theme;
  if (custom) root.style.setProperty('--custom-seed', appearance.theme);
  else root.style.removeProperty('--custom-seed');
  root.dataset.sidebarMode = appearance.sidebarMode;
  root.style.setProperty('--sidebar-font-size', `${sidebarFontSize(appearance)}px`);
  const collapse = $('collapse');
  if (collapse) {
    const label = appearance.alwaysShowSidebar ? 'Auto-hide sidebar' : 'Keep sidebar visible';
    collapse.setAttribute('aria-label', label);
    collapse.setAttribute('aria-pressed', String(appearance.alwaysShowSidebar));
    collapse.title = label;
  }
  const scheme = appearance.colorMode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : appearance.colorMode;
  root.dataset.scheme = scheme;
  root.style.colorScheme = scheme;
}

// ---------------------------------------------------------------- sidebar state

const state = {
  windowId: null,
  store: null,
  records: {},
  tabs: new Map(),
  activeSpaceId: null,
  lastActive: {},
  appearance: { ...DEFAULT_APPEARANCE },
  model: null,
  items: new Map(),
  expect: [],
  focus: { pinned: null, today: null, favorites: null },
  peekKey: null,
  renaming: null,
  press: null,
  drag: null,
  suppressClick: false,
  closeFallback: null,
  lastWheel: 0,
  drawn: false,
  instant: false,
};

const pending = { set: {}, remove: new Set(), timer: 0 };
const urlOf = (tab) => tab?.url || tab?.pendingUrl || '';
const activeTab = () => [...state.tabs.values()].find((tab) => tab.active) || null;
const canFavicon = Boolean(api?.runtime?.getManifest?.().permissions?.includes('favicon'));

function setRecord(tabId, patch) {
  const record = { s: state.activeSpaceId, ...state.records[tabId], ...patch, u: urlOf(state.tabs.get(tabId)) };
  if (!record.e) delete record.e;
  delete record.k;
  state.records[tabId] = record;
  pending.set[tabId] = record;
  pending.remove.delete(String(tabId));
  scheduleFlush();
}

function dropRecord(tabId, persist = true) {
  delete state.records[tabId];
  delete pending.set[tabId];
  if (persist) {
    pending.remove.add(String(tabId));
    scheduleFlush();
  }
}

function scheduleFlush() {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(flushRecords, 150);
}

function flushRecords() {
  clearTimeout(pending.timer);
  const set = pending.set;
  const remove = [...pending.remove];
  if (!Object.keys(set).length && !remove.length) return Promise.resolve();
  pending.set = {};
  pending.remove = new Set();
  return workspace.patchMembers(set, remove).catch((error) => showToast(`Couldn’t save tab spaces. ${errorText(error)}`));
}

function saveWindowState() {
  void api.storage.session.set({ [windowStateKey(state.windowId)]: { activeSpaceId: state.activeSpaceId, lastActive: state.lastActive } }).catch(() => {});
}

async function mutate(fn) {
  try {
    const result = await workspace.update(fn);
    // storage.onChanged re-renders every window; read back now so this one updates without waiting.
    state.store = (await workspace.read()).store;
    render();
    return result;
  } catch (error) {
    showToast(errorText(error));
    throw error;
  }
}

async function refreshTabs() {
  const tabs = await api.tabs.query({ windowId: state.windowId });
  state.tabs = new Map(tabs.map((tab) => [tab.id, tab]));
  render();
}

// Chromium shifts other tabs' indices without events on create, close and pin; re-read them once.
let refreshTimer = 0;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshTabs().catch(() => {}), 50);
}

// ---------------------------------------------------------------- tab actions

async function createTab({ url, spaceId = state.activeSpaceId, entryId = '', pinned = false, active = true, index } = {}) {
  const expectation = { url: url || '', spaceId, entryId, pinned, at: Date.now() };
  state.expect.push(expectation);
  try {
    const tab = await api.tabs.create({ windowId: state.windowId, active, pinned, ...(url ? { url } : {}), ...(index === undefined ? {} : { index }) });
    if (state.expect.includes(expectation)) {
      state.expect.splice(state.expect.indexOf(expectation), 1);
      if (!state.tabs.has(tab.id)) state.tabs.set(tab.id, tab);
      setRecord(tab.id, { s: spaceId, e: entryId });
    } else if (entryId) {
      setRecord(tab.id, { s: spaceId, e: entryId });
    }
    render();
    return tab;
  } catch (error) {
    state.expect = state.expect.filter((item) => item !== expectation);
    showToast(`Couldn’t open a tab. ${errorText(error)}`);
    return null;
  }
}

function newTab() {
  const model = state.model;
  let index;
  if (model?.prefs.newTabPosition === 'top' && model.today.length) index = model.today[0].index;
  return createTab({ index });
}

function activate(tabId) {
  state.lastActive[state.activeSpaceId] = tabId;
  saveWindowState();
  return api.tabs.update(tabId, { active: true }).catch((error) => showToast(errorText(error)));
}

function openEntry(entry, tab) {
  if (tab) return activate(tab.id);
  const found = findNode(state.store, entry.id);
  return createTab({ url: entry.url, spaceId: found?.space?.id ?? state.activeSpaceId, entryId: entry.id, pinned: true });
}

// Keeps the space from going empty and keeps focus inside it when the active tab closes.
async function closeTabs(ids) {
  if (!ids.length) return;
  const visible = state.model ? visibleTabs(state.model) : [];
  const remaining = visible.filter((tab) => !ids.includes(tab.id));
  const current = activeTab();
  if (!remaining.length) {
    await createTab();
  } else if (current && ids.includes(current.id)) {
    const at = visible.findIndex((tab) => tab.id === current.id);
    const next = visible.slice(at + 1).find((tab) => !ids.includes(tab.id)) || [...visible.slice(0, Math.max(0, at))].reverse().find((tab) => !ids.includes(tab.id)) || remaining[0];
    await activate(next.id);
  }
  await api.tabs.remove(ids).catch((error) => showToast(errorText(error)));
}

async function pinTab(tab, { folderId = null, index } = {}) {
  const entry = await mutate((store) => addEntry(store, state.activeSpaceId, { url: urlOf(tab), title: tab.title }, { folderId, index })).catch(() => null);
  if (!entry) return;
  setRecord(tab.id, { s: state.activeSpaceId, e: entry.id });
  await api.tabs.update(tab.id, { pinned: true }).catch(() => {});
  render();
}

async function favoriteTab(tab, index) {
  const entry = await mutate((store) => {
    const fav = addFavorite(store, { url: urlOf(tab), title: tab.title });
    if (index !== undefined) moveNode(store, fav.id, { favorites: true, index });
    return fav;
  }).catch(() => null);
  if (!entry) return;
  setRecord(tab.id, { e: entry.id });
  await api.tabs.update(tab.id, { pinned: true }).catch(() => {});
  render();
}

// Removes an entry (pinned or favorite). A live tab stays open as a today tab.
async function unpinEntry(entry, tab, { undo = true } = {}) {
  const found = findNode(state.store, entry.id);
  if (!found) return;
  const spaceId = found.space?.id ?? state.activeSpaceId;
  const snapshot = { node: structuredClone(found.node), spaceId: found.space?.id ?? null, folderId: found.folder?.id ?? null, index: found.index, favorite: found.favorite };
  await mutate((store) => removeNode(store, entry.id)).catch(() => null);
  if (tab) {
    setRecord(tab.id, { s: spaceId, e: '' });
    await api.tabs.update(tab.id, { pinned: false }).catch(() => {});
  }
  render();
  if (undo && !tab) {
    showToast(snapshot.favorite ? 'Removed from favorites.' : 'Unpinned.', 'Undo', () => mutate((store) => {
      if (snapshot.favorite) store.favorites.splice(snapshot.index, 0, snapshot.node);
      else addEntry(store, resolveSpaceId(store, snapshot.spaceId), snapshot.node, { folderId: snapshot.folderId, index: snapshot.index });
    }).catch(() => {}));
  }
}

async function moveTabToSpace(tab, spaceId) {
  if (spaceId === state.activeSpaceId) return;
  const wasActive = tab.active;
  if (wasActive) {
    const others = visibleTabs(state.model).filter((item) => item.id !== tab.id);
    if (others.length) await activate(others[0].id);
    else await createTab();
  }
  setRecord(tab.id, { s: spaceId, e: '' });
  render();
  const name = state.store.spaces.find((space) => space.id === spaceId)?.name || 'another space';
  showToast(`Moved to ${name}.`, 'Go there', () => switchSpace(spaceId, { focusTab: tab.id }));
}

async function clearToday() {
  const tabs = [...state.model.today];
  if (!tabs.length) return;
  const restore = tabs.map((tab) => ({ url: urlOf(tab), index: tab.index })).filter((item) => isOpenableUrl(item.url));
  const spaceId = state.activeSpaceId;
  await closeTabs(tabs.map((tab) => tab.id));
  showToast(`Closed ${tabs.length} ${tabs.length === 1 ? 'tab' : 'tabs'}.`, 'Undo', () => restoreClosed(restore, spaceId));
}

async function restoreClosed(items, spaceId) {
  const restorable = new Map(items.map((item) => [item.url, item]));
  if (typeof api.sessions?.getRecentlyClosed === 'function' && typeof api.sessions.restore === 'function') {
    try {
      const recent = await api.sessions.getRecentlyClosed({ maxResults: 25 });
      for (const session of recent) {
        const tab = session.tab;
        if (!tab || !restorable.has(tab.url)) continue;
        restorable.delete(tab.url);
        state.expect.push({ url: tab.url, spaceId, entryId: '', pinned: false, at: Date.now() });
        await api.sessions.restore(tab.sessionId);
      }
    } catch { /* Fall back to reopening the URLs below. */ }
  }
  for (const item of restorable.values()) await createTab({ url: item.url, spaceId, active: false });
}

// ---------------------------------------------------------------- spaces

function switchSpace(spaceId, { activateTab = true, focusTab = null } = {}) {
  const next = resolveSpaceId(state.store, spaceId);
  if (next === state.activeSpaceId && !focusTab) return;
  const order = state.store.spaces.map((space) => space.id);
  const direction = order.indexOf(next) > order.indexOf(state.activeSpaceId) ? 'next' : 'prev';
  const current = activeTab();
  if (current && spaceOfTab(state.store, state.records, current.id) === state.activeSpaceId) state.lastActive[state.activeSpaceId] = current.id;
  state.activeSpaceId = next;
  saveWindowState();
  animateSpace(direction);
  state.instant = true;
  draw();
  state.instant = false;
  if (!activateTab) return;
  const visible = visibleTabs(state.model);
  const target = visible.find((tab) => tab.id === focusTab) || visible.find((tab) => tab.id === state.lastActive[next]) || visible.find((tab) => tab.active) || visible[0];
  if (target) void activate(target.id);
  else void createTab();
}

function animateSpace(direction) {
  if (reducedMotion.matches) return;
  const pane = $('space-pane');
  pane.classList.remove('slide-next', 'slide-prev');
  void pane.offsetWidth;
  pane.classList.add(direction === 'next' ? 'slide-next' : 'slide-prev');
}

function stepSpace(delta) {
  const spaces = state.store.spaces;
  const at = spaces.findIndex((space) => space.id === state.activeSpaceId);
  const next = spaces[at + delta];
  if (next) switchSpace(next.id);
}

async function createSpace() {
  if (state.store.spaces.length >= MAX_SPACES) {
    showToast(`You can have up to ${MAX_SPACES} spaces.`);
    return;
  }
  const used = new Set(state.store.spaces.map((space) => space.tone));
  const tone = TONES.find((item) => !used.has(item)) || TONES[state.store.spaces.length % TONES.length];
  const space = await mutate((store) => addSpace(store, { tone })).catch(() => null);
  if (!space) return;
  switchSpace(space.id);
  startRename({ kind: 'space', id: space.id });
}

async function deleteSpace(spaceId) {
  const space = state.store.spaces.find((item) => item.id === spaceId);
  if (!space) return;
  const fallback = await mutate((store) => removeSpace(store, spaceId)).catch(() => null);
  if (!fallback) return;
  if (state.activeSpaceId === spaceId) switchSpace(fallback, { activateTab: false });
  showToast(`Deleted ${space.name}. Its tabs moved to ${state.store.spaces[0].name}.`);
}

// ---------------------------------------------------------------- settings

export async function openSettings() {
  const url = api.runtime.getURL('workspace.html#/settings');
  try {
    const tabs = await api.tabs.query({});
    const existing = tabs.find((tab) => urlOf(tab).startsWith(url));
    if (existing) {
      await api.tabs.update(existing.id, { active: true });
      if (existing.windowId !== state.windowId) await api.windows.update(existing.windowId, { focused: true });
      return;
    }
    await createTab({ url });
  } catch (error) {
    showToast(`Couldn’t open settings. ${errorText(error)}`);
  }
}

// ---------------------------------------------------------------- rendering

let frame = 0;
function render() {
  if (frame || !state.store) return;
  frame = requestAnimationFrame(() => { frame = 0; draw(); });
}

function faviconFor(tab, url) {
  if (typeof tab?.favIconUrl === 'string' && tab.favIconUrl.startsWith('data:image/')) return tab.favIconUrl;
  const page = urlOf(tab) || url;
  if (canFavicon && /^https?:/i.test(page)) return api.runtime.getURL(`/_favicon/?pageUrl=${encodeURIComponent(page)}&size=32`);
  return '';
}

function updateFavicon(holder, tab, url, title) {
  const src = faviconFor(tab, url);
  const fallback = () => {
    const page = urlOf(tab) || url || '';
    holder.textContent = /^chrome:\/\/newtab/.test(page) || !page ? '' : (hostLabel(page)[0] || title[0] || '·').toUpperCase();
    holder.classList.toggle('blank', !holder.textContent);
  };
  if (!src || holder.dataset.failedIcon === src) {
    fallback();
    return;
  }
  let img = holder.querySelector('img');
  if (!img) {
    img = el('img', '', { alt: '', width: '16', height: '16', draggable: 'false' });
    holder.replaceChildren(img);
  }
  holder.classList.remove('blank');
  img.onerror = () => {
    if (holder.contains(img) && img.getAttribute('src') === src) {
      holder.dataset.failedIcon = src;
      fallback();
    }
  };
  if (img.getAttribute('src') !== src) img.src = src;
}

export const favoriteTitle = (entry) => entry.customTitle || entry.title || hostLabel(entry.url);

// Tells the browser which tabs in this window are live favourites; links from
// them open in a peek. Sent only when the set changes.
function syncPeekSources(model) {
  if (typeof api.breezerPrivate?.setPeekSources !== 'function') return;
  const ids = model.favorites.map((item) => item.tab?.id).filter(Number.isInteger).sort((a, b) => a - b);
  const key = ids.join(',');
  if (key === state.peekKey) return;
  state.peekKey = key;
  void callBridge('setPeekSources', ids).catch(() => {
    if (state.peekKey === key) state.peekKey = null;
  });
}

// Keyed reconcile: reuses nodes so focus, hover and transitions survive re-renders.
function reconcile(container, items) {
  const existing = new Map();
  for (const child of container.children) if (!child.classList.contains('leaving')) existing.set(child.dataset.key, child);
  let previous = null;
  for (const item of items) {
    let node = existing.get(item.key);
    if (!node || node.dataset.kind !== item.kind) {
      node = item.create();
      node.dataset.key = item.key;
      node.dataset.kind = item.kind;
      if (state.drawn && !state.instant && !reducedMotion.matches) node.classList.add('entering');
    }
    existing.delete(item.key);
    item.update(node);
    const next = previous ? previous.nextSibling : container.firstChild;
    if (next !== node) container.insertBefore(node, next);
    previous = node;
  }
  for (const node of existing.values()) {
    if (reducedMotion.matches || !state.drawn || state.instant) { node.remove(); continue; }
    node.classList.add('leaving');
    node.setAttribute('aria-hidden', 'true');
    node.inert = true;
    setTimeout(() => node.remove(), 140);
  }
}

function rowNode() {
  const row = el('div', 'row', { role: 'treeitem', tabindex: '-1' });
  const favicon = el('span', 'favicon', { 'aria-hidden': 'true' });
  const title = el('span', 'title');
  const sound = el('button', 'row-sound', { tabindex: '-1', type: 'button' });
  const action = el('button', 'row-action', { tabindex: '-1', type: 'button' });
  row.append(favicon, title, sound, action);
  return row;
}

function updateRow(row, { title, tab, url, active, asleep, actionLabel, actionIcon, selected }) {
  const [favicon, label, sound, action] = row.children;
  if (state.renaming?.key !== row.dataset.key && label.textContent !== title) label.textContent = title;
  updateFavicon(favicon, tab, url, title);
  row.classList.toggle('active', Boolean(active));
  row.classList.toggle('asleep', Boolean(asleep));
  row.classList.toggle('loading', tab?.status === 'loading');
  row.classList.toggle('discarded', Boolean(tab?.discarded));
  row.setAttribute('aria-selected', String(Boolean(selected)));
  row.setAttribute('aria-label', [title, asleep ? 'asleep' : '', tab?.audible ? 'playing audio' : ''].filter(Boolean).join(', '));
  const audible = Boolean(tab && (tab.audible || tab.mutedInfo?.muted));
  sound.hidden = !audible;
  if (audible) {
    const muted = Boolean(tab.mutedInfo?.muted);
    sound.replaceChildren(icon(muted ? 'muted' : 'sound'));
    sound.setAttribute('aria-label', muted ? 'Unmute tab' : 'Mute tab');
    sound.title = muted ? 'Unmute tab' : 'Mute tab';
  }
  if (action.dataset.icon !== actionIcon) { action.replaceChildren(icon(actionIcon)); action.dataset.icon = actionIcon; }
  action.setAttribute('aria-label', actionLabel);
  action.title = actionLabel;
}

function entryRow(item, key) {
  const { entry, tab } = item;
  return {
    key,
    kind: 'entry',
    create: rowNode,
    update: (row) => updateRow(row, {
      title: displayTitle(entry, tab), tab, url: entry.url, active: tab?.active, selected: tab?.active, asleep: !tab,
      actionLabel: tab ? 'Close tab (stays pinned)' : 'Unpin', actionIcon: tab ? 'close' : 'minus',
    }),
  };
}

function folderNode() {
  const folder = el('div', 'folder', { role: 'treeitem', tabindex: '-1' });
  const head = el('div', 'row folder-row');
  const chevron = el('span', 'chevron', { 'aria-hidden': 'true' });
  chevron.append(icon('chevron'));
  const glyph = el('span', 'favicon folder-glyph', { 'aria-hidden': 'true' });
  glyph.append(icon('folder'));
  const title = el('span', 'title');
  const count = el('span', 'count', { 'aria-hidden': 'true' });
  head.append(chevron, glyph, title, count);
  const group = el('div', 'folder-children', { role: 'group' });
  folder.append(head, group);
  return folder;
}

function drawTree(container, items) {
  reconcile(container, items);
}

function draw() {
  if (!state.store) return;
  const model = buildSidebarModel({ store: state.store, records: state.records, tabs: [...state.tabs.values()], activeSpaceId: state.activeSpaceId });
  state.model = model;
  if (model.space.id !== state.activeSpaceId) {
    state.activeSpaceId = model.space.id;
    saveWindowState();
  }
  state.items = new Map();
  const sidebar = $('sidebar');
  sidebar.dataset.tone = /^#[0-9a-fA-F]{6}$/.test(state.appearance.theme) ? 'custom' : model.space.tone;
  sidebar.dataset.close = model.prefs.closeButton;
  if (state.renaming?.kind !== 'space') $('space-name').textContent = model.space.name;
  $('space-glyph').textContent = (model.space.name[0] || '·').toUpperCase();

  // Favorites
  const favoriteItems = model.favorites.map((item) => {
    const key = `v:${item.entry.id}`;
    state.items.set(key, { type: 'favorite', ...item });
    return {
      key,
      kind: 'favorite',
      create: () => {
        const tile = el('button', 'tile', { type: 'button', tabindex: '-1' });
        tile.append(el('span', 'favicon', { 'aria-hidden': 'true' }));
        return tile;
      },
      update: (tile) => {
        // A favourite keeps its saved identity while its live tab browses.
        const title = favoriteTitle(item.entry);
        updateFavicon(tile.firstChild, null, item.entry.url, title);
        tile.title = title;
        tile.setAttribute('aria-label', `${title}${item.tab ? '' : ', asleep'}`);
        tile.setAttribute('aria-pressed', String(Boolean(item.tab?.active)));
        tile.classList.toggle('live', Boolean(item.tab));
        tile.classList.toggle('active', Boolean(item.tab?.active));
      },
    };
  });
  reconcile($('favorites'), favoriteItems);
  syncPeekSources(model);
  $('favorites').hidden = !favoriteItems.length && !state.drag;
  $('favorites').classList.toggle('empty', !favoriteItems.length);

  // Pinned tree
  const pinnedItems = model.pinned.map((node) => {
    if (node.kind === 'entry') {
      const key = `e:${node.entry.id}`;
      state.items.set(key, { type: 'entry', entry: node.entry, tab: node.tab, folder: null });
      return entryRow(node, key);
    }
    const key = `f:${node.folder.id}`;
    state.items.set(key, { type: 'folder', folder: node.folder, children: node.children });
    return {
      key,
      kind: 'folder',
      create: folderNode,
      update: (folder) => {
        const [head, group] = folder.children;
        const open = node.folder.open;
        folder.setAttribute('aria-expanded', String(open));
        folder.setAttribute('aria-label', `${node.folder.name}, folder, ${node.children.length} ${node.children.length === 1 ? 'tab' : 'tabs'}`);
        folder.setAttribute('aria-selected', 'false');
        const title = head.querySelector('.title');
        if (state.renaming?.key !== key && title.textContent !== node.folder.name) title.textContent = node.folder.name;
        head.querySelector('.count').textContent = open || !node.children.length ? '' : String(node.children.length);
        head.classList.toggle('contains-active', !open && node.children.some((child) => child.tab?.active));
        group.hidden = !open;
        reconcile(group, node.children.map((child) => {
          const childKey = `e:${child.entry.id}`;
          state.items.set(childKey, { type: 'entry', entry: child.entry, tab: child.tab, folder: node.folder });
          return entryRow(child, childKey);
        }));
      },
    };
  });
  reconcile($('pinned'), pinnedItems);
  $('pinned').classList.toggle('empty', !pinnedItems.length);

  // Today
  const todayItems = model.today.map((tab) => {
    const key = `t:${tab.id}`;
    state.items.set(key, { type: 'tab', tab });
    return {
      key,
      kind: 'tab',
      create: rowNode,
      update: (row) => updateRow(row, { title: displayTitle(null, tab), tab, active: tab.active, selected: tab.active, actionLabel: 'Close tab', actionIcon: 'close' }),
    };
  });
  reconcile($('today'), todayItems);
  $('clear-today').hidden = !todayItems.length;

  // Spaces dock
  reconcile($('spaces'), model.spaces.map((space, index) => ({
    key: `s:${space.id}`,
    kind: 'space',
    create: () => {
      const dot = el('button', 'space-dot', { type: 'button', role: 'tab' });
      dot.append(el('span', 'dot', { 'aria-hidden': 'true' }));
      return dot;
    },
    update: (dot) => {
      const selected = space.id === model.space.id;
      dot.dataset.tone = space.tone;
      dot.setAttribute('aria-selected', String(selected));
      dot.tabIndex = selected ? 0 : -1;
      dot.setAttribute('aria-label', `${space.name}, ${space.tabCount} ${space.tabCount === 1 ? 'tab' : 'tabs'}`);
      dot.title = index < 4 ? `${space.name} (⌃${index + 1})` : space.name;
    },
  })));
  $('add-space').hidden = model.spaces.length >= MAX_SPACES;

  syncRovingFocus();
  state.drawn = true;
}

// ---------------------------------------------------------------- keyboard focus

const TREES = ['pinned', 'today'];

function treeItems(tree) {
  return [...tree.querySelectorAll('[role="treeitem"]')].filter((node) => !node.classList.contains('leaving') && !node.closest('.folder-children[hidden]'));
}

function syncRovingFocus() {
  for (const name of TREES) {
    const items = treeItems($(name));
    const wanted = items.find((node) => node.dataset.key === state.focus[name])
      || items.find((node) => node.getAttribute('aria-selected') === 'true')
      || items[0];
    for (const node of items) node.tabIndex = node === wanted ? 0 : -1;
  }
  const tiles = [...$('favorites').children].filter((node) => !node.classList.contains('leaving'));
  const tile = tiles.find((node) => node.dataset.key === state.focus.favorites) || tiles.find((node) => node.classList.contains('active')) || tiles[0];
  for (const node of tiles) node.tabIndex = node === tile ? 0 : -1;
}

function focusItem(node) {
  if (!node) return;
  const tree = node.closest('[role="tree"]');
  if (tree) {
    state.focus[tree.id] = node.dataset.key;
    for (const item of treeItems(tree)) item.tabIndex = item === node ? 0 : -1;
  }
  node.focus();
}

function itemFromNode(node) {
  const host = node?.closest?.('[data-key]');
  return host ? { node: host, key: host.dataset.key, item: state.items.get(host.dataset.key) } : null;
}

function activateItem(found) {
  if (!found?.item) return;
  const { item } = found;
  if (item.type === 'tab') void activate(item.tab.id);
  else if (item.type === 'entry' || item.type === 'favorite') void openEntry(item.entry, item.tab);
  else if (item.type === 'folder') void mutate((store) => setFolderOpen(store, item.folder.id, !item.folder.open)).catch(() => {});
}

function closeItem(found) {
  const item = found?.item;
  if (!item) return;
  if (item.tab) void closeTabs([item.tab.id]);
  else if (item.type === 'entry' || item.type === 'favorite') void unpinEntry(item.entry, null);
}

async function reorderItem(found, delta) {
  const item = found?.item;
  if (!item) return;
  if (item.type === 'tab') {
    await refreshTabs();
    draw();
    const list = state.model.today;
    const at = list.findIndex((tab) => tab.id === item.tab.id);
    const neighbor = list[at + delta];
    if (!neighbor) return;
    await api.tabs.move(item.tab.id, { index: neighbor.index }).catch((error) => showToast(errorText(error)));
  } else {
    const id = item.type === 'folder' ? item.folder.id : item.entry.id;
    await mutate((store) => {
      const located = findNode(store, id);
      if (!located) return;
      const index = located.index + delta;
      if (index < 0 || index >= located.list.length) return;
      const [node] = located.list.splice(located.index, 1);
      located.list.splice(index, 0, node);
    }).catch(() => {});
  }
  requestAnimationFrame(() => focusItem(document.querySelector(`[data-key="${CSS.escape(found.key)}"]`)));
}

function onTreeKey(event) {
  const found = itemFromNode(event.target);
  if (!found || found.node.getAttribute('role') !== 'treeitem' || state.renaming) return;
  const tree = event.currentTarget;
  const items = treeItems(tree);
  const at = items.indexOf(found.node);
  const folder = found.item?.type === 'folder' ? found.item.folder : null;
  let handled = true;
  switch (event.key) {
    case 'ArrowDown':
      if (event.altKey) void reorderItem(found, 1);
      else focusItem(items[at + 1] || $(tree.id === 'pinned' ? 'new-tab' : 'today').querySelector('[tabindex="0"]'));
      break;
    case 'ArrowUp':
      if (event.altKey) void reorderItem(found, -1);
      else focusItem(items[at - 1]);
      break;
    case 'Home': focusItem(items[0]); break;
    case 'End': focusItem(items[items.length - 1]); break;
    case 'ArrowRight':
      if (folder && !folder.open) void mutate((store) => setFolderOpen(store, folder.id, true)).catch(() => {});
      else if (folder) focusItem(found.node.querySelector('.folder-children [role="treeitem"]'));
      break;
    case 'ArrowLeft':
      if (folder?.open) void mutate((store) => setFolderOpen(store, folder.id, false)).catch(() => {});
      else if (found.node.closest('.folder-children')) focusItem(found.node.closest('.folder'));
      break;
    case 'Enter':
    case ' ':
      activateItem(found);
      break;
    case 'Delete':
    case 'Backspace':
      closeItem(found);
      break;
    case 'F2':
      startRenameFor(found);
      break;
    case 'ContextMenu':
      openItemMenu(found, found.node.getBoundingClientRect());
      break;
    case 'F10':
      if (event.shiftKey) openItemMenu(found, found.node.getBoundingClientRect());
      else handled = false;
      break;
    default:
      handled = false;
  }
  if (handled) { event.preventDefault(); event.stopPropagation(); }
}

function onFavoritesKey(event) {
  const tiles = [...$('favorites').children].filter((node) => !node.classList.contains('leaving'));
  const at = tiles.indexOf(event.target.closest('.tile'));
  if (at < 0) return;
  const found = itemFromNode(tiles[at]);
  const go = (index) => {
    const tile = tiles[Math.max(0, Math.min(tiles.length - 1, index))];
    state.focus.favorites = tile.dataset.key;
    syncRovingFocus();
    tile.focus();
  };
  const handlers = {
    ArrowRight: () => go(at + 1), ArrowLeft: () => go(at - 1), ArrowDown: () => go(at + 4), ArrowUp: () => go(at - 4),
    Home: () => go(0), End: () => go(tiles.length - 1), Delete: () => closeItem(found), Backspace: () => closeItem(found),
    ContextMenu: () => openItemMenu(found, tiles[at].getBoundingClientRect()),
  };
  if (event.key === 'F10' && event.shiftKey) handlers.F10 = handlers.ContextMenu;
  const handler = handlers[event.key];
  if (handler) { event.preventDefault(); handler(); }
}

// ---------------------------------------------------------------- inline rename

function startRenameFor(found) {
  const item = found?.item;
  if (item?.type === 'folder') startRename({ kind: 'folder', id: item.folder.id, key: found.key });
  else if (item?.type === 'entry' || item?.type === 'favorite') startRename({ kind: 'entry', id: item.entry.id, key: found.key });
}

function startRename(target) {
  // Flush a pending render so a just-created folder or space has its row.
  if (frame) { cancelAnimationFrame(frame); frame = 0; draw(); }
  {
    let label;
    let initial;
    if (target.kind === 'space') {
      label = $('space-name');
      initial = state.store.spaces.find((space) => space.id === target.id)?.name || '';
    } else {
      const host = document.querySelector(`[data-key="${CSS.escape(target.key)}"]`);
      label = host?.querySelector('.title');
      const found = findNode(state.store, target.id);
      initial = target.kind === 'folder' ? found?.node.name : displayTitle(found?.node, state.items.get(target.key)?.tab);
    }
    if (!label) return;
    state.renaming = target;
    const input = el('input', 'rename', { type: 'text', 'aria-label': target.kind === 'space' ? 'Space name' : 'Name', maxlength: target.kind === 'space' ? '60' : '120', spellcheck: 'false' });
    input.value = initial || '';
    label.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      state.renaming = null;
      label.textContent = initial || '';
      if (save && value !== initial) {
        await mutate((store) => {
          if (target.kind === 'space') renameSpace(store, target.id, value);
          else renameNode(store, target.id, value);
        }).catch(() => {});
      }
      render();
      const back = target.kind === 'space' ? $('space-menu') : document.querySelector(`[data-key="${CSS.escape(target.key)}"]`);
      back?.focus();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); void finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => void finish(true));
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
  }
}

// ---------------------------------------------------------------- menu

let menuReturn = null;

function openMenu(entries, rect, returnFocus) {
  const menu = $('menu');
  menuReturn = returnFocus || document.activeElement;
  const nodes = [];
  menu.replaceChildren();
  for (const entry of entries) {
    if (entry === '-') { menu.append(el('div', 'menu-separator', { role: 'separator' })); continue; }
    if (entry.heading) { menu.append(el('div', 'menu-heading', { role: 'presentation' })); menu.lastChild.textContent = entry.heading; continue; }
    const button = el('button', `menu-item${entry.danger ? ' danger' : ''}`, { role: 'menuitem', type: 'button', tabindex: '-1' });
    if (entry.tone) { const swatch = el('span', 'menu-swatch', { 'aria-hidden': 'true' }); swatch.dataset.tone = entry.tone; button.append(swatch); }
    const label = el('span');
    label.textContent = entry.label;
    button.append(label);
    if (entry.checked) { button.setAttribute('aria-checked', 'true'); button.setAttribute('role', 'menuitemradio'); }
    if (entry.disabled) button.setAttribute('aria-disabled', 'true');
    button.addEventListener('click', () => {
      if (entry.disabled) return;
      closeMenu(false);
      entry.run();
    });
    nodes.push(button);
    menu.append(button);
  }
  menu.hidden = false;
  const bounds = $('sidebar').getBoundingClientRect();
  const height = menu.offsetHeight;
  const width = menu.offsetWidth;
  const top = Math.min(Math.max(8, rect.bottom + 4), bounds.height - height - 8);
  const left = Math.min(Math.max(8, rect.left + 8), bounds.width - width - 8);
  menu.style.top = `${top < rect.bottom && rect.top - height - 4 > 8 ? rect.top - height - 4 : top}px`;
  menu.style.left = `${Math.max(4, left)}px`;
  nodes[0]?.focus();
}

function closeMenu(restore = true) {
  const menu = $('menu');
  if (menu.hidden) return;
  menu.hidden = true;
  menu.replaceChildren();
  if (restore && menuReturn?.isConnected) menuReturn.focus();
  menuReturn = null;
}

function spaceTargets(exclude, run) {
  const others = state.store.spaces.filter((space) => space.id !== exclude);
  if (!others.length) return [];
  return ['-', { heading: 'Move to space' }, ...others.map((space) => ({ label: space.name, tone: space.tone, run: () => run(space.id) }))];
}

function copyLink(url) {
  navigator.clipboard?.writeText(url).then(() => showToast('Link copied.'), () => showToast('Couldn’t copy the link.'));
}

function openItemMenu(found, rect) {
  const item = found?.item;
  if (!item) return;
  let entries = [];
  if (item.type === 'tab') {
    const { tab } = item;
    entries = [
      { label: 'Pin tab', run: () => pinTab(tab) },
      { label: 'Add to favorites', disabled: state.store.favorites.length >= 12, run: () => favoriteTab(tab) },
      { label: 'Duplicate', run: () => api.tabs.duplicate(tab.id).catch((error) => showToast(errorText(error))) },
      ...(isOpenableUrl(urlOf(tab)) ? [{ label: 'Copy link', run: () => copyLink(urlOf(tab)) }] : []),
      ...spaceTargets(state.activeSpaceId, (spaceId) => moveTabToSpace(tab, spaceId)),
      '-',
      { label: 'Close other tabs', disabled: state.model.today.length < 2, run: () => closeTabs(state.model.today.filter((other) => other.id !== tab.id).map((other) => other.id)) },
      { label: 'Close tab', danger: true, run: () => closeTabs([tab.id]) },
    ];
  } else if (item.type === 'entry') {
    const { entry, tab } = item;
    const folders = state.model.space.pinned.filter((node) => node.kind === 'folder' && node.id !== item.folder?.id);
    entries = [
      { label: 'Rename', run: () => startRenameFor(found) },
      ...(entry.customTitle ? [{ label: 'Use page title', run: () => mutate((store) => renameNode(store, entry.id, '')).catch(() => {}) }] : []),
      ...(tab && urlOf(tab) !== entry.url && isOpenableUrl(urlOf(tab)) ? [{ label: 'Pin this page instead', run: () => mutate((store) => { const node = findNode(store, entry.id)?.node; if (node) { node.url = urlOf(tab); node.title = tab.title || node.title; } }).catch(() => {}) }] : []),
      { label: 'Add to favorites', disabled: state.store.favorites.length >= 12, run: () => mutate((store) => moveNode(store, entry.id, { favorites: true })).catch(() => {}) },
      ...(item.folder ? [{ label: `Remove from ${item.folder.name}`, run: () => mutate((store) => moveNode(store, entry.id, { spaceId: state.activeSpaceId })).catch(() => {}) }] : []),
      ...folders.map((folder) => ({ label: `Move to ${folder.name}`, run: () => mutate((store) => moveNode(store, entry.id, { spaceId: state.activeSpaceId, folderId: folder.id })).catch(() => {}) })),
      { label: 'Copy link', run: () => copyLink(entry.url) },
      ...spaceTargets(state.activeSpaceId, (spaceId) => mutate((store) => moveNode(store, entry.id, { spaceId })).catch(() => {})),
      '-',
      ...(tab ? [{ label: 'Close tab', run: () => closeTabs([tab.id]) }] : []),
      { label: 'Unpin', danger: true, run: () => unpinEntry(entry, tab) },
    ];
  } else if (item.type === 'favorite') {
    const { entry, tab } = item;
    entries = [
      { label: 'Rename', run: () => startRenameFor(found) },
      { label: 'Copy link', run: () => copyLink(entry.url) },
      ...(tab ? ['-', { label: 'Close tab', run: () => closeTabs([tab.id]) }] : ['-']),
      { label: 'Remove from favorites', danger: true, run: () => unpinEntry(entry, tab) },
    ];
  } else if (item.type === 'folder') {
    const { folder } = item;
    entries = [
      { label: folder.open ? 'Collapse' : 'Expand', run: () => mutate((store) => setFolderOpen(store, folder.id, !folder.open)).catch(() => {}) },
      { label: 'Rename', run: () => startRenameFor(found) },
      ...spaceTargets(state.activeSpaceId, (spaceId) => mutate((store) => moveNode(store, folder.id, { spaceId })).catch(() => {})),
      '-',
      { label: 'Delete folder', danger: true, run: () => mutate((store) => removeNode(store, folder.id)).then(() => showToast(`Deleted ${folder.name}. Its tabs stay pinned.`)).catch(() => {}) },
    ];
  }
  openMenu(entries, rect, found.node);
}

function openSpaceMenu() {
  const space = state.model.space;
  openMenu([
    { label: 'Rename space', run: () => startRename({ kind: 'space', id: space.id }) },
    { label: 'New folder', run: async () => {
      const folder = await mutate((store) => addFolder(store, space.id)).catch(() => null);
      if (folder) startRename({ kind: 'folder', id: folder.id, key: `f:${folder.id}` });
    } },
    '-',
    { heading: 'Color' },
    ...TONES.map((tone) => ({ label: TONE_NAMES[tone], tone, checked: tone === space.tone, run: () => mutate((store) => setSpaceTone(store, space.id, tone)).catch(() => {}) })),
    '-',
    { label: 'Settings', run: openSettings },
    { label: 'Delete space', danger: true, disabled: state.store.spaces.length <= 1, run: () => deleteSpace(space.id) },
  ], $('space-menu').getBoundingClientRect(), $('space-menu'));
}

function onMenuKey(event) {
  const items = [...$('menu').querySelectorAll('[role^="menuitem"]')];
  const at = items.indexOf(document.activeElement);
  const go = (index) => items[(index + items.length) % items.length]?.focus();
  if (event.key === 'ArrowDown') go(at + 1);
  else if (event.key === 'ArrowUp') go(at - 1);
  else if (event.key === 'Home') go(0);
  else if (event.key === 'End') go(items.length - 1);
  else if (event.key === 'Escape' || event.key === 'Tab') closeMenu();
  else return;
  event.preventDefault();
}

// ---------------------------------------------------------------- toast

let toastTimer = 0;
function showToast(message, actionLabel = '', action = null) {
  const toast = $('toast');
  $('toast-text').textContent = message;
  const button = $('toast-action');
  button.hidden = !action;
  button.textContent = actionLabel;
  button.onclick = action ? () => { hideToast(); action(); } : null;
  toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, action ? 8000 : 4000);
}

function hideToast() {
  clearTimeout(toastTimer);
  $('toast').hidden = true;
}

// ---------------------------------------------------------------- drag and drop (pointer events)

function dropTargetAt(x, y) {
  const hit = document.elementFromPoint(x, y);
  if (!hit) return null;
  const dot = hit.closest('.space-dot');
  if (dot) return { zone: 'space', spaceId: dot.dataset.key.slice(2), node: dot };
  if (hit.closest('#favorites')) {
    const tile = hit.closest('.tile');
    const tiles = [...$('favorites').children].filter((node) => !node.classList.contains('leaving'));
    let index = tiles.length;
    if (tile) {
      const rect = tile.getBoundingClientRect();
      index = tiles.indexOf(tile) + (x > rect.left + rect.width / 2 ? 1 : 0);
    }
    return { zone: 'favorites', index, node: $('favorites') };
  }
  const tree = hit.closest('#pinned, #today, .divider-row, .new-tab, #empty-hit');
  if (!tree) return null;
  if (tree.id === 'empty-hit' || tree.id === 'today' || tree.classList.contains('new-tab')) {
    if (tree.classList.contains('new-tab')) return { zone: 'today', before: state.model.today[0] || null, line: tree, after: true };
    const row = hit.closest('[data-key^="t:"]');
    if (!row) return { zone: 'today', before: null, line: $('today').lastElementChild || $('new-tab'), after: true };
    const rect = row.getBoundingClientRect();
    const tabs = state.model.today;
    const at = tabs.findIndex((tab) => `t:${tab.id}` === row.dataset.key);
    const after = y > rect.top + rect.height / 2;
    return { zone: 'today', before: tabs[at + (after ? 1 : 0)] || null, line: row, after };
  }
  if (tree.classList.contains('divider-row')) return { zone: 'pinned', folderId: null, index: state.model.space.pinned.length, line: $('pinned').lastElementChild || $('pinned'), after: true };
  const row = hit.closest('.folder-row, [data-key^="e:"]');
  if (!row) return { zone: 'pinned', folderId: null, index: state.model.space.pinned.length, line: $('pinned').lastElementChild || $('pinned'), after: true };
  const rect = row.getBoundingClientRect();
  const ratio = (y - rect.top) / rect.height;
  if (row.classList.contains('folder-row')) {
    const folderNode = row.closest('.folder');
    const folderId = folderNode.dataset.key.slice(2);
    const index = state.model.space.pinned.findIndex((node) => node.kind === 'folder' && node.folder.id === folderId);
    if (ratio > 0.25 && ratio < 0.75) return { zone: 'pinned', folderId, index: undefined, into: folderNode };
    return { zone: 'pinned', folderId: null, index: index + (ratio >= 0.75 ? 1 : 0), line: row, after: ratio >= 0.75 };
  }
  const item = state.items.get(row.dataset.key);
  const parent = item.folder;
  const list = parent ? state.model.space.pinned.find((node) => node.kind === 'folder' && node.folder.id === parent.id).children.map((child) => child.entry.id) : state.model.space.pinned.map((node) => (node.kind === 'folder' ? node.folder.id : node.entry.id));
  const after = ratio > 0.5;
  return { zone: 'pinned', folderId: parent?.id ?? null, index: list.indexOf(item.entry.id) + (after ? 1 : 0), line: row, after };
}

function showDropTarget(target) {
  document.querySelectorAll('.drop-into').forEach((node) => node.classList.remove('drop-into'));
  const line = $('drag-line');
  line.hidden = true;
  if (!target) return;
  if (target.into || target.zone === 'space' || target.zone === 'favorites') {
    (target.into || target.node).classList.add('drop-into');
    return;
  }
  const bounds = $('sidebar').getBoundingClientRect();
  const rect = target.line.getBoundingClientRect();
  line.style.top = `${(target.after ? rect.bottom : rect.top) - bounds.top - 1}px`;
  line.hidden = false;
}

async function performDrop(source, target) {
  if (!target) return;
  const { item } = source;
  const entryId = item.type === 'folder' ? item.folder.id : item.entry?.id;
  try {
    if (target.zone === 'space') {
      if (item.type === 'tab') await moveTabToSpace(item.tab, target.spaceId);
      else if (item.type !== 'favorite') await mutate((store) => moveNode(store, entryId, { spaceId: target.spaceId }));
      return;
    }
    if (target.zone === 'favorites') {
      if (item.type === 'tab') await favoriteTab(item.tab, target.index);
      else if (item.type !== 'folder') await mutate((store) => moveNode(store, entryId, { favorites: true, index: target.index }));
      return;
    }
    if (target.zone === 'pinned') {
      if (item.type === 'tab') await pinTab(item.tab, { folderId: target.folderId, index: target.index });
      else await mutate((store) => moveNode(store, entryId, { spaceId: state.activeSpaceId, folderId: target.folderId, index: target.index }));
      return;
    }
    if (target.zone === 'today') {
      await refreshTabs();
      draw();
      const today = state.model.today;
      const before = target.before && (state.tabs.get(target.before.id) || null);
      let tab = item.tab;
      if (item.type === 'folder') return;
      if (item.type !== 'tab') {
        await unpinEntry(item.entry, item.tab, { undo: false });
        if (!tab) {
          tab = await createTab({ url: item.entry.url });
          if (!tab) return;
        }
        tab = (await api.tabs.get(tab.id).catch(() => null)) || tab;
      }
      const index = moveIndex(tab, before, before ? null : today.filter((item) => item.id !== tab.id).at(-1));
      await api.tabs.move(tab.id, { index });
    }
  } catch (error) {
    showToast(errorText(error));
  }
}

function onPointerDown(event) {
  if (event.button !== 0 || state.renaming || event.target.closest('.row-action, .row-sound, input')) return;
  const found = itemFromNode(event.target);
  if (!found?.item || found.key.startsWith('s:')) return;
  state.press = { ...found, x: event.clientX, y: event.clientY, pointerId: event.pointerId, source: event.target.closest('.folder-row') || found.node };
}

function onPointerMove(event) {
  const press = state.press;
  if (!press || event.pointerId !== press.pointerId) return;
  if (!state.drag) {
    if (Math.hypot(event.clientX - press.x, event.clientY - press.y) < 5) return;
    state.drag = press;
    press.source.classList.add('lifted');
    $('sidebar').classList.add('dragging');
    $('favorites').hidden = false;
    try { $('sidebar').setPointerCapture(event.pointerId); } catch { /* Pointer already released. */ }
  }
  state.drag.target = dropTargetAt(event.clientX, event.clientY);
  showDropTarget(state.drag.target);
}

function endDrag(commit) {
  const drag = state.drag;
  state.press = null;
  state.drag = null;
  if (!drag) return;
  drag.source.classList.remove('lifted');
  $('sidebar').classList.remove('dragging');
  showDropTarget(null);
  state.suppressClick = true;
  setTimeout(() => { state.suppressClick = false; }, 0);
  if (commit) void performDrop(drag, drag.target);
  render();
}

// ---------------------------------------------------------------- Chromium tab events

function belongsHere(windowId) {
  return windowId === state.windowId;
}

function onCreated(tab) {
  if (!belongsHere(tab.windowId)) return;
  state.tabs.set(tab.id, tab);
  state.expect = state.expect.filter((item) => Date.now() - item.at < 10000);
  const url = urlOf(tab);
  const expectation = state.expect.find((item) => (item.url ? item.url === url : !url || /^chrome:\/\/newtab/.test(url)) && item.pinned === Boolean(tab.pinned));
  if (expectation) {
    state.expect.splice(state.expect.indexOf(expectation), 1);
    setRecord(tab.id, { s: expectation.spaceId, e: expectation.entryId });
  } else if (!state.records[tab.id]) {
    const opener = tab.openerTabId !== undefined && state.tabs.has(tab.openerTabId) ? spaceOfTab(state.store, state.records, tab.openerTabId) : null;
    setRecord(tab.id, { s: opener || state.activeSpaceId, e: '' });
  }
  scheduleRefresh();
  render();
}

function onUpdated(tabId, change, tab) {
  if (!belongsHere(tab.windowId)) return;
  state.tabs.set(tabId, tab);
  if (change.url && state.records[tabId]) setRecord(tabId, {});
  if (change.pinned === false && state.records[tabId]?.e) {
    // Unpinned outside the sidebar: keep the entry, release the tab into today.
    const found = findNode(state.store, state.records[tabId].e);
    setRecord(tabId, { s: found?.space?.id ?? state.activeSpaceId, e: '' });
  }
  if (change.pinned !== undefined) scheduleRefresh();
  render();
}

function onRemoved(tabId, info) {
  if (!belongsHere(info.windowId)) return;
  const removed = state.tabs.get(tabId);
  if (removed?.active && state.model) {
    const visible = visibleTabs(state.model);
    const at = visible.findIndex((tab) => tab.id === tabId);
    const neighbor = at >= 0 ? (visible[at + 1] || visible[at - 1] || null) : null;
    if (at >= 0) state.closeFallback = { spaceId: state.activeSpaceId, tabId: neighbor?.id ?? null, until: Date.now() + 800 };
  }
  state.tabs.delete(tabId);
  // Window closing (including browser quit) keeps the record so a restart can restore the tab's space.
  dropRecord(tabId, !info.isWindowClosing);
  scheduleRefresh();
  render();
}

function onActivated({ tabId, windowId }) {
  if (!belongsHere(windowId)) return;
  for (const tab of state.tabs.values()) tab.active = tab.id === tabId;
  const space = spaceOfTab(state.store, state.records, tabId);
  render();
  if (!space || space === state.activeSpaceId) {
    if (space) { state.lastActive[space] = tabId; saveWindowState(); }
    return;
  }
  // Chromium may pick a neighbor from a hidden space after a native close (⌘W).
  // Wait briefly for onRemoved; if that's what happened, stay in this space.
  setTimeout(() => {
    const fallback = state.closeFallback;
    const current = activeTab();
    if (!current || current.id !== tabId) return;
    if (fallback && fallback.until > Date.now() && fallback.spaceId === state.activeSpaceId) {
      state.closeFallback = null;
      if (fallback.tabId && state.tabs.has(fallback.tabId)) void activate(fallback.tabId);
      else void createTab();
      return;
    }
    switchSpace(space, { activateTab: false });
  }, 60);
}

function onAttached(tabId, info) {
  if (!belongsHere(info.newWindowId)) return;
  state.peekKey = null;
  void api.tabs.get(tabId).then((tab) => {
    state.tabs.set(tabId, tab);
    const record = state.records[tabId];
    setRecord(tabId, { s: state.activeSpaceId, e: record?.e || '' });
    return refreshTabs();
  }).catch(() => {});
}

function onDetached(tabId, info) {
  if (!belongsHere(info.oldWindowId)) return;
  state.peekKey = null;
  state.tabs.delete(tabId);
  // The receiving window rewrites the record; don't race it with a delete.
  dropRecord(tabId, false);
  void refreshTabs();
}

function onReplaced(addedTabId, removedTabId) {
  const record = state.records[removedTabId];
  if (!record) return;
  void api.tabs.get(addedTabId).then((tab) => {
    if (!belongsHere(tab.windowId)) return;
    state.tabs.delete(removedTabId);
    state.tabs.set(addedTabId, tab);
    dropRecord(removedTabId);
    setRecord(addedTabId, record);
    render();
  }).catch(() => {});
}

// Pinned tabs that came back after a restart without a saved entry become entries.
async function adoptPinned(tabIds) {
  const tabs = tabIds.map((id) => state.tabs.get(id)).filter((tab) => tab && isOpenableUrl(urlOf(tab)));
  if (!tabs.length) return;
  const created = await mutate((store) => tabs.map((tab) => {
    const spaceId = resolveSpaceId(store, state.records[tab.id]?.s);
    const matches = findEntriesByUrl(store, urlOf(tab)).filter(({ space }) => !space || space.id === spaceId);
    if (matches.length > 1) return [tab.id, null];
    const existing = matches[0];
    return [tab.id, existing?.entry.id || addEntry(store, spaceId, { url: urlOf(tab), title: tab.title }).id];
  })).catch(() => []);
  for (const [tabId, entryId] of created) if (entryId) setRecord(tabId, { e: entryId });
  render();
}

// ---------------------------------------------------------------- sidebar boot

async function initSidebar(route) {
  $('sidebar').hidden = false;
  document.body.classList.add('route-sidebar');
  try {
    state.windowId = route.windowId ?? (await api.windows.getCurrent()).id;
  } catch {
    showToast('Couldn’t find this window.');
    return;
  }
  const [{ appearance }, tabs, saved] = await Promise.all([
    loadAppearance(),
    api.tabs.query({ windowId: state.windowId }),
    api.storage.session.get(windowStateKey(state.windowId)).catch(() => ({})),
  ]);
  state.appearance = appearance;
  applyAppearance(appearance);
  const windowState = saved[windowStateKey(state.windowId)] || {};
  state.lastActive = windowState.lastActive && typeof windowState.lastActive === 'object' ? windowState.lastActive : {};
  state.tabs = new Map(tabs.map((tab) => [tab.id, tab]));
  const { assigned, orphanPinned, store } = await workspace.reconcile({ tabs, fallbackSpaceId: windowState.activeSpaceId });
  state.store = store;
  state.records = Object.fromEntries(Object.entries(assigned).map(([id, record]) => [id, { s: record.s, ...(record.e ? { e: record.e } : {}), u: record.u }]));
  const active = tabs.find((tab) => tab.active);
  state.activeSpaceId = store.spaces.some((space) => space.id === windowState.activeSpaceId)
    ? windowState.activeSpaceId
    : (active && spaceOfTab(store, state.records, active.id)) || store.spaces[0].id;
  saveWindowState();
  bindSidebar();
  // Re-read after subscribing: tabs can open while initial reconciliation awaits.
  await refreshTabs();
  draw();
  if (orphanPinned.length) void adoptPinned(orphanPinned);
}

function bindSidebar() {
  api.tabs.onCreated.addListener(onCreated);
  api.tabs.onUpdated.addListener(onUpdated);
  api.tabs.onRemoved.addListener(onRemoved);
  api.tabs.onActivated.addListener(onActivated);
  api.tabs.onMoved.addListener((_id, info) => { if (belongsHere(info.windowId)) void refreshTabs(); });
  api.tabs.onAttached.addListener(onAttached);
  api.tabs.onDetached.addListener(onDetached);
  api.tabs.onReplaced?.addListener(onReplaced);
  api.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORE_KEY]) {
      state.store = normalizeStore(changes[STORE_KEY].newValue);
      render();
    }
    if (area === 'session' && changes[APPEARANCE_REV_KEY]) {
      void loadAppearance().then(({ appearance }) => { state.appearance = appearance; applyAppearance(appearance); });
    }
  });
  // Native ⌃1–⌃4 commands are forwarded by the background worker.
  api.runtime.onMessage.addListener((message) => {
    if (message?.type !== 'breezer.workspace.space' || message.windowId !== state.windowId) return;
    const space = state.store.spaces[message.index];
    if (space) switchSpace(space.id);
  });
  darkQuery.addEventListener('change', () => applyAppearance(state.appearance));
  addEventListener('pagehide', () => { void flushRecords(); });

  const sidebar = $('sidebar');
  sidebar.addEventListener('click', (event) => {
    if (state.suppressClick) return;
    if (!$('menu').hidden && !event.target.closest('#menu')) { closeMenu(false); return; }
    const action = event.target.closest('.row-action');
    const sound = event.target.closest('.row-sound');
    const found = itemFromNode(event.target);
    if (sound && found?.item?.tab) {
      void api.tabs.update(found.item.tab.id, { muted: !found.item.tab.mutedInfo?.muted });
      return;
    }
    if (action && found?.item) {
      const { item } = found;
      if (item.tab) void closeTabs([item.tab.id]);
      else void unpinEntry(item.entry, null);
      return;
    }
    if (!found || !found.item || event.target.closest('input')) return;
    if (found.node.closest('#pinned, #today')) focusItem(found.node);
    if (found.item.type === 'favorite') state.focus.favorites = found.key;
    activateItem(found);
  });
  sidebar.addEventListener('auxclick', (event) => {
    if (event.button !== 1) return;
    const found = itemFromNode(event.target);
    if (found?.item?.tab) { event.preventDefault(); void closeTabs([found.item.tab.id]); }
  });
  sidebar.addEventListener('dblclick', (event) => {
    const found = itemFromNode(event.target);
    if (found?.item && found.item.type !== 'tab' && event.target.closest('.title')) startRenameFor(found);
  });
  sidebar.addEventListener('contextmenu', (event) => {
    const found = itemFromNode(event.target);
    if (event.target.closest('input')) return;
    event.preventDefault();
    if (found?.item) openItemMenu(found, { left: event.clientX - 8, right: event.clientX, top: event.clientY, bottom: event.clientY });
    else if (event.target.closest('.space-head, #empty-hit, .space-pane')) openSpaceMenu();
  });
  sidebar.addEventListener('pointerdown', onPointerDown);
  sidebar.addEventListener('pointermove', onPointerMove);
  sidebar.addEventListener('pointerup', (event) => {
    if (state.drag) endDrag(true);
    else if (state.press?.pointerId === event.pointerId) state.press = null;
  });
  sidebar.addEventListener('pointercancel', () => endDrag(false));
  sidebar.addEventListener('wheel', (event) => {
    // Two-finger horizontal swipe switches spaces.
    if (Math.abs(event.deltaX) < 30 || Math.abs(event.deltaX) < Math.abs(event.deltaY) * 2) return;
    const now = Date.now();
    if (now - state.lastWheel < 600) return;
    state.lastWheel = now;
    stepSpace(event.deltaX > 0 ? 1 : -1);
  }, { passive: true });

  for (const name of TREES) $(name).addEventListener('keydown', onTreeKey);
  $('favorites').addEventListener('keydown', onFavoritesKey);
  $('menu').addEventListener('keydown', onMenuKey);
  $('new-tab').addEventListener('click', () => void newTab());
  $('new-tab').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); focusItem(treeItems($('today'))[0]); }
    if (event.key === 'ArrowUp') { event.preventDefault(); const items = treeItems($('pinned')); focusItem(items[items.length - 1]); }
  });
  $('empty-hit').addEventListener('dblclick', () => void newTab());
  $('clear-today').addEventListener('click', () => void clearToday());
  $('space-menu').addEventListener('click', (event) => { event.stopPropagation(); if ($('menu').hidden) openSpaceMenu(); else closeMenu(); });
  $('add-space').addEventListener('click', () => void createSpace());
  $('open-updates').addEventListener('click', () => void api.tabs.create({ url: api.runtime.getURL('whats-new.html') }));
  $('open-settings').addEventListener('click', () => void openSettings());
  $('spaces').addEventListener('click', (event) => {
    const dot = event.target.closest('.space-dot');
    if (dot) switchSpace(dot.dataset.key.slice(2));
  });
  $('spaces').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      stepSpace(event.key === 'ArrowRight' ? 1 : -1);
      requestAnimationFrame(() => $('spaces').querySelector('[aria-selected="true"]')?.focus());
    }
  });
  if (typeof api.breezerPrivate?.setAppearance === 'function') {
    $('collapse').hidden = false;
    $('collapse').addEventListener('click', () => {
      const alwaysShowSidebar = !state.appearance.alwaysShowSidebar;
      void callBridge('setAppearance', { alwaysShowSidebar }).then(async (result) => {
        state.appearance = normalizeAppearance(result);
        applyAppearance(state.appearance);
        await api.storage.session.set({ [APPEARANCE_REV_KEY]: Date.now() });
      }).catch((error) => showToast(`Couldn’t change the sidebar. ${errorText(error)}`));
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.drag) { endDrag(false); return; }
    if (event.ctrlKey && !event.metaKey && !event.altKey && /^[1-9]$/.test(event.key)) {
      const space = state.store.spaces[Number(event.key) - 1];
      if (space) { event.preventDefault(); switchSpace(space.id); }
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('menu').hidden && !event.target.closest('#menu')) closeMenu(false);
  });
}

// ---------------------------------------------------------------- router

async function boot() {
  const route = parseRoute(location.hash);
  if (route.view === 'settings') {
    document.body.classList.add('route-settings');
    const { mountSettings } = await import('./settings.js');
    await mountSettings({ api, workspace, callBridge, loadAppearance, applyAppearance, BridgeUnavailable, darkQuery });
    return;
  }
  if (location.hash.startsWith('#/welcome')) {
    const { mountWelcome } = await import('./onboarding.js');
    await mountWelcome({ api, callBridge, loadAppearance, applyAppearance, darkQuery });
    return;
  }
  await initSidebar(route);
}

addEventListener('hashchange', () => location.reload());
void boot();
