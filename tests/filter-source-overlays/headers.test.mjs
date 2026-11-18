import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { work, root, fixture as fixtureDirectory, manifest } from './fixtures/main-port-20261115/fixture.mjs';

const load = name => import(pathToFileURL(join(root('baseline'), name)).href);
const { default: engine } = await load('static-net-filtering.js');
const { CompiledListReader } = await load('static-filtering-io.js');
const { FilteringContext } = await load('filtering-context.js');
const { default: psl } = await load('../lib/publicsuffixlist/publicsuffixlist.js');
const read = name => fs.readFileSync(join(work, name), 'utf8');
const baseline = read('baseline/third_party/ublock/js/traffic.js');
const candidate = read('source/third_party/ublock/js/traffic.js');
const bundle = read('baseline/third_party/ublock/js/breezer-startup-body.js');
const candidateBundle = read('source/third_party/ublock/js/breezer-startup-body.js');
const bundled = src => src === bundle || src === candidateBundle;
const plain = x => x === undefined ? undefined : JSON.parse(JSON.stringify(x));
const types = ['main_frame','sub_frame','stylesheet','script','image','font','object','xmlhttprequest','ping','csp_report','media','websocket','webtransport','webbundle','other','future_resource'];
const events = ['onSendHeaders','onBeforeRedirect','onCompleted','onErrorOccurred'];
function managerOf(src) {
    if (bundled(src)) {
        const at = src.indexOf('    requestHeadersManager = {');
        return 'const ' + src.slice(at, src.indexOf('    webRequest = {', at)).trim();
    }
    const at = src.indexOf('const requestHeadersManager = {');
    return src.slice(at, src.indexOf('\n/******************************************************************************/', at));
}
function handlerOf(src) {
    const at = src.indexOf('function onHeadersReceived(details) {');
    const end = bundled(src) ? src.indexOf('function textResponseFilterer(', at) : src.indexOf('\nconst reMediaContentTypes', at);
    return src.slice(at, end);
}
const pageStoreSource = read('baseline/third_party/ublock/js/pagestore.js');
const filterMethod = pageStoreSource.slice(pageStoreSource.indexOf('    filterOnHeaders(fctxt, ...headers) {'),pageStoreSource.indexOf('    redirectBlockedRequest(fctxt) {'));
psl.parse(fs.readFileSync(join(fixtureDirectory, 'headers/public_suffix_list.dat'), 'utf8'), s => s);
const headerRecords = fs.readFileSync(join(fixtureDirectory, 'headers/header-records.txt'), 'utf8');
assert.equal(headerRecords.split('\n').filter(line => line.startsWith('[')).length, manifest.headerRecordCount);
engine.fromCompiled(new CompiledListReader(headerRecords));
engine.freeze();
function context(d) {
    return new FilteringContext().setType(d.type).setMethod(d.method ?? 'GET')
        .setURL(d.url).setDocOriginFromURL(d.documentUrl ?? 'https://publisher.example/')
        .setTabOriginFromURL(d.documentUrl ?? 'https://publisher.example/').setIPAddress(d.ip);
}
function fixture(src, {gecko = false, rootConsumer = false, dynamicAllow = false, missingStore = false, enabled = true} = {}) {
    const registrations = [];
    const effects = [];
    const webRequest = Object.fromEntries(events.map(event => [event,{addListener(fn,filters,extra) {
        registrations.push({event,fn,filters,extra});
    }}]));
    const vAPI = {net:{validTypes:new Set(types)}};
    const logger = {enabled:false};
    const µb = {userSettings:{advancedUserEnabled:false},hiddenSettings:{}};
    const store = {
        filterOnHeaders: vm.runInNewContext('({' + filterMethod + '}).filterOnHeaders', {
            staticNetFilteringEngine:engine, logger, µb,
            sessionURLFiltering:{evaluateZ:() => dynamicAllow ? 2 : 0},
            sessionFirewall:{evaluateCellZY:() => 0},
        }),
        getNetFilteringSwitch:() => enabled,
        journalAddRequest:() => effects.push('journal-block'),
    };
    let lookups = 0;
    µb.filteringContext = {fromWebrequestDetails:d => {const c=context(d); c.tabId=d.tabId; return c;}};
    µb.pageStoreFromTabId = () => missingStore ? null : store;
    µb.bindTabToPageStore = () => {effects.push('bind-root'); return store;};
    const foilLargeMediaElement = () => undefined;
    foilLargeMediaElement.TYPE_BITS = 0;
    const sandbox = {
        Array, Map, browser:{webRequest}, vAPI, isGecko:gecko,
        µb, µb7:µb, logger, logger5:logger,
        foilLargeMediaElement,
        onBeforeRootFrameRequest:() => {effects.push('strict-ip'); return undefined;},
        mimeFromHeaders:() => 'text/html', reMediaContentTypes:/^(?:audio|image|video)\//,
        bodyFilterer:{canFilter:() => false},
        httpheaderFilteringEngine:{apply:(c,h) => {
            effects.push('response-policy');
            // Witness that this unchanged path still returns modified root headers.
            if (h.some(x => x.name === 'X-Policy-Test')) {h.push({name:'X-Policy-Applied',value:'yes'}); return true;}
            return false;
        }},
        injectCSP:() => {effects.push('csp'); return false;},
        injectPP:() => {effects.push('permissions'); return false;},
    };
    sandbox.httpheader_filtering_default = sandbox.httpheaderFilteringEngine;
    let handler = handlerOf(src);
    if (rootConsumer) handler = handler.replace('if ( isRootDoc === false ) {\n        const result', 'if ( true ) {\n        const result');
    const runtime = vm.runInNewContext(managerOf(src) + '\n' + handler + '\n({manager:requestHeadersManager,handler:onHeadersReceived})', sandbox);
    const originalLookup = runtime.manager.lookup.bind(runtime.manager);
    runtime.manager.lookup = d => {lookups++; return originalLookup(d);};
    runtime.manager.start();
    function emit(event, details) {
        for (const r of registrations.filter(r => r.event === event)) {
            const matchesURL = /^https?:\/\//.test(details.url);
            if (matchesURL && (!r.filters.types || r.filters.types.includes(details.type))) r.fn(details);
        }
    }
    return {registrations,effects,manager:runtime.manager,emit,
        response:d => plain(runtime.handler(d)), get lookups() {return lookups;}};
}
const longURL = 'https://abcdefghij.com/foo/' + 'a'.repeat(120);
const requestHeader = {name:'X-Request-ID',value:'a'.repeat(32)};
const details = (type='script', requestId='id', extra={}) => ({type,requestId,url:longURL,tabId:3,frameId:type==='main_frame'?0:2,parentFrameId:0,requestHeaders:[requestHeader],responseHeaders:[],...extra});
let passed = 0;
function check(name, fn) {fn(); passed++; console.log('PASS ' + name);}
function exclusion(src) {
    const h = fixture(src);
    assert.equal(h.registrations.length,4);
    for (const r of h.registrations) {
        assert.deepEqual(Array.from(r.filters.types ?? []),types.filter(x => x !== 'main_frame'),r.event+' must exclude only main_frame');
        assert.deepEqual(Array.from(r.filters.urls),['http://*/*','https://*/*']);
    }
    assert.deepEqual(Array.from(h.registrations[0].extra),['requestHeaders','extraHeaders']);
    for (const r of h.registrations.slice(1)) assert.equal(r.extra,undefined);
    assert.deepEqual(Array.from(fixture(src,{gecko:true}).registrations[0].extra),['requestHeaders']);
}
if (process.argv.includes('--baseline-exclusion')) {
    exclusion(baseline); // Intentionally fails on the package-bound baseline.
    throw new Error('baseline unexpectedly passed');
}
check('only seven-line listener-filter edit; filtering and suspension code identical', () => {
    assert.equal(baseline.replace(managerOf(baseline),''), candidate.replace(managerOf(candidate),''));
    assert.equal(managerOf(candidate).split('\n').length-managerOf(baseline).split('\n').length,7);
    assert.match(read('baseline/third_party/ublock/js/background.js'), /fromWebrequestDetails\(details\) \{[\s\S]*?this.type = details.type;/);
    assert.match(read('baseline/third_party/ublock/js/vapi-background.js'), /this.validTypes.add\(wrrt\[typeKey\]\)/);
    assert.match(read('baseline/third_party/ublock/js/vapi-background-ext.js'), /if \( type !== 'other' \) \{ return; \}/);
    assert.equal(baseline.match(/requestHeadersManager.lookup\(/g).length,1);
    assert.equal(bundle.match(/requestHeadersManager.lookup\(/g).length,1);
    assert.match(handlerOf(baseline), /if \( isRootDoc === false \) \{\s*const result = pageStore.filterOnHeaders/);
    assert.match(handlerOf(bundle), /if \(isRootDoc === false\) \{\s*const result = pageStore.filterOnHeaders/);
});
check('packaged Net constructor derives the complete runtime type set before capture starts', () => {
    const src=read('baseline/third_party/ublock/js/vapi-background.js'),at=src.indexOf('vAPI.Net = class {');
    const end=src.indexOf('\n/******************************************************************************/',at);
    const resourceTypes=Object.create({INHERITED:'invalid_inherited_type'});
    for (const type of types) resourceTypes[type.toUpperCase()]=type;
    const vAPI={setDefaultIcon:()=>{}};
    vm.runInNewContext(src.slice(at,end),{vAPI,browser:{webRequest:{ResourceType:resourceTypes,onBeforeRequest:{addListener:()=>{}}}}});
    const net=new vAPI.Net();
    assert.deepEqual(Array.from(net.validTypes),types);
    assert.ok(baseline.indexOf('vAPI.net = new vAPI.Net()') < baseline.indexOf('requestHeadersManager.start()'));
});
check('all four listeners exclude only main_frame, including future runtime types', () => exclusion(candidate));
check('main-frame capture eliminated while bundled and module baselines capture', () => {
    for (const src of [baseline,bundle,candidate]) {
        const h=fixture(src); const d=details('main_frame'); h.emit('onSendHeaders',d);
        assert.equal(h.manager.requests.has(d.requestId),src!==candidate);
        assert.equal(h.response(d),undefined); assert.equal(h.lookups,0);
        assert.deepEqual(h.effects,['response-policy','csp','permissions']);
        h.emit('onCompleted',d); assert.equal(h.manager.requests.size,0);
    }
});
check('all remaining types retain capture, root/subframe distinction and final cleanup', () => {
    for (const type of types.filter(t=>t!=='main_frame')) for (const src of [baseline,bundle,candidate]) {
        const h=fixture(src); const d=details(type); h.emit('onSendHeaders',d);
        assert.equal(h.manager.requests.get(d.requestId),d.requestHeaders,type);
        h.response(d); assert.equal(h.lookups,1,type);
        h.emit('onCompleted',d); assert.equal(h.manager.requests.size,0,type);
    }
});
function lifecycle(src, terminal='onCompleted') {
    const h=fixture(src); const d=details();
    h.emit('onSendHeaders',d); assert.deepEqual(plain(h.manager.lookup(d)),[requestHeader]);
    // Redirect response consumes the old hop before onBeforeRedirect removes it.
    assert.deepEqual(h.response(d),{cancel:true});
    h.emit('onBeforeRedirect',d); assert.equal(h.manager.requests.size,0);
    const hop2=details('script','id',{url:longURL+'?second',requestHeaders:[]});
    h.emit('onSendHeaders',hop2); assert.deepEqual(plain(h.manager.lookup(hop2)),[]);
    assert.equal(h.response(hop2),undefined);
    h.emit('onBeforeRedirect',hop2); assert.equal(h.manager.requests.size,0);
    const hop3=details('script','id'); h.emit('onSendHeaders',hop3);
    assert.deepEqual(h.response(hop3),{cancel:true}); h.emit(terminal,hop3);
    assert.equal(h.manager.requests.size,0);
    // Reusing a terminated request id, including a later root navigation, is safe.
    const root=details('main_frame','id'); h.emit('onSendHeaders',root); h.response(root);
    h.emit('onCompleted',root); assert.equal(h.manager.requests.size,0);
    const reused=details('sub_frame','id',{url:'https://safe.example/',requestHeaders:[]});
    h.emit('onSendHeaders',reused); assert.deepEqual(plain(h.manager.lookup(reused)),[]);
    assert.equal(h.response(reused),undefined); h.emit('onCompleted',reused);
    assert.equal(h.manager.requests.size,0);
}
check('multi-hop redirects, cancellation/error/completion and request-id reuse', () => {
    for (const src of [baseline,bundle,candidate]) for (const event of ['onCompleted','onErrorOccurred']) lifecycle(src,event);
});
check('main-frame redirect chains never read captured headers and always finish empty', () => {
    for (const src of [baseline,bundle,candidate]) for (const terminal of ['onCompleted','onErrorOccurred']) {
        const h=fixture(src);
        for (let hop=0;hop<3;hop++) {
            const d=details('main_frame','root-chain',{url:'https://safe.example/hop'+hop});
            h.emit('onSendHeaders',d); assert.equal(h.manager.requests.size,src===candidate?0:1);
            assert.equal(h.response(d),undefined); assert.equal(h.lookups,0);
            h.emit(hop===2?terminal:'onBeforeRedirect',d); assert.equal(h.manager.requests.size,0);
        }
    }
});
check('repeated sends replace the same id with the latest headers', () => {
    for (const src of [baseline,bundle,candidate]) {
        const h=fixture(src),d=details(); h.emit('onSendHeaders',d);
        const resend={...d,requestHeaders:[]}; h.emit('onSendHeaders',resend);
        assert.equal(h.manager.requests.size,1); assert.equal(h.response(resend),undefined);
        h.emit('onErrorOccurred',resend); assert.equal(h.manager.requests.size,0);
    }
});
check('pre-send cancellation and duplicate cleanup do not leave entries', () => {
    for (const src of [baseline,bundle,candidate]) for (const type of ['main_frame','sub_frame','script']) {
        const h=fixture(src),d=details(type); h.emit('onErrorOccurred',d);
        h.emit('onBeforeRedirect',d); h.emit('onCompleted',d);
        assert.equal(h.manager.requests.size,0); assert.deepEqual(plain(h.manager.lookup(d)),[]);
    }
});
function compareCase(d,opts={}) {
    const results=[baseline,bundle,candidate,candidateBundle].map(src=>{
        const h=fixture(src,opts); const copy=structuredClone(d); h.emit('onSendHeaders',copy);
        const result=h.response(copy); h.emit('onErrorOccurred',copy); assert.equal(h.manager.requests.size,0);
        return {result,effects:h.effects,responseHeaders:copy.responseHeaders};
    });
    assert.deepEqual(results[1],results[0]); assert.deepEqual(results[2],results[0]); assert.deepEqual(results[3],results[0]); return results[0];
}
check('actual shipped responseheader rule still blocks request-only match', () => {
    assert.deepEqual(compareCase(details()).result,{cancel:true});
    assert.equal(compareCase(details('script','id',{requestHeaders:[]})).result,undefined);
    assert.equal(compareCase(details('script','id',{requestHeaders:[{name:'X-Request-ID',value:'bad'}]})).result,undefined);
    assert.equal(compareCase(details('script','id',{method:'POST'})).result,undefined);
    assert.deepEqual(compareCase(details('xmlhttprequest')).result,{cancel:true});
});
check('response-first merge, case-insensitive names, absent headers and dynamic allow', () => {
    assert.equal(compareCase(details('script','id',{responseHeaders:[{name:'x-request-id',value:'not-a-match'}]})).result,undefined);
    assert.deepEqual(compareCase(details('script','id',{requestHeaders:[],responseHeaders:[requestHeader]})).result,{cancel:true});
    assert.equal(compareCase(details(),{dynamicAllow:true}).result,undefined);
    assert.equal(compareCase(details(),{enabled:false}).result,undefined);
    assert.equal(compareCase(details(),{missingStore:true}).result,undefined);
    assert.equal(compareCase(details('script','id',{responseHeaders:undefined})).result,undefined);
});
check('bundled requestheader unit still blocks with Cookie from either merged array', () => {
    const cookie={name:'Cookie',value:'id=*doubleclick.net*'};
    const d=details('script','cookie',{url:'https://abc.workers.dev/index.js',requestHeaders:[cookie]});
    assert.deepEqual(compareCase(d).result,{cancel:true});
    assert.equal(compareCase({...d,requestHeaders:[]}).result,undefined);
    assert.deepEqual(compareCase({...d,requestHeaders:[],responseHeaders:[cookie]}).result,{cancel:true});
});
check('root and subframe response policy, strict IP path, binding, and frame ids unchanged', () => {
    for (const type of ['main_frame','sub_frame']) {
        const d=details(type,'doc',{url:'https://safe.example/',requestHeaders:[requestHeader],responseHeaders:[{name:'X-Policy-Test',value:'yes'}]});
        const result=compareCase(d,{missingStore:type==='main_frame'});
        assert.equal(result.result.responseHeaders.at(-1).name,'X-Policy-Applied');
        assert.equal(result.effects.includes('bind-root'),type==='main_frame');
        assert.ok(result.effects.includes('csp')); assert.ok(result.effects.includes('permissions'));
    }
    const ipCase=compareCase(details('main_frame','ip',{ip:'127.0.0.1',url:'https://safe.example/'}));
    assert.ok(ipCase.effects.includes('strict-ip'));
    // Main/sub-frame semantics use request type rather than an incidental frameId.
    assert.deepEqual(compareCase(details('script','id',{frameId:0})).result,{cancel:true});
    assert.equal(compareCase(details('main_frame','id',{frameId:8})).result,undefined);
});
check('interleaved unrelated requests and URL scope retain per-id headers', () => {
    for (const src of [baseline,bundle,candidate]) {
        const h=fixture(src),a=details('script','a'),b=details('sub_frame','b',{url:'https://safe.example/',requestHeaders:[]});
        h.emit('onSendHeaders',a);h.emit('onSendHeaders',b);h.emit('onErrorOccurred',b);
        assert.equal(h.manager.requests.size,1);assert.deepEqual(h.response(a),{cancel:true});h.emit('onCompleted',a);
        const nonHTTP=details('script','c',{url:'file:///tmp/offline.js'});h.emit('onSendHeaders',nonHTTP);
        assert.equal(h.manager.requests.size,0);
    }
});
const controls=[];
function rejects(name, fn) {
    assert.throws(fn, assert.AssertionError, name+' must fail'); controls.push(name);
}
check('negative controls reject unsafe narrowing and broken lifecycle', () => {
    rejects('baseline retains main_frame',()=>exclusion(baseline));
    rejects('drops subframe and future types',()=>exclusion(candidate.replace("type !== 'main_frame'","type === 'script'")));
    rejects('drops every type',()=>{
        const h=fixture(candidate.replace("type !== 'main_frame'","false")),d=details();h.emit('onSendHeaders',d);assert.deepEqual(h.response(d),{cancel:true});
    });
    rejects('missing redirect cleanup',()=>lifecycle(candidate.replace('this.requests.delete(details.requestId);','void details.requestId;')));
    rejects('missing completion cleanup',()=>lifecycle(candidate.replace(/(onCompleted.addListener\(details => \{)\s*this.requests.delete\(details.requestId\);/,'$1 void details.requestId;')));
    rejects('missing error cleanup',()=>lifecycle(candidate.replace(/(onErrorOccurred.addListener\(details => \{)\s*this.requests.delete\(details.requestId\);/,'$1 void details.requestId;'),'onErrorOccurred'));
    rejects('future main-frame consumer invalidates exclusion',()=>{
        const main=details('main_frame');const a=fixture(baseline,{rootConsumer:true}),b=fixture(candidate,{rootConsumer:true});
        // A new root lookup must invalidate the exclusion, regardless of current rule types.
        a.manager.lookup = d => {assert.ok(a.manager.requests.has(d.requestId));return [];};
        b.manager.lookup = d => {assert.ok(b.manager.requests.has(d.requestId));return [];};
        a.emit('onSendHeaders',main);b.emit('onSendHeaders',main);a.response(main);b.response(main);
    });
    rejects('request headers omitted from matcher',()=>{
        const h=fixture(candidate.replace('requestHeadersManager.lookup(details)','[]'));const d=details();h.emit('onSendHeaders',d);assert.deepEqual(h.response(d),{cancel:true});
    });
    rejects('merge precedence reversed',()=>{
        const c=context(details());assert.equal(engine.matchHeaders(c,[requestHeader],[{name:'x-request-id',value:'bad'}]),0);
    });
});
check('integrated startup body preserves capture lifecycle and handler outcomes', () => {
    exclusion(candidateBundle);
    lifecycle(candidateBundle); lifecycle(candidateBundle,'onErrorOccurred');
    const h=fixture(candidateBundle),d=details('main_frame');
    h.emit('onSendHeaders',d); assert.equal(h.manager.requests.size,0);
    assert.equal(h.response(d),undefined); assert.equal(h.lookups,0);
    for (const type of types.filter(t=>t!=='main_frame')) {
        const request=details(type,type);h.emit('onSendHeaders',request);
        assert.equal(h.manager.requests.get(type),request.requestHeaders);
        h.response(request);h.emit('onCompleted',request);assert.equal(h.manager.requests.size,0);
    }
});
engine.reset();
console.log(JSON.stringify({status:'pass',checks:passed,negativeControls:controls,fixtureCompilerModules:manifest.baselineCompilerSourceCount,headerRealmRows:manifest.headerRecordCount,scope:'bounded offline differential test using selected header/IP records, no full-list compilation, runtime or performance claim'}));
