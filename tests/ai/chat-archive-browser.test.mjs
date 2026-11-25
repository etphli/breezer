import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drives the real New Tab and chat pages against one synthetic profile. The worker is
// replaced by a script in each page, so no helper, provider or account is involved.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || resolve(here, '../../build/support/chat-archive-evidence');
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = resolve(root, `.${url.pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      const body = await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(body);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return server;
}

// storage.local and storage.session live in localStorage so every page of the profile
// shares them. sessionStorage and history stay per tab, as in a browser.
function installProfile() {
  if (location.protocol !== 'http:') return; // about:blank has no storage
  window.fx = { sent: [], ports: [], errors: [] };
  const tabId = () => { let id = Number(window.name.replace('tab-', '')); if (!id) { id = Number(localStorage.getItem('fx-next') || 10) + 1; localStorage.setItem('fx-next', String(id)); window.name = `tab-${id}`; } return id; };
  const id = tabId();
  const open = () => JSON.parse(localStorage.getItem('fx-tabs') || '{}');
  const url = () => location.origin + location.pathname + location.search;
  localStorage.setItem('fx-tabs', JSON.stringify({ ...open(), [id]: url() }));
  const area = name => {
    const listeners = new Set(), prefix = `fx-${name}:`;
    const emit = changes => { for (const fn of [...listeners]) fn(structuredClone(changes)); };
    addEventListener('storage', event => {
      if (event.key?.startsWith(prefix)) emit({ [event.key.slice(prefix.length)]: { oldValue: JSON.parse(event.oldValue) ?? undefined, newValue: JSON.parse(event.newValue) ?? undefined } });
    });
    const read = key => JSON.parse(localStorage.getItem(prefix + key)) ?? undefined;
    const keys = () => Object.keys(localStorage).filter(key => key.startsWith(prefix)).map(key => key.slice(prefix.length));
    return {
      async get(wanted) { return Object.fromEntries((wanted == null ? keys() : [wanted].flat()).filter(key => read(key) !== undefined).map(key => [key, read(key)])); },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: read(key), newValue: value }; localStorage.setItem(prefix + key, JSON.stringify(value)); }
        setTimeout(() => emit(changes), 0);
      },
      async remove(wanted) {
        const changes = {};
        for (const key of [wanted].flat()) { if (read(key) !== undefined) changes[key] = { oldValue: read(key) }; localStorage.removeItem(prefix + key); }
        setTimeout(() => emit(changes), 0);
      },
      onChanged: { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) },
    };
  };
  const tabs = () => Object.entries(open()).map(([tab, address]) => ({ id: Number(tab), windowId: 1, url: address, incognito: false }));
  const providers = [{ id: 'codex', available: true, authenticated: !localStorage.getItem('fx-signed-out'), defaultModel: 'gpt-6-luna', models: [{ id: 'gpt-6-luna', label: 'Sample model', reasoningEfforts: ['low'], speeds: ['standard'] }] }];
  window.chrome = {
    storage: { local: area('local'), session: area('session') },
    search: { query: async () => {} },
    topSites: { get: async () => [] },
    windows: { getCurrent: async () => ({ id: 1, state: 'normal' }), getAll: async () => [{ id: 1, type: 'normal', tabs: tabs() }], update: async () => {} },
    tabs: {
      getCurrent: async () => ({ id, windowId: 1, incognito: false }), get: async wanted => tabs().find(tab => tab.id === wanted), query: async () => tabs(),
      update: async (wanted, changes) => { fx.updated = [wanted, changes]; if (changes.url) location.assign(changes.url); return { id: wanted, windowId: 1 }; },
      create: async () => {},
    },
    sidePanel: { open: async () => {}, close: async () => {} },
    runtime: {
      id: 'fixture', getURL: path => `${location.origin}/${path}`, getManifest: () => ({ permissions: [] }), lastError: undefined,
      connect: ({ name }) => {
        const messages = [], closed = [];
        const port = { name, live: true, onMessage: { addListener: fn => messages.push(fn) }, onDisconnect: { addListener: fn => closed.push(fn) },
          disconnect() { port.live = false; },
          postMessage(message) {
            fx.sent.push({ port: name, ...message });
            const emit = value => setTimeout(() => messages.forEach(fn => fn(value)), 0);
            if (name === 'breezer-newtab') emit({ type: 'view', id: message.id, topSites: [], organato: { enabled: false }, dashboardEnabled: false });
            if (name === 'breezer-panel' && ['init', 'refresh-models'].includes(message.type)) emit({ type: 'status', providers });
            if (name === 'breezer-panel' && message.type === 'chat' && !localStorage.getItem('fx-hold')) {
              emit({ type: 'delta', id: message.id, text: `Answer to ${message.message}` });
              emit({ type: 'complete', id: message.id });
            }
          } };
        fx.ports.push(port);
        return port;
      },
    },
  };
  addEventListener('error', event => fx.errors.push(event.message));
  addEventListener('unhandledrejection', event => fx.errors.push(String(event.reason)));
}

async function profile() {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const context = await browser.newContext({ viewport: { width: 1180, height: 820 }, reducedMotion: 'reduce', locale: 'en-US' });
  await context.addInitScript(installProfile);
  const errors = [];
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  const open = async () => {
    const page = await context.newPage();
    await page.goto(`${base}/newtab.html`);
    await page.waitForFunction(() => document.documentElement.dataset.composer === 'on');
    return page;
  };
  const seed = await context.newPage();
  await seed.goto(`${base}/icon128.png`);
  await seed.evaluate(() => localStorage.setItem('fx-local:breezerExperiments', JSON.stringify({ version: 1, newTabComposer: true, newTabRecentChats: true })));
  await seed.close();
  // A tab closing, or the browser restarting, is done by the worker; do its storage work here.
  const closeTab = async page => {
    const name = await page.evaluate(() => window.name);
    await page.close();
    const other = context.pages()[0] ?? await open();
    await other.evaluate(tab => {
      const tabs = JSON.parse(localStorage.getItem('fx-tabs')); delete tabs[tab.slice(4)]; localStorage.setItem('fx-tabs', JSON.stringify(tabs));
      for (const key of [`fx-session:breezer-full-conversation-${tab}`, `fx-session:breezer-chat-id-${tab}`]) localStorage.removeItem(key);
    }, name);
  };
  return { browser, context, errors, open, base, closeTab, async stop() { await browser.close(); await new Promise(done => server.close(done)); } };
}

const ask = async (page, text) => {
  await page.getByRole('radio', { name: 'Ask Breezer' }).click();
  await page.locator('#composer-input').fill(text);
  await Promise.all([page.waitForURL('**/panel.html?view=chat'), page.locator('#composer-input').press('Enter')]);
  await page.getByText(`Answer to ${text}`, { exact: true }).waitFor();
};
const back = async page => { await page.goBack({ waitUntil: 'commit' }); await page.locator('#composer-input').waitFor(); await page.waitForFunction(() => document.documentElement.dataset.composer === 'on'); };
const shown = page => page.locator('.message.user .message-body').allInnerTexts();
const titles = page => page.locator('.recent-chat-title').allInnerTexts();

test('each New Tab question is its own chat, and Back, Forward and reload keep them apart', { skip, timeout: 60_000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const { open, errors, stop } = await profile();
  try {
    const page = await open();
    await ask(page, 'Explain tides');
    assert.deepEqual(await shown(page), ['Explain tides']);
    await back(page);
    await ask(page, 'Name a cat');
    assert.deepEqual(await shown(page), ['Name a cat'], 'a second question in the same tab starts empty');
    const request = await page.evaluate(() => fx.sent.find(message => message.type === 'chat'));
    assert.deepEqual(request.history, [], 'the earlier chat is not sent to the model');
    await page.locator('#prompt').fill('And a dog?');
    await page.locator('#send').click();
    await page.getByText('Answer to And a dog?', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => fx.sent.filter(message => message.type === 'chat').at(-1))).history.length, 2, 'a follow-up stays in its chat');
    await page.reload();
    await page.getByText('Answer to And a dog?', { exact: true }).waitFor();
    assert.deepEqual(await shown(page), ['Name a cat', 'And a dog?']);
    assert.equal(await page.evaluate(() => fx.sent.some(message => message.type === 'chat')), false, 'reload never resends');
    await back(page);
    await page.locator('.recent-chat').nth(1).waitFor();
    assert.deepEqual(await titles(page), ['Name a cat', 'Explain tides']);
    await page.screenshot({ path: join(evidence, 'newtab-saved-chats.png') });
    await page.goForward({ waitUntil: 'commit' });
    await page.getByText('Answer to And a dog?', { exact: true }).waitFor();
    assert.deepEqual(await shown(page), ['Name a cat', 'And a dog?']);

    // Reopen the older chat here, continue it, then go back through both entries.
    await back(page);
    await page.locator('.recent-chat', { hasText: 'Explain tides' }).click();
    await page.getByText('Answer to Explain tides', { exact: true }).waitFor();
    await page.locator('#prompt').fill('Why two a day?');
    await page.locator('#send').click();
    await page.getByText('Answer to Why two a day?', { exact: true }).waitFor();
    assert.equal((await page.evaluate(() => fx.sent.filter(message => message.type === 'chat').at(-1))).history.length, 2);
    await page.reload();
    await page.getByText('Answer to Why two a day?', { exact: true }).waitFor();
    assert.deepEqual(await shown(page), ['Explain tides', 'Why two a day?']);
    await back(page);
    await page.locator('.recent-chat').nth(1).waitFor();
    assert.deepEqual(await titles(page), ['Explain tides', 'Name a cat'], 'a continued chat is not duplicated');

    // New chat inside the page starts another conversation and keeps the old one.
    await page.goForward({ waitUntil: 'commit' });
    await page.getByText('Answer to Why two a day?', { exact: true }).waitFor();
    await page.locator('#new-chat').click();
    assert.deepEqual(await shown(page), []);
    await page.locator('#prompt').fill('Fresh start');
    await page.locator('#send').click();
    await page.getByText('Answer to Fresh start', { exact: true }).waitFor();
    await back(page);
    await page.locator('.recent-chat').nth(2).waitFor();
    assert.deepEqual(await titles(page), ['Fresh start', 'Explain tides', 'Name a cat']);
    assert.deepEqual(await page.evaluate(() => fx.errors), []);
    assert.deepEqual(errors, []);
  } finally { await stop(); }
});

test('chats reopen after their tab closes and after a browser restart', { skip, timeout: 60_000 }, async () => {
  const { open, closeTab, errors, context, stop } = await profile();
  try {
    const first = await open();
    await ask(first, 'Plan a garden');
    const second = await open();
    await second.locator('.recent-chat', { hasText: 'Plan a garden' }).waitFor();
    assert.equal(await second.locator('.recent-chat-where').innerText(), 'This window', 'an open chat is listed as open');
    await second.locator('.recent-chat').click();
    await second.waitForFunction(() => fx.updated);
    assert.deepEqual(await second.evaluate(() => fx.updated[1]), { active: true }, 'an open chat is focused, never opened twice');
    await closeTab(first);
    await second.reload();
    await second.locator('.recent-chat-where', { hasText: 'Today' }).waitFor();

    // Restart: session data is gone, saved chats remain.
    await second.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('fx-session:') || key === 'fx-tabs') localStorage.removeItem(key); });
    await second.reload();
    await second.locator('.recent-chat', { hasText: 'Plan a garden' }).click();
    await second.getByText('Answer to Plan a garden', { exact: true }).waitFor();
    assert.equal(await second.evaluate(() => fx.sent.some(message => message.type === 'chat')), false);

    // A restored chat tab finds its own chat from its history entry.
    await second.evaluate(() => { for (const key of Object.keys(localStorage)) if (key.startsWith('fx-session:')) localStorage.removeItem(key); });
    await second.reload();
    await second.getByText('Answer to Plan a garden', { exact: true }).waitFor();

    // A duplicated tab continues separately instead of overwriting the first.
    const entry = await second.evaluate(() => history.state);
    const copy = await context.newPage();
    await copy.goto(second.url());
    await copy.evaluate(state => history.replaceState(state, ''), entry);
    await copy.reload();
    await copy.getByText('Answer to Plan a garden', { exact: true }).waitFor();
    const ids = await Promise.all([second, copy].map(page => page.evaluate(() => history.state.breezerChat)));
    assert.notEqual(ids[0], ids[1]);
    assert.deepEqual(errors, []);
  } finally { await stop(); }
});

test('a draft belongs to its own question and opening a saved chat keeps it for Back', { skip, timeout: 60_000 }, async () => {
  const { open, errors, stop } = await profile();
  try {
    const page = await open();
    await ask(page, 'Explain tides');
    await back(page);
    await page.getByRole('radio', { name: 'Ask Breezer' }).click();
    await page.locator('#composer-input').fill('An unsent question');
    await page.locator('.recent-chat', { hasText: 'Explain tides' }).click();
    await page.getByText('Answer to Explain tides', { exact: true }).waitFor();
    assert.equal(await page.locator('#prompt').inputValue(), '');
    await page.reload();
    await page.getByText('Answer to Explain tides', { exact: true }).waitFor();
    assert.equal(await page.locator('#prompt').inputValue(), '');
    assert.equal(await page.evaluate(() => fx.sent.some(message => message.type === 'chat')), false);
    await back(page);
    await page.waitForFunction(() => document.querySelector('#composer-input').value === 'An unsent question');

    // Signed out: the question waits in a new chat and Forward never leaks it into the old one.
    await page.evaluate(() => localStorage.setItem('fx-signed-out', '1'));
    await Promise.all([page.waitForURL('**/panel.html?view=chat'), page.locator('#composer-input').press('Enter')]);
    await page.waitForFunction(() => document.querySelector('.panel').dataset.accountState === 'signed-out');
    assert.deepEqual(await shown(page), []);
    assert.equal(await page.locator('#prompt').inputValue(), 'An unsent question');
    await back(page);
    await page.waitForFunction(() => document.querySelector('#composer-input').value === 'An unsent question');
    await page.evaluate(() => localStorage.removeItem('fx-signed-out'));
    await page.goForward({ waitUntil: 'commit' });
    await page.waitForFunction(() => document.querySelector('#prompt')?.value === 'An unsent question');
    assert.deepEqual(await shown(page), [], 'the waiting question has its own empty chat');
    assert.equal(await page.evaluate(() => fx.sent.some(message => message.type === 'chat')), false);
    await page.locator('#send').click();
    await page.getByText('Answer to An unsent question', { exact: true }).waitFor();
    assert.deepEqual(await shown(page), ['An unsent question']);
    assert.deepEqual(errors, []);
  } finally { await stop(); }
});

test('a question is saved before its reply and clearing resets every page', { skip, timeout: 60_000 }, async () => {
  const { open, errors, stop } = await profile();
  try {
    const page = await open();
    await page.evaluate(() => localStorage.setItem('fx-hold', '1'));
    await page.getByRole('radio', { name: 'Ask Breezer' }).click();
    await page.locator('#composer-input').fill('A slow question');
    await Promise.all([page.waitForURL('**/panel.html?view=chat'), page.locator('#composer-input').press('Enter')]);
    await page.waitForFunction(() => fx.sent.some(message => message.type === 'chat'));
    const other = await open();
    await other.locator('.recent-chat', { hasText: 'A slow question' }).waitFor();
    const clear = other.locator('#recent-chats-clear');
    await clear.click();
    assert.equal(await clear.innerText(), 'Clear all chats?');
    await other.locator('#composer-input').focus();
    assert.equal(await clear.innerText(), 'Clear', 'moving away cancels');
    await clear.click();
    await clear.click();
    await other.locator('#composer-status', { hasText: 'Chats cleared.' }).waitFor();
    await other.locator('#recent-chats').waitFor({ state: 'hidden' });
    await page.waitForFunction(() => document.querySelectorAll('.message').length === 0);
    const run = await page.evaluate(() => fx.sent.find(message => message.type === 'chat').id);
    assert.ok(await page.evaluate(id => fx.sent.some(message => message.type === 'cancel' && message.id === id), run));
    await page.waitForTimeout(100);
    assert.deepEqual(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('fx-local:breezerChat.'))), []);
    await page.evaluate(() => localStorage.removeItem('fx-hold'));
    await page.locator('#prompt').fill('After clearing');
    await page.locator('#send').click();
    await page.getByText('Answer to After clearing', { exact: true }).waitFor();
    await other.locator('.recent-chat', { hasText: 'After clearing' }).waitFor();
    assert.deepEqual(await titles(other), ['After clearing']);
    assert.deepEqual(errors, []);
  } finally { await stop(); }
});

test('only choosing Ask warms the helper, and the long list opens every saved chat', { skip, timeout: 60_000 }, async () => {
  const { open, errors, stop } = await profile();
  try {
    const page = await open();
    const ports = () => page.evaluate(() => fx.ports.filter(port => port.name === 'breezer-ask').map(port => port.live));
    assert.deepEqual(await ports(), [], 'opening New Tab starts nothing');
    await page.getByRole('radio', { name: 'Ask Breezer' }).click();
    assert.deepEqual(await ports(), [true]);
    assert.deepEqual(await page.evaluate(() => fx.sent.filter(message => message.port === 'breezer-ask')), [{ port: 'breezer-ask', type: 'prewarm' }]);
    await page.getByRole('radio', { name: 'Ask Breezer' }).click();
    assert.equal((await ports()).length, 1, 'choosing Ask again is not a second request');
    await page.evaluate(() => { Object.defineProperty(document, 'hidden', { value: true, configurable: true }); document.dispatchEvent(new Event('visibilitychange')); });
    assert.deepEqual(await ports(), [false], 'a hidden page lets go');
    await page.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
    assert.deepEqual(await ports(), [false, true]);
    await page.getByRole('radio', { name: 'Search' }).click();
    assert.deepEqual(await ports(), [false, false]);
    await page.getByRole('radio', { name: 'Ask Breezer' }).click();
    await page.evaluate(() => chrome.storage.local.set({ breezerExperiments: {} }));
    await page.waitForFunction(() => !document.documentElement.dataset.composer);
    assert.deepEqual(await ports(), [false, false, false], 'turning Ask off lets go');
    await page.evaluate(() => chrome.storage.local.set({ breezerExperiments: { newTabComposer: true, newTabRecentChats: true } }));
    await page.waitForFunction(() => document.documentElement.dataset.composer === 'on');

    for (const question of ['One', 'Two', 'Three', 'Four', 'Five']) { await ask(page, question); await back(page); }
    await page.locator('#recent-chats-more').waitFor();
    assert.equal(await page.locator('.recent-chat').count(), 3);
    await page.locator('#recent-chats-more').click();
    await page.waitForFunction(() => document.querySelectorAll('.recent-chat').length === 5);
    assert.deepEqual(await titles(page), ['Five', 'Four', 'Three', 'Two', 'One']);
    assert.equal(await page.locator('#recent-chats-more').getAttribute('aria-expanded'), 'true');
    await page.screenshot({ path: join(evidence, 'newtab-saved-chats-all.png') });
    await page.locator('.recent-chat', { hasText: 'One' }).click();
    await page.getByText('Answer to One', { exact: true }).waitFor();
    assert.deepEqual(errors, []);
  } finally { await stop(); }
});
