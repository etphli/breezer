import test from 'node:test';
import assert from 'node:assert/strict';
import * as S from '../../features/ai/extension/workspace-store.js';
import { WorkspaceSync } from '../../features/ai/extension/workspace-sync.js';
import { emptySyncModel, materializeWorkspace, serializeSyncModel } from '../../features/ai/extension/workspace-sync-model.js';
import { harness } from './workspace-activation-harness.mjs';
import { seed } from './workspace-browser-fixture.mjs';

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

test('undone favorite removal respects the favorites limit', () => {
  const store = S.defaultStore();
  for (let i = 0; i < S.MAX_FAVORITES; i++) S.addFavorite(store, { url: `https://f${i}.test/`, title: `F${i}` });
  const snapshot = snapshotOf(store, store.favorites[0].id);
  S.removeNode(store, snapshot.node.id);
  S.addFavorite(store, { url: 'https://new.test/', title: 'New' });
  assert.throws(() => S.restoreRemovedEntry(store, snapshot), /Favorites hold up to 12/);
  assert.equal(store.favorites.length, S.MAX_FAVORITES);
  assert.equal(S.normalizeStore(structuredClone(store)).favorites.length, S.MAX_FAVORITES);
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
  const h = await harness(undefined, undefined, { boot: true });
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

test('undo of Clear Today reopens a tab whose session restore fails', async () => {
  const h = await harness();
  const created = [];
  h.api.tabs.create = async (options) => { created.push(options.url); return { id: 100 + created.length, windowId: 7, index: 20, active: false, pinned: false, url: options.url }; };
  h.api.sessions = {
    getRecentlyClosed: async () => [{ tab: { url: 'https://dup.test/', sessionId: 's1' } }, { tab: { url: 'https://dup.test/', sessionId: 's2' } }],
    restore: async () => { throw new Error('gone'); },
  };
  h.state.expect = [];
  h.context.createTab = async ({ url }) => { created.push(url); };
  await h.context.restoreClosed([{ url: 'https://dup.test/', index: 1 }, { url: 'https://dup.test/', index: 2 }], 'space-work');
  assert.deepEqual(created, ['https://dup.test/', 'https://dup.test/']);
  assert.deepEqual(h.state.expect, [], 'failed restores leave no stale expectation');
});

test('undone removal of one of two same-URL favorites restores it', () => {
  const store = S.defaultStore();
  S.addFavorite(store, { url: 'https://same.test/', title: 'Same', customTitle: 'Work' });
  const home = S.addFavorite(store, { url: 'https://same.test/', title: 'Same', customTitle: 'Home' });
  const snapshot = snapshotOf(store, home.id);
  S.removeNode(store, home.id);
  S.restoreRemovedEntry(store, snapshot);
  assert.deepEqual(store.favorites.map((node) => node.customTitle), ['Work', 'Home']);
});

test('a tab detached before the membership flush hands its saved-entry link to the receiving window', async () => {
  const persisted = structuredClone({ local: seed().local, session: seed().session });
  const sender = await harness(undefined, undefined, { persisted, boot: true });
  const receiver = await harness(undefined, undefined, { persisted, boot: true });
  receiver.state.windowId = 9;
  sender.setRecord(5, { e: 'v-chat' });
  sender.onDetached(5, { oldWindowId: 7 });
  receiver.onAttached(5, { newWindowId: 9 });
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(receiver.state.records[5]?.e, 'v-chat');
});

// Two sidebars over one storage area. Chrome delivers onDetached to the sending
// window and onAttached to the receiving window in either order.
async function twoSidebars() {
  const persisted = structuredClone({ local: seed().local, session: seed().session });
  const sidebars = [];
  // Like Chrome, report only keys whose stored value actually changed.
  const storageSet = ({ area, values, commit }) => {
    const before = JSON.stringify(persisted[area]);
    const previous = JSON.parse(before);
    commit();
    const changes = Object.fromEntries(Object.entries(values)
      .filter(([key]) => JSON.stringify(previous[key]) !== JSON.stringify(persisted[area][key]))
      .map(([key, value]) => [key, { newValue: structuredClone(value) }]));
    if (!Object.keys(changes).length) return Promise.resolve();
    if (area === 'local') for (const sidebar of sidebars) sidebar.emit('storage.local.onChanged', structuredClone(changes), 'local');
    return Promise.resolve();
  };
  const sender = await harness(undefined, undefined, { persisted, boot: true, storageSet });
  const receiver = await harness(undefined, undefined, { persisted, boot: true, storageSet });
  receiver.state.windowId = 9;
  receiver.state.activeSpaceId = 'space-personal';
  sidebars.push(sender, receiver);
  for (const sidebar of sidebars) sidebar.bindSidebar();
  const run = async () => {
    for (let i = 0; i < 10; i++) await settle();
    for (const sidebar of sidebars) await sidebar.timers(150);
    for (let i = 0; i < 10; i++) await settle();
  };
  return { persisted, sender, receiver, run, stored: (id) => persisted.local[S.MEMBERS_KEY].tabs[id] };
}

for (const order of ['attach-before-detach', 'attach-and-save-before-detach', 'detach-before-attach']) {
  test(`a dragged favorite keeps its saved-entry link when Chrome delivers ${order}`, async () => {
    const { sender, receiver, run, stored } = await twoSidebars();
    sender.setRecord(5, { e: 'v-chat' });
    if (order !== 'detach-before-attach') {
      receiver.onAttached(5, { newWindowId: 9 });
      for (let i = 0; i < 10; i++) await settle();
      if (order === 'attach-and-save-before-detach') await receiver.timers(150);
      sender.onDetached(5, { oldWindowId: 7 });
    } else {
      sender.onDetached(5, { oldWindowId: 7 });
      receiver.onAttached(5, { newWindowId: 9 });
    }
    await run();
    assert.equal(receiver.state.records[5]?.e, 'v-chat', 'the receiving window shows the saved row');
    assert.equal(stored(5)?.e, 'v-chat', 'storage keeps the link');
    assert.equal(stored(5)?.s, 'space-personal', 'the sender does not move the tab back to its space');
    assert.equal(sender.state.records[5], undefined);
  });
}

test('an explicit unlink still removes the stored saved-entry link', async () => {
  const { sender, run, stored } = await twoSidebars();
  assert.equal(stored(8)?.e, 'v-cal');
  sender.setRecord(8, { e: '' });
  sender.setRecord(8, {});
  await run();
  assert.equal(stored(8)?.e, undefined);
  assert.equal(sender.state.records[8]?.e, undefined);
});

test('membership writes merge saved-entry links instead of clobbering them', async () => {
  const saved = structuredClone(seed().local);
  const area = (values) => ({ get: async (keys) => Object.fromEntries([keys].flat().filter((key) => key in values).map((key) => [key, structuredClone(values[key])])), set: async (patch) => Object.assign(values, structuredClone(patch)) });
  const workspace = new S.WorkspaceStore({ storage: { local: area(saved), session: area({ [S.SESSION_KEY]: 'S1' }) }, locks: { request: async (_name, fn) => fn() } });
  const tabs = () => saved[S.MEMBERS_KEY].tabs;
  // The receiver's link-less write lands after the sender's handoff.
  await workspace.patchMembers({ 5: { s: 'space-work', u: 'https://mail.example.com/inbox', e: 'v-chat' } }, [], [5]);
  await workspace.patchMembers({ 5: { s: 'space-personal', u: 'https://mail.example.com/inbox' } });
  assert.deepEqual([tabs()[5].s, tabs()[5].e], ['space-personal', 'v-chat']);
  // The sender's handoff lands after the receiver's claim: only the link changes.
  await workspace.patchMembers({ 4: { s: 'space-personal', u: 'https://x.test/' } });
  await workspace.patchMembers({ 4: { s: 'space-work', u: 'https://old.test/', e: 'v-notes' } }, [], [4]);
  assert.deepEqual([tabs()[4].s, tabs()[4].u, tabs()[4].e], ['space-personal', 'https://x.test/', 'v-notes']);
  // An explicit unlink still removes the link.
  await workspace.patchMembers({ 5: { s: 'space-personal', u: 'https://mail.example.com/inbox', e: '' } });
  assert.equal('e' in tabs()[5], false);
});

for (const [change, link] of [['unlink', undefined], ['replacement link', 'v-chat']]) {
  test(`a pending ${change} wins over the stale stored link when attach arrives first`, async () => {
    const { sender, receiver, run, stored } = await twoSidebars();
    assert.equal(stored(8)?.e, 'v-cal');
    // A real sidebar loads only its own window's tabs (tabs.query by windowId).
    delete receiver.state.records[8]; receiver.state.tabs.delete(8);
    sender.setRecord(8, { e: link || '' });
    receiver.onAttached(8, { newWindowId: 9 });
    for (let i = 0; i < 10; i++) await settle();
    sender.onDetached(8, { oldWindowId: 7 });
    await run();
    // A later unrelated receiver write must not restore the stale link either.
    receiver.setRecord(8, {});
    await run();
    assert.equal(stored(8)?.e, link, 'storage has the sender\'s latest link');
    assert.equal(receiver.state.records[8]?.e, link, 'the receiving window shows the latest link');
  });
}

for (const [change, link] of [['unlink', undefined], ['replacement link', 'v-chat']]) {
  test(`a ${change} reported while the attached tab loads beats the earlier stored read`, async () => {
    const { sender, receiver, run, stored } = await twoSidebars();
    delete receiver.state.records[8]; receiver.state.tabs.delete(8);
    // Same space as the sender, so the receiver's own write changes nothing in storage.
    receiver.state.activeSpaceId = 'space-work';
    sender.setRecord(8, { e: link || '' });
    receiver.holdGet();
    receiver.onAttached(8, { newWindowId: 9 });
    for (let i = 0; i < 10; i++) await settle();
    // The membership read resolved with the stale link; the handoff lands before tabs.get.
    sender.onDetached(8, { oldWindowId: 7 });
    for (let i = 0; i < 10; i++) await settle();
    receiver.releaseGet();
    await run();
    assert.equal(stored(8)?.e, link);
    assert.equal(receiver.state.records[8]?.e, link);
  });

  test(`an adopted ${change} redraws the receiving sidebar`, async () => {
    const { sender, receiver, run } = await twoSidebars();
    delete receiver.state.records[8]; receiver.state.tabs.delete(8);
    receiver.onAttached(8, { newWindowId: 9 });
    await run();
    receiver.flushFrames();
    assert.equal(receiver.state.records[8]?.e, 'v-cal');
    const drawn = receiver.counters.drawn;
    sender.setRecord(8, { e: link || '' });
    sender.onDetached(8, { oldWindowId: 7 });
    await run();
    receiver.flushFrames();
    assert.equal(receiver.state.records[8]?.e, link);
    assert.ok(receiver.counters.drawn > drawn, 'the sidebar redraws after adopting the link');
  });
}
