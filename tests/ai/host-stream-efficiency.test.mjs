import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import { loadHistoricalHost } from './fixtures/host-main-port/historical-host.mjs';
import { JsonLineProcess } from '../../features/ai/host/cli.mjs';
import { HostController } from '../../features/ai/host/controller.mjs';
import { encodeMessage, MAX_OUTPUT_BYTES } from '../../features/ai/host/protocol.mjs';
import { CodexProvider } from '../../features/ai/host/codex.mjs';
import { ClaudeProvider } from '../../features/ai/host/claude.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const { HostController: BeforeHost } = await loadHistoricalHost('controller');
const { JsonLineProcess: BeforeCli } = await loadHistoricalHost('cli');
const delta = text => ({ method: 'item/agentMessage/delta', params: { delta: text } });
const complete = { method: 'turn/completed', params: { turn: { status: 'completed' } } };
const claudeStart = { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'StructuredOutput' } } };
const claudeDelta = text => ({ type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: text } } });
const claudeResult = (text, action = null) => ({ type: 'result', subtype: 'success', structured_output: { text, action } });
function canonical(events) {
  const result = [];
  for (const event of events) {
    if (event.type === 'delta' && result.at(-1)?.type === 'delta' && event.id === result.at(-1).id) result.at(-1).text += event.text;
    else result.push({ ...event, ...(event.type === 'tool' ? { requestId: '<uuid>' } : {}) });
  }
  return result;
}
async function fixture({ before = false, kind = 'codex', onSend, custom } = {}) {
  const child = new EventEmitter(), messages = [], writes = [], kills = [];
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  const lines = values => values.map(value => JSON.stringify(value)).join('\n') + '\n';
  child.stdin = new Writable({ write(chunk, _encoding, callback) {
    const message = JSON.parse(String(chunk)); writes.push(message); callback();
    if (message.id && ['thread/start', 'turn/start'].includes(message.method)) queueMicrotask(() => child.stdout.write(lines([{ id: message.id, result: message.method === 'thread/start' ? { thread: { id: 'thread' } } : { turn: { id: 'turn' } } }])));
  } });
  child.kill = signal => { kills.push(signal); if (child.exitCode === null) { child.exitCode = 0; queueMicrotask(() => child.emit('close', 0)); } return true; };
  const Transport = before ? BeforeCli : JsonLineProcess;
  const rpc = new Transport('/fake-only', [], { env: {}, cwd: '/fake-only', spawnProcess: () => child });
  let provider;
  if (custom) provider = { id: 'codex', discover: async () => ({}), chat: apiChat };
  else if (kind === 'claude') {
    const real = new ClaudeProvider();
    // Use the actual structured-output parser and emitter, without filesystem setup.
    provider = { id: 'claude', discover: async () => ({}), async chat(_chat, api) {
      const result = await real.round(rpc, [], api.emit);
      if (result.action) await api.callTool(result.action.name, result.action.args);
      await rpc.close();
    } };
  } else {
    provider = new CodexProvider();
    provider.status = { available: true }; provider.authenticated = true;
    provider.models = [{ id: 'fixture', reasoningEfforts: [] }];
    provider.discover = async () => ({}); provider.isolate = async () => ({ cleanup: async () => {} });
    provider.preflight = async () => {}; provider.start = async () => rpc;
  }
  function apiChat(_chat, api) {
    return new Promise((resolve, reject) => {
      rpc.on('message', event => custom(event, api, resolve, reject));
      rpc.on('closed', reject);
      api.signal.addEventListener('abort', () => { rpc.close(); resolve(); }, { once: true });
    });
  }
  const Controller = before ? BeforeHost : HostController;
  const host = new Controller([provider], message => { encodeMessage(message); messages.push(message); onSend?.(message, host, child); });
  const run = host.receive({ type: 'chat', id: 'stream', provider: provider.id, model: 'fixture', message: 'test', control: true });
  await tick();
  return { rpc, child, host, run, messages, writes, kills,
    push(values) { child.stdout.write(lines(values)); },
    async dispose() { host.close(); await rpc.close(); await run; child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); },
  };
}

test('actual provider emit chains batch multiple JSON lines in one chunk with baseline negative controls', async () => {
  for (const kind of ['codex', 'claude']) {
    const rows = [];
    for (const before of [true, false]) {
      const f = await fixture({ before, kind });
      try {
        f.push(kind === 'codex' ? [delta('hello '), delta('é'), delta('😀'), complete] : [claudeStart, claudeDelta('{"text":"hello '), claudeDelta('é'), claudeDelta('😀'), claudeResult('hello é😀')]);
        // The parser turn flushes before write returns, without a microtask or timer.
        assert.equal(f.messages.filter(m => m.type === 'delta').length, before ? 3 : 1);
        await f.run; rows.push(f.messages);
      } finally { await f.dispose(); }
    }
    assert.deepEqual(canonical(rows[1]), canonical(rows[0]));
    console.log(JSON.stringify({ fixture: kind + '-3-lines-one-chunk', beforeNativeDeltas: rows[0].filter(m => m.type === 'delta').length, afterNativeDeltas: rows[1].filter(m => m.type === 'delta').length, beforeNativeFrames: rows[0].length, afterNativeFrames: rows[1].length, text: canonical(rows[1])[0].text }));
  }
});

test('separate parser turns and every UTF-8 split preserve text, IDs and completion', async () => {
  const wire = Buffer.from([delta('é😀'), delta('\0"\\\ud800'), complete].map(JSON.stringify).join('\n') + '\n');
  for (let split = 0; split <= wire.length; split++) {
    const f = await fixture();
    try {
      f.child.stdout.write(wire.subarray(0, split)); f.child.stdout.write(wire.subarray(split)); await f.run;
      assert.deepEqual(canonical(f.messages), [{ type: 'delta', id: 'stream', text: 'é😀\0"\\\ud800' }, { type: 'complete', id: 'stream' }]);
    } finally { await f.dispose(); }
  }
  const f = await fixture();
  try { f.push([delta('a')]); assert.equal(f.messages.length, 1); f.push([delta('b')]); assert.equal(f.messages.length, 2); f.push([complete]); await f.run; }
  finally { await f.dispose(); }
});

test('nontext parser messages break batches, including deferred Codex tool requests', async () => {
  const f = await fixture();
  try {
    f.push([delta('a'), { id: 77, method: 'item/tool/call', params: { tool: 'browser_snapshot', arguments: {} } }, delta('b')]);
    assert.deepEqual(f.messages.map(m => m.text), ['a', 'b']);
    await tick(); const tool = f.messages.find(m => m.type === 'tool'); assert.ok(tool);
    await f.host.receive({ type: 'toolResult', id: 'stream', requestId: tool.requestId, result: { text: 'ok' } });
    await tick(); assert.equal(f.writes.find(m => m.id === 77).result.success, true);
    f.push([complete]); await f.run;
  } finally { await f.dispose(); }
});

test('nontext emitted events and synchronous tool calls flush before forwarding', async () => {
  const f = await fixture({ custom(event, api, resolve) {
    if (event.type === 'tool') { void api.callTool('browser_snapshot', {}).catch(() => {}); }
    else if (event.type === 'done') resolve();
    else api.emit(event);
  } });
  try {
    f.push([{ type: 'delta', text: 'a' }, { type: 'usage', value: 2 }, { type: 'delta', text: 'b' }, { type: 'tool' }, { type: 'done' }]);
    await f.run; assert.deepEqual(f.messages.map(m => m.type), ['delta', 'usage', 'delta', 'tool', 'complete']);
  } finally { await f.dispose(); }
});

test('long deltas respect exact native frame limits without unbounded pending fragments', async () => {
  const emptyBytes = encodeMessage({ type: 'delta', text: '', id: 'stream' }).length - 4;
  const exact = 'x'.repeat(MAX_OUTPUT_BYTES - emptyBytes);
  for (const parts of [[exact.slice(0, 10), exact.slice(10)], [exact, 'é'], ['\ud83d', '\ude00'], Array(300).fill('')]) {
    const f = await fixture();
    try {
      f.push([...parts.map(delta), complete]); await f.run;
      assert.equal(f.messages.filter(m => m.type === 'delta').map(m => m.text).join(''), parts.join(''));
      for (const m of f.messages) assert.ok(encodeMessage(m).length - 4 <= MAX_OUTPUT_BYTES);
      assert.equal(f.messages.filter(m => m.type === 'delta').length, parts.length === 300 || parts[0] === exact ? 2 : 1);
    } finally { await f.dispose(); }
  }
  for (const before of [true, false]) {
    const f = await fixture({ before });
    try { f.push([delta(exact + 'x'), complete]); await f.run; assert.match(f.messages.at(-1).error, /Invalid CLI response: Native response is too large/); }
    finally { await f.dispose(); }
  }
});

test('malformed JSON, listener exceptions and provider terminal errors retain text/error order', async () => {
  for (const mode of ['malformed', 'listener', 'provider', 'send']) {
    const rows = [];
    for (const before of [true, false]) {
      let failed = false;
      const f = await fixture({ before, onSend(m) { if (mode === 'send' && m.type === 'delta' && !failed) { failed = true; throw new Error('send failed'); } } });
      try {
        if (mode === 'listener') f.rpc.on('message', m => { if (m.method === 'fixture-error') throw new Error('listener failed'); });
        if (mode === 'malformed') f.child.stdout.write(JSON.stringify(delta('kept')) + '\n{broken}\n');
        else f.push([delta('kept'), mode === 'send' ? complete : mode === 'listener' ? { method: 'fixture-error' } : { method: 'turn/completed', params: { turn: { status: 'failed', error: { message: 'provider failed' } } } }]);
        await f.run; rows.push(canonical(f.messages));
      } finally { await f.dispose(); }
    }
    assert.deepEqual(rows[1], rows[0]); assert.equal(rows[1][0].text, 'kept'); assert.equal(rows[1].at(-1).type, 'error');
  }
});

test('cancel reentrancy, shutdown and late output never leak buffered text across runs', async () => {
  for (const ending of ['cancel', 'close']) {
    const f = await fixture({ onSend(message, host) { if (message.type === 'delta') { if (ending === 'cancel') void host.receive({ type: 'cancel', id: 'stream' }); else host.close(); } } });
    try {
      f.push([delta('a'), delta('b'), complete]); await f.run;
      assert.deepEqual(f.messages.map(m => m.type), ['delta', 'complete']); assert.equal(f.messages.at(-1).cancelled, true);
      const previous = f.messages.length; f.push([delta('late')]); assert.equal(f.messages.length, previous);
    } finally { await f.dispose(); }
  }
});

test('Claude terminal suffix, separator, action and failure sequences retain baseline order', async () => {
  for (const failed of [false, true]) {
    const rows = [];
    for (const before of [true, false]) {
      const f = await fixture({ before, kind: 'claude' });
      try {
        f.push([claudeStart, claudeDelta('{"text":"a'), failed ? { type: 'result', subtype: 'error', errors: ['Claude fixture failure'] } : claudeResult('abcd', { name: 'browser_snapshot', args: {} })]);
        await tick();
        if (!failed) {
          const tool = f.messages.find(m => m.type === 'tool'); assert.ok(tool);
          assert.deepEqual(f.messages.filter(m => m.type === 'delta').map(m => m.text), ['a', 'bcd', '\n\n']);
          await f.host.receive({ type: 'toolResult', id: 'stream', requestId: tool.requestId, result: { text: 'ok' } });
        }
        await f.run; rows.push(canonical(f.messages));
      } finally { await f.dispose(); }
    }
    assert.deepEqual(rows[1], rows[0]);
  }
});

test('nested parser callbacks keep baseline concatenation and terminal ordering', async () => {
  const rows = [];
  for (const before of [true, false]) {
    const f = await fixture({ before });
    try {
      f.rpc.once('message', () => f.child.stdout.emit('data', JSON.stringify(delta('nested')) + '\n'));
      f.push([delta('a'), delta('b'), complete]); await f.run; rows.push(canonical(f.messages));
    } finally { await f.dispose(); }
  }
  assert.deepEqual(rows[1], rows[0]);
});

test('a nontext emission inside a text parser message flushes before the event', async () => {
  const f = await fixture({ custom(event, api, resolve) {
    if (event.method === 'done') { resolve(); return; }
    api.emit({ type: 'delta', text: event.params.delta });
    if (event.params.usage) api.emit({ type: 'usage', value: 1 });
  } });
  try {
    f.push([delta('a'), { method: 'item/agentMessage/delta', params: { delta: 'b', usage: true } }, delta('c'), { method: 'done' }]);
    await f.run; assert.deepEqual(canonical(f.messages), [
      { type: 'delta', id: 'stream', text: 'ab' }, { type: 'usage', id: 'stream', value: 1 }, { type: 'delta', id: 'stream', text: 'c' }, { type: 'complete', id: 'stream' },
    ]);
  } finally { await f.dispose(); }
});

test('replacement runs cannot receive pending or late text from a cancelled run', async () => {
  const f = await fixture({ custom(event, api, resolve) {
    if (event.method === 'done') resolve();
    else api.emit({ type: 'delta', text: event.params.delta });
  } });
  try {
    f.push([delta('old')]); await f.host.receive({ type: 'cancel', id: 'stream' }); await f.run;
    const next = f.host.receive({ type: 'chat', id: 'replacement', provider: 'codex', message: 'next' });
    await tick(); f.push([delta('new'), { method: 'done' }]); await next;
    assert.deepEqual(f.messages.map(m => [m.type, m.id, m.text]), [
      ['delta', 'stream', 'old'], ['complete', 'stream', undefined], ['delta', 'replacement', 'new'], ['complete', 'replacement', undefined],
    ]);
  } finally { await f.dispose(); }
});

test('escaped text and Unicode batches fit exact UTF-8 frame boundaries', async () => {
  const overhead = encodeMessage({ type: 'delta', text: '', id: 'stream' }).length - 4;
  const capacity = MAX_OUTPUT_BYTES - overhead;
  for (const unit of ['é', '😀', '"\n\\', '\ud800']) {
    const unitBytes = Buffer.byteLength(JSON.stringify(unit)) - 2;
    const text = unit.repeat(Math.floor(capacity / unitBytes)) + 'x'.repeat(capacity % unitBytes);
    const f = await fixture();
    try {
      f.push([delta(text.slice(0, 2)), delta(text.slice(2)), delta('!'), complete]); await f.run;
      const deltas = f.messages.filter(m => m.type === 'delta');
      assert.equal(deltas.map(m => m.text).join(''), text + '!');
      for (const event of deltas) assert.ok(encodeMessage(event).length - 4 <= MAX_OUTPUT_BYTES);
      if (unit !== '😀') assert.equal(encodeMessage(deltas[0]).length - 4, MAX_OUTPUT_BYTES);
    } finally { await f.dispose(); }
  }
});

test('cancellation while text is pending flushes before completion and rejects subsequent deltas', async () => {
  for (const before of [true, false]) {
    const f = await fixture({ before });
    try {
      f.rpc.once('message', () => f.host.close());
      f.push([delta('retained'), delta('stale'), complete]); await f.run;
      assert.deepEqual(f.messages, [{ type: 'delta', text: 'retained', id: 'stream' }, { type: 'complete', id: 'stream', cancelled: true }]);
    } finally { await f.dispose(); }
  }
});

test('send exceptions at parser-turn exit retain the original transport error', async () => {
  const rows = [];
  for (const before of [true, false]) {
    let failed = false;
    const f = await fixture({ before, onSend(message) { if (message.type === 'delta' && !failed) { failed = true; throw new Error('turn-exit send failure'); } } });
    try { f.push([delta('retained')]); await f.run; rows.push(canonical(f.messages)); }
    finally { await f.dispose(); }
  }
  assert.deepEqual(rows[1], rows[0]); assert.match(rows[1].at(-1).error, /Invalid CLI response: turn-exit send failure/);
});

test('unknown event shapes keep original spreading behavior and extra fields', async () => {
  const events = [null, undefined, { type: 'delta', text: 'extra', metadata: 1 }, Object.assign(Object.create({ type: 'delta', text: 'inherited' }), { a: 1, b: 2 })];
  const f = await fixture({ custom(event, api, resolve) {
    if (event.method === 'done') resolve();
    else for (const value of events) api.emit(value);
  } });
  try {
    f.push([delta('trigger'), { method: 'done' }]); await f.run;
    assert.deepEqual(f.messages, [...events.map(event => ({ ...event, id: 'stream' })), { type: 'complete', id: 'stream' }]);
  } finally { await f.dispose(); }
});
