// Activity days are local calendar days. Each case runs in a child process so
// the time zone is fixed before any Date is made.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const moduleUrl = new URL('../../features/ai/extension/context-memory.js', import.meta.url).href;

const script = `
const { ContextMemory, CONTEXT_KEY } = await import(${JSON.stringify(moduleUrl)});
const [initial, times] = JSON.parse(process.argv[1]);
const data = initial ? { [CONTEXT_KEY]: initial } : {};
const storage = { async get(k) { return k in data ? { [k]: structuredClone(data[k]) } : {}; }, async set(v) { Object.assign(data, structuredClone(v)); } };
const at = ([y, m, d, h, min = 0]) => new Date(y, m - 1, d, h, min).getTime();
let now = at(times[0]);
const memory = new ContextMemory(storage, { now: () => now });
if (!initial) await memory.configure({ enabled: true, sites: ['docs.example.org'] });
const tab = { active: true, incognito: false, url: 'https://docs.example.org/x' };
for (const time of times) { now = at(time); await memory.observe(tab, { isPermitted: () => true }); }
process.stdout.write(JSON.stringify({ habits: (await memory.view()).habits, stored: data[CONTEXT_KEY] }));
`;

function run(tz, times, initial = null) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', script, JSON.stringify([initial, times])], { env: { ...process.env, TZ: tz }, encoding: 'utf8' });
  return JSON.parse(out);
}

const one = (observations, days) => [{ site: 'docs.example.org', observations, days }];

test('samples on one local day count as one day on either side of UTC midnight', () => {
  // 3pm and 5pm in Los Angeles fall on two UTC days; so do 8am and 10am in Tokyo.
  assert.deepEqual(run('America/Los_Angeles', [[2026, 11, 27, 15], [2026, 11, 27, 17]]).habits, one(2, 1));
  assert.deepEqual(run('Asia/Tokyo', [[2026, 11, 27, 8], [2026, 11, 27, 10]]).habits, one(2, 1));
});

test('local midnight starts a new day', () => {
  assert.deepEqual(run('America/Los_Angeles', [[2026, 11, 27, 23], [2026, 11, 28, 1]]).habits, one(2, 2));
  assert.deepEqual(run('Asia/Tokyo', [[2026, 11, 27, 23], [2026, 11, 28, 1]]).habits, one(2, 2));
});

test('a 25-hour day at the end of daylight time is still one day', () => {
  assert.deepEqual(run('America/Los_Angeles', [[2026, 11, 1, 0, 10], [2026, 11, 1, 23, 50]]).habits, one(2, 1));
  // Retention counts local days across the clock change: late on 7 Nov, 1 Nov is
  // still within the seven days (in UTC it is already 8 Nov).
  const week = run('America/Los_Angeles', [[2026, 11, 1, 12], [2026, 11, 7, 12]]);
  assert.deepEqual(week.habits, one(2, 2));
  assert.deepEqual(run('America/Los_Angeles', [[2026, 11, 7, 23, 30]], week.stored).habits, one(3, 2));
  assert.deepEqual(run('America/Los_Angeles', [[2026, 11, 8, 0, 30]], week.stored).habits, one(2, 2), 'on 8 Nov, 1 Nov has expired');
});

test('buckets saved with UTC day numbers move to their local day without losing samples', () => {
  const SLOT = 30 * 60_000, DAY = 86_400_000;
  const legacy = (iso) => { const t = Date.parse(iso); return { site: 'docs.example.org', day: Math.floor(t / DAY), observations: 3, lastSlot: Math.floor(t / SLOT) }; };
  const base = { version: 1, enabled: true, providerConsent: false, sites: ['docs.example.org'], lastSummary: null };
  // Los Angeles, 5pm 27 Nov is UTC 28 Nov; read and sampled again at 6:40pm local.
  const la = run('America/Los_Angeles', [[2026, 11, 27, 18, 40]], { ...base, buckets: [legacy('2026-11-28T01:00:00Z')] });
  assert.deepEqual(la.habits, one(4, 1));
  assert.equal(la.stored.buckets.length, 1);
  // Tokyo, 8am 28 Nov is UTC 27 Nov; sampled again at 10am local.
  const tokyo = run('Asia/Tokyo', [[2026, 11, 28, 10]], { ...base, buckets: [legacy('2026-11-27T23:00:00Z')] });
  assert.deepEqual(tokyo.habits, one(4, 1));
  assert.equal(tokyo.stored.buckets.length, 1);
  // Two legacy buckets that land on one local day merge.
  const merged = run('America/Los_Angeles', [[2026, 11, 28, 12]], { ...base, buckets: [legacy('2026-11-27T20:00:00Z'), legacy('2026-11-28T02:00:00Z')] });
  assert.deepEqual(merged.habits, [{ site: 'docs.example.org', observations: 7, days: 2 }]);
});
