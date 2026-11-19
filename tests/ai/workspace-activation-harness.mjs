import { localStorageChanges } from '../../features/ai/extension/storage-events.js';
import { PLATFORM } from '../../features/ai/extension/platform.js';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import * as store from '../../features/ai/extension/workspace-store.js';
import { seed } from './workspace-browser-fixture.mjs';

// Deterministic DOM contract, not a layout engine. All production draw/reconcile/
// row/model functions run; timers and animation frames advance explicitly.
class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.parent = null; this.dataset = {};
    this.attrs = {}; this.hidden = false; this.tabIndex = -1; this.text = '';
    this.style = { setProperty() {}, removeProperty() {} }; this.classes = new Set();
    this.classList = { contains: c => this.classes.has(c), add: c => this.classes.add(c),
      remove: c => this.classes.delete(c), toggle: (c, on = !this.classes.has(c)) => on ? this.classes.add(c) : this.classes.delete(c) };
  }
  addEventListener(name, fn) { (this.listeners ||= {})[name] ||= []; this.listeners[name].push(fn); }
  dispatch(name, event = {}) { for (const fn of this.listeners?.[name] || []) fn({target:this,currentTarget:this,preventDefault(){},stopPropagation(){},...event}); }
  focus() { this.focusCalls = (this.focusCalls || 0) + 1; }
  select() { this.selectCalls = (this.selectCalls || 0) + 1; this.selectionStart = 0; this.selectionEnd = this.value?.length || 0; }
  set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
  get textContent() { return this.text + this.children.map(n => n.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.replaceChildren(); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  get src() { return this.attrs.src; }
  set src(value) { this.attrs.src = String(value); }
  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }
  insertBefore(n, before) { n.remove(); const at = before ? this.children.indexOf(before) : this.children.length; this.children.splice(at, 0, n); n.parent = this; }
  replaceChildren(...nodes) { for (const n of [...this.children]) n.remove(); this.append(...nodes); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; }
  matches(q) {
    if (q === '.folder-children[hidden]') return this.classes.has('folder-children') && this.hidden;
    if (q.includes(',')) return q.split(',').some(part => this.matches(part.trim()));
    if (q.startsWith('#')) return this.id === q.slice(1);
    if (q === '[data-key]') return Boolean(this.dataset.key);
    if (q.startsWith('[data-key=') ) return this.dataset.key === q.slice(11, -2);
    if (q === '[role="tree"]') return this.attrs.role === 'tree';
    if (q.startsWith('.')) return this.classes.has(q.slice(1));
    if (q === '[role="treeitem"]') return this.attrs.role === 'treeitem';
    return this.tag === q;
  }
  querySelectorAll(q) {
    if (q.includes(' ')) {
      const at = q.lastIndexOf(' '), ancestor = q.slice(0, at), target = q.slice(at + 1);
      return this.querySelectorAll(target).filter(n => n.parent?.closest(ancestor));
    }
    return this.children.flatMap(n => [...(n.matches(q) ? [n] : []), ...n.querySelectorAll(q)]); }
  querySelector(q) { return this.querySelectorAll(q)[0] || null; }
  closest(q) { return this.matches(q) ? this : this.parent?.closest(q); }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  snapshot() { return { tag: this.tag, classes: [...this.classes].sort(), dataset: this.dataset, attrs: this.attrs,
    text: this.text, hidden: this.hidden, tabIndex: this.tabIndex, title: this.title, src: this.src,
    children: this.children.map(n => n.snapshot()) }; }
}
const plain = value => JSON.parse(JSON.stringify(value));
export const sourcePath = new URL('../../features/ai/extension/workspace.js', import.meta.url);
// Reuse the current complete draw as the oracle, bypassing only row batching.
export function fullDrawOracle(source) {
  const oracle = source.replace('function render(tabId) {', 'function render(tabId) { tabId = undefined;');
  if (oracle === source) throw new Error('The row scheduler source anchor changed');
  return oracle;
}

export async function harness(source, sharedStorage, options = {} = {}) {
  const {width=240,height=800,visibility='visible',reduced=true,favicon=false,boot=false} = options;
  source ??= await readFile(sourcePath, 'utf8');
  const fixture = options.fixture || seed(), nodes = new Map(), frames = new Map(), timers = new Map();
  const counters = { focusSyncs: 0, scheduled: 0, drawn: 0, models: 0, reconciles: 0, reconcileMaps: 0, rowUpdates: 0, elements: 0, queries: 0, refreshScheduled: 0, writes: [] };
  let activationHeld = false, releaseActivation, sessionFailure = false;
  let serial = 0, held = null, release, now = 1700000000000;
  class FixtureDate extends Date { static now() { return now; } }
  const node = id => { if (!nodes.has(id)) { const n = new Node(); n.id = id; nodes.set(id,n); } return nodes.get(id); };
  node('menu').hidden = true;
  node('body').append(node('sidebar'));
  node('sidebar').append(node('favorites'),node('space-pane'),node('spaces'),node('menu'));
  node('space-pane').append(node('space-name'),node('space-glyph'),node('pinned'),node('today'));
  for (const id of ['pinned','today']) node(id).setAttribute('role','tree');
  const globalEvents = {}; let getHeld=false, releaseGet, queryFailure=false, queryTransform=null, paintFailure=false, compactFailure=false;
  let peekReject=Boolean(options.rejectPeek); const peekCalls=[];
  const listeners = {};
  const event = name => ({ addListener(fn) { (listeners[name] ||= []).push(fn); }, removeListener() {} });
  const browserTabs = structuredClone(fixture.tabs);
  const persisted = options.persisted || structuredClone({ local: fixture.local, session: fixture.session });
  const submit = (area, values) => {
    const snapshot = structuredClone(values); counters.writes.push([area,plain(snapshot)]);
    const commit = () => Object.assign(persisted[area],structuredClone(snapshot));
    if (area === 'session' && sessionFailure) { sessionFailure=false; return Promise.reject(new Error('Fixture session write failed')); }
    if (options.storageSet) return options.storageSet({area,values:snapshot,commit});
    commit(); return Promise.resolve();
  };
  const api = { runtime: { getManifest: () => ({ permissions: favicon ? ['favicon'] : [] }), getURL: p => `fixture://${p}`, onMessage: event('runtime.onMessage') },
    storage: { local: { onChanged:event('storage.local.onChanged'), async get() { return structuredClone(persisted.local); }, set: v => submit('local',v) }, onChanged:event('storage.onChanged'), session: { async get() { return structuredClone(persisted.session); }, set: v => submit('session',v) } },
    tabs: { async update(id, patch) { const tab = browserTabs.find(t => t.id === id); if (patch.active) for (const t of browserTabs) t.active = t.id === id; Object.assign(tab,patch); const result = structuredClone(tab); if (activationHeld) { activationHeld=false; await new Promise(resolve => {releaseActivation=resolve;}); } return result; },
      ...Object.fromEntries(['onCreated','onUpdated','onRemoved','onActivated','onMoved','onAttached','onDetached','onReplaced'].map(name => [name,event(`tabs.${name}`)])),
      async get(id) { const snapshot=structuredClone(browserTabs.find(t=>t.id===id)); if(getHeld) { getHeld=false; await new Promise(resolve=>{releaseGet=resolve;}); } return snapshot; },
      async query() { counters.queries++; if(queryFailure) {queryFailure=false;throw new Error('Fixture query failure');} const snapshot=structuredClone(browserTabs); options.query?.({number:counters.queries,browserTabs,listeners}); if(held) {held=false;await new Promise(r=>{release=r;});} return queryTransform ? queryTransform(snapshot) : snapshot; } },
  };
  if (options.peek) api.breezerPrivate = { setPeekSources(ids) { peekCalls.push([...ids]); return peekReject ? Promise.reject(new Error('Fixture Peek failure')) : Promise.resolve(); } };
  if (sharedStorage) api.storage = sharedStorage;
  const context = vm.createContext({ localStorageChanges, PLATFORM, ...store, buildSidebarModel(args) { counters.models++; return store.buildSidebarModel(args); }, WorkspaceStore: boot ? class extends store.WorkspaceStore { async reconcile(args) { const result=await super.reconcile(args); options.reconcile?.({browserTabs,listeners}); return result; } } : class { async patchMembers(set, remove) { counters.writes.push(['members', plain(set), plain(remove)]);
      for (const [id, record] of Object.entries(set)) persisted.local[store.MEMBERS_KEY].tabs[id] = { ...structuredClone(record), k: 'S1' };
      for (const id of remove) delete persisted.local[store.MEMBERS_KEY].tabs[id]; } },
    chrome: api, URL, console, Date: FixtureDate, innerWidth:width, innerHeight:height, CSS:{escape:s=>s}, matchMedia: () => ({ matches: reduced, addEventListener() {} }), addEventListener(name,fn) {(globalEvents[name] ||= []).push(fn);},
    document: { body:node('body'),documentElement:node('html'),visibilityState:visibility, addEventListener(name,fn) {(globalEvents['document.'+name] ||= []).push(fn);},querySelectorAll(q) {return node('body').querySelectorAll(q);},querySelector(q) {return this.querySelectorAll(q)[0] || null;}, getElementById: node, createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag) },
    requestAnimationFrame(fn) { counters.scheduled++; frames.set(++serial, fn); return serial; },
    cancelAnimationFrame(id) { frames.delete(id); },
    setTimeout(fn, delay) { if (delay === 50) counters.refreshScheduled++; timers.set(++serial, { fn, delay }); return serial; },
    clearTimeout(id) { timers.delete(id); },
  });
  source = source.replace('function syncRovingFocus() {', 'function syncRovingFocus() { globalThis.countOp("focusSyncs");');
  const loaded = source.replace(/^import \{[\s\S]*?from '\.\/workspace-store.js';\n/, '').replace(/^export /gm, '').replace('void boot();', '')
    .replace('function draw() {', 'function draw() { globalThis.countDraw();')
    .replace('function reconcile(container, items) {', 'function reconcile(container, items) { globalThis.countOp("reconciles");')
    .replace('const existing = new Map();', 'globalThis.countOp("reconcileMaps"); const existing = new Map();')
    .replace('function updateRow(row, { title, tab, url, active, asleep, actionLabel, actionIcon, selected }) {', 'function updateRow(row, { title, tab, url, active, asleep, actionLabel, actionIcon, selected }) { globalThis.countOp("rowUpdates");')
    .replace("  const sidebar = $('sidebar');", "  globalThis.beforePaint(); const sidebar = $('sidebar');")
    .replace('function compactLabels() {', 'function compactLabels() { globalThis.beforeCompact();')
    .replace("function el(tag, className, attrs = {}) {", "function el(tag, className, attrs = {}) { globalThis.countOp('elements');");
  context.beforePaint=()=>{if(paintFailure){paintFailure=false;throw new Error('Fixture DOM paint failure');}};
  context.beforeCompact=()=>{if(compactFailure){compactFailure=false;throw new Error('Fixture DOM compact failure');}};
  context.countDraw = () => counters.drawn++;
  context.countOp = name => counters[name]++;
  vm.runInContext(loaded + `\nglobalThis.h = {state, initSidebar, activate, onReplaced, queryDirty:()=>typeof queryDrawDirty!=='undefined'?queryDrawDirty:null, bindSidebar, draw, startRename, setRecord, onCreated, onUpdated, onRemoved, onActivated, onAttached, onDetached, switchSpace, saveWindowState, refreshTabs, render, flushRecords, pending:()=>({frame, rows:typeof pendingRows === 'undefined' || pendingRows === null ? null : [...pendingRows]}), versions:()=>[tabEventVersion,tabQueryVersion]};`, context);
  const h = context.h;
  Object.assign(h.state, { windowId: 7, store: structuredClone(fixture.local[store.STORE_KEY]),
    records: structuredClone(fixture.local[store.MEMBERS_KEY].tabs), tabs: new Map(structuredClone(browserTabs).map(t => [t.id, t])), activeSpaceId: 'space-work' });
  const flushFrames = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  if (!boot) { h.render(); flushFrames(); h.bindSidebar(); }
  counters.focusSyncs = 0; for (const key of ['scheduled', 'drawn', 'models', 'reconciles', 'reconcileMaps', 'rowUpdates', 'elements']) counters[key] = 0;
  return { ...h, api, context, persisted, peekCalls, pagehide() {for(const fn of globalEvents.pagehide || []) fn();},
    failNextPaint() {paintFailure=true;},failNextCompact() {compactFailure=true;},
    holdGet() {getHeld=true;},releaseGet() {releaseGet();},rejectNextQuery() {queryFailure=true;},setQueryTransform(fn) {queryTransform=fn;},allowPeek() {peekReject=false;}, emit(name, ...args) { for (const fn of listeners[name] || []) fn(...args); }, framesPending: () => frames.size, counters, browserTabs, nodes, flushFrames,
    setViewport(width, visibility = 'visible') { context.innerWidth = width; context.document.visibilityState = visibility; },
    timerDelays: () => [...timers.values()].map(timer => timer.delay),
    create(tab) {
      browserTabs.push(structuredClone(tab)); h.onCreated(structuredClone(tab));
    },
    update(id, change, extra = {}) {
      const old = browserTabs.find(t => t.id === id) || { id, windowId: 7, index: browserTabs.length };
      const tab = Object.assign(old, structuredClone(change), structuredClone(extra));
      if (!browserTabs.includes(tab)) browserTabs.push(tab);
      h.onUpdated(id, structuredClone(change), structuredClone(tab));
    },
    holdActivation() { activationHeld = true; }, releaseActivation() { releaseActivation(); },
    failSessionWrite() { sessionFailure = true; },
    holdQuery() { held = true; }, releaseQuery() { release(); },
    async timers(delay) { now += delay; for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); await timer.fn(); } for (let i = 0; i < 12; i++) await Promise.resolve(); },
    snapshot() { return plain({ tabs: [...h.state.tabs], records: h.state.records, lastActive: h.state.lastActive,
      renaming: h.state.renaming, closeFallback: h.state.closeFallback, model: h.state.model, items: [...h.state.items], persisted, dom: [...nodes].map(([id, n]) => [id, n.snapshot()]), writes: counters.writes }); },
  };
}
