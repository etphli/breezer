import { mkdir, open, readFile, writeFile, rename, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { types } from 'node:util';
import { keyPattern, windowsSecrets, withWindowsCacheLock } from './organato-windows.mjs';
const BASE = 'https://organato.etphli.workers.dev/api/v1';
const SERVICE = 'io.github.etphli.breezer.organato';
const WINDOWS = process.platform === 'win32';
const localAppData = process.env.LOCALAPPDATA;
const CONFIG = join(WINDOWS
  ? (localAppData && isAbsolute(localAppData) ? localAppData : join(homedir(), 'AppData', 'Local'))
  : join(homedir(), 'Library', 'Application Support'), 'io.github.etphli.breezer-integrations');
const accountId = key => createHash('sha256').update(key).digest('hex');
const CACHE_LIMIT = 8_000_000;
const cacheFields = new Set(['id', 'url', 'version', 'title', 'kind', 'classification', 'dueAt', 'dueDateLocal', 'workingStatus', 'subjectId']);
const cacheItem = item => Object.fromEntries(Object.entries(item).filter(([name, value]) => cacheFields.has(name) && (value === null || ['string', 'number', 'boolean'].includes(typeof value))));
// Use an OS advisory lock for the write/invalidate transaction across helpers.
// The lock holder releases it when the parent closes its pipe or exits.
async function withCacheLock(directory, action) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = join(directory, 'organato-cache.lock');
  if (WINDOWS) return withWindowsCacheLock(path, action);
  await (await open(path, 'a', 0o600)).close();
  const mac = process.platform === 'darwin';
  const child = spawn(mac ? '/usr/bin/lockf' : '/usr/bin/flock', [
    ...(mac ? ['-k', '-t', '3'] : ['-w', '3']), path,
    '/bin/sh', '-c', 'printf 1; read -r reply || :',
  ], { stdio: ['pipe', 'pipe', 'ignore'] });
  const closed = new Promise(resolve => child.once('close', resolve));
  child.stdin.on('error', () => {});
  try {
    await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', () => reject(new Error('Organato cache lock unavailable.')));
      child.stdout.once('data', data => data.toString() === '1' ? resolve() : reject(new Error('Invalid Organato cache lock response.')));
    });
    return await action();
  } finally {
    child.stdin.end();
    await closed;
  }
}
async function responseText(response) {
  if (!response.body) return '';
  const reader = response.body.getReader(), decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  let text = '', leading = true, boms = 0;
  const append = value => {
    let start = 0;
    if (leading) {
      // Node Response.text removes a byte BOM and then the decoder's BOM.
      while (start < value.length && boms < 2 && value[start] === '\ufeff') { start++; boms++; }
      leading = start === value.length;
    }
    text += start ? value.slice(start) : value;
    if (text.length > 2_000_000) throw new Error('Organato response is too large.');
  };
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!types.isUint8Array(value)) throw new TypeError('Organato response stream must contain bytes.');
      for (let offset = 0; offset < value.byteLength; offset += 65536) {
        append(decoder.decode(value.subarray(offset, offset + 65536), { stream: true }));
      }
    }
    append(decoder.decode());
    return text;
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}
function security(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/security', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let output = ''; const timer = setTimeout(() => { child.kill(); reject(new Error('Keychain access timed out.')); }, 30_000);
    child.stdout.on('data', data => { if (output.length < 4096) output += data; });
    child.stderr.resume();
    child.on('error', () => { clearTimeout(timer); reject(new Error('Keychain is unavailable.')); });
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve(output.trim()) : reject(new Error('Could not access the Organato key in macOS Keychain.')); });
    child.stdin.end(input || '');
  });
}
export const keychain = {
  async get() { try { const key = await security(['find-generic-password', '-s', SERVICE, '-a', 'breezer', '-w']); return keyPattern.test(key) ? key : null; } catch { return null; } },
  async set(key) {
    if (!keyPattern.test(key)) throw new Error('Enter a valid Organato API key.');
    // Pass the key on stdin, never in process arguments or an on-disk script.
    await security(['-i'], `add-generic-password -U -s ${SERVICE} -a breezer -w ${key}\n`);
    const saved = await security(['find-generic-password', '-s', SERVICE, '-a', 'breezer', '-w']);
    if (saved !== key) throw new Error('Organato key could not be saved in macOS Keychain.');
  },
  async remove() { await security(['delete-generic-password', '-s', SERVICE, '-a', 'breezer']).catch(() => {}); },
};
export function validateItem(input, update = false) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Organato item.');
  const fields = update ? ['id', 'version', 'displayName', 'dueDateLocal', 'workingStatus', 'notesMarkdown'] : ['kind', 'classification', 'displayName', 'dueDateLocal', 'notesMarkdown'];
  if (Object.keys(input).some(k => !fields.includes(k))) throw new Error('Unsupported Organato field.');
  if (!update && !['work', 'todo'].includes(input.kind)) throw new Error('Choose work or todo.');
  if (!update && (typeof input.displayName !== 'string' || !input.displayName.trim())) throw new Error('An item title is required.');
  if (input.displayName !== undefined && (typeof input.displayName !== 'string' || !input.displayName.trim() || input.displayName.length > 500)) throw new Error('Invalid item title.');
  if (input.classification !== undefined && !['assignment', 'checkpoint', 'both', 'unclassified'].includes(input.classification)) throw new Error('Invalid classification.');
  const { dueDateLocal } = input;
  if (dueDateLocal !== undefined) {
    const timestamp = typeof dueDateLocal === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dueDateLocal) ? Date.parse(dueDateLocal) : NaN;
    if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0, 10) !== dueDateLocal) throw new Error('Use a valid YYYY-MM-DD deadline.');
  }
  if (input.notesMarkdown !== undefined && (typeof input.notesMarkdown !== 'string' || input.notesMarkdown.length > 20_000)) throw new Error('Notes are too long.');
  if (input.workingStatus !== undefined && !['not_started', 'in_progress', 'submitted', 'completed'].includes(input.workingStatus)) throw new Error('Invalid work status.');
  if (update && (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) || !Number.isInteger(input.version) || input.version < 1)) throw new Error('Read the current item and version before updating it.');
  return input;
}
export class Organato {
  constructor({ fetcher = fetch, configDirectory = CONFIG, secrets = WINDOWS ? windowsSecrets(configDirectory) : keychain } = {}) { this.fetcher = fetcher; this.secrets = secrets; this.directory = configDirectory; this.listSequence = 0; this.savedSequence = 0; this.cacheGeneration = 0; this.cacheHolds = 0; this.cacheQueue = Promise.resolve(); }
  cacheOperation(fn) {
    const operation = this.cacheQueue.then(fn);
    this.cacheQueue = operation.catch(() => {});
    return operation;
  }
  // Invalidation outlives a helper process. Readers admit only the current revision.
  async cacheRevision() {
    try { return await readFile(join(this.directory, 'organato-cache-revision'), 'utf8'); }
    catch (error) { return error.code === 'ENOENT' ? '' : null; }
  }
  async clearCache() {
    this.cacheGeneration++;
    await this.cacheOperation(() => withCacheLock(this.directory, async () => {
      const temporary = join(this.directory, `organato-cache-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, randomUUID(), { mode: 0o600 });
        await rename(temporary, join(this.directory, 'organato-cache-revision'));
      } finally { await rm(temporary, { force: true }); }
      await rm(join(this.directory, 'organato-cache.json'), { force: true });
    }));
  }
  async cachedList(key) {
    const generation = this.cacheGeneration;
    if (this.cacheHolds) return null;
    try {
      await this.cacheQueue;
      const revision = await this.cacheRevision();
      if (revision === null) return null;
      const path = join(this.directory, 'organato-cache.json');
      if ((await stat(path)).size > CACHE_LIMIT) return null;
      const saved = JSON.parse(await readFile(path, 'utf8'));
      if ((saved.revision ?? '') !== revision || saved.schema !== 1 || saved.account !== accountId(key) || typeof saved.syncedAt !== 'string' || !Number.isFinite(Date.parse(saved.syncedAt)) || !Array.isArray(saved.items) || saved.items.length > 2000 || saved.items.some(item => !item || typeof item !== 'object' || Array.isArray(item) || typeof item.title !== 'string')) return null;
      if (generation !== this.cacheGeneration || this.cacheHolds || await this.secrets.get() !== key || await this.cacheRevision() !== revision) return null;
      return { items: saved.items.map(cacheItem), truncated: saved.truncated === true, syncedAt: saved.syncedAt };
    } catch { return null; }
  }
  async saveList(result, key, generation, sequence, revision, order) {
    // Cache failures must not turn a successful live sync into a dashboard error.
    await this.cacheOperation(async () => {
      if (revision === null || await this.cacheRevision() !== revision || sequence < this.savedSequence || generation !== this.cacheGeneration || this.cacheHolds || await this.secrets.get() !== key) return;
      if (!Array.isArray(result.items) || result.items.length > 2000) return;
      const items = result.items.map(cacheItem);
      const account = accountId(key);
      const data = JSON.stringify({ schema: 1, revision, account, items, truncated: result.truncated === true, syncedAt: result.syncedAt, order });
      if (Buffer.byteLength(data) > CACHE_LIMIT) return;
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      const temporary = join(this.directory, `organato-cache-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, data, { mode: 0o600 });
        if (revision === null || await this.cacheRevision() !== revision || sequence < this.savedSequence || generation !== this.cacheGeneration || this.cacheHolds || await this.secrets.get() !== key) return;
        await withCacheLock(this.directory, async () => {
          if (await this.cacheRevision() !== revision || generation !== this.cacheGeneration || this.cacheHolds) return;
          const path = join(this.directory, 'organato-cache.json');
          let before;
          try {
            if ((await stat(path)).size <= CACHE_LIMIT) before = JSON.parse(await readFile(path, 'utf8'));
          } catch (error) {
            if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error;
          }
          if (before?.schema === 1 && before.revision === revision && before.account === account) {
            const previousTime = Date.parse(before.syncedAt), time = Date.parse(result.syncedAt);
            if (previousTime > time || (previousTime === time && /^\d{1,24}$/.test(before.order) && BigInt(before.order) > BigInt(order))) return;
          }
          await rename(temporary, path);
          this.savedSequence = sequence;
        });
      } finally { await rm(temporary, { force: true }); }
    }).catch(() => {});
  }
  async config() { try { return { enabled: true, dashboardEnabled: true, allowAI: true, ...JSON.parse(await readFile(join(this.directory, 'organato.json'), 'utf8')) }; } catch { return { enabled: true, dashboardEnabled: true, allowAI: true }; } }
  async view() { return { ...await this.config(), connected: !!await this.secrets.get() }; }
  async dashboardContext() {
    const config = await this.config(), key = await this.secrets.get();
    const fingerprint = createHash('sha256').update(JSON.stringify([1, key, config.enabled, config.dashboardEnabled, config.allowAI, await this.cacheRevision()])).digest('hex');
    return { config, key, fingerprint };
  }
  async dashboardView() {
    const { config, key, fingerprint } = await this.dashboardContext();
    return { ...config, connected: !!key, cacheCapability: 1, fingerprint };
  }
  async dashboardList(expected, signal, { onCached } = {}) {
    const generation = this.cacheGeneration, sequence = ++this.listSequence;
    const revision = await this.cacheRevision();
    const context = await this.dashboardContext();
    const validate = async () => {
      if (generation !== this.cacheGeneration || this.cacheHolds || signal?.aborted || (revision !== null && await this.cacheRevision() !== revision) || (await this.dashboardContext()).fingerprint !== expected) throw Object.assign(new Error('Organato dashboard context changed.'), { code: 'DASHBOARD_CHANGED' });
    };
    if (context.fingerprint !== expected) throw Object.assign(new Error('Organato dashboard context changed.'), { code: 'DASHBOARD_CHANGED' });
    if (!context.config.enabled || !context.config.dashboardEnabled) throw new Error('Organato is switched off in Settings.');
    if (!context.key) throw new Error('Connect Organato in Breezer Settings first.');
    try {
      await validate();
      if (onCached) {
        const cached = await this.cachedList(context.key);
        await validate();
        if (cached) await onCached({ ...cached, fingerprint: expected });
      }
      const result = await this.collectList(signal, context.key, validate);
      const order = process.hrtime.bigint().toString();
      await validate();
      await this.saveList(result, context.key, generation, sequence, revision, order);
      await validate();
      return { ...result, fingerprint: expected };
    } catch (error) {
      if (error.code !== 'DASHBOARD_CHANGED') await validate();
      if (error.status === 401 || error.status === 403) await this.clearCache().catch(() => {});
      throw error;
    }
  }
  configure(input, progress = () => {}) {
    this.cacheHolds++; this.cacheGeneration++;
    const operation = (this.configurationQueue || Promise.resolve()).then(() => this.configureNow(input, progress)).finally(() => { this.cacheHolds--; this.cacheGeneration++; });
    this.configurationQueue = operation.catch(() => {});
    return operation;
  }
  async configureNow(input, progress) {
    let connected;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Organato settings.');
    for (const name of ['enabled', 'dashboardEnabled', 'allowAI']) {
      if (input[name] !== undefined && typeof input[name] !== 'boolean') throw new Error('Invalid Organato setting.');
    }
    if (['enabled', 'dashboardEnabled', 'allowAI'].some(name => input[name] !== undefined)) await this.clearCache();
    if (input.key !== undefined) {
      if (typeof input.key !== 'string' || !keyPattern.test(input.key)) throw new Error('Enter a valid Organato API key.');
      progress('Checking your Organato key…');
      await this.request('/items?limit=1', 'GET', undefined, undefined, input.key);
      await this.clearCache();
      progress(WINDOWS ? 'Saving your key for your Windows account…' : 'Saving your key in macOS Keychain. Approve a system prompt if shown.');
      await this.secrets.set(input.key);
      connected = true;
    }
    if (input.disconnect === true) {
      try { await this.clearCache(); } finally { await this.secrets.remove(); }
      connected = false;
    }
    const config = await this.config();
    for (const name of ['enabled', 'dashboardEnabled', 'allowAI']) if (input[name] !== undefined) { if (typeof input[name] !== 'boolean') throw new Error('Invalid Organato setting.'); config[name] = input[name]; }
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const temporary = join(this.directory, `organato-${randomUUID()}.tmp`);
    await writeFile(temporary, JSON.stringify(config), { mode: 0o600 });
    await rename(temporary, join(this.directory, 'organato.json'));
    return { ...config, connected: connected ?? !!await this.secrets.get() };
  }
  async request(path, method = 'GET', body, signal, suppliedKey) {
    const key = suppliedKey || await this.secrets.get();
    if (!key) throw new Error('Connect Organato in Breezer Settings first.');
    const timeout = AbortSignal.timeout(10_000);
    try {
      const response = await this.fetcher(BASE + path, { method, redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      if (!response.ok) throw Object.assign(new Error(({ 401: 'Organato API key is invalid or expired.', 403: 'This Organato key is read-only. Use a read/write key to change items.', 409: 'This item changed in Organato. Read it again before updating.', 429: 'Organato rate limit reached. Try again in a minute.' })[response.status] || `Organato request failed (${response.status}).`), { status: response.status });
      return JSON.parse(await responseText(response));
    } catch (error) {
      const connectionLost = error instanceof TypeError && ['fetch failed', 'terminated'].includes(error.message) && typeof error.cause?.code === 'string';
      if (connectionLost || (timeout.aborted && timeout.reason === error)) throw Object.assign(new Error(error.message, { cause: error }), { name: error.name, code: 'NETWORK_ERROR' });
      throw error;
    }
  }
  async list(signal, { onCached } = {}) {
    const generation = this.cacheGeneration, sequence = ++this.listSequence;
    const revision = await this.cacheRevision();
    const context = await this.dashboardContext();
    if (!context.config.enabled) throw new Error('Organato is switched off in Settings.');
    if (!context.key) throw new Error('Connect Organato in Breezer Settings first.');
    const validate = async () => {
      if (generation !== this.cacheGeneration || this.cacheHolds || signal?.aborted || (revision !== null && await this.cacheRevision() !== revision) || (await this.dashboardContext()).fingerprint !== context.fingerprint) throw Object.assign(new Error('Organato dashboard context changed.'), { code: 'DASHBOARD_CHANGED' });
    };
    await validate();
    if (onCached && context.config.dashboardEnabled) {
      const cached = await this.cachedList(context.key);
      await validate();
      if (cached) await onCached(cached);
    }
    try {
      const result = await this.collectList(signal, context.key, validate);
      const order = process.hrtime.bigint().toString();
      await validate();
      if (context.config.dashboardEnabled) await this.saveList(result, context.key, generation, sequence, revision, order);
      await validate();
      return result;
    } catch (error) {
      await validate();
      if (error.status === 401 || error.status === 403) await this.clearCache().catch(() => {});
      throw error;
    }
  }
  async collectList(signal, key, validate) {
    const items = []; let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this.request(`/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal, key);
      if (validate) await validate();
      if (!Array.isArray(result.items)) throw new Error('Invalid Organato response.');
      items.push(...result.items); cursor = result.nextCursor;
      if (!cursor) break;
    }
    return { items: items.map(item => ({ id: item.id, url: typeof item.id === 'string' && item.id ? `https://organato.vercel.app/items/${encodeURIComponent(item.id)}` : null, version: item.version, title: item.displayName, kind: item.kind, classification: item.classification, dueAt: item.dueAt, dueDateLocal: item.dueDateLocal, workingStatus: item.workingStatus, subjectId: item.subjectId })), truncated: !!cursor, syncedAt: new Date().toISOString() };
  }
  async tool(name, args, signal) {
    const config = await this.config(); if (!config.enabled || !config.allowAI) throw new Error('Organato AI access is off in Settings.');
    if (name === 'organato_list_items') return this.list(signal);
    if (!['organato_create_item', 'organato_update_item'].includes(name)) throw new Error('Unknown Organato action.');
    const update = name === 'organato_update_item'; validateItem(args, update);
    const { id, ...body } = args;
    const result = await this.request(update ? `/items/${encodeURIComponent(id)}` : '/items', update ? 'PATCH' : 'POST', body, signal);
    await this.clearCache().catch(() => {});
    return { ok: true, item: result.item };
  }
}
