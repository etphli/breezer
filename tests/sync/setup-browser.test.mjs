import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
let chromium;
try { ({ chromium } = await import('../ai/node_modules/playwright/index.mjs')); } catch {}
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : undefined);
const skip = !chromium ? 'Playwright unavailable' : executablePath && !existsSync(executablePath) ? 'Disposable fixture browser unavailable' : false;

test('setup document relays provider, recovery, error and disconnect states through a message fixture', { skip }, async () => {
  const root = resolve('features/sync/setup');
  const server = createServer(async (request, response) => {
    const path = request.url === '/' ? 'setup.html' : request.url.slice(1);
    if (!['setup.html', 'setup.js', 'setup.css'].includes(path)) { response.writeHead(404).end(); return; }
    response.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : 'text/html');
    response.end(await readFile(resolve(root, path)));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ executablePath, headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 900, height: 1100 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      let configured = false, firstProvider = true;
      window.testCalls = [];
      const status = () => ({ configured, active: true, spacesEnabled: true, passwordsEnabled: true, initialSyncComplete: false, hasError: false, providerId: 'dummy-provider', lastSuccess: 0, providers: [{ id: 'dummy-provider', name: 'Disposable provider' }] });
      window.chrome = { send(_message, [id, action, values]) {
        window.testCalls.push({ action, fields: Object.keys(values) });
        let result;
        if (action === 'provider' && firstProvider) {
          firstProvider = false;
          window.finishProvider = () => window.breezerSyncReply(id, { vaults: [{ vaultUuid: 'dummy-vault', displayName: 'Dummy vault' }] });
          queueMicrotask(() => window.breezerSyncReply(id, { progress: 'Fixture waiting for provider sign-in.' }));
          return;
        }
        if (action === 'provider') result = { vaults: [{ vaultUuid: 'dummy-vault', displayName: 'Dummy vault' }] };
        else if (action === 'create') result = { recoveryKey: 'synthetic-fixture-key-not-a-real-vault-key' };
        else if (action === 'join') result = { error: 'Fixture authentication failure. Local data is preserved.' };
        else if (action === 'confirm') { configured = true; result = { status: status() }; }
        else if (action === 'disconnect' || action === 'cancel') { configured = false; result = { status: status() }; }
        else result = { status: status() };
        queueMicrotask(() => window.breezerSyncReply(id, result));
      } };
    });
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    await page.getByText('Sync is off for this profile.', { exact: true }).waitFor();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('Fixture waiting for provider sign-in.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Continue', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: 'Cancel setup', exact: true }).isEnabled(), true);
    await page.evaluate(() => window.finishProvider());
    await page.getByRole('heading', { name: 'Choose a vault' }).waitFor();
    await page.locator('#join-key').fill('synthetic-wrong-key');
    await page.getByRole('button', { name: 'Join vault', exact: true }).click();
    await page.getByRole('alert').filter({ hasText: 'Fixture authentication failure' }).waitFor();
    assert.equal(await page.locator('#join-key').inputValue(), '');
    await page.getByRole('button', { name: 'Create vault', exact: true }).click();
    await page.getByRole('heading', { name: 'Save your recovery key', exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Connect this profile', exact: true }).isDisabled(), true);
    assert.equal(await page.locator('#recovery-key').getAttribute('readonly'), '');
    assert.equal(await page.evaluate(() => document.activeElement.id), 'recovery-key');
    const evidence = process.env.BREEZER_AI_EVIDENCE || resolve('build/sync-ui-evidence');
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: resolve(evidence, 'sync-recovery-fixture.png'), fullPage: true });
    await page.getByRole('checkbox', { name: 'I saved the recovery key somewhere private.' }).check();
    await page.getByRole('button', { name: 'Connect this profile', exact: true }).click();
    await page.getByText('Connected. Waiting for initial sync.', { exact: true }).waitFor();
    assert.equal(await page.locator('#recovery-key').inputValue(), '');
    await page.screenshot({ path: resolve(evidence, 'sync-connected-fixture.png'), fullPage: true });
    page.once('dialog', dialog => dialog.dismiss());
    await page.getByRole('button', { name: 'Disconnect this profile', exact: true }).click();
    assert.equal(await page.getByRole('heading', { name: 'This profile', exact: true }).isVisible(), true);
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: 'Disconnect this profile', exact: true }).click();
    await page.getByText('Sync is off for this profile.', { exact: true }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Create vault', exact: true }).click();
    await page.getByRole('heading', { name: 'Save your recovery key', exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: resolve(evidence, 'sync-recovery-narrow-fixture.png'), fullPage: true });
    await page.getByRole('button', { name: 'Cancel setup', exact: true }).click();
    await page.getByText('Sync is off for this profile.', { exact: true }).waitFor();
    assert.equal(await page.locator('#recovery-key').inputValue(), '');
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => window.testCalls.some(call => call.action === 'join' && call.fields.includes('recoveryKey'))), true);
    // This fixture proves UI routing and key clearing only. It does not load
    // WebUI bindings or authenticate a native vault or password controller.
  } finally {
    await browser.close(); await new Promise(resolve => server.close(resolve));
  }
});
