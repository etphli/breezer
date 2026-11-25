import test from 'node:test';
import assert from 'node:assert/strict';
import { createSpaceSwipe, SWIPE_IDLE_MS } from '../../features/ai/extension/space-swipe.js';

// Feeds [x, y] pairs a frame apart and returns the space steps.
function run(events, { swipe = createSpaceSwipe(), from = 0, every = 8 } = {}) {
  let now = from;
  const results = events.map(([x, y]) => swipe.feed(x, y, now += every));
  return { swipe, now, results, steps: results.map(r => r.step).filter(Boolean) };
}
const flick = [2, 6, 14, 24, 30, 28].map(x => [x, 1]);
const momentum = Array.from({ length: 90 }, (_, i) => [Math.max(1, Math.round(27 * 0.95 ** i)), 0]);

test('a flick and all its momentum switch one space', () => {
  assert.deepEqual(run([...flick, ...momentum]).steps, [1]);
  assert.deepEqual(run([...flick, ...momentum].map(([x, y]) => [-x, y])).steps, [-1]);
});

test('a second swipe works while the first one is still coasting', () => {
  assert.deepEqual(run([...flick, ...momentum.slice(0, 45), ...flick, ...momentum]).steps, [1, 1]);
  assert.deepEqual(run([...flick, ...momentum.slice(0, 45), ...flick.map(([x, y]) => [-x, y])]).steps, [1, -1]);
});

test('uneven momentum and a mouse tilt wheel do not repeat the switch', () => {
  const uneven = momentum.map(([x], i) => [Math.max(1, x + (i % 3) - 1), i % 2]);
  assert.deepEqual(run([...flick, ...uneven]).steps, [1]);
  assert.deepEqual(run([[120, 0], [120, 0], [120, 0]], { every: 60 }).steps, [1]);
  const { swipe, now } = run([[120, 0]]);
  assert.deepEqual(run([[120, 0]], { swipe, from: now + SWIPE_IDLE_MS + 1 }).steps, [1]);
});

test('vertical scrolling stays vertical', () => {
  const scroll = Array.from({ length: 60 }, (_, i) => [i % 5 - 2, 20]);
  const result = run(scroll);
  assert.deepEqual(result.steps, []);
  assert.ok(result.results.every(r => !r.horizontal && r.offset === 0));
  assert.deepEqual(run([[10, 90], [100, 1]]).steps, [], 'one stray event cannot switch');
});

test('a swipe is recognised during vertical momentum, and a scroll after a swipe', () => {
  const coasting = Array.from({ length: 20 }, () => [0, 4]);
  assert.deepEqual(run([...coasting, ...flick, ...flick]).steps, [1]);
  const { results, steps } = run([...flick, ...Array.from({ length: 8 }, () => [1, 20])]);
  assert.deepEqual(steps, [1]);
  assert.equal(results.at(-1).horizontal, false);
});

test('the list follows the fingers until the space switches', () => {
  const { results } = run(flick);
  assert.equal(results[0].horizontal, true, 'the first event already belongs to the swipe');
  assert.ok(results[2].offset < 0 && results[2].offset > -12);
  assert.equal(results.find(r => r.step).offset, 0);
});
