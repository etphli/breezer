import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from '../../tests/ai/node_modules/playwright/index.mjs';
import { dashboardPage } from '../lib/dashboard-page.js';
import { aggregateUsage } from '../lib/metrics.js';

test('homepage, privacy, dashboard, responsive layout, errors, and the actual usage switch', { timeout: 60_000 }, async () => {
  const root = resolve(new URL('../../', import.meta.url).pathname);
  const evidence = process.env.BREEZER_SITE_EVIDENCE || '/tmp/breezer-site-evidence';
  await mkdir(evidence, { recursive: true });
  let fail = false;
  const fixture = { ...aggregateUsage([]), downloads: 14, releases: [{ version: 'v1.1.5', downloads: 4 }], updatedAt: new Date().toISOString() };
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      if (path === '/dashboard') { res.setHeader('Content-Type', 'text/html'); res.end(dashboardPage); return; }
      if (path === '/api/metrics') { res.setHeader('Content-Type', 'application/json'); res.statusCode = fail ? 503 : 200; res.end(JSON.stringify(fail ? { error: 'Unavailable' } : fixture)); return; }
      if (path === '/settings-test') {
        res.setHeader('Content-Type', 'text/html');
        res.end(`<!doctype html><html><head><title>Usage settings fixture</title><link rel="stylesheet" href="/extension/workspace.css"></head><body><main id="settings"><div id="usage-settings"></div></main><script type="module">import {mountUsageSettings} from '/extension/usage-settings.js'; window.saved={};window.api={storage:{local:{get:async k=>({[k]:saved[k]}),set:async v=>Object.assign(saved,v)}}};await mountUsageSettings({api,container:document.getElementById('usage-settings')});</script></body></html>`); return;
      }
      const pages = { '/': 'index.html', '/privacy-policy': 'privacy-policy/index.html', '/download': 'download/index.html' };
      const relative = path.startsWith('/extension/') ? `features/ai/extension/${path.slice(11)}` : `site/${pages[path] ?? path.slice(1)}`;
      const file = resolve(root, relative);
      if (!file.startsWith(root + '/')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const browser = await chromium.launch({ executablePath, headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1050 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  try {
    const version = '1.3.99';
    const tag = `v${version}`;
    const filename = `Breezer-${tag}-arm64.dmg`;
    const sha = 'b'.repeat(64);
    const apiURL = 'https://api.github.com/repos/etphli/breezer/releases/latest';
    let requests = 0;
    await page.route(apiURL, route => {
      requests++;
      return route.fulfill({ json: { tag_name: tag, assets: [
        { name: filename, state: 'uploaded', size: 2026, digest: `sha256:${sha}` },
        { name: `${filename}.sha256`, state: 'uploaded', size: 91 },
      ] } });
    });
    await page.goto(origin);
    await page.waitForFunction(version => document.querySelector('[data-mac-version]').textContent === version, version);
    assert.equal(await page.title(), 'Breezer: a calmer browser for Mac');
    assert.match(await page.locator('main .release').first().textContent(), new RegExp(`Breezer ${version.replaceAll('.', '\\.')} for Mac`));
    assert.equal(await page.locator('video, a[href="#videos"]').count(), 0);
    assert.equal((await page.request.get(`${origin}/videos/breezer-01-blink.mp4`)).status(), 404);
    await page.screenshot({ path: `${evidence}/home-desktop.png` });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${evidence}/home-mobile.png` });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${origin}/download`);
    await page.waitForFunction(version => document.querySelector('[data-mac-version]').textContent === version, version);
    assert.equal(await page.locator('.release').innerText(), `Version ${version}`);
    assert.equal(await page.getByRole('link', { name: 'Download Breezer', exact: true }).getAttribute('href'),
      `https://github.com/etphli/breezer/releases/download/${tag}/Breezer-${tag}-arm64.dmg`);
    assert.equal(await page.getByRole('link', { name: 'Release notes', exact: true }).getAttribute('href'),
      `https://github.com/etphli/breezer/releases/tag/${tag}`);
    assert.equal(await page.locator('#sha').textContent(), sha);
    assert.equal(requests, 1, 'homepage and download reuse the same validated release');
    const fallback = await browser.newPage();
    await fallback.route(apiURL, route => route.fulfill({ json: { tag_name: 'v2.0.0', assets: [
      { name: 'Breezer-v2.0.0-arm64.dmg', state: 'uploaded', size: 2026, digest: `sha256:${sha}` },
      { name: 'Breezer-v2.0.0-arm64.dmg.sha256', state: 'starter', size: 0 },
    ] } }));
    const incomplete = fallback.waitForResponse(apiURL);
    await fallback.goto(`${origin}/download`);
    await incomplete;
    await fallback.waitForLoadState('networkidle');
    assert.match(await fallback.locator('[data-download]').getAttribute('href'), /\/v1\.3\.1\//);
    assert.equal(await fallback.locator('#sha').textContent(), 'd4cea26348d3ad2c388b21511bb726ed1de5adc28bd30050ceda4da29af1b4e7');
    await fallback.close();
    await page.getByRole('link', { name: 'Privacy policy', exact: true }).click();
    await page.getByRole('heading', { name: 'Your browsing. Your business.' }).waitFor();
    assert.equal(await page.locator('article section').count(), 9);
    await page.screenshot({ path: `${evidence}/privacy-desktop.png`, fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${evidence}/privacy-mobile.png`, fullPage: true });
    await page.setViewportSize({ width: 1440, height: 1050 });
    await page.goto(`${origin}/dashboard`); await page.waitForFunction(() => document.querySelector('#downloads').textContent === '14');
    assert.equal(await page.locator('#mau').innerText(), '0'); assert.equal(await page.locator('#hours').innerText(), '0');
    assert.equal(await page.locator('#empty').isVisible(), true); assert.equal(await page.locator('#chart rect').count(), 30);
    await page.screenshot({ path: `${evidence}/dashboard-desktop.png`, fullPage: true });
    fail = true; await page.getByRole('button', { name: 'Refresh data' }).click(); await page.locator('#error').waitFor({ state: 'visible' });
    assert.equal(await page.locator('#downloads').innerText(), '14');
    fail = false; await page.getByRole('button', { name: 'Refresh data' }).click(); await page.locator('#error').waitFor({ state: 'hidden' });
    fixture.series.at(-1).seconds = 7200; fixture.series.at(-1).users = 2; fixture.seconds = 7200; fixture.mau = 2;
    await page.getByRole('button', { name: 'Refresh data' }).click(); await page.waitForFunction(() => document.querySelector('#hours').textContent === '2');
    assert.equal(await page.locator('#empty').isVisible(), false);
    await page.getByText('View daily measurements', { exact: true }).click(); assert.equal(await page.locator('#daily tr').count(), 30);
    await page.setViewportSize({ width: 390, height: 844 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({ path: `${evidence}/dashboard-mobile.png`, fullPage: true });
    await page.goto(`${origin}/settings-test`); const control = page.getByRole('checkbox'); await control.waitFor(); await page.waitForFunction(() => !document.querySelector('#usage-enabled').disabled);
    assert.equal(await control.isChecked(), true); await control.focus(); await page.keyboard.press('Space');
    await page.waitForFunction(() => window.saved['breezer.usage.enabled'] === false); assert.equal(await control.isChecked(), false);
    await page.keyboard.press('Space'); await page.waitForFunction(() => window.saved['breezer.usage.enabled'] === true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
});
