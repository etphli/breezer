import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness, sourcePath } from './workspace-activation-harness.mjs';

const source = await readFile(sourcePath, 'utf8');
const start = source.indexOf('  const previous = state.tabs.get(tabId);', source.indexOf('function onUpdated'));
const end = source.indexOf('  if (change.url', start);
assert.ok(start > 0 && end > start);
const baseline = source.slice(0, start) + `  const row = null; const unchanged = onlyTabFieldsChanged(state.tabs.get(tabId), change, tab, ['autoDiscardable']);\n  state.tabs.set(tabId, tab);\n` + source.slice(end);
const candidate = process.env.SIDEBAR_RETENTION_NEGATIVE_CONTROL ? baseline : source;

async function fixture(code) {
  const h = await harness(code);
  h.browserTabs.splice(0);
  h.state.records = {};
  for (let i = 1; i <= 100; i++) {
    const tab = { id: i, windowId: 7, index: i - 1, active: i === 1, pinned: false,
      url: `https://example.invalid/article/${i}?fixture=${'x'.repeat(120)}`,
      title: `Article ${i}`, autoDiscardable: true, mutedInfo: { muted: false },
      futureProperty: `preserve-${i}` };
    h.browserTabs.push(structuredClone(tab));
    h.state.records[i] = { s: 'space-work', u: tab.url };
  }
  h.state.tabs = new Map(h.browserTabs.map(tab => [tab.id, structuredClone(tab)]));
  h.render(); h.flushFrames();
  h.counters.drawn = h.counters.scheduled = 0;
  return h;
}
function retained(h) {
  const tabs = new Set([...h.state.tabs.values(), ...h.state.model.today,
    ...[...h.state.items.values()].map(item => item.tab).filter(Boolean)]);
  return { objects: tabs.size, jsonBytes: Buffer.byteLength(JSON.stringify([...tabs])) };
}

test('100 visible tabs keep one full snapshot each through repeated guarded events', async (t) => {
  const old = await fixture(baseline), current = await fixture(candidate);
  for (let round = 0; round < 5; round++) for (let id = 1; id <= 100; id++) {
    for (const h of [old, current]) h.update(id, { autoDiscardable: Boolean(round % 2) });
  }
  t.diagnostic(JSON.stringify({ baseline: retained(old), candidate: retained(current), updates: 500, draws: [old.counters.drawn, current.counters.drawn] }));
  assert.equal(retained(old).objects, 200);
  assert.equal(retained(current).objects, 100);
  assert.ok(retained(current).jsonBytes < retained(old).jsonBytes * 0.51);
  // The deliberately stale baseline model is the retention defect under test.
  const observable = h => { const { model, items, ...snapshot } = h.snapshot(); return snapshot; };
  assert.deepEqual(observable(current), observable(old));
  assert.deepEqual([old.counters.drawn, current.counters.drawn], [0, 0]);
  for (const tab of current.state.model.today) {
    assert.strictEqual(tab, current.state.tabs.get(tab.id));
    assert.equal(tab.futureProperty, `preserve-${tab.id}`);
  }
});

test('guarded updates during a held query reject stale results and recover with latest properties', async () => {
  const h = await fixture(source);
  h.holdQuery(); const pending = h.refreshTabs();
  for (let id = 1; id <= 100; id++) h.update(id, { autoDiscardable: false });
  h.update(5, { title: 'Latest', unknownField: 'kept' });
  h.releaseQuery(); await pending;
  assert.equal(h.state.tabs.get(5).title, 'Latest');
  assert.equal(h.counters.refreshScheduled, 1);
  await h.timers(50); h.flushFrames();
  assert.equal(h.state.tabs.get(5).unknownField, 'kept');
  assert.equal(h.state.tabs.get(100).autoDiscardable, false);
  assert.equal(retained(h).objects, 100);
});

test('space changes and both close paths retain baseline behavior after guarded storms', async () => {
  const both = await Promise.all([fixture(baseline), fixture(source)]);
  for (const h of both) {
    for (let id = 1; id <= 100; id++) h.update(id, { autoDiscardable: false });
    h.state.activeSpaceId = h.state.store.spaces.find(space => space.id !== 'space-work').id;
    h.render(); h.flushFrames();
    h.state.activeSpaceId = 'space-work'; h.render(); h.flushFrames();
    h.onRemoved(1, { windowId: 7, isWindowClosing: true });
    h.onRemoved(2, { windowId: 7, isWindowClosing: false });
    h.flushFrames(); await h.timers(150);
  }
  assert.deepEqual(both[1].snapshot(), both[0].snapshot());
  assert.ok(!both[1].counters.writes.some(write => write[0] === 'members' && write[2].includes('1')));
  assert.ok(both[1].counters.writes.some(write => write[0] === 'members' && write[2].includes('2')));
});
