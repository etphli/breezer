import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter, getEventListeners } from 'node:events';
import { CodexProvider } from '../../features/ai/host/codex.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
function fixture({ boundary, late = false, invalid, speed = 'standard', counter, exitGate } = {}) {
  const controller = new AbortController(), entered = deferred(), gate = deferred();
  const processes = [], calls = [], events = [], urls = [];
  let active = 0, peak = 0, cleaned = 0, probes = 0;
  const provider = new CodexProvider({ createProcess(_binary, args) {
    const probe = args.includes('model_provider="breezer_probe"');
    const kind = probe ? 'probe' : 'runtime';
    if (probe) urls.push(/base_url="([^"]+)"/.exec(args.at(-1))[1]);
    const rpc = new EventEmitter(); processes.push(rpc); active++; if (counter) { counter.active++; counter.peak = Math.max(counter.peak, counter.active); } peak = Math.max(peak, active);
    rpc.closed = false; rpc.closes = 0;
    const pending = new Set();
    rpc.send = message => { calls.push(`${kind}:${message.method}`); };
    rpc.close = async () => {
      rpc.closes++; rpc.closed = true; events.push(`${kind}:close`);
      for (const reject of pending) reject(new Error('Cancelled.'));
      rpc.emit('closed', new Error('Cancelled.'));
      if (exitGate) await exitGate.promise;
      active--; if (counter) counter.active--;
    };
    rpc.request = async (method, params) => {
      calls.push(`${kind}:${method}`);
      if (`${kind}:${method}` === boundary) {
        entered.resolve();
        if (late) await gate.promise;
        else await new Promise((resolve, reject) => { pending.add(reject); gate.promise.then(resolve, reject); });
      }
      if (method === 'thread/start') return { thread: { id: kind } };
      if (method === 'turn/start' && probe) {
        probes++;
        const base = /base_url="([^"]+)"/.exec(args.at(-1))[1];
        if (boundary === 'probe:receive') { entered.resolve(); return {}; }
        const input = { tools: provider.tools, reasoning: { effort: 'high' }, service_tier: speed === 'fast' ? 'priority' : 'default' };
        if (invalid === 'tools') input.tools.push({ type: 'function', name: 'exec_command' });
        if (invalid === 'reasoning') input.reasoning.effort = 'low';
        if (invalid === 'speed') input.service_tier = 'wrong';
        const response = await fetch(`${base}/responses`, { method: 'POST', headers: invalid === 'credentials' ? { authorization: 'fake-only' } : {}, body: JSON.stringify(input) });
        await response.text();
      }
      if (method === 'turn/start' && !probe && boundary === 'runtime:done') { entered.resolve(); return {}; }
      if (method === 'turn/start' && !probe) setImmediate(() => rpc.emit('message', { method: 'turn/completed', params: { turn: { status: 'completed' } } }));
      return {};
    };
    if (boundary === `${kind}:spawn`) controller.abort();
    return rpc;
  } });
  provider.status = { available: true }; provider.authenticated = true; provider.defaultModel = 'fixture';
  provider.models = [{ id: 'fixture', reasoningEfforts: ['high'], defaultReasoningEffort: 'high', fastMode: { supported: true, serviceTier: 'priority' } }];
  provider.catalog = { models: [{ slug: 'fixture' }] };
  provider.isolate = async () => {
    if (boundary === 'isolate') { entered.resolve(); await gate.promise; }
    return { directory: '/owned-fake', env: {}, cleanup: async () => { assert.equal(active, 0); cleaned++; events.push('cleanup'); } };
  };
  // Retain the actual security preflight and capture only its expected declarations.
  const preflight = provider.preflight.bind(provider);
  provider.preflight = (...args) => { provider.tools = args[2].map(tool => ({ type: 'function', name: tool.name })); return preflight(...args); };
  return { provider, controller, entered, gate, calls, processes, events, urls,
    get active() { return active; }, get peak() { return peak; }, get cleaned() { return cleaned; }, get probes() { return probes; },
    run() { return provider.chat({ message: 'offline fixture', control: true, speed }, { signal: controller.signal, emit() {}, callTool() {} }); },
    check(expectedCleaned = 1) { assert.equal(active, 0); assert.equal(cleaned, expectedCleaned); for (const rpc of processes) { assert.equal(rpc.closes, 1); assert.equal(rpc.listenerCount('closed'), 0); assert.equal(rpc.listenerCount('message'), 0); } assert.equal(getEventListeners(controller.signal, 'abort').length, 0); },
  };
}

test('abort during probe initialize closes owned setup before gate release', async () => {
  const f = fixture({ boundary: 'probe:initialize' });
  const result = assert.rejects(f.run(), /^Error: Cancelled\.$/);
  await f.entered.promise; f.controller.abort(); await tick();
  try { assert.equal(f.active, 0); assert.equal(f.cleaned, 1); }
  finally { f.gate.resolve(); await result; }
  f.check(); assert.equal(f.calls.some(call => call.startsWith('runtime:')), false);
});

for (const boundary of ['probe:thread/start', 'probe:turn/start', 'probe:receive', 'runtime:initialize', 'runtime:thread/start', 'runtime:turn/start', 'runtime:done']) {
  test(`cancellation closes setup at ${boundary}`, async () => {
    const f = fixture({ boundary });
    const result = assert.rejects(f.run(), /^Error: Cancelled\.$/);
    await f.entered.promise; f.controller.abort();
    await result; f.check();
    const count = f.calls.length;
    f.gate.resolve(); await tick(); assert.equal(f.calls.length, count);
    if (boundary.startsWith('probe:')) assert.equal(f.calls.some(call => call.startsWith('runtime:')), false);
    for (const url of f.urls) await assert.rejects(fetch(`${url}/responses`));
  });
}

for (const boundary of ['isolate', 'probe:initialize', 'probe:thread/start', 'probe:turn/start', 'runtime:initialize', 'runtime:thread/start', 'runtime:turn/start']) {
  for (const reject of [false, true]) test(`late ${reject ? 'rejection' : 'resolution'} after abort at ${boundary} is drained`, async () => {
    const f = fixture({ boundary, late: true });
    let settled = false;
    const result = assert.rejects(f.run().finally(() => { settled = true; }), /^Error: Cancelled\.$/);
    await f.entered.promise; f.controller.abort(); await tick();
    assert.equal(f.active, 0);
    assert.equal(settled, false, 'await the pending setup before removing isolation');
    for (const url of f.urls) await assert.rejects(fetch(`${url}/responses`));
    const count = f.calls.length;
    if (reject) f.gate.reject(new Error('late setup failure')); else f.gate.resolve();
    await result; f.check(boundary === 'isolate' && reject ? 0 : 1);
    assert.equal(f.calls.length, count, 'late settlement cannot initiate another RPC');
  });
}

test('already-aborted chat creates no isolation, probe, or runtime', async () => {
  const f = fixture(); let isolates = 0;
  f.provider.isolate = async () => { isolates++; throw new Error('must not isolate'); };
  f.controller.abort(); await assert.rejects(f.run(), /^Error: Cancelled\.$/);
  assert.equal(isolates, 0); assert.equal(f.processes.length, 0);
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

test('isolation cleanup waits for the owned process exit', async () => {
  const exitGate = deferred();
  const f = fixture({ boundary: 'probe:initialize', exitGate });
  const result = assert.rejects(f.run(), /^Error: Cancelled\.$/);
  await f.entered.promise; f.controller.abort(); await tick();
  assert.equal(f.processes[0].closed, true); assert.equal(f.active, 1); assert.equal(f.cleaned, 0);
  exitGate.resolve(); await result; f.check();
});

for (const speed of ['standard', 'fast']) test(`every ${speed} chat runs the actual security preflight`, async () => {
  const f = fixture({ speed });
  await f.run(); await f.run();
  assert.equal(f.probes, 2); assert.equal(f.cleaned, 2); assert.equal(f.peak, 1);
  for (const rpc of f.processes) { assert.equal(rpc.closes, 1); assert.equal(rpc.listenerCount('message'), 0); assert.equal(rpc.listenerCount('closed'), 0); }
  assert.equal(getEventListeners(f.controller.signal, 'abort').length, 0);
});

for (const [invalid, error] of [['tools', /outside Breezer/], ['reasoning', /reasoning level/], ['speed', /selected speed/], ['credentials', /included credentials/]]) {
  test(`noncancelled preflight rejects invalid ${invalid} before runtime launch`, async () => {
    const f = fixture({ invalid });
    await assert.rejects(f.run(), error); f.check();
    assert.equal(f.calls.some(call => call.startsWith('runtime:')), false);
  });
}

test('thirty cancelled replacements keep fake owned setup resources bounded', async () => {
  const counter = { active: 0, peak: 0 }, fixtures = [], results = [];
  for (let i = 0; i < 30; i++) {
    const f = fixture({ boundary: 'probe:initialize', counter }); fixtures.push(f);
    results.push(assert.rejects(f.run(), /^Error: Cancelled\.$/));
    await f.entered.promise; f.controller.abort();
  }
  await Promise.all(results);
  assert.equal(counter.active, 0); assert.equal(counter.peak, 1);
  for (const f of fixtures) { f.check(); assert.equal(f.processes.length, 1); }
});

for (const boundary of ['probe:spawn', 'runtime:spawn']) test(`abort racing ${boundary} prevents initialize`, async () => {
  const f = fixture({ boundary });
  await assert.rejects(f.run(), /^Error: Cancelled\.$/); f.check();
  assert.equal(f.calls.includes(boundary.replace(':spawn', ':initialize')), false);
});

test('cancelling one chat leaves a separately owned runtime running', async () => {
  const first = fixture({ boundary: 'runtime:done' }), second = fixture({ boundary: 'runtime:done' });
  const firstResult = assert.rejects(first.run(), /^Error: Cancelled\.$/);
  const secondResult = assert.rejects(second.run(), /^Error: Cancelled\.$/);
  await Promise.all([first.entered.promise, second.entered.promise]);
  first.controller.abort(); await firstResult; first.check();
  assert.equal(second.active, 1); assert.equal(second.processes.at(-1).closed, false);
  second.controller.abort(); await secondResult; second.check();
});
