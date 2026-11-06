// Shared fixed-time data and API fixture for new-tab rendering.
export const NOW = new Date(2026, 9, 29, 10, 0);
export const at = (days, hour = null) => {
  if (hour == null) {
    const day = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days);
    return `${day.getFullYear()}-${String(day.getMonth() + 1).padStart(2, '0')}-${String(day.getDate()).padStart(2, '0')}`;
  }
  return new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() + days, hour).toISOString();
};

export const SITES = [
  ['Mail', 'https://mail.example.com/'], ['Canvas', 'https://canvas.example.edu/'], ['Docs', 'https://docs.example.com/'],
  ['Calendar', 'https://calendar.example.com/'], ['News', 'https://news.example.org/'], ['Music', 'https://music.example.com/'],
  ['Maps', 'https://maps.example.com/'], ['Library', 'https://library.example.edu/'], ['Ninth', 'https://ninth.example.com/'],
].map(([title, url]) => ({ title, url }));

export const CONNECTED = {
  topSites: SITES,
  organato: {
    enabled: true, connected: true, error: null,
    // As the background sends them: b1 is classified as both, so it is in
    // exams and assignments; t1 is a to-do the exam filter also picked up.
    exams: [
      { id: 't1', kind: 'todo', classification: 'checkpoint', title: 'Email group about slides', dueAt: at(0) },
      { id: 'e1', kind: 'work', classification: 'checkpoint', title: 'Chemistry unit 3 test', dueAt: at(1, 9), subject: 'Chemistry' },
      { id: 'b1', kind: 'work', classification: 'both', title: 'Biology field study presentation', dueAt: at(4), subject: 'Biology' },
      { id: 'e2', kind: 'work', classification: 'checkpoint', title: 'Spanish oral exam', dueAt: at(6, 13), subject: 'Spanish' },
    ],
    assignments: [
      { id: 'a0', kind: 'work', classification: 'assignment', title: 'Reading reflection', dueAt: at(-1), subject: 'English' },
      { id: 'a1', kind: 'work', classification: 'assignment', title: 'History essay draft', dueAt: at(0, 23), subject: 'History', url: 'https://canvas.example.edu/a1' },
      { id: 'a2', kind: 'work', classification: 'assignment', title: 'Lab report: titration', dueAt: at(3, 17), subject: 'Chemistry' },
      { id: 'b1', kind: 'work', classification: 'both', title: 'Biology field study presentation', dueAt: at(4), subject: 'Biology' },
      { id: 'a3', kind: 'work', classification: 'assignment', title: 'Problem set 7', dueAt: at(9), subject: 'Maths' },
    ],
    todos: [
      { id: 't1', kind: 'todo', classification: 'checkpoint', title: 'Email group about slides', dueAt: at(0) },
      { id: 't2', title: 'Return library books' },
    ],
  },
};

export function installFixture({ view, appearance, delay = 0, hang = false, switches }) {
  // fx.view and fx.delay can be changed mid-test to script later answers.
  window.fx = { requests: [], view, delay };
  const port = (name) => {
    const listeners = { message: [], disconnect: [] };
    return {
      name,
      onMessage: { addListener: (fn) => listeners.message.push(fn) },
      onDisconnect: { addListener: (fn) => listeners.disconnect.push(fn) },
      postMessage(message) {
        window.fx.requests.push({ name, ...message });
        if (hang) return;
        const answer = structuredClone(window.fx.view);
        setTimeout(() => listeners.message.forEach((fn) => fn({ type: 'view', id: message.id, ...answer })), window.fx.delay);
      },
      disconnect() {},
    };
  };
  const preferences = JSON.parse(localStorage.getItem('shortcut-fixture') || '{}');
  if (switches && !('organato.switches.v1' in preferences)) { preferences['organato.switches.v1'] = switches; localStorage.setItem('shortcut-fixture', JSON.stringify(preferences)); }
  const storageListeners = [];
  // chrome.storage is shared by every extension page; same-origin storage events
  // stand in for that, so a change in one tab reaches the others.
  window.addEventListener('storage', (event) => {
    if (event.key !== 'shortcut-fixture') return;
    const next = JSON.parse(event.newValue || '{}');
    const changes = {};
    for (const key of new Set([...Object.keys(preferences), ...Object.keys(next)])) {
      if (JSON.stringify(preferences[key]) !== JSON.stringify(next[key])) changes[key] = { oldValue: preferences[key], newValue: next[key] };
    }
    Object.keys(preferences).forEach((key) => delete preferences[key]);
    Object.assign(preferences, next);
    if (Object.keys(changes).length) for (const fn of storageListeners) fn(changes, 'local');
  });
  window.chrome = {
    tabs: { query: async () => [{ id: 5, title: 'Open project', url: 'https://project.example.com/' }, { id: 6, title: 'Internal', url: 'chrome://settings/' }] },
    runtime: {
      connect: ({ name }) => port(name),
      getURL: (path) => `${location.origin}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ permissions: ['favicon'] }),
      lastError: undefined,
    },
    storage: { local: { async get(key) { return { [key]: structuredClone(preferences[key]) }; }, async set(values) { Object.assign(preferences, structuredClone(values)); localStorage.setItem('shortcut-fixture', JSON.stringify(preferences)); for (const fn of storageListeners) fn(Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { newValue: value }])), 'local'); } }, onChanged: { addListener(fn) { storageListeners.push(fn); }, removeListener(fn) { const index=storageListeners.indexOf(fn); if(index>=0) storageListeners.splice(index,1); } } },
    ...(appearance ? { breezerPrivate: { getAppearance: async () => appearance } } : {}),
  };
}
