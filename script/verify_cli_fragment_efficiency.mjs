import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { PassThrough, Writable } from 'node:stream';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';

export const receiptPath = new URL('../build/efficiency-20261103/cli-fragment-implementation.json', import.meta.url);
export const baselinePath = new URL('../tests/ai/fixtures/cli-before.mjs', import.meta.url);
export const sourcePath = new URL('../features/ai/host/cli.mjs', import.meta.url);
export const sha256 = source => createHash('sha256').update(source).digest('hex');
export async function sources() {
  const baseline = await readFile(baselinePath, 'utf8');
  if (sha256(baseline) !== '64088b181aed86f5aab9991a61474878e05d586726a2477aed20a37982ca1c4b') throw new Error('Baseline hash mismatch');
  return { baseline, current: await readFile(sourcePath, 'utf8') };
}

// Execute the actual class source with fixture timers and injected child streams.
// Counters measure indexOf input lengths, not engine comparisons, copies or RSS.
export function fixture(source, constructorOverride) {
  const timers = new Map(), counts = { searches: 0, searchInputUnits: 0 }, writes = [], events = [], kills = [];
  let timerId = 0;
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
  child.stdin = new Writable({ write(chunk, _encoding, callback) { writes.push(JSON.parse(String(chunk))); callback(); } });
  child.kill = signal => { kills.push(signal); return true; };
  const context = vm.createContext({ EventEmitter, counts,
    setTimeout(callback, delay) { const timer = { id: ++timerId, callback, delay, unref() {} }; timers.set(timer.id, timer); return timer; },
    clearTimeout(timer) { if (timer) timers.delete(timer.id); },
  });
  vm.runInContext(`const originalIndexOf = String.prototype.indexOf;
    String.prototype.indexOf = function(search, offset) {
      if (search === '\\n') { counts.searches++; counts.searchInputUnits += this.length - (offset ?? 0); }
      return originalIndexOf.call(this, search, offset);
    };`, context);
  let classSource = source.slice(source.indexOf('export class JsonLineProcess')).replace('export class', 'class');
  classSource = classSource.replace('  send(message) {', '  retainedFixtureUnits() { return this.#buffer.length; }\n  send(message) {');
  const Constructor = constructorOverride ?? vm.runInContext(`${classSource}\nJsonLineProcess`, context);
  const rpc = new Constructor('/synthetic-only', [], { env: {}, cwd: '/synthetic-only', spawnProcess: () => child });
  rpc.on('message', message => events.push(['message', JSON.parse(JSON.stringify(message))]));
  rpc.on('closed', error => events.push(['closed', error.message]));
  return { rpc, child, counts, writes, events, kills, timers,
    push(chunk) { child.stdout.write(chunk); },
    exit() { child.exitCode = 0; child.emit('close', 0); },
    fire(delay) { for (const [id, timer] of timers) if (timer.delay === delay) { timers.delete(id); timer.callback(); } },
    dispose() { child.exitCode = 0; child.emit('close', 0); timers.clear(); child.stdout.destroy(); child.stderr.destroy(); child.stdin.destroy(); },
  };
}

export function probe(source, { units = 1024 * 1024, chunkSize = 1024, shortLines = 0 } = {}) {
  const f = fixture(source);
  const line = shortLines ? '{"v":1}\n' : `${JSON.stringify({ text: 'x'.repeat(units) })}\n`;
  const start = performance.now();
  if (shortLines) for (let i = 0; i < shortLines; i++) f.push(line);
  else for (let i = 0; i < line.length; i += chunkSize) f.push(line.slice(i, i + chunkSize));
  const elapsedMs = performance.now() - start;
  const result = { ...f.counts, elapsedMs, messages: f.events.length, retainedUnits: f.rpc.retainedFixtureUnits(), inputUnits: shortLines ? line.length * shortLines : line.length };
  f.dispose(); return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const source = await sources();
  const output = { runtime: process.version, fixtureHarnessSha256: sha256(await readFile(new URL(import.meta.url), 'utf8')), baselineSha256: sha256(source.baseline), currentSha256: sha256(source.current), fixtures: {} };
  for (const [name, options] of Object.entries({ fragmented1MiB: {}, fragmentedNearLimit: { units: 16 * 1024 * 1024 - 12, chunkSize: 1024 }, shortLines: { shortLines: 30000 } })) {
    output.fixtures[name] = { baseline: probe(source.baseline, options), current: probe(source.current, options) };
  }
  // Alternate order after warmup to make the ordinary-line comparison reviewable.
  output.shortLineSamples = [];
  for (let i = 0; i < 8; i++) {
    const row = {};
    for (const kind of i % 2 ? ['current', 'baseline'] : ['baseline', 'current']) row[kind] = probe(source[kind], { shortLines: 30000 }).elapsedMs;
    output.shortLineSamples.push(row);
  }
  if (process.argv.includes('--record')) {
    let receipt = {};
    try { receipt = JSON.parse(await readFile(receiptPath, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    await mkdir(new URL('.', receiptPath), { recursive: true });
    await writeFile(receiptPath, JSON.stringify({ ...receipt, baselineSource: source.baseline, baselineSha256: sha256(source.baseline), measurement: output }, null, 2) + '\n');
  }
  console.log(JSON.stringify(output, null, 2));
}
