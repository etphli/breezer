import { readFile, writeFile, mkdir, rm, rmdir, unlink, rename, lstat, readdir, realpath, statfs } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
const exec = promisify(execFile);
const run = async (cmd, args) => (await exec(cmd, args, { timeout: 120_000, maxBuffer: 4 * 1024 ** 2 })).stdout;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// The download can take 15 minutes, followed by several timed macOS commands.
const lockMaxAge = 60 * 60_000;
const ownerName = /^owner-[a-f0-9-]+\.json$/;
const backupName = /^Breezer-(?:update-\d+(?:-[a-f0-9-]+)?|\d{8}-\d{6}(?:-[a-f0-9]{8})?)\.app$/;

function pidIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}

async function releaseLock(owner) {
  try {
    await unlink(owner);
    await rmdir(dirname(owner));
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
  }
}

async function acquireLock(work, lock) {
  const prepared = join(work, 'lock');
  const name = `owner-${randomUUID()}.json`;
  await mkdir(prepared, { mode: 0o700 });
  await writeFile(join(prepared, name), JSON.stringify({ pid: process.pid, startedAt: Date.now() }), { mode: 0o600 });

  while (true) {
    try {
      const info = await lstat(lock);
      if (!info.isDirectory()) throw new Error('Invalid update lock.');
      const entries = await readdir(lock);
      if (entries.length === 1 && ownerName.test(entries[0])) {
        const owner = join(lock, entries[0]);
        const raw = await readFile(owner, 'utf8');
        let record;
        try { record = JSON.parse(raw); } catch {}
        const startedAt = Number.isFinite(record?.startedAt) ? record.startedAt : info.mtimeMs;
        const pid = record?.pid;
        const dead = Number.isInteger(pid) && pid > 0 && pid <= 0x7fffffff && !pidIsAlive(pid);
        if (!dead && Date.now() - startedAt < lockMaxAge) return null;
        await releaseLock(owner);
      } else {
        // Older versions created an empty directory with no way to check its owner.
        if (entries.length || Date.now() - info.birthtimeMs < lockMaxAge) return null;
        await rmdir(lock);
      }
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }

    // Publish the owner and directory together. A competing worker cannot rename
    // over a populated lock or remove it using a previous owner's unique name.
    try {
      await rename(prepared, lock);
      return join(lock, name);
    } catch (error) {
      if (!['ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
}

function detach(mount, force = false) {
  return run('/usr/bin/hdiutil', force ? ['detach', mount, '-force'] : ['detach', mount]);
}

async function cleanStaging(work, mount, mounted, detachAttempted) {
  if (mounted) {
    try {
      if (detachAttempted) await detach(mount, true);
      else await detach(mount).catch(() => detach(mount, true));
    } catch {
      // If the volume is still mounted, leave the mount point alone and free the download.
      const entries = await readdir(work);
      await Promise.all(entries.filter(name => name !== basename(mount))
        .map(name => rm(join(work, name), { recursive: true, force: true })));
      await rmdir(mount).catch(() => {});
      await rmdir(work).catch(() => {});
      return;
    }
  }
  await rm(work, { recursive: true, force: true });
}

export async function verifyBundle(app, commit) {
  if ((await lstat(app)).isSymbolicLink()) throw new Error('The update app must not be a symlink.');
  const root = await realpath(app);
  async function inspect(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const target = join(path, entry.name);
      if (entry.isSymbolicLink()) { if (!(await realpath(target)).startsWith(root + '/')) throw new Error('Unsafe link in update app.'); }
      else if (entry.isDirectory()) await inspect(target);
    }
  }
  await inspect(app);
  const info = JSON.parse(await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')]));
  if (info.CFBundleIdentifier !== 'io.github.etphli.breezer' || info.CFBundleExecutable !== 'Breezer') throw new Error('The download is not Breezer.');
  const versions = join(app, 'Contents/Frameworks/Breezer Framework.framework/Versions');
  const actual = (await readdir(versions)).filter(n => n !== 'Current');
  if (actual.length !== 1) throw new Error('Invalid framework layout.');
  const host = join(versions, actual[0], 'Resources/breezer_ai/host');
  const identity = JSON.parse(await readFile(join(host, 'build-identity.json'), 'utf8'));
  if (identity.commit !== commit) throw new Error('Downloaded app does not match the release commit.');
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  const arch = await run('/usr/bin/lipo', ['-archs', join(app, 'Contents/MacOS/Breezer')]);
  if (!arch.trim().split(/\s+/).includes('arm64')) throw new Error('The update does not support this Mac.');
}
export async function replaceApp(staged, app, backup, verify, launch) {
  let replaced = false;
  await rename(app, backup);
  try {
    await rename(staged, app); replaced = true;
    await verify(app);
    await launch(app);
  } catch (error) {
    if (replaced) await rename(app, staged);
    await rename(backup, app);
    await launch(app).catch(() => {});
    throw error;
  }
}
async function pids(app) {
  const rows = await run('/bin/ps', ['-axo', 'pid=,comm=']);
  return rows.split('\n').flatMap(row => { const match = row.trim().match(/^(\d+)\s+(.+)$/); return match?.[2] === join(app, 'Contents/MacOS/Breezer') ? [Number(match[1])] : []; });
}
export async function installUpdate(work) {
  const { app, candidate } = JSON.parse(await readFile(join(work, 'request.json'), 'utf8'));
  if (![join(homedir(), 'Applications/Breezer.app'), '/Applications/Breezer.app'].includes(app) || resolve(work) !== work || dirname(work) !== dirname(app) || !basename(work).startsWith('.breezer-update-')) throw new Error('Updates require Breezer in Applications.');
  const parent = dirname(app), lock = join(parent, '.Breezer-update.lock');
  let owner;
  const requireLock = () => lstat(owner);
  const status = async (phase, notice) => {
    const path = join(parent, '.Breezer-update-status.json');
    const temporary = join(work, 'status.json');
    await writeFile(temporary, JSON.stringify({ phase, notice, version: candidate.version, updatedAt: Date.now() }), { mode: 0o600 });
    await requireLock();
    await rename(temporary, path);
  };
  const mount = join(work, 'mount'), staged = join(work, 'Breezer.app');
  let mounted = false, detachAttempted = false;
  try {
    owner = await acquireLock(work, lock);
    if (!owner) {
      const notice = 'Another update is already running.';
      if (!process.connected) throw new Error(notice);
      process.send({ type: 'update-worker-blocked', notice });
      return;
    }
    await status('downloading', 'Downloading the verified GitHub release…');
    // A process spawning is not proof its script survived Gatekeeper/startup.
    if (process.connected) process.send({ type: 'update-worker-ready' });
    const disk = await statfs(parent);
    if (disk.bavail * disk.bsize < candidate.size * 4 + 2 * 1024 ** 3) throw new Error('Not enough free disk space for this update.');
    const url = new URL(candidate.url);
    if (url.origin !== 'https://github.com' || !url.pathname.startsWith('/etphli/breezer/releases/download/')) throw new Error('Invalid download origin.');
    const response = await fetch(url, { signal: AbortSignal.timeout(15 * 60_000) });
    if (!response.ok || !response.body || new URL(response.url).protocol !== 'https:') throw new Error('The update download failed.');
    let size = 0; const hash = createHash('sha256');
    await pipeline(Readable.fromWeb(response.body), new Transform({ transform(chunk, _, callback) { size += chunk.length; hash.update(chunk); callback(size > candidate.size ? new Error('Download size mismatch.') : null, chunk); } }), createWriteStream(join(work, 'update.dmg'), { flags: 'wx', mode: 0o600 }));
    if (size !== candidate.size || hash.digest('hex') !== candidate.sha256) throw new Error('The update checksum does not match.');
    await status('verifying', 'Checking the downloaded app…');
    await mkdir(mount);
    await run('/usr/bin/hdiutil', ['attach', '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, join(work, 'update.dmg')]); mounted = true;
    await verifyBundle(join(mount, 'Breezer.app'), candidate.commit);
    await run('/usr/bin/ditto', [join(mount, 'Breezer.app'), staged]);
    await verifyBundle(staged, candidate.commit);
    detachAttempted = true;
    await detach(mount);
    mounted = false;
    await status('restarting', 'Update ready. Restarting Breezer…');
    for (const pid of await pids(app)) { if ((await pids(app)).includes(pid)) process.kill(pid, 'SIGTERM'); }
    for (let i = 0; i < 120 && (await pids(app)).length; i++) await sleep(500);
    if ((await pids(app)).length) throw new Error('Breezer is still running. Close it and try the update again.');
    if ((await lstat(app)).isSymbolicLink()) throw new Error('Refusing to replace a linked app.');
    const backups = join(parent, '.Breezer-backups'); await mkdir(backups, { recursive: true });
    if ((await lstat(backups)).isSymbolicLink()) throw new Error('Invalid backup directory.');
    const obsolete = await readdir(backups, { withFileTypes: true });
    const backup = join(backups, `Breezer-update-${Date.now()}-${randomUUID()}.app`);
    await requireLock();
    await replaceApp(staged, app, backup, path => verifyBundle(path, candidate.commit), path => run('/usr/bin/open', [path, '--args', '--restore-last-session']));
    await requireLock();
    for (const entry of obsolete) {
      if (entry.isDirectory() && backupName.test(entry.name)) {
        await rm(join(backups, entry.name), { recursive: true, force: true }).catch(() => {});
      }
    }
    await status('installed', `Updated to ${candidate.version}. The previous app is kept in .Breezer-backups for rollback.`);
  } catch (error) {
    if (!owner) throw error;
    await status('failed', `Update failed: ${error.message}`);
  } finally {
    try {
      await cleanStaging(work, mount, mounted, detachAttempted);
    } finally {
      if (owner) await releaseLock(owner);
    }
  }
}
if (process.argv[1]?.endsWith('/worker.mjs')) await installUpdate(process.argv[2]);
