import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const rendererPath = 'features/ai/extension/render-message.js';
export const beforePath = 'tests/ai/fixtures/render-message-before.js';
export const hash = source => crypto.createHash('sha256').update(source).digest('hex');

// Counts explicit DOM allocations and parser input, never elapsed time or RSS.
export function fixture(source) {
  const counts = { nodes: 0, parsedCharacters: 0, renders: 0, scannedCharacters: 0, scannedLines: 0 };
  class Node {
    constructor(localName, text = '') { this.localName = localName; this.text = text; this.childNodes = []; this.parentNode = null; }
    append(...nodes) {
      for (const node of nodes) {
        if (node.localName === '#fragment') { this.append(...node.childNodes); continue; }
        node.remove(); node.parentNode = this; this.childNodes.push(node);
      }
    }
    appendData(value) {
      if (this.localName !== '#text') throw new TypeError('Only Text nodes support appendData in this fixture');
      this.text += value;
    }
    remove() { if (this.parentNode) { const siblings = this.parentNode.childNodes; siblings.splice(siblings.indexOf(this), 1); this.parentNode = null; } }
    replaceChildren(...nodes) { for (const node of [...this.childNodes]) node.remove(); this.append(...nodes); }
    get lastChild() { return this.childNodes.at(-1) || null; }
    get childElementCount() { return this.childNodes.filter(node => node.localName !== '#text').length; }
    set textContent(text) { this.replaceChildren(); this.text = text; if (text) this.append(document.createTextNode(text)); }
    get textContent() { return this.localName === '#text' ? this.text : this.childNodes.map(node => node.textContent).join(''); }
  }
  const document = {
    createElement(tag) { counts.nodes++; return new Node(tag); },
    createTextNode(text) { counts.nodes++; return new Node('#text', text); },
    createDocumentFragment() { counts.nodes++; return new Node('#fragment'); },
  };
  const instrumented = source.replace('const lines = text.split', 'countRender(text); const lines = text.split').replace('const line = tail.slice(lineStart, end);', 'const line = tail.slice(lineStart, end); countScan(line);').replaceAll('export function ', 'function ');
  const context = vm.createContext({ document, countScan(line) { counts.scannedCharacters += line.length + 1; counts.scannedLines++; }, countRender(text) { counts.parsedCharacters += text.length; counts.renders++; } });
  vm.runInContext(instrumented + '\nglobalThis.renderer = {renderMessage, createMessageStream: typeof createMessageStream === "function" ? createMessageStream : null};', context);
  return { ...context.renderer, document, counts, root: () => new Node('div') };
}

export function tree(node) {
  return [node.localName, node.localName === '#text' ? node.text : '', node.href || '', node.target || '', node.rel || '', node.childNodes.map(tree)];
}
export function workload(source, chunks, incremental) {
  const f = fixture(source), root = f.root();
  const stream = incremental ? f.createMessageStream(root) : null;
  let text = '';
  for (const chunk of chunks) { text += chunk; if (stream) stream.append(chunk); else f.renderMessage(root, text); }
  stream?.dispose();
  const streaming = { ...f.counts };
  f.renderMessage(root, text);
  return { chunks: chunks.length, finalCharacters: text.length, streaming, includingFinalRender: { ...f.counts } };
}
export const formattedChunks = Array.from({ length: 100 }, (_, i) => `## Section ${i}\n\nParagraph **bold** and [safe](https://example.test) 😀.\n\n- first\n- second\n\n\x60\x60\x60js\nconst n = ${i};\n\x60\x60\x60\n\n`);
export function probe(beforeOnly = false) {
  const before = fs.readFileSync(beforePath, 'utf8');
  if (hash(before) !== '9c756d4893099f0c9f2066422a9ff1b8db0bbba7b19136578e5b94aadd467830') throw new Error('Renderer probe requires the pinned baseline');
  const after = fs.readFileSync(rendererPath, 'utf8');
  const cases = {
    formatted: formattedChunks.flatMap(chunk => chunk.match(/[\s\S]{1,17}/g)),
    singleBlock: Array.from({ length: 100 }, () => '- synthetic streaming line\n'),
    plainParagraph: Array.from({ length: 300 }, () => 'Ordinary Unicode text é😀 with no opener. '),
  };
  return { scope: 'Deterministic synthetic DOM and parser-input counts only. No CPU, RSS, layout, browser, network or PC access.', sourceHashes: { before: hash(before), after: hash(after) }, cases: Object.fromEntries(Object.entries(cases).map(([name, chunks]) => [name, { before: workload(before, chunks, false), ...(!beforeOnly && after.includes('export function createMessageStream') ? { after: workload(after, chunks, true) } : {}) }])) };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(probe(process.argv.includes('--before')), null, 2));
