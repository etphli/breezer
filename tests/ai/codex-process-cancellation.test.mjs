import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { CodexProvider } from '../../features/ai/host/codex.mjs';
import { JsonLineProcess } from '../../features/ai/host/cli.mjs';

test('Codex setup cancellation reaps its owned resistant child before isolation cleanup', { timeout: 10000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'breezer-codex-process-test-'));
  const controller = new AbortController();
  let rpc, ready, timer, cleaned = false;
  const started = new Promise(resolve => { ready = resolve; });
  const provider = new CodexProvider({ createProcess() {
    // This dummy transport installs its handler before announcing readiness.
    // It never runs a CLI, reads configuration, or makes network requests.
    rpc = new JsonLineProcess(process.execPath, ['--input-type=module', '-e', `
      process.on('SIGTERM', () => {});
      process.stdout.write(JSON.stringify({ method: 'fixture/ready' }) + '\\n');
      process.stdin.resume();
    `], { cwd: directory, env: {} });
    rpc.once('message', message => { if (message.method === 'fixture/ready') ready(); });
    return rpc;
  } });
  provider.status = { available: true }; provider.authenticated = true;
  provider.defaultModel = 'fixture'; provider.models = [{ id: 'fixture' }];
  provider.isolate = async () => ({ directory, env: {}, cleanup: async () => {
    assert.equal(rpc.child.signalCode, 'SIGKILL');
    assert.throws(() => process.kill(rpc.child.pid, 0), { code: 'ESRCH' });
    cleaned = true;
  } });
  const result = assert.rejects(provider.chat({ message: 'synthetic setup only' }, {
    signal: controller.signal, emit() {}, callTool() {},
  }), /^Error: Cancelled\.$/);
  try {
    await Promise.race([started, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Dummy process did not become ready')), 3000); })]);
    controller.abort();
    await result;
    assert.equal(cleaned, true);
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (rpc && rpc.child.exitCode === null && rpc.child.signalCode === null) {
      const closed = once(rpc.child, 'close'); rpc.child.kill('SIGKILL'); await closed;
    }
    try { await result; }
    finally { await rm(directory, { recursive: true, force: true }); }
  }
});
