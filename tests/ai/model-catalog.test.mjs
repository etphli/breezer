import test from 'node:test';
import assert from 'node:assert/strict';
import { latestModels } from '../../features/ai/extension/model-catalog.js';
import { CodexProvider, selectCodexCatalog } from '../../features/ai/host/codex.mjs';

function cliCatalog(models) {
  return { code: 0, stdout: JSON.stringify({ models }) };
}

test('Codex prefers its refreshed CLI catalog and retains its restricted tool settings', () => {
  const bundled = cliCatalog([{ slug: 'gpt-6.1-sol', shell_type: 'unified_exec' }]);
  const refreshed = cliCatalog([
    { slug: 'gpt-6.1-sol', shell_type: 'unified_exec' },
    { slug: 'gpt-6.1-terra', shell_type: 'unified_exec' },
  ]);
  const selected = selectCodexCatalog(refreshed, bundled);

  assert.equal(selected.source, 'refreshed');
  assert.deepEqual(selected.catalog.models.map((model) => model.slug), ['gpt-6.1-sol', 'gpt-6.1-terra']);
  assert.equal(selected.catalog.models[1].shell_type, 'disabled');
});

test('Codex falls back to a valid bundled catalog only when refresh has no usable catalog', () => {
  const bundled = cliCatalog([{ slug: 'gpt-6-astra' }]);
  assert.equal(selectCodexCatalog({ code: 1, stdout: '' }, bundled).source, 'bundled');
  assert.equal(selectCodexCatalog({ code: 0, stdout: '{invalid' }, bundled).source, 'bundled');
  assert.throws(() => selectCodexCatalog({ code: 1, stdout: '' }, { code: 0, stdout: '{}' }), /model catalog/);
});

test('Codex discovery requests the refreshed catalog and intersects it with account models', async () => {
  const commands = [];
  const provider = new CodexProvider({
    find: async () => '/fixed/codex',
    run: async (_binary, args) => {
      commands.push(args);
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli test\n' };
      if (args[0] === 'features') return { code: 0, stdout: 'shell_tool\nplugins\nview_image\n' };
      if (args[0] === 'debug') return cliCatalog([{ slug: 'gpt-6.1-terra' }]);
      throw new Error('Unexpected Codex command.');
    },
  });
  provider.isolate = async () => ({ cleanup: async () => {} });
  provider.start = async () => ({
    request: async (method) => method === 'account/read'
      ? { account: { type: 'chatgpt' } }
      : { data: [{ model: 'gpt-6.1-terra', displayName: 'GPT-6.1 Terra' }] },
    close: async () => {},
  });
  provider.preflight = async () => {};

  const status = await provider.discover();
  assert.equal(status.available, true, status.error);
  assert.deepEqual(status.models.map((model) => model.id), ['gpt-6.1-terra']);
  assert.deepEqual(commands.find((args) => args[0] === 'debug'), ['debug', 'models']);
  assert.equal(commands.some((args) => args.includes('--bundled')), false);
});

test('latest GPT models are selected by family and numeric version, with unknown IDs preserved', () => {
  const models = [
    { id: 'gpt-5.6-sol' },
    { id: 'gpt-6-sol' },
    { id: 'gpt-6.10-sol' },
    { id: 'gpt-6.10-terra' },
    { id: 'gpt-6-astra' },
    { id: 'account-custom-model' },
    { id: 'gpt-8.2-sol-preview' },
    { id: 'gpt-6.10-sol-latest' },
    { id: 'gpt-6.10-sol' },
  ];

  assert.deepEqual(latestModels(models), [
    models[2], models[3], models[4], models[5], models[6],
  ]);
});

test('latest Claude release is selected per family and later dated aliases win ties', () => {
  const models = [
    { id: 'claude-4-6-opus-20250601' },
    { id: 'claude-opus-5-4' },
    { id: 'claude-5.5-opus' },
    { id: 'claude-sonnet-5-4' },
    { id: 'claude-5.5-sonnet' },
    { id: 'claude-haiku-4-6' },
    { id: 'claude-5.5-haiku' },
    { id: 'claude-code' },
  ];

  assert.deepEqual(latestModels(models), [models[2], models[4], models[6], models[7]]);
  assert.deepEqual(latestModels([
    { id: 'claude-3-7-sonnet-20250219' },
    { id: 'claude-3-7-sonnet-20250301' },
  ]).map((model) => model.id), ['claude-3-7-sonnet-20250301']);
});

test('explicit aliases collapse to a canonical model and duplicate IDs appear once', () => {
  const alias = { id: 'gpt-7.3-sol-latest' };
  const canonical = { id: 'gpt-7.3-sol' };
  const unknown = { id: 'codex-auto-review' };
  assert.deepEqual(latestModels([alias, canonical, unknown, { ...unknown }]), [canonical, unknown]);
  assert.deepEqual(latestModels(null), []);
});
