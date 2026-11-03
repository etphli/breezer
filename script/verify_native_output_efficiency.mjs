import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { MAX_OUTPUT_BYTES } from '../features/ai/host/protocol.mjs';

export const sourcePath = new URL('../features/ai/host/protocol.mjs', import.meta.url);
export const beforePath = new URL('../tests/ai/fixtures/native-encode-before.mjs', import.meta.url);
export const hash = text => crypto.createHash('sha256').update(text).digest('hex');

export function sources() {
  const before = fs.readFileSync(beforePath, 'utf8');
  assert.equal(hash(before), '6733bc93ca7976a213ac6fbfc950546c07f259216fcada59e5be5b27feb5e5a1', 'Output encoder requires its pinned baseline');
  const source = fs.readFileSync(sourcePath, 'utf8');
  const current = source.match(/^export function encodeMessage\(value\) \{[\s\S]*?^\}/m)?.[0];
  assert.ok(current, 'Production output encoder was not found');
  return { before, current, sourceSha256: hash(source) };
}

export function encoder(source, measured = false) {
  const counts = { allocations: 0, requestedBufferBytes: 0, concatCopiedBytes: 0, explicitCopiedBytes: 0 };
  function record(buffer) {
    counts.allocations++;
    counts.requestedBufferBytes += buffer.length;
    return buffer;
  }
  const buffers = measured ? {
    from: (...args) => {
      const buffer = record(Buffer.from(...args)), copy = buffer.copy;
      buffer.copy = function(...args) {
        const bytes = copy.apply(this, args);
        counts.explicitCopiedBytes += bytes;
        return bytes;
      };
      return buffer;
    },
    alloc: (...args) => record(Buffer.alloc(...args)),
    // Prefill to make an unwritten byte visible in the differential check.
    allocUnsafe: size => record(Buffer.alloc(size, 0xa5)),
    byteLength: (...args) => Buffer.byteLength(...args),
    concat: (...args) => {
      const buffer = Buffer.concat(...args);
      counts.concatCopiedBytes += buffer.length;
      return record(buffer);
    },
  } : Buffer;
  const encode = vm.runInNewContext(source.replace('export function ', 'function ') + '\nencodeMessage;', { Buffer: buffers, MAX_OUTPUT_BYTES });
  return { encode, counts };
}

export function probe() {
  const { before, current, sourceSha256 } = sources();
  const cases = {};
  for (const size of [64, 4096, 65536, MAX_OUTPUT_BYTES]) {
    const value = { text: 'x'.repeat(size - 11) };
    const old = encoder(before, true), next = encoder(current, true);
    assert.deepEqual(next.encode(value), old.encode(value));
    cases[size] = { bodyBytes: size, frameBytes: size + 4, baseline: old.counts, current: next.counts };
  }
  const rejected = {};
  for (const [name, source] of [['baseline', before], ['current', current]]) {
    const f = encoder(source, true);
    assert.throws(() => f.encode({ text: 'x'.repeat(MAX_OUTPUT_BYTES) }), /too large/);
    rejected[name] = f.counts;
  }
  return { scope: 'Source-derived encoder VM with real Node Buffers and explicit allocation/copy counters. Requested bytes are logical counts, not physical RAM, retained memory or browser/AI latency. Payload buffering/copying and the unbounded native output queue remain.', node: process.version, sourceSha256, baselineSha256: hash(before), cases, oversizedReply: rejected };
}

export async function benchmark() {
  const { before, current, sourceSha256 } = sources();
  const restored = fs.readFileSync(sourcePath, 'utf8').replace(current, before.trimEnd());
  assert.equal(hash(restored), 'da4a39a7a390b8418e715f98db9d9e1d192adec471980dd1daeecfc53406e90e', 'Source outside the output encoder changed');
  const { encodeMessage: baseline } = await import('data:text/javascript;base64,' + Buffer.from(restored).toString('base64'));
  const { encodeMessage: next } = await import(sourcePath);
  let checksum = 0;
  const measure = (encode, value, iterations) => {
    const cpu = process.cpuUsage(), start = performance.now();
    for (let i = 0; i < iterations; i++) {
      const frame = encode(value);
      checksum = (checksum + frame.length + frame[4]) >>> 0;
    }
    const elapsedMs = performance.now() - start, used = process.cpuUsage(cpu);
    return { elapsedMs, cpuMs: (used.user + used.system) / 1000 };
  };
  const cases = [];
  for (const size of [64, 4096, 65536, MAX_OUTPUT_BYTES, 'unicode']) {
    const value = { text: size === 'unicode' ? 'é😀'.repeat(10922) : 'x'.repeat(size - 11) };
    const bytes = Buffer.byteLength(JSON.stringify(value));
    const iterations = Math.max(8, Math.ceil(4 * 1024 * 1024 / bytes));
    assert.deepEqual(baseline(value), next(value));
    for (let warm = 0; warm < 3; warm++) {
      measure(baseline, value, iterations); measure(next, value, iterations);
    }
    const trials = [];
    for (let pair = 0; pair < 12; pair++) {
      const order = pair % 2 ? [['current', next], ['baseline', baseline]] : [['baseline', baseline], ['current', next]];
      for (const [variant, encode] of order) trials.push({ pair, variant, ...measure(encode, value, iterations) });
    }
    const summary = {};
    for (const variant of ['baseline', 'current']) {
      summary[variant] = Object.fromEntries(['elapsedMs', 'cpuMs'].map(metric => {
        const values = trials.filter(row => row.variant === variant).map(row => row[metric]).sort((a, b) => a - b);
        return [metric, { median: (values[5] + values[6]) / 2, min: values[0], max: values.at(-1) }];
      }));
    }
    cases.push({ label: String(size), bodyBytes: bytes, iterations, trials, summary });
  }
  return { scope: 'Local synthetic synchronous encoder benchmark of actual before/current full modules. No browser/provider/pipe/PC. Timing includes JSON serialization, encoding and GC, not normal AI or browser latency.', node: process.version, sourceSha256, baselineSourceSha256: hash(restored), checksum, cases };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(JSON.stringify(process.argv.includes('--benchmark') ? await benchmark() : probe(), null, 2));
}
