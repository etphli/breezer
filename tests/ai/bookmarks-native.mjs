// Native bookmark-bar regression. Uses only a disposable profile and dummy bookmark.
import assert from 'node:assert/strict';
import {chromium} from './node_modules/playwright/index.mjs';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {createServer} from 'node:net';
const app=process.argv[2];assert.ok(app?.startsWith('/')&&app.endsWith('/Breezer.app'));
const evidence=resolve(process.env.BREEZER_AI_EVIDENCE||'build/bookmarks-20261029/native');await mkdir(evidence,{recursive:true});
const profile=await mkdtemp(join(tmpdir(),'breezer-bookmark-regression-'));
const probe=createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const uiPort=probe.address().port;await new Promise(r=>probe.close(r));
let context,socket,serial=0;const pending=new Map();const report={phase:'running',app,checks:[],limits:['Read-only native UI DevTools state; physical pointer routing is not verified.']};
const pause=ms=>new Promise(r=>setTimeout(r,ms));
const rpc=(method,params={})=>new Promise((resolve,reject)=>{const id=++serial;const timer=setTimeout(()=>{pending.delete(id);reject(Error('Native UI timed out'));},5000);pending.set(id,{resolve,reject,timer});socket.send(JSON.stringify({id,method,params}));});
try{
 await mkdir(join(profile,'Default'));await writeFile(join(profile,'Default/Preferences'),JSON.stringify({bookmark_bar:{visibility_state:1,show_on_all_tabs:false}}));
 context=await chromium.launchPersistentContext(profile,{executablePath:app+'/Contents/MacOS/Breezer',headless:false,viewport:null,ignoreDefaultArgs:['--enable-automation','--disable-extensions','--disable-component-extensions-with-background-pages','--no-sandbox'],args:['--no-first-run','--no-default-browser-check',`--enable-ui-devtools=${uiPort}`]});
 const manager=await context.newPage();await manager.goto('chrome://bookmarks');await manager.waitForFunction(()=>!!chrome.bookmarks?.create);await manager.evaluate(()=>chrome.bookmarks.create({parentId:'1',title:'Fixture bookmark',url:'https://example.test/'}));
 const page=await context.newPage();await page.goto('chrome://newtab/');await page.bringToFront();await pause(500);
 socket=new WebSocket(`ws://127.0.0.1:${uiPort}/0`);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});socket.onmessage=e=>{const m=JSON.parse(e.data);const p=pending.get(m.id);if(!p)return;pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(Error(m.error.message)):p.resolve(m.result);};
 async function visible(){const {root}=await rpc('DOM.getDocument');let bar;function walk(n){if(n.attributes?.includes('BookmarkBarView'))bar=n;for(const c of n.children||[])walk(c);}walk(root);assert.ok(bar,'Native bookmark bar must exist');const style=await rpc('CSS.getMatchedStylesForNode',{nodeId:bar.nodeId});return style.matchedCSSRules.flatMap(r=>r.rule.style.cssProperties).find(p=>p.name==='Visible')?.value==='true';}
 async function expect(label,value){let actual;const until=Date.now()+3000;do{actual=await visible();if(actual===value)break;await pause(100);}while(Date.now()<until);report.checks.push({label,expected:value,actual});assert.equal(actual,value,label);}
 await expect('Default mode shows bookmarks on the Breezer new-tab page',true);
 const control=await context.newPage();await control.goto('chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/newtab.html');
 const mode=value=>control.evaluate(value=>new Promise((r,j)=>chrome.breezerPrivate.setAppearance({bookmarkBarMode:value},result=>chrome.runtime.lastError?j(Error(chrome.runtime.lastError.message)):r(result))),value);
 await page.goto('data:text/html,<title>Bookmark fixture</title>Page');await page.bringToFront();await expect('New-tabs-only hides bookmarks on ordinary pages',false);
 await page.goto('about:blank');await expect('New-tabs-only includes blank tabs',true);
 await mode('always');await page.goto('data:text/html,<title>Bookmark fixture</title>Page');await page.bringToFront();await expect('Always shows bookmarks on ordinary pages',true);
 await mode('hidden');await page.goto('chrome://newtab/');await page.bringToFront();await expect('Hidden hides bookmarks on new tabs',false);
 await mode('newTab');await expect('Returning to new-tabs-only immediately restores bookmarks',true);
 report.phase='passed';
}catch(error){report.phase='failed';report.error=error.message;process.exitCode=1;}
finally{for(const p of pending.values()){clearTimeout(p.timer);p.reject(Error('Test closed'));}socket?.close();await context?.close();await rm(profile,{recursive:true,force:true});await writeFile(join(evidence,'result.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify(report));
