import { spawn } from 'node:child_process';
import { access, realpath, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname, win32 } from 'node:path';
import { EventEmitter } from 'node:events';

const windows = process.platform === 'win32';
const posixDirectories = [dirname(process.execPath), join(homedir(), '.local/bin'), join(homedir(), '.local/node/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'];

function windowsPath(value) {
  if (typeof value !== 'string' || !/^[a-z]:[\\/]/i.test(value) || /[:;"<>|?*\x00-\x1f]/.test(value.slice(2))) return;
  return win32.normalize(value);
}

function windowsJoin(root, ...segments) {
  if (root) return win32.join(root, ...segments);
}

function windowsLocations(env, home) {
  const profile = windowsPath(home);
  return {
    profile,
    local: windowsPath(env.LOCALAPPDATA) ?? windowsJoin(profile, 'AppData', 'Local'),
    roaming: windowsPath(env.APPDATA) ?? windowsJoin(profile, 'AppData', 'Roaming'),
    system: windowsPath(env.SystemRoot),
    programFiles: windowsPath(env.ProgramFiles),
  };
}

export async function findWindowsCli(name, { env = process.env, home = homedir(), arch = process.arch, resolvePath = realpath, fileInfo = stat } = {}) {
  if (!['codex', 'claude'].includes(name)) throw new Error('Unknown provider.');
  const { profile, local, roaming, programFiles } = windowsLocations(env, home);
  const triple = arch === 'arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc';
  const packageId = name === 'codex' ? 'OpenAI.Codex' : 'Anthropic.ClaudeCode';
  const winGetPackage = packageId + '_Microsoft.Winget.Source_8wekyb3d8bbwe';
  const winGetBinary = name === 'codex' ? 'codex-' + triple + '.exe' : 'claude.exe';
  const portable = [
    windowsJoin(local, 'Microsoft', 'WinGet', 'Packages', winGetPackage, winGetBinary),
    windowsJoin(programFiles, 'WinGet', 'Packages', winGetPackage, winGetBinary),
  ];
  const standalone = windowsJoin(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  const releases = windowsJoin(profile, '.codex', 'packages', 'standalone', 'releases');
  const publisher = name === 'codex' ? '@openai' : '@anthropic-ai';
  const npmName = name === 'codex' ? 'codex' : 'claude-code';
  const npmScope = windowsJoin(roaming, 'npm', 'node_modules', publisher);
  const npmPackage = npmName + '-win32-' + arch;
  const nested = windowsJoin(npmScope, npmName, 'node_modules', publisher, npmPackage);
  const sibling = windowsJoin(npmScope, npmPackage);
  const npmBinaries = name === 'codex'
    ? [nested, sibling, windowsJoin(npmScope, npmName)].flatMap((root) =>
        ['bin', 'codex'].map((folder) => windowsJoin(root, 'vendor', triple, folder, 'codex.exe')))
    : [nested, sibling].map((root) => windowsJoin(root, 'claude.exe'));
  const native = name === 'codex' ? standalone : windowsJoin(profile, '.local', 'bin', 'claude.exe');
  const candidates = [native, ...npmBinaries, ...portable];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      const target = windowsPath(await resolvePath(candidate));
      if (!target) continue;
      if (candidate.toLowerCase() !== target.toLowerCase()) {
        // OpenAI's standalone installer selects a release through a directory junction.
        const release = releases && win32.relative(releases, target).split('\\');
        if (candidate !== standalone || !release || !/^\d+\.\d+\.\d+(?:-[\w.]+)?-(?:x86_64|aarch64)-pc-windows-msvc$/i.test(release[0])
          || !['codex.exe', 'bin\\codex.exe'].includes(release.slice(1).join('\\').toLowerCase())) continue;
      }
      if ((await fileInfo(target)).isFile()) return target;
    } catch {}
  }
  throw new Error(name === 'codex'
    ? 'Codex CLI was not found. Install the Windows Codex CLI with the OpenAI installer, npm, or WinGet, then refresh.'
    : 'Claude Code CLI was not found. Install the Windows Claude Code CLI with the Anthropic installer, npm, or WinGet and sign in from PowerShell, then refresh.');
}

export async function findCli(name) {
  if (windows) return findWindowsCli(name);
  if (!['codex', 'claude'].includes(name)) throw new Error('Unknown provider.');
  for (const directory of posixDirectories) {
    const path = join(directory, name);
    try { await access(path, constants.X_OK); return path; } catch {}
  }
  throw new Error(`${name === 'codex' ? 'Codex' : 'Claude Code'} CLI was not found. Install it and sign in from Terminal.`);
}

export function windowsCliEnvironment(env, home, execPath, temp) {
  const { profile, local, roaming, system, programFiles } = windowsLocations(env, home);
  const system32 = windowsJoin(system, 'System32');
  const executable = windowsPath(execPath);
  const tempDirectory = windowsPath(temp) ?? windowsJoin(local, 'Temp');
  const values = {
    HOME: profile, USERPROFILE: profile, LOCALAPPDATA: local, APPDATA: roaming,
    ProgramFiles: programFiles, ProgramData: windowsPath(env.ProgramData),
    SystemRoot: system, WINDIR: system, ComSpec: windowsJoin(system32, 'cmd.exe'),
    TEMP: tempDirectory, TMP: tempDirectory,
    PATH: [system32, system, executable && win32.dirname(executable)].filter(Boolean).join(';'),
    NoDefaultCurrentDirectoryInExePath: '1',
  };
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

export function cliEnvironment(extra = {}) {
  const env = windows
    ? windowsCliEnvironment(process.env, homedir(), process.execPath, tmpdir())
    : { HOME: homedir(), PATH: posixDirectories.join(':'), LANG: process.env.LANG || 'en_US.UTF-8', TMPDIR: process.env.TMPDIR || '/tmp' };
  const inherited = ['HTTPS_PROXY', 'HTTP_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR'];
  if (!windows) inherited.push('USER', 'LOGNAME', 'ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY');
  for (const key of inherited) if (process.env[key]) env[key] = process.env[key];
  return { ...env, ...extra };
}

function spawnCli(spawnProcess, binary, args, cwd, env) {
  if (windows && (!windowsPath(binary) || win32.extname(binary).toLowerCase() !== '.exe')) {
    throw new Error('Expected an absolute Windows CLI executable path.');
  }
  return spawnProcess(binary, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], shell: false, windowsHide: true });
}

function terminateWindows(child) {
  child.kill('SIGKILL');
  // A descendant may still hold a pipe after the direct child exits. The native
  // launcher's Job Object owns those descendants until the host disconnects.
  child.stdin.destroy();
  child.stdout.destroy();
  child.stderr.destroy();
}

export function runCli(binary, args, { timeout = 20_000, env = cliEnvironment(), cwd = homedir(), spawnProcess = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnCli(spawnProcess, binary, args, cwd, env);
    let stdout = '', stderr = '';
    const stop = () => windows ? terminateWindows(child) : child.kill('SIGKILL');
    const timer = setTimeout(() => { stop(); reject(new Error('CLI discovery timed out.')); }, timeout);
    child.stdout.on('data', (data) => { stdout += data; if (stdout.length > 16 * 1024 * 1024) stop(); });
    child.stderr.on('data', (data) => { stderr = (stderr + data).slice(-4000); });
    child.stdin.on('error', (error) => { if (error.code !== 'EPIPE') reject(error); });
    child.on('error', (error) => { clearTimeout(timer); reject(error); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ stdout, stderr, code }); });
    child.stdin.end();
  });
}

export class JsonLineProcess extends EventEmitter {
  static #outputTurn;
  static get outputTurn() { return this.#outputTurn; }
  #buffer = '';
  #pending = new Map();
  #counter = 0;
  closed = false;
  constructor(binary, args, { cwd = homedir(), env = cliEnvironment(), spawnProcess = spawn } = {}) {
    super();
    this.child = spawnCli(spawnProcess, binary, args, cwd, env);
    this.exited = new Promise((resolve) => this.child.once('close', resolve));
    this.child.stdout.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => {
      const previous = JsonLineProcess.#outputTurn;
      previous?.flush();
      const turn = { message: undefined, flushers: new Set(), flush: (next) => {
        for (const flush of turn.flushers) {
          try { flush(next); }
          catch (error) { this.close(new Error(`Invalid CLI response: ${error.message}`)); }
        }
      } };
      JsonLineProcess.#outputTurn = turn;
      try {
        const prefixLength = this.#buffer.length;
        this.#buffer += chunk;
        if (this.#buffer.length > 16 * 1024 * 1024) return this.close(new Error('CLI output exceeded its limit.'));
        // Search the arriving chunk before touching the accumulated string rope.
        // Once a newline arrives, slicing/parsing materializes that line only once.
        let index = chunk.indexOf('\n');
        if (index !== -1) index += prefixLength;
        for (; index !== -1; index = this.#buffer.indexOf('\n')) {
          const line = this.#buffer.slice(0, index); this.#buffer = this.#buffer.slice(index + 1);
          if (!line.trim()) continue;
          try {
            const message = JSON.parse(line);
            turn.message = message;
            turn.flush(message);
            const key = message.id ?? message.response?.request_id;
            const pending = this.#pending.get(key);
            if (pending && (!message.method || message.type === 'control_response')) {
              clearTimeout(pending.timer); this.#pending.delete(key);
              if (message.error || message.response?.subtype === 'error') pending.reject(new Error(message.error?.message || message.response?.error || 'CLI request failed.'));
              else pending.resolve(message.result ?? message.response?.response);
            } else this.emit('message', message);
          } catch (error) { this.close(new Error(`Invalid CLI response: ${error.message}`)); }
        }
      } finally {
        try { turn.flush(); }
        finally { JsonLineProcess.#outputTurn = previous; }
      }
    });
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', (error) => this.close(error));
    this.child.on('error', (error) => this.close(error));
    this.child.on('close', () => {
      this.#buffer = '';
      this.close(new Error('CLI connection closed.'));
    });
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
    JsonLineProcess.#outputTurn?.flush();
    for (const pending of this.#pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.#pending.clear();
    if (windows) terminateWindows(this.child);
    else {
      this.child.kill('SIGTERM');
      const child = this.child;
      const timer = setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 1000); timer.unref();
    }
    this.emit('closed', error);
    return this.exited;
  }
}
