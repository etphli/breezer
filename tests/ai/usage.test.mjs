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

function fixture({ off = false, focused = true, incognito = false, idle = 'active', send, initialState, start = base } = {}) {
  const data = off ? { [USAGE_ENABLED]: false } : {};
  if (initialState) data[USAGE_STATE] = structuredClone(initialState);
  const listeners = {}, sent = [], alarms = [], writes = [];
  let clock = start;
  const api = {
    alarms: { create: async name => alarms.push(name), clear: async () => alarms.splice(0), onAlarm: { addListener: fn => { listeners.alarm = fn; } } },
    idle: { queryState: async () => idle }, windows: { getAll: async () => [{ focused, incognito }] },
    storage: { local: { onChanged: { addListener: fn => { listeners.change = fn; } }, get: async key => ({ [key]: structuredClone(data[key]) }), set: async values => { writes.push(structuredClone(values)); Object.assign(data, structuredClone(values)); }, remove: async key => { delete data[key]; } }, onChanged: { addListener: fn => { listeners.change = fn; } } },
  };
  const worker = installUsage(api, { now: () => clock, send: async (...args) => { sent.push(args); return send ? send(...args) : { ok: true }; } });
  return { data, sent, alarms, writes, api, worker, activity: values => { ({ focused = focused, incognito = incognito, idle = idle } = values); }, tick: async (ms = 60_000) => { clock += ms; listeners.alarm({ name: USAGE_ALARM }); await worker.settled(); }, change: async value => { data[USAGE_ENABLED] = value; listeners.change({ [USAGE_ENABLED]: { newValue: value } }); await worker.settled(); }, listeners };
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

for (const [name, config] of Object.entries({ idle: { idle: 'idle' }, locked: { idle: 'locked' }, unfocused: { focused: false }, incognito: { incognito: true } })) {
  test(`${name} samples initialize once and skip subsequent inactive writes`, async () => {
    const f = fixture(config);
    await f.worker.settled();
    assert.equal(f.writes.length, 1);
    const initial = structuredClone(f.data[USAGE_STATE]);
    for (let i = 0; i < 5; i++) await f.tick();
    assert.equal(f.writes.length, 1);
    assert.deepEqual(f.data[USAGE_STATE], initial);
    assert.equal(f.sent.length, 0);
    assert.deepEqual(f.alarms, [USAGE_ALARM]);
  });
}

test('persisted inactive state skips writes even after a worker restart', async () => {
  const initialState = advanceUsage(null, base, false, () => id);
  const f = fixture({ idle: 'idle', initialState, start: base + 60_000 });
  await f.worker.settled();
  await f.tick();
  assert.equal(f.writes.length, 0);
  assert.deepEqual(f.data[USAGE_STATE], initialState);
});

test('inactive transition persists once and reactivation never counts stale time', async () => {
  const f = fixture();
  await f.worker.settled();
  await f.tick();
  assert.equal(f.data[USAGE_STATE].days['2026-10-30'], 60);
  const writes = f.writes.length;
  f.activity({ idle: 'locked' });
  await f.tick();
  assert.equal(f.writes.length, writes + 1);
  assert.equal(f.data[USAGE_STATE].active, false);
  assert.equal(f.data[USAGE_STATE].sampledAt, base + 120_000);
  await f.tick(60 * 60_000);
  await f.tick();
  assert.equal(f.writes.length, writes + 1);
  f.activity({ idle: 'active' });
  await f.tick();
  assert.equal(f.data[USAGE_STATE].days['2026-10-30'], 60);
  assert.equal(f.data[USAGE_STATE].active, true);
  await f.tick();
  assert.equal(f.data[USAGE_STATE].days['2026-10-30'], 120);
  assert.equal(f.sent.length, 2);
});

test('inactive midnight skips writes but a new month writes and rotates identity', async () => {
  const f = fixture({ idle: 'idle', start: Date.parse('2026-10-30T23:59:40Z') });
  await f.worker.settled();
  const oldId = f.data[USAGE_STATE].id;
  await f.tick();
  assert.equal(f.writes.length, 1);
  await f.tick(24 * 60 * 60_000);
  assert.equal(f.writes.length, 2);
  assert.equal(f.data[USAGE_STATE].month, '2026-11');
  assert.notEqual(f.data[USAGE_STATE].id, oldId);
  assert.deepEqual(f.data[USAGE_STATE].days, {});
  assert.equal(f.data[USAGE_STATE].active, false);
  await f.tick();
  assert.equal(f.writes.length, 2);
  assert.equal(f.sent.length, 0);
});

test('mixed trace matches baseline accounting and active ticks always persist', async () => {
  const start = Date.parse('2026-10-30T23:58:40Z');
  let baseline = advanceUsage(null, start, true, () => id);
  const f = fixture({ start, initialState: baseline, send: async () => ({ ok: false }) });
  await f.worker.settled();
  let clock = start;
  let expectedWrites = 1;
  for (const [ms, activity, active] of [
    [60_000, {}, true], [60_000, {}, true],
    [10_000, { idle: 'idle' }, false], [10_000, {}, false],
    [10_000, { idle: 'active' }, true], [60_000, {}, true],
    [60_000, { focused: false }, false], [60_000, {}, false],
    [60_000, { focused: true, incognito: true }, false],
    [60_000, { incognito: false }, true], [60_000, {}, true],
    [91_000, {}, true], [90_000, {}, true],
  ]) {
    const prior = baseline;
    clock += ms;
    baseline = advanceUsage(baseline, clock, active);
    f.activity(activity);
    await f.tick(ms);
    if (active || prior.active || prior.month !== baseline.month) expectedWrites++;
    assert.equal(f.writes.length, expectedWrites);
    assert.deepEqual(f.data[USAGE_STATE].days, baseline.days);
    assert.equal(f.data[USAGE_STATE].active, baseline.active);
    assert.equal(f.data[USAGE_STATE].id, baseline.id);
    if (active || prior.active) assert.equal(f.data[USAGE_STATE].sampledAt, clock);
  }
  assert.deepEqual(baseline.days, { '2026-10-30': 60, '2026-10-31': 250 });
});

test('missing inactive flag is persisted rather than treated as explicitly inactive', async () => {
  const initialState = advanceUsage(null, base, false, () => id);
  delete initialState.active;
  const f = fixture({ idle: 'idle', initialState });
  await f.worker.settled();
  assert.equal(f.writes.length, 1);
  assert.equal(f.data[USAGE_STATE].active, false);
  await f.tick();
  assert.equal(f.writes.length, 1);
});

test('opt-out during sampling prevents the transition write', async () => {
  const f = fixture();
  await f.worker.settled();
  const writes = f.writes.length;
  const get = f.api.storage.local.get;
  f.api.storage.local.get = async key => {
    const value = await get(key);
    if (key === USAGE_STATE) f.data[USAGE_ENABLED] = false;
    return value;
  };
  f.activity({ idle: 'idle' });
  await f.tick();
  assert.equal(f.writes.length, writes);
  await f.change(false);
  assert.equal(f.data[USAGE_STATE], undefined);
});

test('opt-out before a successful report response prevents its persistence', async () => {
  let f, complete, started;
  const ready = new Promise(resolve => { started = resolve; });
  f = fixture({ send: () => new Promise(resolve => { complete = resolve; started(); }) });
  await ready;
  f.data[USAGE_ENABLED] = false;
  complete({ ok: true });
  await f.worker.settled();
  assert.equal(f.writes.length, 1);
  assert.equal(f.data[USAGE_STATE].sentAt, 0);
  await f.change(false);
  assert.equal(f.data[USAGE_STATE], undefined);
});

test('queued alarms wait for the preceding sample write', async () => {
  const f = fixture();
  await f.worker.settled();
  const set = f.api.storage.local.set;
  let release, started, attempts = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { started = resolve; });
  f.api.storage.local.set = async values => {
    attempts++;
    if (attempts === 1) { started(); await gate; }
    await set(values);
  };
  const first = f.tick();
  await ready;
  const second = f.tick();
  const attemptsBeforeRelease = attempts;
  release();
  await Promise.all([first, second]);
  assert.equal(attemptsBeforeRelease, 1);
  assert.equal(attempts, 2);
  assert.equal(f.data[USAGE_STATE].sampledAt, base + 120_000);
  assert.equal(f.data[USAGE_STATE].days['2026-10-30'], 120);
});


test('subsecond alarms still sample intervening focus changes', async () => {
  const f = fixture();
  await f.worker.settled();
  const writes = f.writes.length;
  f.activity({ focused: false });
  await f.tick(250);
  assert.equal(f.writes.length, writes + 1);
  assert.equal(f.data[USAGE_STATE].active, false);
  f.activity({ focused: true });
  await f.tick(250);
  assert.equal(f.writes.length, writes + 2);
  assert.equal(f.data[USAGE_STATE].active, true);
  assert.equal(f.data[USAGE_STATE].days['2026-10-30'], 0);
  await f.tick();
  assert.equal(f.data[USAGE_STATE].days['2026-10-30'], 60);
});
