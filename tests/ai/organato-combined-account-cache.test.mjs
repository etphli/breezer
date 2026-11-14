import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Organato } from '../../features/ai/host/organato.mjs';
import { installBackground } from '../../features/ai/extension/background.js';
import { requestView, normalizeView, organatoState } from '../../features/ai/extension/newtab.js';
import { fakeChrome, event } from './browser-api-fixture.mjs';
import { createDashboardCache } from './dashboard-cache-fixture.mjs';
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = title => ({id:'one',displayName:title,kind:'todo',version:1});
const fingerprint = 'a'.repeat(64);
const value = title => ({items:[{id:'one',title,kind:'todo'}],truncated:false,fingerprint,syncedAt:'2026-11-10T00:00:00Z'});
const offline = () => { throw new TypeError('fetch failed', {cause:{code:'ECONNRESET'}}); };
async function fixture(t, items = [item('saved')]) {
  const directory = await mkdtemp(join(tmpdir(),'breezer-combined-'));
  t.after(() => rm(directory,{recursive:true,force:true}));
  let key='org_'+'x'.repeat(43);
  const secrets={get:async()=>key,set:async v=>{key=v},remove:async()=>{key=null}};
  let service=new Organato({configDirectory:directory,secrets,fetcher:async()=>Response.json({items})});
  await service.list();
  // A new helper instance has no process-local state, but retains its private file.
  service=new Organato({configDirectory:directory,secrets,fetcher:offline});
  const fake=fakeChrome(); fake.api.runtime.id='test';
  fake.api.runtime.getURL=p=>`chrome-extension://test/${p}`;
  fake.api.topSites={get:async()=>[]};
  const dispatch=[];
  fake.native.postMessage=message=>{
    dispatch.push(message);
    const send=m=>fake.native.onMessage.emit({id:message.id,...m});
    void (async()=>{
      try {
        const result=message.type==='organato-view'?await service.dashboardView():message.type==='organato-configure'?await service.configure(message.settings):await service.dashboardList(message.dashboardIdentity,undefined,{onCached:v=>send({type:'organato-cache',value:v})});
        send({ok:true,value:result});
      } catch(e) {send({ok:false,error:e.message,status:e.status,code:e.code});}
    })();
  };
  installBackground(fake.api);
  const open=(name='breezer-newtab',page='newtab.html')=>{
    const outgoing=event(),incoming=event(),closed=event();
    fake.api.runtime.onConnect.emit({name,sender:{id:'test',url:fake.api.runtime.getURL(page)},onMessage:outgoing,onDisconnect:closed,postMessage:m=>incoming.emit(m)});
    return {onMessage:incoming,onDisconnect:closed,postMessage:m=>outgoing.emit(m),disconnect:()=>closed.emit()};
  };
  fake.api.runtime.connect=()=>open();
  return {service,fake,open,dispatch,setKey:v=>{key=v},view:options=>requestView(fake.api,{timeoutMs:1000,...options})};
}

test('cold restart streams saved tasks to concurrent readers and preserves them on network failure',async t=>{
 const h=await fixture(t), gate=deferred(), first=deferred(),second=deferred();
 h.service.fetcher=async()=>{await gate.promise;return offline()};
 const updates=[[],[]];
 const a=h.view({onUpdate:v=>{updates[0].push(v);first.resolve()}});
 await first.promise;
 const b=h.view({onUpdate:v=>{updates[1].push(v);second.resolve()}});
 await second.promise;
 assert.equal(h.dispatch.filter(m=>m.type==='organato-list').length,1);
 gate.resolve(); const results=await Promise.all([a,b]);
 for(let i=0;i<2;i++) {assert.equal(updates[i][0].organato.todos[0].title,'saved');assert.equal(results[i].organato.cached,true);assert.equal(results[i].organato.syncedAt,updates[i][0].organato.syncedAt);}
});

test('empty saved results remain ready with a last-sync notice after network failure',async t=>{
 const h=await fixture(t,[]);const updates=[];const result=await h.view({onUpdate:v=>updates.push(v)});
 assert.equal(updates.length,1);assert.equal(result.organato.cached,true);assert.ok(result.organato.syncedAt);
 assert.equal(organatoState(normalizeView(result).organato),'ready');
});

for(const status of [401,403]) test(`authorization ${status} clears saved UI and disk instead of retaining fallback`,async t=>{
 const h=await fixture(t);h.service.fetcher=async()=>new Response('{}',{status});
 const result=await h.view();assert.deepEqual(result.organato.todos,[]);assert.ok(result.organato.error);assert.ok(!result.organato.cached);
 assert.equal(await h.service.cachedList(await h.service.secrets.get()),null);
 h.service.fetcher=offline;const updates=[];await h.view({onUpdate:v=>updates.push(v)});assert.equal(updates.length,0);
});

test('Refresh replaces disk tasks and a subsequent warm memory hit avoids list IO',async t=>{
 const h=await fixture(t);h.service.fetcher=async()=>Response.json({items:[item('live')]});
 const fresh=await h.view({refresh:true});assert.equal(fresh.organato.todos[0].title,'live');assert.equal(fresh.organato.cached,false);
 const count=h.dispatch.filter(m=>m.type==='organato-list').length;
 h.service.fetcher=offline;const warm=await h.view();assert.equal(warm.organato.todos[0].title,'live');assert.equal(h.dispatch.filter(m=>m.type==='organato-list').length,count);
});

test('older disk progress cannot replace a successful in-memory result during Refresh',async()=>{
 const cache=createDashboardCache();await cache.load({fingerprint,fetch:async()=>value('new')});
 const updates=[];const result=await cache.load({fingerprint,refresh:true,onCached:v=>updates.push(v),fetch:async progress=>{progress(value('old'));throw Object.assign(Error('offline'),{code:'NETWORK_ERROR'})}});
 assert.equal(updates.length,0);assert.equal(result.value.items[0].title,'new');assert.equal(result.stale,true);
});

test('holds and identity replacement retire pending progress and publication',async()=>{
 for(const action of ['hold','switch','invalidate']) {
  const cache=createDashboardCache(),gate=deferred(),updates=[];let progress;
  const pending=cache.load({fingerprint,onCached:v=>updates.push(v),fetch:async cb=>{progress=cb;return gate.promise}});
  await tick();let release;
  if(action==='hold')release=cache.hold();else if(action==='switch')await cache.load({fingerprint:'b'.repeat(64),fetch:async()=>value('other')});else cache.invalidate();
  progress(value('old'));gate.resolve(value('old'));await assert.rejects(pending,{code:'DASHBOARD_CHANGED'});assert.equal(updates.length,0);release?.();
 }
});

test('disconnected readers receive no late cached progress while an attached reader finishes',async t=>{
 const h=await fixture(t),gate=deferred(),ready=deferred();h.service.fetcher=async()=>{await gate.promise;return Response.json({items:[]})};
 const port=h.open(),messages=[];port.onMessage.addListener(m=>{messages.push(m);if(m.pending)ready.resolve()});port.postMessage({id:'closed',type:'view'});await ready.promise;port.disconnect();const count=messages.length;
 const b=h.view();gate.resolve();await b;await tick();assert.equal(messages.length,count);
});

test('key switch during saved-file read cannot emit cached progress',async t=>{
 const h=await fixture(t),id=(await h.service.dashboardView()).fingerprint;const read=h.service.cachedList.bind(h.service);
 h.service.cachedList=async key=>{const saved=await read(key);h.setKey('org_'+'y'.repeat(43));return saved};
 await assert.rejects(h.service.dashboardList(id,undefined,{onCached:()=>assert.fail('wrong account drawn')}),{code:'DASHBOARD_CHANGED'});
});

test('saved progress waiting for top sites cannot revive after an account retry', async t => {
  const h = await fixture(t), sites = deferred(), first = deferred(), second = deferred();
  const firstStarted = deferred(), secondStarted = deferred();
  h.fake.api.topSites.get = () => sites.promise;
  let calls = 0;
  h.service.fetcher = async () => {
    if (++calls === 1) { firstStarted.resolve(); return first.promise; }
    secondStarted.resolve(); return second.promise;
  };
  const updates = [];
  const request = h.view({ onUpdate: result => updates.push(result) });
  await firstStarted.promise;
  h.setKey('org_' + 'y'.repeat(43));
  first.resolve(Response.json({ items: [item('old live')] }));
  await secondStarted.promise;
  sites.resolve([]);
  await tick();
  const queuedTitles = updates.flatMap(result => result.organato.todos.map(todo => todo.title));
  second.resolve(Response.json({ items: [item('new account')] }));
  const final = await request;
  assert.deepEqual(queuedTitles, [], 'old saved tasks must not draw under the retried account');
  assert.equal(final.organato.todos[0].title, 'new account');
});

test('clear racing with a queued cache read invalidates its result',async t=>{
 const h=await fixture(t),gate=deferred();const blocking=h.service.cacheOperation(()=>gate.promise);
 const read=h.service.cachedList(await h.service.secrets.get());const clear=h.service.clearCache();gate.resolve();await blocking;await clear;assert.equal(await read,null);
});

test('asynchronous saved-data callbacks finish before the final frontend answer',async()=>{
 const incoming=event(),closed=event(),gate=deferred();let id;const order=[];
 const api={runtime:{connect:()=>({onMessage:incoming,onDisconnect:closed,disconnect:()=>closed.emit(),postMessage:m=>{id=m.id}})}};
 const result=requestView(api,{timeoutMs:1000,onUpdate:async()=>{order.push('start');await gate.promise;order.push('paint')}}).then(()=>order.push('final'));
 incoming.emit({type:'view',id,pending:true});incoming.emit({type:'view',id});await tick();assert.deepEqual(order,['start']);gate.resolve();await result;assert.deepEqual(order,['start','paint','final']);
});

test('newer completed live read wins the persistent cache over an older in-flight read',async t=>{
 const h=await fixture(t),gate=deferred(),started=deferred();let call=0;
 h.service.fetcher=async()=>{if(++call===1){started.resolve();await gate.promise;return Response.json({items:[item('old')]})}return Response.json({items:[item('new')]})};
 const id=(await h.service.dashboardView()).fingerprint;const old=h.service.dashboardList(id);await started.promise;
 await h.service.dashboardList(id);gate.resolve();await old;
 assert.equal((await h.service.cachedList(await h.service.secrets.get())).items[0].title,'new');
});

test('settings changes remove saved results and fence a pending callback',async t=>{
 const h=await fixture(t),read=h.service.cachedList.bind(h.service),gate=deferred(),started=deferred();
 h.service.cachedList=async key=>{const result=await read(key);started.resolve();await gate.promise;return result};
 const id=(await h.service.dashboardView()).fingerprint;
 const pending=h.service.dashboardList(id,undefined,{onCached:()=>assert.fail('settings-stale progress')});
 await started.promise;await h.service.configure({dashboardEnabled:false});gate.resolve();await assert.rejects(pending,{code:'DASHBOARD_CHANGED'});
 assert.equal(await read(await h.service.secrets.get()),null);
});

test('an aborted dashboard read never emits saved account data',async t=>{
 const h=await fixture(t),controller=new AbortController();controller.abort();
 await assert.rejects(h.service.dashboardList((await h.service.dashboardView()).fingerprint,controller.signal,{onCached:()=>assert.fail('aborted progress')}),{code:'DASHBOARD_CHANGED'});
});

test('a mutation from another helper fences an older helper read and saved progress',async t=>{
 const h=await fixture(t),gate=deferred(),started=deferred();
 h.service.fetcher=async()=>{started.resolve();await gate.promise;return Response.json({items:[item('pre-mutation')]})};
 const before=(await h.service.dashboardView()).fingerprint;
 const pending=h.service.dashboardList(before);await started.promise;
 const other=new Organato({configDirectory:h.service.directory,secrets:h.service.secrets,fetcher:async()=>Response.json({item:{id:'one'}})});
 await other.tool('organato_update_item',{id:'one',version:1,workingStatus:'completed'});
 gate.resolve();await assert.rejects(pending,{code:'DASHBOARD_CHANGED'});
 assert.notEqual((await h.service.dashboardView()).fingerprint,before);
 assert.equal(await other.cachedList(await other.secrets.get()),null);
});
