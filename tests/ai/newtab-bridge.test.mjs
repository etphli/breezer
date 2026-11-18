import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackground, ORGANATO_SWITCHES_KEY as BACKGROUND_KEY } from '../../features/ai/extension/background.js';
import { requestView, normalizeView, organatoState, ORGANATO_SWITCHES_KEY } from '../../features/ai/extension/newtab.js';
import { fakeChrome, event, tick } from './browser-api-fixture.mjs';
import { validateChat } from '../../features/ai/host/protocol.mjs';

test('new-tab frontend and native bridge agree on replies and all-day deadlines', async () => {
  const fake = fakeChrome();
  fake.api.runtime.id = 'test';
  fake.api.runtime.getURL = path => `chrome-extension://test/${path}`;
  fake.api.topSites = { get: async () => [{ title: 'Canvas', url: 'https://canvas.example/' }] };
  fake.native.postMessage = message => queueMicrotask(() => fake.native.onMessage.emit({
    id: message.id, ok: true, value: message.type === 'organato-view'
      ? { enabled: true, connected: true, dashboardEnabled: true }
      : { items: [{ id: '1', title: 'Exam', kind: 'work', classification: 'checkpoint', dueDateLocal: '2026-11-03', dueAt: null }] },
  }));
  installBackground(fake.api);
  const outgoing = event(), incoming = event(), disconnected = event();
  fake.api.runtime.connect = ({ name }) => {
    fake.api.runtime.onConnect.emit({ name, sender: { id: 'test', url: fake.api.runtime.getURL('newtab.html') }, onMessage: outgoing, onDisconnect: disconnected, postMessage: message => incoming.emit(message) });
    return { onMessage: incoming, onDisconnect: disconnected, postMessage: message => outgoing.emit(message), disconnect: () => disconnected.emit() };
  };
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(result.topSites[0].title, 'Canvas');
  const view = normalizeView(result);
  assert.equal(view.organato.upcoming[0].due.getDate(), 3);
  assert.equal(view.organato.upcoming[0].allDay, true);
});

test('the real background reply shows a "both" item once and to-dos only in To-dos', async () => {
  const fake = fakeChrome();
  fake.api.runtime.id = 'test';
  fake.api.runtime.getURL = path => `chrome-extension://test/${path}`;
  fake.api.topSites = { get: async () => [] };
  const items = [
    { id: 'w1', title: 'Midterm project', kind: 'work', classification: 'both', dueDateLocal: '2026-11-04', dueAt: null },
    { id: 'w2', title: 'Quiz', kind: 'work', classification: 'checkpoint', dueAt: '2026-11-02T09:00:00Z' },
    { id: 'w3', title: 'Essay', kind: 'work', classification: 'assignment', dueDateLocal: '2026-11-01', dueAt: null },
    { id: 't1', title: 'Flashcards', kind: 'todo', classification: 'checkpoint', dueDateLocal: '2026-10-31', dueAt: null },
  ];
  fake.native.postMessage = message => queueMicrotask(() => fake.native.onMessage.emit({
    id: message.id, ok: true, value: message.type === 'organato-view' ? { enabled: true, connected: true, dashboardEnabled: true } : { items },
  }));
  installBackground(fake.api);
  const outgoing = event(), incoming = event(), disconnected = event();
  fake.api.runtime.connect = ({ name }) => {
    fake.api.runtime.onConnect.emit({ name, sender: { id: 'test', url: fake.api.runtime.getURL('newtab.html') }, onMessage: outgoing, onDisconnect: disconnected, postMessage: message => incoming.emit(message) });
    return { onMessage: incoming, onDisconnect: disconnected, postMessage: message => outgoing.emit(message), disconnect: () => disconnected.emit() };
  };
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  // The response fields stay compatible; work can overlap, while to-dos stay in their own list.
  assert.deepEqual(result.organato.exams.map(item => item.id), ['w2', 'w1']);
  assert.deepEqual(result.organato.assignments.map(item => item.id), ['w3', 'w1']);
  const view = normalizeView(result);
  assert.deepEqual(view.organato.upcoming.map(item => item.id), ['w3', 'w2', 'w1']);
  assert.deepEqual(view.organato.upcoming.map(item => item.exam), [false, true, true]);
  assert.deepEqual(view.organato.todos.map(item => item.id), ['t1']);
});

// A background with a scripted helper. `helper` answers each native request.
function bridge(helper) {
  const fake = fakeChrome();
  fake.api.runtime.id = 'test';
  fake.api.runtime.getURL = path => `chrome-extension://test/${path}`;
  fake.api.topSites = { get: async () => [{ title: 'Canvas', url: 'https://canvas.example/' }] };
  fake.native.postMessage = message => { fake.native.sent.push(message); queueMicrotask(() => fake.native.onMessage.emit({ id: message.id, ...helper(message) })); };
  installBackground(fake.api);
  const helperStarts = () => fake.calls.filter(([kind, name]) => kind === 'native' && name === 'io.github.etphli.breezer.ai').length;
  const open = (name, page) => {
    const outgoing = event(), incoming = event(), disconnected = event();
    fake.api.runtime.onConnect.emit({ name, sender: { id: 'test', url: fake.api.runtime.getURL(page) }, onMessage: outgoing, onDisconnect: disconnected, postMessage: message => incoming.emit(message) });
    return { onMessage: incoming, onDisconnect: disconnected, postMessage: message => outgoing.emit(message), disconnect: () => disconnected.emit() };
  };
  fake.api.runtime.connect = ({ name }) => open(name, 'newtab.html');
  return { fake, helperStarts, open };
}
const ON = { enabled: true, connected: true, dashboardEnabled: true, allowAI: true };
const ITEMS = { items: [{ id: 'x', title: 'Cached exam', kind: 'work', classification: 'checkpoint', dueDateLocal: '2026-11-10', dueAt: null }] };

test('new-tab site lookup overlaps the pending Organato view', async () => {
  const { fake } = bridge(() => ({}));
  let sitesStarted = false, finishSites;
  fake.api.topSites.get = () => {
    sitesStarted = true;
    return new Promise(resolve => { finishSites = resolve; });
  };
  fake.native.postMessage = message => { fake.native.sent.push(message); };
  const view = requestView(fake.api, { timeoutMs: 1000 });
  try {
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(fake.native.sent[0].type, 'organato-view');
    assert.equal(sitesStarted, true, 'sites must start before Organato replies');
  } finally {
    fake.native.onMessage.emit({ id: fake.native.sent[0].id, ok: true, value: { ...ON, connected: false } });
    await new Promise(resolve => setImmediate(resolve));
    finishSites?.([{ title: 'Canvas', url: 'https://canvas.example/' }]);
  }
  const result = await view;
  assert.equal(result.topSites[0].title, 'Canvas');
  assert.equal(result.organato.connected, false);
});

test('an early site lookup failure preserves the Organato error priority', async () => {
  const { fake } = bridge(() => ({}));
  fake.api.topSites.get = async () => { throw new Error('Sites failed first'); };
  fake.native.postMessage = message => { fake.native.sent.push(message); };
  const view = requestView(fake.api, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  fake.native.onMessage.emit({ id: fake.native.sent[0].id, ok: false, error: 'Organato failed later' });
  const result = await view;
  assert.deepEqual(result.topSites, []);
  assert.equal(result.organato.error, 'Organato failed later');
});

test('a site lookup error still reaches the new tab after a valid Organato reply', async () => {
  const { fake } = bridge(() => ({ ok: true, value: { ...ON, connected: false } }));
  fake.api.topSites.get = () => { throw new Error('Sites unavailable'); };
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  assert.deepEqual(result.topSites, []);
  assert.equal(result.organato.error, 'Sites unavailable');
});

test('the page and background agree on the saved-switch key', () => {
  assert.equal(ORGANATO_SWITCHES_KEY, BACKGROUND_KEY);
});

test('a saved "off" answers the new tab without starting the Organato helper', async () => {
  const { fake, helperStarts } = bridge(() => { throw new Error('helper must not be asked'); });
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: false, dashboardEnabled: true } });
  const before = helperStarts();
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(helperStarts(), before, 'no native helper process for a disabled dashboard');
  assert.deepEqual(fake.native.sent, []);
  assert.deepEqual(result.organato, { enabled: false });
  assert.equal(result.dashboardEnabled, true);
  assert.equal(result.topSites[0].title, 'Canvas', 'sites still load');
});

test('helper "off" is never listed and carries no items, even for a connected account', async () => {
  const { fake } = bridge(message => ({ ok: true, value: message.type === 'organato-view' ? { ...ON, enabled: false } : ITEMS }));
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  assert.deepEqual(fake.native.sent.map(message => message.type), ['organato-view']);
  assert.deepEqual(result.organato, { enabled: false });
  // First read of an older profile fills in the saved copy from the helper.
  assert.deepEqual((await fake.api.storage.local.get(ORGANATO_SWITCHES_KEY))[ORGANATO_SWITCHES_KEY], { enabled: false, dashboardEnabled: true });
});

test('saved dashboard-off avoids connectNative and returns the redirect switch with sites', async () => {
  const { fake, helperStarts } = bridge(() => ({ ok: true, value: { ...ON, dashboardEnabled: false } }));
  const saved = { enabled: true, dashboardEnabled: false };
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: saved });
  for (let i = 0; i < 2; i++) {
    const result = await requestView(fake.api, { timeoutMs: 1000 });
    assert.equal(helperStarts(), 0, 'saved dashboard-off must not connectNative');
    assert.deepEqual(fake.native.sent, []);
    assert.equal(result.dashboardEnabled, false);
    assert.deepEqual(result.organato, { ...saved, exams: [], assignments: [], todos: [] });
    assert.equal(result.topSites[0].title, 'Canvas');
  }
});

for (const saved of [undefined, { enabled: true, dashboardEnabled: true }, { enabled: true }, { enabled: 'false', dashboardEnabled: false }]) {
  test(`enabled or unknown saved switches ask the helper: ${JSON.stringify(saved)}`, async () => {
    const { fake, helperStarts } = bridge(message => ({ ok: true, value: message.type === 'organato-view' ? ON : ITEMS }));
    if (saved) await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: saved });
    const result = await requestView(fake.api, { timeoutMs: 1000 });
    assert.equal(helperStarts(), 1);
    assert.deepEqual(fake.native.sent.map(message => message.type), ['organato-view', 'organato-list']);
    assert.equal(result.organato.exams[0].id, 'x');
  });
}

for (const type of ['view', 'refresh']) test(`dashboard-off manual refresh asks authoritative helper: ${type}`, async () => {
  const { fake, helperStarts, open } = bridge(message => ({ ok: true, value: message.type === 'organato-view' ? ON : ITEMS }));
  const saved = { enabled: true, dashboardEnabled: false };
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: saved });
  const port = open('breezer-newtab', 'newtab.html');
  try {
    const reply = new Promise(resolve => port.onMessage.addListener(resolve));
    port.postMessage({ id: 'manual', type, ...(type === 'view' ? { refresh: true } : {}) });
    const result = await reply;
    assert.equal(helperStarts(), 1);
    assert.deepEqual(fake.native.sent.map(message => message.type), ['organato-view', 'organato-list']);
    assert.equal(fake.native.sent[1].refresh, true);
    assert.equal(result.dashboardEnabled, true, 'refresh uses the helper answer');
    assert.deepEqual((await fake.api.storage.local.get(ORGANATO_SWITCHES_KEY))[ORGANATO_SWITCHES_KEY], saved, 'new tabs do not overwrite existing switches');
  } finally { port.disconnect(); }
});

test('master-off manual refresh retains the no-helper behavior', async () => {
  const { fake, helperStarts } = bridge(() => ({ ok: true, value: ON }));
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: false, dashboardEnabled: false } });
  const result = await requestView(fake.api, { refresh: true, timeoutMs: 1000 });
  assert.equal(helperStarts(), 0);
  assert.deepEqual(result.organato, { enabled: false });
});

test('dashboard-off refresh honors a helper that still says dashboard-off', async () => {
  const { fake, helperStarts } = bridge(() => ({ ok: true, value: { ...ON, dashboardEnabled: false } }));
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: true, dashboardEnabled: false } });
  const result = await requestView(fake.api, { refresh: true, timeoutMs: 1000 });
  assert.equal(helperStarts(), 1);
  assert.deepEqual(fake.native.sent.map(message => message.type), ['organato-view']);
  assert.equal(result.dashboardEnabled, false);
  assert.deepEqual(result.organato.exams, []);
});

test('saved dashboard-off retains site errors without starting the helper', async () => {
  const { fake, helperStarts } = bridge(() => ({ ok: true, value: ON }));
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: true, dashboardEnabled: false } });
  fake.api.topSites.get = async () => { throw new Error('Sites unavailable'); };
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(helperStarts(), 0);
  assert.equal(result.organato.error, 'Sites unavailable');
});

test('saved dashboard-off produces no late reply after port cleanup', async () => {
  const { fake, helperStarts, open } = bridge(() => ({ ok: true, value: ON }));
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: true, dashboardEnabled: false } });
  let finishSites;
  fake.api.topSites.get = () => new Promise(resolve => { finishSites = resolve; });
  const port = open('breezer-newtab', 'newtab.html');
  const replies = [];
  port.onMessage.addListener(message => replies.push(message));
  port.postMessage({ id: 'closing-off', type: 'view' });
  await new Promise(resolve => setImmediate(resolve));
  port.disconnect();
  finishSites([]);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(helperStarts(), 0);
  assert.deepEqual(replies, []);
});

test('saved dashboard-off invalidates a warm list before the dashboard returns', async () => {
  const fingerprint = 'a'.repeat(64);
  const { fake, helperStarts } = bridge(message => ({ ok: true, value: message.type === 'organato-view'
    ? { ...ON, cacheCapability: 1, fingerprint } : { ...ITEMS, truncated: false, fingerprint } }));
  await requestView(fake.api, { timeoutMs: 1000 });
  await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(fake.native.sent.filter(message => message.type === 'organato-list').length, 1, 'list was warm');
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: true, dashboardEnabled: false } });
  const starts = helperStarts();
  assert.equal((await requestView(fake.api, { timeoutMs: 1000 })).dashboardEnabled, false);
  assert.equal(helperStarts(), starts);
  // Change only the switches, so configure cannot supply the invalidation for this check.
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: true, dashboardEnabled: true } });
  await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(fake.native.sent.filter(message => message.type === 'organato-list').length, 2);
});

test('Settings re-enables a saved-off dashboard and the next view reconnects', async () => {
  const { fake, helperStarts, open } = bridge(message => ({ ok: true, value: message.type === 'organato-list' ? ITEMS : ON }));
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: true, dashboardEnabled: false } });
  await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(helperStarts(), 0);
  const settings = open('breezer-organato-settings', 'workspace.html');
  const reply = new Promise(resolve => settings.onMessage.addListener(resolve));
  settings.postMessage({ id: 'enable', type: 'configure', settings: { dashboardEnabled: true } });
  assert.equal((await reply).ok, true);
  assert.equal(helperStarts(), 1);
  assert.deepEqual((await fake.api.storage.local.get(ORGANATO_SWITCHES_KEY))[ORGANATO_SWITCHES_KEY], { enabled: true, dashboardEnabled: true });
  settings.disconnect();
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(helperStarts(), 2, 'closed Settings transport reconnects');
  assert.equal(result.organato.exams[0].id, 'x');
  assert.deepEqual(fake.native.sent.map(message => message.type), ['organato-configure', 'organato-view', 'organato-list']);
});

test('a slow new-tab view cannot overwrite Settings turning the dashboard off', async () => {
  const { fake, open } = bridge(() => ({}));
  await fake.api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled: true, dashboardEnabled: true } });
  fake.native.postMessage = message => fake.native.sent.push(message);
  const view = requestView(fake.api, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  const settings = open('breezer-organato-settings', 'workspace.html');
  const reply = new Promise(resolve => settings.onMessage.addListener(resolve));
  settings.postMessage({ id: 'disable', type: 'configure', settings: { dashboardEnabled: false } });
  const configure = fake.native.sent.find(message => message.type === 'organato-configure');
  fake.native.onMessage.emit({ id: configure.id, ok: true, value: { ...ON, dashboardEnabled: false } });
  await reply;
  // Complete the older view without a list, then check the authoritative saved choice.
  fake.native.onMessage.emit({ id: fake.native.sent[0].id, ok: true, value: { ...ON, connected: false } });
  await view;
  settings.disconnect();
  assert.deepEqual((await fake.api.storage.local.get(ORGANATO_SWITCHES_KEY))[ORGANATO_SWITCHES_KEY], { enabled: true, dashboardEnabled: false });
  const before = fake.native.sent.length;
  assert.equal((await requestView(fake.api, { timeoutMs: 1000 })).dashboardEnabled, false);
  assert.equal(fake.native.sent.length, before);
});

test('a disabled payload with stale items, error or connection still renders as off', () => {
  const view = normalizeView({ organato: { enabled: false, connected: true, error: 'Old failure', exams: ITEMS.items.map(item => ({ ...item, dueAt: '2026-11-10' })), todos: [{ id: 't', title: 'Todo' }] } });
  assert.equal(organatoState(view.organato), 'disabled');
  assert.deepEqual(view.organato, { enabled: false, connected: false, error: null, todos: [], upcoming: [] });
});

test('Settings and setup changes update the saved switches; re-enabling keeps the key', async () => {
  let saved = { ...ON };
  const { fake, helperStarts, open } = bridge(message => {
    if (message.type === 'organato-configure') saved = { ...saved, ...message.settings };
    return { ok: true, value: message.type === 'organato-list' ? ITEMS : { ...saved } };
  });
  const settings = open('breezer-organato-settings', 'workspace.html');
  const replies = [];
  settings.onMessage.addListener(message => replies.push(message));
  settings.postMessage({ id: '1', type: 'configure', settings: { enabled: false } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(replies.at(-1).value.enabled, false);
  assert.deepEqual((await fake.api.storage.local.get(ORGANATO_SWITCHES_KEY))[ORGANATO_SWITCHES_KEY], { enabled: false, dashboardEnabled: true });
  const startsWhileOff = helperStarts();
  assert.deepEqual((await requestView(fake.api, { timeoutMs: 1000 })).organato, { enabled: false });
  assert.equal(helperStarts(), startsWhileOff);

  // Turning it back on never sends a disconnect, so the Keychain key stays.
  settings.postMessage({ id: '2', type: 'configure', settings: { enabled: true } });
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(fake.native.sent.filter(message => message.type === 'organato-configure').every(message => !('disconnect' in message.settings)));
  assert.deepEqual((await fake.api.storage.local.get(ORGANATO_SWITCHES_KEY))[ORGANATO_SWITCHES_KEY], { enabled: true, dashboardEnabled: true });
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(result.organato.connected, true);
  assert.deepEqual(result.organato.exams.map(item => item.id), ['x']);
});

test('manual refresh reaches the dashboard read in the native helper', async () => {
  const { fake } = bridge(message => ({ ok: true, value: message.type === 'organato-view' ? ON : ITEMS }));
  await requestView(fake.api, { refresh: true, timeoutMs: 1000 });
  assert.equal(fake.native.sent.find(message => message.type === 'organato-list').refresh, true);
});

test('dashboard list starts while site lookup is pending and the reply waits for both', async () => {
  const { fake } = bridge(() => ({}));
  const trace = [];
  let finishSites;
  fake.api.topSites.get = () => { trace.push('sites:start'); return new Promise(resolve => { finishSites = resolve; }); };
  fake.native.postMessage = message => { fake.native.sent.push(message); trace.push(`${message.type}:start`); };
  const view = requestView(fake.api, { timeoutMs: 1000 });
  let settled = false;
  void view.then(() => { settled = true; });
  try {
    await new Promise(resolve => setImmediate(resolve));
    fake.native.onMessage.emit({ id: fake.native.sent[0].id, ok: true, value: ON });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual([...trace], ['sites:start', 'organato-view:start', 'organato-list:start']);
    fake.native.onMessage.emit({ id: fake.native.sent[1].id, ok: true, value: ITEMS });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(settled, false);
  } finally {
    finishSites?.([{ title: 'Canvas', url: 'https://canvas.example/' }]);
    await new Promise(resolve => setImmediate(resolve));
    const list = fake.native.sent.find(message => message.type === 'organato-list');
    if (list) fake.native.onMessage.emit({ id: list.id, ok: true, value: ITEMS });
    await view;
  }
  const result = await view;
  assert.equal(result.topSites[0].title, 'Canvas');
  assert.equal(result.organato.exams[0].id, 'x');
});

test('site failure takes priority over an earlier concurrent list failure', async () => {
  const { fake } = bridge(() => ({}));
  let failSites;
  fake.api.topSites.get = () => new Promise((resolve, reject) => { failSites = reject; });
  fake.native.postMessage = message => fake.native.sent.push(message);
  const view = requestView(fake.api, { timeoutMs: 1000 });
  await new Promise(resolve => setImmediate(resolve));
  fake.native.onMessage.emit({ id: fake.native.sent[0].id, ok: true, value: ON });
  await new Promise(resolve => setImmediate(resolve));
  fake.native.onMessage.emit({ id: fake.native.sent[1].id, ok: false, error: 'List failed' });
  await new Promise(resolve => setImmediate(resolve));
  failSites(new Error('Sites failed'));
  const result = await view;
  assert.deepEqual(result.topSites, []);
  assert.equal(result.organato.error, 'Sites failed');
});

test('closing while both requests are pending produces no late reply', async () => {
  const { fake, open } = bridge(() => ({}));
  let finishSites;
  fake.api.topSites.get = () => new Promise(resolve => { finishSites = resolve; });
  fake.native.postMessage = message => fake.native.sent.push(message);
  const port = open('breezer-newtab', 'newtab.html');
  const replies = [];
  port.onMessage.addListener(message => replies.push(message));
  port.postMessage({ id: 'request', type: 'view' });
  await new Promise(resolve => setImmediate(resolve));
  fake.native.onMessage.emit({ id: fake.native.sent[0].id, ok: true, value: ON });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fake.native.sent[1].type, 'organato-list');
  port.disconnect();
  finishSites([]);
  fake.native.onMessage.emit({ id: fake.native.sent[1].id, ok: true, value: ITEMS });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, []);
});

test('list failure after sites retains sites and reports the dashboard error', async () => {
  const { fake } = bridge(message => message.type === 'organato-view'
    ? { ok: true, value: ON } : { ok: false, error: 'List unavailable' });
  const result = await requestView(fake.api, { timeoutMs: 1000 });
  assert.equal(result.topSites[0].title, 'Canvas');
  assert.equal(result.organato.error, 'List unavailable');
  assert.deepEqual(result.organato.exams, []);
});

test('closing after a config reply but before its continuation starts no list request', async () => {
  const { fake, open } = bridge(() => ({}));
  fake.native.postMessage = message => fake.native.sent.push(message);
  const port = open('breezer-newtab', 'newtab.html');
  port.postMessage({ id: 'closing', type: 'view' });
  await new Promise(resolve => setImmediate(resolve));
  fake.native.onMessage.emit({ id: fake.native.sent[0].id, ok: true, value: ON });
  port.disconnect();
  await new Promise(resolve => setImmediate(resolve));
  try { assert.deepEqual(fake.native.sent.map(message => message.type), ['organato-view']); }
  finally { fake.native.onDisconnect.emit(); }
});

test('saved native results paint before a blocked request settles and remain in the final answer', async () => {
  let finish;
  const { fake } = bridge(() => ({ ok: true, value: { ...ON, cacheCapability: 1, fingerprint: "a".repeat(64) } }));
  fake.native.postMessage = message => {
    if (message.type === 'organato-view') {
      queueMicrotask(() => fake.native.onMessage.emit({ id: message.id, ok: true, value: { ...ON, cacheCapability: 1, fingerprint: "a".repeat(64) } }));
    } else {
      queueMicrotask(() => fake.native.onMessage.emit({ type: 'organato-cache', id: message.id, value: { ...ITEMS, truncated: false, fingerprint: 'a'.repeat(64), syncedAt: '2026-11-10T21:36:00Z' } }));
      finish = () => fake.native.onMessage.emit({ id: message.id, ok: false, error: 'fetch failed', code: 'NETWORK_ERROR' });
    }
  };
  let updated;
  const intermediate = new Promise(resolve => { updated = resolve; });
  let settled = false;
  const pending = requestView(fake.api, { timeoutMs: 1000, onUpdate: value => updated(value) }).then(value => { settled = true; return value; });
  const cached = await intermediate;
  assert.equal(settled, false);
  assert.equal(cached.organato.cached, true);
  assert.deepEqual(normalizeView(cached).organato.upcoming.map(item => item.id), ['x']);
  finish();
  const final = await pending;
  assert.equal(final.organato.error, 'fetch failed');
  assert.equal(final.organato.syncedAt, '2026-11-10T21:36:00Z');
  assert.deepEqual(final.organato.exams, cached.organato.exams);
  assert.equal(organatoState(normalizeView(final).organato), 'ready');
});

test('a successful live refresh replaces saved tasks and clears the saved-data notice', async () => {
  const { fake } = bridge(() => ({ ok: true, value: { ...ON, cacheCapability: 1, fingerprint: "a".repeat(64) } }));
  fake.native.postMessage = message => queueMicrotask(() => {
    if (message.type === 'organato-list') fake.native.onMessage.emit({ type: 'organato-cache', id: message.id, value: { ...ITEMS, truncated: false, fingerprint: "a".repeat(64) } });
    fake.native.onMessage.emit({ id: message.id, ok: true, value: message.type === 'organato-view' ? { ...ON, cacheCapability: 1, fingerprint: "a".repeat(64) } : { items: [], truncated: false, fingerprint: "a".repeat(64) } });
  });
  const cached = [];
  const final = await requestView(fake.api, { refresh: true, timeoutMs: 1000, onUpdate: value => cached.push(value) });
  assert.equal(cached.length, 1);
  assert.equal(cached[0].organato.exams.length, 1);
  assert.equal(final.organato.cached, false);
  assert.deepEqual(final.organato.exams, []);
});


test('cache-enabled background preserves PR18 attachments and panel sender checks', async () => {
  const fake = fakeChrome();
  fake.api.runtime.id = 'test';
  fake.api.runtime.getURL = path => `chrome-extension://test/${path}`;
  installBackground(fake.api);
  const attachments = [{ name: 'review.txt', text: 'Untrusted file text' }];
  const history = [{ role: 'user', content: 'Earlier file', attachments: [{ name: 'before.txt', text: 'Earlier text' }] }];
  const message = { type: 'chat', id: 'attachments-main-port', provider: 'codex', model: 'fixture', message: 'Review the files', attachments, history };
  const open = sender => {
    const port = { name: 'breezer-panel', sender, onMessage: event(), onDisconnect: event(), postMessage() {} };
    fake.api.runtime.onConnect.emit(port);
    return port;
  };
  for (const sender of [
    { id: 'other', url: fake.api.runtime.getURL('panel.html') },
    { id: 'test', url: fake.api.runtime.getURL('newtab.html') },
    { id: 'test', url: fake.api.runtime.getURL('panel.html'), tab: { incognito: true } },
  ]) open(sender).onMessage.emit(message);
  await tick();
  assert.equal(fake.native.sent.length, 0, 'untrusted senders never reach the helper');
  const trusted = open({ id: 'test', url: fake.api.runtime.getURL('panel.html') });
  try {
    trusted.onMessage.emit(message);
    await tick();
    const forwarded = fake.native.sent.find(value => value.type === 'chat');
    assert.ok(forwarded, 'trusted file message reaches the native bridge');
    assert.deepEqual(forwarded.attachments, attachments);
    assert.deepEqual(forwarded.history, history);
    assert.doesNotThrow(() => validateChat(forwarded));
    assert.throws(() => validateChat({ ...forwarded, attachments: [{ ...attachments[0], path: '/private/file' }] }),
      'the integrated protocol still calls the real attachment validator');
  } finally { trusted.onDisconnect.emit(); }
});
