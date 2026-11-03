import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../features/ai/extension/translation-content.js', import.meta.url), 'utf8');
// An optional captured source permits differential checks against the actual pre-edit file.
const before = process.env.TRANSLATION_WORK_BEFORE
  ? readFileSync(process.env.TRANSLATION_WORK_BEFORE, 'utf8')
  : source.replace('if ((record && node.data === record.translated) || !allowed(node)) continue;',
    'if (!allowed(node) || (record && node.data === record.translated)) continue;');
const event = () => {
  const listeners = new Set();
  return { addListener: f => listeners.add(f), removeListener: f => listeners.delete(f),
    fire: m => { for (const f of [...listeners]) f(m); }, listeners };
};

function fixture(code, count = 1) {
  const nodes = [], messages = [], timers = new Map(), intervals = new Map(), hooks = new Map(), references = [];
  const counts = { rects: 0, styles: 0, derefs: 0 };
  let serial = 0, observer, observing = false, automatic = true;
  const root = { index: -1 }, location = { href: 'https://fixture.invalid/' }, onConnect = event();
  function append(data = 'a', options = {}) {
    const node = { index: nodes.length, data, isConnected: true, visible: true, excluded: false,
      previousSibling: nodes.at(-1) || null, parentNode: root, ...options };
    node.parentElement = { node, closest: () => node.excluded ? {} : null,
      getClientRects: () => { counts.rects++; return node.visible ? [1] : []; } };
    nodes.push(node); return node;
  }
  for (let i = 0; i < count; i++) append();
  const port = { name: 'breezer-translation-page', onMessage: event(), onDisconnect: event(),
    disconnect() { this.onDisconnect.fire(); }, postMessage(m) {
      messages.push(JSON.parse(JSON.stringify(m)));
      if (automatic && m.type === 'batch') queueMicrotask(() => this.onMessage.fire({ id: m.id, texts: m.texts.map(t => 'T' + t) }));
    } };
  vm.runInNewContext(code, {
    chrome: { runtime: { onConnect } }, location,
    document: { body: root, documentElement: root, contentType: 'text/html', createTreeWalker() {
      return { currentNode: root, nextNode() {
        for (let i = this.currentNode.index + 1; i < nodes.length; i++) {
          if (nodes[i].isConnected) return this.currentNode = nodes[i];
        }
        return null;
      } };
    } }, NodeFilter: { SHOW_TEXT: 4 },
    getComputedStyle: parent => { counts.styles++; return { visibility: parent.node.visibility || 'visible' }; },
    // Controllable weak-reference results simulate collection; this does not measure real GC.
    WeakRef: class { constructor(node) { this.value = node; references.push(this); }
      deref() { counts.derefs++; return this.value; } },
    MutationObserver: class { constructor(cb) { observer = cb; } observe() { observing = true; } disconnect() { observing = false; } },
    setTimeout: f => { timers.set(++serial, f); return serial; }, clearTimeout: id => timers.delete(id),
    setInterval: f => { intervals.set(++serial, f); return serial; }, clearInterval: id => intervals.delete(id),
    addEventListener: (name, f) => hooks.set(name, f), crypto: { randomUUID: () => String(++serial) },
  });
  onConnect.fire(port);
  const settle = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
  async function step() {
    await settle();
    const entry = timers.entries().next().value;
    if (entry) { timers.delete(entry[0]); entry[1](); }
    await settle();
  }
  async function drain() {
    for (let i = 0; i < 2000; i++) { await settle(); if (!timers.size) return; await step(); }
    throw new Error('Fixture did not settle');
  }
  return { nodes, messages, counts, references, append, step, drain, port, timers, location,
    start: (dynamic = true) => port.onMessage.fire({ type: 'start', dynamic }),
    command: type => port.onMessage.fire({ type }),
    mutate: () => { if (observing) observer([{ type: 'attributes', attributeName: 'class', target: root }]); },
    manual: () => { automatic = false; },
    reply(error, texts) { const m = messages.findLast(m => m.type === 'batch');
      port.onMessage.fire({ id: m.id, ...(error ? { error } : { texts: texts || m.texts.map(t => 'T' + t) }) }); },
    navigate() { location.href += 'next'; for (const f of intervals.values()) f(); },
    pagehide: () => hooks.get('pagehide')(),
    snapshot: () => ({ text: nodes.map(n => n.data), messages, listeners: port.onMessage.listeners.size, timers: timers.size }),
  };
}

async function differential(scenario, count = 1) {
  const old = fixture(before, count), current = fixture(source, count);
  await scenario(old); await scenario(current);
  assert.deepEqual(current.snapshot(), old.snapshot());
  return current;
}

test('unchanged translated nodes skip visibility reads; changed, hidden and excluded text still uses eligibility checks', async () => {
  const h = fixture(source, 64); h.start(); await h.drain();
  const initial = { ...h.counts }, batches = h.messages.filter(m => m.type === 'batch').length;
  h.mutate(); await h.drain();
  assert.equal(h.counts.rects, initial.rects); assert.equal(h.counts.styles, initial.styles);
  assert.equal(h.messages.filter(m => m.type === 'batch').length, batches);
  h.nodes[0].data = 'changed'; h.nodes[0].visible = false;
  h.nodes[1].data = 'secret'; h.nodes[1].excluded = true;
  h.mutate(); await h.drain();
  assert.ok(h.counts.rects > initial.rects);
  assert.equal(h.nodes[0].data, 'changed'); assert.equal(h.nodes[1].data, 'secret');
  h.nodes[0].visible = true; h.mutate(); await h.drain();
  assert.equal(h.nodes[0].data, 'Tchanged');
  assert.ok(!h.messages.filter(m => m.type === 'batch').flatMap(m => m.texts).includes('secret'));
  h.command('restore'); assert.equal(h.nodes[0].data, 'changed'); assert.equal(h.nodes[1].data, 'secret');
});

test('dynamic insertion, reveals, exclusions and site edits match the old implementation', async () => {
  await differential(async h => {
    h.nodes[0].visible = false; h.start(); await h.drain();
    h.nodes[0].visible = true;
    h.append('new'); h.append('private', { excluded: true }); h.append('hidden', { visibility: 'hidden' });
    h.mutate(); await h.drain();
    assert.deepEqual(h.nodes.map(n => n.data), ['Ta', 'Tnew', 'private', 'hidden']);
    h.nodes[0].data = 'site edit'; h.mutate(); await h.drain();
    h.nodes[1].data = 'later edit'; h.command('restore');
    assert.deepEqual(h.nodes.map(n => n.data), ['site edit', 'later edit', 'private', 'hidden']);
  });
});

test('cancel, invalid reply, provider failure, pending site edits and retry match the old implementation', async () => {
  for (const action of ['cancel', 'failure', 'invalid', 'edit', 'restore', 'navigation', 'disconnect', 'pagehide']) {
    await differential(async h => {
      h.manual(); h.start(); await h.step();
      if (action === 'cancel') h.command('cancel');
      if (action === 'restore') h.command('restore');
      if (action === 'navigation') h.navigate();
      if (action === 'disconnect') h.port.disconnect();
      if (action === 'pagehide') h.pagehide();
      if (action === 'edit') h.nodes[0].data = 'site edit';
      h.reply(action === 'failure' ? 'fixture failure' : undefined, action === 'invalid' ? [] : undefined);
      await h.drain();
      assert.equal(h.nodes[0].data, action === 'edit' ? 'site edit' : 'a');
      if (action !== 'disconnect') {
        h.start(); await h.step(); h.reply(); await h.drain();
        assert.equal(h.nodes[0].data, action === 'edit' ? 'Tsite edit' : 'Ta');
        h.command('restore'); assert.equal(h.nodes[0].data, action === 'edit' ? 'site edit' : 'a');
      }
    });
  }
});

test('detach/reattach before a scan retains Restore, but detachment across a scan prunes the record', async () => {
  for (const scanWhileDetached of [false, true]) {
    await differential(async h => {
      h.start(); await h.step(); assert.equal(h.nodes[0].data, 'Ta');
      h.nodes[0].isConnected = false;
      if (scanWhileDetached) await h.step();
      h.nodes[0].isConnected = true;
      h.command('restore');
      assert.equal(h.nodes[0].data, scanWhileDetached ? 'Ta' : 'a');
    }, 96);
  }
});

test('collected weak refs are removed while connected originals remain restorable', async () => {
  await differential(async h => {
    h.start(); await h.step();
    h.nodes[0].isConnected = false; h.references[0].value = undefined;
    await h.drain();
    h.nodes[1].data = 'site edit'; h.command('restore');
    assert.equal(h.nodes[1].data, 'site edit'); assert.equal(h.nodes[2].data, 'a');
  }, 96);
});

test('long Unicode chunks, input bounds and output limit behavior match the old implementation', async () => {
  await differential(async h => {
    h.nodes[0].data = 'abc😀 '.repeat(1600);
    h.append('x'.repeat(100001)); h.append('12345');
    h.start(false); await h.drain();
    for (const m of h.messages.filter(m => m.type === 'batch')) {
      assert.ok(m.texts.length <= 32 && m.texts.reduce((n, t) => n + t.length, 0) <= 4000);
      assert.ok(m.texts.every(t => !/[\uD800-\uDBFF]$/u.test(t)));
    }
    assert.equal(h.nodes[1].data.length, 100001); assert.equal(h.nodes[2].data, '12345');
    h.command('restore'); assert.equal(h.nodes[0].data, 'abc😀 '.repeat(1600));
  });
  await differential(async h => {
    h.manual(); h.start(); await h.step(); h.reply(undefined, ['z'.repeat(4000001)]); await h.drain();
    assert.equal(h.nodes[0].data, 'a');
    assert.ok(h.messages.some(m => m.state === 'error' && m.message.includes('limit')));
  });
});

test('completion-only pruning is rejected because detach/reattach changes Restore', async () => {
  const candidate = source.replace('for (const reference of translatedNodes) {\n      const node = reference.deref();',
    'if (!node) for (const reference of translatedNodes) {\n      const node = reference.deref();');
  assert.notEqual(candidate, source);
  const results = [];
  for (const code of [before, source, candidate]) {
    const h = fixture(code, 96); h.start(); await h.step();
    h.nodes[0].isConnected = false; await h.step();
    h.nodes[0].isConnected = true; h.command('restore'); results.push(h.nodes[0].data);
  }
  assert.deepEqual(results, ['Ta', 'Ta', 'a']);
});

test('privacy and visibility are rechecked before writing an in-flight response', async () => {
  for (const change of ['excluded', 'hidden', 'invisible', 'detached']) {
    await differential(async h => {
      h.manual(); h.start(); await h.step();
      if (change === 'excluded') h.nodes[0].excluded = true;
      if (change === 'hidden') h.nodes[0].visible = false;
      if (change === 'invisible') h.nodes[0].visibility = 'hidden';
      if (change === 'detached') h.nodes[0].isConnected = false;
      h.reply(); await h.drain();
      assert.equal(h.nodes[0].data, 'a');
      h.command('restore'); assert.equal(h.nodes[0].data, 'a');
    });
  }
});

test('mutation reset during a pending batch, cancellation after progress and navigation preserve connected Restore', async () => {
  for (const action of ['cancel', 'navigation', 'pagehide', 'restart']) {
    await differential(async h => {
      h.start(); await h.step(); assert.equal(h.nodes[0].data, 'Ta');
      h.manual(); h.mutate(); await h.step();
      h.append('new'); h.mutate();
      if (action === 'navigation') h.navigate();
      else if (action === 'pagehide') h.pagehide();
      else h.command(action === 'restart' ? 'start' : 'cancel');
      h.reply();
      if (action === 'restart') { await h.step(); h.reply(); }
      // Stop any further batches. A stale response must not overwrite restored text.
      await h.step(); h.command('restore'); await h.drain();
      assert.ok(h.nodes.slice(0, 96).every(n => n.data === 'a'));
      assert.equal(h.nodes.at(-1).data, 'new');
    }, 96);
  }
});
