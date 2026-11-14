import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { cp, readFile, appendFile, writeFile, mkdir, mkdtemp, readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { compilerContract } from '../../script/breezer_filter_lists.mjs';
import { deriveTokens, verifyTrustedScriptletData, renderTokens } from '../../script/breezer_trusted_scriptlet_tokens.mjs';

import { work, root, manifest } from './fixtures/main-port-20261115/fixture.mjs';
const load = (arm, name) => import(pathToFileURL(join(root(arm), name)).href);
const baseline = await load('baseline', 'trusted-tokens.js');
const candidate = await load('source', 'trusted-tokens.js');
const scriptlets = await load('baseline', 'resources/scriptlets.js');
const generated = await load('source', 'trusted-scriptlet-tokens.js');

test('79 ordered tokens, redirect half, and shared mutable Set match actual modules', () => {
  assert.deepEqual([...candidate.getTrustedTokens()], [...baseline.getTrustedTokens()]);
  assert.equal(candidate.getTrustedTokens().size, 79);
  assert.equal(generated.trustedScriptletTokens.length, 76);
  assert.deepEqual(generated.trustedScriptletTokens, deriveTokens(scriptlets.builtinScriptlets));
  assert.ok(Object.isFrozen(generated.trustedScriptletTokens));
  for (const module of [baseline, candidate]) {
    const set = module.getTrustedTokens(); set.add('test-only-late-trusted');
    assert.strictEqual(module.getTrustedTokens(), set);
    assert.ok(module.getTrustedTokens().has('test-only-late-trusted'));
    set.delete('test-only-late-trusted');
  }
});

test('later real scriptlet loading retains metadata and executable function strings', async () => {
  const late = await load('source', 'resources/scriptlets.js');
  const describe = x => x.builtinScriptlets.map(({ fn, ...meta }) => ({ ...meta, fn: fn?.toString() }));
  assert.deepEqual(describe(late), describe(scriptlets));
  assert.deepEqual([...candidate.getTrustedTokens()], [...baseline.getTrustedTokens()]);
});

async function graph(folder) {
  const seen = new Set();
  async function visit(name) {
    if (seen.has(name)) return; seen.add(name);
    const source = await readFile(join(folder, name), 'utf8');
    for (const match of source.matchAll(/^import\s+(?:[^;]*?\sfrom\s*)?['"]([^'"]+)['"]\s*;/gm)) {
      await visit(join(dirname(name), match[1]));
    }
  }
  await visit('trusted-tokens.js'); return [...seen];
}
test('baseline reproduces static executable imports; candidate token graph has three modules', async () => {
  assert.equal((await graph(root('baseline'))).filter(n => n.startsWith('resources/')).length, 32);
  assert.deepEqual(await graph(root('source')),
    ['trusted-tokens.js', 'trusted-scriptlet-tokens.js', 'redirect-resources.js']);
});

function bundleTokens(source, redirectResources) {
  const start = source.indexOf('// js/trusted-tokens.js');
  const end = source.indexOf('\n// js/', start + 1);
  const section = source.slice(start, end).replace(/^import .+;\n/gm, '');
  const globals = { builtinScriptlets: scriptlets.builtinScriptlets,
    trustedScriptletTokens: generated.trustedScriptletTokens, redirectResources };
  const prelude = source.slice(0, source.indexOf('// js/cosmetic-filtering.js'));
  return vm.runInNewContext(prelude + section + '\ninit_trusted_tokens(); getTrustedTokens;', globals);
}
test('actual flattened baseline and candidate token code preserve values, order and mutability', async () => {
  const { default: redirects } = await load('baseline', 'redirect-resources.js');
  for (const arm of ['baseline', 'source']) {
    const get = bundleTokens(await readFile(join(root(arm), 'breezer-startup-body.js'), 'utf8'), redirects);
    assert.deepEqual([...get()], [...baseline.getTrustedTokens()]);
    const set = get(); set.add('late'); assert.strictEqual(get(), set); assert.ok(get().has('late'));
  }
});

test('strict trust, aliases, duplicates and js suffix expansion retain registration order', () => {
  assert.deepEqual(deriveTokens([
    { name: 'a.js', requiresTrust: true, aliases: ['b.js', 'a.js', 'plain'] },
    { name: 'ignored.js', requiresTrust: 1 }, { name: 'c.js', requiresTrust: true, aliases: 'ignored' },
  ]), ['a.js', 'a', 'b.js', 'b', 'plain', 'c.js', 'c']);
  assert.throws(() => deriveTokens([{ requiresTrust: true }]), /must be a string/);
});

async function variant(label) {
  await mkdir(join(work, 'controls'), { recursive: true });
  const folder = await mkdtemp(join(work, 'controls', label + '-'));
  await cp(join(work, 'source'), folder, { recursive: true });
  return folder;
}

test('real-module validation rejects alias/trust edits, deletion and reordering', async () => {
  await verifyTrustedScriptletData(root('source'));
  for (const [label, tail] of [
    ['alias', "builtinScriptlets.find(x=>x.requiresTrust===true).aliases=['new-alias.js'];"],
    ['trust', 'builtinScriptlets.find(x=>x.requiresTrust!==true).requiresTrust=true;'],
  ]) {
    const folder = await variant(label), js = join(folder, 'third_party/ublock/js');
    await appendFile(join(js, 'resources/scriptlets.js'), '\n' + tail + '\n');
    await assert.rejects(verifyTrustedScriptletData(js), /stale or modified/);
  }
  for (const tokens of [generated.trustedScriptletTokens.slice(1), [...generated.trustedScriptletTokens].sort()]) {
    const folder = await variant('generated'), js = join(folder, 'third_party/ublock/js');
    await writeFile(join(js, 'trusted-scriptlet-tokens.js'), renderTokens(tokens));
    await assert.rejects(verifyTrustedScriptletData(js), /stale or modified/);
  }
});

test('fresh subprocess prevents stale import-cache admission across repeated calls', async () => {
  const folder = await variant('fresh'), js = join(folder, 'third_party/ublock/js');
  await verifyTrustedScriptletData(js);
  await appendFile(join(js, 'resources/scriptlets.js'),
    "\nbuiltinScriptlets.push({name:'new-trusted.js',requiresTrust:true});\n");
  await assert.rejects(verifyTrustedScriptletData(js), /stale or modified/);
});

test('actual compiler contract includes generated module and rejects stale data before versions/inventory', async () => {
  const valid = await compilerContract(join(work, 'source'));
  assert.equal(Object.keys(valid.sourceHashes).length, manifest.candidateCompilerSourceCount);
  // This licensed closure is intentionally smaller than the production inventory.
  const expectedNames = Object.keys(manifest.files)
    .filter(name => /^baseline\/third_party\/ublock\/(js|lib)\/.*\.js$/.test(name))
    .map(name => name.replace('baseline/third_party/ublock/', ''));
  expectedNames.push('js/trusted-scriptlet-tokens.js');
  assert.deepEqual(Object.keys(valid.sourceHashes), expectedNames.sort());
  assert.equal(typeof valid.sourceHashes['js/trusted-scriptlet-tokens.js'], 'string');
  assert.ok(!Object.hasOwn(valid.sourceHashes, 'js/breezer-binary-binding.js'));
  const folder = await variant('compiler-order'), js = join(folder, 'third_party/ublock/js');
  await appendFile(join(js, 'resources/scriptlets.js'),
    "\nbuiltinScriptlets.push({name:'new-compiler-token.js',requiresTrust:true});\n");
  const source = await readFile(new URL('../../script/breezer_filter_lists.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('export async function compilerContract('),
    source.indexOf('\nexport async function withBuiltinBlocker(')).replace('export ', '');
  let reads = 0;
  const fn = vm.runInNewContext(body + '\ncompilerContract', { assert, join, verifyTrustedScriptletData,
    readFile: async (...args) => { reads++; return readFile(...args); },
    readdir: async (...args) => { reads++; return readdir(...args); },
    ownedModules: new Set(), sha256: x => createHash('sha256').update(x).digest('hex') });
  await assert.rejects(fn(folder), /stale or modified/);
  assert.equal(reads, 0);
});
