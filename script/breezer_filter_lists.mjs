// Build-time diagnostics only. Every invocation owns a new disposable profile.
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CDP, parseProcesses, processTree } from './benchmark_browsers.mjs';

export const canonical = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) : item);
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const sleep = ms => new Promise(done => setTimeout(done, ms));
const blockerPrefix = 'chrome-extension://blockjmkbacgjkknlgpkjjiijinjdanf/';
const ownedModules = new Set(['js/breezer-compiled-filter-lists.js', 'js/breezer-compiled-filter-context.js', 'js/breezer-compiled-filter-build.js']);

export async function compilerContract(source) {
  const version = await readFile(join(source, 'chrome/VERSION'), 'utf8');
  const parts = ['MAJOR', 'MINOR', 'BUILD', 'PATCH'].map(key => version.match(new RegExp(`^${key}=(\\d+)$`, 'm'))?.[1]);
  assert.ok(parts.every(Boolean), 'Missing Chromium version');
  const v8 = await readFile(join(source, 'v8/include/v8-version.h'), 'utf8');
  const jsParts = ['MAJOR_VERSION', 'MINOR_VERSION', 'BUILD_NUMBER', 'PATCH_LEVEL'].map(key => v8.match(new RegExp(`^#define V8_${key} (\\d+)$`, 'm'))?.[1]);
  assert.ok(jsParts.every(Boolean), 'Missing V8 version');
  const folder = join(source, 'third_party/ublock');
  const names = (await readdir(folder, { recursive: true })).filter(name => name.endsWith('.js')
    && (name.startsWith('js/') || name.startsWith('lib/')) && !ownedModules.has(name)).sort();
  const sourceHashes = {};
  for (const name of names) sourceHashes[name] = sha256(await readFile(join(folder, name)));
  return { sourceHashes, engineVersion: `Chrome/${parts.join('.')}`, engineJavaScriptVersion: jsParts.join('.') };
}

export async function withBuiltinBlocker({ browser, engineVersion, onLaunch }, work) {
  const profile = await mkdtemp(join(tmpdir(), 'breezer-filter-build-'));
  // HeadlessChrome does not match uBlock's Chromium UA test. Use the shipping
  // engine token so generation has the same compiler environment as the GUI.
  const userAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${engineVersion} Safari/537.36`;
  const proc = spawn(browser, [`--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--headless=new', `--user-agent=${userAgent}`, '--remote-debugging-port=0', 'about:blank'], { stdio: ['ignore', 'ignore', 'pipe'] });
  const logs = [];proc.stderr.on('data', chunk => logs.push(chunk));
  let cdp, current, launchError;
  proc.on('error', error => { launchError = error; });
  const watchdog = setTimeout(() => proc.kill('SIGTERM'), 120000);
  const ps = () => parseProcesses(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', timeout: 5000 }));
  try {
    await onLaunch?.({ pid: proc.pid, profile });
    const deadline = performance.now() + 45000;let port;
    while (performance.now() < deadline && !port) {
      if (launchError) throw launchError;
      if (proc.exitCode !== null) throw new Error(`Browser exited: ${Buffer.concat(logs)}`);
      try { const rows = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).trim().split('\n');if (rows.length === 2) port = rows; } catch {}
      if (!port) await sleep(25);
    }
    assert.ok(port, 'No isolated debugging port');
    cdp = await CDP.connect(`ws://127.0.0.1:${port[0]}${port[1]}`);
    let ready = false;
    while (performance.now() < deadline && !ready) {
      const target = (await cdp.send('Target.getTargets')).targetInfos.find(t => t.type === 'background_page' && t.url.startsWith(blockerPrefix));
      if (!target) { current = null;await sleep(25);continue; }
      if (!current || current.targetId !== target.targetId) {
        current = { targetId: target.targetId, session: await cdp.attach(target.targetId) };
        await cdp.send('Network.enable', {}, current.session);
        await cdp.send('Network.setBlockedURLs', { urls: ['http://*', 'https://*'] }, current.session);
      }
      try {
        if (await cdp.evaluate(current.session, "Boolean(globalThis.vAPI?.uBO && document.readyState === 'complete')", 1000)) {
          ready = await cdp.evaluate(current.session, "import(chrome.runtime.getURL('js/start.js')).then(()=>import(chrome.runtime.getURL('js/background.js'))).then(({default:ub})=>ub.readyToFilter === true)", 2000);
        }
      } catch {}
      if (!ready) await sleep(25);
    }
    assert.ok(ready, 'Built-in blocker did not become ready across first-install reload');
    return await work({ cdp, ...current, pid: proc.pid, profile, browserVersion: await cdp.send('Browser.getVersion') });
  } catch (error) {
    error.message += `\nIsolated browser log:\n${Buffer.concat(logs).toString().slice(-12000)}`;throw error;
  } finally {
    clearTimeout(watchdog);
    const owned = proc.pid ? processTree(ps(), proc.pid) : [];
    await cdp?.send('Browser.close', {}, undefined, 1500).catch(() => {});await sleep(500);
    const currentRows = new Map(ps().map(p => [p.pid, p.command]));
    for (const row of owned) if (currentRows.get(row.pid) === row.command) try { process.kill(row.pid, 'SIGTERM'); } catch {}
    cdp?.socket.close();
    // A process can still write session files while SIGTERM is being handled.
    // Wait for our exact process identities before deleting the owned profile.
    const identities = new Map(owned.map(row => [row.pid, row.command]));
    const remaining = () => ps().filter(row => identities.get(row.pid) === row.command);
    const deadline = performance.now() + 5000;
    while (remaining().length && performance.now() < deadline) await sleep(100);
    for (const row of remaining()) try { process.kill(row.pid, 'SIGKILL'); } catch {}
    if (remaining().length) await sleep(500);
    assert.equal(remaining().length, 0, `Retaining profile while an owned process is still alive: ${profile}`);
    await rm(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  }
}
