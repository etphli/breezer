import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once, EventEmitter} from 'node:events';
import {readFile} from 'node:fs/promises';
import {ownChild, validateSample, validateUsage, validateReport} from '../../script/native_transport_diagnostic.mjs';

const historical = JSON.parse(await readFile(new URL('../../docs/evidence/memory-20261102/native-transport-final-4096.json', import.meta.url)));
test('producer validates every historical sample/probe and rejects malformed records', async () => {
  let count = 0;
  for (const bytes of [4096,65536,1048576,4194304,8388608]) {
    const report = JSON.parse(await readFile(new URL(`../../docs/evidence/memory-20261102/native-transport-final-${bytes}.json`, import.meta.url)));
    for (const trial of report.results) {
      validateSample(trial.before, trial.after.pid, report.runtime.version);
      validateSample(trial.after, trial.before.pid, report.runtime.version);
      validateUsage(trial.usage, trial.after.pid); count++;
    }
  }
  assert.equal(count, 60);
  for (const mutate of [u=>u.schema=999,u=>u.processes[0].pid++,u=>u.processes[0].status='error',u=>u.processes[0].physicalFootprintBytes=-1,u=>u.captureEndedNs='1',u=>u.processes[0].residentBytes=NaN]) {
    const usage=structuredClone(historical.results[0].usage);mutate(usage);
    assert.throws(()=>validateUsage(usage,historical.results[0].after.pid));
  }
  const trial=historical.results[0];
  assert.throws(()=>validateSample(trial.before,999,historical.runtime.version));
  assert.throws(()=>validateSample(trial.before,trial.before.pid,'v0.0.0'));
  const previous=structuredClone(trial.usage);previous.captureStartedNs='1';previous.captureEndedNs='2';
  validateUsage(trial.usage,trial.after.pid,previous);
  previous.processes[0].executableUuid='a'.repeat(32);
  assert.throws(()=>validateUsage(trial.usage,trial.after.pid,previous));
});

for (const stage of ['startup','sample','write','reply','close']) {
  test(`owned SIGTERM-ignoring child is killed and reaped after ${stage} failure`, {timeout:5000}, async () => {
    const child=spawn(process.execPath,['-e',"process.on('SIGTERM',()=>{});console.log('ready');setInterval(()=>{},1000)"]);
    const owned=ownChild(child,{killAfterMs:2000,terminateAfterMs:30});
    try {
      await owned.wait(once(child.stdout,'data'),'ready',1000);
      if (stage === 'write') {
        const waiting=owned.wait(new Promise(()=>{}),stage,50);
        child.stdin.emit('error',new Error('synthetic write failure'));
        await assert.rejects(waiting,/synthetic write/);
      } else if (stage === 'reply') {
        owned.fail(new Error('synthetic malformed reply'));
        await assert.rejects(owned.wait(new Promise(()=>{}),stage,50),/malformed reply/);
      } else {
        await assert.rejects(owned.wait(new Promise(()=>{}),stage,20),/timed out/);
      }
    } finally { await owned.cleanup(); }
    assert.deepEqual(await owned.closed,[null,'SIGKILL']);
    assert.throws(()=>process.kill(child.pid,0), {code:'ESRCH'});
    await owned.cleanup();
  });
}
test('startup spawn error is observed and close reaped',async()=>{
  const child=spawn('/nonexistent/breezer-diagnostic-child',[]);
  const owned=ownChild(child,{killAfterMs:1000,terminateAfterMs:30});
  await assert.rejects(owned.wait(once(child,'spawn'),'startup',500),{code:'ENOENT'});
  await owned.cleanup();assert.equal((await owned.closed)[0],-2);
});
test('original watchdog survives cleanup until child close',async()=>{
  const child=new EventEmitter(); child.stdin=new EventEmitter();
  const signals=[];child.kill=signal=>{signals.push(signal);if(signal==='SIGKILL')setTimeout(()=>child.emit('close',null,signal),5);};
  const owned=ownChild(child,{killAfterMs:15,terminateAfterMs:100});
  await owned.cleanup();assert.deepEqual(signals,['SIGTERM','SIGKILL']);
});

test('producer report boundary checks deltas, source identity, structure and optional diagnostics', () => {
  const report=structuredClone(historical);report.schema=1;
  for (const trial of report.results) { trial.usage=null;trial.usageBefore=null; }
  validateReport(report);
  const trial=report.results[0];trial.after.memory.arrayBuffers=trial.before.memory.arrayBuffers-1;trial.retainedArrayBufferBytes=-1;
  validateReport(report);
  for (const mutate of [r=>r.schema=999,r=>r.runtime.sha256='bad',r=>r.otherHostSources={},r=>r.results[0].cpuUserMicros++,r=>r.results[0].cpuSystemMicros=-1,r=>r.results[0].retainedArrayBufferBytes++,r=>r.results[0].replyMs=Infinity,r=>r.results[0].name='wrong',r=>r.results.pop(),r=>r.results[0].usage=historical.results[0].usage]) {
    const invalid=structuredClone(report);mutate(invalid);assert.throws(()=>validateReport(invalid));
  }
  for (const trial of report.results) {
    trial.usage=structuredClone(historical.results.find(t=>t.name===trial.name&&t.round===trial.round).usage);
    trial.usageBefore=structuredClone(trial.usage);trial.usageBefore.captureStartedNs='1';trial.usageBefore.captureEndedNs='2';
  }
  validateReport(report);
});
