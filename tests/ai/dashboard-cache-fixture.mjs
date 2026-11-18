import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';

// Exercise the private factory in the packaged background resource. Keeping it
// there avoids adding a 51st resource to the native allocation of 50.
const background = readFileSync(new URL('../../features/ai/extension/background.js', import.meta.url), 'utf8');
const boundary = background.indexOf('\nimport ');
assert.ok(boundary > 0, 'Background cache factory boundary is missing');
const factory = background.slice(0, boundary);
assert.ok(factory.startsWith('const createDashboardCache = (() => {'));
export const dashboardCacheWithEncoder = Encoder => runInNewContext(factory + '\ncreateDashboardCache;', { TextEncoder: Encoder });
export const createDashboardCache = dashboardCacheWithEncoder(TextEncoder);
