import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { NativeDecoder, encodeMessage } from '../../features/ai/host/protocol.mjs';

const [gate, providerId] = process.argv.slice(2);
if (gate !== '--run-live' || !['codex', 'claude'].includes(providerId) || process.argv.length !== 4) {
  process.stderr.write('Usage: node tests/ai/host-live.mjs --run-live codex|claude\nThis sends one small synthetic chat through the selected authenticated CLI.\n');
  process.exit(2);
}

const entry = fileURLToPath(new URL('../../features/ai/host/main.mjs', import.meta.url));
const child = spawn(process.execPath, [entry, 'chrome-extension://namgcidocfgliiedlkdafcmifpdfiakj/'], { stdio: ['pipe', 'pipe', 'pipe'] });
const decoder = new NativeDecoder();
const id = `live-${providerId}`;
const title = 'Breezer integration check';
let selectedModel, toolCalls = 0, deltaEvents = 0, reply = '', sentChat = false, answeredTool = false, complete = false, failure, pendingTool;
const send = (message) => child.stdin.write(encodeMessage(message));
const stop = (error) => {
  if (failure) return;
  failure = error;
  clearTimeout(pendingTool);
  try { send({ type: 'cancel', id }); child.stdin.end(); } catch {}
  const kill = setTimeout(() => child.kill('SIGKILL'), 2000); kill.unref();
};
const timeout = setTimeout(() => stop(new Error('Live provider smoke test timed out.')), 90_000);

child.stdout.on('data', (chunk) => {
  try {
    for (const message of decoder.push(chunk)) {
      if (failure) break;
      if (message.type === 'status' && !sentChat) {
        const provider = message.providers.find((entry) => entry.id === providerId);
        assert.ok(provider?.available && provider.authenticated, provider?.error || `${providerId} is not signed in.`);
        assert.ok(provider.models.some((model) => model.id === provider.defaultModel));
        selectedModel = provider.defaultModel;
        sentChat = true;
        send({ type: 'chat', id, provider: providerId, model: selectedModel, includeContext: true, control: false,
          message: 'Call browser_snapshot exactly once. Then answer only with the test page title returned by that tool. Do not call other tools.',
          history: [], profile: { name: '', context: '' },
          context: { url: 'https://example.invalid/breezer-test', title, text: 'Synthetic browser integration fixture. No private information.', viewport: { width: 800, height: 600 }, elements: [] },
        });
      } else if (message.type === 'error') throw new Error(message.error);
      else if (message.id === id && message.type === 'delta') {
        assert.equal(typeof message.text, 'string');
        deltaEvents++; reply += message.text;
      } else if (message.id === id && message.type === 'tool') {
        toolCalls++;
        assert.equal(toolCalls, 1, 'The live smoke test permits exactly one browser tool call.');
        assert.equal(message.name, 'browser_snapshot'); assert.deepEqual(message.args, {});
        assert.equal(typeof message.requestId, 'string');
        assert.equal(complete, false);
        pendingTool = setTimeout(() => {
          try {
            assert.equal(complete, false, 'The provider completed before receiving the browser result.');
            answeredTool = true;
            send({ type: 'toolResult', id, requestId: message.requestId, result: { url: 'https://example.invalid/breezer-test', title, text: 'Synthetic tool result.', viewport: { width: 800, height: 600 }, elements: [] } });
          } catch (error) { stop(error); }
        }, 200);
      } else if (message.id === id && message.type === 'complete') {
        assert.equal(message.cancelled, undefined); assert.equal(toolCalls, 1); assert.equal(answeredTool, true);
        assert.ok(deltaEvents > 0, 'No streamed assistant text was received.');
        assert.ok(reply.includes(title), 'The assistant did not report the synthetic page title.');
        complete = true; clearTimeout(timeout); child.stdin.end();
      }
    }
  } catch (error) { stop(error); }
});
child.stderr.on('data', () => {});
child.stdin.on('error', (error) => { if (!complete) stop(error); });
child.on('error', stop);
send({ type: 'init' });
const code = await new Promise((resolve) => child.on('close', resolve));
clearTimeout(timeout); clearTimeout(pendingTool);
if (failure) throw failure;
decoder.finish(); assert.equal(code, 0); assert.equal(complete, true);
console.log(JSON.stringify({ provider: providerId, model: selectedModel, toolCalls, deltaEvents, waitedForToolResult: answeredTool, completed: complete, reply: reply.slice(0, 400) }, null, 2));
