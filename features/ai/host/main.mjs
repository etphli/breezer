#!/usr/bin/env node
import { NativeDecoder, encodeMessage, validOrigin } from './protocol.mjs';
import { ContextHostController as HostController } from './context-controller.mjs';
import { CodexProvider } from './codex.mjs';
import { ClaudeProvider } from './claude.mjs';

export const EXTENSION_ORIGIN = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/';

if (Number(process.versions.node.split('.')[0]) < 22) {
  process.stderr.write('Breezer AI requires Node.js 22 or newer.\n'); process.exit(1);
}

if (process.argv.length === 3 && process.argv[2] === '--discover') {
  const providers = await Promise.all([new CodexProvider().discover(), new ClaudeProvider().discover()]);
  process.stdout.write(`${JSON.stringify({ providers }, null, 2)}\n`);
} else if (!validOrigin(process.argv[2], EXTENSION_ORIGIN) || process.argv.length !== 3) {
  process.stderr.write('Breezer AI rejected the native messaging origin.\n'); process.exit(1);
} else {
  const decoder = new NativeDecoder();
  const send = (message) => {
    try { process.stdout.write(encodeMessage(message)); }
    catch { process.stderr.write('Breezer AI could not send a native message.\n'); process.exit(1); }
  };
  const controller = new HostController([new CodexProvider(), new ClaudeProvider()], send);
  process.stdin.on('data', (chunk) => {
    try { for (const message of decoder.push(chunk)) void controller.receive(message); }
    catch { send({ type: 'error', error: 'Invalid native messaging frame.' }); controller.close(); process.exitCode = 1; process.stdin.destroy(); }
  });
  process.stdin.on('end', () => {
    try { decoder.finish(); } catch { process.exitCode = 1; }
    controller.close();
  });
  process.stdout.on('error', () => { controller.close(); process.exit(1); });
  process.on('SIGTERM', () => { controller.close(); process.exit(0); });
  process.on('SIGINT', () => { controller.close(); process.exit(0); });
}
