#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { parseArgs } from 'node:util';
import { seed, installFixture } from '../tests/ai/workspace-browser-fixture.mjs';

const { values } = parseArgs({ options: {
  source: { type: 'string', default: 'features/ai/extension/workspace.js' },
  entries: { type: 'string', default: '1000' }, output: { type: 'string' },
  'expect-lazy': { type: 'boolean', default: false },
  'expect-pruned-routes': { type: 'boolean', default: false },
} });
const count = Number(values.entries);
assert.ok(Number.isInteger(count) && count > 0 && count <= 10000, 'Use 1..10000 saved entries');
const source = await readFile(resolve(values.source), 'utf8');
const root = resolve('features/ai/extension');
const { chromium } = await import(process.env.BREEZER_PLAYWRIGHT_MODULE || '../tests/ai/node_modules/playwright/index.mjs');
const browser = await chromium.launch({ channel: 'chromium', headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 300, height: 820 }, reducedMotion: 'reduce' });
  let faviconRequests = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.pathname === '/_favicon/') {
      faviconRequests++;
      await route.fulfill({ contentType: 'image/png', body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAL0lEQVR4nO3OIQEAAAgDMLoQjx7Uhhg3E/Or3rmkEhAQEBAQEBAQEBAQEBAQSAceyW1MeZ5Q05IAAAAASUVORK5CYII=', 'base64') });
      return;
    }
    const path = resolve(root, '.' + url.pathname);
    if (url.origin !== 'http://127.0.0.1' || !path.startsWith(root + '/')) { await route.abort(); return; }
    try {
      await route.fulfill({ contentType: ({ '.js': 'application/javascript', '.html': 'text/html', '.css': 'text/css', '.png': 'image/png' })[extname(path)] || 'application/octet-stream', body: path === resolve(root, 'workspace.js') ? source : await readFile(path) });
    } catch { await route.fulfill({ status: 404, body: 'Missing fixture resource' }); }
  });
  const initial = seed();
  const work = initial.local['workspace.v1'].spaces[0];
  initial.local['workspace.v1'].spaces = [work];
  initial.local['workspace.v1'].favorites = [];
  work.pinned = [{ kind: 'folder', id: 'f-large', name: 'Saved reading', open: false,
    children: Array.from({ length: count }, (_, i) => ({ kind: 'entry', id: 'e-' + i, url: 'https://reading.example.test/' + i, title: 'Saved article ' + i })) }];
  initial.tabs = initial.tabs.slice(0, 2).map((tab, i) => ({ ...tab, id: i + 1, index: i, pinned: i === 0, active: i === 1, url: i === 0 ? work.pinned[0].children[0].url : 'https://today.example.test/', title: i === 0 ? 'Loaded article' : 'Today tab' }));
  initial.local['workspace.members.v1'].tabs = Object.fromEntries(initial.tabs.map(tab => [tab.id, { s: work.id, u: tab.url, k: 'S1', ...(tab.pinned ? { e: 'e-0' } : {}) }]));
  initial.session['workspace.window.7'] = { activeSpaceId: work.id, lastActive: {} };
  await page.addInitScript(installFixture, { seed: initial, bridge: true, favicon: true });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const client = await page.context().newCDPSession(page);
  await client.send('Performance.enable');
  await page.goto('http://127.0.0.1/workspace.html#/sidebar?w=7');
  const folder = page.locator('[data-key="f:f-large"]');
  await folder.waitFor();
  const sample = async () => {
    await page.waitForLoadState('networkidle');
    await client.send('HeapProfiler.collectGarbage');
    const dom = await client.send('Memory.getDOMCounters');
    const heap = await client.send('Runtime.getHeapUsage');
    const metrics = Object.fromEntries((await client.send('Performance.getMetrics')).metrics.map(item => [item.name, item.value]));
    const document = await page.evaluate(() => ({ elements: window.document.querySelectorAll('*').length, folderRows: window.document.querySelectorAll('.folder-children [data-key]').length, unusedRouteElements: [...window.document.querySelectorAll('#settings, #welcome')].reduce((n, el) => n + el.querySelectorAll('*').length + 1, 0) }));
    return { ...dom, ...document, usedHeapBytes: heap.usedSize, scriptDurationSeconds: metrics.ScriptDuration, taskDurationSeconds: metrics.TaskDuration, faviconRequests };
  };
  await page.evaluate(() => document.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight' && event.target.dataset.key === 'f:f-large' && event.target.getAttribute('aria-expanded') === 'false') fx.expandStarted = performance.now();
  }, true));
  const collapsedAtLoad = await sample();
  assert.equal(await folder.getAttribute('aria-expanded'), 'false');
  assert.equal(await folder.locator('.count').textContent(), String(count));
  await folder.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(count => document.querySelectorAll('.folder-children [data-key]').length === count && !document.querySelector('.folder-children').hidden, count);
  const expandReadyMs = await page.evaluate(() => { document.querySelector('.folder-children').getBoundingClientRect(); return performance.now() - fx.expandStarted; });
  const expanded = await sample();
  await page.keyboard.press('ArrowRight');
  assert.equal(await page.evaluate(() => document.activeElement.dataset.key), 'e:e-0');
  await folder.focus(); await page.keyboard.press('ArrowLeft');
  await page.waitForFunction(() => document.querySelector('.folder-children').hidden);
  const collapsedAgain = await sample();
  const handled = await page.evaluate(() => !document.dispatchEvent(new CustomEvent('breezer-select-numbered-tab', { detail: 0, cancelable: true })));
  assert.equal(handled, true);
  await page.waitForFunction(() => window.fx.tabs.find(tab => tab.id === 1).active);
  await page.waitForFunction(() => document.querySelector('.folder-row').classList.contains('contains-active'));
  await page.evaluate(() => {
    const tab = fx.tabs.find(tab => tab.id === 1); tab.title = 'Latest loaded article';
    fx.fire('tabs.onUpdated', 1, { title: tab.title }, tab);
  });
  await folder.focus(); await page.keyboard.press('ArrowRight');
  await page.waitForFunction(() => document.querySelector('[data-key="e:e-0"] .title')?.textContent === 'Latest loaded article');
  const children = await page.evaluate(() => fx.local['workspace.v1'].spaces[0].pinned[0].children.length);
  assert.equal(children, count);
  assert.equal(await page.evaluate(() => fx.calls.filter(([name]) => name === 'tabs.create').length), 0);
  assert.deepEqual(errors, []);
  const result = { browser: browser.version(), source: resolve(values.source), sourceSha256: createHash('sha256').update(source).digest('hex'), entries: count,
    collapsedAtLoad, expanded, collapsedAgain, expandReadyMs, behavior: { folderKeyboard: true, savedSlotWhileClosed: true, latestLiveTitleOnReopen: true, savedEntriesUnchanged: true, noNewLiveTabs: true },
    limits: 'Synthetic saved-tab sidebar in a disposable browser using production resources and a chrome API fixture. Forced-GC document/heap counters and cumulative CPU timings; not native whole-browser RAM, browsing speed or CPU efficiency.' };
  if (values.output) await writeFile(values.output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result, null, 2));
  if (values['expect-pruned-routes']) assert.equal(collapsedAtLoad.unusedRouteElements, 0, 'Sidebar should not retain hidden Settings and welcome markup');
  if (values['expect-lazy']) {
    assert.equal(collapsedAtLoad.folderRows, 0, 'Collapsed folder should not create hidden child rows');
    assert.equal(collapsedAgain.folderRows, 0, 'Collapsing should release child rows');
  }
} finally { await browser.close(); }
