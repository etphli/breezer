import { mkdtemp, writeFile, symlink, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from 'node:http';
import { JsonLineProcess, cliEnvironment, findCli, runCli } from './cli.mjs';
import { allowedTools, contextParts, promptText, systemPrompt } from './protocol.mjs';

export function restrictedCatalog(catalog) {
  if (!Array.isArray(catalog.models) || !catalog.models.length) throw new Error('Codex did not return a model catalog.');
  return { ...catalog, models: catalog.models.map((model) => ({ ...model,
    shell_type: 'disabled', apply_patch_tool_type: null, experimental_supported_tools: [],
    supports_search_tool: false, supports_experimental_context: false, node_repl_disabled: true,
    include_skills_usage_instructions: false, include_plugin_usage_instructions: false,
    include_apps_usage_instructions: false, tool_mode: 'standard',
  })) };
}

export class CodexProvider {
  id = 'codex';
  constructor({ find = findCli, run = runCli, createProcess = (...args) => new JsonLineProcess(...args) } = {}) {
    this.find = find; this.run = run; this.createProcess = createProcess;
  }
  async discover() {
    try {
      this.binary = await this.find('codex');
      const [version, features, raw] = await Promise.all([
        this.run(this.binary, ['--version']), this.run(this.binary, ['features', 'list']), this.run(this.binary, ['debug', 'models', '--bundled']),
      ]);
      if (version.code || features.code || raw.code) throw new Error('Codex CLI discovery failed.');
      this.version = version.stdout.trim();
      this.catalog = restrictedCatalog(JSON.parse(raw.stdout));
      this.features = features.stdout.split('\n').map((line) => line.trim().split(/\s+/)[0]).filter((name) => /^[a-z][a-z0-9_.]*$/.test(name));
      if (!this.features.includes('shell_tool') || !this.features.includes('plugins') || !this.features.includes('view_image')) throw new Error('This Codex CLI cannot enforce browser-only tools. Update Codex.');
      const isolation = await this.isolate();
      let rpc;
      try {
        rpc = await this.start(isolation);
        const account = await rpc.request('account/read', { refreshToken: false });
        const models = []; let cursor;
        do {
          const page = await rpc.request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
          models.push(...page.data); cursor = page.nextCursor;
        } while (cursor && models.length < 500);
        this.models = models.filter((model) => this.catalog.models.some((entry) => entry.slug === model.model)).map((model) => ({ id: model.model, label: model.displayName || model.model, isDefault: model.isDefault === true, inputModalities: model.inputModalities ?? ['text', 'image'], reasoningEfforts: (model.supportedReasoningEfforts ?? []).map((entry) => entry.reasoningEffort) }));
        this.defaultModel = this.models.some((model) => model.id === 'gpt-6.1-sol') ? 'gpt-6.1-sol' : this.models.find((model) => model.isDefault)?.id ?? this.models[0]?.id;
        this.authenticated = !!account.account;
        if (!this.defaultModel) throw new Error('No usable Codex models were returned by model/list.');
        // This sends a turn exclusively to a loopback HTTP server, without provider credentials.
        // It inspects the CLI's actual tool registry before any paid inference is permitted.
        await this.preflight(isolation, this.defaultModel, allowedTools({ control: true }));
        this.status = { id: this.id, available: true, authenticated: this.authenticated, models: this.models, defaultModel: this.defaultModel, version: this.version, isolation: 'verified-browser-tools', ...(this.defaultModel !== 'gpt-6.1-sol' ? { notice: 'GPT-6.1 Sol was not reported by this CLI. Showing its available models.' } : {}) };
      } finally { await rpc?.close(); await isolation.cleanup(); }
    } catch (error) {
      this.status = { id: this.id, available: false, authenticated: this.authenticated ?? false, models: this.models ?? [], error: error.message };
    }
    return this.status;
  }
  async isolate() {
    const directory = await mkdtemp(join(tmpdir(), 'breezer-codex-'));
    const codexHome = join(directory, 'config');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(codexHome, { mode: 0o700 });
    const authSource = join(process.env.CODEX_HOME || join(homedir(), '.codex'), 'auth.json');
    await symlink(authSource, join(codexHome, 'auth.json'));
    const catalogPath = join(directory, 'models.json');
    await writeFile(catalogPath, JSON.stringify(this.catalog), { mode: 0o600 });
    const config = `model_catalog_json = ${JSON.stringify(catalogPath)}\napproval_policy = "never"\nsandbox_mode = "read-only"\nweb_search = "disabled"\nagents.enabled = false\n[tools.update_plan]\nenabled = false\n[tools.experimental_request_user_input]\nenabled = false\n[features]\n${this.features.map((name) => `${JSON.stringify(name)} = false`).join('\n')}\n`;
    await writeFile(join(codexHome, 'config.toml'), config, { mode: 0o600 });
    return { directory, env: cliEnvironment({ CODEX_HOME: codexHome }), cleanup: () => rm(directory, { recursive: true, force: true }) };
  }
  async start(isolation, args = []) {
    const rpc = this.createProcess(this.binary, ['app-server', '--strict-config', ...args], { cwd: isolation.directory, env: isolation.env });
    try {
      await rpc.request('initialize', { clientInfo: { name: 'breezer', title: 'Breezer', version: '1.0.0' }, capabilities: { experimentalApi: true } });
      rpc.send({ method: 'initialized', params: {} }); return rpc;
    } catch (error) { await rpc.close(); throw error; }
  }
  threadParams(model, tools) {
    return { model, modelProvider: 'openai', ephemeral: true, approvalPolicy: 'never', sandbox: 'read-only', environments: [], baseInstructions: systemPrompt, developerInstructions: systemPrompt, dynamicTools: tools.map((tool) => ({ ...tool, deferLoading: false })), config: { web_search: 'disabled' } };
  }
  async preflight(isolation, model, tools) {
    let receive;
    const received = new Promise((resolve, reject) => { receive = { resolve, reject }; });
    const server = createServer((request, response) => {
      let body = '';
      request.on('data', (chunk) => { body += chunk; if (body.length > 5_000_000) request.destroy(); });
      request.on('end', () => {
        try {
          if (!request.url?.endsWith('/responses')) { response.writeHead(404); response.end(); return; }
          const input = JSON.parse(body);
          verifyCodexTools(input, tools);
          if (request.headers.authorization) throw new Error('Codex isolation probe unexpectedly included credentials.');
          receive.resolve();
          response.writeHead(200, { 'Content-Type': 'text/event-stream' });
          response.end('event: response.completed\ndata: {"type":"response.completed","response":{"id":"breezer-probe","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0,"total_tokens":0}}}\n\n');
        } catch (error) { receive.reject(error); response.writeHead(400); response.end(); }
      });
    });
    await new Promise((resolve, reject) => { server.on('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    let rpc, timer;
    try {
      rpc = await this.start(isolation, ['-c', 'model_provider="breezer_probe"', '-c', `model_providers.breezer_probe={name="Breezer isolation probe",base_url="http://127.0.0.1:${address.port}/v1",wire_api="responses",requires_openai_auth=false}`]);
      const started = await rpc.request('thread/start', { ...this.threadParams(model, tools), modelProvider: 'breezer_probe' });
      await rpc.request('turn/start', { threadId: started.thread.id, input: [{ type: 'text', text: 'Tool isolation probe. Do not call tools.' }] });
      await Promise.race([received, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Could not verify Codex browser-only tool isolation.')), 15_000); })]);
    } finally { clearTimeout(timer); await rpc?.close(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  }
  async chat(chat, { signal, emit, callTool }) {
    const model = chat.model || this.defaultModel;
    if (!this.status?.available || !this.authenticated) throw new Error('Codex is unavailable. Sign in with codex login, then reconnect.');
    if (!this.models.some((entry) => entry.id === model)) throw new Error('This model was not reported by Codex model/list.');
    const tools = allowedTools(chat);
    const isolation = await this.isolate();
    let rpc;
    try {
      await this.preflight(isolation, model, tools);
      if (signal.aborted) throw new Error('Cancelled.');
      rpc = await this.start(isolation);
      const abort = () => rpc.close(new Error('Cancelled.'));
      signal.addEventListener('abort', abort, { once: true });
      try {
        const done = new Promise((resolve, reject) => {
          rpc.on('closed', reject);
          rpc.on('message', (message) => {
            if (message.method === 'item/agentMessage/delta') emit({ type: 'delta', text: message.params.delta });
            if (message.method === 'turn/completed') {
              const turn = message.params.turn;
              if (turn.status === 'completed') resolve(); else reject(new Error(turn.error?.message || (turn.status === 'interrupted' ? 'Cancelled.' : 'Codex turn failed.')));
            }
            if (message.id !== undefined && message.method) {
              if (message.method !== 'item/tool/call') {
                rpc.send({ id: message.id, error: { code: -32601, message: 'Only Breezer browser tools are permitted.' } }); return;
              }
              const { tool, arguments: args } = message.params;
              Promise.resolve().then(() => callTool(tool, args, tools)).then((result) => {
                const parts = contextParts(result);
                const contentItems = parts.map((part) => part.type === 'image' ? { type: 'inputImage', imageUrl: part.image } : { type: 'inputText', text: part.text });
                rpc.send({ id: message.id, result: { success: true, contentItems: contentItems.length ? contentItems : [{ type: 'inputText', text: JSON.stringify(result) }] } });
              }).catch((error) => { if (!rpc.closed) rpc.send({ id: message.id, result: { success: false, contentItems: [{ type: 'inputText', text: error.message }] } }); });
            }
          });
        });
        // Attach rejection handling before requests, which may fail synchronously on cancellation.
        done.catch(() => {});
        const started = await rpc.request('thread/start', this.threadParams(model, tools));
        const input = [{ type: 'text', text: promptText(chat) }, ...(chat.includeContext === true ? contextParts(chat.context) : [])];
        const selected = this.models.find((entry) => entry.id === model);
        await rpc.request('turn/start', { threadId: started.thread.id, input: input.map((part) => part.type === 'image' ? { type: 'image', url: part.image } : part), ...(selected.reasoningEfforts.includes('high') ? { effort: 'high' } : {}) });
        await done;
      } finally { signal.removeEventListener('abort', abort); }
    } finally { await rpc?.close(); await isolation.cleanup(); }
  }
}

export function verifyCodexTools(actual, expected) {
  const declarations = Array.isArray(actual) ? actual : [...(actual.tools ?? []), ...(actual.input ?? []).filter((item) => item.type === 'additional_tools').flatMap((item) => item.tools)];
  if (!Array.isArray(declarations)) throw new Error('Codex did not expose a verifiable tool registry.');
  const flatten = (tools) => tools.flatMap((tool) => tool.type === 'namespace' && tool.name === 'functions' && Array.isArray(tool.tools) ? flatten(tool.tools) : [tool.type === 'function' && tool.name]);
  const names = flatten(declarations);
  const allowed = expected.map((tool) => tool.name);
  if (names.some((name) => !allowed.includes(name)) || names.length !== allowed.length || new Set(names).size !== names.length) throw new Error('Codex exposed a tool outside Breezer browser controls. Chat is disabled.');
  return true;
}
