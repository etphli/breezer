// Run against an exact packaged Breezer in a disposable profile.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.equal(process.argv.length, 3, 'Pass a Breezer app bundle or browser executable.');
const target = resolve(process.argv[2]);
const executablePath = target.endsWith('.app') ? join(target, 'Contents/MacOS/Breezer') : target;
const modulePath = process.env.BREEZER_PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(resolve(modulePath)) : 'playwright');
const origin = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj';
const profile = await mkdtemp(join(tmpdir(), 'breezer-native-search-'));
const server = createServer((request, response) => {
  response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  response.end('<!doctype html><title>Breezer address fixture</title>');
});
let context;

try {
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const typed = '127.0.0.1:' + server.address().port + '/fixture';
  const url = 'http://' + typed;
  context = await chromium.launchPersistentContext(profile, {
    executablePath, headless: false, timeout: 30_000,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-sync',
      '--use-mock-keychain', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  await page.goto(origin + '/whats-new.html');
  await page.evaluate(() => chrome.storage.local.set({
    'organato.switches.v1': { enabled: false, dashboardEnabled: false },
  }));
  await page.goto(origin + '/newtab.html');
  const input = page.locator('#composer-input');
  await input.waitFor();
  assert.equal(await page.evaluate(() => typeof chrome.breezerPrivate.queryOmnibox), 'function');
  const client = await context.newCDPSession(page);
  const denied = await client.send('Runtime.evaluate', {
    expression: 'chrome.breezerPrivate.openOmnibox({ text: ' + JSON.stringify(typed) + ' }).then(() => false, () => true)',
    awaitPromise: true, returnByValue: true, userGesture: false,
  });
  assert.equal(denied.result.value, true, 'The native bridge refuses navigation without a user gesture.');
  await client.detach();
  await input.fill(typed);
  await page.waitForFunction(value => [...document.querySelectorAll('#composer-suggestions .suggestion')]
    .some(row => row.textContent.includes(value)), typed);
  const opened = page.waitForURL(url);
  await input.press('Enter');
  await opened;
  assert.equal(await page.title(), 'Breezer address fixture');
  console.log('PASS: native New Tab suggestions, user gesture, Enter, and same-tab address navigation.');
} finally {
  try {
    await context?.close();
    if (server.listening) await new Promise(done => server.close(done));
  } finally {
    await rm(profile, { recursive: true, force: true });
  }
}
