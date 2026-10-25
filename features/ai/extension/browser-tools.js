import { pageContext } from './page-context.js';

export const isWebURL = value => { try { return ['http:', 'https:'].includes(new URL(value).protocol); } catch { return false; } };
export const CONTROL_WORLD = 'breezer-ai';
export const STOP_BINDING = '__breezerAIStop';
const pageOperations = new Set(['snapshot', 'resolve', 'pointer', 'check-focus', 'select-content', 'control-check', 'overlay-start', 'overlay-stop', 'screenshot-mask', 'screenshot-mask-stop']);
const keyCodes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Home: 36, End: 35, PageUp: 33, PageDown: 34 };
const bounded = async (promise, milliseconds = 750) => {
  let timeout;
  try { await Promise.race([promise.catch(() => {}), new Promise(resolve => { timeout = setTimeout(resolve, milliseconds); })]); }
  finally { clearTimeout(timeout); }
};

// Only this shipped function runs in the named world. Model output supplies data.
const overlayBootstrap = id => `(() => {
  if (self !== top || !['http:', 'https:'].includes(location.protocol) || typeof globalThis.__breezerAIStop !== 'function') return;
  const install = () => {
    if (!document.documentElement) return false;
    globalThis.__breezerAIStop(JSON.stringify({sessionId:${JSON.stringify(id)},kind:'ready'}));
    return true;
  };
  if (!install()) {
    const observer = new MutationObserver(() => { if (install()) observer.disconnect(); });
    globalThis.__breezerAIBoot = { sessionId:${JSON.stringify(id)}, observer };
    observer.observe(document, { childList:true, subtree:true });
  }
})();`;

export class BrowserTools {
  constructor(api, onStop = () => {}) {
    this.api = api;
    this.onStop = onStop;
    this.grants = new Map();
    this.session = null;
  }

  authorize(tab) {
    if (tab?.id !== undefined && isWebURL(tab.url)) this.grants.set(tab.id, new URL(tab.url).origin);
  }

  async verifyGrant(tab) {
    if (!tab || !isWebURL(tab.url)) return false;
    try {
      // Native Cmd+K grants activeTab without dispatching an extension command.
      const result = await this.api.scripting.executeScript({ target: { tabId: tab.id }, world: 'ISOLATED', func: () => location.origin });
      if (result[0]?.result !== new URL(tab.url).origin) { this.grants.delete(tab.id); return false; }
      this.authorize(tab);
      return true;
    } catch { this.grants.delete(tab.id); return false; }
  }

  async current(windowId) {
    const [tab] = await this.api.tabs.query({ active: true, ...(windowId === undefined ? { currentWindow: true } : { windowId }) });
    if (!tab || !isWebURL(tab.url) || this.grants.get(tab.id) !== new URL(tab.url).origin) throw new Error('Open Breezer AI with Cmd+K or its toolbar button on this web page to allow page access.');
    return tab;
  }

  assertSession(session) {
    if (session.stopped || this.session !== session) throw new Error('Browser control stopped.');
  }

  async activeTab(session) {
    this.assertSession(session);
    const [tab] = await this.api.tabs.query({ active: true, windowId: session.tab.windowId });
    this.assertSession(session);
    if (!tab || tab.id !== session.tab.id || !isWebURL(tab.url)) {
      void this.stop(session);
      throw new Error('The active page changed or is not a web page. Browser control stopped.');
    }
    session.tab = { ...tab };
    return tab;
  }

  async check(session) {
    this.assertSession(session);
    if (session.ready) await session.ready;
    return this.activeTab(session);
  }

  async protocol(session, method, params = {}, onResult = () => {}) {
    await this.activeTab(session);
    this.assertSession(session);
    const pending = this.api.debugger.sendCommand({ tabId: session.tab.id }, method, params).then(result => { onResult(result); return result; });
    session.pending.add(pending);
    if (method === 'Page.addScriptToEvaluateOnNewDocument') session.installing = pending;
    try {
      const result = await pending;
      this.assertSession(session);
      return result;
    } finally { session.pending.delete(pending); }
  }

  async world(session) {
    const { frameTree } = await this.protocol(session, 'Page.getFrameTree');
    const frame = frameTree.frame;
    if (!isWebURL(frame.url)) { void this.stop(session); throw new Error('Browser control only works on http or https pages.'); }
    const documentKey = `${frame.id}:${frame.loaderId}`;
    session.mainFrameId = frame.id;
    if (session.world?.documentKey === documentKey) return session.world;
    const { executionContextId } = await this.protocol(session, 'Page.createIsolatedWorld', { frameId: frame.id, worldName: CONTROL_WORLD });
    session.contextIds.add(executionContextId);
    session.world = { executionContextId, documentKey };
    return session.world;
  }

  async injectControl(session, operation, args = {}) {
    if (!pageOperations.has(operation)) throw new Error('Unsupported page operation.');
    const world = await this.world(session);
    const response = await this.protocol(session, 'Runtime.callFunctionOn', {
      executionContextId: world.executionContextId,
      functionDeclaration: pageContext.toString(),
      arguments: [{ value: operation }, { value: args }],
      returnByValue: true,
      awaitPromise: true,
    });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text || 'The page changed. Take a new snapshot.');
    return response.result?.value;
  }

  async inject(tabId, operation, args) {
    const results = await this.api.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', func: pageContext, args: [operation, args || {}] });
    if (!results[0] || results[0].error) throw new Error(results[0]?.error?.message || 'This page does not allow access. Reopen Breezer AI on a web page.');
    return results[0].result;
  }

  async snapshot(tab, session = null, screenshot = true, isActive = () => true) {
    const assertActive = () => { if (!isActive()) throw new Error('Request stopped.'); };
    const active = () => session ? this.check(session) : this.current(tab.windowId);
    const inject = (operation, args) => session ? this.injectControl(session, operation, args) : this.inject(tab.id, operation, args);
    assertActive();
    if ((await active()).id !== tab.id) throw new Error('The active page changed.');
    const context = await inject('snapshot');
    const documentKey = session?.world?.documentKey;
    assertActive();
    if (screenshot) {
      if ((await active()).id !== tab.id) throw new Error('The active page changed.');
      await inject('screenshot-mask');
      try {
        await active();
        if (session) {
          assertActive();
          const capture = await this.protocol(session, 'Page.captureScreenshot', { format: 'jpeg', quality: 65, captureBeyondViewport: false });
          context.screenshot = `data:image/jpeg;base64,${capture.data}`;
        } else {
          const delay = 550 - (Date.now() - (this.lastCapture || 0));
          if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
          if ((await active()).id !== tab.id) throw new Error('The active page changed.');
          assertActive();
          this.lastCapture = Date.now();
          context.screenshot = await this.api.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 65 });
        }
      } finally {
        if (!session?.stopped) await inject('screenshot-mask-stop').catch(() => {});
      }
    }
    const finalTab = await active();
    assertActive();
    if (finalTab.id !== tab.id || finalTab.url !== context.url || (session && (await this.world(session)).documentKey !== documentKey)) throw new Error('The page changed during capture. Take a new snapshot.');
    return context;
  }

  async start(id, tab, isActive = () => true, onCreated = () => {}) {
    await this.stop();
    await this.lastCleanup;
    if (this.pendingAttachment || this.pendingDetachment) throw new Error('The previous browser control connection is still stopping. Try again.');
    const initialTab = await this.current(tab.windowId);
    if (!isActive() || initialTab.id !== tab.id) throw new Error('Browser control stopped.');
    const session = { id, tab: { ...initialTab }, stopped: false, attached: false, queue: Promise.resolve(), pending: new Set(), contextIds: new Set() };
    this.session = session;
    onCreated(session);
    try {
      this.pendingAttachment = session;
      session.attaching = this.api.debugger.attach({ tabId: tab.id }, '1.3').then(async () => {
        session.attached = true;
        if (session.stopped) await this.detach(session);
      }).finally(() => { if (this.pendingAttachment === session) this.pendingAttachment = null; });
      await session.attaching;
      await this.protocol(session, 'Page.enable');
      await this.protocol(session, 'Runtime.enable');
      await this.protocol(session, 'Runtime.addBinding', { name: STOP_BINDING, executionContextName: CONTROL_WORLD });
      await this.protocol(session, 'Page.addScriptToEvaluateOnNewDocument', { worldName: CONTROL_WORLD, source: overlayBootstrap(id) }, result => {
        session.bootScript = result.identifier;
      });
      await this.injectControl(session, 'overlay-start', { sessionId: id });
      await this.check(session);
      return session;
    } catch (error) { await this.stop(session); throw error; }
  }

  async detach(session) {
    this.pendingDetachment = session;
    const pending = this.api.debugger.detach({ tabId: session.tab.id }).catch(() => {}).finally(() => {
      session.attached = false;
      if (this.pendingDetachment === session) this.pendingDetachment = null;
    });
    await bounded(pending);
  }

  async stop(session = this.session) {
    if (!session) return;
    if (session.stopping) return session.stopping;
    session.stopped = true;
    clearTimeout(session.navigationTimeout);
    session.rejectReady?.(new Error('Browser control stopped.'));
    if (this.session === session) this.session = null;
    session.stopping = (async () => {
      if (session.attached) {
        let cleanupActive = true;
        const checkCleanup = () => {
          if (!cleanupActive || (this.session && this.session !== session)) throw new Error('Browser cleanup expired.');
        };
        const send = async (method, args = {}) => {
          checkCleanup();
          const result = await this.api.debugger.sendCommand({ tabId: session.tab.id }, method, args);
          checkCleanup();
          return result;
        };
        await bounded((async () => {
          await send('Runtime.removeBinding', { name: STOP_BINDING }).catch(() => {});
          if (session.installing) await session.installing.catch(() => {});
          checkCleanup();
          if (session.bootScript) await send('Page.removeScriptToEvaluateOnNewDocument', { identifier: session.bootScript }).catch(() => {});
          const { frameTree } = await send('Page.getFrameTree');
          if (isWebURL(frameTree.frame.url)) {
            const { executionContextId } = await send('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: CONTROL_WORLD });
            await send('Runtime.callFunctionOn', { executionContextId, functionDeclaration: pageContext.toString(), arguments: [{ value: 'overlay-stop' }, { value: { sessionId: session.id } }], returnByValue: true, awaitPromise: true });
          }
        })());
        cleanupActive = false;
        await this.detach(session);
      }
      this.onStop(session.id);
    })();
    this.lastCleanup = session.stopping;
    return session.stopping;
  }

  navigationStarted(session) {
    if (session.stopped || session.ready) return;
    session.ready = new Promise((resolve, reject) => { session.resolveReady = resolve; session.rejectReady = reject; });
    session.ready.catch(() => {});
    session.navigationTimeout = setTimeout(() => {
      session.rejectReady?.(new Error('The page took too long to load. Browser control stopped.'));
      void this.stop(session);
    }, 30000);
  }

  async navigationComplete(session) {
    if (session.stopped || !session.ready) return;
    try {
      const tab = await this.activeTab(session);
      if (tab.status === 'loading') return;
      await this.injectControl(session, 'overlay-start', { sessionId: session.id });
      if (session.stopped) return;
      const latest = await this.activeTab(session);
      if (latest.status === 'loading') return;
      clearTimeout(session.navigationTimeout);
      session.resolveReady();
      session.ready = null;
    } catch (error) {
      if (!session.stopped) { session.rejectReady?.(error); await this.stop(session); }
    }
  }

  debuggerEvent(source, method, params) {
    const session = this.session;
    if (!session || session.stopped || source.tabId !== session.tab.id) return;
    if (method === 'Runtime.executionContextCreated' && params.context?.name === CONTROL_WORLD && params.context.auxData?.frameId === session.mainFrameId) session.contextIds.add(params.context.id);
    else if (method === 'Runtime.executionContextDestroyed') session.contextIds.delete(params.executionContextId);
    else if (method === 'Runtime.executionContextsCleared') { session.contextIds.clear(); session.world = null; }
    else if (method === 'Runtime.bindingCalled' && params.name === STOP_BINDING && session.contextIds.has(params.executionContextId)) {
      try {
        const message = JSON.parse(params.payload);
        if (message.sessionId !== session.id) return;
        if (message.kind === 'ready') void this.injectControl(session, 'overlay-start', { sessionId: session.id }).catch(() => {});
        else void this.stop(session);
      } catch {}
    } else if (method === 'Page.frameStartedLoading' && params.frameId === session.mainFrameId) this.navigationStarted(session);
    else if (method === 'Page.loadEventFired') void this.navigationComplete(session);
  }

  async command(session, method, params) {
    await this.check(session);
    try { await this.injectControl(session, 'control-check', { sessionId: session.id }); }
    catch (error) { await this.stop(session); throw error; }
    await this.check(session);
    await this.protocol(session, method, params);
    await this.check(session);
  }

  execute(session, name, args = {}) {
    const work = session.queue.then(() => this.perform(session, name, args));
    session.queue = work.catch(() => {});
    return work;
  }

  async perform(session, name, args) {
    await this.check(session);
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid browser tool arguments.');
    if (name === 'browser_snapshot') return this.snapshot(session.tab, session);
    if (name === 'browser_click' || name === 'browser_type') {
      if (typeof args.elementId !== 'string') throw new Error('Choose an element from the latest snapshot.');
      if (name === 'browser_type' && (typeof args.text !== 'string' || args.text.length > 10000)) throw new Error('Enter text of at most 10,000 characters.');
      const point = await this.injectControl(session, 'resolve', { elementId: args.elementId, typing: name === 'browser_type' });
      await this.check(session);
      await this.injectControl(session, 'pointer', { sessionId: session.id, ...point });
      await this.command(session, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...point });
      const currentPoint = await this.injectControl(session, 'resolve', { elementId: args.elementId, typing: name === 'browser_type' });
      if (currentPoint.x !== point.x || currentPoint.y !== point.y) throw new Error('This element moved. Take a new snapshot.');
      await this.command(session, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
      await this.command(session, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
      if (name === 'browser_type') {
        await this.injectControl(session, 'select-content', { elementId: args.elementId });
        await this.command(session, 'Input.insertText', { text: args.text });
      }
    } else if (name === 'browser_scroll') {
      if (!['up', 'down'].includes(args.direction) || (args.amount !== undefined && (!Number.isFinite(args.amount) || args.amount <= 0))) throw new Error('Choose up or down and a positive scroll amount.');
      await this.injectControl(session, 'pointer', { sessionId: session.id, x: 120, y: 120 });
      await this.command(session, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x: 120, y: 120, deltaX: 0, deltaY: Math.min(args.amount || 600, 2000) * (args.direction === 'up' ? -1 : 1) });
    } else if (name === 'browser_key') {
      if (!Object.hasOwn(keyCodes, args.key)) throw new Error('This keyboard key is not allowed.');
      await this.injectControl(session, 'check-focus');
      const params = { key: args.key, windowsVirtualKeyCode: keyCodes[args.key], nativeVirtualKeyCode: keyCodes[args.key] };
      await this.command(session, 'Input.dispatchKeyEvent', { type: 'keyDown', ...params });
      await this.command(session, 'Input.dispatchKeyEvent', { type: 'keyUp', ...params });
    } else if (name === 'browser_navigate') {
      if (!isWebURL(args.url) || new URL(args.url).username || new URL(args.url).password) throw new Error('Navigation requires a normal http or https URL.');
      await this.check(session);
      await this.injectControl(session, 'control-check', { sessionId: session.id });
      await this.check(session);
      this.assertSession(session);
      this.navigationStarted(session);
      await this.api.tabs.update(session.tab.id, { url: args.url });
      await this.check(session);
    } else throw new Error('This browser action is not allowed.');
    return this.snapshot(session.tab, session);
  }
}
