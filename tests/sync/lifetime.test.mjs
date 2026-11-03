import test from 'node:test';
import assert from 'node:assert/strict';
import { installWorkspaceSync } from '../../features/ai/extension/workspace-sync.js';

function event() {
  const listeners = new Set();
  return { addListener(fn) { listeners.add(fn); }, removeListener(fn) { listeners.delete(fn); } };
}

function fixture(t, create) {
  const navigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { locks: { request: async (_name, fn) => fn() } } });
  t.after(() => {
    if (navigator) Object.defineProperty(globalThis, 'navigator', navigator);
    else delete globalThis.navigator;
  });
  let finishRead, markReading, alarmPresent = false;
  const reading = new Promise(resolve => { markReading = resolve; });
  const saved = {}, calls = [];
  const api = {
    storage: { local: {
      async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(saved[key])])); },
      async set(patch) { Object.assign(saved, structuredClone(patch)); },
    }, session: { async set() {} }, onChanged: event() },
    runtime: {},
    alarms: {
      onAlarm: event(),
      async clear() { calls.push('clear'); alarmPresent = false; },
      async create() { if (create) await create(); calls.push('create'); alarmPresent = true; },
    },
    breezerPrivate: {
      readWorkspaceSync(callback) { finishRead = callback; markReading(); },
      exchangeWorkspaceSync(request, callback) { callback({ configured: true, workspaceEnabled: true, providerId: request.providerId, vaultId: request.vaultId, model: request.model }); },
      getAppearance(callback) { callback({}); },
      onSyncStateChanged: event(),
    },
  };
  const installed = installWorkspaceSync(api);
  t.after(() => installed.dispose());
  return { installed, reading, calls, finish: value => finishRead(value), hasAlarm: () => alarmPresent };
}

for (const state of [
  { configured: false },
  { configured: true, workspaceEnabled: false },
  { configured: true, workspaceEnabled: true, providerId: 'fixture-provider', vaultId: 'fixture-vault', model: '' },
]) {
  test(`disposing an in-flight ${JSON.stringify(state)} cycle cannot recreate an alarm`, { timeout: 5000 }, async t => {
    const f = fixture(t);
    await f.reading;
    f.installed.dispose();
    f.finish(state);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(f.hasAlarm(), false);
    assert.equal(f.calls.includes('create'), false);
  });
}

test('disposing while alarm creation is pending clears the late-created alarm', { timeout: 5000 }, async t => {
  let finishCreate, markCreating;
  const creating = new Promise(resolve => { markCreating = resolve; });
  const pending = new Promise(resolve => { finishCreate = resolve; });
  const f = fixture(t, () => { markCreating(); return pending; });
  await f.reading;
  f.finish({ configured: true, workspaceEnabled: false });
  await creating;
  f.installed.dispose();
  finishCreate();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.hasAlarm(), false);
  assert.deepEqual(f.calls, ['clear', 'create', 'clear']);
});
