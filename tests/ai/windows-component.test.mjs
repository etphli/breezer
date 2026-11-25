import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { event, fakeChrome, tick } from './browser-api-fixture.mjs';
import { installFixture as installSettings } from './settings-browser-fixture.mjs';
import { CONNECTED, installFixture as installNewtab } from './newtab-browser-fixture.mjs';

const scripts = fileURLToPath(new URL('../../script', import.meta.url));
let directory;
let assets;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'breezer-windows-component-'));
  assets = join(directory, 'components', 'breezer_ai');
  const python = process.env.BREEZER_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  execFileSync(python, ['-B', '-c', [
    'import sys',
    'from pathlib import Path',
    'sys.path.insert(0, sys.argv[1])',
    'from apply_breezer_ai import resources',
    'resources(Path(sys.argv[2]), platform="windows")',
  ].join('\n'), scripts, directory]);
});
after(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

test('Windows keeps the first-party assistant and sends Organato requests to the native helper', async () => {
  const manifest = JSON.parse(await readFile(join(assets, 'manifest.json'), 'utf8'));
  const source = JSON.parse(await readFile(new URL('../../features/ai/extension/manifest.json', import.meta.url), 'utf8'));
  assert.equal(manifest.key, source.key);
  assert.equal(manifest.chrome_url_overrides.newtab, 'newtab.html');
  assert.deepEqual(manifest.action, source.action);
  assert.deepEqual(manifest.side_panel, source.side_panel);
  assert.deepEqual(manifest.commands['toggle-breezer-ai'], source.commands['toggle-breezer-ai']);
  assert.equal(manifest.commands['space-1'].suggested_key.default, 'Ctrl+Shift+1');
  for (const permission of ['nativeMessaging', 'debugger', 'sidePanel']) {
    assert.equal(manifest.permissions.includes(permission), true);
  }
  assert.equal(existsSync(join(assets, 'panel.html')), true);

  const { api, tab, native, calls } = fakeChrome();
  native.postMessage = (message) => queueMicrotask(() => native.onMessage.emit({
    id: message.id, ok: true, value: { enabled: true, dashboardEnabled: true, connected: false },
  }));
  api.topSites = { get: async () => [{ title: 'Canvas', url: 'https://canvas.example/' }] };
  const messages = [];
  api.runtime.sendMessage = async (message) => { messages.push(message); };
  api.runtime.connect = ({ name }) => {
    const outgoing = event(), incoming = event(), disconnected = event();
    api.runtime.onConnect.emit({
      name,
      sender: { id: api.runtime.id, url: api.runtime.getURL('newtab.html') },
      onMessage: outgoing,
      onDisconnect: disconnected,
      postMessage: message => incoming.emit(message),
    });
    return { onMessage: incoming, onDisconnect: disconnected, postMessage: message => outgoing.emit(message), disconnect: () => disconnected.emit() };
  };
  const { installBackground } = await import(pathToFileURL(join(assets, 'background.js')));
  const { requestView } = await import(pathToFileURL(join(assets, 'newtab.js')));
  installBackground(api);
  const view = await requestView(api, { timeoutMs: 1000 });
  assert.deepEqual(view.topSites, await api.topSites.get());
  assert.equal(view.organato.enabled, true);
  assert.equal(view.organato.connected, false);
  assert.equal(view.dashboardEnabled, true);
  assert.ok(calls.some(call => call[0] === 'native' && call[1] === 'io.github.etphli.breezer.ai'));
  await api.storage.local.set({ 'organato.switches.v1': { enabled: false, dashboardEnabled: false } });
  assert.equal((await requestView(api, { timeoutMs: 1000 })).dashboardEnabled, false);
  api.commands.onCommand.emit('space-2', tab);
  await tick();
  assert.deepEqual(messages, [{ type: 'breezer.workspace.space', windowId: tab.windowId, index: 1 }]);
});

let chromium;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

test('Windows settings, setup and new tab expose the supported features', { skip, timeout: 45_000 }, async (t) => {
  const server = createServer(async (request, response) => {
    try {
      const path = resolve(assets, `.${new URL(request.url, 'http://localhost').pathname}`);
      if (!path.startsWith(`${assets}${sep}`)) throw new Error('Outside fixture root');
      response.setHeader('Content-Type', ({
        '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png',
      })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  t.after(() => server.close());
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const errors = [];
  const settings = await browser.newContext({ reducedMotion: 'reduce' });
  await settings.addInitScript(installSettings, { colorMode: 'light', theme: 'mint' });
  const page = await settings.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/workspace.html#/settings/newtab`);
  await page.locator('[data-category="newtab"][aria-current="page"]').waitFor();
  assert.equal(await page.locator('[data-category="assistant"]').count(), 1);
  assert.equal(await page.locator('#update-check').count(), 0);
  assert.equal(await page.locator('#organato-key').isVisible(), true);
  await page.waitForFunction(() => Boolean(window.fx.ports['breezer-organato-settings']));

  await page.goto(`${base}/workspace.html#/welcome`);
  await page.locator('#welcome[data-ready="true"]').waitFor();
  assert.equal(await page.locator('#wl-stage-count').innerText(), 'Step 1 of 8');
  const next = page.locator('#wl-next');
  for (const step of ['you', 'layout', 'theme', 'import', 'organato', 'tour']) {
    await (step === 'tour' ? page.locator('#wl-organato-later') : next).click();
    await page.locator(`.wl-step[data-step="${step}"]`).waitFor();
  }
  for (const shortcut of ['Ctrl+T', 'Ctrl+Shift+1–4', 'Alt+F', 'Ctrl+Shift+K', 'esc']) {
    assert.ok((await page.locator('#wl-tour-keys').innerText()).includes(shortcut));
    await next.click();
  }
  await page.locator('.wl-step[data-step="done"]').waitFor();
  assert.match(await page.locator('#wl-summary').innerText(), /Breezer AI/);
  assert.equal(await page.evaluate(() => Boolean(window.fx.ports['breezer-updates'])), false);

  const newtab = await browser.newContext({ reducedMotion: 'reduce' });
  await newtab.addInitScript(installNewtab, { view: CONNECTED });
  const newPage = await newtab.newPage();
  newPage.on('pageerror', error => errors.push(error.message));
  await newPage.goto(`${base}/newtab.html`);
  await newPage.waitForSelector('html[data-loaded="true"]');
  assert.ok(await newPage.locator('.site-name').count() > 0);
  assert.equal(await newPage.locator('#organato').isVisible(), true);
  assert.equal(await newPage.locator('#organato').getAttribute('data-state'), 'ready');
  assert.deepEqual(errors, []);
});
