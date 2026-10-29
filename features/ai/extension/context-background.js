import { ContextMemory } from './context-memory.js';

const NATIVE_HOST = 'io.github.etphli.breezer.ai';
const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(id);
const post = (port, message) => { try { port.postMessage(message); } catch {} };

function trustedSettings(api, port) {
  if (api.extension?.inIncognitoContext || port.sender?.tab?.incognito || port.sender?.id !== api.runtime.id) return false;
  try {
    const url = new URL(port.sender.url);
    url.hash = ''; url.search = '';
    return url.href === api.runtime.getURL('workspace.html');
  } catch { return false; }
}

function summaryTransport(api, request, { signal }) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(new Error('Context summary cancelled.')); return; }
    const native = api.runtime.connectNative(NATIVE_HOST);
    const id = `context_${crypto.randomUUID().replaceAll('-', '')}`;
    let done = false, result;
    const finish = (error, value) => {
      if (done) return;
      done = true;
      signal.removeEventListener('abort', abort);
      clearTimeout(timer);
      native.onMessage.removeListener(receive);
      native.onDisconnect.removeListener(disconnect);
      try { native.disconnect(); } catch {}
      if (error) reject(error); else resolve(value);
    };
    const abort = () => {
      try { native.postMessage({ type: 'cancel', id }); } catch {}
      finish(new Error('Context summary cancelled.'));
    };
    const receive = message => {
      if (message?.id !== id) return;
      if (message.type === 'error') finish(new Error('The summary helper could not complete this request. Local suggestions still work.'));
      else if (message.type === 'context-summary-result') {
        const candidate = message.result;
        if (candidate?.localOnly === true && typeof candidate.notice === 'string') result = { localOnly: true, notice: candidate.notice.slice(0, 1000) };
        else if (candidate?.model === 'gpt-6-luna' && candidate.provider === 'codex' && typeof candidate.text === 'string' && candidate.text.length <= 4200) result = { model: candidate.model, provider: candidate.provider, text: candidate.text };
        else finish(new Error('Invalid context summary response.'));
      } else if (message.type === 'complete') {
        if (message.cancelled || !result) finish(new Error('Context summary cancelled or empty.'));
        else finish(null, result);
      }
    };
    const disconnect = () => { void api.runtime.lastError; finish(new Error('The local AI helper disconnected. Local suggestions still work.')); };
    const timer = setTimeout(() => { try { native.postMessage({ type: 'cancel', id }); } catch {} finish(new Error('Context summary timed out.')); }, 60_000);
    native.onMessage.addListener(receive);
    native.onDisconnect.addListener(disconnect);
    signal.addEventListener('abort', abort, { once: true });
    try { native.postMessage({ ...request, id }); } catch { finish(new Error('Could not contact the local AI helper.')); }
  });
}

export function installContextBackground(api, { isPermitted = () => false, now = Date.now } = {}) {
  const memory = new ContextMemory(api.storage.local, { now });
  const ports = new Set();
  let disposed = false;
  const permission = async tab => {
    if (disposed || api.extension?.inIncognitoContext || tab?.incognito !== false || !await isPermitted(tab)) return false;
    const current = await api.tabs.get(tab.id);
    return current?.active === true && current.incognito === false && current.url === tab.url && await isPermitted(current) === true;
  };
  const changed = () => { for (const port of ports) post(port, { type: 'context-changed' }); };
  const observe = tab => memory.observe(tab, { isPermitted: permission }).then(recorded => { if (recorded) changed(); return recorded; }).catch(() => false);
  const onActivated = info => {
    void (async () => {
      // Avoid even querying tab metadata while disabled or in a private extension context.
      if (disposed || api.extension?.inIncognitoContext || !(await memory.view()).enabled) return;
      await observe(await api.tabs.get(info.tabId));
    })().catch(() => {});
  };
  const onUpdated = (_tabId, change, tab) => { if (!disposed && !api.extension?.inIncognitoContext && (change.url || change.status === 'complete')) void observe(tab); };
  const onConnect = port => {
    if (port.name !== 'breezer-context-settings' || !trustedSettings(api, port) || disposed) return;
    ports.add(port);
    const receive = message => {
      void (async () => {
        if (!validId(message?.id) || !ports.has(port)) return;
        let value;
        switch (message.type) {
          case 'view': value = await memory.view(); break;
          case 'preview': value = await memory.summaryPreview(); break;
          case 'configure': value = await memory.configure({ enabled: message.enabled, sites: message.sites }); changed(); break;
          case 'consent': value = await memory.setProviderConsent(message.consent); changed(); break;
          case 'clear': value = await memory.clear(); changed(); break;
          case 'cancel': memory.cancel(); value = { cancelled: true }; break;
          case 'summarize': value = await memory.summarize((request, options) => summaryTransport(api, request, options)); break;
          default: throw new Error('Unknown context settings action.');
        }
        if (ports.has(port)) post(port, { id: message.id, ok: true, value });
      })().catch(error => { if (ports.has(port)) post(port, { id: message.id, ok: false, error: error.message }); });
    };
    port.onMessage.addListener(receive);
    port.onDisconnect.addListener(() => { ports.delete(port); port.onMessage.removeListener(receive); memory.cancel(); });
  };
  api.runtime.onConnect.addListener(onConnect);
  api.tabs.onActivated.addListener(onActivated);
  api.tabs.onUpdated.addListener(onUpdated);
  // Run a bounded prune when the service worker starts. Reads also prune before use.
  void memory.view().catch(() => {});
  return { memory, observeGranted: observe, dispose() {
    disposed = true; memory.cancel();
    api.runtime.onConnect.removeListener(onConnect);
    api.tabs.onActivated.removeListener(onActivated);
    api.tabs.onUpdated.removeListener(onUpdated);
    for (const port of ports) { try { port.disconnect(); } catch {} }
    ports.clear();
  } };
}
