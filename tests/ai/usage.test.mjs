import test from 'node:test';
import assert from 'node:assert/strict';
import { advanceUsage, installUsage, USAGE_ENABLED, USAGE_STATE, USAGE_ALARM } from '../../features/ai/extension/usage.js';

const base = Date.parse('2026-10-30T10:00:00Z');
const id = 'test-id';
test('sampling counts only consecutive active minutes and excludes sleep gaps', () => {
  let state = advanceUsage(null, base, true, () => id);
  state = advanceUsage(state, base + 60_000, true);
  assert.equal(state.days['2026-10-30'], 60);
  state = advanceUsage(state, base + 120_000, false);
  state = advanceUsage(state, base + 180_000, true);
  assert.equal(state.days['2026-10-30'], 60);
  state = advanceUsage(state, base + 600_000, true);
  assert.equal(state.days['2026-10-30'], 60);
});
test('midnight splits conservatively and monthly identifiers rotate', () => {
  const before = Date.parse('2026-10-30T23:59:40Z');
  let state = advanceUsage(null, before, true, () => id);
  state = advanceUsage(state, before + 60_000, true);
  assert.equal(state.days['2026-10-31'], 40);
  state = advanceUsage(state, Date.parse('2026-11-01T00:00:10Z'), true, () => 'rotated');
  assert.equal(state.id, 'rotated'); assert.deepEqual(state.days, { '2026-11-01': 0 });
});

function fixture({ off = false, focused = true, incognito = false, idle = 'active', send } = {}) {
  const data = off ? { [USAGE_ENABLED]: false } : {};
  const listeners = {}, sent = [], alarms = [];
  let clock = base;
  const api = {
    alarms: { create: async name => alarms.push(name), clear: async () => alarms.splice(0), onAlarm: { addListener: fn => { listeners.alarm = fn; } } },
    idle: { queryState: async () => idle }, windows: { getAll: async () => [{ focused, incognito }] },
    storage: { local: { get: async key => ({ [key]: structuredClone(data[key]) }), set: async values => Object.assign(data, structuredClone(values)), remove: async key => { delete data[key]; } }, onChanged: { addListener: fn => { listeners.change = fn; } } },
  };
  const worker = installUsage(api, { now: () => clock, send: async (...args) => { sent.push(args); return send ? send(...args) : { ok: true }; } });
  return { data, sent, alarms, worker, tick: async (ms = 60_000) => { clock += ms; listeners.alarm({ name: USAGE_ALARM }); await worker.settled(); }, change: async value => { data[USAGE_ENABLED] = value; listeners.change({ [USAGE_ENABLED]: { newValue: value } }, 'local'); await worker.settled(); }, listeners };
}
test('default-on sends only monthly ID and day totals, then batches for 30 minutes', async () => {
  const f = fixture(); await f.worker.settled(); assert.equal(f.sent.length, 1); assert.deepEqual(Object.keys(JSON.parse(f.sent[0][1].body)).sort(), ['days', 'id', 'month']);
  for (let i = 0; i < 29; i++) await f.tick();
  assert.equal(f.sent.length, 1); await f.tick(); assert.equal(f.sent.length, 2);
  assert.equal(JSON.parse(f.sent[1][1].body).days['2026-10-30'], 1800);
});
test('disabled reports nothing, clears local state and alarm, re-enable resets ID', async () => {
  const f = fixture(); await f.worker.settled(); const first = f.data[USAGE_STATE].id;
  await f.change(false); assert.equal(f.data[USAGE_STATE], undefined); assert.deepEqual(f.alarms, []);
  await f.tick(); assert.equal(f.sent.length, 1);
  await f.change(true); assert.equal(f.sent.length, 2); assert.notEqual(f.data[USAGE_STATE].id, first);
  const disabled = fixture({ off: true }); await disabled.worker.settled(); await disabled.tick(); assert.equal(disabled.sent.length, 0);
});
test('private, background, and idle windows never send or count active use', async () => {
  for (const config of [{ incognito: true }, { focused: false }, { idle: 'idle' }, { idle: 'locked' }]) {
    const f = fixture(config); await f.worker.settled(); await f.tick(); assert.equal(f.sent.length, 0); assert.deepEqual(f.data[USAGE_STATE].days, {});
  }
});
test('switching off aborts an in-flight report and never restores its local state', async () => {
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const f = fixture({ send: (_url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener('abort', () => reject(new Error('aborted'))); started();
  }) });
  await ready; await f.change(false); assert.equal(f.data[USAGE_STATE], undefined); await f.tick(); assert.equal(f.sent.length, 1);
});
