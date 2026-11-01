import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { randomUUID, randomBytes } from 'node:crypto';
import { installTestProvider } from '../../features/sync/test-provider/extension/provider.js';

class Event {
  listeners = new Set();
  addListener = listener => this.listeners.add(listener);
  removeListener = listener => this.listeners.delete(listener);
  emit = value => { for (const listener of this.listeners) listener(value); };
}
function client(root, token, fetchImpl = fetch) {
  const events = ['Configure', 'ListVaults', 'CreateVault', 'ReadObject', 'WriteObject', 'RenameVault', 'CollectEpochs', 'Cancel'];
  const api = { storage: { local: { get: async () => ({ testProviderToken: token }) } }, syncVaultProvider: {} };
  for (const name of events) api.syncVaultProvider[`on${name}Requested`] = new Event();
  let serial = 0;
  const waiting = new Map();
  api.syncVaultProvider.respond = async response => {
    const done = waiting.get(response.requestId);
    waiting.delete(response.requestId);
    done?.(response);
  };
  const provider = installTestProvider({ api, fetchImpl: (url, options) => fetchImpl(String(url).replace('http://127.0.0.1:18765', root), options) });
  return {
    api, dispose: () => provider.dispose(),
    request(name, data = {}) {
      const requestId = ++serial;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`Provider request ${name} timed out`)), 10000);
        waiting.set(requestId, response => { clearTimeout(timer); resolve(response); });
        api.syncVaultProvider[`on${name}Requested`].emit({ requestId, ...data });
      });
    },
  };
}
async function launch(directory, resume = false) {
  const server = spawn('python3', ['-u', 'features/sync/test-provider/server.py', '--directory', directory, '--port', '0', ...(resume ? ['--resume'] : [])], { stdio: ['ignore', 'pipe', 'pipe'] });
  const root = await new Promise((resolve, reject) => {
    let output = '';
    const timeout = setTimeout(() => reject(new Error('Test server did not start')), 10000);
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Test server exited with ${code}`)); });
    server.stdout.on('data', chunk => {
      output += chunk;
      const found = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (found) { clearTimeout(timeout); resolve(found[0]); }
    });
  });
  return { root, stop: async () => { if (server.exitCode !== null) return; const exit = once(server, 'exit'); server.kill('SIGINT'); await exit; } };
}

test('two independent provider clients enforce CAS, preserve opaque bytes and reconnect after server restart', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'breezer-sync-provider-'));
  let server = await launch(directory);
  const token = await readFile(join(directory, 'provider-token.txt'), 'utf8');
  const clients = [];
  t.after(async () => { clients.forEach(c => c.dispose()); await server.stop(); await rm(directory, { recursive: true, force: true }); });
  const a = client(server.root, token), b = client(server.root, token);
  clients.push(a, b);
  assert.deepEqual((await a.request('Configure')).success, { configurationState: 'READY' });
  assert.deepEqual((await b.request('Configure')).success, { configurationState: 'READY' });
  const vaultUuid = randomUUID();
  assert.deepEqual((await a.request('CreateVault', { vaultUuid, displayName: 'Disposable vault' })).success, {});
  assert.deepEqual((await b.request('CreateVault', { vaultUuid, displayName: 'Same identity' })).success, {});
  const vaults = (await a.request('ListVaults')).success.vaults;
  assert.deepEqual(vaults, [{ vaultUuid, displayName: 'Disposable vault' }]);
  const initial = new Uint8Array(randomBytes(64));
  const base = { vaultUuid, objectId: 'head', data: initial.buffer };
  const first = await a.request('WriteObject', base);
  assert.ok(first.success.revision);
  assert.equal((await b.request('WriteObject', base)).failure.error, 'CONFLICT');
  const alpha = new Uint8Array(randomBytes(128)), beta = new Uint8Array(randomBytes(128));
  const writes = await Promise.all([
    a.request('WriteObject', { ...base, expectedRevision: first.success.revision, data: alpha.buffer }),
    b.request('WriteObject', { ...base, expectedRevision: first.success.revision, data: beta.buffer }),
  ]);
  assert.equal(writes.filter(result => result.success).length, 1);
  assert.equal(writes.filter(result => result.failure?.error === 'CONFLICT').length, 1);
  const winner = writes[0].success ? alpha : beta;
  const stored = (await b.request('ReadObject', { vaultUuid, objectId: 'head', maxBytes: 1024 })).success;
  assert.deepEqual(new Uint8Array(stored.data), winner);
  assert.equal(stored.revision, (writes[0].success || writes[1].success).revision);
  assert.equal((await a.request('ReadObject', { vaultUuid, objectId: 'absent', maxBytes: 1024 })).failure.error, 'NOT_FOUND');
  assert.equal((await a.request('ReadObject', { vaultUuid, objectId: 'head', maxBytes: 1 })).failure.error, 'INVALID_DATA');
  const beforeRestart = stored.revision;
  await server.stop();
  assert.equal((await a.request('Configure')).failure.error, 'NETWORK_ERROR');
  server = await launch(directory, true);
  const c = client(server.root, token); clients.push(c);
  const reloaded = (await c.request('ReadObject', { vaultUuid, objectId: 'head', maxBytes: 1024 })).success;
  assert.deepEqual(new Uint8Array(reloaded.data), winner);
  assert.equal(reloaded.revision, beforeRestart);
  assert.equal((await stat(join(directory, 'ciphertext.sqlite'))).mode & 0o077, 0);
  assert.equal((await stat(join(directory, 'provider-token.txt'))).mode & 0o077, 0);
  const unauthorized = client(server.root, 'wrong-test-token'); clients.push(unauthorized);
  assert.equal((await unauthorized.request('Configure')).failure.error, 'AUTH_REQUIRED');
  const response = await fetch(`${server.root}/v1/vaults/${vaultUuid}/objects/head`, { method: 'PUT', headers: { Authorization: `Bearer ${token}` }, body: 'No conditional revision' });
  assert.equal(response.status, 400);
});

test('provider permission, key boundaries, and native enum spellings match imported API', async () => {
  const manifest = JSON.parse(await readFile('features/sync/test-provider/extension/manifest.json', 'utf8'));
  assert.deepEqual(manifest.permissions, ['syncVaultProvider', 'storage']);
  assert.deepEqual(manifest.host_permissions, ['http://127.0.0.1:18765/*']);
  assert.equal(manifest.sync_vault_provider.api_version, 1);
  assert.ok(!manifest.sync_vault_provider.account_key);
  const source = await readFile('features/sync/test-provider/extension/provider.js', 'utf8');
  assert.doesNotMatch(source, /vaultKey|keyEnvelope|passwordsPrivate|WrapKeyRequested|UnwrapKeyRequested/);
  const native = await readFile('features/sync/native/chrome/browser/sync/breezer_sync/provider_transport.cc', 'utf8');
  const schema = await readFile('upstream/helium-macos/helium-chromium/patches/helium/core/sync/provider/api.patch', 'utf8');
  for (const [, value] of native.matchAll(/api::SyncVaultProviderError::k([A-Za-z]+)/g)) {
    const schemaValue = value.replace(/[A-Z]/g, (letter, at) => `${at ? '_' : ''}${letter}`).toUpperCase();
    assert.ok(schema.includes(`"${schemaValue}"`), `Native error ${value} is absent from provider schema`);
  }
});

test('cancel and dispose abort in-flight provider work without stale replies', async () => {
  const replies = [];
  const api = { storage: { local: { get: async () => ({ testProviderToken: 'synthetic-disposable-test-token' }) } }, syncVaultProvider: {} };
  for (const name of ['Configure', 'ListVaults', 'CreateVault', 'ReadObject', 'WriteObject', 'RenameVault', 'CollectEpochs', 'Cancel']) api.syncVaultProvider[`on${name}Requested`] = new Event();
  api.syncVaultProvider.respond = async response => { replies.push(response); };
  let signal;
  const provider = installTestProvider({ api, fetchImpl: async (_url, options) => {
    signal = options.signal;
    return new Promise((_resolve, reject) => {
      if (signal.aborted) reject(new Error('Aborted'));
      else signal.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
    });
  } });
  api.syncVaultProvider.onConfigureRequested.emit({ requestId: 10 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  api.syncVaultProvider.onCancelRequested.emit({ requestId: 10 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.deepEqual(replies, []);
  api.syncVaultProvider.onConfigureRequested.emit({ requestId: 11 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, false);
  provider.dispose();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(signal.aborted, true);
  assert.deepEqual(replies, []);
  for (const [name, event] of Object.entries(api.syncVaultProvider)) if (name.startsWith('on')) assert.equal(event.listeners.size, 0);
});
