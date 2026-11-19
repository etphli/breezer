import { localStorageChanges } from '../../features/ai/extension/storage-events.js';
import { HAS_NATIVE_HELPER } from '../../features/ai/extension/platform.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('a pre-response shortcut filter cannot overwrite the loaded sites', async () => {
  const source = await readFile(new URL('../../features/ai/extension/newtab.js', import.meta.url), 'utf8');
  const preferences = await readFile(new URL('../../features/ai/extension/top-sites.js', import.meta.url), 'utf8');
  const callbacks = new Map(), nodes = new Map(), observed = { shown: 0, filters: 0 };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, hidden: false, addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const root = { documentElement: { dataset: {} }, getElementById: node, querySelector: node };
  let reply, releaseDigest, requestReady, digestReady;
  const requestStarted = new Promise(resolve => { requestReady = resolve; });
  const digestStarted = new Promise(resolve => { digestReady = resolve; });
  let digests = 0;
  const api = { storage: { local: { onChanged: { addListener(fn) { callbacks.set('storage', fn); }, removeListener() {} }, async get(key) {
    if (key === 'newtab.hiddenSites.v1') return { [key]: ['00'.repeat(32)] };
    if (key === 'newtab.customSites.v1') return { [key]: [{ url: 'https://hidden.example/', title: 'Hidden' }] };
    return {};
  } } } };
  const context = vm.createContext({ localStorageChanges, HAS_NATIVE_HELPER, URL, Intl, Date, TextEncoder, root, api, observed, innerWidth: 1000,
    crypto: { subtle: { async digest(_algorithm, bytes) {
      if (++digests === 1) { digestReady(); await new Promise(resolve => { releaseDigest = resolve; }); }
      return new Uint8Array(32).fill(new TextDecoder().decode(bytes).includes('hidden.example') ? 0 : 1).buffer;
    } } },
    async viewReply() {
      requestReady(); await new Promise(resolve => { reply = resolve; });
      return { topSites: Array.from({ length: 8 }, (_, i) => ({ url: `https://s${i}.example/`, title: `Site ${i}` })), organato: { enabled: true, connected: true } };
    },
    setTimeout: () => 1, clearTimeout() {},
    addEventListener(name, fn) { callbacks.set(name, fn); }, removeEventListener() {},
    installShortcutAdder() {},
  });
  const script = preferences.replace(/^export /gm, '') + '\n' + source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + `
installShortcutActions=()=>()=>{}; requestView=viewReply;
const originalFilter=ShortcutPreferences.prototype.filter;
ShortcutPreferences.prototype.filter=function(...args){observed.filters++;return originalFilter.apply(this,args)};
renderToday=()=>{}; renderPlaceholders=()=>{}; renderSites=(_api,_root,sites)=>{observed.shown=sites.length}; renderOrganato=()=>{};
globalThis.run=()=>startNewTab({api,root});`;
  vm.runInContext(script, context);
  const loaded = context.run();
  await requestStarted;
  context.innerWidth = 900;
  callbacks.get('storage')({ 'newtab.hiddenSites.v1': { newValue: [] } }, 'local');
  await digestStarted;
  reply(); await loaded;
  assert.equal(observed.shown, 8);
  releaseDigest();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.shown, 8, 'obsolete empty result must never erase loaded shortcuts');
  const filters = observed.filters;
  context.innerWidth = 899; callbacks.get('resize')?.();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(observed.shown, 8);
  assert.equal(observed.filters, filters, 'resizing does not filter away shortcuts or trigger storage work');
});

for (const dashboardEnabled of [false, true]) test(`disposed new-tab ignores late reply, dashboard enabled: ${dashboardEnabled}`, async () => {
  const source = await readFile(new URL('../../features/ai/extension/newtab.js', import.meta.url), 'utf8');
  const preferences = await readFile(new URL('../../features/ai/extension/top-sites.js', import.meta.url), 'utf8');
  const callbacks = new Map(), timers = new Map(), nodes = new Map();
  let paints = 0, navigations = 0, reply, started;
  const ready = new Promise(resolve => { started = resolve; });
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, hidden: false, addEventListener() {}, setAttribute() {}, removeAttribute() {}, querySelectorAll: () => [] });
    return nodes.get(id);
  };
  const root = { documentElement: { dataset: {} }, getElementById: node, querySelector: node };
  const api = { storage: { local: { onChanged: { addListener() {}, removeListener() {} }, async get() { return {}; } }, onChanged: { addListener() {}, removeListener() {} } } };
  const context = vm.createContext({ localStorageChanges, HAS_NATIVE_HELPER, URL, Intl, Date, TextEncoder, root, api, innerWidth: 1000,
    installShortcutAdder() {},
    location: { replace() { navigations++; } },
    async viewReply() { started(); return new Promise(resolve => { reply = resolve; }); },
    recordPaint() { paints++; },
    setTimeout(fn) { const id = timers.size + 1; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
    addEventListener(name, fn) { callbacks.set(name, fn); }, removeEventListener(name) { callbacks.delete(name); },
  });
  vm.runInContext(preferences.replace(/^export /gm, '') + '\n' + source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + `
installShortcutActions=()=>()=>{}; requestView=viewReply;
renderToday=recordPaint; renderPlaceholders=()=>{}; renderSites=recordPaint; renderOrganato=recordPaint;
globalThis.run=()=>startNewTab({api,root});`, context);
  const loaded = context.run(); await ready;
  const before = paints;
  const midnight = [...timers.values()][0];
  callbacks.get('pagehide')({ persisted: true });
  assert.equal(timers.size, 1, 'back-forward cached page keeps its scheduled work');
  assert.ok(callbacks.has('pagehide'), 'back-forward cached page keeps its disposal listener');
  assert.equal(callbacks.has('resize'), false, 'layout never installs a resize listener');
  callbacks.get('pagehide')({ persisted: false });
  midnight();
  reply({ dashboardEnabled, topSites: [], organato: { enabled: false } });
  await loaded;
  assert.equal(navigations, 0, 'late replies must not navigate a disposed page');
  assert.equal(paints, before, 'late replies must not paint a disposed page');
  assert.equal(timers.size, 0, 'midnight timer is cancelled on disposal');
  assert.equal(root.documentElement.dataset.loaded, undefined);
});


test('refresh stays hidden during loading, setup and off with only local storage listeners', async () => {
  const source = await readFile(new URL('../../features/ai/extension/newtab.js', import.meta.url), 'utf8');
  const preferences = await readFile(new URL('../../features/ai/extension/top-sites.js', import.meta.url), 'utf8');
  for (const organato of [
    { connected: false }, { enabled: false }, { connected: true }, { connected: true, error: 'offline' },
  ]) {
    const nodes = new Map(), callbacks = new Map();
    let storageListener, release, started, subscriptions = 0, removals = 0;
    const ready = new Promise(resolve => { started = resolve; });
    const node = id => {
      if (!nodes.has(id)) nodes.set(id, { dataset: {}, hidden: false, attributes: new Map(),
        querySelectorAll: () => [],
        addEventListener() {}, setAttribute(name, value) { this.attributes.set(name, value); }, removeAttribute(name) { this.attributes.delete(name); } });
      return nodes.get(id);
    };
    const root = { documentElement: { dataset: {} }, getElementById: node, querySelector: node };
    const api = { storage: {
      local: { async get() { return {}; }, onChanged: {
        addListener(fn) { subscriptions++; storageListener = fn; },
        removeListener(fn) { if (fn === storageListener) removals++; },
      } },
      onChanged: { addListener() { assert.fail('general storage listener subscribed'); } },
    } };
    const context = vm.createContext({ localStorageChanges, HAS_NATIVE_HELPER, URL, Intl, Date, TextEncoder, root, api,
      installShortcutAdder() {}, setTimeout: () => 1, clearTimeout() {},
      addEventListener(name, fn) { callbacks.set(name, fn); }, removeEventListener(name) { callbacks.delete(name); },
      async viewReply() { started(); return new Promise(resolve => { release = resolve; }); },
    });
    vm.runInContext(preferences.replace(/^export /gm, '') + '\n' + source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '') + `
installShortcutActions=()=>()=>{}; requestView=viewReply;
renderToday=()=>{}; renderPlaceholders=()=>{}; renderSites=()=>{}; renderOrganato=()=>{};
globalThis.run=()=>startNewTab({api,root});`, context);
    const loaded = context.run(); await ready;
    assert.equal(node('refresh').hidden, true, 'loading hides Refresh');
    assert.equal(node('refresh').attributes.get('aria-busy'), 'true');
    release({ topSites: [], organato }); await loaded;
    const hidden = organato.connected === false;
    assert.equal(node('refresh').hidden, hidden, JSON.stringify(organato));
    assert.equal(node('refresh').disabled, hidden, JSON.stringify(organato));
    assert.equal(node('refresh').attributes.has('aria-busy'), false);
    assert.equal(node('.sheet').hidden, organato.enabled === false, 'helper-off hides the whole sheet');
    storageListener({ 'organato.switches.v1': { newValue: { enabled: false } } });
    assert.equal(node('refresh').hidden, true, 'a saved off switch hides Refresh');
    assert.equal(node('.sheet').hidden, true);
    assert.equal(subscriptions, 1);
    assert.equal(callbacks.has('resize'), false);
    callbacks.get('pagehide')({ persisted: true });
    assert.equal(removals, 0);
    callbacks.get('pagehide')({ persisted: false });
    assert.equal(removals, 1, 'disposal unsubscribes the same area-local listener');
  }
});
