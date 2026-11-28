#!/usr/bin/env node
import { NativeDecoder, encodeMessage, validOrigin } from './protocol.mjs';
import { Organato } from './organato.mjs';
import { UpdateController } from './updater.mjs';

async function providers() {
  const [{ CodexProvider }, { ClaudeProvider }] = await Promise.all([import('./codex.mjs'), import('./claude.mjs')]);
  return [new CodexProvider(), new ClaudeProvider()];
}

// One native message is capped at 1 MB. Keep the items the dashboard shows
// first (open, soonest due) and mark the list truncated when others are dropped.
const LIST_MESSAGE_BUDGET = 900_000;
const listDone = item => ['submitted', 'completed'].includes(item?.workingStatus);
const listDue = item => String(item?.dueAt || item?.dueDateLocal || '9999');
function fitList(value, budget = LIST_MESSAGE_BUDGET) {
  if (!value || !Array.isArray(value.items) || Buffer.byteLength(JSON.stringify(value)) <= budget) return value;
  let total = Buffer.byteLength(JSON.stringify({ ...value, items: [], truncated: true }));
  const ranked = value.items.map((item, index) => ({ item, index }))
    .sort((a, b) => listDone(a.item) - listDone(b.item) || listDue(a.item).localeCompare(listDue(b.item)) || a.index - b.index);
  const kept = new Set();
  for (const { item, index } of ranked) {
    const size = Buffer.byteLength(JSON.stringify(item) ?? 'null') + 1;
    if (total + size > budget) break;
    total += size; kept.add(index);
  }
  return { ...value, items: value.items.filter((_, index) => kept.has(index)), truncated: true };
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
    let frame;
    try { frame = encodeMessage(message); }
    catch {
      // Optional progress can be dropped; a request still gets its terminal reply.
      if (message?.type === 'organato-cache') return;
      const id = typeof message?.id === 'string' ? { id: message.id.slice(0, 100) } : {};
      const error = 'Breezer AI could not send this response because it is too large.';
      try { frame = encodeMessage(/^[a-z-]+-result$/.test(message?.type) ? { type: message.type, ...id, ok: false, error } : { type: 'error', ...id, error }); }
      catch { process.stderr.write('Breezer AI could not send a native message.\n'); process.exit(1); }
    }
    process.stdout.write(frame);
  };
  const updater = new UpdateController(send);
  const organato = new Organato();
  const getController = () => loadingController ||= Promise.all([import('./context-controller.mjs'), providers()]).then(([{ ContextHostController }, available]) => {
    controller = new ContextHostController(available, send, { integrationTool: (...args) => organato.tool(...args), prepareChat: async () => { const state = await organato.view(); return state.enabled && state.allowAI && state.connected; } });
    if (closed) controller.close();
    return controller;
  }).catch(error => {
    loadingController = undefined;
    throw error;
  });
  const close = () => { closed = true; controller?.close(); };
  async function receive(message) {
    if (['update-check', 'update-install', 'update-status'].includes(message?.type)) return updater.receive(message);
    if (['organato-view', 'organato-configure', 'organato-list'].includes(message?.type)) {
      try {
        const value = message.type === 'organato-view' ? await (message.dashboardCache === 1 ? organato.dashboardView() : organato.view()) : message.type === 'organato-configure' ? await organato.configure(message.settings || {}, stage => send({ type: 'organato-progress', id: message.id, stage })) : await (typeof message.dashboardIdentity === 'string' ? organato.dashboardList(message.dashboardIdentity, undefined, { onCached: value => send({ type: 'organato-cache', id: message.id, value: fitList(value) }) }) : organato.list(undefined, { onCached: value => send({ type: 'organato-cache', id: message.id, value: fitList(value) }) }));
        send({ type: 'organato-result', id: message.id, ok: true, value: message.type === 'organato-list' ? fitList(value) : value });
      } catch (error) { send({ type: 'organato-result', id: message.id, ok: false, error: error.message, ...(['NETWORK_ERROR', 'DASHBOARD_CHANGED'].includes(error.code) ? { code: error.code } : {}), ...(Number.isInteger(error.status) && error.status >= 100 && error.status <= 599 ? { status: error.status } : {}) }); }
      return;
    }
    try {
      const host = await getController();
      if (!closed) await decoder.dispatch(message, value => host.receive(value));
    } catch (error) {
      send({ type: 'error', ...(typeof message?.id === 'string' ? { id: message.id.slice(0, 100) } : {}), error: error.message.slice(0, 1500) });
    }
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
