// Diagnostic-only boundaries and ownership of disposable transport children.
import assert from 'node:assert/strict';

const counter = value => Number.isSafeInteger(value) && value >= 0;
const time = value => typeof value === 'string' && /^[1-9]\d*$/.test(value) && BigInt(value) <= (1n << 64n) - 1n;
export function validateSample(sample, pid, runtime) {
  assert.ok(sample && sample.pid === pid && counter(pid) && pid > 0 && sample.node === runtime, 'Invalid sample identity/runtime');
  for (const [group, keys] of [['memory', ['rss', 'heapTotal', 'heapUsed', 'external', 'arrayBuffers']], ['cpu', ['user', 'system']]]) {
    for (const key of keys) assert.ok(counter(sample[group]?.[key]), `Invalid ${group}.${key}`);
  }
  return sample;
}
export function validateUsage(usage, pid, previous) {
  assert.ok(usage?.schema === 1 && time(usage.captureStartedNs) && time(usage.captureEndedNs)
    && BigInt(usage.captureEndedNs) >= BigInt(usage.captureStartedNs), 'Invalid usage schema/bounds');
  assert.ok(Array.isArray(usage.processes) && usage.processes.length === 1, 'Expected one process');
  const row = usage.processes[0];
  assert.ok(row?.pid === pid && counter(pid) && pid > 0 && row.status === 'ok', 'Invalid usage PID/status');
  assert.ok(time(row.startAbstime) && typeof row.executableUuid === 'string' && /^[a-f0-9]{32}$/.test(row.executableUuid), 'Invalid native identity');
  for (const key of ['physicalFootprintBytes', 'residentBytes', 'lifetimeMaxPhysicalFootprintBytes']) assert.ok(counter(row[key]), `Invalid ${key}`);
  assert.ok(row.lifetimeMaxPhysicalFootprintBytes >= row.physicalFootprintBytes, 'Invalid lifetime footprint');
  if (previous) {
    const before = validateUsage(previous, pid);
    for (const key of ['pid', 'startAbstime', 'executableUuid']) assert.equal(row[key], before[key], 'Native identity changed');
    assert.ok(BigInt(previous.captureEndedNs) <= BigInt(usage.captureStartedNs), 'Overlapping captures');
  }
  // startAbstime is mach ticks, capture bounds are CLOCK_MONOTONIC ns. Never compare them.
  return row;
}
export function validateReport(report) {
  assert.ok(report?.schema === 1 && report.status === 'passed', 'Invalid report schema/status');
  const runtime = report.runtime;
  assert.ok(typeof runtime?.path === 'string' && runtime.path.startsWith('/')
    && typeof runtime.version === 'string' && /^v\d+\.\d+\.\d+$/.test(runtime.version), 'Invalid runtime identity');
  assert.ok(report.otherHostSources && typeof report.otherHostSources === 'object'
    && !Array.isArray(report.otherHostSources) && Object.keys(report.otherHostSources).length > 0, 'Invalid host sources');
  for (const name of Object.keys(report.otherHostSources)) assert.ok(/^[^/]+\.mjs$/.test(name) && name !== 'protocol.mjs', 'Invalid source name');
  for (const hash of [runtime.sha256, report.baselineProtocolSha256, report.candidateProtocolSha256, ...Object.values(report.otherHostSources)]) {
    assert.ok(typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash), 'Invalid source/runtime hash');
  }
  for (const key of ['payloadBytes', 'chunkBytes', 'pairedRounds']) assert.ok(counter(report[key]) && report[key] > 0, `Invalid ${key}`);
  assert.ok(report.pairedRounds <= 10 && report.payloadBytes < 16 * 1024 ** 2 - 1024, 'Invalid dimensions');
  assert.ok(Array.isArray(report.results) && report.results.length === report.pairedRounds * 2, 'Invalid result count');
  for (const [index, trial] of report.results.entries()) {
    const round = Math.floor(index / 2);
    assert.ok(trial?.round === round && trial.name === ((round + index % 2) % 2 ? 'candidate' : 'baseline'), 'Invalid pair identity/order');
    validateSample(trial.before, trial.before?.pid, runtime.version);
    validateSample(trial.after, trial.before.pid, runtime.version);
    if ('pid' in trial) assert.equal(trial.pid, trial.before.pid, 'Invalid trial PID');
    assert.ok(Number.isFinite(trial.replyMs) && trial.replyMs >= 0 && trial.replyMs <= Number.MAX_SAFE_INTEGER, 'Invalid replyMs');
    for (const [metric, group, key] of [['cpuUserMicros', 'cpu', 'user'], ['cpuSystemMicros', 'cpu', 'system'], ['retainedArrayBufferBytes', 'memory', 'arrayBuffers']]) {
      assert.ok(Number.isSafeInteger(trial[metric]) && (metric === 'retainedArrayBufferBytes' || trial[metric] >= 0), `Invalid ${metric}`);
      assert.equal(trial[metric], trial.after[group][key] - trial.before[group][key], `Invalid ${metric} delta`);
    }
    if (trial.usage == null) assert.ok(trial.usageBefore == null, 'Partial footprint capture');
    else {
      assert.ok(trial.usageBefore, 'Missing bracketed capture');
      validateUsage(trial.usage, trial.after.pid, trial.usageBefore);
    }
  }
  return report;
}
export function ownChild(child, { killAfterMs = 20000, terminateAfterMs = 1000 } = {}) {
  let isClosed = false, escalation;
  let resolveClose, rejectFailure;
  const closed = new Promise(resolve => { resolveClose = resolve; });
  const failure = new Promise((_, reject) => { rejectFailure = reject; });
  // Errors can arrive between awaited stages. Attach a handler immediately.
  failure.catch(() => {});
  const kill = () => { if (!isClosed) child.kill('SIGKILL'); };
  const watchdog = setTimeout(kill, killAfterMs);
  child.once('close', (code, signal) => {
    isClosed = true;
    clearTimeout(watchdog); clearTimeout(escalation);
    resolveClose([code, signal]);
    rejectFailure(new Error(`Child closed: ${code}/${signal}`));
  });
  const fail = error => rejectFailure(error);
  child.on('error', fail);
  child.stdin?.on('error', fail);
  child.stdout?.on('error', fail);
  child.stderr?.on('error', fail);
  return {
    closed,
    fail,
    async wait(promise, stage = 'diagnostic', timeoutMs = 15000) {
      let timer;
      try {
        return await Promise.race([promise, failure, new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Diagnostic timed out: ${stage}`)), timeoutMs);
        })]);
      } finally { clearTimeout(timer); }
    },
    async cleanup() {
      if (!isClosed) {
        // The original watchdog stays armed until close, including on failure paths.
        escalation ??= setTimeout(kill, terminateAfterMs);
        try { child.kill('SIGTERM'); } catch (error) { fail(error); kill(); }
      }
      await closed;
    },
  };
}
