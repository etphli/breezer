import test from 'node:test';
import assert from 'node:assert/strict';
import { localStorageChanges } from '../../features/ai/extension/storage-events.js';
import { createContextClient } from '../../features/ai/extension/context-settings.js';
import { CONTEXT_KEY } from '../../features/ai/extension/context-memory.js';
import { STORE_KEY } from '../../features/ai/extension/workspace-store.js';
import { storageBus, event } from './storage-bus.mjs';
import { harness } from './workspace-activation-harness.mjs';

test('missing area-event API fails explicitly; storage-less optional views remain supported', () => {
  assert.equal(localStorageChanges(undefined), null); assert.equal(localStorageChanges({}), null);
  const general = event();
  for (const local of [undefined, {}, { onChanged: {} }]) {
    assert.throws(() => localStorageChanges({ storage: { local, onChanged: general } }), /requires storage.local.onChanged/);
  }
  assert.equal(general.listeners.size, 0, 'an unsupported API must never fall back to the global event');
});

test('area bus separates argument signatures, payloads and removal identity', async () => {
  const bus = storageBus(), storage = bus.context('test'), calls = [];
  const local = (...args) => { calls.push(args); args[0].value.newValue.push('local-mutation'); };
  storage.local.onChanged.addListener(local); storage.onChanged.addListener((...args) => calls.push(args));
  await storage.local.set({ value: ['saved'] }); await bus.flush();
  assert.deepEqual(calls.map(args => args.length), [1, 2]); assert.equal(calls[1][1], 'local');
  assert.deepEqual(calls[1][0].value.newValue, ['saved']);
  storage.local.onChanged.removeListener(local); assert.strictEqual(storage.local.onChanged.removed[0], local);
  await storage.session.set({ value: 'session' }); await bus.flush();
  assert.equal(calls.length, 3); assert.equal(calls[2][1], 'session');
});

test('session writes cannot promote a pending URL frame, while a real local store change does', async () => {
  const bus = storageBus(), storage = bus.context('sidebar');
  const h = await harness(undefined, storage); h.update(3, { url: 'https://example.invalid/queued' });
  const store = structuredClone(h.state.store); store.spaces[0].name = 'Changed elsewhere';
  await storage.session.set({ [STORE_KEY]: store, 'workspace.window.7': { activeSpaceId: 'space-work' }, 'breezer-conversation-7': [] });
  await bus.flush(); assert.deepEqual(Array.from(h.pending().rows), [3]);
  assert.deepEqual(bus.stats(), { dispatches: 0, deliveries: 0, calls: 0 });
  await storage.local.set({ [STORE_KEY]: store }); await bus.flush();
  assert.equal(h.pending().rows, null); h.flushFrames();
  assert.equal(h.state.store.spaces[0].name, 'Changed elsewhere'); assert.equal(h.counters.models, 1);
});

test('context local notifications retain own-key, connected-port and disposal behavior', async () => {
  const bus = storageBus(), storage = bus.context('settings');
  const port = { onMessage: event(), onDisconnect: event(), postMessage() {}, disconnect() { this.onDisconnect.fire(); } };
  const client = createContextClient({ storage, runtime: { connect: () => port } }); let notifications = 0;
  client.onChange(() => notifications++);
  await storage.session.set({ [CONTEXT_KEY]: { enabled: true } }); await bus.flush(); assert.equal(notifications, 0);
  await storage.local.set({ [CONTEXT_KEY]: null }); await bus.flush(); assert.equal(notifications, 1);
  const request = client.request('view'); const rejected = assert.rejects(request, /closed/);
  await storage.local.set({ [CONTEXT_KEY]: { enabled: true } }); await bus.flush(); assert.equal(notifications, 1);
  const callback = [...storage.local.onChanged.listeners][0]; client.dispose(); await rejected;
  assert.equal(storage.local.onChanged.listeners.size, 0); assert.strictEqual(storage.local.onChanged.removed[0], callback);
});
