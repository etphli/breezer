import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const provenance = JSON.parse(readFileSync(new URL('./provenance.json', import.meta.url)));
export async function loadHistoricalHost(name) {
  const entry = provenance.fixtures.find(entry => entry.path === `${name}-before.mjs`);
  assert.ok(entry, 'historical host fixture must have provenance');
  const bytes = readFileSync(new URL(entry.path, import.meta.url));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, 'historical bytes must remain unchanged');
  const source = bytes.toString('utf8');
  // Keep main's protocol validation, including its real attachments import.
  const imported = source.replace("'./protocol.mjs'", JSON.stringify(new URL('../../../../features/ai/host/protocol.mjs', import.meta.url).href));
  assert.equal(source.split("'./protocol.mjs'").length, name === 'controller' ? 2 : 1);
  return import('data:text/javascript;base64,' + Buffer.from(imported).toString('base64'));
}
