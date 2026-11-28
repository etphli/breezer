import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { NOW, CONNECTED, installFixture } from './newtab-browser-fixture.mjs';

// Drives the New Tab box and its compact shortcuts in a real browser. The address
// bar is a synthetic chrome.breezerPrivate; every site and draft is test data.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || resolve(here, '../../build/support/newtab-address-evidence');
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

function extendPage({ omnibox, experiments, look }) {
  if (experiments && !JSON.parse(localStorage.getItem('shortcut-fixture') || '{}').breezerExperiments) {
    void chrome.storage.local.set({ breezerExperiments: experiments });
  }
  if (look) void chrome.storage.local.set({ 'theme.artwork.v1': look });
  Object.assign(fx, { searches: [], queries: [], waits: [], opened: [], delays: {}, failOpen: false });
  chrome.search = { async query(options) { fx.searches.push(options); } };
  chrome.tabs.getCurrent = async () => ({ id: 7, windowId: 1 });
  chrome.tabs.update = async () => ({});
  if (!omnibox) return;
  const url = (host, title, typed) => ({
    kind: 'url', contents: host, description: title, url: `https://${host}/`, fillIntoEdit: host,
    inlineAutocompletion: host.startsWith(typed) ? host.slice(typed.length) : '', isDefault: host.startsWith(typed),
  });
  const search = (query, isDefault = false) => ({
    kind: 'search', contents: query, description: isDefault ? 'Example Search' : '', url: `https://search.example/?q=${query}`,
    fillIntoEdit: query, inlineAutocompletion: '', isDefault,
  });
  let revision = 0;
  fx.local = (text, preventInline) => {
    if (text.startsWith('exa') && 'example.com'.startsWith(text)) {
      return preventInline
        ? [search(text, true), { ...url('example.com', 'Example', text), isDefault: false }]
        : [url('example.com', 'Example', text), search(text), url('docs.example.com', 'Example docs', text)];
    }
    return [search(text, true)];
  };
  fx.settle = null;
  chrome.breezerPrivate = {
    getAppearance: async () => ({
      layout: 'sidebar',
      theme: look?.theme ?? 'mint',
      colorMode: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
    }),
    async queryOmnibox(request) {
      fx.queries.push(request);
      const current = ++revision;
      const delay = fx.delays[request.text];
      if (delay) await new Promise(done => setTimeout(done, delay));
      return { revision: current, done: !fx.settle, matches: request.text ? fx.local(request.text, request.preventInline) : [] };
    },
    nextOmniboxResult(after) {
      fx.waits.push(after);
      return new Promise(done => { fx.finish = matches => done({ revision: ++revision, done: true, matches }); });
    },
    async openOmnibox(request) {
      fx.opened.push(request);
      if (fx.failOpen) throw new Error('synthetic failure');
    },
  };
  fx.url = url;
  fx.search = search;
}

async function open({
  omnibox = true,
  experiments = { newTabComposer: true, newTabShortcuts: true },
  colorScheme = 'light',
  viewport = { width: 1280, height: 820 },
  view = { ...CONNECTED, organato: { enabled: false } },
  look,
  run,
}) {
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/_favicon/') {
        response.setHeader('Content-Type', 'image/svg+xml');
        response.end('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="#1a73e8"/></svg>');
        return;
      }
      const path = resolve(root, `.${url.pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' })[extname(path)] || 'application/octet-stream');
      response.end(await readFile(path));
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport, colorScheme, reducedMotion: 'reduce', locale: 'en-US' });
    await context.addInitScript({ content: `if (location.pathname === '/newtab.html') {
      (${installFixture})(${JSON.stringify({ view })});
      (${extendPage})(${JSON.stringify({ omnibox, experiments, look })});
    }` });
    await context.route('https://example.com/**', route => route.fulfill({ status: 200, contentType: 'text/html', body: '<title>Example</title>' }));
    const page = await context.newPage();
    page.setDefaultTimeout(8000);
    await page.clock.setFixedTime(NOW);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(`http://127.0.0.1:${server.address().port}/newtab.html`);
    await page.waitForFunction(() => document.documentElement.dataset.loaded === 'true' && document.activeElement?.id === 'composer-input');
    if (experiments?.newTabComposer) await page.waitForFunction(() => !document.querySelector('#composer-modes').hidden);
    await run({ page, input: page.locator('#composer-input'), list: page.locator('#composer-suggestions'), rows: page.locator('#composer-suggestions [role="option"]') });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    server.close();
  }
}

const box = page => page.locator('#composer-input').evaluate(node => ({
  value: node.value, selected: node.value.slice(node.selectionStart, node.selectionEnd),
}));
const opened = async (page, count = 1) => {
  await page.waitForFunction(n => fx.opened.length === n, count);
  return page.evaluate(() => fx.opened.at(-1));
};

test('typing shows the address bar’s suggestions and Enter opens its default match', { skip, timeout: 60_000 }, () => open({
  run: async ({ page, input, list, rows }) => {
    await page.keyboard.type('exa');
    await rows.first().waitFor();
    assert.deepEqual(await page.evaluate(() => fx.queries.at(-1)), { text: 'exa', preventInline: false });
    await page.waitForFunction(() => document.querySelector('#composer-input').value === 'example.com');
    assert.deepEqual(await box(page), { value: 'example.com', selected: 'mple.com' });
    assert.deepEqual(await rows.locator('.suggestion-title').allInnerTexts(), ['Example', 'exa', 'Example docs']);
    assert.equal(await rows.first().getAttribute('aria-selected'), 'true');
    assert.equal(await input.getAttribute('aria-controls'), 'composer-suggestions');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, 'newtab-suggestions-light.png') });

    await page.keyboard.press('Enter');
    const first = await opened(page);
    assert.equal(first.text, 'example.com');
    assert.equal(first.index, 0);
    assert.ok(Number.isInteger(first.revision));
    assert.deepEqual(await page.evaluate(() => fx.searches), []);
    assert.equal(await list.isHidden(), true);
  },
}));

test('Charcoal autocomplete stays above Organato and the overlapping rows can be clicked', { skip, timeout: 60_000 }, () => open({
  colorScheme: 'dark',
  view: CONNECTED,
  look: { preset: 'charcoal', theme: '#2e2f33' },
  run: async ({ page, list, rows }) => {
    await page.locator('html[data-look="charcoal"][data-scheme="dark"]').waitFor({ state: 'attached' });
    await page.locator('#organato[data-state="ready"]').waitFor();
    const sheet = page.locator('.sheet');
    const before = await sheet.boundingBox();
    await page.evaluate(() => {
      fx.local = text => [fx.search(text, true), ...Array.from({ length: 7 }, (_, i) => fx.search(`${text} ${i + 1}`))];
    });
    await page.keyboard.type('te');
    const last = rows.nth(7);
    await last.waitFor();
    assert.deepEqual(await sheet.boundingBox(), before, 'Opening suggestions keeps the agenda in place');

    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, 'newtab-suggestions-over-organato.png') });
    const row = await last.boundingBox();
    const x = row.x + row.width / 2;
    const y = row.y + row.height / 2;
    assert.ok(x > before.x && x < before.x + before.width && y > before.y && y < before.y + before.height, 'The suggestion overlaps Organato');
    const top = await page.evaluate(({ x, y }) => {
      return document.elementFromPoint(x, y)?.closest('[role="option"], .sheet')?.className;
    }, { x, y });
    assert.equal(top, 'suggestion', 'The suggestion receives pointer input over Organato');

    await page.mouse.click(x, y);
    assert.equal((await opened(page)).index, 7);
    assert.equal(await list.isHidden(), true);
  },
}));

test('arrow keys, Escape, deletion and the pointer follow address-bar rules', { skip, timeout: 60_000 }, () => open({
  run: async ({ page, input, list, rows }) => {
    await page.keyboard.type('exa');
    await rows.first().waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('ArrowDown');
    assert.equal((await box(page)).value, 'docs.example.com');
    assert.equal(await input.getAttribute('aria-activedescendant'), await rows.nth(2).getAttribute('id'));
    await page.keyboard.press('Enter');
    assert.equal((await opened(page)).index, 2);

    await input.fill('');
    await page.keyboard.type('exa');
    await rows.first().waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    assert.equal(await list.isHidden(), true);
    assert.equal((await box(page)).value, 'exa');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'composer-input');
    await page.keyboard.press('Enter');
    assert.deepEqual(await opened(page, 2), { text: 'exa' });

    await input.fill('');
    await page.keyboard.type('exam');
    await page.waitForFunction(() => document.querySelector('#composer-input').value === 'example.com');
    await page.keyboard.press('Backspace');
    await page.waitForFunction(() => fx.queries.at(-1).preventInline);
    await page.waitForFunction(() => document.querySelectorAll('#composer-suggestions [role="option"]').length === 2);
    assert.deepEqual(await box(page), { value: 'exam', selected: '' });

    await rows.nth(1).click();
    assert.equal((await opened(page, 3)).index, 1);

    // Shift+Enter keeps the caret in the box instead of opening anything.
    await input.fill('');
    await page.waitForFunction(() => document.querySelector('#composer-suggestions').hidden);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => fx.opened.length), 3);
  },
}));

test('late results keep the chosen row and stale answers never show', { skip, timeout: 60_000 }, () => open({
  run: async ({ page, input, rows }) => {
    await page.evaluate(() => { fx.settle = true; });
    await page.keyboard.type('exa');
    await rows.first().waitFor();
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => fx.waits.length > 0 && fx.finish);
    await page.evaluate(() => fx.finish([fx.url('example.com', 'Example', 'exa'), fx.search('example ideas'), fx.search('exa')]));
    await page.waitForFunction(() => document.querySelectorAll('#composer-suggestions [role="option"]')[1]?.innerText.includes('example ideas'));
    assert.equal(await rows.nth(2).getAttribute('aria-selected'), 'true', 'The row the person chose moved with its match');
    await page.keyboard.press('Enter');
    assert.equal((await opened(page)).index, 2);

    await page.evaluate(() => { fx.settle = null; fx.delays = { slow: 250 }; });
    await input.fill('slow');
    await input.fill('exa');
    await rows.nth(2).waitFor();
    await page.waitForTimeout(350);
    assert.equal(await rows.count(), 3, 'A slow answer for older text must not replace newer suggestions');

    // Enter never waits for suggestions: the browser decides what the text means.
    await page.evaluate(() => { fx.delays = { 'quick.example': 5000 }; });
    await input.fill('quick.example');
    await page.keyboard.press('Enter');
    assert.deepEqual(await opened(page, 2), { text: 'quick.example' });
  },
}));

test('Enter still opens addresses and searches when the native bridge fails or is missing', { skip, timeout: 60_000 }, async () => {
  await open({ run: async ({ page, input }) => {
    await page.evaluate(() => { fx.failOpen = true; });
    await input.fill('two words');
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => fx.searches.length === 1);
    assert.deepEqual(await page.evaluate(() => fx.searches[0]), { text: 'two words', tabId: 7 });
    await input.fill('example.com');
    await Promise.all([page.waitForURL('https://example.com/'), page.keyboard.press('Enter')]);
  } });
  await open({ omnibox: false, run: async ({ page, input, list }) => {
    await page.keyboard.type('example.com');
    assert.equal(await list.isHidden(), true);
    await Promise.all([page.waitForURL('https://example.com/'), input.press('Enter')]);
  } });
});

test('Tab turns on Ask with the draft kept, and never traps the keyboard', { skip, timeout: 60_000 }, async () => {
  await open({ run: async ({ page, input, list, rows }) => {
    const mode = () => page.locator('#composer-form').getAttribute('data-mode');
    const focused = () => page.evaluate(() => document.activeElement.id || document.activeElement.dataset.mode);
    await page.evaluate(() => { fx.settle = true; });
    await page.keyboard.type('exa');
    await rows.first().waitFor();
    await page.waitForFunction(() => document.querySelector('#composer-input').value === 'example.com');
    await page.keyboard.press('Tab');
    assert.equal(await mode(), 'ask');
    assert.equal(await focused(), 'composer-input');
    assert.deepEqual(await box(page), { value: 'exa', selected: '' }, 'A suggested ending is not part of the draft');
    assert.equal(await list.isHidden(), true);
    assert.match(await page.locator('#composer-status').innerText(), /Esc/);
    const asked = await page.evaluate(() => fx.queries.length);
    await page.keyboard.type('mple question');
    await page.waitForTimeout(80);
    assert.equal(await page.evaluate(() => fx.queries.slice(-1)[0].text), '', 'Leaving Search stops the suggestion query');
    assert.ok(await page.evaluate(() => fx.queries.length) <= asked, 'Ask drafts are not sent for suggestions');

    // Forward from Ask: the normal tab order continues.
    await page.keyboard.press('Tab');
    assert.equal(await focused(), 'ask');
    await page.keyboard.press('Tab');
    assert.equal(await focused(), 'composer-send');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(), 'composer-input');

    // Escape goes back to Search with the draft, and frees the next Tab.
    await page.keyboard.press('Escape');
    assert.equal(await mode(), 'search');
    assert.equal((await box(page)).value, 'example question');
    await page.keyboard.press('Tab');
    assert.equal(await focused(), 'search');
    assert.equal(await mode(), 'search');
    await page.keyboard.press('Shift+Tab');
    assert.equal(await focused(), 'composer-input');
    await page.keyboard.press('Tab');
    assert.equal(await mode(), 'ask', 'Coming back to the box turns the shortcut on again');
    await page.keyboard.press('Shift+Tab');
    assert.notEqual(await focused(), 'composer-input', 'Shift+Tab always leaves the box');
    assert.equal(await mode(), 'ask');
    assert.equal(await input.inputValue(), 'example question');
  } });
  await open({ experiments: {}, run: async ({ page }) => {
    await page.keyboard.type('exa');
    await page.keyboard.press('Tab');
    assert.notEqual(await page.evaluate(() => document.activeElement.id), 'composer-input', 'Without Ask, Tab moves on');
    assert.equal(await page.locator('#composer-form').getAttribute('data-mode'), 'search');
    assert.equal(await page.locator('#composer-suggestions').isHidden(), true);
  } });
});

test('compact shortcuts can be removed, undone and restored', { skip, timeout: 60_000 }, async () => {
  await open({ run: async ({ page }) => {
    const sites = page.locator('#composer-sites li');
    const link = name => page.locator('#composer-sites').getByRole('link', { name, exact: true });
    const remove = name => page.locator('#composer-sites').getByRole('button', { name: `Remove ${name} shortcut` });
    const undo = page.getByRole('button', { name: 'Undo' });
    await sites.nth(7).waitFor();
    assert.equal(await remove('Canvas').evaluate(node => getComputedStyle(node).opacity), '0');
    await link('Canvas').hover();
    assert.equal(await remove('Canvas').evaluate(node => getComputedStyle(node).opacity), '1');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, 'newtab-compact-remove.png') });
    const target = await remove('Canvas').boundingBox();
    assert.ok(target.width >= 24 && target.height >= 24, 'The remove target is at least 24 by 24');
    await remove('Canvas').click();
    await link('Canvas').waitFor({ state: 'detached' });
    assert.equal(await page.url().includes('newtab.html'), true);
    await page.getByText('Shortcut removed.').waitFor();
    assert.equal(await undo.isVisible(), true);
    assert.equal(await undo.evaluate(node => node === document.activeElement), true);
    const stored = await page.evaluate(async () => (await chrome.storage.local.get('newtab.hiddenSites.v1'))['newtab.hiddenSites.v1']);
    assert.equal(stored.length, 1);
    assert.match(stored[0], /^[a-f0-9]{64}$/);
    await page.screenshot({ path: join(evidence, 'newtab-compact-undo.png') });
    await undo.click();
    await link('Canvas').waitFor();
    assert.equal(await link('Canvas').evaluate(node => node === document.activeElement), true, 'Undo returns to the restored shortcut');

    // Keyboard: the button follows its link and shows on focus.
    await link('Docs').focus();
    await page.keyboard.press('Tab');
    assert.equal(await remove('Docs').evaluate(node => node === document.activeElement), true);
    assert.equal(await remove('Docs').evaluate(node => getComputedStyle(node).opacity), '1');
    await page.keyboard.press('Enter');
    await link('Docs').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: 'Restore shortcuts' }).click();
    await link('Docs').waitFor();

    // Right-click menu, with Escape returning to the shortcut.
    await link('Mail').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove shortcut' }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await link('Mail').evaluate(node => node === document.activeElement), true);
    await link('Mail').click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Remove shortcut' }).click();
    await link('Mail').waitFor({ state: 'detached' });

    await page.evaluate(() => chrome.storage.local.set({ breezerExperiments: { newTabComposer: true, newTabShortcuts: false } }));
    await page.waitForFunction(() => document.querySelector('#composer-sites').hidden);
    assert.equal(await page.getByRole('button', { name: 'Restore shortcuts' }).isHidden(), true);
  } });
  await open({ experiments: {}, run: async ({ page }) => {
    const add = page.locator('.site-add-button');
    await add.click({ button: 'right' });
    assert.equal(await page.getByRole('menuitem').count(), 0, 'Add shortcut is not a removable site');
    await page.locator('#sites .site').first().hover();
    await page.locator('#sites .site-remove').first().click();
    await page.getByText('Shortcut removed.').waitFor();
    await page.getByRole('button', { name: 'Undo' }).click();
    await page.getByText('Shortcut restored.').waitFor();
  } });
});

test('suggestions fit narrow and short windows in both layouts', { skip, timeout: 60_000 }, async () => {
  for (const [name, options] of Object.entries({
    narrow: { viewport: { width: 390, height: 640 }, colorScheme: 'dark' },
    short: { viewport: { width: 900, height: 420 } },
    dated: { experiments: {} },
  })) {
    await open({ ...options, run: async ({ page, list, rows }) => {
      await page.keyboard.type('exa');
      await rows.nth(2).waitFor();
      await mkdir(evidence, { recursive: true });
      await page.screenshot({ path: join(evidence, `newtab-suggestions-${name}.png`) });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, name);
      const on = await rows.nth(1).evaluate(node => {
        const r = node.getBoundingClientRect();
        return node.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
      });
      assert.equal(on, true, `${name}: suggestions sit above the rest of the page`);
      assert.equal(await list.isVisible(), true);
    } });
  }
});
