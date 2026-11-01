// Shipped Passwords component with dummy tabs API. No native credential access.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || '../ai/node_modules/playwright/index.mjs');
const root = resolve(new URL('../..', import.meta.url).pathname);
const evidence = resolve(process.env.BREEZER_PASSKEY_EVIDENCE || 'build/passkeys/component');
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  try {
    const path = resolve(root, `.${new URL(req.url, 'http://localhost').pathname}`);
    if (!path.startsWith(root + sep)) throw new Error('Outside fixture');
    res.setHeader('Content-Type', ({ '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' })[extname(path)] || 'application/octet-stream');
    res.end(await readFile(path));
  } catch { res.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
let browser;
try {
  browser = await chromium.launch({ executablePath: process.env.BREEZER_TEST_BROWSER, headless: true });
  for (const [name, width, scheme] of [['desktop', 1280, 'light'], ['mobile', 360, 'dark']]) {
    const page = await browser.newPage({ viewport: { width, height: 1100 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/tests/passwords/component.html`);
    await page.waitForFunction(() => ['pass', 'fail'].includes(document.documentElement.dataset.result));
    assert.equal(await page.getAttribute('html', 'data-result'), 'pass');
    assert.deepEqual(errors, []);
    await page.evaluate(scheme => document.documentElement.dataset.scheme = scheme, scheme);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'horizontal overflow');
    await page.screenshot({ path: `${evidence}/${name}.png`, fullPage: true });
    await page.close();
  }
  console.log('PASS: shipped Passwords component; native route, signing/storage limits, pending/failure/dispose, desktop/mobile rendering. Dummy tabs API only.');
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
