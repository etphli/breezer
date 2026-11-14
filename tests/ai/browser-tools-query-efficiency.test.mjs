import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { pageContext } from '../../features/ai/extension/page-context.js';
import { fakeChrome, tick } from './browser-api-fixture.mjs';

// Offline controls can run these same assertions against an explicit source copy.
const sourceURL = process.env.BREEZER_QUERY_SOURCE
  ? pathToFileURL(process.env.BREEZER_QUERY_SOURCE)
  : new URL('../../features/ai/extension/browser-tools.js', import.meta.url);
const source = await readFile(sourceURL, 'utf8');
const pageURL = new URL('../../features/ai/extension/page-context.js', import.meta.url);
const { BrowserTools } = await import(`data:text/javascript;base64,${Buffer.from(source.replace("'./page-context.js'", JSON.stringify(pageURL.href))).toString('base64')}`);
const records = [];
after(async () => {
  if (process.env.BREEZER_QUERY_TRACE_FILE) await writeFile(process.env.BREEZER_QUERY_TRACE_FILE, JSON.stringify(records, null, 2) + '\n');
});

async function harness(t, name) {
  const fake = fakeChrome();
  const trace = [];
  const state = { fake, trace, queryCount: 0 };
  const tools = new BrowserTools(fake.api, id => trace.push({ kind: 'stopped', id }));
  const phase = () => state.session?.stopped ? 'cleanup' : 'control';
  const query = fake.api.tabs.query;
  fake.api.tabs.query = async args => {
    const index = ++state.queryCount;
    trace.push({ kind: 'query', index, args: structuredClone(args) });
    const tabs = await query(args);
    trace.push({ kind: 'query-result', index, tabs: structuredClone(tabs) });
    state.afterQuery?.(index, tabs);
    return tabs;
  };
  const send = fake.api.debugger.sendCommand;
  fake.api.debugger.sendCommand = async (target, method, args) => {
    const params = structuredClone(args);
    if (method === 'Runtime.callFunctionOn') {
      assert.equal(params.functionDeclaration, pageContext.toString(), 'only the shipped function may run');
      params.functionDeclaration = '<exact shipped pageContext, asserted before recording>';
    }
    const command = { kind: 'command', phase: phase(), target, method, params };
    trace.push(command);
    try {
      const result = await send(target, method, args);
      if (method === 'Page.getFrameTree' && state.loaderId) result.frameTree.frame.loaderId = state.loaderId;
      trace.push({ kind: 'command-result', method, result: structuredClone(result) });
      state.afterCommand?.(command, result);
      return result;
    } catch (error) {
      trace.push({ kind: 'command-error', method, error: error.message });
      throw error;
    }
  };
  const update = fake.api.tabs.update;
  fake.api.tabs.update = async (id, args) => {
    trace.push({ kind: 'update', id, args });
    await update(id, args);
    fake.setTab({ url: args.url, status: 'complete' });
    state.navigation = tools.navigationComplete(state.session);
  };
  const capture = fake.api.tabs.captureVisibleTab;
  fake.api.tabs.captureVisibleTab = async (...args) => {
    trace.push({ kind: 'capture', args });
    return capture(...args);
  };
  const detach = fake.api.debugger.detach;
  fake.api.debugger.detach = async target => {
    trace.push({ kind: 'detach', target });
    return detach(target);
  };
  const execute = tools.execute.bind(tools);
  tools.execute = async (session, name, args) => {
    trace.push({ kind: 'action', name, args });
    try {
      const result = await execute(session, name, args);
      trace.push({ kind: 'decision', accepted: true, result });
      return result;
    } catch (error) {
      trace.push({ kind: 'decision', accepted: false, error: error.message });
      throw error;
    }
  };
  state.tools = tools;
  tools.authorize(fake.tab);
  state.session = await tools.start('query-test', fake.tab);
  trace.length = 0;
  state.queryCount = 0;
  t.after(async () => {
    state.afterQuery = state.afterCommand = null;
    await tools.stop(state.session);
    await state.navigation;
    assert.equal(state.session.attached, false);
    assert.equal(state.session.keys.size + state.session.buttons.size, 0);
    assert.equal(trace.filter(entry => entry.kind === 'detach').length, 1);
    records.push({ name, trace });
  });
  return state;
}

const controlCommands = state => state.trace.filter(entry => entry.kind === 'command' && entry.phase === 'control');
const inputs = state => controlCommands(state).filter(entry => entry.method.startsWith('Input.'));
const snapshot = url => ({ url, title: 'Page', text: 'Visible content', viewport: { width: 1000, height: 700 }, elements: [], screenshot: 'data:image/jpeg;base64,test' });
const actions = [
  ['click', 'browser_click', { elementId: 'snapshot:1' }],
  ['type', 'browser_type', { elementId: 'snapshot:1', text: 'Hello' }],
  ['insert', 'browser_type', { elementId: 'snapshot:1', text: 'Hello', mode: 'insert' }],
  ['key', 'browser_key', { key: 'Enter' }],
  ['mouse', 'browser_mouse', { action: 'click', x: 300, y: 240 }],
  ['scroll', 'browser_scroll', { direction: 'down' }],
  ['navigate', 'browser_navigate', { url: 'https://other.test/next' }],
  ['snapshot', 'browser_snapshot', {}],
];

for (const [label, name, args] of actions) {
  test(`ordered trace and exact output: ${label}`, async t => {
    const state = await harness(t, `stable-${label}`);
    const result = await state.tools.execute(state.session, name, args);
    assert.deepEqual(result, snapshot(args.url || state.fake.tab.url));
    assert.equal(state.session.stopped, false);
    assert.equal(state.session.keys.size + state.session.buttons.size, 0);
    assert.ok(controlCommands(state).every(entry => entry.target.tabId === 7));
    const requests = state.trace.filter(entry => entry.kind === 'query' || (entry.kind === 'command' && entry.phase === 'control'));
    for (let index = 0; index < requests.length; index++) {
      const request = requests[index];
      if (request.kind !== 'command') continue;
      assert.equal(requests[index - 1]?.kind, 'query', `${request.method} requires its own live pre-command query`);
      if (request.method.startsWith('Input.')) assert.equal(requests[index + 1]?.kind, 'query', 'trusted input requires a live post-command query');
    }
    const counts = { queries: state.queryCount, commands: controlCommands(state).length };
    t.diagnostic(JSON.stringify(counts));
  });
}

test('a switch between adjacent query replies blocks the very first debugger command without a listener', async t => {
  const state = await harness(t, 'switch-before-first-command');
  state.afterQuery = index => {
    if (index === 1) {
      state.trace.push({ kind: 'switch', listenerDelivered: false });
      state.fake.setTab({ id: 8 });
    }
  };
  await assert.rejects(state.tools.execute(state.session, 'browser_click', { elementId: 'snapshot:1' }), /changed|stopped/);
  assert.equal(state.session.stopped, true);
  assert.deepEqual(controlCommands(state), [], 'the second live query must block Page.getFrameTree too');
});

test('the post-command query cannot authorize the next command when its next reply changes', async t => {
  const state = await harness(t, 'switch-after-input-check');
  let afterMove = false;
  state.afterCommand = command => { if (command.params.type === 'mouseMoved') afterMove = true; };
  state.afterQuery = () => {
    if (!afterMove) return;
    afterMove = false;
    state.trace.push({ kind: 'switch', listenerDelivered: false });
    state.fake.setTab({ id: 8 });
  };
  await assert.rejects(state.tools.execute(state.session, 'browser_click', { elementId: 'snapshot:1' }), /changed|stopped/);
  const switchIndex = state.trace.findIndex(entry => entry.kind === 'switch');
  assert.ok(switchIndex > 0);
  assert.deepEqual(state.trace.slice(switchIndex).filter(entry => entry.kind === 'command' && entry.phase === 'control'), []);
  assert.deepEqual(inputs(state).map(entry => entry.params.type), ['mouseMoved']);
});

test('a transient switch in the earlier of two checks must also stop control', async t => {
  const state = await harness(t, 'transient-switch');
  const query = state.fake.api.tabs.query;
  state.fake.setTab({ id: 8 });
  state.fake.api.tabs.query = args => {
    const reply = query(args);
    state.fake.setTab({ id: 7 });
    state.trace.push({ kind: 'switch-restored', listenerDelivered: false });
    return reply;
  };
  await assert.rejects(state.tools.execute(state.session, 'browser_snapshot'), /changed|stopped/);
  assert.equal(state.fake.tab.id, 7, 'the query observation still matters after the tab is restored');
  assert.equal(state.session.stopped, true);
  assert.deepEqual(controlCommands(state), []);
});

test('each input acknowledgement is followed by a live check before further work', async t => {
  const state = await harness(t, 'switch-during-input');
  state.afterCommand = command => {
    if (command.params.type === 'mouseMoved') state.fake.setTab({ id: 8 });
  };
  await assert.rejects(state.tools.execute(state.session, 'browser_click', { elementId: 'snapshot:1' }), /changed|stopped/);
  assert.deepEqual(inputs(state).map(entry => entry.params.type), ['mouseMoved']);
  assert.equal(state.session.stopped, true);
});

test('cancellation while a query is pending rejects its otherwise valid late reply', async t => {
  const state = await harness(t, 'cancel-pending-query');
  const query = state.fake.api.tabs.query;
  let release;
  state.fake.api.tabs.query = args => new Promise(resolve => { release = () => query(args).then(resolve); });
  const pending = state.tools.execute(state.session, 'browser_scroll', { direction: 'down' });
  const rejected = assert.rejects(pending, /stopped/);
  await tick();
  assert.equal(typeof release, 'function');
  await state.tools.stop(state.session);
  release();
  await rejected;
  assert.deepEqual(controlCommands(state), []);
});

for (const method of ['Page.getFrameTree', 'Page.createIsolatedWorld', 'Runtime.callFunctionOn', 'Page.captureScreenshot']) {
  test(`cancellation during ${method} rejects the late result without sending further control commands`, async t => {
    const state = await harness(t, `cancel-${method}`);
    state.session.world = null;
    const send = state.fake.api.debugger.sendCommand;
    let release;
    state.fake.api.debugger.sendCommand = (target, command, args) => {
      const result = send(target, command, args);
      if (command === method && !state.session.stopped && !release) return new Promise(resolve => { release = () => result.then(resolve); });
      return result;
    };
    const pending = state.tools.execute(state.session, 'browser_snapshot');
    const rejected = assert.rejects(pending, /stopped/);
    await tick();
    assert.equal(typeof release, 'function');
    const count = controlCommands(state).length;
    await state.tools.stop(state.session);
    release();
    await rejected;
    assert.equal(controlCommands(state).length, count);
  });
}

test('cancellation during tabs.update prevents a late navigation acknowledgement from reviving control', async t => {
  const state = await harness(t, 'cancel-update');
  let release;
  state.fake.api.tabs.update = (id, args) => {
    state.trace.push({ kind: 'update', id, args });
    return new Promise(resolve => { release = resolve; });
  };
  const pending = state.tools.execute(state.session, 'browser_navigate', { url: 'https://other.test/next' });
  const rejected = assert.rejects(pending, /stopped/);
  await tick();
  assert.equal(typeof release, 'function');
  const count = controlCommands(state).length;
  await state.tools.stop(state.session);
  release();
  await rejected;
  assert.equal(controlCommands(state).length, count);
});

for (const [label, url] of [['same-url', 'https://example.test/page'], ['cross-origin', 'https://other.test/new-document']]) {
  test(`a ${label} navigation wait reacquires the world even when the numeric context ID repeats`, async t => {
    const state = await harness(t, `navigation-world-${label}`);
    const oldWorld = state.session.world;
    state.tools.navigationStarted(state.session);
    const pending = state.tools.execute(state.session, 'browser_snapshot');
    await tick();
    assert.equal(state.queryCount, 0, 'wait for navigation before checking the tab');
    state.loaderId = 'new-document-loader';
    state.fake.setTab({ url, status: 'complete' });
    await state.tools.navigationComplete(state.session);
    assert.deepEqual(await pending, snapshot(state.fake.tab.url));
    const commands = controlCommands(state);
    const create = commands.findIndex(entry => entry.method === 'Page.createIsolatedWorld');
    const call = commands.findIndex(entry => entry.method === 'Runtime.callFunctionOn');
    assert.ok(create > 0 && call > create);
    assert.equal(commands[create - 1].method, 'Page.getFrameTree');
    assert.notEqual(state.session.world.documentKey, oldWorld.documentKey);
    assert.equal(state.session.world.executionContextId, oldWorld.executionContextId, 'fixture deliberately reuses 101');
  });
}

test('a key hold rechecks the active tab after its timer and releases only owned input', async t => {
  const state = await harness(t, 'switch-during-hold');
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = state.tools.execute(state.session, 'browser_key', { key: 'w', holdMs: 100 });
  const rejected = assert.rejects(pending, /changed|stopped/);
  await tick();
  assert.deepEqual(inputs(state).map(entry => entry.params.type), ['keyDown']);
  state.fake.setTab({ id: 8 });
  t.mock.timers.tick(100);
  await rejected;
  await state.session.stopping;
  assert.deepEqual(inputs(state).map(entry => entry.params.type), ['keyDown']);
  const releases = state.trace.filter(entry => entry.kind === 'command' && entry.params.type === 'keyUp');
  assert.equal(releases.length, 1);
  assert.equal(releases[0].phase, 'cleanup');
  assert.equal(releases[0].target.tabId, 7);
});

for (const operation of ['screenshot-mask', 'screenshot-mask-stop']) {
  test(`a tab switch during ${operation} discards the capture`, async t => {
    const state = await harness(t, `switch-${operation}`);
    state.afterCommand = command => {
      if (command.method === 'Runtime.callFunctionOn' && command.params.arguments[0].value === operation) state.fake.setTab({ id: 8 });
    };
    await assert.rejects(state.tools.execute(state.session, 'browser_snapshot'), /changed|stopped/);
    assert.equal(state.session.stopped, true);
    if (operation === 'screenshot-mask') assert.equal(controlCommands(state).filter(entry => entry.method === 'Page.captureScreenshot').length, 0);
  });
}

test('a failed page guard does not leave permission for a later command', async t => {
  const state = await harness(t, 'guard-error');
  const script = state.fake.api.scripting.executeScript;
  state.fake.api.scripting.executeScript = async options => {
    if (options.args?.[0] === 'control-check') throw new Error('Refused by page guard.');
    return script(options);
  };
  await assert.rejects(state.tools.execute(state.session, 'browser_scroll', { direction: 'down' }), /Refused/);
  assert.equal(state.session.stopped, true);
  await assert.rejects(state.tools.execute(state.session, 'browser_key', { key: 'Enter' }), /stopped/);
  assert.deepEqual(inputs(state), []);
});

test('a reentrant page call cannot share permission with a pending query', async t => {
  const state = await harness(t, 'reentrant-query');
  const query = state.fake.api.tabs.query;
  const replies = [];
  state.fake.api.tabs.query = args => new Promise(resolve => replies.push(() => query(args).then(resolve)));
  const pending = state.tools.execute(state.session, 'browser_scroll', { direction: 'down' });
  const rejected = assert.rejects(pending, /changed|stopped/);
  await tick();
  const reentrant = state.tools.injectControl(state.session, 'overlay-start', { sessionId: state.session.id });
  const reentrantRejected = assert.rejects(reentrant, /changed|stopped/);
  assert.equal(replies.length, 2, 'each operation must query independently');
  state.fake.setTab({ id: 8 });
  for (const reply of replies) reply();
  await Promise.all([rejected, reentrantRejected]);
  assert.deepEqual(controlCommands(state), []);
});
