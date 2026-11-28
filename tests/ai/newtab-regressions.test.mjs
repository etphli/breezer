import test from 'node:test';
import assert from 'node:assert/strict';
import { chatDay, fitsAddressText, installAddressSuggestions } from '../../features/ai/extension/newtab.js';

test('a saved chat from a week ago shows its date, not this week’s weekday', () => {
  const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).getTime();
  const now = at(28, 20); // Saturday 28 Nov, 8pm
  const monthDay = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short' });
  const weekday = new Intl.DateTimeFormat(undefined, { weekday: 'long' });
  assert.equal(chatDay(at(28, 9), now), 'Today');
  assert.equal(chatDay(at(27, 23, 30), now), 'Yesterday');
  assert.equal(chatDay(at(23, 12), now), weekday.format(at(23, 12)));
  for (const day of [22, 21]) assert.equal(chatDay(at(day, 23, 30), now), monthDay.format(at(day, 23, 30)));
  assert.notEqual(chatDay(at(21, 23, 30), now), weekday.format(now), 'last Saturday is not labelled as today’s weekday');
});

test('address text is limited by UTF-8 bytes like the browser', () => {
  assert.equal(fitsAddressText('a'.repeat(8192)), true);
  assert.equal(fitsAddressText('a'.repeat(8193)), false);
  assert.equal(fitsAddressText('漢'.repeat(2730) + 'ab'), true, '8192 bytes');
  assert.equal(fitsAddressText('漢'.repeat(2731)), false, '8193 bytes in 2731 UTF-16 units');
  assert.equal(fitsAddressText('😀'.repeat(2048)), true);
  assert.equal(fitsAddressText('😀'.repeat(2048) + 'a'), false);
});

function addressBox() {
  const listeners = {};
  const input = {
    value: '', selectionStart: 0, selectionEnd: 0,
    addEventListener(type, fn) { listeners[type] = fn; },
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; },
    setAttribute() {}, removeAttribute() {},
  };
  const list = { hidden: true, children: [], replaceChildren() {} };
  const queries = [];
  const api = { breezerPrivate: {
    // Mirrors omnibox_api.cc: text over kMaxInputBytes is refused.
    async queryOmnibox({ text }) {
      queries.push(text);
      if (Buffer.byteLength(text, 'utf8') > 8192) throw new Error('Invalid omnibox input.');
      return { revision: 1, done: true, matches: [] };
    },
    async openOmnibox() {},
  } };
  installAddressSuggestions({ api, root: {}, input, list, isActive: () => true, onOpen() {} });
  const type = (text) => { input.value = text; input.selectionStart = input.selectionEnd = text.length; listeners.input({ isComposing: false, inputType: 'insertText' }); };
  return { type, queries };
}

test('suggestions never ask the browser with text it would refuse', () => {
  const box = addressBox();
  box.type('漢'.repeat(3000)); // 3000 UTF-16 units, 9000 UTF-8 bytes
  assert.deepEqual(box.queries, []);
  box.type('漢'.repeat(2730) + 'ab');
  assert.equal(box.queries.length, 1);
  assert.equal(Buffer.byteLength(box.queries[0], 'utf8'), 8192);
});
