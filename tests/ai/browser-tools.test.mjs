import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { BrowserTools, isWebURL, STOP_BINDING } from '../../features/ai/extension/browser-tools.js';
import { pageContext } from '../../features/ai/extension/page-context.js';
import { installBackground, NATIVE_HOST } from '../../features/ai/extension/background.js';

import { fakeChrome, panel, tick, event } from './browser-api-fixture.mjs';

test('canvas coordinate clicks use tab-scoped mouse input instead of DOM click emulation', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('canvas', fake.tab);
  try {
    await tools.execute(session, 'browser_mouse', { action: 'click', x: 300.5, y: 240 });
    assert.deepEqual(fake.calls.filter(call => call[0] === 'input'), [
      ['input', { tabId: 7 }, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 300.5, y: 240, buttons: 0 }],
      ['input', { tabId: 7 }, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 300.5, y: 240, button: 'left', buttons: 1, clickCount: 1 }],
      ['input', { tabId: 7 }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 300.5, y: 240, button: 'left', buttons: 0, clickCount: 1 }],
    ]);
  } finally { await tools.stop(); }
});

test('game start and direction keys send physical code and bounded key down/up', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('snake', fake.tab);
  try {
    await tools.execute(session, 'browser_key', { key: 'Space', holdMs: 1 });
    await tools.execute(session, 'browser_key', { key: 'w', action: 'down' });
    await tools.execute(session, 'browser_key', { key: 'w', action: 'up' });
    const input = fake.calls.filter(call => call[0] === 'input');
    assert.deepEqual(input, [
      ['input', { tabId: 7 }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: ' ', code: 'Space', windowsVirtualKeyCode: 32, text: ' ', unmodifiedText: ' ' }],
      ['input', { tabId: 7 }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: ' ', code: 'Space', windowsVirtualKeyCode: 32 }],
      ['input', { tabId: 7 }, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87, text: 'w', unmodifiedText: 'w' }],
      ['input', { tabId: 7 }, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'w', code: 'KeyW', windowsVirtualKeyCode: 87 }],
    ]);
  } finally { await tools.stop(); }
});

test('Stop interrupts a key hold, releases it only in the original tab, and rejects queued input', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('held', fake.tab);
  const pending = tools.execute(session, 'browser_key', { key: 'ArrowRight', holdMs: 5000 });
  const rejected = assert.rejects(pending, /stopped/);
  await tick();
  assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3].type), ['keyDown']);
  const queued = tools.execute(session, 'browser_key', { key: 'ArrowDown' });
  const queuedRejected = assert.rejects(queued, /stopped/);
  fake.setTab({ id: 8, url: 'https://other.test' });
  await tools.stop();
  await Promise.all([rejected, queuedRejected]);
  assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => [call[1], call[3].type]), [[{ tabId: 7 }, 'keyDown'], [{ tabId: 7 }, 'keyUp']]);
  assert.ok(fake.calls.findIndex(call => call[0] === 'detach') > fake.calls.findIndex(call => call[0] === 'input' && call[3].type === 'keyUp'));
});

test('holdMs keeps a direction down for the requested duration using a virtual clock', async t => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('duration', fake.tab);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = tools.execute(session, 'browser_key', { key: 'ArrowRight', holdMs: 150 });
  await tick();
  t.mock.timers.tick(149);
  await tick();
  assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3].type), ['keyDown']);
  t.mock.timers.tick(1);
  await pending;
  assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3].type), ['keyDown', 'keyUp']);
  await tools.stop();
});

test('a held mouse button expires and is released even while its acknowledgement hangs', async t => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('mouse-timeout', fake.tab);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const send = fake.api.debugger.sendCommand;
  let release;
  fake.api.debugger.sendCommand = (target, method, args) => {
    const result = send(target, method, args);
    return args.type === 'mousePressed' ? new Promise(resolve => { release = () => result.then(resolve); }) : result;
  };
  const pending = tools.execute(session, 'browser_mouse', { action: 'down', x: 300, y: 240 });
  const rejected = assert.rejects(pending, /stopped/);
  await tick();
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(session.stopped, true);
  release();
  await rejected;
  await session.stopping;
  assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3].type), ['mouseMoved', 'mousePressed', 'mouseReleased']);
});

test('a failed key release or missing indicator stops control and cleans up held input', async () => {
  for (const failingOperation of ['check-focus', 'control-check']) {
    const fake = fakeChrome();
    const tools = new BrowserTools(fake.api);
    tools.authorize(fake.tab);
    const session = await tools.start(failingOperation, fake.tab);
    await tools.execute(session, 'browser_key', { key: 'w', action: 'down' });
    const original = fake.api.scripting.executeScript;
    fake.api.scripting.executeScript = options => {
      if (options.args?.[0] === failingOperation) throw new Error('Refused by page guard.');
      return original(options);
    };
    await assert.rejects(tools.execute(session, 'browser_key', { key: 'w', action: 'up' }), /Refused/);
    assert.equal(session.stopped, true);
    assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3].type), ['keyDown', 'keyUp']);
  }
});

test('explicit keydown has a five second fail-safe even while its transport acknowledgement hangs', async t => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('held-timeout', fake.tab);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const send = fake.api.debugger.sendCommand;
  let release;
  fake.api.debugger.sendCommand = (target, method, args) => {
    const result = send(target, method, args);
    return args.type === 'keyDown' ? new Promise(resolve => { release = () => result.then(resolve); }) : result;
  };
  const pending = tools.execute(session, 'browser_key', { key: 'w', action: 'down' });
  const rejected = assert.rejects(pending, /stopped/);
  await tick();
  t.mock.timers.tick(5000);
  await tick();
  assert.equal(session.stopped, true);
  release();
  await rejected;
  await session.stopping;
  assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3].type), ['keyDown', 'keyUp']);
});

test('navigation while a key is held stops control and releases the key', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('held-navigation', fake.tab);
  await tools.execute(session, 'browser_key', { key: 'w', action: 'down' });
  tools.navigationStarted(session);
  await session.stopping;
  assert.equal(session.stopped, true);
  assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3].type), ['keyDown', 'keyUp']);
});

test('navigation requested during a held input sends no navigation after stopping control', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('held-navigation-command', fake.tab);
  await tools.execute(session, 'browser_key', { key: 'w', action: 'down' });
  await assert.rejects(tools.execute(session, 'browser_navigate', { url: 'https://other.test' }), /stopped/);
  await session.stopping;
  assert.equal(fake.calls.filter(call => call[0] === 'navigate').length, 0);
});

test('canvas mouse down/move/up preserves drag button state and release position', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('drag', fake.tab);
  try {
    await tools.execute(session, 'browser_mouse', { action: 'down', button: 'right', x: 100, y: 150 });
    await tools.execute(session, 'browser_mouse', { action: 'move', x: 250, y: 350 });
    await tools.execute(session, 'browser_mouse', { action: 'up', button: 'right', x: 260, y: 360 });
    assert.deepEqual(fake.calls.filter(call => call[0] === 'input').map(call => call[3]), [
      { type: 'mouseMoved', x: 100, y: 150, buttons: 0 },
      { type: 'mousePressed', x: 100, y: 150, button: 'right', buttons: 2, clickCount: 1 },
      { type: 'mouseMoved', x: 250, y: 350, buttons: 2 },
      { type: 'mouseMoved', x: 260, y: 360, buttons: 2 },
      { type: 'mouseReleased', x: 260, y: 360, button: 'right', buttons: 0, clickCount: 1 },
    ]);
  } finally { await tools.stop(); }
});

test('Stop releases a held mouse at its last drag position and a new session gets no stale release', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('drag-stop', fake.tab);
  await tools.execute(session, 'browser_mouse', { action: 'down', x: 100, y: 150 });
  await tools.execute(session, 'browser_mouse', { action: 'move', x: 250, y: 350 });
  await tools.stop();
  assert.deepEqual(fake.calls.filter(call => call[0] === 'input').at(-1), ['input', { tabId: 7 }, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: 250, y: 350, button: 'left', buttons: 0, clickCount: 1 }]);
  const next = await tools.start('next', fake.tab);
  fake.calls.length = 0;
  await tools.stop(session);
  assert.equal(fake.calls.length, 0);
  await tools.stop(next);
});

test('invalid game inputs and refused canvas targets send no input', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('refuse', fake.tab);
  try {
    for (const args of [{ key: 'Meta+L' }, { key: 'Shift' }, { key: 'w', holdMs: 5001 }, { key: 'w', holdMs: -1 }, { key: 'w', holdMs: 1.5 }, { key: 'w', action: 'down', holdMs: 1 }, { key: 'w', action: 'up' }]) await assert.rejects(tools.execute(session, 'browser_key', args));
    for (const args of [{ action: 'click', x: NaN, y: 10 }, { action: 'click', x: -1, y: 10 }, { action: 'click', x: 10, y: 10, button: 'back' }, { action: 'up', x: 10, y: 10 }]) await assert.rejects(tools.execute(session, 'browser_mouse', args));
    const original = fake.api.scripting.executeScript;
    fake.api.scripting.executeScript = options => {
      if (options.args?.[0] === 'resolve-point') throw new Error('Coordinate input requires a visible, uncovered canvas.');
      return original(options);
    };
    await assert.rejects(tools.execute(session, 'browser_mouse', { action: 'click', x: 10, y: 10 }), /canvas/);
    assert.equal(fake.calls.filter(call => call[0] === 'input').length, 0);
  } finally { await tools.stop(); }
});

test('cancelling during canvas validation prevents late mouse input', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('canvas-cancel', fake.tab);
  const original = fake.api.scripting.executeScript;
  let release;
  fake.api.scripting.executeScript = options => options.args?.[0] === 'resolve-point'
    ? new Promise(resolve => { release = () => resolve([{ result: { x: 300, y: 240 } }]); })
    : original(options);
  const pending = tools.execute(session, 'browser_mouse', { action: 'click', x: 300, y: 240 });
  const rejected = assert.rejects(pending, /stopped/);
  await tick();
  await tools.stop();
  release();
  await rejected;
  assert.equal(fake.calls.filter(call => call[0] === 'input').length, 0);
});

test('isolated coordinate validation accepts only visible top-level canvas CSS points', () => {
  const canvas = {
    id: 'game', tagName: 'CANVAS', isConnected: true,
    matches: () => false, getAttribute: () => null, closest: () => null,
    getBoundingClientRect: () => ({ width: 400, height: 300 }),
  };
  let hit = canvas;
  const world = vm.createContext({ crypto: { randomUUID: () => 'doc' }, innerWidth: 1000, innerHeight: 700, getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }), document: { elementFromPoint: () => hit } });
  const invoke = args => vm.runInContext(`(${pageContext.toString()})('resolve-point',${JSON.stringify(args)})`, world);
  assert.equal(invoke({ x: 300.5, y: 240 }).x, 300.5);
  for (const args of [{ x: -1, y: 0 }, { x: 1000, y: 0 }, { x: 0, y: 700 }, { x: '1', y: 1 }, { x: null, y: 1 }]) assert.throws(() => invoke(args), /viewport/);
  for (const tagName of ['INPUT', 'TEXTAREA', 'IFRAME', 'DIV', 'GAME-HOST', 'BUTTON']) {
    hit = { ...canvas, tagName };
    assert.throws(() => invoke({ x: 300, y: 240 }), /canvas/);
  }
  hit = null;
  assert.throws(() => invoke({ x: 300, y: 240 }), /canvas/);
  hit = { ...canvas, isConnected: false };
  assert.throws(() => invoke({ x: 300, y: 240 }), /canvas/);
  hit = { ...canvas, closest: () => ({}) };
  assert.throws(() => invoke({ x: 300, y: 240 }), /canvas/);
  hit = { ...canvas, id: 'secret' };
  assert.throws(() => invoke({ x: 300, y: 240 }), /canvas/);
});

test('page access requires an explicit gesture for the active HTTP(S) origin', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  await assert.rejects(tools.current(), /Cmd\+K/);
  tools.authorize(fake.tab);
  assert.equal((await tools.current()).id, 7);
  fake.setTab({ url: 'https://other.test' });
  await assert.rejects(tools.current(), /Cmd\+K/);
  for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'chrome://settings', 'data:text/plain,a']) assert.equal(isWebURL(url), false);
});

test('only the authorized current tab is captured, and a switch discards context', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  assert.equal((await tools.snapshot(fake.tab)).screenshot, 'data:image/jpeg;base64,test');
  assert.deepEqual(fake.calls.filter(call => call[0] === 'capture'), [['capture', 3, 7]]);
  const oldTab = fake.tab;
  fake.setTab({ id: 8 });
  await assert.rejects(tools.snapshot(oldTab), /allow page access|active page changed/);
  assert.equal(fake.calls.filter(call => call[0] === 'capture').length, 1);
});

test('browser tools allow only scoped trusted input and refuse arbitrary execution', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('r1', fake.tab);
  for (const [name, args] of [['shell', {}], ['javascript', {}], ['browser_key', { key: 'Meta+L' }], ['browser_navigate', { url: 'javascript:alert(1)' }]]) await assert.rejects(tools.execute(session, name, args));
  await tools.execute(session, 'browser_type', { elementId: 'snapshot:1', text: 'Hello' });
  const input = fake.calls.filter(call => call[0] === 'input');
  assert.deepEqual(input.map(call => call[2]), ['Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.dispatchMouseEvent', 'Input.insertText']);
  assert.ok(input.every(call => call[1].tabId === 7));
  assert.ok(fake.calls.some(call => call[0] === 'script' && call[2] === 'select-content'));
  await tools.stop();
  assert.ok(fake.calls.some(call => call[0] === 'detach'));
  assert.ok(fake.calls.some(call => call[0] === 'script' && call[2] === 'overlay-stop'));
});

test('cancelling while debugger attaches detaches it and sends no late input', async () => {
  const fake = fakeChrome();
  let finishAttach;
  fake.api.debugger.attach = () => new Promise(resolve => { finishAttach = resolve; });
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const pending = tools.start('r1', fake.tab);
  await tick();
  const session = tools.session;
  const stopping = tools.stop();
  assert.equal(session.stopped, true);
  finishAttach();
  await stopping;
  await assert.rejects(pending, /stopped/);
  await assert.rejects(tools.execute(session, 'browser_key', { key: 'Enter' }), /stopped/);
  assert.equal(fake.calls.filter(call => call[0] === 'input').length, 0);
  assert.ok(fake.calls.some(call => call[0] === 'detach'));
});

test('cancelling during target resolution prevents all input', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('r1', fake.tab);
  const original = fake.api.scripting.executeScript;
  let finishResolve;
  fake.api.scripting.executeScript = options => options.args[0] === 'resolve' ? new Promise(resolve => { finishResolve = () => resolve([{ result: { x: 50, y: 60 } }]); }) : original(options);
  const action = tools.execute(session, 'browser_click', { elementId: 'snapshot:1' });
  await tick();
  await tools.stop();
  finishResolve();
  await assert.rejects(action, /stopped/);
  assert.equal(fake.calls.filter(call => call[0] === 'input').length, 0);
});

test('Stop detaches while a page protocol request is hung and rejects its late result', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('hung', fake.tab);
  const original = fake.api.debugger.sendCommand;
  let finish;
  fake.api.debugger.sendCommand = (target, method, args) => method === 'Runtime.callFunctionOn' && args.arguments[0].value === 'snapshot' ? new Promise(resolve => { finish = resolve; }) : original(target, method, args);
  const pending = tools.execute(session, 'browser_snapshot');
  await tick();
  const stopped = tools.stop();
  await stopped;
  assert.equal(session.stopped, true);
  assert.ok(fake.calls.some(call => call[0] === 'detach'));
  finish({ result: { value: { url: fake.tab.url } } });
  await assert.rejects(pending, /stopped/);
  assert.equal(fake.calls.filter(call => call[0] === 'input').length, 0);
});

test('Stop bounds cleanup and still attempts detach if a cleanup command never returns', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('cleanup', fake.tab);
  const original = fake.api.debugger.sendCommand;
  fake.api.debugger.sendCommand = (target, method, args) => method === 'Page.getFrameTree' ? new Promise(() => {}) : original(target, method, args);
  const began = Date.now();
  await tools.stop(session);
  assert.ok(Date.now() - began < 2000);
  assert.ok(fake.calls.some(call => call[0] === 'detach'));
});

test('a new control session waits for the previous asynchronous detach', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  await tools.start('old', fake.tab);
  const original = fake.api.debugger.detach;
  let finish;
  fake.api.debugger.detach = () => new Promise(resolve => { finish = resolve; });
  const stopping = tools.stop();
  await tick();
  const starting = tools.start('new', fake.tab);
  await tick();
  assert.equal(fake.calls.filter(call => call[0] === 'attach').length, 1);
  finish();
  await stopping;
  await starting;
  assert.equal(fake.calls.filter(call => call[0] === 'attach').length, 2);
  fake.api.debugger.detach = original;
  await tools.stop();
});

test('expired cleanup cannot remove a new session binding or reused script ID when its command resolves late', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const original = fake.api.debugger.sendCommand;
  const scripts = new Set();
  let binding = false;
  let holdRemoval = true;
  let release;
  fake.api.debugger.sendCommand = (target, method, args) => {
    if (method === 'Runtime.addBinding') binding = true;
    if (method === 'Runtime.removeBinding') binding = false;
    if (method === 'Page.addScriptToEvaluateOnNewDocument') scripts.add('bootstrap');
    if (method === 'Page.removeScriptToEvaluateOnNewDocument') scripts.delete(args.identifier);
    const result = original(target, method, args);
    if (method === 'Runtime.removeBinding' && holdRemoval) {
      holdRemoval = false;
      return new Promise(resolve => { release = () => result.then(resolve); });
    }
    return result;
  };
  await tools.start('old', fake.tab);
  await tools.stop();
  const current = await tools.start('new', fake.tab);
  const commandsBeforeRelease = fake.calls.length;
  release();
  await tick();
  await tick();
  assert.equal(fake.calls.length, commandsBeforeRelease, 'Expired cleanup must issue no further protocol commands.');
  assert.equal(binding, true);
  assert.equal(scripts.has(current.bootScript), true);
  assert.equal(current.stopped, false);
  await tools.stop();
});

test('late bootstrap installation acknowledgement cannot remove the new session script', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const original = fake.api.debugger.sendCommand;
  let holdInstall = true;
  let release;
  fake.api.debugger.sendCommand = (target, method, args) => {
    const result = original(target, method, args);
    if (method === 'Page.addScriptToEvaluateOnNewDocument' && holdInstall) {
      holdInstall = false;
      return new Promise(resolve => { release = () => result.then(resolve); });
    }
    return result;
  };
  const oldStart = tools.start('old', fake.tab);
  const oldRejected = assert.rejects(oldStart, /stopped/);
  await tick();
  await tools.stop();
  const current = await tools.start('new', fake.tab);
  const commandsBeforeRelease = fake.calls.length;
  release();
  await oldRejected;
  await tick();
  assert.equal(fake.calls.length, commandsBeforeRelease);
  assert.equal(current.bootScript, 'bootstrap');
  assert.equal(current.stopped, false);
  await tools.stop();
});

test('a timed-out detach blocks reattachment until the original detach settles', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  await tools.start('old', fake.tab);
  const original = fake.api.debugger.detach;
  let release;
  fake.api.debugger.detach = () => new Promise(resolve => { release = resolve; });
  await tools.stop();
  await assert.rejects(tools.start('new', fake.tab), /still stopping/);
  assert.equal(fake.calls.filter(call => call[0] === 'attach').length, 1);
  release();
  await tick();
  fake.api.debugger.detach = original;
  await tools.start('new', fake.tab);
  assert.equal(fake.calls.filter(call => call[0] === 'attach').length, 2);
  await tools.stop();
});

test('only the controlled tab and named isolated world can use the Stop binding', async () => {
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('binding', fake.tab);
  const params = { name: STOP_BINDING, executionContextId: 101, payload: JSON.stringify({ sessionId: 'binding' }) };
  tools.debuggerEvent({ tabId: 8 }, 'Runtime.bindingCalled', params);
  tools.debuggerEvent({ tabId: 7 }, 'Runtime.bindingCalled', { ...params, executionContextId: 999 });
  tools.debuggerEvent({ tabId: 7 }, 'Runtime.bindingCalled', { ...params, payload: JSON.stringify({ sessionId: 'old' }) });
  assert.equal(session.stopped, false);
  tools.debuggerEvent({ tabId: 7 }, 'Runtime.bindingCalled', params);
  await session.stopping;
  assert.equal(session.stopped, true);
});

test('worker toggles the panel and forwards context only on an opted-in chat', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  fake.api.commands.onCommand.emit('toggle-breezer-ai', fake.tab);
  assert.ok(fake.calls.some(call => call[0] === 'open'));
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  assert.ok(fake.calls.some(call => call[0] === 'native' && call[1] === NATIVE_HOST));
  port.onMessage.emit({ type: 'chat', id: 'a', provider: 'codex', model: 'auto', message: 'Hello', includeContext: false });
  await tick();
  assert.equal(fake.native.sent.find(value => value.id === 'a')?.context, undefined);
  assert.equal(fake.calls.filter(call => call[0] === 'capture').length, 0);
  port.onMessage.emit({ type: 'chat', id: 'b', provider: 'codex', model: 'auto', message: 'Read this', includeContext: true });
  await tick();
  assert.equal(fake.native.sent.find(value => value.id === 'b')?.context.url, fake.tab.url);
  assert.equal(fake.native.sent.find(value => value.id === 'b')?.includeContext, true);
  assert.equal(fake.calls.filter(call => call[0] === 'attach').length, 0);
  fake.api.commands.onCommand.emit('toggle-breezer-ai', fake.tab);
  assert.ok(fake.calls.some(call => call[0] === 'close'));
});

test('inactive tab updates do not query the active page or start the native host', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  for (let id = 10; id < 110; id++) {
    fake.api.tabs.onUpdated.emit(id, { title: 'Loading', status: 'complete' }, { ...fake.tab, id, active: false });
  }
  await tick();
  assert.equal(fake.calls.length, 0, 'ordinary browsing leaves AI idle');
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  fake.calls.length = 0;
  for (let id = 10; id < 110; id++) {
    fake.api.tabs.onUpdated.emit(id, { title: 'Loaded', status: 'complete' }, { ...fake.tab, id, active: false });
  }
  await tick();
  assert.equal(fake.calls.filter(call => call[0] === 'query').length, 0);
  fake.api.tabs.onUpdated.emit(7, { title: 'Active page' }, { ...fake.tab, active: true });
  await tick();
  assert.equal(fake.calls.filter(call => call[0] === 'query').length, 1);
  assert.equal(port.sent.filter(message => message.type === 'context').length, 1);
});

test('a delayed metadata query cannot overwrite a newer active page', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  const queries = [];
  fake.api.tabs.query = () => new Promise(resolve => queries.push(resolve));
  fake.api.tabs.onActivated.emit({ tabId: 7, windowId: 3 });
  fake.api.tabs.onActivated.emit({ tabId: 8, windowId: 3 });
  queries[1]([{ ...fake.tab, id: 8, title: 'New page' }]);
  await tick();
  queries[0]([{ ...fake.tab, id: 7, title: 'Old page' }]);
  await tick();
  assert.deepEqual(port.sent.filter(message => message.type === 'context').map(message => message.context.tabId), [8]);
});

test('hiding and reopening a cached panel discards pending metadata', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  let resolveQuery;
  fake.api.tabs.query = () => new Promise(resolve => { resolveQuery = resolve; });
  fake.api.tabs.onActivated.emit({ tabId: 7, windowId: 3 });
  port.onMessage.emit({ type: 'visibility', visible: false });
  port.onMessage.emit({ type: 'visibility', visible: true });
  resolveQuery([fake.tab]);
  await tick();
  assert.equal(port.sent.filter(message => message.type === 'context').length, 0);
});

test('worker forwards reasoning and only Codex speed to the native host', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  port.onMessage.emit({ type: 'chat', id: 'codex-settings', provider: 'codex', model: 'gpt-6.1-sol', message: 'Hello', reasoning: 'xhigh', speed: 'fast' });
  await tick();
  const codex = fake.native.sent.find(value => value.type === 'chat' && value.id === 'codex-settings');
  assert.equal(codex.reasoning, 'xhigh');
  assert.equal(codex.speed, 'fast');
  port.onMessage.emit({ type: 'chat', id: 'claude-settings', provider: 'claude', model: 'opus', message: 'Hello', reasoning: 'medium', speed: 'fast' });
  await tick();
  const claude = fake.native.sent.find(value => value.type === 'chat' && value.id === 'claude-settings');
  assert.equal(claude.reasoning, 'medium');
  assert.equal(Object.hasOwn(claude, 'speed'), false);
});

test('worker rejects tools without control and cancels on disconnect and tab switches', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  fake.api.action.onClicked.emit(fake.tab);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  port.onMessage.emit({ type: 'chat', id: 'a', provider: 'claude', model: 'auto', message: 'Hello' });
  await tick();
  fake.native.onMessage.emit({ type: 'tool', id: 'a', requestId: 't1', name: 'browser_key', args: { key: 'Enter' } });
  await tick();
  assert.match(fake.native.sent.find(value => value.requestId === 't1').error, /control is off/);
  port.onMessage.emit({ type: 'chat', id: 'b', provider: 'claude', model: 'auto', message: 'Click', control: true });
  await tick();
  assert.ok(fake.calls.some(call => call[0] === 'attach'));
  fake.api.tabs.onActivated.emit({ tabId: 8, windowId: 3 });
  await tick();
  fake.native.onMessage.emit({ type: 'tool', id: 'b', requestId: 'late', name: 'browser_key', args: { key: 'Enter' } });
  await tick();
  assert.equal(fake.calls.filter(call => call[0] === 'input').length, 0);
  assert.ok(fake.calls.some(call => call[0] === 'detach'));
  assert.ok(fake.native.sent.some(value => value.type === 'cancel' && value.id === 'b'));
  port.onDisconnect.emit();
});

test('same-origin navigation retains control and restores its visible overlay', async () => {
  const fake = fakeChrome();
  const worker = installBackground(fake.api);
  fake.api.action.onClicked.emit(fake.tab);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  port.onMessage.emit({ type: 'chat', id: 'nav', provider: 'claude', model: 'auto', message: 'Continue', control: true });
  await tick();
  const session = worker.tools.session;
  fake.api.tabs.onUpdated.emit(7, { status: 'loading' });
  fake.setTab({ url: 'https://example.test/next' });
  fake.api.tabs.onUpdated.emit(7, { url: fake.tab.url });
  const pending = worker.tools.execute(session, 'browser_snapshot');
  await tick();
  fake.api.tabs.onUpdated.emit(7, { status: 'complete' });
  const context = await pending;
  assert.equal(context.url, 'https://example.test/next');
  assert.equal(session.stopped, false);
  assert.equal(fake.calls.filter(call => call[0] === 'attach').length, 1);
  assert.equal(fake.calls.filter(call => call[0] === 'detach').length, 0);
  assert.equal(fake.calls.filter(call => call[0] === 'script' && call[2] === 'overlay-start').length, 2);
  await worker.cancel();
});

test('new-origin navigation revokes read-only grants while attached control continues', async () => {
  const fake = fakeChrome();
  const worker = installBackground(fake.api);
  fake.api.action.onClicked.emit(fake.tab);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  port.onMessage.emit({ type: 'chat', id: 'nav', provider: 'claude', model: 'auto', message: 'Continue', control: true });
  await tick();
  fake.setTab({ url: 'https://different.test' });
  fake.api.tabs.onUpdated.emit(7, { url: fake.tab.url });
  await tick();
  assert.ok(worker.tools.session);
  await assert.rejects(worker.tools.current(), /Cmd\+K/);
  const context = await worker.tools.execute(worker.tools.session, 'browser_snapshot');
  assert.equal(context.url, fake.tab.url);
  assert.ok(fake.calls.some(call => call[0] === 'cdp' && call[2] === 'Page.captureScreenshot'));
  await worker.cancel();
});

test('context preview reads metadata without page text or screenshot', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  fake.api.action.onClicked.emit(fake.tab);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  await tick();
  port.onMessage.emit({ type: 'context' });
  await tick();
  const preview = port.sent.find(message => message.type === 'context');
  assert.deepEqual(preview.context, { url: fake.tab.url, title: '', tabId: 7 });
  assert.equal(fake.calls.filter(call => call[0] === 'script' || call[0] === 'capture').length, 0);
});

test('native Cmd+K can establish access through a successful permission probe without a command event', async () => {
  const fake = fakeChrome();
  const worker = installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  port.onMessage.emit({ type: 'context' });
  await tick();
  assert.equal((await worker.tools.current(3)).id, 7);
  assert.ok(port.sent.some(message => message.type === 'context'));
  fake.api.scripting.executeScript = async () => { throw new Error('Cannot access contents of the page.'); };
  port.onMessage.emit({ type: 'chat', id: 'revoked', provider: 'codex', model: 'auto', message: 'Read this', includeContext: true });
  await tick();
  await assert.rejects(worker.tools.current(3), /Cmd\+K/);
  assert.ok(port.sent.some(message => message.type === 'error' && /Cmd\+K/.test(message.error)));
});

test('visible context chips follow active-tab metadata without granting page access', async () => {
  const fake = fakeChrome();
  const worker = installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  const scriptCount = fake.calls.filter(call => call[0] === 'grant-probe' || call[0] === 'script').length;
  fake.setTab({ id: 8, url: 'https://other.test/first', title: 'Other page' });
  fake.api.tabs.onActivated.emit({ tabId: 8, windowId: 3 });
  await tick();
  assert.deepEqual(port.sent.filter(message => message.type === 'context').at(-1).context, { url: 'https://other.test/first', title: 'Other page', tabId: 8 });
  assert.equal(worker.tools.grants.has(8), false);
  fake.setTab({ url: 'https://other.test/next', title: 'Next page' });
  fake.api.tabs.onUpdated.emit(8, { status: 'complete' }, fake.tab);
  await tick();
  assert.equal(port.sent.filter(message => message.type === 'context').at(-1).context.title, 'Next page');
  assert.equal(fake.calls.filter(call => call[0] === 'grant-probe' || call[0] === 'script').length, scriptCount);
  assert.equal(fake.calls.filter(call => call[0] === 'capture').length, 0);
  port.onMessage.emit({ type: 'visibility', visible: false });
  await tick();
  const messageCount = port.sent.length;
  fake.api.tabs.onUpdated.emit(8, { title: 'Hidden update' }, fake.tab);
  await tick();
  assert.equal(port.sent.length, messageCount);
});

test('context-only chats may refresh their original tab snapshot but cannot act or switch tabs', async () => {
  const fake = fakeChrome();
  const worker = installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  port.onMessage.emit({ type: 'chat', id: 'read', provider: 'codex', model: 'auto', message: 'Read', includeContext: true });
  await tick();
  fake.native.onMessage.emit({ type: 'tool', id: 'read', requestId: 'fresh', name: 'browser_snapshot', args: {} });
  await new Promise(resolve => setTimeout(resolve, 600));
  assert.equal(fake.native.sent.find(message => message.requestId === 'fresh').result.url, fake.tab.url);
  fake.setTab({ id: 8, url: 'https://other.test' });
  worker.tools.authorize(fake.tab);
  fake.native.onMessage.emit({ type: 'tool', id: 'read', requestId: 'switched', name: 'browser_snapshot', args: {} });
  await tick();
  assert.match(fake.native.sent.find(message => message.requestId === 'switched').error, /active page changed/);
  assert.equal(fake.calls.filter(call => call[0] === 'attach' || call[0] === 'input').length, 0);
});

test('hiding a cached panel cancels control and the toolbar can reopen it', async () => {
  const fake = fakeChrome();
  const worker = installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init' });
  await tick();
  port.onMessage.emit({ type: 'chat', id: 'hidden', provider: 'codex', model: 'auto', message: 'Act', control: true });
  await tick();
  port.onMessage.emit({ type: 'visibility', visible: false });
  await tick();
  assert.equal(worker.tools.session, null);
  assert.ok(fake.native.sent.some(message => message.type === 'cancel' && message.id === 'hidden'));
  fake.api.action.onClicked.emit(fake.tab);
  assert.ok(fake.calls.some(call => call[0] === 'open'));
});

test('control survives focus moving to another app but stops for another browser window', async () => {
  const fake = fakeChrome();
  fake.api.windows = { WINDOW_ID_NONE: -1, onFocusChanged: event() };
  const worker = installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  await tick();
  port.onMessage.emit({ type: 'chat', id: 'watch', provider: 'codex', model: 'auto', message: 'Act', control: true });
  for (let i = 0; i < 20 && !fake.native.sent.some(message => message.type === 'chat'); i++) await tick();
  assert.ok(worker.tools.session);
  fake.api.windows.onFocusChanged.emit(-1);
  await tick();
  assert.ok(worker.tools.session, 'focusing another app keeps control of the Breezer tab');
  assert.equal(fake.native.sent.some(message => message.type === 'cancel'), false);
  fake.api.windows.onFocusChanged.emit(4);
  await tick();
  assert.equal(worker.tools.session, null);
  assert.ok(port.sent.some(message => message.type === 'error' && /active window changed/.test(message.error)));
});

test('isolated page targets exclude secret fields and reject covered or stale elements', () => {
  const makeElement = (type, name = '') => ({
    id: '', tagName: 'INPUT', isConnected: true, labels: [],
    matches: selector => selector.includes('password') ? type === 'password' : selector.includes('input'),
    getAttribute: key => ({ type, name }[key] || null),
    getBoundingClientRect: () => ({ x: 10, y: 10, left: 10, top: 10, right: 110, bottom: 30, width: 100, height: 20 }),
    closest: () => null, contains: other => false,
  });
  const ordinary = makeElement('text');
  const password = makeElement('password');
  const token = makeElement('text', 'access_token');
  let covered = false;
  const world = vm.createContext({ crypto: { randomUUID: (() => { let n = 0; return () => String(++n); })() }, innerWidth: 1000, innerHeight: 700, location: { href: 'https://example.test' }, NodeFilter: { SHOW_TEXT: 4 }, getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }), document: { title: 'Page', body: {}, querySelectorAll: () => [ordinary, password, token], createTreeWalker: () => ({ nextNode: () => false }), elementFromPoint: () => covered ? {} : ordinary } });
  const invoke = (operation, args = {}) => vm.runInContext(`(${pageContext.toString()})(${JSON.stringify(operation)},${JSON.stringify(args)})`, world);
  const snapshot = invoke('snapshot');
  assert.equal(snapshot.elements.length, 1);
  assert.equal(invoke('resolve', { elementId: snapshot.elements[0].id }).x, 60);
  covered = true;
  assert.throws(() => invoke('resolve', { elementId: snapshot.elements[0].id }), /covered/);
  covered = false;
  const next = invoke('snapshot');
  assert.notEqual(snapshot.elements[0].id, next.elements[0].id);
  assert.throws(() => invoke('resolve', { elementId: snapshot.elements[0].id }), /changed/);
});
