import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PROVIDERS, TRANSLATION_KEY, translationPreferences, providerRequest } from '../../features/ai/extension/translation-provider.js';
import { installTranslation } from '../../features/ai/extension/translation-background.js';

const languages = [{ code: 'en', name: 'English', targets: ['es'] }, { code: 'es', name: 'Spanish', targets: ['en'] }];
const prefs = translationPreferences();
const reply = data => new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
const event = () => ({ listeners: new Set(), addListener(fn) { this.listeners.add(fn); }, removeListener(fn) { this.listeners.delete(fn); }, fire(...args) { for (const fn of this.listeners) fn(...args); } });
const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(resolve => setImmediate(resolve)); };

test('preferences default to local, opt out of dynamic sharing, and validate language codes', () => {
  assert.deepEqual(prefs, { provider: 'local', source: 'auto', target: 'en', dynamic: false, apiKey: '' });
  assert.equal(translationPreferences({ provider: 'evil', source: '<script>', target: 'zz:evil', dynamic: 1 }).provider, 'local');
  assert.equal(translationPreferences({ target: 'zh-Hant' }).target, 'zh-Hant');
});

test('LibreTranslate contract uses bounded text batches, no cookies/referrer/redirects, and only the chosen server receives the key', async () => {
  let called;
  const translated = await providerRequest({ ...prefs, provider: 'hosted', apiKey: 'test-secret' }, 'translate', {
    texts: ['Hola', 'Mundo'], source: 'es', target: 'en', fetcher: async (url, options) => { called = { url, options }; return reply({ translatedText: ['Hello', '<img onerror=evil()>'] }); },
  });
  assert.deepEqual(translated, ['Hello', '<img onerror=evil()>']);
  assert.equal(called.url, 'https://libretranslate.com/translate');
  assert.equal(called.options.credentials, 'omit'); assert.equal(called.options.redirect, 'error'); assert.equal(called.options.referrerPolicy, 'no-referrer');
  assert.deepEqual(JSON.parse(called.options.body), { q: ['Hola', 'Mundo'], source: 'es', target: 'en', format: 'text', api_key: 'test-secret' });
  assert.equal(called.options.body.includes('url'), false);
  assert.deepEqual(await providerRequest(prefs, 'languages', { fetcher: async () => reply(languages) }), languages);
});

test('provider rejects unsupported input, invalid/mismatched/oversized responses and hosted calls without a key', async () => {
  for (const texts of [[], ['x'.repeat(4001)], Array(33).fill('a'), [42]]) await assert.rejects(providerRequest(prefs, 'translate', { texts, source: 'es', target: 'en' }), /Invalid translation request/);
  await assert.rejects(providerRequest({ ...prefs, provider: 'hosted' }, 'translate', { texts: ['Hola'], source: 'es', target: 'en' }), /API key/);
  for (const result of [{ translatedText: 'Hello' }, { translatedText: [] }, { translatedText: [null] }]) await assert.rejects(providerRequest(prefs, 'translate', { texts: ['Hola'], source: 'es', target: 'en', fetcher: async () => reply(result) }), /invalid text batch/);
  await assert.rejects(providerRequest(prefs, 'languages', { fetcher: async () => reply([{ code: 'xx', name: 'bad', targets: ['invalid-code-long'] }]) }), /invalid language list/);
  await assert.rejects(providerRequest(prefs, 'languages', { fetcher: async () => new Response('x'.repeat(250001)) }), /too much data/);
});

test('provider reports actionable failures without reflecting server bodies or secrets; abort can be retried', async () => {
  for (const code of [400, 401, 403, 429, 500]) {
    await assert.rejects(providerRequest(prefs, 'languages', { fetcher: async () => new Response('secret error body', { status: code }) }), error => !error.message.includes('secret') && /provider|key|rate limit/i.test(error.message));
  }
  await assert.rejects(providerRequest(prefs, 'languages', { fetcher: async () => { throw new Error('raw network secret'); } }), /Start your server/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(providerRequest(prefs, 'languages', { signal: controller.signal, fetcher: async () => { throw new Error('abort'); } }), /cancelled/);
  assert.deepEqual(await providerRequest(prefs, 'languages', { fetcher: async () => reply(languages) }), languages);
});

function harness() {
  const sent = [], pageSent = [], stored = {}, opened = [], injected = [];
  const content = { onMessage: event(), onDisconnect: event(), postMessage: m => pageSent.push(m), disconnect() {} };
  const api = {
    runtime: { id: 'test-id', getURL: path => 'chrome-extension://test-id/' + path, onConnect: event(), onInstalled: event() },
    contextMenus: { onClicked: event(), remove(id, fn) { fn(); }, create() {} }, commands: { onCommand: event() },
    tabs: { async get() { return { id: 7, url: 'https://example.com/read', incognito: false }; }, async query() { return [{ id: 7 }]; }, connect(id, options) { assert.equal(id, 7); assert.equal(options.documentId, 'doc-1'); return content; } },
    scripting: { async executeScript(value) { injected.push(value); return [{ documentId: 'doc-1' }]; } },
    storage: { local: { async get() { return stored; }, async set(value) { Object.assign(stored, value); } } },
    permissions: { async contains() { return true; } }, windows: { async create(value) { opened.push(value); } },
  };
  const ui = { name: 'breezer-translation-ui', sender: { id: 'test-id', url: api.runtime.getURL('translation.html?tab=7') }, onMessage: event(), onDisconnect: event(), postMessage: m => sent.push(m) };
  installTranslation(api);
  return { api, ui, content, sent, pageSent, stored, opened, injected };
}

test('page access comes only from context action/command; settings/content-script impersonation is refused', async () => {
  const h = harness();
  assert.equal(h.injected.length, 0);
  h.api.contextMenus.onClicked.fire({ menuItemId: 'breezer-translate' }, { id: 7, incognito: true });
  assert.equal(h.opened.length, 0);
  h.api.contextMenus.onClicked.fire({ menuItemId: 'breezer-translate' }, { id: 7 });
  assert.match(h.opened[0].url, /translation.html\?tab=7/);
  h.api.runtime.onConnect.fire({ ...h.ui, sender: { id: 'test-id', url: 'https://evil.test/translation.html?tab=7' } });
  await settle(); assert.equal(h.injected.length, 0);
  h.api.runtime.onConnect.fire(h.ui); await settle();
  assert.deepEqual(h.injected[0], { target: { tabId: 7 }, world: 'ISOLATED', files: ['translation-content.js'] });
  assert.equal(h.sent[0].prefs.apiKey, undefined);
});

test('background enforces consent and language pairs, forwards batches, aborts on cancel, and refuses navigation', async t => {
  const h = harness();
  t.mock.method(globalThis, 'fetch', async url => url.endsWith('/languages') ? reply(languages) : reply({ translatedText: ['Hello'] }));
  h.api.runtime.onConnect.fire(h.ui); await settle();
  h.ui.onMessage.fire({ type: 'start', consent: false }); await settle(); assert.match(h.sent.at(-1).message, /Confirm/);
  h.ui.onMessage.fire({ type: 'languages' }); await settle();
  h.ui.onMessage.fire({ type: 'start', consent: true, source: 'en', target: 'en' }); await settle(); assert.match(h.sent.at(-1).message, /supported/);
  h.ui.onMessage.fire({ type: 'start', consent: true, source: 'es', target: 'en' }); await settle();
  assert.equal(h.stored[TRANSLATION_KEY].source, 'es');
  h.content.onMessage.fire({ type: 'batch', id: 'batch-1', texts: ['Hola'] }); await settle();
  assert.deepEqual(h.pageSent.at(-1), { id: 'batch-1', texts: ['Hello'] });
  h.ui.onMessage.fire({ type: 'cancel' }); assert.equal(h.pageSent.at(-1).type, 'cancel');
  h.content.onMessage.fire({ type: 'batch', id: 'after-cancel', texts: ['Private'] }); await settle(); assert.equal(h.pageSent.at(-1).type, 'cancel');
  h.api.tabs.get = async () => ({ id: 7, url: 'https://other.test/', incognito: false });
  h.ui.onMessage.fire({ type: 'start', consent: true, source: 'es', target: 'en' }); await settle(); assert.match(h.sent.at(-1).message, /Page changed/);
});

test('manifest grants only exact optional provider origins and keeps native selected-text translation untouched', async () => {
  const manifest = JSON.parse(await readFile(new URL('../../features/ai/extension/manifest.json', import.meta.url)));
  assert.deepEqual(manifest.optional_host_permissions, Object.values(PROVIDERS).map(p => p.origin));
  assert.ok(manifest.permissions.includes('activeTab')); assert.ok(manifest.permissions.includes('contextMenus'));
  assert.equal(manifest.content_scripts, undefined);
  const patch = await readFile(new URL('../../upstream/helium-macos/patches/helium/macos/native-translation-context-option.patch', import.meta.url), 'utf8');
  assert.match(patch, /native_translation_context_menu/);
});
