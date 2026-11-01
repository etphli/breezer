#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { withBuiltinBlocker } from './breezer_filter_lists.mjs';

const { values } = parseArgs({ options: { browser: { type: 'string' }, artifacts: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values.browser && values.artifacts && values.output, 'Required: --browser NATIVE_EXECUTABLE --artifacts DIRECTORY --output REPORT');
const artifacts = resolve(values.artifacts);
const contract = JSON.parse(await readFile(join(artifacts, 'contract.json'), 'utf8'));
const index = JSON.parse(await readFile(join(artifacts, 'index.json'), 'utf8'));
const userFilters = [
  '||blocked.breezer-net.invalid^$script,third-party',
  '@@||blocked.breezer-net.invalid/allowed.js$script',
  '||assets.breezer-net.invalid/pixel.gif$image',
  '||method.breezer-net.invalid^$method=post',
  '||blocked.breezer-net.invalid/redirect.js$script,redirect=noop.js',
  '||publisher.breezer-page.invalid^$removeparam=breezer_tracking',
  'publisher.breezer-page.invalid##.breezer-ad',
  'publisher.breezer-page.invalid##.breezer-allowed-ad',
  'publisher.breezer-page.invalid#@#.breezer-allowed-ad',
  'publisher.breezer-page.invalid##.breezer-procedural:has-text(BreezerFixture)',
  'publisher.breezer-page.invalid##+js(set-constant, breezerFixtureFlag, true)',
  'publisher.breezer-page.invalid##+js(trusted-set-constant, breezerTrustedFlag, validated)',
].join('\n');

const report = await withBuiltinBlocker({ browser: resolve(values.browser), ...contract }, async ({ cdp, session, browserVersion }) => {
  assert.equal(browserVersion.product, contract.engineVersion);
  assert.equal(browserVersion.jsVersion, contract.engineJavaScriptVersion);
  const packagedIndex = await cdp.evaluate(session, "fetch(chrome.runtime.getURL('assets/breezer-compiled/index.json')).then(r=>r.json())");
  assert.deepEqual(packagedIndex, index);
  const result = await cdp.evaluate(session, `(async()=>{
    const [{default:ub},{default:io},{default:net},{default:cosmetic},{default:scriptlets},{redirectEngine},{FilteringContext},{bundledFilterLists:reader}]=await Promise.all(['background.js','assets.js','static-net-filtering.js','cosmetic-filtering.js','scriptlet-filtering.js','redirect-engine.js','filtering-context.js','breezer-compiled-filter-context.js'].map(name=>import(chrome.runtime.getURL('js/'+name))));
    io.updateStop();
    ub.userSettings.userFiltersTrusted=true;
    await ub.saveUserFilters(${JSON.stringify(userFilters)});
    ub.inMemoryFilters=['||memory.breezer-net.invalid^$script'];
    ub.inMemoryFiltersCompiled='';
    const customKey='https://breezer-fixture.invalid/custom.txt';
    ub.userSettings.importedLists.push(customKey);
    ub.selectedFilterLists.push(customKey);
    await io.registerAssetSource(customKey,{content:'filters',contentURL:customKey,group:'custom',external:true,submitter:'user',title:''});
    await io.put(customKey,'! Title: Breezer custom fixture\\n||custom.breezer-net.invalid^$script');
    const saved={lookup:reader.read,compiler:ub.compileFilters,cache:io.toCache};
    let trace;
    function context(url,type='script',from='https://publisher.breezer-page.invalid/',method='GET'){
      return new FilteringContext().setURL(url).setType(type).setDocOriginFromURL(from).setTabOriginFromURL(from).setMethod(method);
    }
    function outcome(url,type,from,method){return net.matchRequest(context(url,type,from,method));}
    const urls=[
      'https://blocked.breezer-net.invalid/resource.js','https://blocked.breezer-net.invalid/allowed.js',
      'https://assets.breezer-net.invalid/pixel.gif','https://method.breezer-net.invalid/resource',
      'https://memory.breezer-net.invalid/resource.js','https://custom.breezer-net.invalid/resource.js',
      'https://publisher.breezer-page.invalid/main.css','https://publisher.breezer-page.invalid/main.js',
      'https://googleads.g.doubleclick.net/pagead/ads?client=fixture','https://www.google-analytics.com/analytics.js',
      'https://connect.facebook.net/en_US/fbevents.js','https://pagead2.googlesyndication.com/pagead/js/adsbygoogle.js',
      'https://adservice.google.com/adsid/integrator.js','https://sb.scorecardresearch.com/beacon.js',
      'https://static.hotjar.com/c/hotjar-123.js','https://bat.bing.com/bat.js',
      'https://cdn.segment.com/analytics.js','https://example.org/main.css',
      'https://example.org/main.js','https://example.org/image.png',
    ];
    const types=['script','image','stylesheet','xmlhttprequest','sub_frame','media','object','websocket'];
    const methods=['GET','POST'];
    function corpus(){
      const decisions=[];
      for(const url of urls)for(const type of types)for(const from of ['https://publisher.breezer-page.invalid/',new URL(url).origin+'/'])for(const method of methods){
        decisions.push(outcome(url,type,from,method));
      }
      return decisions;
    }
    function snapshot(){
      const url='https://publisher.breezer-page.invalid/';
      const request={hostname:'publisher.breezer-page.invalid',domain:'breezer-page.invalid',url,frameId:0};
      const css=cosmetic.retrieveSpecificSelectors(request,{dontInject:true});
      const disabled=cosmetic.retrieveSpecificSelectors(request,{dontInject:true,noSpecificCosmeticFiltering:true,noGenericCosmeticFiltering:true});
      const script=scriptlets.retrieve({...request,nocache:true});
      const redirect=context('https://blocked.breezer-net.invalid/redirect.js');
      net.matchRequest(redirect);net.redirectRequest(redirectEngine,redirect);
      const redirected=redirect.redirectURL?new URL(redirect.redirectURL,chrome.runtime.getURL('/')):null;
      const query=context(url+'?a=1&breezer_tracking=remove&b=2#section','xmlhttprequest');
      net.filterQuery(query);
      return{
        network:{
          blocked:outcome('https://blocked.breezer-net.invalid/resource.js'),
          exception:outcome('https://blocked.breezer-net.invalid/allowed.js'),
          firstParty:outcome('https://blocked.breezer-net.invalid/resource.js','script','https://blocked.breezer-net.invalid/'),
          image:outcome('https://assets.breezer-net.invalid/pixel.gif','image'),
          post:outcome('https://method.breezer-net.invalid/resource','xmlhttprequest',undefined,'POST'),
          get:outcome('https://method.breezer-net.invalid/resource','xmlhttprequest',undefined,'GET'),
          memory:outcome('https://memory.breezer-net.invalid/resource.js'),
          custom:outcome('https://custom.breezer-net.invalid/resource.js'),
          updated:outcome('https://update.breezer-net.invalid/resource.js'),
          defaultAd:outcome('https://googleads.g.doubleclick.net/pagead/ads?client=fixture'),
        },
        cosmetic:{hidden:css.injectedCSS?.includes('.breezer-ad')===true,
          exception:!css.injectedCSS?.includes('.breezer-allowed-ad'),
          procedural:JSON.stringify(css.proceduralFilters).includes('breezer-procedural'),
          disabled:!disabled.injectedCSS&&disabled.proceduralFilters.length===0,
          excepted:css.exceptedFilters.filter(s=>s.includes('breezer-')).sort()},
        scriptlets:{filters:script?.filters?.filter(s=>s.includes('breezerFixtureFlag')||s.includes('breezerTrustedFlag')).sort(),
          regular:script?.code?.includes('breezerFixtureFlag')===true,trusted:script?.code?.includes('breezerTrustedFlag')===true},
        redirect:redirected?{protocol:redirected.protocol,path:redirected.protocol==='data:'?'data':redirected.pathname}:null,
        removeparam:query.redirectURL||null,
        networkFilterCount:net.getFilterCount(),customTitle:ub.availableFilterLists[customKey]?.title,
      };
    }
    async function reload(mode,{cold=true,collectCorpus=false}={}){
      trace={mode,hits:[],misses:[],compiled:[]};
      const writes=[];
      ub.compileFilters=function(raw,details){trace.compiled.push(details?.assetKey);return saved.compiler.call(this,raw,details)};
      reader.read=function(request,consume){
        return saved.lookup.call(this,request,result=>{
          const chosen=mode==='compile'&&result.kind!=='retry'?{kind:'miss'}:result;
          trace[chosen.kind==='hit'?'hits':'misses'].push(request.assetKey);
          return consume(chosen);
        });
      };
      io.toCache=function(...args){const promise=saved.cache.apply(this,args);writes.push(Promise.resolve(promise).then(()=>{}));return promise;};
      if(cold)ub.compiledFormatChanged=true;
      ub.readyToFilter=false;
      try{
        await ub.loadFilterLists();await Promise.all(writes);
        return{trace,behavior:snapshot(),...(collectCorpus?{decisions:corpus()}:{}),selected:[...ub.selectedFilterLists].sort()};
      }finally{
        ub.readyToFilter=true;reader.read=saved.lookup;ub.compileFilters=saved.compiler;io.toCache=saved.cache;
      }
    }
    const compiled=await reload('compile',{collectCorpus:true});
    const bundled=await reload('bundled',{collectCorpus:true});
    ub.userSettings.userFiltersTrusted=false;
    const untrustedUser=await reload('bundled');
    const raw=await io.get('easylist',{favorLocal:true,silent:true});
    const updatedRaw=raw.content+'\\n||update.breezer-net.invalid^$script';
    await io.put('easylist',updatedRaw);
    const expectedUpdated=ub.compileFilters(updatedRaw,{assetKey:'easylist',trustedSource:ub.isTrustedList('easylist')});
    let persisted=false;
    const deadline=performance.now()+10000;
    while(performance.now()<deadline&&!persisted){
      persisted=(await io.fromCache('compiled/easylist'))===expectedUpdated;
      if(!persisted)await new Promise(done=>setTimeout(done,50));
    }
    if(!persisted)throw new Error('The ordinary update observer did not finish its compiled-cache write');
    const updatedWarm=await reload('bundled',{cold:false});
    const updatedCold=await reload('bundled');
    const selected=[...ub.selectedFilterLists];
    await ub.saveSelectedFilterLists(selected.filter(key=>key!=='easylist'));
    const deselected=await reload('bundled');
    const deselectedRawPurged=(await io.fromCache('easylist'))==='';
    await ub.saveSelectedFilterLists(selected);
    const reselected=await reload('bundled');
    const reselectedCompiled=await reload('compile');
    ub.badLists.set(customKey,true);
    const badCustom=await reload('bundled');
    ub.hiddenSettings.trustedListPrefixes='';ub.parsedTrustedListPrefixes=[];
    const changedBuiltinTrust=await reload('bundled');
    async function concurrentUpdate(){
      const original=(await io.get('easylist',{favorLocal:true,silent:true})).content;
      const changed=original+'\\n||concurrent.breezer-net.invalid^$script';
      const expected=ub.compileFilters(changed,{assetKey:'easylist',trustedSource:ub.isTrustedList('easylist')});
      const payloadURL=chrome.runtime.getURL('assets/breezer-compiled/'+${JSON.stringify(index.entries.easylist.path)});
      const oldFetch=globalThis.fetch,oldCache=io.toCache,writes=[];
      let enter,release,timer,paused=false;
      const entered=new Promise(resolve=>{enter=resolve});
      const gate=new Promise(resolve=>{release=resolve});
      globalThis.fetch=async function(input,...args){
        const response=await oldFetch.call(this,input,...args);
        if(String(input)===payloadURL&&!paused){paused=true;enter();await gate;}
        return response;
      };
      io.toCache=function(...args){const promise=oldCache.apply(this,args);writes.push(Promise.resolve(promise).then(()=>{}));return promise;};
      ub.compiledFormatChanged=true;
      const pending=[ub.getCompiledFilterList('easylist'),ub.getCompiledFilterList('easylist')];
      try{
        await Promise.race([entered,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('The real packaged read did not reach the update gate')),10000)})]);
        clearTimeout(timer);
        await io.put('easylist',changed);
        const deadline=performance.now()+10000;
        let beforeRelease=false;
        while(performance.now()<deadline&&!beforeRelease){
          beforeRelease=(await io.fromCache('compiled/easylist'))===expected;
          if(!beforeRelease)await new Promise(resolve=>setTimeout(resolve,50));
        }
        if(!beforeRelease)throw new Error('Updated compiled cache was not ready before releasing old reads');
        release();
        const returned=await Promise.all(pending);
        await Promise.all(writes);
        return{realPayloadReadPaused:paused,updatedCacheReadyBeforeRelease:beforeRelease,
          returnedLatest:returned.map(value=>value.content===expected),cacheContainsLatest:(await io.fromCache('compiled/easylist'))===expected};
      }finally{
        clearTimeout(timer);release();await Promise.allSettled(pending);
        globalThis.fetch=oldFetch;io.toCache=oldCache;
      }
    }
    const concurrentRawUpdate=await concurrentUpdate();
    return{compiled,bundled,untrustedUser,updatedWarm,updatedCold,deselected,deselectedRawPurged,reselected,reselectedCompiled,badCustom,changedBuiltinTrust,
      concurrentRawUpdate,
      corpus:{urls,types,methods,origins:'For each URL: fixture publisher, then same origin. Loop order: URL, type, origin, method.'}};
  })()`, 90000);

  await writeFile(resolve(values.output), JSON.stringify({ status: 'unverified', browserVersion, ...result }, null, 2) + '\n');
  assert.deepEqual(result.bundled.behavior, result.compiled.behavior, 'Packaged and ordinary compilation produce different filtering behavior');
  assert.deepEqual(result.bundled.decisions, result.compiled.decisions, 'Request corpus decisions differ');
  assert.deepEqual(result.bundled.selected, result.compiled.selected);
  assert.equal(result.bundled.trace.hits.length, Object.keys(index.entries).length);
  assert.equal(result.compiled.trace.hits.length, 0);
  const expected = { blocked: 1, exception: 2, firstParty: 0, image: 1, post: 1, get: 0, memory: 1, custom: 1, updated: 0, defaultAd: 1 };
  assert.deepEqual(result.bundled.behavior.network, expected, 'Positive and negative controls failed');
  assert.deepEqual(result.bundled.behavior.cosmetic, { hidden: true, exception: true, procedural: true, disabled: true, excepted: ['.breezer-allowed-ad'] });
  assert.equal(result.bundled.behavior.scriptlets.regular, true);
  assert.equal(result.bundled.behavior.scriptlets.trusted, true);
  assert.equal(result.bundled.behavior.redirect.path, '/web_accessible_resources/noop.js');
  assert.equal(result.bundled.behavior.removeparam, 'https://publisher.breezer-page.invalid/?a=1&b=2#section');
  assert.equal(result.bundled.behavior.customTitle, 'Breezer custom fixture');
  assert.ok(result.bundled.trace.compiled.includes('user-filters'));
  assert.ok(result.bundled.trace.compiled.includes('https://breezer-fixture.invalid/custom.txt'));
  assert.equal(result.untrustedUser.behavior.scriptlets.regular, true);
  assert.equal(result.untrustedUser.behavior.scriptlets.trusted, false);
  assert.equal(result.updatedWarm.behavior.network.updated, 1);
  assert.equal(result.updatedCold.behavior.network.updated, 1);
  assert.ok(result.updatedCold.trace.misses.includes('easylist'));
  assert.ok(result.updatedCold.trace.compiled.includes('easylist'));
  assert.equal(result.deselected.behavior.network.updated, 0);
  assert.ok(!result.deselected.selected.includes('easylist'));
  // The existing selection API purges deselected raw lists. Reselecting offline
  // restores the packaged original, whose bytes must behave like compilation.
  assert.equal(result.deselectedRawPurged, true);
  assert.equal(result.reselected.behavior.network.updated, 0);
  assert.ok(result.reselected.selected.includes('easylist'));
  assert.ok(result.reselected.trace.hits.includes('easylist'));
  assert.deepEqual(result.reselected.behavior, result.reselectedCompiled.behavior);
  assert.equal(result.badCustom.behavior.network.custom, 0);
  assert.ok(!result.badCustom.trace.compiled.includes('https://breezer-fixture.invalid/custom.txt'));
  for (const [key, entry] of Object.entries(index.entries)) {
    if (!entry.trustedSource) continue;
    assert.ok(!result.changedBuiltinTrust.trace.hits.includes(key), `Changed trust accepted a packaged payload: ${key}`);
    assert.ok(result.changedBuiltinTrust.trace.compiled.includes(key), `Changed trust did not compile normally: ${key}`);
  }
  assert.equal(result.concurrentRawUpdate.realPayloadReadPaused, true);
  assert.equal(result.concurrentRawUpdate.updatedCacheReadyBeforeRelease, true);
  assert.ok(result.concurrentRawUpdate.returnedLatest.every(Boolean), 'An in-flight packaged lookup returned stale data after the raw list changed');
  assert.equal(result.concurrentRawUpdate.cacheContainsLatest, true, 'An older packaged result overwrote the updated compiled cache');
  return { status: 'passed', scope: 'Functional engine decisions in the same signed native candidate, packaged reader enabled versus forced to miss. Disposable offline profile; no real requests, script injection or GUI/UX claim. PGO compilation may be active; no timing comparison.',
    browserVersion, buildId: index.buildId, decisionCountPerMode: result.bundled.decisions.length, ...result };
});
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, decisionCountPerMode: report.decisionCountPerMode,
  bundledHits: report.bundled.trace.hits.length, cases: Object.keys(report).filter(key => report[key]?.trace) }, null, 2));
