import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate } from 'node:timers/promises';
import {
  DEFAULT_EXPERIMENTS, EXPERIMENTS_KEY, PERSONALITIES, applyGlassMaterial, applyPersonality, applyPersonalityLook,
  glassMode, glassSupport, handoffKey, installNativeAddressExperiments, normalizeExperiments, personalityThemeName, pickRecentChats,
  readExperiments, validateExperimentsPatch, watchExperiments, writeExperiments,
} from '../../features/ai/extension/experiments.js';
import { toAddress } from '../../features/ai/extension/newtab.js';
import { ARTWORK_KEY, PREVIOUS_LOOK_KEY } from '../../features/ai/extension/browser-theme.js';

function storage(initial = {}) {
  const data = structuredClone(initial);
  const listeners = [];
  const local = {
    async get(key) { return key == null ? structuredClone(data) : Object.fromEntries([key].flat().filter((k) => k in data).map((k) => [k, structuredClone(data[k])])); },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
      for (const fn of listeners) fn(changes, 'local');
    },
    onChanged: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => listeners.splice(listeners.indexOf(fn), 1) },
  };
  return { data, api: { storage: { local, onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} } } } };
}

test('every experiment defaults to off and damaged records read as off', () => {
  assert.deepEqual(normalizeExperiments(undefined), DEFAULT_EXPERIMENTS);
  assert.deepEqual(normalizeExperiments({ glass: 'yes', spaceDock: 1, personality: 'loud', extra: true }), DEFAULT_EXPERIMENTS);
  for (const [key, value] of Object.entries(DEFAULT_EXPERIMENTS)) if (key !== 'version' && key !== 'glassOpacity') assert.ok(value === false || value === 'off', key);
  assert.deepEqual(Object.keys(DEFAULT_EXPERIMENTS).sort(), ['glass', 'glassOpacity', 'newTabComposer', 'newTabRecentChats', 'newTabShortcuts', 'personality', 'sidebarSearch', 'spaceDock', 'version']);
});

test('glass opacity preserves the old appearance and accepts both endpoints', async () => {
  const { api } = storage({ [EXPERIMENTS_KEY]: { glass: true } });
  assert.equal((await readExperiments(api)).glassOpacity, 66);
  await writeExperiments(api, { glassOpacity: 0 });
  await writeExperiments(api, { glass: false });
  assert.equal((await readExperiments(api)).glassOpacity, 0);
  assert.equal((await writeExperiments(api, { glassOpacity: 100 })).glassOpacity, 100);
  assert.equal(normalizeExperiments({ glassOpacity: '40' }).glassOpacity, 66);
  for (const value of [-1, 101, 30.5, '50']) assert.throws(() => validateExperimentsPatch({ glassOpacity: value }), /opacity/i);
});

test('patches accept only known flags and presets', () => {
  assert.deepEqual(validateExperimentsPatch({ spaceDock: true, personality: 'tutor' }), { spaceDock: true, personality: 'tutor' });
  assert.throws(() => validateExperimentsPatch({ spaceDock: 'true' }), /on or off/);
  assert.throws(() => validateExperimentsPatch({ personality: 'pirate' }), /listed personality/);
  assert.throws(() => validateExperimentsPatch({ sidebarAddress: true }), /Unknown experiment/);
});

test('writes merge with the stored record and reach watchers', async () => {
  const { api, data } = storage({ [EXPERIMENTS_KEY]: { sidebarSearch: true } });
  const seen = [];
  const stop = watchExperiments(api, (next) => seen.push(next));
  await writeExperiments(api, { spaceDock: true });
  assert.equal(data[EXPERIMENTS_KEY].sidebarSearch, true);
  assert.equal(data[EXPERIMENTS_KEY].spaceDock, true);
  assert.equal((await readExperiments(api)).glass, false);
  assert.equal(seen.at(-1).spaceDock, true);
  stop();
  assert.equal((await readExperiments({})).spaceDock, false);
});

test('address experiments reconcile saved profiles and rapid changes without rewriting the pin', async () => {
  const { api } = storage({ [EXPERIMENTS_KEY]: { sidebarSearch: true, newTabComposer: true } });
  const appearance = { alwaysShowTopBar: true, sidebarAddressSearch: false, newTabComposer: false };
  const writes = [];
  const writing = Promise.withResolvers();
  const release = Promise.withResolvers();
  api.breezerPrivate = {
    async getAppearance() { return { ...appearance }; },
    async setAppearance(patch) {
      writes.push(patch);
      writing.resolve();
      await release.promise;
      Object.assign(appearance, patch);
    },
  };
  const startup = installNativeAddressExperiments(api);
  await writing.promise;
  await writeExperiments(api, { sidebarSearch: false });
  await writeExperiments(api, { sidebarSearch: true });
  await writeExperiments(api, { sidebarSearch: false, spaceDock: true });
  release.resolve();
  await startup;
  await setImmediate();
  assert.deepEqual(appearance, { alwaysShowTopBar: true, sidebarAddressSearch: false, newTabComposer: true });
  assert.deepEqual(writes, [{ sidebarAddressSearch: true, newTabComposer: true }, { sidebarAddressSearch: false }]);
  await writeExperiments(api, { newTabComposer: false });
  await setImmediate();
  assert.deepEqual(writes.at(-1), { newTabComposer: false });
  await writeExperiments(api, { glass: true });
  await setImmediate();
  assert.equal(writes.length, 3);
});

test('personality adds one reply-style line to the profile context only when chosen', () => {
  const profile = { name: 'Sam', context: 'Year 10 student.' };
  assert.deepEqual(applyPersonality(profile, { personality: 'off' }), profile);
  const brief = applyPersonality(profile, { personality: 'concise' });
  assert.equal(brief.name, 'Sam');
  assert.match(brief.context, /^Year 10 student\.\n\nReply style chosen in Breezer settings: Keep replies short/);
  assert.match(applyPersonality({}, { personality: 'direct' }).context, /^Reply style chosen in Breezer settings: Be direct/);
  for (const [id, preset] of Object.entries(PERSONALITIES)) {
    if (id === 'off') assert.equal(preset.seed, undefined);
    else assert.match(preset.seed, /^#[0-9a-f]{6}$/, id);
  }
});

test('recent chats come from open windows only, current window first, at most three', () => {
  const convo = (text, reply) => [{ role: 'user', text }, ...(reply ? [{ role: 'assistant', text: reply }] : [])];
  const saved = {
    'breezer-conversation-1': convo('Plan my  essay\nintro', 'Start with a hook.'),
    'breezer-conversation-2': convo('Older window question'),
    'breezer-conversation-3': convo('Newest window', 'Sure.'),
    'breezer-conversation-4': convo('Newer still'),
    'breezer-conversation-9': convo('Closed window'),
    'breezer-conversation-5': [{ role: 'assistant', text: 'No question' }],
    'breezer-handoff-1': { prompt: 'x' },
  };
  const windows = [1, 2, 3, 4, 5].map((id) => ({ id, type: 'normal' })).concat({ id: 7, type: 'popup' });
  const chats = pickRecentChats(saved, windows, 1);
  assert.deepEqual(chats.map((chat) => chat.windowId), [1, 4, 3]);
  assert.equal(chats[0].title, 'Plan my essay intro');
  assert.equal(chats[0].preview, 'Start with a hook.');
  assert.equal(chats[0].current, true);
  assert.deepEqual(pickRecentChats(saved, [], 1), []);
  assert.equal(handoffKey(12), 'breezer-handoff-12');
});

test('glass is solid in fullscreen, with reduced transparency, or when off', () => {
  assert.equal(glassMode({ enabled: true }), 'glass');
  assert.equal(glassMode({ enabled: true, fullscreen: true }), 'solid');
  assert.equal(glassMode({ enabled: true, reducedTransparency: true }), 'solid');
  assert.equal(glassMode({ enabled: false }), 'solid');
});

test('native glass is used only when the appearance bridge reports nativeGlass', async () => {
  const calls = [];
  const bridge = (appearance, fail = false) => ({
    runtime: {},
    storage: { local: { async set(values) { calls.push(['rev', Object.keys(values)]); } } },
    breezerPrivate: {
      async getAppearance() { return appearance; },
      async setAppearance(patch) { calls.push(['set', patch]); if (fail) throw new Error('AppKit refused'); return appearance; },
    },
  });
  assert.deepEqual(await glassSupport(bridge({ theme: 'mint' })), { native: false, on: false });
  assert.equal(await applyGlassMaterial(bridge({ theme: 'mint' }), true), false);
  assert.deepEqual(calls, []);
  assert.deepEqual(await glassSupport(bridge({ nativeGlass: false })), { native: true, on: false });
  assert.equal(await applyGlassMaterial(bridge({ nativeGlass: false }), true), true);
  assert.deepEqual(calls[0], ['set', { nativeGlass: true }]);
  await assert.rejects(applyGlassMaterial(bridge({ nativeGlass: false }, true), true), /AppKit refused/);
});

test('personality looks recolor through the theme path and never replace a person’s own theme', async () => {
  const { api, data } = storage();
  let appearance = { theme: 'mint', colorMode: 'system', themeCanRestore: true };
  api.runtime = {};
  api.breezerPrivate = {
    async getAppearance() { return structuredClone(appearance); },
    async setAppearance(patch) { const { expectedThemeState, ...rest } = patch; appearance = { ...appearance, ...rest }; return structuredClone(appearance); },
  };
  assert.deepEqual(await applyPersonalityLook(api, 'off'), { colors: 'unchanged' });
  assert.deepEqual(await applyPersonalityLook(api, 'warm'), { colors: 'applied' });
  assert.equal(appearance.theme, PERSONALITIES.warm.seed);
  assert.equal(data[ARTWORK_KEY].name, personalityThemeName('warm'));
  assert.equal(data[PREVIOUS_LOOK_KEY].appearance.theme, 'mint');
  assert.deepEqual(await applyPersonalityLook(api, 'direct'), { colors: 'applied' });
  assert.equal(data[PREVIOUS_LOOK_KEY].appearance.theme, 'mint', 'switching presets keeps the original look');
  assert.deepEqual(await applyPersonalityLook(api, 'off'), { colors: 'restored' });
  assert.equal(appearance.theme, 'mint');
  // A theme the person applied is left alone, both when choosing and when leaving a preset.
  await api.storage.local.set({ [ARTWORK_KEY]: { name: 'My sunset', theme: '#aa5500', colorMode: 'dark' } });
  appearance.theme = '#aa5500';
  const kept = await applyPersonalityLook(api, 'tutor');
  assert.equal(kept.colors, 'kept');
  assert.equal(appearance.theme, '#aa5500');
  assert.deepEqual(await applyPersonalityLook(api, 'off'), { colors: 'unchanged' });
  assert.deepEqual(await applyPersonalityLook({ storage: api.storage }, 'tutor'), { colors: 'unavailable' });
});

test('the New Tab box opens only single web addresses directly', () => {
  assert.equal(toAddress('example.com'), 'https://example.com/');
  assert.equal(toAddress('docs.example.org/path?q=1'), 'https://docs.example.org/path?q=1');
  assert.equal(toAddress('localhost:3000'), 'http://localhost:3000/');
  assert.equal(toAddress('http://intranet.test/a'), 'http://intranet.test/a');
  for (const text of ['what is example.com', 'javascript:alert(1)', 'chrome://settings', 'file:///etc/passwd', 'hello', 'data:text/html,x', '']) {
    assert.equal(toAddress(text), null, text);
  }
});
