import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import vm from 'node:vm';
import { installBackground } from '../../features/ai/extension/background.js';
import { loadChat } from '../../features/ai/extension/experiments.js';
import * as experiments from '../../features/ai/extension/experiments.js';
import { detectBrowserTask } from '../../features/ai/extension/browser-task-intent.js';
import { themeReferenceImages } from '../../features/ai/extension/theme-references.js';
import { MODEL_KEY, preferredModel } from '../../features/ai/extension/model-catalog.js';
import { event, fakeChrome, panel, tick } from './browser-api-fixture.mjs';

// A provider can replace the text it streamed for a step with its final output.
// The worker's saved reply and the panel's visible reply must both end with the final text.

const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };
function area() {
  const data = {}, changed = event();
  return {
    data, onChanged: changed,
    async get(keys) {
      const wanted = keys == null ? Object.keys(data) : [keys].flat();
      return Object.fromEntries(wanted.filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    },
    async set(values) {
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: data[key], newValue: structuredClone(newValue) }]));
      Object.assign(data, structuredClone(values)); changed.emit(changes);
    },
    async remove(keys) { for (const key of [keys].flat()) delete data[key]; },
  };
}

test('the worker saves and restores the replaced reply text', async () => {
  const fake = fakeChrome();
  Object.assign(fake.api.storage, { local: area(), session: area() });
  fake.api.windows = { onFocusChanged: event(), onRemoved: event() };
  const natives = [];
  fake.api.runtime.connectNative = () => {
    const native = { sent: [], onMessage: event(), onDisconnect: event(), postMessage(value) { this.sent.push(value); }, disconnect() { this.closed = true; } };
    natives.push(native); return native;
  };
  installBackground(fake.api);
  const open = async (tabId, conversation) => {
    const port = panel();
    port.sender = { id: 'fixture', url: fake.api.runtime.getURL('panel.html?view=chat'), tab: { id: tabId, windowId: 3, incognito: false }, frameId: 0 };
    fake.api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'init', conversation, epoch: '' });
    await settle();
    return { port, native: natives.at(-1) };
  };
  const first = await open(7, uuid(1));
  first.port.onMessage.emit({ type: 'chat', provider: 'claude', model: 'auto', id: 'retry', message: 'What is 2 + 3?' });
  await settle();
  first.native.onMessage.emit({ type: 'delta', id: 'retry', text: 'Step one.\n\n' });
  first.native.onMessage.emit({ type: 'delta', id: 'retry', text: 'The answer is 4' });
  first.native.onMessage.emit({ type: 'replace', id: 'retry', remove: 15, text: 'The answer is 5.' });
  assert.deepEqual(first.port.sent.filter(message => message.type === 'replace').map(({ remove, text }) => [remove, text]), [[15, 'The answer is 5.']]);
  first.port.onDisconnect.emit();
  const reopened = await open(9, uuid(1));
  assert.equal(reopened.port.sent.find(message => message.type === 'turn-state').text, 'Step one.\n\nThe answer is 5.');
  first.native.onMessage.emit({ type: 'complete', id: 'retry' });
  await settle();
  const saved = await loadChat(fake.api, uuid(1));
  assert.equal(saved.messages.at(-1).text, 'Step one.\n\nThe answer is 5.');
});

const source = fs.readFileSync(new URL('../../features/ai/extension/panel.js', import.meta.url), 'utf8');
function panelHarness() {
  const frames = [], writes = [], streams = [], elements = new Map();
  const node = () => ({ children: [], style: {}, value: '', hidden: false, scrollTop: 0, scrollHeight: 300, clientHeight: 100,
    classList: { add() {}, toggle() {} }, setAttribute() {}, focus() {}, setSelectionRange() {}, scrollIntoView() {},
    append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } },
    replaceChildren(...children) { this.children = []; this.append(...children); }, querySelector(selector) { return this.children.find(child => '.' + child.className === selector); },
    addEventListener(type, fn) { this[type] = fn; },
  });
  const get = id => { if (!elements.has(id)) elements.set(id, node()); return elements.get(id); };
  const document = { getElementById: get, createElement: node, createElementNS: node, body: node(), activeElement: null };
  const chrome = { storage: { session: {
    set(value) { writes.push(JSON.parse(JSON.stringify(value))); return Promise.resolve(); },
    async get(key) { return { [key]: [] }; },
  }, local: { async get() { return {}; } } }, windows: { async getCurrent() { return { id: 7 }; } },
  runtime: { connect() { return { postMessage() {}, onMessage: { addListener() {} }, onDisconnect: { addListener() {} } }; } },
  breezerPrivate: { async authorizeCurrentPage() { return true; } },
  };
  const context = vm.createContext({ document, chrome, crypto: { randomUUID: () => 'turn' }, ...experiments, detectBrowserTask, themeReferenceImages,
    MODEL_KEY, preferredModel, listenForNewTabAsk() {}, ResearchSources: class { size = 0; selected = new Map(); clear() {} },
    requestAnimationFrame(fn) { frames.push(fn); },
    renderMessage(body, text) { body.textContent = text; },
    createMessageStream(body) {
      let started = false;
      const stream = { disposed: false, append(text) { assert.equal(this.disposed, false); if (!started) { body.textContent = ''; started = true; } body.textContent += text; }, dispose() { this.disposed = true; } };
      streams.push(stream); return stream;
    },
    renderReplyWidget: () => null,
  });
  const prefix = source.replace(/^import .*;\n/gm, '').split("$('composer').addEventListener")[0];
  const initialize = source.slice(source.indexOf('function restoreNewTabDraft('), source.indexOf('void startPanelTheme();'));
  vm.runInContext(prefix + '\n' + initialize + `
    selectedModel = () => ({provider: {id: 'fixture'}, model: {id: 'fixture'}});
    selectedSettings = () => ({reasoning: '', speed: 'standard'});
    updateControls = () => {}; setModelMenu = () => {}; applyProfile = () => {}; revealPanel = () => {};
    globalThis.api = {state, messageNodes, send, receive};
  `, context);
  const api = context.api;
  api.state.includeContext = false;
  api.state.messages = [];
  api.state.port = chrome.runtime.connect();
  return { ...api, writes, streams, get,
    async start(text = 'question') { get('prompt').value = text; await api.send(); return api.state.running; },
    flush() { while (frames.length) frames.shift()(); },
  };
}

test('the panel shows and saves the replaced reply text', async () => {
  const h = panelHarness();
  const run = await h.start('What is 2 + 3?');
  const body = h.messageNodes.get(run.assistantId);
  h.receive({ type: 'delta', id: run.id, text: 'Step one.\n\n' });
  h.receive({ type: 'delta', id: run.id, text: 'The answer is 4' });
  h.flush();
  assert.equal(body.textContent, 'Step one.\n\nThe answer is 4');
  h.receive({ type: 'replace', id: run.id, remove: 15, text: 'The answer is 5.' });
  h.flush();
  assert.equal(body.textContent, 'Step one.\n\nThe answer is 5.');
  assert.equal(h.streams[0].disposed, true, 'the old stream is discarded before redrawing');
  h.receive({ type: 'delta', id: run.id, text: ' Done.' });
  h.flush();
  assert.equal(body.textContent, 'Step one.\n\nThe answer is 5. Done.');
  h.receive({ type: 'replace', id: run.id, remove: -1, text: 'ignored' });
  h.receive({ type: 'complete', id: run.id });
  await tick();
  const saved = Object.values(h.writes.at(-1)).find(Array.isArray);
  assert.equal(saved.at(-1).text, 'Step one.\n\nThe answer is 5. Done.');
});
