import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { harness } from './workspace-activation-harness.mjs';

// Exercise the shipped keyed reconciler with observable node and timer effects.
// This fixture has no layout or animation engine; packaged motion is a separate gate.
const path = process.env.SIDEBAR_MOTION_SOURCE || new URL('../../features/ai/extension/workspace.js', import.meta.url);
const source = await readFile(path, 'utf8');
const start = source.indexOf('function reconcile(container, items) {');
const end = source.indexOf('\nfunction rowNode()', start);
assert.ok(start >= 0 && end > start, 'production reconcile extraction');

function fixture({ width = 240, visibility = 'visible', reduced = false, drawn = true, instant = false } = {}) {
  const trace = [], timers = [];
  class Node {
    constructor(key) {
      this.dataset = {}; this.children = []; this.parent = null; this.attrs = {}; this.classes = new Set();
      this.classList = { contains: value => this.classes.has(value),
        add: value => { trace.push(['add', key, value]); this.classes.add(value); },
        remove: value => { trace.push(['remove-class', key, value]); this.classes.delete(value); } };
    }
    setAttribute(key, value) { this.attrs[key] = value; trace.push(['attr', this.dataset.key, key, value]); }
    remove() { if (this.parent) { this.parent.children.splice(this.parent.children.indexOf(this), 1); this.parent = null; } }
    insertBefore(node, next) { node.remove(); this.children.splice(next ? this.children.indexOf(next) : this.children.length, 0, node); node.parent = this; }
    get firstChild() { return this.children[0] || null; }
    get nextSibling() { return this.parent?.children[this.parent.children.indexOf(this) + 1] || null; }
  }
  const context = vm.createContext({ state: { drawn, instant }, reducedMotion: { matches: reduced }, innerWidth: width,
    document: { visibilityState: visibility }, setTimeout(fn, delay) { timers.push({ fn, delay }); return timers.length; } });
  vm.runInContext(source.slice(start, end) + '\nglobalThis.run = reconcile;', context);
  const container = new Node('container');
  const item = (key, kind = 'today', update = () => {}) => ({ key, kind, create: () => new Node(key), update });
  return { context, container, item, trace, timers, run: items => context.run(container, items),
    keys: () => container.children.map(node => node.dataset.key) };
}

for (const options of [{ width: 0 }, { visibility: 'hidden' }, { width: 0, visibility: 'hidden' }]) {
  test(`unseen rows reconcile immediately ${JSON.stringify(options)}`, () => {
    const h = fixture(options);
    h.run([h.item('a'), h.item('b')]);
    const b = h.container.children[1];
    assert.equal(h.trace.filter(entry => entry[2] === 'entering').length, 0, 'unseen entrances must not animate');
    h.run([h.item('b')]);
    assert.deepEqual(h.keys(), ['b'], 'unseen exits must remove the node now');
    assert.strictEqual(h.container.children[0], b);
    assert.equal(h.timers.length, 0, 'unseen exits must not schedule removal');
  });
  test(`unseen removal has no leaving row or timer ${JSON.stringify(options)}`, () => {
    const h = fixture({ ...options, drawn: false }); h.run([h.item('a')]); h.context.state.drawn = true;
    const a = h.container.children[0]; h.run([]);
    assert.equal(h.timers.length, 0, 'unseen exits must not schedule removal');
    assert.equal(a.parent, null, 'unseen exits must detach now');
    assert.deepEqual(h.keys(), []);
  });
}

test('visible entrance, exit, inert accessibility and 140 ms removal retain their contract', () => {
  const h = fixture();
  h.run([h.item('a'), h.item('b')]);
  assert.deepEqual(h.trace, [['add', 'a', 'entering'], ['add', 'b', 'entering']]);
  const a = h.container.children[0], b = h.container.children[1];
  h.run([h.item('b')]);
  assert.deepEqual(h.keys(), ['b', 'a']);
  assert.strictEqual(h.container.children[0], b);
  assert.equal(a.inert, true); assert.equal(a.attrs['aria-hidden'], 'true');
  assert.deepEqual(h.trace.slice(2), [['add', 'a', 'leaving'], ['attr', 'a', 'aria-hidden', 'true']]);
  assert.deepEqual(h.timers.map(timer => timer.delay), [140]);
  h.timers[0].fn(); assert.deepEqual(h.keys(), ['b']);
});

for (const options of [{ reduced: true }, { drawn: false }, { instant: true }]) {
  test(`existing instant path retains immediate reconciliation ${JSON.stringify(options)}`, () => {
    const h = fixture(options); h.run([h.item('a')]); h.run([]);
    assert.deepEqual(h.trace, []); assert.deepEqual(h.keys(), []); assert.equal(h.timers.length, 0);
  });
}

test('visible reorder preserves keyed nodes and the focus held by their update callbacks', () => {
  const h = fixture(); h.run([h.item('a'), h.item('b'), h.item('c')]);
  const original = [...h.container.children]; original[0].focused = true;
  h.trace.length = 0;
  h.run([h.item('c'), h.item('a'), h.item('b')]);
  assert.deepEqual(h.container.children, [original[2], original[0], original[1]]);
  assert.equal(h.container.children[1].focused, true); assert.deepEqual(h.trace, []); assert.equal(h.timers.length, 0);
});

test('hide and reveal retain current nodes; new visible rows still animate', () => {
  const h = fixture({ width: 0 }); h.run([h.item('hidden')]);
  const retained = h.container.children[0];
  h.context.innerWidth = 240; h.run([h.item('hidden'), h.item('visible')]);
  assert.strictEqual(h.container.children[0], retained);
  assert.deepEqual(h.trace, [['add', 'visible', 'entering']]);
  h.context.document.visibilityState = 'hidden'; h.run([h.item('hidden')]);
  assert.deepEqual(h.keys(), ['hidden']); assert.equal(h.timers.length, 0);
});

test('hidden reconciliation clears an earlier visible entrance before reveal', () => {
  const h = fixture(); h.run([h.item('a')]); const retained = h.container.children[0];
  assert.equal(retained.classList.contains('entering'), true);
  h.context.document.visibilityState = 'hidden'; h.run([h.item('a')]);
  assert.equal(retained.classList.contains('entering'), false);
  h.context.document.visibilityState = 'visible'; h.run([h.item('a')]);
  assert.strictEqual(h.container.children[0], retained);
  assert.equal(retained.classList.contains('entering'), false);
  assert.equal(h.timers.length, 0);
});

test('a hide during visible removal prunes the leaving node; its old callback cannot remove a replacement', () => {
  const h = fixture(); h.run([h.item('a')]); const old = h.container.children[0]; h.run([]);
  assert.equal(h.timers.length, 1);
  h.context.innerWidth = 0; h.run([h.item('a')]);
  assert.deepEqual(h.keys(), ['a']); assert.notStrictEqual(h.container.children[0], old);
  h.timers[0].fn(); assert.deepEqual(h.keys(), ['a']);
});

test('visible interrupted removal keeps the leaving node inert and a replacement independent', () => {
  const h = fixture(); h.run([h.item('a')]); const old = h.container.children[0]; h.run([]); h.run([h.item('a')]);
  assert.equal(h.container.children.length, 2); assert.equal(old.inert, true);
  assert.notStrictEqual(h.container.children[0], old);
  h.timers[0].fn(); assert.deepEqual(h.keys(), ['a']);
});

test('favorites, folders and nested children share instant reconciliation without changing order or keys', () => {
  const h = fixture({ width: 0 });
  const children = fixture({ width: 0 });
  h.run([h.item('f:1', 'favorite'), h.item('folder:2', 'folder', () => children.run([children.item('e:3', 'saved')]))]);
  h.run([h.item('folder:2', 'folder', () => children.run([]))]);
  assert.deepEqual(h.keys(), ['folder:2']); assert.deepEqual(children.keys(), []);
  assert.deepEqual(h.trace, []); assert.deepEqual(children.trace, []);
  assert.equal(h.timers.length + children.timers.length, 0);
});

for (const options of [{ width: 0 }, { visibility: 'hidden' }, { width: 240 }]) {
  test(`complete production create/close path respects viewport ${JSON.stringify(options)}`, async () => {
    const h = await harness(source, undefined, { ...options, reduced: false });
    const unseen = options.width === 0 || options.visibility === 'hidden';
    h.create({ id: 99, windowId: 7, index: 8, active: false, pinned: false, status: 'loading', url: 'about:blank', title: '' });
    h.flushFrames();
    const created = h.nodes.get('today').children.find(node => node.dataset.key === 't:99');
    assert.ok(created); assert.equal(created.classList.contains('entering'), !unseen);
    h.browserTabs.splice(h.browserTabs.findIndex(tab => tab.id === 99), 1);
    h.onRemoved(99, { windowId: 7, isWindowClosing: false }); h.flushFrames();
    assert.equal(h.timerDelays().includes(140), !unseen);
    assert.equal(created.parent === null, unseen);
    if (!unseen) { assert.equal(created.inert, true); await h.timers(140); assert.equal(created.parent, null); }
  });
}

