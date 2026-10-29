import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drives the shipped whats-new.html in headless Chrome. release-info.js is
// served from the synthetic fixture below (Main ships the real one), and
// chrome.tabs is a recording stub. Nothing here launches the native app.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

const releaseInfo = (version) => `export const RELEASE = { version: ${JSON.stringify(version)}, title: 'A little more your browser' };\nexport const RELEASE_VERSION = RELEASE.version;\n`;

async function startServer() {
  let release = releaseInfo('1.1.0');
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/release-info.js') {
        if (release == null) throw new Error('No release info');
        response.setHeader('Content-Type', 'application/javascript');
        response.end(release);
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
  server.setRelease = (value) => { release = value; };
  return server;
}

function installFixture({ tabs }) {
  window.fx = { removed: [], closed: 0 };
  window.close = () => { window.fx.closed += 1; };
  if (tabs === 'current') {
    window.chrome = { tabs: { getCurrent: async () => ({ id: 42 }), remove: async (id) => { window.fx.removed.push(id); } } };
  } else if (tabs === 'failing') {
    window.chrome = { tabs: { getCurrent: async () => { throw new Error('No tab'); }, remove: async () => {} } };
  }
}

async function withPage(browser, base, options, fn) {
  const { viewport = { width: 1440, height: 900 }, reducedMotion = 'reduce', tabs = 'current' } = options;
  const context = await browser.newContext({ viewport, reducedMotion, colorScheme: 'dark', locale: 'en-US', deviceScaleFactor: 2 });
  await context.addInitScript(installFixture, { tabs });
  const page = await context.newPage();
  const errors = [];
  const foreign = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/release-info\.js|404/.test(message.text())) errors.push(message.text()); });
  page.on('request', (request) => { if (!request.url().startsWith(base)) foreign.push(request.url()); });
  try {
    await page.goto(`${base}/whats-new.html`);
    await page.waitForSelector('html[data-ready="true"]');
    await fn(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(foreign, [], 'no requests leave the extension');
  } finally {
    await context.close();
  }
}

// WCAG relative-luminance contrast between an element's text and the paper.
const contrast = (page, selector) => page.$eval(selector, (node) => {
  // color-mix() computes to color(srgb r g b) with 0-1 channels.
  const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map((c) => Number(c) * (value.startsWith('color(') ? 255 : 1));
  const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  let back = node;
  while (back && getComputedStyle(back).backgroundColor === 'rgba(0, 0, 0, 0)') back = back.parentElement;
  const [a, b] = [lum(rgb(getComputedStyle(node).color)), lum(rgb(getComputedStyle(back).backgroundColor))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
});

test('What\'s new page renders, closes its tab and opens Settings', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.textContent('#release-name'), 'Breezer 1.1.0');
      assert.equal(await page.title(), 'What\'s new in Breezer 1.1.0');
      assert.equal(await page.textContent('h1'), 'A little more your browser');
      assert.deepEqual(await page.$$eval('.feature h3', (nodes) => nodes.map((node) => node.textContent)),
        ['Organato on your new tab', 'Your own theme color', 'Password suggestions that stay put', 'Updates from Settings']);
      // Cream, even though the OS asks for dark.
      assert.equal(await page.$eval('body', (body) => getComputedStyle(body).backgroundColor), 'rgb(243, 235, 218)');
      for (const selector of ['h1', '.lede', '.feature-copy p', '.pending p', '.button.primary', '.button.secondary']) {
        const ratio = await contrast(page, selector);
        assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)}`);
      }
      // Illustrations are hidden from assistive tech and not focusable.
      assert.equal(await page.$$eval('.plate', (plates) => plates.every((plate) => plate.getAttribute('aria-hidden') === 'true')), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.screenshot({ path: `${evidence}/whats-new-desktop.png` });
      await page.screenshot({ path: `${evidence}/whats-new-desktop-full.png`, fullPage: true });

      // Keyboard: Continue browsing first, then Settings, with a visible ring.
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Continue browsing');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), 'workspace.html#/settings');
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
      await page.screenshot({ path: `${evidence}/whats-new-keyboard-focus.png`, clip: { x: 0, y: 0, width: 1440, height: 760 } });

      await page.click('.masthead [data-action="continue"]');
      await page.waitForFunction(() => window.fx.removed.length === 1);
      assert.deepEqual(await page.evaluate(() => window.fx), { removed: [42], closed: 0 });
    });

    // Settings opens in the same tab.
    await withPage(browser, base, {}, async (page) => {
      const pages = page.context().pages().length;
      await Promise.all([page.waitForURL(`${base}/workspace.html#/settings`), page.click('.closing a.button')]);
      assert.equal(page.context().pages().length, pages);
    });

    // Motion: the breeze draws once unless reduced motion is requested.
    await withPage(browser, base, { reducedMotion: 'no-preference' }, async (page) => {
      assert.equal(await page.$eval('.breeze-line', (line) => getComputedStyle(line).animationName), 'breeze');
      assert.equal(await page.$eval('.breeze-line', (line) => getComputedStyle(line).animationIterationCount), '1');
    });
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.$eval('.breeze-line', (line) => getComputedStyle(line).animationName), 'none');
      assert.equal(await page.$eval('.breeze-line', (line) => getComputedStyle(line).strokeDashoffset), '0px');
    });

    await withPage(browser, base, { viewport: { width: 390, height: 844 } }, async (page) => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true);
      const [plate, copy] = await page.$$eval('.feature:first-of-type > *', (nodes) => nodes.map((node) => node.getBoundingClientRect().top));
      assert.ok(copy > plate, 'feature stacks plate above text');
      await page.screenshot({ path: `${evidence}/whats-new-narrow.png` });
      await page.screenshot({ path: `${evidence}/whats-new-narrow-full.png`, fullPage: true });
    });

    // Not in a tab, or the tabs API fails: fall back to window.close(); if
    // that does nothing, say how to leave.
    await withPage(browser, base, { tabs: 'failing' }, async (page) => {
      await page.click('.closing [data-action="continue"]');
      await page.waitForSelector('#close-hint', { state: 'visible' });
      assert.deepEqual(await page.evaluate(() => window.fx), { removed: [], closed: 1 });
      assert.equal(await page.isEnabled('.closing [data-action="continue"]'), true);
      await page.screenshot({ path: `${evidence}/whats-new-close-refused.png`, fullPage: true });
    });
    await withPage(browser, base, { tabs: 'none' }, async (page) => {
      await page.click('.masthead [data-action="continue"]');
      await page.waitForFunction(() => window.fx.closed === 1);
    });

    // Missing or hostile release info falls back to the plain name as text.
    server.setRelease(null);
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.textContent('#release-name'), 'Breezer');
      assert.equal(await page.title(), 'What\'s new in Breezer');
    });
    server.setRelease(releaseInfo('<img src=x onerror=alert(1)>'));
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.textContent('#release-name'), 'Breezer');
      assert.equal(await page.$$eval('.release img', (images) => images.length), 1);
    });
  } finally {
    await browser.close();
    server.close();
  }
});
