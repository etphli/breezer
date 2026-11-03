import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
test('fragmented native frames copy bounded bytes and release the completed backing buffer', async () => {
  const { stdout } = await run(process.execPath, ['--expose-gc', 'script/verify_native_decoder_memory.mjs',
    '--bytes', String(1024 * 1024), '--rounds', '3', '--expect-bounded'], { timeout: 15000 });
  const result = JSON.parse(stdout);
  assert.equal(result.rounds, 3);
  assert.ok(result.retainedArrayBufferBytes < 256 * 1024);
  assert.ok(result.observations.every(row => row.concatCopiedBytes + row.assemblySetBytes <= result.payloadBytes * 4));
});

test('complete native frames copy only headers and release the input backing buffer', async () => {
  const { stdout } = await run(process.execPath, ['--expose-gc', 'script/verify_native_decoder_memory.mjs',
    '--bytes', String(1024 * 1024), '--chunks', String(2 * 1024 * 1024),
    '--rounds', '3', '--expect-bounded'], { timeout: 15000 });
  const result = JSON.parse(stdout);
  assert.equal(result.rounds, 3);
  assert.ok(result.retainedArrayBufferBytes < 256 * 1024);
  for (const row of result.observations) {
    assert.equal(row.concatCopiedBytes, 0);
    assert.equal(row.assemblySetBytes, 4);
  }
});
