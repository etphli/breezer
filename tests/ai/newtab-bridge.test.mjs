import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackground } from '../../features/ai/extension/background.js';
import { requestView, normalizeView } from '../../features/ai/extension/newtab.js';
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
  // The background contract is unchanged: w1 is in both arrays and t1 is in exams and todos.
  assert.deepEqual(result.organato.exams.map(item => item.id), ['t1', 'w2', 'w1']);
  assert.deepEqual(result.organato.assignments.map(item => item.id), ['w3', 'w1']);
  const view = normalizeView(result);
  assert.deepEqual(view.organato.upcoming.map(item => item.id), ['w3', 'w2', 'w1']);
  assert.deepEqual(view.organato.upcoming.map(item => item.exam), [false, true, true]);
  assert.deepEqual(view.organato.todos.map(item => item.id), ['t1']);
});
