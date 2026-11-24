// node tests/ai/sidebar-address-native.mjs /path/to/Breezer.app-or-chrome.exe
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv.length, 3, 'Pass the packaged Breezer app or executable.');
const target = resolve(process.argv[2]);
const executablePath = target.endsWith('.app') ? join(target, 'Contents/MacOS/Breezer') : target;
const playwright = process.env.BREEZER_PLAYWRIGHT_MODULE;
const { chromium } = await import(playwright ? pathToFileURL(resolve(playwright)) : 'playwright');
const origin = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj';
const profile = await mkdtemp(join(tmpdir(), 'breezer-native-sidebar-address-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: false, viewport: null,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking',
      '--disable-sync', '--use-mock-keychain', '--host-resolver-rules=MAP * ~NOTFOUND', '--window-size=1080,750'],
  });
  const settings = await context.newPage();
  settings.setDefaultTimeout(15000);
  await settings.goto(`${origin}/workspace.html#/settings/experiments`);
  const original = await settings.evaluate(() => chrome.breezerPrivate.setAppearance({
    layout: 'sidebar', frameless: true, alwaysShowSidebar: true,
    alwaysShowTopBar: true, bookmarkBarMode: 'hidden',
  }));
  assert.equal(original.sidebarAddressSearch, false, 'The native experiment starts disabled.');
  const toggle = settings.locator('#experiment-sidebarSearch');
  const awaitNative = value => settings.waitForFunction(async expected => {
    const appearance = await chrome.breezerPrivate.getAppearance();
    return appearance.sidebarAddressSearch === expected && appearance.alwaysShowTopBar;
  }, value);
  const pinned = await settings.evaluate(() => innerHeight);
  await toggle.check();
  await awaitNative(true);
  await settings.waitForFunction(height => innerHeight > height + 15, pinned);
  const idle = await settings.evaluate(() => innerHeight);

  // Creating a real New Tab normally focuses the native omnibox automatically.
  const opened = context.waitForEvent('page');
  await settings.evaluate(() => chrome.tabs.create({ url: 'chrome://newtab/' }));
  const newtab = await opened;
  await newtab.waitForURL(`${origin}/newtab.html`);
  await newtab.waitForFunction(height => innerHeight >= height - 2, idle);
  await newtab.close();
  await settings.bringToFront();

  // Attach to the embedded workspace, with no sidebar document in any tab.
  const browser = await context.browser().newBrowserCDPSession();
  const hostPrefix = `${origin}/workspace.html#/sidebar?w=`;
  const deadline = Date.now() + 15000;
  let host;
  while (!host && Date.now() < deadline) {
    const targets = (await browser.send('Target.getTargets')).targetInfos;
    host = targets.find(target => target.url.startsWith(hostPrefix));
    if (!host) await new Promise(done => setTimeout(done, 100));
  }
  assert.ok(host, 'The browser has an embedded workspace sidebar.');
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId: host.targetId, flatten: false });
  let nextId = 0;
  const send = async (method, params) => {
    const id = ++nextId;
    let receive, timer;
    try {
      const response = new Promise((resolve, reject) => {
        receive = event => {
          if (event.sessionId !== sessionId) return;
          const data = JSON.parse(event.message);
          if (data.id !== id) return;
          if (data.error) reject(new Error(data.error.message));
          else resolve(data.result);
        };
        timer = setTimeout(() => reject(new Error(`Timed out on ${method}`)), 5000);
        browser.on('Target.receivedMessageFromTarget', receive);
      });
      await browser.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
      return await response;
    } finally {
      clearTimeout(timer);
      browser.off('Target.receivedMessageFromTarget', receive);
    }
  };
  const evaluate = async expression => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  const point = await evaluate(`(() => {
    const { x, y, width, height } = document.querySelector('#sidebar-address').getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2, width, height };
  })()`);
  assert.ok(point?.width && point.height, 'The address control is visible in the embedded sidebar.');
  const { x, y } = point;
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  await settings.waitForFunction(height => innerHeight < height - 15 && !document.hasFocus(), idle);
  assert.equal(await evaluate('document.hasFocus()'), false, 'The embedded sidebar transfers focus to native chrome.');
  await settings.locator('body').click({ position: { x: 420, y: 360 } });
  await settings.waitForFunction(height => innerHeight >= height - 2, idle);
  await browser.send('Target.detachFromTarget', { sessionId });

  const appearance = patch => settings.evaluate(patch => chrome.breezerPrivate.setAppearance(patch), patch);
  const pinnedToolbar = () => settings.waitForFunction(height => innerHeight < height - 15, idle);
  await appearance({ frameless: false });
  await pinnedToolbar();
  await appearance({ frameless: true });
  await settings.waitForFunction(height => innerHeight >= height - 2, idle);
  await appearance({ layout: 'top' });
  await pinnedToolbar();
  await appearance({ layout: 'sidebar' });
  await settings.waitForFunction(height => innerHeight >= height - 2, idle);

  await settings.bringToFront();
  await toggle.uncheck();
  await awaitNative(false);
  await settings.waitForFunction(height => innerHeight < height - 15, idle);
  console.log('PASS: sidebar address search hides the idle top bar, reveals it for address entry, and restores the saved pin when disabled.');
} finally {
  try { await context?.close(); } finally { await rm(profile, { recursive: true, force: true }); }
}
