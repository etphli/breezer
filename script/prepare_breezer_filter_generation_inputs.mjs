// Source-only plan. This never launches a compiler browser or generates an image.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compilerContract, canonical, sha256 } from './breezer_filter_lists.mjs';

const [sourceArg, outputArg, ...extra] = process.argv.slice(2);
assert.ok(sourceArg && outputArg && !extra.length,
  'prepare_breezer_filter_generation_inputs.mjs PRIVATE_SOURCE NEW_OUTPUT');
const source = resolve(sourceArg), output = resolve(outputArg);
execFileSync('python3', ['-B', fileURLToPath(new URL('./apply_breezer_filter_source_overlays.py', import.meta.url)),
  source, '--check'], { timeout: 10000, maxBuffer: 65536 });
const contract = await compilerContract(source);
const buildId = sha256(canonical(contract));
const stamp = Object.entries({ buildId, engineVersion: contract.engineVersion,
  engineJavaScriptVersion: contract.engineJavaScriptVersion })
  .map(([key, value]) => `export const ${key} = ${JSON.stringify(value)};\n`).join('');
const files = {};
for (const name of (await readdir(source, { recursive: true })).sort()) {
  if (!(name.endsWith('.js') || name.endsWith('.json') || name.endsWith('.html') ||
      ['chrome/VERSION', 'v8/include/v8-version.h', '.breezer-filter-source-overlays'].includes(name))) continue;
  const bytes = await readFile(join(source, name));
  files[name] = { bytes: bytes.length, sha256: sha256(bytes) };
}
await mkdir(output); // A new plan never overwrites evidence or generation results.
await writeFile(join(output, 'contract.json'), canonical(contract) + '\n');
await writeFile(join(output, 'planned-build-stamp.js'), stamp);
await writeFile(join(output, 'producer-binding.js'), "export const catalogSha256 = '';\n");
await writeFile(join(output, 'source-manifest.json'), JSON.stringify({ schema: 1, source,
  files, buildId, contractSha256: sha256(canonical(contract) + '\n'),
  compilerSourceCount: Object.keys(contract.sourceHashes).length,
  generationExecuted: false, nativeValidation: false, performanceAcceptance: false,
}, null, 2) + '\n');
console.log(JSON.stringify({ output, buildId, compilerSourceCount: Object.keys(contract.sourceHashes).length,
  generationExecuted: false }));
