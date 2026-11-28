import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDom } from './settings-dom.mjs';

const html = readFileSync(new URL('../../features/ai/extension/workspace.html', import.meta.url), 'utf8');

test('Sync settings explains that workspace sync waits for the vault download', async () => {
  const dom = createDom(html);
  Object.assign(globalThis, dom.globals);
  globalThis.window = dom.window;
  const { mountSyncSettings } = await import('../../features/ai/extension/sync-settings.js');
  const { SYNC_STATE_KEY } = await import('../../features/ai/extension/workspace-sync.js');
  const container = dom.document.getElementById('sync-settings');
  const listeners = [];
  const api = {
    breezerPrivate: { readWorkspaceSync: async () => ({}) },
    storage: {
      local: {
        get: async () => ({ [SYNC_STATE_KEY]: { phase: 'downloading' } }),
        onChanged: { addListener: (fn) => listeners.push(fn), removeListener() {} },
      },
    },
    runtime: { sendMessage: async () => ({}) },
    tabs: { create: async () => ({}) },
  };
  mountSyncSettings({ container, api });
  await new Promise((resolve) => setTimeout(resolve, 10));
  const status = container.querySelector('[role="status"]');
  assert.match(status.textContent, /Downloading your saved workspace/);
});
