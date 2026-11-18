// Loaded only in a temporary host directory. Actual main is unchanged.
import { Organato as Actual } from './actual-organato.mjs';
let instance, sequence=0;
let state={key:'org_'+'a'.repeat(43), mode:'ok', empty:false, version:1};
const gates=new Map();
const nativeTimeout=AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout=ms=>nativeTimeout(state.mode==='deadline'?5:ms);
globalThis.fetch=()=>{throw Error('FORBIDDEN real fetch')};
process.on('message',async m=>{
 try {
  let result;
  if(m.op==='state') {Object.assign(state,m.value); if(m.value.config) await instance.configure(m.value.config);}
  else if(m.op==='release') {gates.get(m.n)?.();gates.delete(m.n);}
  else if(m.op==='tool') result=await instance.tool('organato_list_items',{});
  else throw Error('unknown control');
  process.send({ack:m.id,result});
 }catch(e){process.send({ack:m.id,error:e.message})}
});
export class Organato extends Actual {
 constructor(){
  super({configDirectory:process.env.REVIEW_CONFIG,secrets:{get:async()=>state.key,set:async k=>{state.key=k},remove:async()=>{state.key=null}},fetcher:async(url,options)=>{
   const snapshot={...state}, n=++sequence;
   process.send({fetch:n,auth:options.headers.Authorization,url});
   if(snapshot.defer) await new Promise(resolve=>gates.set(n,resolve));
   if(snapshot.mode==='network') throw new TypeError('fetch failed',{cause:{code:'ECONNRESET'}});
   if(snapshot.mode==='deadline') return new Promise((resolve,reject)=>{options.signal.addEventListener('abort',()=>reject(options.signal.reason),{once:true});});
   if(snapshot.mode==='body') return new Response(new ReadableStream({start(c){c.error(new TypeError('terminated',{cause:{code:'UND_ERR_SOCKET'}}))}}));
   if(snapshot.mode==='invalid') return new Response('{');
   if(Number.isInteger(snapshot.status)) return new Response('{}',{status:snapshot.status});
   return new Response(JSON.stringify({items:snapshot.empty?[]:[{id:'fixture',displayName:'Fixture '+snapshot.version,version:snapshot.version,subjectId:'fake-subject',kind:'work',classification:'checkpoint',dueDateLocal:'2026-11-10'}],nextCursor:snapshot.pages&&!url.includes('cursor=')?'page2':null}));
  }});
  instance=this;
  process.send({ready:true});
 }
}
// Legacy capability simulation still calls the actual view method.
Organato.prototype.dashboardView=async function(){
 const view=await Actual.prototype.dashboardView.call(this);
 if(state.legacy){delete view.cacheCapability;delete view.fingerprint;}
 return view;
};
