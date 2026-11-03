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
    // As the background sends them: b1 is classified as both, so it is in
    // exams and assignments; t1 is a to-do the exam filter also picked up.
    exams: [
      { id: 't1', kind: 'todo', classification: 'checkpoint', title: 'Email group about slides', dueAt: at(0) },
      { id: 'e1', kind: 'work', classification: 'checkpoint', title: 'Chemistry unit 3 test', dueAt: at(1, 9), subject: 'Chemistry' },
      { id: 'b1', kind: 'work', classification: 'both', title: 'Biology field study presentation', dueAt: at(4), subject: 'Biology' },
      { id: 'e2', kind: 'work', classification: 'checkpoint', title: 'Spanish oral exam', dueAt: at(6, 13), subject: 'Spanish' },
    ],
    assignments: [
      { id: 'a0', kind: 'work', classification: 'assignment', title: 'Reading reflection', dueAt: at(-1), subject: 'English' },
      { id: 'a1', kind: 'work', classification: 'assignment', title: 'History essay draft', dueAt: at(0, 23), subject: 'History', url: 'https://canvas.example.edu/a1' },
      { id: 'a2', kind: 'work', classification: 'assignment', title: 'Lab report: titration', dueAt: at(3, 17), subject: 'Chemistry' },
      { id: 'b1', kind: 'work', classification: 'both', title: 'Biology field study presentation', dueAt: at(4), subject: 'Biology' },
      { id: 'a3', kind: 'work', classification: 'assignment', title: 'Problem set 7', dueAt: at(9), subject: 'Maths' },
    ],
    todos: [
      { id: 't1', kind: 'todo', classification: 'checkpoint', title: 'Email group about slides', dueAt: at(0) },
      { id: 't2', title: 'Return library books' },
    ],
  },
};

function installFixture({ view, appearance, delay = 0, hang = false, switches }) {
  // fx.view and fx.delay can be changed mid-test to script later answers.
  window.fx = { requests: [], view, delay };
  const port = (name) => {
    const listeners = { message: [], disconnect: [] };
    return {
      name,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage(message) {
        window.fx.requests.push({ name, ...message });
        if (hang) return;
        const answer = structuredClone(window.fx.view);
        setTimeout(() => listeners.message.forEach((fn) => fn({ type: 'view', id: message.id, ...answer })), window.fx.delay);
      },
      disconnect() {},
    };
  };
  const preferences = JSON.parse(localStorage.getItem('shortcut-fixture') || '{}');
  if (switches && !('organato.switches.v1' in preferences)) { preferences['organato.switches.v1'] = switches; localStorage.setItem('shortcut-fixture', JSON.stringify(preferences)); }
  const storageListeners = [];
  // chrome.storage is shared by every extension page; same-origin storage events
  // stand in for that, so a change in one tab reaches the others.
  window.addEventListener('storage', (event) => {
    if (event.key !== 'shortcut-fixture') return;
    const next = JSON.parse(event.newValue || '{}');
    const changes = {};
    for (const key of new Set([...Object.keys(preferences), ...Object.keys(next)])) {
      if (JSON.stringify(preferences[key]) !== JSON.stringify(next[key])) changes[key] = { oldValue: preferences[key], newValue: next[key] };
    }
    Object.keys(preferences).forEach((key) => delete preferences[key]);
    Object.assign(preferences, next);
    if (Object.keys(changes).length) for (const fn of storageListeners) fn(changes, 'local');
  });
  window.chrome = {
    tabs: { query: async () => [{ id: 5, title: 'Open project', url: 'https://project.example.com/' }, { id: 6, title: 'Internal', url: 'chrome://settings/' }] },
    runtime: {
      connect: ({ name }) => port(name),
      getURL: (path) => `${location.origin}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ permissions: ['favicon'] }),
      lastError: undefined,
    },
    storage: { local: { async get(key) { return { [key]: structuredClone(preferences[key]) }; }, async set(values) { Object.assign(preferences, structuredClone(values)); localStorage.setItem('shortcut-fixture', JSON.stringify(preferences)); for (const fn of storageListeners) fn(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), 'local'); } }, onChanged: { addListener(fn) { storageListeners.push(fn); }, removeListener(fn) { const index=storageListeners.indexOf(fn); if(index>=0) storageListeners.splice(index,1); } } },
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
    await fn(page, context);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

test('new tab renders sites and Organato lanes across states', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await withPage(browser, base, { view: CONNECTED, appearance: { theme: 'mint', colorMode: 'light' } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      await page.waitForFunction(() => document.querySelectorAll('.site-icon.has-icon').length === 8);
      assert.equal(await page.textContent('#today'), 'Thursday, October 29');
      assert.deepEqual(await page.evaluate(() => window.fx.requests.map(({ name, type, refresh }) => ({ name, type, refresh }))), [{ name: 'breezer-newtab', type: 'view', refresh: false }]);

      // One row, at about the upper third.
      const tops = await page.$$eval('.site:not(.site-add)', (items) => items.map((item) => Math.round(item.getBoundingClientRect().top)));
      assert.equal(tops.length, 8);
      assert.equal(new Set(tops).size, 1);
      assert.ok(tops[0] > 900 * 0.18 && tops[0] < 900 * 0.4, `sites row at ${tops[0]}px`);
      assert.equal(await page.getAttribute('.site-link', 'href'), 'https://mail.example.com/');

      assert.equal(await page.getAttribute('#organato', 'data-state'), 'ready');
      assert.equal(await page.isHidden('#organato-status'), true);
      // Two lanes only: one Upcoming list and To-dos, with no Exams/Assignments headings.
      assert.deepEqual(await page.$$eval('.lane-title', (nodes) => nodes.map((node) => node.firstChild.textContent.trim())), ['Upcoming', 'To-dos']);
      assert.deepEqual(await page.$$eval('[data-count]', (nodes) => nodes.map((node) => node.textContent)), ['7', '2']);
      const upcoming = await page.$$eval('[data-list="upcoming"] .item', (rows) => rows.map((row) => ({
        title: row.querySelector('.item-title').textContent,
        urgency: row.dataset.urgency,
        when: row.querySelector('.item-when').textContent,
        exam: Boolean(row.querySelector('.item-kind')),
      })));
      assert.deepEqual(upcoming.map(({ title }) => title), [
        'Reading reflection', 'History essay draft', 'Chemistry unit 3 test', 'Lab report: titration',
        'Biology field study presentation', 'Spanish oral exam', 'Problem set 7',
      ]);
      assert.deepEqual(upcoming.map(({ urgency }) => urgency), ['overdue', 'today', 'soon', 'soon', 'later', 'later', 'later']);
      assert.deepEqual(upcoming.map(({ exam }) => exam), [false, false, true, false, true, true, false]);
      assert.equal(upcoming[0].when, 'Due yesterday');
      assert.equal(upcoming[4].when, 'In 4 days, Nov 2');
      assert.equal(await page.getAttribute('[data-list="upcoming"] a.item-title', 'href'), 'https://canvas.example.edu/a1');
      assert.deepEqual(await page.$$eval('[data-list="todos"] .item-title', (nodes) => nodes.map((node) => node.textContent)), ['Email group about slides', 'Return library books']);
      // Each title appears once on the whole page.
      const titles = await page.$$eval('.item-title', (nodes) => nodes.map((node) => node.textContent));
      assert.equal(new Set(titles).size, titles.length);
      // Side by side on wide windows, Upcoming the wider of the two.
      const [wide, narrow] = await page.$$eval('.lane', (lanes) => lanes.map((lane) => lane.getBoundingClientRect()).map(({ top, width }) => ({ top, width })));
      assert.equal(wide.top, narrow.top);
      assert.ok(wide.width > narrow.width * 1.4, `lanes ${wide.width} / ${narrow.width}`);
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

    await withPage(browser, base, { view: CONNECTED }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      const mail = '.site-link[href="https://mail.example.com/"]';
      await page.getByRole('button', { name: 'Remove Mail shortcut', exact: true }).click();
      await page.waitForFunction(selector => !document.querySelector(selector), mail);
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.waitForSelector(mail);
      await page.getByRole('button', { name: 'Remove Mail shortcut', exact: true }).click();
      await page.waitForFunction(selector => !document.querySelector(selector), mail);
      assert.ok(page.url().includes('newtab.html'), 'Remove must not open the site');
      await page.reload();await page.waitForSelector('html[data-loaded="true"]');
      assert.equal(await page.locator(mail).count(), 0, 'removal persists after reload');
      const canvas = '.site-link[href="https://canvas.example.edu/"]';
      await page.locator(canvas).click({ button: 'right' });
      await page.keyboard.press('Escape');
      assert.equal(await page.evaluate(() => document.activeElement.href), 'https://canvas.example.edu/');
      await page.locator(canvas).click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Remove shortcut', exact: true }).click();
      await page.waitForFunction(selector => !document.querySelector(selector), canvas);
      await page.getByRole('button', { name: 'Restore shortcuts', exact: true }).click();
      await page.waitForSelector(mail);await page.waitForSelector(canvas);
      await page.route('https://mail.example.com/**', route => route.fulfill({ contentType: 'text/html', body: '<title>Mail fixture</title>Mail' }));
      const blockedClick = await page.evaluate(selector => {
        let prevented;
        document.addEventListener('click', event => {
          prevented = event.defaultPrevented;
          event.preventDefault();
        }, { once: true });
        document.querySelector(selector).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
        return prevented;
      }, mail);
      assert.equal(blockedClick, false, 'normal clicks keep immediate native link navigation');
      await Promise.all([page.waitForURL('https://mail.example.com/'), page.locator(mail).click()]);
      assert.equal(await page.title(), 'Mail fixture', 'single click still opens the site');
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
      const lanes = await page.$$eval('.lane', (nodes) => nodes.map((node) => node.getBoundingClientRect().top));
      assert.ok(lanes[1] > lanes[0], 'lanes stack on narrow windows');
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

    // Same titles with different IDs stay separate; a refresh error keeps the last items.
    const stale = {
      topSites: SITES.slice(0, 3),
      organato: {
        enabled: true, connected: true, error: 'Organato timed out. Try again.',
        exams: [{ id: 'q1', title: 'Weekly quiz', dueAt: at(2, 10), subject: 'Maths' }],
        assignments: [{ id: 'q2', title: 'Weekly quiz', dueAt: at(9, 10), subject: 'Maths' }, { id: 'q1', title: 'Weekly quiz', dueAt: at(2, 10), subject: 'Maths' }],
        todos: [],
      },
    };
    await withPage(browser, base, { view: stale }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      assert.equal(await page.getAttribute('#organato', 'data-state'), 'ready');
      assert.match(await page.textContent('#organato-status'), /Showing the last update.*timed out/);
      assert.deepEqual(await page.$$eval('[data-list="upcoming"] .item-when', (nodes) => nodes.map((node) => node.textContent)), ['In 2 days, Oct 31, 10:00 AM', 'In 9 days, Nov 7, 10:00 AM']);
      assert.equal(await page.textContent('[data-list="todos"] .item-empty'), 'Nothing on your to-do list.');
      await page.screenshot({ path: `${evidence}/newtab-stale-same-title.png` });
    });

    // A failed manual refresh keeps the merged list it already had.
    await withPage(browser, base, { view: CONNECTED }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      await page.evaluate(() => { const connect = window.chrome.runtime.connect; window.chrome.runtime.connect = () => { window.chrome.runtime.connect = connect; throw new Error('Breezer closed the connection.'); }; });
      await page.click('#refresh');
      await page.waitForFunction(() => /Showing the last update/.test(document.getElementById('organato-status').textContent));
      assert.equal(await page.$$eval('[data-list="upcoming"] .item', (rows) => rows.length), 7);
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
      assert.equal(await page.$$eval('.site:not(.site-add)', (items) => items.length), 1);
      assert.equal(await page.textContent('.site-name'), '<img src=x onerror=alert(1)>');
      assert.equal(await page.$('[data-list="upcoming"] a'), null);
      assert.equal(await page.textContent('[data-list="upcoming"] .item-title'), '<script>alert(1)</script>');
      assert.equal(await page.$$eval('main script, main img, main b', (nodes) => nodes.length), 0);
    });
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});


test('add shortcuts by URL and open tab, persist across reload and keep Add visible on narrow screens', { skip }, async () => {
 const server = await startServer(); const base = `http://127.0.0.1:${server.address().port}`;
 let browser;
 try {
   browser = await chromium.launch({ executablePath, headless: true });
   await withPage(browser, base, { view: CONNECTED }, async page => {
  await page.waitForSelector('html[data-loaded="true"]');
  await page.getByRole('button', { name: 'Add shortcut', exact: true }).click();
  await page.getByRole('combobox').fill('javascript:alert(1)');
  await page.getByRole('combobox').press('Enter');
  await page.waitForSelector('#shortcut-add-input[aria-invalid="true"]');
  await page.getByRole('combobox').fill('custom.example.com');
  await page.getByRole('combobox').press('Enter');
  await page.waitForSelector('.site-link[href="https://custom.example.com/"]');
  await page.reload(); await page.waitForSelector('.site-link[href="https://custom.example.com/"]');
  await page.getByRole('button', { name: 'Add shortcut', exact: true }).click();
  await page.getByRole('combobox').fill('Open project');
  await page.getByRole('option', {name: /Open project/}).waitFor();
  await page.getByRole('combobox').press('ArrowDown'); await page.getByRole('combobox').press('Enter');
  await page.waitForSelector('.site-link[href="https://project.example.com/"]');
  await page.setViewportSize({width:375,height:800});
  assert.equal(await page.getByRole('button', { name: 'Add shortcut', exact: true }).isVisible(),true);
  await page.getByRole('button', { name: 'Add shortcut', exact: true }).click();
  await page.getByRole('combobox').press('Escape');
  assert.equal(await page.locator('#shortcut-add').evaluate(x=>x.matches(':popover-open')), false);
  await page.setViewportSize({width:1440,height:900});
  await page.screenshot({path:`${evidence}/newtab-custom-shortcuts.png`});
  await page.getByRole('button', { name: 'Add shortcut', exact: true }).click();
  await page.getByRole('combobox').fill('project');
  await page.getByRole('option', {name: /Open project/}).waitFor();
  await page.screenshot({path:`${evidence}/newtab-add-popover.png`});
 }); } finally { try { await browser?.close(); } finally { await new Promise(done => server.close(done)); } }
});


// Organato off: the whole lower sheet goes, whatever the answer carries.
const OFF_SWITCHES = { enabled: false, dashboardEnabled: true };
const CACHED_OFF = { topSites: SITES.slice(0, 6), organato: { ...CONNECTED.organato, enabled: false, error: 'Old refresh failure' } };
async function organatoGone(page) {
  return page.evaluate(() => {
    const sheet = document.querySelector('.sheet');
    const top = document.getElementById('today').getBoundingClientRect().top;
    const bottom = document.getElementById('sites').getBoundingClientRect().bottom;
    return {
      hidden: sheet.hidden && sheet.getBoundingClientRect().height === 0,
      // Not visible, not read out, and nothing focusable inside.
      text: /Organato|Loading your exams|Refresh/.test(document.body.innerText),
      refreshVisible: Boolean(document.getElementById('refresh').offsetParent),
      flag: document.documentElement.dataset.organato,
      skyCentre: Math.round((top + bottom) / 2),
      height: innerHeight,
      overflow: document.documentElement.scrollWidth > innerWidth || document.documentElement.scrollHeight > innerHeight,
    };
  });
}
async function tabStops(page, count) {
  const stops = [];
  for (let at = 0; at < count; at += 1) {
    await page.keyboard.press('Tab');
    stops.push(await page.evaluate(() => document.activeElement.getAttribute('href') || document.activeElement.id || document.activeElement.textContent.trim()));
  }
  return stops;
}

test('Organato off removes the whole section and follows the switch live', { skip, timeout: 120_000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    // An "off" answer that still carries cached items, a connection and an error.
    await withPage(browser, base, { view: CACHED_OFF, appearance: { theme: 'mint', colorMode: 'light' } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      await page.waitForFunction(() => document.querySelectorAll('.site-icon.has-icon').length === 6);
      const state = await organatoGone(page);
      assert.deepEqual({ hidden: state.hidden, text: state.text, refreshVisible: state.refreshVisible, flag: state.flag, overflow: state.overflow }, { hidden: true, text: false, refreshVisible: false, flag: 'off', overflow: false });
      // The date and sites sit a little above the middle, not up top over a blank gap.
      assert.ok(state.skyCentre > state.height * 0.35 && state.skyCentre < state.height * 0.5, `sky centre ${state.skyCentre}`);
      assert.equal(await page.locator('.item, .item-empty, #organato-action a').count(), 0);
      assert.equal(await page.getByRole('heading', { name: /Organato/ }).count(), 0);
      assert.equal(await page.getByRole('status').filter({ hasText: /Organato/ }).count(), 0);
      // Keyboard: Settings, six sites (each with its remove button) and Add; then out of the page.
      const stops = await tabStops(page, 2);
      assert.deepEqual(stops, ['workspace.html#/settings', 'https://mail.example.com/']);
      await page.locator('.site-add-button').focus();
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.closest('.sheet')), null, 'nothing in the hidden sheet takes focus');
      await page.locator('.site-link').first().focus();
      await page.screenshot({ path: `${evidence}/newtab-organato-off-light.png` });
      // Shortcut controls still work with Organato off.
      await page.getByRole('button', { name: 'Remove Mail shortcut', exact: true }).click();
      await page.getByRole('button', { name: 'Undo', exact: true }).click();
      await page.waitForSelector('.site-link[href="https://mail.example.com/"]');
    });

    await withPage(browser, base, { view: CACHED_OFF, appearance: { theme: 'tide', colorMode: 'dark' } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      await page.waitForFunction(() => document.querySelectorAll('.site-icon.has-icon').length === 6);
      assert.equal((await organatoGone(page)).hidden, true);
      await page.screenshot({ path: `${evidence}/newtab-organato-off-dark.png` });
    });

    await withPage(browser, base, { view: CACHED_OFF, viewport: { width: 375, height: 760 } }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      const state = await organatoGone(page);
      assert.equal(state.hidden, true);
      assert.equal(state.overflow, false, 'no scrolling at 375px');
      assert.equal(await page.getByRole('button', { name: 'Add shortcut', exact: true }).isVisible(), true);
      await page.screenshot({ path: `${evidence}/newtab-organato-off-narrow.png` });
    });

    // A saved "off" hides the sheet before any answer, so loading never flashes it.
    await withPage(browser, base, { view: CONNECTED, hang: true, switches: OFF_SWITCHES }, async (page) => {
      await page.waitForFunction(() => document.documentElement.dataset.organato === 'off');
      assert.equal((await organatoGone(page)).hidden, true);
      assert.equal(await page.$$eval('.site.placeholder', (items) => items.length), 8);
    });

    // A saved "off" beats a late or mismatched answer that still says on, and survives reload.
    await withPage(browser, base, { view: CONNECTED, switches: OFF_SWITCHES }, async (page) => {
      await page.waitForSelector('html[data-loaded="true"]');
      assert.equal((await organatoGone(page)).hidden, true);
      await page.reload();
      await page.waitForSelector('html[data-loaded="true"]');
      assert.equal((await organatoGone(page)).hidden, true);
    });

    // Live: two open new tabs follow a switch made elsewhere, including over an in-flight answer.
    await withPage(browser, base, { view: CONNECTED }, async (page, context) => {
      await page.waitForSelector('html[data-loaded="true"]');
      const other = await context.newPage();
      await other.goto(`${base}/newtab.html`);
      await other.waitForSelector('html[data-loaded="true"]');
      for (const tab of [page, other]) assert.equal(await tab.getAttribute('#organato', 'data-state'), 'ready');

      // A slow refresh is on its way when Organato is turned off.
      await page.evaluate(() => { window.fx.delay = 600; });
      await page.click('#refresh');
      await page.evaluate((value) => window.chrome.storage.local.set({ 'organato.switches.v1': value }), OFF_SWITCHES);
      for (const tab of [page, other]) await tab.waitForFunction(() => document.querySelector('.sheet').hidden);
      await page.waitForFunction(() => document.getElementById('refresh').getAttribute('aria-busy') === null);
      await page.waitForTimeout(200);
      assert.equal((await organatoGone(page)).hidden, true, 'the late "on" answer does not bring it back');
      assert.equal((await organatoGone(other)).hidden, true);

      // Back on: the loading sheet shows, a fresh request goes out and the lanes return.
      const before = await other.evaluate(() => window.fx.requests.length);
      await page.evaluate(() => { window.fx.delay = 400; });
      await other.evaluate(() => { window.fx.delay = 400; });
      await page.evaluate(() => window.chrome.storage.local.set({ 'organato.switches.v1': { enabled: true, dashboardEnabled: true } }));
      await other.waitForFunction(() => !document.querySelector('.sheet').hidden && document.getElementById('organato').getAttribute('aria-busy') === 'true');
      assert.match(await other.textContent('#organato-status'), /Loading/);
      await other.screenshot({ path: `${evidence}/newtab-organato-reenabled-loading.png` });
      for (const tab of [page, other]) await tab.waitForFunction(() => document.getElementById('organato').dataset.state === 'ready');
      assert.equal(await other.evaluate(() => window.fx.requests.length), before + 1);
      assert.equal(await other.$$eval('[data-list="upcoming"] .item', (rows) => rows.length), 7);
      await other.close();
    });
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});
