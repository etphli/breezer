import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { join } from 'node:path';
import vm from 'node:vm';

const source = await readFile(new URL('./provider.test.mjs', import.meta.url), 'utf8');
const launchSource = source.slice(source.indexOf('async function launch('), source.indexOf("test('two independent"));

for (const padded of [false, true]) test(`provider readiness waits for the complete port line, padded=${padded}`, async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stdout.resume = () => {};
  child.stderr = { resume() {} };
  child.kill = () => queueMicrotask(() => child.emit('close', 0));
  const context = vm.createContext({ spawn: () => child, setTimeout, clearTimeout });
  vm.runInContext(`${launchSource}\nglobalThis.launchFixture = launch;`, context);
  let settled = false;
  const pending = context.launchFixture('synthetic').then(server => { settled = true; return server; });
  child.stdout.emit('data', padded ? 'http://127.0.0.1:12345;' : 'http://127.0.0.1:12');
  if (padded) child.stdout.emit('data', 'x'.repeat(6000));
  await new Promise(resolve => setImmediate(resolve));
  let server;
  try { assert.equal(settled, false, 'a partial port is not readiness'); }
  finally {
    child.stdout.emit('data', padded ? '\n' : '345\n');
    server = await pending; await server.stop();
  }
  assert.equal(server.root, 'http://127.0.0.1:12345');
});

test('provider client disposal rejects pending requests and clears their timers', async () => {
  const timers = new Map(); let next = 0, disposed = 0;
  const context = vm.createContext({
    fetch() {}, installTestProvider: () => ({ dispose() { disposed++; } }),
    setTimeout(callback) { timers.set(++next, callback); return next; }, clearTimeout: timer => timers.delete(timer),
  });
  const clientSource = source.slice(source.indexOf('class Event'), source.indexOf('async function launch('));
  vm.runInContext(`${clientSource}\nglobalThis.clientFixture = client;`, context);
  const instance = context.clientFixture('http://synthetic', 'dummy');
  let settled = false;
  const pending = instance.request('Configure').then(() => 'resolved', error => { settled = true; return error.message; });
  instance.dispose();
  await Promise.resolve();
  try {
    assert.equal(timers.size, 0);
    assert.equal(settled, true);
    assert.match(await pending, /disposed/);
    instance.dispose();
    assert.equal(disposed, 1);
    await assert.rejects(instance.request('Configure'), /disposed/);
    assert.equal(timers.size, 0);
  } finally {
    for (const callback of timers.values()) callback();
    await pending;
  }
});

for (const ready of [false, true]) {
  test(`provider fixture reaps a child that ignores SIGINT, readiness=${ready}`, async () => {
    let child;
    const context = vm.createContext({
      spawn: () => {
        child = spawn(process.execPath, ['-e', `process.on('SIGINT', () => {}); ${ready ? "console.log('http://127.0.0.1:12345' + 'x'.repeat(8192));" : ''} setInterval(() => {}, 1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
        return child;
      },
      once, setTimeout: (callback, delay) => setTimeout(callback, delay === 10000 ? (ready ? 3000 : 1000) : 200), clearTimeout,
    });
    vm.runInContext(`${launchSource}\nglobalThis.launchFixture = launch;`, context);
    try {
      if (ready) {
        const server = await context.launchFixture('unused synthetic path');
        assert.equal(server.root, 'http://127.0.0.1:12345');
        await server.stop();
        await server.stop();
      } else {
        await assert.rejects(context.launchFixture('unused synthetic path'), /Test server did not start/);
      }
      assert.ok(child.exitCode !== null || child.signalCode !== null, 'owned child must be reaped');
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close');
        child.kill('SIGKILL');
        await closed;
      }
    }
  });
}

test('provider fixture reports spawn failure and observes child close', async () => {
  let child;
  const context = vm.createContext({
    spawn: () => { child = spawn(`${process.execPath}-synthetic-missing`, [], { stdio: ['ignore', 'pipe', 'pipe'] }); return child; },
    setTimeout, clearTimeout,
  });
  vm.runInContext(`${launchSource}\nglobalThis.launchFixture = launch;`, context);
  await assert.rejects(context.launchFixture('unused synthetic path'), error => error.code === 'ENOENT');
  assert.notEqual(child.exitCode, null);
});

test('provider fixture registers cleanup before reading its token', async () => {
  const callbacks = [], hooks = [];
  let stopped = 0, removed = 0;
  const failure = new Error('Synthetic missing token');
  const context = vm.createContext({
    test: (_name, callback) => callbacks.push(callback),
    mkdtemp: async () => '/synthetic-owned-directory', tmpdir: () => '/tmp', join,
    launch: async () => ({ stop: async () => { stopped++; } }),
    readFile: async () => { throw failure; }, rm: async () => { removed++; },
  });
  vm.runInContext(source.slice(source.indexOf("test('two independent")), context);
  await assert.rejects(callbacks[0]({ after: callback => hooks.push(callback) }), error => error === failure);
  assert.equal(hooks.length, 1);
  await hooks[0]();
  assert.equal(stopped, 1);
  assert.equal(removed, 1);
});
