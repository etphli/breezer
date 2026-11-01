#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256, withBuiltinBlocker } from './breezer_filter_lists.mjs';

const { values } = parseArgs({ options: { 'source-dir': { type: 'string' }, artifacts: { type: 'string' }, browser: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values['source-dir'] && values.artifacts && values.browser && values.output, 'Required: --source-dir STAGED_CHROMIUM --artifacts DIRECTORY --browser NATIVE_EXECUTABLE --output REPORT');
const folder = join(resolve(values['source-dir']), 'third_party/ublock'), artifacts = resolve(values.artifacts);
const contract = JSON.parse(await readFile(join(artifacts, 'contract.json'), 'utf8'));
const index = JSON.parse(await readFile(join(artifacts, 'index.json'), 'utf8'));
const names = (await readdir(folder, { recursive: true })).filter(name => name.endsWith('.js') && (name.startsWith('js/') || name.startsWith('lib/'))).sort();
const sourceHashes = {};
for (const name of names) sourceHashes[name] = sha256(await readFile(join(folder, name)));

const report = await withBuiltinBlocker({ browser: resolve(values.browser), ...contract }, async ({ cdp, session }) => {
  const browserVersion = await cdp.send('Browser.getVersion');
  assert.equal(browserVersion.product, contract.engineVersion);
  assert.equal(browserVersion.jsVersion, contract.engineJavaScriptVersion);
  const actual = await cdp.evaluate(session, `(async()=>{
    const hashes={};
    for(const name of ${JSON.stringify(names)}){
      const response=await fetch(chrome.runtime.getURL(name));
      if(!response.ok)throw new Error('Missing native resource '+name);
      hashes[name]=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');
    }
    return hashes;
  })()`);
  assert.deepEqual(actual, sourceHashes, 'Packaged native JavaScript differs from staged source');
  const proof = await cdp.evaluate(session, `(async()=>{
    const [{default:ub},{default:io},{default:net},{bundledFilterLists:reader}]=await Promise.all(['background.js','assets.js','static-net-filtering.js','breezer-compiled-filter-context.js'].map(name=>import(chrome.runtime.getURL('js/'+name))));
    io.updateStop();
    const index=await fetch(chrome.runtime.getURL('assets/breezer-compiled/index.json')).then(r=>r.json());
    const registry=await fetch(chrome.runtime.getURL('assets/assets.json')).then(r=>r.json()),checks=[];
    for(const assetKey of Object.keys(index.entries)){
      let raw;
      for(const url of [registry[assetKey].contentURL].flat().filter(url=>url.startsWith('assets/'))){
        const details=await io.fetchFilterList(url);
        if(details.content){raw=details.content;break;}
      }
      if(!raw)throw new Error('Missing packaged raw list '+assetKey);
      const trustedSource=ub.isTrustedList(assetKey);
      const expected=ub.compileFilters(raw,{assetKey,trustedSource});
      const hit=await reader.read({assetKey,rawText:raw,trustedSource},result=>result);
      if(hit.kind!=='hit'||hit.content!==expected)throw new Error('Native compiled bytes differ '+assetKey);
      const changed=await reader.read({assetKey,rawText:raw+'\\n||breezer-test.invalid^$script',trustedSource},result=>result);
      const trust=await reader.read({assetKey,rawText:raw,trustedSource:!trustedSource},result=>result);
      if(changed.kind!=='miss'||trust.kind!=='miss')throw new Error('Native fallback failed '+assetKey);
      checks.push({assetKey,byteExact:true,changedRaw:changed.kind,changedTrust:trust.kind});
    }
    const cached={};
    for(const key of Object.keys(index.entries)){
      cached[key]=await io.fromCache('compiled/'+key);
      if(!cached[key]?.startsWith(ub.systemSettings.compiledMagic+'\\n'))throw new Error('Missing ordinary compiled cache '+key);
    }
    const saved={compiler:ub.compileFilters,lookup:reader.read,format:ub.compiledFormatChanged};
    const warmCache=[];
    ub.compileFilters=()=>{throw new Error('Unexpected warm-cache compilation')};
    reader.read=()=>{throw new Error('Unexpected warm-cache packaged lookup')};
    ub.compiledFormatChanged=false;
    try{
      for(const key of Object.keys(index.entries)){
        const result=await ub.getCompiledFilterList(key);
        if(result.content!==cached[key])throw new Error('Cached result differs '+key);
        warmCache.push({assetKey:key,existingCacheWon:true});
      }
    }finally{
      ub.compileFilters=saved.compiler;reader.read=saved.lookup;ub.compiledFormatChanged=saved.format;
    }
    if(ub.inMemoryFilters.length!==0)throw new Error('Unexpected in-memory filters in fresh profile');
    const before={selected:[...ub.selectedFilterLists].sort(),networkFilterCount:net.getFilterCount()};
    const createdAt=Date.now();
    await ub.selfieManager.create();
    if(ub.selfieIsInvalid!==false)throw new Error('Engine snapshot was not created');
    // Asset payloads and their registry have separate persistence. Wait for the
    // existing three-second registry timer before testing a genuine restart.
    const {default:cache}=await import(chrome.runtime.getURL('js/cachestorage.js'));
    let persisted=false;
    const deadline=performance.now()+10000;
    while(performance.now()<deadline&&!persisted){
      const bin=await cache.get('assetCacheRegistry');
      persisted=['selfie/staticMain','selfie/staticExtFilteringEngine','selfie/staticNetFilteringEngine'].every(key=>bin?.assetCacheRegistry?.[key]?.writeTime>=createdAt);
      if(!persisted)await new Promise(done=>setTimeout(done,100));
    }
    if(!persisted)throw new Error('Engine snapshot registry did not finish persistence');
    return{index,checks,warmCache,before,t0:vAPI.T0};
  })()`);
  assert.deepEqual(proof.index, index);
  assert.equal(proof.checks.length, Object.keys(index.entries).length);
  await cdp.evaluate(session, 'setTimeout(()=>chrome.runtime.reload(),0);true');
  let current, after;
  const deadline = performance.now() + 25000;
  while (performance.now() < deadline && !after) {
    const target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.type === 'background_page' && t.url.startsWith('chrome-extension://blockjmkbacgjkknlgpkjjiijinjdanf/'));
    if (target) {
      if (!current || current.targetId !== target.targetId) {
        current = { targetId: target.targetId, session: await cdp.attach(target.targetId) };
        await cdp.send('Network.enable', {}, current.session);
        await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, current.session);
      }
      try {
        const state = await cdp.evaluate(current.session, `(async()=>{
          if(!globalThis.vAPI?.uBO||document.readyState!=='complete')return null;
          await import(chrome.runtime.getURL('js/start.js'));
          const [{default:ub},{default:net}]=await Promise.all(['background.js','static-net-filtering.js'].map(name=>import(chrome.runtime.getURL('js/'+name))));
          return{t0:vAPI.T0,ready:ub.readyToFilter,selected:[...ub.selectedFilterLists].sort(),networkFilterCount:net.getFilterCount(),support:ub.supportStats};
        })()`, 2000);
        if (state?.ready === true && state.t0 !== proof.t0 && typeof state.support.allReadyAfter === 'string') after = state;
      } catch {}
    }
    if (!after) await new Promise(done => setTimeout(done, 25));
  }
  assert.ok(after, 'Reloaded blocker did not become ready');
  assert.match(after.support.allReadyAfter, /\(selfie\)$/);
  assert.deepEqual(after.selected, proof.before.selected);
  assert.equal(after.networkFilterCount, proof.before.networkFilterCount);
  return { status: 'passed', scope: 'Real packaged resources and default reader in a disposable headless native profile. Byte, fallback, existing-cache and saved-engine restart checks. Functional evidence, not a timing comparison.',
    browserVersion, sourceFilesVerified: names.length, ...proof, after };
});
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
