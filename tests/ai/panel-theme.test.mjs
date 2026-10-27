import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { APPEARANCE_REV_KEY, TONES } from '../../features/ai/extension/workspace-store.js';
import { applyTheme, readAppearance, resolveTheme, startPanelTheme } from '../../features/ai/extension/panel-theme.js';

const css = await readFile(new URL('../../features/ai/extension/panel.css', import.meta.url), 'utf8');

function fakeRoot() {
  return { dataset: {}, style: {} };
}

function fakeQuery(matches) {
  const listeners = [];
  return {
    matches,
    addEventListener: (type, fn) => listeners.push(fn),
    flip(value) { this.matches = value; listeners.forEach((fn) => fn()); },
  };
}

function fakeApi(getAppearance) {
  const listeners = [];
  return {
    breezerPrivate: getAppearance ? { getAppearance } : {},
    runtime: {},
    storage: { onChanged: { addListener: (fn) => listeners.push(fn) } },
    emit: (changes, area) => listeners.forEach((fn) => fn(changes, area)),
  };
}

const settle = () => new Promise((done) => setTimeout(done, 0));

test('explicit color modes override the OS and system follows it', () => {
  assert.deepEqual(resolveTheme({ theme: 'rose', colorMode: 'light' }, true), { tone: 'rose', scheme: 'light' });
  assert.deepEqual(resolveTheme({ theme: 'tide', colorMode: 'dark' }, false), { tone: 'tide', scheme: 'dark' });
  assert.deepEqual(resolveTheme({ theme: 'dusk', colorMode: 'system' }, true), { tone: 'dusk', scheme: 'dark' });
  assert.deepEqual(resolveTheme({ theme: 'dusk', colorMode: 'system' }, false), { tone: 'dusk', scheme: 'light' });
  assert.deepEqual(resolveTheme({ theme: 'neon', colorMode: 'dim' }, true), { tone: 'mint', scheme: 'dark' });
  assert.deepEqual(resolveTheme(null, false), { tone: 'mint', scheme: 'light' });
});

test('applyTheme sets the root tone, scheme, and native color-scheme', () => {
  const root = fakeRoot();
  applyTheme(root, { tone: 'pollen', scheme: 'dark' });
  assert.deepEqual(root.dataset, { tone: 'pollen', scheme: 'dark' });
  assert.equal(root.style.colorScheme, 'dark');
});

test('the panel applies the saved appearance at load and after each appearance revision', async () => {
  let current = { theme: 'rose', colorMode: 'light' };
  const api = fakeApi(async () => current);
  const root = fakeRoot();
  const query = fakeQuery(true);
  await startPanelTheme({ api, root, darkQuery: query });
  assert.deepEqual(root.dataset, { tone: 'rose', scheme: 'light' }, 'OS dark, forced light');

  current = { theme: 'graphite', colorMode: 'dark' };
  api.emit({ unrelated: {} }, 'session');
  api.emit({ [APPEARANCE_REV_KEY]: { newValue: 2 } }, 'local');
  await settle();
  assert.equal(root.dataset.tone, 'rose', 'only session appearance.rev triggers a reload');

  query.flip(false);
  api.emit({ [APPEARANCE_REV_KEY]: { newValue: 3 } }, 'session');
  await settle();
  assert.deepEqual(root.dataset, { tone: 'graphite', scheme: 'dark' }, 'OS light, forced dark');

  current = { theme: 'tide', colorMode: 'system' };
  api.emit({ [APPEARANCE_REV_KEY]: { newValue: 4 } }, 'session');
  await settle();
  assert.equal(root.dataset.scheme, 'light');
  query.flip(true);
  assert.deepEqual(root.dataset, { tone: 'tide', scheme: 'dark' }, 'system mode follows OS changes live');
});

test('older builds without the bridge follow the OS without throwing', async () => {
  const root = fakeRoot();
  const query = fakeQuery(true);
  await startPanelTheme({ api: { breezerPrivate: { authorizeCurrentPage: async () => true }, storage: {} }, root, darkQuery: query });
  assert.deepEqual(root.dataset, { tone: 'mint', scheme: 'dark' });
  query.flip(false);
  assert.equal(root.dataset.scheme, 'light');
  await startPanelTheme({ api: undefined, root: fakeRoot(), darkQuery: fakeQuery(false) });
});

test('getAppearance is bounded and failures keep the last good appearance', async () => {
  assert.equal(await readAppearance(fakeApi(() => new Promise(() => {})), 20), null);
  assert.equal(await readAppearance(fakeApi(async () => { throw new Error('no'); })), null);
  assert.deepEqual(await readAppearance(fakeApi((callback) => { callback({ theme: 'dusk' }); })), { theme: 'dusk' });

  let fail = false;
  const api = fakeApi(async () => { if (fail) throw new Error('gone'); return { theme: 'dusk', colorMode: 'dark' }; });
  const root = fakeRoot();
  await startPanelTheme({ api, root, darkQuery: fakeQuery(false) });
  fail = true;
  api.emit({ [APPEARANCE_REV_KEY]: { newValue: 9 } }, 'session');
  await settle();
  assert.deepEqual(root.dataset, { tone: 'dusk', scheme: 'dark' });
});

// --------------------------------------------------------------- palettes

const hex = (value) => {
  let h = value.replace('#', '');
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
};
const luminance = (value) => {
  const [r, g, b] = hex(value).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

function palette(tone, scheme) {
  const rule = css.match(new RegExp(`:root\\[data-tone="${tone}"\\]\\[data-scheme="${scheme}"\\]\\s*\\{([^}]*)\\}`));
  assert.ok(rule, `missing ${tone}/${scheme} palette`);
  return Object.fromEntries([...rule[1].matchAll(/--([a-z-]+):\s*(#[0-9a-f]{3,6})/gi)].map(([, key, value]) => [key, value]));
}

test('every tone has light and dark palettes with readable text', () => {
  for (const tone of TONES) {
    for (const scheme of ['light', 'dark']) {
      const p = palette(tone, scheme);
      const at = `${tone}/${scheme}`;
      for (const key of ['page', 'paper', 'ink', 'muted', 'line', 'accent', 'accent-soft', 'accent-ink']) assert.ok(p[key], `${at} --${key}`);
      for (const surface of ['page', 'paper', 'line']) {
        assert.ok(contrast(p.muted, p[surface]) >= 4.5, `${at} muted on ${surface}`);
        assert.ok(contrast(p.ink, p[surface]) >= 7, `${at} ink on ${surface}`);
      }
      for (const surface of ['page', 'paper', 'accent-soft']) assert.ok(contrast(p['accent-ink'], p[surface]) >= 4.5, `${at} accent text on ${surface}`);
      for (const surface of ['page', 'paper']) assert.ok(contrast(p.accent, p[surface]) >= 3, `${at} focus ring on ${surface}`);
    }
  }
});

test('panel palettes keep the workspace ink and accent for each tone', async () => {
  const workspace = await readFile(new URL('../../features/ai/extension/workspace.css', import.meta.url), 'utf8');
  for (const tone of TONES) {
    const light = workspace.match(new RegExp(`^\\[data-tone="${tone}"\\]\\s*\\{([^}]*)\\}`, 'm'))[1];
    const dark = workspace.match(new RegExp(`\\[data-scheme="dark"\\]\\[data-tone="${tone}"\\]\\s*\\{([^}]*)\\}`))[1];
    for (const [scheme, source] of [['light', light], ['dark', dark]]) {
      const p = palette(tone, scheme);
      for (const key of ['ink', 'accent']) assert.equal(p[key].toLowerCase(), source.match(new RegExp(`--${key}:\\s*(#[0-9a-f]+)`, 'i'))[1].toLowerCase(), `${tone}/${scheme} --${key}`);
    }
  }
});

test('panel CSS uses valid focus, disabled, and backdrop selectors', () => {
  assert.doesNotMatch(css, /:\s+:?(focus-visible|disabled|backdrop)\b/);
  assert.match(css, /dialog::backdrop/);
  assert.match(css, /button:focus-visible/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
});
