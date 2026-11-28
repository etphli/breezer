import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { access, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readUpdateStatus, startUpdateWorker } from '../../features/ai/host/updater.mjs';

const dmg = 'test disk image';
const candidate = {
  commit: 'a'.repeat(40), version: 'v1.2.0',
  url: 'https://github.com/etphli/breezer/releases/download/v1.2.0/Breezer.dmg',
  size: Buffer.byteLength(dmg), sha256: createHash('sha256').update(dmg).digest('hex'),
};

async function fixture(t, failure) {
  const root = await mkdtemp(join(tmpdir(), 'breezer-update-recovery-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, 'Applications');
  const app = join(parent, 'Breezer.app');
  const lock = join(parent, '.Breezer-update.lock');
  // Written by workers from earlier releases; still read when no newer record exists.
  const statusPath = join(parent, '.Breezer-update-status.json');
  const backups = join(parent, '.Breezer-backups');
  const oldBackup = join(backups, 'Breezer-update-100.app');
  const preloader = join(root, 'mock-platform.mjs');
  const detachLog = join(root, 'detach.log');
  const gate = join(root, 'allow-download');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'version'), 'old');
  await writeFile(preloader, `
    import assert from 'node:assert/strict';
    import childProcess from 'node:child_process';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { join } from 'node:path';
    import { setTimeout } from 'node:timers/promises';

    const { candidate, dmg, failure, detachLog, gate } = ${JSON.stringify({ candidate, dmg, failure, detachLog, gate })};
    fs.statfs = async () => ({ bavail: 1024 ** 2, bsize: 4096 });
    globalThis.fetch = async () => {
      if (failure === 'concurrent') {
        const deadline = Date.now() + 15_000;
        while (!(await fs.access(gate).then(() => true, () => false))) {
          if (Date.now() >= deadline) throw new Error('Timed out waiting for the test to release the download');
          await setTimeout(20);
        }
      }
      const response = new Response(dmg);
      Object.defineProperty(response, 'url', { value: candidate.url });
      return response;
    };
    childProcess.execFile = (command, args, options, callback) => {
      (async () => {
        switch (command) {
          case '/usr/bin/hdiutil': {
            if (args[0] === 'attach') {
              const bundle = join(args[args.indexOf('-mountpoint') + 1], 'Breezer.app');
              const host = join(bundle, 'Contents/Frameworks/Breezer Framework.framework/Versions/1/Resources/breezer_ai/host');
              await fs.mkdir(host, { recursive: true });
              await fs.writeFile(join(host, 'build-identity.json'), JSON.stringify({ commit: candidate.commit }));
              await fs.writeFile(join(bundle, 'version'), 'new');
              return '';
            }
            assert.equal(args[0], 'detach');
            const force = args.includes('-force');
            await fs.appendFile(detachLog, force ? 'forced\\n' : 'normal\\n');
            if (!force && ['detach', 'verify'].includes(failure)) throw new Error('disk image busy');
            if (force && failure === 'verify') throw new Error('forced detach failed');
            await fs.rm(args[1], { recursive: true });
            return '';
          }
          case '/usr/bin/plutil':
            if (failure === 'verify') throw new Error('invalid bundle');
            return JSON.stringify({ CFBundleIdentifier: 'io.github.etphli.breezer', CFBundleExecutable: 'Breezer' });
          case '/usr/bin/ditto':
            await fs.cp(args[0], args[1], { recursive: true });
            return '';
          case '/usr/bin/codesign': return '';
          case '/usr/bin/lipo': return 'arm64';
          case '/bin/ps': return '';
          case '/usr/bin/open':
            if (failure === 'launch' && await fs.readFile(join(args[0], 'version'), 'utf8') === 'new') throw new Error('launch failed');
            return '';
          default: throw new Error('Unexpected command: ' + command);
        }
      })().then(stdout => callback(null, { stdout }), callback);
    };
    syncBuiltinESMExports();
  `);
  return {
    parent, app, lock, statusPath, backups, oldBackup, detachLog, gate,
    status: () => readUpdateStatus(parent),
    async writeOwner(pid, startedAt = Date.now()) {
      await mkdir(lock);
      await writeFile(join(lock, `owner-${randomUUID()}.json`), JSON.stringify({ pid, startedAt }));
    },
    async run() {
      let exit;
      try {
        return await startUpdateWorker(app, candidate, {
          spawnProcess(runtime, args, options) {
            const child = spawn(runtime, ['--import', preloader, ...args], {
              ...options, env: { ...process.env, HOME: root },
            });
            child.unref = () => {};
            exit = new Promise(resolve => child.once('exit', resolve));
            return child;
          },
        });
      } finally {
        await exit;
      }
    },
  };
}

for (const owner of ['dead', 'expired']) {
  test(`worker reclaims a lock with ${owner === 'dead' ? 'a dead owner' : 'an expired start time'}`, async t => {
    const update = await fixture(t);
    let pid = process.pid;
    if (owner === 'dead') {
      pid = await new Promise((resolve, reject) => {
        const child = execFile(process.execPath, ['-e', ''], error => error ? reject(error) : resolve(child.pid));
      });
      assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    }
    await update.writeOwner(pid, owner === 'expired' ? Date.now() - 2 * 60 * 60_000 : Date.now());
    await update.run();
    assert.equal((await update.status()).phase, 'installed');
    assert.equal((await readdir(update.parent)).includes('.Breezer-update.lock'), false);
  });
}

test('a live lock reports another update without overwriting its progress', async t => {
  const update = await fixture(t);
  await update.writeOwner(process.pid);
  const progress = { phase: 'downloading', notice: 'Existing download' };
  await writeFile(update.statusPath, JSON.stringify(progress));
  await assert.rejects(update.run(), /another update is already running/i);
  assert.deepEqual(await update.status(), progress);
  assert.equal((await readdir(update.parent)).some(name => name.startsWith('.breezer-update-')), false);
  assert.equal((await readdir(update.lock)).length, 1);
});

test('simultaneous workers can reclaim a stale lock only once', async t => {
  const update = await fixture(t, 'concurrent');
  await update.writeOwner(process.pid, Date.now() - 2 * 60 * 60_000);
  const attempts = [update.run(), update.run()];
  const first = await Promise.race(attempts.map(attempt => attempt.catch(error => error)));
  await writeFile(update.gate, '');
  const results = await Promise.allSettled(attempts);
  assert.match(first.message, /another update is already running/i);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal((await update.status()).phase, 'installed');
  await assert.rejects(access(update.lock), { code: 'ENOENT' });
});

test('failed detach is retried with force and staging is removed', async t => {
  const update = await fixture(t, 'detach');
  const { work } = await update.run();
  const status = await update.status();
  assert.equal(status.phase, 'failed');
  assert.match(status.notice, /disk image busy/);
  assert.equal(await readFile(update.detachLog, 'utf8'), 'normal\nforced\n');
  await assert.rejects(readdir(work), { code: 'ENOENT' });
});

test('failed forced detach preserves the original failure and removes the downloaded DMG', async t => {
  const update = await fixture(t, 'verify');
  const { work } = await update.run();
  assert.match((await update.status()).notice, /invalid bundle/);
  assert.equal(await readFile(update.detachLog, 'utf8'), 'normal\nforced\n');
  assert.deepEqual(await readdir(work), ['mount']);
});

test('a verified replacement retains only its current rollback copy', async t => {
  const update = await fixture(t);
  await mkdir(update.oldBackup, { recursive: true });
  await update.run();
  assert.equal((await update.status()).phase, 'installed');
  assert.equal(await readFile(join(update.app, 'version'), 'utf8'), 'new');
  const entries = await readdir(update.backups);
  assert.equal(entries.length, 1);
  assert.equal(await readFile(join(update.backups, entries[0], 'version'), 'utf8'), 'old');
});

test('a failed launch restores the previous app without pruning backups', async t => {
  const update = await fixture(t, 'launch');
  await mkdir(update.oldBackup, { recursive: true });
  await update.run();
  assert.match((await update.status()).notice, /launch failed/);
  assert.equal(await readFile(join(update.app, 'version'), 'utf8'), 'old');
  assert.deepEqual(await readdir(update.backups), ['Breezer-update-100.app']);
});

test('status reads beside a packaged app and skips filesystem lookup from a development host', async t => {
  const root = await mkdtemp(join(tmpdir(), 'breezer-status-path-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const realRoot = await realpath(root);
  const packaged = join(root, 'Breezer.app', 'Contents', 'host');
  const development = join(root, 'checkout', 'host');
  for (const host of [packaged, development]) {
    await mkdir(host, { recursive: true });
    await copyFile(new URL('../../features/ai/host/updater.mjs', import.meta.url), join(host, 'updater.mjs'));
  }
  await writeFile(join(root, `.Breezer-update-status-${randomUUID()}.json`), JSON.stringify({ phase: 'installed', notice: 'Done', acquiredAt: 1 }));
  const script = `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    Object.defineProperty(process, 'arch', { value: 'arm64' });
    const modules = await Promise.all(${JSON.stringify([packaged, development].map(host => pathToFileURL(join(host, 'updater.mjs')).href))}.map(url => import(url)));
    const paths = [];
    const realReaddir = fs.readdir;
    fs.readdir = async (path, ...rest) => { paths.push(path); return realReaddir(path, ...rest); };
    syncBuiltinESMExports();
    const messages = [];
    for (const { UpdateController } of modules) {
      await new UpdateController(message => messages.push(message)).receive({ type: 'update-status' });
    }
    assert.deepEqual(paths, [${JSON.stringify(realRoot)}, ${JSON.stringify(join(realRoot, '.Breezer-update.lock'))}]);
    assert.deepEqual(messages.map(message => message.value), [{ phase: 'installed', notice: 'Done' }, {}]);
  `;
  await new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], error => error ? reject(error) : resolve());
  });
});
