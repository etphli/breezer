// Breezer experiments: opt-in features kept in one storage.local record.
//
//   chrome.storage.local['breezerExperiments'] = {
//     version: 1,
//     glass: false,             // glossy glass surfaces; native window material where the bridge offers it
//     glassOpacity: 66,         // opacity of the glossy page surfaces, in percent
//     sidebarSearch: false,     // search/address button in the sidebar (workspace-chrome.js)
//     newTabComposer: false,    // compact New Tab with Ask
//     newTabRecentChats: false, // open and saved conversations under the composer
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
// Which saved chat a tab or sidebar window is showing: '...tab-<id>' or '...window-<id>'.
export const CHAT_ID_PREFIX = 'breezer-chat-id-';
export const PENDING_REPLY_PREFIX = 'breezer-pending-reply-';
// New Tab leaves the chosen saved chat here for the chat page it opens in the same tab.
export const openChatKey = (tabId) => `breezer-open-chat-${tabId}`;

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
  glassOpacity: 66,
  personality: 'off',
});

const validOpacity = value => Number.isInteger(value) && value >= 0 && value <= 100;

export function normalizeExperiments(raw) {
  const source = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const value = { ...DEFAULT_EXPERIMENTS };
  for (const flag of FLAGS) value[flag] = source[flag] === true;
  if (validOpacity(source.glassOpacity)) value.glassOpacity = source.glassOpacity;
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
    } else if (key === 'glassOpacity') {
      if (!validOpacity(value)) throw new Error('Choose a glass opacity between 0 and 100.');
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

// The worker mirrors the local toggles even when the sidebar isn't open. Read
// it again when a queued update runs so an older toggle can't win a race.
export function installNativeAddressExperiments(api) {
  if (typeof api?.breezerPrivate?.setAppearance !== 'function') return;
  let pending = Promise.resolve();
  const update = () => {
    pending = pending.then(async () => {
      const values = await api.storage.local.get(EXPERIMENTS_KEY);
      const { sidebarSearch, newTabComposer } = normalizeExperiments(values[EXPERIMENTS_KEY]);
      const appearance = await readAppearance(api);
      const patch = {};
      if (typeof appearance?.sidebarAddressSearch === 'boolean' &&
          appearance.sidebarAddressSearch !== sidebarSearch) patch.sidebarAddressSearch = sidebarSearch;
      if (typeof appearance?.newTabComposer === 'boolean' &&
          appearance.newTabComposer !== newTabComposer) patch.newTabComposer = newTabComposer;
      if (Object.keys(patch).length) await setNativeExperiment(api, patch);
    }).catch(() => {});
    return pending;
  };
  watchExperiments(api, (next, previous) => {
    if (next.sidebarSearch !== previous.sidebarSearch || next.newTabComposer !== previous.newTabComposer) void update();
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
// Saved chats that are not open anywhere follow from the archive.
export function pickRecentChats(saved, windows, currentWindowId, limit = MAX_RECENT_CHATS, chatUrl, archived = []) {
  const open = new Map((Array.isArray(windows) ? windows : [])
    .filter((win) => Number.isInteger(win?.id) && win.incognito !== true && (win.type ?? 'normal') === 'normal')
    .map((win) => [win.id, win]));
  const chats = [];
  const chatTabs = new Map();
  const openIds = new Set();
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
    const summary = summarizeChat(messages);
    if (!summary) continue;
    openIds.add(saved[`${CHAT_ID_PREFIX}${fullChat ? `tab-${tabId}` : `window-${windowId}`}`]);
    chats.push({
      windowId,
      ...(fullChat ? { tabId } : {}),
      ...summary,
      current: windowId === currentWindowId,
    });
  }
  for (const { id, title, preview, messages, lastActivity } of archived) {
    if (!openIds.has(id)) chats.push({ id, title, preview, messages, current: false, lastActivity });
  }
  chats.sort((a, b) => b.lastActivity - a.lastActivity || Number(b.current) - Number(a.current) || (b.windowId ?? 0) - (a.windowId ?? 0));
  return chats.slice(0, limit);
}

export async function recentChats(api = globalThis.chrome, currentWindowId, limit = MAX_RECENT_CHATS) {
  const session = api?.storage?.session;
  const archived = await listChats(api).catch(() => []);
  if (typeof session?.get !== 'function' || typeof api?.windows?.getAll !== 'function') return pickRecentChats({}, [], currentWindowId, limit, undefined, archived);
  const [saved, windows] = await Promise.all([session.get(null), api.windows.getAll({ populate: true })]);
  return pickRecentChats(saved, windows, currentWindowId, limit, api.runtime?.getURL?.(FULL_CHAT_PATH), archived);
}

// ------------------------------------------------------------------ saved chats
// Transcripts stay in this profile's extension storage for seven days after the
// last message. They are never written from a private window.
//
//   chrome.storage.local['breezerChats']     { version, epoch, chats: [summary] }
//   chrome.storage.local['breezerChat.<id>'] { version, id, createdAt, lastActivity, messages }
//
// Clearing replaces the epoch. A save that began before it carries the old epoch
// and is refused, so a page or reply still finishing cannot bring a chat back.

export const CHAT_INDEX_KEY = 'breezerChats';
export const CHAT_RECORD_PREFIX = 'breezerChat.';
export const CHAT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_SAVED_CHATS = 100;
export const MAX_CHAT_BYTES = 1_500_000;
// Leaves about half of the extension's 10 MB for everything else it stores.
export const MAX_SAVED_BYTES = 5_000_000;
const MAX_CHAT_MESSAGES = 60;
const CHAT_PRUNE_ALARM = 'breezer-saved-chats';

const recordKey = (id) => CHAT_RECORD_PREFIX + id;
const byteLength = (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength;
export const validChatId = (value) => typeof value === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(value);
const isTurn = (item) => ['user', 'assistant'].includes(item?.role) && typeof item.text === 'string';

function summarizeChat(messages) {
  const turns = messages.filter(isTurn);
  const first = turns.find((item) => item.role === 'user' && oneLine(item.text, 1));
  if (!first) return null;
  const last = [...turns].reverse().find((item) => item.role === 'assistant' && oneLine(item.text, 1));
  return {
    title: oneLine(first.text, 90),
    preview: last ? oneLine(last.text, 140) : '',
    messages: turns.length,
    lastActivity: Math.max(0, ...turns.slice(-MAX_CHAT_MESSAGES).map((item) => Number.isSafeInteger(item.lastActivity) ? item.lastActivity : 0)),
  };
}

// Pages and the worker share one lock, so no writer can drop another's index entry.
let chatWrites = Promise.resolve();
function withSavedChats(work) {
  const locks = globalThis.navigator?.locks;
  if (locks) return locks.request(CHAT_INDEX_KEY, work);
  const result = chatWrites.then(work);
  chatWrites = result.catch(() => {});
  return result;
}

async function readChatIndex(api) {
  const raw = (await api.storage.local.get(CHAT_INDEX_KEY))?.[CHAT_INDEX_KEY];
  return {
    version: 1,
    epoch: typeof raw?.epoch === 'string' ? raw.epoch : '',
    chats: (Array.isArray(raw?.chats) ? raw.chats : []).filter((chat) => validChatId(chat?.id) && typeof chat.title === 'string'
      && Number.isSafeInteger(chat.lastActivity) && Number.isSafeInteger(chat.bytes)),
  };
}

const expiredChat = (chat, now) => now - chat.lastActivity >= CHAT_RETENTION_MS;
const newestFirst = (a, b) => b.lastActivity - a.lastActivity;

export async function readChatEpoch(api) {
  return (await readChatIndex(api)).epoch;
}

export async function listChats(api, now = Date.now()) {
  return (await readChatIndex(api)).chats.filter((chat) => !expiredChat(chat, now)).sort(newestFirst);
}

export async function loadChat(api, id, now = Date.now()) {
  if (!validChatId(id)) return null;
  const chat = (await readChatIndex(api)).chats.find((item) => item.id === id);
  if (!chat || expiredChat(chat, now)) return null;
  const record = (await api.storage.local.get(recordKey(id)))?.[recordKey(id)];
  return Array.isArray(record?.messages) ? { ...record, messages: record.messages.filter(isTurn) } : null;
}

// Text is kept ahead of files: older images go first, then older attachments, then older turns.
function compactMessages(messages) {
  const kept = messages.filter(isTurn).slice(-MAX_CHAT_MESSAGES).map((message) => ({ ...message }));
  const sizes = kept.map(byteLength);
  let total = sizes.reduce((sum, size) => sum + size, 0);
  const strip = (fields) => {
    for (let index = 0; index < kept.length && total > MAX_CHAT_BYTES; index++) {
      if (!fields.some((field) => kept[index][field])) continue;
      for (const field of fields) delete kept[index][field];
      total -= sizes[index];
      sizes[index] = byteLength(kept[index]);
      total += sizes[index];
    }
  };
  strip(['generatedImage']);
  strip(['attachments', 'themeProposal']);
  while (kept.length > 1 && total > MAX_CHAT_BYTES) { total -= sizes.shift(); kept.shift(); }
  return kept;
}

async function storeChat(api, index, { id, messages, createdAt }, now) {
  const kept = compactMessages(messages);
  const summary = summarizeChat(kept);
  if (!summary) return false;
  const lastActivity = Math.min(now, summary.lastActivity || now);
  const record = { version: 1, id, createdAt, lastActivity, messages: kept };
  const chat = { id, ...summary, lastActivity, bytes: byteLength(record) };
  if (expiredChat(chat, now) || chat.bytes > MAX_SAVED_BYTES) return false;
  const write = async (budget) => {
    const others = index.chats.filter((item) => item.id !== id).sort(newestFirst);
    const chats = [chat];
    const dropped = [];
    let total = chat.bytes;
    for (const item of others) {
      if (expiredChat(item, now) || chats.length >= MAX_SAVED_CHATS || total + item.bytes > budget) { dropped.push(recordKey(item.id)); continue; }
      total += item.bytes;
      chats.push(item);
    }
    if (dropped.length) await api.storage.local.remove(dropped);
    await api.storage.local.set({ [recordKey(id)]: record, [CHAT_INDEX_KEY]: { ...index, chats } });
  };
  try { await write(MAX_SAVED_BYTES); }
  catch (error) {
    // Other features share this quota. Make room once by dropping the oldest chats.
    if (!/quota/i.test(error?.message)) throw error;
    await write(Math.max(chat.bytes, MAX_SAVED_BYTES / 4));
  }
  return true;
}

const canSaveChats = (api, id, epoch) => validChatId(id) && typeof epoch === 'string'
  && api?.extension?.inIncognitoContext !== true && typeof api?.storage?.local?.set === 'function';

// Replaces a chat's transcript with the one its page is showing.
export function saveChat(api, { id, epoch, messages }, now = Date.now()) {
  if (!canSaveChats(api, id, epoch) || !Array.isArray(messages)) return Promise.resolve(false);
  const snapshot = structuredClone(messages);
  return withSavedChats(async () => {
    const index = await readChatIndex(api);
    if (index.epoch !== epoch) return false;
    const existing = index.chats.some((chat) => chat.id === id) ? (await api.storage.local.get(recordKey(id)))?.[recordKey(id)] : null;
    return storeChat(api, index, { id, messages: snapshot, createdAt: existing?.createdAt ?? now }, now);
  });
}

// Adds a finished turn when its page may already be gone. The page's own copy wins.
export function saveChatTurn(api, { id, epoch, user, reply }, now = Date.now()) {
  if (!canSaveChats(api, id, epoch) || !isTurn(user) || !isTurn(reply)) return Promise.resolve(false);
  return withSavedChats(async () => {
    const index = await readChatIndex(api);
    if (index.epoch !== epoch) return false;
    const existing = index.chats.some((chat) => chat.id === id) ? (await api.storage.local.get(recordKey(id)))?.[recordKey(id)] : null;
    const messages = (existing?.messages ?? []).filter(isTurn);
    if (messages.some((item) => item.id === reply.id)) return false;
    const at = messages.findIndex((item) => item.id === user.id);
    const turn = [...(at < 0 ? [user] : []), { ...reply, lastActivity: now }];
    messages.splice(at < 0 ? messages.length : at + 1, 0, ...turn);
    return storeChat(api, index, { id, messages, createdAt: existing?.createdAt ?? now }, now);
  });
}

async function savedChatKeys(api) {
  const local = api.storage.local;
  const keys = typeof local.getKeys === 'function' ? await local.getKeys() : Object.keys(await local.get(null) ?? {});
  return keys.filter((key) => key.startsWith(CHAT_RECORD_PREFIX));
}

// Removes expired chats and any transcript the index no longer lists.
export function pruneChats(api, now = Date.now()) {
  return withSavedChats(async () => {
    const index = await readChatIndex(api);
    const keys = await savedChatKeys(api);
    // A clock that was set forward must not keep a chat past its seven days.
    const chats = index.chats.filter((chat) => !expiredChat(chat, now) && keys.includes(recordKey(chat.id)))
      .map((chat) => chat.lastActivity > now ? { ...chat, lastActivity: now } : chat);
    const keep = new Set(chats.map((chat) => recordKey(chat.id)));
    const removed = keys.filter((key) => !keep.has(key));
    if (removed.length) await api.storage.local.remove(removed);
    if (JSON.stringify(chats) !== JSON.stringify(index.chats)) await api.storage.local.set({ [CHAT_INDEX_KEY]: { ...index, chats } });
    return removed.length;
  });
}

// Clears saved and open chats. Open chat pages see the new epoch and start over.
export function clearChats(api) {
  return withSavedChats(async () => {
    await api.storage.local.set({ [CHAT_INDEX_KEY]: { version: 1, epoch: crypto.randomUUID(), chats: [] } });
    const records = await savedChatKeys(api);
    if (records.length) await api.storage.local.remove(records);
    const session = api.storage.session;
    if (typeof session?.get !== 'function' || typeof session.remove !== 'function') return;
    const prefixes = [FULL_CHAT_PREFIX, CONVERSATION_PREFIX, CHAT_ID_PREFIX, PENDING_REPLY_PREFIX];
    const keys = Object.keys(await session.get(null) ?? {}).filter((key) => prefixes.some((prefix) => key.startsWith(prefix)));
    if (keys.length) await session.remove(keys);
  });
}

// The worker prunes when it starts and every few hours while the browser stays open.
export function installSavedChats(api, onCleared = () => {}) {
  if (api?.extension?.inIncognitoContext === true || typeof api?.storage?.local?.get !== 'function') return;
  const prune = () => { void pruneChats(api).catch(() => {}); };
  prune();
  if (api.alarms?.onAlarm?.addListener) {
    api.alarms.onAlarm.addListener((alarm) => { if (alarm?.name === CHAT_PRUNE_ALARM) prune(); });
    void Promise.resolve(api.alarms.create?.(CHAT_PRUNE_ALARM, { periodInMinutes: 360 })).catch(() => {});
  }
  api.storage.local.onChanged?.addListener?.((changes) => {
    const change = changes?.[CHAT_INDEX_KEY];
    if (change && typeof change.newValue?.epoch === 'string' && change.newValue.epoch !== (change.oldValue?.epoch ?? '')) onCleared(change.newValue.epoch);
  });
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
        description: () => 'Shows the page address and your extensions in the sidebar. In frameless mode, Layout controls the top bar.' },
      { flag: 'spaceDock', label: 'Space dock', terms: 'spaces dock switcher bottom sidebar icons',
        description: () => 'Shows your spaces as a row of icons at the foot of the sidebar.' },
    ],
  },
  {
    group: 'New tab',
    rows: [
      { flag: 'newTabComposer', label: 'Search and ask box', terms: 'new tab composer search ask ai minimal',
        description: () => 'Adds Ask Breezer to search and uses a compact New Tab layout.' },
      { flag: 'newTabRecentChats', label: 'Recent conversations', parent: 'newTabComposer', terms: 'chats conversations history assistant recent',
        description: () => 'Lists your chats under the box. They stay on this device for seven days after the last message.' },
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

// A button that asks once before it clears. Moving away cancels it.
export function wireClearChats(button, api, { onCleared = () => {}, onError = () => {} } = {}) {
  const label = button.textContent;
  const reset = () => { delete button.dataset.confirm; button.textContent = label; };
  button.addEventListener('blur', reset);
  button.addEventListener('click', async () => {
    if (button.dataset.confirm !== 'true') {
      button.dataset.confirm = 'true';
      button.textContent = 'Clear all chats?';
      return;
    }
    reset();
    button.disabled = true;
    try { await clearChats(api); onCleared(); }
    catch (error) { onError(error); }
    finally { button.disabled = false; }
  });
}

function clearChatsRow(api) {
  const row = el('div', 'setting-row', { 'data-search-terms': 'clear delete saved chats conversations history', 'data-experiment-row': 'savedChats' });
  const text = el('span', 'setting-label');
  const name = el('span');
  name.textContent = 'Saved chats';
  const help = el('small', '', { role: 'status' });
  help.textContent = 'Clears saved chats and any that are open.';
  text.append(name, help);
  const button = el('button', 'button', { type: 'button', id: 'clear-saved-chats' });
  button.textContent = 'Clear';
  wireClearChats(button, api, {
    onCleared: () => { help.textContent = 'Chats cleared.'; },
    onError: () => { help.textContent = 'Couldn’t clear your chats. Try again.'; },
  });
  row.append(text, button);
  return row;
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
  const opacityRow = el('div', 'setting-row experiment-child', { 'data-search-terms': 'glass opacity transparency translucent' });
  const opacityLabel = el('label', 'setting-label', { for: 'experiment-glass-opacity' });
  opacityLabel.textContent = 'Glass opacity';
  const opacityHelp = el('small', '', { id: 'glass-opacity-help' });
  opacityHelp.textContent = 'Adjusts glossy surfaces on New Tab and the sidebar.';
  opacityLabel.append(opacityHelp);
  const opacityControls = el('span', 'range-control');
  const opacity = el('input', '', { id: 'experiment-glass-opacity', type: 'range', min: '0', max: '100', 'aria-describedby': opacityHelp.id });
  const opacityValue = el('output', '', { for: opacity.id });
  opacityControls.append(opacity, opacityValue);
  opacityRow.append(opacityLabel, opacityControls);

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
      if (row.flag === 'newTabShortcuts') list.append(clearChatsRow(api));
      if (row.flag === 'glass') list.append(opacityRow);
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
    opacity.value = value.glassOpacity;
    opacityValue.textContent = `${value.glassOpacity}%`;
    opacity.disabled = !value.glass || opacity.dataset.saving === 'true';
    opacityRow.classList.toggle('muted-row', !value.glass);
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
  opacity.addEventListener('input', () => { opacityValue.textContent = `${opacity.value}%`; });
  opacity.addEventListener('change', () => void save({ glassOpacity: opacity.valueAsNumber }, opacity));
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
    for (const row of ['newTabRecentChats', 'savedChats']) section.querySelector(`[data-experiment-row="${row}"]`)?.remove();
    inputs.delete('newTabRecentChats');
  }
  const stop = watchExperiments(api, (next) => { value = next; render(); });
  render();
  return { dispose: stop };
}
