import test from 'node:test';
import assert from 'node:assert/strict';
import {Organato} from '../../features/ai/host/organato.mjs';
import { organatoTestDirectory } from './organato-test-directory.mjs';
const secrets={get:async()=> 'org_'+ 'a'.repeat(43)};
test('an actual internally fired deadline is a temporary network failure',async()=>{
 const original=AbortSignal.timeout;
 AbortSignal.timeout=()=>original(5);
 const service=new Organato({configDirectory:organatoTestDirectory(),secrets,fetcher:async(_,options)=>new Promise((resolve,reject)=>{
  const keepAlive=setTimeout(()=>reject(Error('test guard elapsed')),500);
  options.signal.addEventListener('abort',()=>{clearTimeout(keepAlive);reject(options.signal.reason)},{once:true});
 })});
 try {await assert.rejects(service.request('/items'),error=>error.code==='NETWORK_ERROR' && error.message.includes('timeout'));}
 finally {AbortSignal.timeout=original;}
});
test('connection loss after headers is temporary, while corrupt JSON is not',async()=>{
 const service=new Organato({configDirectory:organatoTestDirectory(),secrets,fetcher:async()=>new Response(new ReadableStream({start(controller){
  controller.error(new TypeError('terminated',{cause:{code:'UND_ERR_SOCKET'}}));
 }}))});
 await assert.rejects(service.request('/items'),{code:'NETWORK_ERROR',message:'terminated'});
 service.fetcher=async()=>new Response('{');
 await assert.rejects(service.request('/items'),error=>error instanceof SyntaxError && !error.code);
});
test('a failed fetch revalidates account identity before stale fallback is possible',async()=>{
 let secret='org_'+'a'.repeat(43);
 const service=new Organato({configDirectory:organatoTestDirectory(),secrets:{get:async()=>secret},fetcher:async()=>{
  secret='org_'+'b'.repeat(43);
  throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});
 }});
 service.config=async()=>({enabled:true,dashboardEnabled:true,allowAI:true});
 const {fingerprint}=await service.dashboardView();
 await assert.rejects(service.dashboardList(fingerprint),{code:'DASHBOARD_CHANGED'});
});
