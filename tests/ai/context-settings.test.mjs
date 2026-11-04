import test from 'node:test';
import assert from 'node:assert/strict';
import { CONTEXT_KEY } from '../../features/ai/extension/context-memory.js';
const { createContextClient, mountContextSettings } = await import('../../features/ai/extension/context-settings.js').catch(() => ({}));
const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, removeListener(fn) { this.listeners=this.listeners.filter(listener=>listener!==fn); }, fire(...args) { for (const fn of this.listeners) fn(...args); } });

test('settings client does not collect or summarize on connect and matches only its own responses', async () => {
  assert.equal(typeof createContextClient, 'function', 'Context settings controls are missing');
  const port = { onMessage: event(), onDisconnect: event(), sent: [], postMessage(m) { this.sent.push(m); }, disconnect() { this.onDisconnect.fire(); } };
  const client = createContextClient({ runtime: { connect({ name }) { assert.equal(name, 'breezer-context-settings'); return port; } }, storage: { onChanged: event() } });
  assert.deepEqual(port.sent, []);
  const reading = client.request('view');
  const request = port.sent[0];
  port.onMessage.fire({ id: 'forged', ok: true, value: { enabled: true } });
  port.onMessage.fire({ id: request.id, ok: true, value: { enabled: false } });
  assert.equal((await reading).enabled, false);
  let notified = 0;
  client.onChange(() => notified++);
  port.onMessage.fire({ type: 'context-changed' });
  assert.equal(notified, 1);
  const pending = client.request('view'); const checked = assert.rejects(pending, /closed|disconnect/i);
  client.dispose(); await checked;
  await assert.rejects(client.request('summarize'), /closed|disconnect/i);
});

test('context settings reconnect after idle retirement and retain change notifications', async () => {
  const ports=[],changed=event();
  const api={storage:{onChanged:changed},runtime:{connect(){
    const port={onMessage:event(),onDisconnect:event(),sent:[],closed:false,
      postMessage(message){if(this.closed)throw new Error('Disconnected port');this.sent.push(message)},
      disconnect(){this.closed=true;this.onDisconnect.fire()}};
    ports.push(port);return port;
  }}};
  const client=createContextClient(api);
  try {
    const initial=client.request('view');initial.catch(()=>{});
    ports[0].onMessage.fire({id:ports[0].sent[0].id,ok:true,value:{enabled:false}});await initial;
    let notifications=0;client.onChange(()=>notifications++);
    ports[0].disconnect();
    assert.equal(ports.length,1,'Idle retirement must not immediately wake the worker');
    changed.fire({unrelated:{newValue:1}},'local');
    changed.fire({[CONTEXT_KEY]:{newValue:{enabled:false}}},'sync');
    assert.equal(notifications,0);
    changed.fire({[CONTEXT_KEY]:{newValue:{enabled:false}}},'local');
    assert.equal(notifications,1,'Stored context changes remain observable while disconnected');
    const next=client.request('view');next.catch(()=>{});
    assert.equal(ports.length,2);
    ports[0].onDisconnect.fire();
    ports[0].onMessage.fire({type:'context-changed'});
    assert.equal(notifications,1,'Old-channel events must be ignored');
    ports[1].onMessage.fire({id:ports[1].sent[0].id,ok:true,value:{enabled:true}});
    assert.equal((await next).enabled,true);
    ports[1].onMessage.fire({type:'context-changed'});assert.equal(notifications,2);
  } finally {client.dispose()}
  assert.equal(changed.listeners.length,0);
  await assert.rejects(client.request('view'),/closed|disconnect/i);
});

test('disconnecting an active context request rejects it without replay and allows a new request',async()=>{
  const ports=[];const api={storage:{onChanged:event()},runtime:{connect(){
    const port={onMessage:event(),onDisconnect:event(),sent:[],postMessage(message){this.sent.push(message)},disconnect(){this.onDisconnect.fire()}};
    ports.push(port);return port;
  }}};
  const client=createContextClient(api);
  try{
    const pending=client.request('configure',{enabled:false});const rejected=assert.rejects(pending,/closed|disconnect/i);
    ports[0].disconnect();await rejected;
    assert.equal(ports.length,1);
    const next=client.request('view');next.catch(()=>{});assert.equal(ports.length,2);
    ports[1].onMessage.fire({id:ports[1].sent[0].id,ok:true,value:{enabled:false}});await next;
  }finally{client.dispose()}
});

// A small DOM event harness, without a browser or an additional dependency.
class Element {
  constructor(tag, doc) { this.tagName = tag; this.ownerDocument = doc; this.children = []; this.dataset = {}; this.listeners = {}; this.textContent = ''; }
  append(...nodes) { for (const node of nodes) { this.children.push(node); node.parent = this; } }
  replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
  setAttribute(key, value) { this[key] = value; }
  addEventListener(name, fn) { this.listeners[name] = fn; }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter(n => n !== this); }
  async fire(name) { await this.listeners[name]?.({ target: this }); }
}
const walk = element => [element, ...element.children.flatMap(walk)];

test('settings flow keeps local and provider consent separate and renders provider text as text', async () => {
  assert.equal(typeof mountContextSettings, 'function');
  const calls = []; let changed;
  let state = { enabled: false, providerConsent: false, sites: [], habits: [], suggestions: [], retentionDays: 7 };
  const client = { onChange(fn) { changed = fn; return () => {}; }, dispose() {}, async request(type, fields) {
    calls.push({ type, fields });
    if (type === 'configure') state = { ...state, enabled: fields.enabled, sites: fields.enabled ? fields.sites : [], providerConsent: false };
    if (type === 'consent') state = { ...state, providerConsent: fields.consent };
    if (type === 'summarize') return { text: '<img src=x onerror=alert(1)>', model: 'gpt-6-luna', provider: 'codex' };
    return state;
  } };
  const doc = { createElement(tag) { return new Element(tag, doc); } };
  const container = new Element('div', doc);
  const mounted = mountContextSettings({ container, client }); await mounted.ready;
  const all = () => walk(container);
  const button = text => all().find(node => node.tagName === 'button' && node.textContent === text);
  const local = all().find(node => node.dataset.contextControl === 'enabled');
  const consent = all().find(node => node.dataset.contextControl === 'consent');
  const sites = all().find(node => node.tagName === 'textarea');
  assert.equal(local.checked, false); assert.equal(consent.checked, false);
  assert.equal(calls.some(call => call.type === 'summarize'), false);
  local.checked = true; sites.value = 'docs.example.org';
  await button('Save choices').fire('click');
  assert.equal(state.enabled, true); assert.equal(state.providerConsent, false);
  consent.checked = true; await consent.fire('change');
  assert.equal(state.providerConsent, true);
  await button('Summarize with GPT-6 Luna').fire('click');
  assert.ok(all().some(node => node.textContent === '<img src=x onerror=alert(1)>'));
  assert.equal(all().some(node => node.tagName === 'img'), false);
  await button('Disable and erase').fire('click');
  assert.equal(state.enabled, false); assert.equal(state.providerConsent, false);
  assert.equal(all().some(node => node.textContent === '<img src=x onerror=alert(1)>'), false);
  changed();
  mounted.dispose();
});
