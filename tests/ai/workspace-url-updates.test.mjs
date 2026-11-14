import test from 'node:test';
import assert from 'node:assert/strict';
import { harness, fullDrawOracle, sourcePath } from './workspace-activation-harness.mjs';
import { readFile } from 'node:fs/promises';

const source = await readFile(sourcePath, 'utf8');
const pair = () => Promise.all([harness(fullDrawOracle(source)), harness(source)]);
const equal = both => assert.deepEqual(both[1].snapshot(), both[0].snapshot());

test('Today URL bursts retain complete-draw output and trailing membership writes with only row work', async () => {
  const both = await pair();
  for (let i = 0; i < 10; i++) {
    for (const h of both) { h.update(3, { url: `https://example.invalid/${i}`, status: 'loading' }); h.flushFrames(); }
    equal(both);
  }
  assert.deepEqual(both.map(h => h.counters.models), [10, 0]);
  assert.equal(both[1].counters.rowUpdates, 10);
  assert.deepEqual(both[1].counters.writes, [], '150 ms membership writes remain deferred');
  for (const h of both) await h.timers(150);
  equal(both);
  const members = both[1].counters.writes.filter(write => write[0] === 'members');
  assert.equal(members.length, 1); assert.equal(members[0][1][3].u, 'https://example.invalid/9');
});

test('URL membership writes retain other queued Today rows', async () => {
  const h = await harness(); h.update(4, { title: 'Queued title' }); h.update(3, { url: 'https://example.invalid/queued' });
  assert.deepEqual(Array.from(h.pending().rows), [4, 3]);
  h.flushFrames(); assert.equal(h.counters.models, 0); assert.equal(h.counters.rowUpdates, 2);
});

test('pending URL presentation retains the canonical object and existing no-write behavior', async () => {
  const both = await pair(); const canonical = both[1].state.tabs.get(3);
  for (const h of both) { h.update(3, { pendingUrl: 'https://example.invalid/pending', title: '' }); h.flushFrames(); await h.timers(150); }
  equal(both); assert.strictEqual(both[1].state.tabs.get(3), canonical);
  assert.equal(canonical.pendingUrl, 'https://example.invalid/pending');
  assert.equal(both[1].counters.models, 0); assert.deepEqual(both[1].counters.writes, []);
});

test('URL updates with unreported structural changes still replace the complete snapshot', async () => {
  const both = await pair(); const previous = both[1].state.tabs.get(3);
  for (const h of both) { h.update(3, { url: 'https://example.invalid/moved' }, { index: 90 }); h.flushFrames(); }
  equal(both); assert.equal(both[1].counters.models, 1);
  assert.notStrictEqual(both[1].state.tabs.get(3), previous); assert.equal(both[1].state.tabs.get(3).index, 90);
});

test('a saved or favorite URL still uses complete reconciliation', async () => {
  for (const id of [1, 8]) {
    const both = await pair();
    for (const h of both) { h.update(id, { url: 'https://example.invalid/saved' }); h.flushFrames(); }
    equal(both); assert.equal(both[1].counters.models, 1);
  }
});

const row = (h, id) => h.nodes.get('today').children.find(n => n.dataset.key === `t:${id}`);
async function duplicatePair(code = source, options) {
  const both = await Promise.all([harness(fullDrawOracle(source), undefined, options), harness(code, undefined, options)]);
  for (const h of both) {
    h.update(3, { url: 'https://same.example/alpha', title: 'Project Alpha', favIconUrl: '' });
    h.update(4, { url: 'https://same.example/beta', title: 'Project Beta', favIconUrl: '' });
    h.flushFrames();
  }
  return both;
}

test('compact duplicate labels follow title, URL and favicon changes in a row batch', async () => {
  for (const favicon of [false, true]) {
    const both = await duplicatePair(source, { favicon });
    equal(both);
    assert.equal(row(both[1], 3).dataset.compactLabel, 'AL');
    assert.equal(row(both[1], 4).dataset.compactLabel, 'BE');
    for (const change of [{ title: 'Project Beta' }, { url: 'https://other.example/new' },
      { url: 'https://same.example/again' }, { favIconUrl: 'data:image/png;base64,fixture' }]) {
      for (const h of both) { h.update(3, change); h.flushFrames(); }
      equal(both);
    }
    assert.equal(row(both[1], 3).dataset.compactLabel, undefined);
    assert.equal(row(both[1], 4).dataset.compactLabel, undefined);
    assert.equal(row(both[1], 3).title, 'Project Beta');
  }
});

test('main two-character fallback and failed favicon redraw recompute compact identities', async () => {
  const both = await duplicatePair(source, { favicon: true });
  for (const h of both) {
    const holder = row(h, 3).children[0], img = holder.querySelector('img');
    img.onerror();
    assert.equal(holder.textContent, 'SA');
    assert.equal(h.framesPending(), 1, 'main fallback requests a complete redraw');
    h.flushFrames();
  }
  equal(both);
  assert.equal(row(both[1], 3).dataset.compactLabel, undefined);
  assert.equal(row(both[1], 4).dataset.compactLabel, undefined);
});

test('negative control exposes stale compact labels if the row batch omits recomputation', async () => {
  const mutant = source.replace('    compactLabels();\n    syncRovingFocus();\n  });', '    syncRovingFocus();\n  });');
  assert.notEqual(mutant, source);
  const both = await duplicatePair(mutant);
  assert.notDeepEqual(both[1].snapshot().dom, both[0].snapshot().dom);
});
