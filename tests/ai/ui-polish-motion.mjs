// Record real custom-UI motion and verify Reduce motion, using disposable fixtures.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { installFixture as workspaceFixture, seed } from './workspace-browser-fixture.mjs';
import { installFixture as settingsFixture } from './settings-browser-fixture.mjs';
import { installFixture as newtabFixture, CONNECTED, NOW } from './newtab-browser-fixture.mjs';
import { installPanelFixture } from './panel-browser-fixture.mjs';

const root = resolve('features/ai/extension');
const output = resolve(process.argv[2] || '/tmp/breezer-ui-motion');
assert.ok(process.argv[3] === undefined || process.argv[3] === '--decode-only', 'Optional mode is --decode-only');
const decodeOnly = process.argv[3] === '--decode-only';
await mkdir(output, { recursive: true });
const server = createServer(async (request, response) => {
  try {
    const path = resolve(root, `.${new URL(request.url, 'http://localhost').pathname}`);
    if (!path.startsWith(`${root}/`)) throw new Error('Outside fixture root');
    response.setHeader('Content-Type', ({ '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png' })[extname(path)] || 'application/octet-stream');
    response.end(await readFile(path));
  } catch { response.writeHead(404).end(); }
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined) });
const report = decodeOnly ? JSON.parse(await readFile(resolve(output, 'motion.json'), 'utf8')) : [];
try {
  if (!decodeOnly) for (const reducedMotion of ['no-preference', 'reduce']) for (const area of ['spaces', 'settings', 'newtab', 'onboarding', 'assistant', 'control']) {
    const viewport = area === 'spaces' ? { width: 280, height: 820 } : ['assistant', 'control'].includes(area) ? { width: 400, height: 850 } : { width: 1200, height: 900 };
    const context = await browser.newContext({ viewport, reducedMotion, recordVideo: { dir: resolve(output, '.recordings'), size: viewport } });
    const page = await context.newPage();
    const video = page.video();
    if (area === 'spaces') {
      await page.addInitScript(workspaceFixture, { seed: seed(), bridge: true });
      await page.goto(`${base}/workspace.html#/sidebar?w=7`);
      await page.getByRole('tab', { name: /Personal/ }).click();
    } else if (area === 'settings') {
      await page.addInitScript(settingsFixture, { theme: 'mint', colorMode: 'light' });
      await page.goto(`${base}/workspace.html#/settings`);
      await page.getByRole('heading', { name: 'Bring your Chrome data to Breezer' }).waitFor();
    } else if (area === 'newtab') {
      await page.addInitScript(newtabFixture, { view: CONNECTED, appearance: { theme: 'mint', colorMode: 'light' }, delay: 400 });
      await page.clock.setFixedTime(NOW);
      await page.goto(`${base}/newtab.html`);
      await page.locator('.organato[data-state="ready"]').waitFor();
    } else if (area === 'onboarding') {
      await page.addInitScript(settingsFixture, { theme: 'mint', colorMode: 'light' });
      await page.goto(`${base}/workspace.html#/welcome`);
      await page.locator('#wl-next').click();
      await page.locator('#wl-next').click();
      await page.locator('#wl-layout [data-value="top"]').click();
    } else {
      await page.addInitScript(installPanelFixture);
      await page.goto(`${base}/panel.html`);
      await page.getByRole('button', { name: /GPT-6.1 Sol/ }).waitFor();
      if (area === 'control') {
        await page.getByRole('button', { name: 'Browser control', exact: true }).hover();
        await page.getByRole('tooltip').waitFor({ state: 'visible' });
      } else {
        await page.getByRole('button', { name: 'Choose source tabs', exact: true }).click();
        await page.getByRole('dialog', { name: 'Source tabs', exact: true }).waitFor();
      }
    }
    const animations = await page.evaluate(() => document.getAnimations().map(animation => ({ name: animation.animationName || 'transition', ...animation.effect.getTiming() })));
    if (reducedMotion === 'reduce') assert.equal(animations.length, 0, `${area} respects Reduce motion`);
    for (const elapsed of [0, 100, 250, 500]) {
      if (elapsed) await page.waitForTimeout(elapsed === 100 ? 100 : elapsed === 250 ? 150 : 250);
      await page.screenshot({ path: resolve(output, `${area}-${reducedMotion}-${elapsed}.png`) });
    }
    await page.waitForTimeout(1000);
    await context.close();
    await video.saveAs(resolve(output, `${area}-${reducedMotion}.webm`));
    report.push({ area, reducedMotion, animations, note: 'Frame timestamps are elapsed after locator settlement, not animation onset. Setup depicts an illustration, not native tabs. Control records the assistant tooltip; it executes no browser actions.' });
  }
  // Export visible UI samples; the original recordings retain their lead-in.
  // The video clock does not establish input latency.
  const decoder = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  for (const entry of report) {
    const name = `${entry.area}-${entry.reducedMotion}`;
    const video = await readFile(resolve(output, `${name}.webm`));
    await decoder.setContent(`<video muted preload="auto" src="data:video/webm;base64,${video.toString('base64')}"></video>`);
    await decoder.waitForFunction(() => document.querySelector('video').readyState >= 2);
    const times = [0, 50, 100, 150, 200, 250, 300, 400, 500, 600, 800, 1000];
    const decoded = await decoder.evaluate(async times => {
      const video = document.querySelector('video'), canvas = document.createElement('canvas');
      canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d'), frames = [];
      const seek = async ms => {
        const target = Math.max(.001, ms / 1000);
        if (Math.abs(video.currentTime - target) < .0001) return;
        await new Promise(done => { video.addEventListener('seeked', done, { once: true }); video.currentTime = target; });
      };
      const preview = document.createElement('canvas');
      preview.width = preview.height = 64;
      const previewContext = preview.getContext('2d');
      let originMs;
      for (let ms = 0; ms <= 5000; ms += 40) {
        await seek(ms);
        previewContext.drawImage(video, 0, 0, 64, 64);
        const pixels = previewContext.getImageData(0, 0, 64, 64).data;
        let sum = 0, squares = 0, horizontalEdges = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const luminance = .2126 * pixels[i] + .7152 * pixels[i + 1] + .0722 * pixels[i + 2];
          sum += luminance; squares += luminance * luminance;
          if ((i / 4) % 64) {
            const previous = .2126 * pixels[i - 4] + .7152 * pixels[i - 3] + .0722 * pixels[i - 2];
            if (Math.abs(luminance - previous) > 6) horizontalEdges++;
          }
        }
        // Blank recording lead-ins can have white and gray horizontal bands.
        // Text and controls also produce edges across columns.
        if (squares / 4096 - (sum / 4096) ** 2 > 1 && horizontalEdges >= 16) { originMs = ms; break; }
      }
      if (originMs === undefined) throw new Error('Recording has no visible UI in its first five seconds');
      for (const ms of times) {
        await seek(originMs + ms);
        context.drawImage(video, 0, 0);
        frames.push(canvas.toDataURL('image/png').split(',')[1]);
      }
      return { frames, originMs };
    }, times);
    for (let i = 0; i < times.length; i++) await writeFile(resolve(output, `${name}-video-${times[i]}.png`), Buffer.from(decoded.frames[i], 'base64'));
    const html = `<!doctype html><style>body{margin:0;font:14px system-ui;background:#f4f4f4;color:#222}main{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;padding:12px}figure{margin:0}img{width:100%;display:block}figcaption{padding:6px 0}</style><h2>${entry.area} · ${entry.reducedMotion}</h2><p>Actual recording frames, relative to the first visible UI frame. The original video retains its lead-in.</p><main>${times.map(ms => `<figure><figcaption>${ms} ms</figcaption><img src="${name}-video-${ms}.png"></figure>`).join('')}</main>`;
    const sheet = resolve(output, `sheet-${name}.html`);
    await writeFile(sheet, html);
    await decoder.goto(pathToFileURL(sheet).href);
    await decoder.screenshot({ path: resolve(output, `sheet-${name}.png`), fullPage: true });
    entry.videoFrameTimesMs = times;
    entry.videoFrameOriginMs = decoded.originMs;
    entry.videoFrameOriginMethod = { previewPixels: 64, luminanceVarianceThreshold: 1, minimumHorizontalEdges: 16, edgeLuminanceDifference: 6, searchStepMs: 40 };
    entry.videoFrameNote = 'Decoded from the original recording. Contact-sheet times start at the first frame with visible UI edges; original videos retain blank lead-in frames. This does not establish input latency or native macOS frame pacing.';
  }
  await decoder.close();
  await writeFile(resolve(output, 'motion.json'), JSON.stringify(report, null, 2));
} finally { await browser.close(); await new Promise(done => server.close(done)); }
