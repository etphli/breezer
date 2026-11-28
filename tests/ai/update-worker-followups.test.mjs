import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readUpdateStatus, startUpdateWorker } from '../../features/ai/host/updater.mjs';

const dmg = 'test disk image';
const candidate = {
  commit: 'b'.repeat(40), version: 'v1.3.7',
  url: 'https://github.com/etphli/breezer/releases/download/v1.3.7/Breezer.dmg',
  size: Buffer.byteLength(dmg), sha256: createHash('sha256').update(dmg).digest('hex'),
};

// Everything macOS-specific is mocked; nothing outside the temporary root is touched.
async function fixture(t, options = {}) {
  const root = await mkdtemp(join(tmpdir(), 'breezer-update-followups-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const parent = join(root, 'Applications');
  const app = join(parent, 'Breezer.app');
  const lock = join(parent, '.Breezer-update.lock');
  const successorStatus = join(parent, '.Breezer-update-status-00000000-0000-0000-0000-000000000000.json');
  const detachLog = join(root, 'detach.log');
  const staleMount = join(parent, '.breezer-update-OLD001', 'mount');
  await mkdir(app, { recursive: true });
  await writeFile(join(app, 'version'), 'old');
  const preloader = join(root, 'mock-platform.mjs');
  await writeFile(preloader, `
    import childProcess from 'node:child_process';
    import fs from 'node:fs/promises';
    import { syncBuiltinESMExports } from 'node:module';
    import { basename, join } from 'node:path';
    const { candidate, dmg, lock, detachLog, staleMount, takeover, processStart, successorStatus } = ${JSON.stringify({ candidate, dmg, lock, detachLog, staleMount, successorStatus, ...options })};
    const successorId = '00000000-0000-0000-0000-000000000000';
    const reclaim = async () => {
      await fs.rm(lock, { recursive: true, force: true });
      await fs.mkdir(lock);
      await fs.writeFile(join(lock, 'owner-' + successorId + '.json'), JSON.stringify({ pid: process.ppid, startedAt: Date.now() }));
    };
    let reclaimed = false;
    const realRename = fs.rename;
    fs.rename = async (from, to) => {
      // The successor publishes its progress between this worker's checks and its write.
      if (takeover === 'race' && reclaimed && basename(to).startsWith('.Breezer-update-status')) {
        await fs.writeFile(successorStatus, JSON.stringify({ phase: 'downloading', notice: 'Successor', worker: '.breezer-update-SUCCESSOR', acquiredAt: Date.now() }));
      }
      return realRename(from, to);
    };
    let staleMounted = true;
    const realLstat = fs.lstat;
    fs.lstat = async (path, ...rest) => {
      const info = await realLstat(path, ...rest);
      if (path === staleMount && staleMounted) Object.defineProperty(info, 'dev', { value: info.dev + 1 });
      return info;
    };
    fs.statfs = async () => ({ bavail: 1024 ** 2, bsize: 4096 });
    globalThis.fetch = async () => {
      if (takeover === true || takeover === 'race') {
        // Another worker reclaims the lock while this one downloads.
        await reclaim(); reclaimed = true;
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
            await fs.appendFile(detachLog, args.join(' ') + '\\n');
            if (args[1] === staleMount) { staleMounted = false; return ''; }
            await fs.rm(args[1], { recursive: true });
            return '';
          }
          case '/usr/bin/plutil': return JSON.stringify({ CFBundleIdentifier: 'io.github.etphli.breezer', CFBundleExecutable: 'Breezer' });
          case '/usr/bin/ditto': await fs.cp(args[0], args[1], { recursive: true }); return '';
          case '/usr/bin/codesign': return '';
          case '/usr/bin/lipo': return 'arm64';
          case '/bin/ps':
            if (args.includes('lstart=')) return processStart === undefined ? '' : new Date(processStart).toString();
            return '';
          case '/usr/bin/open':
            // Another worker reclaims the lock after the new app has launched.
            if (takeover === 'after-launch' && await fs.readFile(join(args[0], 'version'), 'utf8') === 'new') await reclaim();
            return '';
          default: throw new Error('Unexpected command: ' + command);
        }
      })().then(stdout => callback(null, { stdout }), callback);
    };
    syncBuiltinESMExports();
  `);
  return {
    root, parent, app, lock, detachLog, staleMount,
    status: () => readUpdateStatus(parent),
    async writeOwner(pid, startedAt) {
      await mkdir(lock);
      await writeFile(join(lock, `owner-${randomUUID()}.json`), JSON.stringify({ pid, startedAt }));
    },
    async run() {
      let exit;
      try {
        return await startUpdateWorker(app, candidate, {
          spawnProcess(runtime, args, spawnOptions) {
            const child = spawn(runtime, ['--import', preloader, ...args], { ...spawnOptions, env: { ...process.env, HOME: root } });
            child.unref = () => {};
            exit = new Promise(resolve => child.once('exit', resolve));
            return child;
          },
        });
      } finally { await exit; }
    },
  };
}

test('losing the lock mid-update still records a terminal failed phase', async t => {
  const update = await fixture(t, { takeover: true });
  await update.run();
  const status = await update.status();
  assert.equal(status.phase, 'failed');
  assert.equal(status.version, candidate.version);
});

test('a worker that lost its lock never overwrites its successor\'s status', async t => {
  const update = await fixture(t, { takeover: 'race' });
  await update.run();
  const status = await update.status();
  assert.equal(status.phase, 'downloading');
  assert.equal(status.notice, 'Successor');
});

test('losing the lock after a successful replacement still reports installed', async t => {
  const update = await fixture(t, { takeover: 'after-launch' });
  await update.run();
  assert.equal(await readFile(join(update.app, 'version'), 'utf8'), 'new');
  assert.equal((await update.status()).phase, 'installed');
});

test('a live lock owner is kept even after the age limit, when its start time matches', async t => {
  const startedAt = Date.now() - 2 * 60 * 60_000;
  const update = await fixture(t, { processStart: startedAt - 60_000 });
  await update.writeOwner(process.pid, startedAt);
  await assert.rejects(update.run(), /another update is already running/i);
  assert.equal((await readdir(update.lock)).length, 1);
});

test('a live PID that started after the lock was taken is a reused PID and is reclaimed', async t => {
  const startedAt = Date.now() - 5 * 60_000;
  const update = await fixture(t, { processStart: Date.now() - 60_000 });
  await update.writeOwner(process.pid, startedAt);
  await update.run();
  assert.equal((await update.status()).phase, 'installed');
});

test('a startup error before acknowledgement reports its real cause', async t => {
  const update = await fixture(t);
  await writeFile(update.lock, 'not a directory');
  await assert.rejects(update.run(), error => /Invalid update lock/.test(error.message) && !/macOS may have blocked/.test(error.message));
});

test('leftover staging from earlier runs is detached and removed without following links', async t => {
  const update = await fixture(t);
  const old = Date.now() / 1000 - 3600;
  const stale = join(update.parent, '.breezer-update-OLD001');
  await mkdir(update.staleMount, { recursive: true });
  await writeFile(join(stale, 'update.dmg'), 'leftover');
  await utimes(stale, old, old);
  const plain = join(update.parent, '.breezer-update-OLD002');
  await mkdir(plain);
  await writeFile(join(plain, 'update.dmg'), 'leftover');
  await utimes(plain, old, old);
  const recent = join(update.parent, '.breezer-update-NEW001');
  await mkdir(recent);
  const outside = join(update.root, 'outside');
  await mkdir(outside);
  await writeFile(join(outside, 'keep'), 'keep');
  const link = join(update.parent, '.breezer-update-LINK01');
  await symlink(outside, link);
  const unrelated = join(update.parent, 'breezer-update-notes');
  await mkdir(unrelated);
  await utimes(unrelated, old, old);

  await update.run();
  assert.equal((await update.status()).phase, 'installed');
  assert.match(await readFile(update.detachLog, 'utf8'), new RegExp(`detach ${update.staleMount} -force`));
  for (const gone of [stale, plain]) await assert.rejects(lstat(gone), { code: 'ENOENT' });
  for (const kept of [recent, unrelated]) assert.ok((await lstat(kept)).isDirectory());
  assert.ok((await lstat(link)).isSymbolicLink());
  assert.equal(await readFile(join(outside, 'keep'), 'utf8'), 'keep');
});

test('backup pruning keeps manual build_and_run.sh backups', async t => {
  const update = await fixture(t);
  const backups = join(update.parent, '.Breezer-backups');
  await mkdir(join(backups, 'Breezer-update-100.app'), { recursive: true });
  await mkdir(join(backups, 'Breezer-20261101-101010.app'));
  await update.run();
  assert.equal((await update.status()).phase, 'installed');
  const entries = (await readdir(backups)).sort();
  assert.equal(entries.length, 2);
  assert.ok(entries.includes('Breezer-20261101-101010.app'));
  assert.ok(!entries.includes('Breezer-update-100.app'));
});

test('status follows the lock owner, then the worker that acquired the lock last', async t => {
  const root = await mkdtemp(join(tmpdir(), 'breezer-update-status-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [older, newer] = [randomUUID(), randomUUID()];
  const record = (id, value) => writeFile(join(root, `.Breezer-update-status-${id}.json`), JSON.stringify(value));
  await writeFile(join(root, '.Breezer-update-status.json'), JSON.stringify({ phase: 'downloading', notice: 'Legacy' }));
  // The older worker lost the lock and wrote its failure after the newer worker finished.
  await record(newer, { phase: 'installed', notice: 'New', acquiredAt: 2, updatedAt: 3 });
  await record(older, { phase: 'failed', notice: 'Old', acquiredAt: 1, updatedAt: 4 });
  assert.deepEqual(await readUpdateStatus(root), { phase: 'installed', notice: 'New', updatedAt: 3 });
  await mkdir(join(root, '.Breezer-update.lock'));
  await writeFile(join(root, '.Breezer-update.lock', `owner-${older}.json`), '{}');
  assert.equal((await readUpdateStatus(root)).notice, 'Old');
});
