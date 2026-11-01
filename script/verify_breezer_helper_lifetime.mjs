#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { parseArgs } from 'node:util';
import { withBuiltinBlocker } from './breezer_filter_lists.mjs';
import { parseProcesses, processTree } from './benchmark_browsers.mjs';

const {values}=parseArgs({options:Object.fromEntries(['baseline-browser','candidate-browser','artifacts','usage-probe','output','clients'].map(name=>[name,{type:'string'}]))});
for(const name of ['baseline-browser','candidate-browser','artifacts','usage-probe','output'])assert.ok(values[name],`Required: --${name}`);
const clients=Number(values.clients||1);
assert.ok(Number.isSafeInteger(clients)&&clients>=1&&clients<=16,'--clients must be between 1 and 16');
const contract=JSON.parse(await readFile(join(resolve(values.artifacts),'contract.json'),'utf8'));
const probe=resolve(values['usage-probe']);
const pause=ms=>new Promise(done=>setTimeout(done,ms));
const report={status:'unverified',clients,idleMs:1500,scope:'Real native settings connections from one trusted document, invalid input only; no Keychain, configuration or provider requests. Short helper-lifetime check; verify_breezer_settings_lifetime.mjs separately verifies production clients after actual worker retirement.',runs:[]};
const save=()=>writeFile(resolve(values.output),JSON.stringify(report,null,2)+'\n');
for(const [name,path] of [['baseline',values['baseline-browser']],['candidate',values['candidate-browser']]]){
  const browser=resolve(path);
  const app=browser.replace(/\/Contents\/MacOS\/[^/]+$/,'');
  assert.notEqual(app,browser,'Expected an app-bundle executable');
  const result=await withBuiltinBlocker({browser,...contract},async({cdp,pid})=>{
    const sample=()=>{
      const rows=processTree(parseProcesses(execFileSync('/bin/ps',['-axo','pid=,ppid=,rss=,command='],{encoding:'utf8',timeout:3000})),pid);
      const helpers=rows.filter(row=>row.command.includes('/breezer_ai/host/main.mjs'));
      for(const row of helpers)assert.ok(row.command.includes(app+'/'),'Native helper must belong to the measured app');
      const memory=helpers.length?JSON.parse(execFileSync(probe,helpers.map(row=>String(row.pid)),{encoding:'utf8',timeout:3000})):null;
      if(memory)assert.ok(memory.processes.every(row=>row.status==='ok'),'Native helper memory unavailable');
      return{helpers:helpers.map(({pid,rssKiB})=>({pid,rssKiB})),memory};
    };
    const initial=sample();assert.equal(initial.helpers.length,0,'Unexpected pre-existing host in isolated browser');
    const {targetId}=await cdp.send('Target.createTarget',{url:'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/workspace.html'});
    const session=await cdp.attach(targetId);
    let ready=false;
    for(let i=0;i<100&&!ready;i++){
      try{ready=await cdp.evaluate(session,"location.pathname==='/workspace.html'&&document.readyState==='complete'&&Boolean(chrome.runtime?.id)",1000);}catch{}
      if(!ready)await pause(50);
    }
    assert.ok(ready,'Workspace did not load');
    await cdp.evaluate(session,`(()=>{
      globalThis.diagReplies=[];
      globalThis.diagPorts=Array.from({length:${clients}},(_,client)=>{
        const port=chrome.runtime.connect({name:'breezer-organato-settings'});
        port.onMessage.addListener(message=>diagReplies.push({client,id:message.id,ok:message.ok,error:message.error}));
        port.onDisconnect.addListener(()=>{globalThis.diagDisconnected=true;void chrome.runtime.lastError;});
        return port;
      });
      return true;
    })()`);
    await pause(1000);const connected=sample();
    const request=async id=>{
      await cdp.evaluate(session,`diagPorts.forEach(port=>port.postMessage({id:${JSON.stringify(id)},type:'configure',settings:{enabled:'invalid-diagnostic-input'}}));true`);
      let replies=[];
      for(let i=0;i<300&&replies.length!==clients;i++){
        replies=await cdp.evaluate(session,`diagReplies.filter(message=>message.id===${JSON.stringify(id)}).sort((a,b)=>a.client-b.client)`);
        if(replies.length!==clients)await pause(20);
      }
      assert.deepEqual(replies,Array.from({length:clients},(_,client)=>({client,id,ok:false,error:'Invalid Organato setting.'})));
      return{replies,atReply:sample()};
    };
    const first=await request('first');await pause(1500);const idleFirst=sample();
    const second=await request('second');await pause(1500);const idleSecond=sample();
    assert.equal(await cdp.evaluate(session,'globalThis.diagDisconnected===true'),false,'Settings port must remain usable');
    await cdp.evaluate(session,'diagPorts.forEach(port=>port.disconnect());true');
    await pause(1000);const disconnected=sample();
    assert.equal(disconnected.helpers.length,0,'Closing the port should stop its host');
    return{name,app,initial,connected,first,idleFirst,second,idleSecond,disconnected};
  });
  report.runs.push(result);await save();
  assert.equal(result.connected.helpers.length,name==='baseline'?clients:0);
  assert.equal(result.first.atReply.helpers.length,name==='baseline'?clients:1);
  assert.equal(result.second.atReply.helpers.length,name==='baseline'?clients:1);
  assert.equal(result.idleFirst.helpers.length,name==='baseline'?clients:0);
  assert.equal(result.idleSecond.helpers.length,name==='baseline'?clients:0);
  if(name==='candidate')assert.notEqual(result.first.atReply.helpers[0].pid,result.second.atReply.helpers[0].pid,'Later request should launch a fresh helper');
}
report.status='passed';await save();console.log(JSON.stringify(report,null,2));
