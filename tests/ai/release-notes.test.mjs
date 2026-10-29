import test from 'node:test';
import assert from 'node:assert/strict';
import { installReleaseNotes, RELEASE_SEEN_KEY } from '../../features/ai/extension/release-notes.js';
import { RELEASE_VERSION } from '../../features/ai/extension/release-info.js';
const event=()=>({listeners:[],addListener(fn){this.listeners.push(fn);},fire(){return Promise.all(this.listeners.map(fn=>fn()));}});
function fixture() {
 const data={},opened=[];let windows=[{id:1,type:'normal',incognito:false}],existing=[],fail=false;
 const api={runtime:{getURL:path=>`chrome-extension://test/${path}`,onStartup:event(),onInstalled:event()},extension:{inIncognitoContext:false},windows:{getAll:async()=>windows,onCreated:event()},tabs:{query:async()=>existing,create:async value=>{if(fail) throw Error('closed window');opened.push(value);}},storage:{local:{get:async key=>({[key]:data[key]}),set:async value=>Object.assign(data,value)}}};
 return {api,data,opened,setWindows:value=>windows=value,setExisting:value=>existing=value,setFail:value=>fail=value};
}
test('opens once per release across concurrent startup/install/window events',async()=>{
 const f=fixture(),service=installReleaseNotes(f.api);
 await Promise.all([service.check(),f.api.runtime.onStartup.fire(),f.api.runtime.onInstalled.fire(),f.api.windows.onCreated.fire()]);
 assert.equal(f.opened.length,1);assert.equal(f.data[RELEASE_SEEN_KEY],RELEASE_VERSION);
 await installReleaseNotes(f.api).check();assert.equal(f.opened.length,1);
 f.data[RELEASE_SEEN_KEY]='1.0.0';await service.check();assert.equal(f.opened.length,2);
});
test('waits for a regular window and never opens in private browsing',async()=>{
 const f=fixture();f.setWindows([{id:2,type:'normal',incognito:true}]);const service=installReleaseNotes(f.api);await service.check();assert.equal(f.opened.length,0);assert.equal(f.data[RELEASE_SEEN_KEY],undefined);
 f.setWindows([{id:3,type:'normal',incognito:false}]);await f.api.windows.onCreated.fire();assert.equal(f.opened[0].windowId,3);
 const privateProfile=fixture();privateProfile.api.extension.inIncognitoContext=true;await installReleaseNotes(privateProfile.api).check();assert.equal(privateProfile.opened.length,0);
});
test('failed tab creation remains retryable and an existing update page is reused',async()=>{
 const f=fixture();f.setFail(true);const service=installReleaseNotes(f.api);await service.check();assert.equal(f.data[RELEASE_SEEN_KEY],undefined);
 f.setFail(false);f.setExisting([{id:4,incognito:false}]);await service.check();assert.equal(f.opened.length,0);assert.equal(f.data[RELEASE_SEEN_KEY],RELEASE_VERSION);
});
