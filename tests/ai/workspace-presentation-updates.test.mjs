import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness, sourcePath, fullDrawOracle } from './workspace-activation-harness.mjs';
import { STORE_KEY } from '../../features/ai/extension/workspace-store.js';

const candidate = await readFile(sourcePath, 'utf8');
const original = fullDrawOracle(candidate);
const pair = () => Promise.all([harness(original), harness(candidate)]);
const equal = both => assert.deepEqual(both[1].snapshot(), both[0].snapshot());
const flush = both => both.forEach(h => h.flushFrames());
const activate = (h, id, windowId = 7) => {
  if (windowId === 7) h.browserTabs.forEach(tab => { tab.active = tab.id === id; });
  h.onActivated({ tabId: id, windowId });
};
const row = (h, id) => h.nodes.get('today').children.find(row => row.dataset.key === `t:${id}`);
const burst = (h, ids = [3], count = 100) => {
  for (let i = 0; i < count; i++) h.update(ids[i % ids.length], { title: `Title ${i}`, status: i % 2 ? 'loading' : 'complete', audible: Boolean(i % 2) });
};

test('coalesce one tab burst into one scheduled row batch with full-draw equivalence', async () => {
  const both = await pair();
  both.forEach(h => burst(h));
  assert.equal(both[1].counters.rowUpdates, 0); assert.equal(both[1].counters.focusSyncs, 0);
  assert.equal(both[1].framesPending(), 1);
  assert.deepEqual(Array.from(both[1].pending().rows), [3]);
  assert.deepEqual(both[1].snapshot().dom, both[0].snapshot().dom, 'both defer presentation until the next frame');
  flush(both); equal(both);
  assert.equal(both[1].counters.rowUpdates, 1); assert.equal(both[1].counters.focusSyncs, 1);
  assert.equal(both[0].counters.models, 1, 'the comparison executes the unchanged complete draw');
  assert.equal(both[1].counters.models, 0); assert.equal(both[1].pending().rows, null);
  assert.equal(both[1].framesPending(), 0);
});

test('many tabs each update once per frame; later frames cannot reuse stale queued IDs', async () => {
  const both = await pair(); both.forEach(h => burst(h, [3, 4, 5], 150));
  flush(both); equal(both);
  assert.equal(both[1].counters.rowUpdates, 3); assert.equal(both[1].counters.focusSyncs, 1);
  both.forEach(h => h.update(4, { title: 'Next frame' }));
  flush(both); equal(both);
  assert.equal(both[1].counters.rowUpdates, 4); assert.equal(both[1].counters.focusSyncs, 2);
  assert.equal(both[1].counters.models, 0);
});

const structuralEvents = {
  create(h) { h.create({ id: 99, windowId: 7, index: 8, active: false, pinned: false, status: 'loading', url: 'about:blank', title: '' }); },
  remove(h) { h.browserTabs.splice(h.browserTabs.findIndex(tab => tab.id === 4), 1); h.onRemoved(4, { windowId: 7, isWindowClosing: false }); },
  pin(h) { h.update(3, { pinned: true }); },
  index(h) { h.update(4, { index: 0 }); },
  unknown(h) { h.update(3, { unknownFutureField: 'preserve' }); },
  store(h) {
    const store = structuredClone(h.state.store);
    store.spaces[0].name = 'Changed space'; store.spaces[0].pinned[0].open = false;
    h.emit('storage.local.onChanged', { [STORE_KEY]: { newValue: store } });
  },
};

for (const [name, event] of Object.entries(structuralEvents)) {
  test(`queued presentation then ${name} promotes the existing callback to one complete draw`, async () => {
    const both = await pair();
    for (const h of both) { burst(h, [3, 4], 20); event(h); h.update(5, { title: 'Later presentation' }); }
    assert.equal(both[1].framesPending(), 1); assert.equal(both[1].pending().rows, null);
    assert.equal(both[1].counters.rowUpdates, 0);
    flush(both); equal(both);
    assert.equal(both[1].counters.models, 1); assert.equal(both[1].counters.focusSyncs, 1);
    for (const h of both) await h.timers(150);
    equal(both);
  });
  test(`complete ${name} draw already pending cannot be downgraded by presentation`, async () => {
    const both = await pair();
    for (const h of both) { event(h); burst(h, [3, 5], 20); }
    assert.equal(both[1].pending().rows, null); assert.equal(both[1].framesPending(), 1);
    flush(both); equal(both); assert.equal(both[1].counters.models, 1);
  });
}

test('activation while presentation is queued cannot use stale-model fast path', async () => {
  const both = await pair();
  for (const h of both) { h.update(3, { title: 'Before activation' }); activate(h, 4); h.update(4, { title: 'After activation' }); }
  assert.equal(both[1].counters.rowUpdates, 0); assert.equal(both[1].pending().rows, null);
  flush(both); equal(both); assert.equal(both[1].counters.models, 1);
});

test('activation then presentation preserves immediate activation and defers latest title once', async () => {
  const both = await pair();
  for (const h of both) { activate(h, 4); burst(h, [4]); }
  assert.equal(both[1].counters.rowUpdates, 2, 'existing ordinary activation updates two rows immediately');
  assert.deepEqual(both[1].snapshot().dom, both[0].snapshot().dom);
  flush(both); equal(both);
  assert.equal(both[1].counters.models, 0); assert.equal(both[1].counters.rowUpdates, 3);
});

test('cross-window activation cannot discard queued presentation or write this window state', async () => {
  const both = await pair();
  for (const h of both) { h.update(3, { title: 'This window' }); activate(h, 4, 8); }
  assert.deepEqual(Array.from(both[1].pending().rows), [3]);
  flush(both); equal(both);
  assert.equal(both[1].counters.models, 0); assert.deepEqual(both[1].counters.writes, []);
});

test('canonical model/item/tab references retain latest fields while DOM waits for one frame', async () => {
  const h = await harness(candidate), tab = h.state.tabs.get(3), model = h.state.model, item = h.state.items.get('t:3');
  burst(h);
  assert.equal(h.state.tabs.get(3), tab); assert.equal(h.state.model, model); assert.equal(h.state.items.get('t:3'), item);
  assert.equal(tab.title, 'Title 99'); assert.notEqual(row(h, 3).children[1].textContent, tab.title);
  h.flushFrames(); assert.equal(row(h, 3).children[1].textContent, tab.title);
  assert.equal(h.state.model, model); assert.equal(h.state.items.get('t:3'), item);
});

test('queued rows are revalidated together before any row writes after membership or DOM changes', async () => {
  for (const mode of ['membership', 'missing', 'leaving', 'space']) {
    const both = await pair();
    for (const h of both) {
      burst(h, [3, 4], 12);
      if (mode === 'membership') h.setRecord(4, { e: 'e-spec' });
      if (mode === 'missing') row(h, 4).remove();
      if (mode === 'leaving') row(h, 4).classList.add('leaving');
      if (mode === 'space') h.state.activeSpaceId = 'space-personal';
    }
    assert.equal(both[1].counters.rowUpdates, 0);
    flush(both); equal(both); assert.equal(both[1].counters.models, 1, mode);
    assert.equal(both[1].counters.rowUpdates, both[0].counters.rowUpdates, 'no partial row batch before complete draw');
  }
});

test('membership changes for a different tab promote queued rows before asynchronous native completion', async () => {
  const both = await pair();
  for (const h of both) { h.update(3, { title: 'Queued tab' }); h.setRecord(4, { e: 'e-spec' }); }
  assert.equal(both[1].pending().rows, null);
  flush(both); equal(both); assert.equal(both[1].counters.models, 1);
});

test('detach and asynchronous attachment membership retain baseline frame and query ordering', async () => {
  for (const direction of ['detach', 'attach']) {
    const both = await pair();
    for (const h of both) {
      h.update(3, { title: 'Queued before transfer' });
      if (direction === 'detach') {
        h.browserTabs.splice(h.browserTabs.findIndex(tab => tab.id === 4), 1);
        h.onDetached(4, { oldWindowId: 7 });
      } else {
        h.browserTabs.push({ id: 99, windowId: 7, index: 8, active: false, pinned: false, status: 'complete', url: 'https://example.invalid/attached', title: 'Attached' });
        h.onAttached(99, { newWindowId: 7 });
      }
      for (let i = 0; i < 12; i++) await Promise.resolve();
    }
    assert.equal(both[1].pending().rows, null);
    flush(both); equal(both); assert.equal(both[1].counters.models, 1);
    for (const h of both) await h.timers(150);
    equal(both);
  }
});

test('held transfer queries cannot postpone structural membership changes behind a row-only frame', async () => {
  for (const direction of ['detach', 'attach']) {
    const both = await pair();
    for (const h of both) {
      h.update(3, { title: 'Queued before held transfer' }); h.holdQuery();
      if (direction === 'detach') {
        h.browserTabs.splice(h.browserTabs.findIndex(tab => tab.id === 4), 1);
        h.onDetached(4, { oldWindowId: 7 });
      } else {
        h.browserTabs.push({ id: 99, windowId: 7, index: 8, active: false, pinned: false, status: 'complete', url: 'https://example.invalid/attached', title: 'Attached' });
        h.onAttached(99, { newWindowId: 7 });
      }
      for (let i = 0; i < 4; i++) await Promise.resolve();
      assert.equal(h.counters.queries, 1);
    }
    assert.equal(both[1].pending().rows, null);
    flush(both); equal(both); assert.equal(both[1].counters.models, 1, direction);
    for (const h of both) { h.releaseQuery(); for (let i = 0; i < 12; i++) await Promise.resolve(); }
    flush(both); equal(both); assert.equal(both[1].counters.models, direction === 'detach' ? 1 : 2, direction);
  }
});

test('rename flush cancels the queued callback, draws current fields and releases queued IDs', async () => {
  const both = await pair();
  for (const h of both) { h.update(3, { title: 'Before rename' }); h.startRename({ kind: 'space', id: 'space-work', key: 's:space-work' }); }
  equal(both); assert.equal(both[1].pending().rows, null); assert.equal(both[1].framesPending(), 0);
  assert.equal(both[1].counters.models, 1);
  for (const h of both) h.update(3, { title: 'During rename' });
  flush(both); equal(both);
  assert.equal(both[1].nodes.get('space-name').children[0].tag, 'input');
});

test('roving focus is synchronized once and survives a burst', async () => {
  const both = await pair();
  for (const h of both) { h.state.focus.today = 't:5'; burst(h, [3, 4]); }
  flush(both); equal(both);
  assert.equal(row(both[1], 5).tabIndex, 0); assert.equal(both[1].counters.focusSyncs, 1);
});

test('row bursts invalidate in-flight query snapshots and preserve exact recovery versions', async () => {
  const both = await pair();
  for (const h of both) {
    h.holdQuery(); const pending = h.refreshTabs(); burst(h);
    h.releaseQuery(); await pending;
    assert.equal(h.state.tabs.get(3).title, 'Title 99');
    assert.equal(h.counters.refreshScheduled, 1);
    h.flushFrames(); await h.timers(50); h.flushFrames(); await h.timers(150);
  }
  equal(both); assert.deepEqual(both.map(h => Array.from(h.versions())), [[100, 2], [100, 2]]);
});

test('equal query completion preserves queued row work for an equivalent snapshot', async () => {
  const both = await pair();
  for (const h of both) { burst(h); await h.refreshTabs(); }
  assert.deepEqual(Array.from(both[1].pending().rows), [3]); flush(both); equal(both);
  assert.equal(both[1].counters.models, 0); assert.equal(both[1].counters.queries, 1);
});

test('saved and hidden rows, unknown fields and mutable aliases keep complete reconciliation', async () => {
  for (const [id, change, extra] of [[1, { title: 'Saved' }], [2, { status: 'loading' }], [8, { audible: true }],
    [6, { title: 'Hidden' }], [3, { title: 'Incomplete snapshot' }, { index: 20 }],
    [3, { autoDiscardable: false }, { title: 'Unreported presentation' }],
    [3, { title: 'Unknown nested' }, { future: { nested: true } }]]) {
    const both = await pair(); both.forEach(h => h.update(id, change, extra));
    flush(both); equal(both); assert.equal(both[1].counters.models, 1);
  }
  const h = await harness(candidate), tab = h.state.tabs.get(3);
  tab.title = 'Aliased'; h.onUpdated(3, { title: 'Aliased' }, tab); h.flushFrames();
  assert.equal(h.counters.models, 1);
});

test('mixed bursts preserve complete snapshots after every frame and membership flush', async () => {
  const both = await pair(); let random = 0x382f;
  for (let frame = 0; frame < 50; frame++) {
    for (let i = 0; i < 12; i++) {
      random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
      const id = [1, 2, 3, 4, 5, 6, 8][random % 7];
      const change = [{ title: `Frame ${frame} event ${i}` }, { status: i % 2 ? 'loading' : 'complete' },
        { audible: Boolean(i % 2) }, { discarded: Boolean(i % 2) }, { autoDiscardable: Boolean(i % 2) },
        { url: `https://example.invalid/${frame}/${i}` }, { mutedInfo: { muted: Boolean(i % 2) } }][(random >>> 8) % 7];
      both.forEach(h => h.update(id, change));
      if (i === 8 && frame % 5 === 0) both.forEach(h => activate(h, [3, 4][frame % 2]));
    }
    flush(both); equal(both);
    for (const h of both) await h.timers(150);
    equal(both);
  }
});

test('negative controls detect a dropped structural promotion and unsafe activation during queued rows', async () => {
  const noPromotion = candidate.replace('if (tabId === undefined) pendingRows = null;', 'if (tabId === undefined) {}');
  assert.notEqual(noPromotion, candidate);
  const unsafe = await harness(noPromotion), safe = await harness(candidate);
  for (const h of [unsafe, safe]) { h.update(3, { title: 'Queued' }); structuralEvents.store(h); h.flushFrames(); }
  assert.notDeepEqual(unsafe.snapshot(), safe.snapshot());
  const noActivationGuard = candidate.replace('next && !frame && state.drawn', 'next && state.drawn');
  assert.notEqual(noActivationGuard, candidate);
  const mutant = await harness(noActivationGuard); mutant.update(3, { title: 'Queued' }); activate(mutant, 4);
  assert.equal(mutant.counters.rowUpdates, 2, 'mutant touches activation rows before the pending presentation frame');
  const normal = await harness(candidate); normal.update(3, { title: 'Queued' }); activate(normal, 4);
  assert.equal(normal.counters.rowUpdates, 0); assert.equal(normal.pending().rows, null);
});

test('negative control detects omitted frame-time membership revalidation', async () => {
  const noRevalidation = candidate.replace('return { tab, row: todayRow(tab) };', "return { tab, row: [...$('today').children].find(row => row.dataset.key === `t:${id}`) };");
  assert.notEqual(noRevalidation, candidate);
  const unsafe = await harness(noRevalidation), safe = await harness(candidate);
  for (const h of [unsafe, safe]) {
    h.update(3, { title: 'Queued' });
    h.state.records[3] = { ...h.state.records[3], e: 'e-spec' };
    h.flushFrames();
  }
  assert.notDeepEqual(unsafe.snapshot(), safe.snapshot());
});
