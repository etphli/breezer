// Drives the first-run Chrome import card against the shipped workspace.html in a fake DOM.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDom, userClick } from './settings-dom.mjs';
import { ONBOARDING_KEY, mountOnboarding } from '../../features/ai/extension/settings-onboarding.js';

const html = readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../../features/ai/extension/settings-onboarding.js', import.meta.url), 'utf8');
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0)); };
const SUCCESS = /import(ed)? (complete|succeeded|finished|done)|successfully|imported your/i;

function fixture({ saved = {}, tabs = true, createFails = false, setFails = false, passwords = true } = {}) {
  const dom = createDom(html);
  Object.assign(globalThis, dom.globals);
  const opened = [];
  const listeners = [];
  const data = structuredClone(saved);
  const api = {
    storage: {
      local: {
        async get(key) { return key in data ? { [key]: structuredClone(data[key]) } : {}; },
        async set(values) {
          if (setFails) throw new Error('quota');
          Object.assign(data, structuredClone(values));
          for (const fn of listeners) fn(Object.fromEntries(Object.entries(values).map(([k, v]) => [k, { newValue: v }])), 'local');
        },
      },
      onChanged: { addListener: (fn) => listeners.push(fn) },
    },
    ...(tabs ? { tabs: { async create(props) { if (createFails) throw new Error('blocked'); opened.push(props); return props; } } } : {}),
  };
  const shown = [];
  const handle = passwords ? { showImport: () => shown.push('import') } : null;
  const card = mountOnboarding({ container: dom.document.getElementById('settings-onboarding'), api, passwords: handle });
  const q = (selector) => dom.document.querySelector(selector);
  return { dom, api, data, opened, shown, card, listeners, q, section: () => q('[data-onboarding]'), action: (name) => q(`[data-onboarding-action="${name}"]`) };
}

test('first run shows the card only after the saved choice is read', async () => {
  const f = fixture();
  assert.equal(f.section().hidden, true, 'hidden until storage answers');
  await settle();
  assert.equal(f.section().hidden, false);
  assert.match(f.section().textContent, /Bring your Chrome data to Breezer/);
  assert.match(f.section().textContent, /copies your data once/);
  assert.doesNotMatch(f.section().textContent, /\bsync(s|ed|ing)? (with|to|from)\b|keeps? in sync/i, 'never implies sync');
  assert.doesNotMatch(f.section().textContent, /Touch ID|passkeys? (are|will be) imported/i);
  f.card.dispose();
});

test('a dismissed card stays hidden on later visits', async () => {
  const f = fixture({ saved: { [ONBOARDING_KEY]: { dismissed: true } } });
  await settle();
  assert.equal(f.section().hidden, true);
  f.card.dispose();
});

test('Hide persists the choice, hides the card and moves focus to the page heading', async () => {
  const f = fixture();
  await settle();
  userClick(f.action('dismiss'));
  await settle();
  assert.deepEqual(f.data[ONBOARDING_KEY], { dismissed: true });
  assert.equal(f.section().hidden, true);
  assert.ok(f.dom.document.activeElement === f.dom.document.getElementById('settings-title'), 'focus moves to the Settings heading');
  // A remount with the saved value never shows the card again.
  const again = fixture({ saved: f.data });
  await settle();
  assert.equal(again.section().hidden, true);
  f.card.dispose(); again.card.dispose();
});

test('a failed save keeps the card and explains how to retry', async () => {
  const f = fixture({ setFails: true });
  await settle();
  userClick(f.action('dismiss'));
  await settle();
  assert.equal(f.section().hidden, false);
  assert.equal(f.action('dismiss').disabled, false);
  assert.match(f.q('[data-onboarding] [role="alert"]').textContent, /Couldn’t save that choice/);
  f.card.dispose();
});

test('dismissing in another settings tab hides this card too', async () => {
  const f = fixture();
  await settle();
  for (const fn of f.listeners) fn({ [ONBOARDING_KEY]: { newValue: { dismissed: true } } }, 'local');
  assert.equal(f.section().hidden, true);
  f.card.dispose();
});

test('bookmarks and history opens the native import dialog without claiming success', async () => {
  const f = fixture();
  await settle();
  userClick(f.action('browserImport'));
  assert.equal(f.action('browserImport').disabled, true, 'busy while the tab opens');
  userClick(f.action('browserImport'));
  await settle();
  assert.deepEqual(f.opened, [{ url: 'chrome://settings/importData', active: true }]);
  assert.equal(f.action('browserImport').disabled, false);
  const status = f.q('[data-onboarding] [role="status"]').textContent;
  assert.match(status, /opened in a new tab/);
  assert.doesNotMatch(status, SUCCESS);
  f.card.dispose();
});

test('a blocked tab shows the fixed fallback address and no status', async () => {
  const f = fixture({ createFails: true });
  await settle();
  userClick(f.action('browserImport'));
  await settle();
  const alert = f.q('[data-onboarding] [role="alert"]');
  assert.equal(alert.hidden, false);
  assert.match(alert.textContent, /chrome:\/\/settings\/importData/);
  assert.doesNotMatch(alert.textContent, /blocked/, 'raw errors stay off the page');
  assert.equal(f.q('[data-onboarding] [role="status"]').textContent, '');
  f.card.dispose();
});

test('password steps open the existing CSV guide and never a password route directly', async () => {
  const f = fixture();
  await settle();
  userClick(f.action('passwords'));
  await settle();
  assert.deepEqual(f.shown, ['import']);
  assert.deepEqual(f.opened, []);
  assert.match(f.section().textContent, /Passkeys are not included/);
  f.card.dispose();
  const none = fixture({ passwords: false });
  assert.equal(none.action('passwords').hidden, true);
  none.card.dispose();
});

test('without the tabs API the import action is disabled and explained', async () => {
  const f = fixture({ tabs: false });
  await settle();
  assert.equal(f.action('browserImport').disabled, true);
  assert.match(f.q('[data-onboarding] [role="alert"]').textContent, /Open this page in Breezer/);
  f.card.dispose();
});

test('dispose stops late updates and removes the card', async () => {
  const f = fixture();
  f.card.dispose();
  await settle();
  assert.equal(f.section(), null);
});

test('the module only reuses fixed password routes and stores a single flag', () => {
  assert.doesNotMatch(source, /\.innerHTML|insertAdjacentHTML|https?:\/\/|passwordsPrivate|\.csv['"]|FileReader|fetch\(/);
  assert.match(source, /createPasswordActions/);
  assert.match(source, /\{ dismissed: true \}/);
});
