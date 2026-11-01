import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, cp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
let chromium;
try { ({ chromium } = await import('playwright')); } catch {}

const fixture = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Cuaderno de viaje</title><style>
body{max-width:760px;margin:60px auto;font:18px/1.6 Georgia;color:#17302c;background:#eff8f4}h1{font-size:38px}input,button{padding:9px}pre{background:white;padding:12px}iframe{height:40px} .hidden{display:none}
</style></head><body><h1>Cuaderno de viaje</h1><p id="hello"> Hola <strong>mundo</strong>. </p><p id="article">La biblioteca abre por la mañana. Puedes leer junto a la ventana y escuchar los pájaros.</p><a id="link" href="/next">Continuar leyendo</a><form id="form"><label>Correo<input name="email" value="private@example.test"></label><select name="choice"><option>Original choice</option></select><button>Enviar</button></form><div contenteditable="true">Editor privado</div><p translate="no">No traducir</p><p class="notranslate">Keep me</p><p class="hidden">Hidden secret</p><pre>const password = 'excluded';</pre><iframe srcdoc="<p>Frame secret</p>"></iframe><p id="injection">Inyección</p><div id="dynamic"></div></body></html>`;
const listen = (server, port = 0, host = '127.0.0.1') => new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, () => resolve(server.address().port)); });
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const languages = [{ code: 'en', name: 'English', targets: ['es'] }, { code: 'es', name: 'Spanish', targets: ['en'] }];

test('real disposable Chromium extension: provider path, DOM identity, restore, dynamic content, failure/cancel/retry and navigation', { skip: process.env.BREEZER_TRANSLATION_LIVE ? 'Run separately from live provider acceptance' : (!chromium && 'Playwright not installed'), timeout: 120000 }, async t => {
  const temporary = await mkdtemp(join(tmpdir(), 'breezer-translation-'));
  const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-translation-evidence';
  await mkdir(evidence, { recursive: true });
  const requests = []; let fail = false, delay = 0, onRequest;
  const provider = createServer(async (req, res) => {
    if (req.url === '/languages') { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(languages)); return; }
    if (req.method !== 'POST' || req.url !== '/translate') { res.statusCode = 404; res.end(); return; }
    let body = '';
    try { for await (const chunk of req) body += chunk; } catch { return; }
    if (!body || req.aborted) { res.statusCode = 400; res.end(); return; }
    const data = JSON.parse(body); requests.push(data); onRequest?.(); onRequest = null;
    if (delay) await new Promise(resolve => setTimeout(resolve, delay));
    res.setHeader('Content-Type', 'application/json');
    if (fail) { res.statusCode = 429; res.end('{"error":"private error"}'); return; }
    res.end(JSON.stringify({ translatedText: data.q.map(text => text === 'Inyección' ? '<img src=x onerror=alert(1)>' : 'English: ' + text) }));
  });
  const server = createServer((req, res) => { res.setHeader('Content-Type', req.url === '/plain' ? 'text/plain' : 'text/html'); res.end(req.url === '/plain' ? 'Hola mundo' : fixture); });
  let context;
  t.after(async () => { await context?.close(); await close(server); if (provider.listening) await close(provider); await rm(temporary, { recursive: true, force: true }); });
  try { await listen(provider, 5000, 'localhost'); } catch (error) { t.skip('Disposable provider port unavailable: ' + error.code); return; }
  const port = await listen(server);
  const extension = join(temporary, 'extension');
  await cp(resolve('features/ai/extension'), extension, { recursive: true });
  // Only the shipped translation subsystem runs. Fixture-only host grants replace
  // native activeTab invocation and optional permission prompts in this test.
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Breezer translation acceptance fixture', version: '1.0', permissions: ['activeTab', 'scripting', 'tabs', 'contextMenus', 'storage'], host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'], background: { service_worker: 'fixture-worker.js', type: 'module' } }));
  await writeFile(join(extension, 'fixture-worker.js'), "import { installTranslation } from './translation-background.js'; installTranslation(chrome);");
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 960, height: 950 } });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage(); await page.goto('http://127.0.0.1:' + port + '/article');
  await page.evaluate(() => {
    window.original = document.body.innerHTML;
    window.nodes = ['hello', 'article', 'link', 'form'].map(id => document.getElementById(id));
    window.submits = 0; document.getElementById('form').addEventListener('submit', event => { event.preventDefault(); window.submits++; });
  });
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, page.url());
  let ui = await context.newPage();
  await ui.goto('chrome-extension://' + extensionId + '/translation.html?tab=' + tabId);
  let status = ui.locator('#status');
  await ui.locator('#languages').click();
  await ui.waitForFunction(() => document.getElementById('source').options.length > 1);
  assert.equal(requests.length, 0, 'loading languages sends no page text');
  assert.equal(await ui.locator('#translate').isDisabled(), true, 'consent is required');
  await ui.locator('#source').selectOption('es'); await ui.locator('#target').selectOption('en');
  await ui.locator('#dynamic').check(); await ui.locator('#consent').check();
  await ui.locator('#translate').click(); await ui.waitForFunction(() => document.getElementById('status').textContent.includes('Watching'));
  assert.equal(await ui.locator('#cancel').isEnabled(), true, 'watching can be stopped without restoring');
  assert.match(await page.locator('#article').textContent(), /^English:/);
  assert.equal(await page.locator('#hello').textContent(), ' English: Hola English: mundo. ');
  assert.equal(await page.locator('#injection img').count(), 0); assert.match(await page.locator('#injection').textContent(), /<img/);
  assert.equal(await page.evaluate(() => window.nodes.every(n => n === document.getElementById(n.id))), true);
  assert.equal(await page.locator('input').inputValue(), 'private@example.test');
  await page.locator('button').click(); assert.equal(await page.evaluate(() => window.submits), 1);
  assert.equal(await page.locator('select').inputValue(), 'Original choice');
  const submitted = requests.flatMap(r => r.q).join(' ');
  for (const excluded of ['Editor privado', 'No traducir', 'Hidden secret', 'Frame secret', 'Original choice', 'private@example.test', 'password']) assert.equal(submitted.includes(excluded), false, excluded);
  assert.ok(requests.every(r => r.source === 'es' && r.target === 'en' && r.format === 'text' && !r.api_key));
  // Exercise real MV3 inactivity beyond its 30-second idle deadline.
  await ui.waitForTimeout(35000);
  assert.equal(await ui.locator('#restore').isEnabled(), true);
  await page.evaluate(() => { document.getElementById('dynamic').textContent = 'Texto nuevo'; });
  await page.waitForFunction(() => document.getElementById('dynamic').textContent.startsWith('English:'));
  await page.screenshot({ path: join(evidence, 'translation-page-fixture.png'), fullPage: true });
  await ui.screenshot({ path: join(evidence, 'translation-controls-fixture.png') });
  const beforeClose = requests.length;
  await ui.close();
  assert.match(await page.locator('#article').textContent(), /^English:/);
  ui = await context.newPage(); await ui.goto('chrome-extension://' + extensionId + '/translation.html?tab=' + tabId);
  status = ui.locator('#status');
  await ui.waitForFunction(() => document.getElementById('status').textContent.includes('remains'));
  assert.equal(await ui.locator('#languages').isEnabled(), true);
  assert.equal(await ui.locator('#consent').isChecked(), false, 'sharing confirmation is not persisted');
  assert.equal(requests.length, beforeClose);
  await ui.locator('#restore').click(); await ui.waitForFunction(() => document.getElementById('status').textContent.includes('restored'));
  assert.equal(await page.locator('#article').textContent(), 'La biblioteca abre por la mañana. Puedes leer junto a la ventana y escuchar los pájaros.');
  assert.equal(await page.locator('#hello').textContent(), ' Hola mundo. ');
  assert.equal(await page.locator('#dynamic').textContent(), 'Texto nuevo');
  await ui.locator('#languages').click(); await ui.waitForFunction(() => document.getElementById('source').options.length > 1);
  await ui.locator('#consent').check();
  await page.evaluate(() => {
    const long = document.createElement('p'); long.id = 'long'; long.textContent = 'Documento largo. '.repeat(600); document.body.append(long);
    for (let i = 0; i < 80; i++) { const p = document.createElement('p'); p.className = 'many'; p.textContent = 'Párrafo ' + i; document.body.append(p); }
    const oversized = document.createElement('p'); oversized.id = 'oversized'; oversized.textContent = 'z'.repeat(100001); document.body.append(oversized);
  });
  fail = true;
  await ui.locator('#translate').click(); await ui.waitForFunction(() => document.getElementById('status').textContent.includes('rate limit'));
  assert.match(await status.textContent(), /Wait before retrying/);
  fail = false; delay = 800;
  const incoming = new Promise(resolve => { onRequest = resolve; });
  await ui.locator('#translate').click(); await incoming;
  await page.evaluate(() => { document.getElementById('article').textContent = 'Updated by the site during translation'; });
  await ui.locator('#cancel').click();
  await ui.waitForFunction(() => document.getElementById('status').textContent.includes('Stopped'));
  assert.equal(await page.locator('#hello').textContent(), ' Hola mundo. ');
  delay = 0;
  await ui.locator('#translate').click(); await ui.waitForFunction(() => document.getElementById('status').textContent.includes('Watching'));
  assert.equal(await page.locator('.many').evaluateAll(nodes => nodes.every(n => n.textContent.startsWith('English:'))), true);
  assert.match(await page.locator('#long').textContent(), /^English:/);
  assert.equal((await page.locator('#oversized').textContent()).length, 100001);
  assert.match(await status.textContent(), /safety limit/);
  assert.ok(requests.every(r => r.q.length <= 32 && r.q.reduce((n, text) => n + text.length, 0) <= 4000));
  await page.evaluate(() => history.pushState({}, '', '/next'));
  await ui.waitForFunction(() => document.getElementById('status').textContent.includes('Page changed'));
  assert.equal(await page.locator('#hello').textContent(), ' Hola mundo. ');
  assert.equal(await page.locator('#article').textContent(), 'Updated by the site during translation');
  assert.equal(await page.locator('#long').textContent(), 'Documento largo. '.repeat(600));
  const count = requests.length; await page.evaluate(() => { document.getElementById('dynamic').textContent = 'Never send after navigation'; });
  assert.equal(requests.length, count);
  await ui.close();
  const settings = await context.newPage();
  await settings.goto('chrome-extension://' + extensionId + '/translation.html?tab=' + tabId);
  await settings.evaluate(async () => {
    const { mountTranslationSettings } = await import('./translation-settings.js');
    document.body.replaceChildren(); const container = document.createElement('div'); document.body.append(container);
    await mountTranslationSettings({ container, api: chrome });
  });
  await settings.locator('#translation-provider').selectOption('hosted');
  await settings.locator('#translation-key').fill('fixture-secret');
  await settings.getByRole('button', { name: 'Save translation settings' }).click();
  await settings.waitForFunction(() => document.body.textContent.includes('Saved.'));
  assert.equal(await settings.locator('#translation-key').inputValue(), '');
  await settings.locator('#translation-provider').selectOption('local');
  await settings.getByRole('button', { name: 'Save translation settings' }).click();
  await settings.waitForFunction(async () => (await chrome.storage.local.get('translation.v1'))['translation.v1'].provider === 'local');
  const saved = await worker.evaluate(async () => (await chrome.storage.local.get('translation.v1'))['translation.v1']);
  assert.equal(saved.apiKey, '', 'changing provider never forwards its credential');
  assert.equal(saved.source, 'es'); assert.equal(saved.target, 'en');
  assert.equal(requests.length, count, 'settings and reopening never translate automatically');
});

test('live local LibreTranslate model translates the actual page in disposable Chromium', { skip: !process.env.BREEZER_TRANSLATION_LIVE && 'Set BREEZER_TRANSLATION_LIVE=1 with your local server running', timeout: 120000 }, async t => {
  assert.ok(chromium, 'Install Playwright first');
  const temporary = await mkdtemp(join(tmpdir(), 'breezer-translation-live-'));
  const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-translation-evidence';
  await mkdir(evidence, { recursive: true });
  const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html lang="es"><meta charset="utf-8"><title>Live translation check</title><body style="font:22px/1.6 Georgia;margin:60px"><h1>Hola mundo</h1><p id="text">La biblioteca abre por la mañana.</p><a href="/next">Continuar leyendo</a><input value="untouched"><button>Enviar</button></body></html>'); });
  let context;
  t.after(async () => { await context?.close(); await close(server); await rm(temporary, { recursive: true, force: true }); });
  const port = await listen(server);
  const extension = join(temporary, 'extension'); await cp(resolve('features/ai/extension'), extension, { recursive: true });
  await writeFile(join(extension, 'manifest.json'), JSON.stringify({ manifest_version: 3, name: 'Breezer live translation acceptance fixture', version: '1.0', permissions: ['activeTab', 'scripting', 'tabs', 'contextMenus', 'storage'], host_permissions: ['http://127.0.0.1/*', 'http://localhost/*'], background: { service_worker: 'fixture-worker.js', type: 'module' } }));
  await writeFile(join(extension, 'fixture-worker.js'), "import { installTranslation } from './translation-background.js'; installTranslation(chrome);");
  context = await chromium.launchPersistentContext(join(temporary, 'profile'), { channel: 'chromium', headless: true, args: ['--disable-extensions-except=' + extension, '--load-extension=' + extension], viewport: { width: 900, height: 700 } });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  const page = await context.newPage(); await page.goto('http://127.0.0.1:' + port + '/');
  const tabId = await worker.evaluate(async url => (await chrome.tabs.query({ url }))[0].id, page.url());
  const ui = await context.newPage(); await ui.goto('chrome-extension://' + new URL(worker.url()).host + '/translation.html?tab=' + tabId);
  await ui.setViewportSize({ width: 480, height: 700 });
  await ui.locator('#languages').click(); await ui.waitForFunction(() => document.getElementById('source').options.length > 1);
  await ui.locator('#source').selectOption('es'); await ui.locator('#target').selectOption('en');
  await ui.locator('#consent').check(); await ui.locator('#translate').click();
  await ui.waitForFunction(() => document.getElementById('status').textContent === 'Page translated.', undefined, { timeout: 90000 });
  const result = { source: 'es', target: 'en', heading: await page.locator('h1').textContent(), sentence: await page.locator('#text').textContent(), input: await page.locator('input').inputValue(), status: await ui.locator('#status').textContent(), browser: context.browser()?.version() };
  // Check real model execution, not a promise of linguistic quality. The backup
  // Spanish model can omit "mundo" in this short greeting; retain its exact output.
  assert.match(result.heading, /Hello/i); assert.match(result.sentence, /library.*morning/i); assert.equal(result.input, 'untouched');
  await page.screenshot({ path: join(evidence, 'translation-page-live.png') }); await ui.screenshot({ path: join(evidence, 'translation-controls-live.png') });
  await ui.locator('#restore').click(); await page.waitForFunction(() => document.querySelector('h1').textContent === 'Hola mundo');
  result.restored = await page.locator('#text').textContent(); assert.equal(result.restored, 'La biblioteca abre por la mañana.');
  await writeFile(join(evidence, 'translation-live.json'), JSON.stringify(result, null, 2));
});
