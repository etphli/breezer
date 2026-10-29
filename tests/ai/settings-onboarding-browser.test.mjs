import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Renders the shipped Settings page in a headless browser with fake chrome.* APIs and
// helper ports, so the onboarding card, Organato and update sections can be driven.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

function installFixture({ colorMode, theme }) {
  const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  const fx = { local: load('fx-local', {}), opened: [], ports: {}, listeners: [] };
  window.fx = fx;
  const area = (data, persist) => ({
    async get(keys) { const list = keys == null ? Object.keys(data) : [keys].flat(); return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]))); },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
      persist?.();
      setTimeout(() => fx.listeners.forEach((fn) => fn(changes, persist ? 'local' : 'session')), 0);
    },
  });
  const event = () => { const list = []; return { list, addListener: (fn) => list.push(fn), removeListener() {} }; };
  const appearance = { layout: 'sidebar', sidebarMode: 'expanded', theme, colorMode, showBookmarks: true, sidebarWidth: 240, sidebarFontSize: 15, centeredAddressBar: true, minimalUrl: true, showLoadProgress: true, frameless: false, alwaysShowSidebar: false, alwaysShowTopBar: true };
  window.chrome = {
    runtime: {
      getURL: (path) => `${location.origin}/${path}`,
      getManifest: () => ({ version: '1.1.0' }),
      onMessage: event(),
      connect({ name }) {
        const port = { name, sent: [], onMessage: event(), onDisconnect: event(), postMessage(message) { this.sent.push(message); }, disconnect() {} };
        port.reply = (message) => port.onMessage.list.forEach((fn) => fn(structuredClone(message)));
        fx.ports[name] = port;
        // Context settings answer immediately; Organato and updates are driven by the test.
        if (name === 'breezer-context-settings') port.postMessage = (message) => setTimeout(() => port.reply({ id: message.id, ok: true, value: { enabled: false, sites: [] } }), 0);
        return port;
      },
    },
    storage: { local: area(fx.local, () => localStorage.setItem('fx-local', JSON.stringify(fx.local))), session: area({}), onChanged: { addListener: (fn) => fx.listeners.push(fn) } },
    tabs: {
      async query() { return [{ index: 0, windowId: 1 }]; },
      async create(props) { fx.opened.push(props); return props; },
    },
    breezerPrivate: { async getAppearance() { return structuredClone(appearance); }, async setAppearance(patch) { Object.assign(appearance, patch); return structuredClone(appearance); } },
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

test('settings onboarding, Organato and updates render and respond in a real browser', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const url = `http://127.0.0.1:${server.address().port}/workspace.html#/settings`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const errors = [];
  const open = async ({ colorMode = 'light', theme = 'mint', width = 900, height = 1200, reducedMotion = 'no-preference' } = {}) => {
    const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 2, colorScheme: colorMode, reducedMotion });
    await context.addInitScript(installFixture, { colorMode, theme });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(url);
    await page.getByRole('heading', { name: 'Bring your Chrome data to Breezer' }).waitFor();
    // Initial helper replies: Organato not connected, no update available.
    await page.evaluate(() => {
      const org = window.fx.ports['breezer-organato-settings'];
      org.reply({ id: org.sent[0].id, ok: true, value: { enabled: true, dashboardEnabled: true, allowAI: true, connected: false } });
      const upd = window.fx.ports['breezer-updates'];
      upd.reply({ id: upd.sent[0].id, ok: true, value: { available: false, notice: 'Breezer 1.1.0 is up to date.' } });
    });
    return { page, context };
  };
  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
  try {
    // ---------------------------------------------------- light, first run
    const { page, context } = await open();
    await page.screenshot({ path: join(evidence, 'settings-onboarding-light.png') });
    // Subtle buttons must not inherit the sidebar's hover-only .quiet opacity.
    for (const id of ['organato-disconnect']) assert.equal(await page.locator(`#${id}`).evaluate((node) => getComputedStyle(node).opacity), '1');
    assert.equal(await page.getByRole('button', { name: 'Hide getting started' }).evaluate((node) => getComputedStyle(node).opacity), '1');
    // Native import destinations, keyboard only.
    await page.getByRole('button', { name: 'Import bookmarks and history' }).first().focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fx.opened.length === 1);
    assert.deepEqual(await page.evaluate(() => window.fx.opened), [{ url: 'chrome://settings/importData', active: true }]);
    const status = await page.locator('[data-onboarding] [role="status"]').innerText();
    assert.match(status, /opened in a new tab/);
    assert.doesNotMatch(await page.locator('#settings').innerText(), /import (complete|succeeded)|successfully imported/i);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.onboardingAction), 'passwords');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('[data-password-import-guide]').evaluate((node) => node.open), true);
    assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY');
    assert.equal(await page.evaluate(() => window.fx.opened.length), 1, 'password steps do not open the importer by themselves');
    await page.screenshot({ path: join(evidence, 'settings-password-guide-light.png') });

    // ---------------------------------------------------- Organato busy and error
    await page.locator('#organato-key').fill('org_' + 'x'.repeat(43));
    await page.getByRole('button', { name: 'Connect', exact: true }).click();
    assert.equal(await page.locator('#organato-key').inputValue(), '', 'key leaves the page as soon as Connect is chosen');
    await page.evaluate(() => { const org = window.fx.ports['breezer-organato-settings']; org.reply({ id: org.sent.at(-1).id, type: 'progress', stage: 'Checking your Organato key…' }); });
    assert.equal(await page.locator('#organato-connect').isDisabled(), true);
    assert.equal(await page.locator('#dashboard-enabled').isDisabled(), true);
    const spinner = await page.locator('#organato-status').evaluate((node) => getComputedStyle(node, '::before').content);
    assert.notEqual(spinner, 'none', 'busy indicator is visible while connecting');
    await page.locator('#organato-settings').screenshot({ path: join(evidence, 'settings-organato-busy-light.png') });
    await page.evaluate(() => { const org = window.fx.ports['breezer-organato-settings']; org.reply({ id: org.sent.at(-1).id, ok: false, error: 'Organato API key is invalid or expired.' }); });
    assert.equal(await page.locator('#organato-connect').isDisabled(), false);
    assert.match(await page.locator('#organato-status').innerText(), /invalid or expired/);
    assert.equal(await page.locator('#organato-status').evaluate((node) => getComputedStyle(node, '::before').content), 'none');
    await page.locator('#organato-settings').screenshot({ path: join(evidence, 'settings-organato-error-light.png') });
    // Toggles stay real checkboxes and respond to the keyboard.
    await page.locator('#organato-ai').focus();
    await page.keyboard.press('Space');
    const configure = await page.evaluate(() => window.fx.ports['breezer-organato-settings'].sent.at(-1));
    assert.deepEqual(configure.settings, { allowAI: false });
    await page.evaluate(() => { const org = window.fx.ports['breezer-organato-settings']; org.reply({ id: org.sent.at(-1).id, ok: true, value: { enabled: true, dashboardEnabled: true, allowAI: false, connected: true } }); });
    assert.equal(await page.locator('#organato-ai').isChecked(), false);

    // ---------------------------------------------------- updates available
    await page.evaluate(() => { const upd = window.fx.ports['breezer-updates']; upd.reply({ id: upd.sent.at(-1).id, ok: true, value: {} }); });
    await page.getByRole('button', { name: 'Check for updates' }).click();
    await page.evaluate(() => { const upd = window.fx.ports['breezer-updates']; upd.reply({ id: upd.sent.at(-1).id, ok: true, value: { available: true, version: '1.1.1' } }); });
    assert.equal(await page.getByRole('button', { name: 'Update and restart' }).isVisible(), true);
    await page.locator('#update-settings').screenshot({ path: join(evidence, 'settings-update-available-light.png') });

    // ---------------------------------------------------- dismiss persists
    await page.getByRole('button', { name: 'Hide getting started' }).click();
    await page.locator('[data-onboarding]').waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => document.activeElement.id), 'settings-title');
    await page.reload();
    await page.getByRole('heading', { name: 'Settings', exact: true }).waitFor();
    await page.waitForTimeout(100);
    assert.equal(await page.locator('[data-onboarding]').isHidden(), true, 'stays hidden after reload');
    assert.equal(await page.getByRole('button', { name: 'Import bookmarks and history' }).count(), 1, 'browser import remains in More browser settings');
    await context.close();

    // ---------------------------------------------------- dark, custom colour
    const dark = await open({ colorMode: 'dark', theme: '#c2410c' });
    assert.equal(await dark.page.evaluate(() => document.documentElement.dataset.tone), 'custom');
    await dark.page.screenshot({ path: join(evidence, 'settings-onboarding-dark-custom.png') });
    await dark.page.evaluate(() => document.getElementById('organato-settings').scrollIntoView());
    await dark.page.screenshot({ path: join(evidence, 'settings-organato-dark-custom.png') });
    await dark.context.close();

    const darkMint = await open({ colorMode: 'dark' });
    await darkMint.page.screenshot({ path: join(evidence, 'settings-onboarding-dark.png') });
    await darkMint.context.close();

    // ---------------------------------------------------- narrow, reduced motion
    const narrow = await open({ width: 380, height: 900, reducedMotion: 'reduce' });
    assert.equal(await noOverflow(narrow.page), true, 'no horizontal scrolling at 380 px');
    const [label, toggle] = await narrow.page.evaluate(() => [document.querySelector('label[for="organato-ai"]'), document.getElementById('organato-ai')].map((node) => node.getBoundingClientRect().top));
    assert.ok(toggle - label < 24, 'toggles stay beside their labels on narrow screens');
    await narrow.page.screenshot({ path: join(evidence, 'settings-onboarding-narrow.png'), fullPage: false });
    await narrow.page.locator('#organato-key').fill('org_' + 'y'.repeat(43));
    await narrow.page.getByRole('button', { name: 'Connect', exact: true }).click();
    const animation = await narrow.page.locator('#organato-status').evaluate((node) => getComputedStyle(node, '::before').animationName);
    assert.equal(animation, 'none', 'reduced motion stops the spinner');
    await narrow.page.locator('#organato-settings').scrollIntoViewIfNeeded();
    assert.equal(await noOverflow(narrow.page), true);
    await narrow.page.locator('#organato-settings').screenshot({ path: join(evidence, 'settings-organato-narrow-busy.png') });
    await narrow.context.close();

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
