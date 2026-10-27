import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright');

// Live check of opted-in browser control in an installed Breezer.app.
// Uses a temporary profile and a loopback fixture; it never opens the user's session.
// It sends real requests through the signed-in provider, so it incurs inference usage.
const args = process.argv.slice(2);
assert.equal(args.shift(), '--run-live', 'Usage: node tests/ai/installed-control.mjs --run-live /path/to/Breezer.app [--follow-up]');
const app = args.shift();
const followUp = args[0] === '--follow-up' ? Boolean(args.shift()) : false;
assert.equal(args.length, 0, 'Unexpected arguments.');
assert.ok(app?.endsWith('/Breezer.app'), 'Pass the installed Breezer.app path.');
assert.equal(
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${app}/Contents/Info.plist`], { encoding: 'utf8' }).trim(),
  'io.github.etphli.breezer',
);

const extensionId = 'namgcidocfgliiedlkdafcmifpdfiakj';
const profile = await mkdtemp(join(tmpdir(), 'breezer-installed-control-profile-'));
const evidence = process.env.BREEZER_AI_EVIDENCE || await mkdtemp(join(tmpdir(), 'breezer-installed-control-evidence-'));
const fixtureTitle = 'Breezer control fixture';
const page = (body, title = fixtureTitle) => `<!doctype html><title>${title}</title><style>body{font:16px system-ui;margin:0;padding:48px 64px;background:#f6f8fb}main{max-width:620px}input{display:block;margin:8px 0 18px;padding:10px;width:320px;font:inherit}button{padding:10px 16px;font:inherit}.spacer{height:2400px}</style><main>${body}</main>`;
const reports = [];
const server = createServer((request, response) => {
  if (request.url.startsWith('/report?')) { reports.push(Object.fromEntries(new URL(request.url, 'http://fixture').searchParams)); response.end(); return; }
  response.setHeader('Content-Type', 'text/html');
  if (request.url === '/second') { response.end(page('<h1>Second fixture page</h1><p>Navigation reached this page.</p>', 'Breezer second fixture')); return; }
  response.end(page(`<h1>Control fixture</h1>
    <label for="destination">Destination</label><input id="destination" value="">
    <button id="save">Save note</button><p id="result">Ready</p><div class="spacer"></div><p id="bottom">Bottom of the page</p>
    <script>
      window.events = [];
      destination.addEventListener('input', event => events.push({ type: 'input', trusted: event.isTrusted }));
      const report = values => fetch('/report?' + new URLSearchParams(values));
      save.addEventListener('click', event => { events.push({ type: 'click', trusted: event.isTrusted }); result.textContent = 'Saved: ' + destination.value; report({ type: 'click', trusted: event.isTrusted, value: destination.value }); });
      addEventListener('scroll', () => { if (scrollY > 0 && !window.scrolled) { window.scrolled = true; report({ type: 'scroll' }); } });
    </script>`));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

let context;
let watchOverlay;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: `${app}/Contents/MacOS/Breezer`,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check'],
    viewport: { width: 1280, height: 850 },
  });
  const web = context.pages()[0] || await context.newPage();
  await web.goto(`${origin}/`);
  assert.equal(await web.title(), fixtureTitle);

  const worker = context.serviceWorkers().find(item => item.url() === `chrome-extension://${extensionId}/background.js`)
    || await context.waitForEvent('serviceworker', { predicate: item => item.url() === `chrome-extension://${extensionId}/background.js`, timeout: 30000 });
  const fixtureTab = await worker.evaluate(async url => (await chrome.tabs.query({})).find(tab => tab.url === url), `${origin}/`);
  assert.ok(Number.isInteger(fixtureTab?.windowId), 'The fixture tab was not found in the extension.');
  const windowId = fixtureTab.windowId;
  const panelUrl = `chrome-extension://${extensionId}/panel.html`;
  // Record every native-host message and tool result inside the real worker.
  await worker.evaluate(() => {
    globalThis.__breezerTrace = [];
    const connect = chrome.runtime.connectNative.bind(chrome.runtime);
    chrome.runtime.connectNative = name => {
      const port = connect(name);
      const postMessage = port.postMessage.bind(port);
      port.postMessage = message => { globalThis.__breezerTrace.push({ out: message.type, name: message.name, control: message.control, error: message.error, result: message.result ? Object.keys(message.result) : undefined }); return postMessage(message); };
      port.onMessage.addListener(message => globalThis.__breezerTrace.push({ in: message.type, name: message.name, args: message.args, error: message.error }));
      return port;
    };
  });

  const extensionPage = await context.newPage();
  await extensionPage.goto(panelUrl);
  await extensionPage.waitForSelector('#model-label');
  // Keep the fixture active so the panel attaches to it, not to this extension tab.
  await web.bringToFront();
  const extensionPageCdp = await context.newCDPSession(extensionPage);
  const openResult = await extensionPageCdp.send('Runtime.evaluate', {
    expression: `chrome.sidePanel.open({ windowId: ${windowId} })`,
    awaitPromise: true, returnByValue: true, userGesture: true,
  });
  assert.equal(openResult.exceptionDetails, undefined, openResult.exceptionDetails?.text);
  const deadline = Date.now() + 30000;
  const panelContexts = () => worker.evaluate(filter => chrome.runtime.getContexts(filter), {
    contextTypes: ['SIDE_PANEL'], documentUrls: [panelUrl], tabIds: [-1], windowIds: [windowId],
  });
  while (!(await panelContexts()).length) {
    assert.ok(Date.now() < deadline, 'The real side panel did not open.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.equal((await panelContexts()).length, 1, 'Expected one native SIDE_PANEL context in the fixture window.');
  await extensionPage.close();

  const browserCdp = await context.browser().newBrowserCDPSession();
  const pending = new Map();
  let nextMessageId = 1;
  browserCdp.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message);
    const resolve = pending.get(`${event.sessionId}:${message.id}`);
    if (resolve) { pending.delete(`${event.sessionId}:${message.id}`); resolve(message); }
  });
  const attach = async targetId => {
    const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId, flatten: false });
    const target = {
      async send(method, params = {}) {
        const id = nextMessageId++;
        const response = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { pending.delete(`${sessionId}:${id}`); reject(new Error(`Timed out waiting for ${method}.`)); }, 300000);
          pending.set(`${sessionId}:${id}`, value => { clearTimeout(timeout); resolve(value); });
        });
        await browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
        const result = await response;
        if (result.error) throw new Error(result.error.message);
        return result.result;
      },
      async evaluate(expression) {
        const response = await target.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result?.value;
      },
    };
    return target;
  };
  // A normal panel.html tab can be narrow or hidden too. Require a non-tab renderer
  // in the fixture window, backed by the exact native SIDE_PANEL context above.
  let panel;
  const candidates = [];
  for (const info of (await browserCdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page' && target.url === panelUrl)) {
    const candidate = await attach(info.targetId);
    const identity = await candidate.evaluate(`(async () => ({
      tabId: (await chrome.tabs.getCurrent())?.id ?? -1,
      windowId: (await chrome.windows.getCurrent()).id,
      hidden: document.hidden,
      url: location.href,
    }))()`).catch(error => ({ error: error.message }));
    candidates.push({ targetId: info.targetId, ...identity });
    if (identity.tabId === -1 && identity.windowId === windowId && !identity.hidden && identity.url === panelUrl) {
      assert.equal(panel, undefined, 'Multiple visible non-tab panel renderers matched the fixture window.');
      panel = candidate;
    }
  }
  assert.ok(panel, `The real side-panel renderer was not found: ${JSON.stringify(candidates)}`);
  await panel.evaluate(`new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => document.querySelector('#model-label')?.textContent !== 'Connecting your accounts' && !document.querySelector('#control-toggle').disabled ? resolve()
      : Date.now() - started > 45000 ? reject(new Error('Model discovery or page attachment timed out: ' + JSON.stringify({ model: document.querySelector('#model-label').textContent, page: document.querySelector('#context-title').textContent, notice: document.querySelector('#notice-text').textContent }))) : setTimeout(poll, 100);
    poll();
  })`).catch(async error => {
    const tabs = await worker.evaluate(() => chrome.tabs.query({})).catch(e => e.message);
    const hidden = await panel.evaluate('({ hidden: document.hidden, width: innerWidth, url: location.href })').catch(e => e.message);
    throw new Error(`${error.message} ${JSON.stringify({ tabs: Array.isArray(tabs) ? tabs.map(({ id, windowId, active, url }) => ({ id, windowId, active, url })) : tabs, panel: hidden })}`);
  });
  const model = await panel.evaluate(`document.querySelector('#model-label').textContent`);
  assert.ok(model && model !== 'Choose a connected model', 'No connected model appeared in the actual panel.');

  const click = async selector => {
    const box = await panel.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...box });
    await panel.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...box, button: 'left', clickCount: 1 });
    await panel.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...box, button: 'left', clickCount: 1 });
  };
  const submit = async text => {
    await panel.evaluate(`(() => { const prompt = document.querySelector('#prompt'); prompt.value = ${JSON.stringify(text)}; prompt.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await click('#send');
  };
  const waitForReply = index => panel.evaluate(`new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const body = document.querySelectorAll('#messages .message.assistant .message-body')[${index}];
      if (body && !body.querySelector('.thinking') && document.querySelector('#send').dataset.running === 'false') resolve();
      else if (Date.now() - started > 240000) reject(new Error('Response timed out.'));
      else setTimeout(poll, 150);
    };
    poll();
  })`);
  const pageState = () => web.evaluate(() => ({ url: location.href, title: document.title, overlay: Boolean(document.querySelector('[data-breezer-ai="control"]')) }));

  let overlaySeen = false;
  watchOverlay = setInterval(() => { void web.evaluate(() => Boolean(document.querySelector('[data-breezer-ai="control"]'))).then(value => { overlaySeen ||= value; }).catch(() => {}); }, 150);
  const task = `Type "Lisbon" into the Destination field, then click the Save note button. Then scroll down 900 pixels. Then navigate this tab to ${origin}/second. Reply with the text that appeared next to the button after saving.`;
  let replyIndex = 0;
  if (followUp) {
    // Reproduces the common flow: control is enabled for one message, then the user follows up.
    await click('#control-toggle');
    await submit('Take one snapshot of this page and tell me its heading. Do not take any other action.');
    await waitForReply(replyIndex++);
  } else await click('#control-toggle');
  overlaySeen = false;
  const toggleBefore = await panel.evaluate(`document.querySelector('#control-toggle').getAttribute('aria-pressed')`);
  await submit(task);
  await new Promise(resolve => setTimeout(resolve, 2500));
  await web.screenshot({ path: join(evidence, 'installed-control-page.png') });
  await waitForReply(replyIndex);
  clearInterval(watchOverlay);
  const after = await pageState();
  const reply = await panel.evaluate(`document.querySelectorAll('#messages .message.assistant .message-body')[${replyIndex}].textContent`);
  const notice = await panel.evaluate(`document.querySelector('#notice').hidden ? '' : document.querySelector('#notice-text').textContent`);
  const trace = await worker.evaluate(() => globalThis.__breezerTrace);
  const panelShot = await panel.send('Page.captureScreenshot', { format: 'png' });
  await writeFile(join(evidence, 'installed-control-panel.png'), Buffer.from(panelShot.data, 'base64'));
  const report = { app, model, followUp, toggleBefore, reply, notice, page: after, reports, overlaySeen, trace, evidence };
  await writeFile(join(evidence, 'installed-control.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  assert.ok(reports.some(item => item.type === 'click' && item.value === 'Lisbon'), 'The assistant did not type into the field and click Save.');
  assert.ok(reports.some(item => item.type === 'click' && item.trusted === 'true'), 'The click was not a trusted browser input event.');
  assert.ok(reports.some(item => item.type === 'scroll'), 'The assistant did not scroll the page.');
  assert.equal(after.url, `${origin}/second`, 'The assistant did not navigate the tab.');
  assert.ok(overlaySeen, 'The browser control indicator never appeared on the page.');
  assert.equal(after.overlay, false, 'The browser control indicator remained after the reply.');
} finally {
  clearInterval(watchOverlay);
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
