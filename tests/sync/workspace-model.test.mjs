import test from 'node:test';
import assert from 'node:assert/strict';
import { defaultStore, addSpace, addFolder, addEntry, addFavorite, renameSpace, renameNode, removeNode, removeSpace, setFolderOpen, moveNode } from '../../features/ai/extension/workspace-store.js';
import { emptySyncModel, projectWorkspace, recordWorkspaceChanges, mergeSyncModels, materializeWorkspace, validateSyncModel } from '../../features/ai/extension/workspace-sync-model.js';

const initial = () => {
  const store = defaultStore();
  const folder = addFolder(store, 'space-default', 'Work');
  const entry = addEntry(store, 'space-default', { url: 'https://example.test/same', title: 'One' }, { folderId: folder.id });
  const second = addSpace(store, { name: 'Second', tone: 'rose' });
  const duplicate = addEntry(store, second.id, { url: entry.url, title: 'Two' });
  addFavorite(store, { url: entry.url, title: 'Favorite' });
  const model = recordWorkspaceChanges(emptySyncModel(), {}, projectWorkspace(store), 'client_alpha');
  return { store, model, folder, entry, second, duplicate };
};
const edit = (model, store, client, fn) => {
  const changed = structuredClone(store); fn(changed);
  return recordWorkspaceChanges(model, projectWorkspace(store), projectWorkspace(changed), client);
};

test('persistent identity preserves duplicate URLs; local IDs and folder expansion never sync', () => {
  const { store, model, folder } = initial();
  store.tabs = { 12: 'secret' }; store.members = { 123: { windowId: 2 } };
  setFolderOpen(store, folder.id, false);
  const projection = projectWorkspace(store);
  assert.doesNotMatch(JSON.stringify(projection), /secret|windowId|members|"open"/);
  const restored = materializeWorkspace(model, store).store;
  assert.equal(restored.spaces[0].pinned[0].open, false);
  assert.equal(restored.spaces[0].pinned[0].children[0].url, restored.spaces[1].pinned[0].url);
  assert.notEqual(restored.spaces[0].pinned[0].children[0].id, restored.spaces[1].pinned[0].id);
  assert.equal(restored.favorites.length, 1);
});

test('two offline clients converge with concurrent rename, move, independent field edits and restart', () => {
  const { store, model, entry, second } = initial();
  const alpha = edit(model, store, 'client_alpha', s => { renameSpace(s, second.id, 'Team'); renameNode(s, entry.id, 'Changed'); });
  const beta = edit(model, store, 'client_beta1', s => { moveNode(s, entry.id, { spaceId: second.id }); s.spaces[1].tone = 'tide'; });
  const a = mergeSyncModels(alpha, beta), b = mergeSyncModels(beta, alpha);
  assert.deepEqual(a, b);
  assert.deepEqual(mergeSyncModels(a, a), a);
  const { store: restored } = materializeWorkspace(JSON.parse(JSON.stringify(a)));
  assert.equal(restored.spaces[1].name, 'Team');
  assert.equal(restored.spaces[1].tone, 'tide');
  assert.equal(restored.spaces[1].pinned.find(n => n.id === entry.id).customTitle, 'Changed');
});

test('deletions survive stale clients, later edits and concurrent folder/space removal', () => {
  const { store, model, folder, entry, second } = initial();
  const alpha = edit(model, store, 'client_alpha', s => removeNode(s, entry.id));
  const beta = edit(model, store, 'client_beta1', s => renameNode(s, entry.id, 'Offline rename'));
  const merged = mergeSyncModels(alpha, beta);
  assert.deepEqual(merged, mergeSyncModels(beta, alpha));
  assert.equal(materializeWorkspace(mergeSyncModels(merged, model)).store.spaces[0].pinned[0].children.length, 0);
  const folderRemoved = edit(model, store, 'client_alpha', s => removeNode(s, folder.id));
  const spaceRemoved = edit(model, store, 'client_beta1', s => removeSpace(s, second.id));
  const restored = materializeWorkspace(mergeSyncModels(folderRemoved, spaceRemoved)).store;
  assert.equal(restored.spaces.length, 1);
  assert.equal(restored.spaces[0].pinned.filter(n => n.kind === 'entry').length, 2);
});

test('same-field ties use stable client order; merge is associative', () => {
  const { store, model, second } = initial();
  const a = edit(model, store, 'client_alpha', s => renameSpace(s, second.id, 'Alpha'));
  const b = edit(model, store, 'client_beta1', s => renameSpace(s, second.id, 'Beta'));
  const c = edit(model, store, 'client_gamma', s => renameSpace(s, second.id, 'Gamma'));
  assert.deepEqual(mergeSyncModels(mergeSyncModels(a, b), c), mergeSyncModels(a, mergeSyncModels(b, c)));
  assert.equal(materializeWorkspace(mergeSyncModels(a, b)).store.spaces[1].name, 'Beta');
});

test('appearance allowlist includes only supported preferences and keeps field-level changes', () => {
  const store = defaultStore();
  const before = projectWorkspace(store, { theme: 'mint' });
  const base = recordWorkspaceChanges(emptySyncModel(), {}, before, 'client_alpha');
  const after = projectWorkspace(store, { theme: 'rose' });
  const changed = recordWorkspaceChanges(base, before, after, 'client_beta1');
  assert.equal(materializeWorkspace(changed).appearance.theme, 'rose');
  assert.ok(!('showBookmarks' in materializeWorkspace(changed).appearance));
  assert.throws(() => validateSyncModel({ version: 1, records: { 'appearance/password': { appearance: [1, 'client_alpha', 'secret'] } } }));
});

test('malformed and future data reject without mutating either client', () => {
  const { model } = initial(); const before = JSON.stringify(model);
  for (const bad of [null, { version: 2, records: {} }, { version: 1, records: { 'entry/valid': { password: [1, 'client_alpha', 'secret'] } } }, { version: 1, records: { 'entry/valid': { title: [1, 'bad', 'Title'] } } }]) {
    assert.throws(() => mergeSyncModels(model, bad));
    assert.equal(JSON.stringify(model), before);
  }
});

test('concurrent deletion of different last spaces recovers a usable stable identity', () => {
  const { store, model, second } = initial();
  const a = edit(model, store, 'client_alpha', s => removeSpace(s, 'space-default'));
  const b = edit(model, store, 'client_beta1', s => removeSpace(s, second.id));
  const merged = mergeSyncModels(a, b);
  const recovered = materializeWorkspace(merged).store;
  assert.equal(recovered.spaces.length, 1);
  assert.notEqual(recovered.spaces[0].id, 'space-default');
  assert.deepEqual(recovered, materializeWorkspace(mergeSyncModels(b, a)).store);
  const changed = edit(merged, recovered, 'client_alpha', s => { renameSpace(s, s.spaces[0].id, 'Recovered'); });
  assert.equal(materializeWorkspace(changed).store.spaces[0].name, 'Recovered');
});

test('concurrent capacity overflow rejects instead of silently losing saved items', () => {
  const store = defaultStore();
  for (let i = 0; i < 7; i += 1) addSpace(store, { name: `Space ${i}` });
  const model = recordWorkspaceChanges(emptySyncModel(), {}, projectWorkspace(store), 'client_alpha');
  const a = edit(model, store, 'client_alpha', s => addSpace(s, { name: 'A' }));
  const b = edit(model, store, 'client_beta1', s => addSpace(s, { name: 'B' }));
  assert.throws(() => materializeWorkspace(mergeSyncModels(a, b)), /exceed 9 spaces/);
  assert.equal(materializeWorkspace(a).store.spaces.length, 9);
  assert.equal(store.spaces.length, 8);
});

test('clock and payload limits fail without replacing local state', () => {
  const { store, model } = initial();
  model.records.preferences.newTabPosition[0] = Number.MAX_SAFE_INTEGER;
  assert.throws(() => edit(model, store, 'client_alpha', s => { s.prefs.newTabPosition = 'top'; }), /clock is exhausted/);
  const huge = { version: 1, records: { preferences: { closeButton: [1, 'client_alpha', 'x'.repeat(1024 * 1024)] } } };
  assert.throws(() => validateSyncModel(huge), /storage limit/);
});

test('incomplete or conflicting cross-kind identities reject instead of dropping an item during normalization', () => {
  const { model } = initial();
  const incomplete = structuredClone(model);
  incomplete.records['entry/incomplete'] = { alive: [1000, 'client_alpha', true] };
  assert.throws(() => validateSyncModel(incomplete), /Incomplete synced record/);
  const collision = structuredClone(model);
  const entry = Object.values(collision.records).find(record => record.url);
  collision.records['entry/space-default'] = structuredClone(entry);
  assert.throws(() => validateSyncModel(collision), /Conflicting synced identities/);
});
