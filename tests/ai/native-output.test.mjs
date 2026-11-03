import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeMessage, MAX_OUTPUT_BYTES, NativeDecoder } from '../../features/ai/host/protocol.mjs';
import { sources, encoder, probe } from '../../script/verify_native_output_efficiency.mjs';

const { before, current } = sources();
const old = encoder(before).encode, next = encoder(current).encode;

function compare(value) {
  const expected = old(value), actual = next(value);
  assert.deepEqual(actual, expected);
  assert.deepEqual(encodeMessage(value), expected, 'VM executes the actual production encoder');
  assert.equal(actual.readUInt32LE(0), actual.length - 4);
  const decoder = new NativeDecoder();
  const decoded = decoder.push(actual);
  decoder.finish();
  assert.deepEqual(decoded, [JSON.parse(JSON.stringify(value))]);
}

test('output frames preserve JSON values, Unicode and control characters', () => {
  for (const value of [null, true, false, 0, -0, NaN, Infinity, '', [], {},
    { type: 'delta', id: 'one', text: '\0\n\r\t"\\ é😀中\ud800\udfff' },
    { type: 'complete', items: [undefined, null, false, 12.5], omitted: undefined },
    ['x', { nested: ['😀', '\ufeff', '\u2028\u2029'] }]]) compare(value);
});

test('deterministic mixed UTF-16 strings produce identical complete frames', () => {
  let seed = 8314;
  for (let i = 0; i < 1000; i++) {
    let text = '';
    for (let j = 0; j < i % 97; j++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += String.fromCharCode(seed >>> 16);
    }
    compare({ id: i, text, nested: [text.slice(0, 7), i % 2 === 0] });
  }
});

test('output limit remains a UTF-8 byte limit including exact boundaries', () => {
  for (const text of ['x'.repeat(MAX_OUTPUT_BYTES - 11), 'é'.repeat((MAX_OUTPUT_BYTES - 12) / 2) + 'a']) {
    compare({ text });
    assert.equal(encodeMessage({ text }).length, MAX_OUTPUT_BYTES + 4);
    for (const encode of [old, next, encodeMessage]) assert.throws(() => encode({ text: text + 'a' }), /Native response is too large/);
  }
});

test('JSON hooks run once and serialization errors preserve their error class', () => {
  for (const encode of [old, next, encodeMessage]) {
    let calls = 0;
    const value = { toJSON() { calls++; return { calls, text: 'é😀' }; } };
    assert.deepEqual(JSON.parse(encode(value).subarray(4)), { calls: 1, text: 'é😀' });
    assert.equal(calls, 1);
    const circular = {}; circular.self = circular;
    for (const invalid of [undefined, () => {}, Symbol('x'), 1n, circular]) {
      assert.throws(() => encode(invalid), error => error.name === 'TypeError');
    }
    assert.throws(() => encode({ get value() { throw new RangeError('fixture'); } }), error => error.name === 'RangeError' && error.message === 'fixture');
  }
});

test('valid output removes the temporary header buffer; oversized rejection remains unchanged', () => {
  const result = probe();
  for (const row of Object.values(result.cases)) {
    assert.equal(row.current.allocations, 2);
    assert.equal(row.current.requestedBufferBytes, row.bodyBytes + row.frameBytes);
    assert.equal(row.current.concatCopiedBytes, 0);
    assert.equal(row.current.explicitCopiedBytes, row.bodyBytes);
    assert.equal(row.baseline.requestedBufferBytes, row.frameBytes * 2);
    assert.equal(row.baseline.concatCopiedBytes, row.frameBytes);
  }
  assert.deepEqual(result.oversizedReply.current, result.oversizedReply.baseline);
  assert.ok(result.oversizedReply.baseline.requestedBufferBytes > MAX_OUTPUT_BYTES);
});

test('prefilled allocation exposes any unwritten frame bytes', () => {
  for (const size of [0, 1, 7, 31, 4095, 8193]) {
    const value = { text: 'é😀\ud800'.repeat(size) };
    assert.deepEqual(encoder(current, true).encode(value), old(value));
  }
});
