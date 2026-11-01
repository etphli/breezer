#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { withBuiltinBlocker } from './breezer_filter_lists.mjs';
import { parseProcesses, processTree } from './benchmark_browsers.mjs';

const { values } = parseArgs({ options: Object.fromEntries(
  ['baseline-browser', 'candidate-browser', 'artifacts', 'usage-probe', 'output'].map(name => [name, { type: 'string' }]),
) });
for (const name of ['baseline-browser', 'candidate-browser', 'artifacts', 'usage-probe', 'output']) assert.ok(values[name], `Required: --${name}`);
const contract = JSON.parse(await readFile(join(resolve(values.artifacts), 'contract.json'), 'utf8'));
const pause = ms => new Promise(done => setTimeout(done, ms));
const report = { status: 'unverified', idleMs: 40000, runs: [],
  scope: 'Actual packaged Organato, context and updater clients in disposable headless profiles. Updater requests are mapped to read-only update-status and Organato to invalid input before the native bridge; no release checks, installs, real configuration, Keychain or provider calls. This verifies transport lifetime/reconnection, not remote update availability or whole-browser RAM.',
};
const save = () => writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
await save();
for (const [name, path] of [['baseline', values['baseline-browser']], ['candidate', values['candidate-browser']]]) {
  const browser = resolve(path), app = browser.replace(/\/Contents\/MacOS\/[^/]+$/, '');
  assert.notEqual(app, browser, 'Expected an app-bundle executable');
  const statusFileExists = await stat(join(dirname(app), '.Breezer-update-status.json')).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
  assert.equal(statusFileExists, false, 'Use a private candidate parent with no updater status file');
  const run = { name, app };
  report.runs.push(run); await save();
  await withBuiltinBlocker({ browser, ...contract }, async ({ cdp, pid }) => {
    const sample = () => {
      const helpers = processTree(parseProcesses(execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,rss=,command='],
        { encoding: 'utf8', timeout: 3000 })), pid).filter(row => row.command.includes('/breezer_ai/host/main.mjs'));
      for (const row of helpers) assert.ok(row.command.includes(app + '/'), 'Unexpected native host');
      const memory = helpers.length ? JSON.parse(execFileSync(resolve(values['usage-probe']), helpers.map(row => String(row.pid)),
        { encoding: 'utf8', timeout: 3000 })) : null;
      if (memory) assert.ok(memory.processes.every(row => row.status === 'ok'));
      return { helpers: helpers.map(({ pid, rssKiB }) => ({ pid, rssKiB })), memory };
    };
    const workers = async () => (await cdp.send('Target.getTargets')).targetInfos
      .filter(target => target.type === 'service_worker' && target.url.startsWith('chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/'))
      .map(({ targetId, url }) => ({ targetId, url }));
    assert.equal(sample().helpers.length, 0);
    const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/workspace.html' });
    const session = await cdp.attach(targetId);
    const waitFor = async expression => {
      for (let i = 0; i < 240; i++) {
        try { if (await cdp.evaluate(session, expression, 1000)) return; } catch {}
        await pause(25);
      }
      throw new Error(`Settings did not become ready: ${expression}`);
    };
    await waitFor("location.pathname === '/workspace.html' && document.readyState === 'complete' && Boolean(chrome.runtime?.id)");
    await cdp.evaluate(session, `(async () => {
      const [{ mountUpdates, mountOrganato }, { createContextClient }] = await Promise.all([import('./settings.js'), import('./context-settings.js')]);
      const diag = globalThis.updateLifetime = { connections: {}, updateReplies: 0 };
      const api = { runtime: {
        get lastError() { return chrome.runtime.lastError; },
        connect(options) {
          const port = chrome.runtime.connect(options);
          diag.connections[options.name] = (diag.connections[options.name] || 0) + 1;
          if (options.name === 'breezer-updates') port.onMessage.addListener(message => {
            if (!message.ok || JSON.stringify(message.value) !== '{}') throw new Error('Unexpected diagnostic update status');
            diag.updateReplies++;
          });
          return { onMessage: port.onMessage, onDisconnect: port.onDisconnect, disconnect: () => port.disconnect(),
            postMessage(message) {
              port.postMessage(options.name === 'breezer-updates' ? { id: message.id, type: 'update-status' }
                : { id: message.id, type: 'configure', settings: { enabled: 'invalid-diagnostic-input' } });
            },
          };
        },
      } };
      diag.updates = mountUpdates(api); diag.organato = mountOrganato(api);
      diag.context = createContextClient(chrome);
      if ((await diag.context.request('view')).enabled !== false) throw new Error('Unexpected context configuration');
      return true;
    })()`);
    await waitFor("updateLifetime.updateReplies === 1 && !document.getElementById('update-check').disabled && document.getElementById('organato-status').textContent === 'Invalid Organato setting.'");
    await cdp.evaluate(session, `(() => {
      document.getElementById('organato-key').value = 'org_' + 'x'.repeat(43);
      updateLifetime.updateStatus = document.getElementById('update-status').textContent;
      return true;
    })()`);
    run.firstWorkers = await workers(); await save();
    // No AI-worker debugger is attached. The native updater is the only possible keepalive here.
    await pause(report.idleMs);
    run.idle = { ...sample(), workers: await workers(),
      client: await cdp.evaluate(session, `({ connections: updateLifetime.connections, updateReplies: updateLifetime.updateReplies,
        statusPreserved: document.getElementById('update-status').textContent === updateLifetime.updateStatus,
        keyPreserved: document.getElementById('organato-key').value === 'org_' + 'x'.repeat(43) })`),
    };
    await save();
    run.contextAfterIdle = await cdp.evaluate(session, `(async () => {
      const context = await updateLifetime.context.request('view');
      document.getElementById('update-check').click(); document.getElementById('organato-connect').click();
      return { enabled: context.enabled };
    })()`);
    await waitFor("updateLifetime.updateReplies === 2 && !document.getElementById('update-check').disabled && !document.getElementById('organato-connect').disabled && document.getElementById('organato-status').textContent === 'Invalid Organato setting.'");
    run.secondConnections = await cdp.evaluate(session, 'updateLifetime.connections');
    await pause(1500); run.afterSecond = sample();
    await cdp.evaluate(session, 'updateLifetime.updates.dispose(); updateLifetime.organato.dispose(); updateLifetime.context.dispose(); true');
    await pause(1000); run.disposed = sample(); await save();
    assert.equal(run.firstWorkers.length, 1);
    assert.equal(run.idle.helpers.length, name === 'baseline' ? 1 : 0);
    assert.equal(run.idle.workers.length, name === 'baseline' ? 1 : 0);
    assert.deepEqual(run.idle.client, { connections: { 'breezer-updates': 1, 'breezer-organato-settings': 1 }, updateReplies: 1, statusPreserved: true, keyPreserved: true });
    assert.deepEqual(run.contextAfterIdle, { enabled: false });
    assert.deepEqual(run.secondConnections, { 'breezer-updates': name === 'baseline' ? 1 : 2, 'breezer-organato-settings': name === 'baseline' ? 1 : 2 });
    assert.equal(run.afterSecond.helpers.length, name === 'baseline' ? 1 : 0);
    assert.equal(run.disposed.helpers.length, 0);
  });
}
report.status = 'passed'; await save(); console.log(JSON.stringify(report, null, 2));
