import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { pathToFileURL } from 'node:url';

export async function loadSource(path, instrument = false) {
  const source = await readFile(path, 'utf8');
  let code = source.replaceAll("'./cli.mjs'", JSON.stringify(pathToFileURL(`${process.cwd()}/features/ai/host/cli.mjs`).href))
    .replaceAll("'./protocol.mjs'", JSON.stringify(pathToFileURL(`${process.cwd()}/features/ai/host/protocol.mjs`).href));
  const counter = { scanned: 0, parsed: 0, parses: 0 };
  if (instrument) {
    const marker = 'for (const character of chunk) {';
    assert.equal(code.split(marker).length, 2, 'one incremental scan loop');
    globalThis.__claudeStreamCount = counter;
    code = code.replace(marker, `${marker} globalThis.__claudeStreamCount.scanned++;`);
  }
  return { module: await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`), counter,
    sha256: createHash('sha256').update(source).digest('hex') };
}
export function fakeRound(Provider) {
  const rpc = new EventEmitter(), events = [], sent = [];
  rpc.send = message => sent.push(message);
  rpc.close = error => rpc.emit('closed', error ?? new Error('Closed.'));
  const done = new Provider().round(rpc, [], event => events.push(event));
  const start = (index = 0) => rpc.emit('message', { type: 'stream_event', event: { type: 'content_block_start', index, content_block: { type: 'tool_use', name: 'StructuredOutput' } } });
  const push = (partial_json, index = 0) => rpc.emit('message', { type: 'stream_event', event: { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json } } });
  const finish = output => rpc.emit('message', { type: 'result', subtype: 'success', structured_output: output });
  return { rpc, events, sent, done, start, push, finish };
}
async function measure(path, incremental) {
  const loaded = await loadSource(path, incremental), cases = [];
  for (const chunks of [128, 256, 512]) {
    const round = fakeRound(loaded.module.ClaudeProvider); round.start();
    const count = loaded.counter; count.scanned = count.parsed = count.parses = 0;
    const parse = JSON.parse;
    JSON.parse = (text, ...args) => { count.parsed += text.length; count.parses++; return parse(text, ...args); };
    let arrived = 0;
    try {
      for (let i = 0; i < chunks; i++) { const part = (i === 0 ? '{"text":"' : '') + 'x'.repeat(128); arrived += part.length; round.push(part); }
      round.finish({ text: 'x'.repeat(chunks * 128), action: null });
    } finally { JSON.parse = parse; }
    await round.done;
    assert.equal(round.events.map(event => event.text).join(''), 'x'.repeat(chunks * 128));
    assert.equal(round.rpc.listenerCount('message'), 0);
    if (incremental) { assert.equal(count.scanned, arrived); assert.equal(count.parses, 0); }
    cases.push({ chunks, arrivedCodeUnits: arrived, emittedCodeUnits: chunks * 128, ...count });
  }
  return { path, sha256: loaded.sha256, cases };
}
async function differential() {
  const old = await loadSource('build/efficiency-20261103/claude-stream-before.mjs');
  const current = await loadSource('features/ai/host/claude.mjs');
  let seed = 713, comparisons = 0;
  const random = n => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
  const alphabet = ['a', 'é', '😀', '\\', 'u', '0', '1', '2', '3', 'X', '"', '\n', '\t', '\ud800', '\udfff'];
  for (let trial = 0; trial < 400; trial++) {
    const rounds = [fakeRound(old.module.ClaudeProvider), fakeRound(current.module.ClaudeProvider)];
    let text = '';
    for (let block = 0; block < 3; block++) {
      text = Array.from({ length: random(90) }, () => alphabet[random(alphabet.length)]).join('');
      const json = (trial % 2 ? 'junk "tex" ' : '') + JSON.stringify({ text, action: null });
      rounds.forEach(round => round.start(block));
      for (let offset = 0; offset < json.length;) {
        const size = random(12) + 1, chunk = json.slice(offset, offset + size); offset += size;
        rounds.forEach(round => round.push(chunk, block));
        assert.deepEqual(rounds[1].events, rounds[0].events); comparisons++;
      }
    }
    rounds.forEach(round => round.finish({ text, action: trial % 2 ? { name: 'browser_snapshot', args: {} } : null }));
    assert.deepEqual(await rounds[1].done, await rounds[0].done);
    assert.deepEqual(rounds[1].events, rounds[0].events);
  }
  return { actualOldAndNewRounds: 800, structuredBlocks: 1200, perDeltaComparisons: comparisons, result: 'identical events and results' };
}
if (process.argv[1]?.endsWith('/verify_claude_streaming_efficiency.mjs') || process.argv[1] === 'script/verify_claude_streaming_efficiency.mjs') {
  const before = process.argv.includes('--before');
  const result = { runtime: process.version, scope: 'Actual round, fake RPC; deterministic code-unit counts only. No provider or timing measurements.',
    differential: before ? undefined : await differential(),
    measurement: await measure(before ? 'build/efficiency-20261103/claude-stream-before.mjs' : 'features/ai/host/claude.mjs', !before) };
  await writeFile(`build/efficiency-20261103/claude-stream-${before ? 'before' : 'after'}.json`, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
}
