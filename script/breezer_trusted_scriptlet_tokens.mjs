import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

export function deriveTokens(scriptlets) {
  const result = new Set();
  const add = token => {
    assert.equal(typeof token, 'string', 'trusted scriptlet token must be a string');
    result.add(token);
    if (token.endsWith('.js')) result.add(token.slice(0, -3));
  };
  for (const { name, requiresTrust, aliases } of scriptlets) {
    if (requiresTrust !== true) continue;
    add(name);
    if (Array.isArray(aliases)) aliases.forEach(add);
  }
  // Preserve original registration order, including alias expansion.
  return [...result];
}

export function renderTokens(tokens) {
  return '// Generated from resources/scriptlets.js. Verify before compiler-contract generation.\n' +
    'export const trustedScriptletTokens = Object.freeze(' + JSON.stringify(tokens, null, 4) + ');\n';
}

export async function checkTokens(source) {
  const root = resolve(source);
  const { builtinScriptlets } = await import(pathToFileURL(join(root, 'resources/scriptlets.js')).href);
  const expected = renderTokens(deriveTokens(builtinScriptlets));
  assert.equal(await readFile(join(root, 'trusted-scriptlet-tokens.js'), 'utf8'), expected,
    'generated trusted scriptlet tokens are stale or modified');
  return expected;
}

// Compiler contracts must use a fresh process, not an earlier ESM module cache.
export async function verifyTrustedScriptletData(source) {
  await promisify(execFile)(process.execPath,
    [fileURLToPath(import.meta.url), '--check', resolve(source)],
    { timeout: 5000, maxBuffer: 65536 });
}

async function main() {
  const [mode, source, ...extra] = process.argv.slice(2);
  assert.ok(['--write', '--check'].includes(mode) && source && extra.length === 0,
    'generate-tokens.mjs --write|--check JS_SOURCE_DIRECTORY');
  const root = resolve(source);
  const { builtinScriptlets } = await import(pathToFileURL(join(root, 'resources/scriptlets.js')).href);
  const tokens = deriveTokens(builtinScriptlets);
  const expected = renderTokens(tokens);
  if (mode === '--write') {
    await writeFile(join(root, 'trusted-scriptlet-tokens.js'), expected, { flag: 'wx' });
  }
  await checkTokens(root);
  console.log(JSON.stringify({ status: 'verified', scriptletTokens: tokens.length, mode }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await main();
}
