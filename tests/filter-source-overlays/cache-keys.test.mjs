import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {test as nodeTest} from 'node:test';

import {join} from 'node:path';
import {root} from './fixtures/main-port-20261115/fixture.mjs';

for (const bundled of [false, true]) {
const arm = process.env.CACHE_KEYS_ARM ?? 'source';
const test = (name, fn) => nodeTest(`${bundled ? 'bundled' : 'module'}: ${name}`, fn);


const source = readFileSync(join(root(arm), bundled ? 'breezer-startup-body.js' : 'cachestorage.js'), 'utf8');
const bridge = readFileSync(join(root(arm), 'webext.js'), 'utf8');
const method = source.slice(source.indexOf('        async keys(regex) {'), source.indexOf('        async set(rawbin) {'));
const helperStart = source.indexOf(bundled ? 'extensionStorageKeys = async' : 'const extensionStorageKeys =');
const helperEnd = helperStart < 0 ? -1 : source.indexOf(bundled ? '    pendingWrite = ' : 'const pendingWrite', helperStart);
const helper = helperStart < 0 ? '' : (bundled ? 'const ' : '') + source.slice(helperStart, helperEnd);

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return {promise, resolve};
}

function fixture({mode = 'supported', data = {'cache/a': 'x'.repeat(65536), setting: 1}, backend = ['cache/backend'], barrier, readiness, backendFailure = false, nativeKeys} = {}) {
    const calls = {get: 0, getKeys: 0, backend: 0, payloadChars: 0, errors: 0};
    let context;
    const chrome = {runtime: {}, alarms: {}, browserAction: {}, contextMenus: {},
        privacy: {network: {networkPredictionEnabled: {}, webRTCIPHandlingPolicy: {}}, websites: {hyperlinkAuditingEnabled: {}}},
        tabs: {}, windows: {}, webNavigation: {}, storage: {local: {}}};
    const local = chrome.storage.local;
    const respond = (callback, value, failed) => queueMicrotask(() => {
        if (failed) chrome.runtime.lastError = vm.runInContext('({message:"storage failed"})', context);
        try { callback(value); } finally { delete chrome.runtime.lastError; }
    });
    local.get = function(arg, callback) {
        assert.equal(this, local);
        assert.equal(arg, null);
        calls.get++;
        calls.payloadChars += Object.values(data).reduce((n, v) => n + (typeof v === 'string' ? v.length : 0), 0);
        respond(callback, data, mode === 'both-fail');
    };
    if (mode !== 'missing') local.getKeys = function(callback) {
        assert.equal(this, local);
        calls.getKeys++;
        if (mode === 'throw') throw Error('unsupported call');
        const keys = mode === 'invalid' ? undefined : nativeKeys ?? Object.keys(data);
        respond(callback, keys, mode === 'reject' || mode === 'both-fail');
    };
    const removed = Symbol('removed');
    const pendingWrite = new Map();
    context = vm.createContext({chrome, console: {error() { calls.errors++; }},
        cacheAPIs: {indexedDB: {keys() { calls.backend++; return backendFailure ? Promise.reject(Error('backend failed')) : Promise.resolve(backend); }}},
        fastCache: 'indexedDB', readBarrier: barrier?.promise ?? Promise.resolve(),
        backendReadiness: new Map([['indexedDB', readiness?.promise]]),
        pendingWrite, pendingClear: undefined, removed});
    vm.runInContext(bridge.replace('export default webext;', 'globalThis.webextResult = webext;'), context);
    vm.runInContext('const extensionStorage = webextResult.storage.local;\n' + helper + '\nglobalThis.cache = ({' + method + '});', context);
    return {context, calls, pendingWrite, removed, data,
        keys: regex => context.cache.keys(regex).then(set => Array.from(set))};
}

test('supported API returns the same key union without retrieving any values', async () => {
    const f = fixture();
    assert.deepEqual(await f.keys(/^cache\//), ['cache/backend', 'cache/a']);
    assert.equal(f.calls.get, 0);
    assert.equal(f.calls.getKeys, 1);
    assert.equal(f.calls.payloadChars, 0);
});

for (const mode of ['missing', 'reject', 'throw', 'invalid']) {
    test(`${mode} keys API retains the legacy value-read fallback`, async () => {
        const f = fixture({mode});
        assert.deepEqual(await f.keys(/^cache\//), ['cache/backend', 'cache/a']);
        assert.equal(f.calls.get, 1);
        assert.equal(f.calls.payloadChars, 65536);
    });
}

test('both mirror APIs failing still returns the backend and pending keys', async () => {
    const f = fixture({mode: 'both-fail'});
    f.pendingWrite.set('cache/pending', {value: 'pending'});
    assert.deepEqual(await f.keys(/^cache\//), ['cache/backend', 'cache/pending']);
});

test('pending removal and pending additions override both persistent stores', async () => {
    const f = fixture();
    f.pendingWrite.set('cache/a', {value: f.removed});
    f.pendingWrite.set('cache/backend', {value: f.removed});
    f.pendingWrite.set('cache/new', {value: 'new'});
    assert.deepEqual(await f.keys(/^cache\//), ['cache/new']);
});

test('pending clear reads neither backend nor mirror', async () => {
    const f = fixture();
    f.context.pendingClear = {};
    f.pendingWrite.set('cache/new', {value: 'new'});
    assert.deepEqual(await f.keys(/^cache\//), ['cache/new']);
    assert.deepEqual(f.calls, {get: 0, getKeys: 0, backend: 0, payloadChars: 0, errors: 0});
});

test('read barrier and backend readiness both precede any storage read', async () => {
    const barrier = deferred(), readiness = deferred();
    const f = fixture({barrier, readiness});
    const result = f.keys();
    await Promise.resolve();
    assert.equal(f.calls.backend + f.calls.get + f.calls.getKeys, 0);
    barrier.resolve();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(f.calls.backend + f.calls.get + f.calls.getKeys, 0);
    f.pendingWrite.set('cache/late', {value: 'late'});
    readiness.resolve();
    assert.deepEqual(await result, ['cache/backend', 'cache/a', 'setting', 'cache/late']);
});

test('writes and removals arriving during mirror read remain visible', async () => {
    const f = fixture();
    const result = f.keys(/^cache\//);
    queueMicrotask(() => {
        f.pendingWrite.set('cache/a', {value: f.removed});
        f.pendingWrite.set('cache/late', {value: 'late'});
    });
    assert.deepEqual(await result, ['cache/backend', 'cache/late']);
});

test('backend failure still rejects instead of silently accepting mirror keys', async () => {
    const f = fixture({backendFailure: true});
    await assert.rejects(f.keys(), /backend failed/);
});

test('empty stores stay empty and no regex returns every key', async () => {
    assert.deepEqual(await fixture({data: {}, backend: []}).keys(), []);
    assert.deepEqual(await fixture().keys(), ['cache/backend', 'cache/a', 'setting']);
});

test('integer-like and special keys keep Object.keys ordering and avoid prototype setters', async () => {
    const data = JSON.parse('{"9":"nine","1":"one","__proto__":"literal","constructor":"ctor","cache/a":"a"}');
    const f = fixture({data, backend: []});
    assert.deepEqual(await f.keys(), Object.keys(data));
    assert.equal(f.calls.get, 0);
});

test('native key lists are normalized to the former object-enumeration order', async () => {
    const data = JSON.parse('{"100":"hundred","2":"two","__proto__":"literal","cache/a":"a","constructor":"ctor"}');
    const f = fixture({data, backend: [], nativeKeys: ['100', '2', '__proto__', 'cache/a', 'constructor']});
    assert.deepEqual(await f.keys(), Object.keys(data));
    assert.equal(f.calls.get, 0);
});

test('keys-only result retains the original ordered global-RegExp behavior', async () => {
    const data = {'cache/a': 1, 'cache/b': 2, 'cache/c': 3, 'cache/d': 4};
    const f = fixture({data, backend: []});
    const regex = /^cache\//g;
    const expectedRegex = /^cache\//g;
    const expected = Object.keys(data).filter(k => expectedRegex.test(k));
    assert.deepEqual(await f.keys(regex), expected);
    assert.equal(regex.lastIndex, expectedRegex.lastIndex);
});

}
