import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from './node_modules/playwright/index.mjs';

const [executablePath] = process.argv.slice(2);
assert.ok(executablePath, 'Pass the path to the compiled Breezer executable.');
const profile = await mkdtemp(join(tmpdir(), 'breezer-stats-'));
const workerUrl = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/background.js';
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, {
    executablePath,
    ignoreDefaultArgs: ['--disable-extensions', '--disable-component-extensions-with-background-pages', '--no-sandbox'],
    args: ['--no-first-run', '--no-default-browser-check'],
    headless: false,
  });
  const worker = browser.serviceWorkers().find(item => item.url() === workerUrl) ||
    await browser.waitForEvent('serviceworker', { predicate: item => item.url() === workerUrl, timeout: 30_000 });
  const stats = await worker.evaluate(async () => {
    const { id } = await chrome.windows.getLastFocused();
    const sample = async () => {
      const tabs = (await chrome.tabs.query({})).filter(tab => !tab.incognito);
      const { totalTabCount, windowTabCount, browserMemory, systemMemory } = await chrome.breezerPrivate.getBrowserStats(id);
      return {
        totalTabCount, windowTabCount, browserMemory, systemMemory,
        expectedTotal: tabs.length,
        expectedWindow: tabs.filter(tab => tab.windowId === id).length,
      };
    };
    const before = await sample();
    await chrome.tabs.create({ windowId: id, url: 'about:blank', active: false });
    await chrome.windows.create({ url: 'about:blank' });
    return { before, after: await sample() };
  });
  for (const sample of Object.values(stats)) {
    assert.equal(sample.windowTabCount, sample.expectedWindow);
    assert.equal(sample.totalTabCount, sample.expectedTotal);
    assert.ok(sample.browserMemory.browserProcessBytes > 0, 'the main browser process has a measurement');
    assert.ok(sample.browserMemory.footprintBytes >= sample.browserMemory.browserProcessBytes, 'Breezer footprint includes the main browser process');
    assert.ok(sample.systemMemory.totalBytes > 0, 'system RAM has its own measurement');
  }
  assert.equal(stats.after.windowTabCount, stats.before.windowTabCount + 1);
  assert.equal(stats.after.totalTabCount, stats.before.totalTabCount + 2);
  console.log('PASS: native browser footprint and system RAM, plus tab counts for this window and all regular windows.');
} finally {
  try { await browser?.close(); } finally { await rm(profile, { recursive: true, force: true }); }
}
