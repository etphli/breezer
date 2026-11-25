const createDashboardCache = (() => {
const HOUR = 60 * 60 * 1000;
const encoder = new TextEncoder();
const authFailure = error => error?.status === 401 || error?.status === 403;
const temporaryFailure = error => error?.code === 'NETWORK_ERROR' || (error?.status >= 500 && error.status <= 599);
function cacheable(value, maximumBytes) {
  if (!value || !Array.isArray(value.items) || value.items.length > 2000 || typeof value.truncated !== 'boolean') return false;
  if (!value.items.every(item => item && typeof item === 'object' && !Array.isArray(item)
    && typeof item.id === 'string' && typeof item.title === 'string'
    && ['work','todo'].includes(item.kind))) return false;
  try {
    const text = JSON.stringify(value);
    return text.length <= maximumBytes && (text.length * 3 <= maximumBytes || encoder.encode(text).byteLength <= maximumBytes);
  } catch { return false; }
}
function changed() {
  const error = new Error('Organato changed while the dashboard was loading. Try again.');
  error.code = 'DASHBOARD_CHANGED';
  return error;
}

// One worker owns this memory entry. Saved helper progress is admitted only
// through the current fingerprint and epoch, and never replaces a live entry.
function createDashboardCache({ now = Date.now, maximumBytes = 1024 * 1024 } = {}) {
  let epoch = 0, blocked = 0, entry = null, pending = null, identity = null;
  const invalidate = () => { epoch++; entry = null; pending?.listeners.clear(); pending = null; };
  const hold = () => {
    blocked++; invalidate(); let released = false;
    return () => { if (!released) { released = true; blocked--; invalidate(); } };
  };
  const load = async ({ fingerprint, refresh = false, fetch, onCached, active = () => true, signal }) => {
    if (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint)) {
      invalidate(); identity = null;
      return { value: await fetch(), cached: false };
    }
    if (identity !== fingerprint) { invalidate(); identity = fingerprint; }
    const at = now();
    if (entry && at < entry.updatedAt) invalidate();
    if (!blocked && !refresh && entry && at - entry.updatedAt < HOUR) {
      return { value: entry.value, cached: true, updatedAt: entry.updatedAt };
    }
    const listener = { onCached, active };
    const attach = operation => {
      if (signal?.aborted) return;
      operation.listeners.add(listener);
      const remove = () => operation.listeners.delete(listener);
      signal?.addEventListener('abort', remove, { once: true });
      listener.cleanup = () => signal?.removeEventListener('abort', remove);
    };
    if (!blocked && !refresh && pending) {
      attach(pending);
      if (pending.saved && active()) onCached?.(pending.saved);
      return pending.promise;
    }
    if (refresh) { epoch++; pending?.listeners.clear(); pending = null; }
    const version = epoch, fallback = entry, mayCache = blocked === 0;
    const operation = { listeners: new Set(), saved: null };
    attach(operation);
    const progress = value => {
      if (version !== epoch || identity !== fingerprint || blocked || !mayCache || fallback || !cacheable(value, maximumBytes) || value.fingerprint !== fingerprint) return;
      operation.saved = value;
      for (const reader of operation.listeners) if (reader.active()) reader.onCached?.(value);
    };
    operation.promise = Promise.resolve().then(async () => {
      try {
        const value = await fetch(progress);
        if (version !== epoch || identity !== fingerprint) throw changed();
        const updatedAt = now();
        if (mayCache && !blocked && cacheable(value, maximumBytes)) entry = { value, updatedAt };
        else entry = null;
        return { value, cached: false, updatedAt };
      } catch (error) {
        if (version !== epoch || identity !== fingerprint) throw changed();
        if (authFailure(error)) { invalidate(); throw error; }
        if (mayCache && !blocked && temporaryFailure(error) && !fallback && operation.saved) {
          return { value: operation.saved, cached: true, saved: true, stale: true, error: error.message };
        }
        if (mayCache && !blocked && temporaryFailure(error) && fallback && now() >= fallback.updatedAt) {
          return { value: fallback.value, cached: true, stale: true, updatedAt: fallback.updatedAt, error: error.message };
        }
        throw error;
      } finally {
        for (const reader of operation.listeners) reader.cleanup?.();
        operation.listeners.clear();
        if (pending === operation) pending = null;
      }
    });
    if (mayCache) pending = operation;
    return operation.promise;
  };
  return { load, invalidate, hold, fence: () => { const version = epoch; return () => version === epoch; } };
}

return createDashboardCache;
})();
import { prepareResearch, researchSelection } from './research-policy.js';
import { validGeneratedImage } from './reply-widgets.js';
import { installReleaseNotes } from './release-notes.js';
import { installWorkspaceSync } from './workspace-sync.js';
import { installUsage } from './usage.js';
import { BrowserTools, isWebURL } from './browser-tools.js';
import { applyPersonality, FULL_CHAT_PATH, FULL_CHAT_PREFIX, installSidebarAddressSearch, readExperiments } from './experiments.js';
import { readBrowserStats } from './browser-stats.js';
import { themeReferenceImages } from './theme-references.js';
import { installContextBackground } from './context-background.js';
import { installTranslation } from './translation-background.js';
import { HAS_APP_UPDATER, HAS_NATIVE_HELPER, NATIVE_HOST } from './platform.js';
import { readDashboardPreference } from './dashboard-preference.js';

export { NATIVE_HOST };
// Extension-local copy of the helper's Organato switches. The helper's file stays
// the source of truth; this copy lets new tabs honour "off" without starting it
// and lets open new tabs follow a change made in Settings or setup.
export const ORGANATO_SWITCHES_KEY = 'organato.switches.v1';

export async function loadOrganatoSwitches(api) {
  try {
    const value = (await api.storage.local.get(ORGANATO_SWITCHES_KEY))?.[ORGANATO_SWITCHES_KEY];
    return value && typeof value.enabled === 'boolean' && typeof value.dashboardEnabled === 'boolean' ? { enabled: value.enabled, dashboardEnabled: value.dashboardEnabled } : null;
  } catch { return null; }
}

export async function saveOrganatoSwitches(api, { enabled, dashboardEnabled }) {
  if (typeof enabled !== 'boolean' || typeof dashboardEnabled !== 'boolean') return;
  try { await api.storage.local.set({ [ORGANATO_SWITCHES_KEY]: { enabled, dashboardEnabled } }); } catch { /* the helper still answers */ }
}

function createOrganatoTransport(api) {
  const pending = new Map();
  let serial = 0, native = null, idleTimer;
  const release = () => {
    clearTimeout(idleTimer);
    const connection = native;
    native = null;
    connection?.disconnect();
  };
  const releaseWhenIdle = () => {
    clearTimeout(idleTimer);
    if (!pending.size) idleTimer = setTimeout(release, 250);
  };
  const connect = () => {
    clearTimeout(idleTimer);
    if (native) return native;
    const connection = api.runtime.connectNative(NATIVE_HOST);
    native = connection;
    connection.onMessage.addListener(message => {
      if (native !== connection) return;
      const request = pending.get(message?.id);
      if (!request) return;
      if (message.type === 'organato-cache') { request.progress?.(message.value); return; }
      if (message.type === 'organato-progress') { request.progress?.(message.stage); return; }
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.ok) request.resolve(message.value);
      else { const error = new Error(message.error); if (message.status !== undefined) error.status = message.status; if (message.code !== undefined) error.code = message.code; request.reject(error); }
      releaseWhenIdle();
    });
    connection.onDisconnect.addListener(() => {
      void api.runtime.lastError;
      if (native !== connection) return;
      native = null;
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Organato helper disconnected.')); }
      pending.clear();
    });
    return connection;
  };
  const ask = (owner, type, values, progress, timeoutMs) => new Promise((resolve, reject) => {
    const id = `organato_${++serial}`;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('Organato timed out. Try again.')); releaseWhenIdle(); }, timeoutMs);
    pending.set(id, { owner, resolve, reject, timer, progress });
    try { connect().postMessage({ type, id, ...values }); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); releaseWhenIdle(); }
  });
  const close = owner => {
    for (const [id, request] of pending) {
      if (request.owner !== owner) continue;
      clearTimeout(request.timer);
      pending.delete(id);
      request.reject(new Error('Closed'));
    }
    if (!pending.size) release();
  };
  return { ask, close };
}

function installCommands(api, toggleAssistant) {
  api.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-breezer-ai') { toggleAssistant?.(tab); return; }
    const space = /^space-([1-4])$/.exec(command);
    if (!space) return;
    void (async () => {
      const current = tab?.windowId !== undefined ? tab
        : (await api.tabs.query({ active: true, currentWindow: true }))[0];
      if (current?.windowId === undefined) return;
      await api.runtime.sendMessage({
        type: 'breezer.workspace.space', windowId: current.windowId, index: Number(space[1]) - 1,
      });
    })().catch(() => {});
  });
}

export function installBackground(api) {
  installTranslation(api);
  installWorkspaceSync(api);
  void installSidebarAddressSearch(api);
  installUsage(api);
  const organato = createOrganatoTransport(api);
  const dashboardCache = createDashboardCache();
  const cacheOwner = {};
  installReleaseNotes(api);
  if (HAS_APP_UPDATER) api.runtime.onConnect.addListener(port => {
    if (port.name !== 'breezer-updates') return;
    if (port.sender?.id !== api.runtime.id || port.sender?.tab?.incognito) return;
    let url;
    try { url = new URL(port.sender.url); } catch { return; }
    url.hash = ''; url.search = '';
    if (url.href !== api.runtime.getURL('workspace.html')) return;
    const pending = new Map();
    let native = null, idleTimer, closed = false, candidate = false, installing = false;
    const release = () => {
      clearTimeout(idleTimer);
      const connection = native; native = null;
      try { connection?.disconnect(); } catch {}
    };
    const releaseWhenIdle = () => {
      clearTimeout(idleTimer);
      if (!pending.size && !candidate && !installing) idleTimer = setTimeout(release, 250);
    };
    const connect = () => {
      clearTimeout(idleTimer);
      if (native) return native;
      const connection = api.runtime.connectNative(NATIVE_HOST);
      native = connection;
      connection.onMessage.addListener(message => {
        if (closed || native !== connection || message?.type !== 'update-result' || !pending.has(message.id)) return;
        const type = pending.get(message.id); pending.delete(message.id);
        if (message.ok) {
          if (type === 'update-check') candidate = message.value?.available === true;
          if (type === 'update-install' && message.value?.installing === true) { candidate = false; installing = true; }
          if (type === 'update-status' && ['installed', 'failed'].includes(message.value?.phase)) installing = false;
        }
        try { port.postMessage(message); } catch {}
        releaseWhenIdle();
      });
      connection.onDisconnect.addListener(() => {
        void api.runtime.lastError;
        if (closed || native !== connection) return;
        native = null;
        try { port.disconnect(); } catch {}
      });
      return connection;
    };
    port.onMessage.addListener(message => {
      if (closed || !['update-check', 'update-install', 'update-status'].includes(message?.type)
          || typeof message.id !== 'string' || message.id.length >= 100 || pending.has(message.id)) return;
      pending.set(message.id, message.type);
      try { connect().postMessage({ type: message.type, id: message.id }); }
      catch { try { port.disconnect(); } catch {} }
    });
    port.onDisconnect.addListener(() => { closed = true; pending.clear(); release(); });
  });
  api.runtime.onConnect.addListener(port => {
    if (!['breezer-newtab', 'breezer-organato-settings'].includes(port.name)) return;
    if (port.sender?.id !== api.runtime.id || port.sender?.tab?.incognito) return;
    let url; try { url = new URL(port.sender.url); url.hash = ''; url.search = ''; } catch { return; }
    const settings = port.name === 'breezer-organato-settings';
    if (settings && !HAS_NATIVE_HELPER) return;
    if (url.href !== api.runtime.getURL(settings ? 'workspace.html' : 'newtab.html')) return;
    let closed = false, revision = 0, readerController;
    const ask = (type, values = {}, progress) => closed
      ? Promise.reject(new Error('Closed'))
      : organato.ask(port, type, values, progress, settings ? 90000 : 65000);
    const remember = value => { if (value && typeof value === 'object') void saveOrganatoSwitches(api, value); return value; };
    port.onMessage.addListener(message => {
      void (async () => {
        if (closed || typeof message?.id !== 'string' || message.id.length > 100) return;
        if (!settings) { readerController?.abort(); readerController = new AbortController(); }
        const readerSignal = readerController?.signal;
        const requestRevision = settings ? revision : ++revision;
        let value;
        if (settings) {
          if (!['view', 'configure'].includes(message.type)) throw new Error('Unknown settings action.');
          const release = message.type === 'configure' ? dashboardCache.hold() : null;
          try { value = remember(await ask(message.type === 'view' ? 'organato-view' : 'organato-configure', { settings: message.settings }, stage => { if (!closed) port.postMessage({ type: 'progress', id: message.id, stage }); })); } finally { release?.(); }
        } else {
          if (!['view', 'refresh'].includes(message.type)) throw new Error('Unknown new-tab action.');
          // Saved master-off always skips the helper; dashboard-off does so except on refresh.
          // Settings and setup own the saved copy; a new tab only fills it in once
          // (profiles from before it existed), so a slow read never overwrites a newer choice.
          const sites = Promise.resolve().then(() => api.topSites.get()).then(raw => raw.slice(0, 32).filter(site => /^https?:\/\//.test(site.url)));
          // Observe an early failure while retaining the existing config-first error order.
          void sites.catch(() => {});
          const saved = HAS_NATIVE_HELPER ? await loadOrganatoSwitches(api)
            : { enabled: false, dashboardEnabled: await readDashboardPreference(api) };
          if (message.earlySites === true && saved?.dashboardEnabled !== false) {
            void sites.then(topSites => {
              if (!closed && revision === requestRevision) port.postMessage({ type: 'sites', id: message.id, topSites });
            }).catch(() => {});
          }
          let config;
          const refresh = message.refresh === true || message.type === 'refresh';
          const getConfig = () => saved?.enabled === false || (!refresh && saved?.dashboardEnabled === false)
            ? Promise.resolve(saved) : ask('organato-view', { dashboardCache: 1 });
          try { config = await getConfig(); } catch (error) {
            dashboardCache.invalidate();
            const topSites = await sites.catch(() => []);
            if (!closed) port.postMessage({ type: 'view', id: message.id, topSites, organato: { error: error.message } });
            return;
          }
          if (!saved) remember(config);
          let savedResult = null;
          let valid = () => true;
          const active = () => !closed && revision === requestRevision && valid();
          const applyList = (dashboard, result, cached = false) => {
            const items = result.items.map(item => ({ ...item, dueAt: item.dueAt || item.dueDateLocal, allDay: !item.dueAt && Boolean(item.dueDateLocal) })).filter(item => !['submitted', 'completed'].includes(item.workingStatus)).sort((a, b) => String(a.dueAt || a.dueDateLocal || '9999').localeCompare(String(b.dueAt || b.dueDateLocal || '9999')));
            dashboard.exams = items.filter(item => item.kind !== 'todo' && ['checkpoint', 'both'].includes(item.classification)).slice(0, 200);
            dashboard.assignments = items.filter(item => item.kind === 'work' && ['assignment', 'both'].includes(item.classification)).slice(0, 200);
            dashboard.todos = items.filter(item => item.kind === 'todo').slice(0, 200);
            dashboard.truncated = result.truncated;
            dashboard.syncedAt = result.syncedAt;
            dashboard.cached = cached;
          };
          const progress = result => {
            savedResult = result;
            const currentFence = valid;
            void sites.then(topSites => {
              if (!currentFence() || !active() || savedResult !== result || result.fingerprint !== config.fingerprint) return;
              const dashboard = { ...config, exams: [], assignments: [], todos: [] };
              applyList(dashboard, result, true);
              port.postMessage({ type: 'view', id: message.id, pending: true, topSites, organato: dashboard, dashboardEnabled: config.dashboardEnabled });
            }).catch(() => {});
          };
          const loadList = async () => {
            for (let attempt = 0; ; attempt++) {
              const fingerprint = config.cacheCapability === 1 && /^[a-f0-9]{64}$/.test(config.fingerprint || '') ? config.fingerprint : null;
              if (!fingerprint) {
                dashboardCache.invalidate();
                return { value: await ask('organato-list', { refresh }) };
              }
              try {
                const loading = dashboardCache.load({ fingerprint, refresh: refresh && attempt === 0, onCached: progress, active, signal: readerSignal, fetch: async onCached => {
                  const result = await organato.ask(cacheOwner, 'organato-list', { refresh, dashboardIdentity: fingerprint }, onCached, 65000);
                  if (result?.fingerprint !== fingerprint) { const error = new Error('Organato context changed.'); error.code = 'DASHBOARD_CHANGED'; throw error; }
                  return result;
                } });
                valid = dashboardCache.fence();
                return await loading;
              } catch (error) {
                if (error.code !== 'DASHBOARD_CHANGED' || attempt || closed) throw error;
                config = await getConfig();
                if (config.enabled === false || !config.connected || !config.dashboardEnabled) throw error;
              }
            }
          };
          const list = config.enabled !== false && config.connected && config.dashboardEnabled ? loadList() : null;
          valid = dashboardCache.fence();
          if (!list) { dashboardCache.invalidate(); valid = dashboardCache.fence(); }
          // Sites errors retain priority, even if the concurrent list fails first.
          void list?.catch(() => {});
          const topSites = await sites;
          // Off carries no account state or items, so nothing stale can be drawn.
          const dashboard = config.enabled === false ? { enabled: false } : { ...config, exams: [], assignments: [], todos: [] };
          if (list) {
            try {
              const loaded = await list;
              const result = loaded.value;
              if (loaded.stale) { dashboard.stale = true; dashboard.updatedAt = loaded.updatedAt; dashboard.error = loaded.error; }
              if (!active()) throw Object.assign(new Error('Organato dashboard context changed.'), { code: 'DASHBOARD_CHANGED' });
              applyList(dashboard, result, loaded.saved === true);
            } catch (error) { savedResult = null; dashboard.error = error.message; dashboard.exams = []; dashboard.assignments = []; dashboard.todos = []; }
          }
          savedResult = null;
          value = { topSites, organato: config.enabled === false ? { enabled: false } : dashboard, dashboardEnabled: config.dashboardEnabled };
        }
        if (!closed && revision === requestRevision) port.postMessage(settings ? { id: message.id, ok: true, value } : { type: 'view', id: message.id, ...value });
      })().catch(error => { if (!closed) { try { port.postMessage(settings ? { id: message.id, ok: false, error: error.message } : { type: 'view', id: message.id, topSites: [], organato: { error: error.message } }); } catch {} } });
    });
    port.onDisconnect.addListener(() => { closed = true; readerController?.abort(); organato.close(port); });
  });
  if (!HAS_NATIVE_HELPER) {
    installCommands(api);
    return;
  }
  const panels = new Set();
  const runs = new Map();
  const replyWrites = new Map();
  const post = (port, message) => { try { port.postMessage(message); } catch { /* The panel may close during a request. */ } };
  const fullChatKey = tabId => 'chat-tab-' + tabId;
  const runKey = panel => panel.fullChat ? fullChatKey(panel.tabId) : panel.windowId;
  const runFor = panel => runs.get(runKey(panel));
  const controlRun = () => [...runs.values()].find(run => run.control);
  const current = run => runFor(run.panel) === run;
  const replyKey = windowId => `breezer-pending-reply-${windowId}`;
  const writeReply = (windowId, write) => {
    if (windowId === undefined || !api.storage.session) return;
    const pending = (replyWrites.get(windowId) || Promise.resolve()).then(() => write(replyKey(windowId))).catch(() => {});
    replyWrites.set(windowId, pending);
    void pending.then(() => { if (replyWrites.get(windowId) === pending) replyWrites.delete(windowId); });
    return pending;
  };
  const releaseNative = panel => {
    const native = panel.native;
    panel.native = null;
    try { native?.disconnect(); } catch {}
    panel.releaseCache?.();
    panel.releaseCache = null;
  };
  const turnState = run => ({
    type: 'turn-state', id: run.id, user: run.user, text: run.text,
    browserTask: run.browserTask, stats: run.statsSummary,
  });
  const endRun = (run, terminal) => {
    runs.delete(runKey(run.panel));
    let saved;
    if (!run.control) {
      // Keep a completed turn until the panel confirms its transcript was saved.
      const index = terminal.themeProposal?.imageAttachment;
      const value = { ...turnState(run), terminal };
      if (index) value.themeImage = run.themeImages[index - 1].image;
      saved = writeReply(runKey(run.panel), key => api.storage.session.set({ [key]: value }));
      if (index && run.reader !== run.panel) terminal = { ...terminal, themeImage: value.themeImage };
    }
    if (run.reader) post(run.reader.port, terminal);
    if (run.panel.closed) {
      if (saved) void saved.then(() => releaseNative(run.panel));
      else releaseNative(run.panel);
    }
  };
  const tools = new BrowserTools(api, (id, reason) => {
    for (const panel of panels) post(panel.port, { type: 'activity', id, active: false, label: '' });
    const run = controlRun();
    if (run?.session?.id === id) void cancel(run, reason || 'Browser control stopped.', 'browser-control');
  });
  const contextMemory = installContextBackground(api, {
    isPermitted(tab) {
      try { return tab?.incognito === false && tools.grants.get(tab.id) === new URL(tab.url).origin; }
      catch { return false; }
    },
  });
  const cancel = async (run, reason, source) => {
    if (!run || !current(run)) return;
    try { run.panel.native?.postMessage({ type: 'cancel', id: run.id }); } catch { /* Native host already exited. */ }
    endRun(run, reason
      ? { type: 'error', id: run.id, error: reason, ...(source ? { source } : {}) }
      : { type: 'complete', id: run.id, cancelled: true });
    await tools.stop(run.session);
  };
  const ensureActive = run => {
    if (!current(run)) throw new Error('Request stopped.');
  };
  const currentPage = async panel => {
    const [tab] = await api.tabs.query({ active: true, ...(panel.windowId === undefined ? { currentWindow: true } : { windowId: panel.windowId }) });
    await tools.verifyGrant(tab);
    void contextMemory.observeGranted(tab);
    return tools.current(panel.windowId);
  };
  const publishMetadata = async (windowId, expectedTabId) => {
    for (const panel of panels) {
      if (panel.fullChat || panel.closed || !panel.visible || panel.windowId === undefined || (windowId !== undefined && panel.windowId !== windowId)) continue;
      const revision = ++panel.metadataRevision;
      const [tab] = await api.tabs.query({ active: true, windowId: panel.windowId });
      if (!tab || panel.closed || !panel.visible || panel.metadataRevision !== revision || (expectedTabId !== undefined && tab.id !== expectedTabId)) continue;
      post(panel.port, { type: 'context', context: { url: tab.url || '', title: tab.title || '', tabId: tab.id } });
    }
  };
  const connectNative = panel => {
    if (panel.native) return panel.native;
    const release = dashboardCache.hold();
    let native;
    try { native = api.runtime.connectNative(NATIVE_HOST); } catch (error) { release(); throw error; }
    panel.releaseCache = release;
    panel.native = native;
    native.onMessage.addListener(message => {
      if (panel.native !== native || !message || typeof message !== 'object') return;
      if (message.type === 'status') { post(panel.port, message); return; }
      const run = runFor(panel);
      const ownsRun = run?.panel === panel;
      if (message.type === 'error' && !message.id) {
        if (ownsRun) void cancel(run, message.error);
        else if (run?.reader !== panel) post(panel.port, message);
        return;
      }
      if (!ownsRun || message.id !== run.id) return;
      if (message.type === 'tool') {
        void (async () => {
          const response = { type: 'toolResult', id: run.id, requestId: message.requestId };
          try {
            ensureActive(run);
            if (typeof message.requestId !== 'string' || message.requestId.length > 200) throw new Error('Invalid browser tool request.');
            if (message.name === 'browser_stats') {
              if (run.browserTask !== 'stats') throw new Error('Browser stats are off for this request.');
              response.result = run.stats;
            } else if (message.name === 'browser_propose_theme') {
              if (run.browserTask !== 'theme') throw new Error('Theme design is off for this request.');
              const { name, theme, colorMode, html, imageAttachment } = message.args || {};
              if (typeof name !== 'string' || !name.trim() || name.length > 48 || typeof theme !== 'string' ||
                  !/^#[0-9a-f]{6}$/i.test(theme) || !['system', 'light', 'dark'].includes(colorMode) ||
                  (html !== undefined && (typeof html !== 'string' || html.length > 40000))) {
                throw new Error('Provide a name, hex color, color mode, and optional HTML of up to 40,000 characters.');
              }
              if (imageAttachment !== undefined && (!Number.isInteger(imageAttachment) || imageAttachment < 1 || imageAttachment > run.themeImages.length)) {
                throw new Error('Choose an image from the latest image attachments.');
              }
              run.themeProposal = { name, theme, colorMode, ...(html === undefined ? {} : { html }), ...(imageAttachment === undefined ? {} : { imageAttachment }) };
              response.result = { staged: true, name, applied: false };
            } else if (message.name === 'browser_snapshot' && !run.control && run.includeContext && run.tab) response.result = await tools.snapshot(run.tab, null, true, () => current(run));
            else {
              if (!run.session || !run.control) throw new Error('Browser control is off. Enable it before sending a request.');
              response.result = await tools.execute(run.session, message.name, message.args);
            }
            ensureActive(run);
          } catch (error) { response.error = error.message; }
          if (current(run)) { try { native.postMessage(response); } catch {} }
        })();
      } else if (message.type === 'delta' && typeof message.text === 'string') {
        if (!run.control) run.text += message.text;
        if (run.reader) post(run.reader.port, message);
      } else if (message.type === 'complete' || message.type === 'error') {
        let terminal = message;
        if (message.generatedImage !== undefined && (run.browserTask !== 'image' || !validGeneratedImage(message.generatedImage))) {
          const { generatedImage, ...ordinaryResponse } = message;
          terminal = ordinaryResponse;
        }
        if (message.type === 'complete' && !message.cancelled) {
          if (run.themeProposal) terminal = { ...message, themeProposal: run.themeProposal };
          else if (run.browserTask === 'theme') terminal = { type: 'error', id: run.id, source: 'theme', error: 'The model did not create a theme preview. Try again or choose another model.' };
        }
        endRun(run, terminal);
        void tools.stop(run.session);
      }
    });
    native.onDisconnect.addListener(() => {
      if (panel.native !== native) return;
      panel.native = null;
      panel.releaseCache?.(); panel.releaseCache = null;
      const detail = api.runtime.lastError?.message;
      const error = `Breezer AI could not connect to its local helper. Restart Breezer and reopen the sidebar. If it still cannot connect, reinstall Breezer.${detail ? ` ${detail}` : ''}`;
      const run = runFor(panel);
      if (run?.panel === panel) void cancel(run, error);
      else if (run?.reader !== panel) post(panel.port, { type: 'error', error });
    });
    return native;
  };
  const sendChat = async (panel, message) => {
    if (typeof message.id !== 'string' || message.id.length > 200 || !['codex', 'claude'].includes(message.provider) || typeof message.message !== 'string' || !message.message.trim() || message.message.length > 50000 || typeof message.model !== 'string') throw new Error('Choose a provider and model, then enter a message.');
    if (panel.fullChat && !Number.isInteger(panel.windowId)) throw new Error('Open the chat tab before sending a message.');
    if (panel.fullChat && (message.control || message.includeContext || message.researchSources !== undefined || message.pdfView !== undefined)) {
      throw new Error('Page sharing and browser control are available from the sidebar.');
    }
    const browserTask = message.browserTask;
    const pdfView = message.pdfView;
    if (pdfView !== undefined && (typeof pdfView !== 'string' || pdfView.length > 2 * 1024 * 1024
        || !/^data:image\/jpeg;base64,[a-zA-Z0-9+/]+={0,2}$/.test(pdfView)
        || !Number.isInteger(message.tabId) || message.includeContext !== true || message.control === true
        || browserTask !== undefined || message.researchSources !== undefined)) {
      throw new Error('Invalid PDF viewport. Open the PDF and send again.');
    }
    if (browserTask !== undefined && (!['stats', 'theme', 'image'].includes(browserTask) || message.control === true || message.includeContext === true || message.researchSources !== undefined)) throw new Error('This request requires page access and research to be off.');
    if (browserTask === 'image' && (message.provider !== 'codex' || !/^gpt-/i.test(message.model)
        || message.message.length > 4_000 || message.attachments?.length || message.history?.length)) {
      throw new Error('Image generation requires a GPT model and a text prompt of up to 4,000 characters.');
    }
    if (runFor(panel)) await cancel(runFor(panel));
    if (message.control === true && controlRun()) await cancel(controlRun(), 'Browser control moved to another tab.', 'browser-control');
    if (runFor(panel) || (message.control === true && controlRun())) throw new Error('A response is already running. Stop it before sending another message.');
    if (panel.closed || !panel.visible) throw new Error('The assistant closed. Reopen it and select sources again.');
    const run = {
      id: message.id, panel, reader: panel, browserTask, control: message.control === true,
      includeContext: message.includeContext === true || message.control === true, session: null, tab: null, text: '',
      user: { id: message.id, role: 'user', text: message.message, attachments: message.attachments, contextTitle: message.contextTitle },
    };
    const history = Array.isArray(message.history) ? message.history.slice(-40) : [];
    if (browserTask === 'theme') run.themeImages = themeReferenceImages(message.attachments, history);
    runs.set(runKey(panel), run);
    try {
      let context, researchSources;
      if (browserTask === 'stats') {
        let windowId = panel.windowId;
        if (panel.fullChat) {
          const tab = await api.tabs.get(panel.tabId);
          ensureActive(run);
          if (tab?.incognito || tab?.url !== api.runtime.getURL(FULL_CHAT_PATH) ||
              (tab.pendingUrl && tab.pendingUrl !== tab.url)) throw new Error('The chat tab is no longer open.');
          windowId = tab.windowId;
        }
        run.stats = await readBrowserStats(api, windowId);
        ensureActive(run);
        const { windowTabCount, totalTabCount, browserMemory, systemMemory } = run.stats;
        run.statsSummary = { windowTabCount, totalTabCount, browserMemory, systemMemory };
        if (run.reader) post(run.reader.port, { type: 'browser-stats', id: run.id, stats: run.statsSummary });
      }
      if (message.researchSources !== undefined) {
        if (message.control || message.includeContext) throw new Error('Research sources do not authorize browser control or active-page sharing.');
        const draft = panel.researchDraft;
        if (draft?.id !== run.id) throw new Error('Source selection expired. Select tabs and send again.');
        run.research = draft;
        researchSources = await prepareResearch(api, message.researchSources, draft, panel.windowId);
        ensureActive(run);
        if (draft.invalidated) throw new Error('A source changed during capture. Select sources and send again.');
        if (!researchSources.some(source => source.status === 'available' && source.text)) throw new Error('No source text is available. Select loaded tabs and try again.');
        run.user.sourceMetadata = researchSources.map(({ text, ...source }) => source);
      }
      if (pdfView) {
        const [active] = await api.tabs.query({ active: true, windowId: panel.windowId });
        ensureActive(run);
        if (active?.id !== message.tabId || active.incognito !== false) {
          throw new Error('The active PDF tab changed before sending.');
        }
        context = { kind: 'pdf-view', screenshot: pdfView };
      } else if (run.includeContext) {
        const tab = await currentPage(panel);
        if (Number.isInteger(message.tabId) && tab?.id !== message.tabId) throw new Error('The active page changed before it could be shared. Send again from the page you want to share.');
        run.tab = tab;
        ensureActive(run);
        if (run.control) {
          run.session = await tools.start(run.id, tab, () => current(run) && !panel.closed, session => { run.session = session; });
          ensureActive(run);
          post(panel.port, { type: 'activity', id: run.id, active: true, label: 'Taking action' });
        }
        context = await tools.snapshot(tab, run.session, true, () => current(run));
        ensureActive(run);
      }
      const personal = await readExperiments(api);
      const profile = applyPersonality({
        name: String(message.profile?.name || '').slice(0, 100),
        context: String(message.profile?.context || '').slice(0, 20_000),
      }, personal);
      profile.context = profile.context.slice(0, 20_000);
      ensureActive(run);
      const native = connectNative(panel);
      native.postMessage({
        type: 'chat', id: run.id, provider: message.provider, model: message.model,
        ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
        ...(message.provider === 'codex' && message.speed !== undefined ? { speed: message.speed } : {}),
        message: message.message, attachments: message.attachments, history,
        profile,
        ...(researchSources ? { researchSources } : {}),
        ...(browserTask ? { browserTask } : {}),
        context, includeContext: message.includeContext === true || run.control, control: run.control,
      });
      run.submitted = true;
    } catch (error) {
      if (current(run)) {
        releaseNative(panel);
        await cancel(run, error.message);
      }
    }
  };
  const restoreTurn = async panel => {
    const attach = () => {
      const run = runFor(panel);
      if (!run || run.control) return false;
      run.reader = panel;
      post(panel.port, turnState(run));
      return true;
    };
    if (attach() || !api.storage.session) return;
    const key = replyKey(runKey(panel));
    await replyWrites.get(runKey(panel));
    const saved = (await api.storage.session.get(key).catch(() => ({})))[key];
    if (!panel.closed && !attach() && !runFor(panel) && saved) post(panel.port, saved);
  };
  const hidePanel = (panel, reason) => {
    panel.metadataRevision++;
    panel.visible = false;
    invalidateResearch(panel, undefined, reason);
    const run = runFor(panel);
    if (run?.reader === panel && run.control) void cancel(run, 'Browser control stopped because the sidebar closed.', 'browser-control');
  };
  const requestModelCatalog = panel => {
    if (panel.closed) return;
    const native = connectNative(panel);
    try { native.postMessage({ type: 'init' }); }
    catch (error) { releaseNative(panel); throw error; }
  };
  api.runtime.onConnect.addListener(port => {
    if (port.name !== 'breezer-panel') return;
    const sender = port.sender;
    if (sender?.id !== api.runtime.id || sender?.tab?.incognito) return;
    const fullChat = sender.url === api.runtime.getURL(FULL_CHAT_PATH)
      && Number.isInteger(sender.tab?.id) && Number.isInteger(sender.tab.windowId) && sender.frameId === 0;
    if (!fullChat && sender.url !== api.runtime.getURL('panel.html')) return;
    const panel = { port, fullChat, tabId: fullChat ? sender.tab.id : undefined, native: null, closed: false, visible: true, windowId: undefined, metadataRevision: 0, ready: Promise.resolve() };
    panels.add(panel);
    port.onMessage.addListener(message => {
      void (async () => {
        if (!message || typeof message !== 'object' || panel.closed) return;
        if (message.type === 'init') {
          panel.ready = (async () => {
            if (fullChat) {
              panel.windowId = sender.tab.windowId;
              await restoreTurn(panel);
              return;
            }
            const [tab] = await api.tabs.query({ active: true, ...(Number.isInteger(message.windowId) ? { windowId: message.windowId } : { currentWindow: true }) });
            if (panel.closed) return;
            panel.windowId = tab?.windowId ?? message.windowId;
            await tools.verifyGrant(tab);
            void contextMemory.observeGranted(tab);
            if (!panel.closed) await restoreTurn(panel);
          })();
          await panel.ready;
          requestModelCatalog(panel);
        } else if (message.type === 'refresh-models') {
          await panel.ready;
          if (Number.isInteger(panel.windowId)) requestModelCatalog(panel);
        } else if (message.type === 'research-begin') {
          if (fullChat) return;
          await panel.ready;
          panel.researchDraft = { id: message.id, selection: researchSelection(message.sources), invalidated: false };
        } else if (message.type === 'chat') { await panel.ready; await sendChat(panel, message); }
        else if (message.type === 'visibility') {
          if (message.visible === true) { panel.metadataRevision++; panel.visible = true; }
          else hidePanel(panel, 'Panel closed. Select sources again.');
        }
        else if (message.type === 'cancel') {
          if (panel.researchDraft) panel.researchDraft.invalidated = true;
          const run = runFor(panel);
          if (run?.reader === panel && (!message.id || run.id === message.id)) await cancel(run);
        } else if (message.type === 'turn-saved' || message.type === 'clear-turn') {
          await panel.ready;
          await writeReply(runKey(panel), async key => {
            if (message.type === 'clear-turn' || (await api.storage.session.get(key))[key]?.id === message.id) await api.storage.session.remove(key);
          });
        } else if (message.type === 'context') {
          await panel.ready;
          await publishMetadata(panel.windowId);
        }
      })().catch(error => post(port, { type: 'error', id: message?.id, error: error.message }));
    });
    port.onDisconnect.addListener(() => {
      panel.closed = true;
      panels.delete(panel);
      hidePanel(panel, 'Panel closed. Select sources again.');
      const run = runFor(panel);
      if (run?.reader === panel) run.reader = null;
      if (run?.panel !== panel) releaseNative(panel);
    });
  });
  const toggle = tab => {
    if (!tab?.id) return;
    tools.authorize(tab);
    void contextMemory.observeGranted(tab);
    const panel = [...panels].find(item => !item.fullChat && item.windowId === tab.windowId && !item.closed && item.visible);
    if (panel && api.sidePanel.close) {
      const run = runFor(panel);
      if (run?.control) void cancel(run, 'Browser control stopped because the sidebar closed.', 'browser-control');
      void api.sidePanel.close({ windowId: tab.windowId }).catch(error => post(panel.port, { type: 'error', error: error.message }));
    } else {
      // Call open in the user gesture's event stack, before awaiting any work.
      void api.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
  };
  installCommands(api, toggle);
  api.action.onClicked.addListener(toggle);
  api.sidePanel.onClosed?.addListener(info => {
    for (const panel of panels) if (!panel.fullChat && panel.windowId === info.windowId) hidePanel(panel, 'Panel closed. Select source tabs again.');
  });
  api.sidePanel.onOpened?.addListener(info => {
    for (const panel of panels) if (!panel.fullChat && panel.windowId === info.windowId) panel.visible = true;
  });
  api.runtime.onMessage.addListener((message, sender) => {
    const run = controlRun();
    if (message?.type === 'stop-control' && run?.session?.id === message.sessionId && sender.tab?.id === run.session.tab.id) void cancel(run, 'Browser control stopped.');
  });
  const invalidateResearch = (panel, tabId, reason) => {
    if (tabId !== undefined && !panel.researchDraft?.selection.some(source => source.tabId === tabId)) {
      post(panel.port, { type: 'research-invalidated', tabId, reason }); return;
    }
    if (panel.researchDraft) panel.researchDraft.invalidated = true;
    post(panel.port, { type: 'research-invalidated', tabId, reason });
    const run = runFor(panel);
    if (run?.panel === panel && run.research && !run.submitted) void cancel(run, reason);
  };
  api.tabs.onActivated.addListener(info => {
    for (const panel of panels) if (panel.windowId === info.windowId) invalidateResearch(panel, undefined, 'Active tab changed. Select source tabs again.');
    const run = runs.get(info.windowId);
    if (run?.control && info.tabId !== run.tab?.id) void cancel(run, 'Browser control stopped because the active tab changed.', 'browser-control');
    void publishMetadata(info.windowId, info.tabId).catch(() => {});
  });
  api.tabs.onRemoved.addListener(tabId => {
    for (const panel of panels) invalidateResearch(panel, tabId, 'Source closed. Select source tabs again.');
    tools.grants.delete(tabId);
    const run = controlRun();
    if (run?.tab?.id === tabId) void cancel(run, 'Browser control stopped because the tab closed.');
    const key = fullChatKey(tabId);
    void cancel(runs.get(key));
    void writeReply(key, storageKey => api.storage.session.remove([storageKey, FULL_CHAT_PREFIX + tabId]));
  });
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === 'loading') for (const panel of panels) invalidateResearch(panel, tabId, 'Source navigated or is loading. Select source tabs again.');
    if (tab?.active !== false && (change.url || change.title || change.status === 'complete')) void publishMetadata(tab?.windowId, tabId).catch(() => {});
    if (change.url && tools.grants.has(tabId)) {
      try { if (tools.grants.get(tabId) !== new URL(change.url).origin) tools.grants.delete(tabId); } catch { tools.grants.delete(tabId); }
    }
    const run = controlRun();
    if (run?.session?.tab.id !== tabId) return;
    if (change.url && !isWebURL(change.url)) {
      void cancel(run, 'Browser control stopped because this is not an http or https page.');
    } else if (change.status === 'loading') tools.navigationStarted(run.session);
    else if (change.status === 'complete') void tools.navigationComplete(run.session);
  });
  api.tabs.onDetached?.addListener(tabId => {
    for (const panel of panels) invalidateResearch(panel, tabId, 'Source moved to another window. Select source tabs again.');
  });
  api.windows?.onFocusChanged?.addListener(windowId => {
    // WINDOW_ID_NONE means another app has focus. Input still goes only to the controlled
    // tab, so watching from another app does not end control; another Breezer window does.
    if (windowId === (api.windows.WINDOW_ID_NONE ?? -1)) return;
    for (const panel of panels) if (panel.windowId !== windowId) invalidateResearch(panel, undefined, 'Browser window changed. Select source tabs again.');
    const run = controlRun();
    if (run && run.panel.windowId !== windowId) void cancel(run, 'Browser control stopped because the active window changed.', 'browser-control');
  });
  api.windows?.onRemoved?.addListener(windowId => {
    void cancel(runs.get(windowId));
    void writeReply(windowId, storageKey => api.storage.session.remove(storageKey));
  });
  api.debugger.onDetach.addListener(source => {
    const run = controlRun();
    if (run?.session?.tab.id === source.tabId) void cancel(run, 'Browser control stopped because the debugger detached.');
  });
  api.debugger.onEvent.addListener((source, method, params) => tools.debuggerEvent(source, method, params));
  return { tools, panels, cancel: () => Promise.all([...runs.values()].map(run => cancel(run))) };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) installBackground(chrome);
