export function event() {
  const listeners = [];
  return { addListener: fn => listeners.push(fn), emit: (...args) => listeners.forEach(fn => fn(...args)) };
}
export const tick = () => new Promise(resolve => setImmediate(resolve));
export function fakeChrome() {
  let tab = { id: 7, windowId: 3, url: 'https://example.test/page' };
  const calls = [];
  const local = {};
  const api = {
    storage: { local: {
      async get(key) { return { [key]: structuredClone(local[key]) }; },
      async set(values) { Object.assign(local, structuredClone(values)); },
    } },
    runtime: { onConnect: event(), onMessage: event(), connectNative(name) { calls.push(['native', name]); return native; } },
    commands: { onCommand: event() }, action: { onClicked: event() },
    sidePanel: { open: async value => calls.push(['open', value]), close: async value => calls.push(['close', value]) },
    tabs: {
      query: async query => { calls.push(['query', query]); return [{ ...tab }]; },
      captureVisibleTab: async windowId => { calls.push(['capture', windowId, tab.id]); return 'data:image/jpeg;base64,test'; },
      update: async (id, value) => { calls.push(['navigate', id, value]); },
      onActivated: event(), onUpdated: event(), onRemoved: event(),
    },
    scripting: { executeScript: async options => {
      if (!options.args) { calls.push(['grant-probe', options.target.tabId]); return [{ result: new URL(tab.url).origin }]; }
      const [operation, args] = options.args;
      calls.push(['script', options.target.tabId, operation, args]);
      if (operation === 'snapshot') return [{ result: { url: tab.url, title: 'Page', text: 'Visible content', viewport: { width: 1000, height: 700 }, elements: [] } }];
      if (operation === 'resolve') return [{ result: { x: 50, y: 60 } }];
      return [{ result: { ok: true } }];
    } },
    debugger: { attach: async value => calls.push(['attach', value]), detach: async value => calls.push(['detach', value]), sendCommand: async (target, method, args) => {
      if (method.startsWith('Input.')) { calls.push(['input', target, method, args]); return {}; }
      calls.push(['cdp', target, method, args]);
      if (method === 'Page.getFrameTree') return { frameTree: { frame: { id: 'main', loaderId: tab.url, url: tab.url } } };
      if (method === 'Page.createIsolatedWorld') return { executionContextId: 101 };
      if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'bootstrap' };
      if (method === 'Page.captureScreenshot') return { data: 'test' };
      if (method === 'Runtime.callFunctionOn') {
        const result = await api.scripting.executeScript({ target, args: args.arguments.map(value => value.value) });
        return { result: { value: result[0].result } };
      }
      return {};
    }, onDetach: event(), onEvent: event() },
  };
  const native = { sent: [], onMessage: event(), onDisconnect: event(), postMessage(value) { this.sent.push(value); }, disconnect() {} };
  return { api, native, calls, get tab() { return { ...tab }; }, setTab(value) { tab = { ...tab, ...value }; } };
}
export function panel() {
  return { name: 'breezer-panel', sent: [], onMessage: event(), onDisconnect: event(), postMessage(value) { this.sent.push(value); } };
}
