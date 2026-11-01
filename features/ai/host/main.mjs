#!/usr/bin/env node
import { NativeDecoder, encodeMessage, validOrigin } from './protocol.mjs';
import { Organato } from './organato.mjs';
import { UpdateController } from './updater.mjs';

async function providers() {
  const [{ CodexProvider }, { ClaudeProvider }] = await Promise.all([import('./codex.mjs'), import('./claude.mjs')]);
  return [new CodexProvider(), new ClaudeProvider()];
}

export const EXTENSION_ORIGIN = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/';

if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('Breezer AI requires Node.js 22 or newer.\n'); process.exit(1);
}

if (process.argv.length === 3 && process.argv[2] === '--discover') {
  const discovered = await Promise.all((await providers()).map(provider => provider.discover()));
  process.stdout.write(`${JSON.stringify({ providers: discovered }, null, 2)}\n`);
} else if (!validOrigin(process.argv[2], EXTENSION_ORIGIN) || process.argv.length !== 3) {
  process.stderr.write('Breezer AI rejected the native messaging origin.\n'); process.exit(1);
} else {
  const decoder = new NativeDecoder();
  let closed = false, controller, loadingController;
  const send = (message) => {
    if (closed) return;
    try { process.stdout.write(encodeMessage(message)); }
    catch { process.stderr.write('Breezer AI could not send a native message.\n'); process.exit(1); }
  };
  const updater = new UpdateController(send);
  const organato = new Organato();
  const getController = () => loadingController ||= Promise.all([import('./context-controller.mjs'), providers()]).then(([{ ContextHostController }, available]) => {
    controller = new ContextHostController(available, send, { integrationTool: (...args) => organato.tool(...args), prepareChat: async () => { const state = await organato.view(); return state.enabled && state.allowAI && state.connected; } });
    if (closed) controller.close();
    return controller;
  });
  const close = () => { closed = true; controller?.close(); };
  async function receive(message) {
    try {
      if (['update-check', 'update-install', 'update-status'].includes(message.type)) return updater.receive(message);
      if (['organato-view', 'organato-configure', 'organato-list'].includes(message.type)) {
        const value = message.type === 'organato-view' ? await organato.view() : message.type === 'organato-configure' ? await organato.configure(message.settings || {}, stage => send({ type: 'organato-progress', id: message.id, stage })) : await organato.list();
        send({ type: 'organato-result', id: message.id, ok: true, value }); return;
      }
      const host = await getController();
      if (!closed) await host.receive(message);
    } catch (error) { send({ type: 'organato-result', id: message.id, ok: false, error: error.message }); }
  }
  process.stdin.on('data', (chunk) => {
    try { for (const message of decoder.push(chunk)) void receive(message); }
    catch { send({ type: 'error', error: 'Invalid native messaging frame.' }); close(); process.exitCode = 1; process.stdin.destroy(); }
  });
  process.stdin.on('end', () => {
    try { decoder.finish(); } catch { process.exitCode = 1; }
    close();
  });
  process.stdout.on('error', () => { close(); process.exit(1); });
  process.on('SIGTERM', () => { close(); process.exit(0); });
  process.on('SIGINT', () => { close(); process.exit(0); });
}
