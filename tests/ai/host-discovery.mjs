// Explicit read-only integration check. It never sends a turn to either paid provider.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { NativeDecoder, encodeMessage } from '../../features/ai/host/protocol.mjs';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../../features/ai/host/main.mjs', import.meta.url));
const child = spawn(process.execPath, [entry, 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/'], { stdio: ['pipe', 'pipe', 'pipe'] });
const decoder = new NativeDecoder();
const timer = setTimeout(() => { child.kill('SIGKILL'); throw new Error('Native host discovery timed out.'); }, 60_000);
let status;
child.stdout.on('data', (chunk) => {
  for (const message of decoder.push(chunk)) {
    assert.equal(message.type, 'status'); status = message;
    assert.equal(status.providers.length, 2);
    for (const provider of status.providers) {
      assert.equal(typeof provider.authenticated, 'boolean');
      if (provider.available) {
        assert.ok(provider.models.length); assert.ok(provider.models.some((model) => model.id === provider.defaultModel));
        if (provider.id === 'codex' && provider.defaultModel === 'gpt-6.1-sol') assert.ok(provider.models.some((model) => model.id === 'gpt-6.1-sol'));
      } else assert.ok(provider.error);
    }
    console.log(JSON.stringify(status.providers.map(({ id, available, authenticated, defaultModel, isolation, models, error }) => ({ id, available, authenticated, defaultModel, isolation, modelCount: models.length, ...(error ? { error } : {}) })), null, 2));
    child.stdin.end();
  }
});
child.stderr.on('data', () => {});
child.stdin.write(encodeMessage({ type: 'init' }));
const code = await new Promise((resolve, reject) => { child.on('close', resolve); child.on('error', reject); });
clearTimeout(timer); decoder.finish(); assert.equal(code, 0); assert.ok(status);
