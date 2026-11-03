import test from 'node:test';
import assert from 'node:assert/strict';
import * as module from '../../features/ai/extension/workspace-store.js';
import { fakeEnvironment, savedFixture } from '../../script/verify_workspace_members_efficiency.mjs';

const { MEMBERS_KEY, STORE_KEY, SESSION_KEY, LOCK_NAME, normalizeMembers } = module;
const membersFor = (tabs = {}) => normalizeMembers({ version: 1, session: 'current', tabs });
const localWrites = env => env.events.filter(e => e.area === 'local' && e.op === 'set');

test('patchMembers never requests, reads, normalizes or stringifies the saved store', async () => {
  const env = fakeEnvironment(module, { store: savedFixture(module, 1000), members: membersFor() });
  const saved = structuredClone(env.local.get(STORE_KEY));
  const get = env.storage.local.get;
  env.storage.local.get = async keys => {
    assert.deepEqual(keys, [MEMBERS_KEY]);
    const values = await get(keys);
    Object.defineProperty(values, STORE_KEY, { get() { assert.fail('saved store accessed'); } });
    return values;
  };
  const stringify = JSON.stringify;
  let serializations = 0;
  JSON.stringify = function (value, ...args) {
    assert.equal(value?.spaces, undefined, 'saved store must not be serialized');
    serializations++;
    return stringify(value, ...args);
  };
  try { await env.instance().patchMembers({ 1: { s: 'work', u: 'https://example.invalid/' } }); }
  finally { JSON.stringify = stringify; }
  assert.equal(serializations, 2);
  assert.deepEqual(env.local.get(STORE_KEY), saved, 'all saved pins and revision preserved');
  assert.deepEqual(localWrites(env).map(e => e.keys), [[MEMBERS_KEY]]);
});

test('overlapping windows share the exact named FIFO lock with general transactions', async () => {
  const env = fakeEnvironment(module, { token: '' });
  const a = env.instance(), b = env.instance();
  await Promise.all([
    a.patchMembers({ 1: { s: 'a' } }),
    b.update(store => { store.prefs.closeButton = 'always'; }),
    b.patchMembers({ 2: { s: 'b' } }),
    a.patchMembers({ 3: { s: 'a' } }, ['1']),
  ]);
  assert.deepEqual(Object.keys(env.local.get(MEMBERS_KEY).tabs), ['2', '3']);
  assert.equal(env.local.get(STORE_KEY).prefs.closeButton, 'always');
  assert.equal(env.local.get(STORE_KEY).rev, 1);
  assert.ok(env.events.filter(e => e.op === 'lock').every(e => e.name === LOCK_NAME));
  assert.deepEqual(env.stats(), { maxHeld: 1, tokensMade: 1 });
  assert.equal(env.session.get(SESSION_KEY), 'made-1');
  assert.ok(Object.values(env.local.get(MEMBERS_KEY).tabs).every(record => record.k === 'made-1'));
});

test('unchanged writes are suppressed and removals win over sets', async () => {
  const env = fakeEnvironment(module, { members: membersFor({ 1: { s: 'work', u: '', k: 'current' } }) });
  const workspace = env.instance();
  assert.equal(await workspace.patchMembers(), undefined);
  await workspace.patchMembers({ 1: { s: 'work', u: '', k: 'ignored' } }, ['missing']);
  assert.equal(localWrites(env).length, 0);
  await workspace.patchMembers({ 1: { s: 'other' }, 2: { s: 'home' } }, [1, '2']);
  assert.deepEqual(env.local.get(MEMBERS_KEY).tabs, {});
  assert.equal(localWrites(env).length, 1);
  await workspace.patchMembers({}, ['1']);
  assert.equal(localWrites(env).length, 1);
});

test('malformed stored members use existing normalization without persisting cleanup alone', async () => {
  const raw = { version: 1, session: 'current', tabs: { bad: {}, 1: null, 2: { s: 4, u: 'x'.repeat(8300), k: 'current', e: 3 } }, quarantine: { session: 'current', exact: ['ab', 'ab', 'INVALID'], path: null } };
  const env = fakeEnvironment(module, { members: raw });
  await env.instance().patchMembers();
  assert.equal(localWrites(env).length, 0);
  assert.deepEqual(env.local.get(MEMBERS_KEY), raw);
  await env.instance().patchMembers({ 3: { s: 'work' } });
  const expected = normalizeMembers(raw);
  expected.tabs[3] = { s: 'work', k: 'current' };
  assert.deepEqual(env.local.get(MEMBERS_KEY), expected);
  for (const members of [undefined, null, [], { version: 2 }]) {
    const invalid = fakeEnvironment(module, { members });
    await invalid.instance().patchMembers();
    assert.equal(invalid.local.get(MEMBERS_KEY).session, 'current');
  }
});

test('session rollover retains previous and current records, resets quarantine, and stays fresh across windows', async () => {
  const env = fakeEnvironment(module, { token: '', members: {
    version: 1, session: 'old', prev: 'ancient', quarantine: { session: 'old', exact: ['ab'], path: ['cd'] }, tabs: {
      1: { s: 'work', u: '', k: 'old', e: 'pin' },
      2: { s: 'work', u: '', k: 'ancient' },
      3: { s: 'home', u: '', k: 'made-1' },
    },
  } });
  const a = env.instance(), b = env.instance();
  await a.patchMembers();
  const first = env.local.get(MEMBERS_KEY);
  assert.equal(first.prev, 'old');
  assert.deepEqual(Object.keys(first.tabs), ['1', '3']);
  assert.equal(first.tabs[1].e, 'pin');
  assert.deepEqual(first.quarantine, { session: 'made-1', exact: [], path: [] });
  await b.patchMembers({ 4: { s: 'other' } });
  await a.patchMembers({ 5: { s: 'work' } });
  assert.deepEqual(Object.keys(env.local.get(MEMBERS_KEY).tabs), ['1', '3', '4', '5']);
  env.session.clear();
  await b.patchMembers();
  assert.deepEqual(Object.keys(env.local.get(MEMBERS_KEY).tabs), ['3', '4', '5']);
  assert.equal(env.local.get(MEMBERS_KEY).prev, 'made-1');
});

test('a failed membership write rejects and releases the lock for the next writer', async () => {
  const env = fakeEnvironment(module, { members: membersFor() });
  const set = env.storage.local.set;
  let fail = true;
  env.storage.local.set = async values => {
    if (fail) { fail = false; throw new Error('synthetic write failure'); }
    return set(values);
  };
  const a = env.instance(), b = env.instance();
  await assert.rejects(a.patchMembers({ 1: { s: 'work' } }), /synthetic write failure/);
  await b.patchMembers({ 2: { s: 'home' } });
  assert.deepEqual(Object.keys(env.local.get(MEMBERS_KEY).tabs), ['2']);
});
