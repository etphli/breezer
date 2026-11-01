import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drives the redesigned Settings page (category navigation, search and the Other tab)
// in a headless browser against fake chrome.* APIs. Native hosting is out of scope.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

function installFixture({ colorMode, theme }) {
  const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  const fx = { local: load('fx-local', {}), appearance: load('fx-appearance', null), calls: [], ports: {}, listeners: [] };
  fx.appearance ??= { layout: 'sidebar', sidebarMode: 'expanded', theme, colorMode, showBookmarks: true, sidebarWidth: 240, sidebarFontSize: 15, centeredAddressBar: true, minimalUrl: true, showLoadProgress: true, frameless: true, alwaysShowSidebar: false, alwaysShowTopBar: true };
  window.fx = fx;
  const save = () => { localStorage.setItem('fx-local', JSON.stringify(fx.local)); localStorage.setItem('fx-appearance', JSON.stringify(fx.appearance)); };
  const area = (data, name) => ({
    async get(keys) { const list = keys == null ? Object.keys(data) : [keys].flat(); return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]))); },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
      save();
      setTimeout(() => fx.listeners.forEach((fn) => fn(changes, name)), 0);
    },
  });
  const event = () => { const list = []; return { list, addListener: (fn) => list.push(fn), removeListener() {} }; };
  window.chrome = {
    runtime: {
      getURL: (path) => `${location.origin}/${path}`,
      getManifest: () => ({ version: '1.1.0' }),
      onMessage: event(),
      connect({ name }) {
        const port = { name, sent: [], onMessage: event(), onDisconnect: event(), postMessage(message) { this.sent.push(message); }, disconnect() {} };
        port.reply = (message) => port.onMessage.list.forEach((fn) => fn(structuredClone(message)));
        fx.ports[name] = port;
        if (name === 'breezer-context-settings') port.postMessage = (message) => setTimeout(() => port.reply({ id: message.id, ok: true, value: { enabled: false, sites: [] } }), 0);
        if (name === 'breezer-organato-settings') port.postMessage = (message) => setTimeout(() => port.reply({ id: message.id, ok: true, value: { connected: false, dashboardEnabled: true, enabled: true, allowAI: true } }), 0);
        if (name === 'breezer-updates') port.postMessage = (message) => setTimeout(() => port.reply({ id: message.id, ok: true, value: { available: false, notice: 'Breezer is up to date.' } }), 0);
        return port;
      },
    },
    storage: { local: area(fx.local, 'local'), session: area({}, 'session'), onChanged: { addListener: (fn) => fx.listeners.push(fn) } },
    tabs: {
      async query() { return [{ index: 0, windowId: 1 }]; },
      async getCurrent() { return { id: 42, index: 0, windowId: 1 }; },
      async create(props) { fx.calls.push(['tabs.create', props]); return props; },
      async update(id, props) { fx.calls.push(['tabs.update', id, props]); return { id, ...props }; },
    },
    breezerPrivate: {
      async getAppearance() { return structuredClone(fx.appearance); },
      async setAppearance(patch) { fx.calls.push(['setAppearance', patch]); Object.assign(fx.appearance, patch); save(); return structuredClone(fx.appearance); },
    },
  };
}

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

test('settings categories, search, Other and narrow layout work in a real browser', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/workspace.html`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const errors = [];
  const open = async ({ hash = '#/settings', colorMode = 'light', theme = 'mint', width = 1200, height = 860, reducedMotion = 'no-preference' } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: colorMode, reducedMotion });
    await context.addInitScript(installFixture, { colorMode, theme });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(`${message.text()} ${message.location().url}`); });
    await page.goto(`${base}${hash}`);
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.locator('#theme-swatches [role="radio"]').first().waitFor({ state: 'attached' });
    return page;
  };
  const current = (page) => page.locator('.nav-item[aria-current="page"]').innerText();
  const visiblePages = (page) => page.locator('.settings-page:not([hidden])').evaluateAll((nodes) => nodes.map((node) => node.dataset.page));
  try {
    // ---------------------------------------------------------- categories
    const page = await open();
    await page.waitForTimeout(700); // let the import card finish its entrance
    assert.equal(await current(page), 'General');
    assert.deepEqual(await visiblePages(page), ['general']);
    assert.equal(await page.locator('#settings-crumb').innerText(), 'General');
    await page.screenshot({ path: join(evidence, 'settings-redesign-general-light.png') });

    // The sync module is mounted, and this browser fixture deliberately lacks
    // its native bridge. Discovery must explain that limitation without success.
    await page.locator('.nav-item[data-category="sync"]').waitFor();
    await page.getByRole('link', { name: 'Sync', exact: true }).click();
    await page.getByText('This build does not include native sync setup.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Set up or manage sync', exact: true }).isDisabled(), true);
    await page.screenshot({ path: join(evidence, 'settings-sync-unavailable-fixture.png') });
    await page.getByRole('link', { name: 'General', exact: true }).click();
    // Feature modules from FEATURE_MOUNTS add their category once rendered.
    await page.locator('.nav-item[data-category="languages"]').waitFor();
    assert.equal(await page.locator('.nav-item[data-category="assistant"]').isVisible(), true, 'context settings mounted');

    await page.getByRole('link', { name: 'Appearance' }).click();
    assert.equal(await current(page), 'Appearance');
    assert.deepEqual(await visiblePages(page), ['appearance']);
    assert.match(page.url(), /#\/settings\/appearance$/);
    await page.getByRole('radio', { name: 'Dusk' }).click();
    await page.waitForFunction(() => window.fx.appearance.theme === 'dusk');
    await page.waitForFunction(() => document.documentElement.dataset.tone === 'dusk');
    await page.screenshot({ path: join(evidence, 'settings-redesign-appearance-light.png') });
    await page.getByRole('radio', { name: 'Mint' }).click();
    await page.waitForFunction(() => window.fx.appearance.theme === 'mint');

    // Back returns to the previous category without reloading the page.
    await page.evaluate(() => { window.__sameDocument = true; });
    await page.goBack();
    await page.waitForFunction(() => document.querySelector('.nav-item[aria-current="page"]')?.dataset.category === 'general');
    assert.equal(await page.evaluate(() => window.__sameDocument), true, 'category changes do not reload');

    // Keyboard: arrows move through categories, Enter opens one.
    await page.locator('.nav-item[aria-current="page"]').focus();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.category), 'layout');
    await page.keyboard.press('Enter');
    assert.equal(await current(page), 'Layout');
    await page.locator('#frameless').click();
    await page.waitForFunction(() => window.fx.appearance.frameless === false);

    // Deep links and reloads keep the category; persisted values render.
    await page.reload();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.waitForFunction(() => document.getElementById('frameless').getAttribute('aria-checked') === 'false');
    assert.equal(await current(page), 'Layout');
    await page.locator('#frameless').click();
    await page.waitForFunction(() => window.fx.appearance.frameless === true);

    // ---------------------------------------------------------- search
    await page.keyboard.press('Escape');
    await page.locator('body').click({ position: { x: 600, y: 600 } });
    await page.keyboard.press('/');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-search', '/ focuses search');
    await page.keyboard.type('dark mode');
    await page.locator('#settings-results [role="option"]').first().waitFor();
    assert.equal(await page.locator('#settings-search').getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await visiblePages(page), [], 'results replace the page');
    assert.equal(await page.locator('#settings-results [aria-selected="true"] .result-title').innerText(), 'Appearance');
    assert.equal(await page.locator('#settings-crumb').innerText(), 'Search');
    await page.screenshot({ path: join(evidence, 'settings-redesign-search-light.png') });
    await page.keyboard.press('Enter');
    assert.equal(await current(page), 'Appearance');
    assert.equal(await page.locator('#settings-search').inputValue(), '', 'search clears after choosing');
    assert.equal(await page.evaluate(() => document.activeElement.closest('[data-field]')?.dataset.field), 'colorMode', 'focus lands on the setting');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-checked')), 'true');

    // Feature-mounted controls are searchable by their keywords.
    await page.locator('#settings-search').fill('passkeys');
    const passkeys = await page.locator('#settings-results [role="option"] .result-title').allInnerTexts();
    assert.ok(passkeys.includes('Passwords'), `passkeys finds Passwords: ${passkeys}`);
    await page.locator('#settings-search').fill('translate');
    await page.locator('#settings-results [aria-selected="true"]').click();
    assert.equal(await current(page), 'Languages');
    assert.equal(await page.evaluate(() => document.activeElement.closest('#translation-settings') !== null), true);
    await page.locator('#settings-search').fill('organato key');
    await page.locator('#settings-results [role="option"]', { hasText: 'Organato API key' }).click();
    assert.equal(await current(page), 'New tab and Organato');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'organato-key');

    // Native destinations open beside Settings, like the Browser settings rows.
    await page.locator('#settings-search').fill('cookies');
    await page.locator('#settings-results [role="option"]').first().waitFor();
    assert.equal(await page.locator('#settings-results [aria-selected="true"] .result-title').innerText(), 'Privacy and security');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fx.calls.some(([name, props]) => name === 'tabs.create' && props.url === 'chrome://settings/privacy'));

    // No results: say so, and offer Chromium's own search for the same words.
    await page.locator('#settings-search').fill('zzqx flux');
    await page.getByText('No Breezer settings match “zzqx flux”.').waitFor();
    assert.match(await page.locator('#settings-search-status').innerText(), /No Breezer settings match/);
    await page.screenshot({ path: join(evidence, 'settings-redesign-no-results-light.png') });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fx.calls.some(([name, props]) => name === 'tabs.create' && props.url === 'chrome://settings/?search=zzqx%20flux'));
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#settings-results').isHidden(), true, 'Escape closes results');
    assert.equal(await page.locator('.settings-page:not([hidden])').count(), 1);

    // ---------------------------------------------------------- Other
    await page.getByRole('button', { name: 'Other' }).click();
    await page.waitForFunction(() => window.fx.calls.some(([name, id, props]) => name === 'tabs.update' && id === 42 && props.url === 'chrome://settings/'));
    assert.equal(await page.locator('#native-settings-error').isHidden(), true);

    // ---------------------------------------------------------- dark, narrow, reduced motion
    const dark = await open({ hash: '#/settings/general', colorMode: 'dark' });
    await dark.waitForTimeout(700); // let the import card finish its entrance
    await dark.screenshot({ path: join(evidence, 'settings-redesign-general-dark.png') });
    await dark.getByRole('link', { name: 'Layout' }).click();
    await dark.screenshot({ path: join(evidence, 'settings-redesign-layout-dark.png') });
    for (const [name, file] of [['Passwords', 'passwords'], ['Languages', 'languages'], ['Browser settings', 'browser'], ['Spaces', 'spaces'], ['Assistant', 'assistant'], ['Layout', 'layout']]) {
      await dark.locator('#settings-categories').getByRole('link', { name, exact: true }).click();
      await dark.screenshot({ path: join(evidence, `settings-redesign-${file}-dark.png`) });
    }
    const contrast = await dark.evaluate(() => {
      const rgb = (value) => { const parts = value.match(/[\d.]+/g).slice(0, 3).map(Number); return value.startsWith('color(') ? parts.map((c) => c * 255) : parts; };
      const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
      const ratio = (a, b) => { const [x, y] = [lum(rgb(a)), lum(rgb(b))].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
      const small = document.querySelector('.settings-page:not([hidden]) .setting-row small');
      const group = getComputedStyle(small.closest('.setting-group')).backgroundColor;
      const nav = getComputedStyle(document.querySelector('.settings-nav')).backgroundColor;
      return { description: ratio(getComputedStyle(small).color, group), navText: ratio(getComputedStyle(document.querySelector('.nav-item:not([aria-current])')).color, nav) };
    });
    assert.ok(contrast.description >= 4.5, `description contrast ${contrast.description}`);
    assert.ok(contrast.navText >= 4.5, `nav contrast ${contrast.navText}`);

    const narrow = await open({ hash: '#/settings/layout', width: 390, height: 844, reducedMotion: 'reduce' });
    assert.equal(await current(narrow), 'Layout');
    const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflow, 0, 'no horizontal page scroll at 390 px');
    assert.equal(await narrow.locator('.nav-item[aria-current="page"]').evaluate((node) => { const box = node.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth; }), true, 'selected category is in view');
    assert.equal(await narrow.locator('#settings-search').evaluate((node) => node.getBoundingClientRect().top >= 0), true);
    await narrow.screenshot({ path: join(evidence, 'settings-redesign-layout-narrow.png') });
    await narrow.locator('#settings-search').fill('font');
    await narrow.keyboard.press('Enter');
    assert.equal(await current(narrow), 'Appearance');
    assert.equal(await narrow.evaluate(() => document.activeElement.id), 'sidebar-font-size');
    assert.equal(await narrow.locator('.search-hit').evaluate((node) => getComputedStyle(node).animationName), 'none', 'no highlight animation under reduced motion');

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
