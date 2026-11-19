import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BLOB = 4096;
const START_TIMEOUT = 10_000;
export const keyPattern = /^org_[A-Za-z0-9_-]{43}$/;

function powerShell(script) {
  const root = process.env.SystemRoot;
  if (!root || !/^[A-Za-z]:[\\/]/.test(root)) throw new Error('Windows PowerShell is unavailable.');
  // Only fixed code goes in the command line. Data goes on the inherited pipes.
  const command = Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, 'utf16le').toString('base64');
  const child = spawn(join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', command,
  ], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  child.stdin.on('error', () => {});
  return child;
}

async function crypt(operation, data) {
  const child = powerShell(`
    Add-Type -AssemblyName System.Security
    $pipeIn = [Console]::OpenStandardInput()
    $buffer = [byte[]]::new(${MAX_BLOB + 1})
    $length = 0
    while ($length -lt $buffer.Length) {
      $read = $pipeIn.Read($buffer, $length, $buffer.Length - $length)
      if ($read -eq 0) { break }
      $length += $read
    }
    if ($length -eq 0 -or $length -gt ${MAX_BLOB}) { exit 1 }
    $bytes = [byte[]]::new($length)
    [Array]::Copy($buffer, $bytes, $length)
    $result = [Security.Cryptography.ProtectedData]::${operation}($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    $pipeOut = [Console]::OpenStandardOutput()
    $pipeOut.Write($result, 0, $result.Length)
    $pipeOut.Flush()
  `);
  return new Promise((resolve, reject) => {
    const unavailable = () => new Error('Could not access Windows data protection for Organato.');
    const chunks = [];
    let size = 0;
    const timer = setTimeout(() => { child.kill(); reject(unavailable()); }, START_TIMEOUT);
    child.stdout.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BLOB) child.kill();
      else chunks.push(chunk);
    });
    child.once('error', () => reject(unavailable()));
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0 && size > 0 && size <= MAX_BLOB) resolve(Buffer.concat(chunks, size));
      else reject(unavailable());
    });
    child.stdin.end(data);
  });
}

// Read at most one bounded blob, even if another process replaces the file.
async function readBlob(path) {
  const file = await open(path, 'r');
  try {
    const buffer = Buffer.alloc(MAX_BLOB + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size);
      if (!bytesRead) return buffer.subarray(0, size);
      size += bytesRead;
    }
    throw new Error('Invalid Windows Organato credential file.');
  } finally {
    await file.close();
  }
}

export function windowsSecrets(directory, transform = crypt) {
  const path = join(directory, 'organato-key.dpapi');
  let cached;
  return {
    async get() {
      try {
        const blob = await readBlob(path);
        if (!cached?.blob.equals(blob)) {
          // Compare disk bytes on every read so a second helper can rotate or remove the key.
          const key = transform('Unprotect', blob).then(bytes => {
            const value = bytes.toString('latin1');
            return keyPattern.test(value) ? value : null;
          }).catch(() => null);
          cached = { blob, key };
        }
        const loaded = cached;
        const key = await loaded.key;
        if (!key && cached === loaded) cached = undefined;
        return key;
      } catch {
        cached = undefined;
        return null;
      }
    },
    async set(key) {
      if (typeof key !== 'string' || !keyPattern.test(key)) throw new Error('Enter a valid Organato API key.');
      const blob = await transform('Protect', Buffer.from(key, 'ascii'));
      await mkdir(directory, { recursive: true });
      const temporary = join(directory, `organato-key-${randomUUID()}.tmp`);
      const file = await open(temporary, 'wx');
      try {
        try {
          await file.writeFile(blob);
          await file.sync();
        } finally {
          await file.close();
        }
        await rename(temporary, path);
      } finally {
        await rm(temporary, { force: true });
      }
      cached = { blob, key: Promise.resolve(key) };
    },
    async remove() {
      await rm(path, { force: true });
      cached = undefined;
    },
  };
}

// An exclusive Windows file handle releases on EOF or when the lock holder exits.
export async function withWindowsCacheLock(path, action) {
  const child = powerShell(`
    $reader = [IO.StreamReader]::new([Console]::OpenStandardInput(), [Text.Encoding]::UTF8)
    $path = $reader.ReadLine()
    $watch = [Diagnostics.Stopwatch]::StartNew()
    while ($true) {
      try {
        $lock = [IO.File]::Open($path, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
        break
      } catch {
        $errorCode = $_.Exception.GetBaseException().HResult -band 0xffff
        if (($errorCode -ne 32 -and $errorCode -ne 33) -or $watch.ElapsedMilliseconds -ge 3000) { throw }
        Start-Sleep -Milliseconds 25
      }
    }
    try {
      $pipeOut = [Console]::OpenStandardOutput()
      $pipeOut.WriteByte(1)
      $pipeOut.Flush()
      [void]$reader.Read()
    } finally {
      $lock.Dispose()
    }
  `);
  const unavailable = () => new Error('Organato cache lock unavailable.');
  const closed = new Promise(resolve => child.once('close', resolve));
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(unavailable()), START_TIMEOUT);
      child.once('error', () => reject(unavailable()));
      child.once('close', () => { clearTimeout(timer); reject(unavailable()); });
      child.stdout.once('data', chunk => {
        clearTimeout(timer);
        if (chunk.length === 1 && chunk[0] === 1) resolve();
        else reject(unavailable());
      });
      child.stdin.write(`${path}\n`);
    });
    return await action();
  } finally {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), START_TIMEOUT);
    await closed;
    clearTimeout(timer);
  }
}
