import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

// Pure Node checks against historical AI source. No builds, CLIs, browser or profile access.
const base = '4fc90a363daea2247bbe5d17286e20905ec67cb4';
const root = fileURLToPath(new URL('../../', import.meta.url));
const sources = [
  'features/ai/package.json', 'features/ai/extension/browser-tools.js',
  'features/ai/extension/page-context.js', 'features/ai/extension/background.js',
  ...['protocol', 'controller', 'codex', 'claude', 'cli'].map(name => `features/ai/host/${name}.mjs`),
];
const tests = ['browser-tools.test.mjs', 'host.test.mjs', 'browser-input-providers.test.mjs'];
const pattern = 'canvas coordinate clicks|game start and direction|both providers can advertise|controller derives tool permission|adapter routes canvas/game actions';
const args = ['--test', `--test-name-pattern=${pattern}`, ...tests.map(name => `tests/ai/${name}`)];
const directory = await mkdtemp(join(tmpdir(), 'breezer-ai-input-old-'));
try {
  for (const path of sources) {
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), execFileSync('git', ['show', `${base}:${path}`], { cwd: root }));
  }
  for (const name of [...tests, 'browser-api-fixture.mjs']) {
    const path = `tests/ai/${name}`;
    await mkdir(dirname(join(directory, path)), { recursive: true });
    await writeFile(join(directory, path), await readFile(join(root, path)));
  }
  const old = spawnSync(process.execPath, args, { cwd: directory, encoding: 'utf8' });
  const current = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8' });
  assert.equal(old.status, 1, old.stdout + old.stderr);
  assert.match(old.stdout, /# tests 6\b/, old.stdout);
  assert.match(old.stdout, /# fail 6\b/, old.stdout);
  assert.equal(current.status, 0, current.stdout + current.stderr);
  assert.match(current.stdout, /# tests 6\b/, current.stdout);
  assert.match(current.stdout, /# pass 6\b/, current.stdout);
  console.log(`OLD ${base}: 6 targeted regressions fail.`);
  console.log(old.stdout.split('\n').filter(line => /^(not ok|  error:)/.test(line)).join('\n'));
  console.log('CURRENT: the same 6 regressions pass, including both provider adapters.');
} finally { await rm(directory, { recursive: true, force: true }); }
