import test from 'node:test';
import assert from 'node:assert/strict';
import { installReleaseNotes, RELEASE_SEEN_KEY } from '../../features/ai/extension/release-notes.js';
import { RELEASE_PAGE_VERSION } from '../../features/ai/extension/release-info.js';
import { SETUP_KEY } from '../../features/ai/extension/setup-state.js';
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},fire(){return Promise.all(this.listeners.map(fn=>fn()));}});
const NOTES='chrome-extension://test/whats-new.html', SETUP='chrome-extension://test/workspace.html#/welcome';
function fixture(saved={}) {
 const data=structuredClone(saved),opened=[];let windows=[{id:1,type:'normal',incognito:false}],existing=[],fail=false;
 const get=async keys=>Object.fromEntries([keys].flat().filter(key=>key in data).map(key=>[key,data[key]]));
 const api={runtime:{getURL:path=>`chrome-extension://test/${path}`,onStartup:event(),onInstalled:event()},extension:{inIncognitoContext:false},windows:{getAll:async()=>windows,onCreated:event()},tabs:{query:async()=>existing,create:async value=>{if(fail) throw Error('closed window');opened.push(value);}},storage:{local:{get,set:async value=>Object.assign(data,value)}}};
 return {api,data,opened,setWindows:value=>windows=value,setExisting:value=>existing=value,setFail:value=>fail=value};
}
const returning={[RELEASE_SEEN_KEY]:'1.0.0'};

test('a brand-new profile opens the setup guide, not the release notes, and only once',async()=>{
 const f=fixture(),service=installReleaseNotes(f.api);
 await Promise.all([service.check(),f.api.runtime.onStartup.fire(),f.api.runtime.onInstalled.fire(),f.api.windows.onCreated.fire()]);
 assert.deepEqual(f.opened.map(tab=>tab.url),[SETUP]);
 assert.equal(f.data[RELEASE_SEEN_KEY],RELEASE_PAGE_VERSION);
 assert.deepEqual(f.data[SETUP_KEY],{step:'welcome',completed:false});
 await installReleaseNotes(f.api).check();assert.equal(f.opened.length,1);
});
test('profiles used before setup existed get release notes instead of setup',async()=>{
 for (const saved of [returning,{'settings.onboarding.v1':{dismissed:true}},{breezerProfile:{name:'Sam',context:''}}]) {
  const f=fixture(saved);await installReleaseNotes(f.api).check();
  assert.deepEqual(f.opened.map(tab=>tab.url),[NOTES]);
 }
});
test('opens release notes once per release across concurrent startup/install/window events',async()=>{
 const f=fixture(returning),service=installReleaseNotes(f.api);
 await Promise.all([service.check(),f.api.runtime.onStartup.fire(),f.api.runtime.onInstalled.fire(),f.api.windows.onCreated.fire()]);
 assert.equal(f.opened.length,1);assert.equal(f.opened[0].url,NOTES);assert.equal(f.data[RELEASE_SEEN_KEY],RELEASE_PAGE_VERSION);
 await installReleaseNotes(f.api).check();assert.equal(f.opened.length,1);
 f.data[RELEASE_SEEN_KEY]='1.0.0';await service.check();assert.equal(f.opened.length,2);
});
test('waits for a regular window and never opens in private browsing',async()=>{
 const f=fixture(returning);f.setWindows([{id:2,type:'normal',incognito:true}]);const service=installReleaseNotes(f.api);await service.check();assert.equal(f.opened.length,0);assert.equal(f.data[RELEASE_SEEN_KEY],'1.0.0');
 f.setWindows([{id:3,type:'normal',incognito:false}]);await f.api.windows.onCreated.fire();assert.equal(f.opened[0].windowId,3);
 const privateProfile=fixture();privateProfile.api.extension.inIncognitoContext=true;await installReleaseNotes(privateProfile.api).check();assert.equal(privateProfile.opened.length,0);
});
test('failed tab creation remains retryable and an existing page is reused',async()=>{
 const f=fixture(returning);f.setFail(true);const service=installReleaseNotes(f.api);await service.check();assert.equal(f.data[RELEASE_SEEN_KEY],'1.0.0');
 f.setFail(false);f.setExisting([{id:4,incognito:false,url:NOTES}]);await service.check();assert.equal(f.opened.length,0);assert.equal(f.data[RELEASE_SEEN_KEY],RELEASE_PAGE_VERSION);
 const fresh=fixture();fresh.setFail(true);const setup=installReleaseNotes(fresh.api);await setup.check();assert.equal(fresh.data[SETUP_KEY],undefined);
 fresh.setFail(false);fresh.setExisting([{id:5,incognito:false,url:'chrome-extension://test/workspace.html#/settings'}]);await setup.check();
 assert.deepEqual(fresh.opened.map(tab=>tab.url),[SETUP],'a Settings tab is not the setup guide');
});
test('a patch appends to the current minor page without reopening it', async () => {
  const f=fixture({[RELEASE_SEEN_KEY]:'1.1.0'});const service=installReleaseNotes(f.api);await service.check();
  f.data[RELEASE_SEEN_KEY]=RELEASE_PAGE_VERSION.replace(/0$/,'9');await service.check();assert.equal(f.opened.length,0);
});
