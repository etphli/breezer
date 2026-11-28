import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { copyFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NativeDecoder, encodeMessage, MAX_OUTPUT_BYTES } from '../../features/ai/host/protocol.mjs';

const ORIGIN = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/';
// A large account: 2,000 items whose combined list exceeds one native message.
const fake = `import { Organato as Actual } from './actual-organato.mjs';
globalThis.fetch = () => { throw new Error('FORBIDDEN real fetch'); };
let page = 0;
const fetcher = async () => {
  const p = page++ % 10;
  const items = Array.from({ length: 200 }, (_, i) => ({ id: 'itm_' + p + '_' + i, version: 1, displayName: 'x'.repeat(600), kind: 'work', classification: 'assignment', dueDateLocal: '2026-12-' + String(1 + (p * 200 + i) % 28).padStart(2, '0'), workingStatus: (p * 200 + i) % 3 ? 'not_started' : 'completed', subjectId: 'sub' }));
  return new Response(JSON.stringify({ items, nextCursor: p < 9 ? 'c' + p : null }));
};
export class Organato extends Actual {
  constructor() { super({ fetcher, configDirectory: process.env.REVIEW_CONFIG, secrets: { get: async () => 'org_' + 'a'.repeat(43), set: async () => {}, remove: async () => {} } }); }
  async view() { return { ...await super.view(), huge: 'y'.repeat(1_200_000) }; }
}
`;

async function host(t) {
  const directory = await mkdtemp(join(tmpdir(), 'organato-size-'));
  for (const [from, to] of [['main.mjs', 'main.mjs'], ['protocol.mjs', 'protocol.mjs'], ['attachments.mjs', 'attachments.mjs'], ['updater.mjs', 'updater.mjs'], ['organato.mjs', 'actual-organato.mjs'], ['organato-windows.mjs', 'organato-windows.mjs']]) {
    await copyFile(new URL(`../../features/ai/host/${from}`, import.meta.url), join(directory, to));
  }
  await writeFile(join(directory, 'organato.mjs'), fake);
  const child = spawn(process.execPath, [join(directory, 'main.mjs'), ORIGIN], { stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, REVIEW_CONFIG: directory } });
  const decoder = new NativeDecoder(), replies = [], waiters = [];
  let stderr = '', sizes = [];
  child.stderr.on('data', data => { stderr += data; });
  child.stdout.on('data', chunk => {
    for (const message of decoder.push(chunk)) { replies.push(message); sizes.push(Buffer.byteLength(JSON.stringify(message))); waiters.splice(0).forEach(wake => wake()); }
  });
  const exited = new Promise(resolve => child.once('exit', code => { waiters.splice(0).forEach(wake => wake()); resolve(code); }));
  t.after(async () => { child.kill('SIGTERM'); await exited; await rm(directory, { recursive: true, force: true }); });
  const request = async (message) => {
    child.stdin.write(encodeMessage(message));
    const deadline = Date.now() + 10_000;
    for (;;) {
      const reply = replies.find(m => m.id === message.id && m.type === 'organato-result');
      if (reply) return reply;
      if (child.exitCode !== null) throw new Error(`host exited ${child.exitCode}: ${stderr}`);
      if (Date.now() > deadline) throw new Error('host reply timed out');
      await new Promise(resolve => { waiters.push(resolve); setTimeout(resolve, 50); });
    }
  };
  return { request, sizes, stderr: () => stderr };
}

test('a large Organato list is trimmed to one native message and marked truncated', async t => {
  const h = await host(t);
  const reply = await h.request({ type: 'organato-list', id: 'list-1' });
  assert.equal(reply.ok, true);
  assert.equal(reply.value.truncated, true);
  assert.ok(reply.value.items.length > 0 && reply.value.items.length < 2000);
  assert.ok(h.sizes.every(size => size <= MAX_OUTPUT_BYTES));
  // Open items are kept ahead of completed ones, and the earliest due dates first.
  assert.ok(reply.value.items.every(item => item.workingStatus !== 'completed'));
  const latestKept = reply.value.items.map(item => item.dueDateLocal).sort().at(-1);
  assert.ok(latestKept < '2026-12-28', 'the furthest due dates are dropped first');
  // The host stays alive for the next request.
  assert.equal((await h.request({ type: 'organato-list', id: 'list-2' })).ok, true);
});

test('an oversized response becomes a small error for that request instead of exiting', async t => {
  const h = await host(t);
  const reply = await h.request({ type: 'organato-view', id: 'view-1' });
  assert.equal(reply.ok, false);
  assert.match(reply.error, /too large/);
  assert.equal((await h.request({ type: 'organato-list', id: 'list-3' })).ok, true);
  assert.equal(h.stderr(), '');
});
