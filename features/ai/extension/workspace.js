import { localStorageChanges } from './storage-events.js';
import { PLATFORM } from './platform.js';
import { createSpaceSwipe, SWIPE_IDLE_MS } from './space-swipe.js';
import {
  APPEARANCE_REV_KEY, DEFAULT_APPEARANCE, MAX_FAVORITES, MEMBERS_KEY, MAX_SPACES, SPACE_ICONS, STORE_KEY, TONES, TONE_NAMES,
  WorkspaceStore, addEntry, addFavorite, addFolder, addSpace, buildSidebarModel, displayTitle, findEntriesByUrl,
  findNode, hostLabel, isOpenableUrl, moveIndex, moveNode, normalizeAppearance, normalizeMembers, normalizeStore, parseRoute,
  normalizeFolderColor, removeNode, removeSpace, restoreRemovedEntry, renameNode, renameSpace, resolveSpaceId, setFolderColor, setFolderOpen,
  setPrefs, setSpaceIcon, setSpaceTone, spaceOfTab, visibleTabs, windowStateKey,
} from './workspace-store.js';

const api = globalThis.chrome;
const $ = (id) => document.getElementById(id);
const SVG = 'http://www.w3.org/2000/svg';
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const darkQuery = matchMedia('(prefers-color-scheme: dark)');
const workspace = new WorkspaceStore({ storage: api.storage });
const EXPERIMENTS_KEY = 'breezerExperiments';
const OPEN_SPACE_MESSAGE = 'breezer.workspace.open-space';
const windowOpenSpaceKey = (windowId) => `workspace.open-space.${windowId}`;

const ICONS = {
  close: 'M4.5 4.5l7 7M11.5 4.5l-7 7',
  minus: 'M4 8h8',
  sound: 'M3 6.2h2.2L8.4 3.6v8.8L5.2 9.8H3zM10.6 5.6a3.4 3.4 0 0 1 0 4.8',
  muted: 'M3 6.2h2.2L8.4 3.6v8.8L5.2 9.8H3zM10.5 6.3l3 3M13.5 6.3l-3 3',
  chevron: 'M6 4.5L9.5 8 6 11.5',
  folder: 'M2.5 5a1.5 1.5 0 0 1 1.5-1.5h2.6l1.4 1.6H12A1.5 1.5 0 0 1 13.5 6.6V11A1.5 1.5 0 0 1 12 12.5H4A1.5 1.5 0 0 1 2.5 11z',
  spaces: 'M2.5 5.5 8 2.5l5.5 3L8 8.5l-5.5-3ZM2.5 8.5l5.5 3 5.5-3m-11 3 5.5 3 5.5-3',
  pin: 'M5 2.5h6m-5 0v4L4 9v1h8V9l-2-2.5v-4M8 10v3.5',
  star: 'm8 2.2 1.8 3.6 4 .6-2.9 2.8.7 4L8 11.3l-3.6 1.9.7-4-2.9-2.8 4-.6Z',
  duplicate: 'M10.5 10.5h-7v-8h7v8Zm2-5h1v8h-7v-1',
  link: 'm6.4 9.6 3.2-3.2M6 5.2l1.6-1.6a2.8 2.8 0 0 1 4 4L10 9.2m0 1.6-1.6 1.6a2.8 2.8 0 0 1-4-4L6 6.8',
  window: 'M2.5 5h11m-11-1a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v8a1.5 1.5 0 0 1-1.5 1.5H4A1.5 1.5 0 0 1 2.5 12Z',
  split: 'M8 3v10M4 3h8a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1Z',
  edit: 'm4 10-.5 2.5L6 12l6.5-6.5-2-2L4 10Zm5.5-5.5 2 2',
  plus: 'M8 3.5v9m-4.5-4.5h9',
  space: 'M12 8a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z',
  briefcase: 'M6 5V3.5h4V5M2.5 8h11m-10-3h9a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z',
  home: 'm2.5 7 5.5-4.5L13.5 7m-10-.5v6h9v-6M6.5 12.5V9h3v3.5',
  book: 'M8 5C6 3.6 4 3.6 2.5 4v7.7C4.5 11 6.5 11.4 8 12.5c1.5-1.1 3.5-1.5 5.5-.8V4C12 3.6 10 3.6 8 5Zm0 0v7.4',
  sparkle: 'M8 2.4 9.5 6.5 13.6 8 9.5 9.5 8 13.6 6.5 9.5 2.4 8 6.5 6.5 8 2.4Z',
  code: 'm5.5 5-3 3 3 3m5-6 3 3-3 3M9 4l-2 8',
  leaf: 'M4 12.5c4.5-1.5 8.5-4 8.5-9-5.5 0-9.4 2.5-9 6 .1 1.2.7 1.8 1.7 2m0 .5 4.5-4.5',
  globe: 'M13.4 8a5.4 5.4 0 1 1-10.8 0 5.4 5.4 0 0 1 10.8 0ZM2.6 8h10.8M8 2.6a8 8 0 0 1 0 10.8 8 8 0 0 1 0-10.8Z',
};
const SPACE_ICON_NAMES = {
  space: 'Circle', briefcase: 'Briefcase', home: 'Home', book: 'Book',
  sparkle: 'Sparkle', code: 'Code', leaf: 'Leaf', globe: 'Globe',
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
    const raw = await callBridge('getAppearance');
    return { appearance: normalizeAppearance(raw), available: true, error: '' };
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
    collapse.title = appearance.alwaysShowSidebar ? 'Let the sidebar hide when you leave it' : 'Keep the sidebar open beside your page';
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
  swipe: null,
  spaceDock: false,
  drawn: false,
  instant: false,
};

const pending = { set: {}, remove: new Set(), handoff: new Set(), timer: 0 };
// Tabs attached from another window. Their link is provisional: shown from
// storage, never written by this window, until the user sets it here.
const linkWaits = new Map();
const urlOf = (tab) => tab?.url || tab?.pendingUrl || '';
const activeTab = () => [...state.tabs.values()].find((tab) => tab.active) || null;
const canFavicon = Boolean(api?.runtime?.getManifest?.().permissions?.includes('favicon'));

function setRecord(tabId, patch) {
  const previous = state.records[tabId];
  const record = { s: state.activeSpaceId, ...state.records[tabId], ...patch, u: urlOf(state.tabs.get(tabId)) };
  if (!record.e) delete record.e;
  delete record.k;
  state.records[tabId] = record;
  // Storage keeps a link unless the write carries `e`; '' is an explicit unlink.
  const unlink = 'e' in patch ? !patch.e : pending.set[tabId]?.e === '';
  const provisional = linkWaits.has(tabId) && !('e' in patch);
  if (unlink) pending.set[tabId] = { ...record, e: '' };
  else if (provisional) { const { e: _link, ...rest } = record; pending.set[tabId] = rest; }
  else pending.set[tabId] = record;
  if ('e' in patch) linkWaits.delete(tabId);
  pending.remove.delete(String(tabId));
  scheduleFlush();
  // An empty URL patch can still create membership or default its space.
  if (pendingRows && (Object.keys(patch).length || !previous
      || previous.s !== record.s || previous.e !== record.e)) render();
}

function dropRecord(tabId, persist = true) {
  delete state.records[tabId];
  linkWaits.delete(tabId);
  delete pending.set[tabId];
  if (persist) {
    pending.remove.add(String(tabId));
    scheduleFlush();
  }
  if (pendingRows) render();
}

function scheduleFlush() {
  clearTimeout(pending.timer);
  pending.timer = setTimeout(flushRecords, 150);
}

function flushRecords() {
  clearTimeout(pending.timer);
  const set = pending.set;
  const remove = [...pending.remove];
  const handoff = [...pending.handoff];
  if (!Object.keys(set).length && !remove.length) return Promise.resolve();
  pending.set = {};
  pending.remove = new Set();
  pending.handoff = new Set();
  return workspace.patchMembers(set, remove, handoff).catch((error) => showToast(`Couldn’t save tab spaces. ${errorText(error)}`));
}

let windowStateWrite = null;
let windowStateWritesPending = 0;
async function saveWindowState() {
  const key = windowStateKey(state.windowId);
  const value = { activeSpaceId: state.activeSpaceId, lastActive: { ...state.lastActive } };
  const serialized = JSON.stringify(value);
  if (windowStateWrite?.saved && windowStateWrite.key === key && windowStateWrite.serialized === serialized) return;
  const write = { key, serialized, saved: false };
  // Different overlapping writes make completion order ambiguous. Keep sending
  // every change immediately, and only deduplicate a successful isolated write.
  windowStateWrite = windowStateWritesPending ? null : write;
  ++windowStateWritesPending;
  try {
    await api.storage.session.set({ [key]: value });
    if (windowStateWrite === write) write.saved = true;
  } catch {
    if (windowStateWrite === write) windowStateWrite = null;
  } finally {
    --windowStateWritesPending;
  }
}

async function mutate(fn) {
  try {
    const result = await workspace.update(fn);
    // Local storage changes re-render every window; read back now so this one updates without waiting.
    state.store = (await workspace.read()).store;
    render();
    return result;
  } catch (error) {
    showToast(errorText(error));
    throw error;
  }
}

// A query can return after newer tab events or another query have been handled.
let tabQueryVersion = 0;
let tabEventVersion = 0;
let queryDrawDirty = false;
let pendingTabAttachments = 0;
async function refreshTabs() {
  const version = ++tabQueryVersion;
  const events = tabEventVersion;
  const tabs = await api.tabs.query({ windowId: state.windowId });
  if (version !== tabQueryVersion) return;
  if (events !== tabEventVersion) { scheduleRefresh(); return; }
  // A query may only confirm changes already drawn by the event handlers.
  // Keep the existing references used by the model and row actions in that case.
  if (state.drawn && !queryDrawDirty && !pendingTabAttachments
      && !(typeof api.breezerPrivate?.setPeekSources === 'function' && state.peekKey === null)
      && sameTabPresentation(tabs)) {
    for (const tab of tabs) {
      const previous = state.tabs.get(tab.id);
      for (const key of Object.keys(previous)) if (!Object.hasOwn(tab, key)) delete previous[key];
      Object.defineProperties(previous, Object.getOwnPropertyDescriptors(tab));
    }
    return;
  }
  state.tabs = new Map(tabs.map((tab) => [tab.id, tab]));
  render();
}

function sameTabPresentation(tabs) {
  if (tabs.length !== state.tabs.size) return false;
  const previousTabs = state.tabs.values();
  const scalar = value => value === null || (typeof value !== 'object' && typeof value !== 'function');
  const fields = value => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || !Object.isExtensible(value) || Object.getOwnPropertySymbols(value).length) return null;
    const proto = Object.getPrototypeOf(value);
    const constructor = proto && Object.getOwnPropertyDescriptor(proto, 'constructor')?.value;
    if (!proto || Object.getPrototypeOf(proto) !== null || constructor?.name !== 'Object' || constructor.prototype !== proto) return null;
    const standard = ['constructor', '__defineGetter__', '__defineSetter__', 'hasOwnProperty', '__lookupGetter__', '__lookupSetter__', 'isPrototypeOf', 'propertyIsEnumerable', 'toString', 'valueOf', '__proto__', 'toLocaleString'];
    if (Object.getOwnPropertyNames(proto).some(key => !standard.includes(key))) return null;
    const descriptors = Object.getOwnPropertyDescriptors(value);
    if (Object.values(descriptors).some(d => !d.enumerable || !d.configurable || !d.writable || !Object.hasOwn(d, 'value'))) return null;
    return Object.keys(descriptors);
  };
  const flatEqual = (a, b) => {
    if (a === b) return false; // Shared mutable nested state is not evidence of equality.
    const left = fields(a), right = fields(b);
    return left && right && left.length === right.length && left.every(key =>
      Object.hasOwn(b, key) && scalar(a[key]) && scalar(b[key]) && Object.is(a[key], b[key]));
  };
  for (const tab of tabs) {
    const previous = previousTabs.next().value;
    const before = fields(previous), after = fields(tab);
    if (!before || !after || previous === tab || previous.id !== tab.id) return false;
    for (const key of new Set([...before, ...after])) {
      const a = previous[key], b = tab[key];
      if (key === 'highlighted' || key === 'autoDiscardable' || key === 'selected' || key === 'lastAccessed') {
        if ((Object.hasOwn(previous, key) && !scalar(a)) || (Object.hasOwn(tab, key) && !scalar(b))) return false;
        continue;
      }
      if (!Object.hasOwn(previous, key) || !Object.hasOwn(tab, key)) return false;
      if (scalar(a) && scalar(b) && Object.is(a, b)) continue;
      if (key === 'mutedInfo' && flatEqual(a, b)) continue;
      return false;
    }
  }
  return true;
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

const openingEntries = new Map();
function openEntry(entry, tab) {
  if (openingEntries.has(entry.id)) return openingEntries.get(entry.id);
  // The rendered tile may predate a tab-created event or an earlier command.
  const live = (tab && state.tabs.get(tab.id)) || [...state.tabs.values()].find(item => state.records[item.id]?.e === entry.id);
  if (live) return activate(live.id);
  const found = findNode(state.store, entry.id);
  const opening = createTab({ url: entry.url, spaceId: found?.space?.id ?? state.activeSpaceId, entryId: entry.id, pinned: true })
    .finally(() => openingEntries.delete(entry.id));
  openingEntries.set(entry.id, opening);
  return opening;
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
    showToast(snapshot.favorite ? 'Removed from favorites.' : 'Unpinned.', 'Undo', () => mutate((store) => restoreRemovedEntry(store, snapshot)).catch(() => {}));
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

async function moveTabToNewWindow(tab) {
  try {
    await api.windows.create({ tabId: tab.id });
  } catch (error) {
    showToast(`Couldn’t move the tab. ${errorText(error)}`);
  }
}

async function openSpaceInNewWindow(spaceId) {
  try {
    const opened = await api.windows.create({});
    if (!Number.isInteger(opened?.id)) throw new Error('The browser did not return the new window.');
    const tabs = opened.tabs ?? await api.tabs.query({ windowId: opened.id });
    const starter = tabs.find(tab => tab.active) || tabs[0];
    await api.storage.session.set({ [windowOpenSpaceKey(opened.id)]: { spaceId, tabId: starter?.id } });
    // The new sidebar can also pick up the persisted request during startup.
    void api.runtime.sendMessage({ type: OPEN_SPACE_MESSAGE, windowId: opened.id }).catch(() => {});
  } catch (error) {
    showToast(`Couldn’t open the space in a new window. ${errorText(error)}`);
  }
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
  // A list, not a URL map: several closed tabs can share one URL.
  const restorable = [...items];
  if (typeof api.sessions?.getRecentlyClosed === 'function' && typeof api.sessions.restore === 'function') {
    try {
      const recent = await api.sessions.getRecentlyClosed({ maxResults: 25 });
      for (const session of recent) {
        const tab = session.tab;
        if (!tab || !restorable.some((item) => item.url === tab.url)) continue;
        const expectation = { url: tab.url, spaceId, entryId: '', pinned: false, at: Date.now() };
        state.expect.push(expectation);
        try {
          await api.sessions.restore(tab.sessionId);
        } catch {
          // Leave the item for the fallback below, and no stale expectation.
          state.expect = state.expect.filter((item) => item !== expectation);
          continue;
        }
        restorable.splice(restorable.findIndex((item) => item.url === tab.url), 1);
      }
    } catch { /* Fall back to reopening the URLs below. */ }
  }
  for (const item of restorable) await createTab({ url: item.url, spaceId, active: false });
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
  const reveal = () => {
    if (state.activeSpaceId !== next) return;
    saveWindowState();
    animateSpace(direction);
    state.instant = true;
    draw();
    state.instant = false;
    revealActiveSpace();
  };
  if (!activateTab) { reveal(); return; }
  const visible = visibleTabs(buildSidebarModel({ store: state.store, records: state.records, tabs: [...state.tabs.values()], activeSpaceId: next }));
  const target = visible.find((tab) => tab.id === focusTab) || visible.find((tab) => tab.id === state.lastActive[next]) || visible.find((tab) => tab.active) || visible[0];
  const activationVersion = tabEventVersion;
  const activation = target ? api.tabs.update(target.id, { active: true }).then(tab => {
    if (tab?.active && tabEventVersion === activationVersion && state.activeSpaceId === next) {
      ++tabEventVersion;
      for (const live of state.tabs.values()) live.active = live.id === tab.id;
      state.lastActive[next] = tab.id;
    }
  }).catch(error => showToast(errorText(error))) : createTab();
  return activation.finally(reveal);
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

let swipeSettle = 0;

// Follows the fingers a little, so a swipe answers before it switches spaces.
function followSwipe(offset) {
  const pane = $('space-pane');
  pane.classList.toggle('swiping', offset !== 0);
  const translate = offset ? `${offset}px` : '';
  if (pane.style.translate !== translate) pane.style.translate = translate;
}

function onSpaceWheel(event) {
  if (event.ctrlKey || event.metaKey || state.drag || state.renaming || !$('menu').hidden
      || event.target.closest('input, textarea')) return;
  const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? $('sidebar').clientWidth : 1;
  const sideways = !event.deltaX && event.shiftKey;
  state.swipe ??= createSpaceSwipe();
  const { horizontal, step, offset } = state.swipe.feed(
    (sideways ? event.deltaY : event.deltaX) * unit, sideways ? 0 : event.deltaY * unit, performance.now());
  clearTimeout(swipeSettle);
  // A canceled first event keeps the rest of the swipe from scrolling anything.
  if (horizontal && event.cancelable) event.preventDefault();
  if (step) {
    followSwipe(0);
    stepSpace(step);
    return;
  }
  if (!reducedMotion.matches) followSwipe(offset);
  if (offset) swipeSettle = setTimeout(() => followSwipe(0), SWIPE_IDLE_MS);
}

async function createSpace(name, glyph) {
  if (state.store.spaces.length >= MAX_SPACES) {
    showToast(`You can have up to ${MAX_SPACES} spaces.`);
    return;
  }
  const used = new Set(state.store.spaces.map((space) => space.tone));
  const tone = TONES.find((item) => !used.has(item)) || TONES[state.store.spaces.length % TONES.length];
  const space = await mutate((store) => addSpace(store, { name, tone, icon: glyph })).catch(() => null);
  if (!space) return;
  await switchSpace(space.id);
  $('spaces').querySelector('[aria-selected="true"]')?.focus();
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
// null means a full draw; a Set contains only Today tab IDs needing presentation.
let pendingRows = null;
function render(tabId) {
  if (tabId === undefined) pendingRows = null;
  else if (!frame) pendingRows = new Set([tabId]);
  else pendingRows?.add(tabId);
  if (frame || !state.store) return;
  frame = requestAnimationFrame(() => {
    try {
      frame = 0;
      const rows = pendingRows && [...pendingRows].map(id => {
        const tab = state.tabs.get(id);
        return { tab, row: todayRow(tab) };
      });
      pendingRows = null;
      if (!rows || rows.some(({ row }) => !row)) { draw(); return; }
      for (const { row, tab } of rows) {
        updateRow(row, { title: displayTitle(null, tab), tab, active: tab.active, selected: tab.active, actionLabel: 'Close tab', actionIcon: 'close' });
      }
      compactLabels();
      syncRovingFocus();
    } catch (error) {
      queryDrawDirty = true;
      throw error;
    }
  });
}

function todayRow(tab) {
  if (!tab || !state.drawn || state.records[tab.id]?.e
      || state.model?.space.id !== state.activeSpaceId
      || spaceOfTab(state.store, state.records, tab.id) !== state.activeSpaceId
      || !state.model.today.includes(tab)) return null;
  return [...$('today').children].find(row => row.dataset.key === `t:${tab.id}` && !row.classList.contains('leaving'));
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
    holder.textContent = /^chrome:\/\/newtab/.test(page) || !page ? '' : Array.from(hostLabel(page) || title || '·').slice(0, 2).join('').toUpperCase();
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
      render();
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
  const unseen = globalThis.innerWidth === 0 || document.visibilityState === 'hidden';
  const still = state.instant || reducedMotion.matches || !state.drawn
    || unseen;
  const existing = new Map();
  for (const child of unseen ? [...container.children] : container.children) {
    if (!child.classList.contains('leaving')) {
      if (unseen && child.classList.contains('entering')) child.classList.remove('entering');
      existing.set(child.dataset.key, child);
    }
    else if (unseen) child.remove();
  }
  let previous = null;
  for (const item of items) {
    let node = existing.get(item.key);
    if (!node || node.dataset.kind !== item.kind) {
      node = item.create();
      node.dataset.key = item.key;
      node.dataset.kind = item.kind;
      if (!still) node.classList.add('entering');
    }
    existing.delete(item.key);
    item.update(node);
    const next = previous ? previous.nextSibling : container.firstChild;
    if (next !== node) container.insertBefore(node, next);
    previous = node;
  }
  for (const node of existing.values()) {
    if (still) { node.remove(); continue; }
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

const rowPresentation = new WeakMap();
function updateRow(row, { title, tab, url, active, asleep, actionLabel, actionIcon, selected }) {
  const presentation = [title, faviconFor(tab, url), urlOf(tab) || url, Boolean(active), Boolean(asleep),
    tab?.status, Boolean(tab?.discarded), Boolean(tab?.audible), Boolean(tab?.mutedInfo?.muted),
    actionLabel, actionIcon, Boolean(selected), state.renaming?.key === row.dataset.key];
  const previous = rowPresentation.get(row);
  if (previous && presentation.every((value, index) => value === previous[index])) return;
  rowPresentation.set(row, presentation);
  const [favicon, label, sound, action] = row.children;
  if (state.renaming?.key !== row.dataset.key && label.textContent !== title) label.textContent = title;
  updateFavicon(favicon, tab, url, title);
  row.classList.toggle('active', Boolean(active));
  row.classList.toggle('asleep', Boolean(asleep));
  row.classList.toggle('loading', tab?.status === 'loading');
  row.classList.toggle('discarded', Boolean(tab?.discarded));
  row.title = title;
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
  const preview = el('span', 'folder-preview', { 'aria-hidden': 'true' });
  const count = el('span', 'count', { 'aria-hidden': 'true' });
  const dropHint = el('span', 'folder-drop-hint', { 'aria-hidden': 'true' });
  dropHint.textContent = 'Move into folder';
  head.append(chevron, glyph, title, preview, count, dropHint);
  const group = el('div', 'folder-children', { role: 'group' });
  folder.append(head, group);
  return folder;
}

// Tone names map to CSS tokens; a custom hex is carried in --folder-custom.
function paintFolderColor(node, color) {
  const kind = !color ? '' : color.startsWith('#') ? 'custom' : color;
  if ((node.dataset.color || '') !== kind) {
    if (kind) node.dataset.color = kind;
    else delete node.dataset.color;
  }
  const custom = kind === 'custom' ? color : '';
  if ((node.dataset.custom || '') !== custom) {
    if (custom) { node.dataset.custom = custom; node.style.setProperty('--folder-custom', custom); }
    else { delete node.dataset.custom; node.style.removeProperty('--folder-custom'); }
  }
}

function paintFolderPreview(head, children, open) {
  const preview = head.querySelector('.folder-preview');
  const count = head.querySelector('.count');
  preview.hidden = open || !children.length;
  count.textContent = preview.hidden ? '' : String(children.length);
  if (preview.hidden) return;
  const visible = children.slice(0, 3);
  visible.forEach(({ entry, tab }, index) => {
    if (!preview.children[index]) preview.append(el('span', 'favicon'));
    updateFavicon(preview.children[index], tab, entry.url, displayTitle(entry, tab));
  });
  while (preview.children.length > visible.length) preview.children[preview.children.length - 1].remove();
}

function drawTree(container, items) {
  reconcile(container, items);
}

function compactLabels() {
  const rows = ['pinned', 'today'].flatMap(id => [...$(id).querySelectorAll('.row')])
    .filter(row => !row.classList.contains('folder-row') && !row.closest('.leaving') && !row.closest('.folder-children[hidden]'));
  const groups = new Map();
  const labelsByRow = new Map();
  for (const row of rows) {
    const [title, source, url] = rowPresentation.get(row);
    const image = row.querySelector('.favicon img');
    const identity = image ? (source.startsWith('data:') ? source : new URL(url).hostname) : row.querySelector('.favicon').textContent;
    const group = groups.get(identity) || [];
    group.push({ row, words: title.match(/[\p{L}\p{N}]+/gu) || ['Tab'] });
    groups.set(identity, group);
  }
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const candidates = group.map(item => item.words.map(word => [...word].slice(0, 2).join('').toUpperCase()));
    const occurrences = new Map();
    for (const words of candidates) for (const word of new Set(words)) occurrences.set(word, (occurrences.get(word) || 0) + 1);
    const labels = candidates.map(words => words.find(word => occurrences.get(word) === 1) || words[0]);
    const counts = new Map(), ordinals = new Map();
    for (const label of labels) counts.set(label, (counts.get(label) || 0) + 1);
    group.forEach(({ row }, index) => {
      const base = labels[index], ordinal = (ordinals.get(base) || 0) + 1;
      ordinals.set(base, ordinal);
      labelsByRow.set(row, counts.get(base) > 1 ? [...base][0] + ordinal : base);
    });
  }
  for (const row of rows) {
    const label = labelsByRow.get(row);
    if (label && row.dataset.compactLabel !== label) row.dataset.compactLabel = label;
    else if (!label && row.dataset.compactLabel) delete row.dataset.compactLabel;
  }
}

function draw() {
  const queued = Boolean(frame);
  if (frame) { cancelAnimationFrame(frame); frame = 0; }
  queryDrawDirty = true;
  try { paintSidebar(); }
  catch (error) {
    if (queued) render();
    throw error;
  }
}

function paintSidebar() {
  pendingRows = null;
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
  sidebar.dataset.spaceDock = state.spaceDock ? 'alternate' : 'default';
  if (sidebar.dataset.folderColors !== model.prefs.folderColors) sidebar.dataset.folderColors = model.prefs.folderColors;

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
        tile.append(el('span', 'tile-label', { 'aria-hidden': 'true' }));
        return tile;
      },
      update: (tile) => {
        // A favourite keeps its saved identity while its live tab browses.
        const title = favoriteTitle(item.entry);
        const [icon, label] = tile.children;
        updateFavicon(icon, null, item.entry.url, title);
        if (label.textContent !== title) label.textContent = title;
        tile.title = title;
        tile.setAttribute('aria-label', `${title}${item.tab ? '' : ', asleep'}`);
        tile.setAttribute('aria-pressed', String(Boolean(item.tab?.active)));
        tile.classList.toggle('live', Boolean(item.tab));
        tile.classList.toggle('active', Boolean(item.tab?.active));
      },
    };
  });
  const favorites = $('favorites');
  reconcile(favorites, favoriteItems);
  syncPeekSources(model);
  favorites.hidden = !favoriteItems.length && !state.drag;
  favorites.classList.toggle('empty', !favoriteItems.length);
  favorites.classList.toggle('many', favoriteItems.length > 4);

  const pinnedItems = [];
  const todayItems = [];
  for (const node of model.pinned) {
    if (node.kind === 'entry') {
      const key = `e:${node.entry.id}`;
      state.items.set(key, { type: 'entry', entry: node.entry, tab: node.tab, folder: null });
      pinnedItems.push(entryRow(node, key));
      continue;
    }
    const key = `f:${node.folder.id}`;
    state.items.set(key, { type: 'folder', folder: node.folder, children: node.children });
    pinnedItems.push({
      key,
      kind: 'folder',
      create: folderNode,
      update: (folder) => {
        const [head, group] = folder.children;
        const open = node.folder.open;
        folder.setAttribute('aria-expanded', String(open));
        folder.setAttribute('aria-label', `${node.folder.name}, folder, ${node.children.length} ${node.children.length === 1 ? 'tab' : 'tabs'}`);
        folder.setAttribute('aria-selected', 'false');
        if (!folderPreview || folderPreview.id !== node.folder.id) paintFolderColor(folder, node.folder.color);
        const title = head.querySelector('.title');
        if (state.renaming?.key !== key && title.textContent !== node.folder.name) title.textContent = node.folder.name;
        paintFolderPreview(head, node.children, open);
        head.classList.toggle('contains-active', !open && node.children.some((child) => child.tab?.active));
        group.hidden = !open;
        reconcile(group, node.children.map((child) => {
          const childKey = `e:${child.entry.id}`;
          state.items.set(childKey, { type: 'entry', entry: child.entry, tab: child.tab, folder: node.folder });
          return entryRow(child, childKey);
        }));
      },
    });
  }
  reconcile($('pinned'), pinnedItems);
  $('pinned').classList.toggle('empty', !pinnedItems.length);

  for (const tab of model.today) {
    const key = `t:${tab.id}`;
    state.items.set(key, { type: 'tab', tab });
    todayItems.push({
      key,
      kind: 'tab',
      create: rowNode,
      update: (row) => updateRow(row, { title: displayTitle(null, tab), tab, active: tab.active, selected: tab.active, actionLabel: 'Close tab', actionIcon: 'close' }),
    });
  }
  reconcile($('today'), todayItems);
  $('clear-today').hidden = !model.today.length;

  // Spaces dock
  reconcile($('spaces'), model.spaces.map((space, index) => ({
    key: `s:${space.id}`,
    kind: 'space',
    create: () => {
      const dot = el('button', 'space-dot', { type: 'button', role: 'tab', 'aria-haspopup': 'menu' });
      dot.append(el('span', 'dot', { 'aria-hidden': 'true' }));
      return dot;
    },
    update: (dot) => {
      const selected = space.id === model.space.id;
      dot.dataset.tone = space.tone;
      dot.setAttribute('aria-selected', String(selected));
      const marker = dot.querySelector('.dot');
      const glyph = space.icon || 'space';
      if (marker.dataset.icon !== glyph) {
        marker.dataset.icon = glyph;
        marker.replaceChildren(icon(glyph));
      }
      dot.tabIndex = selected ? 0 : -1;
      dot.setAttribute('aria-label', `${space.name}, ${space.tabCount} ${space.tabCount === 1 ? 'tab' : 'tabs'}`);
      const modifier = PLATFORM === 'windows' ? 'Ctrl+Shift+' : '⌃';
      dot.title = index < 4 ? `${space.name} (${modifier}${index + 1})` : space.name;
    },
  })));

  syncRovingFocus();
  compactLabels();
  state.drawn = true;
  queryDrawDirty = false;
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
    for (const node of items) {
      const tabIndex = node === wanted ? 0 : -1;
      if (node.tabIndex !== tabIndex) node.tabIndex = tabIndex;
    }
  }
  const tiles = [...$('favorites').children].filter((node) => !node.classList.contains('leaving'));
  const tile = tiles.find((node) => node.dataset.key === state.focus.favorites) || tiles.find((node) => node.classList.contains('active')) || tiles[0];
  for (const node of tiles) {
    const tabIndex = node === tile ? 0 : -1;
    if (node.tabIndex !== tabIndex) node.tabIndex = tabIndex;
  }
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
      else if (items[at + 1]) focusItem(items[at + 1]);
      else if (tree.id === 'pinned') focusItem(treeItems($('today'))[0]);
      break;
    case 'ArrowUp':
      if (event.altKey) void reorderItem(found, -1);
      else {
        const previous = items[at - 1] || (tree.id === 'today' && treeItems($('pinned')).at(-1));
        if (previous) focusItem(previous);
        else $('new-tab').focus();
      }
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
    ArrowRight: () => go(at + 1), ArrowLeft: () => go(at - 1),
    ArrowDown: () => go(at + Number(getComputedStyle($('favorites')).getPropertyValue('--favorite-columns'))),
    ArrowUp: () => go(at - Number(getComputedStyle($('favorites')).getPropertyValue('--favorite-columns'))),
    Home: () => go(0), End: () => go(tiles.length - 1), Delete: () => closeItem(found), Backspace: () => closeItem(found),
    F2: () => startRenameFor(found),
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
  if (target.kind === 'space') {
    const space = state.store.spaces.find((item) => item.id === target.id);
    const anchor = spaceButton(target.id);
    if (space && anchor) openSpaceEditor(anchor, space);
    return;
  }
  {
    const host = document.querySelector(`[data-key="${CSS.escape(target.key)}"]`);
    if (!host) return;
    const label = host.querySelector('.title');
    const found = findNode(state.store, target.id);
    const initial = target.kind === 'folder' ? found?.node.name
      : target.key.startsWith('v:') && found ? favoriteTitle(found.node)
      : displayTitle(found?.node, state.items.get(target.key)?.tab);
    const popup = !label || globalThis.innerWidth <= 150;
    state.renaming = target;
    const input = el('input', 'rename', { type: 'text', 'aria-label': 'Name', maxlength: '120', spellcheck: 'false' });
    input.value = initial || '';
    if (popup) {
      const bounds = $('sidebar').getBoundingClientRect();
      const top = host.getBoundingClientRect().top - bounds.top;
      input.classList.add('rename-popup');
      input.style.top = `${Math.max(4, Math.min(top, bounds.height - 34))}px`;
      $('sidebar').append(input);
    } else label.replaceChildren(input);
    input.focus();
    input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return;
      done = true;
      const value = input.value.trim();
      state.renaming = null;
      if (popup) input.remove();
      else label.textContent = initial || '';
      if (save && value !== initial) {
        await mutate((store) => {
          renameNode(store, target.id, value);
        }).catch(() => {});
      }
      render();
      const back = document.querySelector(`[data-key="${CSS.escape(target.key)}"]`);
      back?.focus();
    };
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void finish(true); }
      if (event.key === 'Escape') { event.preventDefault(); void finish(false); }
    });
    input.addEventListener('blur', () => void finish(true));
    input.addEventListener('pointerdown', (event) => event.stopPropagation());
  }
}

// ---------------------------------------------------------------- menu

let menuReturn = null;
let menuRect = null;
let submenu = null;
let submenuTimer = 0;
// A custom folder color shown before it is applied. Closing the menu reverts it.
let folderPreview = null;

function menuButton(entry) {
  const hasCheck = Object.hasOwn(entry, 'checked');
  const button = el('button', `menu-item${entry.danger ? ' danger' : ''}`, { role: hasCheck ? 'menuitemradio' : 'menuitem', type: 'button', tabindex: '-1' });
  if (entry.tone) {
    const swatch = el('span', 'menu-swatch', { 'aria-hidden': 'true' });
    swatch.dataset.tone = entry.tone;
    button.append(swatch);
  } else if (entry.icon) button.append(icon(entry.icon, 'menu-icon'));
  const label = el('span', 'menu-label');
  label.textContent = entry.label;
  button.append(label);
  if (hasCheck) button.setAttribute('aria-checked', String(entry.checked));
  if (entry.disabled) button.setAttribute('aria-disabled', 'true');
  if (entry.children) {
    button.setAttribute('aria-haspopup', 'menu');
    button.setAttribute('aria-expanded', 'false');
    button.append(icon('chevron', 'menu-chevron'));
    button.addEventListener('pointerenter', () => openSubmenu(button, entry.children));
    button.addEventListener('focus', () => openSubmenu(button, entry.children));
    button.addEventListener('click', () => openSubmenu(button, entry.children, true));
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowRight') return;
      event.preventDefault();
      event.stopPropagation();
      openSubmenu(button, entry.children, true);
    });
  } else {
    button.addEventListener('pointerenter', () => {
      if (button.closest('.submenu')) return;
      clearTimeout(submenuTimer);
      submenuTimer = setTimeout(closeSubmenu, 180);
    });
    button.addEventListener('focus', () => {
      if (!button.closest('.submenu')) closeSubmenu();
    });
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      if (entry.disabled) return;
      closeMenu();
      entry.run();
    });
  }
  return button;
}

function openSubmenu(trigger, entries, focus = false) {
  clearTimeout(submenuTimer);
  if (submenu?.trigger !== trigger) {
    closeSubmenu();
    const panel = el('div', 'menu submenu', { id: 'workspace-submenu', role: 'menu', 'aria-label': trigger.textContent });
    panel.append(...entries.map(menuButton));
    panel.addEventListener('pointerenter', () => clearTimeout(submenuTimer));
    panel.addEventListener('keydown', onMenuKey);
    $('sidebar').append(panel);
    submenu = { trigger, panel };
    trigger.setAttribute('aria-expanded', 'true');
    trigger.setAttribute('aria-controls', panel.id);
    placeSubmenu();
  }
  if (focus) submenu.panel.firstElementChild?.focus();
}

function placeSubmenu() {
  if (!submenu) return;
  const { panel, trigger } = submenu;
  const bounds = $('sidebar').getBoundingClientRect();
  const anchor = trigger.getBoundingClientRect();
  panel.style.maxHeight = `${Math.max(0, bounds.height - 8)}px`;
  const width = panel.offsetWidth;
  const roomAfter = bounds.right - anchor.right - 4;
  const roomBefore = anchor.left - bounds.left - 4;
  const right = roomAfter >= width || (roomBefore < width && roomAfter >= roomBefore);
  const overlaps = (right ? roomAfter : roomBefore) < width;
  const edge = right ? anchor.right : anchor.left - width;
  const left = Math.min(Math.max(4, edge - bounds.left), bounds.width - width - 4);
  let y = anchor.top - 4;
  if (overlaps) {
    const above = anchor.top - bounds.top - 6;
    const below = bounds.bottom - anchor.bottom - 6;
    const placeBelow = below >= panel.offsetHeight || below >= above;
    panel.style.maxHeight = `${Math.max(0, placeBelow ? below : above)}px`;
    y = placeBelow ? anchor.bottom + 2 : anchor.top - panel.offsetHeight - 2;
  }
  const height = panel.offsetHeight;
  panel.style.left = `${Math.max(4, left)}px`;
  panel.style.top = `${Math.max(4, Math.min(y - bounds.top, bounds.height - height - 4))}px`;
}

function closeSubmenu() {
  clearTimeout(submenuTimer);
  if (!submenu) return;
  submenu.trigger.setAttribute('aria-expanded', 'false');
  submenu.trigger.removeAttribute('aria-controls');
  submenu.panel.remove();
  submenu = null;
}

function openMenu(entries, rect, returnFocus) {
  const menu = $('menu');
  closeMenu(false);
  menu.removeAttribute('aria-label');
  menu.setAttribute('role', 'menu');
  menuReturn = returnFocus || document.activeElement;
  if (menuReturn?.getAttribute('aria-haspopup') === 'menu') menuReturn.setAttribute('aria-expanded', 'true');
  const nodes = [];
  menu.replaceChildren();
  for (const entry of entries) {
    if (entry === '-') { menu.append(el('div', 'menu-separator', { role: 'separator' })); continue; }
    if (entry.node) { menu.append(entry.node); continue; }
    if (entry.heading) { menu.append(el('div', 'menu-heading', { role: 'presentation' })); menu.lastChild.textContent = entry.heading; continue; }
    const button = menuButton(entry);
    nodes.push(button);
    menu.append(button);
  }
  menu.hidden = false;
  menuRect = rect;
  placeMenu();
  nodes[0]?.focus();
}

// Also re-run when the menu grows, so an expanded section stays on screen.
function placeMenu() {
  const menu = $('menu');
  const rect = menuRect;
  const bounds = $('sidebar').getBoundingClientRect();
  menu.style.maxHeight = `${Math.max(0, bounds.height - 8)}px`;
  const fullHeight = menu.offsetHeight;
  const below = bounds.bottom - rect.bottom - 8;
  const above = rect.top - bounds.top - 8;
  const fitsBelow = menu.scrollHeight <= below;
  const openAbove = !fitsBelow && above > below;
  const width = menu.offsetWidth;
  const top = (openAbove ? rect.top - fullHeight - 4 : rect.bottom + 4) - bounds.top;
  const left = Math.min(Math.max(4, rect.left - bounds.left + 4), bounds.width - width - 4);
  menu.style.top = `${Math.max(4, Math.min(top, bounds.height - fullHeight - 4))}px`;
  menu.style.left = `${Math.max(4, left)}px`;
  placeSubmenu();
}

function closeMenu(restore = true) {
  const menu = $('menu');
  if (menu.hidden) return;
  closeSubmenu();
  endFolderPreview();
  if (menu.getAttribute('role') === 'dialog') state.renaming = null;
  menu.hidden = true;
  menu.replaceChildren();
  if (menuReturn?.getAttribute('aria-haspopup') === 'menu') menuReturn.setAttribute('aria-expanded', 'false');
  if (restore && menuReturn?.isConnected) menuReturn.focus();
  menuReturn = null;
}

function spaceTargets(run, tab = null) {
  const children = state.store.spaces.filter((space) => space.id !== state.activeSpaceId)
    .map((space) => ({ label: space.name, tone: space.tone, run: () => run(space.id) }));
  if (tab && typeof api.windows?.create === 'function') children.push({ label: 'New window', icon: 'window', run: () => moveTabToNewWindow(tab) });
  return children.length ? [{ label: 'Move to space', icon: 'spaces', children }] : [];
}

function copyLink(url) {
  navigator.clipboard?.writeText(url).then(() => showToast('Link copied.'), () => showToast('Couldn’t copy the link.'));
}

// ---------------------------------------------------------------- folder colors

const HEX_INPUT = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i;

// Accepts "3a7bd5", "#3A7BD5" or "#38f"; returns "#rrggbb" or null.
export function parseHexInput(value) {
  const match = HEX_INPUT.exec(String(value || '').trim());
  if (!match) return null;
  const digits = match[1].length === 3 ? [...match[1]].map((digit) => digit + digit).join('') : match[1];
  return normalizeFolderColor(`#${digits}`);
}

// Resolves a color custom property on `host` (including a custom theme's
// relative oklch() accent) to #rrggbb for the color input.
function colorPropertyHex(host, property) {
  const probe = el('span', '', { 'aria-hidden': 'true' });
  probe.style.color = `var(${property})`;
  host.append(probe);
  const resolved = getComputedStyle(probe).color;
  probe.remove();
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  if (!context || !resolved) return null;
  context.fillStyle = resolved;
  context.fillRect(0, 0, 1, 1);
  const [r, g, b] = context.getImageData(0, 0, 1, 1).data;
  return `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
}

function previewFolderColor(id, color) {
  const node = document.querySelector(`[data-key="${CSS.escape(`f:${id}`)}"]`);
  if (!node) return;
  folderPreview = { id };
  node.dataset.colorPreview = '';
  paintFolderColor(node, color);
}

// Repaints a folder from the saved store, dropping any preview.
function repaintFolder(id) {
  if (folderPreview?.id === id) return;
  const folder = findNode(state.store, id)?.node;
  const node = document.querySelector(`[data-key="${CSS.escape(`f:${id}`)}"]`);
  if (folder?.kind === 'folder' && node) {
    delete node.dataset.colorPreview;
    paintFolderColor(node, folder.color);
  }
}

function endFolderPreview() {
  if (!folderPreview) return;
  const { id } = folderPreview;
  folderPreview = null;
  repaintFolder(id);
}

function chooseFolderColor(folder, color) {
  // Keep an applied preview on screen until the stored color replaces it.
  if (color && folderPreview?.id === folder.id) folderPreview = null;
  closeMenu();
  void mutate((store) => {
    setFolderColor(store, folder.id, color);
    if (color && store.prefs.folderColors === 'off') setPrefs(store, { folderColors: 'icon' });
  }).catch(() => {}).finally(() => repaintFolder(folder.id));
}

// Six tone swatches plus a custom swatch that opens a hex field and picker.
// The swatches are one stop for Up/Down; Left/Right move between them.
function folderColorEntries(folder) {
  const custom = folder.color?.startsWith('#') ? folder.color : '';
  const swatches = el('div', 'menu-swatches', { role: 'group', 'aria-label': 'Folder color' });
  for (const tone of TONES) {
    const chip = el('button', 'menu-chip', { type: 'button', role: 'menuitemradio', tabindex: '-1', 'aria-checked': String(folder.color === tone), 'aria-label': TONE_NAMES[tone], title: TONE_NAMES[tone] });
    chip.dataset.color = tone;
    chip.addEventListener('click', () => chooseFolderColor(folder, tone));
    swatches.append(chip);
  }
  const more = el('button', 'menu-chip', { type: 'button', role: 'menuitemradio', tabindex: '-1', 'aria-checked': String(Boolean(custom)), 'aria-label': custom ? `Custom color ${custom}` : 'Custom color', title: custom ? `Custom color ${custom}` : 'Custom color', 'aria-expanded': 'false', 'aria-controls': 'menu-custom-color' });
  more.dataset.color = 'custom';
  if (custom) { more.style.setProperty('--folder-custom', custom); more.classList.add('has-custom'); }
  swatches.append(more);

  const editor = el('div', 'menu-custom', { id: 'menu-custom-color', role: 'group', 'aria-label': 'Custom folder color' });
  editor.hidden = true;
  const well = el('input', 'menu-well', { type: 'color', 'aria-label': 'Pick a color' });
  const field = el('input', 'menu-hex', { type: 'text', inputmode: 'text', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Hex color', placeholder: '#rrggbb' });
  const apply = el('button', 'menu-apply', { type: 'button' });
  apply.textContent = 'Apply';
  editor.append(well, field, apply);

  const preview = (hex) => {
    field.removeAttribute('aria-invalid');
    previewFolderColor(folder.id, hex);
  };
  well.addEventListener('input', () => { field.value = well.value; preview(well.value); });
  field.addEventListener('input', () => {
    const hex = parseHexInput(field.value);
    if (hex) { well.value = hex; preview(hex); }
  });
  const commit = () => {
    const hex = parseHexInput(field.value);
    if (!hex) { field.setAttribute('aria-invalid', 'true'); field.focus(); return; }
    chooseFolderColor(folder, hex);
  };
  well.addEventListener('change', () => { field.value = well.value; commit(); });
  field.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); commit(); } });
  apply.addEventListener('click', commit);
  more.addEventListener('click', () => {
    if (!editor.hidden) { field.focus(); field.select(); return; }
    // Start from the folder's current color, or the space accent when it has none.
    const checked = swatches.querySelector('[aria-checked="true"]');
    const source = custom || colorPropertyHex(checked || $('menu'), checked ? '--folder-color' : '--accent') || '#23866b';
    well.value = source;
    field.value = source;
    editor.hidden = false;
    more.setAttribute('aria-expanded', 'true');
    placeMenu();
    field.focus();
    field.select();
  });

  const reset = { label: 'Reset color', disabled: !folder.color, run: () => chooseFolderColor(folder, null) };
  const heading = state.store.prefs.folderColors === 'off' ? 'Color (enables icon colors)' : 'Color';
  return [{ heading }, { node: swatches }, { node: editor }, reset];
}

function collapseColorEditor(editor) {
  editor.hidden = true;
  endFolderPreview();
  const more = $('menu').querySelector('[aria-controls="menu-custom-color"]');
  more?.setAttribute('aria-expanded', 'false');
  placeMenu();
  more?.focus();
}

function openItemMenu(found, rect) {
  const item = found?.item;
  if (!item) return;
  let entries = [];
  if (item.type === 'tab') {
    const { tab } = item;
    entries = [
      { label: 'Pin tab', icon: 'pin', run: () => pinTab(tab) },
      { label: 'Add to favorites', icon: 'star', disabled: state.store.favorites.length >= MAX_FAVORITES, run: () => favoriteTab(tab) },
      { label: 'Duplicate', icon: 'duplicate', run: () => api.tabs.duplicate(tab.id).catch((error) => showToast(errorText(error))) },
      ...(isOpenableUrl(urlOf(tab)) ? [{ label: 'Copy link', icon: 'link', run: () => copyLink(urlOf(tab)) }] : []),
      ...spaceTargets((spaceId) => moveTabToSpace(tab, spaceId), tab),
      ...splitViewEntries(tab),
      '-',
      { label: 'Close other tabs', icon: 'minus', disabled: state.model.today.length < 2, run: () => closeTabs(state.model.today.filter((other) => other.id !== tab.id).map((other) => other.id)) },
      { label: 'Close tab', icon: 'close', danger: true, run: () => closeTabs([tab.id]) },
    ];
  } else if (item.type === 'entry') {
    const { entry, tab } = item;
    const folders = state.model.space.pinned.filter((node) => node.kind === 'folder' && node.id !== item.folder?.id);
    entries = [
      { label: 'Rename', icon: 'edit', run: () => startRenameFor(found) },
      ...(entry.customTitle ? [{ label: 'Use page title', run: () => mutate((store) => renameNode(store, entry.id, '')).catch(() => {}) }] : []),
      ...(tab && urlOf(tab) !== entry.url && isOpenableUrl(urlOf(tab)) ? [{ label: 'Pin this page instead', run: () => mutate((store) => { const node = findNode(store, entry.id)?.node; if (node) { node.url = urlOf(tab); node.title = tab.title || node.title; } }).catch(() => {}) }] : []),
      { label: 'Add to favorites', icon: 'star', disabled: state.store.favorites.length >= MAX_FAVORITES, run: () => mutate((store) => moveNode(store, entry.id, { favorites: true })).catch(() => {}) },
      ...(item.folder ? [{ label: `Remove from ${item.folder.name}`, run: () => mutate((store) => moveNode(store, entry.id, { spaceId: state.activeSpaceId })).catch(() => {}) }] : []),
      ...folders.map((folder) => ({ label: `Move to ${folder.name}`, run: () => mutate((store) => moveNode(store, entry.id, { spaceId: state.activeSpaceId, folderId: folder.id })).catch(() => {}) })),
      { label: 'Copy link', icon: 'link', run: () => copyLink(entry.url) },
      ...spaceTargets((spaceId) => mutate((store) => moveNode(store, entry.id, { spaceId })).catch(() => {}), tab),
      ...splitViewEntries(tab),
      { label: 'Unpin', icon: 'pin', run: () => unpinEntry(entry, tab) },
      ...(tab ? ['-', { label: 'Close tab', icon: 'close', danger: true, run: () => closeTabs([tab.id]) }] : []),
    ];
  } else if (item.type === 'favorite') {
    const { entry, tab } = item;
    entries = [
      { label: 'Rename', icon: 'edit', run: () => startRenameFor(found) },
      { label: 'Copy link', icon: 'link', run: () => copyLink(entry.url) },
      ...splitViewEntries(tab),
      ...(tab ? ['-', { label: 'Close tab', icon: 'close', run: () => closeTabs([tab.id]) }] : ['-']),
      { label: 'Remove from favorites', icon: 'star', danger: true, run: () => unpinEntry(entry, tab) },
    ];
  } else if (item.type === 'folder') {
    const { folder } = item;
    entries = [
      { label: folder.open ? 'Collapse' : 'Expand', run: () => mutate((store) => setFolderOpen(store, folder.id, !folder.open)).catch(() => {}) },
      { label: 'Rename', run: () => startRenameFor(found) },
      '-', ...folderColorEntries(folder),
      '-',
      ...spaceTargets((spaceId) => mutate((store) => moveNode(store, folder.id, { spaceId })).catch(() => {})),
      '-',
      { label: 'Delete folder', danger: true, run: () => mutate((store) => removeNode(store, folder.id)).then(() => showToast(`Deleted ${folder.name}. Its tabs stay pinned.`)).catch(() => {}) },
    ];
  }
  openMenu(entries, rect, found.node);
}

function splitViewEntries(tab) {
  if (!tab || typeof api.breezerPrivate?.toggleSplitView !== 'function') return [];
  return [{
    label: Number.isInteger(tab.splitViewId) && tab.splitViewId >= 0 ? 'Exit Split View' : 'Split View',
    icon: 'split',
    run: () => callBridge('toggleSplitView', tab.id).catch((error) => showToast(errorText(error))),
  }];
}

function spaceButton(id) {
  return [...$('spaces').children].find((button) => button.dataset.key === `s:${id}` && !button.classList.contains('leaving'));
}

function revealActiveSpace() {
  spaceButton(state.activeSpaceId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
}

function openSpaceEditor(anchor, space = null) {
  closeMenu(false);
  state.renaming = { kind: 'space', id: space?.id };
  const menu = $('menu');
  const title = space ? 'Edit space' : 'New space';
  menu.setAttribute('role', 'dialog');
  menu.setAttribute('aria-label', title);
  menuReturn = anchor;
  menuRect = anchor.getBoundingClientRect();
  const form = el('form', 'space-editor');
  const input = el('input', 'space-editor-name', {
    'aria-label': 'Space name', type: 'text', maxlength: '60', spellcheck: 'false',
  });
  input.value = space?.name || `Space ${state.store.spaces.length + 1}`;
  const palette = el('div', 'space-icon-palette', { role: 'radiogroup', 'aria-label': 'Space icon' });
  let glyph = space?.icon || 'space';
  for (const option of SPACE_ICONS) {
    const label = el('label', 'space-icon-option', { title: SPACE_ICON_NAMES[option] });
    const radio = el('input', '', { type: 'radio', name: 'space-icon', 'aria-label': SPACE_ICON_NAMES[option] });
    radio.checked = glyph === option;
    radio.addEventListener('change', () => { if (radio.checked) glyph = option; });
    label.append(radio, icon(option));
    palette.append(label);
  }
  const submit = el('button', 'menu-apply', { type: 'submit' });
  submit.textContent = space ? 'Save' : 'Create';
  form.append(input, palette, submit);
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    const name = input.value.trim();
    if (!name) { input.focus(); return; }
    closeMenu();
    if (!space) { void createSpace(name, glyph); return; }
    const rename = name !== space.name;
    const changeIcon = glyph !== (space.icon || 'space');
    if (rename || changeIcon) void mutate((store) => {
      if (rename) renameSpace(store, space.id, name);
      if (changeIcon) setSpaceIcon(store, space.id, glyph);
    }).catch(() => {});
  });
  menu.replaceChildren(form);
  menu.hidden = false;
  placeMenu();
  input.focus();
  input.select();
}

function openSpaceMenu(anchor = spaceButton(state.activeSpaceId), spaceId = state.activeSpaceId) {
  const space = state.store.spaces.find((item) => item.id === spaceId);
  if (!space || !anchor) return;
  openMenu([
    { label: 'Edit space', icon: 'edit', run: () => openSpaceEditor(anchor, space) },
    { label: 'New space', icon: 'plus', disabled: state.store.spaces.length >= MAX_SPACES, run: () => openSpaceEditor(anchor) },
    ...(typeof api.windows?.create === 'function' ? [{ label: 'Open space in new window', icon: 'window', run: () => openSpaceInNewWindow(space.id) }] : []),
    ...(space.id === state.activeSpaceId ? [{ label: 'New folder', icon: 'folder', run: async () => {
      const folder = await mutate((store) => addFolder(store, space.id)).catch(() => null);
      if (folder) startRename({ kind: 'folder', id: folder.id, key: `f:${folder.id}` });
    } }] : []),
    '-',
    { label: 'Color', children: TONES.map((tone) => ({ label: TONE_NAMES[tone], tone, checked: tone === space.tone, run: () => mutate((store) => setSpaceTone(store, space.id, tone)).catch(() => {}) })) },
    { label: 'Delete space', danger: true, disabled: state.store.spaces.length <= 1, run: () => deleteSpace(space.id) },
  ], anchor.getBoundingClientRect(), anchor);
}

// Each swatch row counts as one stop: the focused, checked or first swatch.
function menuStops(menu) {
  return [...menu.children].flatMap((child) => {
    if (child.hidden || child.classList.contains('menu-custom')) return [];
    if (child.classList.contains('menu-swatches')) {
      const chips = [...child.children];
      return [chips.find((chip) => chip === document.activeElement) || chips.find((chip) => chip.getAttribute('aria-checked') === 'true') || chips[0]];
    }
    return child.matches('[role^="menuitem"]') ? [child] : [];
  });
}

function onMenuKey(event) {
  if (event.currentTarget.getAttribute('role') === 'dialog') {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeMenu();
    }
    return;
  }
  const editor = event.target.closest?.('.menu-custom');
  if (editor) {
    // Text editing keeps its own keys. Tab cycles the editor; Escape returns to the swatches.
    if (event.key === 'Escape') collapseColorEditor(editor);
    else if (event.key === 'Tab') {
      const controls = [...editor.querySelectorAll('input, button')];
      const at = controls.indexOf(event.target);
      controls[(at + (event.shiftKey ? -1 : 1) + controls.length) % controls.length].focus();
    } else return;
    event.preventDefault();
    return;
  }
  const row = event.target.closest?.('.menu-swatches');
  if (row && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
    const chips = [...row.children];
    const at = chips.indexOf(event.target);
    chips[(at + (event.key === 'ArrowRight' ? 1 : -1) + chips.length) % chips.length].focus();
    event.preventDefault();
    return;
  }
  const menu = event.currentTarget;
  const items = menuStops(menu);
  const at = items.indexOf(document.activeElement);
  const go = (index) => items[(index + items.length) % items.length]?.focus();
  if (event.key === 'ArrowDown') go(at + 1);
  else if (event.key === 'ArrowUp') go(at - 1);
  else if (event.key === 'Home') go(0);
  else if (event.key === 'End') go(items.length - 1);
  else if (menu === submenu?.panel && (event.key === 'ArrowLeft' || event.key === 'Escape')) {
    submenu.trigger.focus();
    closeSubmenu();
  } else if (event.key === 'ArrowLeft' && submenu) closeSubmenu();
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
  $('toast-action').onclick = null;
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
  const pinned = state.model.space.pinned;
  const movingFolder = state.drag?.item.type === 'folder';
  if (tree.classList.contains('divider-row')) {
    return { zone: 'pinned', index: 0, line: $('pinned').firstElementChild || tree, after: !$('pinned').firstElementChild };
  }
  const row = hit.closest('.folder-row, [data-key^="e:"]');
  const folder = hit.closest('.folder');
  if (!row && folder && !movingFolder) {
    return { zone: 'pinned', folderId: folder.dataset.key.slice(2), into: folder };
  }
  if (folder && (movingFolder || row?.classList.contains('folder-row'))) {
    const folderId = folder.dataset.key.slice(2);
    const head = folder.querySelector('.folder-row');
    const rect = (movingFolder ? folder : head).getBoundingClientRect();
    // Folder moves reorder at the root. Tabs and saved pages get almost the
    // entire folder header; only the outer four pixels mean before/after.
    if (!movingFolder && y >= rect.top + 4 && y <= rect.bottom - 4) {
      return { zone: 'pinned', folderId, into: folder };
    }
    const index = pinned.findIndex((node) => node.id === folderId);
    const after = y > rect.top + rect.height / 2;
    return { zone: 'pinned', index: index + (after ? 1 : 0), line: movingFolder ? folder : head, after };
  }
  if (row && !row.classList.contains('folder-row')) {
    const { entry, folder: parent } = state.items.get(row.dataset.key);
    const rect = row.getBoundingClientRect();
    const after = y > rect.top + rect.height / 2;
    return { zone: 'pinned', folderId: parent?.id, index: (parent?.children || pinned).findIndex((node) => node.id === entry.id) + (after ? 1 : 0), line: row, after };
  }
  if (tree.id === 'pinned' || movingFolder) {
    const last = $('pinned').lastElementChild;
    return { zone: 'pinned', index: pinned.length, line: last || $('new-tab'), after: Boolean(last) };
  }
  const tabs = state.model.today;
  const first = $('today').querySelector('[data-key^="t:"]');
  const tab = hit.closest('[data-key^="t:"]');
  if (tab) {
    const rect = tab.getBoundingClientRect();
    const at = tabs.findIndex((item) => `t:${item.id}` === tab.dataset.key);
    const after = y > rect.top + rect.height / 2;
    return { zone: 'today', before: tabs[at + (after ? 1 : 0)] || null, line: tab, after };
  }
  const atTop = tree.classList.contains('new-tab') || Boolean(folder);
  return { zone: 'today', before: atTop ? tabs[0] : null, line: atTop ? first || $('new-tab') : $('today').lastElementChild || $('new-tab'), after: !atTop || !first };
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
      else await mutate((store) => moveNode(store, entryId, {
        spaceId: state.activeSpaceId, folderId: target.folderId, index: target.index,
      }));
      if (target.folderId) await mutate((store) => setFolderOpen(store, target.folderId, true));
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
  state.drag.target = validDropTarget(dropTargetAt(event.clientX, event.clientY));
  showDropTarget(state.drag.target);
}

function validDropTarget(target) {
  const item = state.drag?.item;
  if (!target || !item) return null;
  if (item.type === 'folder' && (target.zone === 'today' || target.zone === 'favorites' || target.folderId)) return null;
  return target;
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
  ++tabEventVersion;
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

// Check the full snapshot too: changeInfo need not describe every changed field.
function onlyTabFieldsChanged(previous, change, tab, fields) {
  const keys = Object.keys(change);
  if (!previous || previous === tab || !keys.length || keys.some(key => !fields.includes(key))) return false;
  const sameScalar = (a, b) => (a === null || typeof a !== 'object')
    && (b === null || typeof b !== 'object') && Object.is(a, b);
  const sameFields = (a, b, same) => {
    const fields = Object.keys(a);
    return fields.length === Object.keys(b).length
      && fields.every(key => Object.hasOwn(b, key) && same(a[key], b[key], key));
  };
  const before = Object.keys(previous).filter(key => !fields.includes(key));
  const after = Object.keys(tab).filter(key => !fields.includes(key));
  return before.length === after.length && before.every(key => {
    if (!Object.hasOwn(tab, key)) return false;
    const a = previous[key], b = tab[key];
    if (sameScalar(a, b)) return true;
    // Chromium supplies flat MutedInfo snapshots. Shared objects may already
    // have mutated; unknown nested data also keeps the existing redraw path.
    return key === 'mutedInfo' && a && b && a !== b
      && typeof a === 'object' && typeof b === 'object'
      && sameFields(a, b, sameScalar);
  });
}

const TODAY_ROW_FIELDS = ['title', 'status', 'favIconUrl', 'discarded', 'audible', 'autoDiscardable', 'url', 'pendingUrl'];

function onUpdated(tabId, change, tab) {
  if (!belongsHere(tab.windowId)) return;
  ++tabEventVersion;
  const previous = state.tabs.get(tabId);
  const unchanged = onlyTabFieldsChanged(previous, change, tab, ['autoDiscardable']);
  // Ordinary Today presentation changes cannot alter membership or ordering.
  // Saved rows and any pending full draw still take the complete model path.
  const row = !unchanged && (!frame || pendingRows)
    && !(typeof api.breezerPrivate?.setPeekSources === 'function' && state.peekKey === null)
    && Object.keys(change).some(key => key !== 'autoDiscardable')
    && onlyTabFieldsChanged(previous, change, tab, TODAY_ROW_FIELDS)
    ? todayRow(previous)
    : null;
  if (unchanged || row) {
    // The rendered model still refers to previous. Keep one snapshot per tab
    // while preserving every field and its exact presence in the snapshot.
    for (const key of row ? TODAY_ROW_FIELDS : ['autoDiscardable']) {
      if (Object.hasOwn(tab, key)) previous[key] = tab[key];
      else delete previous[key];
    }
  } else {
    state.tabs.set(tabId, tab);
  }
  if (change.url && state.records[tabId]) setRecord(tabId, {});
  if (change.pinned === false && state.records[tabId]?.e) {
    // Unpinned outside the sidebar: keep the entry, release the tab into today.
    const found = findNode(state.store, state.records[tabId].e);
    setRecord(tabId, { s: found?.space?.id ?? state.activeSpaceId, e: '' });
  }
  if (change.pinned !== undefined) scheduleRefresh();
  if (row) render(tabId);
  else if (!unchanged) render();
}

function onRemoved(tabId, info) {
  if (!belongsHere(info.windowId)) return;
  ++tabEventVersion;
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
  ++tabEventVersion;
  const active = [...state.tabs.values()].filter((tab) => tab.active);
  const next = state.tabs.get(tabId);
  const space = spaceOfTab(state.store, state.records, tabId);
  // Only reuse the last model when both rows are ordinary Today tabs and no
  // other change is waiting to be drawn. Other activations need reconciliation.
  const today = $('today');
  const rows = active.length === 1 && next && !frame && state.drawn && space === state.activeSpaceId
    && state.model?.today.includes(active[0]) && state.model.today.includes(next)
    ? [active[0], next].map((tab) => [...today.children].find((row) => row.dataset.key === `t:${tab.id}` && !row.classList.contains('leaving')))
    : [];
  for (const tab of state.tabs.values()) tab.active = tab.id === tabId;
  if (rows.length === 2 && rows.every(Boolean)) {
    for (const [index, tab] of [active[0], next].entries()) {
      updateRow(rows[index], { title: displayTitle(null, tab), tab, active: tab.active, selected: tab.active, actionLabel: 'Close tab', actionIcon: 'close' });
    }
    syncRovingFocus();
  } else render();
  if (!space || space === state.activeSpaceId) {
    if (space) { state.lastActive[space] = tabId; saveWindowState(); }
    return;
  }
  // Closing a native tab can activate a neighbor from a hidden space.
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
  ++tabEventVersion;
  queryDrawDirty = true;
  ++pendingTabAttachments;
  state.peekKey = null;
  // A tab from another window keeps its saved-entry link from stored membership.
  // The read waits behind the sending window's pending membership write. If
  // the sender has not flushed yet, its later write supplies the link.
  // null until a storage change reports the link; that report is newer than the read.
  linkWaits.set(tabId, null);
  const stored = Promise.resolve().then(() => workspace.readMembers()).then((members) => members.tabs[tabId], () => null);
  void Promise.all([api.tabs.get(tabId), stored]).then(([tab, member]) => {
    ++tabEventVersion;
    queryDrawDirty = true;
    state.tabs.set(tabId, tab);
    const known = state.records[tabId]?.e;
    if (known) setRecord(tabId, { s: state.activeSpaceId, e: known });
    else {
      // Omit `e` so this write can neither erase nor restore the sender's link.
      setRecord(tabId, { s: state.activeSpaceId });
      const reported = linkWaits.get(tabId);
      const shown = typeof reported === 'string' ? reported : member?.e || '';
      if (shown && linkWaits.has(tabId)) state.records[tabId].e = shown;
    }
    return refreshTabs();
  }).catch(() => { if (!state.records[tabId]) linkWaits.delete(tabId); }).finally(() => { --pendingTabAttachments; });
}

function onDetached(tabId, info) {
  if (!belongsHere(info.oldWindowId)) return;
  ++tabEventVersion;
  queryDrawDirty = true;
  state.peekKey = null;
  state.tabs.delete(tabId);
  // Hand the latest membership to the receiving window, which reads it under
  // the same lock. Then don't race its rewrite with a delete. If it already
  // claimed the tab, this write only supplies the link.
  if (pending.set[tabId]) { pending.handoff.add(tabId); void flushRecords(); }
  dropRecord(tabId, false);
  void refreshTabs();
}

// The sending window's late flush links a tab this window already claimed.
function adoptLinks(members) {
  let changed = false;
  for (const tabId of [...linkWaits.keys()]) {
    const stored = members.tabs[tabId];
    if (!stored) continue;
    const e = stored.e || '';
    const record = state.records[tabId];
    if (!record) { linkWaits.set(tabId, e); continue; }
    // Follow storage in memory only; the sender's handoff is authoritative.
    if ((record.e || '') === e) continue;
    if (e) record.e = e; else delete record.e;
    changed = true;
  }
  // Tab snapshots are unchanged, so refreshTabs would skip the redraw.
  if (changed) render();
}

function onReplaced(addedTabId, removedTabId) {
  const record = state.records[removedTabId];
  if (!record) return;
  void api.tabs.get(addedTabId).then((tab) => {
    if (!belongsHere(tab.windowId)) return;
    ++tabEventVersion;
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
  document.body.classList.add('route-sidebar');
  try {
    state.windowId = route.windowId ?? (await api.windows.getCurrent()).id;
  } catch {
    $('sidebar').hidden = false;
    showToast('Couldn’t find this window.');
    return;
  }
  const [{ appearance }, tabs, saved, experiments] = await Promise.all([
    loadAppearance(),
    api.tabs.query({ windowId: state.windowId }),
    api.storage.session.get(windowStateKey(state.windowId)).catch(() => ({})),
    api.storage.local.get(EXPERIMENTS_KEY).catch(() => ({})),
  ]);
  state.appearance = appearance;
  state.spaceDock = experiments[EXPERIMENTS_KEY]?.spaceDock === true;
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
  await readSpaceOpenRequest();
  draw();
  $('sidebar').hidden = false;
  revealActiveSpace();
  if (orphanPinned.length) void adoptPinned(orphanPinned);
}

async function readSpaceOpenRequest() {
  const key = windowOpenSpaceKey(state.windowId);
  const stored = await api.storage.session.get(key).catch(() => ({}));
  return receiveSpaceInNewWindow(stored[key]);
}

let receivingSpace = null;
function receiveSpaceInNewWindow(request) {
  if (!request || receivingSpace) return receivingSpace;
  const key = windowOpenSpaceKey(state.windowId);
  const space = state.store.spaces.find((item) => item.id === request.spaceId);
  if (space && state.tabs.has(request.tabId)) setRecord(request.tabId, { s: space.id, e: '' });
  const activation = space && switchSpace(space.id, { focusTab: request.tabId });
  receivingSpace = Promise.resolve(activation).then(saveWindowState).then(() => flushRecords()).then(() => api.storage.session.remove(key))
    .catch((error) => showToast(`Couldn’t finish opening the space. ${errorText(error)}`));
  return receivingSpace;
}

function bindSidebar() {
  // Native browser commands reach this window's document even when web content
  // has focus. Cancel only saved slots; native selection handles other indices.
  document.addEventListener('breezer-select-numbered-tab', (event) => {
    const index = event.detail;
    if (!Number.isInteger(index) || index < 0 || index > 7) return;
    const model = buildSidebarModel({ store: state.store, records: state.records, tabs: [...state.tabs.values()], activeSpaceId: state.activeSpaceId });
    const slots = [...model.favorites, ...model.pinned.flatMap(node => node.kind === 'folder' ? node.children : [node])];
    const item = slots[index];
    if (!item) return;
    event.preventDefault();
    void openEntry(item.entry, item.tab);
  });
  api.tabs.onCreated.addListener(onCreated);
  api.tabs.onUpdated.addListener(onUpdated);
  api.tabs.onRemoved.addListener(onRemoved);
  api.tabs.onActivated.addListener(onActivated);
  api.tabs.onMoved.addListener((_id, info) => { if (belongsHere(info.windowId)) void refreshTabs(); });
  api.tabs.onAttached.addListener(onAttached);
  api.tabs.onDetached.addListener(onDetached);
  api.tabs.onReplaced?.addListener(onReplaced);
  const refreshAppearance = async () => {
    const { appearance } = await loadAppearance();
    state.appearance = appearance;
    applyAppearance(appearance);
    if (state.model) {
      $('sidebar').dataset.tone = document.documentElement.dataset.tone === 'custom' ? 'custom' : state.model.space.tone;
    }
  };
  localStorageChanges(api).addListener((changes) => {
    if (changes[STORE_KEY]) {
      state.store = normalizeStore(changes[STORE_KEY].newValue);
      render();
    }
    if (changes[MEMBERS_KEY] && linkWaits.size) adoptLinks(normalizeMembers(changes[MEMBERS_KEY].newValue));
    if (changes[EXPERIMENTS_KEY]) {
      state.spaceDock = changes[EXPERIMENTS_KEY].newValue?.spaceDock === true;
      render();
    }
    if (changes[APPEARANCE_REV_KEY]) void refreshAppearance();
  });
  // Space commands are forwarded by the background worker.
  api.runtime.onMessage.addListener((message) => {
    if (message?.type === 'breezer.theme.refresh') { void refreshAppearance(); return; }
    if (message?.windowId !== state.windowId) return;
    if (message.type === OPEN_SPACE_MESSAGE) { void readSpaceOpenRequest(); return; }
    if (message.type !== 'breezer.workspace.space') return;
    const space = state.store.spaces[message.index];
    if (space) switchSpace(space.id);
  });
  darkQuery.addEventListener('change', () => applyAppearance(state.appearance));
  addEventListener('pagehide', () => { void flushRecords(); if (!windowStateWritesPending) void saveWindowState(); });

  const sidebar = $('sidebar');
  sidebar.addEventListener('click', (event) => {
    if (state.suppressClick) return;
    if (!$('menu').hidden && !event.target.closest('#menu, .submenu')) { closeMenu(false); return; }
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
    if (event.detail === 2 && found.item.type !== 'tab' && event.target.closest('.row, .tile')) return;
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
    if (found?.item && found.item.type !== 'tab' && !event.target.closest('button:not(.tile), input')
        && event.target.closest('.row, .tile')) startRenameFor(found);
  });
  sidebar.addEventListener('contextmenu', (event) => {
    const found = itemFromNode(event.target);
    if (event.target.closest('input, #menu, .submenu')) return;
    event.preventDefault();
    if (found?.item) openItemMenu(found, found.node.getBoundingClientRect());
    else {
      const dot = event.target.closest('.space-dot');
      if (dot) openSpaceMenu(dot, dot.dataset.key.slice(2));
      else if (event.target.closest('#space-dock, .space-pane')) openSpaceMenu();
    }
  });
  sidebar.addEventListener('pointerdown', onPointerDown);
  sidebar.addEventListener('pointermove', onPointerMove);
  sidebar.addEventListener('pointerup', (event) => {
    if (state.drag && event.pointerId === state.drag.pointerId) {
      state.drag.target = validDropTarget(dropTargetAt(event.clientX, event.clientY));
      endDrag(true);
    }
    else if (state.press?.pointerId === event.pointerId) state.press = null;
  });
  sidebar.addEventListener('pointercancel', () => endDrag(false));
  sidebar.addEventListener('lostpointercapture', () => endDrag(false));
  sidebar.addEventListener('wheel', onSpaceWheel, { passive: false });

  for (const name of TREES) $(name).addEventListener('keydown', onTreeKey);
  $('favorites').addEventListener('keydown', onFavoritesKey);
  $('menu').addEventListener('keydown', onMenuKey);
  if (PLATFORM === 'windows') $('new-tab').title = 'New tab (Ctrl+T)';
  $('new-tab').addEventListener('click', () => void newTab());
  $('new-tab').addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusItem(treeItems($('pinned'))[0] || treeItems($('today'))[0]);
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const clear = $('clear-today');
      (clear.offsetWidth ? clear : $('favorites').querySelector('[tabindex="0"]'))?.focus();
    }
  });
  $('empty-hit').addEventListener('dblclick', () => void newTab());
  $('clear-today').addEventListener('click', () => void clearToday());
  $('open-updates').addEventListener('click', () => void createTab({ url: api.runtime.getURL('whats-new.html') }));
  $('open-settings').addEventListener('click', () => void openSettings());
  $('spaces').addEventListener('click', (event) => {
    const dot = event.target.closest('.space-dot');
    if (dot) switchSpace(dot.dataset.key.slice(2));
  });
  $('spaces').addEventListener('keydown', (event) => {
    const { key } = event;
    if (key === 'ContextMenu' || (key === 'F10' && event.shiftKey) || key === 'F2') {
      const dot = event.target.closest('.space-dot');
      if (!dot) return;
      event.preventDefault();
      const id = dot.dataset.key.slice(2);
      if (key === 'F2') startRename({ kind: 'space', id });
      else openSpaceMenu(dot, id);
      return;
    }
    if (key === 'ArrowRight' || key === 'ArrowLeft' || key === 'Home' || key === 'End') {
      event.preventDefault();
      const spaces = state.store.spaces;
      const at = spaces.findIndex((space) => space.id === state.activeSpaceId);
      const index = key === 'Home' ? 0 : key === 'End' ? spaces.length - 1 : at + (key === 'ArrowRight' ? 1 : -1);
      const next = spaces[index];
      if (!next) return;
      void Promise.resolve(switchSpace(next.id)).then(() => $('spaces').querySelector('[aria-selected="true"]')?.focus());
    }
  });
  if (typeof api.breezerPrivate?.setAppearance === 'function' && typeof api.breezerPrivate?.focusLocationBar !== 'function') {
    $('collapse').hidden = false;
    $('collapse').addEventListener('click', () => {
      const alwaysShowSidebar = !state.appearance.alwaysShowSidebar;
      void callBridge('setAppearance', { alwaysShowSidebar }).then(async (result) => {
        state.appearance = normalizeAppearance(result);
        applyAppearance(state.appearance);
        await api.storage.local.set({ [APPEARANCE_REV_KEY]: Date.now() });
      }).catch((error) => showToast(`Couldn’t change the sidebar. ${errorText(error)}`));
    });
  }
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && state.drag) { endDrag(false); return; }
    if (PLATFORM === 'mac' && event.ctrlKey && !event.metaKey && !event.altKey && /^[1-9]$/.test(event.key)) {
      const space = state.store.spaces[Number(event.key) - 1];
      if (space) { event.preventDefault(); switchSpace(space.id); }
    }
  });
  document.addEventListener('pointerdown', (event) => {
    if (!$('menu').hidden && !event.target.closest('#menu, .submenu') && !menuReturn?.contains(event.target)) closeMenu(false);
  });
  addEventListener('resize', () => {
    revealActiveSpace();
    if (!$('menu').hidden) placeMenu();
  });
}

// ---------------------------------------------------------------- router

let settingsStyles;
let routeReloading = false;

function loadSettingsStyles() {
  if (settingsStyles) return settingsStyles;
  settingsStyles = new Promise((resolve, reject) => {
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'settings.css';
    let settled = false;
    const finish = (loaded) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (loaded) resolve();
      else {
        link.remove();
        settingsStyles = null;
        reject(new Error('Settings stylesheet unavailable.'));
      }
    };
    const timer = setTimeout(() => finish(false), 10000);
    link.addEventListener('load', () => finish(true), { once: true });
    link.addEventListener('error', () => finish(false), { once: true });
    document.head.append(link);
  });
  return settingsStyles;
}

function showRouteError() {
  if (routeReloading) return;
  const notice = document.createElement('div');
  notice.setAttribute('role', 'alert');
  const message = document.createElement('p');
  message.textContent = 'This page couldn’t load. Reload to try again.';
  const retry = document.createElement('button');
  retry.type = 'button';
  retry.textContent = 'Reload';
  retry.addEventListener('click', () => location.reload());
  notice.append(message, retry);
  document.body.append(notice);
}

async function boot() {
  try {
    const route = parseRoute(location.hash);
    if (route.view === 'settings') {
      await loadSettingsStyles();
      if (routeReloading) return;
      document.body.classList.add('route-settings');
      const { mountSettings } = await import('./settings.js');
      if (routeReloading) return;
      await mountSettings({ api, workspace, callBridge, loadAppearance, applyAppearance, BridgeUnavailable, darkQuery });
      return;
    }
    if (location.hash.startsWith('#/welcome')) {
      await loadSettingsStyles();
      if (routeReloading) return;
      const { mountWelcome } = await import('./onboarding.js');
      if (routeReloading) return;
      await mountWelcome({ api, callBridge, loadAppearance, applyAppearance, darkQuery });
      return;
    }
    $('settings').remove();
    $('welcome').remove();
    await initSidebar(route);
  } catch {
    showRouteError();
  }
}

// Settings switches categories in place (#/settings/<category>); every other route change reloads.
addEventListener('hashchange', (event) => {
  const settings = (url) => parseRoute(new URL(url).hash).view === 'settings';
  if (settings(event.oldURL) && settings(event.newURL)) return;
  routeReloading = true;
  location.reload();
});
void boot();
