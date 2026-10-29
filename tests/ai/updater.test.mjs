import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkRelease, validateManifest } from '../../features/ai/host/updater.mjs';
import { replaceApp } from '../../features/ai/host/update-worker.mjs';
const commit = 'a'.repeat(40), next = 'b'.repeat(40);
const manifest = { schema: 1, platform: 'darwin-arm64', commit: next, sha256: 'c'.repeat(64), asset: 'Breezer-arm64.dmg' };
const release = { tag_name: 'v1.2.0', assets: [
  { name: 'breezer-update.json', browser_download_url: 'https://github.com/etphli/breezer/releases/download/v1.2.0/breezer-update.json' },
  { name: manifest.asset, browser_download_url: 'https://github.com/etphli/breezer/releases/download/v1.2.0/Breezer-arm64.dmg', size: 1234, digest: 'sha256:' + manifest.sha256 },
] };
const fetchJSON = status => async url => url.endsWith('/latest') ? release : url.endsWith('.json') ? manifest : { status };
test('offers only a stable descendant release, not older or diverged commits', async () => {
  assert.equal((await checkRelease({ commit }, fetchJSON('ahead'))).available, true);
  for (const status of ['behind', 'identical', 'diverged']) assert.equal((await checkRelease({ commit }, fetchJSON(status))).available, false);
  assert.equal((await checkRelease({ commit: next }, fetchJSON('ahead'))).available, false);
});
test('rejects missing identity, prereleases, untrusted assets, checksum conflicts and wrong architecture', async () => {
  await assert.rejects(checkRelease({}, fetchJSON('ahead')), /identity/);
  await assert.rejects(checkRelease({ commit }, async () => ({ ...release, prerelease: true })), /stable/);
  for (const patch of [{ platform: 'linux' }, { sha256: 'd'.repeat(64) }, { asset: '../Breezer.dmg' }, { commit: 'main' }]) assert.throws(() => validateManifest({ ...manifest, ...patch }, release));
  const bad = structuredClone(release); bad.assets[1].browser_download_url = 'https://evil.test/Breezer.dmg';
  assert.throws(() => validateManifest(manifest, bad));
});
test('older releases without metadata explain why update cannot proceed', async () => {
  const value = await checkRelease({ commit }, async () => ({ ...release, assets: [] }));
  assert.equal(value.available, false); assert.match(value.notice, /does not support/);
});
for (const failure of ['verify', 'launch', null]) test(`transaction keeps profile and ${failure ? 'rolls back after ' + failure : 'retains old app backup'}`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'breezer-updater-test-'));
  try {
    const app = join(root, 'Breezer.app'), staged = join(root, 'staged.app'), backup = join(root, 'backup.app');
    await mkdir(app); await mkdir(staged); await writeFile(join(app, 'version'), 'old'); await writeFile(join(staged, 'version'), 'new'); await writeFile(join(root, 'profile'), 'private');
    const verify = async () => { if (failure === 'verify') throw new Error('verify failed'); };
    const launch = async path => { if (failure === 'launch' && await readFile(join(path, 'version'), 'utf8') === 'new') throw new Error('launch failed'); };
    const operation = replaceApp(staged, app, backup, verify, launch);
    if (failure) await assert.rejects(operation); else await operation;
    assert.equal(await readFile(join(app, 'version'), 'utf8'), failure ? 'old' : 'new');
    assert.equal(await readFile(join(root, 'profile'), 'utf8'), 'private');
    if (!failure) assert.equal(await readFile(join(backup, 'version'), 'utf8'), 'old');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('update settings require an explicit install click and show helper errors', async () => {
  const { readFileSync } = await import('node:fs');
  const { createDom, userClick } = await import('./settings-dom.mjs');
  const { event } = await import('./browser-api-fixture.mjs');
  const { mountUpdates } = await import('../../features/ai/extension/settings.js');
  const dom = createDom(readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8'));
  Object.assign(globalThis, dom.globals);
  globalThis.window = globalThis;
  const sent = [], port = { onMessage: event(), onDisconnect: event(), postMessage: message => sent.push(message), disconnect() {} };
  const mounted = mountUpdates({ runtime: { connect: () => port } });
  try {
    assert.equal(sent[0].type, 'update-check');
    port.onMessage.emit({ id: sent[0].id, ok: true, value: { available: true, version: 'v1.2.0' } });
    const button = dom.document.getElementById('update-install');
    assert.equal(button.hidden, false); assert.equal(sent.length, 1);
    userClick(button); assert.equal(sent[1].type, 'update-install');
    port.onMessage.emit({ id: sent[1].id, ok: false, error: 'Checksum mismatch' });
    assert.match(dom.document.getElementById('update-status').textContent, /Checksum mismatch/);
  } finally { mounted.dispose(); }
});
