import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { WorkspaceSync, SYNC_LOCAL_KEY, installWorkspaceSync } from '../../features/ai/extension/workspace-sync.js';
import { defaultStore, normalizeStore, DEFAULT_APPEARANCE, STORE_KEY, APPEARANCE_REV_KEY, addSpace, addEntry, removeSpace, renameSpace } from '../../features/ai/extension/workspace-store.js';
import { emptySyncModel, projectWorkspace, recordWorkspaceChanges, mergeSyncModels, serializeSyncModel } from '../../features/ai/extension/workspace-sync-model.js';

const root = new URL('../../', import.meta.url);

// Each client owns its own copy of the synced preference, as Chrome pref sync does.
function client(id, pref, { ready = () => true } = {}) {
  const saved = { [STORE_KEY]: defaultStore() };
  const storage = { local: {
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(key => key in saved).map(key => [key, structuredClone(saved[key])])),
    set: async patch => Object.assign(saved, structuredClone(patch)),
  } };
  const c = { saved, pref, appearance: { ...DEFAULT_APPEARANCE }, onExchange: null, exchanges: 0 };
  const state = () => ({ configured: true, workspaceEnabled: true, workspaceReady: ready(), providerId: 'p', vaultId: 'v', model: ready() ? pref.value : '' });
  c.bridge = {
    read: async () => state(),
    exchange: async request => {
      c.exchanges += 1;
      c.onExchange?.();
      if (ready() && pref.value === request.expectedModel) pref.value = request.model;
      return state();
    },
    getAppearance: async () => c.appearance,
    setAppearance: async patch => (c.appearance = { ...c.appearance, ...patch }),
  };
  c.sync = new WorkspaceSync({ storage, bridge: c.bridge, locks: { request: async (_name, fn) => fn() }, makeClientId: () => id });
  c.cycle = async () => (await c.sync.cycle()).phase;
  return c;
}

for (const [alpha, beta] of [['client_zzzz', 'client_aaab'], ['client_aaaa', 'client_zzzz']]) {
  test(`joining profile waits for the vault download and never overwrites customisations (${alpha} vs ${beta})`, async () => {
    const alphaPref = { value: '' };
    const a = client(alpha, alphaPref);
    renameSpace(a.saved[STORE_KEY], 'space-default', 'Research');
    a.appearance.theme = 'rose';
    assert.equal(await a.cycle(), 'reconciled');
    let downloaded = false;
    const betaPref = { value: '' };
    const b = client(beta, betaPref, { ready: () => downloaded });
    assert.equal(await b.cycle(), 'downloading');
    assert.equal(b.saved[SYNC_LOCAL_KEY], undefined, 'no joining state before the vault has downloaded');
    assert.equal(b.exchanges, 0, 'nothing is published before the vault has downloaded');
    betaPref.value = alphaPref.value; downloaded = true;
    assert.equal(await b.cycle(), 'reconciled');
    assert.equal(b.saved[STORE_KEY].spaces[0].name, 'Research');
    assert.equal(b.appearance.theme, 'rose');
    alphaPref.value = betaPref.value;
    assert.equal(await a.cycle(), 'reconciled');
    assert.equal(a.saved[STORE_KEY].spaces[0].name, 'Research');
    assert.equal(a.appearance.theme, 'rose');
  });

  test(`untouched defaults never beat remote values even if a join reads an empty vault (${alpha} vs ${beta})`, async () => {
    const alphaPref = { value: '' };
    const a = client(alpha, alphaPref);
    renameSpace(a.saved[STORE_KEY], 'space-default', 'Research');
    a.appearance.theme = 'rose';
    assert.equal(await a.cycle(), 'reconciled');
    const betaPref = { value: '' };
    const b = client(beta, betaPref); // A native layer that reports ready too early.
    assert.equal(await b.cycle(), 'reconciled');
    betaPref.value = mergeModelsText(betaPref.value, alphaPref.value);
    assert.equal(await b.cycle(), 'reconciled');
    assert.equal(b.saved[STORE_KEY].spaces[0].name, 'Research');
    assert.equal(b.appearance.theme, 'rose');
    alphaPref.value = betaPref.value;
    assert.equal(await a.cycle(), 'reconciled');
    assert.equal(a.saved[STORE_KEY].spaces[0].name, 'Research');
    assert.equal(a.appearance.theme, 'rose');
  });
}

function mergeModelsText(left, right) {
  return serializeSyncModel(mergeSyncModels(JSON.parse(left), JSON.parse(right)));
}

test('native readiness requires Preferences to be active with no pending initial download', () => {
  const source = readFileSync(new URL('features/workspace/native/chrome/browser/extensions/api/breezer_private/workspace_sync_api.cc', root), 'utf8');
  assert.match(source, /GetActiveDataTypes\(\)\.Has\(syncer::PREFERENCES\)/);
  assert.match(source, /!service->GetTypesWithPendingDownloadForInitialSync\(\)\.Has\(syncer::PREFERENCES\)/);
  assert.match(source, /\.Set\("workspaceReady", ready\)/);
  assert.match(source, /\.Set\("model", ready \?/);
  assert.match(source, /state\.FindBool\("workspaceReady"\)\.value_or\(false\)/);
  const idl = readFileSync(new URL('features/workspace/native/chrome/common/extensions/api/breezer_private.idl', root), 'utf8');
  assert.match(idl, /boolean workspaceReady;/);
});

test('a title truncated inside an emoji stays well-formed and existing lone surrogates heal on projection', () => {
  const store = defaultStore();
  addEntry(store, 'space-default', { url: 'https://example.test/v', title: `${'a'.repeat(199)}\u{1F600} more` });
  const title = normalizeStore(store).spaces[0].pinned[0].title;
  assert.ok(title.isWellFormed(), 'normalized title is well-formed');
  assert.ok(title.length <= 200);
  const model = recordWorkspaceChanges(emptySyncModel(), {}, projectWorkspace(store), 'client_alpha');
  assert.doesNotMatch(serializeSyncModel(model), /\\ud83d/i);
  // A value stored by an earlier build bypasses text(); projection still heals it.
  const raw = defaultStore();
  raw.spaces[0].name = 'Work\ud83d';
  raw.spaces[0].pinned.push({ kind: 'entry', id: 'e1', url: 'https://example.test/\udc00', title: 'T\ud83d', customTitle: 'C\ud83d' });
  raw.spaces[0].pinned.push({ kind: 'folder', id: 'f1', name: 'F\ud83d', open: true, children: [] });
  const projected = projectWorkspace(raw);
  for (const value of Object.values(projected)) for (const field of Object.values(value)) {
    if (typeof field === 'string') assert.ok(field.isWellFormed(), `${JSON.stringify(field)} is well-formed`);
  }
  assert.doesNotThrow(() => JSON.parse(serializeSyncModel(recordWorkspaceChanges(emptySyncModel(), {}, projected, 'client_alpha'))));
});

test('a policy-blocked appearance change does not wake the worker in a loop', async () => {
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_n, fn) => fn() } } });
  let pref = serializeSyncModel(recordWorkspaceChanges(emptySyncModel(), {}, { 'appearance/theme': { appearance: 'rose' } }, 'client_other'));
  const saved = { [STORE_KEY]: defaultStore() };
  const listeners = new Set();
  let reads = 0;
  const api = {
    storage: { local: { onChanged: { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f) },
      get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter(k => k in saved).map(k => [k, structuredClone(saved[k])])),
      set: async patch => { const changes = {}; for (const [k, v] of Object.entries(patch)) { changes[k] = { newValue: v }; saved[k] = structuredClone(v); } setTimeout(() => { for (const f of listeners) f(changes); }, 5); } } },
    runtime: {},
    alarms: { onAlarm: { addListener() {}, removeListener() {} }, create: async () => {}, clear: async () => {} },
    breezerPrivate: {
      readWorkspaceSync(cb) { reads += 1; cb({ configured: true, workspaceEnabled: true, workspaceReady: true, providerId: 'p'.repeat(32), vaultId: 'v'.repeat(36), model: pref }); },
      exchangeWorkspaceSync(r, cb) { if (r.expectedModel === pref) pref = r.model; cb({ configured: true, workspaceEnabled: true, workspaceReady: true, providerId: r.providerId, vaultId: r.vaultId, model: pref }); },
      getAppearance(cb) { setTimeout(() => cb({ ...DEFAULT_APPEARANCE }), 1); },
      setAppearance(_p, cb) { api.runtime.lastError = { message: 'Appearance is controlled by policy.' }; cb(undefined); api.runtime.lastError = undefined; },
      onSyncStateChanged: { addListener() {}, removeListener() {} },
    },
  };
  const handle = installWorkspaceSync(api);
  await new Promise(resolve => setTimeout(resolve, 2000));
  handle.dispose();
  assert.equal(saved['workspace.sync.state.v1']?.phase, 'appearanceBlocked');
  assert.equal(saved[APPEARANCE_REV_KEY], undefined, 'a failed appearance change is not announced');
  assert.ok(reads <= 2, `expected the worker to settle, saw ${reads} cycles`);
});

test('an appearance change made during a cycle is not reverted by the next cycle', async () => {
  const pref = { value: '' };
  const a = client('client_alpha', pref), b = client('client_beta1', pref);
  assert.equal(await a.cycle(), 'reconciled'); assert.equal(await b.cycle(), 'reconciled');
  a.appearance.theme = 'rose';
  assert.equal(await a.cycle(), 'reconciled');
  b.onExchange = () => { b.appearance.sidebarWidth = 333; b.onExchange = null; };
  b.saved[STORE_KEY].spaces[0].name = 'force exchange';
  assert.equal(await b.cycle(), 'reconciled');
  assert.equal(b.appearance.theme, 'rose');
  await b.cycle(); await b.cycle(); await a.cycle();
  assert.equal(b.appearance.sidebarWidth, 333, 'the local change stays');
  assert.equal(a.appearance.sidebarWidth, 333, 'the local change reaches other devices');
});

test('a restored profile with a reused client id converges instead of reporting a clock conflict', async () => {
  const pref = { value: '' };
  const live = client('client_alpha', pref);
  assert.equal(await live.cycle(), 'reconciled');
  const restored = client('client_alpha', pref);
  Object.assign(restored.saved, structuredClone(live.saved));
  renameSpace(live.saved[STORE_KEY], 'space-default', 'Edited after backup');
  assert.equal(await live.cycle(), 'reconciled');
  renameSpace(restored.saved[STORE_KEY], 'space-default', 'Edited on restored');
  assert.equal(await restored.cycle(), 'reconciled');
  assert.equal(await restored.cycle(), 'reconciled');
  assert.equal(await live.cycle(), 'reconciled');
  assert.equal(live.saved[STORE_KEY].spaces[0].name, restored.saved[STORE_KEY].spaces[0].name);
});

test('equal-clock merges pick the same value in either order', () => {
  const left = { version: 1, records: { 'space/s1': { alive: [1, 'client_alpha', true], name: [5, 'client_alpha', 'One'], tone: [1, 'client_alpha', 'mint'], index: [1, 'client_alpha', 0] } } };
  const right = structuredClone(left);
  right.records['space/s1'].name = [5, 'client_alpha', 'Two'];
  assert.equal(serializeSyncModel(mergeSyncModels(left, right)), serializeSyncModel(mergeSyncModels(right, left)));
});

test('joining a non-empty vault does not resurrect a deleted untouched default space', async () => {
  const pref = { value: '' };
  const a = client('client_alpha', pref);
  addSpace(a.saved[STORE_KEY], { name: 'Work' });
  removeSpace(a.saved[STORE_KEY], 'space-default');
  assert.equal(await a.cycle(), 'reconciled');
  const b = client('client_beta1', pref);
  assert.equal(await b.cycle(), 'reconciled');
  assert.deepEqual(b.saved[STORE_KEY].spaces.map(space => space.name), ['Work']);
  assert.doesNotMatch(pref.value, /space\/space-default/);
  assert.equal(await a.cycle(), 'reconciled');
  assert.deepEqual(a.saved[STORE_KEY].spaces.map(space => space.name), ['Work']);
});

test('a failed join exchange does not later publish the skipped default space', async () => {
  const pref = { value: '' };
  const a = client('client_alpha', pref);
  addSpace(a.saved[STORE_KEY], { name: 'Work' });
  removeSpace(a.saved[STORE_KEY], 'space-default');
  assert.equal(await a.cycle(), 'reconciled');
  const b = client('client_beta1', pref);
  addSpace(b.saved[STORE_KEY], { name: 'Home' }); // Forces the join to publish.
  const exchange = b.bridge.exchange;
  b.bridge.exchange = async () => { throw new Error('Provider offline.'); };
  assert.equal(await b.cycle(), 'error');
  b.bridge.exchange = exchange;
  assert.equal(await b.cycle(), 'reconciled');
  assert.deepEqual(b.saved[STORE_KEY].spaces.map(space => space.name).sort(), ['Home', 'Work']);
  assert.match(pref.value, /"Home"/);
  assert.doesNotMatch(pref.value, /space\/space-default/);
});

test('a joining default space that holds local pins is a real edit and is kept', async () => {
  const pref = { value: '' };
  const a = client('client_alpha', pref);
  addSpace(a.saved[STORE_KEY], { name: 'Work' });
  removeSpace(a.saved[STORE_KEY], 'space-default');
  assert.equal(await a.cycle(), 'reconciled');
  const b = client('client_beta1', pref);
  addEntry(b.saved[STORE_KEY], 'space-default', { url: 'https://example.test/kept', title: 'Kept' });
  assert.equal(await b.cycle(), 'reconciled');
  assert.deepEqual(b.saved[STORE_KEY].spaces.map(space => space.name).sort(), ['Personal', 'Work']);
  assert.equal(await a.cycle(), 'reconciled');
  assert.deepEqual(a.saved[STORE_KEY].spaces.map(space => space.name).sort(), ['Personal', 'Work']);
});

test('an appearance field changed during a cycle keeps the local value even when sync was applying that field', async () => {
  const pref = { value: '' };
  const a = client('client_alpha', pref), b = client('client_beta1', pref);
  assert.equal(await a.cycle(), 'reconciled'); assert.equal(await b.cycle(), 'reconciled');
  a.appearance.theme = 'rose';
  assert.equal(await a.cycle(), 'reconciled');
  b.onExchange = () => { b.appearance.theme = 'dusk'; b.onExchange = null; };
  b.saved[STORE_KEY].spaces[0].name = 'force exchange';
  assert.equal(await b.cycle(), 'reconciled');
  assert.equal(b.appearance.theme, 'dusk', 'sync does not overwrite the change made during the cycle');
  await b.cycle(); await a.cycle();
  assert.equal(b.appearance.theme, 'dusk');
  assert.equal(a.appearance.theme, 'dusk', 'the local change reaches other devices');
});

test('a lone surrogate kept on a deleted record in local recovery data is healed before publishing', async () => {
  const pref = { value: '' };
  const a = client('client_alpha', pref);
  assert.equal(await a.cycle(), 'reconciled');
  const local = a.saved[SYNC_LOCAL_KEY];
  local.model.records['entry/old-pin'] = { alive: [40, 'client_alpha', false], title: [39, 'client_alpha', 'cut \ud83d'] };
  a.saved[STORE_KEY].spaces[0].name = 'force exchange';
  assert.equal(await a.cycle(), 'reconciled');
  assert.ok(pref.value.includes('entry/old-pin'));
  assert.ok(!/\\ud8[0-9a-f]{2}/i.test(pref.value), 'no lone surrogate reaches the native JSON parser');
});
