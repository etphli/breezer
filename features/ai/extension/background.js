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
import { installReleaseNotes } from './release-notes.js';
import { installWorkspaceSync } from './workspace-sync.js';
import { installUsage } from './usage.js';
import { BrowserTools, isWebURL } from './browser-tools.js';
import { readBrowserStats } from './browser-stats.js';
import { themeReferenceImages } from './theme-references.js';
import { installContextBackground } from './context-background.js';
import { installTranslation } from './translation-background.js';

export const NATIVE_HOST = 'io.github.etphli.breezer.ai';
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

export function installBackground(api) {
  installTranslation(api);
  installWorkspaceSync(api);
  installUsage(api);
  const organato = createOrganatoTransport(api);
  const dashboardCache = createDashboardCache();
  const cacheOwner = {};
  installReleaseNotes(api);
  api.runtime.onConnect.addListener(port => {
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
          const sites = Promise.resolve().then(() => api.topSites.get());
          // Observe an early failure while retaining the existing config-first error order.
          void sites.catch(() => {});
          const saved = await loadOrganatoSwitches(api);
          let config;
          const refresh = message.refresh === true || message.type === 'refresh';
          const getConfig = () => saved?.enabled === false || (!refresh && saved?.dashboardEnabled === false)
            ? Promise.resolve(saved) : ask('organato-view', { dashboardCache: 1 });
          try { config = await getConfig(); } catch (error) {
            dashboardCache.invalidate();
            const topSites = (await sites.catch(() => [])).slice(0, 32).filter(site => /^https?:\/\//.test(site.url));
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
            void sites.then(rawSites => {
              if (!currentFence() || !active() || savedResult !== result || result.fingerprint !== config.fingerprint) return;
              const dashboard = { ...config, exams: [], assignments: [], todos: [] };
              applyList(dashboard, result, true);
              port.postMessage({ type: 'view', id: message.id, pending: true, topSites: rawSites.slice(0, 32).filter(site => /^https?:\/\//.test(site.url)), organato: dashboard, dashboardEnabled: config.dashboardEnabled });
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
          const topSites = (await sites).slice(0, 32).filter(site => /^https?:\/\//.test(site.url));
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
  const panels = new Set();
  let activeRun = null;
  const post = (port, message) => { try { port.postMessage(message); } catch { /* The panel may close during a request. */ } };
  const tools = new BrowserTools(api, (id, reason) => {
    for (const panel of panels) post(panel.port, { type: 'activity', id, active: false, label: '' });
    if (activeRun?.session?.id === id && !activeRun.cancelled) void cancel(activeRun, reason || 'Browser control stopped.', 'browser-control');
  });
  const contextMemory = installContextBackground(api, {
    isPermitted(tab) {
      try { return tab?.incognito === false && tools.grants.get(tab.id) === new URL(tab.url).origin; }
      catch { return false; }
    },
  });
  const cancel = async (run, reason, source) => {
    if (!run || run.cancelled) return;
    run.cancelled = true;
    if (activeRun === run) activeRun = null;
    try { run.panel.native?.postMessage({ type: 'cancel', id: run.id }); } catch { /* Native host already exited. */ }
    await tools.stop(run.session);
    if (reason) post(run.panel.port, { type: 'error', id: run.id, error: reason, ...(source ? { source } : {}) });
  };
  const ensureActive = run => {
    if (run.cancelled || activeRun !== run || run.panel.closed) throw new Error('Request stopped.');
  };
  const currentPage = async panel => {
    const [tab] = await api.tabs.query({ active: true, ...(panel.windowId === undefined ? { currentWindow: true } : { windowId: panel.windowId }) });
    await tools.verifyGrant(tab);
    void contextMemory.observeGranted(tab);
    return tools.current(panel.windowId);
  };
  const publishMetadata = async (windowId, expectedTabId) => {
    for (const panel of panels) {
      if (panel.closed || !panel.visible || panel.windowId === undefined || (windowId !== undefined && panel.windowId !== windowId)) continue;
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
      if (!message || typeof message !== 'object') return;
      if (message.type === 'status') { post(panel.port, message); return; }
      if (message.type === 'error' && !message.id) {
        post(panel.port, message);
        if (activeRun?.panel === panel) void cancel(activeRun);
        return;
      }
      const run = activeRun;
      if (!run || run.panel !== panel || message.id !== run.id || run.cancelled) return;
      if (message.type === 'tool') {
        void (async () => {
          const response = { type: 'toolResult', id: run.id, requestId: message.requestId };
          try {
            ensureActive(run);
            if (typeof message.requestId !== 'string' || message.requestId.length > 200) throw new Error('Invalid browser tool request.');
            if (message.name === 'browser_stats') {
              if (run.browserTask !== 'stats') throw new Error('Browser stats are off for this request.');
              run.stats ||= readBrowserStats(api, panel.windowId);
              response.result = await run.stats;
            } else if (message.name === 'browser_propose_theme') {
              if (run.browserTask !== 'theme') throw new Error('Theme design is off for this request.');
              const { name, theme, colorMode, html, imageAttachment } = message.args || {};
              if (typeof name !== 'string' || !name.trim() || name.length > 48 || typeof theme !== 'string' ||
                  !/^#[0-9a-f]{6}$/i.test(theme) || !['system', 'light', 'dark'].includes(colorMode) ||
                  (html !== undefined && (typeof html !== 'string' || html.length > 40000))) {
                throw new Error('Provide a name, hex color, color mode, and optional HTML of up to 40,000 characters.');
              }
              if (imageAttachment !== undefined && (!Number.isInteger(imageAttachment) || imageAttachment < 1 || imageAttachment > run.imageCount)) {
                throw new Error('Choose an image from the latest image attachments.');
              }
              run.themeProposal = { name, theme, colorMode, ...(html === undefined ? {} : { html }), ...(imageAttachment === undefined ? {} : { imageAttachment }) };
              response.result = { staged: true, name, applied: false };
            } else if (message.name === 'browser_snapshot' && !run.control && run.includeContext && run.tab) response.result = await tools.snapshot(run.tab, null, true, () => activeRun === run && !run.cancelled);
            else {
              if (!run.session || !run.control) throw new Error('Browser control is off. Enable it before sending a request.');
              response.result = await tools.execute(run.session, message.name, message.args);
            }
            ensureActive(run);
          } catch (error) { response.error = error.message; }
          if (!run.cancelled && activeRun === run) { try { native.postMessage(response); } catch {} }
        })();
      } else if (['delta', 'complete', 'error'].includes(message.type)) {
        if (message.type === 'complete') {
          post(panel.port, {
            type: 'complete', id: run.id, ...(message.cancelled ? { cancelled: true } : {}),
            ...(!message.cancelled && run.themeProposal ? { themeProposal: run.themeProposal } : {}),
          });
        } else post(panel.port, message);
        if (message.type !== 'delta') {
          activeRun = null;
          run.cancelled = true;
          void tools.stop(run.session);
        }
      }
    });
    native.onDisconnect.addListener(() => {
      if (panel.native !== native) return;
      panel.native = null;
      panel.releaseCache?.(); panel.releaseCache = null;
      const detail = api.runtime.lastError?.message;
      const error = `Breezer AI could not connect to its local helper. Restart Breezer and reopen the sidebar. If it still cannot connect, reinstall Breezer.${detail ? ` ${detail}` : ''}`;
      post(panel.port, { type: 'error', error });
      if (activeRun?.panel === panel) void cancel(activeRun, error);
    });
    return native;
  };
  const sendChat = async (panel, message) => {
    if (typeof message.id !== 'string' || message.id.length > 200 || !['codex', 'claude'].includes(message.provider) || typeof message.message !== 'string' || !message.message.trim() || message.message.length > 50000 || typeof message.model !== 'string') throw new Error('Choose a provider and model, then enter a message.');
    const browserTask = message.browserTask;
    if (browserTask !== undefined && (!['stats', 'theme'].includes(browserTask) || message.control === true || message.includeContext === true || message.researchSources !== undefined)) throw new Error('Browser stats and theme design require page access and research to be off.');
    await cancel(activeRun);
    if (panel.closed || !panel.visible) throw new Error('The assistant closed. Reopen it and select sources again.');
    const run = { id: message.id, panel, browserTask, control: message.control === true, includeContext: message.includeContext === true || message.control === true, cancelled: false, session: null, tab: null };
    const history = Array.isArray(message.history) ? message.history.slice(-40) : [];
    if (browserTask === 'theme') run.imageCount = themeReferenceImages(message.attachments, history).length;
    activeRun = run;
    try {
      let context, researchSources;
      if (message.researchSources !== undefined) {
        if (message.control || message.includeContext) throw new Error('Research sources do not authorize browser control or active-page sharing.');
        const draft = panel.researchDraft;
        if (draft?.id !== run.id) throw new Error('Source selection expired. Select tabs and send again.');
        run.research = draft;
        researchSources = await prepareResearch(api, message.researchSources, draft, panel.windowId);
        ensureActive(run);
        if (draft.invalidated) throw new Error('A source changed during capture. Select sources and send again.');
        if (!researchSources.some(source => source.status === 'available' && source.text)) throw new Error('No source text is available. Select loaded tabs and try again.');
      }
      if (run.includeContext) {
        const tab = await currentPage(panel);
        run.tab = tab;
        ensureActive(run);
        if (run.control) {
          run.session = await tools.start(run.id, tab, () => activeRun === run && !run.cancelled && !panel.closed, session => { run.session = session; });
          ensureActive(run);
          post(panel.port, { type: 'activity', id: run.id, active: true, label: 'Taking action' });
        }
        context = await tools.snapshot(tab, run.session, true, () => activeRun === run && !run.cancelled);
        ensureActive(run);
      }
      const native = connectNative(panel);
      ensureActive(run);
      native.postMessage({
        type: 'chat', id: run.id, provider: message.provider, model: message.model,
        ...(message.reasoning !== undefined ? { reasoning: message.reasoning } : {}),
        ...(message.provider === 'codex' && message.speed !== undefined ? { speed: message.speed } : {}),
        message: message.message, attachments: message.attachments, history,
        profile: { name: String(message.profile?.name || '').slice(0, 100), context: String(message.profile?.context || '').slice(0, 20000) },
        ...(researchSources ? { researchSources } : {}),
        ...(browserTask ? { browserTask } : {}),
        context, includeContext: message.includeContext === true || run.control, control: run.control,
      });
    } catch (error) {
      if (!run.cancelled && activeRun === run) {
        if (panel.native) { try { panel.native.disconnect(); } catch {} panel.native = null; panel.releaseCache?.(); panel.releaseCache = null; }
        post(panel.port, { type: 'error', id: run.id, error: error.message }); await cancel(run);
      }
    }
  };
  api.runtime.onConnect.addListener(port => {
    if (port.name !== 'breezer-panel') return;
    if (port.sender?.id !== api.runtime.id || port.sender?.tab?.incognito || port.sender?.url !== api.runtime.getURL('panel.html')) return;
    const panel = { port, native: null, closed: false, visible: true, windowId: undefined, metadataRevision: 0, ready: Promise.resolve() };
    panels.add(panel);
    port.onMessage.addListener(message => {
      void (async () => {
        if (!message || typeof message !== 'object' || panel.closed) return;
        if (message.type === 'init') {
          panel.ready = (async () => {
            const [tab] = await api.tabs.query({ active: true, ...(Number.isInteger(message.windowId) ? { windowId: message.windowId } : { currentWindow: true }) });
            if (panel.closed) return;
            panel.windowId = tab?.windowId;
            await tools.verifyGrant(tab);
            void contextMemory.observeGranted(tab);
            if (!panel.closed) {
              const native = connectNative(panel);
              try { native.postMessage({ type: 'init' }); } catch (error) { try { native.disconnect(); } catch {} panel.native = null; panel.releaseCache?.(); panel.releaseCache = null; throw error; }
            }
          })();
          await panel.ready;
        } else if (message.type === 'research-begin') {
          await panel.ready;
          panel.researchDraft = { id: message.id, selection: researchSelection(message.sources), invalidated: false };
        } else if (message.type === 'chat') { await panel.ready; await sendChat(panel, message); }
        else if (message.type === 'visibility') {
          panel.metadataRevision++;
          panel.visible = message.visible === true;
          if (!panel.visible) invalidateResearch(panel, undefined, 'Panel closed. Select sources again.');
          if (!panel.visible && activeRun?.panel === panel) await cancel(activeRun);
        }
        else if (message.type === 'cancel') {
          if (panel.researchDraft) panel.researchDraft.invalidated = true;
          if (activeRun?.panel === panel && (!message.id || activeRun.id === message.id)) await cancel(activeRun);
        } else if (message.type === 'context') {
          await panel.ready;
          await publishMetadata(panel.windowId);
        }
      })().catch(error => post(port, { type: 'error', id: message?.id, error: error.message }));
    });
    port.onDisconnect.addListener(() => {
      panel.closed = true;
      panels.delete(panel);
      if (activeRun?.panel === panel) void cancel(activeRun);
      try { panel.native?.disconnect(); } catch {}
      panel.native = null; panel.releaseCache?.(); panel.releaseCache = null;
    });
  });
  const toggle = tab => {
    if (!tab?.id) return;
    tools.authorize(tab);
    void contextMemory.observeGranted(tab);
    const panel = [...panels].find(item => item.windowId === tab.windowId && !item.closed && item.visible);
    if (panel && api.sidePanel.close) {
      if (activeRun?.panel === panel) void cancel(activeRun);
      void api.sidePanel.close({ windowId: tab.windowId }).catch(error => post(panel.port, { type: 'error', error: error.message }));
    } else {
      // Call open in the user gesture's event stack, before awaiting any work.
      void api.sidePanel.open({ windowId: tab.windowId }).catch(() => {});
    }
  };
  api.commands.onCommand.addListener((command, tab) => {
    if (command === 'toggle-breezer-ai') { toggle(tab); return; }
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
  api.action.onClicked.addListener(toggle);
  api.sidePanel.onClosed?.addListener(info => {
    for (const panel of panels) if (panel.windowId === info.windowId) {
      panel.metadataRevision++;
      panel.visible = false;
      invalidateResearch(panel, undefined, 'Panel closed. Select source tabs again.');
      if (activeRun?.panel === panel) void cancel(activeRun);
    }
  });
  api.sidePanel.onOpened?.addListener(info => {
    for (const panel of panels) if (panel.windowId === info.windowId) panel.visible = true;
  });
  api.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'stop-control' && activeRun?.session?.id === message.sessionId && sender.tab?.id === activeRun.session.tab.id) void cancel(activeRun, 'Browser control stopped.');
  });
  const invalidateResearch = (panel, tabId, reason) => {
    if (tabId !== undefined && !panel.researchDraft?.selection.some(source => source.tabId === tabId)) {
      post(panel.port, { type: 'research-invalidated', tabId, reason }); return;
    }
    if (panel.researchDraft) panel.researchDraft.invalidated = true;
    post(panel.port, { type: 'research-invalidated', tabId, reason });
    if (activeRun?.panel === panel && activeRun.research) void cancel(activeRun, reason);
  };
  api.tabs.onActivated.addListener(info => {
    for (const panel of panels) if (panel.windowId === info.windowId) invalidateResearch(panel, undefined, 'Active tab changed. Select source tabs again.');
    const run = activeRun;
    if (run?.session && info.windowId === run.session.tab.windowId && info.tabId !== run.session.tab.id) void cancel(run, 'Browser control stopped because the active tab changed.');
    void publishMetadata(info.windowId, info.tabId).catch(() => {});
  });
  api.tabs.onRemoved.addListener(tabId => {
    for (const panel of panels) invalidateResearch(panel, tabId, 'Source closed. Select source tabs again.');
    tools.grants.delete(tabId);
    if (activeRun?.session?.tab.id === tabId) void cancel(activeRun, 'Browser control stopped because the tab closed.');
  });
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.url || change.status === 'loading') for (const panel of panels) invalidateResearch(panel, tabId, 'Source navigated or is loading. Select source tabs again.');
    if (tab?.active !== false && (change.url || change.title || change.status === 'complete')) void publishMetadata(tab?.windowId, tabId).catch(() => {});
    if (change.url && tools.grants.has(tabId)) {
      try { if (tools.grants.get(tabId) !== new URL(change.url).origin) tools.grants.delete(tabId); } catch { tools.grants.delete(tabId); }
    }
    const run = activeRun;
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
    if (activeRun?.session && activeRun.session.tab.windowId !== windowId) void cancel(activeRun, 'Browser control stopped because the active window changed.');
  });
  api.debugger.onDetach.addListener(source => {
    if (activeRun?.session?.tab.id === source.tabId) void cancel(activeRun, 'Browser control stopped because the debugger detached.');
  });
  api.debugger.onEvent.addListener((source, method, params) => tools.debuggerEvent(source, method, params));
  return { tools, panels, cancel: () => cancel(activeRun) };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) installBackground(chrome);
