import test from 'node:test';
import assert from 'node:assert/strict';
import { dashboardCacheWithEncoder } from './dashboard-cache-fixture.mjs';

const fingerprint = 'a'.repeat(64);
const encoder = new TextEncoder();
const data = title => ({ items: [{ id: 'one', title, kind: 'todo' }], truncated: false });

async function readTwice(value, maximumBytes) {
  let encodings = 0, temporaryBytes = 0, fetches = 0;
  const create = dashboardCacheWithEncoder(class extends TextEncoder {
    encode(text) {
      const bytes = super.encode(text);
      encodings++;
      temporaryBytes += bytes.length;
      return bytes;
    }
  });
  const cache = create({ maximumBytes, now: () => 100 });
  const fetch = async () => { fetches++; return value; };
  const first = await cache.load({ fingerprint, fetch });
  const second = await cache.load({ fingerprint, fetch });
  assert.equal(first.value, value);
  assert.equal(second.value, value);
  return { cached: second.cached, encodings, temporaryBytes, fetches };
}

test('a provably bounded dashboard avoids a temporary UTF-8 array', async () => {
  const value = data('日本語🙂');
  const result = await readTwice(value, 1024 * 1024);
  assert.equal(result.cached, true);
  assert.equal(result.fetches, 1);
  assert.equal(result.encodings, 0);
  assert.equal(result.temporaryBytes, 0);
});

test('ambiguous size checks retain exact native UTF-8 limits', async () => {
  for (const title of ['x'.repeat(160), '界'.repeat(160), '🙂'.repeat(80), '\ud800'.repeat(50), '\udfff'.repeat(50)]) {
    const value = data(title);
    const nativeBytes = encoder.encode(JSON.stringify(value)).byteLength;
    for (const maximumBytes of [nativeBytes - 1, nativeBytes, nativeBytes + 1]) {
      const result = await readTwice(value, maximumBytes);
      const expected = nativeBytes <= maximumBytes;
      assert.equal(result.cached, expected);
      assert.equal(result.fetches, expected ? 1 : 2);
      if (JSON.stringify(value).length <= maximumBytes) assert.ok(result.encodings > 0);
      else assert.equal(result.encodings, 0);
    }
  }
});

test('cache admission matches native encoding across Unicode and length bounds', async () => {
  let seed = 0x592a;
  const next = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0);
  for (let i = 0; i < 160; i++) {
    let title = '';
    for (let j = 0, length = next() % 100; j < length; j++) title += String.fromCharCode(next() & 0xffff);
    const value = data(title);
    const text = JSON.stringify(value);
    const nativeBytes = encoder.encode(text).byteLength;
    const limits = [0, text.length - 1, text.length, nativeBytes - 1, nativeBytes, text.length * 3, 1024 * 1024];
    const maximumBytes = limits[i % limits.length];
    const result = await readTwice(value, maximumBytes);
    assert.equal(result.cached, nativeBytes <= maximumBytes);
  }
});

test('malformed data and failed JSON serialization remain uncached', async () => {
  const cycle = data('cycle'); cycle.self = cycle;
  for (const value of [{ items: [null], truncated: false }, { items: [], truncated: 'false' }, cycle]) {
    const result = await readTwice(value, 1024 * 1024);
    assert.equal(result.cached, false);
    assert.equal(result.fetches, 2);
    assert.equal(result.encodings, 0);
  }
});
