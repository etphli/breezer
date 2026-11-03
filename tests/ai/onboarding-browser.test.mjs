import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Walks the shipped first-run setup (workspace.html#/welcome) in a headless browser
// with fake chrome.* APIs, the way a tester would. Set BREEZER_ONBOARDING_VIDEO to a
// directory to record the walkthrough at a human pace.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const videoDir = process.env.BREEZER_ONBOARDING_VIDEO || '';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

function installFixture({ bridge, layout, local = {}, organato = {} }) {
  // fx.organato is the helper's saved state; fx.configure scripts a change: 'ok', 'fail' or 'hang'.
  const fx = { local: structuredClone(local), session: {}, opened: [], updated: [], ports: {}, listeners: [], writes: [],
    organato: { connected: false, enabled: true, allowAI: true, dashboardEnabled: true, ...organato }, configure: 'ok' };
  window.fx = fx;
  const area = (data, name) => ({
    async get(keys) { const list = keys == null ? Object.keys(data) : [keys].flat(); return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]))); },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
      setTimeout(() => fx.listeners.forEach((fn) => fn(changes, name)), 0);
    },
  });
  const event = () => { const list = []; return { list, addListener: (fn) => list.push(fn), removeListener() {} }; };
  const appearance = { layout, sidebarMode: 'expanded', theme: 'mint', colorMode: 'light', showBookmarks: true, bookmarkBarMode: 'newTab', sidebarWidth: 240, sidebarFontSize: 15, centeredAddressBar: true, minimalUrl: true, showLoadProgress: true, frameless: true, alwaysShowSidebar: false, alwaysShowTopBar: true };
  fx.appearance = appearance;
  window.chrome = {
    runtime: {
      getURL: (path) => `${location.origin}/${path}`,
      onMessage: event(),
      connect({ name }) {
        const port = { name, sent: [], onMessage: event(), onDisconnect: event(), disconnect() {} };
        port.reply = (message) => port.onMessage.list.forEach((fn) => fn(structuredClone(message)));
        // Organato answers like the background helper: view reports the saved state,
        // configure with a key reports progress and then a connection.
        port.postMessage = (message) => {
          port.sent.push(message);
          if (message.type === 'view') setTimeout(() => port.reply({ id: message.id, ok: true, value: structuredClone(fx.organato) }), 0);
          if (message.type === 'configure') {
            const { key, ...switches } = message.settings || {};
            if (key) setTimeout(() => port.reply({ id: message.id, type: 'progress', stage: 'Checking your Organato key…' }), 300);
            if (fx.configure === 'hang') return;
            setTimeout(() => {
              if (fx.configure === 'fail') { port.reply({ id: message.id, ok: false, error: 'Couldn’t save Organato settings.' }); return; }
              Object.assign(fx.organato, switches, key ? { connected: true } : {});
              port.reply({ id: message.id, ok: true, value: structuredClone(fx.organato) });
            }, key ? 1200 : 250);
          }
        };
        fx.ports[name] = port;
        return port;
      },
    },
    storage: { local: area(fx.local, 'local'), session: area(fx.session, 'session'),
      onChanged: { addListener: (fn) => fx.listeners.push(fn), removeListener() {} } },
    tabs: {
      async create(props) { fx.opened.push(props); return props; },
      async getCurrent() { return { id: 42 }; },
      async update(id, props) { fx.updated.push({ id, ...props }); return { id, ...props }; },
    },
    ...(bridge ? { breezerPrivate: {
      async getAppearance() { return structuredClone(appearance); },
      async setAppearance(patch) { fx.writes.push(patch); Object.assign(appearance, patch); return structuredClone(appearance); },
    } } : {}),
  };
}

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

test('first-run setup walks through name, layout, theme, import, Organato and the tour', { skip, timeout: 180_000 }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}/workspace.html#/welcome`;
  let browser;
  const errors = [];
  // A tester pauses to read; automated runs only wait for animations to settle.
  const pause = (ms) => new Promise((done) => setTimeout(done, videoDir ? ms : 60));
  const open = async ({ width = 1280, height = 800, reducedMotion = 'no-preference', bridge = true, record = false, layout = 'sidebar', local, organato } = {}) => {
    const context = await browser.newContext({
      viewport: { width, height }, deviceScaleFactor: record ? 1 : 2, colorScheme: 'light', reducedMotion,
      ...(record ? { recordVideo: { dir: videoDir, size: { width, height } } } : {}),
    });
    await context.addInitScript(installFixture, { bridge, layout, local, organato });
    const page = await context.newPage();
    page.on('pageerror', (error) => errors.push(error.message));
    page.on('console', (message) => { if (message.type() === 'error' && !/404/.test(message.text())) errors.push(message.text()); });
    await page.goto(base);
    await page.locator('#welcome[data-ready="true"]').waitFor();
    return { context, page };
  };
  // Screenshots wait for one-off animations; looping tour hints keep running.
  const shot = async (page, name) => {
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== 'running' || animation.effect.getTiming().iterations === Infinity));
    await page.screenshot({ path: join(evidence, `onboarding-${name}.png`), fullPage: true });
  };

  try {
    browser = await chromium.launch({ executablePath, headless: true });
    const { context, page } = await open({ record: Boolean(videoDir) });
    const next = page.locator('#wl-next');
    const heading = () => page.locator('.wl-step:not([hidden]) h1').innerText();

    // Start
    assert.equal(await page.title(), 'Welcome to Breezer');
    assert.equal(await heading(), 'Welcome to Breezer');
    assert.equal(await next.innerText(), 'Get started');
    assert.equal(await page.locator('#wl-back').isVisible(), false);
    assert.equal(await page.evaluate(() => document.activeElement.id), 'wl-h-welcome');
    await pause(2200);
    await shot(page, '1-welcome');
    await next.click();

    // Name: typed live into the miniature assistant, saved into the assistant's profile.
    assert.equal(await heading(), 'What should Breezer AI call you?');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'wl-name');
    await page.locator('#wl-name').pressSequentially('  Sam  ', { delay: videoDir ? 140 : 0 });
    assert.equal(await page.locator('#wl-mini-name').innerText(), 'Sam');
    await pause(900);
    await shot(page, '2-name');
    await page.keyboard.press('Enter');
    assert.deepEqual(await page.evaluate(() => fx.local.breezerProfile), { name: 'Sam', context: '' });
    assert.equal((await page.evaluate(() => fx.local['breezer.setup.v1'])).step, 'layout');

    // Layout: Top hides the sidebar row's effect; arrow keys move within the group.
    assert.equal(await heading(), 'Where should your tabs live?');
    await pause(700);
    await page.getByRole('radio', { name: /^Top/ }).click();
    await page.waitForFunction(() => fx.appearance.layout === 'top');
    assert.equal(await page.locator('#wl-mini').getAttribute('data-layout'), 'top');
    assert.equal(await page.locator('#wl-sidebar-mode-row').evaluate((node) => node.classList.contains('muted-row')), true);
    await pause(1300);
    await page.getByRole('radio', { name: /^Top/ }).press('ArrowLeft');
    await page.waitForFunction(() => fx.appearance.layout === 'sidebar');
    await pause(700);
    await page.getByRole('radio', { name: 'Auto-hide' }).click();
    await page.waitForFunction(() => fx.appearance.sidebarMode === 'autoHide');
    await pause(1600);
    await page.getByRole('radio', { name: 'Expanded' }).click();
    await page.waitForFunction(() => fx.appearance.sidebarMode === 'expanded');
    await pause(600);
    await shot(page, '3-layout');
    await next.click();

    // Theme: the page itself repaints with the chosen tone and scheme.
    assert.equal(await heading(), 'Pick a color for Breezer');
    await pause(600);
    for (const tone of ['Tide', 'Rose', 'Dusk']) {
      await page.getByRole('radio', { name: tone }).click();
      await pause(650);
    }
    await page.waitForFunction(() => fx.appearance.theme === 'dusk');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.tone), 'dusk');
    await page.getByRole('radio', { name: 'Dark' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.scheme === 'dark');
    await pause(1200);
    await shot(page, '4-theme-dark');
    await page.getByRole('radio', { name: 'Light' }).click();
    await page.waitForFunction(() => document.documentElement.dataset.scheme === 'light');
    assert.ok(await page.evaluate(() => 'appearance.rev' in fx.session), 'other Breezer pages are told to reload appearance');
    await pause(700);
    await next.click();

    // Import: opens the native routes and never claims an import happened.
    assert.equal(await heading(), 'Bring your things from Chrome');
    await pause(900);
    await page.getByRole('button', { name: 'Open import dialog' }).click();
    await page.getByRole('button', { name: 'Import passwords' }).click();
    assert.deepEqual(await page.evaluate(() => fx.opened.map((tab) => tab.url)), ['chrome://settings/importData', 'chrome://password-manager/settings?import=true']);
    assert.doesNotMatch(await page.locator('#wl-import-status').innerText(), /imported|success|complete/i);
    await pause(1200);
    await shot(page, '5-import');
    await next.click();

    // Organato: optional; a key goes to the background helper, never into storage.
    assert.equal(await heading(), 'Connect Organato?');
    await pause(700);
    await page.getByRole('button', { name: 'Connect' }).click();
    assert.match(await page.locator('#wl-organato-status').innerText(), /Paste your API key/);
    await page.locator('#wl-organato-key').pressSequentially('org_demo_key', { delay: videoDir ? 70 : 0 });
    await page.keyboard.press('Enter');
    await page.locator('#wl-organato-status', { hasText: 'Organato is connected' }).waitFor();
    const sent = await page.evaluate(() => fx.ports['breezer-organato-settings'].sent);
    assert.deepEqual(sent.map((message) => message.type), ['view', 'configure']);
    assert.deepEqual(sent[1].settings, { key: 'org_demo_key' });
    assert.equal(await page.locator('#wl-organato-key').inputValue(), '');
    assert.doesNotMatch(await page.evaluate(() => JSON.stringify(fx.local)), /org_demo_key/);
    await pause(1500);
    await shot(page, '6-organato');
    await next.click();

    // Tour: three sidebar slides then two assistant slides; Back steps within the tour.
    const titles = [];
    for (let at = 0; at < 5; at += 1) {
      titles.push(await heading());
      assert.equal(await page.locator('#wl-tour-count').innerText(), `${at + 1} of 5`);
      await pause(2600);
      if (at === 0 || at === 3) await shot(page, `7-tour-${at + 1}`);
      if (at === 1) {
        await page.locator('#wl-back').click();
        assert.equal(await page.locator('#wl-tour-count').innerText(), '1 of 5');
        await next.click();
      }
      await next.click();
    }
    assert.deepEqual(titles, ['Your tabs run down the side', 'Favorites and spaces', 'Settings, one click away', 'Meet Breezer AI', 'Let it help, on your terms']);

    // Done: summary of what was chosen.
    assert.equal(await heading(), 'You’re all set, Sam');
    const summary = await page.locator('#wl-summary').innerText();
    for (const value of ['Sam', 'Sidebar, expanded', 'Dusk, light', 'Connected']) assert.match(summary, new RegExp(value));
    assert.equal(await next.innerText(), 'Start browsing');
    await pause(2600);
    await shot(page, '8-done');
    await next.click();
    await page.waitForFunction(() => fx.updated.length === 1);
    assert.deepEqual(await page.evaluate(() => fx.updated), [{ id: 42, url: 'chrome://newtab/' }]);
    assert.deepEqual(await page.evaluate(() => fx.local['breezer.setup.v1']), { step: 'done', completed: true, skipped: false });
    assert.deepEqual(await page.evaluate(() => fx.local['settings.onboarding.v1']), { dismissed: true });
    await context.close();

    // Top tabs get the top-tab tour; Skip records a skip and leaves the import card alone.
    {
      const { context, page } = await open({ reducedMotion: 'reduce', layout: 'top' });
      for (let at = 0; at < 6; at += 1) await page.locator('#wl-next').click();
      assert.equal(await page.locator('#wl-h-tour').innerText(), 'Your tabs stay across the top');
      assert.equal(await page.locator('#wl-tour-count').innerText(), '1 of 3');
      assert.equal(await page.locator('.wl-step:not([hidden])').evaluate((node) => getComputedStyle(node).animationName), 'none');
      await page.locator('#wl-skip').click();
      await page.waitForFunction(() => fx.updated.length === 1);
      assert.deepEqual(await page.evaluate(() => fx.local['breezer.setup.v1']), { step: 'done', completed: true, skipped: true });
      assert.equal(await page.evaluate(() => fx.local['settings.onboarding.v1']), undefined);
      await context.close();
    }

    // One button turns Organato off: saved in the helper first, then setup moves on.
    {
      const { context, page } = await open({ reducedMotion: 'reduce', local: { 'breezer.setup.v1': { step: 'organato', completed: false } } });
      assert.equal(await page.locator('.wl-step:not([hidden]) h1').innerText(), 'Connect Organato?');
      const optOut = page.getByRole('button', { name: 'Don’t use Organato' });
      assert.equal(await optOut.getAttribute('aria-describedby'), 'wl-organato-off-note');
      await shot(page, '6-organato-optout');
      // Keyboard: the opt-out is reachable and works with Enter.
      // Key field, Connect, the Organato Settings link, then the opt-out.
      await page.locator('#wl-organato-key').focus();
      for (let at = 0; at < 3; at += 1) await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'wl-organato-off');
      await page.keyboard.press('Enter');
      // Nothing moves on, and nothing claims "off", until the helper confirms.
      assert.equal(await page.locator('#wl-next').isDisabled(), true);
      assert.equal(await page.locator('#wl-organato-status').innerText(), 'Turning Organato off…');
      assert.equal(await page.locator('.wl-step:not([hidden]) h1').innerText(), 'Connect Organato?');
      await page.locator('#wl-tour-count').waitFor();
      assert.deepEqual(await page.evaluate(() => fx.ports['breezer-organato-settings'].sent.map(({ type, settings }) => ({ type, settings }))), [{ type: 'view', settings: undefined }, { type: 'configure', settings: { enabled: false } }]);
      assert.equal(await page.evaluate(() => fx.organato.enabled), false);
      assert.equal(await page.evaluate(() => fx.organato.connected), false);
      assert.deepEqual(await page.evaluate(() => fx.local['breezer.setup.v1']), { step: 'tour', completed: false });
      // Back shows the saved choice, without offering to turn it off again.
      await page.locator('#wl-back').click();
      assert.equal(await page.locator('#wl-organato-status').innerText(), 'Organato is turned off. You can turn it on in Settings.');
      assert.equal(await page.locator('#wl-organato-off').isVisible(), false);
      assert.equal(await page.locator('#wl-organato-off-note').isVisible(), false);
      for (let at = 0; at < 6; at += 1) await page.locator('#wl-next').click();
      assert.match(await page.locator('#wl-summary').innerText(), /Organato\s+Turned off/);
      await shot(page, '8-done-organato-off');
      await page.locator('#wl-next').click();
      await page.waitForFunction(() => fx.updated.length === 1);
      assert.deepEqual(await page.evaluate(() => fx.local['breezer.setup.v1']), { step: 'done', completed: true, skipped: false });
      assert.equal(await page.evaluate(() => fx.organato.enabled), false, 'finishing setup keeps the choice');
      await context.close();
    }

    // A failed save says so, keeps Organato on and leaves the person on this step.
    {
      const { context, page } = await open({ reducedMotion: 'reduce', width: 390, height: 844, local: { 'breezer.setup.v1': { step: 'organato', completed: false } } });
      await page.evaluate(() => { fx.configure = 'fail'; });
      await page.getByRole('button', { name: 'Don’t use Organato' }).click();
      await page.locator('#wl-organato-status', { hasText: 'Couldn’t turn Organato off.' }).waitFor();
      assert.equal(await page.locator('.wl-step:not([hidden]) h1').innerText(), 'Connect Organato?');
      assert.equal(await page.evaluate(() => document.activeElement.id), 'wl-organato-off');
      assert.equal(await page.locator('#wl-next').isDisabled(), false);
      assert.equal(await page.evaluate(() => fx.organato.enabled), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
      await shot(page, '6-organato-optout-failed-narrow');
      // Retry succeeds.
      await page.evaluate(() => { fx.configure = 'ok'; });
      await page.getByRole('button', { name: 'Don’t use Organato' }).click();
      await page.locator('#wl-tour-count').waitFor();
      assert.equal(await page.evaluate(() => fx.organato.enabled), false);
      await context.close();
    }

    // Continue alone is not an opt-out, and a profile's earlier "off" is shown, not reset.
    {
      const { context, page } = await open({ reducedMotion: 'reduce', local: { 'breezer.setup.v1': { step: 'organato', completed: false } } });
      await page.locator('#wl-next').click();
      assert.equal(await page.evaluate(() => fx.organato.enabled), true);
      assert.deepEqual(await page.evaluate(() => fx.ports['breezer-organato-settings'].sent.map(({ type }) => type)), ['view']);
      await context.close();
    }
    {
      const { context, page } = await open({ reducedMotion: 'reduce', organato: { enabled: false, connected: true }, local: { 'breezer.setup.v1': { step: 'organato', completed: false } } });
      await page.locator('#wl-organato-status', { hasText: 'Organato is turned off' }).waitFor();
      assert.equal(await page.locator('#wl-organato-off').isVisible(), false);
      await page.locator('#wl-skip').click();
      await page.waitForFunction(() => fx.updated.length === 1);
      assert.deepEqual(await page.evaluate(() => fx.ports['breezer-organato-settings'].sent.map(({ type }) => type)), ['view']);
      assert.equal(await page.evaluate(() => fx.organato.enabled), false);
      await context.close();
    }

    // Without the native bridge the page explains why color and layout are fixed.
    {
      const { context, page } = await open({ bridge: false, width: 390, height: 844 });
      assert.match(await page.locator('#wl-bridge-note').innerText(), /browser integration/);
      await page.locator('#wl-next').click();
      await page.locator('#wl-next').click();
      assert.equal(await page.getByRole('radio', { name: /^Top/ }).getAttribute('aria-disabled'), 'true');
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      assert.equal(overflow, 0, 'no horizontal scrolling at 390px');
      await shot(page, 'narrow-no-bridge');
      await context.close();
    }

    assert.deepEqual(errors, []);
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});
