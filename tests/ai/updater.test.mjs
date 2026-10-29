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

test('handoff reuses the existing runtime and waits for the worker to acknowledge startup', async () => {
  const { startUpdateWorker } = await import('../../features/ai/host/updater.mjs');
  const { readdir, stat } = await import('node:fs/promises');
  const { spawn } = await import('node:child_process');
  const root = await mkdtemp(join(tmpdir(), 'breezer-handoff-'));
  try {
    const host = join(root, 'host'); await mkdir(host);
    await writeFile(join(host, 'update-worker.mjs'), `import {writeFile} from 'node:fs/promises';\nawait writeFile(process.argv[2]+'/runtime.json',JSON.stringify({runtime:process.execPath}));\nprocess.send({type:'update-worker-ready'});\nprocess.on('disconnect',()=>process.exit(0));`);
    let command;
    const { work } = await startUpdateWorker(join(root, 'Breezer.app'), manifest, {
      host, spawnProcess: (runtime, args, options) => { command = runtime; return spawn(runtime, args, options); },
    });
    assert.equal(command, process.execPath);
    assert.equal(JSON.parse(await readFile(join(work, 'runtime.json'), 'utf8')).runtime, process.execPath);
    assert.equal((await readdir(work)).includes('node'), false, 'no executable copy can acquire a new quarantine flag');
    assert.equal((await stat(join(work, 'request.json'))).mode & 0o777, 0o600);
  } finally { await rm(root, { recursive: true, force: true }); }
});

for (const behavior of ['exit', 'silent']) test(`worker ${behavior} cannot be reported as a successful handoff`, async () => {
  const { startUpdateWorker } = await import('../../features/ai/host/updater.mjs');
  const { readdir } = await import('node:fs/promises');
  const root = await mkdtemp(join(tmpdir(), 'breezer-handoff-failure-'));
  try {
    const host = join(root, 'host'); await mkdir(host);
    await writeFile(join(host, 'update-worker.mjs'), behavior === 'exit' ? 'process.exit(23);' : 'setInterval(()=>{},1000);');
    await assert.rejects(startUpdateWorker(join(root, 'Breezer.app'), manifest, { host, startupTimeoutMs: behavior === 'exit' ? 3000 : 150 }), /helper (?:stopped|did not start)/);
    assert.deepEqual(await readdir(root), ['host'], 'failed handoff staging is removed');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('the running worker survives replacement and deletion of its original runtime path', async () => {
  const { startUpdateWorker } = await import('../../features/ai/host/updater.mjs');
  const { copyFile, chmod, rename } = await import('node:fs/promises');
  // macOS can reject executable copies under its per-user temporary folder.
  const { fileURLToPath } = await import('node:url');
  const fixtureRoot = fileURLToPath(new URL('../../build/', import.meta.url)); await mkdir(fixtureRoot, { recursive: true });
  const root = await mkdtemp(join(fixtureRoot, 'breezer-runtime-lifetime-'));
  try {
    const app = join(root, 'runtime-directory'), host = join(root, 'host'), marker = join(root, 'completed');
    await mkdir(app); await mkdir(host);
    const runtime = join(app, 'node'); await copyFile(process.execPath, runtime); await chmod(runtime, 0o700);
    await writeFile(join(host, 'update-worker.mjs'), `import {writeFile} from 'node:fs/promises';\nprocess.on('disconnect',async()=>{await new Promise(r=>setTimeout(r,250));await writeFile(${JSON.stringify(marker)},'alive');});\nprocess.send({type:'update-worker-ready'});`);
    await startUpdateWorker(app, manifest, { host, runtime });
    await rename(app, app + '.old'); await mkdir(app); await rm(app + '.old', { recursive: true });
    const until = Date.now() + 3000;
    let result;
    while (Date.now() < until) {
      try { result = await readFile(marker, 'utf8'); break; } catch {}
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.equal(result, 'alive');
  } finally { await rm(root, { recursive: true, force: true }); }
});
