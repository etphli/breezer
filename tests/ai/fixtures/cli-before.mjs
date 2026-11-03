import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { EventEmitter } from 'node:events';

export const safeDirectories = [dirname(process.execPath), join(homedir(), '.local/bin'), join(homedir(), '.local/node/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];
export async function findCli(name) {
  if (!['codex', 'claude'].includes(name)) throw new Error('Unknown provider.');
  for (const directory of safeDirectories) {
    const path = join(directory, name);
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  throw new Error(`${name === 'codex' ? 'Codex' : 'Claude Code'} CLI was not found. Install it and sign in from Terminal.`);
}

export function cliEnvironment(extra = {}) {
  const env = { HOME: homedir(), PATH: safeDirectories.join(':'), LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp' };
  for (const key of ['USER', 'LOGNAME', 'HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY']) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}

export function runCli(binary, args, { timeout = 20_000, env = cliEnvironment(), cwd = homedir(), spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnProcess(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error('CLI discovery timed out.')); }, timeout);
    child.stdout.on('data', (data) => { stdout += data; if (stdout.length > 16 * 1024 * 1024) child.kill('SIGKILL'); });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.stdin.end();
  });
}

export class JsonLineProcess extends EventEmitter {
  #buffer = '';
  #pending = new Map();
  #counter = 0;
  closed = false;
  constructor(binary, args, { cwd = homedir(), env = cliEnvironment(), spawnProcess = spawn } = {}) {
    super();
    this.child = spawnProcess(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false });
    this.exited = new Promise((resolve) => this.child.once('close', resolve));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      this.#buffer += chunk;
      if (this.#buffer.length > 16 * 1024 * 1024) return this.close(new Error('CLI output exceeded its limit.'));
      let index;
      while ((index = this.#buffer.indexOf('\n')) !== -1) {
        const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          const key = message.id ?? message.response?.request_id;
          const pending = this.#pending.get(key);
          if (pending && (!message.method || message.type === 'control_response')) {
            clearTimeout(pending.timer); this.#pending.delete(key);
            if (message.error || message.response?.subtype === 'error') pending.reject(new Error(message.error?.message || message.response?.error || 'CLI request failed.'));
            else pending.resolve(message.result ?? message.response?.response);
          } else this.emit('message', message);
        } catch (error) { this.close(new Error(`Invalid CLI response: ${error.message}`)); }
      }
    });
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', (error) => this.close(error));
    this.child.on('error', (error) => this.close(error));
    this.child.on('close', () => this.close(new Error('CLI connection closed.')));
  }
  send(message) {
    if (this.closed) throw new Error('CLI connection is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }
  request(method, params = {}, timeout = 30_000) {
    const id = ++this.#counter;
    return this.#wait(id, { id, method, params }, timeout);
  }
  control(request, timeout = 30_000) {
    const id = `breezer-${++this.#counter}`;
    return this.#wait(id, { type: 'control_request', request_id: id, request }, timeout);
  }
  #wait(id, message, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(id); reject(new Error('CLI request timed out.')); }, timeout);
      this.#pending.set(id, { resolve, reject, timer });
      try { this.send(message); } catch (error) { clearTimeout(timer); this.#pending.delete(id); reject(error); }
    });
  }
  close(error = new Error('Cancelled.')) {
    if (this.closed) return this.exited;
    this.closed = true;
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    this.child.kill('SIGTERM');
    const child = this.child;
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000); timer.unref();
    this.emit('closed', error);
    return this.exited;
  }
}
