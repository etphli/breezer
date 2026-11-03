import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Storage copies only requested keys, as chrome.storage does. Each await also
// lets overlapping callers expose a missing or incorrectly named lock.
export function fakeEnvironment(module, { store = module.defaultStore(), members, token = 'current' } = {}) {
  const events = [], tails = new Map();
  let held = 0, maxHeld = 0, tokensMade = 0;
  const local = new Map([[module.STORE_KEY, structuredClone(store)]]);
  if (members !== undefined) local.set(module.MEMBERS_KEY, structuredClone(members));
  const session = new Map(token ? [[module.SESSION_KEY, token]] : []);
  const area = (name, data) => ({
    async get(keys) {
      const list = [keys].flat();
      events.push({ area: name, op: 'get', keys: list });
      await Promise.resolve();
      return Object.fromEntries(list.filter(key => data.has(key)).map(key => [key, structuredClone(data.get(key))]));
    },
    async set(values) {
      events.push({ area: name, op: 'set', keys: Object.keys(values), values: structuredClone(values) });
      await Promise.resolve();
      for (const [key, value] of Object.entries(values)) data.set(key, structuredClone(value));
    },
  });
  const locks = {
    request(name, callback) {
      events.push({ op: 'lock', name });
      const run = (tails.get(name) || Promise.resolve()).then(async () => {
        held++;
        maxHeld = Math.max(maxHeld, held);
        try { return await callback(); } finally { held--; }
      });
      tails.set(name, run.catch(() => {}));
      return run;
    },
  };
  const storage = { local: area('local', local), session: area('session', session) };
  return {
    events, local, session, locks, storage,
    instance: () => new module.WorkspaceStore({ storage, locks, makeToken: () => `made-${++tokensMade}` }),
    stats: () => ({ maxHeld, tokensMade }),
  };
}

export function savedFixture(module, size) {
  const store = module.defaultStore();
  store.spaces[0].pinned = Array.from({ length: size }, (_, i) => ({ kind: 'entry', id: `e-${i}`, url: `https://example.invalid/${i}`, title: `Saved ${i}` }));
  return store;
}

async function loadSource(path) {
  const source = await readFile(path, 'utf8');
  return { module: await import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`), sha256: createHash('sha256').update(source).digest('hex') };
}

async function measure(module) {
  const results = [];
  for (const size of [0, 100, 1000]) {
    const env = fakeEnvironment(module, { store: savedFixture(module, size), members: module.normalizeMembers({ version: 1, session: 'current', tabs: {} }) });
    const strings = [], stringify = JSON.stringify;
    JSON.stringify = function (value, ...args) {
      const result = stringify(value, ...args);
      strings.push({ kind: value?.spaces ? 'store' : value?.tabs ? 'members' : 'other', chars: result.length });
      return result;
    };
    try { await env.instance().patchMembers({ 1: { s: 'space-default', u: 'https://example.invalid/new' } }); }
    finally { JSON.stringify = stringify; }
    results.push({ savedEntries: size, reads: env.events.filter(e => e.op === 'get'), writes: env.events.filter(e => e.op === 'set').map(({ area, keys }) => ({ area, keys })), serializations: strings });
  }
  return results;
}

async function differential(oldModule, currentModule) {
  const malformed = [undefined, null, false, [], { version: 2 }, { version: 1, session: 42, tabs: 'bad', quarantine: { exact: [null, 'ff', 'ff', 'BAD'], path: 'bad' } },
    { version: 1, session: 'old', prev: 'ancient', tabs: { bad: {}, 1: null, 2: { s: 7, u: 'x'.repeat(8300), k: 'old', e: 42 }, 3: { s: 'home', u: '', k: 'ancient' }, 4: { s: 'home', u: '', k: 'current' } }, quarantine: { session: 'old', exact: ['ab'], path: ['cd'] } },
    { version: 1, session: 'current', prev: 'old', tabs: { 8: { s: 'other', u: 'https://example.invalid/', k: 'current' } }, quarantine: { session: 'current', exact: ['ab'], path: ['cd'] } }];
  let cases = 0, steps = 0;
  for (const members of malformed) for (const token of ['', 'current', 'old']) {
    const before = fakeEnvironment(oldModule, { members, token, store: savedFixture(oldModule, 100) });
    const after = fakeEnvironment(currentModule, { members, token, store: savedFixture(currentModule, 100) });
    const pairs = [before, after].map(env => [env.instance(), env.instance()]);
    const operations = [
      [{}, []],
      [{ 1: { s: 'work', u: 'https://example.invalid/', e: 'e-1', k: 'ignored' }, 2: null }, [1, 'missing']],
      [{ 7: { s: 'home', u: '', extra: 'preserved' } }, []],
      [{ 7: { s: 'home', u: '', extra: 'preserved' } }, []],
      [{ '09': { s: 'x'.repeat(70), u: 'u'.repeat(8300) }, bad: 'string' }, ['bad']],
    ];
    for (let i = 0; i < operations.length; i++) {
      const [set, remove] = operations[i];
      assert.equal(await pairs[0][i % 2].patchMembers(set, remove), await pairs[1][i % 2].patchMembers(set, remove));
      assert.deepEqual(after.local, before.local);
      assert.deepEqual(after.session, before.session);
      assert.deepEqual(after.events.filter(e => e.op === 'set'), before.events.filter(e => e.op === 'set'));
      steps++;
    }
    // Mixed general transactions and member patches use the same queue.
    for (let side = 0; side < 2; side++) {
      const env = [before, after][side], [a, b] = pairs[side];
      env.session.clear();
      await Promise.all([
        a.patchMembers({ 31: { s: 'home' } }),
        b.update(store => { store.prefs.closeButton = 'always'; }),
        b.patchMembers({ 32: { s: 'work' } }),
        a.patchMembers({ 33: { s: 'home' } }, ['31']),
      ]);
    }
    assert.deepEqual(after.local, before.local);
    assert.deepEqual(after.session, before.session);
    assert.deepEqual(after.events.filter(e => e.op === 'set'), before.events.filter(e => e.op === 'set'));
    assert.equal(after.stats().maxHeld, 1);
    cases++;
  }
  return { cases, sequentialSteps: steps, overlappingOperations: cases * 4, exactPersistedValuesAndWriteSequenceMatch: true };
}

async function main() {
  const [sourcePath = 'features/ai/extension/workspace-store.js', outputPath, baselinePath] = process.argv.slice(2);
  const current = await loadSource(sourcePath);
  const report = { scope: 'Offline actual WorkspaceStore class; deterministic requested-key and serialized-character counts only. No timing, RSS or browser claim.', sourcePath, sourceSha256: current.sha256, measurements: await measure(current.module) };
  if (baselinePath) {
    const old = await loadSource(baselinePath);
    report.baselineSha256 = old.sha256;
    report.differential = await differential(old.module, current.module);
    for (const row of report.measurements) {
      assert.ok(row.reads.filter(e => e.area === 'local').every(e => !e.keys.includes(current.module.STORE_KEY)));
      assert.equal(row.serializations.filter(e => e.kind === 'store').length, 0);
    }
  }
  if (outputPath) await writeFile(outputPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
