// Shared signed-in provider and page-context fixture for the assistant.
export const installPanelFixture = () => {
    const storage = { local: JSON.parse(localStorage.getItem('breezer-fixture-local') || '{}'), session: {} };
    const callbacks = [];
    window.sent = [];
    window.emit = (message) => callbacks.forEach((callback) => callback(message));
    const area = (name) => ({
      get: async (keys) => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).filter((key) => key in storage[name]).map((key) => [key, storage[name][key]])),
      set: async (items) => {
        Object.assign(storage[name], items);
        if (name === 'local') localStorage.setItem('breezer-fixture-local', JSON.stringify(storage.local));
      },
    });
    window.testStorage = storage;
    window.testProviders = [
      { id: 'codex', available: true, authenticated: true, defaultModel: 'gpt-6.1-sol', models: [
        { id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol', reasoningEfforts: ['low', 'medium', 'high', 'xhigh'], defaultReasoningEffort: 'low', speeds: ['standard', 'fast'] },
        { id: 'gpt-6-luna', label: 'GPT-6 Luna', reasoningEfforts: ['low', 'medium'], defaultReasoningEffort: 'low', speeds: ['standard'] },
      ] },
      { id: 'claude', available: true, authenticated: false, models: [], error: 'Sign in with claude auth login, then refresh.' },
    ];
    window.chrome = {
      storage: { local: area('local'), session: area('session') },
      windows: { getCurrent: async () => ({ id: 7 }) },
      breezerPrivate: { authorizeCurrentPage: async () => true },
      sidePanel: { close: async (options) => { window.closedPanel = options; } },
      runtime: {
        connect: () => ({
          onMessage: { addListener: (fn) => callbacks.push(fn) },
          onDisconnect: { addListener: () => {} },
          postMessage: (message) => {
            window.sent.push(message);
            if (message.type === 'init') setTimeout(() => window.emit({ type: 'status', providers: window.testProviders }), 10);
            if (message.type === 'context') setTimeout(() => window.emit({ type: 'context', context: { title: 'Designing a calmer browser', url: 'https://example.com/design', tabId: 11 } }), 10);
          },
        }),
      },
    };
  };
