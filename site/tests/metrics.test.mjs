import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregateUsage, validateUsage, mergeDays, isDashboardHost, DASHBOARD_HOST } from '../lib/metrics.js';
import dashboard from '../api/dashboard.js';
import metrics, { releaseDownloads } from '../api/metrics.js';
import retention from '../api/retention.js';
import usage from '../api/usage.js';

const id = '45cd8724-a8f7-4c47-b27b-490472aa1d30';
const now = new Date('2026-10-31T10:00:00Z');
const report = { month: '2026-10', id, days: { '2026-10-31': 60 } };
function response() { return { headers: {}, code: null, body: null, setHeader(k, v) { this.headers[k] = v; }, status(code) { this.code = code; return this; }, end() {}, json(body) { this.body = body; }, send(body) { this.body = body; }, redirect(code, location) { this.code = code; this.headers.Location = location; } }; }

test('reports permit only the documented payload and current/previous month', () => {
  assert.deepEqual(validateUsage(report, now), report);
  assert.throws(() => validateUsage({ ...report, id: [id] }, now));
  for (const value of [{ ...report, url: 'https://secret.example' }, { ...report, id: '../escape' }, { ...report, month: '2026-08' }, { ...report, days: { '2026-10-32': 60 } }, { ...report, days: { '2026-11-01': 60 } }, { ...report, days: { '2026-10-01': -1 } }, { ...report, days: { '2026-10-01': 86401 } }, { ...report, days: { '2026-10-01': 0.5 } }, { ...report, days: {} }]) assert.throws(() => validateUsage(value, now));
});
test('retries and out-of-order cumulative reports never double-count or lose time', () => {
  const prior = { '2026-10-01': 400, '2026-10-02': 20 };
  const expected = { '2026-10-01': 400, '2026-10-02': 30 };
  assert.deepEqual(mergeDays(prior, { '2026-10-01': 300, '2026-10-02': 30 }), expected);
  assert.deepEqual(mergeDays(expected, expected), expected);
});
test('calendar MAU includes the first of a 31-day month; hours cover exactly 30 days', () => {
  const result = aggregateUsage([{ id, days: { '2026-10-01': 3600, '2026-10-02': 7200, '2026-10-31': 60 } }, { id: 'second', days: { '2026-10-01': 60 } }, { id: 'old', days: { '2026-09-30': 100 } }], now);
  assert.equal(result.mau, 2); assert.equal(result.seconds, 7260); assert.equal(result.series.length, 30); assert.equal(result.start, '2026-10-02');
});
test('month boundary does not count previous-month identifiers in current MAU', () => {
  const result = aggregateUsage([{ id: 'old', days: { '2026-09-30': 3600 } }, { id, days: { '2026-10-01': 0 } }], new Date('2026-10-01T08:00:00Z'));
  assert.equal(result.mau, 1); assert.equal(result.seconds, 3600); assert.equal(result.series.at(-1).users, 1);
});
test('only the exact Vercel-protected team host may read metrics', async () => {
  for (const host of ['breezer-browser.vercel.app', 'getbreezer.vercel.app', 'breezer-ethans-project.vercel.app.evil.test', 'localhost']) {
    const request = { method: 'GET', headers: { host, 'x-forwarded-host': DASHBOARD_HOST } };
    assert.equal(isDashboardHost(request), false);
    const res = response(); await metrics(request, res); assert.equal(res.code, 404); assert.equal(res.body, null);
    const page = response(); dashboard(request, page); assert.equal(page.code, 303); assert.equal(page.headers.Location, `https://${DASHBOARD_HOST}/dashboard`);
  }
  const res = response(); dashboard({ method: 'GET', headers: { host: DASHBOARD_HOST } }, res);
  assert.equal(res.code, 200); assert.match(res.body, /Vercel protected/); assert.match(res.headers['Content-Security-Policy'], /frame-ancestors 'none'/);
});
test('retention refuses missing or malformed authentication', async () => {
  for (const authorization of ['', 'Bearer bogus', 'é'.repeat(7)]) { const res = response(); await retention({ headers: { authorization } }, res); assert.equal(res.code, 401); }
});
test('collector rejects oversized and unexpected payloads before storage', async () => {
  for (const [request, code] of [[{ method: 'GET', headers: {} }, 405], [{ method: 'POST', headers: { 'content-type': 'text/plain' } }, 415], [{ method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '5000' } }, 413], [{ method: 'POST', headers: { 'content-type': 'application/json' }, body: { ...report, browsingHistory: [] } }, 400]]) {
    const res = response(); await usage(request, res); assert.equal(res.code, code);
  }
});
test('GitHub download metrics count installers, exclude draft releases, and paginate', async () => {
  let calls = 0;
  const data = await releaseDownloads(async () => ({ ok: true, json: async () => ++calls === 1 ? Array.from({ length: 100 }, (_, i) => ({ draft: i === 0, tag_name: `v${i}`, assets: [{ name: 'Breezer.dmg', download_count: 2 }, { name: 'Breezer.dmg.sha256', download_count: 999 }] })) : [] }));
  assert.equal(calls, 2); assert.equal(data.length, 99); assert.equal(data.reduce((sum, row) => sum + row.downloads, 0), 198);
  await assert.rejects(releaseDownloads(async () => ({ ok: false })));
});
