// The four Breezer looks in the Settings theme picker, against the fake DOM
// and a breezerPrivate stand-in that follows the native compare-and-set rule.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storageBus } from './storage-bus.mjs';
import { createDom, userClick, userKey } from './settings-dom.mjs';
import { DEFAULT_APPEARANCE, WorkspaceStore, normalizeAppearance, validateAppearancePatch } from '../../features/ai/extension/workspace-store.js';
import { THEME_LOOKS } from '../../features/ai/extension/panel-theme.js';
import { ARTWORK_KEY, LOOK_UNDO_KEY } from '../../features/ai/extension/browser-theme.js';

const html = readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8');
const { mountSettings } = await import('../../features/ai/extension/settings.js');
const settle = async (rounds = 10) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

async function openSettings({ appearance = {}, local = {} } = {}) {
  const dom = createDom(html);
  Object.assign(globalThis, dom.globals);
  const bus = storageBus();
  const storage = bus.context('settings');
  for (const area of ['local', 'session']) { const set = storage[area].set; storage[area].set = async (values) => { await set(values); setTimeout(() => { void bus.flush(); }, 0); }; }
  if (Object.keys(local).length) await storage.local.set(local);
  const native = { ...DEFAULT_APPEARANCE, themeCanRestore: true, ...appearance };
  const calls = [];
  const breezerPrivate = {
    async getAppearance() { return { ...native }; },
    async setAppearance(patch) {
      calls.push(patch);
      const { expectedThemeState: expected, ...change } = patch;
      if (expected && (expected.theme !== native.theme || expected.colorMode !== native.colorMode)) throw new Error('Browser appearance changed. Try again.');
      Object.assign(native, validateAppearancePatch(change));
      return { ...native };
    },
  };
  const api = { storage, breezerPrivate, runtime: {}, tabs: { query: async () => [{ index: 0, windowId: 1 }], create: async (props) => props } };
  const locks = { tail: Promise.resolve(), request(_name, fn) { const run = this.tail.then(fn); this.tail = run.catch(() => {}); return run; } };
  const workspace = new WorkspaceStore({ storage, locks, makeToken: () => 'session-test' });
  const callBridge = (name, ...args) => breezerPrivate[name](...args);
  await mountSettings({
    api, workspace, callBridge,
    loadAppearance: async () => ({ appearance: normalizeAppearance(await breezerPrivate.getAppearance()), available: true, error: '' }),
    applyAppearance: (value) => { dom.document.documentElement.dataset.tone = value.theme; },
    darkQuery: { matches: false, addEventListener() {} },
  });
  await settle();
  const swatches = dom.document.getElementById('theme-swatches');
  const look = (id) => swatches.querySelector(`[data-value="look:${id}"]`);
  const status = () => dom.document.querySelector('.look-status');
  const cancel = () => dom.document.querySelector('.look-cancel');
  return { ...dom, storage, native, bridge: breezerPrivate, calls, swatches, look, status, cancel };
}

test('the theme picker offers the eight looks after the tones, in one radio group', async () => {
  const page = await openSettings();
  const radios = page.swatches.querySelectorAll('[role="radio"]');
  assert.equal(radios.length, 14);
  assert.deepEqual(radios.slice(6).map((radio) => radio.dataset.value), ['charcoal', 'plum', 'sage', 'umber', 'fathom', 'linen', 'lune', 'vesper'].map((id) => `look:${id}`));
  for (const id of Object.keys(THEME_LOOKS)) {
    assert.equal(page.look(id).getAttribute('aria-checked'), 'false');
    assert.equal(page.look(id).querySelector('.look-preview').dataset.look, id);
    assert.match(page.look(id).textContent, new RegExp(THEME_LOOKS[id].name));
  }
  assert.equal(page.status().hidden, true);
  assert.equal(page.swatches.querySelector('[data-value="mint"]').getAttribute('aria-checked'), 'true');
});

test('choosing a look applies its seed, keeps the mode, and Cancel restores the earlier theme and art', async () => {
  const mine = { name: 'Mine', theme: '#336699', colorMode: 'system', html: '<svg></svg>', fingerprint: 'mine' };
  const page = await openSettings({ appearance: { theme: 'rose', colorMode: 'dark' }, local: { [ARTWORK_KEY]: mine } });
  userClick(page.look('umber'));
  await settle();
  assert.equal(page.native.theme, THEME_LOOKS.umber.seed);
  assert.equal(page.native.colorMode, 'dark');
  assert.equal(page.look('umber').getAttribute('aria-checked'), 'true');
  assert.equal(page.swatches.querySelector('[data-value="rose"]').getAttribute('aria-checked'), 'false');
  assert.equal(page.status().hidden, false);
  assert.match(page.status().textContent, /Umber is on/);
  assert.equal(page.document.getElementById('custom-theme-apply').getAttribute('aria-pressed'), 'false');
  const stored = await page.storage.local.get([ARTWORK_KEY, LOOK_UNDO_KEY]);
  assert.equal(stored[ARTWORK_KEY].preset, 'umber');
  assert.equal(stored[LOOK_UNDO_KEY].appearance.theme, 'rose');

  userClick(page.cancel());
  await settle();
  assert.equal(page.native.theme, 'rose');
  assert.equal(page.status().hidden, true);
  assert.equal(page.swatches.querySelector('[data-value="rose"]').getAttribute('aria-checked'), 'true');
  const after = await page.storage.local.get([ARTWORK_KEY]);
  assert.equal(after[ARTWORK_KEY].name, 'Mine');
  assert.equal(after[ARTWORK_KEY].html, '<svg></svg>');
});

test('arrow keys move from the tones into the looks, and a tone ends the look', async () => {
  const page = await openSettings({ appearance: { theme: 'graphite' } });
  page.swatches.querySelector('[data-value="graphite"]').focus();
  userKey(page.document, 'ArrowRight');
  await settle();
  assert.equal(page.native.theme, THEME_LOOKS.charcoal.seed);
  assert.equal(page.look('charcoal').tabIndex, 0);
  userClick(page.swatches.querySelector('[data-value="tide"]'));
  await settle();
  assert.equal(page.native.theme, 'tide');
  assert.equal(page.look('charcoal').getAttribute('aria-checked'), 'false');
  assert.equal(page.status().hidden, true, 'nothing left to cancel once a tone is chosen');
});

test('a reopened Settings page shows the active look and can still cancel it', async () => {
  const first = await openSettings({ appearance: { theme: 'mint', colorMode: 'light' } });
  userClick(first.look('sage'));
  await settle();
  const local = await first.storage.local.get([ARTWORK_KEY, LOOK_UNDO_KEY]);
  const page = await openSettings({ appearance: { theme: THEME_LOOKS.sage.seed, colorMode: 'light' }, local });
  assert.equal(page.look('sage').getAttribute('aria-checked'), 'true');
  assert.equal(page.cancel().hidden, false);
  userClick(page.cancel());
  await settle();
  assert.equal(page.native.theme, 'mint');
});

test('explicit colors retire the old look and Cancel, including a matching seed', async () => {
  for (const switchTone of [false, true]) {
    const page = await openSettings({ appearance: { theme: 'rose' } });
    userClick(page.look('plum'));
    await settle();
    const custom = page.document.getElementById('custom-theme-color');
    assert.equal(custom.value, THEME_LOOKS.plum.seed);
    if (switchTone) {
      userClick(page.swatches.querySelector('[data-value="tide"]'));
      await settle();
      assert.equal(page.native.theme, 'tide');
    }
    userClick(page.document.getElementById('custom-theme-apply'));
    await settle();
    assert.equal(page.native.theme, THEME_LOOKS.plum.seed);
    assert.equal(page.look('plum').getAttribute('aria-checked'), 'false');
    assert.equal(page.status().hidden, true);
    assert.deepEqual(await page.storage.local.get([ARTWORK_KEY, LOOK_UNDO_KEY]), { [ARTWORK_KEY]: null, [LOOK_UNDO_KEY]: null });
  }
});

test('the last keyboard choice wins even while a regular color is saving', async () => {
  const page = await openSettings({ appearance: { theme: 'pollen' } });
  const apply = page.bridge.setAppearance;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  page.bridge.setAppearance = async patch => {
    if (patch.theme === 'graphite') await pending;
    return apply(patch);
  };
  page.swatches.querySelector('[data-value="pollen"]').focus();
  userKey(page.document, 'ArrowRight');
  userKey(page.document, 'ArrowRight');
  assert.equal(page.document.activeElement, page.look('charcoal'));
  assert.equal(page.native.theme, 'pollen');
  release();
  await settle();
  assert.equal(page.native.theme, THEME_LOOKS.charcoal.seed);
  assert.equal(page.look('charcoal').getAttribute('aria-checked'), 'true');
});

test('Cancel waits for a pending appearance write and preserves the chosen mode', async () => {
  const page = await openSettings({ appearance: { theme: 'rose', colorMode: 'light' } });
  userClick(page.look('umber'));
  await settle();
  const apply = page.bridge.setAppearance;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  page.bridge.setAppearance = async patch => {
    if (!patch.theme && patch.colorMode === 'dark') await pending;
    return apply(patch);
  };
  userClick(page.document.querySelector('[data-field="colorMode"] [data-value="dark"]'));
  userClick(page.cancel());
  assert.equal(page.native.theme, THEME_LOOKS.umber.seed);
  release();
  await settle();
  assert.equal(page.native.theme, 'rose');
  assert.equal(page.native.colorMode, 'dark');
  assert.equal(page.status().hidden, true);
});
