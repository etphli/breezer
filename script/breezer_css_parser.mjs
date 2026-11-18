import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Exact css-tree 2.2.1 input. An upstream update needs a reviewed regeneration.
const sourceSHA = 'ecc4507fac946cbe442962e11bb058195dbe72545cce42f34338a83726ec56e0';
const licenseNotice = `/*
Copyright (C) 2016-2022 by Roman Dvornov

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.
*/
`;
export function renderCssParser(source) {
  assert.equal(createHash('sha256').update(source).digest('hex'), sourceSHA, 'CSS parser vendor source drift');
  const factory = 'return s.lexer=new Ke({generic:!0,types:e.types,atrules:e.atrules,properties:e.properties,node:e.node},s),s';
  assert.equal(source.split(factory).length, 2, 'CSS parser factory differs');
  const lean = source.replace(factory, 'return s');
  const start = lean.lastIndexOf('export{'), end = lean.indexOf('};', start) + 2;
  assert.ok(start > 0 && end > start, 'CSS parser export clause missing');
  return licenseNotice + lean.slice(0, start) + 'export{ib as parse};' + lean.slice(end);
}

export async function verifyCssParserData(folder) {
  const source = await readFile(join(folder, 'lib/csstree/css-tree.js'), 'utf8');
  assert.equal(await readFile(join(folder, 'js/breezer-css-parser.js'), 'utf8'), renderCssParser(source),
    'Generated CSS parser is stale or modified');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, folder, ...extra] = process.argv.slice(2);
  assert.ok(['--check', '--write'].includes(mode) && folder && !extra.length,
    'breezer_css_parser.mjs --check|--write UBLOCK_SOURCE');
  if (mode === '--check') await verifyCssParserData(resolve(folder));
  else await writeFile(join(resolve(folder), 'js/breezer-css-parser.js'),
    renderCssParser(await readFile(join(resolve(folder), 'lib/csstree/css-tree.js'), 'utf8')), { flag: 'wx' });
  console.log(mode === '--check' ? 'CSS parser source verified.' : 'Private CSS parser source generated; native generation still required.');
}
