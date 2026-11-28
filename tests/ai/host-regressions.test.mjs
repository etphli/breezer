import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { allowedTools, promptText } from '../../features/ai/host/protocol.mjs';
import { HostController } from '../../features/ai/host/controller.mjs';
import { ClaudeProvider } from '../../features/ai/host/claude.mjs';
import { CodexProvider } from '../../features/ai/host/codex.mjs';
import { runCli } from '../../features/ai/host/cli.mjs';

const names = tools => tools.map(tool => tool.name).filter(name => name.startsWith('organato_'));
const chat = { type: 'chat', id: 'r3', provider: 'codex', model: 'fake', message: 'Plan my week' };

test('Organato writes are not offered with page context, and nothing Organato with browser control', () => {
  assert.deepEqual(names(allowedTools({ organato: true })), ['organato_list_items', 'organato_create_item', 'organato_update_item']);
  assert.deepEqual(names(allowedTools({ organato: true, includeContext: true })), ['organato_list_items']);
  assert.deepEqual(names(allowedTools({ organato: true, includeContext: true, context: { title: 'x' } })), ['organato_list_items']);
  assert.deepEqual(names(allowedTools({ organato: true, control: true })), []);
  assert.deepEqual(names(allowedTools({ organato: true, control: true, includeContext: true })), []);
  // Browser tools are unchanged.
  assert.deepEqual(allowedTools({ organato: true, control: true }).map(tool => tool.name), allowedTools({ control: true }).map(tool => tool.name));
  assert.deepEqual(allowedTools({ organato: true, includeContext: true })[0].name, 'browser_snapshot');

  assert.match(promptText({ ...chat, organato: true }), /Organato access is enabled/);
  const readOnly = promptText({ ...chat, organato: true, includeContext: true });
  assert.doesNotMatch(readOnly, /Organato access is enabled/);
  assert.match(readOnly, /read-only while a page is shared/);
  const control = promptText({ ...chat, organato: true, control: true });
  assert.doesNotMatch(control, /Organato access is enabled/);
  assert.match(control, /Organato tools are unavailable while Browser control is on/);
  assert.doesNotMatch(promptText({ ...chat, organato: false, control: true }), /Organato/);
});

async function organatoRun(fields, toolName, args) {
  const integration = [], messages = [];
  let outcome;
  const provider = {
    id: 'codex',
    async discover() { return { id: 'codex', available: true, authenticated: true }; },
    async chat(_request, { callTool }) {
      outcome = await callTool(toolName, args).then(value => ({ value }), error => ({ error: error.message }));
    },
  };
  const host = new HostController([provider], message => messages.push(message), {
    prepareChat: async () => true,
    integrationTool: async (name, toolArgs) => { integration.push([name, toolArgs]); return { ok: true }; },
  });
  await host.receive({ ...chat, ...fields });
  return { integration, outcome, messages };
}

test('the host rejects Organato write calls that were not offered for the run', async () => {
  const create = ['organato_create_item', { kind: 'todo', displayName: 'Injected' }];
  const update = ['organato_update_item', { id: 'a', version: 1, workingStatus: 'completed' }];
  for (const fields of [{ includeContext: true, context: { title: 'Page' } }, { control: true, includeContext: true, context: { title: 'Page' } }]) {
    for (const [name, args] of [create, update]) {
      const run = await organatoRun(fields, name, args);
      assert.match(run.outcome.error, /not permitted/, `${name} with ${JSON.stringify(fields)}`);
      assert.deepEqual(run.integration, []);
    }
  }
  const listed = await organatoRun({ control: true, includeContext: true, context: { title: 'Page' } }, 'organato_list_items', {});
  assert.match(listed.outcome.error, /not permitted/);
  assert.deepEqual(listed.integration, []);
  // Page shared read-only still reads; a plain chat keeps writes.
  const read = await organatoRun({ includeContext: true, context: { title: 'Page' } }, 'organato_list_items', {});
  assert.deepEqual(read.integration, [['organato_list_items', {}]]);
  const plain = await organatoRun({}, ...create);
  assert.deepEqual(plain.integration, [create]);
});

function claudeRound() {
  const rpc = new EventEmitter(), events = [];
  rpc.send = () => {}; rpc.close = () => {};
  const done = new ClaudeProvider().round(rpc, [], event => events.push(event));
  const start = index => rpc.emit('message', { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', name: 'StructuredOutput' } } });
  const push = (index, partial_json) => rpc.emit('message', { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } } });
  const finish = output => rpc.emit('message', { type: 'result', subtype: 'success', structured_output: output });
  return { rpc, events, done, start, push, finish };
}

const applyEvents = events => events.reduce((text, event) => event.type === 'replace' ? text.slice(0, text.length - event.remove) + event.text : text + event.text, '');

test('a retried Claude StructuredOutput replaces the streamed text with the final answer', async () => {
  const round = claudeRound();
  round.start(0); round.push(0, '{"text":"The answer is 4');
  round.start(1); round.push(1, '{"text":"The answer is 5.","action":null}');
  round.finish({ text: 'The answer is 5.', action: null });
  await round.done;
  assert.deepEqual(round.events, [{ type: 'delta', text: 'The answer is 4' }, { type: 'replace', remove: 15, text: 'The answer is 5.' }]);
  assert.equal(applyEvents(round.events), 'The answer is 5.');

  // A replaced step keeps text from earlier steps and the separator before the next action.
  const action = claudeRound();
  action.start(0); action.push(0, '{"text":"Clicking A');
  action.finish({ text: 'Clicking B', action: { name: 'browser_snapshot', args: {} } });
  await action.done;
  assert.equal(applyEvents([{ type: 'delta', text: 'Earlier.\n\n' }, ...action.events]), 'Earlier.\n\nClicking B\n\n');
});

test('the controller forwards a replace event to the extension in order', async () => {
  const messages = [];
  const provider = {
    id: 'claude',
    async discover() { return { id: 'claude', available: true, authenticated: true }; },
    async chat(_request, { emit }) { emit({ type: 'delta', text: 'wrong' }); emit({ type: 'replace', remove: 5, text: 'right' }); },
  };
  await new HostController([provider], message => messages.push(message)).receive({ ...chat, provider: 'claude' });
  assert.deepEqual(messages.map(({ type, text, remove }) => [type, text, remove]), [['delta', 'wrong', undefined], ['replace', 'right', 5], ['complete', undefined, undefined]]);
});

test('a Claude round whose send throws cleans up its timer and listeners', async () => {
  const rpc = new EventEmitter();
  rpc.send = () => { throw new Error('Claude Code closed.'); };
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout;
  const live = new Set();
  globalThis.setTimeout = (fn, ms, ...rest) => { const timer = realSetTimeout(fn, ms, ...rest); live.add(timer); return timer; };
  globalThis.clearTimeout = timer => { live.delete(timer); return realClearTimeout(timer); };
  let round;
  try { round = new ClaudeProvider().round(rpc, [], () => {}); }
  finally { globalThis.setTimeout = realSetTimeout; globalThis.clearTimeout = realClearTimeout; }
  const leaked = [...live];
  for (const timer of leaked) realClearTimeout(timer);
  await assert.rejects(round, /Claude Code closed/);
  assert.equal(leaked.length, 0, 'the five-minute turn timer must be cleared');
  assert.equal(rpc.listenerCount('message'), 0);
  assert.equal(rpc.listenerCount('closed'), 0);
});

test('separate Codex agent messages in one turn are separated by a blank line', async () => {
  const rpc = new EventEmitter(); rpc.closed = false; rpc.send = () => {}; rpc.close = () => { rpc.closed = true; };
  const delta = (itemId, text) => rpc.emit('message', { method: 'item/agentMessage/delta', params: { threadId: 't', turnId: 'u', itemId, delta: text } });
  rpc.request = async method => {
    if (method === 'thread/start') return { thread: { id: 't' } };
    if (method === 'turn/start') setImmediate(() => {
      delta('a', 'I will check'); delta('a', ' the page.');
      delta('b', '## Result\nThe page says hi.');
      delta('c', ''); delta('c', 'Done.');
      rpc.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } });
    });
    return {};
  };
  const provider = new CodexProvider();
  provider.models = [{ id: 'm', reasoningEfforts: [], defaultReasoningEffort: null, fastMode: { supported: false } }];
  provider.status = { available: true }; provider.authenticated = true;
  provider.isolate = async () => ({ cleanup: async () => {} }); provider.preflight = async () => {}; provider.start = async () => rpc;
  let text = '';
  const signal = new AbortController().signal;
  await provider.chat({ ...chat, model: 'm' }, { signal, emit: event => { text += event.text; }, callTool: async () => ({}) });
  assert.equal(text, 'I will check the page.\n\n## Result\nThe page says hi.\n\nDone.');
  assert.equal(getEventListeners(signal, 'abort').length, 0);
});

test('runCli decodes a UTF-8 character split across output chunks', async () => {
  const script = `const json = Buffer.from(JSON.stringify({ models: [{ slug: 'x', base_instructions: 'a — b 😀' }] }));
const cut = json.indexOf(0xe2) + 1, emoji = json.indexOf(0xf0) + 2;
process.stdout.write(json.subarray(0, cut));
setTimeout(() => { process.stdout.write(json.subarray(cut, emoji)); setTimeout(() => process.stdout.write(json.subarray(emoji)), 30); }, 30);`;
  const result = await runCli(process.execPath, ['-e', script], { env: process.env });
  assert.equal(JSON.parse(result.stdout).models[0].base_instructions, 'a — b 😀');
});
