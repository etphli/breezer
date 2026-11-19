import test from 'node:test';
import assert from 'node:assert/strict';
import { installBackground } from '../../features/ai/extension/background.js';
import { BrowserTools } from '../../features/ai/extension/browser-tools.js';
import { allowedTools, browserTools, validateTool } from '../../features/ai/host/protocol.mjs';
import { fakeChrome, panel, tick } from './browser-api-fixture.mjs';

test('worker reports the browser control startup error for a consented Docs request', async () => {
  const fake = fakeChrome();
  fake.setTab({ url: 'https://docs.google.com/document/d/disposable-fixture/edit' });
  const reason = 'This tab already has an attached debugger.';
  fake.api.debugger.attach = async () => { throw new Error(reason); };
  const worker = installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  port.onMessage.emit({ type: 'chat', id: 'docs', provider: 'codex', model: 'fixture', message: 'Edit this document', control: true });
  try {
    await tick();
    assert.deepEqual(port.sent.filter(message => message.type === 'error'), [{ type: 'error', id: 'docs', source: 'browser-control', error: reason }]);
    assert.ok(!fake.native.sent.some(message => message.type === 'chat'));
    assert.equal(worker.tools.session, null);
  } finally { await worker.cancel(); }
});

test('editor insertion is schema-bounded and unavailable to research or read-only requests', () => {
  const args = { elementId: 'editor', text: 'Hello, Docs!', mode: 'insert' };
  assert.equal(validateTool('browser_type', args, browserTools), args);
  for (const chat of [{ includeContext: true }, { control: false }, { control: true, researchSources: [] }]) {
    assert.throws(() => validateTool('browser_type', args, allowedTools(chat)), /not permitted/);
  }
  for (const change of [{ mode: 'javascript' }, { text: 'a'.repeat(10001) }, { frameId: 'other' }, { selector: 'body' }]) {
    assert.throws(() => validateTool('browser_type', { ...args, ...change }, browserTools));
  }
});

test('selection extends only a navigation press, in both host and worker', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('selection', fake.tab);
  try {
    for (const args of [{ key: 'a', shift: true }, { key: 'Enter', shift: true }, { key: 'ArrowLeft', shift: false }, { key: 'ArrowLeft', shift: true, action: 'down' }, { key: 'ArrowLeft', shift: true, holdMs: 1 }, { key: 'Meta+L' }]) {
      assert.throws(() => validateTool('browser_key', args, browserTools));
      await assert.rejects(tools.execute(session, 'browser_key', args));
    }
    assert.equal(fake.calls.filter(call => call[0] === 'input').length, 0);
    await tools.execute(session, 'browser_key', { key: 'ArrowLeft', shift: true });
    assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3].modifiers), [8, 8]);
  } finally { await tools.stop(); }
});

test('editor insertion preserves the caret and revalidates focus before trusted input', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('insertion', fake.tab);
  try {
    await tools.execute(session, 'browser_type', { elementId: 'editor', text: 'Hello, Docs!', mode: 'insert' });
    const input = fake.calls.filter(call => call[0] === 'input');
    assert.deepEqual(input.map(call => call[2]), ['Input.insertText'], 'no click or select-all resets the caret');
    assert.deepEqual(fake.calls.filter(call => call[0] === 'script' && call[2] === 'check-focus').map(call => call[3]), [{ focusId: 'fixture-editor-focus' }]);
    const inject = fake.api.scripting.executeScript;
    fake.api.scripting.executeScript = async options => {
      if (options.args?.[0] === 'check-focus') throw new Error('The document editor changed.');
      return inject(options);
    };
    await assert.rejects(tools.execute(session, 'browser_type', { elementId: 'editor', text: 'blocked', mode: 'insert' }), /changed/);
    assert.equal(fake.calls.filter(call => call[0] === 'input').length, 1);
  } finally { await tools.stop(); }
});
