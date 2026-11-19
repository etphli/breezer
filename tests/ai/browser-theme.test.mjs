import test from 'node:test';
import assert from 'node:assert/strict';
import { APPEARANCE_REV_KEY } from '../../features/ai/extension/workspace-store.js';
import {
  ARTWORK_CSP, ARTWORK_KEY, PREVIOUS_LOOK_KEY, applyThemeProposal, artworkDocument, normalizeThemeProposal,
  normalizeThemeImage, readThemeState, restorePreviousLook, sanitizeCss,
} from '../../features/ai/extension/browser-theme.js';
import { THEME_REFRESH_MESSAGE, startPanelTheme } from '../../features/ai/extension/panel-theme.js';

// Smallest valid files of each type, as the panel would attach them.
export const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const JPEG = `data:image/jpeg;base64,${Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1]).toString('base64')}`;
const WEBP = `data:image/webp;base64,${Buffer.from('RIFF\x1a\x00\x00\x00WEBPVP8L', 'latin1').toString('base64')}`;

// setAppearance follows the native contract: expectedThemeState must match the
// browser's current restorable theme exactly, or nothing changes.
function fakeApi({ appearance = { theme: 'tide', colorMode: 'light', themeCanRestore: true }, bridge = true, rejectSet = false } = {}) {
  const store = {};
  const calls = [];
  const messages = [];
  let current = { ...appearance };
  return {
    store, calls, messages,
    get current() { return current; },
    set current(value) { current = { ...current, ...value }; },
    runtime: { sendMessage: async (message) => { messages.push(message); } },
    storage: { local: {
      onChanged: { addListener() {}, removeListener() {} },
      async get(keys) { return Object.fromEntries([keys].flat().filter((key) => key in store).map((key) => [key, structuredClone(store[key])])); },
      async set(values) { Object.assign(store, structuredClone(values)); },
      async remove(key) { delete store[key]; },
    } },
    ...(bridge ? { breezerPrivate: {
      getAppearance: async () => ({ ...current }),
      setAppearance: async (patch) => {
        calls.push(patch);
        if (rejectSet) throw new Error('Nope');
        const { expectedThemeState: expected, ...change } = patch;
        if (expected && (!current.themeCanRestore || expected.theme !== current.theme || expected.colorMode !== current.colorMode || expected.nativeDefaultTheme !== current.nativeDefaultTheme)) throw new Error('Browser appearance changed. Try again.');
        if (Object.hasOwn(change, 'theme')) delete current.nativeDefaultTheme;
        current = { ...current, ...change };
        return { ...current };
      },
    } } : {}),
  };
}

test('normalizeThemeProposal accepts the contract and rejects everything else', () => {
  assert.deepEqual(normalizeThemeProposal({ name: '  Night   tide ', theme: '#1A2B3C', colorMode: 'dark', extra: 1 }), { name: 'Night tide', theme: '#1a2b3c', colorMode: 'dark' });
  assert.equal(normalizeThemeProposal({ name: 'A', theme: '#000000', colorMode: 'system', html: '<svg></svg>' }).html, '<svg></svg>');
  assert.equal('html' in normalizeThemeProposal({ name: 'A', theme: '#000000', colorMode: 'light', html: '   ' }), false);
  for (const bad of [null, [], {}, { name: 'A', theme: 'red', colorMode: 'dark' }, { name: 'A', theme: '#abc', colorMode: 'dark' },
    { name: 'A', theme: '#000000', colorMode: 'dim' }, { name: '', theme: '#000000', colorMode: 'dark' },
    { name: 'x'.repeat(49), theme: '#000000', colorMode: 'dark' }, { name: 'A', theme: '#000000', colorMode: 'dark', html: 5 },
    { name: 'A', theme: '#000000', colorMode: 'dark', html: 'x'.repeat(40001) }]) {
    assert.throws(() => normalizeThemeProposal(bad), undefined, JSON.stringify(bad)?.slice(0, 80));
  }
  assert.equal(normalizeThemeProposal({ name: 'x'.repeat(48), theme: '#000000', colorMode: 'dark', html: 'x'.repeat(40000) }).name.length, 48);
});

test('sanitizeCss removes every way to load or escape, and keeps animation', () => {
  const css = sanitizeCss(`
    @import url(https://evil.example/a.css);
    @font-face { font-family: x; src: url(https://evil.example/f.woff); }
    @keyframes drift { from { transform: translateX(0) } to { transform: translateX(10px) } }
    .a { background: url("https://evil.example/p.png"); fill: url(#glow); animation: drift 9s infinite !important; }
    .b { background-image: image-set("x.png" 1x); mask: -webkit-image-set("y.png" 1x); }
    .c { background: u\\72l(https://evil.example/q); }
    .d::before { content: "Sign in"; }  .e::after { content: ""; }
    .f { behavior: url(x.htc); -moz-binding: url(y); }
    </style><script>alert(1)</script>
  `);
  assert.doesNotMatch(css, /url\((?!#glow\))|@import|@font-face|!important|image-set|<|\\|Sign in|behavior|-moz-binding/);
  assert.match(css, /@keyframes drift/);
  assert.match(css, /fill: url\(#glow\)/);
  assert.doesNotMatch(css.replace('u72l(https://evil.example/q)', ''), /evil/, 'only the inert, de-escaped remnant is left');
  assert.match(css, /content:""/);
  assert.equal(sanitizeCss(42), '');
});

test('the artwork document puts the fixed CSP before any artwork and reduced motion after it', () => {
  const doc = artworkDocument('<div class="x"></div>');
  assert.ok(doc.indexOf(ARTWORK_CSP) < doc.indexOf('<div class="x">'));
  assert.ok(doc.lastIndexOf('prefers-reduced-motion') > doc.indexOf('<div class="x">'));
  assert.match(ARTWORK_CSP, /default-src 'none'/);
  assert.doesNotMatch(ARTWORK_CSP, /script-src 'unsafe|https?:/);
});

test('apply sets the native seed and mode, keeps the earlier look once, and restore returns to it', async () => {
  const api = fakeApi();
  const first = await applyThemeProposal({ name: 'Ember', theme: '#C2410C', colorMode: 'dark' }, { api, now: () => 10 });
  assert.equal(first.native, true);
  assert.deepEqual(api.calls, [{ theme: '#c2410c', colorMode: 'dark', expectedThemeState: { theme: 'tide', colorMode: 'light' } }]);
  assert.deepEqual(api.store[PREVIOUS_LOOK_KEY], { appearance: { theme: 'tide', colorMode: 'light' }, artwork: null });
  assert.equal(api.store[APPEARANCE_REV_KEY], 10);
  assert.equal(api.store[ARTWORK_KEY].name, 'Ember');

  await applyThemeProposal({ name: 'Moss', theme: '#15803d', colorMode: 'light' }, { api, now: () => 11 });
  assert.deepEqual(api.store[PREVIOUS_LOOK_KEY].appearance, { theme: 'tide', colorMode: 'light' }, 'still the look from before the first AI theme');
  assert.equal((await readThemeState({ api })).applied.name, 'Moss');
  assert.equal((await readThemeState({ api })).canRestore, true);

  const restored = await restorePreviousLook({ api, now: () => 12 });
  assert.equal(restored.restored, true);
  assert.deepEqual(api.calls.at(-1), { theme: 'tide', colorMode: 'light', expectedThemeState: { theme: '#15803d', colorMode: 'light' } });
  assert.equal(api.store[ARTWORK_KEY], null);
  assert.equal(api.store[PREVIOUS_LOOK_KEY], null);
  assert.equal(api.store[APPEARANCE_REV_KEY], 12);
  assert.deepEqual(await restorePreviousLook({ api }), { restored: false });
});

test('a rejected native change stores nothing and leaves nothing to restore', async () => {
  const api = fakeApi({ rejectSet: true });
  await assert.rejects(applyThemeProposal({ name: 'Ember', theme: '#c2410c', colorMode: 'dark' }, { api }), /Nope/);
  assert.deepEqual(api.store, {});
});

test('apply and restore preserve a native default theme and its visible palette', async () => {
  for (const nativeDefaultTheme of ['grayscale', 'baseline']) {
    const previous = { theme: 'mint', colorMode: 'system', nativeDefaultTheme };
    const api = fakeApi({ appearance: { ...previous, themeCanRestore: true } });
    const proposal = { name: 'Ember', theme: '#c2410c', colorMode: 'dark' };
    await applyThemeProposal(proposal, { api });
    assert.deepEqual(api.calls[0].expectedThemeState, previous);
    assert.deepEqual(api.store[PREVIOUS_LOOK_KEY].appearance, previous);
    assert.equal(api.current.nativeDefaultTheme, undefined);

    assert.equal((await restorePreviousLook({ api })).restored, true);
    assert.deepEqual(api.calls.at(-1), {
      ...previous,
      expectedThemeState: { theme: proposal.theme, colorMode: proposal.colorMode },
    });
    assert.deepEqual(api.current, { ...previous, themeCanRestore: true });
  }
});

test('selecting seeded Mint while a native default is read prevents the proposal from replacing it', async () => {
  const api = fakeApi({ appearance: { theme: 'mint', colorMode: 'system', nativeDefaultTheme: 'grayscale', themeCanRestore: true } });
  const get = api.breezerPrivate.getAppearance;
  api.breezerPrivate.getAppearance = async () => {
    const value = await get();
    api.current = { nativeDefaultTheme: undefined };
    return value;
  };
  await assert.rejects(applyThemeProposal({ name: 'Ember', theme: '#c2410c', colorMode: 'dark' }, { api }), /appearance changed/);
  assert.deepEqual(api.current, { theme: 'mint', colorMode: 'system', nativeDefaultTheme: undefined, themeCanRestore: true });
  assert.deepEqual(api.store, {});
});

test('without the bridge the proposal is stored for the new tab only', async () => {
  const api = fakeApi({ bridge: false });
  const result = await applyThemeProposal({ name: 'Ember', theme: '#c2410c', colorMode: 'dark' }, { api });
  assert.equal(result.native, false);
  assert.deepEqual(api.store[PREVIOUS_LOOK_KEY], { appearance: null, artwork: null });
  await restorePreviousLook({ api });
  assert.equal(api.store[ARTWORK_KEY], null);
});

test('a Chromium look outside the Breezer palette is preserved', async () => {
  const api = fakeApi({ appearance: { theme: 'tide', colorMode: 'light', themeCanRestore: false } });
  await assert.rejects(applyThemeProposal({ name: 'Ember', theme: '#c2410c', colorMode: 'dark' }, { api }), /Choose a Breezer theme/);
  assert.deepEqual(api.calls, []);
  assert.deepEqual(api.store, {});
});

test('failed artwork saves roll back native color and retain the saved restore point', async () => {
  const api = fakeApi();
  const first = { name: 'Ember', theme: '#c2410c', colorMode: 'dark' };
  const next = { name: 'Moss', theme: '#15803d', colorMode: 'light' };
  const write = api.storage.local.set;
  api.storage.local.set = async () => { throw new Error('Storage is full.'); };
  await assert.rejects(applyThemeProposal(first, { api }), /^Error: Storage is full\.$/);
  assert.deepEqual(api.calls.at(-1), { theme: 'tide', colorMode: 'light', expectedThemeState: { theme: first.theme, colorMode: first.colorMode } }, 'rolls back only from the look it wrote');
  assert.deepEqual(api.store, {});
  assert.deepEqual(api.messages, [{ type: THEME_REFRESH_MESSAGE }], 'storage is down, so open pages hear about the rollback by message');
  api.storage.local.set = write;
  await applyThemeProposal(first, { api });
  const committed = structuredClone(api.store);
  api.storage.local.set = async () => { throw new Error('Storage is full.'); };
  await assert.rejects(applyThemeProposal(next, { api }), /Storage is full/);
  assert.deepEqual(api.calls.at(-1), { theme: first.theme, colorMode: first.colorMode, expectedThemeState: { theme: next.theme, colorMode: next.colorMode } });
  await assert.rejects(restorePreviousLook({ api }), /Storage is full/);
  assert.deepEqual(api.calls.at(-1), { theme: first.theme, colorMode: first.colorMode, expectedThemeState: { theme: 'tide', colorMode: 'light' } });
  assert.deepEqual(api.current, { theme: first.theme, colorMode: first.colorMode, themeCanRestore: true });
  assert.deepEqual(api.store, committed);
});

test('tampered stored records are ignored', async () => {
  const api = fakeApi();
  api.store[ARTWORK_KEY] = { name: 'x', theme: 'javascript:1', colorMode: 'dark' };
  assert.equal((await readThemeState({ api })).applied, null);
});

test('normalizeThemeProposal accepts only raster data: images within the attachment limit', () => {
  for (const image of [PNG, JPEG, WEBP]) assert.equal(normalizeThemeProposal({ name: 'A', theme: '#000000', colorMode: 'dark', image }).image, image);
  assert.equal('image' in normalizeThemeProposal({ name: 'A', theme: '#000000', colorMode: 'dark', image: null }), false);
  const padded = `data:image/png;base64,${Buffer.concat([Buffer.from(PNG.split(',')[1], 'base64'), Buffer.alloc(524000)]).toString('base64')}`;
  assert.ok(padded.length <= 700000);
  assert.equal(normalizeThemeImage(padded), padded);
  for (const image of [
    'https://example.com/a.png', '//example.com/a.png', 'blob:chrome-extension://x/y', 'data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=',
    'data:image/svg+xml,<svg onload=alert(1)>', 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', 'data:text/html;base64,PGI+',
    `data:image/png;base64,${Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>').toString('base64')}`, // PNG label, SVG bytes
    JPEG.replace('jpeg', 'png'), 'data:image/png;base64,iVBORw0K GgoAAAA', `${PNG}"onerror="x`, PNG.replace('base64,', ''),
    `data:image/png;base64,${'A'.repeat(700000)}`, 42, {},
  ]) assert.throws(() => normalizeThemeProposal({ name: 'A', theme: '#000000', colorMode: 'dark', image }), undefined, String(image).slice(0, 60));
  assert.equal('image' in normalizeThemeProposal({ name: 'A', theme: '#000000', colorMode: 'dark', imageAttachment: 0 }), false, 'an attachment index alone is never an image');
});

test('an applied image is stored, restored with the earlier look, and tampered images are ignored', async () => {
  const api = fakeApi();
  await applyThemeProposal({ name: 'Photo', theme: '#3b6e8f', colorMode: 'light', image: PNG }, { api });
  assert.equal((await readThemeState({ api })).applied.image, PNG);
  await applyThemeProposal({ name: 'Plain', theme: '#15803d', colorMode: 'dark' }, { api });
  assert.equal(api.store[PREVIOUS_LOOK_KEY].artwork, null);
  await restorePreviousLook({ api });
  assert.equal(api.store[ARTWORK_KEY], null);
  api.store[ARTWORK_KEY] = { name: 'x', theme: '#000000', colorMode: 'dark', image: 'https://evil.example/p.png' };
  assert.equal((await readThemeState({ api })).applied, null);
});

test('a look chosen elsewhere during a failed save is kept, reported and repainted', async () => {
  const api = fakeApi();
  const write = api.storage.local.set;
  // Settings picks a newer look while the artwork save is in flight, then the save fails.
  api.storage.local.set = async (values) => {
    if (!(ARTWORK_KEY in values)) return write(values);
    api.current = { theme: 'rose', colorMode: 'dark' };
    throw new Error('Storage is full.');
  };
  await assert.rejects(applyThemeProposal({ name: 'Ember', theme: '#c2410c', colorMode: 'dark' }, { api, now: () => 40 }),
    { message: 'Storage is full. Your newer browser colors were kept.' });
  assert.deepEqual(api.current, { theme: 'rose', colorMode: 'dark', themeCanRestore: true }, 'the rollback did not overwrite the newer look');
  assert.deepEqual(api.calls.at(-1).expectedThemeState, { theme: '#c2410c', colorMode: 'dark' });
  assert.deepEqual(api.store, { [APPEARANCE_REV_KEY]: 40 }, 'only the revision is written, so open pages repaint');
  assert.deepEqual(api.messages, []);
});

test('apply refuses when the look changed between the read and the write', async () => {
  const api = fakeApi();
  const get = api.breezerPrivate.getAppearance;
  api.breezerPrivate.getAppearance = async () => { const value = await get(); api.current = { theme: 'rose' }; return value; };
  await assert.rejects(applyThemeProposal({ name: 'Ember', theme: '#c2410c', colorMode: 'dark' }, { api }), /appearance changed/);
  assert.equal(api.current.theme, 'rose');
  assert.deepEqual(api.store, {});
});

test('the panel theme re-reads the appearance on a refresh message or window event', async () => {
  const messages = [];
  let current = { theme: 'rose', colorMode: 'light' };
  const api = {
    breezerPrivate: { getAppearance: async () => current }, runtime: { onMessage: { addListener: (fn) => messages.push(fn) } },
    storage: { local: { onChanged: { addListener() {} } } },
  };
  const view = new EventTarget();
  const root = { dataset: {}, ownerDocument: { defaultView: view }, style: { setProperty() {}, removeProperty() {} } };
  await startPanelTheme({ api, root, darkQuery: { matches: false, addEventListener() {} } });
  assert.equal(root.dataset.tone, 'rose');
  current = { theme: 'graphite', colorMode: 'dark' };
  messages.forEach((fn) => fn({ type: 'other' }));
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(root.dataset.tone, 'rose');
  messages.forEach((fn) => fn({ type: THEME_REFRESH_MESSAGE }));
  await new Promise((done) => setTimeout(done, 0));
  assert.deepEqual([root.dataset.tone, root.dataset.scheme], ['graphite', 'dark']);
  current = { theme: 'tide', colorMode: 'light' };
  view.dispatchEvent(new Event(THEME_REFRESH_MESSAGE));
  await new Promise((done) => setTimeout(done, 0));
  assert.equal(root.dataset.tone, 'tide');
});

test('sanitizeCss is stable on its own output past the proposal limit', () => {
  // content:x grows by one character per rule, so a 40k proposal can store more than 40k of CSS.
  const input = `${'.c::before{content:x}'.repeat(1880)}.last{fill:#123456}`;
  assert.ok(input.length <= 40000);
  const once = sanitizeCss(input);
  assert.ok(once.length > 40000);
  assert.equal(sanitizeCss(once), once, 'a re-read keeps every stored rule');
  assert.match(sanitizeCss(once), /\.last\{fill:#123456\}$/);
});
