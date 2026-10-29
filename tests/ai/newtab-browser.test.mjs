import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Drives the shipped newtab.html in a real browser against a chrome.* fixture
// that answers the 'breezer-newtab' port. Sites and items below are test data.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

const NOW = new Date(2026, 9, 29, 10, 0);
const at = (days, hour = null) => {
  if (hour == null) {
    const day = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  }
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days, hour).toISOString();
};

const SITES = [
  ['Mail', 'https://mail.example.com/'], ['Canvas', 'https://canvas.example.edu/'], ['Docs', 'https://docs.example.com/'],
  ['Calendar', 'https://calendar.example.com/'], ['News', 'https://news.example.org/'], ['Music', 'https://music.example.com/'],
  ['Maps', 'https://maps.example.com/'], ['Library', 'https://library.example.edu/'], ['Ninth', 'https://ninth.example.com/'],
].map(([title, url]) => ({ title, url }));

const CONNECTED = {
  topSites: SITES,
  organato: {
    enabled: true, connected: true, error: null,
    exams: [
      { id: 'e1', title: 'Chemistry unit 3 test', dueAt: at(1, 9), subject: 'Chemistry' },
      { id: 'e2', title: 'Spanish oral exam', dueAt: at(6, 13), subject: 'Spanish' },
    ],
    assignments: [
      { id: 'a0', title: 'Reading reflection', dueAt: at(-1), subject: 'English' },
      { id: 'a1', title: 'History essay draft', dueAt: at(0, 23), subject: 'History', url: 'https://canvas.example.edu/a1' },
      { id: 'a2', title: 'Lab report: titration', dueAt: at(3, 17), subject: 'Chemistry' },
      { id: 'a3', title: 'Problem set 7', dueAt: at(9), subject: 'Maths' },
    ],
    todos: [
      { id: 't1', title: 'Email group about slides', dueAt: at(0) },
      { id: 't2', title: 'Return library books' },
    ],
  },
};

function installFixture({ view, appearance, delay = 0, hang = false }) {
  window.fx = { requests: [] };
  const port = (name) => {
    const listeners = { message: [], disconnect: [] };
    return {
      name,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage(message) {
        window.fx.requests.push({ name, ...message });
        if (hang) return;
        setTimeout(() => listeners.message.forEach((fn) => fn({ type: 'view', id: message.id, ...structuredClone(view) })), delay);
      },
      disconnect() {},
    };
  };
  window.chrome = {
    runtime: {
      connect: ({ name }) => port(name),
      getURL: (path) => `${location.origin}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ permissions: ['favicon'] }),
      lastError: undefined,
    },
    storage: { onChanged: { addListener() {} } },
    ...(appearance ? { breezerPrivate: { getAppearance: async () => appearance } } : {}),
  };
}

const COLORS = ['#1a73e8', '#c2410c', '#0f766e', '#7c3aed', '#be123c', '#15803d', '#b45309', '#334155', '#0e7490'];
function favicon(pageUrl) {
  const host = new URL(pageUrl).hostname;
  const color = COLORS[[...host].reduce((sum, c) => sum + c.charCodeAt(0), 0) % COLORS.length];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-family="Helvetica" font-size="17" font-weight="700" text-anchor="middle" fill="#fff">${host[0].toUpperCase()}</text></svg>`;
}

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/_favicon/') {
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end(favicon(url.searchParams.get('pageUrl')));
        return;
      }
      const path = resolve(root, `.${url.pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      const content = await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' })[extname(path)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

async function withPage(browser, base, options, fn) {
  const { viewport = { width: 1440, height: 900 }, colorScheme = 'light', reducedMotion = 'reduce', ...fixture } = options;
  const context = await browser.newContext({ viewport, colorScheme, reducedMotion, locale: 'en-US' });
  await context.addInitScript(installFixture, fixture);
  const page = await context.newPage();
  await page.clock.setFixedTime(NOW);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${message.text()} ${message.location().url}`); });
  try {
    await page.goto(`${base}/newtab.html`);
    await fn(page);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

test('new tab renders sites and Organato lanes across states', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    await withPage(browser, base, { view: CONNECTED, appearance: { theme: 'mint', colorMode: 'light' } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      await page.waitForFunction(() => document.querySelectorAll('.site-icon.has-icon').length === 8);
      assert.equal(await page.textContent('#today'), 'Thursday, October 29');
      assert.deepEqual(await page.evaluate(() => window.fx.requests.map(({ name, type, refresh }) => ({ name, type, refresh }))), [{ name: 'breezer-newtab', type: 'view', refresh: false }]);

      // One row, at about the upper third.
      const tops = await page.$$eval('.site', (items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
      assert.equal(tops.length, 8);
      assert.equal(new Set(tops).size, 1);
      assert.ok(tops[0] > 900 * 0.18 && tops[0] < 900 * 0.4, `sites row at ${tops[0]}px`);
      assert.equal(await page.getAttribute('.site-link', 'href'), 'https://mail.example.com/');

      assert.equal(await page.getAttribute('#organato', 'data-state'), 'ready');
      assert.equal(await page.isHidden('#organato-status'), true);
      assert.deepEqual(await page.$$eval('[data-count]', (nodes) => nodes.map((node) => node.textContent)), ['2', '4', '2']);
      const first = await page.$$eval('[data-list="assignments"] .item', (rows) => rows.map((row) => [row.dataset.urgency, row.querySelector('.item-when').textContent]));
      assert.deepEqual(first.map(([u]) => u), ['overdue', 'today', 'soon', 'later']);
      assert.equal(first[0][1], 'Due yesterday');
      assert.equal(await page.getAttribute('[data-list="assignments"] a.item-title', 'href'), 'https://canvas.example.edu/a1');
      assert.equal(await page.textContent('[data-list="todos"] .item:last-child .item-when'), 'No due date');
      await page.screenshot({ path: `${evidence}/newtab-connected-light.png` });

      // Keyboard: the first stop is Settings, then the sites in order.
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), 'workspace.html#/settings');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), 'https://mail.example.com/');
      await page.screenshot({ path: `${evidence}/newtab-keyboard-focus.png`, clip: { x: 0, y: 0, width: 1440, height: 460 } });
      // Refresh asks exactly once more and never on its own.
      await page.click('#refresh');
      await page.waitForFunction(() => window.fx.requests.length === 2);
      assert.equal(await page.evaluate(() => window.fx.requests[1].refresh), true);
      await page.waitForTimeout(400);
      assert.equal(await page.evaluate(() => window.fx.requests.length), 2);

    });

    await withPage(browser, base, { view: CONNECTED, appearance: { theme: 'tide', colorMode: 'dark' } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      assert.deepEqual(await page.evaluate(() => [document.documentElement.dataset.tone, document.documentElement.dataset.scheme]), ['tide', 'dark']);
      await page.waitForFunction(() => document.querySelectorAll('.site-icon.has-icon').length === 8);
      await page.screenshot({ path: `${evidence}/newtab-connected-dark-tide.png` });
    });

    // Without the bridge the OS scheme is followed.
    await withPage(browser, base, { view: CONNECTED, colorScheme: 'dark' }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      assert.equal(await page.evaluate(() => document.documentElement.dataset.scheme), 'dark');
    });

    await withPage(browser, base, { view: CONNECTED, viewport: { width: 420, height: 860 } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      const visible = await page.$$eval('.site', (items) => items.filter((item) => item.offsetParent).map((item) => Math.round(item.getBoundingClientRect().top)));
      assert.equal(visible.length, 4);
      assert.equal(new Set(visible).size, 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 420), true);
      await page.screenshot({ path: `${evidence}/newtab-narrow.png`, fullPage: true });
    });

    await withPage(browser, base, { view: { topSites: SITES.slice(0, 5), organato: { enabled: true, connected: false } } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      assert.equal(await page.getAttribute('#organato', 'data-state'), 'setup');
      assert.equal(await page.getAttribute('#organato-action a', 'href'), 'workspace.html#/settings');
      assert.match(await page.textContent('#organato-status'), /Connect Organato/);
      await page.screenshot({ path: `${evidence}/newtab-setup.png` });
    });

    await withPage(browser, base, { view: { topSites: [], organato: { enabled: true, connected: true, error: 'The API key was rejected (401).' } } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      assert.equal(await page.getAttribute('#organato', 'data-state'), 'error');
      assert.equal(await page.isVisible('#sites-empty'), true);
      assert.match(await page.textContent('#organato-status'), /API key was rejected/);
      await page.screenshot({ path: `${evidence}/newtab-error.png` });
    });

    await withPage(browser, base, { view: { topSites: [], organato: { enabled: false } } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      assert.equal(await page.getAttribute('#organato', 'data-state'), 'disabled');
    });

    // Loading, then a bounded wait when the background never answers.
    await withPage(browser, base, { view: CONNECTED, hang: true }, async (page) => {
      assert.equal(await page.getAttribute('#organato', 'aria-busy'), 'true');
      assert.equal(await page.$$eval('.site.placeholder', (items) => items.length), 8);
      await page.screenshot({ path: `${evidence}/newtab-loading.png` });
      await page.waitForSelector('html[data-loaded="true"]', { timeout: 70000 });
      assert.equal(await page.getAttribute('#organato', 'data-state'), 'unavailable');
      assert.match(await page.textContent('#organato-status'), /too long.*Refresh/);
    });

    // Hostile values stay text; unsafe URLs never become links.
    const hostile = {
      topSites: [{ title: '<img src=x onerror=alert(1)>', url: 'https://x.example/' }, { title: 'Script', url: 'javascript:alert(1)' }],
      organato: { connected: true, exams: [{ title: '<script>alert(1)</script>', dueAt: at(2), url: 'javascript:alert(1)', subject: '<b>bold</b>' }] },
    };
    await withPage(browser, base, { view: hostile }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      assert.equal(await page.$$eval('.site', (items) => items.length), 1);
      assert.equal(await page.textContent('.site-name'), '<img src=x onerror=alert(1)>');
      assert.equal(await page.$('[data-list="exams"] a'), null);
      assert.equal(await page.textContent('[data-list="exams"] .item-title'), '<script>alert(1)</script>');
      assert.equal(await page.$$eval('main script, main img, main b', (nodes) => nodes.length), 0);
    });
  } finally {
    await browser.close();
    server.close();
  }
});
