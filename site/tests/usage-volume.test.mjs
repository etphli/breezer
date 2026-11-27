import test from 'node:test';
import assert from 'node:assert/strict';
import { MockAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import metrics from '../api/metrics.js';
import usage from '../api/usage.js';
import { DASHBOARD_HOST } from '../lib/metrics.js';

function response() {
  return {
    setHeader() {},
    status(code) { this.code = code; return this; },
    end() {},
    json(body) { this.body = body; },
  };
}

test('dashboard returns partial metrics when a month exceeds the report limit', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-15T10:00:00Z') });
  const agent = new MockAgent();
  agent.disableNetConnect();
  const dispatcher = getGlobalDispatcher();
  const originalEnv = process.env;
  process.env = {
    ...originalEnv,
    BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_fixture_test',
    VERCEL_BLOB_API_URL: 'https://blob-api.test',
  };
  setGlobalDispatcher(agent);
  t.after(async () => {
    setGlobalDispatcher(dispatcher);
    process.env = originalEnv;
    await agent.close();
  });
  t.mock.method(globalThis, 'fetch', async () => Response.json([]));
  const day = '2026-10-15';
  const month = '2026-10';
  let currentMonthPages = 0;
  let reads = 0;
  agent.get('https://blob-api.test').intercept({ path: /^\/\?/ }).reply(200, ({ path }) => {
    const params = new URL(path, 'https://blob-api.test').searchParams;
    const prefix = params.get('prefix');
    if (prefix !== `usage/${month}/`) return { blobs: [], hasMore: false };
    const offset = Number(params.get('cursor'));
    const count = Math.min(Number(params.get('limit')), 20_001 - offset);
    const next = offset + count;
    currentMonthPages++;
    return {
      blobs: Array.from({ length: count }, (_, i) => ({ pathname: `${prefix}${offset + i}.json` })),
      hasMore: next < 20_001,
      cursor: String(next),
    };
  }).persist();
  agent.get('https://fixture.private.blob.vercel-storage.com').intercept({ path: /^\/usage\// }).reply(({ path }) => {
    reads++;
    return path.endsWith('/0.json?cache=0')
      ? { statusCode: 200, data: { id: 'fixture', days: { [day]: 60 } } }
      : { statusCode: 404 };
  }).persist();

  const res = response();
  await metrics({ method: 'GET', headers: { host: DASHBOARD_HOST } }, res);
  assert.equal(res.code, 200, `Metrics returned ${res.code} after ${currentMonthPages} pages`);
  assert.equal(res.body.truncated, true);
  assert.equal(res.body.mau, 1);
  assert.equal(res.body.seconds, 60);
  assert.equal(currentMonthPages, 20);
  assert.equal(reads, 20_000);
});

test('collector checks raw body size in bytes before parsing JSON without a content-length header', async () => {
  const res = response();
  await usage({
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '"' + 'é'.repeat(2048) + '"',
  }, res);
  assert.equal(res.code, 413);
});

test('retention still deletes expired reports when total volume exceeds the dashboard cap', async t => {
  const { pruneReports } = await import('../lib/storage.js');
  const agent = new MockAgent();
  agent.disableNetConnect();
  const dispatcher = getGlobalDispatcher();
  const originalEnv = process.env;
  process.env = { ...originalEnv, BLOB_READ_WRITE_TOKEN: 'vercel_blob_rw_fixture_test', VERCEL_BLOB_API_URL: 'https://blob-api.test' };
  setGlobalDispatcher(agent);
  t.after(async () => { setGlobalDispatcher(dispatcher); process.env = originalEnv; await agent.close(); });
  const total = 20_500;
  let deleted = 0;
  const pool = agent.get('https://blob-api.test');
  pool.intercept({ path: /^\/delete/, method: 'POST' }).reply(200, ({ body }) => { deleted += JSON.parse(body).urls.length; return {}; }).persist();
  pool.intercept({ path: /^\/\?/ }).reply(200, ({ path }) => {
    const params = new URL(path, 'https://blob-api.test').searchParams;
    const offset = Number(params.get('cursor')), count = Math.min(Number(params.get('limit')), total - offset), next = offset + count;
    // The first 500 reports are from an expired month; the rest are current.
    return {
      blobs: Array.from({ length: count }, (_, i) => {
        const n = offset + i, month = n < 500 ? '2026-07' : '2026-10';
        return { pathname: `usage/${month}/${n}.json`, url: `https://fixture.private.blob.vercel-storage.com/usage/${month}/${n}.json` };
      }),
      hasMore: next < total,
      cursor: String(next),
    };
  }).persist();
  assert.equal(await pruneReports(new Date('2026-10-15T10:00:00Z')), 500);
  assert.equal(deleted, 500);
});
