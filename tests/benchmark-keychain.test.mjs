import test from 'node:test';
import assert from 'node:assert/strict';
import { commonFlags, comparisonPlan } from '../script/benchmark_browsers.mjs';

test('all benchmark launches use the test keychain without disabling browser features', () => {
  assert.ok(commonFlags.includes('--use-mock-keychain'));
  assert.equal(commonFlags.some(flag => /^--(?:disable-extensions|disable-component-extensions|disable-features)/.test(flag)), false);
});

test('credential-isolated results cannot be pooled under the historical protocol label', () => {
  const plan = comparisonPlan({ trials: 6, initializedProfiles: true, baselineBreezer: '/baseline', physicalFootprint: true });
  assert.equal(plan.protocol, 'installed-browser-v9-initialized-three-way-footprint');
});
