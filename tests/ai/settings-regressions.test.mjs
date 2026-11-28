import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDom, event } from './settings-dom.mjs';
import { mountOrganato } from '../../features/ai/extension/settings.js';

const html = readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8');

function fixture() {
  const dom = createDom(html);
  Object.assign(globalThis, dom.globals);
  globalThis.window = dom.window;
  const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, fire(value) { this.listeners.forEach((fn) => fn(value)); } });
  const ports = [];
  const api = { runtime: { connect: () => { const port = { onMessage: events(), onDisconnect: events(), sent: [], postMessage(m) { this.sent.push(m); }, disconnect() {} }; ports.push(port); return port; } } };
  const service = mountOrganato(api, { timeoutMs: 20 });
  const $ = (id) => dom.document.getElementById(id);
  ports[0].onMessage.fire({ id: ports[0].sent[0].id, ok: true, value: { enabled: true, dashboardEnabled: true, allowAI: true, connected: true } });
  const toggle = (id, checked) => { $(id).checked = checked; $(id).dispatchEvent(event('change')); return ports[0].sent.at(-1); };
  return { port: ports[0], service, $, toggle };
}

test('a refused Organato change puts the switch back to the saved value', () => {
  const f = fixture();
  assert.equal(f.$('organato-ai').checked, true);
  const sent = f.toggle('organato-ai', false);
  assert.deepEqual(sent.settings, { allowAI: false });
  f.port.onMessage.fire({ id: sent.id, ok: false, error: 'Keychain write failed.' });
  assert.equal(f.$('organato-status').textContent, 'Keychain write failed.');
  assert.equal(f.$('organato-ai').checked, true);
  f.service.dispose();
});

test('a timed-out Organato change puts the switch back to the saved value', async () => {
  const f = fixture();
  f.toggle('organato-enabled', false);
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.match(f.$('organato-status').textContent, /timed out/i);
  assert.equal(f.$('organato-enabled').checked, true);
  f.service.dispose();
});

test('a confirmed Organato change keeps the new value', () => {
  const f = fixture();
  const sent = f.toggle('organato-ai', false);
  f.port.onMessage.fire({ id: sent.id, ok: true, value: { enabled: true, dashboardEnabled: true, allowAI: false, connected: true } });
  assert.equal(f.$('organato-ai').checked, false);
  // A later failure goes back to that newer confirmed value.
  const again = f.toggle('organato-ai', true);
  f.port.onMessage.fire({ id: again.id, ok: false, error: 'Nope.' });
  assert.equal(f.$('organato-ai').checked, false);
  f.service.dispose();
});

test('Organato switches stay off until the first read succeeds, and a failed read is retried', async () => {
  const dom = createDom(html);
  Object.assign(globalThis, dom.globals);
  globalThis.window = dom.window;
  const ports = [];
  const events = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); }, fire(value) { this.listeners.forEach((fn) => fn(value)); } });
  const api = { runtime: { connect: () => { const port = { onMessage: events(), onDisconnect: events(), sent: [], postMessage(m) { this.sent.push(m); }, disconnect() {} }; ports.push(port); return port; } } };
  const service = mountOrganato(api, { timeoutMs: 20, retryMs: 10 });
  const $ = (id) => dom.document.getElementById(id);
  const switches = ['dashboard-enabled', 'organato-enabled', 'organato-ai'];
  assert.deepEqual(switches.map((id) => $(id).disabled), [true, true, true]);
  ports[0].onMessage.fire({ id: ports[0].sent[0].id, ok: false, error: 'Helper unavailable.' });
  assert.deepEqual(switches.map((id) => $(id).disabled), [true, true, true]);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const retry = ports[0].sent.at(-1);
  assert.equal(retry.type, 'view');
  ports[0].onMessage.fire({ id: retry.id, ok: true, value: { enabled: true, dashboardEnabled: true, allowAI: false, connected: true } });
  assert.deepEqual(switches.map((id) => $(id).disabled), [false, false, false]);
  assert.equal($('organato-ai').checked, false);
  service.dispose();
});
