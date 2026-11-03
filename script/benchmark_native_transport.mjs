#!/usr/bin/env node
import assert from 'node:assert/strict';
import { fork, execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { cp, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { ownChild, validateSample, validateUsage, validateReport } from './native_transport_diagnostic.mjs';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { NativeDecoder } from '../features/ai/host/protocol.mjs';

const { values } = parseArgs({ options: {
  'baseline-protocol': { type: 'string' }, output: { type: 'string' },
  rounds: { type: 'string', default: '6' }, bytes: { type: 'string', default: String(8 * 1024 * 1024) },
  'usage-probe': { type: 'string' },
} });
assert.ok(values['baseline-protocol'] && values.output, 'Supply --baseline-protocol and --output');
const rounds = Number(values.rounds), bytes = Number(values.bytes);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 10);
assert.ok(Number.isInteger(bytes) && bytes > 0 && bytes < 16 * 1024 * 1024 - 1024);
const temporary = await mkdtemp(join(tmpdir(), 'breezer-native-transport-'));
const origin = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/';
const sha = text => createHash('sha256').update(text).digest('hex');
const results = [];
const hashFile = async path => { const hash = createHash('sha256'); for await (const chunk of createReadStream(path)) hash.update(chunk); return hash.digest('hex'); };
try {
  const baselineHost = join(temporary, 'baseline-host');
  await cp(resolve('features/ai/host'), baselineHost, { recursive: true });
  await cp(resolve(values['baseline-protocol']), join(baselineHost, 'protocol.mjs'));
  const wrapper = join(temporary, 'diagnostic.mjs');
  await writeFile(wrapper, `import {pathToFileURL} from 'node:url';
await import(pathToFileURL(process.env.BREEZER_MEMORY_HOST_ENTRY));
process.on('message',message=>{if(message?.sample){global.gc();global.gc();process.send({memory:process.memoryUsage(),cpu:process.cpuUsage(),pid:process.pid,node:process.version});}});
process.send({ready:true});\n`);
  const trial = async (name, round) => {
    const host = name === 'baseline' ? baselineHost : resolve('features/ai/host');
    const child = fork(wrapper, [origin], { execArgv: ['--expose-gc'], stdio: ['pipe', 'pipe', 'pipe', 'ipc'], env: { ...process.env, BREEZER_MEMORY_HOST_ENTRY: join(host, 'main.mjs') } });
    const owned = ownChild(child);
    const bounded = (promise, stage) => owned.wait(promise, stage);
    let stderr = '', receive;
    const decoder = new NativeDecoder();
    child.stderr.on('data', data => { stderr = (stderr + data).slice(-2000); });
    child.stdout.on('data', data => {
      try { for (const message of decoder.push(data)) receive?.(message); }
      catch (error) { owned.fail(error); }
    });
    const probe = previous => {
      if (!values['usage-probe']) return null;
      const usage = JSON.parse(execFileSync(resolve(values['usage-probe']), [String(child.pid)], { encoding: 'utf8', timeout: 3000 }));
      validateUsage(usage, child.pid, previous);
      return usage;
    };
    const sample = async () => {
      const result = once(child, 'message'); child.send({ sample: true }, error => { if (error) owned.fail(error); });
      return validateSample((await bounded(result, name + ' sample'))[0], child.pid, process.version);
    };
    try {
      assert.deepEqual((await bounded(once(child, 'message'), name + ' ready'))[0], { ready: true });
      const usageBefore = probe();
      const before = await sample();
      // Invalid boolean rejects before any config, Keychain, provider or network access.
      const body = Buffer.from(JSON.stringify({ type: 'organato-configure', id: 'memory-fixture', settings: { enabled: 'invalid', padding: 'x'.repeat(bytes) } }));
      const frame = Buffer.alloc(body.length + 4); frame.writeUInt32LE(body.length); body.copy(frame, 4);
      const response = new Promise(resolve => { receive = resolve; });
      const started = performance.now();
      for (let offset = 0; offset < frame.length; offset += 32768) {
        if (!child.stdin.write(frame.subarray(offset, Math.min(offset + 32768, frame.length)))) await bounded(once(child.stdin, 'drain'), name + ' write');
      }
      assert.deepEqual(await bounded(response, name + ' reply'), { type: 'organato-result', id: 'memory-fixture', ok: false, error: 'Invalid Organato setting.' });
      const replyMs = performance.now() - started;
      const after = await sample();
      const usage = probe(usageBefore);
      const closed = owned.closed;
      child.stdin.end();
      await owned.cleanup();
      const [code] = await closed;
      assert.equal(code, 0, stderr); decoder.finish();
      return { name, round, replyMs, before, after, usageBefore, usage,
        retainedArrayBufferBytes: after.memory.arrayBuffers - before.memory.arrayBuffers,
        cpuUserMicros: after.cpu.user - before.cpu.user, cpuSystemMicros: after.cpu.system - before.cpu.system };
    } finally { await owned.cleanup(); }
  };
  for (let round = 0; round < rounds; round++) {
    for (const name of round % 2 ? ['candidate', 'baseline'] : ['baseline', 'candidate']) results.push(await trial(name, round));
  }
  const otherHostSources = {};
  for (const name of await readdir(baselineHost)) {
    if (!name.endsWith('.mjs') || name === 'protocol.mjs') continue;
    const original = await readFile(join(baselineHost, name));
    assert.deepEqual(original, await readFile(join(resolve('features/ai/host'), name)), 'Only protocol.mjs may differ');
    otherHostSources[name] = sha(original);
  }
  const report = { schema: 1, status: 'passed', runtime: { path: process.execPath, sha256: await hashFile(process.execPath), version: process.version }, otherHostSources, payloadBytes: bytes, chunkBytes: 32768, pairedRounds: rounds,
    baselineProtocolSha256: sha(await readFile(resolve(values['baseline-protocol']))), candidateProtocolSha256: sha(await readFile('features/ai/host/protocol.mjs')),
    results, limits: 'Actual production native host entry over stdin/stdout, synthetic invalid settings only. Diagnostic IPC samples force GC; no credentials, config writes, provider discovery, network requests or browser launch. Not whole-browser RAM or AI latency.' };
  validateReport(report);
  await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(temporary, { recursive: true, force: true }); }
