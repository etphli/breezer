import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { installBackground } from '../../features/ai/extension/background.js';
import { BrowserTools } from '../../features/ai/extension/browser-tools.js';
import { prepareResearch, researchSelection } from '../../features/ai/extension/research-policy.js';
import { maskSecrets } from '../../features/ai/extension/research-sources.js';
import { validateChat } from '../../features/ai/host/protocol.mjs';
import { detectBrowserTask } from '../../features/ai/extension/browser-task-intent.js';
import { themeReferenceImages } from '../../features/ai/extension/theme-references.js';
import { MODEL_KEY, preferredModel } from '../../features/ai/extension/model-catalog.js';
import * as experiments from '../../features/ai/extension/experiments.js';
import { fakeChrome, panel, tick } from './browser-api-fixture.mjs';

const chat = { type: 'chat', id: 'chat', provider: 'codex', model: 'auto', message: 'next question' };

test('a long assistant reply in history is cut to the host limit, keeping its end', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  await tick();
  const reply = 'x'.repeat(150_000) + 'conclusion';
  port.onMessage.emit({ ...chat, history: [{ role: 'user', content: 'write long' }, { role: 'assistant', content: reply }] });
  await tick();
  const sent = fake.native.sent.find(message => message.type === 'chat');
  const [question, answer] = sent.history;
  assert.equal(question.content, 'write long');
  assert.equal(answer.content.length, 100_000);
  assert.match(answer.content, /^\[Earlier part of this message truncated\.\]\n/);
  assert.ok(answer.content.endsWith('conclusion'));
  assert.doesNotThrow(() => validateChat({ ...sent, context: undefined }));
});

test('id-less worker errors are tagged with the request that failed', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  await tick();
  fake.api.tabs.query = async () => { throw new Error('No window.'); };
  port.onMessage.emit({ type: 'context' });
  await tick(); await tick();
  const error = port.sent.find(message => message.type === 'error');
  assert.equal(error.id, undefined);
  assert.equal(error.request, 'context');
});

test('research text re-masked by the worker still fits the host limit', async () => {
  const url = 'https://example.com/a';
  const text = maskSecrets('a'.repeat(23_990) + ' token=abcdefghij').slice(0, 24_000);
  const sources = [{ sourceId: 'S1', title: 't', url, tabId: 1, documentId: 'd', expectedUrl: url, status: 'available', text, truncated: false, capturedCharacters: text.length }];
  const api = { tabs: { get: async () => ({ incognito: false, windowId: 7, url, status: 'complete' }) } };
  const [prepared] = await prepareResearch(api, sources, { selection: researchSelection(sources), invalidated: false }, 7);
  assert.equal(prepared.text.length, 24_000);
  assert.equal(prepared.capturedCharacters, 24_000);
  assert.equal(prepared.truncated, true);
  assert.doesNotThrow(() => validateChat({ ...chat, history: undefined, researchSources: [prepared] }));
});

test('replace typing refuses to insert text when focus leaves the selected field', async () => {
  const fake = fakeChrome();
  const run = fake.api.scripting.executeScript;
  let selected = false;
  fake.api.scripting.executeScript = async options => {
    const [operation, args] = options.args || [];
    if (operation === 'select-content') selected = true;
    if (operation === 'check-focus' && selected && args?.elementId === 'snapshot:1') throw new Error('The selected field lost focus. Take a new snapshot.');
    return run(options);
  };
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('focus', fake.tab);
  try {
    await assert.rejects(tools.execute(session, 'browser_type', { elementId: 'snapshot:1', text: 'secret' }), /lost focus/);
    assert.equal(fake.calls.some(call => call[0] === 'input' && call[2] === 'Input.insertText'), false);
  } finally { await tools.stop(); }
});

// A trimmed copy of the panel harness in panel-efficiency.test.mjs.
const source = fs.readFileSync(new URL('../../features/ai/extension/panel.js', import.meta.url), 'utf8');
function harness({ initial = [], set } = {}) {
  const posts = [], writes = [], elements = new Map();
  const node = () => ({ children: [], style: {}, value: '', hidden: false, scrollTop: 0, scrollHeight: 300, clientHeight: 100,
    classList: { add() {}, toggle() {} }, setAttribute() {}, focus() {}, setSelectionRange() {}, scrollIntoView() {}, remove() {},
    closest() { return node(); },
    append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } },
    replaceChildren(...children) { this.children = []; this.append(...children); }, querySelector(selector) { return this.children.find(child => '.' + child.className === selector); },
    addEventListener(type, fn) { this[type] = fn; },
  });
  const get = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const document = { getElementById: get, createElement: node, createElementNS: node, body: node(), activeElement: null };
  const chrome = { storage: { session: {
    set(value) { writes.push(value); return set ? set(value) : Promise.resolve(); },
    async get(key) { return { [key]: initial }; },
  }, local: { async get() { return {}; }, async set() {} } }, windows: { async getCurrent() { return { id: 7 }; } },
  runtime: { connect() { return { postMessage(value) { posts.push(JSON.parse(JSON.stringify(value))); }, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; } },
  breezerPrivate: { async authorizeCurrentPage() { return true; } },
  };
  let sequence = 0;
  const context = vm.createContext({ document, chrome, crypto: { randomUUID: () => `run-${++sequence}` },
    ...experiments, detectBrowserTask, themeReferenceImages, MODEL_KEY, preferredModel, listenForNewTabAsk() {},
    ResearchSources: class { size = 0; selected = new Map(); clear() {} },
    requestAnimationFrame() {}, renderMessage(body, text) { body.textContent = text; },
    createMessageStream(body) { return { append(text) { body.textContent = (body.textContent || '') + text; }, dispose() {} }; },
    renderReplyWidget: () => null,
  });
  const prefix = source.replace(/^import .*;\n/gm, '').split("$('composer').addEventListener")[0];
  const initialize = source.slice(source.indexOf('function restoreNewTabDraft('), source.indexOf('void startPanelTheme();'));
  vm.runInContext(prefix + '\n' + initialize + `
    selectedModel = () => ({provider: {id: 'fixture'}, model: {id: 'fixture'}});
    selectedSettings = () => ({reasoning: '', speed: 'standard'});
    updateControls = () => {}; setModelMenu = () => {}; applyProfile = () => {}; revealPanel = () => {};
    globalThis.api = {state, messageNodes, send, receive, saveConversation};
  ` + source.slice(source.indexOf("$('new-chat').addEventListener"), source.indexOf("$('model-button').addEventListener")), context);
  const api = context.api;
  api.state.includeContext = false;
  api.state.port = chrome.runtime.connect();
  api.state.sessionKey = 'conversation-7';
  return { ...api, posts, writes, get,
    async start(text = 'question') { get('prompt').value = text; await api.send(); return api.state.running; },
  };
}

test('an error without the running turn id is a notice and leaves the turn running', async () => {
  const h = harness();
  const run = await h.start();
  h.state.discoveryPending = false;
  h.receive({ type: 'error', request: 'context', error: 'No window.' });
  assert.equal(h.state.running, run);
  assert.equal(h.get('notice-text').textContent, 'No window.');
  h.receive({ type: 'error', id: run.id, error: 'unrecognized provider diagnostic' });
  assert.equal(h.state.running, null);
});

const image = n => 'data:image/png;base64,' + 'A'.repeat(n);
test('saved conversations keep the newest images within a budget and report failed saves', async () => {
  const h = harness();
  h.state.messages = Array.from({ length: 6 }, (_, i) => ({ id: `m${i}`, role: i % 2 ? 'assistant' : 'user', text: `text ${i}`,
    ...(i % 2 ? { generatedImage: image(600_000) } : { attachments: [{ name: `a${i}.png`, image: image(600_000) }, { name: `n${i}.txt`, text: 'notes' }] }) }));
  await h.saveConversation();
  const stored = Object.values(h.writes.at(-1))[0];
  const size = stored.reduce((sum, m) => sum + (m.generatedImage?.length || 0) + (m.attachments || []).reduce((s, f) => s + (f.image?.length || 0), 0), 0);
  assert.ok(size <= 2_500_000, `stored ${size} image bytes`);
  assert.ok(stored.at(-1).generatedImage, 'the newest image is kept');
  assert.equal(stored[0].attachments.some(file => file.image), false, 'the oldest image is dropped');
  assert.equal(JSON.stringify(stored[0].attachments.map(file => file.name)), JSON.stringify(["n0.txt"]));
  assert.deepEqual(JSON.parse(JSON.stringify(stored.map(m => m.text))), h.state.messages.map(m => m.text));
  assert.ok(h.state.messages[0].attachments[0].image, 'the live transcript is unchanged');

  const failing = harness({ set: () => Promise.reject(new Error('QUOTA_BYTES quota exceeded')) });
  failing.state.messages = [{ id: 'm', role: 'user', text: 'hello' }];
  await failing.saveConversation();
  assert.match(failing.get('notice-text').textContent, /couldn’t save this conversation/);
});
