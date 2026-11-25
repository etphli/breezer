import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground, WARM_HANDOFF_MS, WARM_LIFETIME_MS, WARM_RETRY_MS } from '../../features/ai/extension/background.js';
import { event, fakeChrome, panel } from './browser-api-fixture.mjs';

// The helper here is a fake port. Nothing starts a provider, a CLI or an account session.
const PROVIDERS = [{ id: 'codex', available: true, authenticated: true, models: [{ id: 'sample-model' }] }];
const flush = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };

function fixture(t, { experiments = { newTabComposer: true }, tabs = {} } = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const fake = fakeChrome();
  const local = { breezerExperiments: experiments };
  fake.api.storage.local.get = async key => key == null ? { ...local } : Object.fromEntries([key].flat().filter(name => name in local).map(name => [name, local[name]]));
  fake.api.windows = { onFocusChanged: event(), onRemoved: event() };
  fake.api.tabs.get = async id => ({ id, active: true, incognito: false, ...tabs[id] });
  const natives = [];
  fake.api.runtime.connectNative = () => {
    const native = { sent: [], closed: false, onMessage: event(), onDisconnect: event(), postMessage(value) { this.sent.push(value); }, disconnect() { this.closed = true; } };
    natives.push(native);
    return native;
  };
  installBackground(fake.api);
  const newTab = async (tabId = 7, sender = {}) => {
    const port = { name: 'breezer-ask', sent: [], onMessage: event(), onDisconnect: event(), postMessage(value) { this.sent.push(value); },
      sender: { id: 'fixture', url: fake.api.runtime.getURL('newtab.html'), frameId: 0, documentLifecycle: 'active', tab: { id: tabId, windowId: 3, incognito: false }, ...sender } };
    fake.api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'prewarm' });
    await flush();
    return port;
  };
  const chat = async (tabId = 7) => {
    const port = panel();
    port.sender = { id: 'fixture', url: fake.api.runtime.getURL('panel.html?view=chat'), tab: { id: tabId, windowId: 3, incognito: false }, frameId: 0 };
    fake.api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'init', conversation: '00000000-0000-4000-8000-000000000001', epoch: '' });
    await flush();
    return port;
  };
  return { ...fake, natives, newTab, chat, live: () => natives.filter(native => !native.closed), set: value => { local.breezerExperiments = value; } };
}

test('the chat page takes over the warmed helper and its catalog without a second request', async t => {
  const { natives, newTab, chat, live } = fixture(t);
  const tab = await newTab();
  assert.deepEqual(natives.map(native => native.sent), [[{ type: 'init' }]]);
  natives[0].onMessage.emit({ type: 'status', providers: PROVIDERS });
  tab.onDisconnect.emit();
  const port = await chat();
  assert.deepEqual(port.sent.filter(message => message.type === 'status'), [{ type: 'status', providers: PROVIDERS }]);
  assert.equal(natives.length, 1);
  assert.deepEqual(natives[0].sent, [{ type: 'init' }], 'no chat and no second discovery before Send');
  port.onMessage.emit({ type: 'chat', id: 'q', provider: 'codex', model: 'sample-model', message: 'Hello' });
  await flush();
  assert.equal(natives[0].sent.at(-1).type, 'chat');
  t.mock.timers.tick(WARM_LIFETIME_MS * 2);
  assert.equal(live().length, 1, 'the warm limits end once the chat owns the helper');
  port.onMessage.emit({ type: 'refresh-models' });
  await flush();
  assert.equal(natives[0].sent.at(-1).type, 'init', 'Refresh still reads a new catalog');
});

test('a catalog still loading reaches the chat page that took it over', async t => {
  const { natives, newTab, chat } = fixture(t);
  const tab = await newTab();
  tab.onDisconnect.emit();
  const port = await chat();
  assert.equal(natives.length, 1);
  assert.equal(port.sent.some(message => message.type === 'status'), false);
  natives[0].onMessage.emit({ type: 'status', providers: PROVIDERS });
  assert.equal(port.sent.filter(message => message.type === 'status').length, 1);
  assert.equal(natives[0].sent.length, 1);
});

test('several New Tabs share one helper and only their own tab can take it', async t => {
  const { natives, newTab, chat, live } = fixture(t);
  await newTab(7); await newTab(7); await newTab(8);
  assert.equal(natives.length, 1);
  await chat(99);
  assert.equal(natives.length, 2, 'an unrelated chat starts its own helper');
  await chat(8);
  assert.equal(natives.length, 2);
  await chat(7);
  assert.equal(natives.length, 3, 'a helper serves one chat');
  assert.equal(live().length, 3);
});

test('an unused helper exits after its lifetime, a short handoff, or when its tab closes', async t => {
  const { api, natives, newTab, live } = fixture(t);
  await newTab();
  t.mock.timers.tick(WARM_LIFETIME_MS - 1);
  assert.equal(live().length, 1);
  t.mock.timers.tick(1);
  assert.equal(live().length, 0);

  const second = await newTab();
  second.onDisconnect.emit();
  t.mock.timers.tick(WARM_HANDOFF_MS - 1);
  assert.equal(live().length, 1);
  const third = await newTab();
  t.mock.timers.tick(WARM_HANDOFF_MS);
  assert.equal(natives.length, 2, 'choosing Ask again reuses the helper');
  assert.equal(live().length, 1);
  third.onDisconnect.emit();
  t.mock.timers.tick(WARM_HANDOFF_MS);
  assert.equal(live().length, 0);

  await newTab();
  api.tabs.onRemoved.emit(7);
  assert.equal(live().length, 0);
});

test('only an enabled, visible, top-level New Tab of this profile can start a helper', async t => {
  const { natives, newTab } = fixture(t, { tabs: { 20: { active: false }, 21: { incognito: true } } });
  await newTab(7, { id: 'another-extension' });
  await newTab(7, { url: 'chrome-extension://fixture/panel.html' });
  await newTab(7, { url: 'https://example.com/newtab.html' });
  await newTab(7, { frameId: 2 });
  await newTab(7, { documentLifecycle: 'prerender' });
  await newTab(7, { tab: undefined });
  await newTab(7, { tab: { id: 7, incognito: true } });
  await newTab(20);
  await newTab(21);
  assert.equal(natives.length, 0);
});

test('Ask switched off, or a page that left while it was checked, starts nothing', async t => {
  const off = fixture(t, { experiments: {} });
  await off.newTab();
  assert.equal(off.natives.length, 0);
  off.set({ newTabComposer: true });
  let resolve;
  off.api.tabs.get = () => new Promise(done => { resolve = done; });
  const port = await off.newTab();
  port.onDisconnect.emit();
  resolve({ id: 7, active: true, incognito: false });
  await flush();
  assert.equal(off.natives.length, 0);
});

test('a failed helper waits before another start and a chat falls back to its own', async t => {
  const { natives, newTab, chat } = fixture(t);
  const port = await newTab();
  natives[0].onDisconnect.emit();
  port.onMessage.emit({ type: 'prewarm' });
  await newTab(8);
  assert.equal(natives.length, 1);
  await chat();
  assert.equal(natives.length, 2);
  assert.deepEqual(natives[1].sent, [{ type: 'init' }]);
  t.mock.timers.tick(WARM_RETRY_MS);
  await newTab(8);
  assert.equal(natives.length, 3);
});

test('a warmed helper cannot run tools or chats and an error discards it', async t => {
  const { natives, newTab, chat } = fixture(t);
  await newTab();
  natives[0].onMessage.emit({ type: 'tool', id: 'x', requestId: 'r', name: 'browser_snapshot', args: {} });
  await flush();
  assert.deepEqual(natives[0].sent, [{ type: 'init' }]);
  natives[0].onMessage.emit({ type: 'error', error: 'fixture failure' });
  assert.equal(natives[0].closed, true);
  await chat();
  assert.equal(natives.length, 2);
});
