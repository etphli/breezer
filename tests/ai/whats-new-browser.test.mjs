import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { RELEASE_VERSION } from '../../features/ai/extension/release-info.js';

// Drives the shipped whats-new.html in headless Chrome. release-info.js is
// served from the synthetic fixture below (Main ships the real one), and
// chrome.tabs is a recording stub. Nothing here launches the native app.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const baseline = process.env.BREEZER_UI_BASELINE;
if (baseline && !/^[a-f0-9]{7,40}$/.test(baseline)) throw new Error('BREEZER_UI_BASELINE must be a commit hash');
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);

const releaseInfo = (version) => `export const RELEASE = { version: ${JSON.stringify(version)}, title: 'Yours from the first tab' };\nexport const RELEASE_VERSION = RELEASE.version;\n`;

async function startServer() {
  let release = releaseInfo(RELEASE_VERSION);
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname === '/favicon.ico') { response.writeHead(204).end(); return; }
      if (url.pathname === '/release-info.js') {
        if (release == null) throw new Error('No release info');
        response.setHeader('Content-Type', 'application/javascript');
        response.end(release);
        return;
      }
      const path = resolve(root, `.${url.pathname}`);
      if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      const content = baseline
        ? execFileSync('git', ['show', `${baseline}:features/ai/extension/${url.pathname.slice(1)}`], { cwd: resolve(root, '../../..') })
        : await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  server.setRelease = (value) => { release = value; };
  return server;
}

function installFixture({ tabs }) {
  window.fx = { removed: [], closed: 0 };
  window.close = () => { window.fx.closed += 1; };
  if (tabs === 'current') {
    window.chrome = { tabs: { getCurrent: async () => ({ id: 42 }), remove: async (id) => { window.fx.removed.push(id); } } };
  } else if (tabs === 'failing') {
    window.chrome = { tabs: { getCurrent: async () => { throw new Error('No tab'); }, remove: async () => {} } };
  }
}

async function withPage(browser, base, options, fn) {
  const { viewport = { width: 1440, height: 900 }, reducedMotion = 'reduce', tabs = 'current', deviceScaleFactor = viewport.width < 720 ? 1 : 2, forcedColors = 'none' } = options;
  const context = await browser.newContext({ viewport, reducedMotion, colorScheme: 'dark', locale: 'en-US', deviceScaleFactor, forcedColors });
  await context.addInitScript(installFixture, { tabs });
  const page = await context.newPage();
  const errors = [];
  const foreign = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => { if (message.type() === 'error' && !/release-info\.js|404/.test(message.text())) errors.push(message.text()); });
  page.on('request', (request) => { if (!request.url().startsWith(base)) foreign.push(request.url()); });
  try {
    await page.goto(`${base}/whats-new.html`);
    await page.waitForSelector('html[data-ready="true"]');
    await fn(page);
    assert.deepEqual(errors, []);
    assert.deepEqual(foreign, [], 'no requests leave the extension');
  } finally {
    await context.close();
  }
}

// Keep each capture within the viewport. Very tall HiDPI full-page captures
// can repeat compositor tiles, even when the document has only one masthead.
async function captureLongPage(page, name) {
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const viewport = page.viewportSize();
  const tiles = [];
  for (let target = 0; target < height; target += viewport.height - 100) {
    await page.evaluate(y => scrollTo(0, y), target);
    await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const scrollY = await page.evaluate(() => window.scrollY);
    if (tiles.at(-1)?.scrollY === scrollY) break;
    const file = `${name}-tile-${String(tiles.length + 1).padStart(2, '0')}.png`;
    await page.screenshot({ path: `${evidence}/${file}`, fullPage: false });
    tiles.push({ file, scrollY, mastheadBottom: await page.locator('.masthead').evaluate(node => node.getBoundingClientRect().bottom) });
    if (scrollY + viewport.height >= height) break;
  }
  assert.equal(await page.locator('main.sheet').count(), 1);
  assert.equal(await page.locator('.masthead .title').count(), 1);
  await writeFile(`${evidence}/${name}-tiles.json`, JSON.stringify({ height, viewport, mastheads: 1, tiles }, null, 2));
  await page.evaluate(() => scrollTo(0, 0));
  await page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
}

async function captureFeatureDetails(page, size) {
  for (const [name, selector] of [
    ['patch', 'section[aria-labelledby="patch-121-title"]'],
    ['ui-update', 'section[aria-labelledby="patch-125-title"]'],
    ['passkeys', 'article[aria-labelledby="f-passkeys"]'],
    ['shortcuts', 'article[aria-labelledby="f-shortcuts"]'],
  ]) await page.locator(selector).screenshot({ path: `${evidence}/whats-new-${name}-${size}.png`, animations: 'disabled' });
  await page.evaluate(() => scrollTo(0, 0));
}

// WCAG relative-luminance contrast between an element's text and the paper.
const contrast = (page, selector) => page.$eval(selector, (node) => {
  // color-mix() computes to color(srgb r g b) with 0-1 channels.
  const rgb = (value) => value.match(/[\d.]+/g).slice(0, 3).map((c) => Number(c) * (value.startsWith('color(') ? 255 : 1));
  const lum = ([r, g, b]) => [r, g, b].map((c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; }).reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i], 0);
  let back = node;
  while (back && getComputedStyle(back).backgroundColor === 'rgba(0, 0, 0, 0)') back = back.parentElement;
  const [a, b] = [lum(rgb(getComputedStyle(node).color)), lum(rgb(getComputedStyle(back).backgroundColor))];
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
});

test('What\'s new page renders, closes its tab and opens Settings', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const server = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  let browser;
  try {
    browser = await chromium.launch({ executablePath, headless: true });
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.textContent('#release-name'), `Breezer ${RELEASE_VERSION}`);
      assert.equal(await page.title(), `What's new in Breezer ${RELEASE_VERSION}`);
      assert.equal(await page.textContent('h1'), 'Yours from the first tab');
      assert.deepEqual(await page.$$eval('.feature h3', (nodes) => nodes.map((node) => node.textContent)),
        ['A setup guide for new profiles', 'Shortcuts you choose', 'Tasks open where they live', 'No more ghost tabs', 'Helpers that rest when idle', 'Less work at startup, less left on disk', 'Clearer passkey settings', 'Research across tabs you choose', 'Translate a page, keep the original', 'Find settings by category or search']);
      // Cream, even though the OS asks for dark.
      assert.equal(await page.$eval('body', (body) => getComputedStyle(body).backgroundColor), 'rgb(243, 235, 218)');
      for (const selector of ['h1', '.lede', '.feature-copy p', '.notes li', '.pending p', '.button.primary', '.button.secondary', '.feature-copy .button']) {
        const ratio = await contrast(page, selector);
        assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)}`);
      }
      // Illustrations are hidden from assistive tech and not focusable.
      assert.equal(await page.$$eval('.plate', (plates) => plates.every((plate) => plate.getAttribute('aria-hidden') === 'true')), true);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      // Primary illustrations alternate; secondary notes keep a compact text column.
      assert.deepEqual(await page.$$eval('.feature', (rows) => rows.map((row) => {
        const plate = row.querySelector('.plate')?.getBoundingClientRect(), copy = row.querySelector('.feature-copy').getBoundingClientRect();
        return !plate ? 'compact' : plate.left < copy.left ? 'left' : 'right';
      })), ['left', 'right', 'left', 'compact', 'compact', 'compact', 'left', 'right', 'left', 'right']);
      // Every drawing renders inside its plate.
      assert.equal(await page.$$eval('.plate .art', (arts) => arts.every((art) => {
        const box = art.getBoundingClientRect();
        const plate = art.parentElement.getBoundingClientRect();
        if (!box.width) return Boolean(art.closest('.feature-secondary')) && !art.closest('.feature').querySelector('.feature-details').open;
        return box.width > 200 && box.height > 120 && box.right <= plate.right + 0.5 && box.bottom <= plate.bottom + 0.5;
      })), true);
      await page.screenshot({ path: `${evidence}/whats-new-desktop.png` });
      await captureLongPage(page, 'whats-new-desktop');
      await captureFeatureDetails(page, 'desktop');

      // Keyboard: Continue browsing first, then Settings, with a visible ring.
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Continue browsing');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.getAttribute('href')), 'workspace.html#/settings');
      assert.equal(await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle), 'solid');
      const focusGap = await page.evaluate(() => document.querySelector('.page-index').getBoundingClientRect().top - document.activeElement.getBoundingClientRect().bottom);
      assert.ok(focusGap >= 12, 'masthead focus outline and shadow clear the following section index');
      await page.screenshot({ path: `${evidence}/whats-new-keyboard-focus.png` });

      await page.click('.masthead [data-action="continue"]');
      await page.waitForFunction(() => window.fx.removed.length === 1);
      assert.deepEqual(await page.evaluate(() => window.fx), { removed: [42], closed: 0 });
    });

    // Technical explanations and extra measurements remain available on demand.
    await withPage(browser, base, {}, async page => {
      await page.locator('article[aria-labelledby="f-storage"]').screenshot({ path: `${evidence}/whats-new-feature-default.png`, animations: 'disabled' });
      await page.locator('.measurement-details > summary').click();
      await page.locator('.results-more > summary').click();
      const explanations = await page.locator('.feature-details > summary').all();
      for (const summary of explanations) {
        const position = () => summary.evaluate(node => {
          const row = node.closest('.feature');
          return row?.classList.contains('feature-secondary') ? {
            headingWidth: row.querySelector('h3').getBoundingClientRect().width,
            summaryTop: node.getBoundingClientRect().top + scrollY,
          } : null;
        });
        const before = await position();
        await summary.click();
        if (before) assert.deepEqual(await position(), before, 'technical notes open without rewrapping their heading or moving the disclosure');
      }
      assert.equal(await page.locator('.feature-details[open]').count(), explanations.length);
      assert.equal(await page.locator('.feature-secondary > .plate').count(), 0, 'technical notes do not add a second illustration hierarchy');
      await captureLongPage(page, 'whats-new-expanded-desktop');
      await page.locator('article[aria-labelledby="f-storage"]').screenshot({ path: `${evidence}/whats-new-feature-expanded.png`, animations: 'disabled' });
    });

    // Settings opens in the same tab.
    await withPage(browser, base, {}, async (page) => {
      const pages = page.context().pages().length;
      await Promise.all([page.waitForURL(`${base}/workspace.html#/settings`), page.click('.closing a.button')]);
      assert.equal(page.context().pages().length, pages);
    });

    // The setup guide link opens the welcome route in the same tab.
    await withPage(browser, base, {}, async (page) => {
      await Promise.all([page.waitForURL(`${base}/workspace.html#/welcome`), page.click('a[href="workspace.html#/welcome"]')]);
    });

    // Measured results: selected wins first, the full results closed until
    // asked for, and bars drawn to scale from zero.
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.$eval('.full-results', (details) => details.open), false);
      assert.equal(await page.$eval('.measurement-details', details => details.open), false);
      await page.screenshot({ path: `${evidence}/whats-new-results-collapsed.png`, clip: await page.$eval('.results', node => ({ x: 0, y: node.getBoundingClientRect().top + scrollY, width: 1440, height: node.getBoundingClientRect().height })), fullPage: true });
      await page.locator('.measurement-details > summary').click();
      assert.deepEqual(await page.$$eval('.results .reading h3, .results .reading h4', (nodes) => nodes.map((node) => node.id)), ['r-first-load', 'r-saved-records', 'r-new-tab', 'r-relaunch']);
      const [candidate, previous] = await page.$$eval('#r-first-load ~ * .bar-mark rect, .reading:first-child .bar-mark rect', (rects) => rects.slice(0, 2).map((rect) => rect.getBoundingClientRect().width));
      assert.ok(Math.abs(candidate / previous - 262.21 / 717.402) < 0.01, `bar ratio ${candidate / previous}`);
      assert.equal(await page.$$eval('.results .bar', (bars) => bars.every((bar) => bar.querySelector('.bar-name').textContent && /\d\u00a0ms$/.test(bar.querySelector('.bar-value').textContent))), true);
      for (const selector of ['.results h2', '.results-lede', '.results-lede a', '.reading h4', '.reading-copy p', '.bar-name', '.bar-value', '.bars-caption', '.results-method', '.full-results summary']) {
        const ratio = await contrast(page, selector);
        assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)}`);
      }
      await page.screenshot({ path: `${evidence}/whats-new-results.png`, clip: await page.$eval('.results', (node) => { const box = node.getBoundingClientRect(); return { x: 0, y: box.top + scrollY, width: 1440, height: box.height }; }), fullPage: true });
      await page.locator('.results-more > summary').click();
      await page.screenshot({ path: `${evidence}/whats-new-results-expanded.png`, clip: await page.$eval('.results', node => ({ x: 0, y: node.getBoundingClientRect().top + scrollY, width: 1440, height: node.getBoundingClientRect().height })), fullPage: true });

      // "See the full results" opens the details and lands on the table.
      await page.click('.results-lede a');
      await page.waitForFunction(() => document.querySelector('.full-results').open);
      assert.equal(await page.$$eval('.results-table:not(.component-table) tbody tr:not(.table-group)', (rows) => rows.length), 11);
      assert.equal(await page.$$eval('.results-table td.unavailable', (cells) => cells.map((cell) => cell.textContent).join()), 'Unavailable,Unavailable');
      for (const selector of ['.results-table caption', '.measure-note', '.range', '.results-table .verdict', '.results-table .unavailable', '.full-results > p', '.results-limits li']) {
        const ratio = await contrast(page, selector);
        assert.ok(ratio >= 4.5, `${selector} contrast ${ratio.toFixed(2)}`);
      }
      assert.equal(await page.$eval('.table-scroll', (region) => region.scrollWidth <= region.clientWidth), true, 'the full table fits on desktop');
      await page.screenshot({ path: `${evidence}/whats-new-results-full.png`, clip: await page.$eval('.full-results', (node) => { const box = node.getBoundingClientRect(); return { x: 0, y: box.top + scrollY, width: 1440, height: box.height }; }), fullPage: true });

      // The summary is a keyboard control with a visible ring.
      await page.focus('.results-article .button');
      await page.keyboard.press('Tab');
      assert.equal(await page.evaluate(() => document.activeElement.tagName), 'SUMMARY');
      assert.equal(await page.$eval('.full-results summary', (node) => getComputedStyle(node).outlineStyle), 'solid');
      await page.keyboard.press('Enter');
      assert.equal(await page.$eval('.full-results', (details) => details.open), false);
    });

    // Forced colors: bars switch to system colors instead of brand fills.
    await withPage(browser, base, { forcedColors: 'active' }, async (page) => {
      assert.notEqual(await page.$eval('.bar.chrome rect', (rect) => getComputedStyle(rect).fill), 'rgb(184, 131, 76)');
      assert.notEqual(await page.$eval('.bar.candidate rect', (rect) => getComputedStyle(rect).fill), 'rgb(29, 84, 88)');
    });

    // Motion: the breeze draws once unless reduced motion is requested.
    await withPage(browser, base, { reducedMotion: 'no-preference' }, async (page) => {
      assert.equal(await page.$eval('.breeze-line', (line) => getComputedStyle(line).animationName), 'breeze');
      assert.equal(await page.$eval('.breeze-line', (line) => getComputedStyle(line).animationIterationCount), '1');
    });
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.$eval('.breeze-line', (line) => getComputedStyle(line).animationName), 'none');
      assert.equal(await page.$eval('.breeze-line', (line) => getComputedStyle(line).strokeDashoffset), '0px');
    });

    await withPage(browser, base, { viewport: { width: 390, height: 844 } }, async (page) => {
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true);
      const stacked = await page.$$eval('.feature:not(.feature-secondary)', (rows) => rows.map((row) => row.querySelector('.feature-copy').getBoundingClientRect().top > row.querySelector('.plate').getBoundingClientRect().bottom));
      assert.deepEqual(stacked, [true, true, true, true, true, true, true], 'every primary feature stacks plate above text');
      assert.equal(await page.$$eval('.plate, .pending, .feature-copy .button', (nodes) => nodes.every((node) => node.getBoundingClientRect().right <= 390)), true);
      // Every comparison remains visible in the narrow card layout.
      await page.locator('.measurement-details > summary').click();
      await page.click('.full-results summary');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= 390), true, 'open full results stay within 390px');
      assert.equal(await page.$$eval('.reading, .full-results, .component-table, .results-article .button', (nodes) => nodes.every((node) => node.getBoundingClientRect().right <= 390)), true);
      assert.equal(await page.$eval('.table-scroll', (region) => region.scrollWidth <= region.clientWidth), true, 'all comparison columns fit without sideways scrolling');
      assert.equal(await page.$$eval('.results-table tbody td', cells => cells.every(cell => { const box = cell.getBoundingClientRect(); return box.left >= 0 && box.right <= innerWidth && cell.scrollWidth <= cell.clientWidth; })), true, 'all values and ranges are readable inside the window');
      const tableCrop = await page.evaluate(() => ({ offsetY: Math.round(document.querySelector('.full-results').getBoundingClientRect().top - document.querySelector('.results').getBoundingClientRect().top), width: 390, height: 900 }));
      await writeFile(`${evidence}/whats-new-table-crop.json`, JSON.stringify(tableCrop));
      await page.screenshot({ path: `${evidence}/whats-new-table-narrow.png`, clip: await page.$eval('.full-results', node => ({ x: 0, y: node.getBoundingClientRect().top + scrollY, width: 390, height: 900 })), fullPage: true });
      await page.screenshot({ path: `${evidence}/whats-new-results-narrow.png`, clip: await page.$eval('.results', (node) => { const box = node.getBoundingClientRect(); return { x: 0, y: box.top + scrollY, width: 390, height: box.height }; }), fullPage: true });
      await page.click('.full-results summary');
      await page.locator('.measurement-details > summary').click();
      await page.evaluate(() => scrollTo(0, 0));
      await page.screenshot({ path: `${evidence}/whats-new-narrow.png` });
      await captureLongPage(page, 'whats-new-narrow');
      await captureFeatureDetails(page, 'narrow');
      const limits = await page.evaluate(() => {
        const group = document.querySelector('.verification-group');
        const rows = [...document.querySelectorAll('.pending')];
        const top = (group || rows[0]).getBoundingClientRect().top + scrollY;
        const bottom = (group || rows.at(-1)).getBoundingClientRect().bottom + scrollY;
        return { x: 0, y: top, width: innerWidth, height: bottom - top };
      });
      await page.screenshot({ path: `${evidence}/whats-new-limitations-narrow.png`, clip: limits, fullPage: true });
    });

    // The linked reference article is part of the app's rendered UI too.
    for (const [name, options] of [['desktop', {}], ['narrow', { viewport: { width: 390, height: 844 } }], ['dark', { colorScheme: 'dark' }]]) {
      await withPage(browser, base, options, async page => {
        await page.goto(`${base}/efficiency.html`);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${name} reference article stays contained`);
        assert.ok(await contrast(page, '.benchmark-story-body p') >= 4.5, `${name} reference article contrast`);
        const footerGap = await page.locator('.benchmark-story-footer').evaluate(footer => { const [first, second] = [...footer.querySelectorAll('a')].map(node => node.getBoundingClientRect()); return second.top > first.top + 4 ? second.top - first.bottom : second.left - first.right; });
        assert.ok(footerGap >= 12, `${name} footer actions have separate targets`);
        await page.screenshot({ path: `${evidence}/efficiency-${name}.png` });
        if (name !== 'dark') {
          await captureLongPage(page, `efficiency-${name}`);
          await page.locator('.benchmark-story-note').screenshot({ path: `${evidence}/efficiency-method-${name}.png`, animations: 'disabled' });
          await page.locator('.story-table:not(.story-code-table)').screenshot({ path: `${evidence}/efficiency-browser-table-${name}.png`, animations: 'disabled' });
          await page.getByRole('heading', { name: 'Saved tabs', exact: true }).evaluate(node => { node.scrollIntoView({ block: 'start' }); scrollBy(0, -16); });
          const savedTabs = await page.evaluate(() => {
            const headings = [...document.querySelectorAll('.benchmark-story-heading')];
            const range = document.createRange();
            range.setStartBefore(headings.find(node => node.textContent === 'Saved tabs'));
            range.setEndBefore(headings.find(node => node.textContent === 'Less idle work'));
            return range.getBoundingClientRect().toJSON();
          });
          assert.ok(savedTabs.top >= 0 && savedTabs.bottom <= await page.evaluate(() => innerHeight), `${name} saved-tab explanation fits its capture: ${JSON.stringify(savedTabs)}`);
          await page.screenshot({ path: `${evidence}/efficiency-saved-tabs-${name}.png`, clip: savedTabs, animations: 'disabled' });
          if (name === 'narrow') {
            await page.setViewportSize({ width: 320, height: 844 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, '320px reference article stays contained');
            await page.locator('.story-table:not(.story-code-table)').screenshot({ path: `${evidence}/efficiency-browser-table-320.png`, animations: 'disabled' });
            await page.locator('.story-code-table').screenshot({ path: `${evidence}/efficiency-code-table-320.png`, animations: 'disabled' });
            await page.setViewportSize({ width: 390, height: 844 });
          }
        }
        await page.getByRole('link', { name: 'Full benchmark results', exact: true }).click();
        await page.locator('.results-table').first().waitFor();
        assert.equal(await page.locator('.measurement-details').evaluate(node => node.open), true);
        assert.equal(await page.locator('.full-results').evaluate(node => node.open), true);
      });
    }

    // Not in a tab, or the tabs API fails: fall back to window.close(); if
    // that does nothing, say how to leave.
    await withPage(browser, base, { tabs: 'failing' }, async (page) => {
      await page.click('.closing [data-action="continue"]');
      await page.waitForSelector('#close-hint', { state: 'visible' });
      assert.deepEqual(await page.evaluate(() => window.fx), { removed: [], closed: 1 });
      assert.equal(await page.isEnabled('.closing [data-action="continue"]'), true);
      await page.screenshot({ path: `${evidence}/whats-new-close-refused.png`, fullPage: true });
    });
    await withPage(browser, base, { tabs: 'none' }, async (page) => {
      await page.click('.masthead [data-action="continue"]');
      await page.waitForFunction(() => window.fx.closed === 1);
    });

    // Missing or hostile release info falls back to the plain name as text.
    server.setRelease(null);
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.textContent('#release-name'), 'Breezer');
      assert.equal(await page.title(), 'What\'s new in Breezer');
    });
    server.setRelease(releaseInfo('<img src=x onerror=alert(1)>'));
    await withPage(browser, base, {}, async (page) => {
      assert.equal(await page.textContent('#release-name'), 'Breezer');
      assert.equal(await page.$$eval('.release img', (images) => images.length), 1);
    });
  } finally {
    try { await browser?.close(); } finally {
      await new Promise(done => server.close(done));
    }
  }
});
