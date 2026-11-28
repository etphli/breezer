import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDom, event } from './settings-dom.mjs';
import { mountContextSettings } from '../../features/ai/extension/context-settings.js';

const html = readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8');

async function mount(consentResult) {
  const dom = createDom(html);
  Object.assign(globalThis, dom.globals);
  globalThis.window = dom.window;
  const state = { enabled: true, providerConsent: true, sites: ['docs.example.org'], habits: [{ site: 'docs.example.org', observations: 5, days: 2 }], suggestions: [] };
  const client = {
    async request(type, payload) {
      if (type === 'view') return structuredClone(state);
      if (type === 'consent') return consentResult(state, payload);
      return null;
    },
    onChange() { return () => {}; },
    dispose() {},
  };
  const container = dom.document.getElementById('context-settings');
  const ui = mountContextSettings({ container, client });
  await ui.ready;
  const consent = container.querySelector('[data-context-control="consent"]');
  const summarize = [...container.querySelectorAll('button')].find((node) => /Summarize/.test(node.textContent));
  const error = container.querySelector('[role="alert"]');
  return { ui, state, consent, summarize, error };
}

test('a failed consent revoke shows consent still on', async () => {
  const f = await mount(() => { throw new Error('Context settings request timed out. Try again.'); });
  assert.equal(f.consent.checked, true);
  assert.equal(f.summarize.disabled, false);
  f.consent.checked = false;
  f.consent.dispatchEvent(event('change'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.state.providerConsent, true);
  assert.equal(f.consent.checked, true, 'the switch matches the stored consent');
  assert.equal(f.summarize.disabled, false);
  assert.equal(f.error.hidden, false);
  assert.match(f.error.textContent, /timed out/);
  f.ui.dispose();
});

test('a successful consent revoke turns Summarize off', async () => {
  const f = await mount((state, { consent }) => { state.providerConsent = consent; return { providerConsent: consent }; });
  f.consent.checked = false;
  f.consent.dispatchEvent(event('change'));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(f.consent.checked, false);
  assert.equal(f.summarize.disabled, true);
  f.ui.dispose();
});
