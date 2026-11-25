import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWindowsCli, JsonLineProcess, runCli, windowsCliEnvironment } from '../../features/ai/host/cli.mjs';
import { CodexProvider } from '../../features/ai/host/codex.mjs';
import { ClaudeProvider } from '../../features/ai/host/claude.mjs';

const home = 'C:\\Users\\Fixture User';
const local = win32.join(home, 'AppData', 'Local');
const roaming = win32.join(home, 'AppData', 'Roaming');
const programFiles = 'D:\\Program Files';
const system = 'D:\\Windows';
const fixture = fileURLToPath(new URL('./fixtures/provider-cli.mjs', import.meta.url));

function discovery(files, env = {}) {
  const searched = [];
  return {
    searched,
    options: {
      home,
      env: { LOCALAPPDATA: local, APPDATA: roaming, ProgramFiles: programFiles, ...env },
      arch: 'x64',
      async resolvePath(candidate) {
        searched.push(candidate);
        if (!files.has(candidate)) throw Object.assign(new Error('Fixture did not exist.'), { code: 'ENOENT' });
        return files.get(candidate);
      },
      async fileInfo(candidate) { return { isFile: () => !candidate.includes('directory-instead-of-file') }; },
    },
  };
}

test('Windows discovery checks official Codex and Claude Code executables', async () => {
  const standalone = win32.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  const selected = win32.join(home, '.codex', 'packages', 'standalone', 'releases', '0.163.0-x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  const npm = win32.join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
  const npmClaude = win32.join(roaming, 'npm', 'node_modules', '@anthropic-ai', 'claude-code-win32-x64', 'claude.exe');
  const claude = win32.join(home, '.local', 'bin', 'claude.exe');
  const winget = win32.join(programFiles, 'WinGet', 'Packages', 'Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe', 'claude.exe');
  const wingetCodex = win32.join(local, 'Microsoft', 'WinGet', 'Packages', 'OpenAI.Codex_Microsoft.Winget.Source_8wekyb3d8bbwe', 'codex-x86_64-pc-windows-msvc.exe');
  for (const [name, path, target] of [
    ['codex', standalone, selected], ['codex', npm, npm], ['codex', wingetCodex, wingetCodex],
    ['claude', claude, claude.toUpperCase()], ['claude', npmClaude, npmClaude], ['claude', winget, winget],
  ]) {
    const { options } = discovery(new Map([[path, target]]));
    assert.equal(await findWindowsCli(name, options), target);
  }
});

test('Windows discovery ignores PATH, wrappers, and executables redirected outside an approved install', async () => {
  const codex = win32.join(local, 'Programs', 'OpenAI', 'Codex', 'bin', 'codex.exe');
  const claude = win32.join(home, '.local', 'bin', 'claude.exe');
  const { options, searched } = discovery(new Map([
    [codex, 'C:\\Temp\\codex.exe'],
    [claude, win32.join(local, 'Microsoft', 'WindowsApps', 'Claude.exe')],
    ['C:\\Temp\\claude.exe', 'C:\\Temp\\claude.exe'],
    [win32.join(roaming, 'npm', 'codex.cmd'), win32.join(roaming, 'npm', 'codex.cmd')],
    [win32.join(roaming, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'), 'C:\\Temp\\claude.exe'],
  ]), { PATH: '.;C:\\Temp', CODEX_HOME: 'C:\\Temp' });
  await assert.rejects(findWindowsCli('claude', options), /Windows Claude Code CLI/);
  await assert.rejects(findWindowsCli('codex', options), /Windows Codex CLI/);
  await assert.rejects(findWindowsCli('git', options), /Unknown provider/);
  assert.ok(searched.every((path) => /^[A-Z]:\\.+\.exe$/i.test(path)));
  assert.ok(searched.every((path) => !path.startsWith('C:\\Temp')));
});

test('Windows providers get the OS paths they need and a fixed search path', () => {
  const env = windowsCliEnvironment({
    APPDATA: roaming, LOCALAPPDATA: local, ProgramFiles: programFiles, SystemRoot: system,
    PATH: '.;C:\\Temp', ComSpec: 'C:\\Temp\\cmd.exe', ProgramData: 'C:\\Fake;D:\\Fake',
    NODE_OPTIONS: '--require injected', OPENAI_API_KEY: 'fixture', CLAUDE_CONFIG_DIR: 'C:\\Temp',
  }, home, 'D:\\Program Files\\Breezer\\ai\\node.exe', 'D:\\Temp Folder');
  assert.deepEqual(env, {
    APPDATA: roaming, LOCALAPPDATA: local, HOME: home, USERPROFILE: home,
    ProgramFiles: programFiles, SystemRoot: system, WINDIR: system, ComSpec: 'D:\\Windows\\System32\\cmd.exe',
    TEMP: 'D:\\Temp Folder', TMP: 'D:\\Temp Folder',
    PATH: 'D:\\Windows\\System32;D:\\Windows;D:\\Program Files\\Breezer\\ai',
    NoDefaultCurrentDirectoryInExePath: '1',
  });
});

const fixtureEnv = process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {};

test('CLI transport passes arguments literally and hides console windows', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'breezer CLI arguments '));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const argv = ['', 'C:\\User Folder\\', 'quote "and \\\\" backslashes', '雪🙂', '&|><%PATH%!^'];
  const result = await runCli(process.execPath, [fixture, 'echo', ...argv], {
    cwd: directory, env: fixtureEnv,
    spawnProcess(binary, args, options) {
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.ok(!options.windowsVerbatimArguments);
      return spawn(binary, args, options);
    },
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { argv, cwd: await realpath(directory) });
});

test('CLI discovery timeout and RPC cancellation reap the direct fixture process', { timeout: 10_000 }, async () => {
  let discoveryChild;
  let discoveryExited;
  await assert.rejects(runCli(process.execPath, [fixture, 'hang'], {
    timeout: 100, env: fixtureEnv,
    spawnProcess(...args) {
      discoveryChild = spawn(...args);
      discoveryExited = new Promise((resolve) => discoveryChild.once('close', resolve));
      return discoveryChild;
    },
  }), /CLI discovery timed out/);
  await discoveryExited;

  const rpc = new JsonLineProcess(process.execPath, [fixture, 'app-server'], { env: fixtureEnv });
  try {
    assert.deepEqual(await rpc.request('initialize'), {});
    const pending = assert.rejects(rpc.request('wait'), /Cancelled/);
    await rpc.close();
    await pending;
    assert.equal(rpc.child.signalCode, process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM');
    assert.ok(rpc.child.stdout.destroyed);
  } finally { await rpc.close(); }
});

test('Windows CLI transport rejects wrappers and drive-relative executables', { skip: process.platform !== 'win32' }, async () => {
  for (const binary of ['codex.exe', 'C:codex.exe', 'C:\\Fixture\\codex.cmd', 'C:\\Fixture\\codex.exe:alternate.exe']) {
    await assert.rejects(runCli(binary, [], { env: fixtureEnv }), /absolute Windows CLI executable/);
    assert.throws(() => new JsonLineProcess(binary, [], { env: fixtureEnv }), /absolute Windows CLI executable/);
  }
});

test('Windows Codex uses a dedicated CLI login and an unauthenticated loopback probe', { timeout: 15_000 }, async (t) => {
  const profile = await mkdtemp(join(tmpdir(), 'breezer fixture local app data '));
  t.after(() => rm(profile, { recursive: true, force: true }));
  const home = join(profile, 'Breezer', 'Codex');
  const binary = "C:\\Program Files\\Fixture's Codex\\codex.exe";
  const calls = [];
  const provider = new CodexProvider({
    platform: 'win32',
    environment: (extra) => ({ ...fixtureEnv, LOCALAPPDATA: profile, ...extra }),
    find: async () => binary,
    run(_binary, args, options) {
      assert.equal(options.env.CODEX_HOME, home);
      assert.notEqual(options.cwd, home);
      return runCli(process.execPath, [fixture, ...args], options);
    },
    createProcess(_binary, args, options) {
      calls.push({ args, options });
      return new JsonLineProcess(process.execPath, [fixture, ...args], options);
    },
  });
  const signedOut = await provider.discover();
  assert.equal(signedOut.available, true, signedOut.error);
  assert.equal(signedOut.authenticated, false);
  assert.match(signedOut.setup, /Breezer\\Codex/);
  assert.match(signedOut.setup, /Fixture''s Codex\\codex\.exe' login/);
  const configPath = join(home, 'config.toml');
  assert.match(await readFile(configPath, 'utf8'), /approval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"/);
  const authPath = join(home, 'auth.json');
  await writeFile(authPath, '{"fixture-only":true}');

  const signedIn = await provider.discover();
  assert.equal(signedIn.available, true, signedIn.error);
  assert.equal(signedIn.authenticated, true);
  assert.equal(signedIn.setup, undefined);

  const events = [];
  await provider.chat({ message: 'Fixture turn.' }, {
    signal: new AbortController().signal,
    emit: (event) => events.push(event),
    callTool: () => assert.fail('Unexpected browser tool.'),
  });
  assert.deepEqual(events, [{ type: 'delta', text: 'Fixture response.' }]);
  const probes = calls.filter(({ args }) => args.includes('model_provider="breezer_probe"'));
  assert.equal(probes.length, 3);
  for (const { options } of probes) {
    assert.notEqual(options.env.CODEX_HOME, home);
    await assert.rejects(access(options.env.CODEX_HOME), { code: 'ENOENT' });
  }
  for (const { args } of calls.filter(({ options }) => options.env.CODEX_HOME === home)) {
    assert.ok(args.includes('--strict-config'));
    assert.ok(args.some((arg) => arg.startsWith('model_catalog_json=')));
    assert.ok(args.some((arg) => arg.startsWith('features={') && arg.includes('"shell_tool" = false')));
  }
  assert.equal(await readFile(authPath, 'utf8'), '{"fixture-only":true}');

  await writeFile(configPath, 'approval_policy = "on-request"\n');
  assert.match((await provider.discover()).error, /changes to the config.toml/);
  assert.equal(await readFile(configPath, 'utf8'), 'approval_policy = "on-request"\n');
});

test('Claude chat cancelled before setup leaves the CLI unstarted', async () => {
  const provider = new ClaudeProvider({ createProcess: () => assert.fail('Cancelled chat started a CLI.') });
  provider.status = { available: true };
  provider.authenticated = true;
  provider.defaultModel = 'fixture';
  provider.models = [{ id: 'fixture' }];
  await assert.rejects(provider.chat({ message: 'Fixture turn.' }, { signal: AbortSignal.abort() }), /Cancelled/);
});
