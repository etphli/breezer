// Fresh, isolated Chrome WebUI references at the same settings viewport as Breezer.
// These screenshots exclude the native tab strip and toolbar.
import { chromium } from 'playwright';
import { mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';

const output = resolve(process.argv[2] || '/tmp/breezer-ui-chrome');
await mkdir(output, { recursive: true });
const captures = [];
const temporary = await mkdtemp(resolve(tmpdir(), 'breezer-ui-chrome-'));
let context;
let version;
try {
  for (const scheme of ['light', 'dark']) {
    context = await chromium.launchPersistentContext(resolve(temporary, scheme), { headless: true, executablePath: process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined), viewport: { width: 1200, height: 900 }, colorScheme: scheme });
    const page = await context.newPage();
    for (const route of ['appearance', 'onStartup', 'people', 'privacy', 'languages', 'downloads', 'accessibility', 'system', 'performance', 'search', 'defaultBrowser']) {
      await page.goto(`chrome://settings/${route}`);
      await page.locator('settings-ui').waitFor();
      version = await page.evaluate(() => navigator.userAgent);
      await page.screenshot({ path: resolve(output, `${scheme}-${route}.png`) });
      captures.push({ scheme, route, file: `${scheme}-${route}.png` });
    }
    await page.goto('chrome://newtab/');
    await page.locator('ntp-app').waitFor();
    await page.screenshot({ path: resolve(output, `${scheme}-newtab.png`) });
    captures.push({ scheme, route: 'newtab', file: `${scheme}-newtab.png` });
    await context.close();
  }
  await writeFile(resolve(output, 'manifest.json'), JSON.stringify({ version, viewport: { width: 1200, height: 900 }, captures, notes: ['Isolated headless Chrome, no personal profile. Native tab strip and toolbar excluded.'] }, null, 2));
} finally { await context?.close(); await rm(temporary, { recursive: true, force: true }); }
