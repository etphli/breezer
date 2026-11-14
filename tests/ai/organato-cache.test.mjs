import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Organato } from '../../features/ai/host/organato.mjs';

const key = 'org_' + 'x'.repeat(43);
const item = { id: 'exam', displayName: 'Geography exam', version: 1, kind: 'work', classification: 'checkpoint' };
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'organato-cache-'));
  let savedKey = key;
  const secrets = { get: async () => savedKey, set: async value => { savedKey = value; }, remove: async () => { savedKey = null; } };
  const service = new Organato({ configDirectory: directory, secrets, fetcher: async () => Response.json({ items: [item] }) });
  try { await fn(service, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

test('saved tasks survive a helper restart and load before a failed school connection', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'organato-cache-'));
  const secrets = { get: async () => 'org_' + 'x'.repeat(43) };
  const options = { configDirectory: directory, secrets };
  try {
    const online = new Organato({ ...options, fetcher: async () => Response.json({ items: [{ id: 'exam', displayName: 'Geography exam', kind: 'work', classification: 'checkpoint' }] }) });
    const live = await online.list();
    let cached;
    const offline = new Organato({ ...options, fetcher: async () => {
      assert.deepEqual(cached?.items, JSON.parse(JSON.stringify(live.items)), 'saved tasks must arrive before the network request');
      throw new TypeError('fetch failed');
    } });
    await assert.rejects(offline.list(undefined, { onCached: value => { cached = value; } }), /fetch failed/);
    assert.ok(Number.isFinite(Date.parse(cached.syncedAt)));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('cache saves only dashboard fields, uses private permissions and replaces an empty list', () => fixture(async (service, directory) => {
  service.fetcher = async () => Response.json({ items: [{ ...item, notesMarkdown: 'Private notes are not cached' }] });
  await service.list();
  const path = join(directory, 'organato-cache.json');
  const saved = await readFile(path, 'utf8');
  assert.ok(!saved.includes(key));
  assert.ok(!saved.includes('Private notes'));
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal((await stat(directory)).mode & 0o777, 0o700);
  service.fetcher = async () => Response.json({ items: [] });
  await service.list();
  let cached;
  service.fetcher = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(service.list(undefined, { onCached: value => { cached = value; } }), /fetch failed/);
  assert.deepEqual(cached.items, []);
  assert.deepEqual(await readdir(directory), ['organato-cache.json']);
}));

test('failed pagination and malformed responses keep the last complete sync', () => fixture(async service => {
  const original = await service.list();
  let page = 0;
  service.fetcher = async () => ++page === 1 ? Response.json({ items: [{ ...item, id: 'partial' }], nextCursor: 'page2' }) : new Response('{}', { status: 503 });
  await assert.rejects(service.list(), /503/);
  for (const response of ['not json', '{"items":null}']) {
    service.fetcher = async () => new Response(response);
    await assert.rejects(service.list());
  }
  assert.deepEqual((await service.cachedList(key)).items, JSON.parse(JSON.stringify(original.items)));
}));

test('corrupt, oversized, missing and foreign-account caches are ignored', () => fixture(async (service, directory) => {
  const path = join(directory, 'organato-cache.json');
  const saved = await service.list();
  const valid = JSON.parse(await readFile(path, 'utf8'));
  for (const data of ['{broken', JSON.stringify({ ...valid, syncedAt: 'bad' }), JSON.stringify({ ...valid, items: [null] }), JSON.stringify({ ...valid, schema: 99 }), ' '.repeat(8_000_001)]) {
    await writeFile(path, data);
    assert.equal(await service.cachedList(key), null);
  }
  await writeFile(path, JSON.stringify(valid));
  assert.equal(await service.cachedList('org_' + 'y'.repeat(43)), null);
  assert.deepEqual((await service.cachedList(key)).items, JSON.parse(JSON.stringify(saved.items)));
  await rm(path);
  assert.equal(await service.cachedList(key), null);
}));

test('disconnect, key replacement and a pending old sync cannot reuse the previous cache', () => fixture(async (service, directory) => {
  await service.list();
  let release, started;
  const ready = new Promise(resolve => { started = resolve; });
  service.fetcher = async () => { started(); await new Promise(resolve => { release = resolve; }); return Response.json({ items: [item] }); };
  const pending = service.list();
  await ready;
  await service.configure({ disconnect: true });
  release(); await assert.rejects(pending, { code: 'DASHBOARD_CHANGED' });
  assert.ok(!(await readdir(directory)).includes('organato-cache.json'));
  await assert.rejects(service.list(), /Connect Organato/);
  service.fetcher = async () => Response.json({ items: [item] });
  await service.configure({ key }); await service.list();
  await service.configure({ key: 'org_' + 'y'.repeat(43) });
  assert.equal(await service.cachedList(key), null);
  let cached = false;
  service.fetcher = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(service.list(undefined, { onCached: () => { cached = true; } }), /fetch failed/);
  assert.equal(cached, false);
}));

test('disabled Organato never emits saved data and AI reads still fail offline', () => fixture(async service => {
  await service.list();
  service.fetcher = async () => { throw new TypeError('fetch failed'); };
  await assert.rejects(service.tool('organato_list_items', {}), /fetch failed/);
  await service.configure({ enabled: false });
  await assert.rejects(service.list(undefined, { onCached: () => assert.fail('disabled cache emitted') }), /switched off/);
}));

test('dashboard-off AI reads stay live without recreating the saved task cache', () => fixture(async (service, directory) => {
  await service.list();
  await service.configure({ dashboardEnabled: false });
  assert.ok(!(await readdir(directory)).includes('organato-cache.json'));
  let requests = 0;
  service.fetcher = async () => { requests++; return Response.json({ items: [item] }); };
  const result = await service.tool('organato_list_items', {});
  assert.equal(result.items[0].title, 'Geography exam');
  assert.equal(requests, 1);
  assert.ok(!(await readdir(directory)).includes('organato-cache.json'), 'AI reads must not recreate a disabled dashboard cache');
  assert.equal(await service.cachedList(key), null);
  await service.configure({ dashboardEnabled: true });
  await service.tool('organato_list_items', {});
  assert.equal(requests, 2);
  assert.ok(await service.cachedList(key));
}));

test('disconnect removes the key even when cache invalidation fails', () => fixture(async (service, directory) => {
  const file = join(directory, 'not-a-directory');
  await writeFile(file, 'fixture');
  service.directory = file;
  await assert.rejects(service.configure({ disconnect: true }), error => ['EEXIST', 'ENOTDIR'].includes(error.code));
  assert.equal(await service.secrets.get(), null);
}));

test('a cache write failure does not discard a successful live response', () => fixture(async (service, directory) => {
  const file = join(directory, 'not-a-directory');
  await writeFile(file, 'fixture');
  service.directory = file;
  assert.equal((await service.list()).items[0].title, 'Geography exam');
}));

test('successful mutations invalidate saved tasks and failed writes keep them', () => fixture(async service => {
  await service.list();
  service.fetcher = async () => new Response('{}', { status: 409 });
  const update = { id: 'exam', version: 1, workingStatus: 'completed' };
  await assert.rejects(service.tool('organato_update_item', update), /changed in Organato/);
  assert.ok(await service.cachedList(key));
  service.fetcher = async () => Response.json({ item: { ...item, workingStatus: 'completed' } });
  await service.tool('organato_update_item', update);
  assert.equal(await service.cachedList(key), null);
}));
