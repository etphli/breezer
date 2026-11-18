import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {harness} from './workspace-activation-harness.mjs';
const source=await readFile(process.env.SIDEBAR_SOURCE || new URL('../../features/ai/extension/workspace.js',import.meta.url),'utf8');
const settle=async()=>{for(let i=0;i<20;i++)await Promise.resolve();};

test('current actual init keeps two queries but consumes its already painted queued draw',async()=>{
 const h=await harness(source,undefined,{boot:true});await h.initSidebar({windowId:7});
 assert.equal(h.counters.queries,2);assert.equal(h.counters.models,1);
 h.flushFrames();assert.equal(h.counters.models,1,'startup duplicate model');
});
test('equal confirmation preserves pending URL/title row work and canonical tab identity',async()=>{
 const h=await harness(source),tab=h.state.tabs.get(3),model=h.state.model;
 h.update(3,{title:'Newest unread title',url:'https://github.com/current',status:'loading'});
 await h.refreshTabs();h.flushFrames();
 assert.equal(h.counters.models,0,'equal query must retain row paint');
 assert.strictEqual(h.state.tabs.get(3),tab);assert.strictEqual(h.state.model,model);
 assert.equal(h.nodes.get('today').children.find(n=>n.dataset.key==='t:3').querySelector('.title').textContent,'Newest unread title');
});
test('pending duplicate session requests stay independent before acknowledgement',async()=>{
 const pending=[];const h=await harness(source,undefined,{storageSet({commit}){return new Promise(resolve=>pending.push(()=>{commit();resolve();}));}});
 h.saveWindowState();h.saveWindowState();
 assert.equal(pending.length,2,'pre-ack duplicate must still dispatch');for(const commit of pending)commit();await settle();
});
test('failed session write gets a bounded pagehide retry without delaying member flush',async()=>{
 const h=await harness(source);h.failSessionWrite();h.saveWindowState();await settle();
 h.setRecord(3,{s:'space-work'});h.pagehide();await settle();
 assert.equal(h.counters.writes.filter(w=>w[0]==='session').length,2,'pagehide retries failed window state');
 assert.ok(h.counters.writes.some(w=>w[0]==='members'));
});
test('CURRENT already suppresses an identical acknowledged snapshot',async()=>{
 const h=await harness(source);h.saveWindowState();await settle();h.saveWindowState();await settle();
 assert.equal(h.counters.writes.filter(w=>w[0]==='session').length,1);
});
test('CURRENT already resubmits distinct window snapshots immediately',async()=>{
 const pending=[];const h=await harness(source,undefined,{storageSet({commit}){return new Promise(resolve=>pending.push(()=>{commit();resolve();}));}});
 for(const id of [4,5,3]){h.state.lastActive['space-work']=id;h.saveWindowState();}
 assert.equal(pending.length,3);for(const f of pending)f();await settle();
});
