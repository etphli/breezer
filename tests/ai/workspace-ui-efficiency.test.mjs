import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
async function newtab({ duringInitialFilter } = {}) {
  const source = await readFile(new URL('../../features/ai/extension/newtab.js', import.meta.url), 'utf8');
  const callbacks = new Map(), storageListeners = [], nodes = new Map();
  const counters = { loads: 0, filters: 0, sites: 0, organato: 0, limits: [], failLoad: false };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, dataset: {}, textContent: '', handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; }, setAttribute() {}, removeAttribute() {}, focus() {} });
    return nodes.get(id);
  };
  const root = { documentElement: { dataset: {} }, getElementById: node, querySelector: node };
  const api = { storage: { local: { async get() { return {}; } }, onChanged: {
    addListener(fn) { storageListeners.push(fn); }, removeListener(fn) { storageListeners.splice(storageListeners.indexOf(fn), 1); },
  } } };
  let firstFilter = true;
  const context = vm.createContext({ URL, Intl, Date, root, api, counters, innerWidth: 1000,
    setTimeout: () => 1, clearTimeout() {},
    addEventListener(name, fn) { callbacks.set(name, fn); },
    removeEventListener(name, fn) { if (callbacks.get(name) === fn) callbacks.delete(name); },
    ShortcutPreferences: class {
      constructor() { this.hidden = new Set(); }
      async load() { counters.loads++; if (counters.failLoad) throw new Error('Fixture read failed'); }
      async filter(sites, limit) {
        counters.filters++; counters.limits.push(limit);
        if (firstFilter) { firstFilter = false; await duringInitialFilter?.(context, callbacks); }
        return sites.slice(0, limit);
      }
      async reset() { this.hidden.clear(); }
    },
    installShortcutAdder() {}, installShortcutActions: () => () => {},
    HIDDEN_SITES_KEY: 'hidden', CUSTOM_SITES_KEY: 'custom', ORGANATO_SWITCHES_KEY: 'organato.switches.v1',
  });
  const loaded = source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + `
requestView = async () => ({ topSites: Array.from({length:8},(_,i)=>({url:'https://s'+i+'.example/',title:'Site '+i})), organato: {enabled:true,connected:true} });
renderToday=()=>{}; renderPlaceholders=()=>{}; renderSites=(_api,_root,sites)=>{counters.sites++;counters.shown=sites.length}; renderOrganato=()=>{counters.organato++};
globalThis.run=()=>startNewTab({api,root});`;
  vm.runInContext(loaded, context);
  await context.run();
  counters.loads = counters.filters = counters.sites = counters.organato = 0;
  counters.limits.length = 0;
  return { context, callbacks, counters, nodes, storageListeners, async resize(width) { context.innerWidth = width; callbacks.get('resize')?.(); await settle(); } };
}

test('new-tab resizes keep every shortcut without storage, filtering or painting', async () => {
  const h = await newtab();
  for (let i = 0; i < 20; i++) await h.resize(1000 + i);
  assert.deepEqual([h.counters.loads, h.counters.filters, h.counters.sites, h.counters.organato], [0, 0, 0, 0]);
  for (const width of [900, 850, 700, 400, 401]) await h.resize(width);
  assert.deepEqual(h.counters.limits, []);
  assert.deepEqual([h.counters.loads, h.counters.filters, h.counters.sites, h.counters.organato], [0, 0, 0, 0]);
});

test('shortcut changes and explicit Reset still refresh at the same width', async () => {
  const h = await newtab();
  h.storageListeners[0]({ hidden: { newValue: [] } }, 'local');
  await settle();
  assert.equal(h.counters.loads, 1);
  await h.nodes.get('sites-reset').handlers.click();
  assert.equal(h.counters.loads, 2);
});

test('resize during initial shortcut filtering preserves all eight shortcuts', async () => {
  const h = await newtab({ duringInitialFilter: async (context, callbacks) => {
    context.innerWidth = 900;
    callbacks.get('resize')?.();
    await settle();
  } });
  assert.equal(h.counters.shown, 8);
  await h.resize(900);
  assert.equal(h.counters.shown, 8);
});

test('failed shortcut refreshes can retry and pagehide releases storage listeners', async () => {
  const h = await newtab();
  h.counters.failLoad = true;
  h.storageListeners[0]({ hidden: { newValue: [] } }, 'local');
  await settle();
  h.counters.failLoad = false;
  h.storageListeners[0]({ hidden: { newValue: [] } }, 'local');
  await settle();
  assert.equal(h.counters.loads, 2);
  assert.deepEqual(h.counters.limits, [8]);
  h.callbacks.get('pagehide')();
  assert.equal(h.callbacks.has('resize'), false);
  assert.equal(h.storageListeners.length, 0);
});

async function toast() {
  const source = await readFile(new URL('../../features/ai/extension/workspace.js', import.meta.url), 'utf8');
  const functions = source.slice(source.indexOf('let toastTimer = 0;'), source.indexOf('// ---------------------------------------------------------------- drag and drop'));
  const nodes = Object.fromEntries(['toast', 'toast-text', 'toast-action'].map(id => [id, {}]));
  let timeout;
  const context = vm.createContext({ $: id => nodes[id], setTimeout(fn) { timeout = fn; return 1; }, clearTimeout() {} });
  vm.runInContext(functions + '\nglobalThis.show=showToast;globalThis.hide=hideToast;', context);
  return { context, nodes, expire: () => timeout() };
}

test('expired Undo releases its action and clicking active Undo still invokes it once', async () => {
  const h = await toast();
  let calls = 0;
  h.context.show('Closed tabs', 'Undo', () => calls++);
  h.expire();
  assert.equal(h.nodes['toast-action'].onclick, null);
  h.context.show('Closed tabs', 'Undo', () => calls++);
  h.nodes['toast-action'].onclick();
  assert.equal(calls, 1);
  assert.equal(h.nodes['toast-action'].onclick, null);
  assert.equal(h.nodes.toast.hidden, true);
});
