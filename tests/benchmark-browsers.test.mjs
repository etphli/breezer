import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPageTargets, commonFlags, parseProcesses, processTree, summarize } from '../script/benchmark_browsers.mjs';

test('process RSS includes every descendant and excludes unrelated user sessions', () => {
  const rows = parseProcesses('  200 1 1024 /Applications/Breezer.app/Contents/MacOS/Breezer --user-data-dir=/tmp/owned\n  202 201 4096 /Applications/Breezer.app/Contents/Frameworks/Helper\n  201 200 2048 helper\n  300 1 99999 user browser');
  const owned = processTree(rows, 200);
  assert.deepEqual(owned.map(row => row.pid), [200, 202, 201]);
  assert.equal(owned.reduce((sum, row) => sum + row.rssKiB, 0), 7168);
});
test('missing browser root never adopts an unrelated process', () => {
  assert.deepEqual(processTree(parseProcesses('300 1 100 unrelated'), 200), []);
});
test('summary preserves small-sample spread and even-count median', () => {
  assert.deepEqual(summarize([8, 2, 6, 4]), { count: 4, median: 5, min: 2, max: 8, p25: 3.5, p75: 6.5 });
  assert.deepEqual(summarize([3]), { count: 1, median: 3, min: 3, max: 3, p25: 3, p75: 3 });
  assert.throws(() => summarize([]));
  assert.throws(() => summarize([NaN]));
});
test('benchmark does not inject automation flags that disable product functionality', () => {
  assert.deepEqual(commonFlags, ['--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--window-size=1280,900']);
});

test('content tab count excludes only runtime-verified native sidebar hosts', () => {
  const hostUrl = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/workspace.html#/sidebar?w=123';
  const targets = [
    { targetId: 'fixture', type: 'page', url: 'http://127.0.0.1/fixture' },
    { targetId: 'host', type: 'page', url: hostUrl },
    { targetId: 'worker', type: 'service_worker', url: 'chrome-extension://example/background.js' },
  ];
  const proof = { host: { contexts: [{ documentUrl: hostUrl, contextType: 'SIDE_PANEL', tabId: -1 }], tabs: [{ id: 1, url: 'http://127.0.0.1/fixture' }] } };
  assert.equal(accountPageTargets(targets, proof).contentPageCount, 1);
  assert.equal(accountPageTargets(targets, proof).excludedSidebarHosts[0].tabId, -1);
  assert.equal(accountPageTargets(targets).contentPageCount, 2, 'URL alone is not proof');
  for (const patch of [{ tabId: 5 }, { contextType: 'TAB' }, { documentUrl: hostUrl + 'other' }]) {
    const altered = structuredClone(proof);
    Object.assign(altered.host.contexts[0], patch);
    assert.equal(accountPageTargets(targets, altered).contentPageCount, 2);
  }
  const actualTab = structuredClone(proof);
  actualTab.host.tabs.push({ id: 2, url: hostUrl });
  assert.equal(accountPageTargets(targets, actualTab).contentPageCount, 2, 'An extension document in a real tab must count');
});
