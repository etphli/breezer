import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drives the shipped workspace.html in a real browser against a deterministic
// chrome.* fixture (tabs, storage, breezerPrivate). Native hosting is separate.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

const icon = (letter, color) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-family="Helvetica" font-size="17" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`)}`;

function seed() {
  const work = 'space-work';
  const personal = 'space-personal';
  const tabs = [
    { id: 1, url: 'https://linear.app/breezer/inbox', title: 'Inbox · Linear', pinned: true, favIconUrl: icon('L', '#5e6ad2') },
    { id: 2, url: 'https://www.figma.com/file/sidebar', title: 'Sidebar explorations', pinned: true, favIconUrl: icon('F', '#a259ff') },
    { id: 3, url: 'https://github.com/etphli/breezer/pull/42', title: 'Arc-style sidebar · Pull request #42', active: true, favIconUrl: icon('G', '#24292f') },
    { id: 4, url: 'https://docs.breezer.dev/review', title: 'Arc review notes', favIconUrl: icon('D', '#2e9c7e') },
    { id: 5, url: 'https://mail.example.com/inbox', title: 'Mail — 3 unread', favIconUrl: icon('M', '#d93025') },
    { id: 6, url: 'https://recipes.example.com/miso', title: 'Miso glazed aubergine', favIconUrl: icon('R', '#e37400') },
    { id: 7, url: 'https://music.example.com/live', title: 'Late night radio', audible: true, favIconUrl: icon('♪', '#1db954') },
    { id: 8, url: 'https://calendar.example.com/week', title: 'Calendar', pinned: true, favIconUrl: icon('31', '#1a73e8') },
  ].map((tab, index) => ({ windowId: 7, index, active: false, pinned: false, status: 'complete', ...tab }));
  const store = {
    version: 1,
    rev: 1,
    spaces: [
      { id: work, name: 'Work', tone: 'mint', pinned: [
        { kind: 'folder', id: 'f-design', name: 'Design review', open: true, children: [
          { kind: 'entry', id: 'e-figma', url: 'https://www.figma.com/file/sidebar', title: 'Sidebar explorations' },
          { kind: 'entry', id: 'e-spec', url: 'https://docs.breezer.dev/spec', title: 'Sidebar spec' },
        ] },
        { kind: 'entry', id: 'e-linear', url: 'https://linear.app/breezer/inbox', title: 'Linear' },
      ] },
      { id: personal, name: 'Personal', tone: 'rose', pinned: [] },
    ],
    favorites: [
      { kind: 'entry', id: 'v-cal', url: 'https://calendar.example.com/week', title: 'Calendar' },
      { kind: 'entry', id: 'v-chat', url: 'https://chat.example.com/', title: 'Chat' },
      { kind: 'entry', id: 'v-notes', url: 'https://notes.example.com/', title: 'Notes' },
      { kind: 'entry', id: 'v-music', url: 'https://music.example.com/', title: 'Music' },
    ],
    prefs: { newTabPosition: 'bottom', closeButton: 'hover' },
  };
  const record = (s, u, e) => ({ s, u, k: 'S1', ...(e ? { e } : {}) });
  const members = { version: 1, session: 'S1', prev: '', tabs: {
    1: record(work, tabs[0].url, 'e-linear'), 2: record(work, tabs[1].url, 'e-figma'), 3: record(work, tabs[2].url),
    4: record(work, tabs[3].url), 5: record(work, tabs[4].url), 6: record(personal, tabs[5].url), 7: record(personal, tabs[6].url),
    8: record(work, tabs[7].url, 'v-cal'),
  } };
  return { tabs, local: { 'workspace.v1': store, 'workspace.members.v1': members }, session: { 'workspace.session': 'S1' } };
}

// Runs inside the page. Persists to localStorage/sessionStorage so reloads behave
// like a sidebar document reopening in the same (or a restarted) browser.
function installFixture({ seed, bridge, bridgeFails }) {
  const load = (store, key, fallback) => JSON.parse(store.getItem(key) || 'null') ?? fallback;
  const fx = {
    tabs: load(localStorage, 'fx-tabs', seed.tabs),
    local: load(localStorage, 'fx-local', seed.local),
    session: load(sessionStorage, 'fx-session', seed.session),
    appearance: load(localStorage, 'fx-appearance', { layout: 'sidebar', sidebarMode: 'expanded', theme: 'mint', colorMode: 'system', showBookmarks: true, sidebarWidth: 240, sidebarFontSize: 15, centeredAddressBar: true, minimalUrl: true, showLoadProgress: true, frameless: true, alwaysShowSidebar: false, alwaysShowTopBar: true }),
    calls: [],
    listeners: {},
  };
  window.fx = fx;
  const save = () => {
    localStorage.setItem('fx-tabs', JSON.stringify(fx.tabs));
    localStorage.setItem('fx-local', JSON.stringify(fx.local));
    sessionStorage.setItem('fx-session', JSON.stringify(fx.session));
    localStorage.setItem('fx-appearance', JSON.stringify(fx.appearance));
  };
  const event = (name) => ({ addListener: (fn) => (fx.listeners[name] ||= []).push(fn), removeListener() {} });
  const fire = (name, ...args) => setTimeout(() => (fx.listeners[name] || []).forEach((fn) => fn(...structuredClone(args))), 0);
  fx.fire = fire;
  const copy = (value) => structuredClone(value);
  const reindex = () => {
    fx.tabs.sort((a, b) => (b.pinned - a.pinned) || (a.index - b.index));
    fx.tabs.forEach((tab, index) => { tab.index = index; });
  };
  const find = (id) => {
    const tab = fx.tabs.find((item) => item.id === id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tab;
  };
  const setActive = (id) => {
    for (const tab of fx.tabs) tab.active = tab.id === id;
    fire('tabs.onActivated', { tabId: id, windowId: 7 });
  };
  let nextId = Math.max(0, ...fx.tabs.map((tab) => tab.id)) + 1;
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
      save();
      fire('storage.onChanged', changes, name);
    },
  });
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };
  window.chrome = {
    runtime: {
      getURL: (path) => `${location.origin}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ permissions: ['tabs', 'storage'] }),
      onMessage: event('runtime.onMessage'),
      lastError: undefined,
    },
    windows: {
      getCurrent: async () => ({ id: 7 }),
      update: async (id, props) => { fx.calls.push(['windows.update', id, props]); return { id }; },
    },
    storage: { local: area('local'), session: area('session'), onChanged: event('storage.onChanged') },
    tabs: {
      onCreated: event('tabs.onCreated'), onUpdated: event('tabs.onUpdated'), onRemoved: event('tabs.onRemoved'),
      onActivated: event('tabs.onActivated'), onMoved: event('tabs.onMoved'), onAttached: event('tabs.onAttached'),
      onDetached: event('tabs.onDetached'), onReplaced: event('tabs.onReplaced'),
      async query(filter = {}) {
        const snapshot = copy(fx.tabs.filter((tab) => (filter.active === undefined || tab.active === filter.active)));
        if (fx.holdQuery) {
          fx.holdQuery = false;
          await new Promise(resolve => { fx.releaseQuery = resolve; });
        }
        return snapshot;
      },
      async get(id) { return copy(find(id)); },
      async create({ url, active = true, pinned = false, index }) {
        fx.calls.push(['tabs.create', { url, active, pinned, index }]);
        const tab = { id: nextId++, windowId: 7, index: index ?? fx.tabs.length, url: url || 'chrome://newtab/', title: url ? hostOf(url) : 'New Tab', active: false, pinned, status: 'complete' };
        fx.tabs.forEach((item) => { if (item.index >= tab.index) item.index += 1; });
        fx.tabs.push(tab);
        reindex();
        save();
        fire('tabs.onCreated', tab);
        if (active) setActive(tab.id);
        return copy(tab);
      },
      async update(id, props) {
        fx.calls.push(['tabs.update', id, props]);
        const tab = find(id);
        const change = {};
        const from = tab.index;
        if (props.pinned !== undefined && props.pinned !== tab.pinned) { tab.pinned = props.pinned; change.pinned = props.pinned; reindex(); }
        if (tab.index !== from) fire('tabs.onMoved', id, { windowId: 7, fromIndex: from, toIndex: tab.index });
        if (props.muted !== undefined) { tab.mutedInfo = { muted: props.muted }; change.mutedInfo = tab.mutedInfo; }
        save();
        if (Object.keys(change).length) fire('tabs.onUpdated', id, change, tab);
        if (props.active) setActive(id);
        return copy(tab);
      },
      async remove(ids) {
        fx.calls.push(['tabs.remove', [ids].flat()]);
        for (const id of [ids].flat()) {
          const tab = find(id);
          fx.tabs.splice(fx.tabs.indexOf(tab), 1);
          reindex();
          fire('tabs.onRemoved', id, { windowId: 7, isWindowClosing: false });
          if (tab.active && fx.tabs.length) setActive((fx.tabs[tab.index] || fx.tabs[tab.index - 1]).id);
        }
        save();
      },
      async move(id, { index }) {
        fx.calls.push(['tabs.move', id, index]);
        const tab = find(id);
        const from = tab.index;
        fx.tabs.splice(fx.tabs.indexOf(tab), 1);
        fx.tabs.splice(index < 0 ? fx.tabs.length : index, 0, tab);
        fx.tabs.forEach((item, i) => { item.index = i; });
        save();
        fire('tabs.onMoved', id, { windowId: 7, fromIndex: from, toIndex: tab.index });
        return copy(tab);
      },
      async duplicate(id) { return this.create({ url: find(id).url }); },
    },
  };
  if (bridge) {
    const fields = {
      layout: (v) => ['sidebar', 'top'].includes(v), theme: (v) => ['mint', 'tide', 'dusk', 'rose', 'pollen', 'graphite'].includes(v),
      sidebarMode: (v) => ['expanded', 'compact', 'autoHide'].includes(v),
      bookmarkBarMode: (v) => ['newTab', 'always', 'hidden'].includes(v), colorMode: (v) => ['system', 'light', 'dark'].includes(v), showBookmarks: (v) => typeof v === 'boolean',
      sidebarWidth: (v) => Number.isInteger(v) && v >= 200 && v <= 360,
      sidebarFontSize: (v) => Number.isInteger(v) && v >= 12 && v <= 20,
      ...Object.fromEntries(['centeredAddressBar', 'minimalUrl', 'showLoadProgress', 'frameless', 'alwaysShowSidebar', 'alwaysShowTopBar'].map(key => [key, v => typeof v === 'boolean'])),
    };
    window.chrome.breezerPrivate = {
      async getAppearance() { return copy(fx.appearance); },
      async setAppearance(patch) {
        fx.calls.push(['setAppearance', patch]);
        if (bridgeFails) throw new Error('Rejected by the browser.');
        for (const [key, value] of Object.entries(patch)) if (!fields[key]?.(value)) throw new Error(`Invalid ${key}`);
        Object.assign(fx.appearance, patch);
        save();
        return copy(fx.appearance);
      },
      async setSidebarCollapsed(collapsed) { fx.calls.push(['setSidebarCollapsed', collapsed]); },
    };
  }
}

const WINDOW_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#ddf2eb;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#17302c}
  .frame{display:grid;grid-template-columns:240px 1fr 360px;grid-template-rows:40px 28px 1fr;height:100vh}
  .toolbar,.bookmarks{grid-column:1/3;display:flex;align-items:center;gap:14px;padding:0 14px}
  .lights{display:flex;gap:8px}.lights i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.lights i+i{background:#febc2e}.lights i+i+i{background:#28c840}
  .omni{flex:1;height:28px;border-radius:8px;background:#ffffffaa;display:flex;align-items:center;padding:0 12px;color:#4a605b}
  .bookmarks span{color:#4a605b;font-size:12px}
  iframe{border:0;width:240px;height:100%;grid-row:3}
  .page{grid-row:3;margin:0 6px 6px 0;border-radius:10px;background:#fff;box-shadow:0 0 0 .5px #17302c22,0 1px 3px #17302c18;padding:40px 56px}
  .page h1{font-size:26px;margin:0 0 6px}.page p{color:#4a605b;max-width:60ch;line-height:1.6}
  .ai{grid-row:1/4;grid-column:3;background:#f5f7f9;border-left:1px solid #17302c14;padding:24px;color:#738388}
  .bar{height:10px;border-radius:5px;background:#17302c10;margin:14px 0}
</style></head><body><div class="frame">
  <div class="toolbar"><div class="lights"><i></i><i></i><i></i></div><div class="omni">github.com/etphli/breezer/pull/42</div></div>
  <div class="bookmarks"><span>Docs</span><span>Linear</span><span>Figma</span><span>Reading</span><span>Tools</span></div>
  <iframe src="/workspace.html#/sidebar?w=7" title="Breezer sidebar"></iframe>
  <div class="page"><h1>Arc-style sidebar</h1><p>Pull request #42 · Replaces the native vertical tab strip with Breezer's own sidebar. Favorites, pinned folders, spaces and today tabs.</p><div class="bar" style="width:70%"></div><div class="bar" style="width:84%"></div><div class="bar" style="width:52%"></div></div>
  <div class="ai"><strong style="color:#182c31">Breezer AI</strong><div class="bar"></div><div class="bar" style="width:60%"></div></div>
</div></body></html>`;

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/__window.html') { response.setHeader('Content-Type', 'text/html'); response.end(WINDOW_HTML); return; }
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      const content = await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

test('empty Settings-created spaces and sidebar controls respond to held clicks', { skip }, async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const initial = seed();
    initial.tabs = initial.tabs.filter(tab => [3, 4, 5].includes(tab.id)).map((tab, index) => ({ ...tab, index }));
    initial.local['workspace.v1'].favorites = [];
    initial.local['workspace.v1'].spaces.forEach(space => { space.pinned = []; });
    initial.local['workspace.v1'].spaces.push({ id: 'space-research', name: 'Research', tone: 'tide', pinned: [] });
    initial.local['workspace.members.v1'].tabs = Object.fromEntries(Object.entries(initial.local['workspace.members.v1'].tabs).filter(([id]) => initial.tabs.some(tab => tab.id === Number(id))));
    const context = await browser.newContext({ viewport: { width: 300, height: 820 } });
    await context.addInitScript(installFixture, { seed: initial, bridge: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/workspace.html#/sidebar?w=7`);
    await page.locator('#today [data-key="t:3"]').waitFor();
    assert.equal(await page.locator('#spaces [role="tab"]').count(), 3);
    for (const [id, name] of [['space-personal', 'Personal'], ['space-research', 'Research'], ['space-work', 'Work']]) {
      await page.locator(`#spaces [data-key="s:${id}"]`).click({ delay: 120 });
      await page.waitForFunction(({ id, name }) => document.querySelector('#space-name').textContent === name && document.querySelector(`#spaces [data-key="s:${id}"]`).getAttribute('aria-selected') === 'true', { id, name });
      await page.waitForFunction(id => window.fx.session['workspace.window.7']?.activeSpaceId === id, id);
      await page.waitForFunction(() => document.querySelector('#today .row.active'));
    }
    assert.equal((await page.evaluate(() => window.fx.calls)).filter(([name]) => name === 'tabs.create').length, 2, 'Each empty space gets one real tab');
    await page.locator('#today [data-key="t:4"]').click({ delay: 120 });
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.id === 4);
    await page.locator('#today [data-key="t:4"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
    await page.locator('#pinned [data-key^="e:"]').waitFor();
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.id === 4)?.pinned);
    await page.getByRole('button', { name: 'Keep sidebar visible' }).click({ delay: 120 });
    await page.waitForFunction(() => window.fx.appearance.alwaysShowSidebar === true);
    assert.equal(await page.locator('#collapse').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.fx.appearance.sidebarMode), 'expanded', 'Pinning does not compact the sidebar');
    await page.reload();
    await page.getByRole('button', { name: 'Auto-hide sidebar' }).waitFor();
    assert.equal(await page.evaluate(() => window.fx.appearance.alwaysShowSidebar), true, 'Pin preference survives reload');
    await page.getByRole('button', { name: 'Auto-hide sidebar' }).click({ delay: 120 });
    await page.waitForFunction(() => window.fx.appearance.alwaysShowSidebar === false);
    assert.equal(await page.locator('#collapse').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.fx.appearance.sidebarMode), 'expanded', 'Unpinning preserves the chosen sidebar mode');
    await page.getByRole('button', { name: 'New space', exact: true }).click({ delay: 120 });
    await page.waitForFunction(() => window.fx.local['workspace.v1'].spaces.length === 4);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Settings', exact: true }).click({ delay: 120 });
    await page.waitForFunction(() => window.fx.calls.some(([name, props]) => name === 'tabs.create' && props.url?.endsWith('/workspace.html#/settings')));
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(done => server.close(done));
  }
});

test('dragging with no Favorites preserves tab geometry and supports reorder and Favorites drops', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const initial = seed();
    initial.tabs = initial.tabs.filter(tab => [3, 4, 5].includes(tab.id)).map((tab, index) => ({ ...tab, index }));
    initial.local['workspace.v1'].favorites = [];
    initial.local['workspace.v1'].spaces.forEach(space => { space.pinned = []; });
    const context = await browser.newContext({ viewport: { width: 300, height: 820 } });
    await context.addInitScript(installFixture, { seed: initial, bridge: true });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    const row = id => page.locator(`#today [data-key="t:${id}"]`);
    await row(4).waitFor();
    const source = await row(4).boundingBox();
    const target = await row(3).boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 - 6);
    await page.locator('#sidebar.dragging').waitFor();
    assert.deepEqual(await row(3).boundingBox(), target, 'Starting a drag must keep the intended drop row under the pointer');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/workspace-empty-favorites-drag.png` });
    await page.mouse.move(target.x + target.width / 2, target.y + 3, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => window.fx.calls.some(([name, id]) => name === 'tabs.move' && id === 4));
    await page.waitForFunction(() => document.querySelector('#today .row')?.dataset.key === 't:4');
    assert.equal(await page.evaluate(() => window.fx.tabs.find(tab => tab.id === 4).pinned), false, 'Reordering must not pin the tab');
    await page.locator('#favorites').waitFor({ state: 'hidden' });

    // The floating empty Favorites target remains usable without moving tabs.
    const favoriteSource = await row(5).boundingBox();
    await page.mouse.move(favoriteSource.x + favoriteSource.width / 2, favoriteSource.y + favoriteSource.height / 2);
    await page.mouse.down();
    await page.mouse.move(favoriteSource.x + favoriteSource.width / 2, favoriteSource.y + favoriteSource.height / 2 - 6);
    await page.locator('#sidebar.dragging').waitFor();
    const favoriteTarget = await page.locator('#favorites').boundingBox();
    await page.mouse.move(favoriteTarget.x + favoriteTarget.width / 2, favoriteTarget.y + favoriteTarget.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => window.fx.local['workspace.v1'].favorites.some(entry => entry.url === 'https://mail.example.com/inbox'));
    await page.locator('#favorites .tile').waitFor();
    assert.equal(await page.evaluate(() => window.fx.tabs.find(tab => tab.id === 5).pinned), true);
  } finally {
    await browser.close();
    await new Promise(done => server.close(done));
  }
});

test('delayed tab queries cannot revive closed rows or overwrite navigation and activation', { skip }, async () => {
  const server = await startServer();
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 300, height: 820 } });
    await context.addInitScript(installFixture, { seed: seed(), bridge: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    await page.locator('#today [data-key="t:3"]').waitFor();
    // Capture a query before Chromium closes a tab, but deliver it after the
    // removal event and the subsequent fresh query have already been handled.
    await page.evaluate(() => {
      window.fx.holdQuery = true;
      window.fx.fire('tabs.onMoved', 3, { windowId: 7 });
    });
    await page.waitForFunction(() => typeof window.fx.releaseQuery === 'function');
    await page.evaluate(() => chrome.tabs.remove(3));
    await page.waitForFunction(() => !document.querySelector('#today [data-key="t:3"]:not(.leaving)'));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.fx.releaseQuery());
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#today [data-key="t:3"]').count(), 0, 'a closed tab must not return as an unresponsive ghost row');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: `${evidence}/workspace-tab-query-race.png` });

    await page.evaluate(() => {
      window.fx.releaseQuery = null;
      window.fx.holdQuery = true;
      window.fx.fire('tabs.onMoved', 4, { windowId: 7 });
    });
    await page.waitForFunction(() => typeof window.fx.releaseQuery === 'function');
    await page.evaluate(() => {
      const tab = window.fx.tabs.find(tab => tab.id === 4);
      tab.title = 'Updated page';
      window.fx.fire('tabs.onUpdated', 4, { title: tab.title }, tab);
    });
    await page.locator('#today [data-key="t:4"]').click();
    await page.waitForFunction(() => document.querySelector('#today [data-key="t:4"]').classList.contains('active'));
    await page.evaluate(() => window.fx.releaseQuery());
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#today [data-key="t:4"] .title').innerText(), 'Updated page');
    assert.equal(await page.locator('#today [data-key="t:4"]').getAttribute('aria-selected'), 'true');
    await page.locator('#today [data-key="t:4"] .row-action').click();
    await page.waitForFunction(() => !window.fx.tabs.some(tab => tab.id === 4));
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await page.getByRole('treeitem', { name: 'New Tab', exact: true }).waitFor();
    // A query must also converge after an activation event when it contains a
    // tab whose creation happened before this document subscribed to events.
    await page.evaluate(() => {
      window.fx.tabs.push({ id: 100, windowId: 7, index: 100, url: 'about:blank', title: 'Newly discovered tab', active: false, pinned: false });
      window.fx.releaseQuery = null;
      window.fx.holdQuery = true;
      window.fx.fire('tabs.onMoved', 100, { windowId: 7 });
    });
    await page.waitForFunction(() => typeof window.fx.releaseQuery === 'function');
    await page.evaluate(() => chrome.tabs.update(100, { active: true }));
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.id === 100).active);
    await page.waitForTimeout(50);
    await page.evaluate(() => window.fx.releaseQuery());
    await page.locator('#today [data-key="t:100"].active').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    await new Promise(done => server.close(done));
  }
});

test('Arc-style sidebar and settings work against the chrome.* fixture', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const errors = [];
  const newPage = async (options, viewport = { width: 240, height: 820 }) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addInitScript(installFixture, { seed: seed(), ...options });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(`${message.text()} ${message.location().url}`); });
    return page;
  };
  const calls = (page) => page.evaluate(() => window.fx.calls);
  try {
    // ---------------------------------------------------------- sidebar
    const page = await newPage({ bridge: true });
    await page.goto(`${base}/workspace.html#/sidebar?w=7`);
    const tree = page.locator('#today');
    await page.getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    assert.equal(await page.locator('#space-name').innerText(), 'Work');
    assert.equal(await page.locator('#favorites .tile').count(), 4);
    assert.equal(await page.locator('#favorites .tile.live').count(), 1, 'calendar favorite is bound to its live tab');
    assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), ['Arc-style sidebar · Pull request #42', 'Arc review notes', 'Mail — 3 unread']);
    assert.equal(await page.getByRole('treeitem', { name: /Pull request #42/ }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('treeitem', { name: 'Sidebar spec, asleep' }).count(), 1, 'unbound pinned entry is asleep');
    assert.equal(await page.locator('#collapse').isVisible(), true);
    await page.screenshot({ path: `${evidence}/workspace-sidebar.png` });

    // New tab joins the active space.
    await page.getByRole('button', { name: 'New tab' }).click();
    await tree.getByRole('treeitem', { name: /New Tab/ }).waitFor();
    assert.equal(await tree.getByRole('treeitem').count(), 4);

    // Close via the row button; the space keeps a tab and Chromium closes the right one.
    await tree.getByRole('treeitem', { name: /Mail/ }).hover();
    await tree.getByRole('treeitem', { name: /Mail/ }).getByRole('button', { name: 'Close tab' }).click();
    await page.waitForFunction(() => !document.querySelector('#today').textContent.includes('Mail'));
    assert.deepEqual((await calls(page)).filter(([name]) => name === 'tabs.remove').at(-1), ['tabs.remove', [5]]);

    // Pin from the context menu, then it shows in the pinned tree.
    await tree.getByRole('treeitem', { name: /Arc review notes/ }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin tab' }).click();
    await page.locator('#pinned').getByRole('treeitem', { name: 'Arc review notes' }).waitFor();
    assert.equal(await tree.getByRole('treeitem', { name: /Arc review notes/ }).count(), 0);
    assert.ok((await calls(page)).some(([name, id, props]) => name === 'tabs.update' && id === 4 && props.pinned === true));

    // Keyboard: focus, move, reorder with ⌥↓, rename with F2, close folder with ←.
    await tree.getByRole('treeitem', { name: /Pull request/ }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForFunction(() => window.fx.calls.some(([name]) => name === 'tabs.move'));
    await page.waitForFunction(() => document.querySelector('#today').textContent.startsWith('New Tab'));
    assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), ['New Tab', 'Arc-style sidebar · Pull request #42']);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 't:3', 'focus follows the moved row');
    const folder = page.getByRole('treeitem', { name: /Design review, folder/ });
    await folder.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('[data-key="f:f-design"]').getAttribute('aria-expanded') === 'false');
    await page.keyboard.press('F2');
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Reviews');
    await page.keyboard.press('Enter');
    await page.getByRole('treeitem', { name: /^Reviews, folder/ }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'f:f-design', 'focus returns to the folder');

    // Spaces: switching shows Personal's tabs and activates one of them.
    await page.getByRole('tab', { name: /Personal/ }).click();
    await page.waitForFunction(() => document.querySelector('#space-name').textContent === 'Personal');
    assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), ['Miso glazed aubergine', 'Late night radio']);
    assert.equal(await page.locator('#sidebar').getAttribute('data-tone'), 'rose');
    await page.waitForFunction(() => window.fx.tabs.find((tab) => tab.active)?.id === 6);
    assert.equal(await tree.getByRole('button', { name: 'Mute tab' }).count(), 1, 'audible tab shows a mute control');
    await page.screenshot({ path: `${evidence}/workspace-sidebar-personal.png` });

    // Browser restart: storage.session is gone and every tab gets a new id.
    await page.evaluate(() => {
      const tabs = JSON.parse(localStorage.getItem('fx-tabs')).map((tab) => ({ ...tab, id: tab.id + 100 }));
      localStorage.setItem('fx-tabs', JSON.stringify(tabs));
      sessionStorage.setItem('fx-session', '{}');
    });
    await page.reload();
    await tree.getByRole('treeitem', { name: /Miso glazed aubergine/ }).waitFor();
    assert.equal(await page.locator('#space-name').innerText(), 'Personal', 'reopens in the active tab’s space');
    assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), ['Miso glazed aubergine', 'Late night radio']);
    await page.getByRole('tab', { name: /Work/ }).click();
    await tree.getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    assert.equal(await page.locator('#pinned').getByRole('treeitem', { name: 'Linear' }).count(), 1, 'pinned binding survives (live, not asleep)');
    assert.equal(await page.locator('#pinned').getByRole('treeitem', { name: 'Arc review notes' }).count(), 1, 'pin made this session survives');
    assert.equal(await tree.getByRole('treeitem', { name: /Miso/ }).count(), 0, 'Personal tabs stay out of Work');

    // Pinning calls the native bridge without changing the compact preference.
    await page.getByRole('button', { name: 'Keep sidebar visible' }).click();
    await page.waitForFunction(() => window.fx.calls.some(([name, patch]) => name === 'setAppearance' && patch.alwaysShowSidebar === true));

    // Dark scheme.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.scheme === 'dark');
    await page.waitForTimeout(400); // let the space-switch animation finish before capturing
    await page.screenshot({ path: `${evidence}/workspace-sidebar-dark.png` });

    // ---------------------------------------------------------- settings
    const settings = await newPage({ bridge: true }, { width: 1000, height: 1400 });
    await settings.goto(`${base}/workspace.html#/settings`);
    await settings.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    assert.equal(await settings.getByRole('radio', { name: 'Mint' }).getAttribute('aria-checked'), 'true');
    assert.equal(await settings.getByRole('radio', { name: 'Sidebar' }).getAttribute('aria-checked'), 'true');
    assert.equal(await settings.locator('[data-field="bookmarkBarMode"] [data-value="newTab"]').getAttribute('aria-checked'), 'true');
    assert.equal(await settings.locator('#sidebar-width').inputValue(), '240');
    assert.equal(await settings.title(), 'Settings');
    assert.equal(await settings.getByRole('slider', { name: 'Sidebar font size' }).inputValue(), '15');
    for (const value of [12, 20, 15]) {
      await settings.getByRole('slider', { name: 'Sidebar font size' }).fill(String(value));
      await settings.waitForFunction(v => window.fx.appearance.sidebarFontSize === v, value);
      assert.equal(await settings.locator('#sidebar-font-size-value').innerText(), `${value} px`);
    }
    for (const [id, initial] of [['centered-address-bar', true], ['minimal-url', true], ['show-load-progress', true], ['frameless', true], ['always-show-sidebar', false], ['always-show-top-bar', true]]) {
      const control = settings.locator(`#${id}`);
      assert.equal(await control.getAttribute('aria-checked'), String(initial));
      await control.click();
      await settings.waitForFunction(({ id, value }) => document.getElementById(id).getAttribute('aria-checked') === String(value), { id, value: !initial });
      await control.click();
      await settings.waitForFunction(({ id, value }) => document.getElementById(id).getAttribute('aria-checked') === String(value), { id, value: initial });
    }
    await settings.getByRole('button', { name: 'Privacy and security', exact: true }).click();
    await settings.waitForFunction(() => window.fx.calls.some(([name, args]) => name === 'tabs.create' && args.url === 'chrome://settings/privacy'));
    await settings.getByRole('button', { name: 'All native browser settings', exact: true }).click();
    await settings.waitForFunction(() => window.fx.calls.some(([name, args]) => name === 'tabs.create' && args.url === 'chrome://settings/'));
    for (const [label, mode] of [['Compact', 'compact'], ['Auto-hide', 'autoHide'], ['Expanded', 'expanded']]) {
      await settings.getByRole('radio', { name: label, exact: true }).click();
      await settings.waitForFunction(value => window.fx.appearance.sidebarMode === value, mode);
      assert.equal(await settings.getByRole('radio', { name: label, exact: true }).getAttribute('aria-checked'), 'true');
    }
    await settings.getByRole('radio', { name: 'Dusk' }).click();
    await settings.waitForFunction(() => document.documentElement.dataset.tone === 'dusk');
    assert.deepEqual((await calls(settings)).at(-1), ['setAppearance', { theme: 'dusk' }]);
    await settings.getByRole('radio', { name: 'Dusk' }).focus();
    await settings.keyboard.press('ArrowRight');
    await settings.waitForFunction(() => document.documentElement.dataset.tone === 'rose');
    await settings.locator('[data-field="bookmarkBarMode"] [data-value="hidden"]').click();
    await settings.waitForFunction(() => window.fx.appearance.bookmarkBarMode === 'hidden');
    await settings.getByRole('radio', { name: 'At top' }).click();
    await settings.waitForFunction(() => window.fx.local['workspace.v1'].prefs.newTabPosition === 'top');
    await settings.getByRole('textbox', { name: 'Name of space 2' }).fill('Home');
    await settings.keyboard.press('Enter');
    await settings.waitForFunction(() => window.fx.local['workspace.v1'].spaces[1].name === 'Home');
    await settings.getByRole('button', { name: 'Add space' }).click();
    await settings.waitForFunction(() => window.fx.local['workspace.v1'].spaces.length === 3);
    await settings.getByRole('radio', { name: 'Mint' }).click();
    await settings.waitForFunction(() => document.documentElement.dataset.tone === 'mint');
    await settings.getByRole('slider', { name: 'Sidebar font size' }).fill('18');
    await settings.waitForFunction(() => window.fx.appearance.sidebarFontSize === 18);
    await settings.locator('#centered-address-bar').click();
    await settings.waitForFunction(() => window.fx.appearance.centeredAddressBar === false);
    await settings.reload();
    await settings.getByRole('slider', { name: 'Sidebar font size' }).waitFor();
    assert.equal(await settings.getByRole('slider', { name: 'Sidebar font size' }).inputValue(), '18');
    assert.equal(await settings.locator('#centered-address-bar').getAttribute('aria-checked'), 'false');
    assert.equal(await settings.locator('#frameless').getAttribute('aria-checked'), 'true');
    await settings.getByRole('slider', { name: 'Sidebar font size' }).fill('15');
    await settings.waitForFunction(() => window.fx.appearance.sidebarFontSize === 15);
    await settings.locator('#centered-address-bar').click();
    await settings.waitForFunction(() => window.fx.appearance.centeredAddressBar === true);
    await settings.screenshot({ path: `${evidence}/workspace-settings.png`, fullPage: true });
    await settings.emulateMedia({ colorScheme: 'dark' });
    await settings.screenshot({ path: `${evidence}/workspace-settings-dark.png`, fullPage: true });

    // A rejected change is reported and the control keeps the browser's value.
    const failing = await newPage({ bridge: true, bridgeFails: true }, { width: 900, height: 900 });
    await failing.goto(`${base}/workspace.html#/settings`);
    await failing.getByRole('radio', { name: 'Tide' }).click();
    await failing.getByText(/Couldn’t change the theme\. Rejected by the browser\./).waitFor();
    assert.equal(await failing.getByRole('radio', { name: 'Mint' }).getAttribute('aria-checked'), 'true');
    assert.equal(await failing.evaluate(() => document.documentElement.dataset.tone), 'mint');
    await failing.getByRole('slider', { name: 'Sidebar font size' }).fill('18');
    await failing.locator('#typography-error').getByText(/Rejected by the browser/).waitFor();
    assert.equal(await failing.getByRole('slider', { name: 'Sidebar font size' }).inputValue(), '15');
    await failing.locator('#frameless').click();
    await failing.locator('#layout-error').getByText(/Rejected by the browser/).waitFor();
    assert.equal(await failing.locator('#frameless').getAttribute('aria-checked'), 'true');

    // Without the native bridge nothing pretends to apply.
    const missing = await newPage({ bridge: false }, { width: 900, height: 900 });
    await missing.goto(`${base}/workspace.html#/settings`);
    await missing.getByText(/this build doesn’t include/).waitFor();
    assert.equal(await missing.getByRole('radio', { name: 'Top', exact: true }).getAttribute('aria-disabled'), 'true');
    assert.equal(await missing.locator('#sidebar-width').isDisabled(), true);
    assert.equal(await missing.locator('#sidebar-font-size').isDisabled(), true);
    assert.equal(await missing.locator('#frameless').getAttribute('aria-disabled'), 'true');
    await missing.getByRole('radio', { name: 'Dusk' }).click({ force: true });
    assert.equal(await missing.evaluate(() => document.documentElement.dataset.tone), 'mint');
    assert.equal(await missing.getByRole('radio', { name: 'At bottom' }).getAttribute('aria-disabled'), null, 'store-backed tab settings still work');

    const sidebarWithoutBridge = await newPage({ bridge: false });
    await sidebarWithoutBridge.goto(`${base}/workspace.html#/sidebar?w=7`);
    await sidebarWithoutBridge.getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    assert.equal(await sidebarWithoutBridge.locator('#collapse').isVisible(), false, 'no collapse button without native support');

    // Whole-window composition for review.
    const windowPage = await newPage({ bridge: true }, { width: 1280, height: 800 });
    await windowPage.goto(`${base}/__window.html`);
    await windowPage.frameLocator('iframe').getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    await windowPage.screenshot({ path: `${evidence}/workspace-window.png` });

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
