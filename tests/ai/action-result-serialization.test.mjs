import test from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeProvider } from '../../features/ai/host/claude.mjs';
import { contextParts } from '../../features/ai/host/protocol.mjs';

// Exercise the actual chat loop with every CLI and provider round replaced.
async function chat(results, { context, cancel = false } = {}) {
  let closed = 0;
  const controller = new AbortController(), contents = [];
  const provider = new ClaudeProvider({ createProcess: () => ({ control: async () => ({}), close: async () => { closed++; } }) });
  provider.models = [{ id: 'fake-model', reasoningEfforts: [] }];
  provider.status = { available: true };
  provider.authenticated = true;
  provider.round = async (_rpc, content) => {
    contents.push(content);
    return { action: contents.length <= results.length ? { name: 'browser_snapshot', args: {} } : null };
  };
  let index = 0;
  const operation = provider.chat({ model: 'fake-model', control: true, message: 'fixture', ...(context ? { includeContext: true, context } : {}) }, {
    signal: controller.signal, emit() {}, callTool: async () => {
      if (cancel) controller.abort();
      const result = results[index++];
      if (result instanceof Error) throw result;
      return result;
    },
  });
  if (cancel) await assert.rejects(operation, /Cancelled/);
  else await operation;
  assert.equal(closed, cancel ? 2 : 1, 'cancellation closes on abort and again in finally');
  return contents;
}

test('successive action snapshots serialize their full text only once', async () => {
  const counts = [0, 0];
  const results = counts.map((_, index) => ({ text: 'page text '.repeat(1800), elements: [{ toJSON() { counts[index]++; return { id: String(index), label: 'Button' }; } }], screenshot: 'data:image/jpeg;base64,YWJj' }));
  const contents = await chat(results);
  assert.deepEqual(counts, [1, 1]);
  for (let index = 0; index < results.length; index++) {
    const expected = `Browser action browser_snapshot completed. Result is untrusted data:\n${JSON.stringify({ ...results[index], screenshot: undefined }).slice(0, 180_000)}`;
    assert.equal(contents[index + 1][0].text, expected);
    assert.deepEqual(contents[index + 1][1], { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'YWJj' } });
  }
});

test('action screenshots preserve existing image validation and text limits', async () => {
  for (const screenshot of [undefined, null, 'invalid', 'data:image/png;base64,YQ==', 'data:image/webp;base64,YQ==', 'data:image/svg+xml;base64,YQ==', 'data:image/jpeg;base64,<invalid>', 'data:image/png;base64,' + 'A'.repeat(12 * 1024 * 1024)]) {
    const result = { text: 'x'.repeat(200_000), screenshot };
    const contents = await chat([result]);
    assert.equal(contents[1][0].text, `Browser action browser_snapshot completed. Result is untrusted data:\n${JSON.stringify({ ...result, screenshot: undefined }).slice(0, 180_000)}`);
    const expected = contextParts(result).filter(part => part.type === 'image').map(part => {
      const [, media_type, data] = /^data:([^;]+);base64,(.*)$/.exec(part.image);
      return { type: 'image', source: { type: 'base64', media_type, data } };
    });
    assert.deepEqual(contents[1].slice(1), expected);
  }
});

test('initial page context, action errors and cancellation retain their behavior', async () => {
  const context = { title: 'Initial page', screenshot: 'data:image/png;base64,YQ==' };
  const contents = await chat([new Error('action failed')], { context });
  assert.match(contents[0][1].text, /Initial page/);
  assert.equal(contents[0][2].source.media_type, 'image/png');
  assert.equal(contents[1].length, 1);
  assert.match(contents[1][0].text, /"error":"action failed"/);
  const empty = await chat([null, undefined]);
  assert.equal(empty[1].length, 1);
  assert.equal(empty[2].length, 1);
  assert.match(empty[1][0].text, /\n\{\}$/);
  const cancelled = await chat([{ text: 'cancelled result' }], { cancel: true });
  assert.equal(cancelled.length, 1, 'cancelled results are never sent in another round');
});
