// Shared deterministic API fixture for Settings walkthroughs and visual coverage.
export function installFixture({ colorMode, theme }) {
  const load = (key, fallback) => JSON.parse(localStorage.getItem(key) || 'null') ?? fallback;
  const fx = { local: load('fx-local', {}), appearance: load('fx-appearance', null), calls: [], ports: {}, listeners: [] };
  fx.context = { enabled: false, providerConsent: false, sites: [], habits: [], suggestions: [], retentionDays: 7 };
  fx.appearance ??= { layout: 'sidebar', sidebarMode: 'expanded', theme, colorMode, showBookmarks: true, sidebarWidth: 240, sidebarFontSize: 15, centeredAddressBar: true, minimalUrl: true, showLoadProgress: true, frameless: true, alwaysShowSidebar: false, alwaysShowTopBar: true };
  window.fx = fx;
  const save = () => { localStorage.setItem('fx-local', JSON.stringify(fx.local)); localStorage.setItem('fx-appearance', JSON.stringify(fx.appearance)); };
  const area = (data, name) => ({
    async get(keys) { const list = keys == null ? Object.keys(data) : [keys].flat(); return structuredClone(Object.fromEntries(list.filter((k) => k in data).map((k) => [k, data[k]]))); },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) { changes[key] = { oldValue: data[key], newValue: structuredClone(value) }; data[key] = structuredClone(value); }
      save();
      setTimeout(() => fx.listeners.forEach((fn) => fn(changes, name)), 0);
    },
  });
  const event = () => { const list = []; return { list, addListener: (fn) => list.push(fn), removeListener() {} }; };
  window.chrome = {
    runtime: {
      getURL: (path) => `${location.origin}/${path}`,
      getManifest: () => ({ version: '1.1.0' }),
      onMessage: event(),
      connect({ name }) {
        const port = { name, sent: [], onMessage: event(), onDisconnect: event(), postMessage(message) { this.sent.push(message); }, disconnect() {} };
        port.reply = (message) => port.onMessage.list.forEach((fn) => fn(structuredClone(message)));
        fx.ports[name] = port;
        if (name === 'breezer-context-settings') port.postMessage = (message) => {
          if (message.type === 'configure') {
            Object.assign(fx.context, { enabled: message.enabled, sites: message.enabled ? message.sites : [], providerConsent: false });
            if (!message.enabled) Object.assign(fx.context, { habits: [], suggestions: [] });
          }
          if (message.type === 'consent') fx.context.providerConsent = message.consent;
          if (message.type === 'clear') Object.assign(fx.context, { habits: [], suggestions: [] });
          setTimeout(() => port.reply({ id: message.id, ok: true, value: structuredClone(fx.context) }), 0);
        };
        if (name === 'breezer-organato-settings') port.postMessage = (message) => setTimeout(() => port.reply({ id: message.id, ok: true, value: { connected: false, dashboardEnabled: true, enabled: true, allowAI: true } }), 0);
        if (name === 'breezer-updates') port.postMessage = (message) => setTimeout(() => port.reply({ id: message.id, ok: true, value: { available: false, notice: 'Breezer is up to date.' } }), 0);
        return port;
      },
    },
    storage: { local: area(fx.local, 'local'), session: area({}, 'session'), onChanged: { addListener: (fn) => fx.listeners.push(fn) } },
    tabs: {
      async query() { return [{ index: 0, windowId: 1 }]; },
      async getCurrent() { return { id: 42, index: 0, windowId: 1 }; },
      async create(props) { fx.calls.push(['tabs.create', props]); return props; },
      async update(id, props) { fx.calls.push(['tabs.update', id, props]); return { id, ...props }; },
    },
    breezerPrivate: {
      async getAppearance() { return structuredClone(fx.appearance); },
      async setAppearance(patch) { fx.calls.push(['setAppearance', patch]); Object.assign(fx.appearance, patch); save(); return structuredClone(fx.appearance); },
    },
  };
}
