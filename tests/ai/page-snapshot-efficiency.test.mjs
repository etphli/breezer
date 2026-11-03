import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const source = await readFile(new URL('../../features/ai/extension/page-context.js', import.meta.url), 'utf8');
const oldLoop = `    const candidates = new Set([...(editorRoot ? [editorRoot] : []), ...document.querySelectorAll('a[href],button,input,textarea,select,canvas,[role="button"],[role="link"],[contenteditable="true"],[tabindex]')]);
    for (const el of candidates) {
      if (elements.length >= 180) break;`;
const newLoop = `    const candidates = document.querySelectorAll('a[href],button,input,textarea,select,canvas,[role="button"],[role="link"],[contenteditable="true"],[tabindex]');
    for (let index = editorRoot ? -1 : 0; index < candidates.length && elements.length < 180; index++) {
      const el = index < 0 ? editorRoot : candidates[index];
      if (index >= 0 && el === editorRoot) continue;`;
assert.ok(source.includes(oldLoop) || source.includes(newLoop), 'snapshot loop must have a known baseline');
const baseline = source.includes(newLoop) ? source.replace(newLoop, oldLoop) : source;

function run(code, { count = 10000, docs = false, editorAt = -1, editorValid = true, rootOutside = false, exclusions = false } = {}) {
  let reads = 0, styles = 0, serial = 0;
  const rect = { x: 1, y: 1, left: 1, top: 1, bottom: 11, right: 11, width: 10, height: 10 };
  const nodes = Array.from({ length: count }, (_, index) => ({
    id: `control-${index}`, tagName: 'BUTTON', innerText: `Action ${index}`, isConnected: true,
    hidden: exclusions && index < 50, secret: exclusions && index >= 50 && index < 100,
    overlay: exclusions && index >= 100 && index < 150,
    getBoundingClientRect() { return this.hidden ? { ...rect, width: 0 } : rect; },
    getAttribute(name) { return name === 'name' && this.secret ? 'password' : null; },
    querySelector() { return this.isEditor && editorValid ? {} : null; },
    matches(selector) { return selector === '.kix-appview-editor' && this.isEditor; },
    closest(selector) { return selector === '[data-breezer-ai]' ? this.overlay ? this : null : selector === '.kix-appview-editor' ? this.isEditor ? this : this.editor || null : null; },
  }));
  const editor = rootOutside ? { ...nodes[0], id: 'editor' } : nodes[editorAt];
  if (editor) {
    editor.isEditor = true;
    if (nodes[editorAt + 1]) nodes[editorAt + 1].editor = editor;
  }
  const candidates = new Proxy(nodes, { get(target, key, receiver) {
    if (typeof key === 'string' && /^\d+$/.test(key)) reads++;
    return Reflect.get(target, key, receiver);
  } });
  const location = docs ? { origin: 'https://docs.google.com', pathname: '/document/d/fixture/edit', href: 'https://docs.google.com/document/d/fixture/edit' }
    : { origin: 'https://fixture.invalid', pathname: '/', href: 'https://fixture.invalid/' };
  const context = vm.createContext({
    crypto: { randomUUID: () => `fixture-${++serial}` }, location, WeakRef,
    document: { title: 'Fixture', body: {}, querySelector: () => editor, querySelectorAll: () => candidates,
      createTreeWalker: () => ({ nextNode: () => false }) },
    NodeFilter: { SHOW_TEXT: 4 }, innerWidth: 1000, innerHeight: 1000,
    getComputedStyle() { styles++; return { display: 'block', visibility: 'visible', opacity: '1' }; },
  });
  vm.runInContext(code.replace('export function pageContext', 'function pageContext'), context);
  const snapshot = vm.runInContext("pageContext('snapshot')", context);
  for (const item of snapshot.elements) assert.ok(context.__breezerAIContext.targets.get(item.id).deref());
  return { snapshot: JSON.parse(JSON.stringify(snapshot)), reads, styles };
}

test('large snapshot avoids eager candidate copies and stops after 180 successful targets', () => {
  const before = run(baseline), after = run(source);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.equal(before.reads, 10000);
  assert.equal(after.reads, 180);
  assert.equal(after.styles, before.styles);
  assert.equal(after.snapshot.elements.length, 180);
});

for (const options of [
  { count: 0 }, { count: 1 }, { count: 179 }, { count: 180 }, { count: 181 },
  { count: 1000, exclusions: true },
  { count: 300, docs: true, editorAt: 210 },
  { count: 300, docs: true, editorAt: 0 },
  { count: 300, docs: true, rootOutside: true },
  { count: 300, docs: true, editorAt: 20, editorValid: false },
  { count: 300, docs: false, editorAt: 20 },
]) test(`snapshot ordering and filtering match baseline ${JSON.stringify(options)}`, () => {
  const before = run(baseline, options), after = run(source, options);
  assert.deepEqual(after.snapshot, before.snapshot);
  assert.equal(after.styles, before.styles);
  if (options.docs && (options.editorAt >= 0 || options.rootOutside) && options.editorValid !== false) {
    assert.equal(after.snapshot.elements[0].type, 'canvas-editor');
    assert.equal(after.snapshot.elements.filter(item => item.type === 'canvas-editor').length, 1);
  }
});
