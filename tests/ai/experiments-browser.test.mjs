import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, CONNECTED, installFixture as installNewTabFixture } from './newtab-browser-fixture.mjs';
import { installFixture as installSettingsFixture } from './settings-browser-fixture.mjs';

// Drives Settings > Experiments and the experimental New Tab in a real browser
// against chrome.* fixtures. All data is disposable test data.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || resolve(here, '../../build/support/experiments-evidence');
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

const COLORS = ['#1a73e8', '#c2410c', '#0f766e', '#7c3aed', '#be123c', '#15803d', '#b45309', '#334155'];
const favicon = (pageUrl) => {
  const host = new URL(pageUrl).hostname;
  const color = COLORS[[...host].reduce((sum, c) => sum + c.charCodeAt(0), 0) % COLORS.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-family="Helvetica" font-size="17" font-weight="700" text-anchor="middle" fill="#fff">${host[0]?.toUpperCase() || '?'}</text></svg>`;
};

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/_favicon/') { response.setHeader('Content-Type', 'image/svg+xml'); response.end(favicon(url.searchParams.get('pageUrl'))); return; }
      const path = resolve(root, `.${url.pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

// Runs after the shared New Tab fixture: seeds the experiments record once and adds
// the APIs the experiments use (search, side panel, windows, session storage).
function seedNewTab({ experiments, conversations = {}, windowState = 'normal' }) {
  if (experiments && !localStorage.getItem('shortcut-fixture')) localStorage.setItem('shortcut-fixture', JSON.stringify({ breezerExperiments: experiments }));
  window.fxSeed = { conversations, windowState };
}
function extendNewTab() {
  const fx = window.fx;
  Object.assign(fx, { searches: [], panels: [], focused: [], assigned: [] });
  const session = structuredClone(window.fxSeed.conversations);
  const listeners = [];
  const notify = (changes) => setTimeout(() => listeners.forEach((fn) => fn(structuredClone(changes), 'session')), 0);
  chrome.storage.session = {
    async get(key) { return key == null ? structuredClone(session) : Object.fromEntries([key].flat().filter((k) => k in session).map((k) => [k, structuredClone(session[k])])); },
    async set(values) { const changes = {}; for (const [k, v] of Object.entries(values)) { changes[k] = { oldValue: session[k], newValue: structuredClone(v) }; session[k] = structuredClone(v); } notify(changes); },
    async remove(keys) { const changes = {}; for (const k of [keys].flat()) if (k in session) { changes[k] = { oldValue: session[k] }; delete session[k]; } notify(changes); },
    onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} },
  };
  fx.session = session;
  // Stands in for the panel hook consuming a New Tab question.
  fx.consumeHandoff = (windowId) => chrome.storage.session.remove(`breezer-handoff-${windowId}`);
  chrome.search = { async query(options) { fx.searches.push(options); } };
  chrome.sidePanel = { open(options) { fx.panels.push(options); return Promise.resolve(); } };
  chrome.tabs.getCurrent = async () => ({ id: 7, windowId: 1 });
  chrome.windows = {
    async getAll() { return [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' }]; },
    async getCurrent() { return { id: 1, state: window.fxSeed.windowState }; },
    async update(id, props) { fx.focused.push([id, props]); return { id }; },
  };
}

const ALL_ON = { glass: true, newTabComposer: true, newTabRecentChats: true, newTabShortcuts: true, personality: 'warm' };
const CHATS = {
  'breezer-conversation-1': [{ role: 'user', text: 'Help me plan my history essay' }, { role: 'assistant', text: 'Start with a clear question about the cause.' }],
  'breezer-conversation-2': [{ role: 'user', text: 'Compare two laptops for school' }, { role: 'assistant', text: 'The lighter one wins for carrying daily.' }],
  'breezer-conversation-8': [{ role: 'user', text: 'From a closed window' }],
};

async function openNewTab(browser, base, { experiments, conversations, windowState, colorScheme = 'light', reducedMotion = 'reduce', video, viewport = { width: 1280, height: 820 } } = {}) {
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion, locale: 'en-US', ...(video ? { recordVideo: { dir: video, size: viewport } } : {}) });
  await context.addInitScript(seedNewTab, { experiments, conversations, windowState });
  await context.addInitScript(installNewTabFixture, { view: { ...CONNECTED, organato: { enabled: false } } });
  await context.addInitScript(extendNewTab);
  await context.route('https://example.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Example</title>' }));
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
  await page.goto(`${base}/newtab.html`);
  await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true');
  return { page, context, errors };
}

test('New Tab experiments stay off by default and each one works once turned on', { skip, timeout: 120_000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    // ------------------------------------------------------------ defaults
    {
      const { page, context, errors } = await openNewTab(browser, base);
      const html = await page.evaluate(() => ({ ...document.documentElement.dataset }));
      assert.equal(html.composer, undefined);
      assert.equal(html.personality, undefined);
      assert.equal(html.glass, 'solid');
      assert.equal(await page.locator('#composer').isHidden(), true);
      assert.equal(await page.locator('.sites-nav').isVisible(), true);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ------------------------------------------------------------ all on
    for (const colorScheme of ['light', 'dark']) {
      const { page, context, errors } = await openNewTab(browser, base, { experiments: ALL_ON, conversations: CHATS, colorScheme });
      await page.locator('#recent-chats-list .recent-chat').first().waitFor();
      assert.equal(await page.locator('.sites-nav').isHidden(), true);
      assert.equal(await page.locator('#composer-sites li').count(), 8);
      assert.deepEqual(await page.locator('.recent-chat-title').allInnerTexts(), ['Help me plan my history essay', 'Compare two laptops for school']);
      assert.deepEqual(await page.locator('.recent-chat-where').allInnerTexts(), ['This window', 'Other window']);
      const html = await page.evaluate(() => ({ ...document.documentElement.dataset }));
      assert.equal(html.glass, 'glass');
      assert.equal(html.personality, 'warm');
      await page.locator('#composer-input').focus();
      await page.screenshot({ path: join(evidence, `newtab-experiments-${colorScheme}.png`) });
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ------------------------------------------------------------ search, address, ask
    {
      const { page, context, errors } = await openNewTab(browser, base, { experiments: ALL_ON, conversations: CHATS });
      const input = page.locator('#composer-input');
      await input.fill('rain radar sydney');
      await input.press('Enter');
      await page.waitForFunction(() => fx.searches.length === 1);
      assert.deepEqual(await page.evaluate(() => fx.searches[0]), { text: 'rain radar sydney', tabId: 7 });

      await page.getByRole('radio', { name: 'Ask Breezer' }).click();
      assert.equal(await page.locator('#composer-form').getAttribute('data-mode'), 'ask');
      assert.equal(await page.locator('#composer-style').innerText(), 'Warm replies');
      await input.fill('Summarise what I should revise tonight');
      await input.press('Enter');
      await page.waitForFunction(() => fx.panels.length === 1 && fx.session['breezer-handoff-1']);
      assert.deepEqual(await page.evaluate(() => fx.panels[0]), { windowId: 1 });
      const handoff = await page.evaluate(() => fx.session['breezer-handoff-1']);
      assert.equal(handoff.prompt, 'Summarise what I should revise tonight');
      assert.equal(handoff.source, 'newtab');
      await page.evaluate(() => fx.consumeHandoff(1));
      await page.getByText('Opened in Breezer AI.').waitFor();
      assert.equal(await input.inputValue(), '');

      // Without the panel taking it, the question stays and the stored copy is removed.
      await input.fill('A question nobody picks up');
      await input.press('Enter');
      await page.getByText('Your question is still here to paste.', { exact: false }).waitFor({ timeout: 8000 });
      assert.equal(await input.inputValue(), 'A question nobody picks up');
      assert.equal(await page.evaluate(() => 'breezer-handoff-1' in fx.session), false);

      await page.locator('.recent-chat').nth(1).click();
      await page.waitForFunction(() => fx.panels.length === 3 && fx.focused.length === 1);
      assert.deepEqual(await page.evaluate(() => [fx.panels[2], fx.focused[0]]), [{ windowId: 2 }, [2, { focused: true }]]);

      await page.getByRole('radio', { name: 'Search' }).click();
      await input.fill('example.com');
      await Promise.all([page.waitForURL('https://example.com/'), input.press('Enter')]);
      assert.deepEqual(errors, []);
      await context.close();
    }

    // ------------------------------------------------------------ fullscreen and live changes
    {
      const { page, context } = await openNewTab(browser, base, { experiments: { glass: true }, windowState: 'fullscreen' });
      await page.waitForFunction(() => document.documentElement.dataset.glass === 'solid');
      await context.close();
      const live = await openNewTab(browser, base, {});
      await live.page.evaluate(() => chrome.storage.local.set({ breezerExperiments: { newTabComposer: true, personality: 'direct' } }));
      await live.page.waitForFunction(() => document.documentElement.dataset.composer === 'on' && document.documentElement.dataset.personality === 'direct');
      assert.equal(await live.page.locator('#composer').isVisible(), true);
      await live.page.evaluate(() => chrome.storage.local.set({ breezerExperiments: {} }));
      await live.page.waitForFunction(() => !document.documentElement.dataset.composer && !document.documentElement.dataset.personality);
      assert.equal(await live.page.locator('.sites-nav').isVisible(), true);
      await live.context.close();
    }

    // ------------------------------------------------------------ personality looks
    for (const personality of ['concise', 'warm', 'tutor', 'direct']) {
      const { page, context } = await openNewTab(browser, base, { experiments: { newTabComposer: true, newTabShortcuts: true, personality }, viewport: { width: 1100, height: 620 } });
      await page.locator('#composer-sites li').first().waitFor();
      await page.getByRole('radio', { name: 'Ask Breezer' }).click();
      await page.screenshot({ path: join(evidence, `newtab-personality-${personality}.png`) });
      await context.close();
    }

    // ------------------------------------------------------------ narrow
    {
      const { page, context } = await openNewTab(browser, base, { experiments: ALL_ON, conversations: CHATS, viewport: { width: 390, height: 780 } });
      await page.locator('#recent-chats-list .recent-chat').first().waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: join(evidence, 'newtab-experiments-narrow.png') });
      await context.close();
    }

    // ------------------------------------------------------------ mode switch animation
    {
      const dir = join(evidence, 'video-tmp');
      const { page, context } = await openNewTab(browser, base, { experiments: { ...ALL_ON, glass: false }, conversations: CHATS, reducedMotion: 'no-preference', video: dir });
      await page.waitForTimeout(500);
      for (let round = 0; round < 3; round++) {
        await page.getByRole('radio', { name: 'Ask Breezer' }).click();
        await page.waitForTimeout(600);
        await page.getByRole('radio', { name: 'Search' }).click();
        await page.waitForTimeout(600);
      }
      const thumb = await page.locator('.composer-thumb').evaluate((node) => getComputedStyle(node).transitionDuration);
      assert.match(thumb, /0\.22s/);
      const path = await page.video().path();
      await context.close();
      await rename(path, join(evidence, 'newtab-mode-switch.webm'));
    }
  } finally {
    await browser.close();
    server.close();
  }
});

test('Settings > Experiments saves each toggle, gates native glass and personality looks', { skip, timeout: 90_000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/workspace.html`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const open = async ({ nativeGlass, failGlass = false, colorMode = 'light', video } = {}) => {
    const viewport = { width: 1200, height: 900 };
    const context = await browser.newContext({ viewport, colorScheme: colorMode, reducedMotion: video ? 'no-preference' : 'reduce', ...(video ? { recordVideo: { dir: video, size: viewport } } : {}) });
    await context.addInitScript(({ nativeGlass }) => {
      if (localStorage.getItem('fx-appearance')) return;
      localStorage.setItem('fx-appearance', JSON.stringify({
        layout: 'sidebar', sidebarMode: 'expanded', theme: 'mint', colorMode: 'system', showBookmarks: true, sidebarWidth: 240, sidebarFontSize: 15,
        centeredAddressBar: true, minimalUrl: true, showLoadProgress: true, frameless: true, alwaysShowSidebar: false, alwaysShowTopBar: true,
        themeCanRestore: true, ...(nativeGlass === undefined ? {} : { nativeGlass }),
      }));
    }, { nativeGlass });
    await context.addInitScript(installSettingsFixture, { colorMode, theme: 'mint' });
    if (failGlass) await context.addInitScript(() => {
      const set = chrome.breezerPrivate.setAppearance;
      chrome.breezerPrivate.setAppearance = async (patch) => { if ('nativeGlass' in patch) throw new Error('The window material could not change.'); return set(patch); };
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}#/settings/experiments`);
    await page.locator('#experiments-heading').waitFor();
    return { page, context, errors };
  };
  const record = (page) => page.evaluate(() => fx.local.breezerExperiments);
  try {
    {
      const { page, context, errors } = await open({ nativeGlass: false });
      assert.equal(await page.locator('.nav-item[aria-current="page"]').innerText(), 'Experiments');
      const toggles = page.locator('#experiments-settings input.toggle');
      assert.equal(await toggles.count(), 6);
      for (const checked of await toggles.evaluateAll((nodes) => nodes.map((node) => node.checked))) assert.equal(checked, false);
      assert.equal(await page.locator('#experiment-newTabRecentChats').isDisabled(), true);
      assert.equal(await page.locator('[role="radio"][aria-checked="true"]', { hasText: 'Standard' }).count(), 1);
      assert.match(await page.locator('[data-experiment-row="glass"] small').innerText(), /Translucent window/);
      await page.screenshot({ path: join(evidence, 'settings-experiments-default.png'), fullPage: true });

      await page.getByLabel('Search and ask box').check();
      await page.waitForFunction(() => fx.local.breezerExperiments?.newTabComposer === true);
      await page.getByLabel('Recent conversations').check();
      await page.getByLabel('Space dock').check();
      await page.getByLabel('Address search in the sidebar').check();
      await page.waitForFunction(() => fx.local.breezerExperiments?.sidebarSearch === true);
      await page.getByLabel('Glossy glass').check();
      await page.waitForFunction(() => fx.local.breezerExperiments?.glass === true);
      const calls = await page.evaluate(() => fx.calls.filter(([name, patch]) => name === 'setAppearance' && 'nativeGlass' in patch));
      assert.deepEqual(calls.map(([, patch]) => patch), [{ nativeGlass: true }]);

      await page.getByRole('radio', { name: 'Tutor' }).click();
      await page.getByText('Browser colors changed to match.', { exact: false }).waitFor();
      assert.equal((await record(page)).personality, 'tutor');
      assert.equal(await page.evaluate(() => fx.appearance.theme), '#2d6b5a');
      await page.screenshot({ path: join(evidence, 'settings-experiments-on.png'), fullPage: true });
      await page.getByRole('radio', { name: 'Standard' }).click();
      await page.getByText('Your previous browser colors are back.').waitFor();
      assert.equal(await page.evaluate(() => fx.appearance.theme), 'mint');

      const saved = await record(page);
      assert.deepEqual(saved, { version: 1, glass: true, sidebarSearch: true, newTabComposer: true, newTabRecentChats: true, newTabShortcuts: false, spaceDock: true, personality: 'off' });
      await page.locator('#settings-search').fill('personality');
      await page.locator('#settings-results .result-title', { hasText: /^Style$/ }).waitFor();
      assert.deepEqual(errors, []);
      await context.close();
    }
    {
      // Without native glass the description says so and nothing native is called.
      const { page, context } = await open({ colorMode: 'dark' });
      assert.match(await page.locator('[data-experiment-row="glass"] small').innerText(), /keeps the window frame solid/);
      await page.getByLabel('Glossy glass').check();
      await page.waitForFunction(() => fx.local.breezerExperiments?.glass === true);
      assert.equal(await page.evaluate(() => fx.calls.some(([, patch]) => patch && 'nativeGlass' in patch)), false);
      await page.screenshot({ path: join(evidence, 'settings-experiments-dark.png'), fullPage: true });
      await context.close();
    }
    {
      // A failed native change leaves the experiment off and says why.
      const { page, context } = await open({ nativeGlass: false, failGlass: true });
      await page.getByLabel('Glossy glass').click();
      await page.getByText('The window material could not change.', { exact: false }).waitFor();
      assert.equal(await page.getByLabel('Glossy glass').isChecked(), false);
      assert.equal((await record(page))?.glass ?? false, false);
      await context.close();
    }
    {
      const dir = join(evidence, 'video-tmp');
      const { page, context } = await open({ nativeGlass: false, video: dir });
      await page.waitForTimeout(400);
      for (const label of ['Search and ask box', 'Recent conversations', 'Site shortcuts', 'Glossy glass']) { await page.getByLabel(label).check(); await page.waitForTimeout(450); }
      for (const name of ['Brief', 'Warm', 'Tutor', 'Direct', 'Standard']) { await page.getByRole('radio', { name }).click(); await page.waitForTimeout(500); }
      const path = await page.video().path();
      await context.close();
      await rename(path, join(evidence, 'settings-experiments.webm'));
    }
  } finally {
    await browser.close();
    server.close();
  }
});
