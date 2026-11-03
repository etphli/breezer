import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

// The override permits a negative control against a preserved source file.
const api = await import(process.env.WORKSPACE_INDEX_SOURCE
  ? pathToFileURL(process.env.WORKSPACE_INDEX_SOURCE).href
  : '../../features/ai/extension/workspace-store.js');
const entry = id => ({ kind: 'entry', id, url: `https://example.invalid/${id}`, title: id });
function fixture() {
  const store = api.defaultStore();
  store.favorites = [entry('favorite')];
  store.spaces[0].pinned = [entry('pin'), { kind: 'folder', id: 'folder', open: true, children: [entry('child')] }];
  store.spaces.push({ id: 'work', name: 'Work', tone: 'tide', pinned: [] });
  const tabs = ['favorite', 'pin', 'child', 'gone', '', 'favorite'].map((e, i) => ({ id: i + 1, index: i, url: entry(e).url }));
  const records = Object.fromEntries(tabs.map((tab, i) => [tab.id, { s: 'work', e: ['favorite', 'pin', 'child', 'gone', '', 'favorite'][i], k: 'now', u: tab.url }]));
  return { store, tabs, records, activeSpaceId: 'space-default' };
}

test('both exported operations index containing spaces directly without per-node wrappers', () => {
  const args = fixture();
  const ids = new Set(['favorite', 'pin', 'folder', 'child']);
  const OriginalMap = globalThis.Map;
  const writes = [];
  globalThis.Map = class extends OriginalMap {
    set(key, value) {
      if (ids.has(key)) writes.push({ map: this, key, value });
      return super.set(key, value);
    }
  };
  try {
    api.buildSidebarModel(args);
    api.reconcileWindowTabs({ ...args, members: { tabs: structuredClone(args.records) }, session: 'now' });
  } finally { globalThis.Map = OriginalMap; }
  // Bound-tab maps also use entry IDs. Select the two maps that contain folders.
  const indexes = new Set(writes.filter(write => write.key === 'folder').map(write => write.map));
  assert.equal(indexes.size, 2);
  const indexed = writes.filter(write => indexes.has(write.map));
  assert.equal(indexed.length, 8);
  for (const { key, value } of indexed) {
    assert.strictEqual(value, key === 'favorite' ? null : args.store.spaces[0], `direct index value for ${key}`);
  }
});

test('favorite null bindings stay present; tombstones, falsey IDs and second bindings become today', () => {
  const args = fixture();
  const model = api.buildSidebarModel(args);
  assert.strictEqual(model.space, args.store.spaces[0]);
  assert.strictEqual(model.prefs, args.store.prefs);
  assert.strictEqual(model.favorites[0].entry, args.store.favorites[0]);
  assert.strictEqual(model.favorites[0].tab, args.tabs[0]);
  assert.strictEqual(model.pinned[0].tab, args.tabs[1]);
  assert.strictEqual(model.pinned[1].children[0].tab, args.tabs[2]);
  assert.deepEqual(model.spaces.map(space => space.tabCount), [2, 3]);
  const members = { tabs: structuredClone(args.records) };
  const result = api.reconcileWindowTabs({ ...args, members, session: 'now' });
  for (const tab of args.tabs) assert.strictEqual(result.assigned[tab.id], members.tabs[tab.id]);
  assert.equal(result.assigned[1].e, 'favorite');
  for (const id of [4, 5, 6]) assert.equal(result.assigned[id].e, undefined);
});

test('last duplicate ID wins and each operation sees moved or replaced spaces', () => {
  const args = fixture();
  args.store.spaces[1].pinned.push(entry('favorite'), entry('child'));
  let model = api.buildSidebarModel(args);
  assert.deepEqual(model.spaces.map(space => space.tabCount), [1, 5]);
  const replacement = { ...args.store.spaces[1], pinned: [entry('pin')] };
  args.store.spaces[1] = replacement;
  model = api.buildSidebarModel({ ...args, activeSpaceId: 'work' });
  assert.strictEqual(model.space, replacement);
  assert.strictEqual(model.pinned[0].entry, replacement.pinned[0]);
  assert.strictEqual(model.pinned[0].tab, args.tabs[1]);
  assert.deepEqual(model.spaces.map(space => space.tabCount), [1, 4]);
  api.removeNode(args.store, 'favorite');
  const members = { tabs: structuredClone(args.records) };
  assert.equal(api.reconcileWindowTabs({ ...args, members, session: 'now' }).assigned[1].e, undefined);
});

test('frozen saved stores preserve node, tab and preferences identities without mutation', () => {
  const args = fixture();
  const freeze = object => { if (object && typeof object === 'object') { Object.values(object).forEach(freeze); Object.freeze(object); } };
  freeze(args.store); freeze(args.tabs); freeze(args.records);
  const model = api.buildSidebarModel(args);
  assert.strictEqual(model.pinned[1].folder, args.store.spaces[0].pinned[1]);
  assert.strictEqual(model.pinned[1].children[0].entry, args.store.spaces[0].pinned[1].children[0]);
  assert.strictEqual(model.prefs, args.store.prefs);
  assert.doesNotThrow(() => api.reconcileWindowTabs({ ...args, members: { tabs: structuredClone(args.records) }, session: 'now' }));
});
