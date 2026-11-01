import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackground } from '../../features/ai/extension/background.js';
import { fakeChrome, event, tick } from './browser-api-fixture.mjs';

function fixture() {
  const fake = fakeChrome(), natives = [];
  fake.api.runtime.id = 'test';
  fake.api.runtime.getURL = file => `chrome-extension://test/${file}`;
  fake.api.runtime.connectNative = () => {
    const connection = { sent: [], disconnected: false, onMessage: event(), onDisconnect: event(),
      postMessage(message) { this.sent.push(message); },
      disconnect() { this.disconnected = true; this.onDisconnect.emit(); },
    };
    natives.push(connection);
    return connection;
  };
  installBackground(fake.api);
  const open = () => {
    const port = { name: 'breezer-organato-settings', sender: { id: 'test', url: fake.api.runtime.getURL('workspace.html') },
      sent: [], onMessage: event(), onDisconnect: event(), postMessage(message) { this.sent.push(message); } };
    fake.api.runtime.onConnect.emit(port);
    return port;
  };
  const port = open();
  const answer = (native, index = 0) => native.onMessage.emit({ id: native.sent[index].id, type: 'organato-result', ok: true, value: { connected: false } });
  return { port, open, natives, answer };
}

test('an open settings page starts no helper until a request and releases the idle helper', async () => {
  const { port, natives, answer } = fixture();
  try {
    assert.equal(natives.length, 0);
    port.onMessage.emit({ id: 'first', type: 'view' });
    assert.equal(natives.length, 1);
    answer(natives[0]);
    await tick();
    assert.equal(port.sent[0].ok, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(natives[0].disconnected, true);
    assert.equal(port.sent.length, 1, 'idle shutdown is not an error');
    port.onMessage.emit({ id: 'second', type: 'view' });
    assert.equal(natives.length, 2);
    answer(natives[1]);
    await tick();
    assert.equal(port.sent[1].ok, true, 'a later request reconnects');
  } finally { port.onDisconnect.emit(); }
});

test('progress and overlapping requests retain the helper until every request finishes', async () => {
  const { port, natives, answer } = fixture();
  try {
    port.onMessage.emit({ id: 'configure', type: 'configure', settings: { enabled: false } });
    port.onMessage.emit({ id: 'view', type: 'view' });
    assert.equal(natives.length, 1);
    const native = natives[0];
    native.onMessage.emit({ type: 'organato-progress', id: native.sent[0].id, stage: 'Saving' });
    assert.equal(port.sent[0].stage, 'Saving');
    answer(native);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(native.disconnected, false, 'pending work prevents idle shutdown');
    answer(native, 1);
    await tick();
    assert.equal(port.sent.filter(message => message.ok).length, 2);
  } finally { port.onDisconnect.emit(); }
  assert.equal(natives[0].disconnected, true);
});

test('pages share one helper and route colliding UI request IDs independently', async () => {
  const { port, open, natives, answer } = fixture(), other = open();
  try {
    port.onMessage.emit({ id: '1', type: 'configure', settings: { enabled: false } });
    other.onMessage.emit({ id: '1', type: 'view' });
    assert.equal(natives.length, 1);
    const native = natives[0];
    assert.notEqual(native.sent[0].id, native.sent[1].id);
    native.onMessage.emit({ type: 'organato-progress', id: native.sent[0].id, stage: 'Saving' });
    assert.equal(port.sent[0].stage, 'Saving');
    assert.equal(other.sent.length, 0);
    answer(native, 1);
    await tick();
    assert.equal(other.sent[0].ok, true);
    assert.equal(port.sent.length, 1);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(native.disconnected, false, 'the other page still has pending work');
    answer(native, 0);
    await tick();
    assert.equal(port.sent[1].ok, true);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(native.disconnected, true);
  } finally { port.onDisconnect.emit(); other.onDisconnect.emit(); }
});

test('closing one page leaves another page request alive and ignores late replies', async () => {
  const { port, open, natives, answer } = fixture(), other = open();
  try {
    port.onMessage.emit({ id: 'closed', type: 'view' });
    other.onMessage.emit({ id: 'alive', type: 'view' });
    assert.equal(natives.length, 1);
    const native = natives[0];
    port.onDisconnect.emit();
    assert.equal(native.disconnected, false);
    answer(native, 0);
    answer(native, 1);
    await tick();
    assert.equal(port.sent.length, 0);
    assert.equal(other.sent[0].ok, true);
  } finally { port.onDisconnect.emit(); other.onDisconnect.emit(); }
  assert.equal(natives[0].disconnected, true);
});

test('a shared helper exit fails each pending request and a later page reconnects', async () => {
  const { port, open, natives, answer } = fixture(), other = open();
  try {
    port.onMessage.emit({ id: 'first', type: 'view' });
    other.onMessage.emit({ id: 'second', type: 'view' });
    assert.equal(natives.length, 1);
    natives[0].onDisconnect.emit();
    await tick();
    assert.equal(port.sent[0].ok, false);
    assert.equal(other.sent[0].ok, false);
    other.onMessage.emit({ id: 'retry', type: 'view' });
    assert.equal(natives.length, 2);
    answer(natives[1]);
    await tick();
    assert.equal(other.sent[1].ok, true);
  } finally { port.onDisconnect.emit(); other.onDisconnect.emit(); }
});
