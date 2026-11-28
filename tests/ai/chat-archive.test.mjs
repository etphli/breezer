import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../../features/ai/extension/background.js';
import {
  CHAT_ID_PREFIX, CHAT_INDEX_KEY, CHAT_RECORD_PREFIX, CHAT_RETENTION_MS, MAX_CHAT_BYTES, MAX_SAVED_BYTES, MAX_SAVED_CHATS,
  clearChats, listChats, loadChat, pickRecentChats, pruneChats, readChatEpoch, recentChats, saveChat, saveChatTurn, validChatId,
} from '../../features/ai/extension/experiments.js';
import { event, fakeChrome, panel, tick } from './browser-api-fixture.mjs';

const NOW = Date.UTC(2026, 10, 25, 12);
const DAY = 24 * 60 * 60 * 1000;
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const talk = (question, answer, at = NOW) => [
  { id: `${question}-q`, role: 'user', text: question },
  ...(answer ? [{ id: `${question}-q-reply`, role: 'assistant', text: answer, lastActivity: at }] : []),
];

// In-memory chrome.storage with change events, a byte quota and optional failures.
function area({ quota = Infinity } = {}) {
  const data = {}, changed = event();
  const store = {
    data, quota, onChanged: changed,
    async get(keys) {
      const wanted = keys == null ? Object.keys(data) : [keys].flat();
      return Object.fromEntries(wanted.filter(key => key in data).map(key => [key, structuredClone(data[key])]));
    },
    async set(values) {
      const next = { ...data, ...structuredClone(values) };
      if (JSON.stringify(next).length > store.quota) throw new Error('Resource::kQuotaBytes quota exceeded');
      const changes = Object.fromEntries(Object.entries(values).map(([key, newValue]) => [key, { oldValue: data[key], newValue: structuredClone(newValue) }]));
      Object.assign(data, structuredClone(values));
      changed.emit(changes);
    },
    async remove(keys) {
      const changes = {};
      for (const key of [keys].flat()) if (key in data) { changes[key] = { oldValue: data[key] }; delete data[key]; }
      if (Object.keys(changes).length) changed.emit(changes);
    },
  };
  return store;
}
const chromeWith = options => ({ storage: { local: area(options), session: area() } });
const settle = async () => { for (let i = 0; i < 12; i++) await tick(); };

test('saved chats survive a restart, list newest first and expire seven days after their last message', async () => {
  const api = chromeWith();
  await saveChat(api, { id: uuid(1), epoch: '', messages: talk('Plan a garden', 'Start with the soil.', NOW - 6 * DAY) }, NOW);
  await saveChat(api, { id: uuid(2), epoch: '', messages: talk('Name a cat', 'Try Biscuit.', NOW) }, NOW);
  // A restart keeps storage.local and loses storage.session.
  const restarted = { storage: { local: api.storage.local, session: area() } };
  assert.deepEqual((await listChats(restarted, NOW)).map(chat => [chat.title, chat.preview, chat.messages]), [['Name a cat', 'Try Biscuit.', 2], ['Plan a garden', 'Start with the soil.', 2]]);
  assert.deepEqual((await loadChat(restarted, uuid(1), NOW)).messages.map(message => message.text), ['Plan a garden', 'Start with the soil.']);

  const edge = NOW + DAY;
  assert.equal((await loadChat(restarted, uuid(1), edge - 1)).messages.length, 2, 'kept until seven full days have passed');
  assert.equal(await loadChat(restarted, uuid(1), edge), null);
  assert.deepEqual((await listChats(restarted, edge)).map(chat => chat.id), [uuid(2)]);
  await pruneChats(restarted, edge);
  assert.equal(CHAT_RECORD_PREFIX + uuid(1) in api.storage.local.data, false);
  assert.equal(CHAT_RECORD_PREFIX + uuid(2) in api.storage.local.data, true);

  // New activity restarts the seven days.
  await saveChat(restarted, { id: uuid(2), epoch: '', messages: [...talk('Name a cat', 'Try Biscuit.', NOW), ...talk('Another?', 'Pepper.', edge)] }, edge);
  assert.equal((await loadChat(restarted, uuid(2), edge + CHAT_RETENTION_MS - 1)).messages.length, 4);
  assert.equal(await loadChat(restarted, uuid(2), edge + CHAT_RETENTION_MS), null);
});

test('pruning removes unlisted transcripts and limits a clock that was set forward', async () => {
  const api = chromeWith();
  await saveChat(api, { id: uuid(3), epoch: '', messages: talk('From the future', 'Hello.', NOW + 90 * DAY) }, NOW + 90 * DAY);
  api.storage.local.data[CHAT_RECORD_PREFIX + uuid(9)] = { version: 1, id: uuid(9), messages: talk('Orphan') };
  api.storage.local.data.breezerProfile = { name: 'Sample', context: '' };
  await pruneChats(api, NOW);
  assert.equal(CHAT_RECORD_PREFIX + uuid(9) in api.storage.local.data, false);
  assert.deepEqual(api.storage.local.data.breezerProfile, { name: 'Sample', context: '' }, 'other records stay');
  assert.equal((await listChats(api, NOW))[0].lastActivity, NOW);
  await pruneChats(api, NOW + CHAT_RETENTION_MS);
  assert.deepEqual(await listChats(api, NOW + CHAT_RETENTION_MS), []);
});

test('clearing removes saved and open chats and refuses a save that began before it', async () => {
  const api = chromeWith();
  const epoch = await readChatEpoch(api);
  await saveChat(api, { id: uuid(1), epoch, messages: talk('Private question', 'Reply.') }, NOW);
  await api.storage.session.set({
    'breezer-full-conversation-tab-7': talk('Private question'), [`${CHAT_ID_PREFIX}tab-7`]: uuid(1),
    'breezer-conversation-3': talk('Sidebar question'), 'breezer-pending-reply-chat-x': { id: 'x' }, 'workspace.window.3': { kept: true },
  });
  await clearChats(api);
  assert.deepEqual(Object.keys(api.storage.session.data), ['workspace.window.3']);
  assert.deepEqual(Object.keys(api.storage.local.data), [CHAT_INDEX_KEY]);
  assert.equal(await saveChat(api, { id: uuid(1), epoch, messages: talk('Private question', 'Late reply.') }, NOW), false);
  assert.equal(await saveChatTurn(api, { id: uuid(1), epoch, user: talk('Private question')[0], reply: { id: 'r', role: 'assistant', text: 'Late' } }, NOW), false);
  assert.deepEqual(await listChats(api, NOW), []);
  const next = await readChatEpoch(api);
  assert.notEqual(next, epoch);
  assert.equal(await saveChat(api, { id: uuid(4), epoch: next, messages: talk('A new question') }, NOW), true);
});

test('parallel saves keep every chat, and a clear among them wins', async () => {
  const api = chromeWith();
  await Promise.all(Array.from({ length: 12 }, (_, index) => saveChat(api, { id: uuid(index), epoch: '', messages: talk(`Question ${index}`, 'Answer') }, NOW + index)));
  assert.equal((await listChats(api, NOW + 12)).length, 12);
  await Promise.all([
    saveChat(api, { id: uuid(20), epoch: '', messages: talk('Before') }, NOW), clearChats(api),
    saveChat(api, { id: uuid(21), epoch: '', messages: talk('After') }, NOW),
  ]);
  assert.deepEqual(await listChats(api, NOW), []);
  assert.deepEqual(Object.keys(api.storage.local.data), [CHAT_INDEX_KEY]);
});

test('saved chats stay within their size, count and quota limits by dropping files before text', async () => {
  const api = chromeWith();
  const image = 'x'.repeat(MAX_CHAT_BYTES);
  await saveChat(api, { id: uuid(1), epoch: '', messages: [
    { id: 'a', role: 'user', text: 'Draw a pear', attachments: [{ name: 'notes.txt', text: 'small' }] },
    { id: 'b', role: 'assistant', text: 'Image created.', generatedImage: image },
    { id: 'c', role: 'user', text: 'Thanks' },
  ] }, NOW);
  const saved = await loadChat(api, uuid(1), NOW);
  assert.deepEqual(saved.messages.map(message => message.text), ['Draw a pear', 'Image created.', 'Thanks']);
  assert.equal(saved.messages[1].generatedImage, undefined);
  assert.deepEqual(saved.messages[0].attachments, [{ name: 'notes.txt', text: 'small' }]);

  await Promise.all(Array.from({ length: MAX_SAVED_CHATS + 5 }, (_, index) => saveChat(api, { id: uuid(100 + index), epoch: '', messages: talk(`Q${index}`) }, NOW + index + 1)));
  const listed = await listChats(api, NOW + 1000);
  assert.equal(listed.length, MAX_SAVED_CHATS);
  assert.equal(listed.some(chat => chat.id === uuid(1)), false, 'the oldest chat is dropped first');
  assert.equal(Object.keys(api.storage.local.data).filter(key => key.startsWith(CHAT_RECORD_PREFIX)).length, MAX_SAVED_CHATS);

  const heavy = chromeWith();
  for (let index = 0; index < 6; index++) await saveChat(heavy, { id: uuid(index), epoch: '', messages: [{ id: `${index}`, role: 'user', text: `Big ${index}`, attachments: [{ name: 'a.txt', text: 'y'.repeat(1_400_000) }] }] }, NOW + index);
  const total = (await listChats(heavy, NOW + 10)).reduce((sum, chat) => sum + chat.bytes, 0);
  assert.ok(total <= MAX_SAVED_BYTES);
  assert.equal((await listChats(heavy, NOW + 10))[0].id, uuid(5));

  const tight = chromeWith({ quota: 3_000_000 });
  for (let index = 0; index < 3; index++) await saveChat(tight, { id: uuid(index), epoch: '', messages: [{ id: `${index}`, role: 'user', text: `Big ${index}`, attachments: [{ name: 'a.txt', text: 'y'.repeat(1_200_000) }] }] }, NOW + index);
  assert.equal((await listChats(tight, NOW + 10))[0].id, uuid(2), 'a full quota makes room for the newest chat');
  tight.storage.local.quota = 10;
  await assert.rejects(saveChat(tight, { id: uuid(8), epoch: '', messages: talk('No room') }, NOW + 20), /quota/i);
});

test('a write failure other than quota keeps every older chat', async () => {
  const api = chromeWith();
  await saveChat(api, { id: uuid(1), epoch: '', messages: talk('Keep me', 'Yes.') }, NOW);
  const { set } = api.storage.local;
  api.storage.local.set = async () => { throw new Error('IO error'); };
  await assert.rejects(saveChat(api, { id: uuid(2), epoch: '', messages: talk('Lost') }, NOW), /IO error/);
  api.storage.local.set = set;
  assert.equal((await loadChat(api, uuid(1), NOW)).messages.length, 2);
});

test('private contexts, malformed ids and empty chats save nothing', async () => {
  const api = chromeWith();
  for (const id of ['', '../x', 'a', undefined, 7]) assert.equal(validChatId(id), false);
  assert.equal(await saveChat(api, { id: '../x', epoch: '', messages: talk('Hi') }, NOW), false);
  assert.equal(await saveChat(api, { id: uuid(1), epoch: undefined, messages: talk('Hi') }, NOW), false);
  assert.equal(await saveChat(api, { id: uuid(1), epoch: '', messages: [{ id: 'r', role: 'assistant', text: 'No question' }] }, NOW), false);
  assert.equal(await saveChat({ ...api, extension: { inIncognitoContext: true } }, { id: uuid(1), epoch: '', messages: talk('Hi') }, NOW), false);
  assert.deepEqual(Object.keys(api.storage.local.data), []);
});

test('recent chats list an open chat once and saved chats that are not open', async () => {
  const api = chromeWith();
  const url = 'chrome-extension://fixture/panel.html?view=chat';
  await saveChat(api, { id: uuid(1), epoch: '', messages: talk('Open chat', 'Yes', NOW) }, NOW);
  await saveChat(api, { id: uuid(2), epoch: '', messages: talk('Closed chat', 'Yes', NOW - DAY) }, NOW);
  await api.storage.session.set({ 'breezer-full-conversation-tab-7': talk('Open chat', 'Yes', NOW), [`${CHAT_ID_PREFIX}tab-7`]: uuid(1) });
  Object.assign(api, { runtime: { getURL: path => `chrome-extension://fixture/${path}` } });
  let tabs = [{ id: 7, url }];
  api.windows = { getAll: async () => [{ id: 1, tabs }] };
  const realNow = Date.now;
  Date.now = () => NOW;
  try {
    assert.deepEqual((await recentChats(api, 1)).map(({ id, tabId, title }) => [id, tabId, title]), [[undefined, 7, 'Open chat'], [uuid(2), undefined, 'Closed chat']]);
    // Back to New Tab in the same tab, or closing it, leaves the saved copy.
    tabs = [{ id: 7, url: 'chrome-extension://fixture/newtab.html' }];
    assert.deepEqual((await recentChats(api, 1)).map(chat => chat.id), [uuid(1), uuid(2)]);
  } finally { Date.now = realNow; }
  assert.deepEqual(pickRecentChats({}, [], 1, 1, url, await listChats(api, NOW)).map(chat => chat.id), [uuid(1)]);
});

// ------------------------------------------------------------------ worker

const ask = { type: 'chat', provider: 'codex', model: 'auto' };
async function worker() {
  const fake = fakeChrome();
  Object.assign(fake.api.storage, { local: area(), session: area() });
  fake.api.windows = { onFocusChanged: event(), onRemoved: event() };
  const natives = [];
  fake.api.runtime.connectNative = () => {
    const native = { sent: [], closed: false, onMessage: event(), onDisconnect: event(), postMessage(value) { this.sent.push(value); }, disconnect() { this.closed = true; } };
    natives.push(native);
    return native;
  };
  const background = installBackground(fake.api);
  const open = async (tabId, conversation, epoch = '') => {
    const port = panel();
    port.sender = { id: 'fixture', url: fake.api.runtime.getURL('panel.html?view=chat'), tab: { id: tabId, windowId: 3, incognito: false }, frameId: 0 };
    fake.api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'init', conversation, epoch });
    await settle();
    return { port, native: natives.at(-1) };
  };
  return { ...fake, natives, background, open, saved: id => loadChat(fake.api, id) };
}

test('two questions in one tab run as separate conversations', async () => {
  const { open, saved } = await worker();
  const first = await open(7, uuid(1));
  first.port.onMessage.emit({ ...ask, id: 'first', message: 'Explain tides' });
  await settle();
  first.native.onMessage.emit({ type: 'delta', id: 'first', text: 'The Moon' });
  first.port.onDisconnect.emit(); // Back to New Tab while it is still replying.

  const second = await open(7, uuid(2));
  assert.equal(second.port.sent.some(message => message.type === 'turn-state'), false, 'the earlier reply stays in its own chat');
  second.port.onMessage.emit({ ...ask, id: 'second', message: 'Name a cat' });
  await settle();
  assert.equal(first.native.sent.some(message => message.type === 'cancel'), false);
  assert.deepEqual(second.native.sent.find(message => message.type === 'chat').history, []);
  first.native.onMessage.emit({ type: 'delta', id: 'first', text: ' pulls the sea.' });
  first.native.onMessage.emit({ type: 'complete', id: 'first' });
  second.native.onMessage.emit({ type: 'delta', id: 'second', text: 'Biscuit' });
  second.native.onMessage.emit({ type: 'complete', id: 'second' });
  await settle();
  assert.deepEqual(second.port.sent.filter(message => message.type === 'delta').map(message => message.text), ['Biscuit']);
  assert.equal(first.native.closed, true, 'an unread finished reply releases its helper');
  assert.deepEqual((await saved(uuid(1))).messages.map(message => message.text), ['Explain tides', 'The Moon pulls the sea.']);
  assert.deepEqual((await saved(uuid(2))).messages.map(message => message.text), ['Name a cat', 'Biscuit']);

  const reopened = await open(9, uuid(1));
  assert.equal(reopened.port.sent.find(message => message.type === 'turn-state').text, 'The Moon pulls the sea.');
});

test('a running chat reopened in another tab keeps streaming there and outlives its first tab', async () => {
  const { api, open, saved } = await worker();
  const first = await open(7, uuid(1));
  first.port.onMessage.emit({ ...ask, id: 'long', message: 'Write a story' });
  await settle();
  first.port.onDisconnect.emit();
  const second = await open(9, uuid(1));
  assert.equal(second.port.sent.some(message => message.type === 'turn-state'), true);
  api.tabs.onRemoved.emit(7);
  await settle();
  first.native.onMessage.emit({ type: 'delta', id: 'long', text: 'Once upon a time' });
  assert.equal(second.port.sent.at(-1).text, 'Once upon a time');
  api.tabs.onRemoved.emit(9);
  await settle();
  assert.equal(first.native.sent.at(-1).type, 'cancel');
  assert.deepEqual((await saved(uuid(1))).messages.map(message => message.text), ['Write a story', 'Once upon a time']);
});

test('closing a tab stops every question it asked, keeps what was written and clears session copies', async () => {
  const { api, open, saved } = await worker();
  const first = await open(7, uuid(1));
  first.port.onMessage.emit({ ...ask, id: 'one', message: 'First' });
  await settle();
  first.port.onDisconnect.emit();
  const second = await open(7, uuid(2));
  second.port.onMessage.emit({ ...ask, id: 'two', message: 'Second' });
  await settle();
  second.native.onMessage.emit({ type: 'delta', id: 'two', text: 'Partial' });
  await api.storage.session.set({ 'breezer-full-conversation-tab-7': talk('Second'), [`${CHAT_ID_PREFIX}tab-7`]: uuid(2) });
  api.tabs.onRemoved.emit(7);
  await settle();
  assert.ok(first.native.sent.some(message => message.type === 'cancel' && message.id === 'one'));
  assert.ok(second.native.sent.some(message => message.type === 'cancel' && message.id === 'two'));
  assert.deepEqual((await saved(uuid(1))).messages.map(message => message.text), ['First', 'Stopped.']);
  assert.deepEqual((await saved(uuid(2))).messages.map(message => message.text), ['Second', 'Partial']);
  assert.deepEqual(Object.keys(api.storage.session.data), []);
});

test('a second live page cannot claim another tab’s conversation', async () => {
  const { open } = await worker();
  const first = await open(7, uuid(1));
  first.port.onMessage.emit({ ...ask, id: 'one', message: 'Mine' });
  await settle();
  const copy = await open(8, uuid(1));
  assert.equal(copy.port.sent.some(message => message.type === 'turn-state'), false);
  copy.port.onMessage.emit({ ...ask, id: 'two', message: 'Copy' });
  await settle();
  assert.equal(first.native.sent.some(message => message.type === 'cancel'), false);
});

test('clearing chats stops a reply no page is reading and never saves it again', async () => {
  const { api, open } = await worker();
  const first = await open(7, uuid(1));
  first.port.onMessage.emit({ ...ask, id: 'gone', message: 'Forget this' });
  await settle();
  first.port.onDisconnect.emit();
  await clearChats(api);
  await settle();
  assert.ok(first.native.sent.some(message => message.type === 'cancel'));
  first.native.onMessage.emit({ type: 'complete', id: 'gone' });
  await settle();
  assert.deepEqual(Object.keys(api.storage.local.data).filter(key => key.startsWith(CHAT_RECORD_PREFIX)), []);
  assert.deepEqual(Object.keys(api.storage.session.data), []);
});

test('sidebar chats are saved only while Recent conversations can reopen them', async () => {
  for (const on of [false, true]) {
    const { api, natives, saved } = await worker();
    await api.storage.local.set({ breezerExperiments: { newTabComposer: true, newTabRecentChats: on } });
    const port = panel();
    api.runtime.onConnect.emit(port);
    port.onMessage.emit({ type: 'init', windowId: 3, conversation: uuid(5), epoch: '' });
    await settle();
    port.onMessage.emit({ ...ask, id: 'side', message: 'Sidebar question' });
    await settle();
    natives[0].onMessage.emit({ type: 'delta', id: 'side', text: 'Sidebar answer' });
    natives[0].onMessage.emit({ type: 'complete', id: 'side' });
    await settle();
    assert.equal(Boolean(await saved(uuid(5))), on);
  }
});

test('the worker prunes expired chats when it starts', async () => {
  const fake = fakeChrome();
  Object.assign(fake.api.storage, { local: area(), session: area() });
  const old = Date.now() - 8 * DAY;
  await saveChat(fake.api, { id: uuid(1), epoch: '', messages: talk('Old', 'Yes', old) }, old);
  fake.api.windows = { onFocusChanged: event(), onRemoved: event() };
  installBackground(fake.api);
  await settle();
  assert.equal(CHAT_RECORD_PREFIX + uuid(1) in fake.api.storage.local.data, false);
});
