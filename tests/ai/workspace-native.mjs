// Compiled-app integration test for Breezer's native workspace sidebar.
//
//   node tests/ai/workspace-native.mjs /absolute/path/Breezer.app
//
// Launches the real Breezer binary headful with an isolated temporary profile and
// component extensions enabled. It drives the shipped workspace UI hosted in the
// native sidebar view (not a tab), the full-page settings tab, and the bounded
// chrome.breezerPrivate API. No AI requests are made. Evidence is written to
// $BREEZER_AI_EVIDENCE or build/arc-redesign/workspace-native-evidence/<stamp>.
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 the build lacks the
// native workspace (precondition), so nothing about the feature was verified.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from './node_modules/playwright/index.mjs';

const args = process.argv.slice(2);
const app = args.shift();
assert.equal(args.length, 0, 'Pass only the absolute Breezer.app path.');
assert.ok(app?.startsWith('/') && app.endsWith('/Breezer.app'), 'Pass the absolute path of the compiled Breezer.app.');
assert.equal(
  execFileSync('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', `${app}/Contents/Info.plist`], { encoding: 'utf8' }).trim(),
  'io.github.etphli.breezer',
);

const extensionId = 'namgcidocfgliiedlkdafcmifpdfiakj';
const origin = `chrome-extension://${extensionId}`;
const hostPrefix = `${origin}/workspace.html#/sidebar?w=`;
const settingsUrl = `${origin}/workspace.html#/settings`;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = process.env.BREEZER_AI_EVIDENCE
  || join(repo, 'build/arc-redesign/workspace-native-evidence', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'breezer-workspace-native-profile-'));
// Default run checks saved choices from v1. Set BREEZER_TEST_FRESH_PROFILE=1
// to run the same checks against fresh defaults. Neither mode uses a real profile.
const freshProfile = process.env.BREEZER_TEST_FRESH_PROFILE === '1';
const oldPreferences = freshProfile ? {} : {
  breezer: { workspace: { initialized: true } },
  helium: { browser: {
    layout: 2, vertical_right_aligned: false,
    centered_location_bar: false, minimal_location_bar: false,
    show_progress_bar: false, zen_mode: false,
    zen_mode_sidebar_pinned: true, zen_mode_top_chrome_pinned: false,
  } },
  bookmark_bar: { show_on_all_tabs: false },
  vertical_tabs: { uncollapsed_width: 300 },
};
await mkdir(join(profile, 'Default'), { recursive: true });
await writeFile(join(profile, 'Default/Preferences'), JSON.stringify(oldPreferences));

const titles = { alpha: 'Workspace fixture Alpha', beta: 'Workspace fixture Beta', gamma: 'Workspace fixture Gamma' };
const server = createServer((request, response) => {
  const name = request.url.slice(1).split('?')[0];
  response.setHeader('content-type', 'text/html');
  response.end(`<title>${titles[name] || 'Workspace fixture'}</title><main>Isolated Breezer workspace fixture: ${name}</main>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const fixture = name => `http://127.0.0.1:${server.address().port}/${name}`;

const report = { app, profile, evidence, status: 'running', checks: {}, observations: {}, screenshots: [] };
const pass = (name, detail) => { report.checks[name] = { status: 'passed', detail }; console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`); };
const observe = (name, value) => { report.observations[name] = value; };
class Precondition extends Error {}

const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(label, probe, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try {
      last = await probe();
      if (last) return last;
    } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${label}. Last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await sleep(100);
  }
}

// Watchdog: never leave a headful browser behind if something wedges.
const watchdog = setTimeout(() => { console.error('Global deadline (8 min) exceeded.'); process.exitCode = 1; void cleanup().finally(() => process.exit(1)); }, 8 * 60 * 1000);
watchdog.unref();

let context;
let cleaned = false;
async function cleanup() {
  if (cleaned) return;
  cleaned = true;
  await Promise.race([context?.close().catch(() => {}), sleep(15000)]);
  spawnSync('/usr/bin/pkill', ['-f', profile]);
  await new Promise(done => server.close(done));
  await rm(profile, { recursive: true, force: true });
}

// Callback-style private call injected into extension contexts; mirrors workspace.js callBridge.
const privateCall = (name, ...callArgs) => `new Promise((resolve, reject) => {
  const fn = chrome.breezerPrivate?.[${JSON.stringify(name)}];
  if (typeof fn !== 'function') { reject(new Error('chrome.breezerPrivate.${name} is unavailable')); return; }
  fn(...${JSON.stringify(callArgs)}, value => chrome.runtime.lastError ? reject(new Error(chrome.runtime.lastError.message)) : resolve(value));
})`;
const settle = expression => `(${expression}).then(value => ({ ok: true, value }), error => ({ ok: false, error: String(error?.message || error) }))`;

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: `${app}/Contents/MacOS/Breezer`,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check'],
    // No viewport emulation: geometry checks compare real native view sizes.
    viewport: null,
  });

  const worker = context.serviceWorkers().find(item => item.url() === `${origin}/background.js`)
    || await context.waitForEvent('serviceworker', { predicate: item => item.url() === `${origin}/background.js`, timeout: 30000 });
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().name), 'Breezer AI');
  const workerCall = async (name, ...callArgs) => worker.evaluate(settle(privateCall(name, ...callArgs)));

  const browserCdp = await context.browser().newBrowserCDPSession();
  await browserCdp.send('Target.setDiscoverTargets', { discover: true });
  const pending = new Map();
  const sessions = new Map();
  let nextMessageId = 1;
  browserCdp.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message);
    const done = pending.get(`${event.sessionId}:${message.id}`);
    if (!done) return;
    pending.delete(`${event.sessionId}:${message.id}`);
    done(message);
  });
  browserCdp.on('Target.targetDestroyed', ({ targetId }) => sessions.delete(targetId));
  browserCdp.on('Target.detachedFromTarget', ({ targetId }) => targetId && sessions.delete(targetId));

  async function attach(targetId) {
    if (sessions.has(targetId)) return sessions.get(targetId);
    const { sessionId } = await browserCdp.send('Target.attachToTarget', { targetId, flatten: false });
    const session = {
      targetId,
      async send(method, params = {}) {
        const id = nextMessageId++;
        const key = `${sessionId}:${id}`;
        const response = new Promise((done, reject) => {
          const timer = setTimeout(() => { pending.delete(key); reject(new Error(`Timed out waiting for ${method}.`)); }, 15000);
          pending.set(key, value => { clearTimeout(timer); done(value); });
        });
        await browserCdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
        const result = await response;
        if (result.error) throw new Error(result.error.message);
        return result.result;
      },
      async evaluate(expression, { userGesture = false } = {}) {
        const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture });
        if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
        return response.result?.value;
      },
      // Real renderer input: produces trusted events and a transient user activation.
      async click(finder, { button = 'left', hover = false } = {}) {
        const box = await this.evaluate(`(() => {
          const node = ${finder};
          if (!node) return null;
          node.scrollIntoView({ block: 'nearest' });
          const r = node.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
        })()`);
        assert.ok(box && box.width > 0 && box.height > 0, `Element not visible in ${targetId}: ${finder}`);
        await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
        if (hover) return box;
        const buttons = { left: 1, right: 2, middle: 4 }[button];
        await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button, buttons, clickCount: 1 });
        await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button, buttons: 0, clickCount: 1 });
        return box;
      },
      async screenshot(name) {
        const shot = await this.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
        const path = join(evidence, name);
        await writeFile(path, Buffer.from(shot.data, 'base64'));
        report.screenshots.push(path);
        return path;
      },
    };
    sessions.set(targetId, session);
    return session;
  }

  const targets = async () => (await browserCdp.send('Target.getTargets')).targetInfos;
  const hostTargets = async () => (await targets())
    .filter(target => target.url.startsWith(hostPrefix))
    .map(target => ({ ...target, windowId: Number(/[?&]w=(\d+)/.exec(target.url)?.[1]) }));
  const normalWindows = () => worker.evaluate(async () => (await chrome.windows.getAll({ windowTypes: ['normal'] })).map(item => item.id).sort((a, b) => a - b));
  const windowTabs = windowId => worker.evaluate(id => chrome.tabs.query({ windowId: id }), windowId);

  // Exactly one hosted document per normal window, each scoped to its own window ID.
  async function hostsByWindow(label) {
    return waitFor(`one workspace host per window (${label})`, async () => {
      const [hosts, windows] = await Promise.all([hostTargets(), normalWindows()]);
      const ids = hosts.map(host => host.windowId).sort((a, b) => a - b);
      if (JSON.stringify(ids) !== JSON.stringify(windows)) return false;
      return new Map(hosts.map(host => [host.windowId, host]));
    }, 20000);
  }

  const snapshotExpression = `(() => {
    const live = node => !node.classList.contains('leaving');
    const text = node => node.querySelector('.title')?.textContent || '';
    return {
      hash: location.hash,
      sidebarVisible: !document.getElementById('sidebar').hidden,
      today: [...document.querySelectorAll('#today > [data-key^="t:"]')].filter(live).map(node => ({ id: Number(node.dataset.key.slice(2)), title: text(node), active: node.classList.contains('active') })),
      pinned: [...document.querySelectorAll('#pinned [data-kind="entry"]')].filter(live).map(node => ({ key: node.dataset.key, title: text(node), asleep: node.classList.contains('asleep'), active: node.classList.contains('active') })),
      tone: document.documentElement.dataset.tone,
      scheme: document.documentElement.dataset.scheme,
      width: innerWidth,
      height: innerHeight,
    };
  })()`;

  // The sidebar's live rows must be exactly this window's Chromium tabs.
  async function assertScoped(host, windowId, label) {
    let detail;
    await waitFor(`${label}: sidebar rows match window ${windowId} tabs`, async () => {
      const [view, tabs] = await Promise.all([host.evaluate(snapshotExpression), windowTabs(windowId)]);
      const expected = tabs.filter(tab => !tab.pinned).map(tab => tab.id).sort((a, b) => a - b);
      const shown = view.today.map(row => row.id).sort((a, b) => a - b);
      const livePinned = view.pinned.filter(row => !row.asleep).length;
      detail = { windowId, expected, shown, livePinned, chromiumPinned: tabs.filter(tab => tab.pinned).length };
      const activeRow = view.today.find(row => row.active)?.id ?? null;
      const activeTab = tabs.find(tab => tab.active && !tab.pinned)?.id ?? null;
      return JSON.stringify(expected) === JSON.stringify(shown) && livePinned === detail.chromiumPinned && activeRow === activeTab;
    });
    return detail;
  }

  // ---------------------------------------------------------------- precondition
  const surface = await worker.evaluate(() => ({
    breezerPrivate: typeof chrome.breezerPrivate === 'object' && chrome.breezerPrivate
      ? Object.keys(chrome.breezerPrivate).filter(key => typeof chrome.breezerPrivate[key] === 'function').sort()
      : null,
  }));
  observe('privateApiSurface', surface.breezerPrivate);
  if (!surface.breezerPrivate) {
    observe('targetsAtPrecondition', (await targets()).map(({ type, url }) => ({ type, url })));
    throw new Precondition('chrome.breezerPrivate is absent in the Breezer AI service worker; this binary predates the native workspace.');
  }
  assert.deepEqual(surface.breezerPrivate, ['authorizeCurrentPage', 'getAppearance', 'setAppearance', 'setSidebarCollapsed']);
  pass('privateApiSurface', 'exactly the 4 IDL methods are exposed to the component extension');

  const firstHosts = await waitFor('the native workspace host', async () => (await hostTargets()).length > 0 && hostTargets(), 20000)
    .catch(async error => {
      observe('targetsAtPrecondition', (await targets()).map(({ type, url }) => ({ type, url })));
      const layout = await workerCall('getAppearance');
      observe('appearanceAtPrecondition', layout);
      throw new Precondition(`No ${hostPrefix}<id> target appeared (${error.message}).`);
    });
  observe('hostTargetType', firstHosts[0].type);

  // ---------------------------------------------------------------- window A setup
  const [windowA] = await normalWindows();
  await worker.evaluate(id => chrome.windows.update(id, { left: 40, top: 40, width: 1400, height: 900, focused: true }), windowA);
  const [initialTab] = await windowTabs(windowA);
  await worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: initialTab.id, url: fixture('alpha') });
  const alphaA = initialTab.id;
  await waitFor('alpha loaded in window A', async () => (await worker.evaluate(id => chrome.tabs.get(id), alphaA)).title === titles.alpha);
  // Captured before window B opens the same URL.
  const webPage = await waitFor('window A page in Playwright', () => context.pages().find(page => page.url() === fixture('alpha')));

  // ---------------------------------------------------------------- hosting
  let hosts = await hostsByWindow('single window');
  let hostA = await attach(hosts.get(windowA).targetId);
  const hostHash = await hostA.evaluate('location.href');
  assert.equal(hostHash, `${hostPrefix}${windowA}`);
  const allTabs = await worker.evaluate(() => chrome.tabs.query({}));
  assert.ok(!allTabs.some(tab => (tab.url || tab.pendingUrl || '').startsWith(`${origin}/workspace.html#/sidebar`)), 'The sidebar document must not be an ordinary tab.');
  const contexts = await worker.evaluate(() => chrome.runtime.getContexts({}));
  const hostContexts = contexts.filter(item => item.documentUrl?.startsWith(hostPrefix));
  observe('hostRuntimeContexts', hostContexts);
  assert.equal(hostContexts.length, 1, 'Expected one runtime context for the window A host.');
  assert.equal(hostContexts[0].tabId, -1, 'The workspace host must not belong to a tab.');
  if (hostContexts[0].windowId !== -1) assert.equal(hostContexts[0].windowId, windowA);
  pass('nativeHosting', `workspace.html#/sidebar?w=${windowA} runs as a ${firstHosts[0].type} target/${hostContexts[0].contextType} context with tabId -1, not a tab`);
  await assertScoped(hostA, windowA, 'window A initial');
  await hostA.screenshot('host-window-a-initial.png');

  // ---------------------------------------------------------------- second window, same URL
  const windowB = await worker.evaluate(url => chrome.windows.create({ url, left: 520, top: 80, width: 1200, height: 820 }).then(item => item.id), fixture('alpha'));
  hosts = await hostsByWindow('two windows');
  const hostB = await attach(hosts.get(windowB).targetId);
  assert.equal(await hostB.evaluate('location.href'), `${hostPrefix}${windowB}`);
  const [alphaB] = (await windowTabs(windowB)).map(tab => tab.id);
  await waitFor('alpha loaded in window B', async () => (await worker.evaluate(id => chrome.tabs.get(id), alphaB)).title === titles.alpha);
  const scopedA = await assertScoped(hostA, windowA, 'window A with B open');
  const scopedB = await assertScoped(hostB, windowB, 'window B');
  assert.ok(!scopedA.shown.includes(alphaB) && !scopedB.shown.includes(alphaA), 'Same-URL tabs leaked across windows.');
  pass('uniqueHostPerWindow', `windows ${windowA} and ${windowB} each have exactly one host; same URL ${fixture('alpha')} shows only the owning window's tab (${alphaA} vs ${alphaB})`);
  await hostB.screenshot('host-window-b.png');

  // ---------------------------------------------------------------- create / switch / pin / close via shipped UI
  const countB = (await windowTabs(windowB)).length;
  const beforeA = new Set((await windowTabs(windowA)).map(tab => tab.id));
  await hostA.click(`document.getElementById('new-tab')`);
  const betaA = await waitFor('UI-created tab in window A', async () => (await windowTabs(windowA)).find(tab => !beforeA.has(tab.id))?.id);
  assert.equal((await windowTabs(windowB)).length, countB, 'New tab in A changed window B.');
  await worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: betaA, url: fixture('beta') });
  await waitFor('beta loaded', async () => (await worker.evaluate(id => chrome.tabs.get(id), betaA)).title === titles.beta);
  await assertScoped(hostA, windowA, 'after create');
  await assertScoped(hostB, windowB, 'B after A create');
  pass('createTabViaUi', `New tab button in window A's host created tab ${betaA} in window ${windowA} only`);

  await hostA.click(`document.querySelector('#today [data-key="t:${alphaA}"]')`);
  await waitFor('alpha activated via sidebar row', async () => (await worker.evaluate(id => chrome.tabs.get(id), alphaA)).active);
  await assertScoped(hostA, windowA, 'after switch');
  assert.ok((await worker.evaluate(id => chrome.tabs.get(id), alphaB)).active, 'Switching in A changed B.');
  pass('switchTabViaUi', `clicking the row activated tab ${alphaA}; window B's active tab unchanged`);

  await hostA.click(`document.querySelector('#today [data-key="t:${betaA}"]')`, { button: 'right' });
  await waitFor('row context menu', () => hostA.evaluate(`!document.getElementById('menu').hidden`));
  await hostA.click(`[...document.querySelectorAll('#menu [role^="menuitem"]')].find(node => node.textContent.trim() === 'Pin tab')`);
  await waitFor('Chromium pinned state', async () => (await worker.evaluate(id => chrome.tabs.get(id), betaA)).pinned);
  const pinnedView = await waitFor('pinned row in A', async () => {
    const view = await hostA.evaluate(snapshotExpression);
    return view.pinned.some(row => row.title === titles.beta && !row.asleep) && !view.today.some(row => row.id === betaA) && view;
  });
  await assertScoped(hostA, windowA, 'after pin');
  await assertScoped(hostB, windowB, 'B after A pin');
  const pinnedInB = (await hostB.evaluate(snapshotExpression)).pinned.filter(row => row.title === titles.beta);
  assert.ok(pinnedInB.every(row => row.asleep), 'Window B shows A\'s pinned tab as live.');
  observe('pinnedEntryInWindowB', pinnedInB);
  pass('pinTabViaUi', `context menu "Pin tab" pinned Chromium tab ${betaA}; window B ${pinnedInB.length ? 'shows the shared pin asleep' : 'does not show it'}`);
  await hostA.screenshot('host-window-a-pinned.png');
  observe('pinnedRowsA', pinnedView.pinned);

  const beforeGamma = new Set((await windowTabs(windowA)).map(tab => tab.id));
  await hostA.click(`document.getElementById('new-tab')`);
  const gammaA = await waitFor('second UI-created tab', async () => (await windowTabs(windowA)).find(tab => !beforeGamma.has(tab.id))?.id);
  await worker.evaluate(({ id, url }) => chrome.tabs.update(id, { url }), { id: gammaA, url: fixture('gamma') });
  await waitFor('gamma row', async () => (await hostA.evaluate(snapshotExpression)).today.some(row => row.id === gammaA && row.title === titles.gamma));
  await hostA.click(`document.querySelector('#today [data-key="t:${gammaA}"]')`, { hover: true });
  await hostA.click(`document.querySelector('#today [data-key="t:${gammaA}"] .row-action')`);
  await waitFor('gamma closed', async () => !(await windowTabs(windowA)).some(tab => tab.id === gammaA));
  assert.equal((await windowTabs(windowB)).length, countB, 'Closing in A changed window B.');
  await assertScoped(hostA, windowA, 'after close');
  pass('closeTabViaUi', `row close button removed tab ${gammaA}; window B untouched`);

  // ---------------------------------------------------------------- full-page settings tab
  await hostA.click(`document.getElementById('open-settings')`);
  const settingsTab = await waitFor('settings tab', async () => (await windowTabs(windowA)).find(tab => (tab.url || tab.pendingUrl) === settingsUrl));
  assert.ok(settingsTab.id >= 0 && settingsTab.windowId === windowA);
  const settings = await waitFor('settings page in Playwright', () => context.pages().find(page => page.url() === settingsUrl));
  await settings.locator('#theme-swatches [data-value="dusk"]').waitFor();
  await waitFor('settings controls enabled', () => settings.evaluate(() => document.querySelector('#theme-swatches [data-value="dusk"]').getAttribute('aria-disabled') === 'false'));
  assert.equal(await settings.locator('#bridge-note').isHidden(), true, 'Settings reports the native bridge as unavailable.');
  pass('settingsTab', `Settings opened as ordinary tab ${settingsTab.id} in window ${windowA}`);

  const settingsCall = (name, ...callArgs) => settings.evaluate(settle(privateCall(name, ...callArgs)));
  const appearance = async () => { const result = await settingsCall('getAppearance'); assert.ok(result.ok, result.error); return result.value; };
  const initialAppearance = await appearance();
  observe('initialAppearance', initialAppearance);
  assert.deepEqual(Object.keys(initialAppearance).sort(), ['alwaysShowSidebar', 'alwaysShowTopBar', 'centeredAddressBar', 'colorMode', 'frameless', 'layout', 'minimalUrl', 'showBookmarks', 'showLoadProgress', 'sidebarFontSize', 'sidebarMode', 'sidebarWidth', 'theme']);
  assert.equal(initialAppearance.layout, 'sidebar');
  assert.equal(initialAppearance.showBookmarks, freshProfile);
  assert.equal(initialAppearance.sidebarWidth, freshProfile ? 240 : 300);
  assert.equal(initialAppearance.sidebarFontSize, 15);
  for (const field of ['centeredAddressBar', 'minimalUrl', 'showLoadProgress', 'frameless', 'alwaysShowTopBar']) {
    assert.equal(initialAppearance[field], freshProfile, `${field} must respect the profile's saved choice`);
  }
  assert.equal(initialAppearance.alwaysShowSidebar, !freshProfile);
  observe('seededOldPreferences', oldPreferences);
  pass('profileDefaults', freshProfile ? 'fresh profile received requested appearance defaults' : 'v2 migration preserved explicit v1 choices');
  await settings.screenshot({ path: join(evidence, 'workspace-settings.png'), fullPage: true });
  report.screenshots.push(join(evidence, 'workspace-settings.png'));

  // Bounded: unknown keys and values are rejected by native code.
  const rejections = {
    unknownKey: await settingsCall('setAppearance', { homepage: 'https://example.com' }),
    badTheme: await settingsCall('setAppearance', { theme: 'neon' }),
    badLayout: await settingsCall('setAppearance', { layout: 'floating' }),
    empty: await settingsCall('setAppearance', {}),
    smallFont: await settingsCall('setAppearance', { theme: 'rose', sidebarFontSize: 11 }),
    largeFont: await settingsCall('setAppearance', { theme: 'rose', sidebarFontSize: 21 }),
    fractionalFont: await settingsCall('setAppearance', { theme: 'rose', sidebarFontSize: 15.5 }),
    stringFont: await settingsCall('setAppearance', { theme: 'rose', sidebarFontSize: '15' }),
    invalidFrameless: await settingsCall('setAppearance', { sidebarFontSize: 18, frameless: 1 }),
  };
  observe('boundedRejections', rejections);
  for (const [name, result] of Object.entries(rejections)) assert.equal(result.ok, false, `setAppearance accepted ${name}`);
  assert.deepEqual(await appearance(), initialAppearance, 'Rejected patches changed appearance.');
  assert.equal(await webPage.evaluate(() => typeof globalThis.chrome?.breezerPrivate), 'undefined', 'Web pages must not see breezerPrivate.');
  pass('boundedApi', 'unknown keys, bad enum values and empty patches rejected without side effects; API absent from web pages');

  async function choose(selector, field, value) {
    await settings.locator(selector).click();
    await waitFor(`${field}=${value} via native getAppearance`, async () => (await appearance())[field] === value);
    await waitFor(`${selector} reflects ${value}`, () => settings.evaluate(sel => document.querySelector(sel).getAttribute('aria-checked') === 'true', selector));
  }
  for (const theme of ['dusk', 'pollen']) {
    await choose(`#theme-swatches [data-value="${theme}"]`, 'theme', theme);
    for (const [host, label] of [[hostA, 'A'], [hostB, 'B']]) await waitFor(`host ${label} tone ${theme}`, async () => (await host.evaluate(snapshotExpression)).tone === theme);
  }
  pass('themeRoundTrip', 'swatch clicks round-trip through native getAppearance and reach both hosted sidebars');
  for (const mode of ['dark', 'light']) {
    await choose(`.segmented[data-field="colorMode"] [data-value="${mode}"]`, 'colorMode', mode);
    for (const [host, label] of [[hostA, 'A'], [hostB, 'B']]) await waitFor(`host ${label} scheme ${mode}`, async () => (await host.evaluate(snapshotExpression)).scheme === mode);
    if (mode === 'dark') await hostA.screenshot('host-window-a-dark.png');
  }
  observe('hostPrefersDarkAfterLight', await hostA.evaluate(`matchMedia('(prefers-color-scheme: dark)').matches`));
  await choose(`.segmented[data-field="colorMode"] [data-value="system"]`, 'colorMode', 'system');
  pass('colorModeRoundTrip', 'dark, light and system round-trip through native ThemeService and both hosted sidebars');

  for (const value of [12, 20, 15]) {
    await settings.locator('#sidebar-font-size').fill(String(value));
    await waitFor(`sidebarFontSize=${value}`, async () => (await appearance()).sidebarFontSize === value);
  }
  pass('sidebarFontSize', '12, 20 and 15 px round-trip through the native appearance API');

  // Bookmark bar: cross-check the native pref through chrome://settings.
  const prefsPage = await context.newPage();
  await prefsPage.goto('chrome://settings/appearance');
  const bookmarkPref = () => prefsPage.evaluate(() => new Promise(done => chrome.settingsPrivate.getPref('bookmark_bar.show_on_all_tabs', pref => done(pref.value))));
  const startBookmarks = (await appearance()).showBookmarks;
  assert.equal(await bookmarkPref(), startBookmarks);
  await settings.bringToFront();
  await settings.locator('#show-bookmarks').click();
  await waitFor('bookmark toggle via native API', async () => (await appearance()).showBookmarks === !startBookmarks);
  await waitFor('bookmark pref in chrome://settings', async () => (await bookmarkPref()) === !startBookmarks);
  await settings.locator('#show-bookmarks').click();
  await waitFor('bookmark pref restored', async () => (await bookmarkPref()) === startBookmarks && (await appearance()).showBookmarks === startBookmarks);
  await prefsPage.close();
  pass('bookmarkPref', `switch toggled bookmark_bar.show_on_all_tabs ${startBookmarks}→${!startBookmarks}→${startBookmarks}, confirmed by chrome.settingsPrivate`);

  // Sidebar width: the hosted view should resize by the same delta.
  const widthBefore = (await hostA.evaluate(snapshotExpression)).width;
  const targetWidth = initialAppearance.sidebarWidth >= 320 ? 260 : 320;
  await settings.locator('#sidebar-width').fill(String(targetWidth));
  await waitFor('sidebarWidth via native API', async () => (await appearance()).sidebarWidth === targetWidth);
  const widthAfter = await waitFor('host A resized', async () => {
    const width = (await hostA.evaluate(snapshotExpression)).width;
    return Math.abs((width - widthBefore) - (targetWidth - initialAppearance.sidebarWidth)) <= 4 && width;
  });
  observe('sidebarWidth', { pref: [initialAppearance.sidebarWidth, targetWidth], hostInnerWidth: [widthBefore, widthAfter] });
  pass('sidebarWidth', `pref ${initialAppearance.sidebarWidth}→${targetWidth} px resized the hosted document ${widthBefore}→${widthAfter} px`);

  // ---------------------------------------------------------------- authorization
  const canScript = tabId => worker.evaluate(id => chrome.scripting.executeScript({ target: { tabId: id }, func: () => document.title })
    .then(([result]) => ({ ok: true, title: result?.result }), error => ({ ok: false, error: error.message })), tabId);
  await hostA.click(`document.querySelector('#today [data-key="t:${alphaA}"]')`);
  await waitFor('alpha active for authorization', async () => (await worker.evaluate(id => chrome.tabs.get(id), alphaA)).active);
  assert.equal((await canScript(alphaA)).ok, false, 'Baseline: extension already had access to window A page.');
  assert.equal((await canScript(alphaB)).ok, false, 'Baseline: extension already had access to window B page.');

  // Real clicks leave a ~5 s transient activation in host A; let it expire so a
  // rejection proves the gesture check rather than timing luck. Host B and the
  // worker have never received input.
  await sleep(6000);
  const scripted = {
    serviceWorker: await workerCall('authorizeCurrentPage'),
    hostAWithoutGesture: await hostA.evaluate(settle(privateCall('authorizeCurrentPage'))),
    hostBWithoutGesture: await hostB.evaluate(settle(privateCall('authorizeCurrentPage'))),
  };
  observe('authorizeWithoutGesture', scripted);
  for (const [caller, result] of Object.entries(scripted)) {
    assert.equal(result.ok, false, `${caller} granted page access without a user gesture.`);
    assert.match(result.error, /user gesture/i);
  }
  assert.equal((await canScript(alphaA)).ok, false, 'A rejected call still granted access.');
  assert.equal((await canScript(alphaB)).ok, false, 'A rejected call still granted access in B.');

  // Even a gesture in the workspace cannot grant page access. That operation
  // belongs to the assistant document, rather than every extension page.
  const grantB = await hostB.evaluate(settle(privateCall('authorizeCurrentPage')), { userGesture: true });
  assert.equal(grantB.ok, false);
  assert.equal((await canScript(alphaB)).ok, false);
  assert.equal((await canScript(alphaA)).ok, false, 'Window B grant leaked to window A.');
  pass('authorizationGesture', 'worker and workspace cannot grant access; a gesture in the workspace is also rejected');

  // ---------------------------------------------------------------- AI side panel geometry
  const openPanel = await hostA.evaluate(`chrome.sidePanel.open({ windowId: ${windowA} }).then(() => 'opened')`, { userGesture: true });
  assert.equal(openPanel, 'opened');
  const panelInfo = await waitFor('AI side panel target', async () => (await targets()).find(target => target.url === `${origin}/panel.html`));
  const panel = await attach(panelInfo.targetId);
  await waitFor('panel rendered', () => panel.evaluate(`Boolean(document.querySelector('#model-label'))`));
  const grantA = await panel.evaluate(settle(privateCall('authorizeCurrentPage')), { userGesture: true });
  assert.deepEqual(grantA, { ok: true, value: true });
  assert.equal((await canScript(alphaB)).ok, false, 'The AI panel in A granted access to B.');
  await waitFor('window A page scriptable', async () => (await canScript(alphaA)).ok);
  pass('authorizationFromPanel', 'gesture grant from the real side panel scopes activeTab to window A\'s active page');

  await webPage.bringToFront();
  await sleep(500);
  const geometry = {
    window: await worker.evaluate(id => chrome.windows.get(id).then(({ left, top, width, height, state }) => ({ left, top, width, height, state })), windowA),
    panel: await panel.evaluate('({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio })'),
    page: await webPage.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    host: await hostA.evaluate('({ width: innerWidth, height: innerHeight })'),
  };
  observe('panelGeometry', geometry);
  assert.ok(geometry.panel.height <= geometry.window.height, 'Panel taller than its window.');
  assert.ok(geometry.panel.height - geometry.page.height >= 30, `Panel (${geometry.panel.height}px) is not taller than the page viewport (${geometry.page.height}px); it does not extend above the content area.`);
  pass('panelFullHeight', `panel viewport ${geometry.panel.height}px vs page viewport ${geometry.page.height}px vs window ${geometry.window.height}px: the panel extends ${geometry.panel.height - geometry.page.height}px above the web content top. This proves extent, not that the native header pixels are absent`);
  await panel.screenshot('ai-panel.png');

  // Optional window-region capture; only real if Screen Recording is granted to this terminal.
  const regionPath = join(evidence, 'window-a-region.png');
  const { left, top, width, height } = geometry.window;
  const capture = spawnSync('/usr/sbin/screencapture', ['-x', `-R${left},${top},${width},${height}`, regionPath], { encoding: 'utf8' });
  observe('windowRegionCapture', capture.status === 0
    ? { path: regionPath, note: 'Region capture of window A. Not asserted: without Screen Recording permission macOS returns only the desktop. Review manually for the hidden AI header.' }
    : { unsupported: true, status: capture.status, stderr: capture.stderr.trim() });
  if (capture.status === 0) report.screenshots.push(regionPath);

  // ---------------------------------------------------------------- layout switch round trip
  const sidebarPageWidth = geometry.page.width;
  await settings.bringToFront();
  await choose(`.segmented[data-field="layout"] [data-value="top"]`, 'layout', 'top');
  await sleep(1000);
  const topHosts = await hostTargets();
  const perWindowTop = Object.fromEntries((await normalWindows()).map(id => [id, topHosts.filter(host => host.windowId === id).length]));
  observe('hostsInTopLayout', perWindowTop);
  assert.ok(Object.values(perWindowTop).every(count => count <= 1), 'Duplicate workspace hosts in top layout.');
  assert.deepEqual(await normalWindows(), [windowA, windowB].sort((a, b) => a - b), 'A window disappeared after switching to top.');
  await webPage.bringToFront();
  const topPageWidth = await waitFor('content widens in top layout', async () => {
    const value = await webPage.evaluate(() => innerWidth);
    return value > sidebarPageWidth + 100 && value;
  });
  await webPage.screenshot({ path: join(evidence, 'page-top-layout.png') });
  report.screenshots.push(join(evidence, 'page-top-layout.png'));
  pass('layoutTop', `top layout kept both windows, ≤1 host per window ${JSON.stringify(perWindowTop)}, page width ${sidebarPageWidth}→${topPageWidth}px`);

  await settings.bringToFront();
  await choose(`.segmented[data-field="layout"] [data-value="sidebar"]`, 'layout', 'sidebar');
  hosts = await hostsByWindow('back to sidebar');
  hostA = await attach(hosts.get(windowA).targetId);
  const hostB2 = await attach(hosts.get(windowB).targetId);
  await waitFor('host A sidebar visible', async () => (await hostA.evaluate(snapshotExpression)).sidebarVisible);
  await assertScoped(hostA, windowA, 'after sidebar return');
  await assertScoped(hostB2, windowB, 'B after sidebar return');
  await webPage.bringToFront();
  await waitFor('content narrows again', async () => (await webPage.evaluate(() => innerWidth)) < topPageWidth - 100);
  await hostA.screenshot('host-window-a-after-layout-roundtrip.png');
  pass('layoutReturn', 'returning to sidebar restored exactly one correctly scoped host per window');

  // Compact and auto-hide are separate native choices, with different geometry.
  await settings.bringToFront();
  await choose('.segmented[data-field="sidebarMode"] [data-value="compact"]', 'sidebarMode', 'compact');
  const compactWidth = await waitFor('compact icon rail width', async () => {
    const width = await hostA.evaluate('innerWidth');
    return width >= 30 && width <= 60 && width;
  });
  await choose('.segmented[data-field="sidebarMode"] [data-value="autoHide"]', 'sidebarMode', 'autoHide');
  const hiddenWidth = await waitFor('auto-hide edge width', async () => {
    const width = await hostA.evaluate('innerWidth');
    return width > 0 && width <= 10 && width;
  });
  await choose('.segmented[data-field="sidebarMode"] [data-value="expanded"]', 'sidebarMode', 'expanded');
  await waitFor('expanded width restored', async () => (await hostA.evaluate('innerWidth')) >= 200);
  pass('sidebarBehaviorSettings', `compact rail ${compactWidth}px, auto-hide edge ${hiddenWidth}px, expanded restored; pointer-driven native reveal is a separate check`);

  // ---------------------------------------------------------------- window close releases its host
  await worker.evaluate(id => chrome.windows.remove(id), windowB);
  await waitFor('window B host released', async () => !(await hostTargets()).some(host => host.windowId === windowB));
  await hostsByWindow('after closing B');
  pass('hostLifetime', `closing window ${windowB} destroyed its host; window ${windowA} keeps one`);

  report.status = 'passed';
} catch (error) {
  report.status = error instanceof Precondition ? 'blocked-precondition' : 'failed';
  report.error = error.stack || String(error);
  process.exitCode = error instanceof Precondition ? 2 : 1;
  console.error(error instanceof Precondition
    ? `BLOCKED (nothing about the native workspace was verified): ${error.message}`
    : `FAILED: ${error.stack || error}`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
  report.profileRemoved = true;
  await writeFile(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`status: ${report.status}\nevidence: ${evidence}`);
}
