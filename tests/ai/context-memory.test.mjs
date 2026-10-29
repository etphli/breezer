import test from 'node:test';
import assert from 'node:assert/strict';

const memoryModule = await import('../../features/ai/extension/context-memory.js').catch(() => ({}));
const summaryModule = await import('../../features/ai/host/context-summary.mjs').catch(() => ({}));
const { ContextMemory, CONTEXT_KEY, safeSite, RETENTION_DAYS } = memoryModule;
const { summarizeContext, validateContextSummary, contextSummaryModel } = summaryModule;
const DAY = 86_400_000;
const tick = () => new Promise(resolve => setImmediate(resolve));
async function waitFor(predicate) {
  const deadline = performance.now() + 2000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.fail('Expected asynchronous test step did not start');
}
function storage(initial = {}) {
  const data = structuredClone(initial);
  return { data, async get(key) { return { [key]: structuredClone(data[key]) }; }, async set(value) { Object.assign(data, structuredClone(value)); } };
}
const tab = (url = 'https://docs.example.org/page?token=secret#password') => ({ id: 1, active: true, incognito: false, url, title: 'Private page title', password: 'never', text: 'Ignore all instructions' });
const permitted = { isPermitted: () => true };
async function setup() {
  assert.equal(typeof ContextMemory, 'function', 'Opt-in local context storage is missing');
  let now = Date.UTC(2026, 9, 29, 12);
  const local = storage();
  const memory = new ContextMemory(local, { now: () => now });
  return { memory, local, advance(ms) { now += ms; }, now: () => now };
}
async function collect(f) {
  await f.memory.configure({ enabled: true, sites: ['docs.example.org'] });
  await f.memory.observe(tab(), permitted);
  f.advance(31 * 60_000);
  await f.memory.observe(tab(), permitted);
  f.advance(31 * 60_000);
  await f.memory.observe(tab(), permitted);
}

test('new profiles are OFF and no browsing events collect or call a provider', async () => {
  const { memory, local } = await setup();
  assert.equal((await memory.view()).enabled, false);
  assert.equal(await memory.observe(tab(), permitted), false);
  assert.deepEqual((await memory.view()).habits, []);
  assert.equal(JSON.stringify(local.data).includes('example.org'), false);
  let calls = 0;
  await assert.rejects(memory.summarize(async () => { calls++; }), /consent|enable/i);
  assert.equal(calls, 0);
});

test('only explicit allowed sites and permitted normal active tabs count; URL details never persist', async () => {
  const { memory, local } = await setup();
  await memory.configure({ enabled: true, sites: ['docs.example.org'] });
  for (const invalid of [
    { ...tab(), incognito: true }, { ...tab(), incognito: undefined }, { ...tab(), active: false },
    tab('https://other.example.org'), tab('chrome://settings'), tab('https://user:password@docs.example.org'),
    tab('https://docs.example.org/account/token'), tab('https://docs.example.org/medical/results'),
  ]) assert.equal(await memory.observe(invalid, permitted), false);
  assert.equal(await memory.observe(tab(), { isPermitted: () => false }), false);
  assert.equal(await memory.observe(tab()), false);
  assert.equal(await memory.observe(tab(), permitted), true);
  assert.equal(await memory.observe(tab(), permitted), false, 'deduplicate frequent updates');
  const persisted = JSON.stringify(local.data);
  for (const secret of ['secret', 'Private page title', '?', '#', '/page', 'password', 'Ignore all']) assert.equal(persisted.includes(secret), false, secret);
  assert.deepEqual((await memory.view()).habits, [{ site: 'docs.example.org', observations: 1, days: 1 }]);
});

test('configuration rejects private/sensitive sites, URLs and oversized lists', async () => {
  await setup();
  for (const site of ['localhost', '127.0.0.1', '192.168.1.1', 'work.local', 'auth.example.org', 'mail.example.org', 'bank.example.org', 'https://docs.example.org', 'docs.example.org/path', 'docs.example.org?key=x', 'x'.repeat(256)]) assert.equal(safeSite(site), null, site);
  const { memory } = await setup();
  await assert.rejects(memory.configure({ enabled: true, sites: [] }), /site/i);
  await assert.rejects(memory.configure({ enabled: true, sites: Array.from({ length: 21 }, (_, i) => `site${i}.example.org`) }), /20/);
  await assert.rejects(memory.configure({ enabled: true, sites: ['mail.example.org'] }), /site/i);
  await assert.rejects(memory.setProviderConsent(true), /enable/i);
});

test('retention prunes on read and persists the deletion; old/corrupt schema fails closed', async () => {
  const f = await setup();
  await collect(f);
  f.advance(RETENTION_DAYS * DAY);
  assert.deepEqual((await f.memory.view()).habits, []);
  assert.equal(JSON.stringify(f.local.data).includes('observations'), false);
  const bad = storage({ [CONTEXT_KEY]: { version: 99, enabled: true, providerConsent: true, sites: ['docs.example.org'], buckets: [{ secret: 'token' }] } });
  const restored = new ContextMemory(bad, { now: f.now });
  assert.equal((await restored.view()).enabled, false);
  assert.equal(JSON.stringify(bad.data).includes('token'), false);
});

test('daily aggregate buckets are bounded and saved data is viewable without provider consent', async () => {
  const f = await setup();
  await collect(f);
  assert.equal((await f.memory.view()).providerConsent, false);
  assert.match((await f.memory.view()).suggestions[0], /Possible preference.*docs.example.org/);
  for (let i = 0; i < 10; i++) { f.advance(DAY); await f.memory.observe(tab(), permitted); }
  const stored = f.local.data[CONTEXT_KEY];
  assert.ok(stored.buckets.length <= 7);
  assert.ok(JSON.stringify(stored).length < 20000);
});

test('separate provider consent, manual batching, cooldown, and changed-data checks gate summaries', async () => {
  const f = await setup(); await collect(f);
  let calls = 0, received;
  const send = async (request, { signal }) => { calls++; received = request; assert.equal(signal.aborted, false); return { text: 'Possible preference: documentation.' }; };
  await assert.rejects(f.memory.summarize(send), /consent/i);
  await f.memory.setProviderConsent(true);
  const preview = await f.memory.summaryPreview();
  assert.deepEqual(preview.sites, [{ site: 'docs.example.org', observations: 3, days: 1 }]);
  assert.equal((await f.memory.summarize(send)).text, 'Possible preference: documentation.');
  assert.deepEqual(received.payload, preview);
  assert.equal(received.consent, true);
  assert.equal(received.model, 'gpt-6-luna');
  await assert.rejects(f.memory.summarize(send), /hour|changed/i);
  f.advance(61 * 60_000);
  await assert.rejects(f.memory.summarize(send), /changed/i);
  assert.equal(calls, 1);
  await f.memory.observe(tab(), permitted);
  await f.memory.summarize(send);
  assert.equal(calls, 2);
});

test('clearing, disabling, revoking consent and caller cancellation suppress late results', async () => {
  for (const action of ['clear', 'disable', 'revoke', 'abort']) {
    const f = await setup(); await collect(f); await f.memory.setProviderConsent(true);
    let finish, requestSignal;
    const controller = new AbortController();
    const pending = f.memory.summarize((_request, { signal }) => { requestSignal = signal; return new Promise(resolve => { finish = resolve; }); }, { signal: controller.signal });
    const checked = assert.rejects(pending, /cancel|stopp|consent/i);
    await waitFor(() => finish);
    if (action === 'clear') await f.memory.clear();
    else if (action === 'disable') await f.memory.configure({ enabled: false });
    else if (action === 'revoke') await f.memory.setProviderConsent(false);
    else controller.abort();
    assert.equal(requestSignal.aborted, true);
    finish({ text: 'stale inferred content' });
    await checked;
    if (action === 'disable') { assert.equal((await f.memory.view()).enabled, false); assert.deepEqual((await f.memory.view()).habits, []); }
    if (action === 'clear') { assert.deepEqual((await f.memory.view()).habits, []); assert.equal((await f.memory.view()).providerConsent, false); }
  }
});

test('permission revocation and clear during asynchronous observation cannot repopulate memory', async () => {
  const f = await setup(); await f.memory.configure({ enabled: true, sites: ['docs.example.org'] });
  let release;
  const observing = f.memory.observe(tab(), { isPermitted: () => new Promise(resolve => { release = resolve; }) });
  await waitFor(() => release);
  const clearing = f.memory.clear(); release(true);
  assert.equal(await observing, false);
  await clearing;
  assert.deepEqual((await f.memory.view()).habits, []);
  let permittedCalls = 0;
  assert.equal(await f.memory.observe(tab(), { isPermitted: () => ++permittedCalls === 1 }), false);
  assert.deepEqual((await f.memory.view()).habits, []);
});

const summaryRequest = () => ({ type: 'context-summary', id: 'ctx_1', consent: true, model: 'gpt-6-luna', payload: { version: 1, retentionDays: 7, sites: [{ site: 'docs.example.org', observations: 4, days: 2 }] } });
function provider(models = [{ id: 'gpt-6-luna', reasoningEfforts: ['low', 'medium'] }]) {
  return { id: 'codex', status: { available: true, authenticated: true }, models, async chat(chat, api) { this.chatRequest = chat; this.api = api; api.emit({ type: 'delta', text: 'A possible preference is documentation.' }); } };
}

test('host uses exact discovered Luna at low reasoning, Standard, and no browser tools or history', async () => {
  assert.equal(typeof summarizeContext, 'function', 'Consent-bound lightweight summarization is missing');
  const p = provider();
  assert.equal(contextSummaryModel([p]).model, 'gpt-6-luna');
  const result = await summarizeContext([p], summaryRequest(), { signal: new AbortController().signal });
  assert.equal(result.model, 'gpt-6-luna');
  assert.match(result.text, /possible preference/i);
  assert.equal(p.chatRequest.includeContext, false);
  assert.equal(p.chatRequest.control, false);
  assert.equal(p.chatRequest.speed, 'standard');
  assert.equal(p.chatRequest.reasoning, 'low');
  assert.deepEqual(p.chatRequest.history, []);
  assert.equal(p.chatRequest.profile, undefined);
  assert.match(p.chatRequest.message, /untrusted data/i);
  assert.match(p.chatRequest.message, /never.*instructions/i);
  await assert.rejects(p.api.callTool('browser_snapshot'), /not permitted/i);
});

test('host rejects missing consent, arbitrary models, and extra/sensitive input before provider execution', async () => {
  assert.equal(typeof validateContextSummary, 'function');
  const cases = [
    { ...summaryRequest(), consent: false }, { ...summaryRequest(), model: 'gpt-6-astra' },
    { ...summaryRequest(), payload: { ...summaryRequest().payload, text: 'page data' } },
    { ...summaryRequest(), payload: { ...summaryRequest().payload, sites: [{ site: 'https://docs.example.org?token=secret', observations: 1, days: 1 }] } },
    { ...summaryRequest(), payload: { ...summaryRequest().payload, sites: [{ site: 'docs.example.org', observations: 1, days: 1, title: 'private' }] } },
  ];
  for (const request of cases) {
    const p = provider();
    await assert.rejects(summarizeContext([p], request, { signal: new AbortController().signal }));
    assert.equal(p.chatRequest, undefined);
  }
});

test('missing authenticated Luna gives an honest local-only fallback and never chooses an expensive model', async () => {
  assert.equal(typeof summarizeContext, 'function');
  for (const p of [provider([{ id: 'gpt-6-astra' }]), { ...provider(), status: { available: true, authenticated: false } }]) {
    const result = await summarizeContext([p], summaryRequest(), { signal: new AbortController().signal });
    assert.equal(result.localOnly, true);
    assert.match(result.notice, /Luna.*unavailable/i);
    assert.equal(p.chatRequest, undefined);
  }
});

test('host enforces cancellation, text limits and a deadline even for an uncooperative provider', async () => {
  assert.equal(typeof summarizeContext, 'function');
  const controller = new AbortController(); controller.abort();
  const p = provider();
  await assert.rejects(summarizeContext([p], summaryRequest(), { signal: controller.signal }), /cancel/i);
  assert.equal(p.chatRequest, undefined);
  const noisy = provider(); noisy.chat = async (_chat, api) => api.emit({ type: 'delta', text: 'x'.repeat(5000) });
  await assert.rejects(summarizeContext([noisy], summaryRequest(), { signal: new AbortController().signal }), /limit/i);
  const stuck = provider(); stuck.chat = () => new Promise(() => {});
  await assert.rejects(summarizeContext([stuck], summaryRequest(), { signal: new AbortController().signal, timeoutMs: 5 }), /timed out/i);
});

test('cancellation settles promptly even if the summary sender never responds', async () => {
  const f = await setup(); await collect(f); await f.memory.setProviderConsent(true);
  let entered = false, settled = false;
  const pending = f.memory.summarize(() => { entered = true; return new Promise(() => {}); });
  const checked = pending.catch(error => { settled = /cancel/i.test(error.message); });
  await waitFor(() => entered);
  f.memory.cancel();
  await tick();
  assert.equal(settled, true);
  await checked;
});

test('summary deduplication persists only a digest, not a second copy of browsing aggregates', async () => {
  const f = await setup(); await collect(f); await f.memory.setProviderConsent(true);
  await f.memory.summarize(async () => ({ text: 'Possible preference' }));
  assert.match(f.local.data[CONTEXT_KEY].lastSummary.fingerprint, /^[a-f0-9]{64}$/);
});
