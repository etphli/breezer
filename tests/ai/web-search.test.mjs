import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { ClaudeProvider, claudeSafeArgs } from '../../features/ai/host/claude.mjs';
import { CodexProvider, verifyCodexTools } from '../../features/ai/host/codex.mjs';
import { HostController } from '../../features/ai/host/controller.mjs';
import { allowedTools, browserAccess, browserTools, promptText, validateChat } from '../../features/ai/host/protocol.mjs';
import { detectBrowserTask } from '../../features/ai/extension/browser-task-intent.js';

const url = 'https://duckduckgo.com/?q=' + encodeURIComponent('lisbon tower hours & "tickets"');
const results = { url: 'https://duckduckgo.com/', title: 'Results', text: 'Untrusted result text' };

function ready(provider) {
  provider.models = [{ id: 'fixture', reasoningEfforts: [] }];
  provider.status = { available: true };
  provider.authenticated = true;
  provider.discover = async () => provider.status;
  return provider;
}

function codexFixture(seen) {
  const provider = ready(new CodexProvider());
  provider.isolate = async () => ({ cleanup: async () => {} });
  provider.preflight = async () => {};
  provider.start = async () => {
    const rpc = new EventEmitter();
    rpc.request = async (method, params) => {
      if (method === 'turn/start') seen.push(JSON.stringify(params.input));
      if (method === 'thread/start') {
        assert.equal(params.config.web_search, 'disabled', 'provider-hosted search stays off');
        assert.ok(params.dynamicTools.some(tool => tool.name === 'browser_navigate'));
        return { thread: { id: 'search' } };
      }
      queueMicrotask(() => rpc.emit('message', { id: 4, method: 'item/tool/call', params: { tool: 'browser_navigate', arguments: { url } } }));
      return {};
    };
    rpc.send = message => {
      seen.push(JSON.stringify(message.result));
      rpc.emit('message', { method: 'item/agentMessage/delta', params: { delta: 'Found it.' } });
      rpc.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } });
    };
    rpc.close = async () => {};
    return rpc;
  };
  return provider;
}

function claudeFixture(seen) {
  return ready(new ClaudeProvider({ createProcess: (_binary, args) => {
    assert.deepEqual(args.slice(0, claudeSafeArgs.length), claudeSafeArgs, 'native tools stay off');
    const rpc = new EventEmitter();
    let round = 0;
    rpc.control = async () => ({});
    rpc.close = async () => {};
    rpc.send = message => {
      seen.push(JSON.stringify(message.message.content));
      round++;
      const output = round === 1 ? { text: 'Searching.', action: { name: 'browser_navigate', args: { url } } } : { text: 'Found it.', action: null };
      queueMicrotask(() => {
        rpc.emit('message', { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: [] });
        rpc.emit('message', { type: 'result', subtype: 'success', structured_output: output });
      });
    };
    return rpc;
  } }));
}

for (const [id, fixture] of [['codex', codexFixture], ['claude', claudeFixture]]) {
  test(`${id} completes a requested search through the controlled browser tab`, { timeout: 5000 }, async () => {
    const seen = [], actions = [], replies = [];
    const host = new HostController([fixture(seen)], message => {
      if (message.type !== 'tool') { replies.push(message); return; }
      actions.push(message);
      void host.receive({ type: 'toolResult', id: message.id, requestId: message.requestId, result: results });
    });
    await host.receive({ type: 'chat', id: 'search', provider: id, model: 'fixture', message: 'Search the web for tower hours', control: true });
    assert.match(seen[0], /You can search the web with browser_navigate/, 'the turn tells the model how to search');
    assert.deepEqual(actions.map(({ name, args }) => ({ name, args })), [{ name: 'browser_navigate', args: { url } }]);
    assert.ok(seen[1].includes('Untrusted result text'), 'the page snapshot returns to the model');
    assert.equal(replies.at(-1).type, 'complete');
    assert.match(replies.map(message => message.text).join(''), /Found it\./);
  });
}

test('search adds no tool and has no path outside Browser control', async () => {
  assert.equal(browserTools.some(tool => /search/i.test(tool.name)), false);
  const declarations = browserTools.map(tool => ({ type: 'function', name: tool.name }));
  assert.throws(() => verifyCodexTools([...declarations, { type: 'web_search' }], browserTools), /outside/);
  for (const chat of [{}, { includeContext: true }]) {
    const messages = [];
    const host = new HostController([{ id: 'codex', discover: async () => ({}), chat: (_chat, api) => api.callTool('browser_navigate', { url }, browserTools) }],
      message => messages.push(message));
    await host.receive(validateChat({ type: 'chat', id: 'off', provider: 'codex', model: 'fixture', message: 'Search', ...chat }));
    assert.equal(messages.some(message => message.type === 'tool'), false);
    assert.match(messages.at(-1).error, /not permitted/);
  }
  for (const chat of [{ researchSources: [{}] }, { context: { kind: 'pdf-view' } }]) assert.deepEqual(allowedTools(chat), []);
});

test('each access mode says how a requested search can run', () => {
  assert.match(browserAccess({ control: true }), /You can search the web with browser_navigate/);
  for (const chat of [{}, { includeContext: true }, { researchSources: [{}] }, { context: { kind: 'pdf-view' } }]) {
    assert.match(browserAccess(chat), /search block/);
    assert.match(browserAccess(chat), /Never claim that you searched/);
    assert.doesNotMatch(browserAccess(chat), /browser_navigate/);
  }
  const prompt = promptText({ message: 'Show me a picture of the tower' });
  assert.match(prompt, /image that already exists/);
  assert.match(prompt, /cannot generate images in this reply/);
});

test('existing images stay in chat while new artwork uses image generation', () => {
  const task = text => detectBrowserTask(text, { allowImage: true });
  for (const text of ['Create an image of a blue pear', 'Draw a picture of a spider hanging from the web', 'Generate an image of a page turning in a storybook',
    'Make a poster showing the history of websites']) assert.equal(task(text), 'image', text);
  for (const text of ['Show me an image of the Eiffel Tower', 'Find a picture of a fox', 'Link to a photo of the tower', 'What is the source of this image?',
    'Make an image of the chart on this page', 'Create an image of the photo at https://images.example/a.png', 'Make a picture of the tower from Wikipedia']) {
    assert.equal(task(text), '', text);
  }
});
