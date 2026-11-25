import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const line = (message) => process.stdout.write(JSON.stringify(message) + '\r\n');
const fixtureModel = 'gpt-6.1-sol';

if (args[0] === 'echo') line({ argv: args.slice(1), cwd: process.cwd() });
else if (args[0] === 'hang') setInterval(() => {}, 1000);
else if (args[0] === '--version') console.log('codex-cli fixture');
else if (args[0] === 'features') console.log('shell_tool\nplugins\nview_image');
else if (args[0] === 'debug') line({ models: [{ slug: fixtureModel, shell_type: 'unified_exec' }] });
else if (args[0] === 'app-server') {
  let tools;
  const hasLogin = () => access(join(process.env.CODEX_HOME, 'auth.json')).then(() => true, () => false);
  const input = createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const raw of input) {
    const message = JSON.parse(raw);
    if (!Object.hasOwn(message, 'id')) continue;
    const { id, method, params } = message;
    let result;
    try {
      if (method === 'initialize') result = {};
      else if (method === 'account/read') result = { account: await hasLogin() ? { type: 'chatgpt' } : null };
      else if (method === 'model/list') result = { data: [{ model: fixtureModel, displayName: 'Fixture', isDefault: true }], nextCursor: null };
      else if (method === 'thread/start') {
        tools = params.dynamicTools.map(({ name }) => ({ type: 'function', name }));
        result = { thread: { id: 'fixture-thread' } };
      } else if (method === 'turn/start') {
        const probe = args.find((arg) => arg.startsWith('model_providers.breezer_probe='));
        if (probe) {
          if (await hasLogin()) throw new Error('Probe had access to the fixture login.');
          const url = /base_url="(http:\/\/127\.0\.0\.1:[0-9]+\/v1)"/.exec(probe)?.[1];
          const config = await readFile(join(process.env.CODEX_HOME, 'config.toml'), 'utf8');
          if (!config.includes('sandbox_mode = "read-only"')) throw new Error('Probe was missing its restrictions.');
          const response = await fetch(url + '/responses', { method: 'POST', body: JSON.stringify({ tools, service_tier: params.serviceTier }) });
          if (!response.ok) throw new Error('Probe rejected the fixture request.');
          await response.text();
        } else {
          if (!await hasLogin()) throw new Error('Runtime did not use its fixture login.');
          line({ method: 'item/agentMessage/delta', params: { delta: 'Fixture response.' } });
        }
        result = { turn: { id: 'fixture-turn' } };
      } else if (method === 'wait') continue;
      else throw new Error('Unexpected fixture request ' + method);
      line({ id, result });
      if (method === 'turn/start') line({ method: 'turn/completed', params: { turn: { status: 'completed' } } });
    } catch (error) {
      line({ id, error: { message: error.message } });
    }
  }
} else {
  throw new Error('Unexpected fixture arguments.');
}
