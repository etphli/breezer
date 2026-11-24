// Verify the packaged Settings UI against the real native appearance bridge.
// node tests/ai/theme-looks-native.mjs /path/to/Breezer.app
// On Windows, pass the extracted Breezer chrome.exe instead.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { THEME_LOOKS } from '../../features/ai/extension/panel-theme.js';

assert.equal(process.argv.length, 3, 'Pass the packaged Breezer app or executable.');
const target = resolve(process.argv[2]);
const executablePath = target.endsWith('.app') ? join(target, 'Contents/MacOS/Breezer') : target;
const playwright = process.env.BREEZER_PLAYWRIGHT_MODULE;
const { chromium } = await import(playwright ? pathToFileURL(resolve(playwright)) : 'playwright');
const profile = await mkdtemp(join(tmpdir(), 'breezer-native-looks-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    executablePath,
    headless: true,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
           '--use-mock-keychain', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  const settings = await context.newPage();
  const timeout = 10000;
  settings.setDefaultTimeout(timeout);
  await settings.goto('chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/workspace.html#/settings/appearance');
  const appearance = () => settings.evaluate(() => chrome.breezerPrivate.getAppearance());
  const select = async (value, theme, mode) => {
    const swatch = settings.locator(`#theme-swatches [data-value="${value}"]`);
    await swatch.click();
    try {
      await settings.waitForFunction(({ value }) =>
        document.querySelector(`#theme-swatches [data-value="${value}"]`)?.getAttribute('aria-checked') === 'true',
      { value }, { timeout });
    } catch (error) {
      const status = await settings.getByText(/Couldn’t change the theme/).first().textContent({ timeout: 500 }).catch(() => null);
      throw new Error(status || `Settings did not select ${value}.`, { cause: error });
    }
    const actual = await appearance();
    assert.equal(actual.theme, theme, value);
    assert.equal(actual.colorMode, mode, value);
  };

  const original = await appearance();
  for (const [id, look] of Object.entries(THEME_LOOKS)) {
    await select(`look:${id}`, look.seed, original.colorMode);
  }
  await settings.getByRole('button', { name: 'Cancel Vesper and return to your previous theme' }).click();
  await settings.waitForFunction(theme => chrome.breezerPrivate.getAppearance().then(value => value.theme === theme),
    original.theme, { timeout });
  const restored = await appearance();
  assert.equal(restored.nativeDefaultTheme, original.nativeDefaultTheme);
  assert.equal(restored.colorMode, original.colorMode);
  await select('look:lune', THEME_LOOKS.lune.seed, original.colorMode);
  await select('rose', 'rose', original.colorMode);
  console.log('PASS: all eight packaged Looks, Cancel, and a plain color after a Look preserve the color mode.');
} finally {
  try { await context?.close(); } finally { await rm(profile, { recursive: true, force: true }); }
}
