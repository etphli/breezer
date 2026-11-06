// Decode continuous native recordings and index the original native screenshots.
// node tests/ai/native-ui-evidence.mjs NATIVE_EVIDENCE REDUCED_EVIDENCE
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from './node_modules/playwright/index.mjs';

const folders = process.argv.slice(2).map(path => resolve(path));
assert.equal(folders.length, 2, 'Pass the normal and reduced native evidence folders.');
const browser = await chromium.launch({ headless: true, executablePath: process.env.BREEZER_TEST_BROWSER || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
  for (const folder of folders) {
    const report = JSON.parse(await readFile(join(folder, 'manifest.json'), 'utf8'));
    assert.equal(report.status, 'passed');
    const video = await readFile(report.recording.path);
    await page.setContent(`<video muted preload="auto" src="data:video/mp4;base64,${video.toString('base64')}"></video>`);
    await page.waitForFunction(() => document.querySelector('video').readyState >= 2);
    const times = [0, 100, 300, 600, 900, 1200, 1500, 1800];
    const decoded = await page.evaluate(async times => {
      const video = document.querySelector('video');
      const canvas = document.createElement('canvas'); canvas.width = video.videoWidth; canvas.height = video.videoHeight;
      const context = canvas.getContext('2d'), frames = [];
      for (const ms of times) {
        const target = Math.max(.001, ms / 1000);
        if (Math.abs(video.currentTime - target) > .0001) await new Promise(done => { video.addEventListener('seeked', done, { once: true }); video.currentTime = target; });
        context.drawImage(video, 0, 0);
        const pixel = [...context.getImageData(canvas.width - 40, canvas.height - 40, 1, 1).data].slice(0, 3);
        frames.push({ ms, pixel, data: canvas.toDataURL('image/png').split(',')[1] });
      }
      return { width: canvas.width, height: canvas.height, duration: video.duration, frames };
    }, times);
    assert.ok(decoded.duration >= 2 && decoded.width >= 1000);
    for (const frame of decoded.frames) {
      assert.ok(frame.pixel.every((v, i) => Math.abs(v - [228, 243, 237][i]) < 12), `Native recording ${frame.ms}ms contains painted fixture content`);
      await writeFile(join(folder, `native-motion-${frame.ms}.png`), Buffer.from(frame.data, 'base64'));
      delete frame.data;
    }
    await writeFile(join(folder, 'motion-frames.json'), JSON.stringify({ ...decoded, note: 'Times are video timestamps. They are not input latency or animation onset. Continuous recordings are retained; these are decoded samples.' }, null, 2));
    const sheets = [['motion', times.map(ms => ({ path: join(folder, `native-motion-${ms}.png`), label: `${ms} ms`, width: decoded.width / 2 }))]];
    for (const mode of ['light', 'dark']) {
      const captures = report.captures.filter(item => new RegExp(`^top-.+-${mode}-(desktop|narrow)\\.png$`).test(item.path.split('/').at(-1)));
      if (captures.length) sheets.push([`top-${mode}`, captures.map(item => ({ path: item.path, label: item.path.split('/').at(-1), width: item.geometry.width }))]);
    }
    sheets.push(['variants', report.captures.filter(item => /\/(toolbar-|sidebar-frame-)/.test(item.path)).map(item => ({ path: item.path, label: item.path.split('/').at(-1), width: item.geometry.width }))]);
    for (const [name, tiles] of sheets) {
      if (!tiles.length) continue;
      const html = `<!doctype html><style>body{margin:16px;color:#202b32;background:white;font:14px system-ui}main{display:grid;grid-template-columns:1fr 1fr;gap:16px}figure{margin:0;min-width:0}figcaption{margin-bottom:6px}.crop{overflow:hidden}img{width:100%;display:block}</style><h1>Actual native ${name}</h1><p>Native header crops for indexing. Open original PNGs for complete windows. Video samples do not establish input latency.</p><main>${tiles.map(tile => `<figure><figcaption>${tile.label}</figcaption><div class="crop" style="aspect-ratio:${tile.width}/110"><img src="${tile.path}"></div></figure>`).join('')}</main>`;
      const path = join(folder, `sheet-native-${name}.html`); await writeFile(path, html);
      await page.goto(pathToFileURL(path).href);
      await page.screenshot({ path: path.replace(/\.html$/, '.png'), fullPage: true });
    }
    console.log(`ok ${folder}: eight native video frames and contact sheets`);
  }
} finally { await browser.close(); }
