import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { installBackground } from '../../features/ai/extension/background.js';
import { HostController } from '../../features/ai/host/controller.mjs';
import { CodexProvider } from '../../features/ai/host/codex.mjs';
import { ClaudeProvider } from '../../features/ai/host/claude.mjs';
import { fakeChrome, panel } from './browser-api-fixture.mjs';

// These run the shipped adapters/host/worker, with CLI and Chrome transports replaced.
// They assert wire data and ordering, not DOM events, gameplay or native hit testing.
const actions = [
  { name: 'browser_mouse', args: { action: 'click', x: 300.5, y: 240 } },
  { name: 'browser_key', args: { key: 'Space', holdMs: 1 } },
  { name: 'browser_key', args: { key: 'w', action: 'down' } },
  { name: 'browser_key', args: { key: 'w', action: 'up' } },
  { name: 'browser_mouse', args: { action: 'down', x: 300, y: 240 } },
  { name: 'browser_mouse', args: { action: 'move', x: 330, y: 260 } },
  { name: 'browser_mouse', args: { action: 'up', x: 330, y: 260 } },
];

function checkCatalog(tools) {
  assert.equal(tools.length, 7);
  assert.ok(tools.find(tool => tool.name === 'browser_mouse').inputSchema.properties.x.type === 'number');
  const key = tools.find(tool => tool.name === 'browser_key').inputSchema.properties;
  assert.ok(key.key.enum.includes('Space') && key.key.enum.includes('w'));
  assert.deepEqual(key.action.enum, ['press', 'down', 'up']);
  assert.equal(key.holdMs.maximum, 5000);
}

function providerFixture(id) {
  let provider;
  let catalogChecks = 0;
  if (id === 'codex') {
    provider = new CodexProvider();
    provider.isolate = async () => ({ cleanup: async () => {} });
    provider.preflight = async (_isolation, _model, tools) => { checkCatalog(tools); catalogChecks++; };
    provider.start = async () => {
      const rpc = new EventEmitter();
      let index = 0;
      const next = () => queueMicrotask(() => {
        if (index === actions.length) rpc.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } });
        else rpc.emit('message', { id: index, method: 'item/tool/call', params: { tool: actions[index].name, arguments: actions[index].args } });
      });
      rpc.request = async (method, params) => {
        if (method === 'thread/start') { checkCatalog(params.dynamicTools); catalogChecks++; return { thread: { id: 'fixture' } }; }
        assert.equal(method, 'turn/start');
        next();
        return {};
      };
      rpc.send = message => {
        assert.equal(message.id, index);
        assert.equal(message.result.success, true);
        assert.match(message.result.contentItems[0].text, /Visible content/);
        index++;
        next();
      };
      rpc.close = async () => { rpc.closed = true; };
      return rpc;
    };
  } else {
    provider = new ClaudeProvider({ createProcess: (_binary, args) => {
      const instructions = args[args.indexOf('--system-prompt') + 1];
      checkCatalog(JSON.parse(instructions.split('Available browser actions:\n')[1]));
      catalogChecks++;
      const rpc = new EventEmitter();
      let index = 0;
      rpc.control = async () => ({});
      rpc.send = message => {
        assert.equal(message.type, 'user');
        if (index > 0) assert.match(message.message.content[0].text, /Visible content/);
        queueMicrotask(() => {
          rpc.emit('message', { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] });
          rpc.emit('message', { type: 'result', subtype: 'success', structured_output: { text: '', action: actions[index++] ?? null } });
        });
      };
      rpc.close = async () => { rpc.closed = true; };
      return rpc;
    } });
  }
  provider.models = [{ id: 'fixture', reasoningEfforts: [] }];
  provider.status = { id, available: true, authenticated: true, models: provider.models };
  provider.authenticated = true;
  provider.discover = async () => provider.status;
  return { provider, checked: () => catalogChecks > 0 };
}

for (const id of ['codex', 'claude']) test(`${id} adapter routes canvas/game actions through host and worker to only the consented tab`, { timeout: 5000 }, async () => {
  const fake = fakeChrome();
  const fixture = providerFixture(id);
  const messages = [];
  let finish;
  const finished = new Promise(resolve => { finish = resolve; });
  const host = new HostController([fixture.provider], message => {
    messages.push(message);
    fake.native.onMessage.emit(message);
    if (message.type === 'complete' || message.type === 'error') finish();
  });
  fake.native.postMessage = message => { fake.native.sent.push(message); void host.receive(message); };
  const worker = installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  port.onMessage.emit({ type: 'chat', id: 'game', provider: id, model: 'fixture', message: 'Start and steer the game', control: true });
  try {
    await finished;
    await worker.tools.lastCleanup;
    assert.deepEqual(messages.filter(message => message.type === 'error'), []);
    assert.ok(fixture.checked());
    assert.deepEqual(messages.filter(message => message.type === 'tool').map(({ name, args }) => ({ name, args })), actions);
    const results = fake.native.sent.filter(message => message.type === 'toolResult');
    assert.equal(results.length, actions.length);
    assert.ok(results.every(message => message.result?.url === fake.tab.url && !message.error));
    const input = fake.calls.filter(call => call[0] === 'input');
    assert.ok(input.every(call => call[1].tabId === 7 && Object.keys(call[1]).length === 1));
    assert.deepEqual(input.map(call => call[3].type), ['mouseMoved', 'mousePressed', 'mouseReleased', 'keyDown', 'keyUp', 'keyDown', 'keyUp', 'mouseMoved', 'mousePressed', 'mouseMoved', 'mouseMoved', 'mouseReleased']);
    assert.deepEqual(input[0][3], { type: 'mouseMoved', x: 300.5, y: 240, buttons: 0 });
    assert.equal(input[3][3].code, 'Space');
    assert.equal(input[5][3].code, 'KeyW');
    assert.equal(worker.tools.session, null);
  } finally { host.close(); await worker.cancel(); }
});
