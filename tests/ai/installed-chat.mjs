import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from './node_modules/playwright/index.mjs';

const args = process.argv.slice(2);
const mode = args[0] === '--expect-page-denied' ? args.shift() : '--run-live';
const app = args.shift();
assert.equal(args.length, 0, 'Pass only the Breezer.app path after the optional baseline flag.');
assert.ok(app?.endsWith('/Breezer.app'), 'Pass the installed Breezer.app path.');
assert.equal(
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${app}/Contents/Info.plist`], { encoding: 'utf8' }).trim(),
  'io.github.etphli.breezer',
);

const extensionId = 'namgcidocfgliiedlkdafcmifpdfiakj';
const profile = await mkdtemp(join(tmpdir(), 'breezer-installed-chat-profile-'));
const evidence = await mkdtemp(join(tmpdir(), 'breezer-installed-chat-evidence-'));
const fixtureTitle = 'Breezer synthetic page title';
const server = createServer((_request, response) => response.end(`<title>${fixtureTitle}</title><main>Isolated Breezer integration fixture.</main>`));
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: `${app}/Contents/MacOS/Breezer`,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check'],
    viewport: { width: 1280, height: 850 },
  });

  const web = context.pages()[0] || await context.newPage();
  await web.goto(`http://127.0.0.1:${server.address().port}`);
  assert.equal(await web.title(), fixtureTitle);

  const worker = context.serviceWorkers().find(item => item.url() === `chrome-extension://${extensionId}/background.js`)
    || await context.waitForEvent('serviceworker', { predicate: item => item.url() === `chrome-extension://${extensionId}/background.js`, timeout: 30000 });
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name), 'Breezer AI');

  // Open the real side panel from an extension document. A CDP key dispatch does not
  // create the browser's extension-command gesture, so this uses Runtime.evaluate's
  // userGesture flag on the actual extension page.
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/panel.html`);
  await extensionPage.waitForSelector('#model-label');
  const extensionPageCdp = await context.newCDPSession(extensionPage);
  const openResult = await extensionPageCdp.send('Runtime.evaluate', {
    expression: '(async () => chrome.sidePanel.open({ windowId: (await chrome.windows.getCurrent()).id }))()',
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  assert.equal(openResult.exceptionDetails, undefined, openResult.exceptionDetails?.text);
  const panelOpenDeadline = Date.now() + 30000;
  while (!(await worker.evaluate(async () => (await chrome.runtime.getContexts({ contextTypes: ['SIDE_PANEL'] })).length > 0))) {
    assert.ok(Date.now() < panelOpenDeadline, 'The real side panel did not open.');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  await web.bringToFront();

  const browserCdp = await context.browser().newBrowserCDPSession();
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });
  const pending = new Map();
  let nextMessageId = 1;
  browserCdp.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message);
    const resolve = pending.get(`${event.sessionId}:${message.id}`);
    if (!resolve) return;
    pending.delete(`${event.sessionId}:${message.id}`);
    resolve(message);
  });

  async function attach(targetId) {
    const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId, flatten: false });
    return {
      async send(method, params = {}) {
        const id = nextMessageId++;
        const key = `${sessionId}:${id}`;
        const response = new Promise((resolve, reject) => {
          const timeout = setTimeout(() => {
            pending.delete(key);
            reject(new Error(`Timed out waiting for ${method}.`));
          }, 15000);
          pending.set(key, value => { clearTimeout(timeout); resolve(value); });
        });
        await browserCdp.send('Target.sendMessageToTarget', {
          sessionId,
          message: JSON.stringify({ id, method, params }),
        });
        const result = await response;
        if (result.error) throw new Error(result.error.message);
        return result.result;
      },
      async evaluate(expression) {
        const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result?.value;
      },
    };
  }

  const targetInfos = (await browserCdp.send('Target.getTargets')).targetInfos;
  const extensionTargets = targetInfos.filter(target => target.type === 'page' && target.url === `chrome-extension://${extensionId}/panel.html`);
  let panelTarget;
  for (const target of extensionTargets) {
    const candidate = await attach(target.targetId);
    const dimensions = await candidate.evaluate('({ width: innerWidth, height: innerHeight })');
    if (dimensions.width < 500) { panelTarget = candidate; break; }
  }
  assert.ok(panelTarget, 'The real side-panel renderer was not found.');

  const pageInfo = await panelTarget.evaluate(`(async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return { url: tab?.url, title: tab?.title, windowId: tab?.windowId };
  })()`);
  assert.equal(pageInfo.title, fixtureTitle);

  await panelTarget.evaluate(`new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      if (document.querySelector('#model-label')?.textContent !== 'Connecting your accounts') resolve();
      else if (Date.now() - started > 60000) reject(new Error('Model discovery timed out.'));
      else setTimeout(poll, 100);
    };
    poll();
  })`);
  const model = await panelTarget.evaluate(`({
    label: document.querySelector('#model-label').textContent,
    contextEnabled: !document.querySelector('#context-toggle').disabled,
    control: document.querySelector('#control-toggle').getAttribute('aria-pressed'),
  })`);
  assert.ok(model.label && model.label !== 'Choose a connected model', 'No connected model appeared in the actual panel.');
  assert.equal(model.contextEnabled, true, 'The synthetic HTTP page was not attached to the panel.');
  assert.equal(model.control, 'false', 'Browser control must remain off for this test.');

  // Inspect the real discovered menu, then restore the default before inference.
  await panelTarget.evaluate(`document.querySelector('#model-button').click()`);
  const modelMenu = await panelTarget.evaluate(`Array.from(document.querySelectorAll('.provider-group'), group => ({
    provider: group.querySelector('.provider-heading span')?.textContent,
    models: Array.from(group.querySelectorAll('.model-option'), button => button.querySelector('span')?.textContent),
  }))`);
  const codexMenu = modelMenu.find(group => group.provider === 'Codex');
  assert.ok(codexMenu?.models.some(label => /6\.1.*terra/i.test(label)), 'GPT-6.1 Terra is missing from the actual discovered model menu.');
  assert.ok(codexMenu.models.every(label => !/gpt[- ]?(?:5|6\.0)(?:[ .-]|$)/i.test(label)), 'An older GPT generation remains in the actual model menu.');
  await panelTarget.evaluate(`document.querySelector('#model-button').click()`);
  const preferences = await panelTarget.evaluate(`(async () => {
    const reasoning = document.querySelector('#reasoning-select');
    const previous = reasoning.value;
    const value = Array.from(reasoning.options).find(option => option.value && option.value !== previous)?.value;
    if (value) {
      reasoning.value = value;
      reasoning.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    const stored = await chrome.storage.local.get('breezerModelPreferences');
    reasoning.value = previous;
    reasoning.dispatchEvent(new Event('change', { bubbles: true }));
    return { tested: value || null, stored: stored.breezerModelPreferences || {}, speedVisible: !document.querySelector('#speed-setting').hidden };
  })()`);
  if (preferences.tested) assert.ok(Object.values(preferences.stored).some(item => item.reasoning === preferences.tested), 'Reasoning selection was not persisted.');
  assert.equal(preferences.speedVisible, true, 'The default Codex model must show its speed selector.');

  // The page-aware send exercises the real background port and BrowserTools.snapshot.
  // Its actual click also carries the transient user gesture needed by Breezer's
  // private activeTab-grant API.
  const initialContextState = await panelTarget.evaluate(`document.querySelector('#context-toggle').getAttribute('aria-pressed')`);
  if (initialContextState !== 'true') await panelTarget.evaluate(`document.querySelector('#context-toggle').click()`);

  async function submitPrompt(text) {
    await panelTarget.evaluate(`(() => {
      const prompt = document.querySelector('#prompt');
      prompt.value = ${JSON.stringify(text)};
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    const button = await panelTarget.evaluate(`(() => {
      const element = document.querySelector('#send');
      const bounds = element.getBoundingClientRect();
      return { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2, disabled: element.disabled };
    })()`);
    assert.equal(button.disabled, false, 'The actual panel send button is disabled.');
    await panelTarget.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: button.x, y: button.y });
    await panelTarget.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: button.x, y: button.y, button: 'left', clickCount: 1 });
    await panelTarget.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: button.x, y: button.y, button: 'left', clickCount: 1 });
  }

  async function waitForAssistant(index) {
    await panelTarget.evaluate(`new Promise((resolve, reject) => {
      const started = Date.now();
      const poll = () => {
        const body = document.querySelectorAll('#messages .message.assistant .message-body')[${index}];
        if (body && !body.querySelector('.thinking')) resolve();
        else if (Date.now() - started > 90000) reject(new Error('Response timed out.'));
        else setTimeout(poll, 100);
      };
      poll();
    })`);
  }

  await submitPrompt('Reply with the page title.');
  await waitForAssistant(0);
  const pageAware = await panelTarget.evaluate(`({
    bubble: document.querySelector('#messages .message.assistant .message-body')?.textContent || '',
    notice: document.querySelector('#notice-text')?.textContent || '',
    activity: document.querySelector('#activity-label')?.textContent || '',
  })`);
  const screenshot = await panelTarget.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  const screenshotPath = join(evidence, 'installed-side-panel.png');
  await writeFile(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  if (mode === '--run-live') {
    assert.ok(pageAware.bubble.includes(fixtureTitle), `Expected the assistant to use the page snapshot; received: ${pageAware.bubble}`);
    assert.equal(pageAware.notice, '', `Unexpected panel notice: ${pageAware.notice}`);
  } else {
    assert.ok(pageAware.bubble.includes('Could not finish this response'), `Expected the installed app's page-aware error; received: ${pageAware.bubble}`);
    assert.ok(pageAware.notice.includes('Open Breezer AI with Cmd+K'), `Expected the activeTab permission diagnostic; received: ${pageAware.notice}`);
  }

  let controlSnapshot = null;
  if (mode === '--run-live') {
    await panelTarget.evaluate(`document.querySelector('#control-toggle').click()`);
    assert.equal(await panelTarget.evaluate(`document.querySelector('#control-toggle').getAttribute('aria-pressed')`), 'true');
    await submitPrompt('Call browser_snapshot exactly once. Do not click, type, scroll, navigate, or take any other browser action. Reply with the exact page title from the snapshot.');
    await waitForAssistant(1);
    controlSnapshot = await panelTarget.evaluate(`document.querySelectorAll('#messages .message.assistant .message-body')[1].textContent`);
    assert.ok(controlSnapshot.includes(fixtureTitle), `Expected the control snapshot to return the page title; received: ${controlSnapshot}`);
  }
  const assistantMessages = await panelTarget.evaluate(`Array.from(document.querySelectorAll('#messages .message.assistant .message-body'), item => item.textContent)`);
  const report = {
    mode,
    app,
    page: pageInfo,
    model: model.label,
    modelMenu,
    preferences,
    control: model.control,
    pageAware,
    controlSnapshot,
    assistantMessages,
    screenshotPath,
  };
  await writeFile(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  assert.ok(assistantMessages.length >= 1);
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
