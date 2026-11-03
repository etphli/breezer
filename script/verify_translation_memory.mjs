#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  source: { type: 'string', default: 'features/ai/extension/translation-content.js' },
  output: { type: 'string' },
  'expect-released': { type: 'boolean', default: false },
} });
const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || '../tests/ai/node_modules/playwright/index.mjs');
const source = await readFile(resolve(values.source), 'utf8');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', route => route.fulfill({ contentType: 'text/html', body: '<!doctype html><p id="restore">Hola original</p><p id="edited">Texto original</p><main></main>' }));
  await page.goto('http://127.0.0.1/translation-memory');
  const client = await page.context().newCDPSession(page);
  const { frameTree } = await client.send('Page.getFrameTree');
  const { executionContextId } = await client.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'breezer-translation-memory' });
  const evaluate = async fn => {
    const result = await client.send('Runtime.callFunctionOn', { executionContextId, functionDeclaration: fn.toString(), returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  await evaluate(() => {
    const event = () => {
      const listeners = new Set();
      return { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn), fire: value => { for (const fn of [...listeners]) fn(value); } };
    };
    const onConnect = event();
    window.chrome = { runtime: { onConnect } };
    window.translationTest = {
      statuses: [], connection: null, disconnectAfterBatch: true,
      connect() {
        const connection = {
          name: 'breezer-translation-page', onMessage: event(), onDisconnect: event(),
          disconnect() { this.onDisconnect.fire(); },
          postMessage(message) {
            if (message.type === 'batch') queueMicrotask(() => this.onMessage.fire({ id: message.id, texts: message.texts.map(text => 'Translated: ' + text) }));
            if (message.type === 'status') {
              translationTest.statuses.push(message);
              if (message.state === 'loading' && message.total > 0 && translationTest.disconnectAfterBatch) this.disconnect();
            }
          },
        };
        this.connection = connection;
        onConnect.fire(connection);
      },
    };
  });
  const injected = await client.send('Runtime.evaluate', { contextId: executionContextId, expression: source });
  if (injected.exceptionDetails) throw new Error(injected.exceptionDetails.exception?.description || injected.exceptionDetails.text);
  const sample = async () => {
    await client.send('HeapProfiler.collectGarbage');
    const dom = await client.send('Memory.getDOMCounters');
    const heap = await client.send('Runtime.getHeapUsage');
    return { ...dom, usedHeapBytes: heap.usedSize };
  };
  const empty = await sample();
  await evaluate(() => {
    const fragment = document.createDocumentFragment();
    for (let i = 0; i < 10000; i++) {
      const span = document.createElement('span'); span.textContent = 'Sección ' + i + '. '; fragment.append(span);
    }
    document.querySelector('main').append(fragment);
    translationTest.connect();
    translationTest.connection.onMessage.fire({ type: 'start', dynamic: false });
  });
  await evaluate(async () => {
    for (let i = 0; i < 500; i++) {
      if (translationTest.statuses.some(status => status.state === 'loading' && status.total > 0)) return;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error('No translation batch completed');
  });
  assert.match(await page.locator('#restore').textContent(), /^Translated:/);
  const attached = await sample();
  await evaluate(() => {
    document.querySelector('main').remove();
    document.getElementById('edited').textContent = 'Changed by site';
  });
  await page.waitForTimeout(20);
  const detached = await sample();
  await evaluate(() => {
    translationTest.disconnectAfterBatch = false;
    translationTest.connect();
    translationTest.connection.onMessage.fire({ type: 'restore' });
  });
  assert.equal(await page.locator('#restore').textContent(), 'Hola original');
  assert.equal(await page.locator('#edited').textContent(), 'Changed by site');
  assert.equal(await evaluate(() => translationTest.statuses.at(-1).state), 'ready');
  const restored = await sample();
  const released = detached.nodes <= empty.nodes + 1000;
  const result = { browser: browser.version(), source: resolve(values.source),
    isolatedWorld: true, sourceSha256: createHash('sha256').update(source).digest('hex'), empty, attached, detached, restored,
    retainedExtraNodes: detached.nodes - empty.nodes, released,
    limits: 'Synthetic real-DOM retention check with production content script and fixture translation port in an isolated world. Forced GC; no provider calls or whole-browser RAM/CPU claim.' };
  if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (values['expect-released']) assert.ok(released, 'Translation records retain removed page content after the UI disconnects');
} finally {
  await browser.close();
}
