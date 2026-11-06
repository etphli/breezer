import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

test('a pre-response shortcut filter cannot overwrite the loaded sites', async () => {
  const source = await readFile(new URL('../../features/ai/extension/newtab.js', import.meta.url), 'utf8');
  const preferences = await readFile(new URL('../../features/ai/extension/top-sites.js', import.meta.url), 'utf8');
  const callbacks = new Map(), nodes = new Map(), observed = { shown: 0, filters: 0 };
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, hidden: false, addEventListener() {}, setAttribute() {}, removeAttribute() {} });
    return nodes.get(id);
  };
  const root = { documentElement: { dataset: {} }, getElementById: node, querySelector: node };
  let reply, releaseDigest, requestReady, digestReady;
  const requestStarted = new Promise(resolve => { requestReady = resolve; });
  const digestStarted = new Promise(resolve => { digestReady = resolve; });
  let digests = 0;
  const api = { storage: { local: { async get(key) {
    if (key === 'newtab.hiddenSites.v1') return { [key]: ['00'.repeat(32)] };
    if (key === 'newtab.customSites.v1') return { [key]: [{ url: 'https://hidden.example/', title: 'Hidden' }] };
    return {};
  } }, onChanged: { addListener(fn) { callbacks.set('storage', fn); }, removeListener() {} } } };
  const context = vm.createContext({ URL, Intl, Date, TextEncoder, root, api, observed, innerWidth: 1000,
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
