import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserTools } from '../../features/ai/extension/browser-tools.js';
import { allowedTools, validateTool } from '../../features/ai/host/protocol.mjs';
import { fakeChrome } from './browser-api-fixture.mjs';

test('browser scrolling uses the maximum advertised by the model schema', async () => {
  const schemas = allowedTools({ control: true });
  const { maximum } = schemas.find(tool => tool.name === 'browser_scroll').inputSchema.properties.amount;
  const fake = fakeChrome();
  const tools = new BrowserTools(fake.api);
  tools.authorize(fake.tab);
  const session = await tools.start('scroll', fake.tab);
  try {
    const args = validateTool('browser_scroll', { direction: 'down', amount: maximum }, schemas);
    await tools.execute(session, 'browser_scroll', args);
    await tools.execute(session, 'browser_scroll', { direction: 'up', amount: maximum + 1 });
    const wheels = fake.calls.filter(call => call[0] === 'input' && call[3].type === 'mouseWheel');
    assert.deepEqual(wheels.map(call => call[3].deltaY), [maximum, -maximum]);
  } finally {
    await tools.stop();
  }
});
