#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  source: { type: 'string', default: 'features/ai/host/protocol.mjs' },
  bytes: { type: 'string', default: String(8 * 1024 * 1024) },
  chunks: { type: 'string', default: String(32 * 1024) },
  rounds: { type: 'string', default: '5' }, output: { type: 'string' },
  'expect-bounded': { type: 'boolean', default: false },
} });
assert.equal(typeof global.gc, 'function', 'Run node --expose-gc script/verify_native_decoder_memory.mjs');
const { NativeDecoder, MAX_MESSAGE_BYTES } = await import(pathToFileURL(resolve(values.source)));
const bytes = Number(values.bytes), chunkBytes = Number(values.chunks), rounds = Number(values.rounds);
assert.ok(Number.isInteger(bytes) && bytes > 0 && bytes < MAX_MESSAGE_BYTES - 1024);
assert.ok(Number.isInteger(chunkBytes) && chunkBytes > 0);
assert.ok(Number.isInteger(rounds) && rounds > 0 && rounds <= 20);
const decoder = new NativeDecoder();
global.gc();
const before = process.memoryUsage();
const observations = [];
const originalConcat = Buffer.concat;
const originalSet = Buffer.prototype.set;
function decodeRound() {
  const body = Buffer.from(JSON.stringify({ type: 'fixture', text: 'x'.repeat(bytes) }));
  const frame = Buffer.alloc(body.length + 4); frame.writeUInt32LE(body.length); body.copy(frame, 4);
  let copiedBytes = 0, assemblySetBytes = 0, replies = 0;
  Buffer.concat = (parts, length) => { copiedBytes += length ?? parts.reduce((n, part) => n + part.length, 0); return originalConcat(parts, length); };
  Buffer.prototype.set = function(source, offset) { assemblySetBytes += source.byteLength; return originalSet.call(this, source, offset); };
  try {
    const cpu = process.cpuUsage(), started = performance.now();
    for (let offset = 0; offset < frame.length; offset += chunkBytes) {
      const messages = decoder.push(frame.subarray(offset, Math.min(offset + chunkBytes, frame.length)));
      for (const message of messages) { assert.equal(message.text.length, bytes); replies++; }
    }
    decoder.finish();
    const elapsedMs = performance.now() - started, cpuUsed = process.cpuUsage(cpu);
    assert.equal(replies, 1);
    return { elapsedMs, cpuUserMicros: cpuUsed.user, cpuSystemMicros: cpuUsed.system, concatCopiedBytes: copiedBytes, assemblySetBytes };
  } finally { Buffer.concat = originalConcat; Buffer.prototype.set = originalSet; }
}
for (let round = 0; round < rounds; round++) observations.push(decodeRound());
await new Promise(resolve => setImmediate(resolve));
global.gc(); global.gc();
const after = process.memoryUsage();
const retainedArrayBufferBytes = after.arrayBuffers - before.arrayBuffers;
const result = { node: process.version, source: resolve(values.source),
  sourceSha256: createHash('sha256').update(await readFile(resolve(values.source))).digest('hex'),
  payloadBytes: bytes, chunkBytes, rounds, before, after, retainedArrayBufferBytes, observations,
  limits: 'Production native frame decoder with synthetic JSON, fragmented input and forced GC. Buffer.concat and Buffer.set instrumentation count decoder assembly bytes. Not whole-browser RAM, unique memory or AI/provider latency.' };
if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result, null, 2));
if (values['expect-bounded']) {
  assert.ok(retainedArrayBufferBytes < 256 * 1024, 'An empty decoder retains the large completed frame');
  assert.ok(observations.every(row => (row.concatCopiedBytes + row.assemblySetBytes) <= bytes * 4), 'Fragmentation repeatedly copies the accumulated frame');
}
