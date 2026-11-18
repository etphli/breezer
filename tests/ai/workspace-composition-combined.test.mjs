import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {harness} from './workspace-activation-harness.mjs';
import {seed} from './workspace-browser-fixture.mjs';
const source=await readFile(process.env.SIDEBAR_SOURCE || new URL('../../features/ai/extension/workspace.js',import.meta.url),'utf8');
const baseline=await readFile(new URL('./fixtures/workspace-composition/baseline-workspace.js',import.meta.url),'utf8');
export const settle=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
const row=(h,id)=>h.nodes.get('today').children.find(n=>n.dataset.key===`t:${id}` && !n.classList.contains('leaving'));
const pair=async options=>[await harness(baseline,undefined,options),await harness(source,undefined,options)];
const same=hs=>assert.deepEqual(hs[1].snapshot(),hs[0].snapshot());
const attached=()=>({id:99,windowId:7,index:8,active:false,pinned:false,title:'Late attachment',url:'https://new.test/',status:'complete'});

for(const rowsOnly of [false,true]) test(`equal query, queued ${rowsOnly?'row':'full'} work, sync draw and later event retain fresh DOM`,async()=>{
 const hs=await pair();
 for(const h of hs){h.update(3,{title:'Before sync draw',url:'https://github.com/current'});if(!rowsOnly)h.render();await h.refreshTabs();h.draw();h.flushFrames();h.update(4,{title:'After sync draw'});h.flushFrames();await h.timers(150);}
 same(hs);assert.equal(hs[1].counters.models,1);assert.equal(hs[1].framesPending(),0);assert.equal(row(hs[1],4).title,'After sync draw');
});

test('a rejected confirmation does not cancel pending URL/member/row work',async()=>{
 const hs=await pair();
 for(const h of hs){h.update(3,{title:'Must paint',url:'https://github.com/rejected'});h.rejectNextQuery();await assert.rejects(h.refreshTabs(),/query failure/);h.flushFrames();h.pagehide();await settle();}
 // pagehide may add a first window save in the candidate; members are exact.
 const members=h=>h.counters.writes.filter(w=>w[0]==='members');assert.deepEqual(members(hs[1]),members(hs[0]));
 assert.equal(row(hs[1],3).title,row(hs[0],3).title);assert.equal(hs[1].counters.models,0);
});

test('CURRENT queued retry survives a failed synchronous full draw',async()=>{
 const hs=await pair();
 for(const h of hs){h.update(3,{title:'Retry latest'});h.failNextPaint();assert.throws(()=>h.draw(),/DOM paint failure/);assert.equal(h.framesPending(),1,'existing queued retry retained');h.flushFrames();}
 same(hs);assert.equal(row(hs[1],3).title,'Retry latest');assert.equal(hs[1].queryDirty(),false);
});

test('failed non-transfer full paint cannot make an equal query certify incomplete UI',async()=>{
 const h=await harness(source);h.browserTabs.find(t=>t.id===3).title='Model ahead of UI';await h.refreshTabs();h.failNextPaint();assert.throws(()=>h.flushFrames(),/DOM paint failure/);
 assert.equal(h.queryDirty(),true);assert.notEqual(row(h,3).title,'Model ahead of UI');
 await h.refreshTabs();h.flushFrames();assert.equal(row(h,3).title,'Model ahead of UI');assert.equal(h.queryDirty(),false);
});

test('failed row-label pass forces the next equal query through a complete draw',async()=>{
 const h=await harness(source);h.update(3,{title:'Updated before label failure'});h.failNextCompact();assert.throws(()=>h.flushFrames(),/compact failure/);
 const before=h.counters.models;assert.equal(h.queryDirty(),true);await h.refreshTabs();h.flushFrames();assert.equal(h.counters.models,before+1);assert.equal(h.queryDirty(),false);
});

test('unresolved attachment remains conservative even after an intervening successful draw',async()=>{
 const h=await harness(source);h.browserTabs.push(attached());h.holdGet();h.onAttached(99,{newWindowId:7});h.draw();
 h.setQueryTransform(tabs=>tabs.filter(t=>t.id!==99));const n=h.counters.models;
 await h.refreshTabs();h.flushFrames();assert.equal(h.counters.models,n+1,'unresolved get prevents equal-query skip');
 h.setQueryTransform(null);h.releaseGet();await settle();h.flushFrames();assert.ok(row(h,99));
});

test('late attach dirtiness survives rejected query after an intervening draw',async()=>{
 const h=await harness(source);h.browserTabs.push(attached());h.holdGet();h.onAttached(99,{newWindowId:7});h.draw();h.rejectNextQuery();h.releaseGet();await settle();
 assert.equal(h.framesPending(),0);assert.equal(h.queryDirty(),true);
 await h.refreshTabs();h.flushFrames();assert.ok(row(h,99),'late attach requires fresh UI');
 const n=h.counters.models;await h.refreshTabs();h.flushFrames();assert.equal(h.counters.models,n,'successful transfer clears dirtiness');
});

test('two unresolved attachments decrement independently and retain success clearing',async()=>{
 const h=await harness(source);const releases=[];
 h.api.tabs.get=id=>new Promise(resolve=>releases.push(()=>resolve({...attached(),id,index:id})));
 h.browserTabs.push({...attached(),id:99,index:99},{...attached(),id:100,index:100});
 h.onAttached(99,{newWindowId:7});h.onAttached(100,{newWindowId:7});h.draw();
 releases[0]();await settle();h.flushFrames();const n=h.counters.models;
 await h.refreshTabs();h.flushFrames();assert.equal(h.counters.models,n+1);
 releases[1]();await settle();h.flushFrames();const done=h.counters.models;
 await h.refreshTabs();h.flushFrames();assert.equal(h.counters.models,done);assert.ok(row(h,99));assert.ok(row(h,100));
});

test('failed Peek stays retryable across consumed sync draw, rejection, and equal query',async()=>{
 const h=await harness(source,undefined,{peek:true,rejectPeek:true});await settle();
 h.update(3,{title:'Peek retry'});h.draw();await settle();assert.equal(h.framesPending(),0);assert.equal(h.state.peekKey,null);
 h.rejectNextQuery();await assert.rejects(h.refreshTabs());h.allowPeek();await h.refreshTabs();h.flushFrames();await settle();
 assert.equal(h.peekCalls.length,3);assert.notEqual(h.state.peekKey,null);const n=h.peekCalls.length;await h.refreshTabs();h.flushFrames();assert.equal(h.peekCalls.length,n);
});

test('rename input identity, focus/selection and roving key survive equal/changed queries and sync draws',async()=>{
 const hs=await pair();
 for(const h of hs){h.state.focus.today='t:5';h.update(3,{title:'Before rename'});h.startRename({kind:'entry',id:'e-spec',key:'e:e-spec'});const folder=h.nodes.get('pinned').querySelector('[data-key="e:e-spec"]');const input=folder.querySelector('input');
  assert.ok(input);input.value='Typed name';input.selectionStart=2;input.selectionEnd=6;
  await h.refreshTabs();h.flushFrames();h.browserTabs.find(t=>t.id===3).title='Different authoritative title';await h.refreshTabs();h.flushFrames();h.draw();
  assert.strictEqual(folder.querySelector('input'),input);assert.equal(input.value,'Typed name');assert.equal(input.selectionStart,2);assert.equal(input.selectionEnd,6);assert.equal(input.focusCalls,1);assert.equal(input.selectCalls,1);
 }
 same(hs);assert.equal(row(hs[1],5).tabIndex,0);
});

for(const [name,transform]of[
 ['own getter',tabs=>Object.defineProperty(tabs[0],'unknown',{get(){throw new Error('getter must not execute');},enumerable:true,configurable:true})],
 ['non-enumerable',tabs=>Object.defineProperty(tabs[0],'unknown',{value:1,enumerable:false,configurable:true,writable:true})],
 ['nonconfigurable',tabs=>Object.defineProperty(tabs[0],'unknown',{value:1,enumerable:true,configurable:false,writable:true})],
 ['frozen',tabs=>Object.freeze(tabs[0])],
 ['own symbol',tabs=>tabs[0][Symbol('unknown')]=1],
 ['unknown nested metadata',tabs=>tabs[0].unknown={x:1}],
 ['ignored function metadata',tabs=>tabs[0].lastAccessed=()=>1],
 ['custom prototype',tabs=>Object.setPrototypeOf(tabs[0],{future:1})],
])test(`ambiguous query snapshot ${name} takes the conservative full path`,async()=>{
 const h=await harness(source);h.setQueryTransform(tabs=>{transform(tabs);return tabs;});await h.refreshTabs();h.flushFrames();assert.equal(h.counters.models,1);
});

test('own scalar metadata presence and canonical model/item references remain exact',async()=>{
 const h=await harness(source),tab=h.state.tabs.get(3),model=h.state.model,item=h.state.items.get('t:3');
 h.browserTabs.find(t=>t.id===3).lastAccessed=undefined;await h.refreshTabs();h.flushFrames();
 assert.equal(h.counters.models,0);assert.strictEqual(h.state.model,model);assert.strictEqual(h.state.items.get('t:3'),item);assert.strictEqual(item.tab,tab);assert.ok(Object.hasOwn(tab,'lastAccessed'));
 delete h.browserTabs.find(t=>t.id===3).lastAccessed;await h.refreshTabs();assert.ok(!Object.hasOwn(tab,'lastAccessed'));
});

test('startup retains pre-subscription tabs and events during its second query',async()=>{
 for(const mode of ['during-reconcile','second-query']){
  const hs=[];
  for(const text of [baseline,source]){
   const h=await harness(text,undefined,{boot:true,reconcile({browserTabs,listeners}){if(mode==='during-reconcile'){assert.equal(listeners['tabs.onCreated'],undefined);browserTabs.push(attached());}},query({number,browserTabs,listeners}){if(mode==='second-query'&&number===2){const tab=attached();browserTabs.push(tab);for(const fn of listeners['tabs.onCreated'])fn(structuredClone(tab));}}});
   await h.initSidebar({windowId:7});h.flushFrames();await h.timers(50);h.flushFrames();await h.timers(150);hs.push(h);
  }
  same(hs);assert.ok(row(hs[1],99));assert.equal(hs[1].counters.queries,mode==='during-reconcile'?2:3);
 }
});

test('bounded mixed current UI/model/member differential across query, storage, full and row paths',async()=>{
 const hs=await pair();
 for(let i=0;i<96;i++){
  for(const h of hs){
   if(i%12===0){const store=structuredClone(h.state.store);store.spaces[0].name=`Work ${i}`;h.emit('storage.local.onChanged',{'workspace.v1':{newValue:store}});}
   else if(i%9===0){h.onActivated({tabId:[3,4,5][i%3],windowId:7});await settle();}
   else h.update([3,4,5][i%3],{title:`Frame ${i}`,url:`https://current.test/${i}`});
   if(i%3===0)await h.refreshTabs();if(i%5===0)h.draw();h.flushFrames();await h.timers(150);
  }
  same(hs);
 }
});

for(const options of [{width:0},{visibility:'hidden'}])test(`no new viewport/visibility delay ${JSON.stringify(options)}`,async()=>{
 const hs=await pair(options);
 for(const h of hs){h.update(3,{title:'Eager at zero/hidden',url:'https://github.com/eager'});await h.refreshTabs();h.flushFrames();assert.equal(row(h,3).title,'Eager at zero/hidden');h.setViewport(240);assert.equal(row(h,3).title,'Eager at zero/hidden');await h.timers(150);}
 same(hs);
});
