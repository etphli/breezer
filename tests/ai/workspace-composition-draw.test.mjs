import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {harness} from './fixtures/workspace-composition/harness.mjs';

const baseline = await readFile(new URL('./fixtures/workspace-composition/baseline-workspace.js', import.meta.url), 'utf8');
const candidate = await readFile(new URL('../../features/ai/extension/workspace.js', import.meta.url), 'utf8');
const both = options => Promise.all([harness(baseline, options?.()), harness(candidate, options?.())]);
const equal = pair => assert.deepEqual(pair[1].snapshot(), pair[0].snapshot());
const newTab = () => ({id: 99, windowId: 7, index: 8, active: false, pinned: false, status: 'complete',
  url: 'https://example.invalid/new', title: 'Opened during startup'});

test('baseline reproduces the redundant startup model and reconciliation work', async () => {
  const pair = await both(() => ({boot: true}));
  for (const h of pair) {await h.initSidebar({windowId: 7}); h.flushFrames();}
  equal(pair);
  assert.deepEqual(pair.map(h => [h.counters.queries, h.counters.drawn, h.counters.models, h.counters.reconciles]),
    [[2, 2, 2, 10], [2, 1, 1, 5]]);
});

test('a tab opened during reconciliation is caught by the retained second query', async () => {
  const pair = await both(() => ({boot: true, reconcile({browserTabs, listeners}) {
    assert.equal(listeners['tabs.onCreated'], undefined, 'this tab opens before the subscription');
    browserTabs.push(newTab());
  }}));
  for (const h of pair) {await h.initSidebar({windowId: 7}); h.flushFrames();}
  equal(pair);
  assert.equal(pair[1].state.tabs.get(99).title, 'Opened during startup');
  assert.ok(pair[1].snapshot().items.some(([key]) => key === 't:99'));
  assert.equal(pair[1].counters.models, 1);
});

test('an event during the second query invalidates its snapshot and the recovery still paints', async () => {
  const pair = await both(() => ({boot: true, query({number, browserTabs, listeners}) {
    if (number !== 2) return;
    const tab = newTab(); browserTabs.push(tab);
    for (const fn of listeners['tabs.onCreated']) fn(structuredClone(tab));
  }}));
  for (const h of pair) {
    await h.initSidebar({windowId: 7}); h.flushFrames();
    assert.equal(h.state.tabs.get(99).title, 'Opened during startup');
    assert.equal(h.counters.refreshScheduled, 2, 'creation schedules recovery and the stale query replaces that timer');
    await h.timers(50); h.flushFrames(); await h.timers(150);
  }
  equal(pair);
  assert.deepEqual(pair.map(h => Array.from(h.versions())), [[1, 2], [1, 2]]);
  assert.equal(pair[1].counters.models, 1, 'recovery confirms the already painted event state');
});

test('synchronous complete draws consume full and row-only queued work', async () => {
  for (const rowsOnly of [false, true]) {
    const pair = await both();
    for (const h of pair) {
      h.update(3, {title: 'Latest row value'});
      if (!rowsOnly) h.render();
      h.draw();
    }
    equal(pair);
    for (const h of pair) h.flushFrames();
    equal(pair);
    assert.equal(pair[1].counters.models, 1);
    assert.equal(pair[1].framesPending(), 0);
    assert.equal(pair[1].pending().frame, 0);
    assert.equal(pair[1].pending().rows, null);
  }
});

test('a new presentation event after a synchronous draw schedules and paints its own frame', async () => {
  const pair = await both();
  for (const h of pair) {
    h.update(3, {title: 'First value'}); h.draw();
    h.update(3, {title: 'Later value'});
    assert.equal(h.framesPending(), 1);
    h.flushFrames();
  }
  equal(pair);
  assert.equal(pair[1].counters.models, 1);
  assert.equal(pair[1].nodes.get('today').children.find(row => row.dataset.key === 't:3').querySelector('.title').textContent, 'Later value');
});

test('an authoritative query completing after a synchronous draw schedules another full draw', async () => {
  const pair = await both();
  for (const h of pair) {
    h.holdQuery(); const pending = h.refreshTabs();
    h.render(); h.draw();
    h.browserTabs.find(tab => tab.id === 3).title = 'Authoritative query value';
    h.releaseQuery(); await pending;
    assert.equal(h.framesPending(), h === pair[0] ? 1 : 0); h.flushFrames();
    await h.refreshTabs(); h.flushFrames();
  }
  equal(pair);
  assert.equal(pair[1].counters.models, 2);
});

test('synchronous space changes consume old queued rows and preserve focus and saved state', async () => {
  const pair = await both();
  for (const h of pair) {
    h.update(3, {title: 'Updated before space change'});
    h.switchSpace('space-personal', {activateTab: false}); h.flushFrames();
  }
  equal(pair);
  assert.equal(pair[1].state.model.space.id, 'space-personal');
  assert.equal(pair[1].counters.models, 1);
});

test('rename still flushes queued work and preserves its input through the next frame', async () => {
  const pair = await both();
  for (const h of pair) {
    h.update(3, {title: 'Before rename'});
    h.startRename({kind: 'space', id: 'space-work', key: 's:space-work'});
    h.flushFrames();
    h.update(3, {title: 'During rename'}); h.flushFrames();
  }
  equal(pair);
  assert.equal(pair[1].nodes.get('space-name').children[0].tag, 'input');
});

test('uninterrupted queued rendering and drawing with no queued frame remain unchanged', async () => {
  const pair = await both();
  for (let i = 0; i < 24; i++) {
    for (const h of pair) {
      h.update(3 + i % 3, {title: `Frame ${i}`});
      if (i % 3 === 0) h.render();
      if (i % 4 === 0) h.draw();
      h.flushFrames();
    }
    equal(pair);
  }
});

test('animation-enabled startup and structural updates retain entering and leaving lifetimes', async () => {
  const pair = await both(() => ({boot: true, reducedMotion: false}));
  for (const h of pair) {await h.initSidebar({windowId: 7}); h.flushFrames();}
  equal(pair);
  for (const h of pair) {
    h.create(newTab()); h.draw(); h.flushFrames();
    h.browserTabs.splice(h.browserTabs.findIndex(tab => tab.id === 4), 1);
    h.onRemoved(4, {windowId: 7, isWindowClosing: false}); h.draw(); h.flushFrames();
    assert.ok(h.nodes.get('today').children.some(node => node.classList.contains('leaving')));
  }
  equal(pair);
  for (const h of pair) {await h.timers(140); await h.timers(50); h.flushFrames(); await h.timers(150);}
  equal(pair);
  assert.ok(!pair[1].nodes.get('today').children.some(node => node.classList.contains('leaving')));
});

