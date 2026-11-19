// Served beside the extension by browser-theme-browser.test.mjs as
// /_theme/card.js. A fake chrome.* whose storage is the same localStorage key
// newtab-browser-fixture.mjs uses, so an Apply here reaches an open new tab.
import { readThemeState, renderThemeProposal, restorePreviousLook } from '/browser-theme.js';
import { startPanelTheme } from '/panel-theme.js';

const KEY = 'shortcut-fixture';
const read = () => JSON.parse(localStorage.getItem(KEY) || '{}');
const listeners = [];
const emit = (changes) => listeners.forEach((fn) => fn(structuredClone(changes)));
const diff = (before, after) => Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])]
  .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
  .map((key) => [key, { oldValue: before[key], newValue: after[key] }]));
const write = (next) => { const before = read(); localStorage.setItem(KEY, JSON.stringify(next)); const changes = diff(before, next); if (Object.keys(changes).length) emit(changes); };
addEventListener('storage', (event) => { if (event.key === KEY) { const changes = diff(JSON.parse(event.oldValue || '{}'), JSON.parse(event.newValue || '{}')); if (Object.keys(changes).length) emit(changes); } });

let appearance = { theme: 'tide', colorMode: 'light', themeCanRestore: true };
window.bridgeCalls = [];
// Test hooks: failSave is null, 'artwork' (only the full theme save fails) or
// 'all' (storage is down); beforeFail runs first, standing in for another page.
window.themeFixture = {
  failSave: null,
  beforeFail: null,
  messages: [],
  get appearance() { return { ...appearance }; },
  setAppearance(value) { appearance = { ...appearance, ...value }; },
};
window.chrome = {
  runtime: { sendMessage: async (message) => { window.themeFixture.messages.push(message); } },
  storage: { local: {
    onChanged: { addListener: (fn) => listeners.push(fn), removeListener: (fn) => listeners.splice(listeners.indexOf(fn) >>> 0, 1) },
    async get(keys) { const all = read(); return Object.fromEntries([keys].flat().filter((key) => key in all).map((key) => [key, all[key]])); },
    async set(values) {
      const { failSave, beforeFail } = window.themeFixture;
      if (failSave === 'all' || (failSave === 'artwork' && 'theme.artwork.v1' in values)) {
        beforeFail?.();
        throw new Error('Storage is full.');
      }
      write({ ...read(), ...structuredClone(values) });
    },
    async remove(key) { const all = read(); delete all[key]; write(all); },
  } },
  breezerPrivate: {
    getAppearance: async () => ({ ...appearance }),
    // Matches the native compare: expectedThemeState must name the current Breezer theme.
    setAppearance: async (patch) => {
      window.bridgeCalls.push(patch);
      const { expectedThemeState: expected, ...change } = patch;
      if (expected && (!appearance.themeCanRestore || expected.theme !== appearance.theme || expected.colorMode !== appearance.colorMode)) {
        throw new Error('Browser appearance changed. Try again.');
      }
      appearance = { ...appearance, ...change };
      return { ...appearance };
    },
  },
};

const thread = document.getElementById('thread');
window.cards = (window.proposals || []).map((proposal) => renderThemeProposal(thread, proposal));
// Stands in for the parent's Browser tools dialog: a Restore entry built only
// on the exported readThemeState / restorePreviousLook.
const headerButton = Object.assign(document.createElement('button'), { type: 'button', className: 'theme-restore-button', textContent: 'Restore previous look', hidden: true });
document.getElementById('header-actions').append(headerButton);
const syncHeader = async () => { headerButton.hidden = !(await readThemeState()).canRestore; };
headerButton.addEventListener('click', async () => {
  const result = await restorePreviousLook();
  document.getElementById('header-status').textContent = result.restored ? 'Restored your previous look.' : 'There’s no previous look to restore.';
  await syncHeader();
});
window.chrome.storage.local.onChanged.addListener((changes) => { if (changes['theme.previous.v1']) void syncHeader(); });
window.headerRestore = { ready: syncHeader() };
void startPanelTheme();
window.ready = Promise.all([...window.cards.map((card) => card.ready), window.headerRestore.ready]);
