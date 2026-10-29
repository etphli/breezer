import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Organato, validateItem } from '../../features/ai/host/organato.mjs';
import { allowedTools, validateTool } from '../../features/ai/host/protocol.mjs';
const key = 'org_' + 'x'.repeat(43);
async function fixture(fn) {
  const directory = await mkdtemp(join(tmpdir(), 'organato-contract-')); let secret = null;
  const calls = [], secrets = { get: async () => secret, set: async k => { secret = k; }, remove: async () => { secret = null; } };
  const service = new Organato({ configDirectory: directory, secrets, fetcher: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify(options.method === 'GET' ? { items: [{ id: 'id1', version: 2, displayName: 'Exam', classification: 'checkpoint', kind: 'work', workingStatus: 'not_started' }], nextCursor: null } : { item: { id: 'created' } })); } });
  try { await fn(service, calls, directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
test('default dashboard is enabled without sending requests or persisting a key in config', () => fixture(async (service, calls, directory) => {
  assert.deepEqual(await service.view(), { enabled: true, dashboardEnabled: true, allowAI: true, connected: false }); assert.equal(calls.length, 0);
  await service.configure({ key }); assert.equal((await service.view()).connected, true);
  assert.ok(! (await readFile(join(directory, 'organato.json'), 'utf8')).includes(key));
  assert.equal(calls[0].options.redirect, 'error');
}));
test('fixed API contract supports reading, creation and versioned updates with explicit permissions', () => fixture(async (service, calls) => {
  await service.configure({ key });
  assert.equal((await service.tool('organato_list_items', {})).items[0].title, 'Exam');
  await service.tool('organato_create_item', { kind: 'todo', displayName: 'Study' });
  assert.equal(calls.at(-1).url, 'https://organato.etphli.workers.dev/api/v1/items');
  assert.equal(calls.at(-1).options.method, 'POST');
  await service.tool('organato_update_item', { id: 'id1', version: 2, workingStatus: 'completed' });
  assert.equal(calls.at(-1).options.method, 'PATCH');
  await service.configure({ allowAI: false });
  await assert.rejects(service.tool('organato_create_item', { kind: 'todo', displayName: 'No' }), /off/);
  await service.configure({ disconnect: true }); assert.equal((await service.view()).connected, false);
}));
test('invalid paths, fields and dates cannot become API mutations', () => {
  for (const input of [{ kind: 'todo', displayName: 'X', url: 'http://evil' }, { kind: 'todo', displayName: 'X', dueDateLocal: '2026-02-30' }, { id: '../secret', version: 1 }, { id: 'abc', version: 0 }]) assert.throws(() => validateItem(input, 'id' in input));
  assert.ok(!allowedTools({}).some(tool => tool.name.startsWith('organato_')));
  const tools = allowedTools({ organato: true });
  assert.equal(tools.length, 3);
  assert.throws(() => validateTool('organato_update_item', { id: 'a', version: 1, password: key }, tools));
});
