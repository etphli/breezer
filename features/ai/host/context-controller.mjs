import { HostController } from './controller.mjs';
import { summarizeContext, validateContextSummary } from './context-summary.mjs';

// Opt-in adapter; the ordinary chat controller and its tool permissions stay unchanged.
export class ContextHostController extends HostController {
  #summary;
  #chatRun;
  discover(refresh = false) { return super.discover(this.#summary ? false : refresh); }
  async receive(message) {
    if (message?.type === 'context-summary') { await this.#summarize(message); return; }
    if (message?.type === 'cancel' && this.#summary?.id === message.id) { this.cancel(); return; }
    if (message?.type !== 'chat') { await super.receive(message); return; }
    if (this.#summary || this.#chatRun) { this.send({ type: 'error', id: message.id, error: 'Another request is already running. Stop it first.' }); return; }
    const run = { id: message.id };
    this.#chatRun = run;
    try { await super.receive(message); }
    finally { if (this.#chatRun === run) this.#chatRun = undefined; }
  }
  async #summarize(message) {
    let run;
    try {
      validateContextSummary(message);
      if (this.#summary || this.#chatRun) throw new Error('Another request is already running. Stop it first.');
      run = { id: message.id, controller: new AbortController() };
      this.#summary = run;
      await this.discover();
      if (this.#summary !== run || run.controller.signal.aborted) return;
      const result = await summarizeContext(this.providers, message, { signal: run.controller.signal });
      if (this.#summary !== run || run.controller.signal.aborted) return;
      this.send({ type: 'context-summary-result', id: run.id, result });
      this.send({ type: 'complete', id: run.id });
    } catch (error) {
      if (!run || this.#summary === run && !run.controller.signal.aborted) this.send({ type: 'error', id: message?.id, error: error.message.slice(0, 1500) });
    } finally { if (run && this.#summary === run) this.#summary = undefined; }
  }
  cancel() {
    this.#chatRun = undefined;
    const run = this.#summary;
    if (run) {
      this.#summary = undefined;
      run.controller.abort();
      this.send({ type: 'complete', id: run.id, cancelled: true });
    }
    super.cancel();
  }
}
