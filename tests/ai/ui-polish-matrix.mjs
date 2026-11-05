// Capture every Settings category and theme, plus sidebar modes, new tab and AI.
// node tests/ai/ui-polish-matrix.mjs /tmp/breezer-ui/matrix
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from 'playwright';
import { installFixture as settingsFixture } from './settings-browser-fixture.mjs';
import { installFixture as workspaceFixture, seed } from './workspace-browser-fixture.mjs';
import { installFixture as newtabFixture, CONNECTED, NOW } from './newtab-browser-fixture.mjs';
import { installPanelFixture } from './panel-browser-fixture.mjs';
import { captureStablePanel } from './ui-evidence-capture.mjs';

const root = resolve('features/ai/extension');
const output = resolve(process.argv[2] || '/tmp/breezer-ui-matrix');
const themes = ['mint', 'tide', 'dusk', 'rose', 'pollen', 'graphite', '#3979bd'];
const categories = ['general', 'appearance', 'layout', 'spaces', 'passwords', 'sync', 'privacy', 'assistant', 'newtab', 'languages', 'browser'];
const manifest = { themes, categories, captures: [], notes: [
  'Shipped UI with deterministic extension APIs. No installed app or personal data.',
  'Desktop settings use a tall enough real viewport to show every row. Narrow captures use fullPage.',
  'Compact sidebar uses a 72px viewport. Auto-hide captures its expanded document, not native reveal behavior.',
  'All settings is a native Settings destination, not a Breezer category document.',
  'Native top tabs, toolbar, menus and physical auto-hide integration are not captured by this script.',
] };
await mkdir(output, { recursive: true });
const sourceHashes = async () => Object.fromEntries(await Promise.all((await readdir(root)).sort().map(async file => [file, createHash('sha256').update(await readFile(resolve(root, file))).digest('hex')])));
manifest.sourceHashes = await sourceHashes();
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname === '/favicon.ico') return response.writeHead(204).end();
    if (url.pathname === '/_favicon/') {
      response.setHeader('Content-Type', 'image/svg+xml');
      return response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#3979bd"/><path d="M9 10h14v12H9Z" fill="white"/></svg>');
    }
    const path = resolve(root, `.${url.pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
  for (const colorMode of ['light', 'dark']) for (const theme of themes) {
    const name = `${theme.startsWith('#') ? 'custom' : theme}-${colorMode}`;
    const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, colorScheme: colorMode, reducedMotion: 'reduce', locale: 'en-US' });
    const captures = [];
    const shot = async (page, id) => {
      const file = `${name}-${id}.png`;
      await page.mouse.move(page.viewportSize().width - 2, 2);
      await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      let captureChecks;
      if (id.startsWith('assistant')) captureChecks = await captureStablePanel(page, resolve(output, file), id.startsWith('assistant-options') ? { surfaceSelector: '#model-menu' } : {});
      else await page.screenshot({ path: resolve(output, file), fullPage: id.endsWith('-narrow'), animations: 'disabled' });
      const entry = { name, id, file, viewport: page.viewportSize(), ...(captureChecks ? { captureChecks } : {}) };
      captures.push(entry); manifest.captures.push(entry);
    };
    const settings = await context.newPage();
    await settings.addInitScript(settingsFixture, { colorMode, theme });
    await settings.goto(`${base}/workspace.html#/settings`);
    await settings.locator('.nav-item[data-category="languages"]').waitFor();
    for (const category of categories) {
      await settings.evaluate(value => { location.hash = `#/settings/${value}`; }, category);
      await settings.locator(`.settings-page[data-page="${category}"]:not([hidden])`).waitFor();
      await settings.setViewportSize({ width: 1200, height: 900 });
      await settings.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const height = await settings.locator('.settings-column').evaluate(node => Math.ceil(node.scrollHeight + 64));
      await settings.setViewportSize({ width: 1200, height: Math.max(900, height) });
      await shot(settings, `settings-${category}`);
      await settings.setViewportSize({ width: 390, height: 844 });
      assert.equal(await settings.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `${name}/${category} narrow overflow`);
      await shot(settings, `settings-${category}-narrow`);
    }
    await settings.evaluate(() => { location.hash = '#/settings/assistant'; });
    await settings.locator('[data-context-control="enabled"]').check();
    await settings.getByRole('button', { name: 'Save choices', exact: true }).click();
    await settings.getByRole('heading', { name: 'Activity summary', exact: true }).waitFor();
    for (const width of [1200, 390]) {
      await settings.setViewportSize({ width, height: width === 1200 ? 1100 : 844 });
      await shot(settings, width === 1200 ? 'settings-assistant-enabled' : 'settings-assistant-enabled-narrow');
    }
    const workspace = await context.newPage();
    const workspaceSeed = seed();
    if (!theme.startsWith('#')) workspaceSeed.local['workspace.v1'].spaces[0].tone = theme;
    await workspace.addInitScript(workspaceFixture, { seed: workspaceSeed, bridge: true });
    await workspace.addInitScript(({ theme, colorMode }) => Object.assign(window.fx.appearance, { theme, colorMode }), { theme, colorMode });
    await workspace.goto(`${base}/workspace.html#/sidebar?w=7`);
    await workspace.locator('#today [data-key="t:3"]').waitFor();
    for (const mode of ['expanded', 'compact', 'autoHide']) {
      await workspace.setViewportSize({ width: mode === 'compact' ? 72 : 240, height: 820 });
      await workspace.evaluate(async mode => { const { applyAppearance } = await import('/workspace.js'); applyAppearance({ ...window.fx.appearance, sidebarMode: mode }); }, mode);
      await shot(workspace, `sidebar-${mode}`);
    }
    const newtab = await context.newPage();
    await newtab.addInitScript(newtabFixture, { view: CONNECTED, appearance: { theme, colorMode } });
    await newtab.clock.setFixedTime(NOW);
    await newtab.goto(`${base}/newtab.html`);
    await newtab.locator('.organato[data-state="ready"]').waitFor();
    await newtab.setViewportSize({ width: 1200, height: 900 });
    await shot(newtab, 'newtab');
    await newtab.setViewportSize({ width: 390, height: 844 });
    await shot(newtab, 'newtab-narrow');
    const panel = await context.newPage();
    await panel.addInitScript(installPanelFixture);
    await panel.addInitScript(appearance => { chrome.breezerPrivate.getAppearance = async () => appearance; }, { theme, colorMode });
    await panel.setViewportSize({ width: 400, height: 850 });
    await panel.goto(`${base}/panel.html`);
    await panel.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
    await shot(panel, 'assistant');
    await panel.setViewportSize({ width: 320, height: 640 });
    await shot(panel, 'assistant-narrow');
    await panel.locator('#model-button').click();
    await panel.locator('#inference-options > summary').click();
    await panel.getByLabel('Codex speed', { exact: true }).selectOption('fast');
    for (const width of [400, 320]) {
      await panel.setViewportSize({ width, height: width === 320 ? 640 : 850 });
      await shot(panel, width === 320 ? 'assistant-options-narrow' : 'assistant-options');
    }
    const setup = await context.newPage();
    await setup.addInitScript(settingsFixture, { colorMode, theme });
    await setup.goto(`${base}/workspace.html#/welcome`);
    for (let step = 0; step < 5; step++) await setup.locator('#wl-next').click();
    await setup.locator('.wl-step[data-step="organato"]:not([hidden])').waitFor();
    await setup.setViewportSize({ width: 1200, height: 900 });
    await shot(setup, 'onboarding');
    await setup.setViewportSize({ width: 390, height: 844 });
    await shot(setup, 'onboarding-narrow');
    // Contact sheet is an index. Raw captures above are the source for text/detail review.
    const tiles = await Promise.all(captures.filter(item => !item.id.endsWith('-narrow')).map(async item => `<figure><figcaption>${item.id}</figcaption><img src="data:image/png;base64,${(await readFile(resolve(output, item.file))).toString('base64')}"/></figure>`));
    const sheet = await context.newPage();
    await sheet.setViewportSize({ width: 1440, height: 900 });
    await sheet.setContent(`<html><style>body{margin:0;padding:24px;background:#eef0f2;color:#20242b;font:14px system-ui}h1{font-size:24px}.grid{display:grid;grid-template-columns:repeat(4,1fr);gap:16px}figure{margin:0;min-width:0}figcaption{margin:6px 0;font-weight:600}img{display:block;max-width:100%;max-height:420px;object-fit:contain;object-position:top left;border:1px solid #c8cdd3}</style><h1>${name} · shipped UI fixtures</h1><p>Open raw PNGs for full-size details. Native top tabs and window chrome are outside this set.</p><div class="grid">${tiles.join('')}</div></html>`);
    await sheet.screenshot({ path: resolve(output, `sheet-${name}.png`), fullPage: true });
    await context.close();
    console.log(`Captured ${name}: ${captures.length} screens`);
  }
  assert.deepEqual(await sourceHashes(), manifest.sourceHashes, 'extension source must stay frozen during a matrix capture');
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
}
