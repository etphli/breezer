import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createHash } from 'node:crypto';

const source = await readFile(process.env.PAGE_SNAPSHOT_TEXT_SOURCE || new URL('../../features/ai/extension/page-context.js', import.meta.url), 'utf8');
// Use the historical text walk with today's source around it, including target validation.
const mainLoop = await readFile(new URL('./fixtures/host-main-port/page-snapshot-main-loop.txt', import.meta.url), 'utf8');
const provenance = JSON.parse(await readFile(new URL('./fixtures/host-main-port/provenance.json', import.meta.url), 'utf8'));
const mainLoopHash = provenance.fixtures.find(entry => entry.path === 'page-snapshot-main-loop.txt').sha256;
assert.equal(createHash('sha256').update(mainLoop).digest('hex'), mainLoopHash);
const loopStart = source.indexOf('    let lastParent;');
const loopEnd = source.indexOf('    return { url: location.href, title: document.title, text:', loopStart);
assert.ok(loopStart >= 0 && loopEnd > loopStart, 'optimized snapshot loop must be present');
const baseline = process.env.PAGE_SNAPSHOT_TEXT_BASELINE ? await readFile(process.env.PAGE_SNAPSHOT_TEXT_BASELINE, 'utf8')
  : source.slice(0, loopStart) + mainLoop + source.slice(loopEnd);
const plain = value => JSON.parse(JSON.stringify(value));
const whitespace = '\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff';

function element(tagName = 'DIV', attrs = {}, style = {}) {
  return { nodeType: 1, tagName, attrs, style, children: [], parentElement: null, isConnected: true };
}
function text(value, parent) {
  const node = { nodeType: 3, value, parentElement: parent };
  if (parent) parent.children.push(node);
  return node;
}
function append(parent, child) {
  parent.children.push(child);
  child.parentElement = parent;
  return child;
}

// A depth-first SHOW_TEXT walker over a tree, including adjacent Text nodes and
// nodes whose parentElement is null. It never stubs out the production text walk.
function fixture(code, setup, { noBody = false, onVisit } = {}) {
  const counts = { visited: 0, advances: 0, closest: 0, geometry: 0, styles: 0, checkVisibility: 0,
    textReads: 0, probes: [], normalizations: [] };
  const root = element('BODY');
  const candidates = [];
  const details = setup(root, candidates) || {};
  const lineage = function* (el) { for (; el; el = el.parentElement) yield el; };
  const matches = (el, selector) => selector.startsWith('[')
    ? selector === '[aria-hidden="true"]' ? el.attrs['aria-hidden'] === 'true' : Object.hasOwn(el.attrs, selector.slice(1, -1))
    : el.tagName.toLowerCase() === selector;
  const rect = { x: 10, y: 10, left: 10, top: 10, bottom: 30, right: 110, width: 100, height: 20 };
  const nodes = function* (node) {
    for (const child of node.children || []) {
      if (child.nodeType === 3) yield child;
      else yield* nodes(child);
    }
  };
  const decorate = el => {
    el.id = el.attrs.id || '';
    el.innerText = el.attrs.label || '';
    el.getAttribute = name => el.attrs[name] ?? null;
    el.matches = selectors => selectors.split(',').some(selector => {
      if (selector === 'input[type="password"]') return el.tagName === 'INPUT' && el.attrs.type === 'password';
      if (selector === 'input[type="hidden"]') return el.tagName === 'INPUT' && el.attrs.type === 'hidden';
      if (selector.startsWith('[autocomplete')) return /password|cc-|one-time-code/.test(el.attrs.autocomplete || '');
      return matches(el, selector);
    });
    el.closest = selectors => {
      counts.closest++;
      return [...lineage(el)].find(ancestor => selectors.split(',').some(selector => matches(ancestor, selector))) || null;
    };
    el.getBoundingClientRect = () => {
      counts.geometry++;
      return [...lineage(el)].some(ancestor => ancestor.style.display === 'none') || el.style.zero
        ? { ...rect, width: 0 } : rect;
    };
    el.checkVisibility = options => {
      assert.deepEqual(plain(options), { checkOpacity: true, checkVisibilityCSS: true });
      counts.checkVisibility++;
      return ![...lineage(el)].some(ancestor => ancestor.style.opacity === '0' || ancestor.style.contentVisibility === 'hidden');
    };
    for (const child of el.children) {
      if (child.nodeType === 1) decorate(child);
      else Object.defineProperties(child, {
        length: { get() { return child.value.length; } },
        textContent: { get() { counts.textReads++; return child.value; } },
      });
    }
  };
  decorate(root);
  let serial = 0;
  const world = vm.createContext({
    crypto: { randomUUID: () => `fixture-${++serial}` }, WeakRef,
    location: { href: 'https://fixture.invalid/', origin: 'https://fixture.invalid', pathname: '/' },
    innerWidth: 1000, innerHeight: 700, NodeFilter: { SHOW_TEXT: 4 },
    document: { title: 'Text fixture', body: noBody ? null : root, documentElement: root,
      querySelectorAll: () => candidates,
      createTreeWalker(start, mask, filter) {
        assert.equal(start, root);
        assert.equal(mask, 4);
        assert.equal(filter, undefined, 'the walker has no mutation-capable filter callback');
        const iterator = nodes(start);
        return { currentNode: start, nextNode() {
          counts.advances++;
          const { value, done } = iterator.next();
          if (done) return null;
          this.currentNode = value;
          counts.visited++;
          onVisit?.(value, counts.visited, details);
          return value;
        } };
      } },
    getComputedStyle(el) {
      counts.styles++;
      const visibility = [...lineage(el)].find(ancestor => ancestor.style.visibility)?.style.visibility || 'visible';
      return { display: el.style.display || 'block', visibility, opacity: el.style.opacity || '1' };
    },
    recordProbe: length => counts.probes.push(length),
    recordNormalization: length => counts.normalizations.push(length),
  });
  // Observe actual operations without replacing their results or the algorithm.
  vm.runInContext(`
    const originalTest = RegExp.prototype.test;
    RegExp.prototype.test = function(value) {
      if (this.source === '\\\\S') recordProbe(value.length);
      return originalTest.call(this, value);
    };
    const originalReplace = String.prototype.replace;
    String.prototype.replace = function(pattern, replacement) {
      if (pattern.source === '\\\\s+') recordNormalization(this.length);
      return originalReplace.call(this, pattern, replacement);
    };
    ${code.replace('export function pageContext', 'function pageContext')}
  `, world);
  const invoke = (operation, args = {}) => plain(vm.runInContext(`pageContext(${JSON.stringify(operation)},${JSON.stringify(args)})`, world));
  return { snapshot: () => invoke('snapshot'), invoke, counts, root, details, world };
}

function compare(setup, options) {
  const candidate = fixture(source, setup, options);
  const snapshot = candidate.snapshot();
  let before;
  if (baseline) {
    before = fixture(baseline, setup, options);
    assert.deepEqual(snapshot, before.snapshot(), 'entire snapshot equals the pinned pre-edit implementation');
    assert.equal(candidate.counts.visited, before.counts.visited);
    assert.equal(candidate.counts.advances, before.counts.advances);
  }
  return { ...candidate, snapshot, before };
}

test('short whitespace nodes avoid ancestor, style, geometry and normalization work', t => {
  const result = compare(root => {
    for (let index = 0; index < 100; index++) {
      const parent = append(root, element('P'));
      text(whitespace, parent);
      text('', parent);
    }
  });
  assert.equal(result.snapshot.text, '');
  assert.equal(result.counts.visited, 200);
  t.diagnostic(JSON.stringify({ case: 'whitespace', before: result.before?.counts, after: result.counts }));
  for (const name of ['closest', 'styles', 'geometry', 'checkVisibility']) assert.equal(result.counts[name], 0, name);
  assert.deepEqual(result.counts.normalizations, []);
  assert.equal(result.before.counts.closest, 200, 'main loop is a negative control for whitespace work');
  assert.equal(result.before.counts.normalizations.length, 200);
});

test('same-parent runs reuse eligibility and changed parents are rechecked', t => {
  const result = compare(root => {
    for (let index = 0; index < 4; index++) {
      const parent = append(root, element('P'));
      text(' One\t two ', parent);
      text('\n', parent);
      text('three', parent);
      const inline = append(parent, element('SPAN'));
      text(' four ', inline);
      text('five', parent);
    }
  });
  assert.equal(result.snapshot.text, Array(4).fill('One two three four five').join(' '));
  t.diagnostic(JSON.stringify({ case: 'parent-runs', before: result.before?.counts, after: result.counts }));
  for (const name of ['closest', 'styles', 'geometry', 'checkVisibility']) {
    assert.equal(result.counts[name], 12, name);
    assert.equal(result.before.counts[name], 20, 'main rechecks every text node: ' + name);
  }
});

test('a changed parent invalidates the cache even when its text is whitespace', () => {
  const result = compare(root => {
    text('head', root);
    text('\n', append(root, element('SPAN')));
    text('tail', root);
  });
  assert.equal(result.snapshot.text, 'head tail');
  assert.equal(result.counts.closest, 2);
  assert.equal(result.counts.styles, 2);
});

test('the early whitespace scan is bounded to 256 code units', () => {
  const result = compare(root => {
    text(' '.repeat(256), root);
    text(' '.repeat(257), append(root, element('SPAN')));
  });
  assert.equal(result.snapshot.text, '');
  assert.deepEqual(result.counts.probes, [256]);
  assert.deepEqual(result.counts.normalizations, [257]);
  assert.equal(result.counts.closest, 1);
});

test('Unicode whitespace uses exactly the existing normalization semantics', () => {
  const result = compare(root => {
    text(whitespace, root);
    text(`${whitespace}a${whitespace}b${whitespace}`, root);
    for (const value of ['\u0085', '\u180e', '\u200b', '\u200c', '\u200d', '\ud83d\ude00']) text(value, root);
    text(` ${'x'.repeat(255)}`, root);
    text(` ${'y'.repeat(256)}`, root);
  });
  assert.equal(result.snapshot.text, `a b \u0085 \u180e \u200b \u200c \u200d 😀 ${'x'.repeat(255)} ${'y'.repeat(256)}`);
});

test('excluded parents and ancestors never contribute text', t => {
  const result = compare(root => {
    text('visible', root);
    for (const tag of ['SCRIPT', 'STYLE', 'NOSCRIPT', 'INPUT', 'TEXTAREA', 'SELECT']) {
      const parent = append(root, element(tag));
      text('EXCLUDED', parent);
      text('EXCLUDED AGAIN', parent);
    }
    for (const attrs of [{ contenteditable: '' }, { contenteditable: 'false' }, { 'data-breezer-ai': 'control' }, { hidden: '' }, { 'aria-hidden': 'true' }]) {
      const ancestor = append(root, element('DIV', attrs));
      const parent = append(ancestor, element('SPAN'));
      text('SECRET', parent);
      text('SECRET AGAIN', parent);
    }
    text('tail', root);
  });
  assert.equal(result.snapshot.text, 'visible tail');
  t.diagnostic(JSON.stringify({ case: 'excluded-runs', before: result.before?.counts, after: result.counts }));
  assert.equal(result.counts.closest, 13);
  assert.equal(result.counts.styles, 2);
});

test('CSS-hidden ancestors, disconnected and zero-size parents retain visibility filtering', () => {
  const result = compare(root => {
    for (const style of [{ display: 'none' }, { visibility: 'hidden' }, { opacity: '0' }, { contentVisibility: 'hidden' }]) {
      const ancestor = append(root, element('DIV', {}, style));
      const parent = append(ancestor, element('SPAN'));
      text('HIDDEN', parent);
      text('HIDDEN AGAIN', parent);
    }
    const disconnected = append(root, element('DIV'));
    disconnected.isConnected = false;
    text('DISCONNECTED', disconnected);
    text('ZERO SIZE', append(root, element('DIV', {}, { zero: true })));
    text('kept', root);
  });
  assert.equal(result.snapshot.text, 'kept');
});

test('missing parents and documentElement fallback keep walker ordering', () => {
  const result = compare(root => {
    root.children.push(text('ORPHAN', null), text('', null));
    text('head', root);
    text('middle', append(root, element('SPAN')));
    text('tail', root);
  }, { noBody: true });
  assert.equal(result.snapshot.text, 'head middle tail');
  assert.equal(result.counts.visited, 5);
});

test('huge excluded text is never scanned, including all-whitespace and long prefixes', t => {
  const result = compare(root => {
    for (const tag of ['SCRIPT', 'STYLE', 'NOSCRIPT']) {
      const parent = append(root, element(tag));
      text(' '.repeat(131072) + 'excluded', parent);
      text(' '.repeat(131072), parent);
      const child = append(parent, element('SPAN'));
      text(' '.repeat(131072), child);
    }
    text('safe', root);
  });
  t.diagnostic(JSON.stringify({ case: 'huge-excluded', before: result.before?.counts, after: result.counts }));
  assert.equal(result.snapshot.text, 'safe');
  assert.equal(result.counts.textReads, 1, 'long excluded text stays unread');
  assert.deepEqual(result.counts.normalizations, [4]);
  assert.ok(result.counts.probes.every(length => length <= 256));
});

test('long eligible whitespace and whitespace prefixes retain exact output', () => {
  const result = compare(root => {
    text(' '.repeat(257), root);
    text(' '.repeat(32768), root);
    text(' '.repeat(32768) + 'visible\tvalue ', root);
    text('z'.repeat(19000), root);
    text('UNREACHED', root);
  });
  assert.equal(result.snapshot.text, `visible value ${'z'.repeat(19000)}`.slice(0, 18000));
  assert.equal(result.counts.visited, 5, 'nextNode still advances once after the character cap');
});

test('18000-character cap, join spaces and normalization lengths are unchanged', () => {
  for (const values of [
    ['x'.repeat(18000), 'UNREACHED'],
    ['x'.repeat(17999), 'yz', 'UNREACHED'],
    ['x'.repeat(17999) + '😀', 'UNREACHED'],
    ['x'.repeat(17999), ' ', '', 'y', 'UNREACHED'],
    ['x'.repeat(17998), 'y', 'z', 'UNREACHED'],
    [],
  ]) {
    const result = compare(root => { for (const value of values) text(value, root); });
    const expected = values.filter(value => value !== 'UNREACHED').map(value => value.replace(/\s+/g, ' ').trim()).filter(Boolean).join(' ').slice(0, 18000);
    assert.equal(result.snapshot.text, expected);
  }
});

test('whitespace and excluded nodes still consume the 20000-node budget', () => {
  for (const excluded of [false, true]) {
    const result = compare(root => {
      const parent = excluded ? append(root, element('SCRIPT')) : root;
      for (let index = 0; index < 19999; index++) text(excluded ? 'EXCLUDED' : '\n', parent);
      text('kept', root);
      text('UNREACHED', root);
    });
    assert.equal(result.snapshot.text, 'kept');
    assert.equal(result.counts.visited, 20001, 'the existing condition advances past 20000 processed nodes');
    assert.equal(result.counts.advances, 20001);
  }
});

test('successive snapshots recheck eligibility and invalidate old target handles', () => {
  const exercise = code => {
    const run = fixture(code, (root, candidates) => {
      const parent = append(root, element('DIV'));
      text('shared', parent);
      text('text', parent);
      for (const attrs of [{ label: 'Keep' }, { type: 'password', label: 'PASSWORD' }, { name: 'access_token', label: 'TOKEN' }, { type: 'hidden', label: 'HIDDEN' }, { autocomplete: 'cc-number', label: 'CARD' }]) {
        candidates.push(append(root, element(attrs.label === 'Keep' ? 'BUTTON' : 'INPUT', attrs)));
      }
      return { parent };
    });
    const first = run.snapshot();
    assert.equal(first.text, 'shared text');
    assert.deepEqual(first.elements.map(el => el.label), ['Keep']);
    run.details.parent.attrs.hidden = '';
    const second = run.snapshot();
    assert.equal(second.text, '');
    assert.notEqual(first.elements[0].id, second.elements[0].id);
    assert.throws(() => run.invoke('resolve', { elementId: first.elements[0].id }), /changed/);
    delete run.details.parent.attrs.hidden;
    const third = run.snapshot();
    assert.equal(third.text, first.text);
    assert.equal(run.world.__breezerAIContext.targets.size, 1);
    return [first, second, third];
  };
  const after = exercise(source);
  if (baseline) assert.deepEqual(after, exercise(baseline));
});

test('queued DOM mutations run after the synchronous snapshot and are rechecked next time', async () => {
  for (const code of baseline ? [baseline, source] : [source]) {
    let mutated = false;
    const run = fixture(code, root => {
      text('head', root);
      text('tail', root);
    }, { onVisit(node, visited) {
      if (visited === 1) queueMicrotask(() => { node.parentElement.attrs.hidden = ''; mutated = true; });
    } });
    assert.equal(run.snapshot().text, 'head tail');
    assert.equal(mutated, false);
    await Promise.resolve();
    assert.equal(mutated, true);
    assert.equal(run.snapshot().text, '');
  }
});


test('the text-walk inverse uses the pinned loop with the current page controls', () => {
  if (process.env.PAGE_SNAPSHOT_TEXT_BASELINE) {
    assert.equal(createHash('sha256').update(baseline).digest('hex'), provenance.currentMainOracles['features/ai/extension/page-context.js']);
    return;
  }
  const historicalLoopEnd = loopStart + mainLoop.length;
  assert.equal(createHash('sha256').update(baseline.slice(loopStart, historicalLoopEnd)).digest('hex'), mainLoopHash);
  assert.equal(baseline.slice(0, loopStart), source.slice(0, loopStart));
  assert.equal(baseline.slice(historicalLoopEnd), source.slice(loopEnd));
});
