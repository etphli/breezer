import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PNG } from 'pngjs';
import { NOW, CONNECTED, installFixture } from './newtab-browser-fixture.mjs';

// Drives AI theme proposal cards and the new-tab artwork in a real browser.
// Artwork here is synthetic; the hostile sample tries every fetch and script
// route we know of and the server records any request that gets through.
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../features/ai/extension');
const evidence = process.env.BREEZER_AI_EVIDENCE || '/tmp/breezer-ai-evidence';
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
let chromium = null;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch { /* reported by skip below */ }
const skip = !chromium ? 'playwright is not installed' : (executablePath && !existsSync(executablePath) ? `no browser at ${executablePath}` : false);
const EXTENSION_CSP = "script-src 'self'; object-src 'none'";

export const AURORA = `
<style>
  .sky { position: absolute; inset: 0; background: linear-gradient(160deg, #0c1b33, #1d3557 45%, #274c77); }
  .band { position: absolute; left: -20%; width: 140%; height: 38%; border-radius: 50%; filter: blur(38px); opacity: .7; animation: sway 14s ease-in-out infinite alternate; }
  .band.one { top: 8%; background: radial-gradient(closest-side, #5eead4, transparent); }
  .band.two { top: 24%; background: radial-gradient(closest-side, #a78bfa, transparent); animation-duration: 19s; }
  @keyframes sway { from { transform: translateX(-6%) rotate(-4deg); } to { transform: translateX(6%) rotate(3deg); } }
</style>
<div class="sky"></div><div class="band one"></div><div class="band two"></div>
<svg viewBox="0 0 1200 400" preserveAspectRatio="none" style="position:absolute;bottom:0;width:100%;height:34%">
  <style>.svg-star { fill: #ebefff; animation: sway 14s infinite alternate; }</style>
  <circle class="svg-star" cx="750" cy="95" r="8"/>
  <defs><linearGradient id="ridge" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0b2545"/><stop offset="1" stop-color="#13315c"/></linearGradient></defs>
  <path d="M0 260 L160 170 L300 240 L470 120 L640 230 L820 150 L1000 250 L1200 180 L1200 400 L0 400 Z" fill="url(#ridge)"/>
</svg>`;

const hostile = (base) => `
<img src="${base}/leak/img" onerror="parent.postMessage('xss','*')">
<link rel="stylesheet" href="${base}/leak/link">
<iframe src="${base}/leak/iframe"></iframe>
<video src="${base}/leak/video"></video>
<script>fetch('${base}/leak/script')</script>
<style>@import url(${base}/leak/import); .x { background: url(${base}/leak/css); } @font-face { font-family: z; src: url(${base}/leak/font); } .t::before { content: "Enter your password"; }</style>
<a href="${base}/leak/nav">Click to continue</a>
<form action="${base}/leak/form"><input name="password"><button>Sign in</button></form>
<svg onload="alert(1)"><style>@import url(${base}/leak/svg-style);</style><image href="${base}/leak/svg-image"/><use href="${base}/leak/use#x"/><foreignObject><div>Fake button</div></foreignObject>
  <animate attributeName="href" to="javascript:alert(1)"/><circle cx="5" cy="5" r="4" fill="#123456" style="fill:url(${base}/leak/fill)"/></svg>
<div class="x t" style="background-image:url(${base}/leak/inline)">Untrusted words</div>`;

async function startServer() {
  const leaks = [];
  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url, 'http://localhost');
      if (url.pathname.startsWith('/leak/')) { leaks.push(url.pathname); response.writeHead(204).end(); return; }
      if (url.pathname === '/favicon.ico' || url.pathname === '/_favicon/') { response.writeHead(204).end(); return; }
      if (url.pathname === '/_theme/card.html') {
        response.setHeader('Content-Type', 'text/html');
        response.setHeader('Content-Security-Policy', EXTENSION_CSP);
        response.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Theme card</title><link rel="stylesheet" href="/panel.css">
<style>body{padding:16px;width:380px}.header{display:flex;align-items:center;gap:8px;margin-bottom:8px}#header-status{color:var(--muted);font-size:12px}</style></head>
<body><div class="header"><strong>Breezer</strong><span id="header-actions"></span><span id="header-status" role="status"></span></div><div id="thread"></div><script type="module" src="/_theme/card.js"></script></body></html>`);
        return;
      }
      const path = url.pathname === '/_theme/card.js' ? resolve(here, 'browser-theme-fixture.js') : resolve(root, `.${url.pathname}`);
      if (path !== resolve(here, 'browser-theme-fixture.js') && !path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
      const content = await readFile(path);
      response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' })[extname(path)] || 'application/octet-stream');
      if (extname(path) === '.html') response.setHeader('Content-Security-Policy', EXTENSION_CSP);
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, leaks };
}

test('theme proposal cards apply, restore and paint sandboxed artwork on the new tab', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const { server, leaks } = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'light', reducedMotion: 'no-preference', locale: 'en-US' });
    const proposals = [
      { name: 'Northern lights', theme: '#274C77', colorMode: 'dark', html: AURORA },
      { name: 'Probe', theme: '#7c3aed', colorMode: 'light', html: hostile(base) },
    ];
    await context.addInitScript((list) => { window.proposals = list; }, proposals);
    const errors = [];
    const card = await context.newPage();
    card.on('pageerror', (error) => errors.push(error.message));
    card.on('dialog', (dialog) => { errors.push(`dialog ${dialog.message()}`); void dialog.dismiss(); });
    await card.goto(`${base}/_theme/card.html`);
    await card.evaluate(() => window.ready);
    await card.waitForTimeout(500);

    // The frame is opaque, script-free and inert; the parent cannot reach into it.
    const frames = await card.$$eval('iframe.theme-proposal-art', (nodes) => nodes.map((frame) => ({
      sandbox: frame.getAttribute('sandbox'), inert: frame.inert, hidden: frame.getAttribute('aria-hidden'),
      tab: frame.tabIndex, pointer: getComputedStyle(frame).pointerEvents, reachable: (() => { try { return Boolean(frame.contentDocument); } catch { return false; } })(),
      srcdoc: frame.srcdoc,
    })));
    assert.equal(frames.length, 2);
    for (const frame of frames) {
      assert.equal(frame.sandbox, '');
      assert.equal(frame.inert, true);
      assert.equal(frame.hidden, 'true');
      assert.equal(frame.tab, -1);
      assert.equal(frame.pointer, 'none');
      assert.equal(frame.reachable, false);
      assert.ok(frame.srcdoc.indexOf("default-src 'none'") < frame.srcdoc.indexOf('<body>'));
    }
    const probe = frames[1].srcdoc.slice(frames[1].srcdoc.indexOf('<body>'));
    assert.doesNotMatch(probe, /leak|<img|<link|<iframe|<video|<script|<a |<form|<input|<button|<image|<use|<foreignObject|<animate|onload|onerror|password|Sign in|Untrusted words|Fake button|Click to continue/i);
    assert.match(probe, /<circle cx="5" cy="5" r="4" fill="#123456"/, 'harmless graphics survive');
    assert.match(frames[0].srcdoc, /@keyframes sway/);
    assert.match(frames[0].srcdoc, /fill="url\(#ridge\)"/);
    const svgStar = card.frameLocator('iframe.theme-proposal-art').first().locator('.svg-star');
    assert.deepEqual(await svgStar.evaluate(node => {
      const { fill, animationName } = getComputedStyle(node);
      return { fill, animationName };
    }), { fill: 'rgb(235, 239, 255)', animationName: 'sway' });

    const first = card.locator('.theme-proposal').first();
    assert.equal(await card.locator('.theme-restore-button').isHidden(), true, 'nothing to restore yet');
    await card.screenshot({ path: `${evidence}/theme-proposal-cards.png`, fullPage: true });

    const tab = await context.newPage();
    tab.on('pageerror', (error) => errors.push(error.message));
    await tab.setViewportSize({ width: 1280, height: 800 });
    // Playwright injects init scripts into every frame, the sandboxed art frames included; the fixture belongs to the page only.
    await tab.addInitScript({ content: `if (window === window.top) (${installFixture})(${JSON.stringify({ view: CONNECTED, appearance: { theme: '#274c77', colorMode: 'dark' } })});` });
    await tab.clock.setFixedTime(NOW);
    await tab.goto(`${base}/newtab.html`);
    await tab.waitForSelector('html[data-loaded="true"]');
    assert.equal(await tab.locator('iframe.theme-artwork').count(), 0, 'no artwork before Apply');

    await first.getByRole('button', { name: 'Apply theme' }).click();
    await first.getByText('Applied “Northern lights”.').waitFor();
    assert.deepEqual(await card.evaluate(() => window.bridgeCalls), [{ theme: '#274c77', colorMode: 'dark', expectedThemeState: { theme: 'tide', colorMode: 'light' } }]);
    assert.equal(await first.getByRole('button', { name: 'Applied' }).isDisabled(), true);
    await card.locator('.theme-restore-button').waitFor({ state: 'visible' });
    await card.screenshot({ path: `${evidence}/theme-proposal-applied.png`, fullPage: true });

    // The open new tab follows the apply and keeps content above the art.
    await tab.waitForSelector('html[data-artwork="on"] iframe.theme-artwork');
    const layering = await tab.evaluate(() => {
      const frame = document.querySelector('iframe.theme-artwork');
      const sites = document.querySelector('.site-link').getBoundingClientRect();
      const hit = document.elementFromPoint(sites.x + sites.width / 2, sites.y + sites.height / 2);
      return { first: document.body.firstElementChild === frame, hit: Boolean(hit?.closest('.site-link')), sandbox: frame.getAttribute('sandbox') };
    });
    assert.deepEqual(layering, { first: true, hit: true, sandbox: '' });
    await tab.waitForTimeout(400);
    await tab.screenshot({ path: `${evidence}/theme-newtab-artwork.png` });

    // Persisted across reloads.
    await tab.reload();
    await tab.waitForSelector('html[data-artwork="on"] iframe.theme-artwork');

    // Restore from the header, outside the conversation.
    await card.locator('.theme-restore-button').click();
    await card.getByText('Restored your previous look.').waitFor();
    assert.deepEqual(await card.evaluate(() => window.bridgeCalls.at(-1)), { theme: 'tide', colorMode: 'light', expectedThemeState: { theme: '#274c77', colorMode: 'dark' } });
    await tab.waitForFunction(() => !document.querySelector('iframe.theme-artwork') && !document.documentElement.dataset.artwork);
    await card.locator('.theme-restore-button').waitFor({ state: 'hidden' });
    assert.equal(await first.getByRole('button', { name: 'Apply theme' }).isEnabled(), true);

    // Applying the hostile proposal still fetches nothing anywhere.
    const probeCard = card.locator('.theme-proposal').nth(1);
    await probeCard.getByRole('button', { name: 'Apply theme' }).click();
    await probeCard.getByText('Applied “Probe”.').waitFor();
    await tab.waitForSelector('iframe.theme-artwork');
    await tab.waitForTimeout(800);
    assert.deepEqual(leaks, []);
    assert.deepEqual(errors, []);

    const expanded = await card.evaluate(async () => {
      const { applyThemeProposal, readThemeState } = await import('/browser-theme.js');
      const html = '<svg>' + '<rect width="1" height="1" fill="#123456"/>'.repeat(900) + '</svg>';
      await applyThemeProposal({ name: 'Tiles', theme: '#17304f', colorMode: 'dark', html });
      return { inputLength: html.length, storedLength: (await readThemeState()).applied.html.length };
    });
    assert.ok(expanded.inputLength < 40000 && expanded.storedLength > 40000, 'SVG serialization can exceed the proposal input limit');
    await tab.frameLocator('iframe.theme-artwork').locator('rect').last().waitFor({ state: 'attached' });
    assert.equal(await tab.frameLocator('iframe.theme-artwork').locator('rect').count(), 900);

    // Sanitizing can lengthen CSS past the 40k proposal limit; every stored rule
    // must survive the re-sanitization on each read, including after a reload.
    const css = await card.evaluate(async () => {
      const { applyThemeProposal, readThemeState } = await import('/browser-theme.js');
      const html = `<style>${'.c::before{content:x}'.repeat(1880)}.last{position:absolute;inset:0;background:rgb(1, 2, 3)}</style><div class="last"></div>`;
      await applyThemeProposal({ name: 'Long', theme: '#17304f', colorMode: 'dark', html });
      const stored = (await readThemeState()).applied.html;
      return { inputLength: html.length, storedLength: stored.length, keepsLast: stored.includes('.last{') };
    });
    assert.ok(css.inputLength <= 40000 && css.storedLength > 40000 && css.keepsLast, JSON.stringify(css));
    const lastRule = () => tab.frameLocator('iframe.theme-artwork').locator('div.last').evaluate((node) => getComputedStyle(node).backgroundColor);
    await tab.frameLocator('iframe.theme-artwork').locator('div.last').waitFor({ state: 'attached' });
    assert.equal(await lastRule(), 'rgb(1, 2, 3)');
    await tab.reload();
    await tab.frameLocator('iframe.theme-artwork').locator('div.last').waitFor({ state: 'attached' });
    assert.equal(await lastRule(), 'rgb(1, 2, 3)', 'the reloaded tab still applies the last rule');
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});

// A synthetic stand-in for a photo the person pasted: a harbour at dusk whose
// water has 1px light and dark rows, so blurring or rescaling shows in pixels.
async function harbourImage(browser) {
  const page = await browser.newPage();
  try {
    return await page.evaluate(async () => {
      const canvas = new OffscreenCanvas(1280, 800);
      const g = canvas.getContext('2d');
      const sky = g.createLinearGradient(0, 0, 0, 520);
      sky.addColorStop(0, '#1d2b53'); sky.addColorStop(0.5, '#5d4e8c'); sky.addColorStop(1, '#f0b67f');
      g.fillStyle = sky; g.fillRect(0, 0, 1280, 520);
      const glow = g.createRadialGradient(930, 470, 10, 930, 470, 260);
      glow.addColorStop(0, 'rgba(255, 228, 181, .95)'); glow.addColorStop(1, 'rgba(255, 228, 181, 0)');
      g.fillStyle = glow; g.fillRect(600, 200, 680, 330);
      g.fillStyle = '#ffe9c4'; g.beginPath(); g.arc(930, 478, 54, 0, Math.PI * 2); g.fill();
      g.fillStyle = '#3b335f';
      g.beginPath(); g.moveTo(0, 430); g.lineTo(180, 360); g.lineTo(330, 420); g.lineTo(520, 330); g.lineTo(700, 450); g.lineTo(700, 520); g.lineTo(0, 520); g.fill();
      g.fillStyle = '#231f3d';
      g.beginPath(); g.moveTo(0, 520); g.lineTo(0, 470); g.lineTo(240, 440); g.lineTo(460, 480); g.lineTo(1280, 500); g.lineTo(1280, 520); g.fill();
      const water = g.createLinearGradient(0, 520, 0, 800);
      water.addColorStop(0, '#2c3566'); water.addColorStop(1, '#0f1530');
      g.fillStyle = water; g.fillRect(0, 520, 1280, 280);
      for (let y = 524; y < 800; y += 2) {
        g.fillStyle = 'rgba(214, 200, 255, .55)';
        g.fillRect(0, y, 1280, 1);
        const spread = 60 + (y - 520) * 0.9;
        g.fillStyle = `rgba(255, 220, 170, ${Math.max(0.25, 0.95 - (y - 520) / 420)})`;
        g.fillRect(930 - spread, y, spread * 2, 1);
      }
      const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.95 });
      return new Promise((done) => { const reader = new FileReader(); reader.onload = () => done(reader.result); reader.readAsDataURL(blob); });
    });
  } finally {
    await page.close();
  }
}

// A light layer of drifting mist: the artwork draws over the image, not instead of it.
const MIST = `
<style>
  .mist { position: absolute; left: -10%; width: 120%; height: 18%; border-radius: 50%; filter: blur(30px); opacity: .35; background: #f8e7ff; animation: drift 22s ease-in-out infinite alternate; }
  .mist.one { top: 14%; } .mist.two { top: 32%; opacity: .22; animation-duration: 30s; }
  @keyframes drift { from { transform: translateX(-4%); } to { transform: translateX(4%); } }
</style>
<div class="mist one"></div><div class="mist two"></div>`;

// Mean luminance step between neighbouring rows of a screenshot region.
function rowContrast(png, { x0, x1, y0, y1 }) {
  const { data, width } = PNG.sync.read(png);
  const lum = (x, y) => { const i = (y * width + x) * 4; return 0.2126 * data[i] + 0.7152 * data[i + 1] + 0.0722 * data[i + 2]; };
  let sum = 0;
  let count = 0;
  for (let y = y0; y < y1; y += 1) for (let x = x0; x < x1; x += 1) { sum += Math.abs(lum(x, y) - lum(x, y + 1)); count += 1; }
  return sum / count;
}

async function openPages(browser, base, proposals, appearance = { theme: '#3b6e8f', colorMode: 'light' }) {
  const context = await browser.newContext({ viewport: { width: 420, height: 900 }, colorScheme: 'light', reducedMotion: 'no-preference', locale: 'en-US' });
  await context.addInitScript((list) => { window.proposals = list; }, proposals);
  const errors = [];
  const card = await context.newPage();
  card.on('pageerror', (error) => errors.push(error.message));
  await card.goto(`${base}/_theme/card.html`);
  await card.evaluate(() => window.ready);
  const tab = await context.newPage();
  tab.on('pageerror', (error) => errors.push(error.message));
  await tab.setViewportSize({ width: 1280, height: 800 });
  await tab.addInitScript({ content: `if (window === window.top) (${installFixture})(${JSON.stringify({ view: CONNECTED, appearance })});` });
  await tab.clock.setFixedTime(NOW);
  await tab.goto(`${base}/newtab.html`);
  await tab.waitForSelector('html[data-loaded="true"]');
  return { context, card, tab, errors };
}

test('a pasted image paints crisply behind the artwork in the preview and the new tab', { skip }, async () => {
  await mkdir(evidence, { recursive: true });
  const { server, leaks } = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const image = await harbourImage(browser);
    assert.ok(image.startsWith('data:image/jpeg;base64,') && image.length <= 700000, `image is ${image.length} characters`);
    const { context, card, tab, errors } = await openPages(browser, base, [
      { name: 'Harbour at dusk', theme: '#5d4e8c', colorMode: 'light', image, html: MIST },
      { name: 'Harbour, image only', theme: '#5d4e8c', colorMode: 'dark', image },
    ]);

    // The preview shows the image under the artwork frame, and the sketch on top.
    const first = card.locator('.theme-proposal').first();
    const stage = await first.locator('.theme-proposal-stage').evaluate((node) => [...node.children].map((child) => ({
      tag: child.localName, className: child.className, fit: getComputedStyle(child).objectFit,
      loaded: child.localName === 'img' ? child.complete && child.naturalWidth === 1280 : undefined,
    })));
    assert.deepEqual(stage.map(({ className }) => className), ['theme-proposal-image', 'theme-proposal-art', 'theme-proposal-sketch']);
    assert.equal(stage[0].fit, 'cover');
    assert.equal(stage[0].loaded, true);
    assert.match(await first.locator('.theme-proposal-meta').textContent(), /with your image and background art/);
    assert.match(await card.locator('.theme-proposal').nth(1).locator('.theme-proposal-meta').textContent(), /with your image$/);
    await card.waitForTimeout(300);
    await card.screenshot({ path: `${evidence}/theme-proposal-image.png`, fullPage: true });

    await first.getByRole('button', { name: 'Apply theme' }).click();
    await first.getByText('Applied “Harbour at dusk”.').waitFor();
    assert.deepEqual(await card.evaluate(() => window.bridgeCalls.at(-1)), { theme: '#5d4e8c', colorMode: 'light', expectedThemeState: { theme: 'tide', colorMode: 'light' } });

    const check = async () => {
      await tab.waitForSelector('html[data-artwork="on"][data-theme-image="on"] img.theme-image');
      await tab.waitForFunction(() => document.querySelector('img.theme-image').complete);
      return tab.evaluate(() => {
        const picture = document.querySelector('img.theme-image');
        const frame = document.querySelector('iframe.theme-artwork');
        const style = getComputedStyle(picture);
        const box = picture.getBoundingClientRect();
        const sites = document.querySelector('.site-link').getBoundingClientRect();
        const hit = document.elementFromPoint(sites.x + sites.width / 2, sites.y + sites.height / 2);
        return {
          order: [...document.body.children].slice(0, 2).map((node) => node.className),
          natural: [picture.naturalWidth, picture.naturalHeight], box: [box.width, box.height],
          filter: style.filter, transform: style.transform, fit: style.objectFit, pointer: style.pointerEvents,
          src: picture.src.slice(0, 23), sandbox: frame.getAttribute('sandbox'), hit: Boolean(hit?.closest('.site-link')),
        };
      });
    };
    const expected = {
      order: ['theme-image', 'theme-artwork'], natural: [1280, 800], box: [1280, 800], filter: 'none', transform: 'none',
      fit: 'cover', pointer: 'none', src: 'data:image/jpeg;base64,', sandbox: '', hit: true,
    };
    assert.deepEqual(await check(), expected);
    await tab.waitForTimeout(400);
    const shot = await tab.screenshot({ path: `${evidence}/theme-newtab-image.png` });
    // The 1px ripple rows on the water, beside the sheet, still alternate light and dark on screen.
    const contrast = rowContrast(shot, { x0: 1212, x1: 1272, y0: 560, y1: 780 });
    assert.ok(contrast > 25, `reflection rows kept ${contrast.toFixed(1)} levels of contrast`);

    // Persisted across reloads.
    await tab.reload();
    assert.deepEqual(await check(), expected);

    // Switching to the image-only proposal keeps the image and drops the art layer.
    const second = card.locator('.theme-proposal').nth(1);
    await second.getByRole('button', { name: 'Apply theme' }).click();
    await second.getByText('Applied “Harbour, image only”.').waitFor();
    await tab.waitForFunction(() => !document.querySelector('iframe.theme-artwork') && document.querySelector('img.theme-image'));
    await tab.screenshot({ path: `${evidence}/theme-newtab-image-only.png` });

    // Restore returns to the look from before the first theme: no image.
    await card.locator('.theme-restore-button').click();
    await card.getByText('Restored your previous look.').waitFor();
    await tab.waitForFunction(() => !document.querySelector('img.theme-image') && !document.documentElement.dataset.artwork && !document.documentElement.dataset.themeImage);

    // A stored image that is not a raster data: URL is never shown.
    await card.evaluate(() => chrome.storage.local.set({ 'theme.artwork.v1': { name: 'x', theme: '#000000', colorMode: 'dark', image: 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=' } }));
    await tab.waitForTimeout(300);
    assert.equal(await tab.locator('img.theme-image').count(), 0);
    assert.deepEqual(leaks, []);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});

test('a failed save keeps a look picked meanwhile and repaints the page', { skip }, async () => {
  const { server } = await startServer();
  const base = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const { context, card, errors } = await openPages(browser, base, [{ name: 'Ember', theme: '#c2410c', colorMode: 'dark' }]);
    const first = card.locator('.theme-proposal').first();
    await card.waitForFunction(() => document.documentElement.dataset.tone === 'tide');

    // Settings picks Rose while the theme save is in flight; the save then fails.
    await card.evaluate(() => {
      window.themeFixture.failSave = 'artwork';
      window.themeFixture.beforeFail = () => window.themeFixture.setAppearance({ theme: 'rose', colorMode: 'dark' });
    });
    await first.getByRole('button', { name: 'Apply theme' }).click();
    await first.getByText('Couldn’t change the theme. Storage is full. Your newer browser colors were kept.').waitFor();
    const after = await card.evaluate(() => ({ appearance: window.themeFixture.appearance, last: window.bridgeCalls.at(-1), stored: JSON.parse(localStorage.getItem('shortcut-fixture') || '{}') }));
    assert.deepEqual(after.appearance, { theme: 'rose', colorMode: 'dark', themeCanRestore: true });
    assert.deepEqual(after.last, { theme: 'tide', colorMode: 'light', expectedThemeState: { theme: '#c2410c', colorMode: 'dark' } }, 'the rollback named the look it wrote');
    assert.deepEqual(Object.keys(after.stored), ['appearance.rev'], 'only the revision was written');
    await card.waitForFunction(() => document.documentElement.dataset.tone === 'rose' && document.documentElement.dataset.scheme === 'dark');
    assert.equal(await first.getByRole('button', { name: 'Apply theme' }).isEnabled(), true);
    assert.equal(await card.locator('.theme-restore-button').isHidden(), true);

    // With storage down entirely the page still repaints, from the refresh event and message.
    await card.evaluate(() => {
      window.themeFixture.failSave = 'all';
      window.themeFixture.beforeFail = () => window.themeFixture.setAppearance({ theme: 'graphite', colorMode: 'light' });
    });
    await first.getByRole('button', { name: 'Apply theme' }).click();
    await first.getByText('Couldn’t change the theme. Storage is full. Your newer browser colors were kept.').waitFor();
    await card.waitForFunction(() => document.documentElement.dataset.tone === 'graphite' && document.documentElement.dataset.scheme === 'light');
    assert.deepEqual(await card.evaluate(() => window.themeFixture.messages), [{ type: 'breezer.theme.refresh' }]);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser.close();
    server.close();
  }
});
