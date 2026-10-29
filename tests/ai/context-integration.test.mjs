import test from 'node:test';
import assert from 'node:assert/strict';
const { installContextBackground } = await import('../../features/ai/extension/context-background.js').catch(() => ({}));
const { ContextHostController } = await import('../../features/ai/host/context-controller.mjs').catch(() => ({}));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) { if (predicate()) return; await new Promise(resolve => setTimeout(resolve, 1)); }
  assert.fail('Expected asynchronous test step did not start');
}
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners = this.listeners.filter(x => x !== fn); }, fire(...args) { for (const fn of this.listeners) fn(...args); } });
const tab = { id: 1, active: true, incognito: false, url: 'https://docs.example.org/help?token=secret', title: 'Private title' };
function port(url = 'chrome-extension://test/workspace.html', incognito = false) {
  return { name: 'breezer-context-settings', sender: { id: 'test', url, tab: { incognito } }, messages: [], onMessage: event(), onDisconnect: event(), postMessage(value) { this.messages.push(value); }, disconnect() { this.onDisconnect.fire(); } };
}
function browser() {
  const data = {}; let nativeCalls = 0;
  const api = { runtime: { id: 'test', getURL: file => `chrome-extension://test/${file}`, onConnect: event(), connectNative() { nativeCalls++; return api.native; } }, extension: { inIncognitoContext: false },
    native: { ...port(), sent: [], postMessage(value) { this.sent.push(value); }, disconnect() { this.onDisconnect.fire(); } },
    tabs: { onActivated: event(), onUpdated: event(), async get() { return { ...tab }; } },
    storage: { local: { async get(key) { return { [key]: structuredClone(data[key]) }; }, async set(value) { Object.assign(data, structuredClone(value)); } } },
  };
  return { api, data, nativeCalls: () => nativeCalls };
}
async function command(p, type, fields = {}) {
  const id = `r${p.messages.length}`;
  p.onMessage.fire({ id, type, ...fields });
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    const result = p.messages.find(m => m.id === id); if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  throw new Error('Missing command response');
}

test('only trusted non-private settings pages can configure/view context', async () => {
  assert.equal(typeof installContextBackground, 'function', 'Context integration is missing');
  const b = browser();
  const service = installContextBackground(b.api, { isPermitted: () => true });
  for (const p of [port('https://docs.example.org'), port('chrome-extension://test/panel.html'), port(undefined, true)]) {
    b.api.runtime.onConnect.fire(p);
    p.onMessage.fire({ id: 'x', type: 'configure', enabled: true, sites: ['docs.example.org'] });
    await tick();
    assert.equal((await service.memory.view()).enabled, false);
  }
  const p = port(); b.api.runtime.onConnect.fire(p);
  assert.equal((await command(p, 'configure', { enabled: true, sites: ['docs.example.org'] })).ok, true);
  assert.equal((await command(p, 'view')).value.enabled, true);
  assert.equal(b.nativeCalls(), 0);
  await command(p, 'clear');
  assert.deepEqual((await service.memory.view()).habits, []);
  await command(p, 'configure', { enabled: false });
  assert.equal((await service.memory.view()).enabled, false);
  service.dispose();
});

test('tab events respect permissions, never open a helper or read a document, and disposal stops recording', async () => {
  assert.equal(typeof installContextBackground, 'function');
  const b = browser(); let allowed = false;
  const service = installContextBackground(b.api, { isPermitted: () => allowed });
  b.api.tabs.onUpdated.fire(1, { status: 'complete' }, tab); await tick();
  assert.equal((await service.memory.view()).enabled, false);
  await service.memory.configure({ enabled: true, sites: ['docs.example.org'] });
  b.api.tabs.onUpdated.fire(1, { status: 'complete' }, tab); await tick();
  assert.deepEqual((await service.memory.view()).habits, []);
  allowed = true;
  b.api.tabs.onUpdated.fire(1, { title: 'Secret title only update' }, tab); await tick();
  assert.deepEqual((await service.memory.view()).habits, []);
  b.api.tabs.onActivated.fire({ tabId: 1 }); await tick(); await tick();
  assert.equal((await service.memory.view()).habits[0].observations, 1);
  assert.equal(b.nativeCalls(), 0);
  service.dispose();
  assert.equal(b.api.tabs.onUpdated.listeners.length, 0);
});

test('summary transport sends only a consented batch and clear cancels/disconnects its helper', async () => {
  assert.equal(typeof installContextBackground, 'function');
  const b = browser(); let now = Date.UTC(2026, 9, 29);
  const service = installContextBackground(b.api, { isPermitted: () => true, now: () => now });
  const p = port(); b.api.runtime.onConnect.fire(p);
  await command(p, 'configure', { enabled: true, sites: ['docs.example.org'] });
  for (let i = 0; i < 3; i++) { await service.memory.observe(tab, { isPermitted: () => true }); now += 31 * 60_000; }
  const denied = await command(p, 'summarize'); assert.equal(denied.ok, false); assert.equal(b.nativeCalls(), 0);
  await command(p, 'consent', { consent: true });
  p.onMessage.fire({ id: 'summary1', type: 'summarize' });
  for (let i = 0; i < 30 && !b.api.native.sent.some(m => m.type === 'context-summary'); i++) await tick();
  const sent = b.api.native.sent.find(m => m.type === 'context-summary');
  assert.ok(sent); assert.equal(sent.consent, true); assert.equal(JSON.stringify(sent).includes('secret'), false);
  await command(p, 'clear'); await tick();
  assert.ok(b.api.native.sent.some(m => m.type === 'cancel' && m.id === sent.id));
  assert.equal(p.messages.find(m => m.id === 'summary1').ok, false);
  service.dispose();
});

const request = { type: 'context-summary', id: 'summary1', consent: true, model: 'gpt-6-luna', payload: { version: 1, retentionDays: 7, sites: [{ site: 'docs.example.org', observations: 3, days: 1 }] } };
function provider(chat) {
  return { id: 'codex', status: { available: true, authenticated: true }, models: [{ id: 'gpt-6-luna', reasoningEfforts: ['low'] }], async discover() { return this.status; }, chat };
}

test('host wrapper shares normal chat busy/cancel boundaries and suppresses stale summary output', async () => {
  assert.equal(typeof ContextHostController, 'function', 'Context host adapter is missing');
  const messages = []; let finish;
  const p = provider(async (_chat, api) => { await new Promise(resolve => { finish = resolve; }); api.emit({ type: 'delta', text: 'stale' }); });
  const host = new ContextHostController([p], m => messages.push(m));
  const run = host.receive(request); await waitFor(() => finish);
  await host.receive({ type: 'chat', id: 'chat1', provider: 'codex', message: 'Hi' });
  assert.match(messages.at(-1).error, /running/);
  await host.receive({ type: 'cancel', id: 'wrong' });
  assert.equal(messages.some(m => m.cancelled), false);
  await host.receive({ type: 'cancel', id: request.id });
  finish(); await run;
  assert.equal(messages.some(m => m.type === 'context-summary-result'), false);
  assert.equal(messages.filter(m => m.cancelled).length, 1);
  host.close();
});

test('host wrapper returns a summary result and preserves ordinary chat behavior', async () => {
  assert.equal(typeof ContextHostController, 'function');
  const messages = [];
  const p = provider(async (_chat, api) => api.emit({ type: 'delta', text: 'A possible preference is documentation.' }));
  const host = new ContextHostController([p], m => messages.push(m));
  await host.receive(request);
  assert.equal(messages[0].type, 'context-summary-result');
  assert.match(messages[0].result.text, /Possible preferences/);
  assert.equal(messages.at(-1).type, 'complete');
  await host.receive({ type: 'chat', id: 'chat2', provider: 'codex', message: 'Hi' });
  assert.equal(messages.at(-1).type, 'complete');
  assert.ok(messages.some(m => m.id === 'chat2' && m.type === 'delta'));
  host.close();
});

test('cancelling ordinary chat permits its replacement before old provider cleanup finishes', async () => {
  const messages = []; let finish;
  const p = provider(async (chat, api) => {
    if (chat.id === 'old') await new Promise(resolve => { finish = resolve; });
    api.emit({ type: 'delta', text: chat.id });
  });
  const host = new ContextHostController([p], m => messages.push(m));
  const first = host.receive({ type: 'chat', id: 'old', provider: 'codex', message: 'Old request' });
  await waitFor(() => finish);
  await host.receive({ type: 'cancel', id: 'old' });
  await host.receive({ type: 'chat', id: 'replacement', provider: 'codex', message: 'Replacement request' });
  assert.ok(messages.some(m => m.id === 'replacement' && m.type === 'complete'));
  assert.equal(messages.some(m => m.id === 'replacement' && m.type === 'error'), false);
  finish(); await first; host.close();
});

test('an explicit grant records the first sample and a manual summary completes through the real host adapter', async () => {
  const b = browser(); let now = Date.UTC(2026, 9, 29), modelCalls = 0;
  const p = provider(async (chat, api) => { modelCalls++; assert.equal(chat.control, false); assert.equal(chat.includeContext, false); api.emit({ type: 'delta', text: 'You may find a documentation shortcut useful.' }); });
  b.api.runtime.connectNative = () => {
    const native = { onMessage: event(), onDisconnect: event(), postMessage(message) { void host.receive(message); }, disconnect() { host.close(); this.onDisconnect.fire(); } };
    const host = new ContextHostController([p], message => native.onMessage.fire(message));
    return native;
  };
  const service = installContextBackground(b.api, { isPermitted: () => true, now: () => now });
  const settings = port(); b.api.runtime.onConnect.fire(settings);
  await command(settings, 'configure', { enabled: true, sites: ['docs.example.org'] });
  for (let i = 0; i < 3; i++) { assert.equal(await service.observeGranted(tab), true); now += 31 * 60_000; }
  assert.equal(modelCalls, 0);
  await command(settings, 'consent', { consent: true });
  const result = await command(settings, 'summarize');
  assert.equal(result.ok, true);
  assert.equal(result.value.model, 'gpt-6-luna');
  assert.match(result.value.text, /documentation shortcut/);
  assert.equal(modelCalls, 1);
  service.dispose();
});
