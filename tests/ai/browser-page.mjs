import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { BrowserTools, CONTROL_WORLD } from '../../features/ai/extension/browser-tools.js';

// Real Chromium DOM, isolated-world injection, rendering and trusted CDP input.
// Chrome extension API transport is a fixture; this does not test a native build.
const playwrightModule = process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(playwrightModule);
const require = createRequire(playwrightModule.startsWith('/') ? playwrightModule : import.meta.url);
const { PNG } = require('pngjs');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
await mkdir(evidence, { recursive: true });
let firstOrigin;
let secondOrigin;
const server = createServer((request, response) => {
  if (request.url === '/slow') {
    response.setHeader('Content-Type', 'text/html');
    response.write('<!doctype html><html><head><title>Loading fixture</title></head><body>Loading');
    setTimeout(() => response.end('</body></html>'), 1500);
    return;
  }
  response.setHeader('Content-Type', 'text/html');
  response.end(`<!doctype html><html><head><title>Breezer control fixture</title><style>
    body{font:16px system-ui;background:#f5f7fa;color:#17304c;padding:90px 100px;margin:0}main{max-width:700px;background:white;border:1px solid #dbe2ea;border-radius:18px;padding:36px}h1{margin-top:0;font-size:28px}label{display:block;margin-top:22px;font-weight:600}input{display:block;box-sizing:border-box;width:100%;padding:13px;margin-top:8px;border:1px solid #b7c5d7;border-radius:8px;font:16px system-ui}button{margin-top:24px;padding:12px 18px;background:#163e6c;color:white;border:0;border-radius:8px;font:15px system-ui}p{line-height:1.6;color:#64748b}
    </style></head><body><main><h1>A visible, scoped browser assistant</h1><p>Breezer can work with this page while the blue wave and AI pointer are visible. Press Escape or Stop to end control.</p>
    <label for="destination">Destination</label><input id="destination" value="UNSHARED-INPUT-VALUE">
    <label for="password">Password</label><input id="password" type="password" value="DUMMY-PASSWORD-SECRET">
    <label for="api-token">API token</label><input id="api-token" name="api_token" value="DUMMY-TOKEN-SECRET">
    <button id="save">Save note</button><p id="result" aria-live="polite">Ready</p><a id="next-site" href="${request.headers.host === new URL(firstOrigin).host ? secondOrigin : firstOrigin}">Visit other site</a><div hidden>HIDDEN-TEXT-SECRET</div><div style="opacity:0"><span>HIDDEN-ANCESTOR-SECRET</span></div></main><script>
    window.events=[];destination.addEventListener('input',event=>events.push({type:'input',trusted:event.isTrusted}));save.addEventListener('click',event=>{events.push({type:'click',trusted:event.isTrusted});result.textContent='Note saved'});
    </script></body></html>`);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
firstOrigin = `http://127.0.0.1:${server.address().port}`;
const secondServer = createServer(server.listeners('request')[0]);
await new Promise(resolve => secondServer.listen(0, '127.0.0.1', resolve));
secondOrigin = `http://127.0.0.1:${secondServer.address().port}`;
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const browser = await chromium.launch({ ...(executablePath ? { executablePath } : {}), headless: true });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 }, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', error => errors.push(error.message));
let tools;
try {
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  assert.equal(await page.title(), 'Breezer control fixture');
  const cdp = await page.context().newCDPSession(page);
  const evaluate = async expression => {
    const response = await cdp.send('Runtime.evaluate', { expression, contextId: tools.session.world.executionContextId, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  };
  const tab = { id: 1, windowId: 1, url: page.url() };
  let redactionChecks = 0;
  let readOnlyCaptures = 0;
  let loading = false;
  let liveURL = page.url();
  let attached = false;
  const inspectCapture = async () => {
    const screenshot = await page.screenshot({ path: `${evidence}/browser-control.png` });
    const png = PNG.sync.read(screenshot);
    for (const selector of ['#password', '#api-token']) {
      const rect = await page.locator(selector).boundingBox();
      const offset = (Math.floor(rect.y + rect.height / 2) * png.width + Math.floor(rect.x + rect.width / 2)) * 4;
      assert.deepEqual([...png.data.subarray(offset, offset + 3)], [23, 32, 51], `${selector} is covered in captured pixels`);
      redactionChecks++;
    }
  };
  const api = {
    tabs: {
      query: async () => [{ ...tab, url: liveURL, status: loading ? 'loading' : 'complete' }],
      update: async (id, args) => { assert.equal(id, 1); await page.goto(args.url, { waitUntil: 'commit' }); },
      captureVisibleTab: async () => { readOnlyCaptures++; throw new Error('activeTab is unavailable after leaving the initial origin'); },
    },
    scripting: { executeScript: async options => {
      assert.equal(options.world, 'ISOLATED');
      assert.equal(options.target.tabId, 1);
      if (new URL(liveURL).origin !== firstOrigin) throw new Error('activeTab is unavailable on this origin');
      const { frameTree } = await cdp.send('Page.getFrameTree');
      const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'breezer-permission-fixture' });
      const response = await cdp.send('Runtime.callFunctionOn', { executionContextId, functionDeclaration: options.func.toString(), arguments: (options.args || []).map(value => ({ value })), returnByValue: true, awaitPromise: true });
      if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
      return [{ result: response.result.value }];
    } },
    debugger: {
      attach: async () => { assert.equal(attached, false); attached = true; },
      detach: async () => { attached = false; },
      sendCommand: async (target, method, args) => {
        assert.equal(target.tabId, 1);
        assert.equal(attached, true);
        const result = await cdp.send(method, args);
        if (method === 'Page.captureScreenshot') {
          assert.deepEqual(args, { format: 'jpeg', quality: 65, captureBeyondViewport: false });
          await inspectCapture();
        }
        return result;
      },
    },
  };
  tools = new BrowserTools(api);
  const execute = tools.execute.bind(tools);
  tools.execute = async (session, name, args) => {
    try { return await execute(session, name, args); }
    catch (error) {
      error.message = `${name} (loading=${loading}, url=${liveURL}): ${error.message}`;
      throw error;
    }
  };
  for (const method of ['Runtime.executionContextCreated', 'Runtime.executionContextDestroyed', 'Runtime.executionContextsCleared', 'Runtime.bindingCalled', 'Page.frameStartedLoading', 'Page.loadEventFired']) {
    cdp.on(method, params => {
      if (method === 'Page.frameStartedLoading' && params.frameId === tools.session?.mainFrameId) loading = true;
      if (method === 'Page.loadEventFired') loading = false;
      tools.debuggerEvent({ tabId: 1 }, method, params);
    });
  }
  cdp.on('Page.frameNavigated', params => { if (!params.frame.parentId) liveURL = params.frame.url; });
  assert.equal(await tools.verifyGrant(tab), true);
  let session = await tools.start('test-control', tab);
  assert.equal(await page.locator('[data-breezer-ai="control"]').count(), 1);
  // The wave animates compositor-only properties and never takes page input.
  const waveAnimations = () => evaluate(`__breezerAIContext.pointer.getRootNode().getAnimations().filter(animation => animation.playState === 'running').map(animation => [...new Set(animation.effect.getKeyframes().flatMap(frame => Object.keys(frame).filter(key => !['offset', 'computedOffset', 'easing', 'composite'].includes(key))))])`);
  const animated = await waveAnimations();
  assert.ok(animated.length >= 8, 'the four edges each run layered flow animations');
  assert.deepEqual([...new Set(animated.flat())].sort(), ['opacity', 'transform']);
  for (const [x, y] of [[4, 400], [550, 4], [1096, 400], [550, 846]]) {
    assert.equal(await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('[data-breezer-ai]') ?? null, [x, y]), null, `the wave at ${x},${y} must not block input`);
  }
  await new Promise(resolve => setTimeout(resolve, 400));
  await page.screenshot({ path: `${evidence}/browser-control-wave.png` });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  assert.deepEqual(await waveAnimations(), [], 'reduced motion stops the wave');
  await page.screenshot({ path: `${evidence}/browser-control-wave-reduced-motion.png` });
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  let snapshot = await tools.snapshot(tab, session);
  assert.match(snapshot.screenshot, /^data:image\/jpeg;base64,/);
  assert.equal(snapshot.elements.some(element => ['password', 'api-token'].includes(element.label.toLowerCase())), false);
  assert.equal(/DUMMY-|UNSHARED-|HIDDEN-TEXT|HIDDEN-ANCESTOR/.test(JSON.stringify(snapshot.elements) + snapshot.text), false);
  const field = snapshot.elements.find(element => element.label === 'Destination');
  assert.ok(field);
  assert.equal(await page.locator('#destination').inputValue(), 'UNSHARED-INPUT-VALUE');
  const firstWorld = session.world.executionContextId;
  snapshot = await tools.execute(session, 'browser_type', { elementId: field.id, text: 'A calmer browser' });
  assert.equal(await page.locator('#destination').inputValue(), 'A calmer browser');
  assert.equal(session.world.executionContextId, firstWorld, 'target handles stay in the same isolated world');
  assert.ok((await page.evaluate(() => events)).some(event => event.type === 'input' && event.trusted));
  const save = snapshot.elements.find(element => element.label === 'Save note');
  snapshot = await tools.execute(session, 'browser_click', { elementId: save.id });
  assert.equal(await page.locator('#result').innerText(), 'Note saved');
  assert.ok((await page.evaluate(() => events)).some(event => event.type === 'click' && event.trusted));
  assert.equal(await evaluate(`__breezerAIContext.pointer.textContent`), 'Breezer');
  const saveBox = await page.locator('#save').boundingBox();
  await new Promise(resolve => setTimeout(resolve, 300));
  const tip = await evaluate(`(() => { const box = __breezerAIContext.pointer.querySelector('svg').getBoundingClientRect(); return { x: box.x + 3, y: box.y + 2 }; })()`);
  assert.ok(Math.abs(tip.x - (saveBox.x + saveBox.width / 2)) < 2 && Math.abs(tip.y - (saveBox.y + saveBox.height / 2)) < 2, `the visible pointer tip lands on the clicked element: ${JSON.stringify({ tip, saveBox })}`);
  await assert.rejects(tools.execute(session, 'browser_click', { elementId: save.id }), /changed/);
  await page.locator('#password').focus();
  await assert.rejects(tools.execute(session, 'browser_key', { key: 'Enter' }), /passwords/);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-breezer-ai="control"]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.stopped, true);
  await assert.rejects(tools.execute(session, 'browser_click', { elementId: snapshot.elements[0].id }), /stopped/);
  await session.stopping;
  session = await tools.start('stop-button', { ...tab, url: liveURL });
  await evaluate(`__breezerAIContext.pointer.getRootNode().querySelector('button').click()`);
  await page.waitForFunction(() => !document.querySelector('[data-breezer-ai="control"]'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(session.stopped, true);
  await session.stopping;
  session = await tools.start('cross-origin', { ...tab, url: liveURL });
  snapshot = await tools.execute(session, 'browser_navigate', { url: `${secondOrigin}/destination` });
  assert.equal(new URL(snapshot.url).origin, secondOrigin);
  assert.notEqual(session.world.executionContextId, firstWorld);
  assert.equal(await page.locator('[data-breezer-ai="control"]').count(), 1);
  assert.equal(await tools.verifyGrant({ ...tab, url: liveURL }), false, 'read-only page access is not granted by control navigation');
  await assert.rejects(tools.current(1), /Cmd\+K/);
  const secondField = snapshot.elements.find(element => element.label === 'Destination');
  snapshot = await tools.execute(session, 'browser_type', { elementId: secondField.id, text: 'Across origins' });
  assert.equal(await page.locator('#destination').inputValue(), 'Across origins');
  const link = snapshot.elements.find(element => element.label === 'Visit other site');
  await tools.execute(session, 'browser_click', { elementId: link.id });
  await page.waitForURL(`${firstOrigin}/`);
  snapshot = await tools.execute(session, 'browser_snapshot');
  assert.equal(new URL(snapshot.url).origin, firstOrigin);
  assert.equal(session.stopped, false);
  assert.equal(readOnlyCaptures, 0, 'control uses tab-scoped debugger screenshots');
  const slowNavigation = tools.execute(session, 'browser_navigate', { url: `${secondOrigin}/slow` });
  const cancelledNavigation = assert.rejects(slowNavigation, /stopped/);
  await page.waitForURL(`${secondOrigin}/slow`, { waitUntil: 'commit' });
  await page.locator('[data-breezer-ai="control"]').waitFor();
  await page.keyboard.press('Escape');
  await cancelledNavigation;
  await session.stopping;
  assert.equal(session.stopped, true);
  assert.equal(attached, false);
  assert.equal(await page.locator('[data-breezer-ai="control"]').count(), 0);
  assert.equal(await page.evaluate(() => document.getAnimations().length), 0, 'cancellation leaves no running wave animations');
  assert.ok(redactionChecks >= 10);
  assert.deepEqual(errors, []);
  console.log('PASS: real Chromium isolated-world snapshots, secret exclusion and pixel redaction, flowing blue wave (transform/opacity only, input pass-through, reduced motion, clean removal) and visible AI pointer, trusted replacement/click, cross-origin tool and link navigation, stale-target/password refusal, Escape/Stop cancellation including a loading page.');
  console.log(`Evidence: ${evidence}/browser-control.png`);
} finally {
  await tools?.stop();
  await browser.close();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => secondServer.close(resolve))]);
}
