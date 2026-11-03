import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness, sourcePath, measure } from '../../script/verify_workspace_tab_updates.mjs';

const source = await readFile(sourcePath, 'utf8');
// Restore the original unconditional render while running the same real code.
const baseline = source.replace('if (!unchanged) render();', 'render();');
const pair = async () => Promise.all([harness(baseline), harness(source)]);
const equivalent = (a, b) => assert.deepEqual(b.snapshot(), a.snapshot());
const publish = async (both, id, change, extra) => {
  for (const h of both) { h.update(id, change, extra); h.flushFrames(); await h.timers(150); }
  equivalent(...both);
};

test('actual autoDiscardable events avoid scheduled frames and full draws, preserving state and DOM', async () => {
  assert.equal((await measure(baseline)).drawn, 20, 'reproduce baseline redundancy');
  const both = await pair();
  for (let i = 0; i < 20; i++) await publish(both, 3, { autoDiscardable: Boolean(i % 2) });
  assert.deepEqual(both.map(h => [h.counters.scheduled, h.counters.drawn, h.versions()[0]]), [[20, 20, 20], [0, 0, 20]]);
  assert.equal(both[1].state.tabs.get(3).autoDiscardable, true);
  assert.deepEqual(both[1].counters.writes, []);
});

test('visual, membership, sorting and unknown changes retain baseline work and snapshots', async () => {
  const both = await pair();
  const events = [
    [3, { title: 'Renamed' }], [3, { url: 'https://example.invalid/next' }],
    [3, { favIconUrl: 'data:image/png;base64,fixture' }], [3, { status: 'loading' }],
    [3, { status: 'complete', autoDiscardable: false }], [3, { discarded: true }],
    [3, { audible: true }], [3, { mutedInfo: { muted: true, reason: 'user' } }],
    [3, { active: false }], [4, { active: true }], [3, { index: 0 }],
    [1, { pinned: false }], [1, { pinned: true }],
    [3, { pendingUrl: 'https://example.invalid/pending' }],
    [3, { unknownFutureField: { nested: 'changed' } }], [3, {}],
    [3, { autoDiscardable: true, title: 'Mixed' }],
    [8, { url: 'https://calendar.example.com/event', title: 'Favourite keeps identity' }],
    [6, { title: 'Inactive space' }], [3, { windowId: 8, title: 'Other window ignored' }],
    [3, { windowId: 7, title: 'Back in this window' }],
  ];
  for (const args of events) await publish(both, ...args);
  assert.equal(both[1].counters.refreshScheduled, 2);
  assert.ok(both[1].counters.writes.some(w => w[0] === 'members'));
  assert.equal(both[1].counters.drawn, both[0].counters.drawn);
  // A close after skipped updates uses the same active/fallback model and drops membership.
  await publish(both, 4, { autoDiscardable: false });
  for (const h of both) { h.onRemoved(4, { windowId: 7, isWindowClosing: false }); h.flushFrames(); await h.timers(150); }
  equivalent(...both);
});

test('first-seen tabs and full-snapshot differences redraw even with autoDiscardable-only changeInfo', async () => {
  for (const [id, extra] of [[99, { title: 'First seen' }], [3, { title: 'Omitted title' }],
    [3, { index: 100 }], [3, { active: false }], [3, { mutedInfo: { muted: true } }],
    [3, { newField: true }], [3, { pendingUrl: 'https://example.invalid/' }]]) {
    const both = await pair();
    await publish(both, id, { autoDiscardable: false }, extra);
    assert.equal(both[1].counters.drawn, 1);
  }
});

test('flat cloned mutedInfo can be equivalent; mutable aliases and unknown nested data default to redraw', async () => {
  const both = await pair();
  await publish(both, 3, { mutedInfo: { muted: false, reason: 'user', extensionId: 'fake' } });
  await publish(both, 3, { autoDiscardable: false });
  assert.equal(both[0].counters.drawn - both[1].counters.drawn, 1);
  for (const mode of ['same-tab', 'same-muted', 'unknown-nested', 'muted-nested']) {
    const h = await harness();
    const previous = h.state.tabs.get(3);
    previous.mutedInfo = { muted: false };
    let tab = structuredClone(previous);
    if (mode === 'same-tab') tab = previous;
    if (mode === 'same-muted') { tab.mutedInfo = previous.mutedInfo; tab.mutedInfo.muted = true; }
    if (mode === 'unknown-nested') { previous.future = { a: 1 }; tab.future = { a: 1 }; }
    if (mode === 'muted-nested') { previous.mutedInfo.future = { a: 1 }; tab.mutedInfo.future = { a: 1 }; }
    tab.autoDiscardable = false;
    h.onUpdated(3, { autoDiscardable: false }, tab); h.flushFrames();
    assert.equal(h.counters.drawn, 1, mode);
  }
});

test('skipped events invalidate in-flight queries at the exact event version and trigger recovery', async () => {
  const both = await pair();
  for (const h of both) {
    h.holdQuery(); const pending = h.refreshTabs();
    assert.deepEqual(Array.from(h.versions()), [0, 1]);
    h.update(3, { autoDiscardable: false });
    assert.deepEqual(Array.from(h.versions()), [1, 1]);
    h.releaseQuery(); await pending;
    assert.equal(h.state.tabs.get(3).autoDiscardable, false, 'stale snapshot rejected');
    assert.equal(h.counters.refreshScheduled, 1);
    await h.timers(50); h.flushFrames();
    assert.deepEqual(Array.from(h.versions()), [1, 2]);
    assert.equal(h.counters.queries, 2);
  }
  equivalent(...both);
});

test('newer queries win and mixed bursts coalesce without dropping visual state', async () => {
  const both = await pair();
  for (const h of both) {
    h.holdQuery(); const stale = h.refreshTabs();
    h.update(3, { autoDiscardable: false }); h.update(3, { title: 'Latest title' });
    h.update(3, { autoDiscardable: true }); h.update(1, { pinned: false });
    await h.refreshTabs(); h.releaseQuery(); await stale; h.flushFrames();
    assert.deepEqual(Array.from(h.versions()), [4, 2]);
    assert.equal(h.counters.drawn, 1);
    assert.equal(h.counters.refreshScheduled, 1, 'superseded query adds no retry');
    await h.timers(150);
  }
  equivalent(...both);
});

test('deterministic mixed stream preserves snapshots after every event and activation', async () => {
  const both = await pair();
  let random = 0x5937;
  for (let i = 0; i < 160; i++) {
    random = (Math.imul(random, 1664525) + 1013904223) >>> 0;
    const id = [1, 2, 3, 4, 6, 8][random % 6];
    const change = [
      { autoDiscardable: Boolean(i % 2) }, { title: `Title ${i}` },
      { status: i % 2 ? 'loading' : 'complete' }, { discarded: Boolean(i % 2) },
      { audible: Boolean(i % 2) }, { mutedInfo: { muted: Boolean(i % 2), reason: 'user' } },
      { pinned: Boolean(i % 2) }, { url: `https://example.invalid/${i}` },
      { autoDiscardable: false, title: `Mixed ${i}` },
    ][(random >>> 8) % 9];
    await publish(both, id, change);
    if (i % 20 === 0) {
      for (const h of both) { h.onActivated({ tabId: id, windowId: 7 }); h.flushFrames(); }
      equivalent(...both);
    }
  }
  assert.equal(both[0].versions()[0], 168);
  assert.equal(both[1].versions()[0], 168);
  assert.ok(both[1].counters.drawn < both[0].counters.drawn);
});
