import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Peek, sidebar half: the shipped workspace.html marks only live favourite
// tabs as peek sources through breezerPrivate.setPeekSources, keeps that set
// in sync, and shows each favourite's saved identity while its tab browses.
// The native peek window itself is checked by script/check_breezer_workspace.py
// (source) and needs a compiled Breezer for runtime behaviour.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

function seed() {
  const work = 'space-work';
  const tabs = [
    { id: 1, url: 'https://linear.app/breezer/inbox', title: 'Inbox · Linear', pinned: true },
    { id: 2, url: 'https://github.com/etphli/breezer/pull/42', title: 'Pull request #42', active: true },
    { id: 8, url: 'https://calendar.example.com/week', title: 'Calendar — this week', pinned: true },
    { id: 9, url: 'https://mail.example.com/inbox', title: 'Mail — 3 unread', pinned: true },
  ].map((tab, index) => ({ windowId: 7, index, active: false, pinned: false, status: 'complete', ...tab }));
  const store = {
    version: 1, rev: 1,
    spaces: [{ id: work, name: 'Work', tone: 'mint', pinned: [{ kind: 'entry', id: 'e-linear', url: tabs[0].url, title: 'Linear' }] }],
    favorites: [
      { kind: 'entry', id: 'v-cal', url: 'https://calendar.example.com/week', title: 'Calendar' },
      { kind: 'entry', id: 'v-mail', url: 'https://mail.example.com/inbox', title: 'Mail', customTitle: 'Work mail' },
      { kind: 'entry', id: 'v-notes', url: 'https://notes.example.com/', title: 'Notes' },
    ],
    prefs: { newTabPosition: 'bottom', closeButton: 'hover' },
  };
  const record = (u, e) => ({ s: work, u, k: 'S1', ...(e ? { e } : {}) });
  const members = { version: 1, session: 'S1', prev: '', tabs: {
    1: record(tabs[0].url, 'e-linear'), 2: record(tabs[1].url), 8: record(tabs[2].url, 'v-cal'), 9: record(tabs[3].url, 'v-mail'),
  } };
  return { tabs, local: { 'workspace.v1': store, 'workspace.members.v1': members }, session: { 'workspace.session': 'S1' } };
}

// Runs inside the page: a small chrome.* fixture with a recording bridge.
function installFixture({ seed, withPeekApi }) {
  const fx = { tabs: seed.tabs, local: seed.local, session: seed.session, peek: [], listeners: {} };
  window.fx = fx;
  const copy = (value) => structuredClone(value);
  const event = (name) => ({ addListener: (fn) => (fx.listeners[name] ||= []).push(fn), removeListener() {} });
  const fire = (name, ...args) => setTimeout(() => (fx.listeners[name] || []).forEach((fn) => fn(...copy(args))), 0);
  fx.fire = fire;
  const area = (name) => ({
    async get(keys) {
      const list = keys == null ? Object.keys(fx[name]) : [keys].flat();
      return copy(Object.fromEntries(list.filter((key) => key in fx[name]).map((key) => [key, fx[name][key]])));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: fx[name][key], newValue: copy(value) };
        fx[name][key] = copy(value);
      }
      fire('storage.onChanged', changes, name);
    },
  });
  window.chrome = {
    runtime: {
      getURL: (path) => `${location.origin}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ permissions: ['tabs', 'storage'] }),
      onMessage: event('runtime.onMessage'),
      lastError: undefined,
    },
    windows: { getCurrent: async () => ({ id: 7 }), update: async (id) => ({ id }) },
    storage: { local: area('local'), session: area('session'), onChanged: event('storage.onChanged') },
    tabs: {
      onCreated: event('tabs.onCreated'), onUpdated: event('tabs.onUpdated'), onRemoved: event('tabs.onRemoved'),
      onActivated: event('tabs.onActivated'), onMoved: event('tabs.onMoved'), onAttached: event('tabs.onAttached'),
      onDetached: event('tabs.onDetached'), onReplaced: event('tabs.onReplaced'),
      async create(props) { const tab = { id: Math.max(...fx.tabs.map(tab => tab.id)) + 1, windowId: 7, ...copy(props) }; fx.tabs.push(tab); return copy(tab); },
      async query() {
        const snapshot = copy(fx.tabs);
        if (seed.startupRace) {
          seed.startupRace = false;
          fx.tabs.forEach(tab => { tab.active = false; });
          const tab = { id: 12, windowId: 7, index: fx.tabs.length, url: 'https://example.test/new', title: 'Opened during startup', active: true, pinned: false };
          fx.tabs.push(tab);
          (fx.listeners['tabs.onCreated'] || []).forEach(listener => listener(copy(tab)));
        }
        return snapshot;
      },
      async get(id) { return copy(fx.tabs.find((tab) => tab.id === id)); },
      async update(id, props) { return copy(Object.assign(fx.tabs.find((tab) => tab.id === id), props)); },
      async remove(ids) {
        for (const id of [ids].flat()) {
          fx.tabs = fx.tabs.filter((tab) => tab.id !== id);
          fire('tabs.onRemoved', id, { windowId: 7, isWindowClosing: false });
        }
      },
    },
    breezerPrivate: {
      async getAppearance() { return { layout: 'sidebar', sidebarMode: 'expanded', theme: 'mint', colorMode: 'light' }; },
      async setAppearance(patch) { return patch; },
      ...(withPeekApi ? { async setPeekSources(ids) { fx.peek.push(copy(ids)); } } : {}),
    },
  };
}

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      const content = await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

async function openSidebar(browser, base, withPeekApi = true) {
  const page = await browser.newPage({ viewport: { width: 260, height: 520 } });
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(installFixture, { seed: seed(), withPeekApi });
  await page.goto(`${base}/workspace.html#/sidebar?w=7`);
  await page.locator('#favorites .tile').first().waitFor();
  return { page, errors };
}

const lastPeek = (page) => page.evaluate(() => window.fx.peek.at(-1));
const peekCalls = (page) => page.evaluate(() => window.fx.peek.length);

test('only live favourite tabs in this window become peek sources, kept in sync', { skip }, async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const { page, errors } = await openSidebar(browser, base);
    // Favourites 8 and 9 are live. Pinned tab 1 and today tab 2 are not sources.
    await page.waitForFunction(() => window.fx.peek.length > 0);
    assert.deepEqual(await lastPeek(page), [8, 9]);

    // Browsing inside a favourite changes neither the set nor its saved identity.
    const calls = await peekCalls(page);
    await page.evaluate(() => {
      const tab = window.fx.tabs.find((item) => item.id === 8);
      Object.assign(tab, { url: 'https://calendar.example.com/event/42', title: 'Design review — Thursday' });
      window.fx.fire('tabs.onUpdated', 8, { url: tab.url, title: tab.title }, tab);
    });
    await page.waitForTimeout(150);
    assert.equal(await peekCalls(page), calls, 'an unchanged source set is not resent');
    const tiles = page.locator('#favorites .tile');
    assert.equal(await tiles.nth(0).getAttribute('title'), 'Calendar');
    assert.equal(await tiles.nth(0).getAttribute('aria-label'), 'Calendar');
    assert.equal(await tiles.nth(1).getAttribute('title'), 'Work mail', 'a renamed favourite keeps its custom title');
    assert.equal(await tiles.nth(2).getAttribute('aria-label'), 'Notes, asleep');

    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/workspace-peek-favourite-identity.png` });

    // Unfavouriting releases the tab: it is cleared on the native side.
    await page.evaluate(() => window.chrome.storage.local.get('workspace.v1').then((value) => {
      const store = value['workspace.v1'];
      store.favorites = store.favorites.filter((entry) => entry.id !== 'v-cal');
      store.rev += 1;
      return window.chrome.storage.local.set({ 'workspace.v1': store });
    }));
    await page.waitForFunction(() => JSON.stringify(window.fx.peek.at(-1)) === '[9]');

    // Closing the last live favourite empties the set.
    await page.evaluate(() => window.chrome.tabs.remove(9));
    await page.waitForFunction(() => JSON.stringify(window.fx.peek.at(-1)) === '[]');

    // A tab leaving the window forces a fresh reconcile even if the set looks the same.
    const before = await peekCalls(page);
    await page.evaluate(() => window.fx.fire('tabs.onDetached', 2, { oldWindowId: 7, oldPosition: 1 }));
    await page.waitForFunction((count) => window.fx.peek.length > count, before);
    assert.deepEqual(await lastPeek(page), []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test('builds without setPeekSources keep the sidebar working', { skip }, async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const { page, errors } = await openSidebar(browser, base, false);
    assert.equal(await page.locator('#favorites .tile').count(), 3);
    assert.equal(await page.locator('#favorites .tile.live').count(), 2);
    assert.deepEqual(await page.evaluate(() => window.fx.peek), []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});

test('failed tab icons show a fallback and recover when a valid icon arrives', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const { page, errors } = await openSidebar(browser, `http://127.0.0.1:${server.address().port}`);
    const publish = async value => page.evaluate(favIconUrl => {
      const tab = window.fx.tabs.find(item => item.id === 2);
      tab.favIconUrl = favIconUrl;
      window.fx.fire('tabs.onUpdated', 2, { favIconUrl }, tab);
    }, value);
    const icon = page.locator('[data-key="t:2"] .favicon');
    await publish('data:image/png;base64,invalid');
    await page.waitForFunction(() => {
      const icon = document.querySelector('[data-key="t:2"] .favicon');
      return icon?.textContent === 'G' && !icon.querySelector('img');
    }, null, { timeout: 3000 });
    await publish('data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"><rect width="16" height="16" fill="green"/></svg>'));
    await icon.locator('img').waitFor();
    assert.equal(await icon.evaluate(node => node.classList.contains('blank')), false);
    await page.waitForFunction(() => document.querySelector('[data-key="t:2"] .favicon img')?.naturalWidth > 0);
    await page.getByRole('button', { name: 'What’s new in Breezer' }).click();
    await page.waitForFunction(() => window.fx.tabs.some(tab => tab.url.endsWith('/whats-new.html')));
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(done => server.close(done)); }
});


test('a tab opened between the initial query and event subscription is shown', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage();
    await page.addInitScript(installFixture, { seed: { ...seed(), startupRace: true }, withPeekApi: true });
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    await page.locator('[data-key="t:12"].active').waitFor({ timeout: 3000 });
  } finally { await browser.close(); await new Promise(done => server.close(done)); }
});
