import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createBundledFilterReader } from '../features/performance/compiled-filter-lists.mjs';
const encode = text => new TextEncoder().encode(text);
const digest = value => createHash('sha256').update(value).digest('hex');
function fixture(rawText = '||ads.example^', content = '72\ncompiled fixture') {
  const context = { compiledMagic: 72, environment: ['chromium', 'native_css_has'], maxTokenLength: 7, trustedTokensSha256: 'b'.repeat(64), engineVersion: '156.0.8078.47' };
  const payload = encode(content), raw = encode(rawText), path = `${digest(payload)}.txt`;
  const catalog = { schema: 1, buildId: 'a'.repeat(64), context, entries: { easylist: { path, payloadSha256: digest(payload), rawSha256: digest(raw), rawBytes: raw.length, payloadBytes: payload.length, trustedSource: false } } };
  const calls = [], state = { context: { ...context, buildId: catalog.buildId, trustedSource: false }, payload };
  const readResource = async (name, maximum) => { calls.push({ name, maximum }); return name === 'index.json' ? encode(JSON.stringify(catalog)) : state.payload; };
  const reader = createBundledFilterReader({ getContext: async () => state.context, readResource });
  return { reader, catalog, state, calls, path, content, request: { assetKey: 'easylist', rawText, trustedSource: false } };
}

test('matching compiled bytes are returned without retaining payloads or refetching the index', async () => {
  const f = fixture();
  assert.deepEqual(await f.reader.tryLoad(f.request), { kind: 'hit', content: f.content });
  assert.equal((await f.reader.tryLoad(f.request)).kind, 'hit');
  assert.equal(f.calls.filter(call => call.name === 'index.json').length, 1);
  assert.equal(f.calls.filter(call => call.name === f.path).length, 2);
});

test('raw text changes and unknown/user/external keys miss before a payload read', async () => {
  for (const patch of [{ rawText: '||bad.example^' }, { rawText: 'changed' }, { assetKey: 'unknown' }, { assetKey: 'user-filters' }, { assetKey: 'https://example.com/list' }, { assetKey: 'constructor' }]) {
    const f = fixture();
    assert.equal((await f.reader.tryLoad({ ...f.request, ...patch })).kind, 'miss');
    assert.ok(f.calls.every(call => call.name === 'index.json'));
  }
});

test('each live compilation or trust difference selects ordinary fallback', async () => {
  const mutations = [ctx => ctx.buildId = 'c'.repeat(64), ctx => ctx.compiledMagic++, ctx => ctx.environment.push('firefox'), ctx => ctx.maxTokenLength++, ctx => ctx.engineVersion = '157.0.0.0', ctx => ctx.trustedTokensSha256 = 'd'.repeat(64), ctx => ctx.trustedSource = true];
  for (const change of mutations) {
    const f = fixture();f.state.context = structuredClone(f.state.context);change(f.state.context);
    assert.equal((await f.reader.tryLoad(f.request)).kind, 'miss');
    assert.ok(f.calls.every(call => call.name === 'index.json'));
  }
});

test('a trust change during payload I/O cannot return a previously trusted result', async () => {
  const f = fixture();
  const reader = createBundledFilterReader({ getContext: () => f.state.context, readResource: async path => {
    if (path === 'index.json') return encode(JSON.stringify(f.catalog));
    f.state.context = { ...f.state.context, trustedSource: true };
    return f.state.payload;
  } });
  assert.equal((await reader.tryLoad(f.request)).kind, 'miss');
});

test('corrupt, truncated, invalid UTF-8 and wrong-magic payloads miss', async () => {
  const corrupt = fixture();corrupt.state.payload = encode('72\nchanged payload');
  assert.equal((await corrupt.reader.tryLoad(corrupt.request)).kind, 'miss');
  for (const payload of [encode('72'), new Uint8Array([0xff]), encode('73\ncompiled fixture')]) {
    const f = fixture();f.state.payload = payload;
    // Keep integrity metadata consistent to reach UTF-8 and format checks too.
    Object.assign(f.catalog.entries.easylist, { payloadBytes: payload.length, payloadSha256: digest(payload), path: `${digest(payload)}.txt` });
    assert.equal((await f.reader.tryLoad(f.request)).kind, 'miss');
  }
});

test('unsafe paths, malformed catalogs and sizes outside fixed limits miss', async () => {
  for (const change of [f => f.catalog.schema++, f => f.catalog.entries.easylist.path = '../escape.txt', f => f.catalog.entries.easylist.rawBytes = 9 * 1024 * 1024, f => f.catalog.entries.easylist.payloadBytes = 17 * 1024 * 1024, f => f.catalog.entries.easylist.payloadBytes = -1, f => f.catalog.buildId = 'not a digest']) {
    const f = fixture();change(f);
    assert.equal((await f.reader.tryLoad(f.request)).kind, 'miss');
    assert.ok(f.calls.every(call => call.name === 'index.json'));
  }
  for (const bytes of [encode('bad json'), new Uint8Array([0xff]), new Uint8Array(64 * 1024 + 1)]) {
    const reader = createBundledFilterReader({ getContext: () => ({}), readResource: async () => bytes });
    assert.equal((await reader.tryLoad(fixture().request)).kind, 'miss');
  }
});

test('resource/context errors are misses and do not poison subsequent work', async () => {
  const f = fixture();let fail = true;
  const reader = createBundledFilterReader({ getContext: () => { if (fail) { fail = false; throw new Error('unavailable'); } return f.state.context; }, readResource: async path => path === 'index.json' ? encode(JSON.stringify(f.catalog)) : f.state.payload });
  assert.equal((await reader.tryLoad(f.request)).kind, 'miss');
  assert.equal((await reader.tryLoad(f.request)).kind, 'hit');
});

test('concurrent list loads keep at most one payload buffer in flight', async () => {
  const f = fixture();let active = 0, maximum = 0;
  const reader = createBundledFilterReader({ getContext: () => f.state.context, readResource: async path => {
    if (path === 'index.json') return encode(JSON.stringify(f.catalog));
    maximum = Math.max(maximum, ++active);
    await new Promise(resolve => setTimeout(resolve, 2));active--;
    return f.state.payload;
  } });
  const results = await Promise.all(Array.from({ length: 8 }, () => reader.tryLoad(f.request)));
  assert.ok(results.every(result => result.kind === 'hit'));
  assert.equal(maximum, 1);
});

test('Unicode is byte-exact, with no normalization or lone-surrogate collisions', async () => {
  const f = fixture('café😀');
  assert.equal((await f.reader.tryLoad(f.request)).kind, 'hit');
  assert.equal((await f.reader.tryLoad({ ...f.request, rawText: 'cafe\u0301😀' })).kind, 'miss');
  const replacement = fixture('\ufffd');
  assert.equal((await replacement.reader.tryLoad({ ...replacement.request, rawText: '\ud800' })).kind, 'miss');
});


test('the packaged-resource reader cancels a body that exceeds its fixed index limit', async () => {
  const oldFetch = globalThis.fetch, oldChrome = globalThis.chrome;
  let cancelled = false;
  globalThis.chrome = { runtime: { getURL: path => `chrome-extension://test/${path}` } };
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(64 * 1024 + 1)); },
    cancel() { cancelled = true; },
  }));
  try {
    const reader = createBundledFilterReader({ getContext: () => ({}) });
    assert.equal((await reader.tryLoad(fixture().request)).kind, 'miss');
    assert.equal(cancelled, true);
  } finally { globalThis.fetch = oldFetch; globalThis.chrome = oldChrome; }
});
