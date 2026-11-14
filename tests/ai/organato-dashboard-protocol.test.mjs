import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, copyFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { encodeMessage, NativeDecoder } from '../../features/ai/host/protocol.mjs';
test('native protocol dispatches old and bound calls and forwards known errors', async () => {
  const dir=await mkdtemp(join(tmpdir(),'host-protocol-'));
  let child;
  try {
    for (const file of ['main.mjs','protocol.mjs','attachments.mjs']) await copyFile(new URL('../../features/ai/host/'+file,import.meta.url),join(dir,file));
    await writeFile(join(dir,'updater.mjs'), 'export class UpdateController { receive() {} }');
    await writeFile(join(dir,'organato.mjs'), `export class Organato {
      async view(){return {which:'view'}} async dashboardView(){return {which:'dashboardView',cacheCapability:1,fingerprint:'abc'}}
      async list(){return {which:'list'}} async dashboardList(id){if(id==='bad') throw Object.assign(new Error('changed'),{code:'DASHBOARD_CHANGED',status:429}); return {which:'dashboardList',fingerprint:id}} }`);
    child=spawn(process.execPath,[join(dir,'main.mjs'),'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/'],{stdio:['pipe','pipe','pipe']});
    const decoder=new NativeDecoder(), replies=[];
    child.stdout.on('data', data=>replies.push(...decoder.push(data)));
    const done=new Promise((resolve,reject)=>{child.on('error',reject); child.on('close',code=>code===0?resolve():reject(new Error(`exit ${code}`)));});
    void done.catch(()=>{});
    const requests=[{type:'organato-view'}, {type:'organato-view',dashboardCache:1}, {type:'organato-list'}, {type:'organato-list',dashboardIdentity:'abc'}, {type:'organato-list',dashboardIdentity:'bad'}];
    for (const [id,request] of requests.entries()) child.stdin.write(encodeMessage({...request,id}));
    // Keep stdin open until asynchronous replies have been sent.
    const deadline=Date.now()+3000;
    while(replies.length!==requests.length){
      assert.ok(Date.now()<deadline,'reply timeout');
      await new Promise(resolve=>setTimeout(resolve,1));
    }
    child.stdin.end(); await done;
    replies.sort((a,b)=>a.id-b.id);
    assert.deepEqual(replies.map(r=>r.value?.which),['view','dashboardView','list','dashboardList',undefined]);
    assert.equal(replies[3].value.fingerprint,'abc'); assert.deepEqual(replies[4],{type:'organato-result',id:4,ok:false,error:'changed',code:'DASHBOARD_CHANGED',status:429});
  } finally {
    if(child&&child.exitCode===null&&child.signalCode===null){
      child.kill('SIGTERM');
      for(let i=0;i<100&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(resolve=>setTimeout(resolve,5));
      if(child.exitCode===null&&child.signalCode===null){
        child.kill('SIGKILL');
        for(let i=0;i<100&&child.exitCode===null&&child.signalCode===null;i++)await new Promise(resolve=>setTimeout(resolve,5));
      }
      assert.ok(child.exitCode!==null||child.signalCode!==null,`Owned host still alive; temporary directory retained: ${dir}`);
    }
    await rm(dir,{recursive:true,force:true});
  }
});
