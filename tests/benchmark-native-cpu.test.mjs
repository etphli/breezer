import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import { nativeCpuWindow } from '../script/benchmark_browsers.mjs';

test('native helper CPU agrees with owned process CPU accounting', { skip: process.platform !== 'darwin' }, () => {
  mkdirSync('build', { recursive: true });
  const dir = mkdtempSync(resolve('build/native-cpu-test-'));
  try {
    const helper = `${dir}/helper`, worker = `${dir}/worker`;
    for (const [source, output] of [['script/macos_process_usage.c', helper], ['tests/fixtures/macos-cpu-worker.c', worker]]) {
      execFileSync('/usr/bin/xcrun', ['clang', '-O2', '-Wall', '-Wextra', '-Werror', source, '-o', output], { timeout: 20000 });
    }
    const result = spawnSync(worker, [helper], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const captures = result.stdout.trim().split('\n').map(JSON.parse);
    assert.equal(captures.length, 4);
    const pid = captures[0].processes[0].pid;
    const row = { pid, ppid: 1, command: 'owned-worker', role: 'browser', startedAt: '2000-01-01T00:00:00.000Z' };
    const sample = (a, b) => ({ before: [row], after: [row], captureStartedAt: new Date().toISOString(), usageBefore: a, usageAfter: b });
    const window = nativeCpuWindow([sample(captures[0], captures[1]), sample(captures[2], captures[3])], pid);
    assert.equal(window.status, 'observed-native-window');
    const first = captures[0].processes[0], last = captures[3].processes[0];
    const elapsed = Number(BigInt(last.readEndedNs) - BigInt(first.readStartedNs));
    const measuredCpu = window.cpuSecondsPerElapsedSecondLowerBound * elapsed;
    const independentCpu = Number(result.stderr.trim());
    assert.ok(measuredCpu > independentCpu * 0.8 && measuredCpu < independentCpu * 1.3, `${measuredCpu} vs ${independentCpu}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
