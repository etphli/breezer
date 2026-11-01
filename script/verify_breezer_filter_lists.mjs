#!/usr/bin/env node
// Run the staged production reader and compiler seam in a disposable real engine.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { createServer } from 'node:http';
import { sha256, withBuiltinBlocker } from './breezer_filter_lists.mjs';

const { values } = parseArgs({ options: { 'source-dir': { type: 'string' }, artifacts: { type: 'string' }, browser: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values['source-dir'] && values.artifacts && values.browser && values.output, 'Required: --source-dir STAGED_CHROMIUM --artifacts DIRECTORY --browser EXECUTABLE --output REPORT');
const source = resolve(values['source-dir']), artifacts = resolve(values.artifacts);
const contract = JSON.parse(await readFile(join(artifacts, 'contract.json'), 'utf8'));
const index = JSON.parse(await readFile(join(artifacts, 'index.json'), 'utf8'));
const folder = join(source, 'third_party/ublock');
const core = (await readFile(join(folder, 'js/breezer-compiled-filter-lists.js'), 'utf8')).replace('export function createBundledFilterReader', 'function createBundledFilterReader');
const context = (await readFile(join(folder, 'js/breezer-compiled-filter-context.js'), 'utf8')).replace(/^import .*\n/gm, '').replace('export const bundledFilterLists', 'const bundledFilterLists');
const storage = await readFile(join(folder, 'js/storage.js'), 'utf8');
const stagedFunction = storage.match(/µb\.getCompiledFilterList = (async function\(assetKey\) \{[\s\S]*?\n\});/)?.[1];
assert.ok(stagedFunction, 'Staged compiler seam is missing');
const prefix = 'chrome-extension://blockjmkbacgjkknlgpkjjiijinjdanf/assets/breezer-compiled/';
const resources = new Map([['index.json', Buffer.from(JSON.stringify(index))]]);
for (const entry of Object.values(index.entries)) {
  const bytes = await readFile(join(artifacts, entry.path));assert.equal(sha256(bytes), entry.payloadSha256);resources.set(entry.path, bytes);
}
let corrupt = false;
const server = createServer((request, response) => {
  const path = request.url.slice(1);
  let body = resources.get(path);
  if (body && corrupt && path !== 'index.json') { body = Buffer.from(body);body[body.length - 1] ^= 1; }
  response.writeHead(body ? 200 : 404, { 'Content-Type': 'application/octet-stream', 'Content-Length': body?.length || 0, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  response.end(body);
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}/`;
let report;
try {
report = await withBuiltinBlocker({ browser: resolve(values.browser), ...contract }, async ({ cdp, session, browserVersion }) => {
  assert.equal(browserVersion.product, contract.engineVersion);assert.equal(browserVersion.jsVersion, contract.engineJavaScriptVersion);
  const actual = await cdp.evaluate(session, `(async()=>{const out={};for(const name of ${JSON.stringify(Object.keys(contract.sourceHashes))}){const r=await fetch(chrome.runtime.getURL(name));if(!r.ok)throw new Error('Missing source '+name);out[name]=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await r.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');}return out})()`);
  assert.deepEqual(actual, contract.sourceHashes, 'Actual compiler differs from generation');
  cdp.socket.addEventListener('message', event => {
    const message = JSON.parse(String(event.data));
    if (message.sessionId !== session || message.method !== 'Fetch.requestPaused') return;
    const { requestId, request } = message.params;
    const allowed = request.url.startsWith(base);
    void cdp.send(allowed ? 'Fetch.continueRequest' : 'Fetch.failRequest', { requestId, ...(allowed ? {} : { errorReason: 'BlockedByClient' }) }, session).catch(() => {});
  });
  await cdp.send('Network.setBlockedURLs', { urls: [] }, session);
  await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'http://*' }, { urlPattern: 'https://*' }] }, session);
  await cdp.evaluate(session, `(async()=>{
    const [{default:µb},{default:io},{default:staticNetFilteringEngine},{getTrustedTokens}]=await Promise.all(['background.js','assets.js','static-net-filtering.js','trusted-tokens.js'].map(name=>import(chrome.runtime.getURL('js/'+name))));
    io.updateStop();
    const fetch=(url,...rest)=>globalThis.fetch(typeof url==='string'&&url.startsWith(${JSON.stringify(prefix)})?${JSON.stringify(base)}+url.slice(${prefix.length}):url,...rest);
    const buildId=${JSON.stringify(index.buildId)},engineVersion=${JSON.stringify(contract.engineVersion)},engineJavaScriptVersion=${JSON.stringify(contract.engineJavaScriptVersion)};
    ${core}
    ${context}
    globalThis.breezerFilterVerification={ub:µb,io,reader:bundledFilterLists,normal:µb.getCompiledFilterList,staged:${stagedFunction},raws:{}};
    const p=breezerFilterVerification,registry=await fetch(chrome.runtime.getURL('assets/assets.json')).then(r=>r.json());
    for(const key of ${JSON.stringify(Object.keys(index.entries))})for(const url of [registry[key].contentURL].flat().filter(url=>url.startsWith('assets/'))){const details=await io.fetchFilterList(url);if(details.content){p.raws[key]=details.content;break;}}
  })()`);
  const byteChecks = await cdp.evaluate(session, `(async()=>{const p=breezerFilterVerification,out=[];for(const [assetKey,rawText]of Object.entries(p.raws)){const expected=p.ub.compileFilters(rawText,{assetKey,trustedSource:p.ub.isTrustedList(assetKey)}),hit=await p.reader.read({assetKey,rawText,trustedSource:p.ub.isTrustedList(assetKey)},result=>result);if(hit.kind!=='hit'||hit.content!==expected)throw new Error('Reader differs '+assetKey);out.push({assetKey,byteExact:true});}return out})()`);
  assert.equal(byteChecks.length, Object.keys(index.entries).length);
  const seamChecks = await cdp.evaluate(session, `(async()=>{
    const p=breezerFilterVerification,ub=p.ub,io=p.io,key='easylist',raw=p.raws[key],expected=ub.compileFilters(raw,{assetKey:key,trustedSource:ub.isTrustedList(key)}),out=[];
    const saved={get:io.get,fromCache:io.fromCache,toCache:io.toCache,compile:ub.compileFilters,metadata:ub.extractFilterListMetadata,format:ub.compiledFormatChanged,bad:ub.badLists};
    let calls,writes,selectedRaw,selectedCache;
    const reset=()=>{calls={get:0,compile:0,metadata:0};writes=[];selectedRaw=raw;selectedCache='';ub.badLists=new Map();ub.compiledFormatChanged=true;};
    io.get=async assetKey=>{calls.get++;return{assetKey,content:selectedRaw};};
    io.fromCache=async()=>selectedCache;
    io.toCache=(...args)=>{writes.push(args);};
    ub.compileFilters=function(...args){calls.compile++;return saved.compile.apply(this,args);};
    ub.extractFilterListMetadata=function(...args){calls.metadata++;return saved.metadata.apply(this,args);};
    const require=(condition,label)=>{if(!condition)throw new Error(label);out.push(label);};
    try{
      reset();let result=await p.staged.call(ub,key);require(result.content===expected&&calls.compile===0&&calls.metadata===1&&writes.length===1&&writes[0][0]==='compiled/'+key,'packaged hit retains metadata and ordinary cache write');
      reset();ub.compiledFormatChanged=false;selectedCache=expected;result=await p.staged.call(ub,key);require(result.content===expected&&calls.get===0&&calls.compile===0&&writes.length===0,'existing compiled cache still wins');
      reset();ub.badLists.set(key,true);result=await p.staged.call(ub,key);require(result.content===''&&calls.get===0&&writes.length===0,'bad list suppressed before raw retrieval');
      reset();ub.extractFilterListMetadata=()=>{ub.badLists.set(key,false);};result=await p.staged.call(ub,key);require(result.content===''&&calls.compile===0&&writes.length===0,'bad list found in metadata is suppressed');ub.extractFilterListMetadata=function(...args){calls.metadata++;return saved.metadata.apply(this,args);};
      reset();selectedRaw=raw+'\\n||breezer-test.invalid^$script';result=await p.staged.call(ub,key);require(result.content===saved.compile.call(ub,selectedRaw,{assetKey:key,trustedSource:ub.isTrustedList(key)})&&calls.compile===1&&writes.length===1,'updated or overridden raw list compiles normally');
      reset();selectedRaw='||breezer-test.invalid^$script';result=await p.staged.call(ub,'https://example.invalid/custom');require(result.content===saved.compile.call(ub,selectedRaw,{assetKey:'https://example.invalid/custom',trustedSource:false})&&calls.compile===1,'custom list compiles normally');
      reset();selectedRaw='';result=await p.staged.call(ub,key);require(result.content===''&&calls.compile===0&&writes.length===0,'empty raw list retains existing early return');
      return out;
    }finally{io.get=saved.get;io.fromCache=saved.fromCache;io.toCache=saved.toCache;ub.compileFilters=saved.compile;ub.extractFilterListMetadata=saved.metadata;ub.compiledFormatChanged=saved.format;ub.badLists=saved.bad;}
  })()`);
  corrupt = true;
  const integrity = await cdp.evaluate(session, "(async()=>{const p=breezerFilterVerification;return(await p.reader.read({assetKey:'easylist',rawText:p.raws.easylist,trustedSource:p.ub.isTrustedList('easylist')},result=>result)).kind})()");
  assert.equal(integrity, 'miss');corrupt = false;
  return { status: 'passed', browserVersion, buildId: index.buildId, sourceFilesVerified: Object.keys(actual).length,
    byteChecks, seamChecks, corruptedPayload: integrity,
    scope: 'Staged production reader and compiler seam in the actual isolated built-in engine. Own-resource fetch URLs mapped to a loopback fixture; real GRIT bytes checked separately. Not native acceptance or startup timing.' };
});
} finally { await new Promise(done => server.close(done)); }
await writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
