import test from 'node:test';
import assert from 'node:assert/strict';
import { Organato } from '../../features/ai/host/organato.mjs';

const limit = 2_000_000;
const service = fetcher => new Organato({ fetcher, secrets: { async get() { return 'org_' + 'x'.repeat(43); } } });
function streamed(bytes, size = 65536) {
  let offset = 0, cancelled = false;
  const response = new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return; }
      const end = Math.min(offset + size, bytes.length);
      controller.enqueue(bytes.subarray(offset, end));
      offset = end;
    },
    cancel() { cancelled = true; },
  }, { highWaterMark: 0 }));
  return { response, consumed: () => offset, cancelled: () => cancelled };
}

test('oversized responses stop consumption and cancel the body at the existing character limit', async t => {
  const input = new Uint8Array(4 * 1024 * 1024).fill(0x78);
  const body = streamed(input);
  await assert.rejects(service(async () => body.response).request('/items'), /^Error: Organato response is too large\.$/);
  t.diagnostic(`${body.consumed()} bytes consumed from ${input.length}`);
  assert.ok(body.consumed() <= limit + 65536);
  assert.equal(body.cancelled(), true);
  assert.equal(body.response.body.locked, false);
});

test('UTF-8 splitting, replacement and BOM behavior matches Response.text', async () => {
  const encoder = new TextEncoder();
  const fixtures = [
    encoder.encode(JSON.stringify({ text: 'é漢字😀 \\"\n\t' })),
    new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode('{"text":"with BOM"}')]),
    new Uint8Array([0x22, 0xff, 0xe2, 0x82, 0x22]),
    encoder.encode('null'),
    encoder.encode('{"items":[]}'),
  ];
  for (const bytes of fixtures) {
    const expected = JSON.parse(await new Response(bytes).text());
    for (const size of [1, 2, 3, 4, 7, 65536]) {
      const body = streamed(bytes, size);
      assert.deepEqual(await service(async () => body.response).request('/items'), expected);
    }
  }
});

test('one oversized transport chunk is decoded only up to the rejection boundary', async t => {
  const input = new Uint8Array(4 * 1024 * 1024).fill(0x78), body = streamed(input, input.length);
  const decode = TextDecoder.prototype.decode;
  let decoded = 0;
  TextDecoder.prototype.decode = function (bytes, options) { decoded += bytes?.byteLength || 0; return decode.call(this, bytes, options); };
  try { await assert.rejects(service(async () => body.response).request('/items'), /response is too large/); }
  finally { TextDecoder.prototype.decode = decode; }
  t.diagnostic(`${decoded} bytes decoded from one ${input.length}-byte chunk`);
  assert.ok(decoded <= limit + 65536);
});

test('non-byte stream chunks retain Response.text rejection', async () => {
  for (const value of ['text', {}, new Uint16Array([123, 125])]) {
    const response = () => new Response(new ReadableStream({ start(controller) { controller.enqueue(value); controller.close(); } }));
    await assert.rejects(response().text(), TypeError);
    await assert.rejects(service(async () => response()).request('/items'), TypeError);
  }
});

test('leading BOM removal matches the pinned Response.text implementation', async () => {
  const json = new TextEncoder().encode('{"ok":true}');
  for (let count = 0; count <= 4; count++) {
    const bytes = new Uint8Array(count * 3 + json.length);
    for (let i = 0; i < count; i++) bytes.set([0xef, 0xbb, 0xbf], i * 3);
    bytes.set(json, count * 3);
    for (const size of [1, 2, 3, 7, 64, 65536]) {
      const request = () => service(async () => streamed(bytes, size).response).request('/items');
      if (count <= 2) {
        assert.deepEqual(await request(), JSON.parse(await new Response(bytes).text()));
      } else {
        await assert.rejects(async () => JSON.parse(await new Response(bytes).text()), SyntaxError);
        await assert.rejects(request(), SyntaxError);
      }
    }
  }
});

test('stalled or rejected cancellation never hides the size error or retains the reader lock', async () => {
  for (const kind of ['stalled', 'rejected']) {
    let release;
    const cancellation = new Promise(resolve => { release = resolve; });
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(limit + 1).fill(0x78)); },
      cancel() { return kind === 'stalled' ? cancellation : Promise.reject(new Error('Fixture cancellation failed')); },
    }));
    let settled = false;
    const pending = service(async () => response).request('/items').then(
      () => { settled = true; return null; },
      error => { settled = true; return error; },
    );
    await new Promise(resolve => setImmediate(resolve));
    const beforeRelease = { settled, locked: response.body.locked };
    release();
    const error = await pending;
    assert.deepEqual(beforeRelease, { settled: true, locked: false });
    assert.match(error?.message || '', /^Organato response is too large\.$/);
  }
});

test('the exact limit counts decoded UTF-16 characters rather than UTF-8 bytes', async () => {
  for (const character of ['a', '漢', '😀']) {
    const value = character.repeat((limit - 2) / character.length);
    const body = streamed(new TextEncoder().encode(JSON.stringify(value)));
    assert.equal(await service(async () => body.response).request('/items'), value);
    assert.equal(body.cancelled(), false);
  }
  const body = streamed(new TextEncoder().encode('"' + '漢'.repeat(limit - 1) + '"'));
  await assert.rejects(service(async () => body.response).request('/items'), /response is too large/);
});

test('the limit includes replacement characters emitted by the final decoder flush', async () => {
  const prefix = new TextEncoder().encode('"' + 'a'.repeat(limit - 1));
  const bytes = new Uint8Array(prefix.length + 1);
  bytes.set(prefix); bytes[bytes.length - 1] = 0xf0;
  assert.equal((await new Response(bytes).text()).length, limit + 1);
  await assert.rejects(service(async () => streamed(bytes).response).request('/items'), /response is too large/);
});

test('empty, malformed and failed bodies preserve their error behavior', async () => {
  for (const text of [null, '', '{invalid']) {
    await assert.rejects(service(async () => new Response(text)).request('/items'), SyntaxError);
  }
  const failure = new Error('Fixture stream failure');
  const response = new Response(new ReadableStream({ pull(controller) { controller.error(failure); } }));
  await assert.rejects(service(async () => response).request('/items'), error => error === failure);
});

test('abort and HTTP status still follow the original request contract', async () => {
  const abort = new AbortController();
  const pending = service(async (_url, options) => new Response(new ReadableStream({
    start(controller) {
      options.signal.addEventListener('abort', () => controller.error(options.signal.reason), { once: true });
    },
  }))).request('/items', 'GET', undefined, abort.signal);
  await new Promise(resolve => setImmediate(resolve));
  abort.abort();
  await assert.rejects(pending, { name: 'AbortError' });
  for (const status of [401, 403, 409, 429, 500]) {
    const body = new ReadableStream({ pull() { assert.fail('Error body should not be read'); } }, { highWaterMark: 0 });
    await assert.rejects(service(async () => new Response(body, { status })).request('/items'), /Organato|item changed/);
  }
});
