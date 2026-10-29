// Compiled-app integration test for favourite-tab Peek.
//
//   node tests/ai/peek-native.mjs /absolute/path/Breezer.app
//
// Launches the real Breezer binary headful with an isolated temporary profile,
// makes a favourite through the native sidebar, and clicks links inside pages
// with trusted renderer input (CDP Input.*). No real profile, no AI requests.
// Evidence is written to $BREEZER_AI_EVIDENCE or
// build/arc-redesign/peek-native-evidence/<stamp>.
//
// Verified here: which links open a peek, that the favourite tab stays on its
// page, that the peek is a real page target outside the tab strip, and that
// Escape, window.close() and switching tabs destroy it. Not reachable from
// renderer input: the native Expand and close buttons and backdrop clicks.
// Those need physical pointer input and are reported as unverified.
//
// Exit codes: 0 all checks passed, 1 a check failed, 2 the build lacks Peek.
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

const origin = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj';
const hostPrefix = `${origin}/workspace.html#/sidebar?w=`;
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const evidence = process.env.BREEZER_AI_EVIDENCE
  || join(repo, 'build/arc-redesign/peek-native-evidence', new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'breezer-peek-native-profile-'));
await mkdir(join(profile, 'Default'), { recursive: true });
// Keep the sidebar visible so its document can be driven.
await writeFile(join(profile, 'Default/Preferences'), JSON.stringify({ helium: { browser: { zen_mode_sidebar_pinned: true } } }));

// 127.0.0.1 and localhost are different sites, so one server serves both sides.
const server = createServer((request, response) => {
  const path = request.url.split('?')[0];
  const port = server.address().port;
  response.setHeader('content-type', 'text/html');
  if (path === '/home') {
    response.end(`<title>Peek favourite home</title><style>a{display:block;margin:24px;font:20px sans-serif}</style>
      <input id="draft" placeholder="draft">
      <a id="blank" href="/target?via=blank" target="_blank">Same-site link in a new tab</a>
      <a id="open" href="#" onclick="window.open('/target?via=open'); return false">window.open()</a>
      <a id="cross" href="http://localhost:${port}/target?via=cross">Cross-site link</a>
      <a id="same" href="/second">Same-site link</a>`);
    return;
  }
  const title = path === '/target' ? 'Peek target' : path === '/second' ? 'Peek second page' : 'Peek fixture';
  response.end(`<title>${title}</title><main>${title} ${request.url}</main>`);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const home = `http://127.0.0.1:${server.address().port}/home`;

const report = { app, profile, evidence, status: 'running', checks: {}, unverified: [], screenshots: [] };
const pass = (name, detail) => { report.checks[name] = { status: 'passed', detail }; console.log(`ok   ${name}${detail ? ` — ${detail}` : ''}`); };
class Precondition extends Error {}
const sleep = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(label, probe, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  for (;;) {
    try { last = await probe(); if (last) return last; } catch (error) { last = error; }
    if (Date.now() > deadline) throw new Error(`Timed out after ${timeout} ms waiting for ${label}. Last: ${last instanceof Error ? last.message : JSON.stringify(last)}`);
    await sleep(100);
  }
}
// Waits `ms` and asserts `probe` never became true (for "nothing happened" checks).
async function stays(label, probe, ms = 1500) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    assert.ok(!(await probe()), label);
    await sleep(100);
  }
}

const watchdog = setTimeout(() => { console.error('Global deadline (6 min) exceeded.'); process.exitCode = 1; void cleanup().finally(() => process.exit(1)); }, 6 * 60 * 1000);
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

try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: `${app}/Contents/MacOS/Breezer`,
    headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check'],
    viewport: null,
  });
  const worker = context.serviceWorkers().find(item => item.url() === `${origin}/background.js`)
    || await context.waitForEvent('serviceworker', { predicate: item => item.url() === `${origin}/background.js`, timeout: 30000 });
  const surface = await worker.evaluate(() => Object.keys(chrome.breezerPrivate || {}).sort());
  if (!surface.includes('setPeekSources')) throw new Precondition(`chrome.breezerPrivate.setPeekSources is missing (surface: ${surface.join(', ')})`);

  // Flat CDP sessions on any target, including WebContents that are not tabs.
  const cdp = await context.browser().newBrowserCDPSession();
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  const pending = new Map();
  let nextId = 1;
  cdp.on('Target.receivedMessageFromTarget', event => {
    const message = JSON.parse(event.message);
    const done = pending.get(`${event.sessionId}:${message.id}`);
    if (done) { pending.delete(`${event.sessionId}:${message.id}`); done(message); }
  });
  async function attach(targetId) {
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: false });
    const send = async (method, params = {}) => {
      const id = nextId++;
      const response = new Promise((done, reject) => {
        const timer = setTimeout(() => { pending.delete(`${sessionId}:${id}`); reject(new Error(`Timed out waiting for ${method}.`)); }, 15000);
        pending.set(`${sessionId}:${id}`, value => { clearTimeout(timer); done(value); });
      });
      await cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) });
      const result = await response;
      if (result.error) throw new Error(result.error.message);
      return result.result;
    };
    const evaluate = async expression => (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result?.value;
    return {
      send, evaluate,
      // Trusted renderer click: real input events with user activation.
      async click(selector, modifiers = 0) {
        const box = await waitFor(`click target ${selector}`, () => evaluate(`(() => {
          const r = document.querySelector(${JSON.stringify(selector)})?.getBoundingClientRect();
          return r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()`));
        const base = { x: box.x, y: box.y, button: 'left', clickCount: 1, modifiers };
        await send('Input.dispatchMouseEvent', { ...base, type: 'mouseMoved', button: 'none' });
        await send('Input.dispatchMouseEvent', { ...base, type: 'mousePressed', buttons: 1 });
        await send('Input.dispatchMouseEvent', { ...base, type: 'mouseReleased', buttons: 0 });
      },
      async key(key, code, windowsVirtualKeyCode) {
        await send('Input.dispatchKeyEvent', { type: 'rawKeyDown', key, code, windowsVirtualKeyCode });
        await send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode });
      },
    };
  }
  const targets = async () => (await cdp.send('Target.getTargets')).targetInfos.filter(target => target.type === 'page');
  const [{ id: windowId }] = await worker.evaluate(() => chrome.windows.getAll({ windowTypes: ['normal'] }));
  const tabs = () => worker.evaluate(id => chrome.tabs.query({ windowId: id }), windowId);
  const tabUrls = async () => (await tabs()).map(tab => tab.url || tab.pendingUrl);
  // A peek is a page target whose URL matches and which is not any tab.
  const peekTarget = async pattern => {
    const urls = new Set(await tabUrls());
    return (await targets()).find(target => pattern.test(target.url) && !urls.has(target.url)) || null;
  };

  // ------------------------------------------------------------ make a favourite through the sidebar
  const hostInfo = await waitFor('sidebar host', async () => (await targets()).find(target => target.url.startsWith(hostPrefix)));
  const host = await attach(hostInfo.targetId);
  await worker.evaluate(async url => {
    const { 'workspace.v1': store } = await chrome.storage.local.get('workspace.v1');
    const next = store || { version: 1, rev: 0, spaces: [{ id: 'space-default', name: 'Personal', tone: 'mint', pinned: [] }], favorites: [], prefs: {} };
    next.favorites = [{ kind: 'entry', id: 'v-peek', url, title: 'Peek home (saved)' }];
    next.rev = (next.rev || 0) + 1;
    await chrome.storage.local.set({ 'workspace.v1': next });
  }, home);
  await host.click('#favorites .tile');
  const favourite = await waitFor('favourite tab opened', async () => (await tabs()).find(tab => (tab.url || tab.pendingUrl) === home && tab.pinned));
  const favouriteTarget = await waitFor('favourite page target', async () => (await targets()).find(target => target.url === home));
  const page = await attach(favouriteTarget.targetId);
  await waitFor('favourite page loaded', () => page.evaluate(`document.readyState === 'complete' && Boolean(document.getElementById('blank'))`));
  await sleep(500); // setPeekSources is sent from the sidebar's next frame.
  const baseline = (await tabs()).length;
  pass('favouriteSource', `tab ${favourite.id} opened from the favourite tile`);

  // ------------------------------------------------------------ target=_blank opens a peek; Escape destroys it
  await page.click('#blank');
  const blank = await waitFor('peek for target=_blank', () => peekTarget(/\/target\?via=blank$/));
  assert.equal((await tabs()).length, baseline, 'target=_blank from a favourite must not add a tab');
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), favourite.id)).url, home, 'favourite stays on its page');
  const shot = spawnSync('/usr/sbin/screencapture', ['-x', join(evidence, 'peek-open.png')]);
  if (shot.status === 0) report.screenshots.push(join(evidence, 'peek-open.png'));
  const blankSession = await attach(blank.targetId);
  await waitFor('peek page loaded', () => blankSession.evaluate(`document.title === 'Peek target'`));
  await blankSession.key('Escape', 'Escape', 27);
  await waitFor('Escape destroys the peek', async () => !(await peekTarget(/\/target\?via=blank$/)));
  assert.equal((await tabs()).length, baseline);
  pass('blankLinkPeek', 'target=_blank opened a non-tab page; Escape from the focused page destroyed it');

  // ------------------------------------------------------------ window.open opens a peek; window.close destroys it
  await page.click('#open');
  const opened = await waitFor('peek for window.open', () => peekTarget(/\/target\?via=open$/));
  assert.equal((await tabs()).length, baseline);
  const openedSession = await attach(opened.targetId);
  await openedSession.evaluate('window.close()');
  await waitFor('window.close destroys the peek', async () => !(await peekTarget(/\/target\?via=open$/)));
  pass('windowOpenPeek', 'window.open() opened a peek; the page closing itself destroyed it');

  // ------------------------------------------------------------ cross-site same-tab link opens a peek; tab switch destroys it
  await page.click('#cross');
  await waitFor('peek for cross-site link', () => peekTarget(/localhost:\d+\/target\?via=cross$/));
  assert.equal((await worker.evaluate(id => chrome.tabs.get(id), favourite.id)).url, home, 'cross-site link must not move the favourite');
  assert.equal((await tabs()).length, baseline);
  const other = await worker.evaluate(() => chrome.tabs.create({ url: 'about:blank', active: true }));
  await waitFor('switching tabs destroys the peek', async () => !(await peekTarget(/via=cross$/)));
  await worker.evaluate(id => chrome.tabs.remove(id), other.id);
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), favourite.id);
  pass('crossSiteContainment', 'a cross-site link click kept the favourite on its page and opened a peek; switching tabs destroyed it');

  // ------------------------------------------------------------ background-tab clicks keep normal behaviour
  await page.click('#blank', 4 /* Meta */);
  await waitFor('Cmd-click opens a background tab', async () => (await tabs()).length === baseline + 1);
  assert.equal(await peekTarget(/via=blank$/), null, 'Cmd-click must not open a peek');
  const background = (await tabs()).find(tab => /via=blank$/.test(tab.url || tab.pendingUrl));
  await worker.evaluate(id => chrome.tabs.remove(id), background.id);
  pass('backgroundClickUnchanged', 'Cmd-click still opened an ordinary background tab');

  // ------------------------------------------------------------ same-site links, back/forward and explicit navigation stay in the tab
  await page.click('#same');
  await waitFor('same-site link navigates the favourite', async () => /\/second$/.test((await worker.evaluate(id => chrome.tabs.get(id), favourite.id)).url));
  assert.equal(await peekTarget(/\/second$/), null);
  await worker.evaluate(id => chrome.tabs.goBack(id), favourite.id);
  await waitFor('back returns to home', async () => (await worker.evaluate(id => chrome.tabs.get(id), favourite.id)).url === home);
  const typed = `http://localhost:${server.address().port}/second?typed`;
  await worker.evaluate(([id, url]) => chrome.tabs.update(id, { url }), [favourite.id, typed]);
  await waitFor('browser-initiated cross-site navigation stays in the tab', async () => (await worker.evaluate(id => chrome.tabs.get(id), favourite.id)).url === typed);
  await stays('explicit navigation must not open a peek', async () => Boolean(await peekTarget(/\?typed$/)), 800);
  await worker.evaluate(id => chrome.tabs.goBack(id), favourite.id);
  await waitFor('back to home again', async () => (await worker.evaluate(id => chrome.tabs.get(id), favourite.id)).url === home);
  pass('ordinaryNavigationUnchanged', 'same-site link, back, and browser-initiated cross-site navigation stayed in the favourite tab');

  // ------------------------------------------------------------ saved identity
  const tile = await host.evaluate(`document.querySelector('#favorites .tile')?.getAttribute('title')`);
  assert.equal(tile, 'Peek home (saved)', 'favourite tile keeps its saved title');
  pass('savedIdentity', 'favourite tile shows the saved title, not the live page title');

  // ------------------------------------------------------------ non-favourite tabs are unaffected; unfavourite clears the mark
  const plain = await worker.evaluate(url => chrome.tabs.create({ url, active: true }), home);
  const plainTarget = await waitFor('plain tab target', async () => (await targets()).find(target => target.url === home && target.targetId !== favouriteTarget.targetId));
  const plainPage = await attach(plainTarget.targetId);
  await waitFor('plain page loaded', () => plainPage.evaluate(`Boolean(document.getElementById('blank'))`));
  const withPlain = (await tabs()).length;
  await plainPage.click('#blank');
  await waitFor('plain tab opens a normal tab', async () => (await tabs()).length === withPlain + 1);
  pass('nonFavouriteUnchanged', 'target=_blank from an ordinary tab opened a normal tab');
  for (const tab of (await tabs()).filter(item => item.id !== favourite.id && !item.pinned)) await worker.evaluate(id => chrome.tabs.remove(id), tab.id);
  await worker.evaluate(id => chrome.tabs.update(id, { active: true }), favourite.id);

  await worker.evaluate(async () => {
    const { 'workspace.v1': store } = await chrome.storage.local.get('workspace.v1');
    store.favorites = [];
    store.rev += 1;
    await chrome.storage.local.set({ 'workspace.v1': store });
  });
  await sleep(800);
  const unmarked = (await tabs()).length;
  await page.click('#blank');
  await waitFor('unfavourited tab opens a normal tab', async () => (await tabs()).length === unmarked + 1);
  assert.equal(await peekTarget(/via=blank$/), null);
  pass('unfavouriteClearsSource', 'after unfavouriting, target=_blank opened a normal tab');

  report.unverified.push(
    'Expand button: moving the live WebContents into a tab (needs physical pointer on the native button).',
    'Close button and backdrop click (native views; not reachable by renderer input).',
    'Window resize while a peek is open, and visual layout beyond the captured screenshot.',
  );
  report.status = 'passed';
} catch (error) {
  report.status = error instanceof Precondition ? 'blocked-precondition' : 'failed';
  report.error = error.stack || String(error);
  process.exitCode = error instanceof Precondition ? 2 : 1;
  console.error(error instanceof Precondition ? `BLOCKED: ${error.message}` : `FAILED: ${error.stack || error}`);
} finally {
  clearTimeout(watchdog);
  await cleanup();
  await writeFile(join(evidence, 'result.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`status: ${report.status}\nunverified: ${report.unverified.length ? report.unverified.join(' | ') : 'none'}\nevidence: ${evidence}`);
}
