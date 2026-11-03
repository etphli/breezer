import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeDecoder } from '../../features/ai/host/protocol.mjs';
import { NativeDecoder as Before } from './fixtures/native-decoder-before-complete-frame.mjs';

function frame(body) {
  body = typeof body === 'string' ? Buffer.from(body) : body;
  const bytes = Buffer.alloc(body.length + 4);
  bytes.writeUInt32LE(body.length);
  bytes.set(body, 4);
  return bytes;
}
const encode = value => frame(JSON.stringify(value));
function outcome(work) {
  try { return { value: work() }; }
  catch (error) { return { error: { name: error.name, message: error.message, code: error.code } }; }
}
function trace(Decoder, chunks) {
  const decoder = new Decoder();
  return [...chunks.map(chunk => outcome(() => decoder.push(chunk))),
    outcome(() => decoder.push(new Uint8Array(0))), outcome(() => decoder.finish()),
    outcome(() => decoder.push(encode(null))), outcome(() => decoder.finish())];
}
function view(bytes, shared = false) {
  const backing = shared ? new SharedArrayBuffer(bytes.length + 17) : new ArrayBuffer(bytes.length + 17);
  const result = new Uint8Array(backing, 9, bytes.length);
  result.set(bytes);
  return result;
}
function measure(Decoder, chunks) {
  const decoder = new Decoder(), bodies = new WeakSet();
  const alloc = Buffer.alloc, set = Buffer.prototype.set;
  const work = { allocations: 0, allocatedBytes: 0, copiedBodyBytes: 0, copiedHeaderBytes: 0 };
  // No await or callbacks to external code while synchronous instrumentation is installed.
  try {
    Buffer.alloc = function(size, ...args) {
      const body = alloc(size, ...args);
      bodies.add(body); work.allocations++; work.allocatedBytes += size;
      return body;
    };
    Buffer.prototype.set = function(source, offset) {
      work[bodies.has(this) ? 'copiedBodyBytes' : 'copiedHeaderBytes'] += source.byteLength;
      return set.call(this, source, offset);
    };
    return { work, result: outcome(() => chunks.flatMap(chunk => decoder.push(chunk))) };
  } finally { Buffer.alloc = alloc; Buffer.prototype.set = set; }
}

test('complete and coalesced native frames avoid temporary body buffers', () => {
  for (const values of [[{ text: 'x'.repeat(4096) }],
    [null, false, 0, 'é😀\u0000', { nested: ['\ud800', '\ufeff'] }]]) {
    const bytes = Buffer.concat(values.map(encode));
    const old = measure(Before, [bytes]), current = measure(NativeDecoder, [bytes]);
    assert.deepEqual(current.result, old.result);
    assert.deepEqual(current.result.value, values);
    assert.equal(old.work.allocations, values.length);
    assert.ok(old.work.copiedBodyBytes > 0);
    assert.deepEqual(current.work, { allocations: 0, allocatedBytes: 0,
      copiedBodyBytes: 0, copiedHeaderBytes: values.length * 4 });
  }
});

test('fragmented and shared native frames keep the owned-copy path', () => {
  const bytes = encode({ text: 'preserve é😀' });
  for (const chunks of [[bytes.subarray(0, 5), bytes.subarray(5)], [view(bytes, true)]]) {
    const old = measure(Before, chunks), current = measure(NativeDecoder, chunks);
    assert.deepEqual(current, old);
    assert.equal(current.work.allocations, 1);
    assert.equal(current.work.allocatedBytes, bytes.length - 4);
    assert.equal(current.work.copiedBodyBytes, bytes.length - 4);
  }
});

test('complete-body decoding preserves every split with offset and shared views', () => {
  const bytes = Buffer.concat([encode({ text: 'é😀\u0000' }), encode(null), encode(false)]);
  for (const shared of [false, true]) {
    for (let split = 0; split <= bytes.length; split++) {
      const chunks = [view(bytes.subarray(0, split), shared), new Uint8Array(0), view(bytes.subarray(split), shared)];
      assert.deepEqual(trace(NativeDecoder, chunks), trace(Before, chunks), `shared=${shared}, split=${split}`);
    }
  }
});

test('malformed complete bodies stay poisoned after the caller repairs its buffer', () => {
  for (const raw of [Buffer.from('xxxx'), Buffer.from([255, 255, 255, 255])]) {
    for (const shared of [false, true]) {
      for (const split of [0, 4, 5]) {
        const run = Decoder => {
          const decoder = new Decoder(), bytes = view(frame(raw), shared), results = [];
          if (split) results.push(outcome(() => decoder.push(bytes.subarray(0, split))));
          const failure = outcome(() => decoder.push(bytes.subarray(split)));
          assert.ok(failure.error);
          results.push(failure);
          bytes.set(Buffer.from('null'), 4);
          results.push(outcome(() => decoder.push(new Uint8Array(0))), outcome(() => decoder.finish()),
            outcome(() => decoder.push(encode(null))), outcome(() => decoder.push([])), outcome(() => decoder.finish()));
          return results;
        };
        assert.deepEqual(run(NativeDecoder), run(Before));
      }
    }
  }
});

test('seeded malformed bodies preserve errors, follow-up pushes and finish', () => {
  let seed = 0x4e617469;
  const random = () => seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
  for (let trial = 0; trial < 512; trial++) {
    const body = Buffer.alloc(1 + random() % 64);
    for (let index = 0; index < body.length; index++) body[index] = random() >>> 24;
    const bytes = frame(body), split = random() % (bytes.length + 1);
    const chunks = [bytes.subarray(0, split), bytes.subarray(split)];
    assert.deepEqual(trace(NativeDecoder, chunks), trace(Before, chunks), `trial=${trial}`);
  }
});
