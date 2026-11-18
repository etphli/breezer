import test from 'node:test';
import assert from 'node:assert/strict';
import {createDashboardCache} from './dashboard-cache-fixture.mjs';
const fingerprint='a'.repeat(64), other='b'.repeat(64);
const data=(title='one')=>({items:[{id:'1',title,kind:'todo',version:4}],truncated:false});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b});return{promise,resolve,reject}};
test('warm reads reuse one successful list; expiry and Refresh fetch again',async()=>{
 let time=100,calls=0;const cache=createDashboardCache({now:()=>time});const fetch=async()=>{calls++;return data()};
 await cache.load({fingerprint,fetch});const warm=await cache.load({fingerprint,fetch});assert.equal(calls,1);assert.equal(warm.cached,true);assert.equal(warm.value.items[0].version,4);
 time+=3600000;await cache.load({fingerprint,fetch});assert.equal(calls,2);await cache.load({fingerprint,fetch,refresh:true});assert.equal(calls,3);
});
test('an ordinary slow request cannot replace a newer Refresh',async()=>{
 const cache=createDashboardCache(),old=deferred();const first=cache.load({fingerprint,fetch:()=>old.promise});
 await cache.load({fingerprint,refresh:true,fetch:async()=>data('new')});old.resolve(data('old'));
 await assert.rejects(first,{code:'DASHBOARD_CHANGED'});
 assert.equal((await cache.load({fingerprint,fetch:()=>assert.fail('unexpected fetch')})).value.items[0].title,'new');
});
test('account change and invalidation fence pending work',async()=>{
 const cache=createDashboardCache(),old=deferred();const first=cache.load({fingerprint,fetch:()=>old.promise});
 await cache.load({fingerprint:other,fetch:async()=>data('other')});old.resolve(data('old'));await assert.rejects(first,{code:'DASHBOARD_CHANGED'});
 const next=deferred();const pending=cache.load({fingerprint:other,refresh:true,fetch:()=>next.promise});cache.invalidate();next.resolve(data());await assert.rejects(pending,{code:'DASHBOARD_CHANGED'});
});
test('a native-AI connection hold bypasses caching and releases idempotently',async()=>{
 let calls=0;const cache=createDashboardCache(),fetch=async()=>{calls++;return data()};
 await cache.load({fingerprint,fetch});const release=cache.hold();await cache.load({fingerprint,fetch});await cache.load({fingerprint,fetch});assert.equal(calls,3);
 release();release();await cache.load({fingerprint,fetch});await cache.load({fingerprint,fetch});assert.equal(calls,4);
});
test('only explicit temporary failures can use stale data, including an empty list',async()=>{
 let time=100;const cache=createDashboardCache({now:()=>time});await cache.load({fingerprint,fetch:async()=>({items:[],truncated:false})});time+=3600000;
 const stale=await cache.load({fingerprint,fetch:async()=>{throw Object.assign(Error('offline'),{code:'NETWORK_ERROR'})}});
 assert.equal(stale.stale,true);assert.equal(stale.updatedAt,100);assert.deepEqual(stale.value.items,[]);
 await assert.rejects(cache.load({fingerprint,fetch:async()=>{throw Error('invalid response')}}),/invalid response/);
 await assert.rejects(cache.load({fingerprint,fetch:async()=>{throw Object.assign(Error('unauthorized'),{status:401})}}),/unauthorized/);
 await assert.rejects(cache.load({fingerprint,fetch:async()=>{throw Object.assign(Error('offline'),{status:503})}}),/offline/);
});
test('oversized or malformed successes remain intact but are not cached',async()=>{
 for(const value of [data('x'.repeat(200)),{items:[null],truncated:false}]){
  let calls=0;const cache=createDashboardCache({maximumBytes:100}),fetch=async()=>{calls++;return value};
  assert.equal((await cache.load({fingerprint,fetch})).value,value);await cache.load({fingerprint,fetch});assert.equal(calls,2);
 }
});
test('a backwards clock discards freshness and a missing capability stays uncached',async()=>{
 let time=100,calls=0;const cache=createDashboardCache({now:()=>time}),fetch=async()=>{calls++;return data()};
 await cache.load({fingerprint,fetch});time=99;await cache.load({fingerprint,fetch});assert.equal(calls,2);
 await cache.load({fingerprint:null,fetch});await cache.load({fingerprint:null,fetch});assert.equal(calls,4);
});
test('simultaneous ordinary reads share work without retaining failed requests',async()=>{
 let calls=0;const cache=createDashboardCache(),work=deferred(),fetch=()=>{calls++;return work.promise};
 const first=cache.load({fingerprint,fetch}),second=cache.load({fingerprint,fetch});work.resolve(data());assert.deepEqual(await first,await second);assert.equal(calls,1);
});
test('a synchronously failed fetch is released so a later read can recover',async()=>{
 const cache=createDashboardCache();
 await assert.rejects(cache.load({fingerprint,fetch:()=>{throw Error('sync failure')}}),/sync failure/);
 const result=await cache.load({fingerprint,fetch:()=>data('recovered')});
 assert.equal(result.value.items[0].title,'recovered');
});
