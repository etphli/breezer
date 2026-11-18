import { after } from 'node:test';
import { mkdtempSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function organatoTestDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'breezer-organato-unit-'));
  after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
