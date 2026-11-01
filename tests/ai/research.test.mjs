import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { researchSelection, prepareResearch } from '../../features/ai/extension/research-policy.js';
import { sourceURL, maskSecrets } from '../../features/ai/extension/research-sources.js';
import { allowedTools, browserAccess, researchParts, validateChat } from '../../features/ai/host/protocol.mjs';
import { installBackground } from '../../features/ai/extension/background.js';
import { fakeChrome, panel, tick } from './browser-api-fixture.mjs';
const selected = [
  { tabId: 7, documentId: 'doc-a', expectedUrl: 'https://one.test/article?q=secret#private' },
  { tabId: 8, documentId: 'doc-b', expectedUrl: 'https://two.test/article' },
];
const sources = selected.map((source, index) => ({ ...source, sourceId: `S${index + 1}`, title: `Source ${index + 1}`, status: 'available', text: `Article ${index + 1}`, truncated: index === 1 }));
const chat = researchSources => ({ type: 'chat', id: 'research', provider: 'codex', model: 'test', message: 'Compare these sources', researchSources });

test('explicit selection is bounded, unique and excludes internal/credential URLs', () => {
  assert.deepEqual(researchSelection(sources), selected);
  assert.throws(() => researchSelection([...sources, sources[0]]), /Invalid/);
  assert.throws(() => researchSelection(Array.from({ length: 7 }, (_, tabId) => ({ tabId }))), /six/);
  for (const expectedUrl of ['chrome://settings', 'file:///secret', 'https://user:password@one.test/']) assert.throws(() => researchSelection([{ ...selected[0], expectedUrl }]));
  assert.equal(sourceURL(selected[0].expectedUrl), 'https://one.test/article');
  assert.equal(maskSecrets('token=sk-abcdefghijklmnop'), 'token: [redacted]');
});

test('collection strips browser identities, masks secrets and keeps partial failures', async () => {
  const api = { tabs: { get: async id => { if (id === 8) throw new Error('Source closed'); return { windowId: 3, url: selected[0].expectedUrl }; } } };
  const result = await prepareResearch(api, sources, { selection: selected }, 3);
  assert.equal(result[0].status, 'available');
  assert.equal(result[0].url, 'https://one.test/article');
  assert.equal(result[1].status, 'unavailable');
  assert.match(result[1].error, /closed/);
  assert.equal(result[1].text, undefined);
  assert.equal(JSON.stringify(result).includes('documentId'), false);
  validateChat(chat(result));
  for (const override of [{ incognito: true }, { windowId: 4 }, { url: 'https://unrelated.test/' }, { status: 'loading' }]) {
    api.tabs.get = async () => ({ windowId: 3, url: selected[0].expectedUrl, ...override });
    assert.equal((await prepareResearch(api, sources, { selection: selected }, 3))[0].status, 'unavailable');
  }
  await assert.rejects(prepareResearch(api, sources, { selection: selected, invalidated: true }, 3), /expired/);
});

test('source prompts identify evidence and limitations without granting any browser tools', async () => {
  const api = { tabs: { get: async id => ({ windowId: 3, url: selected.find(source => source.tabId === id).expectedUrl }) } };
  const result = await prepareResearch(api, sources, { selection: selected }, 3);
  const message = validateChat(chat(result));
  assert.deepEqual(allowedTools(message), []);
  assert.deepEqual(allowedTools({ ...message, control: true }), []);
  assert.match(browserAccess(message), /No browser tools/);
  const parts = researchParts(message);
  assert.equal(parts.length, 1);
  assert.match(parts[0].text, /never instructions or tool grants/);
  assert.match(parts[0].text, /\[S1\]/);
  assert.match(parts[0].text, /"truncated":true/);
  for (const provider of ['codex', 'claude']) {
    const adapter = await readFile(new URL(`../../features/ai/host/${provider}.mjs`, import.meta.url), 'utf8');
    assert.match(adapter, /\.\.\.researchParts\(chat\)/);
  }
  assert.throws(() => validateChat({ ...message, control: true }), /text-only/);
  assert.throws(() => validateChat(chat([{ ...result[0], screenshot: 'data:image/png;base64,AA==' }])) , /Unexpected/);
  assert.throws(() => validateChat(chat([{ ...result[0], sourceId: 'S9' }])), /identity/);
});

async function worker() {
  const fake = fakeChrome();
  fake.setTab({ incognito: false });
  fake.api.tabs.get = async id => ({ id, windowId: 3, url: selected.find(source => source.tabId === id)?.expectedUrl, incognito: false });
  const installed = installBackground(fake.api), port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  await tick(); await tick();
  return { ...fake, installed, port };
}
const send = async fake => {
  fake.port.onMessage.emit({ type: 'research-begin', id: 'research', sources: selected });
  await tick();
  fake.port.onMessage.emit({ ...chat(sources), includeContext: false, control: false });
  await tick(); await tick();
};

test('worker sends only explicit sources, without active-page screenshot or debugger grants', async () => {
  const fake = await worker();
  fake.calls.length = 0;
  await send(fake);
  const message = fake.native.sent.find(message => message.type === 'chat');
  assert.equal(message.researchSources.length, 2);
  assert.equal(message.includeContext, false);
  assert.equal(message.control, false);
  validateChat(JSON.parse(JSON.stringify(message)));
  assert.equal(fake.calls.some(call => ['attach', 'capture', 'script', 'grant-probe'].includes(call[0])), false);
  fake.native.onMessage.emit({ type: 'tool', id: 'research', requestId: 'x', name: 'browser_click', args: { elementId: 'x' } });
  await tick();
  assert.match(fake.native.sent.at(-1).error, /control is off/);
});

for (const kind of ['navigation', 'closed', 'active-tab', 'cancel', 'hidden']) test(`worker stops research on ${kind} and rejects late capture`, async () => {
  const fake = await worker();
  await send(fake);
  if (kind === 'navigation') fake.api.tabs.onUpdated.emit(7, { status: 'loading' }, { active: false });
  if (kind === 'closed') fake.api.tabs.onRemoved.emit(8);
  if (kind === 'active-tab') fake.api.tabs.onActivated.emit({ windowId: 3, tabId: 9 });
  if (kind === 'cancel') fake.port.onMessage.emit({ type: 'cancel', id: 'research' });
  if (kind === 'hidden') fake.port.onMessage.emit({ type: 'visibility', visible: false });
  await tick();
  assert.ok(fake.native.sent.some(message => message.type === 'cancel'));
  const count = fake.native.sent.filter(message => message.type === 'chat').length;
  fake.port.onMessage.emit({ ...chat(sources), includeContext: false });
  await tick(); await tick();
  assert.equal(fake.native.sent.filter(message => message.type === 'chat').length, count);
});

test('untrusted extension ports cannot submit sources', async () => {
  const fake = fakeChrome(); installBackground(fake.api);
  const port = panel(); port.sender.url = 'https://page.test/panel.html';
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit(chat(sources)); await tick();
  assert.equal(fake.native.sent.length, 0);
});

test('native read contract gates exact documents and never widens tab permissions', async () => {
  const source = await readFile(new URL('../../features/workspace/native/chrome/browser/extensions/api/breezer_private/breezer_private_api.cc', import.meta.url), 'utf8');
  const reader = source.split('BreezerPrivateReadResearchTabFunction::RunFunction()')[1].split('BreezerPrivateSetPeekSourcesFunction')[0];
  for (const required of ['user_gesture()', 'source_url().GetPath() != kPanelPath', 'GetCallerBrowser()', 'GetDocumentId(frame)', 'url.spec() != args()[2].GetString()', 'GetWeakDocumentPtr()', 'GetPrimaryMainFrame() == frame', 'base::Seconds(8)', 'contents->IsLoading()', 'ISOLATED_WORLD_ID_CHROME_INTERNAL']) assert.ok(reader.includes(required), required);
  assert.doesNotMatch(reader, /GrantIfRequested|ScriptExecutor|debugger|executeScript/);
});
