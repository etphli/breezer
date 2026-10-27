import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_APPEARANCE, MAX_FAVORITES, MEMBERS_KEY, SESSION_KEY, STORE_KEY, WorkspaceStore,
  addEntry, addFavorite, addFolder, addSpace, buildSidebarModel, findEntriesByUrl, findNode, moveIndex, moveNode, moveSpace,
  normalizeAppearance, normalizeMembers, normalizeStore, parseRoute, reconcileWindowTabs, removeNode, removeSpace,
  renameNode, rollSession, spaceOfTab, validateAppearancePatch, visibleTabs,
} from '../../features/ai/extension/workspace-store.js';

// chrome.storage-like area backed by a Map; values are deep-copied like the real API.
function fakeArea() {
  const data = new Map();
  return {
    data,
    async get(keys) {
      const list = keys === undefined ? [...data.keys()] : [keys].flat();
      return Object.fromEntries(list.filter((key) => data.has(key)).map((key) => [key, structuredClone(data.get(key))]));
    },
    async set(values) {
      await new Promise((resolve) => setTimeout(resolve, Math.random() * 3));
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
    clear() { data.clear(); },
  };
}

function fakeStorage() {
  return { local: fakeArea(), session: fakeArea() };
}

// Minimal Web Locks: one shared FIFO queue per name, like navigator.locks across extension pages.
function fakeLocks() {
  const tails = new Map();
  let held = 0;
  let maxHeld = 0;
  return {
    get maxHeld() { return maxHeld; },
    request(name, callback) {
      const previous = tails.get(name) || Promise.resolve();
      const run = previous.then(async () => {
        held += 1;
        maxHeld = Math.max(maxHeld, held);
        try { return await callback(); } finally { held -= 1; }
      });
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
}

const tab = (id, url, extra = {}) => ({ id, url, index: id, windowId: 1, active: false, pinned: false, title: url, ...extra });

function restoreAmbiguousAcrossWindows(previousUrls, targetUrl, order, { extraRecords = [], verifyUrl = '' } = {}) {
  const store = normalizeStore(undefined);
  const work = addSpace(store, { name: 'Work' });
  const fallback = store.spaces[0].id;
  const tabs = {
    11: { s: work.id, u: previousUrls[0], k: 'old' },
    12: { s: fallback, u: previousUrls[1], k: 'old' },
    // This record belongs to a window already reconciled in the current session.
    90: { s: work.id, u: targetUrl, k: 'new' },
  };
  for (const { id, url, assignment = 'work' } of extraRecords) {
    tabs[id] = { s: assignment === 'work' ? work.id : fallback, u: url, k: 'old' };
  }
  const members = normalizeMembers({ version: 1, session: 'new', prev: 'old', tabs });
  const assigned = {};
  for (const [name, id] of order) {
    const result = reconcileWindowTabs({ members, store, tabs: [tab(id, targetUrl)], session: 'new', fallbackSpaceId: fallback });
    assigned[name] = result.assigned[id].s;
  }
  const siblingAssignment = verifyUrl
    ? reconcileWindowTabs({ members, store, tabs: [tab(3, verifyUrl)], session: 'new', fallbackSpaceId: fallback }).assigned[3].s
    : null;
  return {
    assigned,
    currentWindowRecord: members.tabs[90],
    staleIds: Object.entries(members.tabs).filter(([, record]) => record.k === 'old').map(([id]) => id).sort(),
    quarantine: structuredClone(members.quarantine),
    siblingAssignment,
    fallback,
    work: work.id,
  };
}

test('routes parse the explicit native window id', () => {
  assert.deepEqual(parseRoute('#/sidebar?w=42'), { view: 'sidebar', windowId: 42 });
  assert.deepEqual(parseRoute('#/settings'), { view: 'settings', windowId: null });
  assert.deepEqual(parseRoute(''), { view: 'sidebar', windowId: null });
  assert.deepEqual(parseRoute('#/sidebar?w=abc'), { view: 'sidebar', windowId: null });
  assert.deepEqual(parseRoute('#/sidebar?w=-1'), { view: 'sidebar', windowId: null });
});

test('appearance defaults and validation match the native contract', () => {
  assert.deepEqual(DEFAULT_APPEARANCE, { layout: 'sidebar', sidebarMode: 'expanded', theme: 'mint', colorMode: 'system', showBookmarks: true, sidebarWidth: 240 });
  assert.deepEqual(normalizeAppearance(undefined), DEFAULT_APPEARANCE);
  assert.deepEqual(normalizeAppearance({ layout: 'top', theme: 'dusk', colorMode: 'dark', showBookmarks: false, sidebarWidth: 999 }),
    { layout: 'top', sidebarMode: 'expanded', theme: 'dusk', colorMode: 'dark', showBookmarks: false, sidebarWidth: 360 });
  assert.equal(normalizeAppearance({ theme: 'neon' }).theme, 'mint');
  assert.deepEqual(validateAppearancePatch({ theme: 'rose' }), { theme: 'rose' });
  for (const bad of [{}, null, [], { sidebarMode: 'hidden' }, { colour: 'x' }, { theme: 'neon' }, { sidebarWidth: 199 }, { sidebarWidth: 361 }, { sidebarWidth: 240.5 }, { showBookmarks: 'yes' }, { layout: 'left' }]) {
    assert.throws(() => validateAppearancePatch(bad), Error, JSON.stringify(bad));
  }
});

test('store normalization survives corrupt data and keeps at least one space', () => {
  const store = normalizeStore({ version: 1, spaces: [], favorites: [{ url: 'javascript:alert(1)' }], prefs: { closeButton: 'nope' } });
  assert.equal(store.spaces.length, 1);
  assert.deepEqual(store.favorites, []);
  assert.equal(store.prefs.closeButton, 'hover');
  const duplicate = normalizeStore({ version: 1, spaces: [{ id: 'a', name: 'A', tone: 'tide', pinned: [{ kind: 'entry', id: 'x', url: 'https://a.test/' }, { kind: 'entry', id: 'x', url: 'https://b.test/' }] }] });
  assert.equal(duplicate.spaces[0].pinned.length, 1, 'duplicate ids are dropped');
  assert.equal(normalizeStore({ version: 2 }).spaces[0].name, 'Personal');
});

test('space, folder, entry and favorite operations', () => {
  const store = normalizeStore(undefined);
  const home = store.spaces[0].id;
  const work = addSpace(store, { name: 'Work', tone: 'tide' });
  const folder = addFolder(store, work.id, 'Design');
  const figma = addEntry(store, work.id, { url: 'https://figma.com/', title: 'Figma' }, { folderId: folder.id });
  const linear = addEntry(store, work.id, { url: 'https://linear.app/', title: 'Linear' });
  assert.equal(findNode(store, figma.id).folder.id, folder.id);
  assert.throws(() => addEntry(store, work.id, { id: figma.id, url: 'https://figma.com/' }), /Already pinned/);

  moveNode(store, linear.id, { spaceId: work.id, folderId: folder.id, index: 0 });
  assert.deepEqual(folder.children.map((entry) => entry.title), ['Linear', 'Figma']);
  assert.throws(() => moveNode(store, folder.id, { favorites: true }), /Folders/);

  renameNode(store, figma.id, 'Mocks');
  assert.equal(figma.customTitle, 'Mocks');
  renameNode(store, figma.id, '');
  assert.equal(figma.customTitle, undefined);

  removeNode(store, folder.id);
  assert.deepEqual(work.pinned.map((node) => node.title), ['Linear', 'Figma'], 'deleting a folder keeps its entries');

  moveNode(store, linear.id, { favorites: true });
  assert.equal(store.favorites[0].id, linear.id);
  for (let i = store.favorites.length; i < MAX_FAVORITES; i += 1) addFavorite(store, { url: `https://f${i}.test/` });
  assert.throws(() => addFavorite(store, { url: 'https://overflow.test/' }), /Favorites hold/);

  assert.equal(moveSpace(store, work.id, -1), true);
  assert.equal(store.spaces[0].id, work.id);
  assert.equal(removeSpace(store, work.id), home);
  assert.equal(store.spaces[0].pinned.some((node) => node.id === figma.id), true, 'deleted space hands its pins to the first space');
  assert.throws(() => removeSpace(store, home), /at least one/);
});

test('sidebar model splits favorites, pinned and today tabs per space', () => {
  const store = normalizeStore(undefined);
  const home = store.spaces[0].id;
  const work = addSpace(store, { name: 'Work' });
  const pin = addEntry(store, work.id, { url: 'https://docs.test/' });
  const sleeping = addEntry(store, work.id, { url: 'https://sleep.test/' });
  const fav = addFavorite(store, { url: 'https://mail.test/' });
  const tabs = [tab(1, 'https://docs.test/', { pinned: true }), tab(2, 'https://a.test/'), tab(3, 'https://b.test/'), tab(4, 'https://mail.test/', { active: true })];
  const records = { 1: { s: work.id, e: pin.id }, 2: { s: work.id }, 3: { s: home }, 4: { s: home, e: fav.id } };

  const model = buildSidebarModel({ store, records, tabs, activeSpaceId: work.id });
  assert.equal(model.space.id, work.id);
  assert.equal(model.favorites[0].tab.id, 4);
  assert.deepEqual(model.pinned.map((node) => [node.entry.id, node.tab?.id ?? null]), [[pin.id, 1], [sleeping.id, null]]);
  assert.deepEqual(model.today.map((item) => item.id), [2]);
  assert.deepEqual(visibleTabs(model).map((item) => item.id), [1, 2]);
  assert.deepEqual(Object.fromEntries(model.spaces.map((space) => [space.name, space.tabCount])), { Personal: 1, Work: 2 });

  assert.equal(spaceOfTab(store, records, 4), null, 'favorite tabs belong to every space');
  assert.equal(spaceOfTab(store, { 9: { s: 'deleted-space' } }, 9), home, 'unknown spaces fall back to the first');
  assert.equal(buildSidebarModel({ store, records, tabs, activeSpaceId: 'gone' }).space.id, home);
});

test('moveIndex places a tab before a neighbor or at the end of the visible list', () => {
  assert.equal(moveIndex({ index: 2 }, { index: 5 }), 4);
  assert.equal(moveIndex({ index: 6 }, { index: 5 }), 5);
  assert.equal(moveIndex({ index: 2 }, null, { index: 7 }), 7);
  assert.equal(moveIndex({ index: 9 }, null, { index: 7 }), 8);
  assert.equal(moveIndex({ index: 9 }, null, null), -1);
});

test('restart: previous-session records restore spaces and pinned bindings by URL', () => {
  const store = normalizeStore(undefined);
  const work = addSpace(store, { name: 'Work' });
  const pin = addEntry(store, work.id, { url: 'https://docs.test/home' });
  const members = normalizeMembers({ version: 1, session: 'old', tabs: {
    11: { s: work.id, u: 'https://a.test/x?q=1', k: 'old' },
    12: { s: work.id, u: 'https://a.test/x?q=1', k: 'old' },
    13: { s: store.spaces[0].id, u: 'https://b.test/', k: 'old' },
    14: { s: work.id, e: pin.id, u: 'https://docs.test/home', k: 'old' },
  } });
  rollSession(members, 'new');
  assert.equal(members.prev, 'old');
  const restored = [tab(1, 'https://docs.test/home', { pinned: true }), tab(2, 'https://a.test/x?q=1'), tab(3, 'https://a.test/x?q=1'), tab(4, 'https://b.test/'), tab(5, 'https://fresh.test/')];
  const { assigned } = reconcileWindowTabs({ members, store, tabs: restored, session: 'new', fallbackSpaceId: store.spaces[0].id });

  assert.deepEqual(assigned[1], { s: work.id, e: pin.id, u: 'https://docs.test/home', k: 'new' });
  assert.equal(assigned[2].s, work.id);
  assert.equal(assigned[3].s, work.id, 'duplicate URLs each consume one record');
  assert.equal(assigned[4].s, store.spaces[0].id);
  assert.equal(assigned[5].s, store.spaces[0].id, 'unmatched tabs use the fallback space');
  for (const old of ['11', '12', '13', '14']) assert.equal(old in members.tabs, false, 'consumed stale records are removed');
});

test('restart: ambiguous exact URL records fall back independent of window restore order', () => {
  const exact = 'https://shared.test/document?id=1';
  const sibling = 'https://shared.test/document?id=2';
  const extraRecords = [{ id: 13, url: sibling, assignment: 'work' }];
  const forward = restoreAmbiguousAcrossWindows([exact, exact], exact, [['windowA', 1], ['windowB', 2]], { extraRecords, verifyUrl: sibling });
  const reverse = restoreAmbiguousAcrossWindows([exact, exact], exact, [['windowB', 2], ['windowA', 1]], { extraRecords, verifyUrl: sibling });
  const reusedIds = restoreAmbiguousAcrossWindows([exact, exact], exact, [['windowA', 11], ['windowB', 12]], { extraRecords, verifyUrl: sibling });

  assert.deepEqual(forward.assigned, { windowA: forward.fallback, windowB: forward.fallback });
  assert.deepEqual(reverse.assigned, { windowB: reverse.fallback, windowA: reverse.fallback });
  assert.notEqual(forward.work, forward.fallback);
  assert.notEqual(reverse.work, reverse.fallback);
  assert.deepEqual(forward.currentWindowRecord, { s: forward.work, u: exact, k: 'new' }, 'quarantining old records preserves another window current-session record');
  assert.deepEqual(reverse.currentWindowRecord, { s: reverse.work, u: exact, k: 'new' }, 'restore order does not alter current-session membership');
  assert.deepEqual(forward.quarantine.exact, reverse.quarantine.exact);
  assert.equal(forward.quarantine.exact.length, 1);
  assert.equal(forward.quarantine.path.length, 1, 'exact ambiguity also blocks weaker path fallback');
  assert.deepEqual(forward.staleIds, ['11', '12'], 'quarantined records remain available to distinguish other exact URLs');
  assert.deepEqual(reverse.staleIds, ['11', '12']);
  assert.equal(forward.siblingAssignment, forward.work, 'an unrelated exact URL in the same path still restores uniquely');
  assert.equal(reverse.siblingAssignment, reverse.work);
  assert.deepEqual(reusedIds.assigned, { windowA: reusedIds.fallback, windowB: reusedIds.fallback }, 'reused tab ids do not erase the quarantine before another window restores');
  assert.equal(reusedIds.siblingAssignment, reusedIds.work);
});

test('restart: ambiguous path-only URL records fall back independent of window restore order', () => {
  const previous = ['https://shared.test/document?id=old-a', 'https://shared.test/document?id=old-b'];
  const target = 'https://shared.test/document?id=current';
  const forward = restoreAmbiguousAcrossWindows(previous, target, [['windowA', 1], ['windowB', 2]]);
  const reverse = restoreAmbiguousAcrossWindows(previous, target, [['windowB', 2], ['windowA', 1]]);

  assert.deepEqual(forward.assigned, { windowA: forward.fallback, windowB: forward.fallback });
  assert.deepEqual(reverse.assigned, { windowB: reverse.fallback, windowA: reverse.fallback });
  assert.deepEqual(forward.currentWindowRecord, { s: forward.work, u: target, k: 'new' });
  assert.deepEqual(reverse.currentWindowRecord, { s: reverse.work, u: target, k: 'new' });
  assert.deepEqual(forward.quarantine.path, reverse.quarantine.path);
  assert.equal(forward.quarantine.path.length, 1);
  assert.deepEqual(forward.staleIds, ['11', '12']);
  assert.deepEqual(reverse.staleIds, ['11', '12']);
});

test('restart: unique and same-assignment URL candidates keep their space', () => {
  const store = normalizeStore(undefined);
  const work = addSpace(store, { name: 'Work' });
  const members = normalizeMembers({ version: 1, session: 'new', prev: 'old', tabs: {
    11: { s: work.id, u: 'https://unique.test/page?old=1', k: 'old' },
    12: { s: work.id, u: 'https://shared.test/page', k: 'old' },
    13: { s: work.id, u: 'https://shared.test/page', k: 'old' },
  } });
  const restored = [
    tab(1, 'https://unique.test/page?old=1'),
    tab(2, 'https://shared.test/page'),
    tab(3, 'https://shared.test/page'),
  ];
  const { assigned } = reconcileWindowTabs({ members, store, tabs: restored, session: 'new', fallbackSpaceId: store.spaces[0].id });

  assert.equal(assigned[1].s, work.id, 'one matching previous record is safe to restore');
  assert.equal(assigned[2].s, work.id, 'same-assignment duplicates retain their assignment');
  assert.equal(assigned[3].s, work.id, 'each same-assignment duplicate can serve a restored tab');
});

test('restart: path match, pinned entry match, orphan pinned and reload with stable ids', () => {
  const store = normalizeStore(undefined);
  const work = addSpace(store, { name: 'Work' });
  const pin = addEntry(store, work.id, { url: 'https://pinned.test/app' });
  const members = normalizeMembers({ version: 1, session: 'old', tabs: {
    7: { s: work.id, u: 'https://moved.test/page?old=1', k: 'old' },
    30: { s: work.id, u: 'https://same-id.test/', k: 'old' },
  } });
  rollSession(members, 'new');
  const tabs = [
    tab(1, 'https://moved.test/page?new=2'),
    tab(2, 'https://pinned.test/app', { pinned: true }),
    tab(3, 'https://unknown.test/', { pinned: true }),
    tab(30, 'https://same-id.test/'),
  ];
  const { assigned, orphanPinned } = reconcileWindowTabs({ members, store, tabs, session: 'new', fallbackSpaceId: store.spaces[0].id });
  assert.equal(assigned[1].s, work.id, 'origin+path match');
  assert.equal(assigned[2].e, pin.id, 'Chromium-pinned tab binds to its entry');
  assert.deepEqual(orphanPinned, [3]);
  assert.equal(assigned[30].s, work.id, 'extension reload keeps same-id records');
});

test('optional per-tab hints win when available', () => {
  const store = normalizeStore(undefined);
  const work = addSpace(store, { name: 'Work' });
  const members = normalizeMembers(undefined);
  rollSession(members, 'new');
  const { assigned } = reconcileWindowTabs({ members, store, tabs: [tab(1, 'https://x.test/')], session: 'new', fallbackSpaceId: store.spaces[0].id, hints: { 1: { s: work.id, e: '' } } });
  assert.equal(assigned[1].s, work.id);
});

test('rollSession keeps only the previous session for matching', () => {
  const members = normalizeMembers({ version: 1, session: 'b', prev: 'a', tabs: { 1: { s: 'x', u: '', k: 'a' }, 2: { s: 'x', u: '', k: 'b' } } });
  members.quarantine = { session: 'b', exact: ['deadbeef'], path: ['f00baa12'] };
  assert.equal(rollSession(members, 'b'), false);
  assert.equal(rollSession(members, 'c'), true);
  assert.deepEqual(Object.keys(members.tabs), ['2']);
  assert.equal(members.prev, 'b');
  assert.deepEqual(members.quarantine, { session: 'c', exact: [], path: [] }, 'ambiguity markers do not leak into the next session');
});

test('WorkspaceStore serializes concurrent writers from different windows', async () => {
  const storage = fakeStorage();
  const locks = fakeLocks();
  const windowA = new WorkspaceStore({ storage, locks });
  const windowB = new WorkspaceStore({ storage, locks });
  await Promise.all(Array.from({ length: 12 }, (_, i) => (i % 2 ? windowA : windowB).update((store) => {
    addEntry(store, store.spaces[0].id, { url: `https://site${i}.test/` });
  })));
  const { store } = await windowA.read();
  assert.equal(store.spaces[0].pinned.length, 12, 'no lost writes');
  assert.equal(store.rev, 12);
  assert.equal(locks.maxHeld, 1);

  await Promise.all([
    windowA.patchMembers({ 1: { s: 'a' } }),
    windowB.patchMembers({ 2: { s: 'b' } }),
    windowA.patchMembers({}, ['1']),
  ]);
  const { members } = await windowB.read();
  assert.deepEqual(Object.keys(members.tabs), ['2']);
  assert.equal(members.tabs[2].k, members.session);
});

test('WorkspaceStore: browser restart restores today tabs to their spaces', async () => {
  const storage = fakeStorage();
  let counter = 0;
  const workspace = new WorkspaceStore({ storage, locks: fakeLocks(), makeToken: () => `session-${++counter}` });
  const work = await workspace.update((store) => addSpace(store, { name: 'Work', tone: 'dusk' }));
  const firstRun = [tab(101, 'https://a.test/'), tab(102, 'https://b.test/')];
  await workspace.reconcile({ tabs: firstRun, fallbackSpaceId: undefined });
  await workspace.patchMembers({ 101: { s: work.id, u: 'https://a.test/' } });

  // Restart: storage.session is wiped and Chromium hands out new tab ids.
  storage.session.clear();
  const restored = [tab(1, 'https://b.test/'), tab(2, 'https://a.test/')];
  const { assigned } = await workspace.reconcile({ tabs: restored, fallbackSpaceId: undefined });
  const { store } = await workspace.read();
  assert.equal(assigned[2].s, work.id);
  assert.equal(assigned[1].s, store.spaces[0].id);
  assert.equal(storage.session.data.get(SESSION_KEY), 'session-2');
  const persisted = storage.local.data.get(MEMBERS_KEY);
  assert.deepEqual(Object.keys(persisted.tabs).sort(), ['1', '2']);
  assert.ok(storage.local.data.get(STORE_KEY).rev >= 1);
});

test('WorkspaceStore persists URL quarantine before another window restores the same page', async () => {
  const storage = fakeStorage();
  const locks = fakeLocks();
  const store = normalizeStore(undefined);
  const work = addSpace(store, { name: 'Work' });
  const url = 'https://shared.test/page?id=1';
  await storage.local.set({ [STORE_KEY]: store, [MEMBERS_KEY]: normalizeMembers({ version: 1, session: 'old', tabs: {
    11: { s: work.id, u: url, k: 'old' },
    12: { s: store.spaces[0].id, u: url, k: 'old' },
  } }) });
  await storage.session.set({ [SESSION_KEY]: 'new' });
  const windowA = new WorkspaceStore({ storage, locks });
  const windowB = new WorkspaceStore({ storage, locks });

  const first = await windowA.reconcile({ tabs: [tab(1, url)], fallbackSpaceId: store.spaces[0].id });
  const afterFirst = await windowA.read();
  const second = await windowB.reconcile({ tabs: [tab(2, url)], fallbackSpaceId: store.spaces[0].id });

  assert.equal(first.assigned[1].s, store.spaces[0].id);
  assert.equal(second.assigned[2].s, store.spaces[0].id);
  assert.equal(afterFirst.members.quarantine.session, 'new');
  assert.equal(afterFirst.members.quarantine.exact.length, 1);
  assert.equal(afterFirst.members.quarantine.path.length, 1);
});

test('duplicate saved pins never borrow another space or multiply during restore', () => {
  const store = normalizeStore({ version: 1, spaces: [
    { id: 'work', name: 'Work', tone: 'mint', pinned: [{ kind: 'entry', id: 'pin-work', url: 'https://example.com/same', title: 'Work' }] },
    { id: 'home', name: 'Home', tone: 'rose', pinned: [{ kind: 'entry', id: 'pin-home', url: 'https://example.com/same', title: 'Home' }] },
  ], favorites: [] });
  const members = normalizeMembers({});
  const tabs = [{ id: 42, windowId: 7, index: 0, pinned: true, active: true, url: 'https://example.com/same' }];
  assert.equal(findEntriesByUrl(store, tabs[0].url).length, 2);
  const result = reconcileWindowTabs({ members, store, tabs, session: 'new', fallbackSpaceId: 'work' });
  assert.equal(result.assigned[42].s, 'work');
  assert.equal(result.assigned[42].e, undefined);
  assert.deepEqual(result.orphanPinned, []);
  const model = buildSidebarModel({ store, records: result.assigned, tabs, activeSpaceId: 'work' });
  assert.deepEqual(model.today.map(tab => tab.id), [42]);
  assert.equal(store.spaces.reduce((sum, space) => sum + space.pinned.length, 0), 2);
});
