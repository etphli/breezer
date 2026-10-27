import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Sidebar text size and the title bar band, on the shipped workspace.html with a
// minimal chrome.* fixture. The native side (window controls over the band,
// window dragging, resize edge) needs the compiled browser.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

function installFixture(appearance) {
  const tabs = [
    ['Inbox · Linear', 'https://linear.app/breezer/inbox'],
    ['Sidebar and themes', 'https://docs.breezer.dev/sidebar'],
    ['Arc-style sidebar · Pull request #42', 'https://github.com/etphli/breezer/pull/42'],
    ['Miso glazed aubergine', 'https://recipes.example.com/miso'],
  ].map(([title, url], index) => ({ id: index + 1, windowId: 7, index, title, url, active: index === 2, pinned: false, status: 'complete' }));
  const data = { local: {}, session: {} };
  const event = () => ({ addListener() {}, removeListener() {} });
  const area = (name) => ({
    async get(keys) {
      const list = keys == null ? Object.keys(data[name]) : [keys].flat();
      return structuredClone(Object.fromEntries(list.filter((key) => key in data[name]).map((key) => [key, data[name][key]])));
    },
    async set(values) { Object.assign(data[name], structuredClone(values)); },
  });
  window.chrome = {
    runtime: { getURL: (path) => `${location.origin}/${path}`, getManifest: () => ({}), onMessage: event(), lastError: undefined },
    windows: { getCurrent: async () => ({ id: 7 }), update: async (id) => ({ id }) },
    storage: { local: area('local'), session: area('session'), onChanged: event() },
    tabs: {
      onCreated: event(), onUpdated: event(), onRemoved: event(), onActivated: event(), onMoved: event(),
      onAttached: event(), onDetached: event(), onReplaced: event(),
      async query(filter = {}) { return structuredClone(tabs.filter((tab) => filter.active === undefined || tab.active === filter.active)); },
      async get(id) { return structuredClone(tabs.find((tab) => tab.id === id)); },
    },
    breezerPrivate: {
      async getAppearance() { return structuredClone(appearance); },
      async setAppearance(patch) { Object.assign(appearance, patch); return structuredClone(appearance); },
      async setSidebarCollapsed() {},
    },
  };
}

const APPEARANCE = { layout: 'sidebar', sidebarMode: 'expanded', theme: 'graphite', colorMode: 'dark', showBookmarks: true, sidebarWidth: 240 };

// A full-height sidebar beside the toolbar, with the window controls drawn over
// the sidebar's top band as the browser does.
const WINDOW_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#1a1c20;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#e4e6e9}
  .frame{position:relative;display:grid;grid-template-columns:240px 1fr;grid-template-rows:40px 1fr;height:100vh}
  iframe{grid-row:1/3;border:0;width:240px;height:100%}
  .toolbar{display:flex;align-items:center;gap:14px;padding:0 14px}
  .omni{flex:1;height:28px;border-radius:8px;background:#ffffff14;display:flex;align-items:center;padding:0 12px;color:#a8aeb6}
  .page{margin:0 6px 6px 0;border-radius:10px;background:#26292f;padding:40px 56px}
  .lights{position:absolute;left:14px;top:14px;display:flex;gap:8px}.lights i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.lights i+i{background:#febc2e}.lights i+i+i{background:#28c840}
</style></head><body><div class="frame">
  <iframe src="/workspace.html#/sidebar?w=7" title="Breezer sidebar"></iframe>
  <div class="toolbar"><span>‹ ›</span><div class="omni">github.com/etphli/breezer/pull/42</div></div>
  <div class="page"><h1>Pull request #42</h1></div>
  <div class="lights" aria-hidden="true"><i></i><i></i><i></i></div>
</div></body></html>`;

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/__window.html') { response.setHeader('Content-Type', 'text/html'); response.end(WINDOW_HTML); return; }
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

// The band height the native view reports through env(titlebar-area-height).
const setBand = (frame, px) => frame.evaluate((value) => document.getElementById('sidebar').style.setProperty('--titlebar-h', value), `${px}px`);

const metrics = (frame) => frame.evaluate(() => {
  const row = document.querySelector('#today [role="treeitem"]');
  const title = row.querySelector('.title');
  const sidebar = document.getElementById('sidebar');
  const first = [...sidebar.children].find((child) => child.getClientRects().length).getBoundingClientRect();
  return {
    fontSize: parseFloat(getComputedStyle(title).fontSize),
    rowHeight: row.getBoundingClientRect().height,
    contentTop: Math.round(first.top),
    bottom: Math.round(document.querySelector('.dock').getBoundingClientRect().bottom),
  };
});

test('sidebar text follows sidebarFontSize and content clears the title bar band', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  const errors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 240, height: 640 }, deviceScaleFactor: 2 });
    await context.addInitScript(installFixture, APPEARANCE);
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/workspace.html#/sidebar?w=7`);
    await page.getByRole('treeitem', { name: /Pull request #42/ }).waitFor();

    // Default: 15 px text, no band outside a full-height window.
    const initial = await metrics(page);
    assert.equal(initial.fontSize, 15);
    assert.equal(initial.rowHeight, 34);
    assert.ok(initial.contentTop <= 12, `content starts at the top without a band (${initial.contentTop})`);
    assert.equal(initial.bottom, 640, 'dock reaches the bottom edge');

    // The appearance value drives the size, within the native 12–20 range.
    const apply = (value) => page.evaluate(async (size) => {
      const { applyAppearance } = await import('/workspace.js');
      applyAppearance({ ...(await chrome.breezerPrivate.getAppearance()), sidebarFontSize: size });
    }, value);
    for (const [value, expected] of [[18, 18], [12, 12], [20, 20], [40, 15], [16.5, 15], ['18', 15]]) {
      await apply(value);
      assert.equal((await metrics(page)).fontSize, expected, `sidebarFontSize ${JSON.stringify(value)}`);
    }
    await apply(20);
    const large = await metrics(page);
    assert.equal(large.rowHeight, 44, 'rows grow with the text');
    assert.ok(await page.evaluate(() => {
      const title = document.querySelector('#today .title');
      return title.scrollHeight <= title.parentElement.getBoundingClientRect().height;
    }), 'large text fits its row');
    await apply(15);

    // A 38 px band pushes the first content below the window controls, and the
    // dock still ends at the bottom edge.
    await setBand(page, 38);
    const banded = await metrics(page);
    assert.ok(banded.contentTop >= 38, `content clears the band (${banded.contentTop})`);
    assert.equal(banded.bottom, 640);
    await page.screenshot({ path: `${evidence}/sidebar-frame-band.png` });

    // Whole-window composition: one surface from the window top, controls on it.
    const windowPage = await context.newPage();
    windowPage.on('pageerror', (error) => errors.push(error.message));
    await windowPage.setViewportSize({ width: 1100, height: 640 });
    await windowPage.goto(`${base}/__window.html`);
    const frame = windowPage.frameLocator('iframe');
    await frame.getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    const sidebarFrame = windowPage.frames().find((item) => item.url().includes('workspace.html'));
    await setBand(sidebarFrame, 40);
    await windowPage.waitForTimeout(300);
    await windowPage.screenshot({ path: `${evidence}/sidebar-frame-window.png` });
    await sidebarFrame.evaluate(async () => {
      const { applyAppearance } = await import('/workspace.js');
      applyAppearance({ ...(await chrome.breezerPrivate.getAppearance()), sidebarFontSize: 18 });
    });
    await windowPage.screenshot({ path: `${evidence}/sidebar-frame-window-18px.png` });

    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
});
