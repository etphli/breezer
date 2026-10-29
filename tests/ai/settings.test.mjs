// Drives the shipped settings page (workspace.html#/settings + settings.js)
// against a fake DOM, fake chrome.storage and a controllable breezerPrivate
// bridge. Native outcomes are out of scope; workspace-native.mjs covers them.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDom, event, userClick, userKey, userTab, userType } from './settings-dom.mjs';
import {
  APPEARANCE_REV_KEY, DEFAULT_APPEARANCE, STORE_KEY, WorkspaceStore, addSpace, normalizeAppearance, validateAppearancePatch,
} from '../../features/ai/extension/workspace-store.js';

const html = readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8');
const { mountSettings } = await import('../../features/ai/extension/settings.js');
const label = (node) => node?.[Symbol.for('nodejs.util.inspect.custom')]?.() ?? String(node);
// Compares labels, not nodes: failing assertions must not serialize the DOM graph.
const assertFocused = (page, node, message = 'focus') => assert.equal(label(page.document.activeElement), label(node), message);
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };

function fakeStorage() {
  const listeners = [];
  const area = (name) => {
    const data = {};
    return {
      data,
      async get(keys) {
        const list = keys == null ? Object.keys(data) : [keys].flat();
        return Object.fromEntries(list.filter((key) => key in data).map((key) => [key, structuredClone(data[key])]));
      },
      async set(values) {
        const changes = {};
        for (const [key, value] of Object.entries(values)) {
          changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
          data[key] = structuredClone(value);
        }
        setTimeout(() => { for (const fn of listeners) fn(changes, name); }, 0);
      },
    };
  };
  return { local: area('local'), session: area('session'), onChanged: { addListener: (fn) => listeners.push(fn) } };
}

// breezerPrivate stand-in. With `hold`, each setAppearance waits for release().
function fakeBridge(initial = {}) {
  const bridge = {
    native: { ...DEFAULT_APPEARANCE, ...initial },
    calls: [],
    hold: false,
    held: [],
    reject: null,
    release() { const next = this.held.shift(); next?.(); return settle(); },
    async releaseAll() { while (this.held.length) await this.release(); await settle(); },
    async call(name, patch) {
      this.calls.push([name, patch]);
      if (name === 'getAppearance') return { ...this.native };
      if (this.hold) await new Promise((resolve) => this.held.push(resolve));
      if (this.reject) throw new Error(this.reject);
      Object.assign(this.native, validateAppearancePatch(patch));
      return { ...this.native };
    },
  };
  return bridge;
}

async function openSettings({ appearance, available = true } = {}) {
  const dom = createDom(html);
  Object.assign(globalThis, dom.globals);
  const storage = fakeStorage();
  const bridge = fakeBridge(appearance);
  const opened = [];
  const api = {
    storage,
    tabs: { query: async () => [{ index: 0, windowId: 1 }], create: async (props) => { opened.push(props); return props; } },
  };
  const locks = { tail: Promise.resolve(), request(_name, fn) { const run = this.tail.then(fn); this.tail = run.catch(() => {}); return run; } };
  const workspace = new WorkspaceStore({ storage, locks, makeToken: () => 'session-test' });
  await workspace.update((store) => { store.spaces[0].name = 'Personal'; });
  await mountSettings({
    api,
    workspace,
    callBridge: (name, ...args) => (available ? bridge.call(name, ...args) : Promise.reject(new Error('unavailable'))),
    loadAppearance: async () => (available
      ? { appearance: normalizeAppearance(await bridge.call('getAppearance')), available: true, error: '' }
      : { appearance: { ...DEFAULT_APPEARANCE }, available: false, error: '' }),
    applyAppearance: (value) => { dom.document.documentElement.dataset.tone = value.theme; },
    darkQuery: { matches: false, addEventListener() {} },
  });
  await settle();
  const $ = (id) => dom.document.getElementById(id);
  const radio = (field, value) => dom.document.querySelector(`[data-field="${field}"] [data-value="${value}"]`);
  const sets = () => bridge.calls.filter(([name]) => name === 'setAppearance').map(([, patch]) => patch);
  return { ...dom, $, radio, sets, bridge, storage, workspace, opened };
}

test('every appearance control maps to a declared bridge field and renders the reported value', async () => {
  const page = await openSettings({
    appearance: {
      layout: 'top', sidebarMode: 'autoHide', theme: 'dusk', colorMode: 'dark', showBookmarks: false,
      sidebarWidth: 300, sidebarFontSize: 18, centeredAddressBar: false, minimalUrl: false,
      showLoadProgress: false, frameless: false, alwaysShowSidebar: true, alwaysShowTopBar: false,
    },
  });
  const fields = new Set([...page.document.querySelectorAll('[data-field]')].map((node) => node.dataset.field));
  fields.add('theme');
  assert.deepEqual([...fields].sort(), Object.keys(DEFAULT_APPEARANCE).sort(), 'every native appearance field has exactly one control');
  for (const [field, value] of [['layout', 'top'], ['sidebarMode', 'autoHide'], ['colorMode', 'dark']]) {
    assert.equal(page.radio(field, value).getAttribute('aria-checked'), 'true', field);
  }
  assert.equal(page.document.querySelector('#theme-swatches [data-value="dusk"]').getAttribute('aria-checked'), 'true');
  for (const id of ['show-bookmarks', 'centered-address-bar', 'minimal-url', 'show-load-progress', 'frameless', 'always-show-top-bar']) {
    assert.equal(page.$(id).getAttribute('aria-checked'), 'false', id);
  }
  assert.equal(page.$('always-show-sidebar').getAttribute('aria-checked'), 'true');
  assert.equal(page.$('sidebar-width').value, '300');
  assert.equal(page.$('sidebar-width-value').textContent, '300 px');
  assert.equal(page.$('sidebar-font-size').value, '18');
  assert.equal(page.document.documentElement.dataset.tone, 'dusk');
});

test('switches, radios and swatches each write one field and persist the reported value', async () => {
  const page = await openSettings();
  for (const id of ['show-bookmarks', 'centered-address-bar', 'minimal-url', 'show-load-progress', 'frameless', 'always-show-sidebar', 'always-show-top-bar']) {
    const control = page.$(id);
    const field = control.dataset.field;
    const before = page.bridge.native[field];
    userClick(control);
    await settle();
    assert.deepEqual(page.sets().at(-1), { [field]: !before }, id);
    assert.equal(control.getAttribute('aria-checked'), String(!before), id);
  }
  userClick(page.radio('layout', 'top'));
  await settle();
  assert.equal(page.bridge.native.layout, 'top');
  userClick(page.radio('colorMode', 'dark'));
  await settle();
  assert.equal(page.bridge.native.colorMode, 'dark');
  userClick(page.document.querySelector('#theme-swatches [data-value="rose"]'));
  await settle();
  assert.equal(page.bridge.native.theme, 'rose');
  assert.equal(page.document.documentElement.dataset.tone, 'rose');
  assert.ok(page.storage.session.data[APPEARANCE_REV_KEY], 'other documents are told to reload appearance');
});

test('keyboard steps on a slider keep focus and are all applied while a save is in flight', async () => {
  const page = await openSettings();
  const font = page.$('sidebar-font-size');
  page.bridge.hold = true;
  font.focus();
  userKey(page.document, 'ArrowRight');
  assertFocused(page, font, 'focus stays on the slider while its value saves');
  userKey(page.document, 'ArrowRight');
  assert.equal(font.value, '17', 'the second key step is not reverted');
  await page.bridge.releaseAll();
  assert.equal(page.bridge.native.sidebarFontSize, 17);
  assert.equal(font.value, '17');
  assert.equal(page.$('sidebar-font-size-value').textContent, '17 px');
  assertFocused(page, font);
});

test('saving one setting does not disable or dim the others', async () => {
  const page = await openSettings();
  page.bridge.hold = true;
  userClick(page.$('show-bookmarks'));
  await settle();
  assert.equal(page.$('frameless').getAttribute('aria-disabled'), 'false');
  assert.equal(page.radio('layout', 'top').getAttribute('aria-disabled'), 'false');
  assert.equal(page.$('sidebar-width').disabled, false);
  await page.bridge.releaseAll();
});

test('a quick second click on a switch is applied instead of dropped', async () => {
  const page = await openSettings();
  page.bridge.hold = true;
  userClick(page.$('frameless'));
  userClick(page.$('frameless'));
  await page.bridge.releaseAll();
  await settle();
  assert.equal(page.bridge.native.frameless, true, 'two clicks return the switch to on');
  assert.equal(page.$('frameless').getAttribute('aria-checked'), 'true');
});

test('arrowing through a radio group during a save selects the focused option', async () => {
  const page = await openSettings();
  page.bridge.hold = true;
  page.radio('sidebarMode', 'expanded').focus();
  userKey(page.document, 'ArrowRight');
  userKey(page.document, 'ArrowRight');
  await page.bridge.releaseAll();
  await settle();
  const autoHide = page.radio('sidebarMode', 'autoHide');
  assertFocused(page, autoHide);
  assert.equal(page.bridge.native.sidebarMode, 'autoHide');
  assert.equal(autoHide.getAttribute('aria-checked'), 'true');
  assert.equal(autoHide.tabIndex, 0, 'roving tab stop follows the focused, selected radio');
});

test('an outside appearance change does not reset a slider the user is dragging', async () => {
  const page = await openSettings();
  const width = page.$('sidebar-width');
  width.focus();
  width.value = '320';
  width.dispatchEvent(event('input'));
  page.bridge.native.theme = 'tide';
  await page.storage.session.set({ [APPEARANCE_REV_KEY]: Date.now() });
  await settle();
  assert.equal(page.document.documentElement.dataset.tone, 'tide', 'outside change still applies');
  assert.equal(width.value, '320');
  assert.equal(page.$('sidebar-width-value').textContent, '320 px');
  width.dispatchEvent(event('change'));
  await settle();
  assert.equal(page.bridge.native.sidebarWidth, 320);
});

test('a rejected change shows an error and the control reverts to the browser value', async () => {
  const page = await openSettings();
  page.bridge.reject = 'Rejected by the browser.';
  userClick(page.$('frameless'));
  await settle();
  assert.match(page.$('layout-error').textContent, /Couldn’t change the frameless mode\. Rejected by the browser\./);
  assert.equal(page.$('frameless').getAttribute('aria-checked'), 'true');
  const font = page.$('sidebar-font-size');
  font.focus();
  userKey(page.document, 'ArrowLeft');
  await settle();
  assert.equal(font.value, '15');
  assert.match(page.$('typography-error').textContent, /sidebar font size/);
  page.bridge.reject = null;
  userClick(page.$('frameless'));
  await settle();
  assert.equal(page.$('layout-error').hidden, true, 'a later success clears the error');
});

test('a browser that keeps a different value reports it', async () => {
  const page = await openSettings();
  page.bridge.call = async function (name, patch) {
    this.calls.push([name, patch]);
    return { ...this.native };
  };
  userClick(page.radio('layout', 'top'));
  await settle();
  assert.equal(page.$('layout-error').textContent, 'The browser kept tab layout at Sidebar.');
  assert.equal(page.radio('layout', 'sidebar').getAttribute('aria-checked'), 'true');
});

test('without the bridge appearance controls are disabled but store-backed settings work', async () => {
  const page = await openSettings({ available: false });
  assert.equal(page.$('bridge-note').hidden, false);
  assert.equal(page.$('sidebar-width').disabled, true);
  assert.equal(page.$('frameless').getAttribute('aria-disabled'), 'true');
  userClick(page.$('frameless'));
  await settle();
  assert.equal(page.bridge.calls.length, 0);
  userClick(page.document.querySelector('[data-pref="newTabPosition"] [data-value="top"]'));
  await settle();
  assert.equal(page.storage.local.data[STORE_KEY].prefs.newTabPosition, 'top');
});

test('rows that cannot take effect in the current layout are marked muted', async () => {
  const page = await openSettings();
  const row = (id) => page.$(id).closest('.setting-row').classList.contains('muted-row');
  assert.equal(row('always-show-sidebar'), false);
  assert.equal(row('always-show-top-bar'), false);
  userClick(page.$('frameless'));
  await settle();
  assert.equal(row('always-show-sidebar'), true, 'sidebar pin only applies in frameless mode');
  assert.equal(row('always-show-top-bar'), true, 'top bar pin only applies in frameless mode');
  assert.equal(row('sidebar-width'), false);
  userClick(page.radio('layout', 'top'));
  await settle();
  for (const id of ['sidebar-width', 'sidebar-font-size']) assert.equal(row(id), true, id);
  assert.equal(page.radio('sidebarMode', 'expanded').closest('.setting-row').classList.contains('muted-row'), true);
});

test('tab behavior settings persist in the workspace store', async () => {
  const page = await openSettings();
  userClick(page.document.querySelector('[data-pref="newTabPosition"] [data-value="top"]'));
  userClick(page.document.querySelector('[data-pref="closeButton"] [data-value="always"]'));
  await settle();
  assert.deepEqual(page.storage.local.data[STORE_KEY].prefs, { newTabPosition: 'top', closeButton: 'always' });
  assert.equal(page.document.querySelector('[data-pref="closeButton"] [data-value="always"]').getAttribute('aria-checked'), 'true');
});

test('spaces: rename, recolor, reorder, add and two-step delete', async () => {
  const page = await openSettings();
  userClick(page.$('settings-add-space'));
  await settle();
  const items = () => page.$('space-list').children;
  assert.equal(items().length, 2);
  const second = items()[1].querySelector('input');
  assertFocused(page, second, 'new space name is focused');
  userType(second, 'Work');
  userTab(page.document, items()[1].querySelector('select'));
  await settle();
  assert.equal(page.storage.local.data[STORE_KEY].spaces[1].name, 'Work');
  const tone = items()[1].querySelector('select');
  tone.value = 'rose';
  tone.dispatchEvent(event('change'));
  await settle();
  assert.equal(page.storage.local.data[STORE_KEY].spaces[1].tone, 'rose');
  userClick(items()[1].querySelector('[data-control="up"]'));
  await settle();
  assert.deepEqual(page.storage.local.data[STORE_KEY].spaces.map((space) => space.name), ['Work', 'Personal']);
  const remove = items()[0].querySelector('[data-control="delete"]');
  userClick(remove);
  assert.equal(remove.textContent, 'Confirm delete');
  userClick(remove);
  await settle();
  assert.deepEqual(page.storage.local.data[STORE_KEY].spaces.map((space) => space.name), ['Personal']);
  assert.equal(items()[0].querySelector('[data-control="delete"]').disabled, true, 'the last space cannot be deleted');
});

test('a blank space name is rejected and the field shows the saved name again', async () => {
  const page = await openSettings();
  const name = page.$('space-list').querySelector('input');
  userType(name, '   ');
  name.dispatchEvent(event('change'));
  await settle();
  assert.equal(page.$('spaces-error').textContent, 'Give the space a name.');
  assert.equal(page.$('space-list').querySelector('input').value, 'Personal');
});

test('spaces changed elsewhere appear once the user leaves a name field', async () => {
  const page = await openSettings();
  const name = page.$('space-list').querySelector('input');
  name.focus();
  await page.workspace.update((store) => { addSpace(store, { name: 'From sidebar', tone: 'tide' }); });
  await settle();
  assertFocused(page, name, 'an open edit is not interrupted');
  page.$('settings-add-space').focus();
  await settle();
  assert.deepEqual([...page.$('space-list').querySelectorAll('input')].map((input) => input.value), ['Personal', 'From sidebar']);
});

test('browser settings links open beside the settings tab and report failures', async () => {
  const page = await openSettings();
  const links = [...page.document.querySelectorAll('.link-list [data-url]')];
  assert.ok(links.length >= 10);
  for (const link of links) assert.match(link.dataset.url, /^chrome:\/\//);
  userClick(links[0]);
  await settle();
  assert.deepEqual(page.opened.at(-1), { url: links[0].dataset.url, index: 1, windowId: 1 });
  page.opened.push = () => { throw new Error('Blocked.'); };
  userClick(links[1]);
  await settle();
  assert.equal(links[1].closest('li').dataset.error, 'true');
  assert.match(links[1].title, /Couldn’t open chrome:\/\/.+ Blocked\./);
});

test('custom color saves through the native theme field and preset restores normally', async () => {
  const page = await openSettings();
  page.$('custom-theme-color').value = '#123abc';
  userClick(page.$('custom-theme-apply')); await settle();
  assert.deepEqual(page.sets().at(-1), { theme: '#123abc' });
  assert.equal(page.bridge.native.theme, '#123abc');
  userClick(page.document.querySelector('#theme-swatches [data-value="rose"]')); await settle();
  assert.equal(page.bridge.native.theme, 'rose');
  for (const value of ['#abc', '#00000000', 'url(evil)', '#12345g']) assert.throws(() => validateAppearancePatch({ theme: value }));
});
