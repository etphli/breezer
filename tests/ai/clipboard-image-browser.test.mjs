import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

let chromium;
try { ({ chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || 'playwright')); } catch {}
const executablePath = process.env.BREEZER_TEST_BROWSER || (process.platform === 'darwin'
  ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  : undefined);
const skip = !chromium ? 'Playwright is not installed' : (executablePath && !existsSync(executablePath)
  ? `No browser at ${executablePath}`
  : false);
const limit = 512 * 1024;

test('pasted images use the existing image attachment format in Chromium', { skip }, async t => {
  const source = await readFile(new URL('../../features/ai/extension/clipboard-image.js', import.meta.url));
  const browser = await chromium.launch({ executablePath, headless: true });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route('https://clipboard-image.test/**', route => {
    if (route.request().url().endsWith('/clipboard-image.js')) {
      return route.fulfill({ contentType: 'application/javascript', body: source });
    }
    return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Clipboard image fixture</title>' });
  });
  await page.goto('https://clipboard-image.test/');

  await t.test('small PNG, JPEG and WebP files pass through by identity', async () => {
    const images = await page.evaluate(async () => {
      const { preparePastedImage } = await import('/clipboard-image.js');
      const canvas = document.createElement('canvas');
      canvas.getContext('2d').fillRect(0, 0, canvas.width, canvas.height);
      const types = ['image/png', 'image/jpeg', 'image/webp'];
      const results = [];
      for (const type of types) {
        const blob = await new Promise(resolve => canvas.toBlob(resolve, type, 0.8));
        const file = new File([blob], 'Small image', { type: blob.type });
        const output = await preparePastedImage(file);
        results.push({ type: output.type, sameFile: output === file });
      }
      return results;
    });
    assert.deepEqual(images, ['image/png', 'image/jpeg', 'image/webp'].map(type => ({ type, sameFile: true })));
  });

  await t.test('a high-entropy 4K PNG fits the wire limit and retains alpha', async () => {
    const image = await page.evaluate(async () => {
      const { preparePastedImage } = await import('/clipboard-image.js');
      const canvas = document.createElement('canvas');
      canvas.width = 3840;
      canvas.height = 2160;
      const context = canvas.getContext('2d');
      const pixels = context.createImageData(canvas.width, canvas.height);
      let seed = 713;
      for (let y = 0; y < canvas.height; y++) {
        for (let x = 0; x < canvas.width * 0.75; x++) {
          const offset = (y * canvas.width + x) * 4;
          seed ^= seed << 13;
          seed ^= seed >>> 17;
          seed ^= seed << 5;
          pixels.data[offset] = seed & 255;
          pixels.data[offset + 1] = (seed >>> 8) & 255;
          pixels.data[offset + 2] = (seed >>> 16) & 255;
          pixels.data[offset + 3] = 255;
        }
      }
      context.putImageData(pixels, 0, 0);
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const input = new File([png], 'Screenshot.png', { type: png.type });

      const close = ImageBitmap.prototype.close;
      let closed = 0;
      ImageBitmap.prototype.close = function () {
        close.call(this);
        closed++;
      };
      let output;
      try { output = await preparePastedImage(input); }
      finally { ImageBitmap.prototype.close = close; }

      const bitmap = await createImageBitmap(output);
      try {
        const { width, height } = bitmap;
        canvas.width = width;
        canvas.height = height;
        context.drawImage(bitmap, 0, 0);
        return {
          inputSize: input.size,
          outputSize: output.size,
          type: output.type,
          name: output.name,
          isFile: output instanceof File,
          width,
          height,
          transparentAlpha: context.getImageData(width - 1, height - 1, 1, 1).data[3],
          opaqueAlpha: context.getImageData(0, 0, 1, 1).data[3],
          closed,
        };
      } finally {
        bitmap.close();
      }
    });
    assert.ok(image.inputSize > limit * 10);
    assert.ok(image.outputSize > 0 && image.outputSize <= limit);
    assert.equal(image.isFile, true);
    assert.equal(image.type, 'image/webp');
    assert.equal(image.name, 'Screenshot.webp');
    assert.ok(image.width >= 960 && image.width <= 2560);
    assert.ok(Math.abs(image.height - image.width * 9 / 16) <= 1);
    assert.equal(image.transparentAlpha, 0);
    assert.equal(image.opaqueAlpha, 255);
    assert.equal(image.closed, 1);
  });

  await t.test('unreasonable inputs are rejected before decode and corrupt pixels get a readable error', async () => {
    const result = await page.evaluate(async () => {
      const { preparePastedImage } = await import('/clipboard-image.js');
      const canvas = document.createElement('canvas');
      const png = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
      const oversizedHeader = await png.slice(0, 33).arrayBuffer();
      new DataView(oversizedHeader).setUint32(16, 16_385);
      const overPixelBudget = await png.slice(0, 33).arrayBuffer();
      new DataView(overPixelBudget).setUint32(16, 8192);
      new DataView(overPixelBudget).setUint32(20, 8192);
      const largeInput = new Blob([new Uint8Array(1024 * 1024)]);
      const inputs = [
        new File(['text'], 'note.txt', { type: 'text/plain' }),
        new File([], 'Empty.png', { type: 'image/png' }),
        new File(Array(65).fill(largeInput), 'Too many bytes.png', { type: 'image/png' }),
        new File([oversizedHeader], 'Too wide.png', { type: 'image/png' }),
        new File([overPixelBudget], 'Too many pixels.png', { type: 'image/png' }),
        new File([png.slice(0, 33)], 'Corrupt.png', { type: 'image/png' }),
      ];
      const decode = globalThis.createImageBitmap;
      let decodeCalls = 0;
      globalThis.createImageBitmap = (...args) => {
        decodeCalls++;
        return decode(...args);
      };
      try {
        const errors = [];
        for (const input of inputs) {
          try { await preparePastedImage(input); errors.push(null); }
          catch (error) { errors.push(error.message); }
        }
        return { errors, decodeCalls };
      } finally {
        globalThis.createImageBitmap = decode;
      }
    });
    assert.deepEqual(result.errors, [
      'Paste a PNG, JPEG, or WebP image.',
      'The pasted image is empty.',
      'The pasted image is too large. Try a smaller screenshot.',
      'The pasted image is too large. Try a smaller screenshot.',
      'The pasted image is too large. Try a smaller screenshot.',
      'Could not decode the pasted image.',
    ]);
    assert.equal(result.decodeCalls, 1);
  });
});
