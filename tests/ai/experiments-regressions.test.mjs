import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDom, userClick } from './settings-dom.mjs';
import {
  EXPERIMENTS_KEY, PERSONALITIES, applyPersonalityLook, mountExperimentSettings, readExperiments,
} from '../../features/ai/extension/experiments.js';
import { ARTWORK_KEY, applyThemeColor } from '../../features/ai/extension/browser-theme.js';

const html = readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeApi({ getDelay = 0, setDelay = 0 } = {}) {
  const data = {};
  const listeners = [];
  const onChanged = { addListener: (fn) => listeners.push(fn), removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1) };
  const local = {
    async get(key) { return key == null ? structuredClone(data) : Object.fromEntries([key].flat().filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
      for (const fn of [...listeners]) fn(changes, 'local');
    },
    onChanged,
  };
  const state = { appearance: { theme: 'mint', colorMode: 'system', themeCanRestore: true } };
  const api = {
    storage: { local, onChanged },
    runtime: {},
    breezerPrivate: {
      async getAppearance() { if (getDelay) await delay(getDelay); return structuredClone(state.appearance); },
      async setAppearance(patch) {
        if (setDelay) await delay(setDelay);
        const { expectedThemeState, ...rest } = patch;
        state.appearance = { ...state.appearance, ...rest };
        return structuredClone(state.appearance);
      },
    },
  };
  return { api, data, state };
}

test('Standard keeps a colour the person picked after a personality look', async () => {
  const { api, data, state } = fakeApi();
  assert.deepEqual(await applyPersonalityLook(api, 'warm'), { colors: 'applied' });
  await applyThemeColor('#123456', { api });
  assert.equal(state.appearance.theme, '#123456');
  assert.ok(data[ARTWORK_KEY], 'the personality record is still stored');
  assert.deepEqual(await applyPersonalityLook(api, 'off'), { colors: 'unchanged' });
  assert.equal(state.appearance.theme, '#123456', 'the person’s colour is not restored away');
  // Another preset leaves the person’s colour alone too.
  assert.equal((await applyPersonalityLook(api, 'direct')).colors, 'kept');
  assert.equal(state.appearance.theme, '#123456');
});

test('quick personality choices settle on the last one chosen', async () => {
  const dom = createDom(html);
  Object.assign(globalThis, dom.globals);
  globalThis.window = dom.window;
  const { api, data, state } = fakeApi({ getDelay: 5, setDelay: 20 });
  const container = dom.document.createElement('div');
  dom.document.body.append(container);
  const ui = await mountExperimentSettings({ container, api });
  const radio = (id) => container.querySelector(`[role="radio"][data-value="${id}"]`);
  userClick(radio('concise'));
  await delay(1);
  userClick(radio('off'));
  assert.equal(radio('off').getAttribute('aria-checked'), 'true', 'the latest choice shows at once');
  await delay(300);
  assert.equal((await readExperiments(api)).personality, 'off');
  assert.equal(data[EXPERIMENTS_KEY].personality, 'off');
  assert.equal(state.appearance.theme, 'mint', 'the earlier look is restored');
  assert.notEqual(state.appearance.theme, PERSONALITIES.concise.seed);
  assert.equal(radio('off').getAttribute('aria-checked'), 'true');
  assert.equal(radio('concise').getAttribute('aria-checked'), 'false');
  ui.dispose();
});

test('Standard keeps a picked colour when the browser theme cannot be read', async () => {
  const { api, state } = fakeApi();
  assert.deepEqual(await applyPersonalityLook(api, 'warm'), { colors: 'applied' });
  await applyThemeColor('#123456', { api });
  const getAppearance = api.breezerPrivate.getAppearance;
  let failures = 1;
  api.breezerPrivate.getAppearance = async () => { if (failures-- > 0) throw new Error('bridge busy'); return getAppearance(); };
  assert.deepEqual(await applyPersonalityLook(api, 'off'), { colors: 'unchanged' });
  assert.equal(state.appearance.theme, '#123456');
});
