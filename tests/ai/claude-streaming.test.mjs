import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ClaudeProvider, partialText } from '../../features/ai/host/claude.mjs';

function fixture() {
  const rpc = new EventEmitter(), events = [], sent = [];
  rpc.send = message => sent.push(message);
  rpc.close = error => rpc.emit('closed', error ?? new Error('Cancelled.'));
  const done = new ClaudeProvider().round(rpc, [], event => events.push(event));
  const start = (index = 0) => rpc.emit('message', { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', name: 'StructuredOutput' } } });
  const push = (partial_json, index = 0) => rpc.emit('message', { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } } });
  const finish = message => rpc.emit('message', { type: 'result', subtype: 'success', ...message });
  return { rpc, events, sent, done, start, push, finish };
}

async function compare(blocks, output, final = { structured_output: output }) {
  const round = fixture(), expected = [];
  try {
    let streamed = '';
    for (const chunks of blocks) {
      round.start(); let json = '';
      for (const chunk of chunks) {
        json += chunk;
        const text = partialText(json);
        if (text.startsWith(streamed)) {
          const delta = text.slice(streamed.length);
          if (delta) expected.push({ type: 'delta', text: delta });
          streamed = text;
        }
        round.push(chunk);
        assert.deepEqual(round.events, expected, JSON.stringify({ json, chunk }));
      }
    }
    if (output.text.startsWith(streamed)) {
      const delta = output.text.slice(streamed.length);
      if (delta) expected.push({ type: 'delta', text: delta });
    } else if (!streamed) expected.push({ type: 'delta', text: output.text });
    if (output.action && output.text) expected.push({ type: 'delta', text: '\n\n' });
    round.finish(final);
    assert.deepEqual(await round.done, output);
    assert.deepEqual(round.events, expected);
    assert.equal(round.rpc.listenerCount('message'), 0);
    assert.equal(round.rpc.listenerCount('closed'), 0);
  } finally {
    if (round.rpc.listenerCount('message')) {
      round.rpc.close(new Error('Fixture comparison ended.'));
      await round.done.catch(() => {});
    }
  }
}

test('actual round matches one-shot prefix semantics at every split and character', async () => {
  const texts = ['', 'hello', 'é😀\ud800\udfff', '\\', '\\\\', '\\u', '\\u0', '\\u012', '\\u0123', '\\u012x', '\\\\u12', 'a"b\\c\n\r\t\b\f\u0000'];
  const fixtures = texts.map(text => [JSON.stringify({ text, action: null }), text]);
  fixtures.push(['{"text":"A\\uD83D\\uDE00\\u00e9\\/Z","action":null}', 'A😀é/Z']);
  fixtures.push(['x"text" \t\n: \r "value","text":"ignored"', 'value']);
  fixtures.push(['{"action":{"text":"nested"},"text":"outer"}', 'outer']);
  for (const [json, text] of fixtures) {
    const output = { text, action: null };
    for (let split = 0; split <= json.length; split++) await compare([[json.slice(0, split), json.slice(split)]], output);
    await compare([[...Array.from({ length: json.length }, (_, i) => json[i])]], output);
  }
});

test('malformed prefixes preserve suppression and final fallback, including action newlines', async () => {
  for (const suffix of ['\\q', '\\uX', '\\u123X', '\n', '\u0000', '\\', '\\u', '\\u12', '\\\\u12']) {
    const json = '{"text":"before' + suffix;
    await compare([[...json]], { text: 'before final', action: { name: 'browser_snapshot', args: {} } });
  }
  await compare([['{"text":123}']], { text: 'fallback', action: null }, { result: '{"text":"fallback","action":null}' });
});

test('overlapping text keys in malformed progress retain one-shot compatibility', async () => {
  for (const json of ['"text"text":"value"', '"text"text" : "value"', '"text"text"text":"value"', '"text" text":"value"']) {
    for (let split = 0; split <= json.length; split++) await compare([[json.slice(0, split), json.slice(split)]], { text: 'final fallback', action: null });
    await compare([[...json]], { text: 'final fallback', action: null });
  }
});

test('multiple StructuredOutput blocks match only the already emitted prefix', async () => {
  for (const texts of [['abc', 'abcde'], ['abc', 'abd'], ['abc', 'a'], ['abc', ''], ['', 'xyz']]) {
    await compare(texts.map(text => [...JSON.stringify({ text, action: null })]), { text: texts.at(-1), action: null });
  }
});

test('unrelated blocks, control requests and final validation keep existing boundaries', async () => {
  const round = fixture(); round.start(2);
  round.push('{"text":"ignored"}', 1);
  round.rpc.emit('message', { type: 'control_request', request_id: 'native' });
  assert.match(round.sent.at(-1).response.error, /No native tool/);
  assert.equal(round.events.length, 0);
  round.finish({ structured_output: { text: 'invalid' } });
  await assert.rejects(round.done, /browser-assistant response/);
  assert.equal(round.rpc.listenerCount('message'), 0);
  for (const message of [
    { type: 'result', subtype: 'error', errors: ['fixture failure'] },
    { type: 'result', subtype: 'success', result: '{broken' },
    { type: 'system', subtype: 'init', tools: ['Bash'] },
    { type: 'system', subtype: 'init', tools: ['StructuredOutput'], mcp_servers: ['foreign'] },
  ]) {
    const failed = fixture(); failed.rpc.emit('message', message);
    await assert.rejects(failed.done);
    assert.equal(failed.rpc.listenerCount('message'), 0);
    assert.equal(failed.rpc.listenerCount('closed'), 0);
  }
  const cancelled = fixture(); cancelled.start(); cancelled.push('{"text":"partial\\u');
  cancelled.rpc.close(new Error('Cancelled.'));
  await assert.rejects(cancelled.done, /Cancelled/);
  assert.equal(cancelled.rpc.listenerCount('message'), 0);
  assert.equal(cancelled.rpc.listenerCount('closed'), 0);
});

test('actual chat cancellation closes fake RPC and removes abort and round listeners', async () => {
  const rpc = new EventEmitter(), abort = new AbortController();
  let closes = 0;
  rpc.control = async () => ({});
  rpc.close = error => { closes++; rpc.emit('closed', error ?? new Error('Closed.')); };
  rpc.send = message => {
    if (message.type === 'user') queueMicrotask(() => abort.abort());
  };
  const provider = new ClaudeProvider({ createProcess: () => rpc });
  provider.status = { available: true }; provider.authenticated = true;
  provider.defaultModel = 'fake'; provider.models = [{ id: 'fake', reasoningEfforts: [] }];
  const { getEventListeners } = await import('node:events');
  await assert.rejects(provider.chat({ message: 'offline fixture' }, {
    signal: abort.signal, emit() {}, callTool() { assert.fail('no action requested'); },
  }), /Cancelled/);
  assert.equal(closes, 2);
  assert.equal(getEventListeners(abort.signal, 'abort').length, 0);
  assert.equal(rpc.listenerCount('message'), 0);
  assert.equal(rpc.listenerCount('closed'), 0);
});
