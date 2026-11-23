// Breezer looks: eight appearance presets chosen in the Settings theme picker.
// Covers the native seed path, Cancel (also after a restart), what pages draw,
// and that the art stays CSS-only with a light and dark variant everywhere.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { APPEARANCE_REV_KEY } from '../../features/ai/extension/workspace-store.js';
import {
  ARTWORK_KEY, LOOK_UNDO_KEY, PREVIOUS_LOOK_KEY, applyThemeLook, applyThemeProposal, cancelThemeLook,
  normalizeThemeProposal, readThemeLook, restorePreviousLook,
} from '../../features/ai/extension/browser-theme.js';
import { THEME_LOOKS, activeLook, applyTheme, startPanelTheme } from '../../features/ai/extension/panel-theme.js';

const extension = new URL('../../features/ai/extension/', import.meta.url);
const read = (name) => readFile(new URL(name, extension), 'utf8');
const IDS = ['charcoal', 'plum', 'sage', 'umber', 'fathom', 'linen', 'lune', 'vesper'];
const settle = () => new Promise((done) => setTimeout(done, 0));

// Follows the native contract: a write naming a stale expectedThemeState is refused.
function fakeApi({ appearance = { theme: 'tide', colorMode: 'dark', themeCanRestore: true }, bridge = true, store = {} } = {}) {
  const calls = [];
  const listeners = [];
  let current = { ...appearance };
  return {
    store, calls,
    get current() { return current; },
    runtime: { sendMessage: async () => {}, onMessage: { addListener() {} } },
    storage: { local: {
      onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} },
      async get(keys) { return Object.fromEntries([keys].flat().filter((key) => key in store).map((key) => [key, structuredClone(store[key])])); },
      async set(values) {
        Object.assign(store, structuredClone(values));
        const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { newValue }]));
        listeners.forEach((fn) => fn(changes));
      },
    } },
    ...(bridge ? { breezerPrivate: {
      getAppearance: async () => ({ ...current }),
      setAppearance: async (patch) => {
        calls.push(patch);
        const { expectedThemeState: expected, ...change } = patch;
        if (expected && (expected.theme !== current.theme || expected.colorMode !== current.colorMode || expected.nativeDefaultTheme !== current.nativeDefaultTheme)) throw new Error('Browser appearance changed. Try again.');
        if (Object.hasOwn(change, 'theme')) delete current.nativeDefaultTheme;
        current = { ...current, ...change };
        return { ...current };
      },
    } } : {}),
  };
}

test('there are eight looks, each with a distinct native seed, name and description', () => {
  assert.deepEqual(Object.keys(THEME_LOOKS), IDS);
  const seeds = IDS.map((id) => THEME_LOOKS[id].seed);
  assert.equal(new Set(seeds).size, IDS.length);
  assert.equal(new Set(IDS.map((id) => THEME_LOOKS[id].name.toLowerCase())).size, IDS.length);
  // A look never shares a name with one of the six tones the picker shows first.
  for (const tone of ['mint', 'tide', 'dusk', 'rose', 'pollen', 'graphite']) assert.ok(!IDS.includes(tone) && !IDS.some((id) => THEME_LOOKS[id].name.toLowerCase() === tone));
  for (const id of IDS) {
    assert.match(THEME_LOOKS[id].seed, /^#[0-9a-f]{6}$/, 'stored lowercase, as the native side reports it');
    assert.ok(THEME_LOOKS[id].name && THEME_LOOKS[id].description);
  }
});

test('a proposal can name a look only with that look’s own seed', () => {
  const plum = THEME_LOOKS.plum;
  assert.equal(normalizeThemeProposal({ name: 'Plum', theme: plum.seed.toUpperCase(), colorMode: 'dark', preset: 'plum' }).preset, 'plum');
  assert.throws(() => normalizeThemeProposal({ name: 'Plum', theme: '#000000', colorMode: 'dark', preset: 'plum' }));
  assert.throws(() => normalizeThemeProposal({ name: 'Neon', theme: plum.seed, colorMode: 'dark', preset: 'neon' }));
  assert.equal('preset' in normalizeThemeProposal({ name: 'A', theme: '#000000', colorMode: 'dark' }), false);
});

test('activeLook needs the record and, with a bridge, the browser still on the seed', () => {
  const record = { name: 'Sage', theme: THEME_LOOKS.sage.seed, colorMode: 'light', preset: 'sage' };
  assert.equal(activeLook(record, THEME_LOOKS.sage.seed.toUpperCase()), 'sage');
  assert.equal(activeLook(record, 'mint'), null, 'picking a tone ends the look');
  assert.equal(activeLook(record, null), 'sage', 'without a bridge the record decides');
  assert.equal(activeLook({ ...record, theme: '#123456' }, '#123456'), null);
  assert.equal(activeLook({ ...record, preset: 'toString' }, null), null);
  assert.equal(activeLook(null, null), null);
});

test('applying a look sets only the seed natively, keeps the colour mode and saves Cancel', async () => {
  const mine = { name: 'Mine', theme: '#336699', colorMode: 'system', html: '<svg></svg>', fingerprint: 'm' };
  const api = fakeApi({ store: { [ARTWORK_KEY]: mine } });
  const result = await applyThemeLook('charcoal', { api, now: () => 7 });
  assert.equal(result.look, 'charcoal');
  assert.equal(result.kept, false);
  assert.deepEqual(api.calls[0], { theme: THEME_LOOKS.charcoal.seed, expectedThemeState: { theme: 'tide', colorMode: 'dark' } });
  assert.equal(api.current.colorMode, 'dark');
  assert.equal(api.store[ARTWORK_KEY].preset, 'charcoal');
  assert.equal(api.store[ARTWORK_KEY].colorMode, 'dark');
  assert.equal('html' in api.store[ARTWORK_KEY], false, 'a look replaces artwork with its own CSS art');
  assert.deepEqual(api.store[LOOK_UNDO_KEY].appearance, { theme: 'tide', colorMode: 'dark' });
  assert.equal(api.store[LOOK_UNDO_KEY].artwork.name, 'Mine');
  assert.equal(api.store[LOOK_UNDO_KEY].previous, null);
  assert.equal(api.store[APPEARANCE_REV_KEY], 7);
  assert.deepEqual(await readThemeLook({ api, theme: api.current.theme }), { look: 'charcoal', canCancel: true });
});

test('switching looks keeps the first starting point; Cancel restores theme, artwork and previous look', async () => {
  const previous = { appearance: { theme: 'rose', colorMode: 'light' }, artwork: null };
  const mine = { name: 'Mine', theme: '#336699', colorMode: 'system', html: '<svg></svg>', fingerprint: 'm' };
  const api = fakeApi({ store: { [ARTWORK_KEY]: mine, [PREVIOUS_LOOK_KEY]: previous } });
  await applyThemeLook('plum', { api });
  await applyThemeLook('umber', { api });
  assert.equal(api.current.theme, THEME_LOOKS.umber.seed);
  assert.equal(api.store[LOOK_UNDO_KEY].appearance.theme, 'tide');
  // The person flips the colour mode while the look is on; Cancel leaves it.
  await api.breezerPrivate.setAppearance({ colorMode: 'light' });
  const result = await cancelThemeLook({ api });
  assert.equal(result.cancelled, true);
  assert.deepEqual({ theme: api.current.theme, colorMode: api.current.colorMode }, { theme: 'tide', colorMode: 'light' });
  assert.equal(api.store[ARTWORK_KEY].name, 'Mine');
  assert.equal(api.store[ARTWORK_KEY].html, '<svg></svg>');
  assert.deepEqual(api.store[PREVIOUS_LOOK_KEY], previous);
  assert.equal(api.store[LOOK_UNDO_KEY], null);
  assert.deepEqual(await readThemeLook({ api, theme: api.current.theme }), { look: null, canCancel: false });
});

test('Cancel survives a restart because everything it needs is in storage.local', async () => {
  const store = {};
  const first = fakeApi({ store, appearance: { theme: 'mint', colorMode: 'system', themeCanRestore: true } });
  await applyThemeLook('sage', { api: first });
  // A new browser session: same profile storage and native state, fresh pages.
  const second = fakeApi({ store, appearance: first.current });
  assert.deepEqual(await readThemeLook({ api: second, theme: second.current.theme }), { look: 'sage', canCancel: true });
  assert.equal((await cancelThemeLook({ api: second })).cancelled, true);
  assert.equal(second.current.theme, 'mint');
});

test('Cancel does nothing once another theme replaced the look', async () => {
  const api = fakeApi();
  await applyThemeLook('plum', { api });
  await api.breezerPrivate.setAppearance({ theme: 'pollen' });
  assert.deepEqual(await cancelThemeLook({ api }), { cancelled: false });
  assert.equal(api.current.theme, 'pollen');
  assert.equal(api.store[LOOK_UNDO_KEY], null);
  // An AI theme also ends the look; its own Restore still works.
  await applyThemeLook('plum', { api });
  await applyThemeProposal({ name: 'Mist', theme: '#99aabb', colorMode: 'light' }, { api, doc: null });
  assert.equal((await readThemeLook({ api, theme: api.current.theme })).look, null);
  assert.equal((await restorePreviousLook({ api })).restored, true);
});

test('a look is refused when the browser cannot restore the current theme', async () => {
  const api = fakeApi({ appearance: { theme: 'tide', colorMode: 'dark', themeCanRestore: false } });
  await assert.rejects(applyThemeLook('umber', { api }), /previous look can be restored/);
  assert.deepEqual(api.calls, []);
  assert.equal(ARTWORK_KEY in api.store, false);
  await assert.rejects(applyThemeLook('neon', { api }), /listed Breezer look/);
});

test('pages mark data-look from the record and the browser seed, and follow changes', async () => {
  const root = { dataset: {}, style: { setProperty() {}, removeProperty() {} }, ownerDocument: null };
  const darkQuery = { matches: true, addEventListener() {} };
  const api = fakeApi();
  await startPanelTheme({ api, root, darkQuery });
  assert.equal(root.dataset.look, undefined);
  await applyThemeLook('charcoal', { api });
  await settle(); await settle();
  assert.equal(root.dataset.look, 'charcoal');
  assert.equal(root.dataset.tone, 'custom');
  assert.equal(root.dataset.scheme, 'dark');
  await api.breezerPrivate.setAppearance({ theme: 'mint' });
  await api.storage.local.set({ [APPEARANCE_REV_KEY]: 2 });
  await settle(); await settle();
  assert.equal(root.dataset.look, undefined, 'a tone picked in Settings ends the look on open pages');
  applyTheme(root, { tone: 'mint', scheme: 'light', look: 'constructor' });
  assert.equal(root.dataset.look, undefined);
});

test('every look has light and dark tokens in New Tab, the panel and the picker, drawn without resources', async () => {
  const [newtab, panel, settings] = await Promise.all([read('newtab.css'), read('panel.css'), read('settings.css')]);
  for (const id of IDS) {
    for (const scheme of ['light', 'dark']) {
      assert.match(newtab, new RegExp(`:root\\[data-look="${id}"\\]\\[data-scheme="${scheme}"\\] \\{[^}]*--canvas:[^}]*--look-field:`), `newtab ${id} ${scheme}`);
      assert.match(panel, new RegExp(`:root\\[data-look="${id}"\\]\\[data-scheme="${scheme}"\\] \\{[^}]*--page:`), `panel ${id} ${scheme}`);
    }
    assert.match(newtab, new RegExp(`:root\\[data-look="${id}"\\]:not\\(\\[data-artwork="on"\\]\\) body::after`), `newtab art ${id}`);
    assert.match(settings, new RegExp(`\\.look-preview\\[data-look="${id}"\\]`), `picker ${id}`);
  }
  for (const [name, css] of [['newtab', newtab], ['panel', panel], ['settings', settings]]) {
    const looks = css.slice(css.search(/Breezer looks/));
    assert.ok(looks.length > 500, `${name} has a looks block`);
    assert.doesNotMatch(looks, /url\(|@import|@font-face|image-set/, `${name} looks load nothing`);
  }
  // The compact Home is tuned for every look, and the default and forced-colour paths stay safe.
  assert.match(newtab, /:root:where\(\[data-look\]\)\[data-composer="on"\] \.composer-box/);
  assert.match(newtab, /@media \(forced-colors: active\) \{\s*:root\[data-look\] body \{ background: Canvas; \}/);
  assert.match(newtab, /prefers-reduced-transparency: reduce/);
});

test('Lune draws a shaded moon whose shadow edge is a halftone stipple, in both schemes', async () => {
  const [newtab, panel, settings] = await Promise.all([read('newtab.css'), read('panel.css'), read('settings.css')]);
  for (const [name, css] of [['newtab', newtab], ['panel', panel], ['settings', settings]]) {
    const looks = css.slice(css.search(/Breezer looks/));
    // The stipple is a dot screen thresholded by contrast() and kept to the shadow edge by a mask.
    assert.match(looks, /data-look="lune"\][^{]*::after \{[^}]*radial-gradient\(closest-side[^}]*background-blend-mode: screen, multiply, normal;[^}]*filter: var\(--moon-dots-filter\);[^}]*mask-image: radial-gradient/, `${name} stipple`);
    assert.match(looks, /data-look="lune"\][^{]*::before[^{]*\{[^}]*var\(--moon-lit\)/, `${name} disc`);
  }
  for (const scheme of ['light', 'dark']) {
    for (const token of ['--moon-lit', '--moon-mid', '--moon-dots-blend', '--moon-dots-filter', '--moon-dots-opacity']) {
      assert.match(newtab, new RegExp(`:root\\[data-look="lune"\\]\\[data-scheme="${scheme}"\\] \\{[^}]*${token}:`), `newtab ${scheme} ${token}`);
      assert.match(panel, new RegExp(`:root\\[data-look="lune"\\]\\[data-scheme="${scheme}"\\] \\{[^}]*${token}:`), `panel ${scheme} ${token}`);
    }
  }
  // Light scheme inverts the stipple to dark dots instead of white ones.
  assert.match(newtab, /data-look="lune"\]\[data-scheme="light"\] \{[^}]*--moon-dots-filter: contrast\(18\) invert\(1\)/);
  // No generated text: the moon is drawn, not typed.
  assert.doesNotMatch(newtab.slice(newtab.indexOf('/* Lune:')), /content: "[^"]/);
});

test('looks add no extension resources', async () => {
  const files = (await readdir(extension, { recursive: true, withFileTypes: true })).filter((entry) => entry.isFile());
  assert.ok(files.length <= 64, `${files.length} extension resources, limit 64`);
});
