import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { fixture, tree, rendererPath, beforePath, hash } from '../../script/verify_stream_render_efficiency.mjs';

const source = fs.readFileSync(rendererPath, 'utf8');
const oracleSource = fs.readFileSync(beforePath, 'utf8');

// Visual replies extend the whole-message parser only. Undo that layer while
// the older fence benchmark continues to compare the pinned parser byte-for-byte.
const sourceWithoutWidgets = source
  .replace('renderMessage(container, text, renderWidget)', 'renderMessage(container, text)')
  .replace('  let widgets = 0;\n', '')
  .replace(
    /      const body = \[\];\n(      while \(\+\+index[^\n]*\n)[\s\S]*?      code\.textContent = source;\n/,
    "      const code = document.createElement('code');\n" +
    "      const pre = document.createElement('pre');\n" +
    "      const body = [];\n$1      code.textContent = body.join('\\n');\n",
  );

const sourceWithoutTables = sourceWithoutWidgets
  .replace('    let columns;\n', '')
  .replace(`    } else if (!paragraph.length && (columns = tableColumns(line, lines[index + 1]))) {
      flush();
      index = appendTable(container, lines, index, columns);
`, '')
  .replace(/function tableCells\(line\) \{[\s\S]*?(?=function inline\()/, '');

// Undo only this port's code Text reuse to reconstruct the real main stream.
const provenance = JSON.parse(fs.readFileSync(new URL('./fixtures/host-main-port/provenance.json', import.meta.url)));
const mainStreamSource = sourceWithoutTables
  .replace('  let codeText = null;\n', '')
  .replaceAll('      codeText = null;\n', '')
  .replace(`      // The opener is complete and the current code line has no backticks.
      // A possible closing fence must rebuild, including its preceding newline.
      if (codeText && !delta.includes('\x60')) {
        codeText.appendData(delta);
        return;
      }
`, '')
  .replace(`      if (fenced && !tail.includes('\x60', lineStart)) {
        codeText = mutableNodes.at(-1).lastChild.lastChild;
      }
`, '');
assert.equal(hash(mainStreamSource), provenance.currentMainOracles['features/ai/extension/render-message.js'], 'inverse must reconstruct pinned current main, including its stream parser');

// Observe the DOM operations actually made by the renderer, including removals
// through the forwarding target. No elapsed-time or browser measurements.
function countedFixture(code = source) {
  const f = fixture(code), root = f.root();
  const counts = { topLevelRemovals: 0, replacements: 0, textAppends: 0 };
  const prototype = Object.getPrototypeOf(root);
  const remove = prototype.remove, replaceChildren = prototype.replaceChildren, appendData = prototype.appendData;
  prototype.remove = function () {
    if (this.parentNode === root) counts.topLevelRemovals++;
    return remove.call(this);
  };
  prototype.replaceChildren = function (...nodes) {
    counts.replacements++;
    return replaceChildren.apply(this, nodes);
  };
  prototype.appendData = function (text) {
    counts.textAppends++;
    return appendData.call(this, text);
  };
  for (const property of ['innerHTML', 'outerHTML']) {
    Object.defineProperty(prototype, property, { set() { assert.fail(`Unsafe ${property} write`); } });
  }
  f.document.write = () => assert.fail('Unsafe document.write');
  return { ...f, root, operations: () => ({ ...f.counts, ...counts }) };
}

function differential(chunks) {
  const f = countedFixture(), oracle = fixture(oracleSource), expected = oracle.root();
  const stream = f.createMessageStream(f.root);
  let text = '';
  for (const delta of chunks) {
    text += delta;
    stream.append(delta);
    oracle.renderMessage(expected, text);
    assert.deepEqual(tree(f.root), tree(expected), `prefix ${text.length}: ${JSON.stringify(text)}`);
  }
  const streamed = tree(f.root);
  stream.dispose(); stream.dispose(); stream.append('ignored after disposal');
  assert.deepEqual(tree(f.root), streamed);
  f.renderMessage(f.root, text);
  assert.deepEqual(tree(f.root), tree(expected), 'authoritative final full render');
}

function split(text, sizes) {
  const chunks = [];
  for (let offset = 0, i = 0; offset < text.length; i++) {
    const end = Math.min(text.length, offset + sizes[i % sizes.length]);
    chunks.push(text.slice(offset, end)); offset = end;
  }
  return chunks;
}

test('full renderer outside table handling remains byte-identical to the pinned oracle', () => {
  assert.equal(hash(oracleSource), '9c756d4893099f0c9f2066422a9ff1b8db0bbba7b19136578e5b94aadd467830');
  assert.equal(sourceWithoutTables.slice(0, oracleSource.length), oracleSource);
});

test('every UTF-16 prefix matches full rendering for fence, newline and literal-content edges', () => {
  const cases = [
    '```', '```js', '```js\n', '```js\n\n', '```js\n```', '```js\n\n```\n',
    '```js\nconst n = 1;\n\n\n```textafter\noutside',
    'before **bold**\n\n  ```js\n  indented\n\t\n\t ```suffix\n\n# after',
    '```language `opener`\nbody\n`\n``\n  ```\n',
    '\\```js\nplain\n\n```js\n\\```escaped\n\\`literal\n```\n',
    '```\r\nline\r\n\r\n  ```\r\ntextafter\r\n',
    '```js\rnot-an-LF\nbody\r\n  \r\t``\n\r```suffix\n',
    '```html\n<img src=x onerror=alert(1)>\n<script>alert(1)</script>\n&copy; **literal** [bad](javascript:alert(1))\n```\n\n[safe](https://a.test) [bad](javascript:alert(1))',
    '```\n😀é中\ud800\udfff\0\n```\n\n```rust\nnext 😀\n```\n\nend',
    '```\nbody\n```\n```\n\n```\n\n```\nlast\n',
    'before\n```\nbody\n```suffix\ntextafter\n\n```other\nnext\n```\n# end',
  ];
  for (const text of cases) for (const sizes of [[1], [2, 7, 1, 13], [31, 3]]) {
    differential(split(text, sizes));
  }
  // Use the parser's actual ECMAScript whitespace set, including non-LF line
  // separators. These characters are significant code text until a fence closes.
  const whitespace = Array.from({ length: 0x10000 }, (_, unit) => String.fromCharCode(unit)).filter(value => /\s/u.test(value));
  for (const space of whitespace) {
    differential(split(`${space}\`\`\`js\nbody\n${space}\`\`\`after\n\nend`, [1]));
  }
});

test('all two-chunk splits and deterministic mixed chunks match the full renderer', () => {
  const samples = ['```js\nA\n\n``', '```js\nA\n  ```after\nend', '```\r\n😀\r\n```\r\n', '```\nA\n\\```\n```\n\n```\nB'];
  for (const text of samples) for (let end = 0; end <= text.length; end++) {
    differential([text.slice(0, end), '', text.slice(end), '']);
  }
  let seed = 94721;
  const tokens = ['abc', '\n', '\n\n', '```', '`', '``', '\\```', '\r', '\t', '😀', '\ud800', '<b>', '  ', '**', '[x](https://a.test)'];
  for (let run = 0; run < 50; run++) {
    let text = '```js\nseed';
    for (let i = 0; i < 35; i++) { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; text += tokens[seed % tokens.length]; }
    differential(split(text, [1]));
    differential(split(text, [3, 1, 11]));
  }
});

test('an established open fence reuses its pre, code and Text for literal appends', () => {
  const f = countedFixture(), oracle = fixture(oracleSource), expected = oracle.root();
  const stream = f.createMessageStream(f.root);
  let text = '';
  const append = delta => {
    text += delta; stream.append(delta); oracle.renderMessage(expected, text);
    assert.deepEqual(tree(f.root), tree(expected));
  };
  append('```js\nfirst');
  const pre = f.root.lastChild, code = pre.lastChild, node = code.lastChild;
  const before = f.operations();
  for (const delta of [' line', '\n', '\n\r', '\n  ', '<img onerror=evil()>', '\ud83d', '\ude00', '']) {
    append(delta);
    assert.equal(f.root.lastChild, pre);
    assert.equal(pre.lastChild, code);
    assert.equal(code.lastChild, node);
  }
  const after = f.operations();
  for (const key of ['nodes', 'renders', 'parsedCharacters', 'topLevelRemovals', 'replacements']) assert.equal(after[key], before[key], key);
  assert.ok(after.textAppends > before.textAppends);
  stream.dispose();
});

test('backticks rebuild ambiguous lines and preserve newline removal on a split close', () => {
  const f = countedFixture(), oracle = fixture(oracleSource), expected = oracle.root();
  const stream = f.createMessageStream(f.root);
  let text = '';
  const append = delta => {
    text += delta; stream.append(delta); oracle.renderMessage(expected, text);
    assert.deepEqual(tree(f.root), tree(expected), JSON.stringify(text));
  };
  append('```js\nbody\n');
  const first = f.root.lastChild;
  append('  `'); assert.notEqual(f.root.lastChild, first);
  const partial = f.root.lastChild;
  append('`'); assert.notEqual(f.root.lastChild, partial);
  append('`');
  assert.equal(f.root.lastChild.textContent, 'body', 'closing line and preceding newline disappear');
  append('textafter\noutside');
  assert.equal(f.root.lastChild.localName, 'p');
  assert.equal(f.root.lastChild.textContent, 'outside');
  stream.dispose();
});

test('a literal backtick line falls back until its newline, then the next line can append', () => {
  const f = countedFixture(), stream = f.createMessageStream(f.root);
  stream.append('```js\nliteral `');
  const ambiguous = f.root.lastChild;
  stream.append('tail');
  assert.notEqual(f.root.lastChild, ambiguous);
  stream.append('\nnext');
  const resumed = f.root.lastChild, node = resumed.lastChild.lastChild;
  stream.append(' text');
  assert.equal(f.root.lastChild, resumed);
  assert.equal(resumed.lastChild.lastChild, node);
  const oracle = fixture(oracleSource), expected = oracle.root();
  oracle.renderMessage(expected, '```js\nliteral `tail\nnext text');
  assert.deepEqual(tree(f.root), tree(expected));
  stream.dispose();
});

test('opener metadata and empty code blocks cannot seed an incorrect text append', () => {
  differential(['```ja', 'vascript', '\n', '', 'a', '\n', '```suffix', '\n\n', '```', '\n', '```', '\n']);
  const f = countedFixture(), stream = f.createMessageStream(f.root);
  stream.append('```js\n');
  assert.equal(f.root.lastChild.lastChild.lastChild, null, 'empty code has no Text node');
  stream.append('first');
  const pre = f.root.lastChild, node = pre.lastChild.lastChild;
  stream.append(' body');
  assert.equal(f.root.lastChild, pre);
  assert.equal(pre.lastChild.lastChild, node);
  assert.equal(node.textContent, 'first body');
  stream.dispose();
});

test('committing multiple blocks and disposal retire code node references', () => {
  const f = countedFixture(), oracle = fixture(oracleSource), expected = oracle.root();
  const stream = f.createMessageStream(f.root);
  let text = '';
  const append = delta => {
    text += delta; stream.append(delta); oracle.renderMessage(expected, text);
    assert.deepEqual(tree(f.root), tree(expected));
  };
  append('before\n\n```js\nfirst');
  const committed = f.root.childNodes[0], retired = f.root.lastChild.lastChild.lastChild;
  append(' tail\n```\n\nMiddle\n\n```other\nnext');
  const retiredText = retired.textContent, nextPre = f.root.lastChild;
  append(' tail');
  assert.equal(f.root.childNodes[0], committed);
  assert.equal(f.root.lastChild, nextPre);
  assert.equal(retired.textContent, retiredText);
  const before = tree(f.root), counts = f.operations();
  stream.dispose(); stream.dispose(); stream.append('late');
  assert.deepEqual(tree(f.root), before);
  assert.deepEqual(f.operations(), counts, 'disposed renderer makes no DOM writes');
  f.renderMessage(f.root, text);
  const final = tree(f.root);
  stream.append('later');
  assert.deepEqual(tree(f.root), final, 'full final render is authoritative');
  // Disposal must clear the extra Text reference as well as the existing tail.
  assert.match(source.slice(source.indexOf('dispose()')), /codeText = null;/);
});

test('panel completion, stop, error and New Chat preserve open-fence finalization with a queued RAF', () => {
  // Same offline panel setup as stream-render.test.mjs. Only fake DOM and APIs.
  const panel = fs.readFileSync('features/ai/extension/panel.js', 'utf8').replace(/^import .*;\n/gm, '');
  for (const ending of ['complete', 'stop', 'error', 'new-chat']) {
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
    const context = vm.createContext({ document: f.document, ...f, requestAnimationFrame: fn => frames.push(fn), chrome: {}, renderReplyWidget: () => null, ResearchSources: class { clear() {} }, console });
    const newChat = panel.slice(panel.indexOf("$('new-chat').addEventListener"), panel.indexOf("$('model-button').addEventListener"));
    vm.runInContext(panel.slice(0, panel.indexOf("$('composer').addEventListener")) + `
      updateControls = () => {}; saveConversation = () => {}; setControl = () => {};
      post = () => {}; offerRetry = () => {};
      globalThis.api = {state, messageNodes, receive, stop};\n` + newChat, context);
    const api = context.api, message = { id: 'reply', role: 'assistant', text: '' }, body = f.root();
    api.state.messages.push(message); api.messageNodes.set(message.id, body);
    // Main appends each message body inside an article. Error details use it.
    const article = f.root(); article.append(body); body.parentElement = article;
    const run = api.state.running = { id: 'run', assistantId: message.id, message };
    api.receive({ type: 'delta', id: 'run', text: '```js\nseed' });
    frames.shift()();
    const renderer = run.renderer, pre = body.lastChild;
    get('conversation').scrollTop = 290;
    api.receive({ type: 'delta', id: 'run', text: '\nmore' });
    frames.shift()();
    assert.equal(body.lastChild, pre, 'active panel uses the fence append path');
    assert.equal(get('conversation').scrollTop, 500, 'bottom-following still applies');
    api.receive({ type: 'delta', id: 'run', text: '\n```suffix\ntextafter' });
    assert.equal(frames.length, 1);
    if (ending === 'stop') api.stop();
    else if (ending === 'new-chat') get('new-chat').click();
    else api.receive({ type: ending, id: 'run', error: 'fixture error' });
    assert.equal(api.state.running, null);
    assert.equal(run.renderer, null);
    assert.equal(run.message, null);
    const oracle = fixture(oracleSource), expected = oracle.root();
    oracle.renderMessage(expected, message.text);
    assert.deepEqual(tree(body), tree(expected), 'finish renders pending text without waiting for RAF');
    renderer.append('late');
    while (frames.length) frames.shift()();
    assert.deepEqual(tree(body), tree(expected));
    if (ending === 'new-chat') { assert.equal(api.state.messages.length, 0); assert.equal(api.messageNodes.size, 0); }
  }
});

function workload(code, chunks) {
  const f = countedFixture(code), stream = f.createMessageStream(f.root);
  let text = '';
  for (const delta of chunks) { text += delta; stream.append(delta); }
  const streaming = f.operations();
  stream.dispose(); f.renderMessage(f.root, text);
  const oracle = fixture(oracleSource), expected = oracle.root();
  oracle.renderMessage(expected, text);
  assert.deepEqual(tree(f.root), tree(expected));
  return { chunks: chunks.length, finalCharacters: text.length, streaming, includingFinalRender: f.operations() };
}

test('open code streams allocate once; ambiguous tails remain full-render negative controls', t => {
  const chunks = ['```js\nseed', ...Array.from({ length: 80 }, (_, i) => `\nconst n${i} = "é😀";`)];
  const result = workload(source, chunks);
  const main = workload(mainStreamSource, chunks);
  assert.equal(main.streaming.renders, chunks.length, 'current main rebuilds each open-code tail');
  assert.equal(main.streaming.nodes, 3 * chunks.length);
  assert.equal(main.streaming.textAppends, 0);
  assert.throws(() => assert.equal(main.streaming.renders, 1), 'main is a negative control for code reuse');
  t.diagnostic(JSON.stringify({ openFence: result }));
  assert.equal(result.streaming.nodes, 3);
  assert.equal(result.streaming.renders, 1);
  assert.equal(result.streaming.parsedCharacters, chunks[0].length);
  assert.equal(result.streaming.topLevelRemovals, 0);
  assert.equal(result.streaming.textAppends, 80);
  assert.equal(result.includingFinalRender.nodes, 6);
  assert.equal(result.includingFinalRender.renders, 2);
  assert.equal(result.includingFinalRender.topLevelRemovals, 1);
  assert.equal(result.includingFinalRender.parsedCharacters, chunks[0].length + result.finalCharacters);
  const fallback = ['```js\nseed`', ...Array.from({ length: 25 }, () => '`literal`')];
  const control = workload(source, fallback);
  t.diagnostic(JSON.stringify({ backtickControl: control }));
  assert.equal(control.streaming.renders, fallback.length);
  assert.equal(control.streaming.nodes, 3 * fallback.length);
  assert.equal(control.streaming.topLevelRemovals, fallback.length - 1);
  assert.equal(control.streaming.textAppends, 0);
  const plain = workload(source, ['ordinary', ' text']);
  assert.equal(plain.streaming.nodes, 2, 'existing plain-text append path still works');
});
