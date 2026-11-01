import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackground, ORGANATO_SWITCHES_KEY as BACKGROUND_KEY } from '../../features/ai/extension/background.js';
import { requestView, normalizeView, organatoState, ORGANATO_SWITCHES_KEY } from '../../features/ai/extension/newtab.js';
import { fakeChrome, event } from './browser-api-fixture.mjs';

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
