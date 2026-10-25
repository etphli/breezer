// Read-only CLI settings probe. All model turns terminate at a local HTTP fixture.
import assert from 'node:assert/strict';
import { CodexProvider, codexTurnOptions, expectedCodexApiEffort } from '../../features/ai/host/codex.mjs';
import { ClaudeProvider, claudeSafeArgs } from '../../features/ai/host/claude.mjs';
import { JsonLineProcess } from '../../features/ai/host/cli.mjs';
import { allowedTools } from '../../features/ai/host/protocol.mjs';

const codex = new CodexProvider();
const codexStatus = await codex.discover();
assert.ok(codexStatus.available, codexStatus.error);
const model = codex.models.find((entry) => entry.id === codex.defaultModel);
for (const reasoning of ['high', 'ultra'].filter((effort) => model.reasoningEfforts.includes(effort))) {
  for (const speed of model.speeds) {
    const isolation = await codex.isolate({ fast: speed === 'fast' });
    try {
      const options = codexTurnOptions({ reasoning, speed }, model);
      const wire = await codex.preflight(isolation, model.id, allowedTools({ control: true }), options);
      assert.equal(wire.effort, expectedCodexApiEffort(codex.catalog, model.id, reasoning));
      assert.equal(wire.serviceTier, speed === 'fast' ? model.fastMode.serviceTier : 'default');
      console.log(JSON.stringify({ provider: 'codex', model: model.id, selected: { reasoning, speed }, wire, browserToolsOnly: true, accountFastEligibility: 'unknown' }));
    } finally { await isolation.cleanup(); }
  }
}

const claude = new ClaudeProvider();
const claudeStatus = await claude.discover();
assert.ok(claudeStatus.available, claudeStatus.error);
const claudeModel = claude.models.find((entry) => entry.id === claude.defaultModel);
const effort = claudeModel.reasoningEfforts.includes('high') ? 'high' : claudeModel.reasoningEfforts[0];
assert.ok(effort, 'Claude did not report reasoning support.');
const rpc = new JsonLineProcess(claude.binary, [...claudeSafeArgs, '--model', claudeModel.id, '--effort', effort]);
try {
  const initialized = await rpc.control({ subtype: 'initialize' });
  assert.ok(initialized.models.some((entry) => entry.resolvedModel === claudeModel.id));
  console.log(JSON.stringify({ provider: 'claude', model: claudeModel.id, selectedEffort: effort, cliArgumentAccepted: true, paidInferenceSent: false }));
} finally { await rpc.close(); }
