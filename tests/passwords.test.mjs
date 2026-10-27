import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPasswordActions, PASSWORD_ROUTES } from '../features/ai/extension/passwords.js';

test('password actions open pinned native pages in Breezer, without reading credentials', async () => {
  const calls = [];
  const api = new Proxy({ tabs: { async create(options) { calls.push(options); return { id: 7 }; } } }, {
    get(target, property) {
      assert.equal(property, 'tabs', 'only the tabs API is needed');
      return target[property];
    },
  });
  const actions = createPasswordActions({ api });
  for (const destination of ['manager', 'settings', 'import', 'browserImport']) await actions.open(destination);
  assert.deepEqual(calls, [
    { url: 'chrome://password-manager/passwords', active: true },
    { url: 'chrome://password-manager/settings', active: true },
    { url: 'chrome://password-manager/settings?import=true', active: true },
    { url: 'chrome://settings/importData', active: true },
  ]);
  assert.equal(PASSWORD_ROUTES.import, calls[2].url);
});

test('no arbitrary URL or inherited object property can become a password destination', async () => {
  const calls = [];
  const actions = createPasswordActions({ api: { tabs: { create: async (value) => calls.push(value) } } });
  for (const destination of ['https://example.test', 'toString', '__proto__', '']) {
    await assert.rejects(actions.open(destination), /Unknown password page/);
  }
  assert.equal(calls.length, 0);
});

test('unavailable integration and rejected tab opens fail without claiming import success', async () => {
  await assert.rejects(createPasswordActions({ api: null }).open('import'), /Open this page in Breezer/);
  const actions = createPasswordActions({ api: { tabs: { create: async () => { throw new Error('blocked'); } } } });
  await assert.rejects(actions.open('import'), /blocked/);
});

test('runtime fixture contains only one explicit dummy credential', async () => {
  const fixture = await readFile(new URL('./passwords/dummy.csv', import.meta.url), 'utf8');
  assert.equal(fixture, 'name,url,username,password,note\nBreezer dummy,http://localhost:8765/passwords-fixture,dummy@example.test,Breezer-test-only-123!,Disposable test fixture only\n');
});
