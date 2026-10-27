import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPageTargets, captureFailureState, commonFlags, cpuTimeCentiseconds, observedCpuWindow, pageReady, parseProcessLoad, parseProcesses, processRole, processTree, summarize } from '../script/benchmark_browsers.mjs';

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
  const rows = parseProcessLoad(' 200 1 1024 1.5 0:01.25 Wed Oct 28 07:14:49 2026 /Applications/Breezer.app/Contents/MacOS/Breezer --user-data-dir=/tmp/owned\n 201 200 2048 12.3 1:02.50 Wed Oct 28 07:14:50 2026 /Applications/Breezer.app/Contents/Frameworks/Breezer Helper (Renderer) --type=renderer --renderer-client-id=9\n 300 1 99999 90.0 2:03.00 Wed Oct  7 07:14:49 2026 user browser');
  const owned = processTree(rows, 200);
  assert.deepEqual(owned.map(row => [row.pid, row.role, row.cpuPercent, row.cpuTime]), [[200, 'browser', 1.5, '0:01.25'], [201, 'renderer', 12.3, '1:02.50']]);
  assert.equal(owned[1].command.endsWith('--renderer-client-id=9'), true);
  assert.equal(owned[0].startedAt, new Date('2026-10-28T07:14:49').toISOString());
  assert.equal(processRole('Helper --type=gpu-process'), 'gpu-process');
  assert.equal(processRole('Helper --type=utility --utility-sub-type=network.mojom.NetworkService'), 'utility');
});

test('CPU time parses observed macOS minute and centisecond formats without treating minutes as hours', () => {
  // Values from read-only ps output on this Mac; time is user + system.
  assert.equal(cpuTimeCentiseconds('0:00.04'), cpuTimeCentiseconds('0:00.02') * 2);
  assert.equal(cpuTimeCentiseconds('126:12.12'), 757212);
  assert.equal(cpuTimeCentiseconds('160:08.98'), 960898);
  assert.equal(cpuTimeCentiseconds('0:00.00'), 0);
  for (const value of [undefined, null, '', '-', 'NaN', '-1:00.00', '1:60.00', '1:02', '1:02.500', '1:02:03.00', '9999999999999999:00.00']) {
    assert.equal(cpuTimeCentiseconds(value), null, String(value));
  }
});

function cpuSamples() {
  return Array.from({ length: 5 }, (_, index) => ({
    captureStartedAt: '2026-10-28T00:00:10.000Z',
    monotonicStartedMs: 100 + index * 1025,
    monotonicEndedMs: 125 + index * 1025,
    processes: [
      { pid: 200, ppid: 1, startedAt: '2026-10-28T00:00:00.000Z', executable: '/Browser', role: 'browser', cpuTime: `126:12.${12 + index * 10}`, cpuPercent: 99 },
      { pid: 201, ppid: 200, startedAt: '2026-10-28T00:00:01.000Z', executable: '/Helper (Renderer)', role: 'renderer', cpuTime: `0:01.${25 + index * 15}`, cpuPercent: 99 },
    ],
  }));
}

test('settled CPU sums counter deltas across all observed processes over actual monotonic capture bounds', () => {
  const samples = cpuSamples();
  samples[1].processes.reverse();
  const result = observedCpuWindow(samples, 200);
  assert.equal(result.status, 'observed-lower-bound');
  assert.equal(result.sampleCount, 5);
  assert.equal(result.sampledProcessCount, 2);
  assert.equal(result.observedCpuSeconds, 1, '0.40 browser + 0.60 renderer seconds');
  assert.equal(result.cpuSecondsLowerBound, 0.96, 'two centiseconds allowed per process, not per sample');
  assert.equal(result.elapsedSeconds, 4.125, 'five samples cover four gaps plus capture time, not the settle period');
  assert.equal(result.cpuSecondsPerElapsedSecondLowerBound, 0.96 / 4.125);
  assert.equal(result.counterResolutionSeconds, 0.01);
  assert.equal(result.counterUncertaintyCpuSeconds, 0.04);
  assert.equal(result.counterUncertaintyCpuSecondsPerElapsedSecond, 0.04 / 4.125);
  assert.match(result.coverage, /unobserved/);
  samples.forEach(sample => sample.processes.forEach(row => { row.cpuPercent = 0; }));
  assert.deepEqual(observedCpuWindow(samples, 200), result, 'ps %cpu does not contribute');
});

test('idle CPU and observations at or below aggregate counter uncertainty are unavailable', () => {
  for (const final of ['0:00.00', '0:00.01', '0:00.04']) {
    const samples = cpuSamples();
    samples.forEach(sample => sample.processes.forEach(row => { row.cpuTime = '0:00.00'; }));
    samples.at(-1).processes[0].cpuTime = final;
    const result = observedCpuWindow(samples, 200);
    assert.equal(result.status, 'unavailable', final);
    assert.match(result.reason, /counter uncertainty/);
    assert.equal(result.counterResolutionSeconds, 0.01);
    assert.equal(result.counterUncertaintyCpuSeconds, 0.04);
    assert.equal(result.observedCpuSeconds, undefined);
    assert.equal(result.cpuSecondsLowerBound, undefined);
    assert.equal(result.cpuSecondsPerElapsedSecondLowerBound, undefined);
  }
});

test('counter uncertainty grows with PID count even when observed CPU is unchanged', () => {
  const samples = cpuSamples();
  samples.forEach(sample => sample.processes.push(...Array.from({ length: 48 }, (_, index) => ({ ...sample.processes[1], pid: 300 + index, cpuTime: '0:00.00' }))));
  const result = observedCpuWindow(samples, 200);
  assert.equal(result.status, 'unavailable');
  assert.equal(result.sampledProcessCount, 50);
  assert.equal(result.counterUncertaintyCpuSeconds, 1);
  assert.equal(result.cpuSecondsPerElapsedSecondLowerBound, undefined);
});

test('aggregate CPU seconds per elapsed second can exceed one core', () => {
  const samples = cpuSamples();
  samples.at(-1).processes[0].cpuTime = '126:22.12';
  samples.at(-1).processes[1].cpuTime = '0:03.25';
  const result = observedCpuWindow(samples, 200);
  assert.equal(result.observedCpuSeconds, 12);
  assert.equal(result.cpuSecondsPerElapsedSecondLowerBound, 11.96 / 4.125);
  assert.ok(result.cpuSecondsPerElapsedSecondLowerBound > 1);
});

test('CPU is unavailable for process churn, PID reuse, identity changes, missing counters, or an intermediate reset', () => {
  const changes = [
    samples => samples[2].processes.pop(),
    samples => { samples[2].processes[1].pid = 202; },
    samples => { samples[2].processes[1].startedAt = '2026-10-28T00:00:02.000Z'; },
    samples => { samples[2].processes[1].ppid = 1; },
    samples => { samples[2].processes[1].executable = '/Other Helper'; },
    samples => { samples[2].processes[1].role = 'utility'; },
    samples => { samples[2].processes[1].cpuTime = undefined; },
    samples => { samples[2].processes[1].cpuTime = '-'; },
    samples => { samples[2].processes[1].cpuTime = '0:00.00'; },
    samples => samples.forEach(sample => { sample.processes[1].startedAt = null; }),
    samples => samples.forEach(sample => { sample.processes[1].startedAt = '2026-10-28T00:00:09.000Z'; }),
    samples => { samples[2].processes = [samples[2].processes[1]]; },
    samples => { samples[2].processes = []; },
    samples => samples[2].processes.push(samples[2].processes[0]),
  ];
  for (const change of changes) {
    const samples = cpuSamples();
    change(samples);
    const result = observedCpuWindow(samples, 200);
    assert.equal(result.status, 'unavailable', change.toString());
    assert.ok(result.reason);
    assert.equal(result.observedCpuSeconds, undefined);
    assert.equal(result.cpuSecondsPerElapsedSecondLowerBound, undefined);
  }
});

test('CPU is unavailable for legacy samples, insufficient samples, invalid timestamps, or overlapping captures', () => {
  assert.equal(observedCpuWindow([], 200).status, 'unavailable');
  assert.equal(observedCpuWindow(cpuSamples().slice(0, 1), 200).status, 'unavailable');
  for (const change of [
    samples => { delete samples[0].monotonicStartedMs; },
    samples => { delete samples[0].captureStartedAt; },
    samples => { samples[1].monotonicStartedMs = NaN; },
    samples => { samples[1].monotonicEndedMs = Infinity; },
    samples => { samples[1].monotonicEndedMs = samples[1].monotonicStartedMs - 1; },
    samples => { samples[1].monotonicStartedMs = samples[0].monotonicEndedMs; },
  ]) {
    const samples = cpuSamples();
    change(samples);
    assert.equal(observedCpuWindow(samples, 200).status, 'unavailable', change.toString());
  }
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
