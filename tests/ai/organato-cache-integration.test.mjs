import test from 'node:test';
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {mkdtemp,copyFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {installBackground} from '../../features/ai/extension/background.js';
import {requestView} from '../../features/ai/extension/newtab.js';
import {NativeDecoder,encodeMessage} from '../../features/ai/host/protocol.mjs';
import {fakeChrome,event,tick} from './browser-api-fixture.mjs';

globalThis.fetch=()=>{throw Error('FORBIDDEN real fetch in review process')};

async function until(fn) {
 const deadline=Date.now()+3000;
 while(!fn()){if(Date.now()>deadline) throw Error('fixture step timed out');await new Promise(r=>setTimeout(r,2));}
}
async function fixture(t) {
 const directory=await mkdtemp(join(tmpdir(),'organato-combined-'));
 for(const [from,to] of [['host/main.mjs','main.mjs'],['host/protocol.mjs','protocol.mjs'],['host/attachments.mjs','attachments.mjs'],['host/updater.mjs','updater.mjs'],['host/organato.mjs','actual-organato.mjs'],['host/organato-windows.mjs','organato-windows.mjs'],['organato-cache-fake-host.mjs','organato.mjs']]) await copyFile(new URL(from.startsWith('host/')?'../../features/ai/'+from:from,import.meta.url),join(directory,to));
 const child=fork(join(directory,'main.mjs'),['chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/'],{silent:true,env:{...process.env,REVIEW_CONFIG:directory}});
 let ready=false,serial=0,stderr='';const controls=new Map(),routes=new Map(),fetches=[],replies=[],ports=[];
 const decoder=new NativeDecoder();
 child.stderr.on('data',b=>stderr+=b);
 child.on('message',m=>{if(m.ready)ready=true;if(m.fetch)fetches.push(m);if(m.ack){const p=controls.get(m.ack);controls.delete(m.ack);m.error?p.reject(Error(m.error)):p.resolve(m.result)}});
 child.stdout.on('data',b=>{for(const m of decoder.push(b)){replies.push(m);routes.get(m.id)?.onMessage.emit(m)}});
 const f=fakeChrome();f.api.runtime.id='test';f.api.runtime.getURL=p=>`chrome-extension://test/${p}`;f.api.topSites={get:async()=>[]};
 let panelMode='ok',settingsPostFailure=false;
 f.api.runtime.connectNative=()=>{
  const p={onMessage:event(),onDisconnect:event(),sent:[],closed:false,
   postMessage(m){
    this.sent.push(m);
    if(!m.type.startsWith('organato-')){
     assert.ok(['init','cancel','chat'].includes(m.type),'provider dispatch forbidden');
     if(panelMode==='throw'||(panelMode==='chat-throw'&&m.type==='chat'))throw Error('fixture native post failure');
     return;
    }
    if(settingsPostFailure&&m.type==='organato-configure')throw Error('fixture settings post failure');
    routes.set(m.id,p);
    // Deliberately split a real frame inside its header and body.
    const frame=encodeMessage(m);child.stdin.write(frame.subarray(0,2));child.stdin.write(frame.subarray(2,9));child.stdin.write(frame.subarray(9));
   },disconnect(){if(this.closed)return;this.closed=true;this.onDisconnect.emit();}
  };ports.push(p);return p;
 };
 installBackground(f.api);
 const open=(name='breezer-newtab')=>{
  const outgoing=event(),incoming=event(),disconnected=event();let closed=false;
  const page=name==='breezer-panel'?'panel.html':name==='breezer-organato-settings'?'workspace.html':'newtab.html';
  f.api.runtime.onConnect.emit({name,sender:{id:'test',url:f.api.runtime.getURL(page)},onMessage:outgoing,onDisconnect:disconnected,postMessage:m=>{if(!closed)incoming.emit(m)}});
  return {onMessage:incoming,onDisconnect:disconnected,postMessage:m=>outgoing.emit(m),disconnect:()=>{closed=true;disconnected.emit()}};
 };
 f.api.runtime.connect=({name})=>open(name);
 t.after(async()=>{
  for(const p of ports)p.disconnect();
  child.kill('SIGTERM');await new Promise(resolve=>child.exitCode!==null?resolve():child.once('exit',resolve));
  await rm(directory,{recursive:true,force:true});
  assert.equal(stderr,'','no provider startup, warnings or subprocess errors');
 });
 await until(()=>ready);
 const command=(op,value={})=>new Promise((resolve,reject)=>{const id='c'+(++serial);controls.set(id,{resolve,reject});child.send({id,op,...value})});
 return {f,ports,fetches,replies,open,view:(refresh=false)=>requestView(f.api,{refresh,timeoutMs:3000}),state:value=>command('state',{value}),release:n=>command('release',{n}),tool:()=>command('tool'),panelMode:v=>panelMode=v,settingsPostFailure:v=>settingsPostFailure=v};
}
const titles=r=>r.organato.exams.map(i=>i.title);

test('real methods/main/framing/background/requestView: warm repeat, refresh and AI versions',async t=>{
 const h=await fixture(t);assert.deepEqual(titles(await h.view()),['Fixture 1']);await h.view();assert.equal(h.fetches.length,1);
 await h.state({version:2});assert.deepEqual(titles(await h.view(true)),['Fixture 2']);assert.equal(h.fetches.length,2);
 assert.equal((await h.tool()).items[0].version,2);await h.state({version:3});assert.equal((await h.tool()).items[0].version,3);assert.equal(h.fetches.length,4);
 assert.equal((await h.tool()).items[0].subjectId,'fake-subject');
 assert.ok(h.replies.every(m=>['organato-result','organato-cache'].includes(m.type)));
 const requests=h.ports.flatMap(p=>p.sent);
 for(const request of requests)assert.equal(h.replies.filter(m=>m.type==='organato-result'&&m.id===request.id).length,1,'one terminal response per native request');
 for(const progress of h.replies.filter(m=>m.type==='organato-cache')){
  assert.equal(requests.find(m=>m.id===progress.id)?.type,'organato-list');
  assert.match(progress.value.fingerprint,/^[a-f0-9]{64}$/);
  assert.equal(progress.value.fingerprint,h.replies.find(m=>m.type==='organato-result'&&m.id===progress.id).value.fingerprint);
 }
});
for(const empty of [false,true])test(`real network/deadline/body failure retains original timestamp, empty=${empty}`,async t=>{
 const h=await fixture(t);await h.state({empty});const before=Date.now(),first=await h.view(),after=Date.now();let updatedAt;

 for(const mode of ['network','deadline','body']){
  await h.state({mode});const r=await h.view(true);assert.equal(r.organato.stale,true,mode);assert.ok(r.organato.updatedAt>=before&&r.organato.updatedAt<=after);updatedAt??=r.organato.updatedAt;assert.equal(r.organato.updatedAt,updatedAt);assert.deepEqual(r.organato.exams,first.organato.exams);
  assert.equal(h.replies.at(-1).code,'NETWORK_ERROR');
 }
});
for(const status of [401,403])test(`real HTTP ${status} never serves stale or retains denied cache`,async t=>{
 const h=await fixture(t);await h.view();await h.state({status});const r=await h.view(true);assert.ok(r.organato.error);assert.equal(r.organato.stale,undefined);assert.deepEqual(r.organato.exams,[]);
 await h.state({status:null,mode:'network'});assert.equal((await h.view()).organato.stale,undefined);
});
for(const field of ['key','config'])for(const mode of ['ok','network','body'])test(`context changes during ${mode}: ${field} fences old data and failure`,async t=>{
 const h=await fixture(t);await h.view();await h.state({defer:true,mode});const pending=h.view(true);
 await until(()=>h.fetches.length===2);
 await h.state({...field==='key'?{key:'org_'+'b'.repeat(43)}:{config:{enabled:true,dashboardEnabled:true,allowAI:false}},defer:false});
 await h.release(2);const r=await pending;
 assert.ok(h.replies.some(m=>m.code==='DASHBOARD_CHANGED'));
 assert.equal(r.organato.stale,undefined);
 if(mode==='ok')assert.deepEqual(titles(r),['Fixture 1']);else assert.deepEqual(r.organato.exams,[]);
 assert.equal(h.fetches.length,3,'one bounded bridge retry');
});
test('captured key binds every page; account change fences between pages',async t=>{
 const h=await fixture(t);await h.state({pages:true,defer:true});const p=h.view();await until(()=>h.fetches.length===1);await h.release(1);await until(()=>h.fetches.length===2);
 assert.ok(h.fetches.every(m=>m.auth==='Bearer org_'+'a'.repeat(43)));
 await h.state({key:'org_'+'b'.repeat(43),defer:false,pages:false});await h.release(2);await p;
 assert.ok(h.replies.some(m=>m.code==='DASHBOARD_CHANGED'));assert.equal(h.fetches[2].auth,'Bearer org_'+'b'.repeat(43));
});
test('simultaneous pages share list after first port closes',async t=>{
 const h=await fixture(t);await h.state({defer:true});const p=h.open();p.postMessage({type:'view',id:'first'});await until(()=>h.fetches.length===1);
 const second=h.view();await until(()=>h.replies.filter(m=>m.value?.cacheCapability).length===2);p.disconnect();await h.state({defer:false});await h.release(1);
 assert.deepEqual(titles(await second),['Fixture 1']);await h.view();assert.equal(h.fetches.length,1);
});
test('newer refresh wins despite older native list completing last',async t=>{
 const h=await fixture(t);await h.state({defer:true});const first=h.view(true);await until(()=>h.fetches.length===1);
 await h.state({version:2});const second=h.view(true);await until(()=>h.fetches.length===2);await h.release(2);assert.deepEqual(titles(await second),['Fixture 2']);
 await h.release(1);assert.deepEqual(titles(await first),['Fixture 2']);assert.deepEqual(titles(await h.view()),['Fixture 2']);assert.equal(h.fetches.length,2);
});
test('invalid JSON is not stale; helper disconnect clears pending and permits retry',async t=>{
 const h=await fixture(t);await h.view();await h.state({mode:'invalid'});assert.equal((await h.view(true)).organato.stale,undefined);
 await h.state({mode:'ok',defer:true});const p=h.view(true);await until(()=>h.fetches.length===3);h.ports.at(-1).disconnect();assert.match((await p).organato.error,/disconnected/);
 await h.state({defer:false});await h.release(3);assert.deepEqual(titles(await h.view(true)),['Fixture 1']);
});
for(const action of ['cancel-close','native-disconnect','post-failure'])test(`panel cache hold and release: ${action}`,async t=>{
 const h=await fixture(t);await h.view();if(action==='post-failure')h.panelMode('throw');
 const panel=h.open('breezer-panel');panel.postMessage({type:'init'});await until(()=>h.ports.some(p=>p.sent.some(m=>m.type==='init')));
 if(action==='post-failure'){await tick();await h.view();await h.view();assert.equal(h.fetches.length,2);panel.disconnect();return;}
 const native=h.ports.find(p=>p.sent.some(m=>m.type==='init'));await h.view();
 panel.postMessage({type:'chat',id:'active-fake',provider:'codex',model:'fake-model',message:'Offline fixture',includeContext:false,control:false});await until(()=>native.sent.some(m=>m.type==='chat'));
 panel.postMessage({type:'cancel'});await until(()=>native.sent.some(m=>m.type==='cancel'&&m.id==='active-fake'));await h.view();assert.equal(h.fetches.length,3,'cancel alone keeps panel hold');
 if(action==='native-disconnect')native.disconnect();else panel.disconnect();
 await h.view();await h.view();assert.equal(h.fetches.length,4);panel.disconnect();
});
for(const action of ['failure','port-close'])test(`settings configure ${action} releases hold after real failed validation`,async t=>{
 const h=await fixture(t);await h.view();await h.state({defer:true,status:401});const settings=h.open('breezer-organato-settings');const messages=[];settings.onMessage.addListener(m=>messages.push(m));
 settings.postMessage({type:'configure',id:'settings',settings:{key:'org_'+'z'.repeat(43)}});await until(()=>h.fetches.length===2);
 const configuration=h.ports.flatMap(p=>p.sent).find(m=>m.type==='organato-configure');
 if(action==='port-close')settings.disconnect();
 await h.state({defer:false,status:null});
 for(let i=0;i<2;i++){
  const value=await h.view();assert.equal(value.organato.stale,undefined);assert.deepEqual(value.organato.exams,[]);assert.match(value.organato.error,/changed/i);
 }
 assert.equal(h.fetches.length,2,'helper configuration hold blocks list reads until validation settles');
 await h.release(2);await until(()=>h.replies.some(m=>m.type==='organato-result'&&m.id===configuration.id));
 if(action==='failure')await until(()=>messages.some(m=>m.ok===false));
 assert.deepEqual(titles(await h.view()),['Fixture 1']);await h.view();assert.equal(h.fetches.length,3,'fresh data is reusable after actual helper completion');settings.disconnect();
});
test('worker recreation is cold with identical saved switches',async t=>{
 const a=await fixture(t);await a.view();await a.view();assert.equal(a.fetches.length,1);
 const b=await fixture(t);const saved=await a.f.api.storage.local.get('organato.switches.v1');await b.f.api.storage.local.set(saved);await b.view();assert.equal(b.fetches.length,1);
 const storage=JSON.stringify(await a.f.api.storage.local.get('organato.switches.v1'));assert.ok(!storage.includes('Fixture'));assert.ok(!storage.includes('fingerprint'));
});
test('older helper without capability always lists through actual legacy dispatch',async t=>{
 const h=await fixture(t);await h.state({legacy:true});await h.view();await h.state({version:2});assert.deepEqual(titles(await h.view()),['Fixture 2']);assert.equal(h.fetches.length,2);
 assert.ok(h.replies.filter(m=>m.value?.items).every(m=>!m.value.fingerprint));
});
test('page supplied identity cannot select a cache account',async t=>{
 const h=await fixture(t);const p=h.open();const messages=[];p.onMessage.addListener(m=>messages.push(m));
 p.postMessage({id:'forged',type:'view',fingerprint:'f'.repeat(64),dashboardIdentity:'f'.repeat(64)});await until(()=>messages.length);
 assert.deepEqual(titles(messages[0]),['Fixture 1']);const identity=h.replies.find(m=>m.value?.cacheCapability).value.fingerprint;
 assert.notEqual(identity,'f'.repeat(64));assert.equal(h.replies.find(m=>m.value?.items).value.fingerprint,identity);p.disconnect();
});
test('private cache-owner timeout settles after page closes and next read recovers',async t=>{
 const h=await fixture(t);await h.state({defer:true});const timeouts=[];const original=setTimeout;
 // Restore even on assertion failure; use real clearTimeout for every intercepted timer.
 const timers=[];globalThis.setTimeout=(fn,ms,...args)=>{const id=original(fn,ms,...args);if(ms===65000){timeouts.push(fn);timers.push(id)}return id};
 const p=h.open();p.postMessage({id:'closing',type:'view'});
 try{await until(()=>h.fetches.length===1);p.disconnect();assert.ok(timeouts.length>=2);timeouts.at(-1)();await tick();}
 finally{globalThis.setTimeout=original;for(const timer of timers)clearTimeout(timer);}
 await h.state({defer:false});await h.release(1);await tick();assert.deepEqual(titles(await h.view()),['Fixture 1']);assert.equal(h.fetches.length,2);
});
for(const transition of ['cancelled capture','superseded page query'])for(const outcome of ['resolve','reject'])test(`${transition} ${outcome} cannot disconnect the replacement chat or release its cache hold`,async t=>{
 const h=await fixture(t);await h.view();const panel=h.open('breezer-panel'),messages=[];panel.onMessage.addListener(m=>messages.push(m));panel.postMessage({type:'init'});
 await until(()=>h.ports.some(p=>p.sent.some(m=>m.type==='init')));const native=h.ports.find(p=>p.sent.some(m=>m.type==='init'));
 let settle,started=false;
 const target=transition==='cancelled capture'?h.f.api.scripting:h.f.api.tabs;
 const method=transition==='cancelled capture'?'executeScript':'query',original=target[method];
 target[method]=(...args)=>{
  if(!started&&(transition==='superseded page query'||args[0].args?.[0]==='snapshot')){
   started=true;return new Promise((resolve,reject)=>{settle=()=>outcome==='reject'?reject(Error('late capture failed')):resolve(original(...args));});
  }
  return original(...args);
 };
 const chat=id=>({type:'chat',id,provider:'codex',model:'fake-model',message:'Offline fixture',includeContext:id==='A',control:false});
 panel.postMessage(chat('A'));
 if(transition==='cancelled capture'){
  await until(()=>started);panel.postMessage({type:'cancel',id:'A'});await until(()=>native.sent.some(m=>m.type==='cancel'&&m.id==='A'));
 }
 // Without Stop, both handlers pass the initial await before A owns activeRun.
 panel.postMessage(chat('B'));await until(()=>started&&native.sent.some(m=>m.type==='chat'&&m.id==='B'));
 settle();await tick();target[method]=original;
 assert.equal(native.closed,false,'late A cleanup must not disconnect B\'s shared connection');
 native.onMessage.emit({type:'delta',id:'B',text:'replacement reply'});native.onMessage.emit({type:'complete',id:'B'});await tick();
 assert.deepEqual(messages.filter(m=>m.id==='B').map(m=>m.type),['delta','complete']);
 assert.equal(messages.some(m=>m.id==='A'&&m.type==='error'),false,'abandoned capture must not publish a late error');
 const before=h.fetches.length;await h.view();await h.view();assert.equal(h.fetches.length,before+2,'B connection retains the cache hold even after completion');
 panel.disconnect();await h.view();await h.view();assert.equal(h.fetches.length,before+3,'only B connection close releases the hold and permits reuse');
});
test('chat native post failure releases panel hold',async t=>{
 const h=await fixture(t);await h.view();const p=h.open('breezer-panel');const messages=[];p.onMessage.addListener(m=>messages.push(m));p.postMessage({type:'init'});
 await until(()=>h.ports.some(p=>p.sent.some(m=>m.type==='init')));h.panelMode('chat-throw');
 p.postMessage({type:'chat',id:'chat-fixture',provider:'codex',model:'fake-model',message:'Fake offline text',includeContext:false,control:false});
 await until(()=>messages.some(m=>m.type==='error'&&m.id==='chat-fixture'));await h.view();await h.view();assert.equal(h.fetches.length,2);p.disconnect();
});
for(const action of ['post-failure','native-disconnect','timeout'])test(`settings transport ${action} releases hold`,async t=>{
 const h=await fixture(t);await h.view();await h.state({defer:true});const p=h.open('breezer-organato-settings'),messages=[];p.onMessage.addListener(m=>messages.push(m));
 const original=setTimeout,timers=[],timeouts=[];
 if(action==='post-failure')h.settingsPostFailure(true);
 if(action==='timeout')globalThis.setTimeout=(fn,ms,...args)=>{const timer=original(fn,ms,...args);if(ms===90000){timers.push(timer);timeouts.push(fn)}return timer};
 try{
  p.postMessage({type:'configure',id:'s',settings:{key:'org_'+'z'.repeat(43)}});
  if(action!=='post-failure'){
   await until(()=>h.fetches.length===2);
   if(action==='native-disconnect')h.ports.at(-1).disconnect();else {assert.equal(timeouts.length,1);timeouts[0]();}
  }
  await until(()=>messages.some(m=>m.ok===false));
 }finally{globalThis.setTimeout=original;for(const timer of timers)clearTimeout(timer);}
 h.settingsPostFailure(false);await h.state({defer:false});
 if(action!=='post-failure'){
  const configuration=h.ports.flatMap(port=>port.sent).find(m=>m.type==='organato-configure');
  await h.release(2);await until(()=>h.replies.some(m=>m.type==='organato-result'&&m.id===configuration.id));
 }
 assert.deepEqual(titles(await h.view()),['Fixture 1']);const count=h.fetches.length;await h.view();assert.equal(h.fetches.length,count,'hold released and fresh value reusable');p.disconnect();
});
