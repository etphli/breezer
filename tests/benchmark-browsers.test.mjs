import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPageTargets, captureFailureState, commonFlags, pageReady, parseProcessLoad, parseProcesses, processRole, processTree, summarize } from '../script/benchmark_browsers.mjs';

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

test('process load retains renderer PID and full command while excluding other browser sessions', () => {
  const rows = parseProcessLoad(' 200 1 1024 1.5 0:01.25 /Applications/Breezer.app/Contents/MacOS/Breezer --user-data-dir=/tmp/owned\n 201 200 2048 12.3 1:02.50 /Applications/Breezer.app/Contents/Frameworks/Breezer Helper (Renderer) --type=renderer --renderer-client-id=9\n 300 1 99999 90.0 2:03.00 user browser');
  const owned = processTree(rows, 200);
  assert.deepEqual(owned.map(row => [row.pid, row.role, row.cpuPercent, row.cpuTime]), [[200, 'browser', 1.5, '0:01.25'], [201, 'renderer', 12.3, '1:02.50']]);
  assert.equal(owned[1].command.endsWith('--renderer-client-id=9'), true);
  assert.equal(processRole('Helper --type=gpu-process'), 'gpu-process');
  assert.equal(processRole('Helper --type=utility --utility-sub-type=network.mojom.NetworkService'), 'utility');
});

test('a double-frame timeout stays rejected and identifies the exact failing readiness stage', async () => {
  const failure = new Error('CDP timeout: Runtime.evaluate');
  const expressions = [];
  const cdp = { evaluate: async (session, expression) => {
    assert.equal(session, 'retained-session');
    expressions.push(expression);
    if (expression.startsWith('Boolean(')) return true;
    throw failure;
  } };
  await assert.rejects(pageReady(cdp, 'retained-session', 'http://127.0.0.1/fixture'), error => {
    assert.equal(error, failure);
    assert.equal(error.readiness.stage, 'double-animation-frame');
    assert.equal(error.readiness.expectedUrl, 'http://127.0.0.1/fixture');
    return true;
  });
  assert.equal(expressions[1], 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
  assert.equal(expressions[0].includes('document.readyState === \'complete\''), true);
  assert.equal(expressions[0].includes('location.href === "http://127.0.0.1/fixture"'), true);
});

test('failure evidence survives an unresponsive renderer without activating, navigating, or closing it', async () => {
  const calls = [];
  const error = new Error('frame timeout');
  error.readiness = { stage: 'double-animation-frame', session: 'retained' };
  const instance = {
    operation: { stage: 'navigation', targetId: 'fixture', expectedUrl: 'http://127.0.0.1/fixture' },
    cdp: {
      evaluate: async (session, expression, timeout) => { calls.push({ method: 'Runtime.evaluate', session, expression, timeout }); throw new Error('renderer unresponsive'); },
      send: async (method, params, session, timeout) => { calls.push({ method, params, timeout }); return { method }; },
    },
    nativeWindowSnapshot: () => ({ active: false, windows: [{ onScreen: true }] }),
    captureLoad: () => [{ pid: 200, role: 'renderer', rssKiB: 1024 }],
  };
  const state = await captureFailureState(instance, error);
  assert.equal(state.operation.targetId, 'fixture');
  assert.equal(state.operation.stage, 'double-animation-frame');
  assert.equal(state.operation.benchmarkStage, 'navigation');
  assert.equal(state.page.error, 'renderer unresponsive');
  assert.equal(state.nativeWindow.active, false);
  assert.equal(state.processes[0].pid, 200);
  assert.deepEqual(calls.map(call => call.method).sort(), ['Browser.getWindowForTarget', 'Runtime.evaluate', 'SystemInfo.getProcessInfo', 'Target.getTargets']);
  assert.ok(calls.every(call => call.timeout === 1500));
  assert.ok(calls[0].expression.includes('document.visibilityState'));
  assert.ok(calls[0].expression.includes('document.hasFocus()'));
});

test('failure capture before CDP connects still retains the launch and native process state', async () => {
  const state = await captureFailureState({
    operation: { stage: 'launch', expectedUrl: 'http://127.0.0.1/fixture' },
    nativeWindowSnapshot: () => ({ active: false, windows: [] }),
    captureLoad: () => [{ pid: 200, role: 'browser' }],
  }, new Error('DevToolsActivePort timed out'));
  assert.equal(state.operation.benchmarkStage, 'launch');
  assert.equal(state.nativeWindow.active, false);
  assert.equal(state.processes[0].pid, 200);
  assert.ok(state.targets.error);
  assert.match(state.error, /DevToolsActivePort timed out/);
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
