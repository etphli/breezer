import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, cp, mkdtemp, appendFile, access } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { renderCssParser, verifyCssParserData } from '../../script/breezer_css_parser.mjs';
import { root, work } from './fixtures/main-port-20261115/fixture.mjs';

const selectors = ['', '.ad', '#sponsored > :is(div,span)', '[data-x="ad"]',
  'article:has(> .ad)', 'div:nth-child(2n + 1 of .ad)', ':not(:where(.ad, .sponsor))',
  '[href^="https://example.com/"]', '\\31 23', 'div::before', ':unknown(??)',
  'div[', 'div)', 'div:has(', '.\\', '[x="unterminated', 'a/*comment*/ > b', '😀.ad'];
const filters = ['||ads.example^$script', '@@||ads.example/allowed.js$script',
  'example.com##.ad', 'example.com#@#.ad', '##.sponsor', '##div:has(> .ad)',
  'example.com##div:has-text(advertisement)', 'example.com##.ad:remove()',
  'example.com##.ad:style(display:none!important)', 'example.com##a[href^="https://ads."]',
  'example.com##:matches-path(/news/)', 'example.com##div:upward(2)',
  'example.com##.ad::before', 'example.com##div[', 'example.com##+js(set-constant, ad, false)',
  'example.com##^script:has-text(advertisement)', '##\\31 23', 'example.com#@#div:has(> .ad)'];
const load = (arm, name) => import(pathToFileURL(join(root(arm), name)).href);
const parseResult = (library, raw, options) => {
  try { return { ok: true, ast: JSON.stringify(library.parse(raw, options)) }; }
  catch (error) { return { ok: false, name: error.name, message: error.message,
    offset: error.offset, line: error.line, column: error.column,
    fragment: error.sourceFragment?.() }; }
};

test('generated private entry matches its pinned vendor without changing the full module', async () => {
  await verifyCssParserData(dirname(root('source')));
  const source = await readFile(join(root('baseline'), '../lib/csstree/css-tree.js'), 'utf8');
  assert.equal(await readFile(join(root('source'), 'breezer-css-parser.js'), 'utf8'), renderCssParser(source));
  assert.equal(await readFile(join(root('source'), '../lib/csstree/css-tree.js'), 'utf8'), source);
  assert.throws(() => renderCssParser(source + '\n'), /vendor source drift/);
  assert.deepEqual(Object.keys(await load('source', 'breezer-css-parser.js')), ['parse']);
});

test('generator writes only a new entry and rejects existing output or vendor drift', async () => {
  const script = fileURLToPath(new URL('../../script/breezer_css_parser.mjs', import.meta.url));
  const folder = await mkdtemp(join(work, 'controls', 'css-generation-'));
  await cp(join(work, 'baseline'), folder, { recursive: true });
  const source = join(folder, 'third_party/ublock');
  const command = () => spawnSync(process.execPath, [script, '--write', source], { encoding: 'utf8', timeout: 10000 });
  assert.equal(command().status, 0);
  await verifyCssParserData(source);
  const output = await readFile(join(source, 'js/breezer-css-parser.js'), 'utf8');
  const refused = command();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /EEXIST/);
  assert.equal(await readFile(join(source, 'js/breezer-css-parser.js'), 'utf8'), output);
  const other = await mkdtemp(join(work, 'controls', 'css-drift-'));
  await cp(join(work, 'baseline'), other, { recursive: true });
  const changed = join(other, 'third_party/ublock');
  await appendFile(join(changed, 'lib/csstree/css-tree.js'), '\n// changed\n');
  const rejected = spawnSync(process.execPath, [script, '--write', changed], { encoding: 'utf8', timeout: 10000 });
  assert.notEqual(rejected.status, 0);
  assert.match(rejected.stderr, /vendor source drift/);
  await assert.rejects(access(join(changed, 'js/breezer-css-parser.js')));
});

test('CSS contexts, malformed input and error details preserve parse output', async () => {
  const full = await load('baseline', '../lib/csstree/css-tree.js');
  const lean = await load('source', 'breezer-css-parser.js');
  for (const raw of selectors) assert.deepEqual(parseResult(lean, raw, { context: 'selectorList', positions: true }),
    parseResult(full, raw, { context: 'selectorList', positions: true }));
  for (const context of ['stylesheet', 'declarationList', 'value', 'mediaQueryList', 'selector', 'block'])
    for (const raw of ['color:red;display:none!important', '--x:var(--a, red)', '(width > 30px)',
      '@media (width > 30px){a{color:red}}', 'a > b', '/*unterminated', 'url("x")', ''])
      for (const parseValue of [true, false]) assert.deepEqual(parseResult(lean, raw, { context, parseValue }),
        parseResult(full, raw, { context, parseValue }));
  full.parse(''); lean.parse('');
});

const parserState = parser => JSON.stringify({ type: parser.astType, flavor: parser.astTypeFlavor,
  flags: parser.astFlags, error: parser.astError, root: parser.rootNode,
  nodes: Array.from(parser.nodes.subarray(0, parser.nodePoolPtr)),
  transforms: parser.astTransforms.slice(0, parser.astTransformPtr), result: parser.result });
test('actual filter parser preserves selectors, procedural filters and rejection behavior', async () => {
  const a = await load('baseline', 'static-filtering-parser.js');
  const b = await load('source', 'static-filtering-parser.js');
  for (const nativeCssHas of [false, true]) {
    const before = new a.AstFilterParser({ interactive: true, nativeCssHas });
    const after = new b.AstFilterParser({ interactive: true, nativeCssHas });
    for (const raw of filters) {
      before.parse(raw); after.parse(raw);
      assert.equal(parserState(after), parserState(before), 'Filter output differs: ' + raw);
    }
    before.finish(); after.finish();
  }
});

function bundleParser(source, candidate) {
  const marker = candidate ? '// js/breezer-css-parser.js' : '// lib/csstree/css-tree.js';
  const start = source.indexOf(marker), end = source.indexOf('\n// ', start + marker.length);
  assert.ok(start > 0 && end > start, 'Bundled CSS section missing');
  const prelude = source.slice(0, source.indexOf('// js/cosmetic-filtering.js')).replace(/^import .+;\n/gm, '');
  return vm.runInNewContext(prelude + source.slice(start, end) +
    `\n${candidate ? 'init_breezer_css_parser' : 'init_css_tree'}(); ({parse:ib});`);
}
test('embedded startup parser matches the module parser', async () => {
  const full = await load('baseline', '../lib/csstree/css-tree.js');
  for (const arm of ['baseline', 'source']) {
    const parser = bundleParser(await readFile(join(root(arm), 'breezer-startup-body.js'), 'utf8'), arm === 'source');
    for (const raw of selectors) assert.deepEqual(parseResult(parser, raw, { context: 'selectorList', positions: true }),
      parseResult(full, raw, { context: 'selectorList', positions: true }));
    parser.parse('');
  }
});
