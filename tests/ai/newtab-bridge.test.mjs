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
  assert.equal(view.organato.exams[0].due.getDate(), 3);
  assert.equal(view.organato.exams[0].allDay, true);
});
