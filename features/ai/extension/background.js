import { BrowserTools, isWebURL } from './browser-tools.js';

export const NATIVE_HOST = 'io.github.etphli.breezer.ai';

export function installBackground(api) {
  const panels = new Set();
  let activeRun = null;
  const post = (port, message) => { try { port.postMessage(message); } catch { /* The panel may close during a request. */ } };
  const tools = new BrowserTools(api, id => {
    for (const panel of panels) post(panel.port, { type: 'activity', id, active: false, label: '' });
    if (activeRun?.session?.id === id && !activeRun.cancelled) void cancel(activeRun, 'Browser control stopped.');
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
    return tools.current(panel.windowId);
  };
  const publishMetadata = async (windowId, expectedTabId) => {
    for (const panel of panels) {
      if (panel.closed || !panel.visible || panel.windowId === undefined || (windowId !== undefined && panel.windowId !== windowId)) continue;
      const [tab] = await api.tabs.query({ active: true, windowId: panel.windowId });
      if (!tab || panel.closed || !panel.visible || (expectedTabId !== undefined && tab.id !== expectedTabId)) continue;
      post(panel.port, { type: 'context', context: { url: tab.url || '', title: tab.title || '' } });
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
    const panel = { port, native: null, closed: false, visible: true, windowId: undefined, ready: Promise.resolve() };
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
            if (!panel.closed) connectNative(panel).postMessage({ type: 'init' });
          })();
          await panel.ready;
        } else if (message.type === 'chat') { await panel.ready; await sendChat(panel, message); }
        else if (message.type === 'visibility') {
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
    if (change.url || change.title || change.status === 'complete') void publishMetadata(tab?.windowId, tabId).catch(() => {});
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
    if (activeRun?.session && activeRun.session.tab.windowId !== windowId) void cancel(activeRun, 'Browser control stopped because the active window changed.');
  });
  api.debugger.onDetach.addListener(source => {
    if (activeRun?.session?.tab.id === source.tabId) void cancel(activeRun, 'Browser control stopped because the debugger detached.');
  });
  api.debugger.onEvent.addListener((source, method, params) => tools.debuggerEvent(source, method, params));
  return { tools, panels, cancel: () => cancel(activeRun) };
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onConnect) installBackground(chrome);
