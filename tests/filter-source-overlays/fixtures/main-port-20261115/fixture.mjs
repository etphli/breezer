import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const fixture = fileURLToPath(new URL('./', import.meta.url));
export const work = execFileSync('python3', ['-B', join(fixture, 'prepare.py')],
  { encoding: 'utf8', timeout: 10000, maxBuffer: 65536 }).trim();
export const manifest = JSON.parse(readFileSync(join(fixture, 'manifest.json'), 'utf8'));
export const root = arm => join(work, arm, 'third_party/ublock/js');
