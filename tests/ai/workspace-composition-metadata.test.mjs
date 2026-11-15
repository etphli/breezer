import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {harness, fullDrawOracle} from './fixtures/workspace-composition/harness.mjs';

const file = process.env.SIDEBAR_METADATA_SOURCE || 'candidate';
const source = await readFile(new URL('../../features/ai/extension/workspace.js', import.meta.url), 'utf8');
const pair = () => Promise.all([harness(source), harness(fullDrawOracle(source))]);
const flush = both => both.forEach(h => h.flushFrames());
const compare = async both => {
  await Promise.all(both.map(h => h.refreshTabs()));
  both[1].render(); flush(both);
  assert.deepEqual(both[0].snapshot(), both[1].snapshot());
};

test('post-activation metadata refresh keeps rows and model while matching a complete draw', async () => {
  const both = await pair();
  for (const h of both) {
    for (const id of [3,4]) {
      const old = h.state.tabs.get(id), live = h.browserTabs.find(t => t.id === id);
      old.selected = live.selected = id === 3;
      old.lastAccessed = live.lastAccessed = id === 3 ? 1000 : 900;
    }
    for (const tab of h.browserTabs) tab.active = tab.id === 4;
    h.onActivated({tabId:4,windowId:7}); h.flushFrames();
    for (const id of [3,4]) {
      const live = h.browserTabs.find(t => t.id === id);
      live.selected = id === 4;
      if (id === 4) live.lastAccessed = 1100.25;
    }
    h.counters.drawn = 0;
  }
  const [optimized] = both, model = optimized.state.model;
  const refs = [3,4].map(id => optimized.state.tabs.get(id));
  const rows = [...optimized.nodes.get('today').children];
  await compare(both);
  assert.equal(optimized.counters.drawn, 0);
  assert.strictEqual(optimized.state.model, model);
  for (const [i,id] of [3,4].entries()) {
    assert.strictEqual(optimized.state.tabs.get(id),refs[i]);
    assert.equal(refs[i].selected,id === 4);
    assert.equal(refs[i].lastAccessed,id === 4 ? 1100.25 : 1000);
  }
  assert.deepEqual(optimized.nodes.get('today').children,rows);
});

test('addition, undefined and removal preserve exact property presence', async () => {
  const both = await pair(), refs = both[0].state.tabs.get(3);
  for (const h of both) { const tab=h.browserTabs.find(t=>t.id===3); tab.selected=undefined; tab.lastAccessed=0; }
  await compare(both);
  assert.equal(both[0].counters.drawn,0);
  assert.strictEqual(both[0].state.tabs.get(3),refs);
  assert.equal(Object.hasOwn(refs,'selected'),true); assert.equal(refs.selected,undefined);
  assert.equal(Object.hasOwn(refs,'lastAccessed'),true); assert.equal(refs.lastAccessed,0);
  for (const h of both) { const tab=h.browserTabs.find(t=>t.id===3); delete tab.selected; tab.lastAccessed=undefined; }
  await compare(both);
  assert.equal(both[0].counters.drawn,0);
  assert.equal(Object.hasOwn(refs,'selected'),false);
  assert.equal(Object.hasOwn(refs,'lastAccessed'),true); assert.equal(refs.lastAccessed,undefined);
  for (const h of both) delete h.browserTabs.find(t=>t.id===3).lastAccessed;
  await compare(both);
  assert.equal(both[0].counters.drawn,0); assert.equal(Object.hasOwn(refs,'lastAccessed'),false);
});

test('objects and functions in either ignored field always force the full path', async () => {
  for (const field of ['selected','lastAccessed']) for (const side of ['cached','queried']) for (const value of [{x:1},()=>{}]) {
    const h=await harness(source);
    if (side==='cached') h.state.tabs.get(3)[field]=value;
    else h.setQueryTransform(tabs => { tabs.find(t=>t.id===3)[field]=value; return tabs; });
    await h.refreshTabs(); h.flushFrames();
    assert.equal(h.counters.drawn,1,`${field} ${side} ${typeof value}`);
  }
});

test('changed active state or structural index still forces a full draw', async () => {
  for (const [field,value] of [['active',false],['index',42]]) {
    const both=await pair();
    for (const h of both) h.browserTabs.find(t=>t.id===3)[field]=value;
    await compare(both);
    assert.equal(both[0].counters.drawn,1,field);
  }
});

test('post-close index shifts still reconcile after the removal event was drawn', async () => {
  const both=await pair();
  for (const h of both) {
    const position=h.browserTabs.findIndex(t=>t.id===4);
    h.browserTabs.splice(position,1);
    h.onRemoved(4,{windowId:7,isWindowClosing:false});
    h.flushFrames(); h.counters.drawn=0;
    for (const tab of h.browserTabs) {
      if (tab.index>position) tab.index--;
      if (tab.id===3) { tab.selected=true; tab.lastAccessed=1200; }
    }
  }
  await compare(both);
  assert.equal(both[0].counters.drawn,1);
  assert.equal(both[0].state.tabs.get(5).index,both[0].browserTabs.find(t=>t.id===5).index);
});
