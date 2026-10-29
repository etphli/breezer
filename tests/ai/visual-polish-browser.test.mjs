import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Geometry and screenshot checks for the favourites tile grid in the sidebar
// and the one-row site shortcuts on the new tab. Drives the shipped HTML/CSS/JS
// in headless Chrome against small chrome.* fixtures; all data is test data.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

const svg = (letter, color) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-family="Helvetica" font-size="17" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`;
const icon = (letter, color) => `data:image/svg+xml,${encodeURIComponent(svg(letter, color))}`;
const COLORS = ['#1a73e8', '#c2410c', '#0f766e', '#7c3aed', '#be123c', '#15803d', '#b45309', '#334155', '#0e7490'];

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/_favicon/') {
        const host = new URL(url.searchParams.get('pageUrl')).hostname;
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(svg(host[0].toUpperCase(), COLORS[[...host].reduce((sum, c) => sum + c.charCodeAt(0), 0) % COLORS.length]));
        return;
      }
      const path = resolve(root, `.${url.pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      const content = await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

// Intervals between neighbouring centres, rounded to 0.5 px.
const intervals = (centres) => centres.slice(1).map((c, i) => Math.round((c - centres[i]) * 2) / 2);
const spread = (values) => Math.max(...values) - Math.min(...values);

// ------------------------------------------------------------------ sidebar

function seed(favoriteCount) {
  const work = 'space-work';
  const tabs = [
    { id: 1, url: 'https://calendar.example.com/week', title: 'Calendar', active: true, favIconUrl: icon('31', '#1a73e8') },
    { id: 2, url: 'https://chat.example.com/', title: 'Chat', favIconUrl: icon('C', '#7c3aed') },
    { id: 3, url: 'https://github.com/etphli/breezer/pull/42', title: 'Arc-style sidebar · Pull request #42', favIconUrl: icon('G', '#24292f') },
    { id: 4, url: 'https://docs.breezer.dev/review', title: 'Arc review notes', favIconUrl: icon('D', '#2e9c7e') },
  ].map((tab, index) => ({ windowId: 7, index, active: false, pinned: false, status: 'complete', ...tab }));
  const favorites = [
    { id: 'v-cal', url: 'https://calendar.example.com/week', title: 'Calendar' },
    { id: 'v-chat', url: 'https://chat.example.com/', title: 'Chat' },
    { id: 'v-notes', url: 'https://notes.example.com/', title: 'Notes' },
    { id: 'v-music', url: 'https://music.example.com/', title: 'Music' },
    { id: 'v-mail', url: 'https://mail.example.com/', title: 'Mail' },
    { id: 'v-maps', url: 'https://maps.example.com/', title: 'Maps' },
  ].slice(0, favoriteCount).map((entry) => ({ kind: 'entry', ...entry }));
  const store = {
    version: 1,
    rev: 1,
    spaces: [{ id: work, name: 'Home', tone: 'mint', pinned: [{ kind: 'entry', id: 'e-docs', url: 'https://docs.breezer.dev/review', title: 'Arc review notes' }] }],
    favorites,
    prefs: { newTabPosition: 'bottom', closeButton: 'hover' },
  };
  const record = (u, e) => ({ s: work, u, k: 'S1', ...(e ? { e } : {}) });
  const members = { version: 1, session: 'S1', prev: '', tabs: {
    1: record(tabs[0].url, favoriteCount ? 'v-cal' : undefined), 2: record(tabs[1].url, favoriteCount > 1 ? 'v-chat' : undefined),
    3: record(tabs[2].url), 4: record(tabs[3].url, 'e-docs'),
  } };
  return { tabs, local: { 'workspace.v1': store, 'workspace.members.v1': members }, session: { 'workspace.session': 'S1' } };
}

// Runs in the page: just enough of chrome.* for the sidebar to draw, open,
// remove and undo favourites.
function installSidebarFixture({ seed, appearance }) {
  const fx = { tabs: seed.tabs, local: seed.local, session: seed.session, appearance, calls: [], listeners: {} };
  window.fx = fx;
  const copy = (value) => structuredClone(value);
  const event = (name) => ({ addListener: (fn) => (fx.listeners[name] ||= []).push(fn), removeListener() {} });
  const fire = (name, ...args) => setTimeout(() => (fx.listeners[name] || []).forEach((fn) => fn(...copy(args))), 0);
  const find = (id) => fx.tabs.find((tab) => tab.id === id) || (() => { throw new Error(`No tab with id: ${id}.`); })();
  const setActive = (id) => { for (const tab of fx.tabs) tab.active = tab.id === id; fire('tabs.onActivated', { tabId: id, windowId: 7 }); };
  let nextId = 100;
  const area = (name) => ({
    async get(keys) {
      const list = keys == null ? Object.keys(fx[name]) : [keys].flat();
      return copy(Object.fromEntries(list.filter((key) => key in fx[name]).map((key) => [key, fx[name][key]])));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: fx[name][key], newValue: copy(value) }; fx[name][key] = copy(value); }
      fire('storage.onChanged', changes, name);
    },
  });
  window.chrome = {
    runtime: { getURL: (path) => `${location.origin}/${String(path).replace(/^\//, '')}`, getManifest: () => ({ permissions: ['tabs', 'storage'] }), onMessage: event('runtime.onMessage'), lastError: undefined },
    windows: { getCurrent: async () => ({ id: 7 }), update: async (id) => ({ id }) },
    storage: { local: area('local'), session: area('session'), onChanged: event('storage.onChanged') },
    tabs: {
      ...Object.fromEntries(['onCreated', 'onUpdated', 'onRemoved', 'onActivated', 'onMoved', 'onAttached', 'onDetached', 'onReplaced'].map((name) => [name, event(`tabs.${name}`)])),
      async query(filter = {}) { return copy(fx.tabs.filter((tab) => filter.active === undefined || tab.active === filter.active)); },
      async get(id) { return copy(find(id)); },
      async create({ url, active = true, pinned = false }) {
        fx.calls.push(['tabs.create', url]);
        const tab = { id: nextId++, windowId: 7, index: fx.tabs.length, url, title: new URL(url).hostname, active: false, pinned, status: 'complete' };
        fx.tabs.push(tab);
        fire('tabs.onCreated', tab);
        if (active) setActive(tab.id);
        return copy(tab);
      },
      async update(id, props) { fx.calls.push(['tabs.update', id, props]); if (props.active) setActive(id); return copy(find(id)); },
      async remove(ids) {
        for (const id of [ids].flat()) { fx.tabs.splice(fx.tabs.indexOf(find(id)), 1); fire('tabs.onRemoved', id, { windowId: 7, isWindowClosing: false }); }
      },
      async move(id) { return copy(find(id)); },
    },
    breezerPrivate: {
      async getAppearance() { return copy(fx.appearance); },
      async setAppearance(patch) { Object.assign(fx.appearance, patch); return copy(fx.appearance); },
      async setSidebarCollapsed() {},
    },
  };
}

const APPEARANCE = { layout: 'sidebar', sidebarMode: 'expanded', theme: 'mint', colorMode: 'light', showBookmarks: true, sidebarWidth: 240, sidebarFontSize: 15, centeredAddressBar: true, minimalUrl: true, showLoadProgress: true, frameless: true, alwaysShowSidebar: false, alwaysShowTopBar: true };

async function withSidebar(browser, base, { width, favorites = 4, appearance = {}, reducedMotion = 'no-preference' }, fn) {
  const context = await browser.newContext({ viewport: { width, height: 560 }, deviceScaleFactor: 2, reducedMotion, locale: 'en-US' });
  await context.addInitScript(installSidebarFixture, { seed: seed(favorites), appearance: { ...APPEARANCE, ...appearance } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/workspace.html#/sidebar?w=7`);
    await page.locator('#sidebar:not([hidden])').waitFor();
    if (favorites) await page.waitForFunction((count) => document.querySelectorAll('#favorites .tile').length === count, favorites);
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

// Tile boxes, favicon centres and overflow inside the favourites grid.
const tileGeometry = (page) => page.evaluate(() => {
  const grid = document.getElementById('favorites').getBoundingClientRect();
  const tiles = [...document.querySelectorAll('#favorites .tile')].map((tile) => {
    const box = tile.getBoundingClientRect();
    const glyph = tile.querySelector('.favicon').getBoundingClientRect();
    return { left: box.left, right: box.right, top: box.top, width: box.width, height: box.height, cx: box.left + box.width / 2, cy: box.top + box.height / 2, gx: glyph.left + glyph.width / 2, gy: glyph.top + glyph.height / 2, glyph: glyph.width };
  });
  return { grid: { left: grid.left, right: grid.right }, tiles, scroll: document.documentElement.scrollWidth, view: innerWidth };
});

function assertTileGrid(geometry, label) {
  const { tiles, grid } = geometry;
  assert.ok(tiles.length > 0, label);
  assert.ok(spread(tiles.map((t) => t.width)) < 0.5, `${label}: equal tile widths ${tiles.map((t) => t.width)}`);
  assert.ok(spread(tiles.map((t) => t.height)) < 0.5, `${label}: equal tile heights`);
  for (const tile of tiles) {
    assert.ok(tile.left >= grid.left - 0.5 && tile.right <= grid.right + 0.5, `${label}: tile inside the grid`);
    assert.ok(Math.abs(tile.gx - tile.cx) < 0.75 && Math.abs(tile.gy - tile.cy) < 0.75, `${label}: favicon centred in its tile`);
  }
  const rows = new Map();
  for (const tile of tiles) rows.set(Math.round(tile.top), [...(rows.get(Math.round(tile.top)) || []), tile.cx]);
  for (const centres of rows.values()) if (centres.length > 1) assert.ok(spread(intervals(centres)) <= 0.5, `${label}: even icon-centre intervals ${intervals(centres)}`);
  assert.ok(geometry.scroll <= geometry.view, `${label}: no horizontal overflow`);
}

test('favourite tiles stay even, centred and usable across sidebar widths and themes', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const cases = [
      { name: '240-light', width: 240 },
      { name: '300-light', width: 300 },
      { name: '300-dark-tide-one', width: 300, favorites: 1, appearance: { theme: 'tide', colorMode: 'dark' } },
      { name: '240-dark-rose-six', width: 240, favorites: 6, appearance: { theme: 'rose', colorMode: 'dark' } },
      { name: '300-custom', width: 300, appearance: { theme: '#d0543c' } },
      { name: '300-custom-dark', width: 300, appearance: { theme: '#d0543c', colorMode: 'dark' } },
      { name: 'compact-rail', width: 120, appearance: { sidebarMode: 'compact' } },
      { name: '360-large-font', width: 360, appearance: { sidebarFontSize: 20 } },
    ];
    for (const item of cases) {
      await withSidebar(browser, base, item, async (page) => {
        const geometry = await tileGeometry(page);
        assertTileGrid(geometry, item.name);
        if (item.name === 'compact-rail') {
          assert.equal(new Set(geometry.tiles.map((t) => Math.round(t.cx))).size, 1, 'compact rail stacks tiles in one column');
        } else {
          assert.equal(new Set(geometry.tiles.slice(0, 4).map((t) => Math.round(t.top))).size, 1, 'four tiles per row (arrow up/down move by four)');
        }
        await page.screenshot({ path: `${evidence}/favorites-${item.name}.png`, clip: { x: 0, y: 0, width: item.width, height: 240 } });
      });
    }

    // States: active, live, asleep, hover and keyboard focus read distinctly.
    await withSidebar(browser, base, { width: 300, reducedMotion: 'reduce' }, async (page) => {
      const fill = (selector) => page.$eval(selector, (node) => getComputedStyle(node).backgroundColor);
      const active = await fill('#favorites .tile.active');
      const live = await fill('#favorites .tile.live:not(.active)');
      const asleep = await fill('#favorites .tile:not(.live)');
      assert.equal(new Set([active, live, asleep]).size, 3, `active/live/asleep fills differ: ${[active, live, asleep]}`);
      await page.hover('#favorites .tile:not(.live)');
      assert.notEqual(await fill('#favorites .tile:not(.live):hover'), asleep, 'hover changes the asleep tile');
      assert.equal(await page.$eval('#favorites .tile:not(.live)', (node) => getComputedStyle(node).transitionDuration), '0s', 'reduced motion drops tile transitions');
      await page.mouse.move(280, 520);

      // Roving focus lands on the active tile and moves with arrows.
      await page.focus('#favorites .tile.active');
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Chat');
      await page.keyboard.press('ArrowRight');
      const ring = await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return { style: s.outlineStyle, width: s.outlineWidth, label: document.activeElement.getAttribute('aria-label'), visible: document.activeElement.matches(':focus-visible') }; });
      assert.deepEqual(ring, { style: 'solid', width: '2px', label: 'Notes, asleep', visible: true });
      await page.screenshot({ path: `${evidence}/favorites-focus-300.png`, clip: { x: 0, y: 0, width: 300, height: 120 } });

      // Context menu removal and Undo still work on a tile.
      await page.click('#favorites .tile[aria-label="Notes, asleep"]', { button: 'right' });
      await page.getByRole('menuitem', { name: 'Remove from favorites' }).click();
      await page.waitForFunction(() => document.querySelectorAll('#favorites .tile:not(.leaving)').length === 3);
      await page.getByRole('button', { name: 'Undo' }).click();
      await page.waitForFunction(() => document.querySelectorAll('#favorites .tile:not(.leaving)').length === 4);

      // A click opens the favourite.
      await page.click('#favorites .tile[aria-label="Music, asleep"]');
      await page.waitForFunction(() => window.fx.calls.some(([name, url]) => name === 'tabs.create' && url === 'https://music.example.com/'));
    });

    // The temporary empty drop target floats: showing it moves nothing beneath it.
    await withSidebar(browser, base, { width: 240, favorites: 0 }, async (page) => {
      const before = await page.$eval('#space-pane', (node) => node.getBoundingClientRect().top);
      const target = await page.evaluate(() => {
        const favorites = document.getElementById('favorites');
        favorites.hidden = false;
        favorites.classList.add('empty');
        const box = favorites.getBoundingClientRect();
        return { position: getComputedStyle(favorites).position, height: box.height, width: box.width };
      });
      assert.equal(target.position, 'absolute');
      assert.ok(target.height >= 40 && target.width > 180, `drop target ${target.width}x${target.height}`);
      assert.equal(await page.$eval('#space-pane', (node) => node.getBoundingClientRect().top), before, 'tab rows stay put');
      await page.screenshot({ path: `${evidence}/favorites-empty-drop-target.png`, clip: { x: 0, y: 0, width: 240, height: 160 } });
    });
  } finally {
    await browser.close();
    server.close();
  }
});

// ------------------------------------------------------------------ new tab

const LONG = 'The ground beneath you is moving: the evidence for moving continents';
const NEW_TAB_SITES = [
  ['Canvas LMS', 'https://canvas.example.edu/'],
  ['Enter your username and password', 'https://tass.example.edu/'],
  ['Organato', 'https://organato.example.com/'],
  ['Canva: Visual Suite for Everyone', 'https://www.canva.example.com/'],
  [LONG, 'https://geology.example.org/'],
  ['X', 'https://x.example.com/'],
  ['Mail', 'https://mail.example.com/'],
  ['A very long library catalogue search results page title', 'https://library.example.edu/'],
  ['Ninth', 'https://ninth.example.com/'],
].map(([title, url]) => ({ title, url }));

function installNewTabFixture({ view, appearance }) {
  window.fx = { requests: [] };
  const preferences = {};
  const listeners = [];
  window.chrome = {
    runtime: {
      connect: ({ name }) => {
        const handlers = [];
        return {
          name,
          onMessage: { addListener: (fn) => handlers.push(fn) },
          onDisconnect: { addListener() {} },
          postMessage(message) { window.fx.requests.push(message); setTimeout(() => handlers.forEach((fn) => fn({ type: 'view', id: message.id, ...structuredClone(view) })), 0); },
          disconnect() {},
        };
      },
      getURL: (path) => `${location.origin}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ permissions: ['favicon'] }),
      lastError: undefined,
    },
    storage: {
      local: {
        async get(key) { return { [key]: structuredClone(preferences[key]) }; },
        async set(values) { Object.assign(preferences, structuredClone(values)); for (const fn of listeners) fn(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), 'local'); },
      },
      onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} },
    },
    breezerPrivate: { getAppearance: async () => appearance },
  };
}

async function withNewTab(browser, base, { width, height = 720, appearance = { theme: 'tide', colorMode: 'dark' }, reducedMotion = 'no-preference' }, fn) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, reducedMotion, locale: 'en-US' });
  await context.addInitScript(installNewTabFixture, { view: { topSites: NEW_TAB_SITES, organato: { enabled: false } }, appearance });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/newtab.html`);
    await page.waitForSelector('html[data-loaded="true"]');
    await page.waitForFunction(() => document.querySelectorAll('.site-icon.has-icon').length === 8);
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

const siteGeometry = (page) => page.evaluate(() => [...document.querySelectorAll('.site')].filter((site) => site.offsetParent).map((site) => {
  const slot = site.getBoundingClientRect();
  const icon = site.querySelector('.site-icon').getBoundingClientRect();
  const name = site.querySelector('.site-name');
  const label = name.getBoundingClientRect();
  return {
    left: slot.left, right: slot.right, width: slot.width, top: Math.round(slot.top),
    cx: icon.left + icon.width / 2, labelLeft: label.left, labelRight: label.right,
    truncated: name.scrollWidth > name.clientWidth, title: site.querySelector('.site-link').title, text: name.textContent,
  };
}));

function assertSiteRow(sites, visible, label, viewport) {
  assert.equal(sites.length, visible, `${label}: visible sites`);
  assert.equal(new Set(sites.map((s) => s.top)).size, 1, `${label}: one row`);
  assert.ok(spread(sites.map((s) => s.width)) < 0.5, `${label}: equal slots ${sites.map((s) => s.width)}`);
  assert.ok(spread(intervals(sites.map((s) => s.cx))) <= 0.5, `${label}: even icon centres ${intervals(sites.map((s) => s.cx))}`);
  for (const site of sites) {
    assert.ok(site.labelLeft >= site.left - 0.5 && site.labelRight <= site.right + 0.5, `${label}: "${site.text}" stays in its slot`);
    assert.ok(site.title.startsWith(`${site.text}\n`), `${label}: full title tooltip kept`);
    assert.ok(site.right <= viewport, `${label}: inside the window`);
  }
}

test('new-tab sites keep equal slots and icon spacing whatever the title length', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const cases = [
      { name: 'wide-dark-tide', width: 1440, visible: 8 },
      { name: 'wide-light-mint', width: 1280, visible: 8, appearance: { theme: 'mint', colorMode: 'light' } },
      { name: 'medium-custom', width: 900, visible: 6, appearance: { theme: '#d0543c', colorMode: 'light' } },
      { name: 'small-custom-dark', width: 640, visible: 4, appearance: { theme: '#d0543c', colorMode: 'dark' } },
      { name: 'mobile-dark', width: 390, visible: 3 },
    ];
    for (const item of cases) {
      await withNewTab(browser, base, item, async (page) => {
        const sites = await siteGeometry(page);
        assertSiteRow(sites, item.visible, item.name, item.width);
        assert.ok(sites.some((s) => s.truncated), `${item.name}: long titles are truncated`);
        assert.ok(sites.some((s) => s.text === 'X' && !s.truncated) || item.visible < 6, `${item.name}: short titles are whole`);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${item.name}: no page overflow`);
        await page.screenshot({ path: `${evidence}/newtab-sites-${item.name}.png`, clip: { x: 0, y: 0, width: item.width, height: 360 } });
      });
    }

    // Keyboard: link then its Remove button; the button shows on focus and removes without navigating.
    await withNewTab(browser, base, { width: 1280, reducedMotion: 'reduce' }, async (page) => {
      await page.keyboard.press('Tab');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), 'https://canvas.example.edu/');
      await page.keyboard.press('Tab');
      const remove = await page.evaluate(() => ({ label: document.activeElement.getAttribute('aria-label'), opacity: getComputedStyle(document.activeElement).opacity, outline: getComputedStyle(document.activeElement).outlineStyle }));
      assert.deepEqual(remove, { label: 'Remove Canvas LMS shortcut', opacity: '1', outline: 'solid' });
      await page.screenshot({ path: `${evidence}/newtab-sites-remove-focus.png`, clip: { x: 0, y: 0, width: 1280, height: 360 } });
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => !document.querySelector('.site-link[href="https://canvas.example.edu/"]'));
      assert.ok(page.url().endsWith('/newtab.html'), 'Remove must not open the site');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'shortcut-undo');
      assertSiteRow(await siteGeometry(page), 8, 'after removal', 1280);
      await page.keyboard.press('Enter');
      await page.waitForSelector('.site-link[href="https://canvas.example.edu/"]');
      assert.equal(await page.$eval('.site:hover .site-icon, .site-icon', (node) => getComputedStyle(node).transitionDuration), '0s', 'reduced motion drops the hover lift');
    });
  } finally {
    await browser.close();
    server.close();
  }
});
