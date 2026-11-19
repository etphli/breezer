import assert from 'node:assert/strict';
import test from 'node:test';
import { installBackground } from '../../features/ai/extension/background.js';
import { HostController } from '../../features/ai/host/controller.mjs';
import { allowedTools, promptText, validateChat, validateTool } from '../../features/ai/host/protocol.mjs';
import { fakeChrome, panel, tick } from './browser-api-fixture.mjs';

const chat = { type: 'chat', id: 'chat', provider: 'codex', model: 'auto', message: 'Test request' };
const proposal = { name: 'Night sky', theme: '#263045', colorMode: 'dark', html: '<div>Night sky</div>' };

test('browser tasks grant only the selected tool and reject page and research access', () => {
  for (const [browserTask, name, args] of [['stats', 'browser_stats', {}], ['theme', 'browser_propose_theme', proposal]]) {
    const request = validateChat({ ...chat, browserTask });
    const tools = allowedTools({ ...request, organato: true });
    assert.deepEqual(tools.map(tool => tool.name), [name]);
    assert.equal(validateTool(name, args, tools), args);
    assert.throws(() => validateTool('browser_snapshot', {}, tools), /not permitted/);
    for (const fields of [{ control: true }, { includeContext: true }, { context: {} }, { researchSources: [] }]) {
      assert.throws(() => validateChat({ ...request, ...fields }), /page access and research/);
    }
    assert.doesNotMatch(promptText({ ...request, organato: true }), /Organato access is enabled/);
  }
  assert.throws(() => validateTool('browser_propose_theme', { ...proposal, theme: 'red' }, allowedTools({ browserTask: 'theme' })), /hex color/);
  assert.throws(() => validateTool('browser_propose_theme', { ...proposal, image: 'https://example.test/photo.png' }, allowedTools({ browserTask: 'theme' })), /Invalid browser tool arguments/);
});

test('native browser tools run without loading the unrelated Organato account', async () => {
  const received = [];
  const provider = {
    id: 'codex',
    async discover() { return { id: 'codex', available: true, authenticated: true }; },
    async chat(request) { received.push(request); },
  };
  const host = new HostController([provider], () => {}, { prepareChat() { assert.fail('Organato is not a browser-task dependency'); } });
  for (const browserTask of ['stats', 'theme']) await host.receive({ ...chat, browserTask });
  assert.deepEqual(received.map(request => [request.browserTask, request.organato]), [['stats', false], ['theme', false]]);
});

test('the worker forwards theme proposals only after a successful opted-in turn', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  await tick();

  const requestTheme = (id, args = proposal) => {
    fake.native.onMessage.emit({ type: 'tool', id, requestId: id, name: 'browser_propose_theme', args });
    return tick();
  };
  const start = async (id, fields) => {
    port.onMessage.emit({ ...chat, id, ...fields });
    await tick();
  };
  await start('ordinary');
  await requestTheme('ordinary');
  assert.match(fake.native.sent.at(-1).error, /Theme design is off/);

  await start('theme', { browserTask: 'theme' });
  assert.equal(fake.native.sent.at(-1).browserTask, 'theme');
  assert.equal(fake.native.sent.at(-1).context, undefined);
  await requestTheme('theme', { ...proposal, name: ' ' });
  assert.match(fake.native.sent.at(-1).error, /Provide a name/);
  await requestTheme('theme');
  assert.deepEqual(fake.native.sent.at(-1).result, { staged: true, name: proposal.name, applied: false });
  assert.equal(port.sent.some(message => message.themeProposal), false);
  fake.native.onMessage.emit({ type: 'complete', id: 'theme' });
  assert.deepEqual(port.sent.at(-1).themeProposal, proposal);

  await start('cancelled', { browserTask: 'theme' });
  await requestTheme('cancelled');
  fake.native.onMessage.emit({ type: 'complete', id: 'cancelled', cancelled: true });
  assert.equal(port.sent.at(-1).themeProposal, undefined);

  await start('missing', { browserTask: 'theme' });
  fake.native.onMessage.emit({ type: 'complete', id: 'missing' });
  assert.equal(port.sent.at(-1).source, 'theme');
  assert.match(port.sent.at(-1).error, /did not create a theme preview/);
  assert.equal(fake.calls.some(([call]) => call === 'capture' || call === 'attach'), false);
});

test('theme wallpaper refers to an image the user attached, without returning pixels from the native host', async () => {
  const fake = fakeChrome();
  installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  await tick();
  const history = [{ role: 'user', content: 'Use this photo.', attachments: [{ name: 'sky.png', image: 'data:image/png;base64,AA==' }] }];
  const request = { ...chat, browserTask: 'theme', history };
  assert.match(promptText(request), /"number":1,"name":"sky.png"/);
  port.onMessage.emit(request);
  await tick();
  const tool = imageAttachment => fake.native.onMessage.emit({
    type: 'tool', id: chat.id, requestId: String(imageAttachment), name: 'browser_propose_theme',
    args: { ...proposal, imageAttachment },
  });
  tool(2);
  await tick();
  assert.match(fake.native.sent.at(-1).error, /latest image attachments/);
  tool(1);
  await tick();
  fake.native.onMessage.emit({ type: 'complete', id: chat.id });
  assert.deepEqual(port.sent.at(-1).themeProposal, { ...proposal, imageAttachment: 1 });
});

test('the worker sends measured browser stats to the panel and gives the provider the same snapshot', async () => {
  const fake = fakeChrome();
  fake.setTab({ incognito: false });
  installBackground(fake.api);
  const port = panel();
  fake.api.runtime.onConnect.emit(port);
  port.onMessage.emit({ type: 'init', windowId: 3 });
  await tick();
  const callsBefore = fake.calls.length;
  port.onMessage.emit({ ...chat, browserTask: 'stats' });
  await tick();
  assert.equal(fake.calls.length, callsBefore + 1, 'sending a stats request samples once');
  const request = { type: 'tool', id: chat.id, name: 'browser_stats', args: {} };
  fake.native.onMessage.emit({ ...request, requestId: 'first' });
  await tick();
  const first = fake.native.sent.at(-1);
  const callsAfter = fake.calls.length;
  assert.equal(first.error, undefined);
  assert.ok(first.result);
  const { stats } = port.sent.find(message => message.type === 'browser-stats');
  assert.equal(stats.totalTabCount, first.result.totalTabCount);
  assert.equal(stats.windowTabCount, first.result.windowTabCount);
  assert.deepEqual(stats.browserMemory, first.result.browserMemory);
  assert.deepEqual(stats.systemMemory, first.result.systemMemory);
  assert.doesNotMatch(JSON.stringify(first.result), /example\.test/);
  fake.native.onMessage.emit({ ...request, requestId: 'second' });
  await tick();
  assert.deepEqual(fake.native.sent.at(-1).result, first.result);
  assert.equal(fake.calls.length, callsAfter);
  assert.equal(fake.calls.some(([call]) => call === 'capture' || call === 'attach'), false);
});
