import test from 'node:test';
import assert from 'node:assert/strict';
import { createReleaseCache, releaseDownloads } from '../api/metrics.js';

const page = [{ draft: false, tag_name: 'v1.3.7', assets: [{ name: 'Breezer.dmg', download_count: 4 }] }];
const ok = body => ({ ok: true, json: async () => body });

test('GitHub requests use GITHUB_TOKEN when it is set, and omit it otherwise', async t => {
  const seen = [];
  const fetcher = async (url, options) => { seen.push(options.headers.Authorization); return ok(page); };
  const original = process.env.GITHUB_TOKEN;
  t.after(() => { if (original === undefined) delete process.env.GITHUB_TOKEN; else process.env.GITHUB_TOKEN = original; });
  process.env.GITHUB_TOKEN = 'ghp_fixture';
  assert.deepEqual(await releaseDownloads(fetcher), [{ version: 'v1.3.7', downloads: 4 }]);
  delete process.env.GITHUB_TOKEN;
  await releaseDownloads(fetcher);
  assert.deepEqual(seen, ['Bearer ghp_fixture', undefined]);
});

test('paging GitHub is bounded by one total time budget', async () => {
  let calls = 0;
  // Each page answers just inside the per-request timeout, but the total exceeds the budget.
  const fetcher = async (url, { signal }) => {
    calls++;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 40);
      signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
    return ok(Array.from({ length: 100 }, (_, i) => ({ draft: false, tag_name: `v${calls}.${i}`, assets: [] })));
  };
  const started = Date.now();
  await assert.rejects(releaseDownloads(fetcher, { token: '', budgetMs: 100 }));
  assert.ok(Date.now() - started < 1000);
  assert.ok(calls < 20);
});

test('release counts are cached per instance, shared while pending and reused when GitHub fails', async () => {
  let time = 0, calls = 0, fail = false;
  const fetcher = async () => { calls++; if (fail) return { ok: false }; return ok(page); };
  const read = createReleaseCache({ fetcher, now: () => time, token: '' });
  const [first, second] = await Promise.all([read(), read()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
  time += 60_000; await read(); assert.equal(calls, 1);
  time += 5 * 60_000; fail = true;
  assert.deepEqual(await read(), first, 'a recent result covers a GitHub failure');
  assert.equal(calls, 2);
  time += 2 * 60 * 60_000;
  await assert.rejects(read());
  fail = false; assert.deepEqual(await read(), first);
});
