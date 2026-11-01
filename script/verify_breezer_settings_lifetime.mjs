#!/usr/bin/env node
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { withBuiltinBlocker } from './breezer_filter_lists.mjs';
import { parseProcesses, processTree } from './benchmark_browsers.mjs';

const { values } = parseArgs({ options: Object.fromEntries(
  ['browser', 'artifacts', 'output'].map(name => [name, { type: 'string' }]),
) });
for (const name of ['browser', 'artifacts', 'output']) assert.ok(values[name], `Required: --${name}`);
const browser = resolve(values.browser);
const app = browser.replace(/\/Contents\/MacOS\/[^/]+$/, '');
assert.notEqual(app, browser, 'Expected an app-bundle executable');
const contract = JSON.parse(await readFile(join(resolve(values.artifacts), 'contract.json'), 'utf8'));
const pause = ms => new Promise(done => setTimeout(done, ms));
const report = {
  status: 'unverified', app, idleMs: 40000,
  scope: 'Packaged production Organato/context clients in a disposable headless profile, without the updater. Organato payloads are replaced with invalid input before reaching the native host; context is local and disabled. A separate updater-port control makes no requests. No provider, Keychain or real configuration requests. Zero idle helpers is not a claim about the full Settings route.',
};
const save = () => writeFile(resolve(values.output), JSON.stringify(report, null, 2) + '\n');
await save();
try {
  await withBuiltinBlocker({ browser, ...contract }, async ({ cdp, pid }) => {
    const helpers = () => processTree(parseProcesses(execFileSync('/bin/ps',
      ['-axo', 'pid=,ppid=,rss=,command='], { encoding: 'utf8', timeout: 3000 })), pid)
      .filter(row => row.command.includes('/breezer_ai/host/main.mjs'))
      .map(row => {
        assert.ok(row.command.includes(app + '/'), 'Unexpected helper executable');
        return { pid: row.pid, rssKiB: row.rssKiB };
      });
    const workers = async () => (await cdp.send('Target.getTargets')).targetInfos
      .filter(t => t.type === 'service_worker' && t.url.startsWith('chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/'))
      .map(({ targetId, url }) => ({ targetId, url }));
    assert.equal(helpers().length, 0);
    const { targetId } = await cdp.send('Target.createTarget', {
      url: 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/workspace.html',
    });
    const session = await cdp.attach(targetId);
    const waitFor = async expression => {
      for (let i = 0; i < 200; i++) {
        try { if (await cdp.evaluate(session, expression, 1000)) return; } catch {}
        await pause(25);
      }
      throw new Error(`Settings did not become ready: ${expression}`);
    };
    await waitFor("location.pathname === '/workspace.html' && document.readyState === 'complete' && Boolean(chrome.runtime?.id)");
    report.first = await cdp.evaluate(session, `(async () => {
      const [{ mountOrganato }, { createContextClient }, { CONTEXT_KEY }] = await Promise.all([
        import('./settings.js'), import('./context-settings.js'), import('./context-memory.js'),
      ]);
      const diag = globalThis.settingsLifetime = { connections: 0, sent: 0, changes: 0, key: CONTEXT_KEY };
      const api = { runtime: {
        get lastError() { return chrome.runtime.lastError; },
        connect(options) {
          const port = chrome.runtime.connect(options); diag.connections++;
          return {
            onMessage: port.onMessage, onDisconnect: port.onDisconnect,
            disconnect: () => port.disconnect(),
            postMessage(message) {
              diag.sent++;
              port.postMessage({ id: message.id, type: 'configure', settings: { enabled: 'invalid-diagnostic-input' } });
            },
          };
        },
      } };
      diag.organato = mountOrganato(api);
      diag.context = createContextClient(chrome);
      diag.context.onChange(() => { diag.changes++; });
      const context = await diag.context.request('view');
      return { contextEnabled: context.enabled };
    })()`);
    await waitFor("document.getElementById('organato-status').textContent === 'Invalid Organato setting.'");
    await cdp.evaluate(session, `(() => {
      document.getElementById('organato-key').value = 'org_' + 'x'.repeat(43);
      settingsLifetime.status = document.getElementById('organato-status').textContent;
      return true;
    })()`);
    report.first.workers = await workers();
    report.first.client = await cdp.evaluate(session, '({ connections: settingsLifetime.connections, sent: settingsLifetime.sent })');
    await save();
    // No debugger is attached to the AI service worker during this wait.
    await pause(report.idleMs);
    report.idle = {
      workers: await workers(), helpers: helpers(),
      client: await cdp.evaluate(session, `({
        connections: settingsLifetime.connections, sent: settingsLifetime.sent,
        statusPreserved: document.getElementById('organato-status').textContent === settingsLifetime.status,
        keyPreserved: document.getElementById('organato-key').value === 'org_' + 'x'.repeat(43),
      })`),
    };
    await save();
    await cdp.evaluate(session, `(async () => {
      await chrome.storage.local.set({ [settingsLifetime.key]: {
        version: 1, enabled: false, providerConsent: false, sites: [], buckets: [], lastSummary: null,
      } });
      return true;
    })()`);
    await pause(250);
    report.storageNotifications = await cdp.evaluate(session, 'settingsLifetime.changes');
    report.second = await cdp.evaluate(session, `(async () => {
      let context;
      try { context = { ok: true, enabled: (await settingsLifetime.context.request('view')).enabled }; }
      catch (error) { context = { ok: false, error: error.message }; }
      document.getElementById('organato-connect').click();
      return { context };
    })()`);
    await waitFor("!document.getElementById('organato-connect').disabled");
    report.second.client = await cdp.evaluate(session, `({
      connections: settingsLifetime.connections, sent: settingsLifetime.sent,
      status: document.getElementById('organato-status').textContent,
      keyCleared: document.getElementById('organato-key').value === '',
    })`);
    await pause(1500);
    report.second.idleHelpers = helpers();
    await cdp.evaluate(session, 'settingsLifetime.organato.dispose(); settingsLifetime.context.dispose(); true');
    await cdp.evaluate(session, "settingsLifetime.updater = chrome.runtime.connect({ name: 'breezer-updates' }); settingsLifetime.updater.onDisconnect.addListener(() => { void chrome.runtime.lastError; }); true");
    await pause(1000);
    report.updaterControl = { connectedHelpers: helpers() };
    await cdp.evaluate(session, 'settingsLifetime.updater.disconnect(); true');
    await pause(1000);
    report.updaterControl.disconnectedHelpers = helpers();
    await save();
    assert.equal(report.first.contextEnabled, false);
    assert.equal(report.first.workers.length, 1, 'Expected a live worker after the first request');
    assert.deepEqual(report.first.client, { connections: 1, sent: 1 });
    assert.equal(report.idle.workers.length, 0, 'Worker must actually retire during the test');
    assert.equal(report.idle.helpers.length, 0, 'Idle native helper must exit');
    assert.deepEqual(report.idle.client, { connections: 1, sent: 1, statusPreserved: true, keyPreserved: true });
    assert.ok(report.storageNotifications > 0, 'Dormant context client missed its storage notification');
    assert.deepEqual(report.second.context, { ok: true, enabled: false });
    assert.deepEqual(report.second.client, {
      connections: 2, sent: 2, status: 'Invalid Organato setting.', keyCleared: true,
    });
    assert.equal(report.second.idleHelpers.length, 0);
    assert.equal(report.updaterControl.connectedHelpers.length, 0, 'An unused updater port should start no helper');
    assert.equal(report.updaterControl.disconnectedHelpers.length, 0);
  });
  report.status = 'passed'; await save();
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  report.status = 'failed'; report.error = error.message; await save(); throw error;
}
