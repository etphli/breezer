// Breezer experiments: opt-in features kept in one storage.local record.
//
//   chrome.storage.local['breezerExperiments'] = {
//     version: 1,
//     glass: false,             // glossy glass surfaces; native window material where the bridge offers it
//     sidebarSearch: false,     // search/address button in the sidebar (workspace-chrome.js)
//     newTabComposer: false,    // New Tab search and Ask composer
//     newTabRecentChats: false, // up to three open-window conversations under the composer
//     newTabShortcuts: false,   // compact frequent-site icons under the composer
//     personality: 'off',       // browser-wide assistant reply style, see PERSONALITIES
//     spaceDock: false,         // alternate space dock (workspace)
//   }
//
// Every flag is off by default and an unknown or damaged record reads as all off.
// Features start their own code only after reading an "on" value here.
import { localStorageChanges } from './storage-events.js';
import { HAS_NATIVE_HELPER } from './platform.js';
import { readAppearance } from './panel-theme.js';
import { APPEARANCE_REV_KEY } from './workspace-store.js';
import { applyThemeProposal, readThemeState, restorePreviousLook } from './browser-theme.js';

export const EXPERIMENTS_KEY = 'breezerExperiments';
export const EXPERIMENTS_VERSION = 1;
// The New Tab and its full-page chat share the tab's sessionStorage draft.
export const handoffKey = (tabId) => `breezer-handoff-${tabId}`;
export const HANDOFF_TTL_MS = 60_000;
export const CONVERSATION_PREFIX = 'breezer-conversation-';
export const FULL_CHAT_PATH = 'panel.html?view=chat';
export const FULL_CHAT_PREFIX = 'breezer-full-conversation-tab-';
export const MAX_RECENT_CHATS = 3;

const FLAGS = ['glass', 'sidebarSearch', 'newTabComposer', 'newTabRecentChats', 'newTabShortcuts', 'spaceDock'];

export const PERSONALITIES = Object.freeze({
  off: { label: 'Standard', description: 'Breezer AI answers in its usual style.', instruction: '' },
  concise: {
    label: 'Brief',
    description: 'Short answers that lead with the result. A crisp slate look with squared edges.',
    seed: '#4b5d73',
    instruction: 'Keep replies short. Lead with the answer, use at most a few sentences or a short list, and skip preamble.',
  },
  warm: {
    label: 'Warm',
    description: 'Friendly and encouraging, still to the point. A honey-toned look with soft, round shapes.',
    seed: '#a8741a',
    instruction: 'Use a warm, encouraging and conversational tone while staying accurate and to the point.',
  },
  tutor: {
    label: 'Tutor',
    description: 'Explains steps and checks understanding. A deep green notebook look with ruled lines.',
    seed: '#2d6b5a',
    instruction: 'Teach rather than just answer: explain the reasoning step by step in plain language and suggest one way to check understanding.',
  },
  direct: {
    label: 'Direct',
    description: 'Plain, candid answers with clear recommendations. A bold cobalt look with hard edges.',
    seed: '#2f50c4',
    instruction: 'Be direct and candid. Give a clear recommendation, state trade-offs plainly and avoid hedging.',
  },
});

export const DEFAULT_EXPERIMENTS = Object.freeze({
  version: EXPERIMENTS_VERSION,
  ...Object.fromEntries(FLAGS.map((flag) => [flag, false])),
  personality: 'off',
});

export function normalizeExperiments(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = { ...DEFAULT_EXPERIMENTS };
  for (const flag of FLAGS) value[flag] = source[flag] === true;
  value.personality = Object.hasOwn(PERSONALITIES, source.personality) ? source.personality : 'off';
  return value;
}

export function validateExperimentsPatch(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Experiment changes must be an object.');
  const clean = {};
  for (const [key, value] of Object.entries(patch)) {
    if (FLAGS.includes(key)) {
      if (typeof value !== 'boolean') throw new Error(`${key} must be on or off.`);
      clean[key] = value;
    } else if (key === 'personality') {
      if (!Object.hasOwn(PERSONALITIES, value)) throw new Error('Choose a listed personality.');
      clean[key] = value;
    } else {
      throw new Error(`Unknown experiment: ${key}`);
    }
  }
  return clean;
}

export async function readExperiments(api = globalThis.chrome) {
  try {
    const values = await api?.storage?.local?.get?.(EXPERIMENTS_KEY);
    return normalizeExperiments(values?.[EXPERIMENTS_KEY]);
  } catch {
    return normalizeExperiments(null);
  }
}

// Writes are merged with the latest stored record so two pages can change different flags.
export async function writeExperiments(api, patch) {
  const clean = validateExperimentsPatch(patch);
  const write = async () => {
    const current = await readExperiments(api);
    const next = normalizeExperiments({ ...current, ...clean });
    await api.storage.local.set({ [EXPERIMENTS_KEY]: next });
    return next;
  };
  const locks = globalThis.navigator?.locks;
  return locks ? locks.request(EXPERIMENTS_KEY, write) : write();
}

// Calls onChange(next, previous) whenever another page changes the record. Returns a stop function.
export function watchExperiments(api, onChange) {
  const events = localStorageChanges(api);
  if (!events) return () => {};
  const listener = (changes) => {
    const change = changes?.[EXPERIMENTS_KEY];
    if (change) onChange(normalizeExperiments(change.newValue), normalizeExperiments(change.oldValue));
  };
  events.addListener(listener);
  return () => events.removeListener(listener);
}

// The worker mirrors the local toggle even when the sidebar isn't open. Read
// it again when a queued update runs so an older toggle can't win a race.
export function installSidebarAddressSearch(api) {
  if (typeof api?.breezerPrivate?.setAppearance !== 'function') return;
  let pending = Promise.resolve();
  const update = () => {
    pending = pending.then(async () => {
      const values = await api.storage.local.get(EXPERIMENTS_KEY);
      const sidebarAddressSearch = normalizeExperiments(values[EXPERIMENTS_KEY]).sidebarSearch;
      const appearance = await readAppearance(api);
      if (typeof appearance?.sidebarAddressSearch === 'boolean' &&
          appearance.sidebarAddressSearch !== sidebarAddressSearch) {
        await setNativeExperiment(api, { sidebarAddressSearch });
      }
    }).catch(() => {});
    return pending;
  };
  watchExperiments(api, (next, previous) => {
    if (next.sidebarSearch !== previous.sidebarSearch) void update();
  });
  return update();
}

// ------------------------------------------------------------------ personality

export function personalityInstruction(id) {
  return PERSONALITIES[id]?.instruction || '';
}

// Adds the chosen reply style to the profile context the native host already sends
// to the model. background.js sendChat calls this, so the New Tab handoff and the
// Cmd/Ctrl+K panel share one browser-wide setting.
export function applyPersonality(profile, experiments) {
  const name = String(profile?.name || '');
  const context = String(profile?.context || '');
  const instruction = personalityInstruction(normalizeExperiments(experiments).personality);
  if (!instruction) return { name, context };
  const style = `Reply style chosen in Breezer settings: ${instruction}`;
  return { name, context: context ? `${context}\n\n${style}` : style };
}

// ------------------------------------------------------------------ personality look

// Each preset also has a look. Pages mark <html data-personality="…"> so the New Tab
// and the assistant panel can change shape and type; the browser colors use the
// same theme path as AI theme proposals, which keeps the person's previous look
// for Restore. A theme the person applied themselves is never replaced.
export const personalityThemeName = (id) => `Breezer ${PERSONALITIES[id]?.label ?? ''} personality`.replace(/\s+/g, ' ');

const isPersonalityTheme = (record) => Boolean(record) && Object.entries(PERSONALITIES)
  .some(([id, preset]) => preset.seed && record.name === personalityThemeName(id) && record.theme === preset.seed);

const hasAppearanceBridge = (api) => typeof api?.breezerPrivate?.setAppearance === 'function' && typeof api?.breezerPrivate?.getAppearance === 'function';

// Returns { colors: 'applied' | 'restored' | 'kept' | 'unavailable' | 'unchanged', reason? }.
export async function applyPersonalityLook(api, id) {
  const preset = PERSONALITIES[id];
  if (!preset) throw new Error('Choose a listed personality.');
  if (!hasAppearanceBridge(api)) return { colors: 'unavailable' };
  const { applied } = await readThemeState({ api });
  const ours = isPersonalityTheme(applied);
  if (!preset.seed) {
    if (!ours) return { colors: 'unchanged' };
    await restorePreviousLook({ api });
    return { colors: 'restored' };
  }
  if (applied && !ours) return { colors: 'kept', reason: 'Your current theme was kept.' };
  try {
    await applyThemeProposal({ name: personalityThemeName(id), theme: preset.seed, colorMode: 'system' }, { api });
    return { colors: 'applied' };
  } catch (error) {
    return { colors: 'kept', reason: error?.message || 'Browser colors were not changed.' };
  }
}

// Marks root with the current preset and follows changes. Returns a stop function.
export function startPersonalityLook({ api = globalThis.chrome, root = globalThis.document?.documentElement } = {}) {
  if (!root) return () => {};
  const mark = (value) => {
    const id = normalizeExperiments(value).personality;
    if (id === 'off') delete root.dataset.personality; else root.dataset.personality = id;
  };
  void readExperiments(api).then(mark);
  return watchExperiments(api, mark);
}

// ------------------------------------------------------------------ glass

// Native material is optional. Builds whose appearance bridge reports a boolean
// `nativeGlass` field (the profile's AppKit material setting, absent where
// unsupported) get the real window backdrop; every build gets the page-level treatment,
// which turns solid in fullscreen and when the system asks for reduced transparency.
export async function glassSupport(api = globalThis.chrome) {
  if (typeof api?.breezerPrivate?.setAppearance !== 'function') return { native: false, on: false };
  const appearance = await readAppearance(api);
  const native = typeof appearance?.nativeGlass === 'boolean';
  return { native, on: native && appearance.nativeGlass };
}

// Returns true when the native material changed, false when this build has none.
// Throws when a supported write fails, so the caller can keep the old setting.
export async function applyGlassMaterial(api, on) {
  if (!(await glassSupport(api)).native) return false;
  await setNativeExperiment(api, { nativeGlass: on });
  return true;
}

async function setNativeExperiment(api, patch) {
  await new Promise((resolve, reject) => {
    const result = api.breezerPrivate.setAppearance(patch, () => {
      const error = api.runtime?.lastError;
      if (error) reject(new Error(error.message)); else resolve();
    });
    if (result && typeof result.then === 'function') result.then(resolve, reject);
  });
  // Open pages re-read appearance when this revision changes.
  await api.storage.local.set({ [APPEARANCE_REV_KEY]: Date.now() }).catch(() => {});
}

// 'glass' or 'solid' for a page surface.
export function glassMode({ enabled, fullscreen = false, reducedTransparency = false } = {}) {
  return enabled && !fullscreen && !reducedTransparency ? 'glass' : 'solid';
}

// ------------------------------------------------------------------ recent conversations

const oneLine = (value, limit) => (typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, limit) : '');

// Sidebar conversations belong to their window. Full-page conversations
// belong to the open chat tab, including when it moves to another window.
export function pickRecentChats(saved, windows, currentWindowId, limit = MAX_RECENT_CHATS, chatUrl) {
  const open = new Map((Array.isArray(windows) ? windows : [])
    .filter((win) => Number.isInteger(win?.id) && win.incognito !== true && (win.type ?? 'normal') === 'normal')
    .map((win) => [win.id, win]));
  const chats = [];
  const chatTabs = new Map();
  for (const win of open.values()) {
    for (const tab of win.tabs ?? []) {
      if (Number.isInteger(tab.id) && !tab.incognito && chatUrl && tab.url === chatUrl &&
          (!tab.pendingUrl || tab.pendingUrl === chatUrl)) chatTabs.set(tab.id, win.id);
    }
  }
  for (const [key, messages] of Object.entries(saved && typeof saved === 'object' ? saved : {})) {
    const fullChat = key.startsWith(FULL_CHAT_PREFIX);
    if ((!fullChat && !key.startsWith(CONVERSATION_PREFIX)) || !Array.isArray(messages)) continue;
    const tabId = fullChat ? Number(key.slice(FULL_CHAT_PREFIX.length)) : undefined;
    const windowId = fullChat ? chatTabs.get(tabId) : Number(key.slice(CONVERSATION_PREFIX.length));
    if (!open.has(windowId)) continue;
    const turns = messages.filter((item) => ['user', 'assistant'].includes(item?.role) && typeof item.text === 'string');
    const first = turns.find((item) => item.role === 'user' && oneLine(item.text, 1));
    if (!first) continue;
    const last = [...turns].reverse().find((item) => item.role === 'assistant' && oneLine(item.text, 1));
    chats.push({
      windowId,
      ...(fullChat ? { tabId } : {}),
      title: oneLine(first.text, 90),
      preview: last ? oneLine(last.text, 140) : '',
      messages: turns.length,
      current: windowId === currentWindowId,
      lastActivity: Math.max(0, ...turns.slice(-60).map(item => Number.isSafeInteger(item.lastActivity) ? item.lastActivity : 0)),
    });
  }
  chats.sort((a, b) => b.lastActivity - a.lastActivity || Number(b.current) - Number(a.current) || b.windowId - a.windowId);
  return chats.slice(0, limit);
}

export async function recentChats(api = globalThis.chrome, currentWindowId, limit = MAX_RECENT_CHATS) {
  const session = api?.storage?.session;
  if (typeof session?.get !== 'function' || typeof api?.windows?.getAll !== 'function') return [];
  const [saved, windows] = await Promise.all([session.get(null), api.windows.getAll({ populate: true })]);
  return pickRecentChats(saved, windows, currentWindowId, limit, api.runtime?.getURL?.(FULL_CHAT_PATH));
}

// ------------------------------------------------------------------ settings

const LOOK_MESSAGES = {
  applied: () => 'Browser colors changed to match. Choose Standard to put yours back.',
  restored: () => 'Your previous browser colors are back.',
  kept: (reason) => `Browser colors stayed the same. ${reason || ''}`.trim(),
  unavailable: () => 'This build can’t change browser colors, so only Breezer pages change.',
  unchanged: () => '',
};

const ROWS = [
  {
    group: 'Look',
    rows: [
      { flag: 'glass', label: 'Glossy glass', terms: 'glass translucent blur transparency vibrancy window material',
        description: (support) => (support.native
          ? 'Translucent window and New Tab surfaces. Fullscreen and Reduce transparency stay solid.'
          : 'Translucent New Tab surfaces. This build keeps the window frame solid, as do fullscreen and Reduce transparency.') },
      { flag: 'sidebarSearch', label: 'Address search in the sidebar', terms: 'address bar url search omnibox sidebar location',
        description: () => 'Open the address bar from the sidebar. In frameless sidebar layout, the top bar appears when needed.' },
      { flag: 'spaceDock', label: 'Space dock', terms: 'spaces dock switcher bottom sidebar icons',
        description: () => 'Shows your spaces as a row of icons at the foot of the sidebar.' },
    ],
  },
  {
    group: 'New tab',
    rows: [
      { flag: 'newTabComposer', label: 'Search and ask box', terms: 'new tab composer search ask ai minimal',
        description: () => 'Replaces the shortcut grid with one box: search the web, open an address or ask Breezer AI.' },
      { flag: 'newTabRecentChats', label: 'Recent conversations', parent: 'newTabComposer', terms: 'chats conversations history assistant recent',
        description: () => 'Lists up to three conversations from open windows under the box. They stay on this device.' },
      { flag: 'newTabShortcuts', label: 'Site shortcuts', parent: 'newTabComposer', terms: 'shortcuts sites favorites icons frequent',
        description: () => 'Shows your frequent sites as small icons under the box.' },
    ],
  },
];

function el(tag, className, attrs = {}) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  return node;
}

export async function mountExperimentSettings({ container, api }) {
  const [support, initial] = await Promise.all([glassSupport(api), readExperiments(api)]);
  let value = initial;
  const section = el('section', 'settings-section experiments', { 'aria-labelledby': 'experiments-heading', 'data-search-terms': 'experiments labs beta preview features' });
  const heading = el('h2', 'sr-only', { id: 'experiments-heading' });
  heading.textContent = 'Experiments';
  const note = el('p', 'section-note');
  note.textContent = 'Features still taking shape. Each one starts off and turning it off brings back the usual Breezer.';
  section.append(heading, note);
  const inputs = new Map();
  const error = el('p', 'field-error', { id: 'experiments-error', role: 'alert' });
  error.hidden = true;

  for (const { group, rows } of ROWS) {
    const label = el('h3', 'experiment-group-title');
    label.textContent = group;
    const list = el('div', 'setting-group experiment-group');
    for (const row of rows) {
      const id = `experiment-${row.flag}`;
      const node = el('div', `setting-row${row.parent ? ' experiment-child' : ''}`, { 'data-search-terms': row.terms, 'data-experiment-row': row.flag });
      const text = el('label', 'setting-label', { for: id });
      const small = el('small');
      small.textContent = row.description(support);
      const name = el('span');
      name.textContent = row.label;
      text.append(name, small);
      const input = el('input', 'toggle', { id, type: 'checkbox' });
      input.dataset.experiment = row.flag;
      if (row.parent) input.dataset.parent = row.parent;
      inputs.set(row.flag, input);
      node.append(text, input);
      list.append(node);
    }
    section.append(label, list);
  }

  const personalityTitle = el('h3', 'experiment-group-title');
  personalityTitle.textContent = 'Personality';
  const personalityGroup = el('div', 'setting-group experiment-group');
  const personalityRow = el('div', 'setting-row experiment-personality', { 'data-search-terms': 'personality reply style tone voice theme look colors concise brief warm tutor direct assistant command k' });
  const personalityLabel = el('span', 'setting-label', { id: 'experiment-personality-label' });
  const personalityHelp = el('small', '', { id: 'experiment-personality-help' });
  const personalityName = el('span');
  personalityName.textContent = 'Style';
  personalityLabel.append(personalityName, personalityHelp);
  const choices = el('div', 'segmented experiment-segmented', { role: 'radiogroup', 'aria-labelledby': 'experiment-personality-label', 'aria-describedby': 'experiment-personality-help' });
  for (const [id, preset] of Object.entries(PERSONALITIES)) {
    const choice = el('button', '', { type: 'button', role: 'radio', 'aria-checked': 'false' });
    choice.dataset.value = id;
    choice.textContent = preset.label;
    choices.append(choice);
  }
  personalityRow.append(personalityLabel, choices);
  const personalityNote = el('p', 'experiment-note');
  personalityNote.textContent = 'Applies to the sidebar and New Tab. Choose Standard to return to your previous look.';
  const lookStatus = el('p', 'experiment-note experiment-look-status', { role: 'status', 'aria-live': 'polite' });
  lookStatus.hidden = true;
  personalityGroup.append(personalityRow, personalityNote, lookStatus);
  section.append(personalityTitle, personalityGroup, error);
  container.replaceChildren(section);

  const render = () => {
    for (const [flag, input] of inputs) {
      input.checked = value[flag];
      const parent = input.dataset.parent;
      const muted = parent && !value[parent];
      input.disabled = Boolean(muted) || input.dataset.saving === 'true';
      input.closest('.setting-row').classList.toggle('muted-row', Boolean(muted));
    }
    for (const choice of choices.querySelectorAll('[role="radio"]')) {
      const checked = choice.dataset.value === value.personality;
      choice.setAttribute('aria-checked', String(checked));
      choice.tabIndex = checked ? 0 : -1;
    }
    personalityHelp.textContent = PERSONALITIES[value.personality].description;
  };

  const save = async (patch, input) => {
    error.hidden = true;
    if (input) input.dataset.saving = 'true';
    try {
      // The native material changes first; the experiment is stored only after it succeeds.
      if ('glass' in patch) await applyGlassMaterial(api, patch.glass);
      let look = null;
      if ('personality' in patch) look = await applyPersonalityLook(api, patch.personality);
      value = await writeExperiments(api, patch);
      if (look) {
        lookStatus.textContent = LOOK_MESSAGES[look.colors](look.reason);
        lookStatus.hidden = !lookStatus.textContent;
      }
    } catch (failure) {
      error.textContent = `Couldn’t save that experiment. ${failure?.message || 'Try again.'}`;
      error.hidden = false;
    } finally {
      if (input) delete input.dataset.saving;
      render();
      input?.focus();
    }
  };

  for (const [flag, input] of inputs) input.addEventListener('change', () => void save({ [flag]: input.checked }, input));
  const choose = (id) => { if (id !== value.personality) void save({ personality: id }); };
  choices.addEventListener('click', (event) => {
    const choice = event.target.closest('[role="radio"]');
    if (choice) choose(choice.dataset.value);
  });
  choices.addEventListener('keydown', (event) => {
    const radios = [...choices.querySelectorAll('[role="radio"]')];
    const at = radios.indexOf(event.target.closest('[role="radio"]'));
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
    if (at < 0 || !step) return;
    event.preventDefault();
    const next = radios[(at + step + radios.length) % radios.length];
    next.focus();
    choose(next.dataset.value);
  });
  if (!HAS_NATIVE_HELPER) {
    // Builds without the local assistant have nothing for these to change.
    personalityTitle.remove(); personalityGroup.remove();
    section.querySelector('[data-experiment-row="newTabRecentChats"]')?.remove();
    inputs.delete('newTabRecentChats');
  }
  const stop = watchExperiments(api, (next) => { value = next; render(); });
  render();
  return { dispose: stop };
}
