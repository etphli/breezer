const icon = (letter, color) => `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="8" fill="${color}"/><text x="16" y="22" font-family="Helvetica" font-size="17" font-weight="700" text-anchor="middle" fill="#fff">${letter}</text></svg>`)}`;

export function seed() {
  const work = 'space-work';
  const personal = 'space-personal';
  const tabs = [
    { id: 1, url: 'https://linear.app/breezer/inbox', title: 'Inbox · Linear', pinned: true, favIconUrl: icon('L', '#5e6ad2') },
    { id: 2, url: 'https://www.figma.com/file/sidebar', title: 'Sidebar explorations', pinned: true, favIconUrl: icon('F', '#a259ff') },
    { id: 3, url: 'https://github.com/etphli/breezer/pull/42', title: 'Arc-style sidebar · Pull request #42', active: true, favIconUrl: icon('G', '#24292f') },
    { id: 4, url: 'https://docs.breezer.dev/review', title: 'Arc review notes', favIconUrl: icon('D', '#2e9c7e') },
    { id: 5, url: 'https://mail.example.com/inbox', title: 'Mail — 3 unread', favIconUrl: icon('M', '#d93025') },
    { id: 6, url: 'https://recipes.example.com/miso', title: 'Miso glazed aubergine', favIconUrl: icon('R', '#e37400') },
    { id: 7, url: 'https://music.example.com/live', title: 'Late night radio', audible: true, favIconUrl: icon('♪', '#1db954') },
    { id: 8, url: 'https://calendar.example.com/week', title: 'Calendar', pinned: true, favIconUrl: icon('31', '#1a73e8') },
  ].map((tab, index) => ({ windowId: 7, index, active: false, pinned: false, status: 'complete', ...tab }));
  const store = {
    version: 1,
    rev: 1,
    spaces: [
      { id: work, name: 'Work', tone: 'mint', pinned: [
        { kind: 'folder', id: 'f-design', name: 'Design review', open: true, children: [
          { kind: 'entry', id: 'e-figma', url: 'https://www.figma.com/file/sidebar', title: 'Sidebar explorations' },
          { kind: 'entry', id: 'e-spec', url: 'https://docs.breezer.dev/spec', title: 'Sidebar spec' },
        ] },
        { kind: 'entry', id: 'e-linear', url: 'https://linear.app/breezer/inbox', title: 'Linear' },
      ] },
      { id: personal, name: 'Personal', tone: 'rose', pinned: [] },
    ],
    favorites: [
      { kind: 'entry', id: 'v-cal', url: 'https://calendar.example.com/week', title: 'Calendar' },
      { kind: 'entry', id: 'v-chat', url: 'https://chat.example.com/', title: 'Chat' },
      { kind: 'entry', id: 'v-notes', url: 'https://notes.example.com/', title: 'Notes' },
      { kind: 'entry', id: 'v-music', url: 'https://music.example.com/', title: 'Music' },
    ],
    prefs: { newTabPosition: 'bottom', closeButton: 'hover' },
  };
  const record = (s, u, e) => ({ s, u, k: 'S1', ...(e ? { e } : {}) });
  const members = { version: 1, session: 'S1', prev: '', tabs: {
    1: record(work, tabs[0].url, 'e-linear'), 2: record(work, tabs[1].url, 'e-figma'), 3: record(work, tabs[2].url),
    4: record(work, tabs[3].url), 5: record(work, tabs[4].url), 6: record(personal, tabs[5].url), 7: record(personal, tabs[6].url),
    8: record(work, tabs[7].url, 'v-cal'),
  } };
  return { tabs, local: { 'workspace.v1': store, 'workspace.members.v1': members }, session: { 'workspace.session': 'S1' } };
}

// Runs inside the page. Persists to localStorage/sessionStorage so reloads behave
// like a sidebar document reopening in the same (or a restarted) browser.
export function installFixture({ seed, bridge, bridgeFails, favicon = false }) {
  const windowId = seed.windowId ?? 7;
  const load = (store, key, fallback) => JSON.parse(store.getItem(key) || 'null') ?? fallback;
  const fx = {
    tabs: load(localStorage, 'fx-tabs', seed.tabs),
    local: load(localStorage, 'fx-local', seed.local),
    session: load(sessionStorage, 'fx-session', seed.session),
    appearance: load(localStorage, 'fx-appearance', { layout: 'sidebar', sidebarMode: 'expanded', theme: 'mint', colorMode: 'system', showBookmarks: true, sidebarWidth: 240, sidebarFontSize: 15, centeredAddressBar: true, minimalUrl: true, showLoadProgress: true, frameless: true, alwaysShowSidebar: false, alwaysShowTopBar: true }),
    calls: [],
    listeners: {},
  };
  window.fx = fx;
  const save = () => {
    localStorage.setItem('fx-tabs', JSON.stringify(fx.tabs));
    localStorage.setItem('fx-local', JSON.stringify(fx.local));
    sessionStorage.setItem('fx-session', JSON.stringify(fx.session));
    localStorage.setItem('fx-appearance', JSON.stringify(fx.appearance));
  };
  const event = (name) => ({ addListener: (fn) => (fx.listeners[name] ||= []).push(fn), removeListener() {} });
  const fire = (name, ...args) => setTimeout(() => (fx.listeners[name] || []).forEach((fn) => fn(...structuredClone(args))), 0);
  fx.fire = fire;
  const copy = (value) => structuredClone(value);
  const reindex = () => {
    fx.tabs.sort((a, b) => (b.pinned - a.pinned) || (a.index - b.index));
    fx.tabs.forEach((tab, index) => { tab.index = index; });
  };
  const find = (id) => {
    const tab = fx.tabs.find((item) => item.id === id);
    if (!tab) throw new Error(`No tab with id: ${id}.`);
    return tab;
  };
  const setActive = (id) => {
    const currentWindow = find(id).windowId;
    for (const tab of fx.tabs) if (tab.windowId === currentWindow) tab.active = tab.id === id;
    fire('tabs.onActivated', { tabId: id, windowId: currentWindow });
  };
  let nextId = Math.max(0, ...fx.tabs.map((tab) => tab.id)) + 1;
  const area = (name) => ({
    async get(keys) {
      const list = keys == null ? Object.keys(fx[name]) : [keys].flat();
      return copy(Object.fromEntries(list.filter((key) => key in fx[name]).map((key) => [key, fx[name][key]])));
    },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) {
        changes[key] = { oldValue: fx[name][key], newValue: copy(value) };
        fx[name][key] = copy(value);
      }
      save();
      fire('storage.onChanged', changes, name);
    },
  });
  const hostOf = (url) => { try { return new URL(url).hostname; } catch { return url; } };
  window.chrome = {
    runtime: {
      getURL: (path) => `${location.origin}/${String(path).replace(/^\//, '')}`,
      getManifest: () => ({ permissions: ['tabs', 'storage', ...(favicon ? ['favicon'] : [])] }),
      onMessage: event('runtime.onMessage'),
      lastError: undefined,
    },
    windows: {
      getCurrent: async () => ({ id: windowId }),
      update: async (id, props) => { fx.calls.push(['windows.update', id, props]); return { id }; },
    },
    storage: { local: area('local'), session: area('session'), onChanged: event('storage.onChanged') },
    tabs: {
      onCreated: event('tabs.onCreated'), onUpdated: event('tabs.onUpdated'), onRemoved: event('tabs.onRemoved'),
      onActivated: event('tabs.onActivated'), onMoved: event('tabs.onMoved'), onAttached: event('tabs.onAttached'),
      onDetached: event('tabs.onDetached'), onReplaced: event('tabs.onReplaced'),
      async query(filter = {}) {
        const snapshot = copy(fx.tabs.filter(tab => (filter.active === undefined || tab.active === filter.active)
          && (filter.windowId === undefined || tab.windowId === filter.windowId)));
        if (fx.holdQuery) {
          fx.holdQuery = false;
          await new Promise(resolve => { fx.releaseQuery = resolve; });
        }
        return snapshot;
      },
      async get(id) { return copy(find(id)); },
      async create({ url, active = true, pinned = false, index, windowId = 7 }) {
        fx.calls.push(['tabs.create', { url, active, pinned, index }]);
        if (fx.holdCreate) await new Promise(resolve => { fx.releaseCreate = resolve; });
        if (fx.failCreate) throw new Error('Fixture create failure');
        const tab = { id: nextId++, windowId, index: index ?? fx.tabs.length, url: url || 'chrome://newtab/', title: url ? hostOf(url) : 'New Tab', active: false, pinned, status: 'complete' };
        fx.tabs.forEach((item) => { if (item.index >= tab.index) item.index += 1; });
        fx.tabs.push(tab);
        reindex();
        save();
        fire('tabs.onCreated', tab);
        if (active) setActive(tab.id);
        return copy(tab);
      },
      async update(id, props) {
        fx.calls.push(['tabs.update', id, props]);
        const tab = find(id);
        const change = {};
        const from = tab.index;
        if (props.pinned !== undefined && props.pinned !== tab.pinned) { tab.pinned = props.pinned; change.pinned = props.pinned; reindex(); }
        if (tab.index !== from) fire('tabs.onMoved', id, { windowId: 7, fromIndex: from, toIndex: tab.index });
        if (props.muted !== undefined) { tab.mutedInfo = { muted: props.muted }; change.mutedInfo = tab.mutedInfo; }
        save();
        if (Object.keys(change).length) fire('tabs.onUpdated', id, change, tab);
        if (props.active) setActive(id);
        return copy(tab);
      },
      async remove(ids) {
        fx.calls.push(['tabs.remove', [ids].flat()]);
        for (const id of [ids].flat()) {
          const tab = find(id);
          fx.tabs.splice(fx.tabs.indexOf(tab), 1);
          reindex();
          fire('tabs.onRemoved', id, { windowId: 7, isWindowClosing: false });
          if (tab.active && fx.tabs.length) setActive((fx.tabs[tab.index] || fx.tabs[tab.index - 1]).id);
        }
        save();
      },
      async move(id, { index }) {
        fx.calls.push(['tabs.move', id, index]);
        const tab = find(id);
        const from = tab.index;
        fx.tabs.splice(fx.tabs.indexOf(tab), 1);
        fx.tabs.splice(index < 0 ? fx.tabs.length : index, 0, tab);
        fx.tabs.forEach((item, i) => { item.index = i; });
        save();
        fire('tabs.onMoved', id, { windowId: 7, fromIndex: from, toIndex: tab.index });
        return copy(tab);
      },
      async duplicate(id) { return this.create({ url: find(id).url }); },
    },
  };
  if (bridge) {
    const fields = {
      layout: (v) => ['sidebar', 'top'].includes(v), theme: (v) => ['mint', 'tide', 'dusk', 'rose', 'pollen', 'graphite'].includes(v),
      sidebarMode: (v) => ['expanded', 'compact', 'autoHide'].includes(v),
      bookmarkBarMode: (v) => ['newTab', 'always', 'hidden'].includes(v), colorMode: (v) => ['system', 'light', 'dark'].includes(v), showBookmarks: (v) => typeof v === 'boolean',
      sidebarWidth: (v) => Number.isInteger(v) && v >= 200 && v <= 360,
      sidebarFontSize: (v) => Number.isInteger(v) && v >= 12 && v <= 20,
      ...Object.fromEntries(['centeredAddressBar', 'minimalUrl', 'showLoadProgress', 'frameless', 'alwaysShowSidebar', 'alwaysShowTopBar'].map(key => [key, v => typeof v === 'boolean'])),
    };
    window.chrome.breezerPrivate = {
      async getAppearance() { return copy(fx.appearance); },
      async setAppearance(patch) {
        fx.calls.push(['setAppearance', patch]);
        if (bridgeFails) throw new Error('Rejected by the browser.');
        for (const [key, value] of Object.entries(patch)) if (!fields[key]?.(value)) throw new Error(`Invalid ${key}`);
        Object.assign(fx.appearance, patch);
        save();
        return copy(fx.appearance);
      },
      async setSidebarCollapsed(collapsed) { fx.calls.push(['setSidebarCollapsed', collapsed]); },
    };
  }
}
