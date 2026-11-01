#!/usr/bin/env node
// Deterministic saved-session and sidebar-model CPU benchmark. No browsers are opened.
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
if (!process.argv[2]) { console.error('Usage: node script/benchmark_workspace.mjs /path/to/workspace-store.js'); process.exit(2); }
const module = await import(pathToFileURL(resolve(process.argv[2])).href);
const { normalizeStore, normalizeMembers, reconcileWindowTabs, buildSidebarModel } = module;
const median = values => values.sort((a,b)=>a-b)[Math.floor(values.length/2)];
const results=[];
for (const size of [10,100,500,1000]) {
 const tabs = Array.from({length:size}, (_,i)=>({id:i+1,index:i,pinned:true,active:i===0,url:`https://example.com/docs/${i}?v=2`,title:`Document ${i}`}));
 const store = normalizeStore({version:1,spaces:[{id:'s',name:'Work',tone:'mint',pinned:tabs.map((t,i)=>({kind:'entry',id:`e${i}`,url:t.url,title:t.title}))}]});
 const raw = {version:1,session:'new',prev:'old',tabs:Object.fromEntries(tabs.map((t,i)=>[i+10000,{s:'s',e:`e${i}`,u:t.url,k:'old'}]))};
 const timings = [], draws=[];
 let assigned;
 for(let rep=0;rep<11;rep++) {
  const members=normalizeMembers(structuredClone(raw));
  const start=performance.now();
  assigned=reconcileWindowTabs({store,members,tabs,session:'new',fallbackSpaceId:'s'}).assigned;
  timings.push(performance.now()-start);
  const draw=performance.now();
  for(let j=0;j<20;j++) buildSidebarModel({store,records:assigned,tabs,activeSpaceId:'s'});
  draws.push((performance.now()-draw)/20);
 }
 results.push({tabs:size,restoreMs:median(timings),modelMs:median(draws),assigned:Object.keys(assigned).length});
}
console.log(JSON.stringify({module:process.argv[2],results},null,2));
