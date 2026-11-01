import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackground } from '../../features/ai/extension/background.js';
import { fakeChrome, event } from './browser-api-fixture.mjs';

const idle = () => new Promise(resolve => setTimeout(resolve, 300));
function fixture() {
  const { api } = fakeChrome(), natives = [];
  api.runtime.id = 'test';
  api.runtime.getURL = file => `chrome-extension://test/${file}`;
  api.runtime.connectNative = () => {
    const native = { sent: [], disconnected: false, onMessage: event(), onDisconnect: event(),
      postMessage(message) { assert.equal(this.disconnected, false); this.sent.push(message); },
      disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
    };
    natives.push(native);
    return native;
  };
  installBackground(api);
  const open = (sender = { id: 'test', url: api.runtime.getURL('workspace.html') }) => {
    const port = { name: 'breezer-updates', sender, sent: [], disconnected: false,
      onMessage: event(), onDisconnect: event(), postMessage(message) { this.sent.push(message); },
      disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
    };
    api.runtime.onConnect.emit(port);
    return port;
  };
  const reply = (native, id, value, ok = true) => native.onMessage.emit({ type: 'update-result', id, ok, ...(ok ? { value } : { error: value }) });
  return { open, natives, reply };
}

test('updater starts on demand and releases empty checks and errors without closing Settings', async () => {
  const { open, natives, reply } = fixture(), port = open();
  try {
    assert.equal(natives.length, 0, 'an unused updater port needs no process');
    port.onMessage.emit({ type: 'update-check', id: '1' });
    assert.equal(natives.length, 1);
    reply(natives[0], '1', { available: false });
    await idle();
    assert.equal(natives[0].disconnected, true);
    assert.equal(port.disconnected, false);
    port.onMessage.emit({ type: 'update-check', id: '2' });
    assert.equal(natives.length, 2);
    reply(natives[1], '2', 'GitHub is unavailable.', false);
    await idle();
    assert.equal(natives[1].disconnected, true);
    assert.deepEqual(port.sent.map(message => message.ok), [true, false]);
    assert.equal(port.disconnected, false);
  } finally { port.disconnect(); }
});

test('pending checks, checked candidates and active installations retain their native state', async () => {
  const { open, natives, reply } = fixture(), port = open();
  try {
    port.onMessage.emit({ type: 'update-check', id: 'check' });
    const native = natives[0];
    await idle(); assert.equal(native.disconnected, false, 'pending check');
    reply(native, 'check', { available: true, version: '1.2.0' });
    await idle(); assert.equal(native.disconnected, false, 'checked candidate');
    port.onMessage.emit({ type: 'update-install', id: 'failed-handoff' });
    reply(native, 'failed-handoff', 'Worker did not start.', false);
    await idle(); assert.equal(native.disconnected, false, 'failed handoff retains checked candidate');
    port.onMessage.emit({ type: 'update-install', id: 'install' });
    reply(native, 'install', { installing: true });
    await idle(); assert.equal(native.disconnected, false, 'installation acknowledged');
    port.onMessage.emit({ type: 'update-status', id: 'status' });
    reply(native, 'status', { phase: 'downloading' });
    await idle(); assert.equal(native.disconnected, false, 'worker still running');
    port.onMessage.emit({ type: 'update-status', id: 'finished' });
    reply(native, 'finished', { phase: 'failed' });
    await idle(); assert.equal(native.disconnected, true, 'terminal worker status');
    assert.equal(natives.length, 1, 'all stateful actions use the checked host');
    assert.equal(port.disconnected, false);
  } finally { port.disconnect(); }
});

test('a later empty check releases an earlier checked candidate; stale native events cannot close its replacement', async () => {
  const { open, natives, reply } = fixture(), port = open();
  try {
    port.onMessage.emit({ type: 'update-check', id: '1' });
    reply(natives[0], '1', { available: true });
    port.onMessage.emit({ type: 'update-check', id: '2' });
    reply(natives[0], '2', { available: false });
    await idle(); assert.equal(natives[0].disconnected, true);
    port.onMessage.emit({ type: 'update-status', id: '3' });
    assert.equal(natives.length, 2);
    natives[0].onDisconnect.emit(); reply(natives[0], '3', { phase: 'installed' });
    assert.equal(port.disconnected, false); assert.equal(port.sent.length, 2);
    reply(natives[1], '3', {});
    await idle(); assert.equal(natives[1].disconnected, true);
  } finally { port.disconnect(); }
});

test('updater connections keep page ownership and close on unexpected host failure', async () => {
  const { open, natives, reply } = fixture(), first = open(), second = open();
  try {
    first.onMessage.emit({ type: 'update-check', id: '1' });
    second.onMessage.emit({ type: 'update-check', id: '1' });
    assert.equal(natives.length, 2, 'checked releases are owned by each settings page');
    first.disconnect(); assert.equal(natives[0].disconnected, true);
    assert.equal(natives[1].disconnected, false);
    reply(natives[1], '1', { available: true });
    natives[1].onDisconnect.emit();
    assert.equal(second.disconnected, true);
  } finally { first.disconnect(); second.disconnect(); }
});

test('untrusted updater senders and invalid requests never launch a native helper', () => {
  const { open, natives } = fixture();
  for (const sender of [{ id: 'other', url: 'chrome-extension://test/workspace.html' },
    { id: 'test', url: 'https://example.com/' },
    { id: 'test', url: 'chrome-extension://test/workspace.html', tab: { incognito: true } }]) {
    const port = open(sender); port.onMessage.emit({ type: 'update-check', id: '1' }); port.disconnect();
  }
  const port = open();
  for (const message of [{ type: 'update-check', id: 1 }, { type: 'delete', id: '1' }, { type: 'update-check', id: 'x'.repeat(101) }]) port.onMessage.emit(message);
  assert.equal(natives.length, 0);
  port.disconnect();
});
