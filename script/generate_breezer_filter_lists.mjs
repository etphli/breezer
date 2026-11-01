#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { canonical, compilerContract, sha256, withBuiltinBlocker } from './breezer_filter_lists.mjs';

const { values } = parseArgs({ options: { 'source-dir': { type: 'string' }, browser: { type: 'string' }, output: { type: 'string' } } });
assert.ok(values['source-dir'] && values.browser && values.output, 'Required: --source-dir PREPARED_CHROMIUM --browser EXECUTABLE --output NEW_DIRECTORY');
const source = resolve(values['source-dir']), output = resolve(values.output), contract = await compilerContract(source);
await mkdir(output); // Refuse to overwrite an earlier artifact or failure record.
try {
  const generated = await withBuiltinBlocker({ browser: resolve(values.browser), ...contract }, async ({ cdp, session, browserVersion }) => {
    assert.equal(browserVersion.product, contract.engineVersion, 'Compiler browser version differs from source');
    assert.equal(browserVersion.jsVersion, contract.engineJavaScriptVersion, 'Compiler V8 version differs from source');
    const actualHashes = await cdp.evaluate(session, `(async()=>{const out={};for(const name of ${JSON.stringify(Object.keys(contract.sourceHashes))}){const response=await fetch(chrome.runtime.getURL(name));if(!response.ok)throw new Error('Missing source '+name);out[name]=[...new Uint8Array(await crypto.subtle.digest('SHA-256',await response.arrayBuffer()))].map(v=>v.toString(16).padStart(2,'0')).join('');}return out})()`);
    assert.deepEqual(actualHashes, contract.sourceHashes, 'Packaged compiler/runtime source differs from prepared source');
    return cdp.evaluate(session, `(async()=>{
      const [{default:ub},{default:io},{default:net},{getTrustedTokens}]=await Promise.all(['background.js','assets.js','static-net-filtering.js','trusted-tokens.js'].map(name=>import(chrome.runtime.getURL('js/'+name))));
      io.updateStop();
      const digest=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');
      const registry=await fetch(chrome.runtime.getURL('assets/assets.json')).then(r=>r.json());
      const context={compiledMagic:ub.systemSettings.compiledMagic,environment:[...vAPI.webextFlavor.env].sort(),maxTokenLength:net.MAX_TOKEN_LENGTH,canFilterResponseBody:ub.canFilterResponseData,trustedTokensSha256:await digest(JSON.stringify([...getTrustedTokens()].sort()))};
      if(!context.environment.includes('chromium'))throw new Error('Missing shipping Chromium environment');
      const lists=[];
      for(const assetKey of [...ub.selectedFilterLists].sort()){
        if(registry[assetKey]?.content!=='filters')continue;
        const urls=[registry[assetKey].contentURL].flat().filter(url=>typeof url==='string'&&url.startsWith('assets/'));
        let raw;for(const url of urls){raw=await io.fetchFilterList(url);if(raw.content)break;}
        if(!raw?.content)continue;
        const trustedSource=ub.isTrustedList(assetKey),content=ub.compileFilters(raw.content,{assetKey,trustedSource});
        if(content!==ub.compileFilters(raw.content,{assetKey,trustedSource}))throw new Error('Nondeterministic compilation '+assetKey);
        lists.push({assetKey,rawSha256:await digest(raw.content),rawBytes:new TextEncoder().encode(raw.content).length,trustedSource,content});
      }
      return {context,lists};
    })()`);
  });
  assert.ok(generated.lists.length > 0 && generated.lists.length <= 64, 'No eligible bundled lists or too many lists');
  const buildId = sha256(canonical(contract));
  const index = { schema: 1, buildId, context: { ...generated.context, engineVersion: contract.engineVersion, engineJavaScriptVersion: contract.engineJavaScriptVersion }, entries: {} };
  let payloadBytes = 0;
  for (const { assetKey, content, ...entry } of generated.lists) {
    assert.match(assetKey, /^[a-z0-9][a-z0-9-]{0,79}$/);
    assert.ok(!assetKey.startsWith('user-') && entry.rawBytes <= 8 * 1024 * 1024);
    const payload = Buffer.from(content), payloadSha256 = sha256(payload), path = `${payloadSha256}.txt`;
    assert.ok(payload.length > 0 && payload.length <= 16 * 1024 * 1024);
    assert.ok(content.startsWith(`${index.context.compiledMagic}\n`));
    index.entries[assetKey] = { ...entry, path, payloadBytes: payload.length, payloadSha256 };
    payloadBytes += payload.length;await writeFile(join(output, path), payload);
  }
  assert.ok(Buffer.byteLength(canonical(index)) <= 64 * 1024);
  await writeFile(join(output, 'contract.json'), canonical(contract) + '\n');
  await writeFile(join(output, 'index.json'), canonical(index) + '\n');
  console.log(JSON.stringify({ output, buildId, lists: Object.keys(index.entries), payloadBytes }, null, 2));
} catch (error) {
  await writeFile(join(output, 'failure.txt'), String(error.stack));throw error;
}
