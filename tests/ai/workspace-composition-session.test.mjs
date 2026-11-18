import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {harness} from './fixtures/workspace-composition/harness.mjs';
import {windowStateKey} from '../../features/ai/extension/workspace-store.js';
import {seed} from './workspace-browser-fixture.mjs';

const source = await readFile(new URL('../../features/ai/extension/workspace.js', import.meta.url), 'utf8');
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const plain = v => JSON.parse(JSON.stringify(v));
const writes = h => h.counters.writes.filter(([area, values]) => area === 'session' && Object.hasOwn(values, windowStateKey(h.state.windowId)));
const value = h => plain({activeSpaceId: h.state.activeSpaceId, lastActive: h.state.lastActive});
function deferredStorage() {
  const requests = [];
  return {requests, storageSet({area, values, commit}) {
    if (area !== 'session') { commit(); return Promise.resolve(); }
    let resolve, reject;
    const promise = new Promise((ok, fail) => { resolve = ok; reject = fail; });
    requests.push({values, succeed() { commit(); resolve(); }, fail() { reject(new Error('fixture storage failure')); }});
    return promise;
  }};
}
function clickApi(h, {event = true} = {}) {
  h.api.tabs.update = async (id, props) => {
    assert.equal(props.active, true);
    h.browserTabs.forEach(t => t.active = t.id === id);
    if (event) h.onActivated({tabId: id, windowId: h.state.windowId});
    return structuredClone(h.browserTabs.find(t => t.id === id));
  };
}

// The successful-snapshot regression must fail on the explicit composition base.
test('duplicate click/event retains both in-flight requests and their independent retry opportunity', async () => {
  const storage = deferredStorage(), h = await harness(source, storage); clickApi(h);
  await h.activate(4);
  assert.equal(writes(h).length, 2, 'pending writes retain baseline durability');
  assert.deepEqual(plain(storage.requests[0].values), {[windowStateKey(7)]: value(h)});
  storage.requests[0].fail(); storage.requests[1].succeed(); await settle();
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});
test('an unchanged successful snapshot needs no second storage call', async () => {
  const h = await harness(source); h.onActivated({tabId: 4, windowId: 7}); await settle();
  h.onActivated({tabId: 4, windowId: 7}); await settle();
  assert.equal(writes(h).length, 1, 'duplicate completed write');
});

test('every distinct native activation submits before a microtask, frame or timer', async () => {
  const storage = deferredStorage(), h = await harness(source, storage);
  for (const [i, id] of [4,5,3,4,5,3].entries()) {
    h.onActivated({tabId: id, windowId: 7});
    assert.equal(writes(h).length, i + 1);
    assert.equal(storage.requests[i].values[windowStateKey(7)].lastActive['space-work'], id);
  }
  assert.equal(storage.requests[0].values[windowStateKey(7)].lastActive['space-work'], 4, 'dispatch snapshots do not alias state');
  for (const r of storage.requests) r.succeed(); await settle();
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});

test('A/B/A is submitted immediately even when A is already stored', async () => {
  const storage = deferredStorage(), h = await harness(source, storage);
  h.state.lastActive['space-work'] = 4; h.saveWindowState(); storage.requests[0].succeed(); await settle();
  h.state.lastActive['space-work'] = 5; h.saveWindowState();
  h.state.lastActive['space-work'] = 4; h.saveWindowState();
  assert.equal(storage.requests.length, 3, 'pending B must invalidate cached A');
  storage.requests[1].succeed(); storage.requests[2].succeed(); await settle();
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});

test('overlapping different writes disable suppression, including repeated latest state', async () => {
  const storage = deferredStorage(), h = await harness(source, storage);
  for (const id of [4,5,5]) { h.state.lastActive['space-work'] = id; h.saveWindowState(); }
  assert.equal(storage.requests.length, 3);
  // Acknowledgements are not proof that the latest dispatch was the last commit.
  storage.requests[1].succeed(); storage.requests[2].succeed(); storage.requests[0].succeed(); await settle();
  assert.equal(h.persisted.session[windowStateKey(7)].lastActive['space-work'], 4);
  h.saveWindowState(); assert.equal(storage.requests.length, 4, 'ambiguous overlap must not seed a success cache');
  storage.requests[3].succeed(); await settle(); h.saveWindowState();
  assert.equal(storage.requests.length, 4);
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});

for (const order of [[0,1,2], [0,2,1], [1,0,2], [1,2,0], [2,0,1], [2,1,0]]) {
  test(`overlap completion order ${order.join('/')} retains next-save recovery`, async () => {
    const storage = deferredStorage(), h = await harness(source, storage);
    for (const id of [4,5,3]) { h.state.lastActive['space-work'] = id; h.saveWindowState(); }
    for (const at of order) { storage.requests[at].succeed(); await settle(); }
    h.saveWindowState(); assert.equal(storage.requests.length, 4);
    storage.requests[3].succeed(); await settle();
    assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
  });
}

test('failure leaves state retryable and the next identical event retries', async () => {
  const storage = deferredStorage(), h = await harness(source, storage); clickApi(h);
  h.onActivated({tabId:4,windowId:7}); assert.equal(storage.requests.length, 1);
  storage.requests[0].fail(); await settle();
  h.onActivated({tabId: 4, windowId: 7}); assert.equal(storage.requests.length, 2);
  storage.requests[1].succeed(); await settle(); h.saveWindowState();
  assert.equal(storage.requests.length, 2);
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});

test('overlapping failure cannot establish an isolated success cache', async () => {
  const storage = deferredStorage(), h = await harness(source, storage);
  h.saveWindowState(); h.state.lastActive['space-work'] = 4; h.saveWindowState();
  storage.requests[1].succeed(); storage.requests[0].fail(); await settle();
  h.saveWindowState(); storage.requests[2].succeed(); await settle(); h.saveWindowState();
  assert.equal(storage.requests.length, 3);
});

test('pagehide retries a failed save immediately and keeps member flushing', async () => {
  const storage = deferredStorage(), h = await harness(source, storage);
  h.setRecord(4, {s:'space-work'});
  h.onActivated({tabId: 4, windowId: 7}); storage.requests[0].fail(); await settle();
  h.pagehide(); assert.equal(storage.requests.length, 2, 'pagehide retry');
  assert.ok(h.counters.writes.some(([area]) => area === 'members'));
  storage.requests[1].succeed(); await settle();
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});

test('pagehide adds no request while pending, and deduplicates a successful saved state', async () => {
  const storage = deferredStorage(), h = await harness(source, storage);
  h.onActivated({tabId: 4, windowId: 7}); h.pagehide(); assert.equal(storage.requests.length, 1);
  storage.requests[0].succeed(); await settle(); h.pagehide(); assert.equal(storage.requests.length, 1);
});

test('pagehide keeps distinct already-submitted writes pending without adding another', async () => {
  const storage = deferredStorage(), h = await harness(source, storage);
  for (const id of [4,5]) { h.state.lastActive['space-work'] = id; h.saveWindowState(); }
  h.pagehide(); assert.equal(storage.requests.length, 2);
  for (const r of storage.requests) r.succeed(); await settle();
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});

test('space switching immediately persists both the space and per-space active tabs', async () => {
  const h = await harness(source); clickApi(h);
  h.onActivated({tabId: 4, windowId: 7}); await settle();
  h.switchSpace('space-personal'); await settle();
  assert.equal(h.persisted.session[windowStateKey(7)].activeSpaceId, 'space-personal');
  assert.equal(h.persisted.session[windowStateKey(7)].lastActive['space-personal'], 6);
  assert.equal(h.persisted.session[windowStateKey(7)].lastActive['space-work'], 4);
  h.switchSpace('space-work'); await settle();
  assert.equal(h.state.tabs.get(4).active, true);
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});

test('two windows with identical values retain independent keys, caches and failures', async () => {
  const f = seed(), persisted = structuredClone({local:f.local, session:f.session});
  const storage = deferredStorage();
  const a = await harness(source, {persisted, ...storage}), b = await harness(source, {persisted, ...storage});
  b.state.windowId = 9;
  a.saveWindowState(); b.saveWindowState();
  assert.equal(storage.requests.length, 2);
  assert.deepEqual(Object.keys(storage.requests[0].values), [windowStateKey(7)]);
  assert.deepEqual(Object.keys(storage.requests[1].values), [windowStateKey(9)]);
  storage.requests[0].fail(); storage.requests[1].succeed(); await settle();
  a.saveWindowState(); b.saveWindowState(); assert.equal(storage.requests.length, 3);
  storage.requests[2].succeed(); await settle();
  assert.deepEqual(persisted.session[windowStateKey(7)], value(a));
  assert.deepEqual(persisted.session[windowStateKey(9)], value(b));
  const before = writes(a).length; a.onActivated({tabId:4,windowId:9}); assert.equal(writes(a).length, before);
});

test('a completed activation survives fake reload without pagehide or a timer', async () => {
  const h = await harness(source); clickApi(h);
  await h.activate(5); await settle();
  const f = seed(); f.tabs = structuredClone(h.browserTabs); f.session = structuredClone(h.persisted.session);
  const reload = await harness(source, {fixture: f, boot: true});
  await reload.initSidebar({windowId:7}); reload.flushFrames();
  assert.deepEqual(plain(reload.state.lastActive), {'space-work':5});
  assert.equal(reload.state.tabs.get(5).active, true);
  assert.equal(reload.state.activeSpaceId, 'space-work');
});

test('a completed space switch survives fake reload with independent per-space history', async () => {
  const h = await harness(source); clickApi(h);
  await h.activate(5); await settle(); h.switchSpace('space-personal'); await settle();
  await h.activate(7); await settle(); h.pagehide(); await settle();
  const f = seed(); f.tabs = structuredClone(h.browserTabs); f.session = structuredClone(h.persisted.session);
  const reload = await harness(source, {fixture:f, boot:true});
  await reload.initSidebar({windowId:7}); reload.flushFrames(); clickApi(reload);
  assert.equal(reload.state.activeSpaceId, 'space-personal');
  assert.deepEqual(plain(reload.state.lastActive), {'space-work':5,'space-personal':7});
  reload.switchSpace('space-work'); await settle(); assert.equal(reload.state.tabs.get(5).active, true);
});


test('synchronous storage failure remains retryable without an unhandled rejection', async () => {
  let fail = true;
  const h = await harness(source, {storageSet({commit}) { if (fail) { fail=false; throw new Error('sync fixture failure'); } commit(); return Promise.resolve(); }});
  await h.saveWindowState(); await h.saveWindowState(); await h.saveWindowState();
  assert.equal(writes(h).length, 2);
  assert.deepEqual(h.persisted.session[windowStateKey(7)], value(h));
});

const base = await readFile(new URL('./fixtures/workspace-composition/baseline-workspace.js', import.meta.url), 'utf8');
for (const order of [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]]) {
  test(`adversarial commit order ${order.join('/')} preserves base state and dispatches`, async () => {
    const hs=[];
    for (const text of [base,source]) {
      const storage=deferredStorage(), h=await harness(text,storage);
      for(const id of [4,5,3]) { h.browserTabs.forEach(t=>t.active=t.id===id); h.onActivated({tabId:id,windowId:7}); h.flushFrames(); }
      for(const at of order) { storage.requests[at].succeed(); await settle(); }
      hs.push(h);
    }
    assert.deepEqual(hs[1].snapshot(),hs[0].snapshot(), 'same operations and same retained base ordering limitation');
  });
}

test('failed changed state cannot reuse the prior successful fingerprint', async () => {
  const storage=deferredStorage(), h=await harness(source,storage);
  h.state.lastActive['space-work']=4;h.saveWindowState();storage.requests[0].succeed();await settle();
  h.state.lastActive['space-work']=5;h.saveWindowState();storage.requests[1].fail();await settle();
  h.state.lastActive['space-work']=4;h.saveWindowState();assert.equal(storage.requests.length,3);
  storage.requests[2].succeed();await settle();h.saveWindowState();assert.equal(storage.requests.length,3);
});
