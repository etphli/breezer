import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../features/ai/extension/workspace-store.js';
import { WorkspaceSync } from '../../features/ai/extension/workspace-sync.js';
import { emptySyncModel, materializeWorkspace, serializeSyncModel } from '../../features/ai/extension/workspace-sync-model.js';
import { harness } from './workspace-activation-harness.mjs';

const settle = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
const snapshotOf = (store, id) => {
  const found = S.findNode(store, id);
  return { node: structuredClone(found.node), spaceId: found.space?.id ?? null, folderId: found.folder?.id ?? null, index: found.index, favorite: found.favorite };
};

function syncedDevice(server, client) {
  const saved = { [S.STORE_KEY]: S.defaultStore() };
  const storage = { local: {
    get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in saved).map((key) => [key, structuredClone(saved[key])])),
    set: async (patch) => Object.assign(saved, structuredClone(patch)),
  } };
  let appearance = { ...S.DEFAULT_APPEARANCE };
  const bridge = {
    read: async () => structuredClone(server.state),
    exchange: async (request) => { if (server.state.model === request.expectedModel) server.state.model = request.model; return structuredClone(server.state); },
    getAppearance: async () => appearance,
    setAppearance: async (patch) => (appearance = { ...appearance, ...patch }),
  };
  const sync = new WorkspaceSync({ storage, bridge, locks: { request: async (_name, fn) => fn() }, makeClientId: () => client });
  return { saved, sync, store: () => saved[S.STORE_KEY] };
}

test('undone unpin and favorite removal survive the next sync on every device', async () => {
  const server = { state: { configured: true, workspaceEnabled: true, providerId: 'p', vaultId: 'v', model: serializeSyncModel(emptySyncModel()) } };
  const alpha = syncedDevice(server, 'client_alpha');
  const entry = S.addEntry(alpha.store(), 'space-default', { url: 'https://example.test/a', title: 'A' });
  S.renameNode(alpha.store(), entry.id, 'Named pin');
  const favorite = S.addFavorite(alpha.store(), { url: 'https://example.test/f', title: 'F' });
  await alpha.sync.cycle();
  const snapEntry = snapshotOf(alpha.store(), entry.id);
  const snapFavorite = snapshotOf(alpha.store(), favorite.id);
  S.removeNode(alpha.store(), entry.id);
  S.removeNode(alpha.store(), favorite.id);
  await alpha.sync.cycle();

  S.restoreRemovedEntry(alpha.store(), snapEntry);
  S.restoreRemovedEntry(alpha.store(), snapFavorite);
  await alpha.sync.cycle();
  await alpha.sync.cycle();
  const local = alpha.store();
  assert.deepEqual(local.spaces[0].pinned.map((node) => [node.url, node.customTitle]), [['https://example.test/a', 'Named pin']]);
  assert.deepEqual(local.favorites.map((node) => node.url), ['https://example.test/f']);

  // Another device sees the restored items once, not the deleted identities.
  const remote = materializeWorkspace(JSON.parse(server.state.model)).store;
  assert.deepEqual(remote.spaces[0].pinned.map((node) => [node.url, node.customTitle]), [['https://example.test/a', 'Named pin']]);
  assert.deepEqual(remote.favorites.map((node) => node.url), ['https://example.test/f']);
});

test('undone favorite removal respects the favorites limit and does not duplicate', () => {
  const store = S.defaultStore();
  for (let i = 0; i < S.MAX_FAVORITES; i++) S.addFavorite(store, { url: `https://f${i}.test/`, title: `F${i}` });
  const snapshot = snapshotOf(store, store.favorites[0].id);
  S.removeNode(store, snapshot.node.id);
  S.addFavorite(store, { url: 'https://new.test/', title: 'New' });
  assert.throws(() => S.restoreRemovedEntry(store, snapshot), /Favorites hold up to 12/);
  assert.equal(store.favorites.length, S.MAX_FAVORITES);
  assert.equal(S.normalizeStore(structuredClone(store)).favorites.length, S.MAX_FAVORITES);

  const again = S.defaultStore();
  const fav = S.addFavorite(again, { url: 'https://same.test/', title: 'Same' });
  const removed = snapshotOf(again, fav.id);
  S.removeNode(again, fav.id);
  S.addFavorite(again, { url: 'https://same.test/', title: 'Same' });
  S.restoreRemovedEntry(again, removed);
  assert.equal(again.favorites.length, 1);
});

test('undone unpin keeps the custom title and its position', () => {
  const store = S.defaultStore();
  S.addEntry(store, 'space-default', { url: 'https://one.test/', title: 'One' });
  const entry = S.addEntry(store, 'space-default', { url: 'https://two.test/', title: 'Two' });
  S.addEntry(store, 'space-default', { url: 'https://three.test/', title: 'Three' });
  S.renameNode(store, entry.id, 'My name');
  const snapshot = snapshotOf(store, entry.id);
  S.removeNode(store, entry.id);
  const restored = S.restoreRemovedEntry(store, snapshot);
  assert.equal(restored.customTitle, 'My name');
  assert.notEqual(restored.id, entry.id);
  assert.deepEqual(store.spaces[0].pinned.map((node) => node.url), ['https://one.test/', 'https://two.test/', 'https://three.test/']);
});

test('sidebar undo of a favorite removal goes through the restore rules', async () => {
  const h = await harness();
  const store = structuredClone(h.state.store);
  let undo = null, message = null;
  h.context.structuredClone = structuredClone;
  h.context.mutate = async (fn) => { const result = fn(store); h.state.store = structuredClone(store); return result; };
  h.context.showToast = (text, _label, action) => { message = text; undo = action; };
  await h.context.unpinEntry(store.favorites.find((node) => node.id === 'v-chat'), null);
  assert.equal(message, 'Removed from favorites.');
  await undo();
  assert.deepEqual(store.favorites.map((node) => node.url), ['https://calendar.example.com/week', 'https://chat.example.com/', 'https://notes.example.com/', 'https://music.example.com/']);
  assert.ok(!S.findNode(store, 'v-chat'), 'the restored favorite has a fresh id');
});

test('a favorite tab dragged into an open window keeps its saved-entry link', async () => {
  const h = await harness();
  // The receiving window has never seen tab 8; its stored membership links v-cal.
  delete h.state.records[8];
  h.state.tabs.delete(8);
  h.onAttached(8, { newWindowId: 7 });
  await settle();
  assert.equal(h.state.records[8]?.e, 'v-cal');
});

test('undo of Clear Today restores every closed tab, including repeated URLs', async () => {
  const h = await harness();
  const created = [], restored = [];
  h.api.tabs.create = async (options) => { const tab = { id: 100 + created.length, windowId: 7, index: 20, active: false, pinned: false, url: options.url }; created.push(options.url); return tab; };
  h.api.sessions = {
    getRecentlyClosed: async () => [{ tab: { url: 'https://dup.test/', sessionId: 's1' } }],
    restore: async (id) => { restored.push(id); },
  };
  await h.context.restoreClosed([{ url: 'https://dup.test/', index: 1 }, { url: 'https://dup.test/', index: 2 }, { url: 'https://dup.test/', index: 3 }], 'space-work');
  assert.deepEqual(restored, ['s1']);
  assert.deepEqual(created, ['https://dup.test/', 'https://dup.test/']);
});
