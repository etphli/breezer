import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { seed, installFixture } from './workspace-browser-fixture.mjs';

// Folder colors in the shipped sidebar and Settings documents, driven in a real
// browser against the chrome.* fixture: Settings mode, the folder context menu
// by mouse and keyboard, custom hex preview/revert, failure revert, contrast.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

async function startServer() {
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return server;
}

// Composites the folder row over the sidebar and returns the title's WCAG contrast.
const titleContrast = (page) => page.evaluate(() => {
  const row = document.querySelector('.folder .folder-row');
  const context = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
  const layers = [getComputedStyle(document.body).backgroundColor, getComputedStyle(document.getElementById('sidebar')).backgroundColor, getComputedStyle(row).backgroundColor];
  for (const color of layers) { context.fillStyle = color; context.fillRect(0, 0, 1, 1); }
  const back = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = getComputedStyle(row.querySelector('.title')).color; context.fillRect(0, 0, 1, 1);
  const ink = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3);
  const lum = (rgb) => rgb.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0);
  const [a, b] = [lum(back), lum(ink)].sort((x, y) => y - x);
  return { ratio: (a + 0.05) / (b + 0.05), background: getComputedStyle(row).backgroundColor };
});

// Storage settles before the sidebar's next frame paints; wait for the DOM itself.
const folderPainted = (page, color, custom) => page.waitForFunction(([color, custom]) => {
  const node = document.querySelector('.folder');
  return node && (node.dataset.color ?? null) === color && (custom === undefined || (node.dataset.custom ?? null) === custom);
}, [color, custom]);

test('folder colors: Settings mode, context menu, keyboard, custom hex, preview and failure revert', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  const errors = [];
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const context = await browser.newContext({ viewport: { width: 260, height: 620 }, deviceScaleFactor: 2, reducedMotion: 'reduce' });
    await context.addInitScript(installFixture, { seed: seed(), bridge: true });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`${base}/workspace.html#/sidebar?w=7`);
    const folder = page.locator('.folder').first();
    const head = folder.locator('.folder-row');
    await folder.waitFor();
    const stored = () => page.evaluate(() => ({ color: window.fx.local['workspace.v1'].spaces[0].pinned[0].color ?? null, mode: window.fx.local['workspace.v1'].prefs.folderColors }));

    // A fresh display setting still lets the folder menu choose and show a color.
    await page.waitForFunction(() => document.getElementById('sidebar').dataset.folderColors === 'off');
    const glyph = head.locator('.folder-glyph');
    const glyphColor = () => glyph.evaluate((node) => getComputedStyle(node).color);
    const neutral = await glyphColor();
    const initial = await stored();
    await head.click({ button: 'right' });
    assert.equal(await page.locator('#menu .menu-swatches').count(), 1, 'the default folder menu offers colors');
    await page.screenshot({ animations: 'disabled', path: `${evidence}/folder-colors-default-menu.png` });

    await page.getByRole('menuitemradio', { name: 'Custom color' }).click();
    await page.getByRole('textbox', { name: 'Hex color' }).fill('#38f');
    assert.notEqual(await glyphColor(), neutral);
    assert.deepEqual(await stored(), initial, 'opening the editor saves neither the color nor the display mode');
    await page.keyboard.press('Escape');
    assert.equal(await glyphColor(), neutral);

    await page.getByRole('menuitemradio', { name: 'Rose' }).click();
    await folderPainted(page, 'rose');
    await page.waitForFunction(() => document.getElementById('sidebar').dataset.folderColors === 'icon');
    assert.deepEqual(await stored(), { color: 'rose', mode: 'icon' });
    assert.notEqual(await glyphColor(), neutral);
    await page.reload();
    await folderPainted(page, 'rose');
    assert.notEqual(await glyphColor(), neutral);
    await head.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reset color' }).click();
    await folderPainted(page, null, null);

    // Settings > Layout > Sidebar folder colors writes the store; the sidebar follows on reload.
    const settings = await context.newPage();
    await settings.setViewportSize({ width: 900, height: 700 });
    await settings.goto(`${base}/workspace.html#/settings/layout`);
    const group = settings.locator('[data-pref="folderColors"]');
    await group.waitFor();
    assert.equal(await group.locator('[data-value="icon"]').getAttribute('aria-checked'), 'true');
    await group.locator('[data-value="icon"]').focus();
    await settings.keyboard.press('ArrowRight');
    await settings.waitForFunction(() => window.fx.local['workspace.v1'].prefs.folderColors === 'row');
    assert.equal(await group.locator('[data-value="row"]').getAttribute('aria-checked'), 'true');
    await settings.locator('[data-pref="folderColors"]').evaluate((node) => node.closest('.setting-row').scrollIntoView({ block: 'center' }));
    await settings.screenshot({ animations: 'disabled', path: `${evidence}/folder-colors-settings.png` });
    await settings.close();
    await page.reload();
    await folder.waitFor();
    await page.waitForFunction(() => document.getElementById('sidebar').dataset.folderColors === 'row');

    // Keyboard: open the folder menu, reach the swatches with Down, move with Right, apply with Enter.
    await folder.focus();
    await page.keyboard.press('Shift+F10');
    await page.locator('#menu .menu-swatches').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Collapse', 'the menu opens with focus on its first item');
    assert.equal(await page.locator('#menu .menu-heading').first().innerText(), 'Color');
    assert.equal(await page.getByRole('menuitem', { name: 'Reset color' }).getAttribute('aria-disabled'), 'true');
    await page.keyboard.press('ArrowDown'); // Rename
    await page.keyboard.press('ArrowDown'); // swatch row (first swatch)
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Mint');
    for (let i = 0; i < 3; i++) await page.keyboard.press('ArrowRight');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Rose');
    await page.keyboard.press('ArrowLeft');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fx.local['workspace.v1'].spaces[0].pinned[0].color === 'rose');
    await folderPainted(page, 'rose');
    assert.equal(await page.locator('#menu').isHidden(), true);
    assert.equal(await page.evaluate(() => document.activeElement.classList.contains('folder')), true, 'focus returns to the folder');
    const rowTint = await titleContrast(page);
    assert.notEqual(rowTint.background, 'rgba(0, 0, 0, 0)', 'whole row is tinted');
    assert.ok(rowTint.ratio >= 4.5, `row title contrast ${rowTint.ratio.toFixed(2)}`);
    await page.screenshot({ animations: 'disabled', path: `${evidence}/folder-colors-row-light.png` });

    // Custom: the swatch opens a hex field; typing previews, Escape reverts and returns focus.
    await head.click({ button: 'right' });
    await page.getByRole('menuitemradio', { name: 'Custom color' }).click();
    const hex = page.getByRole('textbox', { name: 'Hex color' });
    await hex.waitFor();
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Hex color');
    assert.equal(await hex.inputValue(), await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--folder-rose').trim()), 'starts from the current color');
    await hex.fill('#38f');
    assert.equal(await folder.getAttribute('data-color'), 'custom', 'typing previews the color');
    assert.equal((await stored()).color, 'rose', 'preview is not saved');
    await page.screenshot({ animations: 'disabled', path: `${evidence}/folder-colors-custom-editor.png` });
    await page.keyboard.press('Escape');
    assert.equal(await hex.isHidden(), true);
    assert.equal(await folder.getAttribute('data-color'), 'rose', 'Escape reverts the preview');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Custom color');
    // Tab stays inside the editor; an invalid value is flagged and not applied.
    await page.keyboard.press('Enter');
    await hex.fill('zz');
    await page.keyboard.press('Enter');
    assert.equal(await hex.getAttribute('aria-invalid'), 'true');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Apply');
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Pick a color');
    await hex.fill('1F8A70');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => window.fx.local['workspace.v1'].spaces[0].pinned[0].color === '#1f8a70');
    await folderPainted(page, 'custom', '#1f8a70');

    // A failed save shows a toast and puts the saved color back.
    await page.evaluate(() => {
      const area = chrome.storage.local;
      window.restoreSet = area.set;
      area.set = async () => { throw new Error('Storage is full.'); };
    });
    await head.click({ button: 'right' });
    await page.getByRole('menuitemradio', { name: /Custom color/ }).click();
    await hex.fill('#c0392b');
    await page.keyboard.press('Enter');
    await page.locator('#toast').waitFor({ state: 'visible' });
    assert.match(await page.locator('#toast-text').innerText(), /Storage is full/);
    await folderPainted(page, 'custom', '#1f8a70');
    assert.equal((await stored()).color, '#1f8a70');
    await page.evaluate(() => { chrome.storage.local.set = window.restoreSet; });

    // Dark scheme: the clamped custom color keeps the title readable.
    await page.evaluate(async () => {
      const { applyAppearance } = await import('/workspace.js');
      applyAppearance({ ...window.fx.appearance, colorMode: 'dark' });
    });
    const dark = await titleContrast(page);
    assert.ok(dark.ratio >= 4.5, `dark row title contrast ${dark.ratio.toFixed(2)}`);
    await page.locator('#toast').evaluate((node) => { node.hidden = true; });
    await page.screenshot({ animations: 'disabled', path: `${evidence}/folder-colors-row-dark.png` });

    // Light tint colors the glyph and the whole card evenly, without a row band.
    await page.evaluate(async () => {
      const value = structuredClone(window.fx.local['workspace.v1']);
      value.prefs.folderColors = 'icon';
      await chrome.storage.local.set({ 'workspace.v1': value });
      const { applyAppearance } = await import('/workspace.js');
      applyAppearance({ ...window.fx.appearance, colorMode: 'light' });
    });
    await page.waitForFunction(() => document.getElementById('sidebar').dataset.folderColors === 'icon');
    assert.equal(await head.evaluate((node) => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
    const card = await head.evaluate((node) => {
      const { backgroundColor } = getComputedStyle(node.parentElement);
      const probe = node.parentElement.appendChild(document.createElement('i'));
      probe.style.color = 'color-mix(in srgb, var(--folder-color) 8%, transparent)';
      const expected = getComputedStyle(probe).color;
      probe.remove();
      return { backgroundColor, expected };
    });
    assert.equal(card.backgroundColor, card.expected, 'the card carries a trace of its own color');
    assert.notEqual(await head.locator('.folder-glyph').evaluate((node) => getComputedStyle(node).color),
      await page.locator('.row:not(.folder-row) .title').first().evaluate((node) => getComputedStyle(node).color));
    await page.screenshot({ animations: 'disabled', path: `${evidence}/folder-colors-icon-light.png` });

    // Off hides a saved color while keeping the palette available. Reset can
    // clear that saved color without enabling the display.
    await page.evaluate(async () => {
      const value = structuredClone(window.fx.local['workspace.v1']);
      value.prefs.folderColors = 'off';
      await chrome.storage.local.set({ 'workspace.v1': value });
    });
    await page.waitForFunction(() => document.getElementById('sidebar').dataset.folderColors === 'off');
    assert.equal(await glyphColor(), neutral);
    assert.deepEqual(await stored(), { color: '#1f8a70', mode: 'off' });
    await head.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Reset color' }).click();
    await page.waitForFunction(() => !('color' in window.fx.local['workspace.v1'].spaces[0].pinned[0]));
    await folderPainted(page, null, null);
    assert.deepEqual(await stored(), { color: null, mode: 'off' });
    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally { await new Promise((done) => server.close(done)); }
  }
});
