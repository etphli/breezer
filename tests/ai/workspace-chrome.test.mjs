import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';

import { windowsUpdate } from '../../features/ai/extension/workspace-chrome.js';
import { seed, installFixture } from './workspace-browser-fixture.mjs';

const installer = 'Breezer-Windows-x64-Setup.exe';
const download = `https://github.com/etphli/breezer/releases/download/v1.3.6/${installer}`;
const asset = (name, url) => ({ state: 'uploaded', size: 128, name, browser_download_url: url });
const available = {
  draft: false, prerelease: false, tag_name: 'v1.3.6',
  assets: [
    { ...asset(installer, download), digest: 'sha256:' + 'a'.repeat(64) },
    asset(installer + '.sha256', download + '.sha256'),
  ],
};

test('Windows update notices require a newer stable release and both complete installer assets', () => {
  assert.deepEqual(windowsUpdate(available, '1.3.5'), { version: '1.3.6', download });
  for (const patch of [{ draft: true }, { prerelease: true }, { tag_name: 'v1.3.6-beta.1' }]) {
    assert.equal(windowsUpdate({ ...available, ...patch }, '1.3.5'), null);
  }
  assert.equal(windowsUpdate(available, '1.3.6'), null);
  assert.equal(windowsUpdate(available, '1.4.0'), null);
  assert.equal(windowsUpdate({ ...available, assets: [available.assets[0]] }, '1.3.5'), null);
  for (const index of [0, 1]) for (const patch of [
    { state: 'starter' }, { size: 0 }, { browser_download_url: 'https://example.test/setup' },
  ]) {
    const assets = structuredClone(available.assets);
    Object.assign(assets[index], patch);
    assert.equal(windowsUpdate({ ...available, assets }, '1.3.5'), null);
  }
  assert.equal(windowsUpdate({ ...available, assets: [
    { ...available.assets[0], digest: 'sha256:unavailable' }, available.assets[1],
  ] }, '1.3.5'), null);
});

let chromium;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const executablePath = process.env.BREEZER_TEST_BROWSER
  || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const skip = !chromium ? 'playwright is not installed' : executablePath && !existsSync(executablePath) && 'browser is missing';
const contentTypes = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css' };

test('sidebar checks once, offers restart after a validated reply, and opens the native address bar only when enabled', { skip }, async () => {
  const root = resolve('features/ai/extension');
  const server = createServer(async (req, res) => {
    const path = resolve(root, '.' + new URL(req.url, 'http://127.0.0.1').pathname);
    try {
      if (!path.startsWith(root + '/')) throw new Error('Outside fixture');
      const content = await readFile(path);
      res.setHeader('Content-Type', contentTypes[extname(path)] || 'application/octet-stream');
      res.end(content);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 230, height: 720 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript({ content: `
      (${installFixture})(${JSON.stringify({ seed: seed(), bridge: true })});
      const event = () => {
        const listeners = [];
        return { addListener: fn => listeners.push(fn), emit: data => listeners.forEach(fn => fn(data)) };
      };
      window.updatePort = {
        sent: [],
        onMessage: event(),
        onDisconnect: event(),
        postMessage: msg => updatePort.sent.push(msg),
        disconnect() {},
      };
      chrome.runtime.connect = () => updatePort;
      chrome.breezerPrivate.focusLocationBar = callback => {
        fx.calls.push(['focusLocationBar']);
        callback();
      };
    ` });
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    const address = page.getByRole('button', { name: 'Open the address bar' });
    const restart = page.getByRole('button', { name: 'Restart', exact: true });
    assert.equal(await address.isVisible(), false);
    assert.equal(await restart.isVisible(), false);
    await page.waitForFunction(() => updatePort.sent.length === 1);
    assert.equal(await page.evaluate(() => updatePort.sent[0].type), 'update-check');
    await page.evaluate(() => updatePort.onMessage.emit({
      id: updatePort.sent[0].id, ok: true, value: { available: true, version: '1.3.6' },
    }));
    await restart.waitFor();
    assert.equal(await page.locator('#sidebar-update-status').textContent(), 'Update ready');
    assert.equal(await page.evaluate(() => updatePort.sent.length), 1);
    await restart.click();
    assert.deepEqual(await page.evaluate(() => updatePort.sent.map(value => value.type)), ['update-check', 'update-install']);
    await page.evaluate(() => updatePort.onDisconnect.emit());
    await page.getByRole('button', { name: 'Check again' }).waitFor();
    assert.equal(await restart.isVisible(), false);
    assert.equal(await page.evaluate(() => updatePort.sent.length), 2, 'installation never replays');
    await page.evaluate(() => chrome.storage.local.set({ breezerExperiments: { sidebarSearch: true } }));
    await address.click();
    assert.equal(await page.evaluate(() => fx.calls.filter(([name]) => name === 'focusLocationBar').length), 1);
    await page.evaluate(() => chrome.storage.local.set({ breezerExperiments: { sidebarSearch: false } }));
    await address.waitFor({ state: 'hidden' });
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally { await new Promise(resolve => server.close(resolve)); }
  }
});
