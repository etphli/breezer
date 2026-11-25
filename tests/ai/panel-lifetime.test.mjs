import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../../features/ai/extension/background.js';
import { event, fakeChrome, panel, tick } from './browser-api-fixture.mjs';

const chat = { type: 'chat', id: 'request', provider: 'codex', model: 'auto', message: 'Make my browser dark purple', browserTask: 'theme' };

async function fixture(fields = {}) {
  const fake = fakeChrome();
  const stored = {};
  fake.api.storage.session = {
    async get(key) { return { [key]: structuredClone(stored[key]) }; },
    async set(entries) { Object.assign(stored, structuredClone(entries)); },
    async remove(key) { delete stored[key]; },
  };
  fake.api.sidePanel.onClosed = event();
  fake.api.windows = { onFocusChanged: event(), onRemoved: event() };
  const natives = [];
  fake.api.runtime.connectNative = () => {
    const native = { ...fake.native, sent: [], onMessage: event(), onDisconnect: event(), disconnect() { this.closed = true; this.onDisconnect.emit(); } };
    natives.push(native);
    return native;
  };
  installBackground(fake.api);
  const connect = async (windowId = 3) => {
    fake.setTab({ windowId });
    const port = panel();
    fake.api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'init', windowId });
    await tick();
    return port;
  };
  const port = await connect();
  port.onMessage.emit({ ...chat, ...fields });
  await tick();
  return { ...fake, port, native: natives[0], connect };
}

const emitDelta = (native, text) => native.onMessage.emit({ type: 'delta', id: chat.id, text });

test('a read-only turn survives tab and window switches, hiding, and disconnection, then streams on reopen', async () => {
  const { api, port, native, connect } = await fixture();
  emitDelta(native, 'First ');
  port.onMessage.emit({ type: 'visibility', visible: false });
  api.sidePanel.onClosed.emit({ windowId: 3 });
  api.tabs.onActivated.emit({ windowId: 3, tabId: 8 });
  api.windows.onFocusChanged.emit(4);
  port.onDisconnect.emit();
  await tick();
  assert.ok(!native.closed);
  assert.ok(!native.sent.some(message => message.type === 'cancel'));

  const differentWindow = await connect(4);
  assert.ok(!differentWindow.sent.some(message => message.type === 'turn-state'));
  differentWindow.onMessage.emit({ ...chat, id: 'another-window' });
  const reopened = await connect();
  const turn = reopened.sent.find(message => message.type === 'turn-state');
  assert.equal(turn.text, 'First ');
  assert.equal(turn.user.text, chat.message);
  emitDelta(native, 'second');
  assert.equal(reopened.sent.at(-1).text, 'second');
  reopened.onMessage.emit({ type: 'cancel', id: chat.id });
  await tick();
  assert.ok(native.sent.some(message => message.type === 'cancel'));
  assert.ok(native.closed, 'a detached helper shuts down after Stop');
});

test('a theme finished with the panel closed is restored as a proposal in the original window', async () => {
  const image = 'data:image/png;base64,iVBORw0KGgo=';
  const { port, native, connect } = await fixture({ attachments: [{ name: 'sky.png', image }] });
  port.onDisconnect.emit();
  const proposal = { name: 'Dark purple', theme: '#39255a', colorMode: 'dark', imageAttachment: 1 };
  native.onMessage.emit({ type: 'tool', id: chat.id, requestId: 'theme', name: 'browser_propose_theme', args: proposal });
  await tick();
  assert.equal(native.sent.at(-1).result.staged, true);
  emitDelta(native, 'Here is your theme.');
  native.onMessage.emit({ type: 'complete', id: chat.id });
  await tick();
  assert.ok(native.closed);
  const reopened = await connect();
  const turn = reopened.sent.find(message => message.type === 'turn-state');
  assert.equal(turn.text, 'Here is your theme.');
  assert.deepEqual(turn.terminal.themeProposal, proposal);
  assert.equal(turn.themeImage, image);
  reopened.onMessage.emit({ type: 'turn-saved', id: chat.id });
  await tick();
  assert.ok(!(await connect()).sent.some(message => message.type === 'turn-state'));
});

test('full-page chat isolates its request and reply from the sidebar window', async () => {
  const { api, native, port } = await fixture();
  const tab = panel();
  tab.sender = { id: 'fixture', url: api.runtime.getURL('panel.html?view=chat'), tab: { id: 42, windowId: 3, incognito: false }, frameId: 0 };
  api.runtime.onConnect.emit(tab);
  tab.onMessage.emit({ type: 'init', windowId: 999 });
  await tick();
  assert.ok(!tab.sent.some(message => message.type === 'turn-state'));
  tab.onMessage.emit({ type: 'chat', id: 'blocked', provider: 'codex', model: 'gpt-6', message: 'Read this page', includeContext: true });
  await tick();
  assert.match(tab.sent.at(-1).error, /available from the sidebar/);
  api.sidePanel.onClosed.emit({ windowId: 3 });
  tab.onMessage.emit({ type: 'chat', id: 'tab-visual', provider: 'claude', model: 'claude-opus-5-5', message: 'Show the steps' });
  await tick();
  assert.ok(!tab.sent.some(message => message.id === 'tab-visual' && message.type === 'error'));
  emitDelta(native, 'sidebar only');
  assert.equal(port.sent.at(-1).text, 'sidebar only');
  assert.ok(!tab.sent.some(message => message.text === 'sidebar only'));
});
