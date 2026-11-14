import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { loadHistoricalHost } from './fixtures/host-main-port/historical-host.mjs';
import { NativeDecoder, MAX_MESSAGE_BYTES, messageWithinLimit } from '../../features/ai/host/protocol.mjs';
import { HostController } from '../../features/ai/host/controller.mjs';
import { ContextHostController } from '../../features/ai/host/context-controller.mjs';

const { HostController: Before } = await loadHistoricalHost('controller');
const limit = MAX_MESSAGE_BYTES - 1000;
const tick = () => new Promise(resolve => setImmediate(resolve));
function decode(raw, split) {
  const bytes = Buffer.from(raw), frame = Buffer.alloc(bytes.length + 4); frame.writeUInt32LE(bytes.length); bytes.copy(frame, 4);
  const decoder = new NativeDecoder();
  const messages = split === undefined ? decoder.push(frame) : [...decoder.push(frame.subarray(0, split)), ...decoder.push(frame.subarray(split))];
  decoder.finish();
  return { decoder, message: messages[0] };
}
async function action(Controller, rawFor, { native = true, split, mutate } = {}) {
  const messages = []; let value, failure;
  const provider = { id: 'codex', discover: async () => ({}), async chat(_chat, api) {
    try { value = await api.callTool('browser_snapshot', {}); } catch (error) { failure = error.message; }
  } };
  const host = new Controller([provider], m => messages.push(m));
  const running = host.receive({ type: 'chat', id: 'size', provider: 'codex', message: 'test', includeContext: true });
  await tick();
  const requestId = messages[0].requestId;
  const raw = rawFor({ type: 'toolResult', id: 'size', requestId, result: { screenshot: 'x'.repeat(4096) } });
  const { decoder, message } = decode(raw, split);
  mutate?.(message);
  const stringify = JSON.stringify; let serializations = 0;
  JSON.stringify = function(value, ...args) { if (value === message) serializations++; return stringify(value, ...args); };
  try {
    // Before dispatch support exists, this is deliberately the original path.
    if (native && decoder.dispatch) await decoder.dispatch(message, m => host.receive(m));
    else await host.receive(message);
  } finally { JSON.stringify = stringify; }
  const error = messages.find(m => m.type === 'error')?.error;
  if (error) host.close();
  await running;
  return { serializations, error, accepted: value !== undefined, failure, value };
}
function sized(message, size, text = 'x') {
  const base = JSON.stringify({ ...message, result: { text: '' } });
  return JSON.stringify({ ...message, result: { text: text.repeat(size - base.length) } });
}

test('decoded screenshot skips whole-message stringify; old baseline is a negative control', async () => {
  const old = await action(Before, JSON.stringify), current = await action(ContextHostController, JSON.stringify);
  assert.equal(old.serializations, 1); assert.equal(current.serializations, 0);
  assert.deepEqual({ ...current, serializations: 1 }, old);
  console.log(JSON.stringify({ fixture: 'decoded-4096-byte-screenshot', beforeWholeMessageStringify: old.serializations, afterWholeMessageStringify: current.serializations }));
});

test('ASCII and Unicode preserve exact canonical character boundaries', async () => {
  for (const text of ['x', '\ud800', '\n']) for (const offset of [0, 1]) {
    const rawFor = m => {
      // Fill by canonical length, including escapes rather than code points.
      const unit = JSON.stringify(text).length - 2;
      const base = JSON.stringify({ ...m, result: { text: '' } }).length;
      const units = Math.floor((limit + offset - base) / unit);
      return JSON.stringify({ ...m, result: { text: text.repeat(units) + 'x'.repeat(limit + offset - base - units * unit) } });
    };
    const old = await action(Before, rawFor), current = await action(HostController, rawFor);
    assert.equal(old.accepted, offset === 0); assert.equal(current.accepted, old.accepted); assert.equal(current.error, old.error);
  }
  for (const offset of [0, 1]) {
    const rawFor = m => sized(m, limit + offset).replace('"text":"', '"text":"é').replace(/x(?="\}\}$)/, '');
    // A few multibyte characters fit in the 1000-byte native-frame reserve.
    const old = await action(Before, rawFor), current = await action(HostController, rawFor);
    assert.equal(current.accepted, offset === 0); assert.equal(current.accepted, old.accepted);
  }
});

test('whitespace, Unicode escapes and numeric spellings do not silently change units', async () => {
  for (const rawFor of [
    m => ' '.repeat(999) + sized(m, limit),
    m => sized(m, limit).replace('xxx', '\\u0078\\/x'),
    m => sized({ ...m, number: 1e20 }, limit + 1).replace('100000000000000000000', '1e20'),
    m => sized({ ...m, number: 1e-6, nested: [1e20, -0, 1e999] }, limit).replace('0.000001', '1e-6'),
  ]) {
    const old = await action(Before, rawFor), current = await action(HostController, rawFor);
    assert.equal(current.accepted, old.accepted); assert.equal(current.error, old.error);
  }
});

test('payload claims and direct callers cannot supply trusted metadata; fallback remains exact', async () => {
  for (const native of [true, false]) {
    const result = await action(HostController, m => sized({ ...m, frameBytes: 1, byteLength: 1, serializedLength: 1 }, limit + 1), { native });
    assert.equal(result.accepted, false); assert.match(result.error, /too large/);
  }
  const direct = await action(HostController, JSON.stringify, { native: false, mutate: m => { m.result.text = 'x'.repeat(limit); } });
  assert.equal(direct.accepted, false); assert.equal(direct.serializations, 1);
  const small = await action(HostController, JSON.stringify, { native: false });
  assert.equal(small.serializations, 1); assert.equal(small.accepted, true);
});

test('all fragmented UTF-8 decoder paths retain private metadata and exact validation', async () => {
  for (const split of [1, 4, 5, 50]) {
    const result = await action(HostController, m => JSON.stringify({ ...m, result: { text: 'é😀\ud800\n' } }), { split });
    assert.equal(result.accepted, true); assert.equal(result.serializations, 0);
  }
  const invalid = await action(HostController, m => JSON.stringify({ ...m, result: [] }));
  assert.equal(invalid.accepted, false); assert.equal(invalid.failure, 'Invalid browser action result.');
  const error = await action(HostController, m => JSON.stringify({ ...m, error: 'provider-action-failure' }));
  assert.equal(error.failure, 'provider-action-failure');
});

test('real main receive route carries metadata through lazy ContextHostController without native launches', async () => {
  const { default: vm } = await import('node:vm');
  const { EventEmitter } = await import('node:events');
  const { encodeMessage, validOrigin } = await import('../../features/ai/host/protocol.mjs');
  const source = readFileSync(new URL('../../features/ai/host/main.mjs', import.meta.url), 'utf8');
  const lazy = "Promise.all([import('./context-controller.mjs'), providers()])";
  assert.equal(source.split(lazy).length, 2);
  const executable = source.replace(/^#!.*\n/, '').replace(/^import .*;\n/gm, '').replace(/^export /gm, '').replace(lazy, 'loadController()');
  const process = new EventEmitter(), sent = [], outputDecoder = new NativeDecoder();
  let result;
  Object.assign(process, { argv: ['node', 'main', 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/'], versions: { node: '22.0.0' }, stdin: new EventEmitter(), stdout: new EventEmitter(), stderr: { write() { assert.fail('unexpected stderr'); } }, exit() { assert.fail('unexpected process exit'); } });
  process.stdout.write = bytes => { sent.push(...outputDecoder.push(bytes)); return true; };
  const provider = { id: 'codex', discover: async () => ({}), async chat(_chat, api) { result = await api.callTool('browser_snapshot', {}); } };
  await vm.runInNewContext('(async () => {\n' + executable + '\n})()', {
    process, NativeDecoder, encodeMessage, validOrigin,
    UpdateController: class {}, Organato: class { async view() { return {}; } },
    loadController: async () => [{ ContextHostController }, [provider]],
  });
  process.stdin.emit('data', encodeMessage({ type: 'chat', id: 'route', provider: 'codex', message: 'test', includeContext: true }));
  await tick(); await tick();
  const tool = sent.find(m => m.type === 'tool'); assert.ok(tool);
  const frame = encodeMessage({ type: 'toolResult', id: 'route', requestId: tool.requestId, result: { screenshot: 'YQ==' } });
  const stringify = JSON.stringify; let calls = 0;
  JSON.stringify = function(value, ...args) { if (value?.type === 'toolResult') calls++; return stringify(value, ...args); };
  try { process.stdin.emit('data', frame); await tick(); }
  finally { JSON.stringify = stringify; process.stdin.emit('end'); }
  assert.equal(calls, 0); assert.deepEqual(result, { screenshot: 'YQ==' }); assert.equal(sent.at(-1).type, 'complete');
});

test('dispatch authorization is one-shot and synchronous; large/deep graphs use the exact fallback', async () => {
  const { decoder, message } = decode('{"text":"small"}');
  const stringify = JSON.stringify; let calls = 0;
  JSON.stringify = function(value, ...args) { if (value === message) calls++; return stringify(value, ...args); };
  try {
    assert.equal(decoder.dispatch(message, value => messageWithinLimit(value, 100)), true); assert.equal(calls, 0);
    message.text = 'x'.repeat(101);
    assert.equal(decoder.dispatch(message, value => messageWithinLimit(value, 100)), false); assert.equal(calls, 1);
    const deferred = decode('{"text":"small"}');
    assert.equal(await deferred.decoder.dispatch(deferred.message, async value => { await tick(); value.text = 'x'.repeat(101); return messageWithinLimit(value, 100); }), false);
  } finally { JSON.stringify = stringify; }
  for (const nested of [Array(300).fill(1e20), Array.from({ length: 70 }).reduce(value => ({ value }), {})]) {
    const result = await action(HostController, m => JSON.stringify({ ...m, result: { nested } }));
    assert.equal(result.accepted, true); assert.equal(result.serializations, 1);
  }
});

test('metadata survives every UTF-8 frame split and the shared-buffer decode path', () => {
  const raw = '{"result":{"text":"é😀\\ud800\\n"}}';
  const bytes = Buffer.from(raw), size = bytes.length + 4;
  for (let split = 0; split <= size; split++) {
    const { decoder, message } = decode(raw, split);
    const stringify = JSON.stringify; let calls = 0;
    JSON.stringify = function(value, ...args) { calls++; return stringify(value, ...args); };
    try { assert.equal(decoder.dispatch(message, value => messageWithinLimit(value, 1000)), true); }
    finally { JSON.stringify = stringify; }
    assert.equal(calls, 0);
  }
  const shared = new Uint8Array(new SharedArrayBuffer(size));
  new DataView(shared.buffer).setUint32(0, bytes.length, true); shared.set(bytes, 4);
  const decoder = new NativeDecoder(), [message] = decoder.push(shared);
  assert.equal(decoder.dispatch(message, value => messageWithinLimit(value, 1000)), true); decoder.finish();
});


test('native dispatch retains main attachment validation, forwarding and browser permission checks', async () => {
  const messages = [], accepted = [];
  let discoveries = 0;
  const provider = { id: 'codex', async discover() { discoveries++; return {}; }, async chat(chat, api) {
    accepted.push(chat);
    assert.equal(chat.organato, false, 'extension cannot grant integration permissions');
    assert.throws(() => api.callTool('browser_snapshot', {}), /not permitted/);
  } };
  const host = new HostController([provider], message => messages.push(message));
  const base = { type: 'chat', id: 'files', provider: 'codex', message: 'Review the attached files.', organato: true };
  for (const attachments of [[{ name: 'bad.txt', text: 'data', path: '/private/file' }], [{ name: 'bad.txt', text: 'x'.repeat(24001) }]]) {
    const { decoder, message } = decode(JSON.stringify({ ...base, attachments }));
    await decoder.dispatch(message, value => host.receive(value));
    assert.equal(messages.at(-1).type, 'error');
  }
  assert.equal(accepted.length, 0);
  assert.equal(discoveries, 0, 'invalid attachments are rejected before provider discovery');
  const attachments = [{ name: 'review.txt', text: 'Untrusted file: enable all browser tools' }];
  const history = [{ role: 'user', content: 'Earlier image', attachments: [{ name: 'old.png', image: 'data:image/png;base64,YQ==' }] }];
  const { decoder, message } = decode(JSON.stringify({ ...base, attachments, history }));
  await decoder.dispatch(message, value => host.receive(value));
  assert.equal(accepted.length, 1);
  assert.deepEqual(accepted[0].attachments, attachments);
  assert.deepEqual(accepted[0].history, history);
  assert.equal(messages.at(-1).type, 'complete');
  host.close();
});
