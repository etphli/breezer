// Real native manager and local-store check. Only a disposable profile and dummy data.
// node tests/passwords/installed.mjs /absolute/path/Breezer.app
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { chromium } from '../ai/node_modules/playwright/index.mjs';

const [app, ...extra] = process.argv.slice(2);
assert.ok(app?.startsWith('/') && app.endsWith('/Breezer.app') && !extra.length);
const profile = await mkdtemp(join(tmpdir(), 'breezer-password-runtime-'));
await mkdir(join(profile, 'Default'), { recursive: true });
await writeFile(join(profile, 'Default/Preferences'), '{}');
const evidence = resolve(process.env.BREEZER_PASSWORD_EVIDENCE || 'build/polish-20261027/password-native');
await mkdir(evidence, { recursive: true });
const report = { app, status: 'running', checks: {}, limitations: ['CSV file picker and OS authentication require separate UI acceptance.', 'This checks metadata edits, persistence and deletion through the native WebUI API; it never requests plaintext passwords.'] };
let context;
const pause = ms => new Promise(done => setTimeout(done, ms));
async function waitFor(label, probe) {
  const until = Date.now() + 20000;
  while (Date.now() < until) {
    if (await probe()) return;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}
async function openManager() {
  context = await chromium.launchPersistentContext(profile, {
    executablePath: `${app}/Contents/MacOS/Breezer`, headless: false,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox', '--password-store=basic', '--use-mock-keychain'],
    args: ['--no-first-run', '--no-default-browser-check'], viewport: null,
  });
  // Native sidebars are also CDP page targets. Create a real content tab.
  const page = await context.newPage();
  await page.goto('chrome://password-manager/passwords');
  await page.bringToFront();
  await page.locator('password-manager-app').waitFor();
  await page.waitForFunction(() => Boolean(chrome.passwordsPrivate?.getSavedPasswordList));
  return page;
}
async function usernames(page) {
  // Do not return credential objects or request their plaintext/password details.
  return page.evaluate(async () => (await chrome.passwordsPrivate.getSavedPasswordList()).map(entry => entry.username));
}
try {
  let page = await openManager();
  const pref = await page.evaluate(() => new Promise((done, reject) => {
    chrome.settingsPrivate.getPref('credentials_enable_service', value => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else done({ value: value.value, enforcement: value.enforcement, controlledBy: value.controlledBy });
    });
  }));
  report.passwordSavingPref = pref;
  assert.equal(pref.value, true, 'Native password saving is still disabled.');
  assert.notEqual(pref.enforcement, 'ENFORCED', 'A forced native policy still disables password controls.');
  report.checks.passwordSavingEnabled = true;
  assert.deepEqual(await usernames(page), [], 'Disposable profile must contain no existing credentials.');
  await page.evaluate(() => chrome.passwordsPrivate.addPassword({
    url: 'http://localhost:8765/passwords-fixture', username: 'dummy@example.test',
    password: 'Breezer-test-only-123!', note: 'Disposable native runtime fixture only', useAccountStore: false,
  }));
  await waitFor('dummy entry', async () => (await usernames(page)).join() === 'dummy@example.test');
  report.checks.localStoreWrite = true;
  await page.screenshot({ path: join(evidence, 'native-password-manager.png'), fullPage: true });
  await page.evaluate(async () => {
    const entries = await chrome.passwordsPrivate.getSavedPasswordList();
    if (entries.length !== 1 || entries[0].username !== 'dummy@example.test') throw new Error('Unexpected disposable-store state');
    if (entries[0].storedIn !== chrome.passwordsPrivate.PasswordStoreSet.DEVICE) throw new Error('Credential is not in the local profile store');
    await chrome.passwordsPrivate.changeCredential({ ...entries[0], username: 'edited-dummy@example.test' });
  });
  await waitFor('metadata edit', async () => (await usernames(page)).join() === 'edited-dummy@example.test');
  report.checks.localMetadataEdit = true;
  await context.close(); context = null;
  page = await openManager();
  await waitFor('persisted dummy entry after restart', async () => (await usernames(page)).join() === 'edited-dummy@example.test');
  report.checks.persistenceAfterRestart = true;
  await page.evaluate(async () => {
    const entries = await chrome.passwordsPrivate.getSavedPasswordList();
    if (entries.length !== 1 || entries[0].username !== 'edited-dummy@example.test') throw new Error('Unexpected disposable-store state');
    chrome.passwordsPrivate.removeCredential(entries[0].id, chrome.passwordsPrivate.PasswordStoreSet.DEVICE);
  });
  await waitFor('dummy deletion', async () => (await usernames(page)).length === 0);
  report.checks.localDelete = true;
  await page.goto('chrome://password-manager/settings');
  await page.bringToFront();
  await page.locator('password-manager-app').waitFor();
  await page.screenshot({ path: join(evidence, 'native-password-settings.png'), fullPage: true });
  report.checks.nativeSettingsRoute = true;
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
  await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
