#!/usr/bin/env node
// Run against a disposable browser, without reading a user profile.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values } = parseArgs({ options: {
  source: { type: 'string', default: 'features/ai/extension/page-context.js' },
  output: { type: 'string' },
  'expect-released': { type: 'boolean', default: false },
} });
const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || '../tests/ai/node_modules/playwright/index.mjs');
const originalSource = await readFile(resolve(values.source), 'utf8');
const source = originalSource.replace('export function pageContext', 'function pageContext');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.setContent('<!doctype html><style>a{position:absolute;top:20px;left:20px;width:200px;height:30px;overflow:hidden}</style><main></main>');
  const client = await page.context().newCDPSession(page);
  const { frameTree } = await client.send('Page.getFrameTree');
  const { executionContextId } = await client.send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'breezer-page-context-memory' });
  const injected = await client.send('Runtime.evaluate', { contextId: executionContextId, expression: source });
  if (injected.exceptionDetails) throw new Error(injected.exceptionDetails.exception?.description || injected.exceptionDetails.text);
  const invoke = async (operation, args = {}) => {
    const result = await client.send('Runtime.callFunctionOn', { executionContextId,
      functionDeclaration: 'function(operation, args) { return pageContext(operation, args); }',
      arguments: [{ value: operation }, { value: args }], returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  const sample = async () => {
    await client.send('HeapProfiler.collectGarbage');
    const dom = await client.send('Memory.getDOMCounters');
    const heap = await client.send('Runtime.getHeapUsage');
    return { ...dom, usedHeapBytes: heap.usedSize };
  };
  const empty = await sample();
  await page.evaluate(() => {
    const root = document.querySelector('main');
    for (let i = 0; i < 180; i++) {
      const link = document.createElement('a');
      link.href = '#item-' + i;
      for (let j = 0; j < 200; j++) {
        const span = document.createElement('span');
        span.textContent = `Temporary article ${i}, section ${j}. `;
        link.append(span);
      }
      root.append(link);
    }
  });
  const snapshot = await invoke('snapshot');
  assert.equal(snapshot.elements.length, 180);
  const attached = await sample();
  // Collection must preserve targets that still belong to the live document.
  await invoke('resolve', { elementId: snapshot.elements.at(-1).id });
  await page.evaluate(() => document.querySelector('main').replaceChildren());
  await page.waitForTimeout(20);
  const detached = await sample();
  await assert.rejects(invoke('resolve', { elementId: snapshot.elements[0].id }), /changed/);
  const released = detached.nodes <= empty.nodes + 1000;
  const result = { browser: browser.version(), source: resolve(values.source), isolatedWorld: true, sourceSha256: createHash('sha256').update(originalSource).digest('hex'), empty, attached, detached,
    retainedExtraNodes: detached.nodes - empty.nodes, released,
    limits: 'Synthetic isolated-world page-control retention check after forced GC. Not whole-browser RAM, CPU or browsing speed.' };
  if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (values['expect-released']) assert.ok(released, 'Removed page nodes remain retained by the last control snapshot');
} finally {
  await browser.close();
}
