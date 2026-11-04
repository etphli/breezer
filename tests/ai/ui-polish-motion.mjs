// Record real custom-UI motion and verify Reduce motion, using disposable fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { installFixture as workspaceFixture, seed } from './workspace-browser-fixture.mjs';
import { installFixture as settingsFixture } from './settings-browser-fixture.mjs';
import { installFixture as newtabFixture, CONNECTED, NOW } from './newtab-browser-fixture.mjs';

const root = resolve('features/ai/extension');
const output = resolve(process.argv[2] || '/tmp/breezer-ui-motion');
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
const report = [];
try {
  for (const reducedMotion of ['no-preference', 'reduce']) for (const area of ['spaces', 'settings', 'newtab']) {
    const viewport = area === 'spaces' ? { width: 280, height: 820 } : { width: 1200, height: 900 };
    const context = await browser.newContext({ viewport, reducedMotion, recordVideo: { dir: output, size: viewport } });
    const page = await context.newPage();
    const video = page.video();
    if (area === 'spaces') {
      await page.addInitScript(workspaceFixture, { seed: seed(), bridge: true });
      await page.goto(`${base}/workspace.html#/sidebar?w=7`);
      await page.getByRole('tab', { name: /Personal/ }).click();
    } else if (area === 'settings') {
      await page.addInitScript(settingsFixture, { theme: 'mint', colorMode: 'light' });
      await page.goto(`${base}/workspace.html#/settings`);
      await page.getByRole('heading', { name: 'Bring your Chrome data to Breezer' }).waitFor();
    } else {
      await page.addInitScript(newtabFixture, { view: CONNECTED, appearance: { theme: 'mint', colorMode: 'light' }, delay: 400 });
      await page.clock.setFixedTime(NOW);
      await page.goto(`${base}/newtab.html`);
      await page.locator('.organato[data-state="ready"]').waitFor();
    }
    const animations = await page.evaluate(() => document.getAnimations().map(animation => ({ name: animation.animationName || 'transition', ...animation.effect.getTiming() })));
    if (reducedMotion === 'reduce') assert.equal(animations.length, 0, `${area} respects Reduce motion`);
    for (const elapsed of [0, 100, 250, 500]) {
      if (elapsed) await page.waitForTimeout(elapsed === 100 ? 100 : elapsed === 250 ? 150 : 250);
      await page.screenshot({ path: resolve(output, `${area}-${reducedMotion}-${elapsed}.png`) });
    }
    await page.waitForTimeout(600);
    await context.close();
    await video.saveAs(resolve(output, `${area}-${reducedMotion}.webm`));
    report.push({ area, reducedMotion, animations, note: 'Frame timestamps are elapsed after the UI action settled enough for its locator, not a guarantee of animation onset.' });
  }
  await writeFile(resolve(output, 'motion.json'), JSON.stringify(report, null, 2));
} finally { await browser.close(); await new Promise(done => server.close(done)); }
