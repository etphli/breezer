import test from 'node:test';
import assert from 'node:assert/strict';
import { Organato } from '../../features/ai/host/organato.mjs';
import { organatoTestDirectory } from './organato-test-directory.mjs';
const key = n => 'org_' + n.repeat(43);
function fixture() {
  let secret = key('a'), config = { enabled: true, dashboardEnabled: true, allowAI: true }, calls = [];
  const service = new Organato({ configDirectory: organatoTestDirectory(), secrets: { get: async () => secret }, fetcher: async (url, options) => { calls.push(options.headers.Authorization); return new Response(JSON.stringify({items:[{id:'x',version:3,subjectId:'subject',displayName:'z'.repeat(10000)}]})); } });
  service.config = async () => ({...config});
  return {service, calls, setKey: value => secret = value, setConfig: value => config = {...config,...value}};
}
test('view identity is stable, opaque, local and changes with key or settings', async () => {
  const f = fixture(), a = await f.service.dashboardView(), b = await f.service.dashboardView();
  assert.equal(a.cacheCapability, 1); assert.match(a.fingerprint, /^[a-f0-9]{64}$/); assert.equal(a.fingerprint,b.fingerprint); assert.equal(f.calls.length,0);
  f.setKey(key('b')); const c = await f.service.dashboardView(); assert.notEqual(c.fingerprint,a.fingerprint);
  f.setConfig({dashboardEnabled:false}); assert.notEqual((await f.service.dashboardView()).fingerprint,c.fingerprint);
});
test('bound list retains fields and rejects changed identity before fetch', async () => {
  const f = fixture(), id = (await f.service.dashboardView()).fingerprint;
  const result = await f.service.dashboardList(id); assert.equal(result.fingerprint,id); assert.equal(result.items[0].title.length,10000); assert.equal(result.items[0].version,3); assert.equal(result.items[0].subjectId,'subject');
  f.setKey(key('b')); await assert.rejects(f.service.dashboardList(id), {code:'DASHBOARD_CHANGED'}); assert.equal(f.calls.length,1);
});
test('account swap during pagination or after result rejects, with every page bound to captured key', async () => {
  for (const swap of [1,2]) {
    const f = fixture(), id = (await f.service.dashboardView()).fingerprint; let page=0, auth=[];
    f.service.fetcher = async (_, options) => { auth.push(options.headers.Authorization); page++; if(page===swap) f.setKey(key('b')); return new Response(JSON.stringify({items:[{id:'x'}],nextCursor:page===1?'next':null})); };
    await assert.rejects(f.service.dashboardList(id), {code:'DASHBOARD_CHANGED'}); assert.ok(auth.every(a => a === `Bearer ${key('a')}`));
  }
});
test('transport, abort, HTTP and invalid JSON remain distinct; AI reads fresh versions', async () => {
  const f=fixture(); f.service.fetcher=async()=>{throw new TypeError('fetch failed', {cause: {code: 'ECONNREFUSED'}})}; await assert.rejects(f.service.request('/items'), {code:'NETWORK_ERROR',message:'fetch failed'});
  f.service.fetcher=async()=>{throw new TypeError('programmer mistake')}; await assert.rejects(f.service.request('/items'), e=>e.message==='programmer mistake' && !e.code);
  const abort=new DOMException('aborted','AbortError'); f.service.fetcher=async()=>{throw abort}; await assert.rejects(f.service.request('/items'), e=>e===abort);
  f.service.fetcher=async()=>new Response('',{status:429}); await assert.rejects(f.service.request('/items'), {status:429});
  f.service.fetcher=async()=>new Response('{'); await assert.rejects(f.service.request('/items'), e=>e instanceof SyntaxError && !e.code);
  let v=0; f.service.fetcher=async()=>new Response(JSON.stringify({items:[{version:++v,subjectId:'s'}]}));
  assert.equal((await f.service.tool('organato_list_items',{})).items[0].version,1); const item=(await f.service.tool('organato_list_items',{})).items[0]; assert.equal(item.version,2); assert.equal(item.subjectId,'s');
});
test('settings changes during response consumption reject the result', async () => {
  const f=fixture(), id=(await f.service.dashboardView()).fingerprint;
  f.service.fetcher=async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new TextEncoder().encode('{"items":[]}')); f.setConfig({allowAI:false}); controller.close();}}));
  await assert.rejects(f.service.dashboardList(id), {code:'DASHBOARD_CHANGED'});
});
