import test from 'node:test';import assert from 'node:assert/strict';
import {ShortcutPreferences,HIDDEN_SITES_KEY}from'../../features/ai/extension/top-sites.js';
function fixture(){const data={};return{data,api:{storage:{local:{async get(key){return{[key]:structuredClone(data[key])}},async set(value){Object.assign(data,structuredClone(value))}}}}};}
test('removal persists only a URL hash and Undo/reset restore it without changing history',async()=>{
 const f=fixture(),prefs=await new ShortcutPreferences(f.api).load();const sites=[{title:'Canvas',url:'https://example.test/private?token=dummy'},{title:'Other',url:'https://other.test/'}];
 const undo=await prefs.hide(sites[0].url);assert.equal(f.data[HIDDEN_SITES_KEY].length,1);assert.match(undo,/^[a-f0-9]{64}$/);assert.ok(!JSON.stringify(f.data).includes('example.test'));
 const reloaded=await new ShortcutPreferences(f.api).load();assert.deepEqual(await reloaded.filter(sites),[sites[1]]);await reloaded.restore(undo);assert.deepEqual(await reloaded.filter(sites),sites);
 await reloaded.hide(sites[0].url);await reloaded.reset();assert.deepEqual(await reloaded.filter(sites),sites);
});
test('queued removals merge, malformed storage is ignored, and unsafe URLs are rejected',async()=>{
 const f=fixture();f.data[HIDDEN_SITES_KEY]=['bad'];const prefs=await new ShortcutPreferences(f.api).load();await Promise.all([prefs.hide('https://one.test'),prefs.hide('https://two.test')]);assert.equal(f.data[HIDDEN_SITES_KEY].length,2);
 await assert.rejects(prefs.hide('javascript:alert(1)'),/Unsupported/);assert.deepEqual(await prefs.filter([{url:'javascript:alert(1)'}]),[]);
});
