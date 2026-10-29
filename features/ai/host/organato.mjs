import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
const BASE = 'https://organato.etphli.workers.dev/api/v1';
const SERVICE = 'io.github.etphli.breezer.organato';
const CONFIG = join(homedir(), 'Library/Application Support/io.github.etphli.breezer-integrations');
const keyPattern = /^org_[A-Za-z0-9_-]{43}$/;
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
  if (input.dueDateLocal !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(input.dueDateLocal) || new Date(input.dueDateLocal).toISOString().slice(0, 10) !== input.dueDateLocal)) throw new Error('Use a valid YYYY-MM-DD deadline.');
  if (input.notesMarkdown !== undefined && (typeof input.notesMarkdown !== 'string' || input.notesMarkdown.length > 20_000)) throw new Error('Notes are too long.');
  if (input.workingStatus !== undefined && !['not_started', 'in_progress', 'submitted', 'completed'].includes(input.workingStatus)) throw new Error('Invalid work status.');
  if (update && (!/^[a-zA-Z0-9_-]{1,100}$/.test(input.id) || !Number.isInteger(input.version) || input.version < 1)) throw new Error('Read the current item and version before updating it.');
  return input;
}
export class Organato {
  constructor({ fetcher = fetch, secrets = keychain, configDirectory = CONFIG } = {}) { this.fetcher = fetcher; this.secrets = secrets; this.directory = configDirectory; }
  async config() { try { return { enabled: true, dashboardEnabled: true, allowAI: true, ...JSON.parse(await readFile(join(this.directory, 'organato.json'), 'utf8')) }; } catch { return { enabled: true, dashboardEnabled: true, allowAI: true }; } }
  async view() { return { ...await this.config(), connected: !!await this.secrets.get() }; }
  configure(input, progress = () => {}) {
    const operation = (this.configurationQueue || Promise.resolve()).then(() => this.configureNow(input, progress));
    this.configurationQueue = operation.catch(() => {});
    return operation;
  }
  async configureNow(input, progress) {
    let connected;
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid Organato settings.');
    for (const name of ['enabled', 'dashboardEnabled', 'allowAI']) {
      if (input[name] !== undefined && typeof input[name] !== 'boolean') throw new Error('Invalid Organato setting.');
    }
    if (input.key !== undefined) {
      if (!keyPattern.test(input.key)) throw new Error('Enter a valid Organato API key.');
      progress('Checking your Organato key…');
      await this.request('/items?limit=1', 'GET', undefined, undefined, input.key);
      progress('Saving your key in macOS Keychain. Approve a system prompt if shown.');
      await this.secrets.set(input.key);
      connected = true;
    }
    if (input.disconnect === true) { await this.secrets.remove(); connected = false; }
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
    const response = await this.fetcher(BASE + path, { method, redirect: 'error', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10_000)]) : AbortSignal.timeout(10_000) });
    if (!response.ok) throw new Error(({ 401: 'Organato API key is invalid or expired.', 403: 'This Organato key is read-only. Use a read/write key to change items.', 409: 'This item changed in Organato. Read it again before updating.', 429: 'Organato rate limit reached. Try again in a minute.' })[response.status] || `Organato request failed (${response.status}).`);
    const text = await response.text(); if (text.length > 2_000_000) throw new Error('Organato response is too large.'); return JSON.parse(text);
  }
  async list(signal) {
    const config = await this.config(); if (!config.enabled) throw new Error('Organato is switched off in Settings.');
    const items = []; let cursor;
    for (let page = 0; page < 10; page++) {
      const result = await this.request(`/items?limit=200${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`, 'GET', undefined, signal);
      if (!Array.isArray(result.items)) throw new Error('Invalid Organato response.');
      items.push(...result.items); cursor = result.nextCursor;
      if (!cursor) break;
    }
    return { items: items.map(item => ({ id: item.id, version: item.version, title: item.displayName, kind: item.kind, classification: item.classification, dueAt: item.dueAt, dueDateLocal: item.dueDateLocal, workingStatus: item.workingStatus, subjectId: item.subjectId })), truncated: !!cursor };
  }
  async tool(name, args, signal) {
    const config = await this.config(); if (!config.enabled || !config.allowAI) throw new Error('Organato AI access is off in Settings.');
    if (name === 'organato_list_items') return this.list(signal);
    if (!['organato_create_item', 'organato_update_item'].includes(name)) throw new Error('Unknown Organato action.');
    const update = name === 'organato_update_item'; validateItem(args, update);
    const { id, ...body } = args;
    const result = await this.request(update ? `/items/${encodeURIComponent(id)}` : '/items', update ? 'PATCH' : 'POST', body, signal);
    return { ok: true, item: result.item };
  }
}
