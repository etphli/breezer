// Disposable dummy-login test. Uses the native password store, never a real profile.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from '../ai/node_modules/playwright/index.mjs';
const app = process.argv[2];
assert.ok(app?.endsWith('/Breezer.app'));
const evidence = resolve(process.env.BREEZER_PASSWORD_EVIDENCE || 'build/updates-20261029/password-fill');
await mkdir(evidence, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'breezer-fill-test-'));
const server = createServer((req, res) => { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><title>Dummy login</title><form method="post"><label>Username<input id="username" name="username" autocomplete="username"></label><label>Password<input id="password" name="password" type="password" autocomplete="current-password"></label><button>Sign in</button></form>'); });
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://localhost:${server.address().port}/`;
const portProbe = createServer(); await new Promise(r => portProbe.listen(0, '127.0.0.1', r)); const uiPort = portProbe.address().port; await new Promise(r => portProbe.close(r));
const report = { status: 'running', app, checks: {}, limitations: ['Renderer-delivered input exercises native autofill; physical pointer routing and OS biometric prompts are not tested.'] };
let context, internals;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath: `${app}/Contents/MacOS/Breezer`, headless: false, viewport: null, ignoreDefaultArgs: ['--enable-automation', '--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox', '--password-store=basic', '--use-mock-keychain'], args: ['--no-first-run', '--no-default-browser-check', `--enable-ui-devtools=${uiPort}`] });
  const manager = await context.newPage(); await manager.goto('chrome://password-manager/passwords');
  await manager.waitForFunction(() => !!chrome.passwordsPrivate?.addPassword);
  await manager.evaluate(url => chrome.passwordsPrivate.addPassword({ url, username: 'dummy@example.test', password: 'Dummy-only-123!', note: 'Disposable fixture', useAccountStore: false }), url);
  await manager.waitForFunction(async () => (await chrome.passwordsPrivate.getSavedPasswordList()).length === 1);
  internals = await context.newPage(); await internals.goto('chrome://password-manager-internals');
  const page = await context.newPage(); await page.goto(url); await page.bringToFront();
  await new Promise(r => setTimeout(r, 1500));
  await page.locator('#password').click();
  await new Promise(r => setTimeout(r, 1000));
  report.focus = await page.evaluate(() => ({ focused: document.hasFocus(), field: document.activeElement?.id }));
  const socket = new WebSocket(`ws://127.0.0.1:${uiPort}/0`);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  const tree = await new Promise((resolve, reject) => { const timer = setTimeout(() => reject(new Error('UI tree timeout')), 5000); socket.onmessage = event => { const message = JSON.parse(event.data); if (message.id === 1) { clearTimeout(timer); resolve(message.result); } }; socket.send(JSON.stringify({ id: 1, method: 'DOM.getDocument', params: {} })); });
  socket.close();
  await writeFile(join(evidence, 'native-tree.json'), JSON.stringify(tree, null, 2));
  const classes = []; const walk = node => { if (node.attributes) classes.push(node.attributes); for (const child of node.children || []) walk(child); }; walk(tree.root);
  report.popupClasses = classes.filter(value => /Autofill|Popup|Suggestion/.test(JSON.stringify(value)));
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelector('#password').value === 'Dummy-only-123!', null, { timeout: 5000 });
  report.checks.passwordFieldSelectionFilledDummy = true;
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.message; process.exitCode = 1; }
finally { if (internals) await writeFile(join(evidence, 'internals.txt'), await internals.locator('body').innerText().catch(() => 'Unavailable')); await context?.close(); server.close(); await rm(profile, { recursive: true, force: true }); await writeFile(join(evidence, 'result.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify(report, null, 2));
