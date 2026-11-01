import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { once } from 'node:events';
import { NativeDecoder, encodeMessage } from '../../features/ai/host/protocol.mjs';

const entry = resolve(process.env.BREEZER_TEST_HOST_ENTRY || 'features/ai/host/main.mjs');
const origin = 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/';
async function run({ argument = origin, request } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'breezer-host-loading-'));
  const child = spawn(process.execPath, [entry, argument], { env: { ...process.env, NODE_V8_COVERAGE: directory }, stdio: ['pipe', 'pipe', 'pipe'] });
  const decoder = new NativeDecoder(), messages = [];
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.on('data', chunk => { messages.push(...decoder.push(chunk)); if (request) child.stdin.end(); });
  const timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try {
    if (request) child.stdin.write(encodeMessage(request));
    else child.stdin.end();
    const [code] = await once(child, 'close');
    const scripts = [];
    for (const file of await readdir(directory)) scripts.push(...JSON.parse(await readFile(join(directory, file), 'utf8')).result.map(script => script.url));
    return { code, stderr, scripts, messages };
  } finally { clearTimeout(timer); child.kill(); await rm(directory, { recursive: true, force: true }); }
}
const aiModule = url => /\/(codex|claude|context-controller|controller|cli|context-summary)\.mjs$/.test(url);

test('an idle native helper exits cleanly without loading AI providers or their controllers', async () => {
  const result = await run();
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.messages, []);
  assert.deepEqual(result.scripts.filter(aiModule), []);
});

test('invalid native origins are still rejected without loading AI providers', async () => {
  const result = await run({ argument: 'https://example.com/' });
  assert.equal(result.code, 1);
  assert.match(result.stderr, /rejected the native messaging origin/);
  assert.deepEqual(result.scripts.filter(aiModule), []);
});

test('the first AI message loads the real controller and preserves validation', async () => {
  const result = await run({ request: { type: 'chat', id: 'invalid', provider: 'unknown', message: 'test' } });
  assert.equal(result.code, 0, result.stderr);
  assert.ok(result.scripts.some(url => url.endsWith('/context-controller.mjs')));
  assert.equal(result.messages[0].type, 'error');
  assert.equal(result.messages[0].id, 'invalid');
});
