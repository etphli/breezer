#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  'source-dir': { type: 'string', default: 'features/ai/extension' },
  output: { type: 'string' }, 'expect-optimized': { type: 'boolean' },
} });
const source = resolve(values['source-dir']);
const { WorkspaceSync } = await import(pathToFileURL(join(source, 'workspace-sync.js')));
const { emptySyncModel, recordWorkspaceChanges, materializeWorkspace } = await import(pathToFileURL(join(source, 'workspace-sync-model.js')));
const hashes = {};
for (const name of ['workspace-store.js', 'workspace-sync.js', 'workspace-sync-model.js']) {
  hashes[name] = createHash('sha256').update(await readFile(join(source, name))).digest('hex');
}
const results = { scope: 'Offline production JS with synthetic in-memory storage. Operation counts only, not native browser RAM, CPU, IPC or physical disk bytes.', node: process.version, sourceSha256: hashes, noOpCycles: [], folders: [] };
const space = { alive: true, name: 'Space', tone: 'mint', index: 0 };
for (const count of [0, 1000]) {
  const entities = { 'space/s': space, preferences: { newTabPosition: 'top', closeButton: 'always' } };
  for (let i = 0; i < count; i++) entities[`entry/e${i}`] = { alive: true, url: `https://example.invalid/${i}`, title: `Synthetic ${i}`, parent: 'space/s', index: i };
  let remote = { configured: true, workspaceEnabled: true, providerId: 'fixture-provider', vaultId: 'fixture-vault', model: JSON.stringify(recordWorkspaceChanges(emptySyncModel(), {}, entities, 'client001')) };
  const saved = {}, writes = [];
  const storage = { local: {
    async get(keys) { return Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, structuredClone(saved[key])])); },
    async set(patch) { writes.push({ bytes: new TextEncoder().encode(JSON.stringify(patch)).length }); Object.assign(saved, structuredClone(patch)); },
  }, session: { async set() {} } };
  let exchanges = 0;
  const bridge = { async read() { return structuredClone(remote); }, async getAppearance() { return {}; }, async setAppearance(patch) { return patch; }, async exchange(request) { exchanges++; remote.model = request.model; return structuredClone(remote); } };
  const sync = new WorkspaceSync({ storage, locks: { request: async (_name, fn) => fn() }, bridge, makeClientId: () => 'client002' });
  for (let i = 0; i < 2; i++) assert.equal((await sync.cycle()).phase, 'reconciled');
  const before = JSON.stringify(saved);
  writes.length = 0; exchanges = 0;
  assert.equal((await sync.cycle()).phase, 'reconciled');
  assert.equal(JSON.stringify(saved), before);
  assert.equal(exchanges, 0);
  if (values['expect-optimized']) assert.equal(writes.length, 0);
  results.noOpCycles.push({ entries: count, storageWrites: writes.length, serializedStorageBytes: writes.reduce((sum, row) => sum + row.bytes, 0), dataUnchanged: true, exchanges });
}
for (const count of [100, 1000]) {
  const entities = { 'space/s': space }, pinned = [];
  for (let i = 0; i < count; i++) {
    entities[`folder/f${i}`] = { alive: true, name: 'Folder', parent: 'space/s', index: i };
    pinned.push({ kind: 'folder', id: `f${i}`, open: i % 2 === 0, children: [] });
  }
  let reads = 0;
  const observed = new Proxy(pinned, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const model = recordWorkspaceChanges(emptySyncModel(), {}, entities, 'client001');
  const local = { version: 1, rev: 0, spaces: [{ id: 's', name: 'Space', tone: 'mint', pinned: observed }], favorites: [], prefs: { newTabPosition: 'top', closeButton: 'always' } };
  const applied = materializeWorkspace(model, local).store;
  assert.equal(applied.spaces[0].pinned.length, count);
  assert.ok(applied.spaces[0].pinned.every((node, i) => node.open === (i % 2 === 0)));
  if (values['expect-optimized']) assert.ok(reads <= count * 2);
  results.folders.push({ count, localPinReads: reads, expansionPreserved: true });
}
if (values.output) await writeFile(resolve(values.output), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
