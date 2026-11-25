import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { chromium } from '../../tests/ai/node_modules/playwright/index.mjs';

const site = resolve(new URL('../', import.meta.url).pathname);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };
const WINDOWS_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const asset = (name, digest = `sha256:${'a'.repeat(64)}`) => ({ name, digest, state: 'uploaded', size: 100, browser_download_url: `https://github.com/etphli/breezer/releases/download/v1.3.5/${name}` });
const macOnly = { tag_name: 'v1.3.1', assets: [asset('Breezer-v1.3.1-arm64.dmg'), asset('Breezer-v1.3.1-arm64.dmg.sha256')] };
const withWindows = { tag_name: 'v1.3.5', assets: [
  asset('Breezer-v1.3.5-arm64.dmg'), asset('Breezer-v1.3.5-arm64.dmg.sha256'),
  asset('Breezer-Windows-x64-Setup.exe', `sha256:${'b'.repeat(64)}`), asset('Breezer-Windows-x64-Setup.exe.sha256'),
  asset('Breezer-Windows-x64.zip', `sha256:${'c'.repeat(64)}`), asset('Breezer-Windows-x64.zip.sha256'),
] };
// An installer without its published .sha256 file must not be offered.
const missingChecksum = { tag_name: 'v1.3.0', assets: [asset('Breezer-Windows-x64-Setup.exe')] };
const incompleteUploads = [
  { state: 'starter' }, { size: 0 },
].flatMap(override => [
  { ...missingChecksum, assets: [...missingChecksum.assets,
    { ...asset('Breezer-Windows-x64-Setup.exe.sha256'), ...override },
  ] },
  { ...missingChecksum, assets: [
    { ...asset('Breezer-Windows-x64.zip'), ...override }, asset('Breezer-Windows-x64.zip.sha256'),
  ] },
]);

test('download page offers Windows only when a verified Windows build is published', { timeout: 60_000 }, async () => {
  const evidence = process.env.BREEZER_SITE_EVIDENCE || '/tmp/breezer-site-evidence';
  await mkdir(evidence, { recursive: true });
  const server = createServer(async (req, res) => {
    try {
      const path = new URL(req.url, 'http://localhost').pathname;
      const file = resolve(site, path === '/download' ? 'download/index.html' : path === '/' ? 'index.html' : path.slice(1));
      if (!file.startsWith(site + '/')) { res.writeHead(404).end(); return; }
      res.setHeader('Content-Type', types[extname(file)] || 'application/octet-stream');
      res.end(await readFile(file));
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
  const browser = await chromium.launch({ executablePath, headless: true });

  const open = async ({ userAgent, release, path = '/download', status = 200, viewport = { width: 1440, height: 1050 } }) => {
    const context = await browser.newContext({ userAgent, viewport, reducedMotion: 'reduce' });
    const page = await context.newPage();
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    let calls = 0;
    await page.route('https://api.github.com/**', route => {
      calls++;
      route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(status === 200 ? release : { message: 'API rate limit exceeded' }) });
    });
    const done = page.waitForResponse(r => r.url().startsWith('https://api.github.com/'));
    await page.goto(`${origin}${path}`);
    await done;
    await page.waitForTimeout(100);
    return { page, context, errors, calls: () => calls };
  };
  const visible = (page, selector) => page.locator(selector).isVisible();
  const macHref = page => page.locator('[data-download]').getAttribute('href');

  try {
    const staticPage = await browser.newPage({ javaScriptEnabled: false });
    await staticPage.goto(`${origin}/download`);
    const originalMacHref = await macHref(staticPage);
    assert.match(originalMacHref, /^https:\/\/github\.com\/etphli\/breezer\/releases\/download\/(v\d+\.\d+\.\d+)\/Breezer-\1-arm64\.dmg$/);
    await staticPage.close();

    // Today's releases: Mac visitors see the unchanged Mac page.
    let s = await open({ userAgent: MAC_UA, release: macOnly });
    assert.equal(s.calls(), 1);
    assert.equal(await visible(s.page, '#windows'), false);
    assert.equal(await visible(s.page, '#windows-unavailable'), false);
    assert.equal(await macHref(s.page), originalMacHref);
    assert.equal(await s.page.locator('[data-download]').innerText(), 'Download Breezer');
    assert.equal(await s.page.locator('#platform-support').innerText(), "Intel Macs, Windows and Linux aren't supported yet.");
    assert.equal(await s.page.locator('a[href*="Windows"]').count(), 0, 'no link to a Windows file that does not exist');
    assert.deepEqual(s.errors, []);
    await s.context.close();

    // Windows visitors are told plainly that there is no Windows build yet.
    s = await open({ userAgent: WINDOWS_UA, release: macOnly });
    assert.equal(await visible(s.page, '#windows'), false);
    assert.equal(await s.page.locator('#windows-unavailable').innerText(), "There's no Windows version yet. This download needs a Mac with Apple Silicon. New versions appear on the releases page.");
    assert.equal(await s.page.locator('a[href*="Windows"]').count(), 0);
    await s.page.screenshot({ path: `${evidence}/download-windows-unavailable.png` });
    await s.context.close();

    // An installer without its .sha256 file is ignored.
    for (const release of [missingChecksum, ...incompleteUploads]) {
      s = await open({ userAgent: WINDOWS_UA, release });
      assert.equal(await visible(s.page, '#windows'), false);
      assert.equal(await s.page.locator('a[href*="Windows"]').count(), 0);
      await s.context.close();
    }

    // If GitHub can't answer, the page doesn't claim anything about Windows.
    s = await open({ userAgent: WINDOWS_UA, status: 403 });
    assert.equal(await visible(s.page, '#windows'), false);
    assert.equal(await s.page.locator('#windows-unavailable').innerText(), 'This download needs a Mac with Apple Silicon. New versions appear on the releases page.');
    assert.equal(await macHref(s.page), originalMacHref);
    assert.deepEqual(s.errors, []);
    await s.context.close();

    // Once published: Windows visitors get their installer first, with checksums.
    s = await open({ userAgent: WINDOWS_UA, release: withWindows });
    assert.equal(await visible(s.page, '#windows'), true);
    assert.equal(await visible(s.page, '#windows-unavailable'), false);
    assert.equal(await s.page.getByRole('link', { name: 'Download for Windows' }).getAttribute('href'), withWindows.assets[2].browser_download_url);
    assert.equal(await s.page.getByRole('link', { name: 'Download zip', exact: true }).getAttribute('href'), withWindows.assets[4].browser_download_url);
    assert.equal(await s.page.locator('#windows-sha').innerText(), 'b'.repeat(64));
    assert.equal(await s.page.locator('#windows-zip-sha').innerText(), 'c'.repeat(64));
    assert.equal(await s.page.locator('#windows-version').innerText(), 'Version 1.3.5');
    assert.equal(await s.page.getByRole('heading', { name: 'Breezer for Windows', exact: true, level: 1 }).count(), 1);
    assert.equal(await s.page.getByRole('link', { name: 'Windows release notes' }).getAttribute('href'), 'https://github.com/etphli/breezer/releases/tag/v1.3.5');
    assert.equal(await s.page.locator('.get-copy > :is(#windows, .actions)').evaluateAll(els => els.map(el => el.id || 'mac')).then(ids => ids.join()), 'windows,mac');
    assert.equal(await s.page.locator('[data-download]').innerText(), 'Download for Mac');
    assert.equal(await macHref(s.page), withWindows.assets[0].browser_download_url);
    assert.equal(await s.page.locator('#sha').textContent(), 'a'.repeat(64));
    assert.equal(await s.page.locator('#platform-support').innerText(), "Intel Macs and Linux aren't supported yet.");
    await s.page.screenshot({ path: `${evidence}/download-windows-available.png` });
    await s.page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await s.page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await s.page.locator('#windows').screenshot({ path: `${evidence}/download-windows-mobile.png` });
    // The release lookup is cached for the session.
    await s.page.reload(); await s.page.locator('#windows').waitFor();
    assert.equal(s.calls(), 1);
    assert.deepEqual(s.errors, []);
    await s.context.close();

    // Mac visitors keep their download first and see Windows below it.
    s = await open({ userAgent: MAC_UA, release: withWindows });
    assert.equal(await visible(s.page, '#windows'), true);
    assert.equal(await s.page.locator('.get-copy > :is(#windows, .actions)').evaluateAll(els => els.map(el => el.id || 'mac')).then(ids => ids.join()), 'mac,windows');
    assert.equal(await s.page.locator('[data-download]').innerText(), 'Download Breezer');
    await s.page.screenshot({ path: `${evidence}/download-mac-with-windows.png` });
    await s.context.close();

    // Home and Download share release evidence in the same browser session.
    s = await open({ userAgent: WINDOWS_UA, release: withWindows, path: '/' });
    assert.equal(await s.page.locator('#home-version').innerText(), 'Breezer 1.3.5 for Windows');
    assert.match(await s.page.locator('#home-platforms').innerText(), /Windows x64/);
    await s.page.getByRole('link', { name: 'Download for Windows' }).click();
    await s.page.locator('#windows').waitFor();
    assert.equal(s.calls(), 1);
    assert.deepEqual(s.errors, []);
    await s.context.close();

    for (const release of [macOnly, missingChecksum]) {
      s = await open({ userAgent: WINDOWS_UA, release, path: '/' });
      assert.equal(await s.page.locator('#home-download').innerText(), 'Download for Mac');
      assert.doesNotMatch(await s.page.locator('#home-platforms').innerText(), /Windows/);
      await s.context.close();
    }
  } finally { await browser.close(); await new Promise(done => server.close(done)); }
});
