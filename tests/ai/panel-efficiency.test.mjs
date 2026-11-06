import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = fs.readFileSync(new URL('../../features/ai/extension/panel.js', import.meta.url), 'utf8');
const baselineSHA = 'ed7dea30709beb45cba3a340ae333603500c91de655b2ff665aabf68108a60bb';
const hash = text => createHash('sha256').update(text).digest('hex');
// The reviewed original is independent of unrelated UI changes in the current controller.
const baseline = fs.readFileSync(new URL('./fixtures/panel-before-efficiency.js', import.meta.url), 'utf8');
assert.equal(hash(baseline), baselineSHA, 'negative control must match the exact reviewed original');
function originalSource(current) {
  if (hash(current) === baselineSHA) return current;
  return current
    .replace(/function recentMessages\(limit\) \{[\s\S]*?\n\}\n\n/, '')
    .replace('recentMessages(60)', 'state.messages.filter((item) => item.text).slice(-60)')
    .replace('recentMessages(30)', 'state.messages.filter((item) => item.text).slice(-30)')
    .replace('const message = state.running?.message;', 'const message = state.messages.find((item) => item.id === state.running?.assistantId);')
    .replace(/    \/\/ Resolve once[^\n]*\n    message: state.messages.find\(\(item\) => item.id === assistantId\),\n/, '')
    .replace('state.running = {\n    id, assistantId, control: state.control,\n  };', 'state.running = { id, assistantId, control: state.control };')
    .replace('    state.running.message = null;\n', '')
    .replace('const empty = run && !run.message.text;', 'const empty = run && !state.messages.find((item) => item.id === run.assistantId).text;')
    .replace('const reply = state.running.message;', 'const reply = state.messages.find((item) => item.id === state.running.assistantId);');
}
const baselineForBehavior = originalSource(source);

function harness(code, initial = [], ids = []) {
  const frames = [], posts = [], writes = [], events = [], renders = [], streams = [], elements = new Map();
  const counts = { reads: 0, findCallbacks: 0, filterCallbacks: 0, resultArrays: 0, resultSlots: 0, frames: 0 };
  const node = () => ({ children: [], style: {}, value: '', hidden: false, scrollTop: 0, scrollHeight: 300, clientHeight: 100,
    classList: { add() {}, toggle() {} }, setAttribute() {}, focus() {}, setSelectionRange() {}, scrollIntoView() {},
    append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } },
    replaceChildren() { this.children = []; }, querySelector(selector) { return this.children.find(child => '.' + child.className === selector); },
    addEventListener(type, fn) { this[type] = fn; },
  });
  const get = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const document = { getElementById: get, createElement: node, body: node(), activeElement: null };
  const instrument = array => new Proxy(array, { get(target, key, receiver) {
    if (/^\d+$/.test(String(key))) counts.reads++;
    if (key === 'find' || key === 'filter') return callback => {
      const result = Array.prototype[key].call(receiver, (...args) => { counts[key + 'Callbacks']++; return callback(...args); });
      if (key === 'filter') {
        counts.resultArrays++; counts.resultSlots += result.length;
        Object.defineProperty(result, 'slice', { value(...args) { const sliced = Array.prototype.slice.apply(this, args); counts.resultArrays++; counts.resultSlots += sliced.length; return sliced; } });
      }
      return result;
    };
    return Reflect.get(target, key, receiver);
  } });
  let sequence = 0;
  const chrome = { storage: { session: {
    set(value) { writes.push({ refs: Object.values(value)[0], snapshot: JSON.parse(JSON.stringify(value)) }); events.push('write'); return Promise.resolve(); },
    async get(key) { return { [key]: initial }; },
  }, local: { async get() { return {}; } } }, windows: { async getCurrent() { return { id: 7 }; } },
  runtime: { connect() { return { postMessage(value) { posts.push(JSON.parse(JSON.stringify(value))); events.push(value.type); }, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; } },
  breezerPrivate: { async authorizeCurrentPage() { return true; } },
  };
  const context = vm.createContext({ document, chrome, crypto: { randomUUID: () => ids[sequence++] || `run-${sequence}` },
    ResearchSources: class { size = 0; selected = new Map(); clear() {} },
    requestAnimationFrame(fn) { counts.frames++; frames.push(fn); },
    renderMessage(body, text) { renders.push(text); body.textContent = text; },
    createMessageStream(body) { const stream = { disposed: false, append(text) { assert.equal(this.disposed, false); body.textContent = (body.textContent || '') + text; }, dispose() { this.disposed = true; } }; streams.push(stream); return stream; },
    instrument, counts,
  });
  const prefix = code.replace(/^import .*;\n/gm, '').split("$('composer').addEventListener")[0];
  const newChat = code.slice(code.indexOf("$('new-chat').addEventListener"), code.indexOf("$('model-button').addEventListener"));
  const initialize = code.slice(code.indexOf('async function initialize()'), code.indexOf('void startPanelTheme();'));
  vm.runInContext(prefix + '\n' + initialize + `
    selectedModel = () => ({provider: {id: 'fixture'}, model: {id: 'fixture'}});
    selectedSettings = () => ({reasoning: '', speed: 'standard'});
    updateControls = () => {}; setModelMenu = () => {}; applyProfile = () => {}; revealPanel = () => {};
    if (typeof recentMessages === 'function') {
      const select = recentMessages;
      recentMessages = limit => { const result = select(limit); counts.resultArrays++; counts.resultSlots += result.length; return result; };
    }
    globalThis.api = {state, messageNodes, send, receive, stop, finish, saveConversation, initialize};
  ` + newChat, context);
  const api = context.api;
  api.state.includeContext = false;
  api.state.port = chrome.runtime.connect();
  function load(messages) { api.state.messages = instrument(messages); messages.forEach(apiMessage => {
    // Existing nodes are synthetic; newly sent messages use the actual appendMessage.
    api.messageNodes.set(apiMessage.id, node());
  }); }
  load(initial);
  return { ...api, counts, frames, posts, writes, events, renders, streams, get, load,
    async start(text = 'question') { get('prompt').value = text; await api.send(); return api.state.running; },
    flush() { while (frames.length) frames.shift()(); },
    reset() { for (const key of Object.keys(counts)) counts[key] = 0; },
  };
}
const records = n => Array.from({ length: n }, (_, i) => ({ id: `history-${i}`, role: i % 2 ? 'assistant' : 'user', text: i % 7 ? `text ${i}` : '', contextTitle: `page ${i}` }));
const plain = value => JSON.parse(JSON.stringify(value));

test('known provider failures name the cause without exposing technical details in the reply', async () => {
  for (const [reason, expected] of [
    ['HTTP 429 rate_limit_exceeded: private diagnostic', /provider limit.*reset before retrying/],
    ['401 Unauthorized: private account diagnostic', /could not verify your account/],
    ['Provider request timed out after 60000ms', /took too long to reply/],
    ['connect ECONNREFUSED 127.0.0.1:1234', /connection to your provider failed/],
    ['unrecognized provider diagnostic', /could not complete this response/],
  ]) {
    const h = harness(source), run = await h.start();
    h.receive({ type: 'error', id: run.id, error: reason });
    const response = h.state.messages.find(message => message.id === run.assistantId).text;
    assert.match(response, expected);
    assert.equal(response.includes(reason), false);
  }
});

async function scenario(code, ending, collision = false) {
  const initial = records(125);
  if (collision) initial.unshift({ id: 'same-reply', role: 'assistant', text: 'first match' }, { id: 'same', role: 'user', text: 'original collision user' });
  const h = harness(code, initial, ['same', 'next']);
  const run = await h.start();
  if ('message' in run) assert.equal(run.message, h.state.messages.find(item => item.id === run.assistantId));
  const expectedHistory = initial.slice(0, -2).filter(item => item.text).slice(-30).map(({ role, text: content }) => ({ role, content }));
  assert.deepEqual(h.posts[0].history, expectedHistory);
  for (let frame = 0; frame < 20; frame++) {
    for (let delta = 0; delta < 8; delta++) h.receive({ type: 'delta', id: run.id, text: delta % 3 ? 'part ' : '' });
    assert.equal(h.frames.length, 1); h.flush();
  }
  h.receive({ type: 'delta', id: run.id, text: 'queued' });
  const stream = h.streams.at(-1);
  if (ending === 'stop') h.stop();
  else if (ending === 'new-chat') h.get('new-chat').click();
  else h.receive({ type: ending, id: run.id, error: 'fixture error', cancelled: ending === 'complete' });
  assert.equal(h.state.running, null);
  assert.equal(run.renderer, null);
  if ('message' in run) assert.equal(run.message, null, 'retry closures must not retain the cached reply');
  assert.equal(stream.disposed, true);
  assert.equal(h.state.messages.length, ending === 'new-chat' ? 0 : initial.length);
  if (ending === 'error') {
    const retry = h.messageNodes.get(run.assistantId).parentElement.querySelector('.retry-button');
    retry.click();
    assert.equal(h.get('prompt').value, collision ? 'original collision user' : 'question');
  }
  await h.start('next question');
  h.receive({ type: 'delta', id: run.id, text: 'STALE' });
  h.receive({ type: 'delta', id: h.state.running.id, text: 'new reply' });
  assert.equal(h.frames.length, 1, 'queued old RAF coalesces into current run'); h.flush();
  h.receive({ type: 'complete', id: h.state.running.id });
  return plain({ messages: h.state.messages, posts: h.posts, writes: h.writes.map(write => write.snapshot), events: h.events, renders: h.renders });
}

test('source controller preserves history, writes, retry, terminal rendering and stale RAF ordering', async () => {
  for (const ending of ['complete', 'error', 'stop', 'new-chat']) for (const collision of [false, true]) {
    assert.deepEqual(await scenario(source, ending, collision), await scenario(baselineForBehavior, ending, collision));
  }
});

test('storage selects truthy tail by reference and snapshots at each synchronous storage call', async () => {
  for (const n of [0, 12, 61, 600]) {
    const data = records(n), h = harness(source, data);
    await h.saveConversation();
    const expected = data.filter(item => item.text).slice(-60);
    assert.equal(h.writes[0].refs.length, expected.length);
    expected.forEach((item, i) => assert.equal(h.writes[0].refs[i], item));
    const snapshot = plain(h.writes[0].snapshot);
    if (expected.length) expected.at(-1).text = 'mutated later';
    data.push({ id: 'later', role: 'user', text: 'later' });
    assert.deepEqual(h.writes[0].snapshot, snapshot);
    await h.saveConversation();
    assert.deepEqual(plain(h.writes[1].refs), plain(data.filter(item => item.text).slice(-60)));
    assert.equal(h.state.messages.length, n + 1);
  }
});

test('actual initialize accepts loaded valid records, including empty text, before sending', async () => {
  async function loaded(code) {
    const data = [...records(90), { role: 'invalid', text: 'reject' }, { role: 'user', text: 5 }];
    const h = harness(code, data);
    await h.initialize();
    const expected = data.filter(item => ['user', 'assistant'].includes(item.role) && typeof item.text === 'string').slice(-60);
    assert.deepEqual(plain(h.state.messages), expected);
    await h.start(); h.receive({ type: 'complete', id: h.state.running.id });
    return plain({ posts: h.posts, writes: h.writes.map(write => write.snapshot), messages: h.state.messages });
  }
  assert.deepEqual(await loaded(source), await loaded(baselineForBehavior));
});

test('empty replies, stop retry, pending authorization cancellation and post failure stay equivalent', async () => {
  async function edges(code) {
    const output = [];
    for (const ending of ['complete', 'error', 'stop']) {
      const h = harness(code, records(80)); const run = await h.start();
      h.receive({ type: 'delta', id: run.id, text: '' });
      if (ending === 'stop') h.stop(); else h.receive({ type: ending, id: run.id, error: 'empty failure' });
      h.flush();
      if (ending !== 'complete') {
        const button = h.messageNodes.get(run.assistantId).parentElement.querySelector('.retry-button');
        h.get('prompt').value = 'existing draft'; button.click(); assert.equal(h.get('prompt').value, 'existing draft');
        h.get('prompt').value = ''; button.click(); assert.equal(h.get('prompt').value, 'question');
      }
      output.push(plain({ messages: h.state.messages, writes: h.writes.map(write => write.snapshot), events: h.events, renders: h.renders }));
    }
    const h = harness(code); h.state.includeContext = true;
    const pending = h.start(); h.stop(); await pending;
    assert.equal(h.posts.some(post => post.type === 'chat'), false);
    h.state.includeContext = false; h.state.port = null; await h.start();
    assert.equal(h.state.running, null);
    output.push(plain(h.writes.map(write => write.snapshot)));
    return output;
  }
  assert.deepEqual(await edges(source), await edges(baselineForBehavior));
});

async function measure(code, size) {
  const h = harness(code, records(size));
  await h.start();
  const start = { ...h.counts }; h.reset();
  for (let frame = 0; frame < 100; frame++) {
    for (let delta = 0; delta < 10; delta++) h.receive({ type: 'delta', id: h.state.running.id, text: 'x' });
    h.flush();
  }
  const streaming = { ...h.counts }; h.reset();
  await h.saveConversation();
  return { size, start, streaming, save: { ...h.counts } };
}

test('negative control reproduces per-delta/frame traversal and full-filter temporary arrays', async () => {
  const before = await measure(baseline, 1200);
  assert.equal(before.streaming.findCallbacks, 1202 * 1100);
  assert.equal(before.streaming.frames, 100);
  assert.equal(before.save.filterCallbacks, 1202);
  assert.equal(before.save.resultArrays, 2);
  assert.ok(before.save.resultSlots > 1000);
  assert.throws(() => assert.equal(before.streaming.findCallbacks, 0), 'old source fails intended hot-path check');
});

test('current source removes hot transcript scans and bounds selected-result allocation', async () => {
  const samples = [];
  for (const size of [12, 1200]) {
    const before = await measure(baseline, size), after = await measure(source, size);
    assert.equal(after.streaming.findCallbacks, 0);
    assert.equal(after.streaming.reads, 0);
    assert.equal(after.streaming.frames, before.streaming.frames);
    assert.equal(after.save.filterCallbacks, 0);
    assert.equal(after.save.resultArrays, 1);
    assert.equal(after.save.resultSlots, Math.min(60, records(size).filter(item => item.text).length + 2));
    assert.ok(after.save.reads <= 72);
    samples.push({ before, after });
  }
  if (process.env.PANEL_EFFICIENCY_SAMPLES) fs.writeFileSync(process.env.PANEL_EFFICIENCY_SAMPLES, JSON.stringify(samples, null, 2) + '\n');
});


test('sparse truthy tails preserve references, whitespace and original order without truncating live records', async () => {
  const data = records(500).map((item, i) => ({ ...item, text: i % 93 ? '' : i === 0 ? ' ' : `sparse ${i}` }));
  const h = harness(source, data);
  await h.saveConversation();
  const expected = data.filter(item => item.text).slice(-60);
  expected.forEach((item, i) => assert.equal(h.writes[0].refs[i], item));
  assert.equal(h.writes[0].refs[0].text, ' ');
  assert.equal(h.counts.reads, 500, 'a sparse tail may require reading the entire transcript');
  assert.equal(h.counts.resultSlots, expected.length);
  assert.equal(h.state.messages.length, 500);
});

test('provider history is a value snapshot before asynchronous page authorization', async () => {
  async function captured(code) {
    const data = records(100), h = harness(code, data);
    h.state.includeContext = true;
    const pending = h.start();
    data[99].text = 'edited while awaiting page authorization';
    data.push({ id: 'extra', role: 'user', text: 'appended while awaiting page authorization' });
    await pending;
    const sent = h.posts.find(post => post.type === 'chat');
    assert.equal(sent.history.at(-1).content, 'text 99');
    h.finish();
    return plain(sent);
  }
  assert.deepEqual(await captured(source), await captured(baselineForBehavior));
});
