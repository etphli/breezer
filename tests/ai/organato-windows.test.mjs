import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { Organato } from '../../features/ai/host/organato.mjs';
import { windowsSecrets, withWindowsCacheLock } from '../../features/ai/host/organato-windows.mjs';

const nativeOptions = { skip: process.platform !== 'win32', timeout: 45_000 };
const temporaryKey = () => `org_${randomBytes(32).toString('base64url')}`;
const blobName = 'organato-key.dpapi';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'breezer-organato-windows-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test('Windows store observes another helper replacing or removing a protected key', async t => {
  const directory = await fixture(t);
  const blobs = new Map();
  let unprotections = 0;
  const transform = async (operation, bytes) => {
    if (operation === 'Protect') {
      const blob = randomBytes(32);
      blobs.set(blob.toString('hex'), bytes);
      return blob;
    }
    unprotections++;
    return blobs.get(bytes.toString('hex'));
  };
  const first = windowsSecrets(directory, transform);
  const second = windowsSecrets(directory, transform);
  const previous = temporaryKey();
  const replacement = temporaryKey();
  await first.set(previous);
  assert.ok((await second.get()) === previous);
  assert.ok((await second.get()) === previous);
  assert.equal(unprotections, 1);
  assert.ok(!(await readFile(join(directory, blobName))).includes(previous));
  await first.set(replacement);
  assert.ok((await second.get()) === replacement);
  assert.equal(unprotections, 2);
  await first.remove();
  assert.equal(await second.get(), null);
});

test('Windows store bounds blobs and cleans up failed credential replacements', async t => {
  const directory = await fixture(t);
  const path = join(directory, blobName);
  const protectedKey = randomBytes(32);
  let unprotections = 0;
  const store = windowsSecrets(directory, async operation => {
    if (operation === 'Protect') return protectedKey;
    unprotections++;
    throw new Error('Windows rejected the blob');
  });
  await writeFile(path, Buffer.alloc(4097));
  assert.equal(await store.get(), null);
  assert.equal(unprotections, 0);
  await writeFile(path, Buffer.alloc(20));
  assert.equal(await store.get(), null);
  assert.equal(unprotections, 1);
  await rm(path);
  await mkdir(path);
  await assert.rejects(store.set(temporaryKey()));
  assert.deepEqual(await readdir(directory), [blobName]);
});

test('Windows Organato connects, saves, reads and disconnects under DPAPI', nativeOptions, async t => {
  const directory = await fixture(t);
  const key = temporaryKey();
  const progress = [];
  const fetcher = async (_url, options) => {
    assert.ok(options.headers.Authorization === `Bearer ${key}`);
    return Response.json({ items: [{ id: 'fixture', displayName: 'Synthetic task', kind: 'todo' }] });
  };
  const options = { configDirectory: directory, fetcher };
  const first = new Organato(options);
  assert.equal((await first.view()).connected, false);
  assert.equal((await first.configure({ key }, stage => progress.push(stage))).connected, true);
  assert.match(progress[1], /Windows account/);
  const stored = await readFile(join(directory, blobName));
  assert.ok(stored.length > Buffer.byteLength(key) && !stored.includes(key));
  assert.ok(!(await readFile(join(directory, 'organato.json'))).includes(key));
  const reopened = new Organato(options);
  assert.equal((await reopened.view()).connected, true);
  assert.equal((await reopened.list()).items[0].title, 'Synthetic task');
  assert.ok((await readdir(directory)).includes('organato-cache.json'));
  assert.equal((await first.configure({ disconnect: true })).connected, false);
  assert.equal((await reopened.view()).connected, false);
  assert.ok(!(await readdir(directory)).includes(blobName));
});

test('Windows cache lock denies an independent file handle and releases on failure', nativeOptions, async t => {
  const directory = await fixture(t);
  const path = join(directory, 'organato-cache.lock');
  await assert.rejects(withWindowsCacheLock(path, async () => {
    await assert.rejects(open(path, 'r').then(file => file.close()));
    throw new Error('synthetic transaction failure');
  }), /synthetic transaction failure/);
  const competingHandle = await open(path, 'r');
  const result = withWindowsCacheLock(path, () => 1);
  try {
    assert.equal(await Promise.race([result, delay(1000, 'waiting')]), 'waiting');
  } finally {
    await competingHandle.close();
  }
  assert.equal(await result, 1);
});
