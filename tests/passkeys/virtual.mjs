// Browser protocol check in a disposable profile. The CDP authenticator is a fake,
// not evidence of native platform authentication, storage, management or sync.
import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || '../ai/node_modules/playwright/index.mjs');
const evidence = resolve(process.env.BREEZER_PASSKEY_EVIDENCE || 'build/passkeys/virtual');
await mkdir(evidence, { recursive: true });
const server = createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  if (!['/webauthn.html', '/webauthn.js'].includes(path)) return res.writeHead(404).end();
  res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : 'text/html');
  res.end(await readFile(new URL(`.${path}`, import.meta.url)));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://localhost:${server.address().port}`;
const report = { checks: [], limitations: ['CDP virtual authenticator only; no biometric, Keychain, iCloud, physical key or phone acceptance.', 'Deletion uses the virtual authenticator API, not the Mac native manager.'], browser: {} };
let browser;
try {
  const executablePath = process.env.BREEZER_TEST_BROWSER;
  browser = await chromium.launch({ executablePath, headless: true });
  report.browser = { version: browser.version(), executable: executablePath || 'Playwright Chromium' };
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', { options: {
    protocol: 'ctap2', transport: 'internal', hasResidentKey: true,
    hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
  } });
  await page.goto(`${base}/webauthn.html`);
  const registration = await page.evaluate(() => passkeyFixture.create());
  const client = JSON.parse(Buffer.from(registration.clientData));
  assert.equal(client.type, 'webauthn.create');
  assert.equal(client.origin, base);
  assert.equal(client.challenge, Buffer.from(registration.challenge).toString('base64url'));
  const publicKey = createPublicKey({ key: Buffer.from(registration.publicKey), type: 'spki', format: 'der' });
  report.checks.push('resident passkey creation with required user verification');
  const assertion = await page.evaluate(() => passkeyFixture.use());
  assert.equal(assertion.id, registration.id);
  const authData = Buffer.from(assertion.authenticatorData);
  assert.deepEqual(authData.subarray(0, 32), createHash('sha256').update('localhost').digest());
  assert.equal(authData[32] & 5, 5, 'user presence and verification flags');
  const assertionClient = JSON.parse(Buffer.from(assertion.clientData));
  assert.equal(assertionClient.type, 'webauthn.get');
  assert.equal(assertionClient.origin, base);
  assert.equal(assertionClient.challenge, Buffer.from(assertion.challenge).toString('base64url'));
  const signed = Buffer.concat([authData, createHash('sha256').update(Buffer.from(assertion.clientData)).digest()]);
  assert.ok(verify('sha256', signed, publicKey, Buffer.from(assertion.signature)), 'signature verifies with registered public key');
  report.checks.push('sign-in signature, challenge, origin, RP hash and UP/UV flags verified');
  for (const operation of ['create', 'use']) {
    const error = await page.evaluate(async operation => {
      try {
        await (operation === 'create' ? passkeyFixture.create('127.0.0.1') : passkeyFixture.use({ rpId: '127.0.0.1' }));
        return 'unexpected success';
      } catch (e) { return e.name; }
    }, operation);
    assert.equal(error, 'SecurityError');
  }
  report.checks.push('wrong RP rejected for creation and assertion');
  // Moving to a different trustworthy origin must not allow localhost's RP.
  await page.goto(`http://127.0.0.1:${server.address().port}/webauthn.html`);
  assert.equal(await page.evaluate(async () => {
    try { await passkeyFixture.use({ rpId: 'localhost', id: [1] }); return 'unexpected success'; }
    catch (e) { return e.name; }
  }), 'SecurityError');
  report.checks.push('different origin cannot request localhost RP');
  await page.goto(`${base}/webauthn.html`);
  for (const operation of ['create', 'use', 'conditional']) {
    await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: false });
    const error = await page.evaluate(async ({ operation, id }) => {
      const result = (operation === 'create' ? passkeyFixture.create() : passkeyFixture.use({ id, conditional: operation === 'conditional' }))
        .then(() => 'unexpected success', error => error.name);
      setTimeout(() => passkeyFixture.cancel(), 100);
      return result;
    }, { operation, id: registration.rawId });
    assert.equal(error, 'AbortError');
  }
  report.checks.push('creation, sign-in and pending conditional-autofill cancellation');
  await cdp.send('WebAuthn.setAutomaticPresenceSimulation', { authenticatorId, enabled: true });
  const afterCancel = await page.evaluate(id => passkeyFixture.use({ id }), registration.rawId);
  assert.equal(afterCancel.id, registration.id, 'cancelled create must preserve original credential');
  // Never call getCredentials: it would export virtual private keys.
  await cdp.send('WebAuthn.removeCredential', { authenticatorId, credentialId: Buffer.from(registration.rawId).toString('base64') });
  const afterDelete = await page.evaluate(async id => {
    const result = passkeyFixture.use({ id }).then(() => 'unexpected success', error => error.name);
    setTimeout(() => passkeyFixture.cancel(), 200);
    return result;
  }, registration.rawId);
  assert.ok(['AbortError', 'NotAllowedError'].includes(afterDelete));
  report.checks.push('virtual credential deletion prevents subsequent use');
  await page.screenshot({ path: `${evidence}/disposable-webauthn.png` });
  await cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId });
  report.status = 'passed';
} catch (error) {
  report.status = 'failed'; report.error = error.message; process.exitCode = 1;
} finally {
  await browser?.close();
  await new Promise(done => server.close(done));
  await writeFile(`${evidence}/result.json`, JSON.stringify(report, null, 2) + '\n');
}
console.log(JSON.stringify(report, null, 2));
