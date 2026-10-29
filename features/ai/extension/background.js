import { BrowserTools, isWebURL } from './browser-tools.js';
import { installContextBackground } from './context-background.js';

export const NATIVE_HOST = 'io.github.etphli.breezer.ai';

export function installBackground(api) {
  api.runtime.onConnect.addListener(port => {
    if (port.name !== 'breezer-updates') return;
    if (port.sender?.id !== api.runtime.id || port.sender?.tab?.incognito) return;
    let url;
    try { url = new URL(port.sender.url); } catch { return; }
    url.hash = ''; url.search = '';
    if (url.href !== api.runtime.getURL('workspace.html')) return;
    const native = api.runtime.connectNative(NATIVE_HOST);
    native.onMessage.addListener(message => { if (message?.type === 'update-result') { try { port.postMessage(message); } catch {} } });
    native.onDisconnect.addListener(() => { void api.runtime.lastError; try { port.disconnect(); } catch {} });
    port.onMessage.addListener(message => {
      if (['update-check', 'update-install', 'update-status'].includes(message?.type) && typeof message.id === 'string' && message.id.length < 100) native.postMessage({ type: message.type, id: message.id });
    });
    port.onDisconnect.addListener(() => { try { native.disconnect(); } catch {} });
  });
  api.runtime.onConnect.addListener(port => {
    if (!['breezer-newtab', 'breezer-organato-settings'].includes(port.name)) return;
    if (port.sender?.id !== api.runtime.id || port.sender?.tab?.incognito) return;
    let url; try { url = new URL(port.sender.url); url.hash = ''; url.search = ''; } catch { return; }
    const settings = port.name === 'breezer-organato-settings';
    if (url.href !== api.runtime.getURL(settings ? 'workspace.html' : 'newtab.html')) return;
    const native = api.runtime.connectNative(NATIVE_HOST), pending = new Map();
    let serial = 0, closed = false;
    const ask = (type, values = {}) => new Promise((resolve, reject) => {
      const id = `organato_${++serial}`;
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Organato timed out. Try again.')); }, 65000);
      pending.set(id, { resolve, reject, timer }); native.postMessage({ type, id, ...values });
    });
    native.onMessage.addListener(message => { const request = pending.get(message?.id); if (!request) return; pending.delete(message.id); clearTimeout(request.timer); message.ok ? request.resolve(message.value) : request.reject(new Error(message.error)); });
    native.onDisconnect.addListener(() => { void api.runtime.lastError; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Organato helper disconnected.')); } pending.clear(); });
    port.onMessage.addListener(message => {
      void (async () => {
        if (closed || typeof message?.id !== 'string' || message.id.length > 100) return;
        let value;
        if (settings) {
          if (!['view', 'configure'].includes(message.type)) throw new Error('Unknown settings action.');
          value = await ask(message.type === 'view' ? 'organato-view' : 'organato-configure', { settings: message.settings });
        } else {
          if (!['view', 'refresh'].includes(message.type)) throw new Error('Unknown new-tab action.');
          const config = await ask('organato-view');
          const topSites = (await api.topSites.get()).slice(0, 8).filter(site => /^https?:\/\//.test(site.url));
          const organato = { ...config, exams: [], assignments: [], todos: [] };
          if (config.enabled && config.connected && config.dashboardEnabled) {
            try {
              const result = await ask('organato-list');
              const items = result.items.map(item => ({ ...item, dueAt: item.dueAt || item.dueDateLocal, allDay: !item.dueAt && Boolean(item.dueDateLocal) })).filter(item => !['submitted', 'completed'].includes(item.workingStatus)).sort((a, b) => String(a.dueAt || a.dueDateLocal || '9999').localeCompare(String(b.dueAt || b.dueDateLocal || '9999')));
              organato.exams = items.filter(item => ['checkpoint', 'both'].includes(item.classification)).slice(0, 6);
              organato.assignments = items.filter(item => item.kind === 'work' && ['assignment', 'both'].includes(item.classification)).slice(0, 6);
              organato.todos = items.filter(item => item.kind === 'todo').slice(0, 8);
              organato.truncated = result.truncated;
            } catch (error) { organato.error = error.message; }
          }
          value = { topSites, organato, dashboardEnabled: config.dashboardEnabled };
        }
        if (!closed) port.postMessage(settings ? { id: message.id, ok: true, value } : { type: 'view', id: message.id, ...value });
      })().catch(error => { if (!closed) { try { port.postMessage(settings ? { id: message.id, ok: false, error: error.message } : { type: 'view', id: message.id, topSites: [], organato: { error: error.message } }); } catch {} } });
    });
    port.onDisconnect.addListener(() => { closed = true; for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Closed')); } pending.clear(); native.disconnect(); });
  });
  const panels = new Set();
  let activeRun = null;
  const post = (port, message) => { try { port.postMessage(message); } catch { /* The panel may close during a request. */ } };
  const tools = new BrowserTools(api, id => {
    for (const panel of panels) post(panel.port, { type: 'activity', id, active: false, label: '' });
    if (activeRun?.session?.id === id && !activeRun.cancelled) void cancel(activeRun, 'Browser control stopped.');
  });
  const contextMemory = installContextBackground(api, {
    isPermitted(tab) {
      try { return tab?.incognito === false && tools.grants.get(tab.id) === new URL(tab.url).origin; }
      catch { return false; }
    },
  });
  const cancel = async (run, reason) => {
    if (!run || run.cancelled) return;
    run.cancelled = true;
    if (activeRun === run) activeRun = null;
    try { run.panel.native?.postMessage({ type: 'cancel', id: run.id }); } catch { /* Native host already exited. */ }
    await tools.stop(run.session);
    if (reason) post(run.panel.port, { type: 'error', id: run.id, error: reason });
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
    const native = api.runtime.connectNative(NATIVE_HOST);
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
            if (message.name === 'browser_snapshot' && !run.control && run.includeContext && run.tab) response.result = await tools.snapshot(run.tab, null, true, () => activeRun === run && !run.cancelled);
            else {
              if (!run.session || !run.control) throw new Error('Browser control is off. Enable it before sending a request.');
              response.result = await tools.execute(run.session, message.name, message.args);
            }
            ensureActive(run);
          } catch (error) { response.error = error.message; }
          if (!run.cancelled && activeRun === run) { try { native.postMessage(response); } catch {} }
        })();
      } else if (['delta', 'complete', 'error'].includes(message.type)) {
        post(panel.port, message);
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
      const detail = api.runtime.lastError?.message;
      const error = `Breezer AI could not connect to its local helper. Restart Breezer and reopen the sidebar. If it still cannot connect, reinstall Breezer.${detail ? ` ${detail}` : ''}`;
      post(panel.port, { type: 'error', error });
      if (activeRun?.panel === panel) void cancel(activeRun, error);
    });
    return native;
  };
  const sendChat = async (panel, message) => {
    if (typeof message.id !== 'string' || message.id.length > 200 || !['codex', 'claude'].includes(message.provider) || typeof message.message !== 'string' || !message.message.trim() || message.message.length > 50000 || typeof message.model !== 'string') throw new Error('Choose a provider and model, then enter a message.');
    await cancel(activeRun);
    if (panel.closed) return;
    const run = { id: message.id, panel, control: message.control === true, includeContext: message.includeContext === true || message.control === true, cancelled: false, session: null, tab: null };
    activeRun = run;
    try {
      let context;
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
        message: message.message, history: Array.isArray(message.history) ? message.history.slice(-40) : [],
        profile: { name: String(message.profile?.name || '').slice(0, 100), context: String(message.profile?.context || '').slice(0, 20000) },
        context, includeContext: message.includeContext === true || run.control, control: run.control,
      });
    } catch (error) {
      if (!run.cancelled) { post(panel.port, { type: 'error', id: run.id, error: error.message }); await cancel(run); }
    }
  };
  api.runtime.onConnect.addListener(port => {
    if (port.name !== 'breezer-panel') return;
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
            if (!panel.closed) connectNative(panel).postMessage({ type: 'init' });
          })();
          await panel.ready;
        } else if (message.type === 'chat') { await panel.ready; await sendChat(panel, message); }
        else if (message.type === 'visibility') {
          panel.metadataRevision++;
          panel.visible = message.visible === true;
          if (!panel.visible && activeRun?.panel === panel) await cancel(activeRun);
        }
        else if (message.type === 'cancel') {
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
      if (activeRun?.panel === panel) void cancel(activeRun);
    }
  });
  api.sidePanel.onOpened?.addListener(info => {
    for (const panel of panels) if (panel.windowId === info.windowId) panel.visible = true;
  });
  api.runtime.onMessage.addListener((message, sender) => {
    if (message?.type === 'stop-control' && activeRun?.session?.id === message.sessionId && sender.tab?.id === activeRun.session.tab.id) void cancel(activeRun, 'Browser control stopped.');
  });
  api.tabs.onActivated.addListener(info => {
    const run = activeRun;
    if (run?.session && info.windowId === run.session.tab.windowId && info.tabId !== run.session.tab.id) void cancel(run, 'Browser control stopped because the active tab changed.');
    void publishMetadata(info.windowId, info.tabId).catch(() => {});
  });
  api.tabs.onRemoved.addListener(tabId => {
    tools.grants.delete(tabId);
    if (activeRun?.session?.tab.id === tabId) void cancel(activeRun, 'Browser control stopped because the tab closed.');
  });
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
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
  api.windows?.onFocusChanged?.addListener(windowId => {
    // WINDOW_ID_NONE means another app has focus. Input still goes only to the controlled
    // tab, so watching from another app does not end control; another Breezer window does.
    if (windowId === (api.windows.WINDOW_ID_NONE ?? -1)) return;
    if (activeRun?.session && activeRun.session.tab.windowId !== windowId) void cancel(activeRun, 'Browser control stopped because the active window changed.');
  });
  api.debugger.onDetach.addListener(source => {
    if (activeRun?.session?.tab.id === source.tabId) void cancel(activeRun, 'Browser control stopped because the debugger detached.');
  });
  api.debugger.onEvent.addListener((source, method, params) => tools.debuggerEvent(source, method, params));
  return { tools, panels, cancel: () => cancel(activeRun) };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) installBackground(chrome);
