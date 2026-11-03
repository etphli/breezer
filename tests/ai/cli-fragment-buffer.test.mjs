import test from 'node:test';
import assert from 'node:assert/strict';
import { JsonLineProcess } from '../../features/ai/host/cli.mjs';
import { fixture, sources, probe } from '../../script/verify_cli_fragment_efficiency.mjs';

const source = await sources();
const limit = 16 * 1024 * 1024;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function compare(action) {
  const results = [];
  for (const kind of ['baseline', 'current']) {
    const f = fixture(source[kind]);
    try {
      const extra = await action(f);
      results.push(JSON.parse(JSON.stringify({ events: f.events, writes: f.writes, kills: f.kills, closed: f.rpc.closed, extra })));
    } finally { f.dispose(); }
  }
  assert.deepEqual(results[1], results[0]);
  return results[1];
}

test('actual class matches baseline at every UTF-16 split and every UTF-8 byte boundary', async () => {
  const text = '\n \r\n' + JSON.stringify({ text: 'é中😀\ud800\\"\n\u0000' }) + '\r\n' + JSON.stringify({ id: 42, result: 'tail' }) + '\npartial';
  for (let split = 0; split <= text.length; split++) await compare(f => {
    // Direct data emission also exercises splits between UTF-16 surrogate halves.
    f.child.stdout.emit('data', text.slice(0, split)); f.child.stdout.emit('data', text.slice(split));
    return f.rpc.retainedFixtureUnits();
  });
  const bytes = Buffer.from(text);
  for (let split = 0; split <= bytes.length; split++) await compare(f => {
    assert.equal(f.child.stdout.readableEncoding, 'utf8');
    f.push(bytes.subarray(0, split)); f.push(bytes.subarray(split));
    return f.rpc.retainedFixtureUnits();
  });
  await compare(f => { for (const byte of bytes) f.push(Buffer.from([byte])); return f.rpc.retainedFixtureUnits(); });
});

test('blank lines, malformed JSON and listener errors preserve error and message order', async () => {
  for (const chunks of [ [' \r\n\n', '{broken}\n{"a":1}\n{"b":2}\n'], ['null\n{"next":true}\n'], ['{"a":', '1}\n{bad', '}\n', '{"last":3}\n'] ]) {
    await compare(f => { for (const chunk of chunks) f.push(chunk); return f.rpc.retainedFixtureUnits(); });
  }
  await compare(f => {
    f.rpc.once('message', () => { throw new Error('listener failed'); });
    f.push('{"a":1}\n{"b":2}\n');
  });
});

test('whole incoming chunk limit remains UTF-16 based before any lines are dispatched', async () => {
  for (const text of ['x', '😀']) {
    const unit = text.length;
    const content = text.repeat(Math.floor((limit - 3) / unit));
    const exact = '"' + content + '"' + ' '.repeat(limit - content.length - 3) + '\n';
    assert.equal(exact.length, limit);
    const accepted = await compare(f => { f.push(exact.slice(0, -1)); f.push('\n'); return f.events.length; });
    assert.equal(accepted.closed, false);
    const rejected = await compare(f => { f.push(exact.slice(0, -1)); f.push(' \n'); });
    assert.deepEqual(rejected.events, [['closed', 'CLI output exceeded its limit.']]);
  }
  const result = await compare(f => { f.push('{"early":true}\n' + ' '.repeat(limit)); });
  assert.deepEqual(result.events, [['closed', 'CLI output exceeded its limit.']]);
});

test('requests, controls, notifications, failures, sends and timers retain correlations', async () => {
  await compare(async f => {
    const settle = promise => promise.then(value => { f.events.push(['resolved', value]); }, error => { f.events.push(['rejected', error.message]); });
    f.rpc.send({ notification: true });
    const a = settle(f.rpc.request('first'));
    const b = settle(f.rpc.control({ subtype: 'initialize' }));
    const c = settle(f.rpc.request('fail'));
    const d = settle(f.rpc.control({ subtype: 'fail' }));
    const e = settle(f.rpc.request('timeout', {}, 17));
    const frames = [ { id: 1, method: 'notification' }, { id: 1, result: { ok: true } },
      { type: 'control_request', request_id: 'permission', request: { subtype: 'can_use_tool' } },
      { type: 'control_response', method: 'allowed', response: { request_id: 'breezer-2', response: { models: [] } } },
      { id: 3, error: { message: 'request failed' } },
      { type: 'control_response', response: { request_id: 'breezer-4', subtype: 'error', error: 'control failed' } } ];
    const wire = frames.map(JSON.stringify).join('\n') + '\n';
    for (let i = 0; i < wire.length; i += 7) f.push(wire.slice(i, i + 7));
    f.child.stderr.write('stderr'.repeat(10000));
    f.fire(17); await Promise.all([a, b, c, d, e]);
    return { timers: f.timers.size, stderrBuffered: f.child.stderr.readableLength };
  });
});

test('cancellation preserves fragmented in-flight output, pending rejection and confirmed exit', async () => {
  await compare(async f => {
    const pending = f.rpc.request('waiting').catch(error => f.events.push(['rejected', error.message]));
    f.push('{"late":');
    const promise = f.rpc.close(); assert.equal(promise, f.rpc.exited);
    assert.equal(f.rpc.close(), promise);
    let exited = false; promise.then(() => { exited = true; });
    await tick(); assert.equal(exited, false);
    f.push('true}\n{"last":2}\nunfinished');
    f.fire(1000); assert.deepEqual(f.kills, ['SIGTERM', 'SIGKILL']);
    f.child.emit('error', new Error('late error')); f.child.stdin.emit('error', new Error('late stdin'));
    await pending; f.exit(); await promise; assert.equal(exited, true);
    assert.throws(() => f.rpc.send({}), /connection is closed/);
    await assert.rejects(f.rpc.request('closed'), /connection is closed/);
    return { timers: f.timers.size };
  });
});

test('error and close races preserve first error, reject pending once and avoid kill after exit', async () => {
  for (const first of ['stdin', 'child', 'exit']) await compare(async f => {
    const pending = f.rpc.control({}).catch(error => f.events.push(['rejected', error.message]));
    f.push('{"partial":');
    if (first === 'stdin') f.child.stdin.emit('error', new Error('stdin error'));
    else if (first === 'child') f.child.emit('error', new Error('spawn error'));
    else f.exit();
    f.child.emit('error', new Error('second error')); f.exit(); f.fire(1000);
    await pending; await f.rpc.exited;
    return { timers: f.timers.size };
  });
});

test('reentrant output callbacks retain baseline ordering and suffix handling', async () => {
  await compare(f => { f.rpc.once('message', () => f.push('{"nested":true}\n')); f.push('{"first":true}\n{"second":true}\n'); });
});

test('confirmed child exit releases retained partial text while transport is still reachable', () => {
  for (const [kind, expected] of [['baseline', 1024 * 1024], ['current', 0]]) {
    const f = fixture(source[kind]);
    try {
      f.push('x'.repeat(1024 * 1024)); f.rpc.close();
      // A child may still finish an output line during cancellation.
      assert.equal(f.rpc.retainedFixtureUnits(), 1024 * 1024);
      f.exit(); assert.equal(f.rpc.retainedFixtureUnits(), expected);
    } finally { f.dispose(); }
  }
});

test('fragment fixture searches each arriving chunk instead of the repeated prefix', () => {
  const baseline = probe(source.baseline), current = probe(source.current);
  assert.equal(current.messages, baseline.messages); assert.equal(current.retainedUnits, 0);
  assert.ok(baseline.searchInputUnits > current.searchInputUnits * 500);
});


test('directly imported production class preserves fragmented replies and cancellation exit promise', async () => {
  const f = fixture(source.current, JsonLineProcess);
  try {
    const pending = f.rpc.request('first');
    const control = f.rpc.control({ subtype: 'initialize' });
    const wire = Buffer.from('{"id":1,"result":"é😀"}\n{"type":"control_response","response":{"request_id":"breezer-2","response":{}}}\n');
    for (const byte of wire) f.push(Buffer.from([byte]));
    assert.equal(await pending, 'é😀'); assert.deepEqual(await control, {});
    const waiting = assert.rejects(f.rpc.request('cancel'), /Cancelled/);
    f.push('{"late":');
    const exited = f.rpc.close(); assert.equal(exited, f.rpc.exited);
    let confirmed = false; exited.then(() => { confirmed = true; });
    await tick(); assert.equal(confirmed, false);
    f.push('true}\n'); assert.deepEqual(f.events, [['closed', 'Cancelled.'], ['message', { late: true }]]);
    f.exit(); await exited; await waiting;
    assert.equal(confirmed, true);
  } finally { f.dispose(); }
});
