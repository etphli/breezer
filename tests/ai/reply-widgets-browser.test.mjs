import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { mapURL } from '../../features/ai/extension/reply-widgets.js';

let chromium;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : undefined);
const skip = !chromium ? 'Playwright is not installed' : (executablePath && !existsSync(executablePath)
  ? `No browser at ${executablePath}`
  : false);

test('map bounds select the requested zoom at any latitude and stay centered', () => {
  const y = lat => Math.asinh(Math.tan(lat * Math.PI / 180));
  for (const [lat, lon] of [[0, 0], [38.6916, -9.216], [69.6492, 18.9553], [-54.8019, -68.303], [-16.8, 179.98], [0.0000001, -180]]) {
    for (const zoom of [3, 10, 15, 19]) {
      const url = new URL(mapURL({ lat, lon, zoom }));
      assert.equal(url.origin + url.pathname, 'https://www.openstreetmap.org/export/embed.html');
      assert.doesNotMatch(url.search, /\de-/, 'coordinates use decimal notation');
      const [west, south, east, north] = url.searchParams.get('bbox').split(',').map(Number);
      const scale = 256 * 2 ** zoom;
      const width = (east - west) / 360 * scale, height = (y(north) - y(south)) / (2 * Math.PI) * scale;
      // The 238px frame interior: 200px fits, and neither floor nor round can choose another zoom.
      for (const size of [width, height]) assert.ok(size > 170 && size < 236, `${lat},${lon} z${zoom}: ${size}px`);
      assert.ok(Math.abs((west + east) / 2 - lon) < 1e-5);
      assert.ok(Math.abs((y(north) + y(south)) / 2 - y(lat)) / (2 * Math.PI) * scale < 2, 'the marker is vertically centered');
    }
  }
});

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');

test('map, image and search replies wait for a click and recover from failures', { skip }, async t => {
  const files = Object.fromEntries(await Promise.all(['reply-widgets.js', 'render-message.js', 'panel.css'].map(async name =>
    ['/' + name, await readFile(new URL('../../features/ai/extension/' + name, import.meta.url))])));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 340, height: 800 } });
  const external = [];
  await page.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin === 'https://panel.test') {
      const body = files[url.pathname];
      return route.fulfill(body ? { body, contentType: url.pathname.endsWith('.css') ? 'text/css' : 'application/javascript' }
        : { contentType: 'text/html', body: '<!doctype html><link rel="stylesheet" href="/panel.css"><main id="body" class="message-body"></main>' });
    }
    external.push({ url: url.href, referer: request.headers().referer });
    if (url.pathname.endsWith('/broken.png')) return route.abort();
    if (url.hostname === 'www.openstreetmap.org') return route.fulfill({ contentType: 'text/html', body: '<p>Map fixture</p>' });
    return route.fulfill({ contentType: 'image/png', body: png });
  });
  await page.goto('https://panel.test/');
  const render = text => page.evaluate(async value => {
    const { renderMessage } = await import('/render-message.js');
    const { renderReplyWidget } = await import('/reply-widgets.js');
    renderMessage(document.querySelector('#body'), value, renderReplyWidget);
  }, text);
  const block = data => '```breezer\n' + JSON.stringify(data) + '\n```';
  const widgets = page.locator('.reply-widget');

  await t.test('maps clamp zoom, show the marker, and offer a place when coordinates are unknown', async () => {
    await render(block({ type: 'map', title: 'Harbour', lat: 69.6492, lon: 18.9553, zoom: 22.4, place: 'Tromsø harbour' }));
    assert.equal(external.length, 0);
    assert.equal(await page.getByText('Marker at 69.6492, 18.9553, supplied by the assistant.').count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Open in OpenStreetMap' }).getAttribute('href'),
      'https://www.openstreetmap.org/?mlat=69.6492&mlon=18.9553#map=19/69.6492/18.9553');
    await page.getByRole('button', { name: 'Load interactive map' }).click();
    await page.frameLocator('iframe').getByText('Map fixture').waitFor();
    assert.equal(await page.locator('iframe').getAttribute('sandbox'), 'allow-scripts allow-same-origin');
    await page.waitForFunction(() => !document.querySelector('.reply-widget-status').textContent);
    assert.equal(external.length, 1);
    await page.getByRole('button', { name: 'Hide map' }).click();
    assert.equal(await page.locator('iframe').count(), 0);
    await render(block({ type: 'map', title: 'Unknown', place: 'Tromsø & harbour' }));
    assert.equal(new URL(await page.getByRole('link', { name: 'Find this place' }).getAttribute('href')).searchParams.get('query'), 'Tromsø & harbour');
    assert.equal(await page.getByRole('button').count(), 0);
    for (const bad of [{ lat: 95, lon: 0 }, { lat: 1 }, { lat: '1', lon: 2 }, { lat: 1, lon: 2, zoom: 'near' }, { place: 4 }, {}]) {
      await render(block({ type: 'map', title: 'Invalid', ...bad }));
      assert.equal(await widgets.count(), 0, JSON.stringify(bad));
    }
  });

  await t.test('a stalled map explains how to continue', async () => {
    await page.clock.install();
    await page.route('https://www.openstreetmap.org/**', () => {}, { times: 1 });
    await render(block({ type: 'map', title: 'Slow', lat: 1, lon: 2 }));
    await page.getByRole('button', { name: 'Load interactive map' }).click();
    await page.getByText('Loading map…').waitFor();
    await page.clock.runFor(12_100);
    await page.getByText('The map is taking a while.').waitFor();
    await page.getByRole('button', { name: 'Hide map' }).click();
    assert.equal(await page.locator('.reply-widget-status').textContent(), '');
  });

  await t.test('existing images show their host, load without a referrer, and are not labeled generated', async () => {
    external.length = 0;
    await render('Here it is.\n\n' + block({ type: 'image', title: 'Tower', url: 'https://images.example/tower.png', source: 'https://example.com/tower', alt: 'Stone tower' }));
    await page.getByText('Web image from images.example. It loads when you view it.').waitFor();
    assert.deepEqual(external, []);
    await page.getByRole('button', { name: 'View image' }).click();
    await page.waitForFunction(() => document.querySelector('.reply-web-image img')?.naturalWidth === 1);
    assert.deepEqual(external, [{ url: 'https://images.example/tower.png', referer: undefined }]);
    assert.equal(await page.getByRole('img', { name: 'Stone tower' }).count(), 1);
    assert.equal(await page.getByRole('link', { name: 'Open source' }).getAttribute('href'), 'https://example.com/tower');
    assert.equal(await page.getByText('Generated image').count() + await page.getByRole('link', { name: 'Save image' }).count(), 0);
    await render(block({ type: 'image', title: 'Broken', url: 'https://images.example/broken.png' }));
    await page.getByRole('button', { name: 'View image' }).click();
    await page.getByText('This image could not load.').waitFor();
    assert.equal(await page.locator('.reply-web-image img').count(), 0);
    await render(block({ type: 'image', title: 'Source only', source: 'http://example.com/gallery' }));
    assert.equal(await page.getByRole('button').count(), 0);
    assert.equal(await page.getByRole('link', { name: 'Open source' }).count(), 1);
  });

  await t.test('unsafe image addresses never become image cards', async () => {
    external.length = 0;
    for (const url of ['http://images.example/a.png', 'data:image/svg+xml,<svg/>', 'javascript:alert(1)', 'file:///etc/passwd', 'chrome://settings',
      'https://user:pass@images.example/a.png', 'https://127.0.0.1/a.png', 'https://0x7f.1/a.png', 'https://[::1]/a.png', 'https://localhost/a.png',
      'https://router.local/a.png', 'https://intranet/a.png', 'https://images.example:8443/a.png', 'https://a.example/' + 'x'.repeat(2048)]) {
      await render(block({ type: 'image', title: 'Unsafe', url }));
      assert.equal(await widgets.count(), 0, url);
    }
    assert.deepEqual(external, []);
  });

  await t.test('Markdown images become click-to-load cards or plain links, never automatic requests', async () => {
    external.length = 0;
    await render('![A tower](https://images.example/tower.png)\n\nSee ![inline](https://images.example/b.png) and ![](https://images.example/c.png) or [docs](https://example.com/).\n\n![local](https://127.0.0.1/a.png)');
    assert.equal(await widgets.count(), 1);
    assert.equal(await widgets.locator('figcaption').textContent(), 'A tower');
    assert.equal(await page.locator('#body > p').first().textContent(), 'See inline and Image or docs.');
    assert.equal(await page.locator('#body > p').last().getByRole('link', { name: 'local' }).count(), 1);
    assert.equal(await page.locator('#body img').count(), 0);
    assert.deepEqual(external, []);
  });

  await t.test('a suggested search runs once clicked, in the default engine', async () => {
    await page.evaluate(() => { window.searches = []; window.chrome = { search: { query: async value => { window.searches.push(value); } } }; });
    await render(block({ type: 'search', title: 'Web search', query: 'tower <b>hours</b> & tickets' }));
    await page.getByText('tower <b>hours</b> & tickets', { exact: true }).waitFor();
    assert.deepEqual(await page.evaluate(() => searches), []);
    await page.getByRole('button', { name: 'Search the web' }).click();
    await page.getByText('Results opened in a new tab.').waitFor();
    assert.deepEqual(await page.evaluate(() => searches), [{ text: 'tower <b>hours</b> & tickets', disposition: 'NEW_TAB' }]);
    await page.evaluate(() => { window.chrome = {}; });
    await page.getByRole('button', { name: 'Search the web' }).click();
    await page.getByText('The search could not open.').waitFor();
    for (const query of ['', ' ', 'x'.repeat(201), 'a\nb', 4]) {
      await render(block({ type: 'search', title: 'Bad', query }));
      assert.equal(await widgets.count(), 0, String(query));
    }
  });

  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
});
