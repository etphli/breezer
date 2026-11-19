import assert from 'node:assert/strict';
import test from 'node:test';
import { readBrowserStats } from '../../features/ai/extension/browser-stats.js';

test('reads one native sample with shared renderer memory reported once', async () => {
  const calls = [];
  const api = {
    breezerPrivate: {
      async getBrowserStats(windowId) {
        calls.push(windowId);
        return {
          totalTabCount: 19,
          windowTabCount: 3,
          systemMemory: { totalBytes: 34_359_738_368, availableBytes: 10_737_418_240 },
          browserMemory: {
            footprintBytes: 899_678_208,
            browserProcessBytes: 400_556_032,
            measuredProcessCount: 7,
            sampleComplete: true,
          },
          tabs: [
            { tabId: 12, title: 'Calendar', rendererProcessIds: [0, 1], url: 'https://private.example/' },
            { tabId: 25, title: 'Inbox', rendererProcessIds: [0], text: 'Page content' },
            { tabId: 27, title: 'Discarded tab', rendererProcessIds: [] },
          ],
          rendererProcesses: [
            { id: 0, footprintBytes: 186_122_240, shared: true, pid: 5109 },
            { id: 1, footprintBytes: 25_122_816, shared: false },
          ],
          otherProfile: ['Other profile title'],
        };
      },
    },
  };
  const { notes, ...stats } = await readBrowserStats(api, 77);
  assert.deepEqual(calls, [77]);
  assert.deepEqual(stats, {
    totalTabCount: 19,
    windowTabCount: 3,
    systemMemory: { totalBytes: 34_359_738_368, availableBytes: 10_737_418_240 },
    browserMemory: { footprintBytes: 899_678_208, browserProcessBytes: 400_556_032, measuredProcessCount: 7, sampleComplete: true },
    tabs: [
      { tabId: 12, title: 'Calendar', rendererProcessIds: [0, 1] },
      { tabId: 25, title: 'Inbox', rendererProcessIds: [0] },
      { tabId: 27, title: 'Discarded tab', rendererProcessIds: [] },
    ],
    rendererProcesses: [
      { id: 0, footprintBytes: 186_122_240, shared: true },
      { id: 1, footprintBytes: 25_122_816, shared: false },
    ],
    detailsTruncated: false,
  });
  assert.match(notes.join(' '), /already included/);
  assert.match(notes.join(' '), /each process appears once/i);
  assert.match(notes.join(' '), /no live renderer/);
});

test('counts all regular tabs and this window using a single query on unpatched builds', async () => {
  const calls = [];
  const tab = (windowId, incognito = false) => ({
    windowId,
    incognito,
    get title() { assert.fail('The fallback must not read tab titles'); },
    get url() { assert.fail('The fallback must not read tab URLs'); },
  });
  const api = {
    tabs: {
      async query(query) {
        calls.push(query);
        return [tab(7), tab(7), tab(8), tab(7, true), tab(9, true)];
      },
    },
    get processes() { assert.fail('The collector must not use the Dev-channel processes API'); },
  };
  const stats = await readBrowserStats(api, 7);
  assert.deepEqual(calls, [{}]);
  assert.equal(stats.totalTabCount, 3);
  assert.equal(stats.windowTabCount, 2);
  assert.deepEqual(stats.tabs, []);
  assert.deepEqual(stats.rendererProcesses, []);
  assert.deepEqual(stats.systemMemory, { totalBytes: null, availableBytes: null });
  assert.equal(stats.browserMemory.footprintBytes, null);
  assert.equal(stats.browserMemory.browserProcessBytes, null);
  assert.match(stats.notes.join(' '), /require the native Breezer statistics reader/);
});

test('preserves a partial measurement and reports missing readings', async () => {
  const api = {
    breezerPrivate: {
      async getBrowserStats() {
        return {
          totalTabCount: 2,
          windowTabCount: 2,
          systemMemory: { totalBytes: 34_359_738_368 },
          browserMemory: { footprintBytes: 1024, measuredProcessCount: 2, sampleComplete: false },
          tabs: [
            { tabId: 3, title: '', rendererProcessIds: [0] },
            { tabId: 4, title: 'Reports', rendererProcessIds: [1] },
          ],
          rendererProcesses: [
            { id: 0, footprintBytes: 0, shared: false },
            { id: 1, shared: true },
          ],
        };
      },
    },
  };
  const stats = await readBrowserStats(api, 7);
  assert.equal(stats.systemMemory.availableBytes, null);
  assert.equal(stats.browserMemory.browserProcessBytes, null);
  assert.equal(stats.browserMemory.sampleComplete, false);
  assert.equal(stats.rendererProcesses[0].footprintBytes, 0);
  assert.equal(stats.rendererProcesses[1].footprintBytes, null);
  assert.match(stats.notes.join(' '), /partial memory sample/);
  assert.match(stats.notes.join(' '), /Some renderer footprints could not be measured/);
});

test('rejects an implicit window or an incognito caller before collecting data', async () => {
  await assert.rejects(readBrowserStats({}, undefined), /A Breezer window ID is required/);
  await assert.rejects(readBrowserStats({ extension: { inIncognitoContext: true } }, 7), /regular profile/);
});

test('bounds tab details and renderer associations without clipping the tool result or counts', async () => {
  const fullTitle = '界'.repeat(250);
  const processes = Array.from({ length: 500 }, (_, id) => ({ id, footprintBytes: 1024, shared: true }));
  const tabs = Array.from({ length: 600 }, (_, tabId) => ({
    tabId,
    title: tabId === 0 ? 'Inbox password=secret123 ' + fullTitle : fullTitle,
    rendererProcessIds: Array.from({ length: 12 }, (_, index) => (tabId * 8 + index) % 500),
  }));
  const api = {
    breezerPrivate: {
      async getBrowserStats() {
        return {
          totalTabCount: 725,
          windowTabCount: 600,
          systemMemory: {},
          browserMemory: {},
          tabs,
          rendererProcesses: processes,
        };
      },
    },
  };
  const stats = await readBrowserStats(api, 7);
  assert.equal(stats.totalTabCount, 725);
  assert.equal(stats.windowTabCount, 600);
  assert.equal(stats.tabs.length, 200);
  assert.equal(stats.rendererProcesses.length, 256);
  assert.equal(stats.tabs[0].rendererProcessIds.length, 8);
  assert.equal(stats.tabs[0].rendererDetailsTruncated, true);
  assert.ok(stats.tabs.every(tab => tab.title.length <= 160));
  assert.equal(stats.detailsTruncated, true);
  assert.match(stats.tabs[0].title, /password: \[redacted\]/);
  assert.doesNotMatch(stats.tabs[0].title, /secret123/);
  assert.match(stats.notes.join(' '), /omitted or shortened.*counts still cover every matching tab/);
  assert.doesNotMatch(stats.notes.join(' '), /no live renderer/);
  const serialized = JSON.stringify(stats);
  assert.ok(serialized.length <= 180_000, 'Claude sends the full JSON result');
  assert.ok(Buffer.byteLength(serialized) <= 140 * 1024, 'the UTF-8 response stays bounded');
});

test('reports no memory or window details when native readings are unavailable', async () => {
  const api = {
    breezerPrivate: {
      async getBrowserStats() {
        return { totalTabCount: 2, systemMemory: {}, browserMemory: {}, tabs: [], rendererProcesses: [] };
      },
    },
  };
  const stats = await readBrowserStats(api, 7);
  assert.equal(stats.totalTabCount, 2);
  assert.equal(stats.windowTabCount, null);
  assert.equal(stats.browserMemory.footprintBytes, null);
  assert.match(stats.notes.join(' '), /window was unavailable/);
  assert.match(stats.notes.join(' '), /memory sample was unavailable/);
});

test('retries a system-only sample to recover the browser footprint', async () => {
  const calls = [];
  const api = { breezerPrivate: {
    async getBrowserStats(windowId) {
      calls.push(windowId);
      return {
        totalTabCount: 4, windowTabCount: 2, systemMemory: { totalBytes: 8 * 1024 ** 3 },
        browserMemory: calls.length === 1 ? {} : { footprintBytes: 256 * 1024 ** 2, sampleComplete: true },
        tabs: [], rendererProcesses: [],
      };
    },
  } };
  const stats = await readBrowserStats(api, 7);
  assert.deepEqual(calls, [7, 7]);
  assert.equal(stats.browserMemory.footprintBytes, 256 * 1024 ** 2);
  assert.equal(stats.systemMemory.totalBytes, 8 * 1024 ** 3);
  assert.equal(stats.totalTabCount, 4);
  assert.equal(stats.windowTabCount, 2);
});
