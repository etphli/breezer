import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync}from'node:fs';
import {createDom,userClick}from'./settings-dom.mjs';
import {mountOrganato}from'../../features/ai/extension/settings.js';
const html=readFileSync(new URL('../../features/ai/extension/workspace.html',import.meta.url),'utf8');
function fixture(){const dom=createDom(html);Object.assign(globalThis,dom.globals);globalThis.window=dom.window;
 const events=()=>({listeners:[],addListener(fn){this.listeners.push(fn)},fire(value){this.listeners.forEach(fn=>fn(value))}});
 const port={onMessage:events(),onDisconnect:events(),sent:[],postMessage(m){this.sent.push(m)},disconnect(){}};
 const api={runtime:{connect:()=>port}};const service=mountOrganato(api,{timeoutMs:10});
 return {port,service,$:id=>dom.document.getElementById(id)};
}
test('a late initial view never hides the result of a newer connect attempt',()=>{
 const f=fixture();f.$('organato-key').value='org_'+'x'.repeat(43);userClick(f.$('organato-connect'));
 const connect=f.port.sent.find(m=>m.type==='configure');assert.ok(connect,'Connect must be accepted while initial status is pending');
 f.port.onMessage.fire({id:connect.id,ok:false,error:'Organato API key is invalid or expired.'});
 f.port.onMessage.fire({id:f.port.sent[0].id,ok:true,value:{enabled:true,dashboardEnabled:true,allowAI:true,connected:false}});
 assert.match(f.$('organato-status').textContent,/invalid or expired/);f.service?.dispose();
});
test('status replies preserve typed keys and helper silence ends with a retryable error',async()=>{
 const f=fixture();f.$('organato-key').value='typed-but-not-submitted';
 f.port.onMessage.fire({id:f.port.sent[0].id,ok:true,value:{enabled:true,dashboardEnabled:true,allowAI:true,connected:false}});
 assert.equal(f.$('organato-key').value,'typed-but-not-submitted');
 userClick(f.$('organato-connect'));await new Promise(r=>setTimeout(r,25));
 assert.match(f.$('organato-status').textContent,/timed out/i);assert.equal(f.$('organato-connect').disabled,false);f.service?.dispose();
});
test('progress and double clicks respect the active request',()=>{
 const f=fixture();f.port.onMessage.fire({id:f.port.sent[0].id,ok:true,value:{enabled:true,dashboardEnabled:true,allowAI:true,connected:false}});
 f.$('organato-key').value='org_'+'x'.repeat(43);userClick(f.$('organato-connect'));userClick(f.$('organato-connect'));
 assert.equal(f.port.sent.filter(m=>m.type==='configure').length,1);
 const current=f.port.sent.at(-1);f.port.onMessage.fire({id:current.id,type:'progress',stage:'Checking your Organato key…'});
 assert.match(f.$('organato-status').textContent,/Checking your Organato key/);f.service?.dispose();
});
