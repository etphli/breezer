import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { harness, sourcePath, fullDrawOracle } from '../../script/verify_workspace_activation.mjs';

const candidate = await readFile(sourcePath, 'utf8');
// Main draw remains the oracle; disabling only ordinary activation forces its full path.
const baseline = fullDrawOracle(candidate).replace('active.length === 1 && next && !frame', 'false && active.length === 1 && next && !frame');
const pair = () => Promise.all([harness(baseline), harness(candidate)]);
const equivalent = ([a, b]) => assert.deepEqual(b.snapshot(), a.snapshot());
const activate = (h, id) => h.onActivated({ tabId: id, windowId: 7 });
const flush = both => both.forEach(h => h.flushFrames());

test('ordinary Today activations avoid real model builds and reconciliation', async () => {
  const both = await pair();
  for (let i = 0; i < 10; i++) {
    for (const h of both) activate(h, i % 2 ? 3 : 4);
    flush(both); equivalent(both);
  }
  assert.deepEqual(both.map(h => [h.counters.models, h.counters.reconciles, h.counters.reconcileMaps, h.counters.queries]), [[10, 50, 50, 0], [0, 0, 0, 0]]);
  assert.equal(both[1].counters.rowUpdates, 20);
  assert.equal(both[1].versions()[0], 10);
});

test('updates before and after activation, including pending frame, keep complete rendering', async () => {
  for (const change of [{ title: 'New title' }, { url: 'https://example.test/new' }, { pinned: true }, { status: 'loading' }, { index: 0 }]) {
    const both = await pair();
    for (const h of both) { h.update(4, change); activate(h, 4); }
    flush(both); equivalent(both);
    assert.equal(both[1].counters.drawn, 1);
    for (const h of both) { h.update(3, { status: 'loading' }); h.flushFrames(); }
    equivalent(both);
  }
});

test('delayed query is invalidated and recovery preserves activation', async () => {
  const both = await pair();
  for (const h of both) {
    h.holdQuery(); const pending = h.refreshTabs();
    h.browserTabs.forEach(t => { t.active = t.id === 4; });
    activate(h, 4); h.releaseQuery(); await pending;
    assert.equal(h.counters.refreshScheduled, 1);
    await h.timers(50); h.flushFrames();
  }
  equivalent(both);
  assert.deepEqual(both.map(h => Array.from(h.versions())), [[1, 2], [1, 2]]);
});

test('saved tabs, cross-space, missing tab and pending close retain full path', async () => {
  for (const id of [1, 2, 6, 8, 99]) {
    const both = await pair();
    for (const h of both) activate(h, id);
    flush(both); equivalent(both);
    assert.equal(both[1].counters.drawn, 1, `tab ${id}`);
  }
  const both = await pair();
  for (const h of both) { h.onRemoved(3, { windowId: 7, isWindowClosing: false }); activate(h, 4); }
  flush(both); equivalent(both);
  assert.equal(both[1].counters.drawn, 1);
});

test('roving keyboard selection and unrelated windows are preserved', async () => {
  const both = await pair();
  for (const h of both) { h.state.focus.today = 't:5'; activate(h, 4); h.onActivated({ tabId: 3, windowId: 8 }); }
  flush(both); equivalent(both);
  assert.equal(both[1].nodes.get('today').children.find(n => n.dataset.key === 't:5').tabIndex, 0);
});

test('negative controls detect unconditional rendering and an unsafe pending-frame guard', async () => {
  const original = await harness(baseline);
  activate(original, 4); original.flushFrames();
  assert.equal(original.counters.models, 1);
  const unsafe = candidate.replace('next && !frame && state.drawn', 'next && state.drawn');
  assert.notEqual(unsafe, candidate);
  const mutant = await harness(unsafe);
  mutant.update(5, { title: 'Pending title' }); activate(mutant, 4);
  assert.equal(mutant.counters.rowUpdates, 2, 'unsafe guard touches rows before pending draw');
  const safe = await harness(candidate);
  safe.update(5, { title: 'Pending title' }); activate(safe, 4);
  assert.equal(safe.counters.rowUpdates, 0, 'pending draw owns the update');
});

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

test('identical window snapshots skip session writes; changed selection and failed writes remain retryable', async () => {
  const h = await harness(candidate);
  activate(h, 4); activate(h, 4); h.saveWindowState(); await settle();
  assert.equal(h.counters.writes.filter(w => w[0] === 'session').length, 1);
  activate(h, 3); await settle();
  assert.equal(h.counters.writes.filter(w => w[0] === 'session').length, 2);
  h.failSessionWrite(); activate(h, 4); await settle(); h.saveWindowState(); await settle();
  assert.equal(h.counters.writes.filter(w => w[0] === 'session').length, 4);
  assert.equal(h.snapshot().persisted.session['workspace.window.7'].lastActive['space-work'], 4);
  assert.equal(h.counters.queries, 0, 'ordinary activations require no tab query');
});

test('space switching activates before revealing and retains main space names and tooltips', async () => {
  const h = await harness(candidate);
  h.holdActivation(); h.switchSpace('space-personal');
  assert.equal(h.state.activeSpaceId, 'space-personal');
  assert.equal(h.state.model.space.id, 'space-work', 'old pane stays until native activation resolves');
  assert.equal(h.counters.drawn, 0);
  h.releaseActivation(); await settle();
  assert.equal(h.state.model.space.id, 'space-personal');
  assert.equal(h.state.tabs.get(6).active, true);
  assert.equal(h.nodes.get('space-name').textContent, 'Personal');
  const dot = h.nodes.get('spaces').children.find(n => n.dataset.key === 's:space-personal');
  assert.equal(dot.querySelector('.space-label').textContent, 'Personal');
  assert.equal(dot.title, 'Personal (⌃2)');
  assert.equal(dot.getAttribute('aria-selected'), 'true');
  assert.equal(h.counters.drawn, 1);
  assert.equal(h.counters.queries, 0);
});

test('newer tab events fence stale activation completion before space reveal', async () => {
  const h = await harness(candidate);
  h.holdActivation(); h.switchSpace('space-personal');
  activate(h, 7); const version = h.versions()[0];
  h.releaseActivation(); await settle(); h.flushFrames();
  assert.equal(h.state.model.space.id, 'space-personal');
  assert.equal(h.state.tabs.get(7).active, true);
  assert.equal(h.state.tabs.get(6).active, false);
  assert.equal(h.state.lastActive['space-personal'], 7);
  assert.equal(h.versions()[0], version);
});

test('negative control catches repeated session writes without snapshot deduplication', async () => {
  const mutant = candidate.replace('if (signature === savedWindowState) return;', '');
  assert.notEqual(mutant, candidate);
  const h = await harness(mutant);
  activate(h, 4); activate(h, 4);
  assert.equal(h.counters.writes.filter(w => w[0] === 'session').length, 2);
});
