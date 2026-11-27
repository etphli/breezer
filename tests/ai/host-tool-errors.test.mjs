import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { copyFile, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ClaudeProvider } from '../../features/ai/host/claude.mjs';
import { HostController } from '../../features/ai/host/controller.mjs';
import { MAX_MESSAGE_BYTES, NativeDecoder, encodeMessage } from '../../features/ai/host/protocol.mjs';

const chat = { type: 'chat', id: 'chat', provider: 'codex', message: 'Test browser action', control: true };
const tick = () => new Promise(resolve => setImmediate(resolve));

test('Claude receives invalid browser arguments as a tool error and can retry', { timeout: 5000 }, async t => {
  const provider = new ClaudeProvider({ createProcess: () => ({ control: async () => ({}), close: async () => {} }) });
  provider.status = { available: true };
  provider.authenticated = true;
  provider.models = [{ id: 'fixture', reasoningEfforts: [] }];
  provider.discover = async () => provider.status;

  const rounds = [];
  provider.round = async (_rpc, content) => {
    rounds.push(content[0].text);
    if (rounds.length === 1) return { action: { name: 'browser_navigate', args: { url: 'example.com' } } };
    if (rounds.length === 2) return { action: { name: 'browser_navigate', args: { url: 'https://example.com/' } } };
    return { action: null };
  };
  const messages = [];
  const host = new HostController([provider], message => {
    messages.push(message);
    if (message.type === 'tool') {
      void host.receive({ type: 'toolResult', id: message.id, requestId: message.requestId, result: { ok: true } });
    }
  });
  t.after(() => host.close());

  await host.receive({ ...chat, provider: 'claude', model: 'fixture' });

  assert.deepEqual(messages.map(message => message.type), ['tool', 'complete']);
  assert.deepEqual(messages[0].args, { url: 'https://example.com/' });
  assert.equal(rounds.length, 3);
  assert.match(rounds[1], /"error":"Invalid URL"/);
  assert.match(rounds[2], /"ok":true/);
});

test('a result arriving after the tool timeout leaves the active chat running', { timeout: 5000 }, async t => {
  const messages = [];
  const timedOut = Promise.withResolvers(), finish = Promise.withResolvers();
  const provider = { id: 'codex', discover: async () => ({}), async chat(_chat, { callTool, emit }) {
    await callTool('browser_snapshot', {}).then(timedOut.resolve, timedOut.resolve);
    await finish.promise;
    emit({ type: 'delta', text: 'Continued after timeout.' });
  } };
  const host = new HostController([provider], message => messages.push(message), { toolTimeout: 5 });
  t.after(() => { finish.resolve(); host.close(); });

  const run = host.receive(chat);
  assert.match((await timedOut.promise).message, /timed out/);
  await host.receive({ type: 'toolResult', id: chat.id, requestId: messages[0].requestId, result: { ok: true } });
  finish.resolve();
  await run;

  assert.deepEqual(messages.map(message => message.type), ['tool', 'delta', 'complete']);
});

test('oversized and invalid results reject their pending tool calls', { timeout: 5000 }, async t => {
  const messages = [], failures = [];
  const provider = { id: 'codex', discover: async () => ({}), async chat(_chat, { callTool }) {
    for (let i = 0; i < 2; i++) {
      await callTool('browser_snapshot', {}).catch(error => failures.push(error.message));
    }
  } };
  const host = new HostController([provider], message => messages.push(message));
  t.after(() => host.close());
  const run = host.receive(chat);
  for (const result of [{ text: 'x'.repeat(MAX_MESSAGE_BYTES - 1000) }, []]) {
    await tick();
    const request = messages.at(-1);
    assert.equal(request.type, 'tool');
    await host.receive({ type: 'toolResult', id: chat.id, requestId: request.requestId, result });
  }
  await run;

  assert.deepEqual(failures, ['Browser action result is too large.', 'Invalid browser action result.']);
  assert.deepEqual(messages.map(message => message.type), ['tool', 'tool', 'complete']);
});

test('native helper reports a controller import failure and loads it on the next chat', { timeout: 5000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'breezer-host-import-'));
  const source = file => fileURLToPath(new URL(`../../features/ai/host/${file}`, import.meta.url));
  const link = file => symlink(source(file), join(directory, file));
  const entry = join(directory, 'main.mjs');
  let child;
  try {
    await copyFile(source('main.mjs'), entry);
    await Promise.all(['protocol.mjs', 'organato.mjs', 'updater.mjs', 'codex.mjs', 'claude.mjs'].map(link));
    child = spawn(process.execPath, [entry, 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/'], { stdio: ['pipe', 'pipe', 'inherit'] });
    const closed = once(child, 'close');
    const timer = setTimeout(() => child.kill('SIGKILL'), 4000);
    const decoder = new NativeDecoder(), messages = [];
    try {
      child.stdin.write(encodeMessage(chat));
      for await (const chunk of child.stdout) {
        const count = messages.length;
        messages.push(...decoder.push(chunk));
        if (count === 0 && messages.length === 1) {
          await link('context-controller.mjs');
          child.stdin.write(encodeMessage({ ...chat, id: 'retry', provider: 'unknown' }));
        }
        if (messages.length >= 2) child.stdin.end();
      }
      const [code] = await closed;
      assert.equal(code, 0);
    } finally { clearTimeout(timer); }

    assert.deepEqual(messages.map(({ type, id }) => ({ type, id })), [
      { type: 'error', id: 'chat' }, { type: 'error', id: 'retry' },
    ]);
    assert.match(messages[0].error, /Cannot find module .*context-controller\.mjs/);
    assert.equal(messages[1].error, 'Choose Codex or Claude.');
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
