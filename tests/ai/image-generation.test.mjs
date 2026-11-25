import assert from 'node:assert/strict';
import test from 'node:test';
import { HostController } from '../../features/ai/host/controller.mjs';
import { generateOpenAiImage } from '../../features/ai/host/image-generation.mjs';
import { encodeMessage, validateChat } from '../../features/ai/host/protocol.mjs';
import { validGeneratedImage } from '../../features/ai/extension/reply-widgets.js';

const webp = 'UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
const image = 'data:image/webp;base64,' + webp;
const request = { type: 'chat', id: 'art', provider: 'codex', model: 'gpt-6.1-sol',
  message: 'Draw a blue pear.', browserTask: 'image' };

test('image helper sends a bounded prompt to the fixed endpoint and returns a WebP', async () => {
  const result = await generateOpenAiImage(request.message, new AbortController().signal, {
    apiKey: 'fixture-key',
    async fetchImage(url, options) {
      assert.equal(url, 'https://api.openai.com/v1/images/generations');
      assert.equal(options.redirect, 'error');
      assert.equal(options.headers.Authorization, 'Bearer fixture-key');
      const body = JSON.parse(options.body);
      assert.equal(body.prompt, request.message);
      assert.equal(body.n, 1);
      assert.equal(body.output_format, 'webp');
      return Response.json({ data: [{ b64_json: webp }] });
    },
  });
  assert.equal(result, image);
  assert.ok(validGeneratedImage(result));
  assert.ok(encodeMessage({ type: 'complete', id: request.id, generatedImage: result }).length < 1024 * 1024);
});

test('image generation is restricted to the GPT prompt and native response', async () => {
  for (const fields of [{ provider: 'claude' }, { model: 'other' }, { control: true },
    { includeContext: true }, { context: {} }, { attachments: [{ name: 'secret.txt', text: 'data' }] },
    { history: [{ role: 'user', content: 'Earlier chat' }] }]) {
    assert.throws(() => validateChat({ ...request, ...fields }), /Image generation|requires page access/);
  }
  const sent = [];
  const host = new HostController([], value => sent.push(value), {
    prepareChat() { assert.fail('Image generation must not inspect integration context'); },
    async generateImage(prompt, signal) {
      assert.equal(prompt, request.message);
      assert.equal(signal.aborted, false);
      return image;
    },
  });
  await host.receive(request);
  assert.deepEqual(sent, [{ type: 'complete', id: request.id, generatedImage: image }]);
});

test('unconfigured, malformed, and failed image requests cannot attach a result', async () => {
  const signal = new AbortController().signal;
  await assert.rejects(generateOpenAiImage(request.message, signal, {
    apiKey: '', fetchImage() { assert.fail('Connecting before configuration'); },
  }), /BREEZER_OPENAI_IMAGE_API_KEY/);
  await assert.rejects(generateOpenAiImage(request.message, signal, {
    apiKey: 'fixture', fetchImage: async () => Response.json({ data: [{ b64_json: 'bm90IGEgd2VicCBpbWFnZQ==' }] }),
  }), /unexpected image format/);
  await assert.rejects(generateOpenAiImage(request.message, signal, {
    apiKey: 'fixture', fetchImage: async () => Response.json({ error: 'private provider detail' }, { status: 401 }),
  }), /^Error: OpenAI image generation returned HTTP 401\./);
  assert.equal(validGeneratedImage('data:image/svg+xml;base64,AAAA'), false);
  assert.equal(validGeneratedImage('https://example.test/image'), false);
});
