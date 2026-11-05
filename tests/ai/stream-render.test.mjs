import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { fixture, tree, workload, formattedChunks, rendererPath, beforePath, hash } from '../../script/verify_stream_render_efficiency.mjs';

const source = fs.readFileSync(rendererPath, 'utf8');
const oldSource = fs.readFileSync(beforePath, 'utf8');

function differential(text, sizes) {
  const old = fixture(oldSource), next = fixture(source);
  const expected = old.root(), actual = next.root(), stream = next.createMessageStream(actual);
  let end = 0, chunk = 0;
  while (end < text.length) {
    const start = end;
    end = Math.min(text.length, end + sizes[chunk++ % sizes.length]);
    stream.append(text.slice(start, end));
    old.renderMessage(expected, text.slice(0, end));
    assert.deepEqual(tree(actual), tree(expected), `prefix ${end}: ${JSON.stringify(text.slice(0, end))}`);
  }
  stream.dispose();
  next.renderMessage(actual, text);
  assert.deepEqual(tree(actual), tree(expected));
}

test('every visible UTF-16 prefix matches the full safe parser across block and inline boundaries', () => {
  const cases = [
    '**bold** `code` [safe](https://example.test/a?q=1) [bad](javascript:alert(1))\n\nnext',
    '**open\ncontinued**\n\n`open\ncode`\n\n[split\nlabel](https://a.test)',
    '# Heading\n#### Four\n##### Plain\n> quote **ok**\n>next\n\n- one\n* two\n1. three\n2. four\n\nend',
    'paragraph\ncontinued\n- list\nplain\n- separate list\n\n\n',
    '```js\nopen\n\n# code\n- code\n```suffix\n\n# outside\n\n',
    'before\n  ```\n\n```\n```\n\nunterminated 😀\n\n',
    '\n\n\t\n\r\n\u00a0\n\u2028\n\ufeff\nUnicode 😀 é 中\r\n\r\n**x**',
    '<img src=x onerror=alert(1)>\n\n[link](HTTP://invalid.test)\n\n[link](https://a.test/"x)\n\n',
    '``\n\n`\n\n***\n\n>\n\n1.\n\n-\n\n',
  ];
  for (const text of cases) for (const sizes of [[1], [2, 7, 1, 13], [19, 3]]) differential(text, sizes);
});

test('deterministic malformed block combinations match at every chunk', () => {
  let seed = 4021;
  const tokens = ['abc', '**x', '**', '`', '[a](https://b.test)', '\n', '\n\n', '```', '> ', '- ', '1. ', '# ', '\r', '\t', '😀'];
  for (let run = 0; run < 60; run++) {
    let text = '';
    for (let i = 0; i < 35; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += tokens[seed % tokens.length]; }
    differential(text, [1, 3, 7]);
  }
});

test('the long formatted response matches at each streaming chunk boundary', () => {
  differential(formattedChunks.join(''), [17]);
});

test('committed nodes stay attached; disposing releases the renderer and prevents further DOM writes', () => {
  const f = fixture(source), root = f.root(), stream = f.createMessageStream(root);
  stream.append('first **bold**\n\nsecond');
  const committed = root.childNodes[0];
  stream.append(' `code`\n\nthird');
  assert.equal(root.childNodes[0], committed);
  const before = tree(root);
  stream.dispose(); stream.dispose(); stream.append('ignored');
  assert.deepEqual(tree(root), before);
  assert.match(source, /container = null;[\s\S]*tail = '';[\s\S]*mutableNodes = \[\];/);
});

test('formatted work decreases and long single-block work remains explicitly unchanged', () => {
  const chunks = formattedChunks.flatMap(chunk => chunk.match(/[\s\S]{1,17}/g));
  const before = workload(oldSource, chunks, false), after = workload(source, chunks, true);
  assert.ok(after.includingFinalRender.nodes < before.includingFinalRender.nodes / 50);
  assert.ok(after.includingFinalRender.parsedCharacters < before.includingFinalRender.parsedCharacters / 50);
  const single = Array.from({ length: 100 }, () => '- synthetic streaming line\n');
  const oldSingle = workload(oldSource, single, false), nextSingle = workload(source, single, true);
  for (const phase of ['streaming', 'includingFinalRender']) {
    for (const count of ['nodes', 'parsedCharacters', 'renders']) assert.equal(nextSingle[phase][count], oldSingle[phase][count]);
  }
  assert.equal(nextSingle.streaming.scannedCharacters, nextSingle.finalCharacters);
  assert.ok(after.streaming.scannedCharacters <= after.finalCharacters);
});

function panelHarness() {
  const f = fixture(source), elements = new Map(), frames = [];
  const get = id => {
    if (!elements.has(id)) {
      const node = f.root();
      Object.assign(node, { scrollTop: 25, scrollHeight: 500, clientHeight: 200, focus() {}, addEventListener(type, fn) { this[type] = fn; } });
      elements.set(id, node);
    }
    return elements.get(id);
  };
  f.document.getElementById = get;
  f.document.body = f.root();
  const context = vm.createContext({ document: f.document, ...f, requestAnimationFrame: fn => frames.push(fn), chrome: {}, ResearchSources: class { clear() {} }, console });
  const panel = fs.readFileSync('features/ai/extension/panel.js', 'utf8').replace(/^import .*;\n/gm, '');
  const newChat = panel.slice(panel.indexOf("$('new-chat').addEventListener"), panel.indexOf("$('model-button').addEventListener"));
  vm.runInContext(panel.slice(0, panel.indexOf("$('composer').addEventListener")) + `
    updateControls = () => {}; saveConversation = () => {}; setControl = () => {};
    post = () => {}; offerRetry = () => { globalThis.retries = (globalThis.retries || 0) + 1; };
    globalThis.api = {state, messageNodes, receive, renderDelta, finish, stop};\n` + newChat, context);
  const api = context.api;
  function start(id) {
    const message = { id: id + '-reply', role: 'assistant', text: '' };
    api.state.messages.push(message);
    const body = f.root();
    const article = f.root(); article.append(body); body.parentElement = article;
    api.messageNodes.set(message.id, body);
    api.state.running = { id, assistantId: message.id, message };
    return message;
  }
  return { ...api, f, get, frames, context, start, flush() { while (frames.length) frames.shift()(); } };
}

test('panel keeps RAF coalescing, immediate prefix output and both scroll decisions', () => {
  const h = panelHarness(), msg = h.start('one');
  h.receive({ type: 'delta', id: 'one', text: 'first\n\n' });
  h.receive({ type: 'delta', id: 'one', text: '**second' });
  assert.equal(h.frames.length, 1);
  assert.equal(h.messageNodes.get(msg.id).childNodes.length, 0);
  h.flush();
  const expected = h.f.root(); h.f.renderMessage(expected, msg.text);
  assert.deepEqual(tree(h.messageNodes.get(msg.id)), tree(expected));
  assert.equal(h.get('conversation').scrollTop, 25, 'reader away from bottom stays put');
  h.get('conversation').scrollTop = 290;
  h.receive({ type: 'delta', id: 'one', text: '**' }); h.flush();
  assert.equal(h.get('conversation').scrollTop, 500, 'bottom-following reader still follows');
});

test('complete, stop, error and New Chat dispose streams and retain final full output', () => {
  for (const ending of ['complete', 'stop', 'error', 'new-chat']) {
    const h = panelHarness(), msg = h.start('one');
    h.receive({ type: 'delta', id: 'one', text: 'first\n\n**tail' }); h.flush();
    const run = h.state.running, renderer = run.renderer, body = h.messageNodes.get(msg.id);
    h.receive({ type: 'delta', id: 'one', text: '**' });
    if (ending === 'stop') h.stop();
    else if (ending === 'new-chat') h.get('new-chat').click();
    else h.receive({ type: ending, id: 'one', error: 'fixture error' });
    assert.equal(run.renderer, null);
    assert.equal(h.state.running, null);
    const expected = h.f.root(); h.f.renderMessage(expected, msg.text);
    assert.deepEqual(tree(body), tree(expected));
    renderer.append('late');
    h.flush();
    assert.deepEqual(tree(body), tree(expected), 'queued RAF cannot modify finished reply');
    if (ending === 'new-chat') { assert.equal(h.state.messages.length, 0); assert.equal(h.messageNodes.size, 0); }
    if (ending === 'error') assert.equal(h.context.retries, 1);
  }
});

test('the full renderer remains byte-for-byte the pinned baseline', () => {
  assert.equal(hash(oldSource), '9c756d4893099f0c9f2066422a9ff1b8db0bbba7b19136578e5b94aadd467830');
  assert.equal(source.slice(0, oldSource.length), oldSource);
});

test('standalone probe rejects an altered baseline before reporting counts', () => {
  const probeSource = fs.readFileSync(new URL('../../script/verify_stream_render_efficiency.mjs', import.meta.url), 'utf8');
  const context = vm.createContext({
    fs: { readFileSync: path => path === beforePath ? `${oldSource}\n` : source },
    crypto, vm, process: { argv: [] },
  });
  vm.runInContext(probeSource.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
    .replaceAll('import.meta.url', '"fixture"') + '\nglobalThis.probeFixture = probe;', context);
  assert.throws(() => context.probeFixture(), /pinned baseline/);
});

test('empty replies, empty deltas and a queued RAF crossing into a new run keep existing behavior', () => {
  for (const ending of ['complete', 'stop', 'error']) {
    const h = panelHarness(), msg = h.start('empty');
    h.receive({ type: 'delta', id: 'empty', text: '' }); h.flush();
    if (ending === 'stop') h.stop();
    else h.receive({ type: ending, id: 'empty', error: 'fixture error' });
    assert.equal(h.state.running, null);
    assert.ok(msg.text);
    const expected = h.f.root(); h.f.renderMessage(expected, msg.text);
    assert.deepEqual(tree(h.messageNodes.get(msg.id)), tree(expected));
    if (ending !== 'complete') assert.equal(h.context.retries, 1);
  }
  const h = panelHarness(); h.start('old');
  h.receive({ type: 'delta', id: 'old', text: 'old reply' });
  h.get('new-chat').click();
  const next = h.start('next');
  h.receive({ type: 'delta', id: 'old', text: 'stale' });
  h.receive({ type: 'delta', id: 'next', text: 'new reply' });
  assert.equal(h.frames.length, 1);
  h.flush();
  const expected = h.f.root(); h.f.renderMessage(expected, next.text);
  assert.deepEqual(tree(h.messageNodes.get(next.id)), tree(expected));
  assert.equal(next.text, 'new reply');
  h.finish();
});


test('plain tail keeps its Text until fallback, resets after a boundary, and stops after disposal', () => {
  const f = fixture(source), oracle = fixture(oldSource), root = f.root(), expected = oracle.root();
  const stream = f.createMessageStream(root);
  let text = '';
  const append = delta => {
    text += delta; stream.append(delta); oracle.renderMessage(expected, text);
    assert.deepEqual(tree(root), tree(expected));
  };
  append('Ordinary');
  const paragraph = root.lastChild, firstText = paragraph.lastChild;
  append(' plain text'); append('');
  assert.equal(root.lastChild, paragraph);
  assert.equal(root.lastChild.lastChild, firstText);
  const retiredText = firstText.textContent;
  append(' **bo');
  assert.notEqual(root.lastChild, paragraph);
  append('ld**');
  const fallback = root.lastChild;
  append(' ordinary suffix');
  assert.notEqual(root.lastChild, fallback, 'ambiguity keeps the existing parser path until a boundary');
  append('\n\nFresh');
  const committed = root.childNodes[0], freshText = root.lastChild.lastChild;
  append(' plain tail'); append('');
  assert.equal(root.childNodes[0], committed);
  assert.equal(root.lastChild.lastChild, freshText);
  assert.equal(firstText.textContent, retiredText);
  const final = tree(root);
  stream.dispose(); stream.dispose(); stream.append('late text');
  assert.deepEqual(tree(root), final);
});

test('generated whitespace, control and partial-opener prefixes preserve the full-render tree', () => {
  const whitespace = Array.from({ length: 0x10000 }, (_, unit) => String.fromCharCode(unit)).filter(value => /\s/u.test(value));
  const starts = [...whitespace, '\0', '\u0085', '\u200b', '\u200c', '\u200d', '\u2060', '\ud800', '\udfff', '😀', '#', '####', '-', '1.', '>', '`', '**', '['];
  for (const start of starts) for (const sizes of [[1], [3, 1, 7]]) {
    differential(`${start}Ordinary text\ud83d\ude00 **later** [safe](https://a.test)\n\nFresh\n\n`, sizes);
  }
});

test('one delta can commit multiple blocks and seed a fresh tail without duplication', () => {
  const f = fixture(source), oracle = fixture(oldSource), root = f.root(), expected = oracle.root();
  const stream = f.createMessageStream(root);
  let text = '';
  const append = delta => {
    text += delta; stream.append(delta); oracle.renderMessage(expected, text);
    assert.deepEqual(tree(root), tree(expected));
  };
  append('First plain');
  append(' tail\n\nSecond plain\n\nThird');
  const committed = root.childNodes[0], thirdText = root.lastChild.lastChild;
  append(' remains');
  assert.equal(root.childNodes[0], committed);
  assert.equal(root.lastChild.lastChild, thirdText);
  for (const delta of ['\n\n``', '`js\nliteral\n``', '`\n', '\nFourth', ' tail']) append(delta);
  assert.equal(root.childNodes[0], committed);
  const fourthText = root.lastChild.lastChild;
  append(' remains');
  assert.equal(root.lastChild.lastChild, fourthText);
  stream.dispose();
});

test('plain streams avoid repeated parser/node work while ambiguous single blocks retain it', () => {
  const chunks = Array.from({ length: 300 }, () => 'Ordinary Unicode text é😀 with no opener. ');
  const result = workload(source, chunks, true);
  assert.equal(result.streaming.nodes, 2);
  assert.equal(result.streaming.renders, 1);
  assert.equal(result.streaming.parsedCharacters, chunks[0].length);
  assert.equal(result.includingFinalRender.parsedCharacters, chunks[0].length + result.finalCharacters);
  for (const first of [' ', '1.', '- ']) {
    const fallback = [first, ...Array.from({ length: 40 }, () => '**mutable** text ')];
    const current = workload(source, fallback, true), baseline = workload(oldSource, fallback, false);
    for (const key of ['nodes', 'renders', 'parsedCharacters']) assert.equal(current.streaming[key], baseline.streaming[key]);
  }
});
