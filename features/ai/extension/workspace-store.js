// Breezer workspace state: spaces, pinned entries, folders, favorites, and the
// per-tab space membership that has to survive a browser restart. No DOM code,
// so it runs under Node with a fake `chrome` in tests/ai/workspace*.test.mjs.

export const STORE_KEY = 'workspace.v1';
export const MEMBERS_KEY = 'workspace.members.v1';
export const SESSION_KEY = 'workspace.session';
export const APPEARANCE_REV_KEY = 'appearance.rev';
export const LOCK_NAME = 'breezer.workspace';
export const TONES = ['mint', 'tide', 'dusk', 'rose', 'pollen', 'graphite'];
export const TONE_NAMES = { mint: 'Mint', tide: 'Tide', dusk: 'Dusk', rose: 'Rose', pollen: 'Pollen', graphite: 'Graphite' };
export const MAX_FAVORITES = 12;
export const MAX_SPACES = 9;
export const DEFAULT_PREFS = Object.freeze({ newTabPosition: 'bottom', closeButton: 'hover' });
export const DEFAULT_APPEARANCE = Object.freeze({
  layout: 'sidebar', sidebarMode: 'expanded', theme: 'mint', colorMode: 'system',
  showBookmarks: true, sidebarWidth: 240, sidebarFontSize: 15,
  centeredAddressBar: true, minimalUrl: true, showLoadProgress: true,
  frameless: true, alwaysShowSidebar: false, alwaysShowTopBar: true,
});
export const SIDEBAR_WIDTH = Object.freeze({ min: 200, max: 360 });
export const SIDEBAR_FONT_SIZE = Object.freeze({ min: 12, max: 20 });

export const windowStateKey = (windowId) => `workspace.window.${windowId}`;

const APPEARANCE_FIELDS = {
  layout: (value) => value === 'sidebar' || value === 'top',
  sidebarMode: (value) => ['expanded', 'compact', 'autoHide'].includes(value),
  theme: (value) => TONES.includes(value) || (typeof value === 'string' && /^#[0-9a-fA-F]{6}$/.test(value)),
  colorMode: (value) => value === 'system' || value === 'light' || value === 'dark',
  showBookmarks: (value) => typeof value === 'boolean',
  sidebarFontSize: (value) => Number.isInteger(value) && value >= SIDEBAR_FONT_SIZE.min && value <= SIDEBAR_FONT_SIZE.max,
  centeredAddressBar: (value) => typeof value === 'boolean',
  minimalUrl: (value) => typeof value === 'boolean',
  showLoadProgress: (value) => typeof value === 'boolean',
  frameless: (value) => typeof value === 'boolean',
  alwaysShowSidebar: (value) => typeof value === 'boolean',
  alwaysShowTopBar: (value) => typeof value === 'boolean',
  sidebarWidth: (value) => Number.isInteger(value) && value >= SIDEBAR_WIDTH.min && value <= SIDEBAR_WIDTH.max,
};

const text = (value, max = 200) => (typeof value === 'string' ? value.slice(0, max) : '');
const isTone = (value) => TONES.includes(value);

// Short session-scoped tombstones keep a quarantined URL from falling through
// to a different path match when another window restores later. Hash collisions
// can only cause an extra conservative fallback.
function urlKeyToken(value) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash = Math.imul(hash ^ value.charCodeAt(index), 16777619);
  }
  return (hash >>> 0).toString(16);
}

function cleanUrlKeyTokens(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((item) => typeof item === 'string' && /^[\da-f]{1,8}$/.test(item)))]
    : [];
}

export function uid(prefix) {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${random.replaceAll('-', '').slice(0, 12)}`;
}

// `#/sidebar?w=123` → { view: 'sidebar', windowId: 123 }. Anything unexpected
// falls back to the sidebar with no explicit window.
export function parseRoute(hash) {
  const raw = String(hash || '').replace(/^#\/?/, '');
  const [path, query = ''] = raw.split('?');
  const view = path === 'settings' ? 'settings' : 'sidebar';
  const w = new URLSearchParams(query).get('w');
  const windowId = w !== null && /^\d{1,10}$/.test(w) ? Number(w) : null;
  return { view, windowId };
}

// Only page URLs we can safely show or reopen. Everything else is treated as empty.
export function isOpenableUrl(url) {
  return typeof url === 'string' && /^(https?|chrome|chrome-extension|file|about):/i.test(url) && url.length <= 8192;
}

export function urlKeys(url) {
  try {
    const parsed = new URL(url);
    const origin = parsed.origin === 'null' ? `${parsed.protocol}//${parsed.host}` : parsed.origin;
    return { exact: `${origin}${parsed.pathname}${parsed.search}`, path: `${origin}${parsed.pathname}`, origin };
  } catch {
    return { exact: String(url || ''), path: String(url || ''), origin: String(url || '') };
  }
}

export function hostLabel(url) {
  try { return new URL(url).hostname.replace(/^www\./, '') || url; } catch { return String(url || ''); }
}

// ---------------------------------------------------------------- appearance

export function normalizeAppearance(raw) {
  const result = { ...DEFAULT_APPEARANCE };
  if (raw && typeof raw === 'object') {
    for (const [key, valid] of Object.entries(APPEARANCE_FIELDS)) {
      let value = raw[key];
      if (key === 'sidebarWidth' && typeof value === 'number' && Number.isFinite(value)) {
        value = Math.min(SIDEBAR_WIDTH.max, Math.max(SIDEBAR_WIDTH.min, Math.round(value)));
      }
      if (valid(value)) result[key] = value;
    }
  }
  return result;
}

// Mirrors the native rule: any unknown key or invalid value rejects the whole patch.
export function validateAppearancePatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Appearance changes must be an object.');
  const keys = Object.keys(patch);
  if (!keys.length) throw new Error('Appearance change is empty.');
  for (const key of keys) {
    if (!Object.hasOwn(APPEARANCE_FIELDS, key)) throw new Error(`Unknown appearance setting "${key}".`);
    if (!APPEARANCE_FIELDS[key](patch[key])) throw new Error(`Invalid value for ${key}.`);
  }
  return { ...patch };
}

// ---------------------------------------------------------------- store schema

function normalizeEntry(raw) {
  if (!raw || typeof raw !== 'object' || !isOpenableUrl(raw.url)) return null;
  const entry = { kind: 'entry', id: text(raw.id, 64) || uid('e'), url: raw.url, title: text(raw.title) || hostLabel(raw.url) };
  const custom = text(raw.customTitle).trim();
  if (custom) entry.customTitle = custom;
  return entry;
}

function normalizeNode(raw) {
  if (raw?.kind === 'folder') {
    return {
      kind: 'folder',
      id: text(raw.id, 64) || uid('f'),
      name: text(raw.name, 80).trim() || 'Folder',
      open: raw.open !== false,
      children: (Array.isArray(raw.children) ? raw.children : []).map(normalizeEntry).filter(Boolean),
    };
  }
  return normalizeEntry(raw);
}

export function defaultStore() {
  return { version: 1, rev: 0, spaces: [{ id: 'space-default', name: 'Personal', tone: 'mint', pinned: [] }], favorites: [], prefs: { ...DEFAULT_PREFS } };
}

export function normalizeStore(raw) {
  const store = defaultStore();
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return store;
  store.rev = Number.isSafeInteger(raw.rev) ? raw.rev : 0;
  const seen = new Set();
  const unique = (node) => {
    if (!node || seen.has(node.id)) return false;
    seen.add(node.id);
    if (node.kind === 'folder') node.children = node.children.filter(unique);
    return true;
  };
  const spaces = (Array.isArray(raw.spaces) ? raw.spaces : []).slice(0, MAX_SPACES).map((space) => ({
    id: text(space?.id, 64) || uid('s'),
    name: text(space?.name, 60).trim() || 'Space',
    tone: isTone(space?.tone) ? space.tone : 'mint',
    pinned: (Array.isArray(space?.pinned) ? space.pinned : []).map(normalizeNode).filter(unique),
  })).filter((space) => (seen.has(space.id) ? false : seen.add(space.id)));
  if (spaces.length) store.spaces = spaces;
  store.favorites = (Array.isArray(raw.favorites) ? raw.favorites : []).map(normalizeEntry).filter(unique).slice(0, MAX_FAVORITES);
  const prefs = raw.prefs || {};
  store.prefs = {
    newTabPosition: prefs.newTabPosition === 'top' ? 'top' : 'bottom',
    closeButton: prefs.closeButton === 'always' ? 'always' : 'hover',
  };
  return store;
}

export function normalizeMembers(raw) {
  const members = { version: 1, session: '', prev: '', tabs: {}, quarantine: { session: '', exact: [], path: [] } };
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return members;
  members.session = text(raw.session, 64);
  members.prev = text(raw.prev, 64);
  const quarantine = raw.quarantine && typeof raw.quarantine === 'object' ? raw.quarantine : {};
  members.quarantine = {
    session: text(quarantine.session, 64),
    exact: cleanUrlKeyTokens(quarantine.exact),
    path: cleanUrlKeyTokens(quarantine.path),
  };
  for (const [id, record] of Object.entries(raw.tabs || {})) {
    if (!/^\d+$/.test(id) || !record || typeof record !== 'object') continue;
    const clean = { s: text(record.s, 64), u: text(record.u, 8192), k: text(record.k, 64) };
    if (record.e) clean.e = text(record.e, 64);
    members.tabs[id] = clean;
  }
  return members;
}

// ---------------------------------------------------------------- queries

export function spaceById(store, id) {
  return store.spaces.find((space) => space.id === id) || null;
}

export function resolveSpaceId(store, id) {
  return spaceById(store, id)?.id ?? store.spaces[0].id;
}

// Locates any node. For entries inside folders, `folder` is set and `list` is the folder's children.
export function findNode(store, id) {
  const favoriteIndex = store.favorites.findIndex((entry) => entry.id === id);
  if (favoriteIndex >= 0) return { node: store.favorites[favoriteIndex], space: null, folder: null, list: store.favorites, index: favoriteIndex, favorite: true };
  for (const space of store.spaces) {
    for (let i = 0; i < space.pinned.length; i += 1) {
      const node = space.pinned[i];
      if (node.id === id) return { node, space, folder: null, list: space.pinned, index: i, favorite: false };
      if (node.kind === 'folder') {
        const childIndex = node.children.findIndex((child) => child.id === id);
        if (childIndex >= 0) return { node: node.children[childIndex], space, folder: node, list: node.children, index: childIndex, favorite: false };
      }
    }
  }
  return null;
}

export function entriesOf(space) {
  return space.pinned.flatMap((node) => (node.kind === 'folder' ? node.children : [node]));
}

export function findEntriesByUrl(store, url, exclude = new Set()) {
  const keys = urlKeys(url);
  const all = [...store.favorites.map((entry) => ({ entry, space: null })), ...store.spaces.flatMap((space) => entriesOf(space).map((entry) => ({ entry, space })))]
    .filter(({ entry }) => !exclude.has(entry.id));
  const exact = all.filter(({ entry }) => urlKeys(entry.url).exact === keys.exact);
  return exact.length ? exact : all.filter(({ entry }) => urlKeys(entry.url).path === keys.path);
}

export const displayTitle = (entry, tab) => entry?.customTitle || tab?.title || entry?.title || hostLabel(entry?.url || tab?.url || '') || 'New tab';

// ---------------------------------------------------------------- store operations (mutate a draft)

function requireSpace(store, id) {
  const space = spaceById(store, id);
  if (!space) throw new Error('That space no longer exists.');
  return space;
}

export function addSpace(store, { name, tone } = {}) {
  if (store.spaces.length >= MAX_SPACES) throw new Error(`You can have up to ${MAX_SPACES} spaces.`);
  const space = { id: uid('s'), name: text(name, 60).trim() || `Space ${store.spaces.length + 1}`, tone: isTone(tone) ? tone : 'mint', pinned: [] };
  store.spaces.push(space);
  return space;
}

export function renameSpace(store, id, name) {
  const clean = text(name, 60).trim();
  if (!clean) throw new Error('Give the space a name.');
  requireSpace(store, id).name = clean;
}

export function setSpaceTone(store, id, tone) {
  if (!isTone(tone)) throw new Error('Unknown color.');
  requireSpace(store, id).tone = tone;
}

export function moveSpace(store, id, delta) {
  const from = store.spaces.findIndex((space) => space.id === id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= store.spaces.length) return false;
  const [space] = store.spaces.splice(from, 1);
  store.spaces.splice(to, 0, space);
  return true;
}

// Deleting a space keeps its pinned entries by moving them to the first remaining space.
// Its tabs follow automatically because unknown space ids resolve to the first space.
export function removeSpace(store, id) {
  if (store.spaces.length <= 1) throw new Error('Keep at least one space.');
  const index = store.spaces.findIndex((space) => space.id === id);
  if (index < 0) return null;
  const [removed] = store.spaces.splice(index, 1);
  store.spaces[0].pinned.push(...removed.pinned);
  return store.spaces[0].id;
}

export function addEntry(store, spaceId, { id, url, title } = {}, { folderId = null, index } = {}) {
  const entry = normalizeEntry({ id, url, title });
  if (!entry) throw new Error('This page can’t be pinned.');
  if (findNode(store, entry.id)) throw new Error('Already pinned.');
  const space = requireSpace(store, spaceId);
  let list = space.pinned;
  if (folderId) {
    const folder = space.pinned.find((node) => node.id === folderId && node.kind === 'folder');
    if (!folder) throw new Error('That folder no longer exists.');
    list = folder.children;
  }
  list.splice(index === undefined ? list.length : Math.max(0, Math.min(index, list.length)), 0, entry);
  return entry;
}

export function addFolder(store, spaceId, name = 'New folder') {
  const folder = { kind: 'folder', id: uid('f'), name: text(name, 80).trim() || 'New folder', open: true, children: [] };
  requireSpace(store, spaceId).pinned.unshift(folder);
  return folder;
}

export function renameNode(store, id, name) {
  const found = findNode(store, id);
  if (!found) throw new Error('That item no longer exists.');
  const clean = text(name, 120).trim();
  if (found.node.kind === 'folder') found.node.name = clean || 'Folder';
  else if (clean) found.node.customTitle = clean;
  else delete found.node.customTitle;
}

export function setFolderOpen(store, id, open) {
  const found = findNode(store, id);
  if (found?.node.kind === 'folder') found.node.open = Boolean(open);
}

// Removing a folder keeps its entries in place.
export function removeNode(store, id) {
  const found = findNode(store, id);
  if (!found) return null;
  found.list.splice(found.index, 1);
  if (found.node.kind === 'folder') found.list.splice(found.index, 0, ...found.node.children);
  return found.node;
}

// Move an entry or folder. Targets: { favorites:true, index } or { spaceId, folderId?, index }.
export function moveNode(store, id, target) {
  const found = findNode(store, id);
  if (!found) throw new Error('That item no longer exists.');
  if (found.node.kind === 'folder' && (target.favorites || target.folderId)) throw new Error('Folders can’t go inside other folders.');
  let list;
  if (target.favorites) {
    list = store.favorites;
    if (!found.favorite && list.length >= MAX_FAVORITES) throw new Error(`Favorites hold up to ${MAX_FAVORITES} pages.`);
  } else {
    const space = requireSpace(store, target.spaceId);
    list = space.pinned;
    if (target.folderId) {
      const folder = space.pinned.find((node) => node.id === target.folderId && node.kind === 'folder');
      if (!folder) throw new Error('That folder no longer exists.');
      list = folder.children;
    }
  }
  let index = target.index === undefined ? list.length : target.index;
  if (list === found.list && found.index < index) index -= 1;
  found.list.splice(found.index, 1);
  list.splice(Math.max(0, Math.min(index, list.length)), 0, found.node);
  return found.node;
}

export function addFavorite(store, { id, url, title } = {}) {
  const entry = normalizeEntry({ id, url, title });
  if (!entry) throw new Error('This page can’t be added to favorites.');
  if (store.favorites.length >= MAX_FAVORITES) throw new Error(`Favorites hold up to ${MAX_FAVORITES} pages.`);
  if (findNode(store, entry.id)) throw new Error('Already saved.');
  store.favorites.push(entry);
  return entry;
}

export function setPrefs(store, patch) {
  if (patch.newTabPosition !== undefined) {
    if (!['top', 'bottom'].includes(patch.newTabPosition)) throw new Error('Invalid new tab position.');
    store.prefs.newTabPosition = patch.newTabPosition;
  }
  if (patch.closeButton !== undefined) {
    if (!['hover', 'always'].includes(patch.closeButton)) throw new Error('Invalid close button setting.');
    store.prefs.closeButton = patch.closeButton;
  }
}

// ---------------------------------------------------------------- membership

// Chromium tab ids don't survive a restart, and storage.session is wiped with it.
// Without durable per-tab metadata, prior-session membership can only be restored
// when URL candidates agree on the assignment. Ambiguous URLs use the fallback
// space. `hints` are optional per-tab membership values supplied by the caller.
export function reconcileWindowTabs({ members, store, tabs, session, fallbackSpaceId, hints = {} }) {
  const fallback = resolveSpaceId(store, fallbackSpaceId);
  if (!members.quarantine || members.quarantine.session !== session) {
    members.quarantine = { session, exact: [], path: [] };
  }
  const exactQuarantine = new Set(members.quarantine.exact);
  const pathQuarantine = new Set(members.quarantine.path);
  const records = members.tabs;
  const assigned = {};
  const boundEntries = new Set();
  const orphanPinned = [];
  const urlOf = (tab) => tab.url || tab.pendingUrl || '';
  const pending = [];

  const accept = (tab, record) => {
    const clean = { s: resolveSpaceId(store, record.s), u: urlOf(tab), k: session };
    if (record.e && findNode(store, record.e) && !boundEntries.has(record.e)) {
      clean.e = record.e;
      boundEntries.add(record.e);
    }
    records[tab.id] = clean;
    assigned[tab.id] = clean;
  };

  // 1. Current-session records and explicit per-tab hints are authoritative.
  // Previous-session records are matched as a group below: a reused tab id alone
  // cannot disambiguate duplicate URLs restored across windows.
  for (const tab of tabs) {
    const record = records[tab.id];
    const hint = hints[tab.id];
    if (record?.k === session) accept(tab, record);
    else if (hint && typeof hint === 'object' && typeof hint.s === 'string') accept(tab, hint);
    else pending.push(tab);
  }

  // 2. Previous-session records matched by URL across the stored membership set.
  const pool = Object.entries(records).filter(([id, record]) => record.k !== session && !(id in assigned));
  const assignmentKey = (record) => JSON.stringify([
    resolveSpaceId(store, record.s),
    record.e && findNode(store, record.e) ? record.e : '',
  ]);
  const quarantine = (kind, key) => {
    const token = urlKeyToken(key);
    const list = members.quarantine[kind];
    if (!list.includes(token)) list.push(token);
    if (kind === 'exact') exactQuarantine.add(token);
    else pathQuarantine.add(token);
  };
  const take = (predicate, kind, key) => {
    const matches = pool.filter(predicate);
    if (!matches.length) return { record: null, ambiguous: false };

    const assignments = new Set(matches.map(([, record]) => assignmentKey(record)));
    if (assignments.size > 1) {
      // Keep the conflict visible to other restoring windows, while marking this
      // URL and its path unsafe for weaker fallback.
      quarantine(kind, key);
      if (kind === 'exact') quarantine('path', urlKeys(key).path);
      return { record: null, ambiguous: true };
    }

    const [id, record] = matches[0];
    const index = pool.findIndex(([candidateId]) => candidateId === id);
    if (index >= 0) pool.splice(index, 1);
    if (records[id]?.k !== session) delete records[id];
    return { record, ambiguous: false };
  };
  for (const tab of pending) {
    const keys = urlKeys(urlOf(tab));
    const exactToken = urlKeyToken(keys.exact);
    const exact = urlOf(tab)
      ? exactQuarantine.has(exactToken)
        ? { record: null, ambiguous: true }
        : take(([, r]) => urlKeys(r.u).exact === keys.exact, 'exact', keys.exact)
      : { record: null, ambiguous: false };
    const pathToken = urlKeyToken(keys.path);
    const path = !exact.record && !exact.ambiguous && urlOf(tab)
      ? pathQuarantine.has(pathToken)
        ? { record: null, ambiguous: true }
        : take(([, r]) => urlKeys(r.u).path === keys.path, 'path', keys.path)
      : { record: null, ambiguous: false };
    const record = exact.record || path.record;
    if (record) { accept(tab, record); continue; }
    // 3. Chromium-pinned tabs bind to an entry with the same URL.
    if (tab.pinned) {
      const matches = findEntriesByUrl(store, urlOf(tab), boundEntries);
      if (matches.length === 1) {
        const match = matches[0];
        accept(tab, { s: match.space?.id ?? fallback, e: match.entry.id });
        continue;
      }
      // Ambiguous saved pins stay visible as live tabs without creating another
      // saved pin on every restart or borrowing another space's entry.
      if (!matches.length) orphanPinned.push(tab.id);
    }
    accept(tab, { s: fallback });
  }
  return { assigned, orphanPinned };
}

// Starts a new membership session when storage.session has no token (browser
// restart or extension reload). Only the previous session's records are kept.
export function rollSession(members, token) {
  if (members.session === token) return false;
  members.prev = members.session;
  members.session = token;
  members.quarantine = { session: token, exact: [], path: [] };
  for (const [id, record] of Object.entries(members.tabs)) {
    if (record.k !== token && record.k !== members.prev) delete members.tabs[id];
  }
  return true;
}

// ---------------------------------------------------------------- view model

// Splits this window's live tabs (Chromium is the truth) into favorites,
// pinned tree and today list for one space.
export function buildSidebarModel({ store, records, tabs, activeSpaceId }) {
  const spaceId = resolveSpaceId(store, activeSpaceId);
  const space = spaceById(store, spaceId);
  const bound = new Map();
  const today = [];
  const counts = Object.fromEntries(store.spaces.map((s) => [s.id, 0]));
  const sorted = [...tabs].sort((a, b) => a.index - b.index);
  for (const tab of sorted) {
    const record = records[tab.id];
    const found = record?.e ? findNode(store, record.e) : null;
    if (found && !bound.has(record.e)) {
      bound.set(record.e, tab);
      if (found.space) counts[found.space.id] += 1;
      continue;
    }
    const tabSpace = resolveSpaceId(store, record?.s);
    counts[tabSpace] += 1;
    if (tabSpace === spaceId) today.push(tab);
  }
  const item = (entry) => ({ entry, tab: bound.get(entry.id) || null });
  const pinned = space.pinned.map((node) => (node.kind === 'folder'
    ? { kind: 'folder', folder: node, children: node.children.map(item) }
    : { kind: 'entry', ...item(node) }));
  return {
    space,
    spaces: store.spaces.map((s) => ({ ...s, tabCount: counts[s.id] })),
    favorites: store.favorites.map(item),
    pinned,
    today,
    prefs: store.prefs,
  };
}

// Tabs the user can see in a space, top to bottom (live pinned first, then today).
export function visibleTabs(model) {
  const pinned = model.pinned.flatMap((node) => (node.kind === 'folder' ? node.children : [node])).map((item) => item.tab).filter(Boolean);
  return [...pinned, ...model.today];
}

export function spaceOfTab(store, records, tabId) {
  const record = records[tabId];
  if (record?.e) {
    const found = findNode(store, record.e);
    if (found) return found.favorite ? null : found.space.id;
  }
  return resolveSpaceId(store, record?.s);
}

// Index for tabs.move so a today tab lands before `beforeTab` (or after the last one).
export function moveIndex(tab, beforeTab, lastTab) {
  if (!beforeTab) return lastTab ? (tab.index <= lastTab.index ? lastTab.index : lastTab.index + 1) : -1;
  return tab.index < beforeTab.index ? beforeTab.index - 1 : beforeTab.index;
}

// ---------------------------------------------------------------- persistence

function createMutex() {
  let tail = Promise.resolve();
  return {
    request(_name, callback) {
      const run = tail.then(() => callback());
      tail = run.catch(() => {});
      return run;
    },
  };
}

const fallbackLocks = createMutex();

// Read-modify-write transactions over chrome.storage.local, serialized across
// every window with a Web Lock so no window can lose another window's write.
export class WorkspaceStore {
  constructor({ storage, locks = globalThis.navigator?.locks, makeToken = () => uid('session') } = {}) {
    this.storage = storage;
    this.locks = locks || fallbackLocks;
    this.makeToken = makeToken;
  }

  async read() {
    const values = await this.storage.local.get([STORE_KEY, MEMBERS_KEY]);
    return { store: normalizeStore(values[STORE_KEY]), members: normalizeMembers(values[MEMBERS_KEY]) };
  }

  // fn(draft) mutates { store, members, session } and may return a value.
  // Only changed keys are written; a changed store increments `rev`.
  transact(fn) {
    return this.locks.request(LOCK_NAME, async () => {
      const { store, members } = await this.read();
      const beforeStore = JSON.stringify(store);
      const beforeMembers = JSON.stringify(members);
      const session = await this.sessionToken();
      rollSession(members, session);
      const result = await fn({ store, members, session });
      const writes = {};
      if (JSON.stringify(store) !== beforeStore) {
        store.rev += 1;
        writes[STORE_KEY] = store;
      }
      if (JSON.stringify(members) !== beforeMembers) writes[MEMBERS_KEY] = members;
      if (Object.keys(writes).length) await this.storage.local.set(writes);
      return result;
    });
  }

  update(fn) {
    return this.transact(({ store }) => fn(store));
  }

  // Applies this window's membership changes without touching other windows' tabs.
  patchMembers(set = {}, remove = []) {
    return this.transact(({ members, session }) => {
      for (const [id, record] of Object.entries(set)) members.tabs[id] = { ...record, k: session };
      for (const id of remove) delete members.tabs[id];
    });
  }

  // Must run inside a lock (transact does). Token creation is idempotent per browser session.
  async sessionToken() {
    const values = await this.storage.session.get(SESSION_KEY);
    if (typeof values[SESSION_KEY] === 'string' && values[SESSION_KEY]) return values[SESSION_KEY];
    const token = this.makeToken();
    await this.storage.session.set({ [SESSION_KEY]: token });
    return token;
  }

  reconcile({ tabs, fallbackSpaceId, hints }) {
    return this.transact(({ store, members, session }) => {
      const result = reconcileWindowTabs({ members, store, tabs, session, fallbackSpaceId, hints });
      return { ...result, store: structuredClone(store) };
    });
  }
}
