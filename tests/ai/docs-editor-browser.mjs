import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
const { BrowserTools } = await import(process.env.BREEZER_CONTROL_MODULE || '../../features/ai/extension/browser-tools.js');

// A synthetic Docs-shaped document, not an authenticated Google Doc. No site
// requests, credentials, personal profile, extension permission grants or native build.
const playwrightModule = process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright';
const { chromium } = await import(playwrightModule);
let browser;
const url = 'https://docs.google.com/document/d/disposable-fixture/edit';
const html = `<!doctype html><meta charset="utf-8"><title>Disposable editor fixture</title><style>
body{margin:0;background:#eef0f3;font:16px system-ui;color:#253247}header{padding:24px;background:white}main{position:relative;margin:35px auto;width:700px;height:500px;background:white;border:1px solid #ccd2db}canvas{width:700px;height:500px}.kix-hit{position:absolute;inset:0}iframe{position:absolute;left:-10000px;width:10px;height:10px}#output{position:absolute;left:50px;top:50px;white-space:pre-wrap;pointer-events:none}</style>
<header>Disposable canvas editor · synthetic Docs workflow</header><main class="kix-appview-editor" role="textbox" aria-label="Document editor"><canvas width="700" height="500"></canvas><div class="kix-hit"></div><div id="output"></div></main><iframe class="docs-texteventtarget-iframe"></iframe>
<script>const frame=document.querySelector('iframe');const doc=frame.contentDocument;doc.body.contentEditable='true';doc.body.setAttribute('role','textbox');window.events=[];doc.body.addEventListener('input', e=>{events.push({type:e.type,trusted:e.isTrusted});document.querySelector('#output').textContent=doc.body.innerText});document.querySelector('main').addEventListener('mousedown',event=>{event.preventDefault();doc.body.focus()});</script>`;
let tools;
try {
  browser = await chromium.launch({ executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 750 } });
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: html }));
  await page.goto(url);
  const cdp = await page.context().newCDPSession(page);
  const tab = { id: 1, windowId: 1, url };
  const calls = [];
  const api = {
    tabs: { query: async () => [{ ...tab, url: page.url() }] },
    debugger: { attach: async () => {}, detach: async () => {}, sendCommand: async (_target, method, args) => { calls.push(method); return cdp.send(method, args); } },
  };
  tools = new BrowserTools(api);
  tools.authorize(tab);
  cdp.on('Runtime.bindingCalled', params => tools.debuggerEvent({ tabId: 1 }, 'Runtime.bindingCalled', params));
  let session = await tools.start('docs-fixture', tab);
  let snapshot = await tools.snapshot(tab, session);
  assert.ok(snapshot.screenshot, 'authorization and capture succeed before editing');
  let editor = snapshot.elements.find(el => el.label === 'Document editor') || snapshot.elements.find(el => el.tag === 'canvas');
  assert.ok(editor, 'document target is discoverable');
  // Clicking the painted page must reach the editor through its transparent hit layer.
  snapshot = await tools.execute(session, 'browser_click', { elementId: editor.id });
  assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'IFRAME');
  editor = snapshot.elements.find(el => el.label === 'Document editor') || snapshot.elements.find(el => el.tag === 'canvas');
  snapshot = await tools.execute(session, 'browser_type', { elementId: editor.id, text: 'Hello, Docs!', mode: 'insert' });
  assert.equal(await page.locator('#output').innerText(), 'Hello, Docs!');
  snapshot = await tools.execute(session, 'browser_key', { key: 'ArrowLeft', shift: true });
  editor = snapshot.elements.find(el => el.label === 'Document editor') || snapshot.elements.find(el => el.tag === 'canvas');
  // Follow-up editing uses the existing selection; it must not re-click and reset it.
  await tools.execute(session, 'browser_type', { elementId: editor.id, text: '?', mode: 'insert' });
  assert.equal(await page.locator('#output').innerText(), 'Hello, Docs?');
  assert.ok((await page.evaluate(() => events)).every(event => event.trusted));
  assert.equal(calls.filter(method => method === 'Input.insertText').length, 2);
  const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-docs-control-evidence';
  await mkdir(evidence, { recursive: true });
  await page.screenshot({ path: `${evidence}/docs-editor-fixture.png` });
  const inputCount = () => calls.filter(method => method.startsWith('Input.')).length;
  const currentEditor = async () => (await tools.snapshot(tab, session)).elements.find(el => el.type === 'canvas-editor');
  const insert = async text => tools.execute(session, 'browser_type', { elementId: (await currentEditor()).id, text, mode: 'insert' });
  const reset = async (targetURL = url) => {
    await tools.stop();
    await page.goto(targetURL);
    tools.authorize({ ...tab, url: targetURL }); // simulate a fresh explicit user grant
    session = await tools.start('docs-security', { ...tab, url: targetURL });
  };
  const focusEditor = async () => tools.execute(session, 'browser_click', { elementId: (await currentEditor()).id });
  // Fresh snapshot IDs invalidate older handles.
  const stale = editor.id;
  let before = inputCount();
  await assert.rejects(tools.execute(session, 'browser_type', { elementId: stale, text: 'blocked', mode: 'insert' }), /snapshot/);
  assert.equal(inputCount(), before);
  // A changed field, even within the allowed frame, cannot receive input.
  await page.evaluate(() => document.querySelector('iframe').contentDocument.body.id = 'api_token');
  before = inputCount();
  await assert.rejects(insert('blocked'), /passwords or secret/);
  await assert.rejects(tools.execute(session, 'browser_key', { key: 'ArrowLeft' }), /passwords or secret/);
  assert.equal(inputCount(), before);
  await reset();
  before = inputCount();
  await assert.rejects(insert('blocked'), /Click the document editor/);
  assert.equal(inputCount(), before, 'insertion does not focus a target on its own');
  await focusEditor();
  await page.evaluate(() => document.querySelector('iframe').remove());
  before = inputCount();
  await assert.rejects(insert('blocked'), /changed or lost focus/);
  assert.equal(inputCount(), before);
  await reset();
  await focusEditor();
  await page.evaluate(() => history.pushState({}, '', '/document/d/different-document/edit'));
  before = inputCount();
  await assert.rejects(insert('blocked'), /changed or lost focus/);
  assert.equal(inputCount(), before, 'same-document navigation invalidates the editor binding');
  await reset();
  await focusEditor();
  await page.evaluate(() => document.querySelector('iframe').src = '/replacement-frame');
  await page.waitForFunction(() => document.querySelector('iframe').contentDocument?.URL.endsWith('/replacement-frame'));
  before = inputCount();
  await assert.rejects(insert('blocked'), /changed or lost focus/);
  assert.equal(inputCount(), before, 'frame navigation invalidates the exact document binding');
  await reset();
  await focusEditor();
  await page.evaluate(() => document.querySelector('iframe').src = 'https://other-origin.test/input');
  await page.waitForFunction(() => !document.querySelector('iframe').contentDocument);
  before = inputCount();
  await assert.rejects(insert('blocked'), /changed or lost focus/);
  await assert.rejects(tools.execute(session, 'browser_key', { key: 'Enter' }), /changed or lost focus/);
  assert.equal(inputCount(), before, 'cross-origin frames remain outside the action scope');
  await reset('https://unrelated.test/document/d/disposable-fixture/edit');
  assert.ok(!(await tools.snapshot(tab, session)).elements.some(el => el.type === 'canvas-editor'));
  before = inputCount();
  await assert.rejects(tools.execute(session, 'browser_mouse', { action: 'click', x: 400, y: 300 }), /canvas/);
  assert.equal(inputCount(), before, 'a matching CSS class on another site grants nothing');
  await reset();
  await focusEditor();
  const oldProtocol = tools.protocol.bind(tools);
  let mutate = true;
  tools.protocol = async (...args) => {
    const result = await oldProtocol(...args);
    if (mutate && args[1] === 'Runtime.callFunctionOn' && args[2].arguments[0].value === 'editor-focus') {
      mutate = false;
      await page.evaluate(() => document.querySelector('iframe').contentDocument.body.id = 'password');
    }
    return result;
  };
  before = inputCount();
  await assert.rejects(insert('blocked'), /passwords or secret/);
  assert.equal(inputCount(), before, 'focus is revalidated immediately before native insertion');
  tools.protocol = oldProtocol;
  await reset();
  await focusEditor();
  let cancel = true;
  tools.protocol = async (...args) => {
    const result = await oldProtocol(...args);
    if (cancel && args[1] === 'Runtime.callFunctionOn' && args[2].arguments[0].value === 'editor-focus') {
      cancel = false;
      await tools.stop(session);
    }
    return result;
  };
  before = inputCount();
  await assert.rejects(insert('blocked'), /stopped/);
  assert.equal(inputCount(), before, 'Stop discards an insertion after focus validation');
  tools.protocol = oldProtocol;
  await reset();
  await focusEditor();
  // A visible frame is masked rather than disclosing fields outside the outer DOM.
  await page.evaluate(() => { const frame = document.querySelector('iframe'); frame.style.cssText = 'position:fixed;left:200px;top:200px;width:100px;height:100px'; });
  await tools.injectControl(session, 'screenshot-mask');
  try {
  const { PNG } = createRequire(playwrightModule.startsWith('/') ? playwrightModule : import.meta.url)('pngjs');
    const pixels = PNG.sync.read(await page.screenshot());
    const offset = (250 * pixels.width + 250) * 4;
    assert.deepEqual([...pixels.data.subarray(offset, offset + 3)], [23, 32, 51], 'visible frame pixels are redacted');
  } finally { await tools.injectControl(session, 'screenshot-mask-stop'); }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('[data-breezer-ai="control"]'));
  assert.ok(session.stopped, 'Escape inside the focused frame stops the control session');
  await session.stopping;
  const { frameTree } = await cdp.send('Page.getFrameTree');
  const { executionContextId } = await cdp.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'breezer-ai' });
  const cleared = await cdp.send('Runtime.evaluate', { contextId: executionContextId, expression: '!__breezerAIContext.editor', returnByValue: true });
  assert.equal(cleared.result.value, true, 'Stop clears the frame binding and Escape listener');
  console.log('PASS frame restrictions: stale handles, secret fields, detached/navigated/cross-origin frames, site scope, late focus changes, cancellation and frame Escape.');
  console.log('PASS synthetic Docs workflow: capture, editor hit layer, focused frame typing, selection and follow-up edit. Authenticated Docs/native acceptance NOT tested.');
} finally {
  try { await tools?.stop(); } finally { await browser?.close(); }
}
