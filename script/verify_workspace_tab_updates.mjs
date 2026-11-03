import { readFile, writeFile } from 'node:fs/promises';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import * as store from '../features/ai/extension/workspace-store.js';
import { seed } from '../tests/ai/workspace-browser-fixture.mjs';

// Deterministic DOM contract, not a layout engine. All production draw/reconcile/
// row/model functions run; timers and animation frames advance explicitly.
class Node {
  constructor(tag = 'div') {
    this.tag = tag; this.children = []; this.parent = null; this.dataset = {};
    this.attrs = {}; this.hidden = false; this.tabIndex = -1; this.text = '';
    this.classes = new Set();
    this.classList = { contains: c => this.classes.has(c), add: c => this.classes.add(c),
      remove: c => this.classes.delete(c), toggle: (c, on = !this.classes.has(c)) => on ? this.classes.add(c) : this.classes.delete(c) };
  }
  set className(value) { this.classes = new Set(value.split(' ').filter(Boolean)); }
  get textContent() { return this.text + this.children.map(n => n.textContent).join(''); }
  set textContent(value) { this.text = String(value); this.replaceChildren(); }
  setAttribute(k, v) { this.attrs[k] = String(v); if (k === 'class') this.className = v; }
  getAttribute(k) { return this.attrs[k] ?? null; }
  append(...nodes) { for (const n of nodes) this.insertBefore(n, null); }
  insertBefore(n, before) { n.remove(); const at = before ? this.children.indexOf(before) : this.children.length; this.children.splice(at, 0, n); n.parent = this; }
  replaceChildren(...nodes) { for (const n of [...this.children]) n.remove(); this.append(...nodes); }
  remove() { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; }
  get firstChild() { return this.children[0] || null; }
  get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; }
  matches(q) {
    if (q === '.folder-children[hidden]') return this.classes.has('folder-children') && this.hidden;
    if (q.startsWith('.')) return this.classes.has(q.slice(1));
    if (q === '[role="treeitem"]') return this.attrs.role === 'treeitem';
    return this.tag === q;
  }
  querySelectorAll(q) { return this.children.flatMap(n => [...(n.matches(q) ? [n] : []), ...n.querySelectorAll(q)]); }
  querySelector(q) { return this.querySelectorAll(q)[0] || null; }
  closest(q) { return this.matches(q) ? this : this.parent?.closest(q); }
  contains(n) { return n === this || this.children.some(c => c.contains(n)); }
  snapshot() { return { tag: this.tag, classes: [...this.classes].sort(), dataset: this.dataset, attrs: this.attrs,
    text: this.text, hidden: this.hidden, tabIndex: this.tabIndex, title: this.title, src: this.src,
    children: this.children.map(n => n.snapshot()) }; }
}
const plain = value => JSON.parse(JSON.stringify(value));
export const sourcePath = new URL('../features/ai/extension/workspace.js', import.meta.url);
export const baselinePath = new URL('../build/efficiency-20261103/workspace-tab-update-baseline.js', import.meta.url);
export async function harness(source) {
  source ??= await readFile(sourcePath, 'utf8');
  const fixture = seed(), nodes = new Map(), frames = new Map(), timers = new Map();
  const counters = { scheduled: 0, drawn: 0, queries: 0, refreshScheduled: 0, writes: [] };
  let serial = 0, held = null, release, now = 1700000000000;
  class FixtureDate extends Date { static now() { return now; } }
  const node = id => { if (!nodes.has(id)) nodes.set(id, new Node()); return nodes.get(id); };
  const browserTabs = structuredClone(fixture.tabs);
  const persisted = structuredClone({ local: fixture.local, session: fixture.session });
  const api = { runtime: { getManifest: () => ({ permissions: [] }), getURL: p => `fixture://${p}` },
    storage: { session: { async set(v) { counters.writes.push(['session', plain(v)]); Object.assign(persisted.session, structuredClone(v)); } } },
    tabs: { async query() { counters.queries++; const snapshot = structuredClone(browserTabs); if (held) { held = false; await new Promise(r => { release = r; }); } return snapshot; } } };
  const context = vm.createContext({ ...store, WorkspaceStore: class { async patchMembers(set, remove) { counters.writes.push(['members', plain(set), plain(remove)]);
      for (const [id, record] of Object.entries(set)) persisted.local[store.MEMBERS_KEY].tabs[id] = { ...structuredClone(record), k: 'S1' };
      for (const id of remove) delete persisted.local[store.MEMBERS_KEY].tabs[id]; } },
    chrome: api, URL, console, Date: FixtureDate, matchMedia: () => ({ matches: true }), addEventListener() {},
    document: { getElementById: node, createElement: tag => new Node(tag), createElementNS: (_, tag) => new Node(tag) },
    requestAnimationFrame(fn) { counters.scheduled++; frames.set(++serial, fn); return serial; },
    setTimeout(fn, delay) { if (delay === 50) counters.refreshScheduled++; timers.set(++serial, { fn, delay }); return serial; },
    clearTimeout(id) { timers.delete(id); },
  });
  const loaded = source.replace(/^import \{[\s\S]*?from '\.\/workspace-store.js';\n/, '').replace(/^export /gm, '').replace('void boot();', '')
    .replace('function draw() {', 'function draw() { globalThis.countDraw();');
  context.countDraw = () => counters.drawn++;
  vm.runInContext(loaded + `\nglobalThis.h = {state, onUpdated, onRemoved, onActivated, refreshTabs, render, flushRecords, versions:()=>[tabEventVersion,tabQueryVersion]};`, context);
  const h = context.h;
  Object.assign(h.state, { windowId: 7, store: structuredClone(fixture.local[store.STORE_KEY]),
    records: structuredClone(fixture.local[store.MEMBERS_KEY].tabs), tabs: new Map(structuredClone(browserTabs).map(t => [t.id, t])), activeSpaceId: 'space-work' });
  const flushFrames = () => { for (const [id, fn] of [...frames]) { frames.delete(id); fn(); } };
  h.render(); flushFrames(); counters.scheduled = counters.drawn = 0;
  return { ...h, counters, browserTabs, nodes, flushFrames,
    update(id, change, extra = {}) {
      const old = browserTabs.find(t => t.id === id) || { id, windowId: 7, index: browserTabs.length };
      const tab = Object.assign(old, structuredClone(change), structuredClone(extra));
      if (!browserTabs.includes(tab)) browserTabs.push(tab);
      h.onUpdated(id, structuredClone(change), structuredClone(tab));
    },
    holdQuery() { held = true; }, releaseQuery() { release(); },
    async timers(delay) { now += delay; for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); await timer.fn(); } for (let i = 0; i < 12; i++) await Promise.resolve(); },
    snapshot() { return plain({ tabs: [...h.state.tabs], records: h.state.records, lastActive: h.state.lastActive,
      closeFallback: h.state.closeFallback, persisted, dom: [...nodes].map(([id, n]) => [id, n.snapshot()]), writes: counters.writes }); },
  };
}
export async function measure(source) {
  const h = await harness(source);
  for (let i = 0; i < 20; i++) { h.update(3, { autoDiscardable: Boolean(i % 2) }); h.flushFrames(); }
  return { ...h.counters, eventVersion: h.versions()[0] };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const baseline = await readFile(baselinePath, 'utf8'), current = await readFile(sourcePath, 'utf8');
  const result = { baselineSha256: createHash('sha256').update(baseline).digest('hex'),
    currentSha256: createHash('sha256').update(current).digest('hex'), baseline: await measure(baseline), current: await measure(current) };
  console.log(JSON.stringify(result, null, 2));
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(result, null, 2) + '\n');
}
