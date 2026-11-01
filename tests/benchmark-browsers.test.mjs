import test from 'node:test';
import assert from 'node:assert/strict';
import { accountPageTargets, aggregateTrials, captureFailureState, commonFlags, comparisonPlan, cpuTimeCentiseconds, nativeForegroundReady, observedCpuWindow, pageReady, parseProcessLoad, parseProcesses, processRole, processTree, summarize } from '../script/benchmark_browsers.mjs';
import * as benchmark from '../script/benchmark_browsers.mjs';

test('footprint instrumentation has its own initialized protocol and preserves balanced orders', () => {
  assert.throws(() => comparisonPlan({ trials: 6, physicalFootprint: true }), /initialized-profiles/);
  const two = comparisonPlan({ trials: 6, initializedProfiles: true, physicalFootprint: true });
  assert.equal(two.protocol, 'installed-browser-v8-initialized-foreground-footprint');
  assert.deepEqual(two.roundOrders, comparisonPlan({ trials: 6, initializedProfiles: true }).roundOrders);
  const three = comparisonPlan({ trials: 6, initializedProfiles: true, baselineBreezer: '/baseline', physicalFootprint: true });
  assert.equal(three.protocol, 'installed-browser-v8-initialized-three-way-footprint');
  assert.deepEqual(three.roundOrders, comparisonPlan({ trials: 6, initializedProfiles: true, baselineBreezer: '/baseline' }).roundOrders);
});

function footprintFixture() {
  const before = [
    { pid: 200, ppid: 1, command: '/Browser', role: 'browser', startedAt: '2026-10-30T00:00:00.000Z' },
    { pid: 201, ppid: 200, command: '/Renderer --type=renderer', role: 'renderer', startedAt: '2026-10-30T00:00:01.000Z' },
  ];
  const usageBefore = { schema: 1, captureStartedNs: '100', captureEndedNs: '200', processes: before.map((row, index) => ({
    pid: row.pid, status: 'ok', startAbstime: String(1000 + index), executableUuid: 'a'.repeat(32),
    physicalFootprintBytes: (index + 2) * 1024 ** 2, residentBytes: 900 * 1024 ** 2, lifetimeMaxPhysicalFootprintBytes: 1000 * 1024 ** 2,
  })) };
  const usageAfter = structuredClone(usageBefore);
  usageAfter.captureStartedNs = '300'; usageAfter.captureEndedNs = '400';
  usageAfter.processes.forEach(row => { row.physicalFootprintBytes *= 2; });
  return { rootPid: 200, captureStartedAt: '2026-10-30T00:00:10.000Z', before, after: structuredClone(before), usageBefore, usageAfter };
}

test('footprint sums the first kernel observation after checking the full tree and both kernel identities', () => {
  const fixture = footprintFixture();
  fixture.after.reverse(); fixture.usageAfter.processes.reverse();
  const result = benchmark.observedPhysicalFootprint(fixture);
  assert.equal(result.status, 'observed');
  assert.equal(result.miB, 5, 'resident sets and lifetime peaks do not enter the footprint sum');
  assert.equal(result.processCount, 2);
  assert.equal(result.captureStartedNs, '100'); assert.equal(result.captureEndedNs, '200');
  assert.equal(result.identityGuardEndedNs, '400');
  assert.match(result.coverage, /Sequential/);
});

test('footprint is unavailable for churn, PID reuse, missing values, partial capture or unsafe totals', () => {
  for (const change of [
    x => { x.before = []; }, x => x.before.push(x.before[0]),
    x => { x.before = [x.before[1]]; }, x => { x.after.pop(); },
    x => { x.after[1].ppid = 300; }, x => { x.after[1].command = '/Other'; },
    x => { x.after[1].startedAt = '2026-10-30T00:00:02.000Z'; },
    x => { x.before[1].startedAt = x.after[1].startedAt = '2026-10-30T00:00:09.000Z'; },
    x => { x.captureStartedAt = undefined; }, x => { x.usageBefore.schema = 2; },
    x => { x.usageBefore.processes.pop(); }, x => { x.usageAfter.processes.push(x.usageAfter.processes[0]); },
    x => { x.usageAfter.processes[0].status = 'exited'; }, x => { x.usageAfter.processes[0].status = 'unavailable'; },
    x => { x.usageAfter.processes[0].startAbstime = '2000'; },
    x => { x.usageAfter.processes[0].executableUuid = 'b'.repeat(32); },
    x => { x.usageBefore.processes[0].physicalFootprintBytes = NaN; },
    x => { delete x.usageAfter.processes[0].physicalFootprintBytes; },
    x => { x.usageBefore.processes[0].physicalFootprintBytes = -1; },
    x => { x.usageBefore.processes[0].physicalFootprintBytes = Number.MAX_SAFE_INTEGER; },
    x => { x.usageBefore.captureEndedNs = '99'; }, x => { x.usageAfter.captureStartedNs = '199'; },
    x => { x.usageBefore.processes[0].startAbstime = 'not-a-counter'; },
  ]) {
    const fixture = footprintFixture(); change(fixture);
    const result = benchmark.observedPhysicalFootprint(fixture);
    assert.equal(result.status, 'unavailable', change.toString());
    assert.ok(result.reason); assert.equal(result.miB, undefined);
  }
});

test('footprint summaries require every observation and never replace missing data with zero', () => {
  assert.deepEqual(benchmark.summarizeFootprints([{ status: 'observed', miB: 8 }, { status: 'observed', miB: 4 }]),
    { status: 'observed', count: 2, median: 6, min: 4, max: 8, p25: 5, p75: 7 });
  for (const samples of [[], [{ status: 'unavailable' }], [{ status: 'observed', miB: 4 }, { status: 'unavailable' }]]) {
    const result = benchmark.summarizeFootprints(samples);
    assert.equal(result.status, 'unavailable'); assert.equal(result.median, undefined);
  }
});

test('three-app footprint summaries keep trial medians separate and retain unavailable windows', () => {
  const names = ['breezer', 'baselineBreezer', 'chrome'];
  const trials = names.flatMap((browser, index) => {
    const first = value => ({ browser, profileState: 'initialized', startupUsableMs: 10,
      newTabs: [{ requestedUrl: 'about:blank', usableMs: 1 }, { requestedUrl: 'chrome://newtab/', usableMs: 1 }],
      navigations: [{ usableMs: 1, navigationTiming: { loadEventEnd: 1 } }],
      memoryOneTab: { rssMiB: { median: 100 }, physicalFootprint: { status: 'observed', median: value } },
      memoryMultiTab: { rssMiB: { median: 200 }, physicalFootprint: { status: 'observed', median: value * 2 } },
    });
    return [first(index * 10 + 1), first(index * 10 + 3), { browser, profileState: 'reused', startupUsableMs: 10 }];
  });
  trials.find(trial => trial.browser === 'baselineBreezer').memoryOneTab.physicalFootprint = { status: 'unavailable', reason: 'PID churn' };
  const summary = aggregateTrials(trials, names);
  assert.equal(summary.breezer.oneTabPhysicalFootprintMiB.median, 2);
  assert.equal(summary.chrome.oneTabPhysicalFootprintMiB.median, 22);
  assert.equal(summary.baselineBreezer.oneTabPhysicalFootprintMiB.status, 'unavailable');
  assert.equal(summary.baselineBreezer.oneTabPhysicalFootprintMiB.median, undefined);
  assert.equal(summary.baselineBreezer.multiTabPhysicalFootprintMiB.median, 24);
  assert.equal(summary.baselineBreezer.oneTabRssMiB.median, 100, 'RSS is independent of missing footprint data');
});

test('native foreground readiness rejects covered, hidden, wrong-PID and unusable windows', () => {
  const ready = { pid: 200, active: true, hidden: false, terminated: false, frontmostPid: 200,
    windows: [{ layer: 0, onScreen: true, bounds: { Width: 320, Height: 200 } }] };
  assert.equal(nativeForegroundReady(ready, 200), true);
  for (const patch of [{ active: false }, { hidden: true }, { terminated: true }, { pid: 201 },
    { frontmostPid: 201 }, { windows: [] }, { windows: null },
    { windows: [{ ...ready.windows[0], onScreen: false }] },
    { windows: [{ ...ready.windows[0], layer: 1 }] },
    { windows: [{ ...ready.windows[0], bounds: { Width: 319, Height: 200 } }] },
    { windows: [{ ...ready.windows[0], bounds: { Width: 320, Height: 199 } }] }]) {
    assert.equal(nativeForegroundReady({ ...ready, ...patch }, 200), false, JSON.stringify(patch));
  }
});

test('two-browser protocols retain their existing alternating order', () => {
  const orders = [['breezer', 'chrome'], ['chrome', 'breezer'], ['breezer', 'chrome']];
  assert.deepEqual(comparisonPlan({ trials: 3 }).roundOrders, orders);
  assert.equal(comparisonPlan({ trials: 3 }).protocol, 'installed-browser-v3-observed-cpu');
  const active = comparisonPlan({ trials: 3, initializedProfiles: true });
  assert.equal(active.protocol, 'installed-browser-v8-initialized-foreground');
  assert.deepEqual(active.roundOrders, orders);
});

test('three-browser order balances positions and every pair in each six-round block', () => {
  const plan = comparisonPlan({ trials: 12, initializedProfiles: true, baselineBreezer: '/baseline' });
  assert.equal(plan.protocol, 'installed-browser-v8-initialized-three-way');
  const names = ['breezer', 'baselineBreezer', 'chrome'];
  for (const block of [plan.roundOrders.slice(0, 6), plan.roundOrders.slice(6)]) {
    assert.equal(new Set(block.map(order => order.join(','))).size, 6);
    for (const name of names) {
      for (let position = 0; position < 3; position++) assert.equal(block.filter(order => order[position] === name).length, 2);
      for (const other of names.filter(other => other !== name)) {
        assert.equal(block.filter(order => order.indexOf(name) < order.indexOf(other)).length, 3);
      }
    }
  }
  assert.throws(() => comparisonPlan({ trials: 6, baselineBreezer: '/baseline' }), /initialized-profiles/);
  assert.throws(() => comparisonPlan({ trials: 7, initializedProfiles: true, baselineBreezer: '/baseline' }), /multiple of six/);
});

test('three-browser summaries retain separate startup and memory observations', () => {
  const names = ['breezer', 'baselineBreezer', 'chrome'];
  const trials = names.flatMap((browser, index) => {
    const value = 10 ** index;
    return [
      { browser, profileState: 'initialized', startupUsableMs: value,
        newTabs: [{ requestedUrl: 'about:blank', usableMs: value * 2 }, { requestedUrl: 'chrome://newtab/', usableMs: value * 3 }],
        navigations: [{ usableMs: value * 4, navigationTiming: { loadEventEnd: value * 5 } }],
        memoryOneTab: { rssMiB: { median: value * 6 } }, memoryMultiTab: { rssMiB: { median: value * 7 } } },
      { browser, profileState: 'reused', startupUsableMs: value * 8 },
    ];
  });
  const summary = aggregateTrials(trials, names);
  assert.deepEqual(Object.keys(summary), names);
  names.forEach((name, index) => {
    const value = 10 ** index;
    const s = summary[name];
    assert.equal(s.startupInitializedProfileMs.median, value);
    assert.equal(s.startupReusedProfileMs.median, value * 8);
    assert.equal(s.blankTabMs.median, value * 2);
    assert.equal(s.productNewTabMs.median, value * 3);
    assert.equal(s.localNavigationUsableMs.median, value * 4);
    assert.equal(s.localNavigationLoadEventEndMs.median, value * 5);
    assert.equal(s.oneTabRssMiB.median, value * 6);
    assert.equal(s.multiTabRssMiB.median, value * 7);
    assert.equal(s.oneTabPhysicalFootprintMiB, undefined, 'legacy summaries retain their exact fields');
  });
});

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

test('untimed initialization completes the actual setup guide and closes only its resulting new tab', async () => {
  const prefix = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/';
  const sidebar = { type: 'page', targetId: 'sidebar', url: `${prefix}workspace.html#/sidebar?w=1` };
  const welcome = { type: 'page', targetId: 'welcome', url: `${prefix}workspace.html#/welcome` };
  const unrelated = { type: 'page', targetId: 'other', url: 'https://example.test/' };
  let targets = [sidebar, welcome, unrelated], completed = false;
  const calls = [], state = { actions: [], clickedWelcomeTargets: new Set() };
  const cdp = {
    attach: async id => `session-${id}`,
    evaluate: async (session, expression) => {
      calls.push({ session, expression });
      if (expression.includes('wl-skip')) { assert.equal(session, 'session-welcome'); completed = true; return true; }
      return { extensionId: 'namgcidocfgliiedlkdafcmifpdfiakj', seen: '1.1.0', setup: { completed } };
    },
    send: async (method, params) => {
      calls.push({ method, params });
      if (method === 'Target.closeTarget') targets = targets.filter(t => t.targetId !== params.targetId);
      return {};
    },
  };
  assert.equal(await benchmark.initializeBreezerProfile(cdp, targets, state), false);
  assert.equal(calls.filter(c => c.expression?.includes('wl-skip')).length, 1);
  assert.equal(calls.filter(c => c.method === 'Target.closeTarget').length, 0);
  targets = targets.map(t => t.targetId === 'welcome' ? { ...t, url: `${prefix}newtab.html` } : t);
  assert.equal(await benchmark.initializeBreezerProfile(cdp, targets, state), true);
  assert.deepEqual(calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId), ['welcome']);
  assert.ok(targets.some(t => t.targetId === 'other'), 'Unknown tabs must remain for the main inventory gate to reject');
  assert.equal(calls.filter(c => c.expression?.includes('wl-skip')).length, 1);
  assert.equal(calls.filter(c => c.method === 'Target.detachFromTarget').length, 3);
});

test('untimed initialization supports the old notes page and always detaches failed sessions', async () => {
  const prefix = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/';
  const target = { type: 'page', targetId: 'notes', url: `${prefix}whats-new.html` };
  const calls = [];
  const cdp = { attach: async () => 'session', evaluate: async () => ({ extensionId: 'namgcidocfgliiedlkdafcmifpdfiakj', seen: '1.1.0' }), send: async (method, params) => { calls.push({ method, params }); return {}; } };
  assert.equal(await benchmark.initializeBreezerProfile(cdp, [target], { actions: [], clickedWelcomeTargets: new Set() }), true);
  assert.deepEqual(calls.filter(c => c.method === 'Target.closeTarget').map(c => c.params.targetId), ['notes']);
  cdp.evaluate = async () => { throw new Error('real extension failure'); };
  await assert.rejects(benchmark.initializeBreezerProfile(cdp, [target], { actions: [], clickedWelcomeTargets: new Set() }), /real extension failure/);
  assert.equal(calls.filter(c => c.method === 'Target.detachFromTarget').length, 2);
});

test('untimed initialization never closes a setup target that navigated to an unexpected page', async () => {
  const prefix = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/';
  const targets = [{ type: 'page', targetId: 'sidebar', url: `${prefix}workspace.html#/sidebar?w=1` }, { type: 'page', targetId: 'welcome', url: 'https://example.test/' }];
  const calls = [], state = { actions: [], clickedWelcomeTargets: new Set(['welcome']) };
  const cdp = { attach: async () => 'session', evaluate: async () => ({ extensionId: 'namgcidocfgliiedlkdafcmifpdfiakj', seen: '1.1.0', setup: { completed: true } }), send: async method => { calls.push(method); return {}; } };
  assert.equal(await benchmark.initializeBreezerProfile(cdp, targets, state), false);
  assert.equal(calls.includes('Target.closeTarget'), false);
});
