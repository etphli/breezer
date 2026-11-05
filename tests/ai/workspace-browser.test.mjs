import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed, installFixture } from './workspace-browser-fixture.mjs';

// Drives the shipped workspace.html in a real browser against a deterministic
// chrome.* fixture (tabs, storage, breezerPrivate). Native hosting is separate.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

const WINDOW_HTML = `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#ddf2eb;font:13px -apple-system,BlinkMacSystemFont,sans-serif;color:#17302c}
  .frame{display:grid;grid-template-columns:240px 1fr 360px;grid-template-rows:40px 28px 1fr;height:100vh}
  .toolbar,.bookmarks{grid-column:1/3;display:flex;align-items:center;gap:14px;padding:0 14px}
  .lights{display:flex;gap:8px}.lights i{width:12px;height:12px;border-radius:50%;background:#ff5f57}.lights i+i{background:#febc2e}.lights i+i+i{background:#28c840}
  .omni{flex:1;height:28px;border-radius:8px;background:#ffffffaa;display:flex;align-items:center;padding:0 12px;color:#4a605b}
  .bookmarks span{color:#4a605b;font-size:12px}
  iframe{border:0;width:240px;height:100%;grid-row:3}
  .page{grid-row:3;margin:0 6px 6px 0;border-radius:10px;background:#fff;box-shadow:0 0 0 .5px #17302c22,0 1px 3px #17302c18;padding:40px 56px}
  .page h1{font-size:26px;margin:0 0 6px}.page p{color:#4a605b;max-width:60ch;line-height:1.6}
  .ai{grid-row:1/4;grid-column:3;background:#f5f7f9;border-left:1px solid #17302c14;padding:24px;color:#738388}
  .bar{height:10px;border-radius:5px;background:#17302c10;margin:14px 0}
</style></head><body><div class="frame">
  <div class="toolbar"><div class="lights"><i></i><i></i><i></i></div><div class="omni">github.com/etphli/breezer/pull/42</div></div>
  <div class="bookmarks"><span>Docs</span><span>Linear</span><span>Figma</span><span>Reading</span><span>Tools</span></div>
  <iframe src="/workspace.html#/sidebar?w=7" title="Breezer sidebar"></iframe>
  <div class="page"><h1>Arc-style sidebar</h1><p>Pull request #42 · Replaces the native vertical tab strip with Breezer's own sidebar. Favorites, pinned folders, spaces and today tabs.</p><div class="bar" style="width:70%"></div><div class="bar" style="width:84%"></div><div class="bar" style="width:52%"></div></div>
  <div class="ai"><strong style="color:#182c31">Breezer AI</strong><div class="bar"></div><div class="bar" style="width:60%"></div></div>
</div></body></html>`;

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const pathname = new URL(request.url, 'http://localhost').pathname;
      if (pathname === '/__window.html') { response.setHeader('Content-Type', 'text/html'); response.end(WINDOW_HTML); return; }
      const path = resolve(root, `.${pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      const content = await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

test('sidebar releases unused route markup and reloads Settings and welcome intact', { skip }, async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.addInitScript(installFixture, { seed: seed(), bridge: true });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    await page.locator('#today [data-key="t:3"]').waitFor();
    assert.equal(await page.locator('#settings, #welcome').count(), 0);
    await page.evaluate(() => { location.hash = '#/settings/appearance'; });
    await page.getByRole('radio', { name: 'Mint', exact: true }).waitFor();
    assert.equal(await page.locator('#settings').isVisible(), true);
    await page.evaluate(() => { location.hash = '#/welcome'; });
    await page.locator('#welcome[data-ready="true"]').waitFor();
    assert.equal(await page.locator('#wl-next').isEnabled(), true);
    await page.evaluate(() => { location.hash = '#/sidebar?w=7'; });
    await page.locator('#today [data-key="t:3"]').waitFor();
    assert.equal(await page.locator('#settings, #welcome').count(), 0);
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});

test('empty Settings-created spaces and sidebar controls respond to held clicks', { skip }, async () => {
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const initial = seed();
    initial.tabs = initial.tabs.filter(tab => [3, 4, 5].includes(tab.id)).map((tab, index) => ({ ...tab, index }));
    initial.local['workspace.v1'].favorites = [];
    initial.local['workspace.v1'].spaces.forEach(space => { space.pinned = []; });
    initial.local['workspace.v1'].spaces.push({ id: 'space-research', name: 'Research', tone: 'tide', pinned: [] });
    initial.local['workspace.members.v1'].tabs = Object.fromEntries(Object.entries(initial.local['workspace.members.v1'].tabs).filter(([id]) => initial.tabs.some(tab => tab.id === Number(id))));
    const context = await browser.newContext({ viewport: { width: 300, height: 820 } });
    await context.addInitScript(installFixture, { seed: initial, bridge: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`${base}/workspace.html#/sidebar?w=7`);
    await page.locator('#today [data-key="t:3"]').waitFor();
    assert.equal(await page.locator('#spaces [role="tab"]').count(), 3);
    for (const [id, name] of [['space-personal', 'Personal'], ['space-research', 'Research'], ['space-work', 'Work']]) {
      await page.locator(`#spaces [data-key="s:${id}"]`).click({ delay: 120 });
      await page.waitForFunction(({ id, name }) => document.querySelector('#space-name').textContent === name && document.querySelector(`#spaces [data-key="s:${id}"]`).getAttribute('aria-selected') === 'true', { id, name });
      await page.waitForFunction(id => window.fx.session['workspace.window.7']?.activeSpaceId === id, id);
      await page.waitForFunction(() => document.querySelector('#today .row.active'));
    }
    assert.equal((await page.evaluate(() => window.fx.calls)).filter(([name]) => name === 'tabs.create').length, 2, 'Each empty space gets one real tab');
    await page.locator('#today [data-key="t:4"]').click({ delay: 120 });
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.id === 4);
    await page.locator('#today [data-key="t:4"]').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Pin tab', exact: true }).click();
    await page.locator('#pinned [data-key^="e:"]').waitFor();
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.id === 4)?.pinned);
    await page.getByRole('button', { name: 'Keep sidebar visible' }).click({ delay: 120 });
    await page.waitForFunction(() => window.fx.appearance.alwaysShowSidebar === true);
    assert.equal(await page.locator('#collapse').getAttribute('aria-pressed'), 'true');
    assert.equal(await page.evaluate(() => window.fx.appearance.sidebarMode), 'expanded', 'Pinning does not compact the sidebar');
    await page.reload();
    await page.getByRole('button', { name: 'Auto-hide sidebar' }).waitFor();
    assert.equal(await page.evaluate(() => window.fx.appearance.alwaysShowSidebar), true, 'Pin preference survives reload');
    await page.getByRole('button', { name: 'Auto-hide sidebar' }).click({ delay: 120 });
    await page.waitForFunction(() => window.fx.appearance.alwaysShowSidebar === false);
    assert.equal(await page.locator('#collapse').getAttribute('aria-pressed'), 'false');
    assert.equal(await page.evaluate(() => window.fx.appearance.sidebarMode), 'expanded', 'Unpinning preserves the chosen sidebar mode');
    await page.getByRole('button', { name: 'New space', exact: true }).click({ delay: 120 });
    await page.waitForFunction(() => window.fx.local['workspace.v1'].spaces.length === 4);
    await page.keyboard.press('Enter');
    await page.getByRole('button', { name: 'Settings', exact: true }).click({ delay: 120 });
    await page.waitForFunction(() => window.fx.calls.some(([name, props]) => name === 'tabs.create' && props.url?.endsWith('/workspace.html#/settings')));
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});

test('dragging with no Favorites preserves tab geometry and supports reorder and Favorites drops', { skip }, async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const initial = seed();
    initial.tabs = initial.tabs.filter(tab => [3, 4, 5].includes(tab.id)).map((tab, index) => ({ ...tab, index }));
    initial.local['workspace.v1'].favorites = [];
    initial.local['workspace.v1'].spaces.forEach(space => { space.pinned = []; });
    const context = await browser.newContext({ viewport: { width: 300, height: 820 } });
    await context.addInitScript(installFixture, { seed: initial, bridge: true });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    const row = id => page.locator(`#today [data-key="t:${id}"]`);
    await row(4).waitFor();
    const source = await row(4).boundingBox();
    const target = await row(3).boundingBox();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2);
    await page.mouse.down();
    await page.mouse.move(source.x + source.width / 2, source.y + source.height / 2 - 6);
    await page.locator('#sidebar.dragging').waitFor();
    assert.deepEqual(await row(3).boundingBox(), target, 'Starting a drag must keep the intended drop row under the pointer');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ animations: 'disabled', path: `${evidence}/workspace-empty-favorites-drag.png` });
    await page.mouse.move(target.x + target.width / 2, target.y + 3, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => window.fx.calls.some(([name, id]) => name === 'tabs.move' && id === 4));
    await page.waitForFunction(() => document.querySelector('#today .row')?.dataset.key === 't:4');
    assert.equal(await page.evaluate(() => window.fx.tabs.find(tab => tab.id === 4).pinned), false, 'Reordering must not pin the tab');
    await page.locator('#favorites').waitFor({ state: 'hidden' });

    // The floating empty Favorites target remains usable without moving tabs.
    const favoriteSource = await row(5).boundingBox();
    await page.mouse.move(favoriteSource.x + favoriteSource.width / 2, favoriteSource.y + favoriteSource.height / 2);
    await page.mouse.down();
    await page.mouse.move(favoriteSource.x + favoriteSource.width / 2, favoriteSource.y + favoriteSource.height / 2 - 6);
    await page.locator('#sidebar.dragging').waitFor();
    const favoriteTarget = await page.locator('#favorites').boundingBox();
    await page.mouse.move(favoriteTarget.x + favoriteTarget.width / 2, favoriteTarget.y + favoriteTarget.height / 2, { steps: 12 });
    await page.mouse.up();
    await page.waitForFunction(() => window.fx.local['workspace.v1'].favorites.some(entry => entry.url === 'https://mail.example.com/inbox'));
    await page.locator('#favorites .tile').waitFor();
    assert.equal(await page.evaluate(() => window.fx.tabs.find(tab => tab.id === 5).pinned), true);
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});

test('delayed tab queries cannot revive closed rows or overwrite navigation and activation', { skip }, async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 300, height: 820 } });
    await context.addInitScript(installFixture, { seed: seed(), bridge: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    await page.locator('#today [data-key="t:3"]').waitFor();
    // Capture a query before Chromium closes a tab, but deliver it after the
    // removal event and the subsequent fresh query have already been handled.
    await page.evaluate(() => {
      window.fx.holdQuery = true;
      window.fx.fire('tabs.onMoved', 3, { windowId: 7 });
    });
    await page.waitForFunction(() => typeof window.fx.releaseQuery === 'function');
    await page.evaluate(() => chrome.tabs.remove(3));
    await page.waitForFunction(() => !document.querySelector('#today [data-key="t:3"]:not(.leaving)'));
    await page.waitForTimeout(150);
    await page.evaluate(() => window.fx.releaseQuery());
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#today [data-key="t:3"]').count(), 0, 'a closed tab must not return as an unresponsive ghost row');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ animations: 'disabled', path: `${evidence}/workspace-tab-query-race.png` });

    await page.evaluate(() => {
      window.fx.releaseQuery = null;
      window.fx.holdQuery = true;
      window.fx.fire('tabs.onMoved', 4, { windowId: 7 });
    });
    await page.waitForFunction(() => typeof window.fx.releaseQuery === 'function');
    await page.evaluate(() => {
      const tab = window.fx.tabs.find(tab => tab.id === 4);
      tab.title = 'Updated page';
      window.fx.fire('tabs.onUpdated', 4, { title: tab.title }, tab);
    });
    await page.locator('#today [data-key="t:4"]').click();
    await page.waitForFunction(() => document.querySelector('#today [data-key="t:4"]').classList.contains('active'));
    await page.evaluate(() => window.fx.releaseQuery());
    await page.waitForTimeout(150);
    assert.equal(await page.locator('#today [data-key="t:4"] .title').innerText(), 'Updated page');
    assert.equal(await page.locator('#today [data-key="t:4"]').getAttribute('aria-selected'), 'true');
    await page.locator('#today [data-key="t:4"] .row-action').click();
    await page.waitForFunction(() => !window.fx.tabs.some(tab => tab.id === 4));
    await page.getByRole('button', { name: 'New tab', exact: true }).click();
    await page.getByRole('treeitem', { name: 'New Tab', exact: true }).waitFor();
    // A query must also converge after an activation event when it contains a
    // tab whose creation happened before this document subscribed to events.
    await page.evaluate(() => {
      window.fx.tabs.push({ id: 100, windowId: 7, index: 100, url: 'about:blank', title: 'Newly discovered tab', active: false, pinned: false });
      window.fx.releaseQuery = null;
      window.fx.holdQuery = true;
      window.fx.fire('tabs.onMoved', 100, { windowId: 7 });
    });
    await page.waitForFunction(() => typeof window.fx.releaseQuery === 'function');
    await page.evaluate(() => chrome.tabs.update(100, { active: true }));
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.id === 100).active);
    await page.waitForTimeout(50);
    await page.evaluate(() => window.fx.releaseQuery());
    await page.locator('#today [data-key="t:100"].active').waitFor();
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});

test('Arc-style sidebar and settings work against the chrome.* fixture', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const errors = [];
  const newPage = async (options, viewport = { width: 240, height: 820 }) => {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 2 });
    await context.addInitScript(installFixture, { seed: seed(), ...options });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !message.location().url.endsWith('/favicon.ico')) errors.push(`${message.text()} ${message.location().url}`); });
    return page;
  };
  const calls = (page) => page.evaluate(() => window.fx.calls);
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    // ---------------------------------------------------------- sidebar
    const page = await newPage({ bridge: true });
    await page.goto(`${base}/workspace.html#/sidebar?w=7`);
    const tree = page.locator('#today');
    await page.getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    assert.equal(await page.locator('#space-name').innerText(), 'Work');
    assert.equal(await page.locator('#favorites .tile').count(), 4);
    assert.equal(await page.locator('#favorites .tile.live').count(), 1, 'calendar favorite is bound to its live tab');
    assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), ['Arc-style sidebar · Pull request #42', 'Arc review notes', 'Mail — 3 unread']);
    assert.equal(await page.getByRole('treeitem', { name: /Pull request #42/ }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.getByRole('treeitem', { name: 'Sidebar spec, asleep' }).count(), 1, 'unbound pinned entry is asleep');
    assert.equal(await page.locator('#collapse').isVisible(), true);
    await page.screenshot({ animations: 'disabled', path: `${evidence}/workspace-sidebar.png` });

    // New tab joins the active space.
    await page.getByRole('button', { name: 'New tab' }).click();
    await tree.getByRole('treeitem', { name: /New Tab/ }).waitFor();
    assert.equal(await tree.getByRole('treeitem').count(), 4);

    // Close via the row button; the space keeps a tab and Chromium closes the right one.
    await tree.getByRole('treeitem', { name: /Mail/ }).hover();
    await tree.getByRole('treeitem', { name: /Mail/ }).getByRole('button', { name: 'Close tab' }).click();
    await page.waitForFunction(() => !document.querySelector('#today').textContent.includes('Mail'));
    assert.deepEqual((await calls(page)).filter(([name]) => name === 'tabs.remove').at(-1), ['tabs.remove', [5]]);

    // Pin from the context menu, then it shows in the pinned tree.
    await tree.getByRole('treeitem', { name: /Arc review notes/ }).click({ button: 'right' });
    await page.screenshot({ animations: 'disabled', path: `${evidence}/workspace-tab-menu.png` });
    await page.getByRole('menuitem', { name: 'Pin tab' }).click();
    await page.locator('#pinned').getByRole('treeitem', { name: 'Arc review notes' }).waitFor();
    assert.equal(await tree.getByRole('treeitem', { name: /Arc review notes/ }).count(), 0);
    assert.ok((await calls(page)).some(([name, id, props]) => name === 'tabs.update' && id === 4 && props.pinned === true));

    // Keyboard: focus, move, reorder with ⌥↓, rename with F2, close folder with ←.
    await tree.getByRole('treeitem', { name: /Pull request/ }).focus();
    await page.keyboard.press('Alt+ArrowDown');
    await page.waitForFunction(() => window.fx.calls.some(([name]) => name === 'tabs.move'));
    await page.waitForFunction(() => document.querySelector('#today').textContent.startsWith('New Tab'));
    assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), ['New Tab', 'Arc-style sidebar · Pull request #42']);
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 't:3', 'focus follows the moved row');
    const folder = page.getByRole('treeitem', { name: /Design review, folder/ });
    await folder.focus();
    await page.keyboard.press('ArrowLeft');
    await page.waitForFunction(() => document.querySelector('[data-key="f:f-design"]').getAttribute('aria-expanded') === 'false');
    await page.keyboard.press('F2');
    await page.keyboard.press('Meta+A');
    await page.keyboard.type('Reviews');
    await page.keyboard.press('Enter');
    await page.getByRole('treeitem', { name: /^Reviews, folder/ }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'f:f-design', 'focus returns to the folder');

    // Spaces: switching shows Personal's tabs and activates one of them.
    await page.getByRole('tab', { name: /Personal/ }).click();
    await page.waitForFunction(() => document.querySelector('#space-name').textContent === 'Personal');
    assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), ['Miso glazed aubergine', 'Late night radio']);
    assert.equal(await page.locator('#sidebar').getAttribute('data-tone'), 'rose');
    await page.waitForFunction(() => window.fx.tabs.find((tab) => tab.active)?.id === 6);
    assert.equal(await tree.getByRole('button', { name: 'Mute tab' }).count(), 1, 'audible tab shows a mute control');
    await page.screenshot({ animations: 'disabled', path: `${evidence}/workspace-sidebar-personal.png` });

    // Browser restart: storage.session is gone and every tab gets a new id.
    await page.evaluate(() => {
      const tabs = JSON.parse(localStorage.getItem('fx-tabs')).map((tab) => ({ ...tab, id: tab.id + 100 }));
      localStorage.setItem('fx-tabs', JSON.stringify(tabs));
      sessionStorage.setItem('fx-session', '{}');
    });
    await page.reload();
    await tree.getByRole('treeitem', { name: /Miso glazed aubergine/ }).waitFor();
    assert.equal(await page.locator('#space-name').innerText(), 'Personal', 'reopens in the active tab’s space');
    assert.deepEqual(await tree.getByRole('treeitem').allInnerTexts(), ['Miso glazed aubergine', 'Late night radio']);
    await page.getByRole('tab', { name: /Work/ }).click();
    await tree.getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    assert.equal(await page.locator('#pinned').getByRole('treeitem', { name: 'Linear' }).count(), 1, 'pinned binding survives (live, not asleep)');
    assert.equal(await page.locator('#pinned').getByRole('treeitem', { name: 'Arc review notes' }).count(), 1, 'pin made this session survives');
    assert.equal(await tree.getByRole('treeitem', { name: /Miso/ }).count(), 0, 'Personal tabs stay out of Work');

    // Pinning calls the native bridge without changing the compact preference.
    await page.getByRole('button', { name: 'Keep sidebar visible' }).click();
    await page.waitForFunction(() => window.fx.calls.some(([name, patch]) => name === 'setAppearance' && patch.alwaysShowSidebar === true));

    // Dark scheme.
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.waitForFunction(() => document.documentElement.dataset.scheme === 'dark');
    await page.waitForTimeout(400); // let the space-switch animation finish before capturing
    await page.screenshot({ animations: 'disabled', path: `${evidence}/workspace-sidebar-dark.png` });

    // ---------------------------------------------------------- settings
    const settings = await newPage({ bridge: true }, { width: 1000, height: 1400 });
    await settings.goto(`${base}/workspace.html#/settings`);
    await settings.locator('#settings-title').waitFor();
    // Categories show one at a time, like the browser's own settings.
    const go = (page, name) => page.locator('#settings-categories').getByRole('link', { name, exact: true }).click();
    await go(settings, 'Appearance');
    assert.equal(await settings.getByRole('radio', { name: 'Mint' }).getAttribute('aria-checked'), 'true');
    await go(settings, 'Layout');
    assert.equal(await settings.getByRole('radio', { name: 'Sidebar' }).getAttribute('aria-checked'), 'true');
    assert.equal(await settings.locator('[data-field="bookmarkBarMode"] [data-value="newTab"]').getAttribute('aria-checked'), 'true');
    assert.equal(await settings.locator('#sidebar-width').inputValue(), '240');
    assert.equal(await settings.title(), 'Layout – Settings');
    await go(settings, 'Appearance');
    assert.equal(await settings.getByRole('slider', { name: 'Sidebar font size' }).inputValue(), '15');
    for (const value of [12, 20, 15]) {
      await settings.getByRole('slider', { name: 'Sidebar font size' }).fill(String(value));
      await settings.waitForFunction(v => window.fx.appearance.sidebarFontSize === v, value);
      assert.equal(await settings.locator('#sidebar-font-size-value').innerText(), `${value} px`);
    }
    await go(settings, 'Layout');
    for (const [id, initial] of [['centered-address-bar', true], ['minimal-url', true], ['show-load-progress', true], ['frameless', true], ['always-show-sidebar', false], ['always-show-top-bar', true]]) {
      const control = settings.locator(`#${id}`);
      assert.equal(await control.getAttribute('aria-checked'), String(initial));
      await control.click();
      await settings.waitForFunction(({ id, value }) => document.getElementById(id).getAttribute('aria-checked') === String(value), { id, value: !initial });
      await control.click();
      await settings.waitForFunction(({ id, value }) => document.getElementById(id).getAttribute('aria-checked') === String(value), { id, value: initial });
    }
    await go(settings, 'Browser settings');
    await settings.getByRole('button', { name: 'Privacy and security', exact: true }).click();
    await settings.waitForFunction(() => window.fx.calls.some(([name, args]) => name === 'tabs.create' && args.url === 'chrome://settings/privacy'));
    await settings.getByRole('button', { name: 'All browser settings', exact: true }).click();
    await settings.waitForFunction(() => window.fx.calls.some(([name, args]) => name === 'tabs.create' && args.url === 'chrome://settings/'));
    await go(settings, 'Layout');
    for (const [label, mode] of [['Compact', 'compact'], ['Auto-hide', 'autoHide'], ['Expanded', 'expanded']]) {
      await settings.getByRole('radio', { name: label, exact: true }).click();
      await settings.waitForFunction(value => window.fx.appearance.sidebarMode === value, mode);
      assert.equal(await settings.getByRole('radio', { name: label, exact: true }).getAttribute('aria-checked'), 'true');
    }
    await go(settings, 'Appearance');
    await settings.getByRole('radio', { name: 'Dusk' }).click();
    await settings.waitForFunction(() => document.documentElement.dataset.tone === 'dusk');
    assert.deepEqual((await calls(settings)).at(-1), ['setAppearance', { theme: 'dusk' }]);
    await settings.getByRole('radio', { name: 'Dusk' }).focus();
    await settings.keyboard.press('ArrowRight');
    await settings.waitForFunction(() => document.documentElement.dataset.tone === 'rose');
    await go(settings, 'Layout');
    await settings.locator('[data-field="bookmarkBarMode"] [data-value="hidden"]').click();
    await settings.waitForFunction(() => window.fx.appearance.bookmarkBarMode === 'hidden');
    await go(settings, 'General');
    await settings.getByRole('radio', { name: 'At top' }).click();
    await settings.waitForFunction(() => window.fx.local['workspace.v1'].prefs.newTabPosition === 'top');
    await go(settings, 'Spaces');
    await settings.getByRole('textbox', { name: 'Name of space 2' }).fill('Home');
    await settings.keyboard.press('Enter');
    await settings.waitForFunction(() => window.fx.local['workspace.v1'].spaces[1].name === 'Home');
    await settings.getByRole('button', { name: 'Add space' }).click();
    await settings.waitForFunction(() => window.fx.local['workspace.v1'].spaces.length === 3);
    await go(settings, 'Appearance');
    await settings.getByRole('radio', { name: 'Mint' }).click();
    await settings.waitForFunction(() => document.documentElement.dataset.tone === 'mint');
    await settings.getByRole('slider', { name: 'Sidebar font size' }).fill('18');
    await settings.waitForFunction(() => window.fx.appearance.sidebarFontSize === 18);
    await go(settings, 'Layout');
    await settings.locator('#centered-address-bar').click();
    await settings.waitForFunction(() => window.fx.appearance.centeredAddressBar === false);
    await settings.reload();
    await settings.locator('#centered-address-bar').waitFor();
    assert.equal(await settings.locator('#sidebar-font-size').inputValue(), '18');
    assert.equal(await settings.locator('#centered-address-bar').getAttribute('aria-checked'), 'false');
    assert.equal(await settings.locator('#frameless').getAttribute('aria-checked'), 'true');
    await go(settings, 'Appearance');
    await settings.getByRole('slider', { name: 'Sidebar font size' }).fill('15');
    await settings.waitForFunction(() => window.fx.appearance.sidebarFontSize === 15);
    await go(settings, 'Layout');
    await settings.locator('#centered-address-bar').click();
    await settings.waitForFunction(() => window.fx.appearance.centeredAddressBar === true);
    await settings.screenshot({ animations: 'disabled', path: `${evidence}/workspace-settings.png`, fullPage: true });
    await settings.emulateMedia({ colorScheme: 'dark' });
    await settings.screenshot({ animations: 'disabled', path: `${evidence}/workspace-settings-dark.png`, fullPage: true });

    // A rejected change is reported and the control keeps the browser's value.
    const failing = await newPage({ bridge: true, bridgeFails: true }, { width: 900, height: 900 });
    await failing.goto(`${base}/workspace.html#/settings/appearance`);
    await failing.getByRole('radio', { name: 'Tide' }).click();
    await failing.getByText(/Couldn’t change the theme\. Rejected by the browser\./).waitFor();
    assert.equal(await failing.getByRole('radio', { name: 'Mint' }).getAttribute('aria-checked'), 'true');
    assert.equal(await failing.evaluate(() => document.documentElement.dataset.tone), 'mint');
    await failing.getByRole('slider', { name: 'Sidebar font size' }).fill('18');
    await failing.locator('#typography-error').getByText(/Rejected by the browser/).waitFor();
    assert.equal(await failing.getByRole('slider', { name: 'Sidebar font size' }).inputValue(), '15');
    await go(failing, 'Layout');
    await failing.locator('#frameless').click();
    await failing.locator('#frameless-error').getByText(/Rejected by the browser/).waitFor();
    assert.equal(await failing.locator('#frameless').getAttribute('aria-checked'), 'true');

    // Without the native bridge nothing pretends to apply.
    const missing = await newPage({ bridge: false }, { width: 900, height: 900 });
    await missing.goto(`${base}/workspace.html#/settings/layout`);
    await missing.getByText(/this build doesn’t include/).waitFor();
    assert.equal(await missing.getByRole('radio', { name: 'Top', exact: true }).getAttribute('aria-disabled'), 'true');
    assert.equal(await missing.locator('#sidebar-width').isDisabled(), true);
    assert.equal(await missing.locator('#sidebar-font-size').isDisabled(), true);
    assert.equal(await missing.locator('#frameless').getAttribute('aria-disabled'), 'true');
    await go(missing, 'Appearance');
    await missing.getByRole('radio', { name: 'Dusk' }).click({ force: true });
    assert.equal(await missing.evaluate(() => document.documentElement.dataset.tone), 'mint');
    await go(missing, 'General');
    assert.equal(await missing.getByRole('radio', { name: 'At bottom' }).getAttribute('aria-disabled'), null, 'store-backed tab settings still work');

    const sidebarWithoutBridge = await newPage({ bridge: false });
    await sidebarWithoutBridge.goto(`${base}/workspace.html#/sidebar?w=7`);
    await sidebarWithoutBridge.getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    assert.equal(await sidebarWithoutBridge.locator('#collapse').isVisible(), false, 'no collapse button without native support');

    // Whole-window composition for review.
    const windowPage = await newPage({ bridge: true }, { width: 1280, height: 800 });
    await windowPage.goto(`${base}/__window.html`);
    await windowPage.frameLocator('iframe').getByRole('treeitem', { name: /Pull request #42/ }).waitFor();
    await windowPage.screenshot({ animations: 'disabled', path: `${evidence}/workspace-window.png` });

    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});

test('tab updates leave unchanged rows and their audio controls intact', { skip }, async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 300, height: 820 } });
    await context.addInitScript(installFixture, { seed: seed(), bridge: true });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    const row = page.locator('#today [data-key="t:3"]');
    await row.waitFor();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const unchanged = await page.evaluate(async () => {
      const records = [];
      const observer = new MutationObserver(values => records.push(...values));
      document.querySelectorAll('.row').forEach(row => observer.observe(row, { subtree: true, attributes: true, childList: true, characterData: true }));
      const tab = fx.tabs.find(tab => tab.id === 3);
      for (const listener of fx.listeners['tabs.onUpdated']) listener(tab.id, { autoDiscardable: true }, { ...tab, autoDiscardable: true });
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      records.push(...observer.takeRecords());
      observer.disconnect();
      return records.length;
    });
    assert.equal(unchanged, 0, 'an unchanged presentation must cause no row mutations');
    await page.evaluate(() => {
      const tab = fx.tabs.find(tab => tab.id === 3);
      Object.assign(tab, { title: 'Updated document', audible: true });
      for (const listener of fx.listeners['tabs.onUpdated']) listener(tab.id, { title: tab.title, audible: true }, { ...tab });
    });
    await page.waitForFunction(() => document.querySelector('[data-key="t:3"] .title').textContent === 'Updated document');
    assert.equal(await row.locator('.row-sound').isVisible(), true);
    await row.click();
    assert.equal(await row.getAttribute('aria-selected'), 'true');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ animations: 'disabled', path: `${evidence}/workspace-efficient-updates.png` });
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});

// Replays the native host's cancelable command in the shipped document. This
// verifies the bridge recipient, not physical macOS accelerator dispatch.
async function numberedCommand(page, index) {
  const cdp = await page.context().newCDPSession(page);
  try {
    const { frameTree } = await cdp.send('Page.getFrameTree');
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id, worldName: 'breezer-shortcut-native-fixture',
    });
    const result = await cdp.send('Runtime.evaluate', {
      expression: `!document.dispatchEvent(new CustomEvent('breezer-select-numbered-tab',{cancelable:true,detail:${JSON.stringify(index)}}))`,
      contextId: executionContextId, returnByValue: true,
    });
    assert.equal(result.exceptionDetails, undefined);
    return result.result.value;
  } finally { await cdp.detach(); }
}

test('numbered favorite command lazily opens the saved first slot, once under rapid repeat', { skip }, async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const initial = seed();
    initial.tabs = initial.tabs.filter(tab => tab.id === 3).map(tab => ({ ...tab, index: 0 }));
    const page = await browser.newPage({ viewport: { width: 300, height: 820 } });
    await page.addInitScript(installFixture, { seed: initial, bridge: true });
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    await page.locator('#favorites .tile').first().waitFor();
    assert.equal(await page.evaluate(() => window.fx.tabs.length), 1, 'no favorite is preloaded');
    await page.evaluate(() => { window.fx.holdCreate = true; });
    assert.equal(await numberedCommand(page, 0), true, 'Command+1 must handle the saved favorite, not native live index 0');
    await numberedCommand(page, 0);
    await page.locator('#favorites .tile').first().click();
    assert.equal(await page.evaluate(() => window.fx.calls.filter(([name]) => name === 'tabs.create').length), 1);
    await page.evaluate(() => { window.fx.holdCreate = false; window.fx.releaseCreate(); });
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.url === 'https://calendar.example.com/week');
    assert.equal(await page.evaluate(() => window.fx.tabs.length), 2);
    await numberedCommand(page, 0);
    assert.equal(await page.evaluate(() => window.fx.calls.filter(([name]) => name === 'tabs.create').length), 1);
    await page.locator('#favorites .tile.active').first().waitFor();
    await page.waitForFunction(() => !document.querySelector('#today .row.active'));
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ animations: 'disabled', path: `${evidence}/favorite-number-lazy-fixture.png` });
    // Failed creation releases the entry for a subsequent deliberate retry.
    await page.evaluate(() => { window.fx.failCreate = true; });
    await numberedCommand(page, 1);
    await page.locator('#toast').filter({ hasText: 'Fixture create failure' }).waitFor();
    await page.evaluate(() => { window.fx.failCreate = false; });
    await numberedCommand(page, 1);
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.url === 'https://chat.example.com/');
    await numberedCommand(page, 0);
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.url === 'https://calendar.example.com/week');
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});

test('numbered saved slots reuse loaded and discarded tabs, follow reorder across spaces and restart', { skip }, async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const initial = seed();
    initial.tabs.find(tab => tab.id === 8).discarded = true;
    initial.local['workspace.v1'].spaces[0].pinned[0].open = false;
    const page = await browser.newPage({ viewport: { width: 300, height: 820 } });
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(installFixture, { seed: initial, bridge: true });
    await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=7`);
    await page.locator('#favorites .tile').first().waitFor();
    // A browser command still handles the slot while a text field has focus.
    await page.evaluate(() => { const input = document.createElement('input'); input.id = 'typing'; document.body.append(input); input.focus(); });
    await page.keyboard.type('123');
    assert.equal(await page.locator('#typing').inputValue(), '123', 'ordinary typing is left alone');
    assert.equal(await numberedCommand(page, 0), true);
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.id === 8);
    assert.equal(await page.evaluate(() => window.fx.calls.filter(([name]) => name === 'tabs.create').length), 0, 'discarded target is activated in place');
    await numberedCommand(page, 6); // Four favorites, two folder children, Linear.
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.id === 1);
    await numberedCommand(page, 4); // Closed folders still have stable saved slots.
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.id === 2);
    await numberedCommand(page, 5);
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.url === 'https://docs.breezer.dev/spec');
    assert.equal(await numberedCommand(page, 7), false, 'unassigned saved slot falls back to native order');
    assert.equal(await numberedCommand(page, 8), false, 'Command+9 is never a saved slot');
    for (const invalid of [-1, 99, 0.5, '1', null]) assert.equal(await numberedCommand(page, invalid), false);
    await page.locator('#spaces [data-key="s:space-personal"]').click();
    await numberedCommand(page, 0);
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.id === 8);
    assert.equal(await page.locator('#space-name').textContent(), 'Personal', 'global favorite does not switch spaces');
    assert.equal(await numberedCommand(page, 4), false, 'pins belong to the active space');
    await page.evaluate(async () => {
      const store = window.fx.local['workspace.v1'];
      [store.favorites[0], store.favorites[1]] = [store.favorites[1], store.favorites[0]];
      store.rev++;
      await chrome.storage.local.set({ 'workspace.v1': store });
    });
    await page.waitForFunction(() => document.querySelector('#favorites .tile').dataset.key === 'v:v-chat');
    await numberedCommand(page, 0);
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.url === 'https://chat.example.com/');
    // Restart fixture: retain saved order, drop live favorites, rotate membership session.
    await page.evaluate(() => {
      const tab = window.fx.tabs.find(tab => tab.id === 3);
      localStorage.setItem('fx-tabs', JSON.stringify([{ ...tab, index: 0, active: true }]));
      sessionStorage.clear();
    });
    await page.reload();
    await page.locator('#favorites .tile').first().waitFor();
    assert.equal(await page.evaluate(() => window.fx.tabs.length), 1);
    await numberedCommand(page, 0);
    await page.waitForFunction(() => window.fx.tabs.find(tab => tab.active)?.url === 'https://chat.example.com/');
    assert.equal(await page.evaluate(() => window.fx.tabs.length), 2);
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});

test('numbered favorite activation is scoped to the host window, including another window with a live target', { skip }, async () => {
  const server = await startServer();
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    for (const windowId of [7, 8]) {
      const initial = seed();
      initial.windowId = windowId;
      // Same saved favorite already live in window 7. Window 8 must open its own.
      initial.tabs.push({ id: 20, windowId: 8, index: 0, active: true, url: 'https://ordinary.example.test/', title: 'Other window' });
      const page = await browser.newPage({ viewport: { width: 300, height: 820 } });
      await page.addInitScript(installFixture, { seed: initial, bridge: true });
      await page.goto(`http://127.0.0.1:${server.address().port}/workspace.html#/sidebar?w=${windowId}`);
      await page.locator('#favorites .tile').first().waitFor();
      await numberedCommand(page, 0);
      await page.waitForFunction(id => window.fx.tabs.some(tab => tab.windowId === id && tab.active && tab.url === 'https://calendar.example.com/week'), windowId);
      assert.equal(await page.evaluate(() => window.fx.calls.filter(([name]) => name === 'tabs.create').length), windowId === 7 ? 0 : 1);
      assert.equal(await page.evaluate(() => window.fx.tabs.find(tab => tab.id === 20).active), windowId === 7, 'the other window retains its selection');
      await page.close();
    }
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});
