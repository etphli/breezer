import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { MAX_SYNC_BYTES as MAX, validateSyncModel } from '../../features/ai/extension/workspace-sync-model.js';

const NativeTextEncoder = globalThis.TextEncoder;
const encoder = new NativeTextEncoder();
const size = model => encoder.encode(JSON.stringify(model)).length;
const limitError = 'Workspace sync has reached its storage limit. Local data is preserved.';
const sourceUrl = new URL('../../features/ai/extension/workspace-sync-model.js', import.meta.url);
const source = await readFile(sourceUrl, 'utf8');
// Restore only the old size guard in the actual source. All schema checks remain
// source-bound; this reference has no dependency on ignored build receipts.
const guardStart = source.indexOf('\n', source.indexOf("throw new Error('Unsupported workspace sync data.');")) + 1;
const guardEnd = source.indexOf('  const records = Object.entries(model.records);', guardStart);
assert.ok(guardStart > 0 && guardEnd > guardStart);
const originalGuard = `  if (new TextEncoder().encode(JSON.stringify(model)).length > MAX_SYNC_BYTES) throw new Error('${limitError}');\n`;
const referenceSource = (source.slice(0, guardStart) + originalGuard + source.slice(guardEnd))
  .replace("'./workspace-store.js'", JSON.stringify(new URL('./workspace-store.js', sourceUrl).href));
const { validateSyncModel: reference } = await import(`data:text/javascript;base64,${Buffer.from(referenceSource).toString('base64')}`);

const reg = value => [1, 'client_alpha', value];
function model(text = 'Title') {
  return { version: 1, records: {
    'space/space1': { alive: reg(true), name: reg('Space'), tone: reg('mint'), index: reg(0) },
    'entry/entry1': { alive: reg(true), url: reg('https://example.test/'), title: reg(text), parent: reg('space/space1'), index: reg(0) },
  } };
}
// The baseline accepts extra top-level metadata. Padding lives there, never in
// a register whose field limits it would violate. All records are valid/clocked.
function padded(units, token = 'x') {
  const value = { ...model(), padding: '' };
  const count = units - JSON.stringify(value).length;
  assert.ok(count >= 0);
  const tokenUnits = JSON.stringify(token).length - 2;
  value.padding = token.repeat(Math.floor(count / tokenUnits));
  value.padding += 'x'.repeat(units - JSON.stringify(value).length);
  assert.equal(JSON.stringify(value).length, units);
  return value;
}
function outcome(validate, value) {
  try { return { result: validate(value) }; }
  catch (error) { return { error: [error.constructor, error.message] }; }
}
function compare(value) {
  const before = JSON.stringify(value);
  const expected = outcome(reference, value);
  const actual = outcome(validateSyncModel, value);
  assert.deepEqual(actual.error, expected.error);
  if (!expected.error) assert.equal(actual.result, value);
  assert.equal(JSON.stringify(value), before, 'validator must not mutate input');
  return actual;
}
// Synchronous, finally-restored instrumentation; no asynchronous work runs while
// the global is replaced. Node's default file isolation keeps other suites apart.
function counted(validate, value) {
  const previous = globalThis.TextEncoder;
  const work = { constructors: 0, calls: 0, bytes: 0 };
  globalThis.TextEncoder = class extends NativeTextEncoder {
    constructor() { super(); work.constructors += 1; }
    encode(input) { const bytes = super.encode(input); work.calls += 1; work.bytes += bytes.length; return bytes; }
  };
  try { return { ...outcome(validate, value), work }; }
  finally { globalThis.TextEncoder = previous; }
}

test('native reference sizes preserve floor(MAX/3), 1 MiB and one-over boundaries', () => {
  for (const units of [Math.floor(MAX / 3) - 1, Math.floor(MAX / 3), Math.floor(MAX / 3) + 1, MAX - 1, MAX, MAX + 1]) {
    const value = padded(units);
    assert.equal(size(value), units);
    const actual = compare(value);
    if (units > MAX) assert.equal(actual.error[1], limitError);
    else assert.equal(actual.result, value);
  }
});

test('short and clearly oversized models avoid encoders; ambiguous cases retain native byte arrays', t => {
  const measurements = [];
  for (const [label, value, calls] of [
    ['short valid', model(), 0],
    ['upper bound fits', padded(Math.floor(MAX / 3)), 0],
    ['just ambiguous', padded(Math.floor(MAX / 3) + 1), 1],
    ['exact limit', padded(MAX), 1],
    ['lower bound exceeds limit', padded(MAX + 1), 0],
    ['multibyte oversized in ambiguous range', padded(Math.floor(MAX / 3) + 1000, '界'), 1],
  ]) {
    const old = counted(reference, value), actual = counted(validateSyncModel, value);
    assert.equal(old.work.calls, 1);
    assert.equal(old.work.bytes, size(value));
    t.diagnostic(JSON.stringify({ label, units: JSON.stringify(value).length, nativeBytes: size(value), baseline: old.work, candidate: actual.work }));
    assert.deepEqual(actual.error, old.error, label);
    measurements.push({ label, actual, calls, bytes: size(value) });
  }
  for (const { label, actual, calls, bytes } of measurements) {
    assert.equal(actual.work.calls, calls, label);
    assert.equal(actual.work.constructors, calls, label);
    assert.equal(actual.work.bytes, calls ? bytes : 0, label);
  }
});

test('ASCII, two/three/four-byte text, escapes and surrogate spellings agree with native encoding', () => {
  const tokens = ['x', 'é', '界', '😀', '\ud83d\ude00', '\ud800', '\udc00', '\\ud800', '\\ud83d\\ude00', '"\\\n\t\u0000', 'xé界😀\ud800'];
  assert.equal(encoder.encode('😀').length, 4);
  assert.equal('😀'.length, 2);
  assert.equal(encoder.encode('\ud800').length, 3);
  assert.equal(JSON.stringify('\ud800'), '"\\ud800"');
  for (const token of tokens) {
    compare(model(token));
    for (const units of [Math.floor(MAX / 3), Math.floor(MAX / 3) + 1, MAX]) {
      const value = padded(units, token);
      const actual = compare(value);
      assert.equal(Boolean(actual.error), size(value) > MAX);
    }
  }
  // Deterministic mixed UTF-16 code units, including unpaired surrogates.
  let seed = 0x12345678;
  for (let trial = 0; trial < 60; trial += 1) {
    let text = '';
    for (let i = 0; i < 180; i += 1) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      text += String.fromCharCode(seed & 0xffff);
    }
    compare(model(text));
    const value = { ...model(), padding: text.repeat(trial % 3 === 0 ? 2400 : 8) };
    const actual = compare(value);
    assert.equal(Boolean(actual.error), size(value) > MAX);
  }
});

test('Unicode and escaped padding preserve exact native byte limits', () => {
  for (const token of ['x', 'é', '界', '😀', '\ud800', '\udc00', '\\ud83d\\ude00', '"\\\n', 'xé界😀']) {
    for (const target of [MAX - 1, MAX, MAX + 1]) {
      const value = { ...model(), padding: '' };
      const remaining = target - size(value);
      const tokenBytes = encoder.encode(JSON.stringify(token)).length - 2;
      value.padding = token.repeat(Math.floor(remaining / tokenBytes));
      value.padding += 'x'.repeat(target - size(value));
      assert.equal(size(value), target);
      const actual = compare(value);
      assert.equal(Boolean(actual.error), target > MAX);
      if (actual.error) assert.equal(actual.error[1], limitError);
    }
  }
  function freeze(value) {
    if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); }
    return value;
  }
  const frozen = freeze(model('界😀'));
  assert.equal(validateSyncModel(frozen), frozen);
});

test('all schema checks, clocks, identities and size-before-field precedence remain source-bound', () => {
  const cases = [null, undefined, false, {}, { version: 2, records: {} }, { version: 1, records: [] },
    { version: 1, records: null }, { version: 1, records: {} },
    { version: 1, records: Object.fromEntries(Array.from({ length: 12001 }, (_, i) => [`entry/e${i}`, {}])) }];
  for (const records of [
    { invalid: {} }, { 'entry/a': null }, { 'entry/a': [] },
    { 'entry/a': Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`f${i}`, reg(1)])) },
    { preferences: {} }, { 'appearance/theme': {} }, { 'appearance/showBookmarks': { appearance: reg(true) } },
    { 'entry/a': {} }, { 'entry/a': { alive: reg(true) } },
    { 'space/entry1': model().records['space/space1'], 'entry/entry1': model().records['entry/entry1'] },
  ]) cases.push({ version: 1, records });
  for (const register of [null, [], [1, 'client_alpha'], [0, 'client_alpha', true], [-1, 'client_alpha', true],
    [1.5, 'client_alpha', true], [Number.MAX_SAFE_INTEGER + 1, 'client_alpha', true], [1, 'bad', true], reg('true')]) {
    cases.push({ version: 1, records: { 'entry/a': { alive: register } } });
  }
  for (const [field, value] of [['unknown', 'x'], ['url', 'invalid'], ['title', 'x'.repeat(201)], ['parent', 'bad'], ['index', -1]]) {
    const bad = model(); bad.records['entry/entry1'][field] = reg(value); cases.push(bad);
  }
  for (const value of cases) compare(value);
  for (const units of [Math.floor(MAX / 3), MAX, MAX + 1]) {
    const bad = padded(units); bad.records['entry/entry1'].title[0] = 0;
    assert.equal(compare(bad).error[1], units > MAX ? limitError : 'Invalid workspace sync field.');
  }
  const unsupported = { version: 2, records: {}, padding: 'x'.repeat(MAX + 1), toJSON() { throw new Error('must not stringify'); } };
  assert.equal(counted(validateSyncModel, unsupported).error[1], 'Unsupported workspace sync data.');
  assert.deepEqual(outcome(validateSyncModel, unsupported).error, outcome(reference, unsupported).error);
});

test('circular, BigInt, toJSON and thrown serialization behavior remain compatible', () => {
  for (const kind of ['circular', 'bigint', 'undefined', 'null', 'string', 'throw']) {
    function fixture() {
      const value = model(); let calls = 0;
      if (kind === 'circular') value.self = value;
      if (kind === 'bigint') value.extra = 1n;
      if (['undefined', 'null', 'string', 'throw'].includes(kind)) value.toJSON = () => {
        calls += 1;
        if (kind === 'throw') throw new RangeError('serialization failed');
        return kind === 'undefined' ? undefined : kind === 'null' ? null : '界'.repeat(MAX / 2);
      };
      return { value, calls: () => calls };
    }
    const left = fixture(), right = fixture();
    const expected = outcome(reference, left.value), actual = outcome(validateSyncModel, right.value);
    assert.deepEqual(actual.error, expected.error, kind);
    if (!expected.error) assert.equal(actual.result, right.value);
    assert.equal(right.calls(), left.calls());
    assert.equal(right.calls(), ['circular', 'bigint'].includes(kind) ? 0 : 1);
  }
  const undefinedJSON = model(); undefinedJSON.toJSON = () => undefined;
  assert.equal(encoder.encode(JSON.stringify(undefinedJSON)).length, 0);
  assert.equal(validateSyncModel(undefinedJSON), undefinedJSON);
  undefinedJSON.records['entry/entry1'].title[0] = 0;
  assert.deepEqual(outcome(validateSyncModel, undefinedJSON).error, outcome(reference, undefinedJSON).error);
});
