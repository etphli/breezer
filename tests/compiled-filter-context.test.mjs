import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createBundledFilterReader } from '../features/performance/compiled-filter-lists.mjs';

const source = readFileSync(process.env.COMPILED_FILTER_CONTEXT_SOURCE ||
  new URL('../features/performance/compiled-filter-context.js', import.meta.url), 'utf8');
const imports = [
  "import { createBundledFilterReader } from './breezer-compiled-filter-lists.js';",
  "import { buildId, engineVersion, engineJavaScriptVersion } from './breezer-compiled-filter-build.js';",
  "import { getTrustedTokens } from './trusted-tokens.js';",
  "import io from './assets.js';",
  "import staticNetFilteringEngine from './static-net-filtering.js';",
  "import µb from './background.js';",
];
// Substitute only the known dependency bindings and export syntax. Execute the
// complete production body, including getContext, observer and consume fencing.
assert.deepEqual(source.match(/^import .*;$/gm), imports);
let script = source;
for (const line of imports) script = script.replace(line, '');
assert.equal(script.match(/^export /gm)?.length, 1);
script = script.replace('export const bundledFilterLists =', 'const bundledFilterLists =');
const encode = text => new TextEncoder().encode(text);
const sha256 = value => createHash('sha256').update(value).digest('hex');
const tokenDigest = tokens => sha256(JSON.stringify([...tokens].sort()));
const plain = value => JSON.parse(JSON.stringify(value));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};

function fixture({ tokens = ['z', 'a'], digest, readResource, afterLoad } = {}) {
  const state = {
    tokens: new Set(tokens), compiledMagic: 72, environment: new Set(['native_css_has', 'chromium']),
    maxTokenLength: 7, canFilterResponseBody: true, trusted: false,
  };
  const counts = { tokenReads: 0, trustReads: [], encoders: 0, encodes: 0, hexConversions: 0, hashes: [] };
  let getContext, observer;
  class CountingEncoder extends TextEncoder {
    constructor() { super(); counts.encoders++; }
    encode(value) { counts.encodes++; return super.encode(value); }
  }
  class CountingBytes extends Uint8Array {
    [Symbol.iterator]() { counts.hexConversions++; return super[Symbol.iterator](); }
  }
  const bindings = {
    buildId: 'a'.repeat(64), engineVersion: '156.0.8078.47', engineJavaScriptVersion: 'fixture-js',
    createBundledFilterReader(options) {
      getContext = options.getContext;
      const reader = readResource ? createBundledFilterReader({ ...options, readResource }) :
        { tryLoad: async () => ({ kind: 'miss' }) };
      return { tryLoad(request) {
        const result = reader.tryLoad(request);
        // Cross-realm await adopts the host promise first. Place the update
        // after that adoption, immediately behind the module's read resumption.
        if (afterLoad) result.then(() => queueMicrotask(() => queueMicrotask(afterLoad)));
        return result;
      } };
    },
    getTrustedTokens() { counts.tokenReads++; return state.tokens; },
    io: { addObserver(callback) { assert.equal(observer, undefined); observer = callback; } },
    staticNetFilteringEngine: { get MAX_TOKEN_LENGTH() { return state.maxTokenLength; } },
    µb: {
      systemSettings: { get compiledMagic() { return state.compiledMagic; } },
      get canFilterResponseData() { return state.canFilterResponseBody; },
      isTrustedList(assetKey) { counts.trustReads.push(assetKey); return state.trusted; },
    },
    vAPI: { webextFlavor: { get env() { return state.environment; } } },
    TextEncoder: CountingEncoder, Uint8Array: CountingBytes,
    crypto: { subtle: { digest(algorithm, bytes) {
      assert.equal(algorithm, 'SHA-256');
      const call = { text: new TextDecoder().decode(bytes), bytes: Uint8Array.from(createHash('sha256').update(bytes).digest()).buffer };
      counts.hashes.push(call);
      return digest ? digest(call, counts.hashes.length) : webcrypto.subtle.digest(algorithm, bytes);
    } } },
  };
  const { bundledFilterLists } = runInNewContext(`'use strict';\n${script}\n({ bundledFilterLists });`, bindings,
    { filename: 'compiled-filter-context.js' });
  return { state, counts, getContext, bundledFilterLists, notify: (topic, details) => observer(topic, details),
    expected: () => ({ buildId: bindings.buildId, engineVersion: bindings.engineVersion,
      engineJavaScriptVersion: bindings.engineJavaScriptVersion, compiledMagic: state.compiledMagic,
      environment: [...state.environment].sort(), maxTokenLength: state.maxTokenLength,
      canFilterResponseBody: state.canFilterResponseBody, trustedTokensSha256: tokenDigest(state.tokens),
      trustedSource: state.trusted }) };
}

test('context digests match current canonical token values', async () => {
  for (const tokens of [[], ['abc'], ['é', '😀', 'e\u0301'], ['a,b', '"', '\\', '\n', '']]) {
    const f = fixture({ tokens });
    assert.deepEqual(plain(await f.getContext('easylist')), f.expected());
    assert.equal(f.counts.hashes[0].text, JSON.stringify([...tokens].sort()));
    f.state.tokens.add('later');
    assert.deepEqual(plain(await f.getContext('easyprivacy')), f.expected());
  }
});

test('one failed digest does not reject an independent concurrent lookup', async () => {
  const failure = new Error('first digest failed');
  const f = fixture({ digest: (call, i) => i === 1 ? Promise.reject(failure) : Promise.resolve(call.bytes) });
  const results = await Promise.allSettled([f.getContext('first'), f.getContext('second')]);
  assert.deepEqual(results.map(result => result.status), ['rejected', 'fulfilled']);
  assert.equal(results[0].reason, failure);
  assert.deepEqual(plain(results[1].value), f.expected());
  assert.deepEqual(plain(await f.getContext('retry')), f.expected());
});

test('concurrent lookups retain their own invocation token snapshots', async () => {
  const gates = [deferred(), deferred()];
  const f = fixture({ tokens: ['old'], digest: (call, i) => gates[i - 1].promise.then(() => call.bytes) });
  const first = f.getContext('old-list'); f.state.tokens = new Set(['new']);
  const second = f.getContext('new-list'); gates[1].resolve();
  assert.equal((await second).trustedTokensSha256, tokenDigest(['new'])); gates[0].resolve();
  assert.equal((await first).trustedTokensSha256, tokenDigest(['old']));
});

test('capabilities and trust remain live after the digest await', async () => {
  const gate = deferred(), f = fixture({ digest: call => gate.promise.then(() => call.bytes) });
  const pending = f.getContext('easylist');
  f.state.compiledMagic++; f.state.environment = new Set(['firefox']);
  f.state.maxTokenLength++; f.state.canFilterResponseBody = false; f.state.trusted = true;
  gate.resolve(); assert.deepEqual(plain(await pending), f.expected());
});

test('synchronous and asynchronous digest failures allow a later retry', async () => {
  for (const synchronous of [true, false]) {
    const failure = new Error('digest failed');
    const f = fixture({ digest(call, i) {
      if (i > 1) return Promise.resolve(call.bytes);
      if (synchronous) throw failure;
      return Promise.reject(failure);
    } });
    await assert.rejects(f.getContext('first'), error => error === failure);
    assert.deepEqual(plain(await f.getContext('retry')), f.expected());
  }
});

test('trust failures propagate and the next call can recover', async () => {
  const f = fixture(), failure = new Error('trust unavailable'); let fail = true;
  Object.defineProperty(f.state, 'trusted', { get() {
    if (fail) { fail = false; throw failure; } return false;
  } });
  await assert.rejects(f.getContext('first'), error => error === failure);
  assert.deepEqual(plain(await f.getContext('retry')), f.expected());
});

function readerFixture(options = {}) {
  const rawText = '||ads.example^', content = '72\ncompiled fixture';
  const raw = encode(rawText), payload = encode(content), path = `${sha256(payload)}.txt`;
  const calls = [];
  let active = 0, maximum = 0, catalog;
  const f = fixture({ ...options, readResource: async (name, limit) => {
    calls.push({ name, limit });
    if (name === 'index.json') return encode(JSON.stringify(catalog));
    maximum = Math.max(maximum, ++active);
    try {
      const replacement = await options.onPayload?.(f, name);
      return replacement || payload;
    } finally { active--; }
  } });
  const { buildId, trustedSource, ...context } = f.expected();
  const entry = { path, payloadSha256: sha256(payload), rawSha256: sha256(raw),
    rawBytes: raw.length, payloadBytes: payload.length, trustedSource };
  catalog = { schema: 1, buildId, context, entries: { easylist: entry, easyprivacy: entry } };
  return { ...f, calls, path, content, maximum: () => maximum,
    request: { assetKey: 'easylist', rawText, trustedSource } };
}

const read = (f, request = f.request, consume = result => result) => f.bundledFilterLists.read(request, consume);

test('11 bundled hits keep both live checks and serialized verified payload reads', async () => {
  const f = readerFixture();
  const results = await Promise.all(Array.from({ length: 11 }, () => read(f)));
  assert.ok(results.every(result => result.kind === 'hit' && result.content === f.content));
  assert.equal(f.counts.tokenReads, 22);
  assert.equal(f.counts.trustReads.length, 22);
  assert.equal(f.calls.filter(call => call.name === 'index.json').length, 1);
  assert.equal(f.calls.filter(call => call.name === f.path).length, 11);
  assert.equal(f.maximum(), 1);
});

test('every live capability, trust and token mutation between reader checks causes fallback', async () => {
  for (const mutate of [
    state => state.compiledMagic++, state => state.environment.add('firefox'),
    state => state.maxTokenLength++, state => state.canFilterResponseBody = false,
    state => state.trusted = true, state => state.tokens.add('new'),
  ]) {
    const f = readerFixture({ onPayload: f => { mutate(f.state); } });
    assert.equal((await read(f)).kind, 'miss');
    assert.equal(f.counts.tokenReads, 2);
    assert.equal(f.counts.trustReads.length, 2);
  }
});

test('digest errors select reader fallback and the next request can hit', async () => {
  for (const synchronous of [true, false]) {
    const f = readerFixture({ digest(call, i) {
      if (i > 1) return Promise.resolve(call.bytes);
      if (synchronous) throw new Error('digest unavailable');
      return Promise.reject(new Error('digest unavailable'));
    } });
    assert.equal((await read(f)).kind, 'miss');
    assert.equal(f.calls.filter(call => call.name === f.path).length, 0);
    assert.equal((await read(f)).kind, 'hit');
  }
});

test('live context preserves raw and payload integrity checks', async () => {
  let corrupt = false;
  const f = readerFixture({ onPayload: () => corrupt ? encode('72\ncorrupt payload!') : undefined });
  assert.equal((await read(f)).kind, 'hit');
  assert.equal((await read(f, { ...f.request, rawText: '||bad.example^' })).kind, 'miss');
  corrupt = true;
  assert.equal((await read(f)).kind, 'miss');
});

test('active asset updates fence all pending matching reads and allow later retries', async () => {
  let update = true;
  const f = readerFixture({ onPayload(f) {
    if (!update) return;
    update = false;
    f.notify('after-asset-updated', { assetKey: 'easylist' });
  } });
  const results = await Promise.all([read(f), read(f), read(f, { ...f.request, assetKey: 'easyprivacy' })]);
  assert.deepEqual(results.map(result => result.kind), ['retry', 'retry', 'hit']);
  assert.equal((await read(f)).kind, 'hit');
});

test('unrelated observer topics and asset keys do not invalidate a hit', async () => {
  const f = readerFixture({ onPayload(f) {
    f.notify('before-asset-updated', { assetKey: 'easylist' });
    f.notify('after-asset-updated', { assetKey: 'other' });
  } });
  assert.equal((await read(f)).kind, 'hit');
});

test('freshness check and consume stay in one turn, with cleanup after a consumer error', async () => {
  let updated = false, f;
  f = readerFixture({ afterLoad() {
    updated = true;
    f.notify('after-asset-updated', { assetKey: 'easylist' });
  } });
  const failure = new Error('consumer failed');
  await assert.rejects(read(f, f.request, result => {
    assert.equal(updated, false);
    assert.equal(result.kind, 'hit');
    throw failure;
  }), error => error === failure);
  assert.equal(updated, true);
  assert.equal((await read(f)).kind, 'hit');
});
