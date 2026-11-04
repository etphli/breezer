import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { installFixture, seed } from './workspace-browser-fixture.mjs';

const root = resolve('features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const themes = ['mint', 'tide', 'dusk', 'rose', 'pollen', 'graphite'];
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium;
try { ({ chromium } = await import('playwright')); } catch { /* Browser job installs it; static CI does not. */ }
const skip = !chromium ? 'Playwright is not installed' : executablePath && !existsSync(executablePath) ? `No browser at ${executablePath}` : false;

test('all themes keep settings readable and sidebar font boundaries usable', { skip }, async () => {
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ headless: true, executablePath });
    await mkdir(evidence, { recursive: true });
    for (const colorMode of ['light', 'dark']) for (const theme of themes) {
      const context = await browser.newContext({ viewport: { width: 1200, height: 860 }, colorScheme: colorMode, reducedMotion: 'reduce' });
      await context.addInitScript(installFixture, { seed: seed(), bridge: true });
      await context.addInitScript(({ theme, colorMode }) => Object.assign(window.fx.appearance, { theme, colorMode }), { theme, colorMode });
      const page = await context.newPage();
      await page.goto(`${base}/workspace.html#/settings/appearance`);
      await page.getByRole('radio', { name: 'Mint', exact: true }).waitFor();
      await page.waitForFunction(({ theme, colorMode }) => document.documentElement.dataset.tone === theme && document.documentElement.dataset.scheme === colorMode, { theme, colorMode });
      const contrast = await page.evaluate(() => {
        const canvas = document.createElement('canvas');
        canvas.width = canvas.height = 1;
        const ctx = canvas.getContext('2d');
        const rgb = color => { ctx.clearRect(0, 0, 1, 1); ctx.fillStyle = color; ctx.fillRect(0, 0, 1, 1); return [...ctx.getImageData(0, 0, 1, 1).data].slice(0, 3); };
        const luminance = color => rgb(color).map(v => { v /= 255; return v <= .04045 ? v / 12.92 : ((v + .055) / 1.055) ** 2.4; }).reduce((sum, v, i) => sum + v * [.2126, .7152, .0722][i], 0);
        const ratio = (text, background) => { const [a, b] = [luminance(text), luminance(background)].sort((a, b) => b - a); return (a + .05) / (b + .05); };
        const description = document.querySelector('.settings-page:not([hidden]) .setting-row small');
        const nav = document.querySelector('.nav-item:not([aria-current])');
        return {
          description: ratio(getComputedStyle(description).color, getComputedStyle(description.closest('.setting-group')).backgroundColor),
          navigation: ratio(getComputedStyle(nav).color, getComputedStyle(nav.closest('.settings-nav')).backgroundColor),
        };
      });
      for (const [name, ratio] of Object.entries(contrast)) assert.ok(ratio >= 4.5, `${theme}/${colorMode} ${name} contrast ${ratio}`);
      await page.screenshot({ path: `${evidence}/theme-${theme}-${colorMode}.png` });
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${theme}/${colorMode} settings overflow`);
      await context.close();
    }
    for (const fontSize of [12, 15, 20]) {
      const context = await browser.newContext({ viewport: { width: 240, height: 820 } });
      await context.addInitScript(installFixture, { seed: seed(), bridge: true });
      await context.addInitScript(value => { window.fx.appearance.sidebarFontSize = value; }, fontSize);
      const page = await context.newPage();
      await page.goto(`${base}/workspace.html#/sidebar?w=7`);
      const row = page.locator('#today [data-key="t:3"]');
      await row.waitFor();
      assert.equal(await row.locator('.title').evaluate(node => parseFloat(getComputedStyle(node).fontSize)), fontSize);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${fontSize}px sidebar overflow`);
      const dock = await page.locator('.dock').boundingBox();
      assert.ok(dock.y >= 0 && dock.y + dock.height <= 820, `${fontSize}px footer reachable`);
      await context.close();
    }
  } finally {
    await browser?.close();
    await new Promise(done => server.close(done));
  }
});
