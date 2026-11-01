import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkspaceSync, SYNC_LOCAL_KEY } from '../../features/ai/extension/workspace-sync.js';
import { defaultStore, DEFAULT_APPEARANCE, STORE_KEY, MEMBERS_KEY, addSpace, addEntry, renameSpace, removeNode } from '../../features/ai/extension/workspace-store.js';
import { emptySyncModel, serializeSyncModel } from '../../features/ai/extension/workspace-sync-model.js';

function fixture(server, id, initial = defaultStore()) {
  const saved = { [STORE_KEY]: structuredClone(initial), [MEMBERS_KEY]: { tabs: { 3: { s: 'space-default', k: 'device-session', u: 'https://private.test/local' } } } };
  const storage = {
    local: { get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in saved).map(key => [key, structuredClone(saved[key])])), set: async patch => Object.assign(saved, structuredClone(patch)) },
    session: { set: async () => {} },
  };
  let appearance = { ...DEFAULT_APPEARANCE };
  const bridge = {
    read: async () => structuredClone(server.state),
    exchange: async request => {
      server.calls += 1;
      if (server.fail) throw new Error('Provider offline.');
      if (server.state.providerId === request.providerId && server.state.vaultId === request.vaultId && server.state.model === request.expectedModel) server.state.model = request.model;
      return structuredClone(server.state);
    },
    getAppearance: async () => appearance,
    setAppearance: async patch => (appearance = { ...appearance, ...patch }),
  };
  const locks = { request: async (_name, fn) => fn() };
  const instance = () => new WorkspaceSync({ storage, bridge, locks, makeClientId: () => id });
  return { saved, storage, bridge, instance, appearance: () => appearance };
}
const server = () => ({ state: { configured: true, workspaceEnabled: true, providerId: 'disposable-provider', vaultId: 'disposable-vault', model: serializeSyncModel(emptySyncModel()) }, calls: 0, fail: false });
const cycle = async client => assert.equal((await client.instance().cycle()).phase, 'reconciled');

test('workspace worker reconciles through a native-API fixture, including restart, duplicate URLs and local membership', async () => {
  const remote = server();
  const a = fixture(remote, 'client_alpha');
  const b = fixture(remote, 'client_beta1');
  await cycle(a); await cycle(b);
  const members = structuredClone(b.saved[MEMBERS_KEY]);
  const second = addSpace(a.saved[STORE_KEY], { name: 'Projects' });
  const first = addEntry(a.saved[STORE_KEY], 'space-default', { url: 'https://example.test/same', title: 'One' });
  addEntry(a.saved[STORE_KEY], second.id, { url: first.url, title: 'Two' });
  await cycle(a); await cycle(b);
  assert.equal(b.saved[STORE_KEY].spaces[1].name, 'Projects');
  assert.notEqual(b.saved[STORE_KEY].spaces[0].pinned[0].id, b.saved[STORE_KEY].spaces[1].pinned[0].id);
  assert.deepEqual(b.saved[MEMBERS_KEY], members);
  const stable = remote.calls;
  await cycle(a); await cycle(b); await cycle(a);
  assert.equal(remote.calls, stable, 'unchanged clients must not republish metadata');
  const nativeModel = JSON.parse(remote.state.model);
  assert.doesNotMatch(JSON.stringify(nativeModel), /device-session|private.test|workspace.members/);
});

test('offline changes survive capture, worker restart and remote deletion', async () => {
  const remote = server();
  const a = fixture(remote, 'client_alpha'), b = fixture(remote, 'client_beta1');
  const entry = addEntry(a.saved[STORE_KEY], 'space-default', { url: 'https://example.test/page', title: 'Saved' });
  await cycle(a); await cycle(b);
  remote.fail = true;
  renameSpace(b.saved[STORE_KEY], 'space-default', 'Offline work');
  assert.equal((await b.instance().cycle()).phase, 'error');
  const captured = structuredClone(b.saved[SYNC_LOCAL_KEY]);
  assert.equal(captured.baseline['space/space-default'].name, 'Offline work');
  remote.fail = false;
  removeNode(a.saved[STORE_KEY], entry.id);
  await cycle(a);
  await cycle(b); await cycle(a);
  assert.equal(a.saved[STORE_KEY].spaces[0].name, 'Offline work');
  assert.equal(b.saved[STORE_KEY].spaces[0].pinned.length, 0);
  assert.deepEqual(a.saved[SYNC_LOCAL_KEY].model, b.saved[SYNC_LOCAL_KEY].model);
});

test('untouched joining profile defaults do not overwrite remote space names or appearance', async () => {
  const remote = server();
  const a = fixture(remote, 'client_alpha');
  renameSpace(a.saved[STORE_KEY], 'space-default', 'Research');
  await a.bridge.setAppearance({ theme: 'rose' });
  await cycle(a);
  const b = fixture(remote, 'client_beta1');
  await cycle(b);
  assert.equal(b.saved[STORE_KEY].spaces[0].name, 'Research');
  assert.equal(b.appearance().theme, 'rose');
});

test('disabled and disconnected clients never write or apply remote data', async () => {
  const remote = server(); const a = fixture(remote, 'client_alpha');
  const original = structuredClone(a.saved);
  remote.state.configured = false;
  assert.deepEqual(await a.instance().cycle(), { phase: 'disabled' });
  assert.equal(remote.calls, 0);
  assert.deepEqual(a.saved[STORE_KEY], original[STORE_KEY]);
  assert.equal(a.saved[SYNC_LOCAL_KEY], undefined);
  remote.state.configured = true; remote.state.workspaceEnabled = false;
  assert.deepEqual(await a.instance().cycle(), { phase: 'workspaceOff' });
  assert.equal(remote.calls, 0);
});

test('invalid remote data preserves local store and membership', async () => {
  const remote = server(); const a = fixture(remote, 'client_alpha');
  const original = structuredClone(a.saved);
  remote.state.model = '{invalid';
  assert.equal((await a.instance().cycle()).phase, 'error');
  assert.deepEqual(a.saved[STORE_KEY], original[STORE_KEY]);
  assert.deepEqual(a.saved[MEMBERS_KEY], original[MEMBERS_KEY]);
});

test('CAS conflicts retry with remote edits without dropping captured local edits', async () => {
  const remote = server(); const a = fixture(remote, 'client_alpha'), b = fixture(remote, 'client_beta1');
  await cycle(a); await cycle(b);
  addSpace(a.saved[STORE_KEY], { name: 'Alpha' });
  addSpace(b.saved[STORE_KEY], { name: 'Beta' });
  const exchange = a.bridge.exchange;
  let race = true;
  a.bridge.exchange = async request => {
    if (race) { race = false; await cycle(b); }
    return exchange(request);
  };
  await cycle(a); await cycle(b);
  assert.deepEqual(a.saved[STORE_KEY].spaces.map(s => s.name).sort(), ['Alpha', 'Beta', 'Personal']);
  assert.deepEqual(b.saved[STORE_KEY].spaces.map(s => s.name).sort(), ['Alpha', 'Beta', 'Personal']);
});

test('local capture failure never publishes a partial snapshot or replaces saved data', async () => {
  const remote = server(); const a = fixture(remote, 'client_alpha');
  const original = structuredClone(a.saved[STORE_KEY]);
  a.storage.local.set = async () => { throw new Error('Local storage quota exceeded.'); };
  assert.equal((await a.instance().cycle()).phase, 'error');
  assert.equal(remote.calls, 0);
  assert.deepEqual(a.saved[STORE_KEY], original);
});

test('explicit overflow recovery keeps pins when removing a concurrent space', async () => {
  const remote = server(); const initial = defaultStore();
  for (let index = 0; index < 7; index += 1) addSpace(initial, { name: `Initial ${index}` });
  const a = fixture(remote, 'client_alpha', initial), b = fixture(remote, 'client_beta1', initial);
  await cycle(a); await cycle(b);
  addSpace(a.saved[STORE_KEY], { name: 'Alpha' });
  const overflow = addSpace(b.saved[STORE_KEY], { name: 'Beta' });
  const pin = addEntry(b.saved[STORE_KEY], overflow.id, { url: 'https://example.test/recovered', title: 'Keep me' });
  await cycle(b);
  assert.equal((await a.instance().cycle()).phase, 'error');
  assert.equal(a.saved[STORE_KEY].spaces.length, 9);
  assert.equal((await a.instance().repair({ removeSpace: overflow.id })).phase, 'reconciled');
  await cycle(b);
  assert.equal(a.saved[STORE_KEY].spaces.length, 9);
  assert.equal(a.saved[STORE_KEY].spaces.some(space => space.id === overflow.id), false);
  assert.equal(a.saved[STORE_KEY].spaces[0].pinned.some(entry => entry.id === pin.id), true);
  assert.deepEqual(a.saved[STORE_KEY].spaces, b.saved[STORE_KEY].spaces);
});

test('changing providers with the same vault UUID cannot receive an old in-flight write', async () => {
  const remote = server(); const a = fixture(remote, 'client_alpha');
  await cycle(a);
  renameSpace(a.saved[STORE_KEY], 'space-default', 'Pending alpha edit');
  const prior = remote.state.model;
  const exchange = a.bridge.exchange;
  a.bridge.exchange = async request => {
    remote.state.providerId = 'another-provider';
    return exchange(request);
  };
  const result = await a.instance().cycle();
  assert.equal(result.phase, 'error');
  assert.match(result.message, /changed vaults/);
  assert.equal(remote.state.model, prior);
  assert.equal(a.saved[SYNC_LOCAL_KEY].providerId, 'disposable-provider');
  assert.equal(a.saved[STORE_KEY].spaces[0].name, 'Pending alpha edit');
});

test('managed appearance changes do not block valid saved spaces or overwrite the local appearance', async () => {
  const remote = server(); const a = fixture(remote, 'client_alpha'), b = fixture(remote, 'client_beta1');
  await cycle(a); await cycle(b);
  addSpace(a.saved[STORE_KEY], { name: 'Policy-safe data' });
  await a.bridge.setAppearance({ theme: 'rose' });
  await cycle(a);
  b.bridge.setAppearance = async () => { throw new Error('Appearance is controlled by policy.'); };
  const result = await b.instance().cycle();
  assert.equal(result.phase, 'appearanceBlocked');
  assert.match(result.message, /controlled by policy/);
  assert.equal(b.saved[STORE_KEY].spaces[1].name, 'Policy-safe data');
  assert.equal(b.appearance().theme, 'mint');
});
