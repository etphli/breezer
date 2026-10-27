#!/usr/bin/env node
// Native, isolated-profile macOS comparison. No browser automation defaults.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = ms => new Promise(done => setTimeout(done, ms));
export const commonFlags = ['--no-first-run', '--no-default-browser-check', '--remote-debugging-port=0', '--window-size=1280,900'];
export function parseProcesses(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.+)$/);
    if (!match) throw new Error(`Cannot parse ps row: ${line}`);
    return { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), command: match[4] };
  });
}
export function processTree(rows, pid) {
  const owned = new Set([pid]);
  let count;
  do {
    count = owned.size;
    for (const row of rows) if (owned.has(row.ppid)) owned.add(row.pid);
  } while (count !== owned.size);
  return rows.filter(row => owned.has(row.pid));
}
export function processRole(command) {
  return command.match(/(?:^|\s)--type=([^\s]+)/)?.[1] || 'browser';
}
export function parseProcessLoad(text) {
  return text.trim().split('\n').filter(Boolean).map(line => {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.+)$/);
    if (!match) throw new Error(`Cannot parse process load row: ${line}`);
    const started = Date.parse(match[6]);
    return { pid: Number(match[1]), ppid: Number(match[2]), rssKiB: Number(match[3]), cpuPercent: Number(match[4]), cpuTime: match[5], startedAt: Number.isFinite(started) ? new Date(started).toISOString() : null, command: match[7], role: processRole(match[7]) };
  });
}
export function cpuTimeCentiseconds(value) {
  const match = typeof value === 'string' && value.match(/^(\d+):([0-5]\d)\.(\d{2})$/);
  if (!match) return null;
  const total = Number(match[1]) * 6000 + Number(match[2]) * 100 + Number(match[3]);
  return Number.isSafeInteger(total) ? total : null;
}
export function observedCpuWindow(samples, rootPid) {
  const coverage = 'Sampled process tree only; processes born and exited between listings are unobserved. No full-browser CPU or efficiency ratio.';
  const counterResolutionSeconds = 0.01;
  const unavailable = reason => ({ status: 'unavailable', reason, coverage, counterResolutionSeconds });
  if (samples.length < 2) return unavailable('At least two samples are required');
  for (let index = 0; index < samples.length; index++) {
    const sample = samples[index];
    if (!Number.isFinite(sample.monotonicStartedMs) || !Number.isFinite(sample.monotonicEndedMs) || sample.monotonicEndedMs < sample.monotonicStartedMs ||
        (index && sample.monotonicStartedMs <= samples[index - 1].monotonicEndedMs)) return unavailable('Missing or non-increasing monotonic capture timestamps');
    if (!sample.processes?.length || !sample.processes.some(row => row.pid === rootPid) || new Set(sample.processes.map(row => row.pid)).size !== sample.processes.length) return unavailable('Missing browser root, empty tree, or duplicate PID');
  }
  const first = samples[0];
  const captureStartedAt = Date.parse(first.captureStartedAt);
  if (!Number.isFinite(captureStartedAt)) return unavailable('Missing capture wall time for process identity checks');
  let observedCentiseconds = 0;
  let lowerBoundCentiseconds = 0;
  for (const process of first.processes) {
    const started = Date.parse(process.startedAt);
    // lstart has one-second resolution. Reject identities that could have been
    // born during the first listing, including same-second PID reuse.
    if (!Number.isFinite(started) || captureStartedAt - started <= 1000) return unavailable('Missing or too-recent process start time');
    let previous;
    let initial;
    for (const sample of samples) {
      if (sample.processes.length !== first.processes.length) return unavailable('Observed process tree changed during the window');
      const row = sample.processes.find(row => row.pid === process.pid);
      if (!row || row.startedAt !== process.startedAt || row.ppid !== process.ppid || row.executable !== process.executable || row.role !== process.role) return unavailable('Process identity or tree membership changed during the window');
      const current = cpuTimeCentiseconds(row.cpuTime);
      if (current === null || (previous !== undefined && current < previous)) return unavailable('Missing, unsupported, or reset CPU counter');
      initial ??= current;
      previous = current;
    }
    const delta = previous - initial;
    observedCentiseconds += delta;
    // Allow one displayed centisecond of error at each endpoint per process.
    lowerBoundCentiseconds += Math.max(0, delta - 2);
  }
  const elapsedSeconds = (samples.at(-1).monotonicEndedMs - first.monotonicStartedMs) / 1000;
  const counterUncertaintyCpuSeconds = first.processes.length * 2 / 100;
  const observation = { sampledProcessCount: first.processes.length, sampleCount: samples.length, elapsedSeconds, counterResolutionSeconds,
    counterUncertaintyCpuSeconds, counterUncertaintyCpuSecondsPerElapsedSecond: counterUncertaintyCpuSeconds / elapsedSeconds };
  if (observedCentiseconds <= first.processes.length * 2) return { ...unavailable('Observed CPU does not exceed aggregate counter uncertainty'), ...observation };
  const cpuSecondsLowerBound = lowerBoundCentiseconds / 100;
  return { status: 'observed-lower-bound', coverage, ...observation, observedCpuSeconds: observedCentiseconds / 100, cpuSecondsLowerBound,
    cpuSecondsPerElapsedSecondLowerBound: cpuSecondsLowerBound / elapsedSeconds };
}
const sidebarPrefix = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/workspace.html#/sidebar?w=';
export function accountPageTargets(targets, evidence = {}) {
  const contentPages = [];
  const excludedSidebarHosts = [];
  for (const target of targets.filter(item => item.type === 'page')) {
    const proof = evidence[target.targetId];
    const context = proof?.contexts?.find(item => item.documentUrl === target.url && item.contextType === 'SIDE_PANEL' && item.tabId === -1);
    const isActualTab = proof?.tabs?.some(tab => (tab.url || tab.pendingUrl) === target.url);
    if (target.url.startsWith(sidebarPrefix) && /^\d+$/.test(target.url.slice(sidebarPrefix.length)) && context && proof.tabs && !isActualTab) {
      excludedSidebarHosts.push({ targetId: target.targetId, url: target.url, contextType: context.contextType, tabId: context.tabId });
    } else contentPages.push({ targetId: target.targetId, url: target.url });
  }
  return { contentPages, excludedSidebarHosts, contentPageCount: contentPages.length };
}
async function pageInventory(cdp) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const evidence = {};
  for (const target of targetInfos.filter(item => item.type === 'page' && item.url.startsWith(sidebarPrefix))) {
    const session = await cdp.attach(target.targetId);
    evidence[target.targetId] = await cdp.evaluate(session, '(async () => ({ contexts: await chrome.runtime.getContexts({}), tabs: await chrome.tabs.query({}) }))()');
  }
  return accountPageTargets(targetInfos, evidence);
}
export function summarize(values) {
  const sorted = [...values].sort((a, b) => a - b);
  assert.ok(sorted.length && sorted.every(Number.isFinite), 'Expected finite measurements');
  const percentile = p => {
    const i = (sorted.length - 1) * p;
    return sorted[Math.floor(i)] + (sorted[Math.ceil(i)] - sorted[Math.floor(i)]) * (i % 1);
  };
  return { count: sorted.length, median: percentile(0.5), min: sorted[0], max: sorted.at(-1), p25: percentile(0.25), p75: percentile(0.75) };
}
const ps = () => parseProcesses(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', timeout: 2000 }));
const processLoad = pid => processTree(parseProcessLoad(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,%cpu=,time=,lstart=,command='], { encoding: 'utf8', timeout: 2000, env: { ...process.env, LC_ALL: 'C' } })), pid);
const command = (file, args = []) => {
  try { return execFileSync(file, args, { encoding: 'utf8', timeout: 20000 }).trim(); }
  catch (error) { return { error: error.message }; }
};
async function until(label, probe, timeout = 30000, interval = 25) {
  const start = performance.now();
  let last;
  while (performance.now() - start < timeout) {
    try { const result = await probe(); if (result) return result; } catch (error) { last = error; }
    await sleep(interval);
  }
  throw new Error(`${label} timed out: ${last?.message || 'condition never became true'}`);
}
class CDP {
  constructor(socket) {
    this.socket = socket;
    this.next = 0;
    this.pending = new Map();
    socket.addEventListener('message', event => {
      const result = JSON.parse(String(event.data));
      const pending = this.pending.get(result.id);
      if (!pending) return;
      this.pending.delete(result.id);
      clearTimeout(pending.timer);
      if (result.error) pending.reject(new Error(JSON.stringify(result.error)));
      else pending.resolve(result.result);
    });
    socket.addEventListener('close', () => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(new Error('CDP socket closed')); }
      this.pending.clear();
    });
  }
  static async connect(url) {
    const socket = new WebSocket(url);
    await new Promise((done, reject) => { socket.addEventListener('open', done, { once: true }); socket.addEventListener('error', reject, { once: true }); });
    return new CDP(socket);
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.next;
    return new Promise((resolveResult, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`CDP timeout: ${method}${method === 'Runtime.evaluate' ? ` expression=${String(params.expression).slice(0, 180)}` : ''}`)); }, timeoutMs);
      this.pending.set(id, { resolve: resolveResult, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  async attach(targetId) { return (await this.send('Target.attachToTarget', { targetId, flatten: true })).sessionId; }
  async evaluate(session, expression, timeoutMs = 30000) {
    const response = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session, timeoutMs);
    if (response.exceptionDetails) throw new Error(JSON.stringify(response.exceptionDetails));
    return response.result?.value;
  }
}

const windowProbeSource = `import CoreGraphics
import Foundation
import AppKit
let pid = Int32(CommandLine.arguments[1])!
if CommandLine.arguments.contains("--snapshot") {
  let windows = CGWindowListCopyWindowInfo([.optionAll, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  let owned = windows.filter { ($0[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid }.map { window in
    return ["number": window[kCGWindowNumber as String] ?? NSNull(), "layer": window[kCGWindowLayer as String] ?? NSNull(), "onScreen": window[kCGWindowIsOnscreen as String] ?? false, "bounds": window[kCGWindowBounds as String] ?? NSNull(), "alpha": window[kCGWindowAlpha as String] ?? NSNull()]
  }
  let app = NSRunningApplication(processIdentifier: pid)
  let state: [String: Any] = ["pid": pid, "active": app?.isActive ?? false, "hidden": app?.isHidden ?? false, "terminated": app?.isTerminated ?? true, "frontmostPid": NSWorkspace.shared.frontmostApplication?.processIdentifier ?? -1, "windows": owned]
  let data = try! JSONSerialization.data(withJSONObject: state, options: [.sortedKeys])
  print(String(data: data, encoding: .utf8)!)
  exit(0)
}
let deadline = ProcessInfo.processInfo.systemUptime + 35
while ProcessInfo.processInfo.systemUptime < deadline {
  let windows = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  for window in windows {
    guard (window[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
      (window[kCGWindowLayer as String] as? NSNumber)?.intValue == 0,
      let bounds = window[kCGWindowBounds as String] as? [String: Any],
      let width = bounds["Width"] as? NSNumber, let height = bounds["Height"] as? NSNumber,
      width.doubleValue >= 320, height.doubleValue >= 200 else { continue }
    print("visible")
    exit(0)
  }
  Thread.sleep(forTimeInterval: 0.01)
}
fputs("No visible native window for owned browser PID\\n", stderr)
exit(1)
`;
function fixtureHtml() {
  return `<!doctype html><meta charset="utf-8"><title>Breezer benchmark fixture</title>
<style>body{margin:32px;font:16px system-ui;background:#fafafa;color:#172126}main{display:grid;grid-template-columns:repeat(4,1fr);gap:12px}article{border:1px solid #cdd4d8;background:white;padding:16px;border-radius:8px}svg{width:100%;height:54px}</style>
<h1>Identical local browser benchmark</h1><p>No external requests. 128 deterministic cards.</p><main>${Array.from({ length: 128 }, (_, i) => `<article><h2>Card ${i + 1}</h2><svg viewBox="0 0 100 30"><path d="M0 25L20 ${i % 20}L40 16L70 4L100 11" fill="none" stroke="#327a8e" stroke-width="2"/></svg><p>Rendering, layout and local navigation fixture ${i + 1}.</p></article>`).join('')}</main><script>window.fixtureReady=true</script>`;
}
export async function pageReady(cdp, session, expectedUrl, productNewTab = false) {
  const started = performance.now();
  let stage = 'document';
  let documentReadyMs;
  try {
    await until('usable document', () => cdp.evaluate(session, `Boolean(document.readyState === 'complete' && document.body && document.body.getBoundingClientRect().width > 0 ${expectedUrl ? `&& location.href === ${JSON.stringify(expectedUrl)}` : ''} ${productNewTab ? `&& location.href !== 'about:blank'` : ''})`));
    documentReadyMs = performance.now() - started;
    stage = 'double-animation-frame';
    await cdp.evaluate(session, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true))))');
    return { documentReadyMs, animationFramesMs: performance.now() - started - documentReadyMs };
  } catch (error) {
    error.readiness = { stage, session, expectedUrl, productNewTab, documentReadyMs, elapsedMs: performance.now() - started };
    throw error;
  }
}
const pageStateExpression = `({url:location.href,visibilityState:document.visibilityState,hidden:document.hidden,hasFocus:document.hasFocus(),readyState:document.readyState,bodyWidth:document.body?.getBoundingClientRect().width,viewport:{width:innerWidth,height:innerHeight},navigationTiming:performance.getEntriesByType('navigation')[0]?.toJSON()})`;
export async function captureFailureState(instance, error) {
  const operation = { ...instance.operation, benchmarkStage: instance.operation.stage, ...error.readiness };
  const state = { at: new Date().toISOString(), error: error.stack || error.message, operation };
  const probes = {
    page: () => instance.cdp.evaluate(operation.session, pageStateExpression, 1500),
    targets: () => instance.cdp.send('Target.getTargets', {}, undefined, 1500),
    window: () => instance.cdp.send('Browser.getWindowForTarget', { targetId: operation.targetId }, undefined, 1500),
    browserProcesses: () => instance.cdp.send('SystemInfo.getProcessInfo', {}, undefined, 1500),
    nativeWindow: () => instance.nativeWindowSnapshot(),
    processes: () => instance.captureLoad(),
  };
  await Promise.all(Object.entries(probes).map(async ([key, probe]) => {
    try { state[key] = await probe(); } catch (failure) { state[key] = { error: failure.message }; }
  }));
  return state;
}
async function metadata(app) {
  const plist = JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }));
  const executable = join(app, 'Contents/MacOS', plist.CFBundleExecutable);
  await access(executable);
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(executable)) hash.update(chunk);
  return { app, executable, bundleId: plist.CFBundleIdentifier, version: plist.CFBundleShortVersionString, build: plist.CFBundleVersion, executableSha256: hash.digest('hex') };
}
function environment() {
  return {
    recordedAt: new Date().toISOString(), platform: process.platform, architecture: process.arch, node: process.version,
    os: command('/usr/bin/sw_vers'), cpu: command('/usr/sbin/sysctl', ['-n', 'machdep.cpu.brand_string']),
    logicalCpus: command('/usr/sbin/sysctl', ['-n', 'hw.logicalcpu']), ramBytes: command('/usr/sbin/sysctl', ['-n', 'hw.memsize']),
    loadAverage: command('/usr/sbin/sysctl', ['-n', 'vm.loadavg']), vmStat: command('/usr/bin/vm_stat'),
    power: command('/usr/bin/pmset', ['-g', 'batt']), thermal: command('/usr/bin/pmset', ['-g', 'therm']),
    gitCommit: command('/usr/bin/git', ['-C', root, 'rev-parse', 'HEAD']),
    gitStatus: command('/usr/bin/git', ['-C', root, 'status', '--short']),
  };
}
async function launch(browser, profile, url, output, label, probeExecutable) {
  const args = [`--user-data-dir=${profile}`, ...commonFlags, url];
  const started = performance.now();
  const proc = spawn(browser.executable, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let spawnError;
  proc.on('error', error => { spawnError = error; });
  const logs = [];
  proc.stdout.on('data', chunk => logs.push(chunk));
  proc.stderr.on('data', chunk => logs.push(chunk));
  const result = { pid: proc.pid, profile, command: [browser.executable, ...args], launchLabel: label };
  let cdp;
  let windowProbe;
  let windowResult;
  const owned = new Map();
  const captureOwned = () => {
    const tree = processTree(ps(), proc.pid);
    for (const row of tree) owned.set(row.pid, row.command);
    return tree;
  };
  const instance = { result, captureOwned, captureLoad: () => {
    const tree = processLoad(proc.pid);
    for (const row of tree) owned.set(row.pid, row.command);
    return tree;
  },
    nativeWindowSnapshot: () => JSON.parse(execFileSync(probeExecutable, [String(proc.pid), '--snapshot'], { encoding: 'utf8', timeout: 2000 })),
    operation: { stage: 'launch', expectedUrl: url } };
  instance.captureFailure = async error => {
    result.failure = await captureFailureState(instance, error);
    try { await writeFile(join(output, `${label}.failure.json`), `${JSON.stringify(result, null, 2)}\n`); }
    catch (failure) { result.failure.artifactWriteError = failure.message; }
  };
  const cleanup = async () => {
    captureOwned();
    if (cdp) await Promise.race([cdp.send('Browser.close').catch(() => {}), sleep(1500)]);
    await sleep(500);
    const current = new Map(ps().map(row => [row.pid, row]));
    for (const [pid, originalCommand] of owned) {
      if (current.get(pid)?.command !== originalCommand) continue;
      try { process.kill(pid, 'SIGTERM'); } catch {}
    }
    await sleep(500);
    for (const [pid, originalCommand] of owned) {
      const row = ps().find(item => item.pid === pid);
      if (row?.command !== originalCommand) continue;
      try { process.kill(pid, 'SIGKILL'); } catch {}
    }
    cdp?.socket.close();
    windowProbe?.kill();
    await writeFile(join(output, `${label}.browser.log`), Buffer.concat(logs));
  };
  try {
    windowProbe = spawn(probeExecutable, [String(proc.pid)], { stdio: ['ignore', 'pipe', 'pipe'] });
    windowResult = new Promise((done, reject) => {
      let text = '';
      windowProbe.stdout.on('data', chunk => { text += chunk; if (text.includes('visible')) done(performance.now() - started); });
      windowProbe.on('exit', code => { if (code !== 0) reject(new Error(`Native window probe exited ${code}`)); });
      windowProbe.on('error', reject);
    });
    // Handle failures immediately even before CDP is ready.
    windowResult.catch(() => {});
    const port = await until('DevToolsActivePort', async () => {
      if (spawnError) throw spawnError;
      if (proc.exitCode !== null) throw new Error(`Browser exited ${proc.exitCode}`);
      const content = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');
      return content[0] && content[1] ? content : false;
    });
    cdp = await CDP.connect(`ws://127.0.0.1:${port[0]}${port[1]}`);
    instance.cdp = cdp;
    const target = await until('initial fixture tab', async () => (await cdp.send('Target.getTargets')).targetInfos.find(item => item.type === 'page' && item.url === url));
    const session = await cdp.attach(target.targetId);
    instance.operation = { stage: 'startup', targetId: target.targetId, session, expectedUrl: url };
    await cdp.send('Target.activateTarget', { targetId: target.targetId });
    result.startupReadiness = await pageReady(cdp, session, url);
    result.startupPageReadyMs = performance.now() - started;
    result.startupNativeWindowMs = await windowResult;
    result.startupUsableMs = Math.max(result.startupPageReadyMs, result.startupNativeWindowMs);
    result.version = await cdp.send('Browser.getVersion');
    result.initialNavigationTiming = await cdp.evaluate(session, 'performance.getEntriesByType("navigation")[0]?.toJSON()');
    result.initialPageInventory = await pageInventory(cdp);
    assert.equal(result.initialPageInventory.contentPageCount, 1, 'Startup must have exactly one content tab for a comparable launch');
    captureOwned();
    return Object.assign(instance, { cdp, session, targetId: target.targetId, cleanup });
  } catch (error) {
    await instance.captureFailure(error);
    error.launchResult = result;
    await cleanup();
    throw error;
  }
}
async function memorySample(instance, seconds, samples) {
  await sleep(seconds * 1000);
  const rows = [];
  for (let index = 0; index < samples; index++) {
    const captureStartedAt = new Date().toISOString();
    const monotonicStartedMs = performance.now();
    const tree = instance.captureLoad();
    const monotonicEndedMs = performance.now();
    assert.ok(tree.length, 'Owned browser process tree disappeared');
    rows.push({ at: new Date().toISOString(), captureStartedAt, monotonicStartedMs, monotonicEndedMs, rssMiB: tree.reduce((sum, row) => sum + row.rssKiB, 0) / 1024,
      processes: tree.map(({ pid, ppid, rssKiB, cpuPercent, cpuTime, startedAt, role, command: cmd }) => ({ pid, ppid, rssKiB, cpuPercent, cpuTime, startedAt, role, executable: cmd.split(' --')[0] })) });
    if (index + 1 < samples) await sleep(1000);
  }
  return { rssMiB: summarize(rows.map(row => row.rssMiB)), cpu: observedCpuWindow(rows, instance.result.pid), samples: rows };
}
async function exercise(instance, fixtureUrl, options) {
  const { cdp, session, targetId, result } = instance;
  result.newTabs = [];
  for (const tabUrl of ['about:blank', 'chrome://newtab/']) {
    for (let repeat = 0; repeat < options.repetitions; repeat++) {
      const started = performance.now();
      instance.operation = { stage: 'new-tab', requestedUrl: tabUrl, repeat };
      const { targetId: id } = await cdp.send('Target.createTarget', { url: tabUrl });
      const tabSession = await cdp.attach(id);
      Object.assign(instance.operation, { targetId: id, session: tabSession });
      await cdp.send('Target.activateTarget', { targetId: id });
      const readiness = await pageReady(cdp, tabSession, tabUrl === 'about:blank' ? tabUrl : undefined, tabUrl !== 'about:blank');
      result.newTabs.push({ targetId: id, requestedUrl: tabUrl, resolvedUrl: await cdp.evaluate(tabSession, 'location.href'), usableMs: performance.now() - started, readiness });
      await cdp.send('Target.closeTarget', { targetId: id });
    }
  }
  await cdp.send('Target.activateTarget', { targetId });
  result.navigations = [];
  for (let repeat = 0; repeat < options.repetitions; repeat++) {
    const url = `${fixtureUrl}?navigation=${repeat}`;
    instance.operation = { stage: 'navigation', targetId, session, expectedUrl: url, repeat };
    const started = performance.now();
    const navigateResult = await cdp.send('Page.navigate', { url }, session);
    const navigateAckMs = performance.now() - started;
    const readiness = await pageReady(cdp, session, url);
    result.navigations.push({ usableMs: performance.now() - started,
      navigateAckMs, navigateResult, readiness,
      navigationTiming: await cdp.evaluate(session, 'performance.getEntriesByType("navigation")[0].toJSON()') });
  }
  instance.operation = { stage: 'one-tab-memory', targetId, session };
  result.memoryOneTab = await memorySample(instance, options.settleSeconds, options.memorySamples);
  result.multiTabs = [];
  for (let index = 1; index < options.tabs; index++) {
    const url = `${fixtureUrl}?tab=${index}`;
    instance.operation = { stage: 'memory-tab-creation', expectedUrl: url, index };
    const { targetId: id } = await cdp.send('Target.createTarget', { url });
    const tabSession = await cdp.attach(id);
    Object.assign(instance.operation, { targetId: id, session: tabSession });
    await cdp.send('Target.activateTarget', { targetId: id });
    await pageReady(cdp, tabSession, url);
    result.multiTabs.push(id);
  }
  await cdp.send('Target.activateTarget', { targetId });
  instance.operation = { stage: 'multi-tab-memory', targetId, session };
  result.multiTabPageInventory = await pageInventory(cdp);
  result.actualPageTabCount = result.multiTabPageInventory.contentPageCount;
  assert.equal(result.actualPageTabCount, options.tabs, 'Unexpected tabs would bias memory comparison');
  result.memoryMultiTab = await memorySample(instance, options.settleSeconds, options.memorySamples);
  // Both products quit with the same single fixture tab, so relaunches do not
  // compare a restored multi-tab session against a single-tab session.
  for (const id of result.multiTabs) await cdp.send('Target.closeTarget', { targetId: id });
  instance.operation = { stage: 'pre-relaunch', targetId, session, expectedUrl: fixtureUrl };
  await cdp.send('Target.activateTarget', { targetId });
  await cdp.send('Page.navigate', { url: fixtureUrl }, session);
  await pageReady(cdp, session, fixtureUrl);
  result.preRelaunchPageInventory = await pageInventory(cdp);
  assert.equal(result.preRelaunchPageInventory.contentPageCount, 1);
}
function aggregate(trials) {
  const result = {};
  for (const name of ['breezer', 'chrome']) {
    const samples = trials.filter(trial => trial.browser === name);
    const first = samples.filter(trial => trial.profileState === 'fresh');
    const warm = samples.filter(trial => trial.profileState === 'reused');
    result[name] = {
      startupFreshProfileMs: summarize(first.map(item => item.startupUsableMs)),
      startupReusedProfileMs: summarize(warm.map(item => item.startupUsableMs)),
      blankTabMs: summarize(first.flatMap(item => item.newTabs.filter(tab => tab.requestedUrl === 'about:blank').map(tab => tab.usableMs))),
      productNewTabMs: summarize(first.flatMap(item => item.newTabs.filter(tab => tab.requestedUrl === 'chrome://newtab/').map(tab => tab.usableMs))),
      localNavigationUsableMs: summarize(first.flatMap(item => item.navigations.map(nav => nav.usableMs))),
      localNavigationLoadEventEndMs: summarize(first.flatMap(item => item.navigations.map(nav => nav.navigationTiming.loadEventEnd))),
      oneTabRssMiB: summarize(first.map(item => item.memoryOneTab.rssMiB.median)),
      multiTabRssMiB: summarize(first.map(item => item.memoryMultiTab.rssMiB.median)),
    };
  }
  return result;
}
export async function main(argv = process.argv.slice(2)) {
  const help = `Usage: node script/benchmark_browsers.mjs --prepare|--run --breezer /absolute/Breezer.app --chrome '/Applications/Google Chrome.app' --output NEW_DIRECTORY [--trials 6 --repetitions 3 --tabs 10 --settle-seconds 5 --memory-samples 5]\n--prepare verifies bundles, records environment, and compiles the native window probe. It never launches a browser.\n--run performs measurements. Run only after builds and competing work have stopped. See docs/browser-benchmark.md.`;
  if (argv.includes('--help') || !argv.length) { console.log(help); return; }
  const options = { trials: 6, repetitions: 3, tabs: 10, settleSeconds: 5, memorySamples: 5 };
  const valueKeys = { '--breezer': 'breezer', '--chrome': 'chrome', '--output': 'output', '--trials': 'trials', '--repetitions': 'repetitions', '--tabs': 'tabs', '--settle-seconds': 'settleSeconds', '--memory-samples': 'memorySamples' };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--run' || arg === '--prepare') { assert.ok(!options.mode, 'Choose exactly one mode'); options.mode = arg.slice(2); }
    else {
      assert.ok(valueKeys[arg] && argv[index + 1], `Unknown or incomplete argument ${arg}`);
      const key = valueKeys[arg];
      options[key] = typeof options[key] === 'number' ? Number(argv[++index]) : argv[++index];
    }
  }
  assert.equal(process.platform, 'darwin', 'This benchmark requires macOS native windows');
  assert.ok(options.mode && options.breezer && options.chrome && options.output, help);
  for (const key of ['trials', 'repetitions', 'tabs', 'settleSeconds', 'memorySamples']) assert.ok(Number.isSafeInteger(options[key]) && options[key] >= 1, `Invalid ${key}`);
  assert.ok(options.tabs >= 2);
  options.output = resolve(options.output);
  const browsers = { breezer: await metadata(resolve(options.breezer)), chrome: await metadata(resolve(options.chrome)) };
  assert.notEqual(browsers.breezer.executableSha256, browsers.chrome.executableSha256, 'Two distinct browser executables required');
  await mkdir(options.output, { recursive: false });
  const probeSource = join(options.output, 'native-window-probe.swift');
  const probeExecutable = join(options.output, 'native-window-probe');
  await writeFile(probeSource, windowProbeSource);
  execFileSync('/usr/bin/xcrun', ['swiftc', probeSource, '-o', probeExecutable], { stdio: 'pipe', timeout: 120000 });
  const report = { protocol: 'installed-browser-v3-observed-cpu', status: options.mode === 'prepare' ? 'prepared' : 'running', options, browsers, flags: commonFlags, environmentBefore: environment(), trials: [] };
  const save = () => writeFile(join(options.output, 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
  await save();
  if (options.mode === 'prepare') { console.log(`Prepared without launching browsers: ${options.output}`); return; }
  const html = fixtureHtml();
  report.fixtureSha256 = createHash('sha256').update(html).digest('hex');
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(html) });
    response.end(html);
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`;
  report.fixtureUrl = fixtureUrl;
  let active;
  let profile;
  const interrupt = async (signal, code) => {
    report.status = 'interrupted';
    report.error = signal;
    await active?.cleanup();
    if (profile) await rm(profile, { recursive: true, force: true });
    await save();
    process.exit(code);
  };
  const onSigint = () => { void interrupt('SIGINT', 130); };
  const onSigterm = () => { void interrupt('SIGTERM', 143); };
  process.once('SIGINT', onSigint);
  process.once('SIGTERM', onSigterm);
  try {
    // Do not count window-probe compilation or binary hashing in a browser timing.
    await sleep(10000);
    for (let trial = 0; trial < options.trials; trial++) {
      const order = trial % 2 === 0 ? ['breezer', 'chrome'] : ['chrome', 'breezer'];
      for (const name of order) {
        profile = await mkdtemp(join(tmpdir(), `breezer-benchmark-${name}-`));
        for (const state of ['fresh', 'reused']) {
          await rm(join(profile, 'DevToolsActivePort'), { force: true });
          const label = `trial-${trial + 1}-${name}-${state}`;
          console.log(`Measuring ${label}`);
          active = await launch(browsers[name], profile, fixtureUrl, options.output, label, probeExecutable);
          active.result.browser = name;
          active.result.trial = trial + 1;
          active.result.profileState = state;
          active.result.environmentAtLaunch = environment();
          report.trials.push(active.result);
          if (state === 'fresh') await exercise(active, fixtureUrl, options);
          await save();
          await active.cleanup();
          active = undefined;
          await sleep(2000);
        }
        await rm(profile, { recursive: true, force: true });
        profile = undefined;
      }
    }
    report.summary = aggregate(report.trials);
    report.status = 'completed';
    report.environmentAfter = environment();
  } catch (error) {
    report.status = 'failed';
    report.error = error.stack;
    if (active) await active.captureFailure(error);
    if (error.launchResult) report.failedLaunch = error.launchResult;
    process.exitCode = 1;
    console.error(error.stack);
  } finally {
    await active?.cleanup();
    if (profile) await rm(profile, { recursive: true, force: true });
    await new Promise(done => server.close(done));
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    await save();
  }
  console.log(JSON.stringify({ status: report.status, summary: report.summary, output: options.output }, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
