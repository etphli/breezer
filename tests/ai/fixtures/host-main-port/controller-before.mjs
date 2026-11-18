import { randomUUID } from 'node:crypto';
import { allowedTools, validateChat, validateTool, MAX_MESSAGE_BYTES } from './protocol.mjs';

export class HostController {
  #discovery;
  #discovering = false;
  #active;
  #pending = new Map();
  constructor(providers, send, { toolTimeout = 60_000, integrationTool, prepareChat } = {}) {
    this.providers = providers; this.send = send; this.toolTimeout = toolTimeout; this.integrationTool = integrationTool; this.prepareChat = prepareChat;
  }
  async discover(refresh = false) {
    if (refresh && !this.#active && !this.#discovering) this.#discovery = undefined;
    if (!this.#discovery) {
      this.#discovering = true;
      this.#discovery = Promise.all(this.providers.map((provider) => provider.discover())).finally(() => { this.#discovering = false; });
    }
    return this.#discovery;
  }
  async receive(message) {
    try {
      if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error('Invalid native message.');
      if (message.type === 'init') {
        this.send({ type: 'status', ...(typeof message.id === 'string' ? { id: message.id } : {}), providers: await this.discover(true) }); return;
      }
      if (message.type === 'cancel') {
        if (this.#active?.id === message.id) this.cancel();
        return;
      }
      if (message.type === 'toolResult') { this.toolResult(message); return; }
      validateChat(message);
      if (this.#active) throw new Error('Another chat is already running. Stop it before starting a new request.');
      const run = { id: message.id, controller: new AbortController(), tools: [] };
      this.#active = run;
      try {
        message = { ...message, organato: this.prepareChat ? await this.prepareChat() : false };
        if (run.controller.signal.aborted) return;
        run.tools = allowedTools(message);
        await this.discover();
        if (run.controller.signal.aborted) return;
        const provider = this.providers.find((entry) => entry.id === message.provider);
        await provider.chat(message, {
          signal: run.controller.signal,
          emit: (event) => { if (this.#active === run && !run.controller.signal.aborted) this.send({ ...event, id: run.id }); },
          callTool: (name, args) => this.callTool(run, name, args),
        });
        if (this.#active === run) this.send({ type: 'complete', id: run.id });
      } catch (error) {
        if (this.#active === run && !run.controller.signal.aborted) this.send({ type: 'error', id: run.id, error: error.message.slice(0, 1500) });
      } finally {
        if (this.#active === run) this.#active = undefined;
        this.rejectTools(run.id, new Error('Chat ended.'));
      }
    } catch (error) { this.send({ type: 'error', ...(typeof message?.id === 'string' ? { id: message.id.slice(0, 100) } : {}), error: error.message.slice(0, 1500) }); }
  }
  callTool(run, name, args) {
    if (this.#active !== run || run.controller.signal.aborted) return Promise.reject(new Error('Cancelled.'));
    validateTool(name, args, run.tools);
    if (name.startsWith('organato_')) {
      if (!this.integrationTool) return Promise.reject(new Error('Organato is unavailable.'));
      return this.integrationTool(name, args, run.controller.signal);
    }
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.#pending.delete(requestId); reject(new Error('The browser action timed out.')); }, this.toolTimeout);
      this.#pending.set(requestId, { id: run.id, resolve, reject, timer });
      this.send({ type: 'tool', id: run.id, requestId, name, args });
    });
  }
  toolResult(message) {
    const pending = this.#pending.get(message.requestId);
    if (!pending || pending.id !== message.id || this.#active?.id !== message.id) throw new Error('Unknown browser action result.');
    if (JSON.stringify(message).length > MAX_MESSAGE_BYTES - 1000) throw new Error('Browser action result is too large.');
    this.#pending.delete(message.requestId); clearTimeout(pending.timer);
    if (typeof message.error === 'string') pending.reject(new Error(message.error.slice(0, 1000)));
    else if (!message.result || typeof message.result !== 'object' || Array.isArray(message.result)) pending.reject(new Error('Invalid browser action result.'));
    else pending.resolve(message.result);
  }
  rejectTools(id, error) {
    for (const [key, pending] of this.#pending) {
      if (pending.id !== id) continue;
      clearTimeout(pending.timer); pending.reject(error); this.#pending.delete(key);
    }
  }
  cancel() {
    const run = this.#active;
    if (!run) return;
    this.#active = undefined;
    run.controller.abort();
    this.rejectTools(run.id, new Error('Cancelled.'));
    this.send({ type: 'complete', id: run.id, cancelled: true });
  }
  close() { this.cancel(); }
}
