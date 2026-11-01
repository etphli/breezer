import { PROVIDERS, TRANSLATION_KEY, translationPreferences, providerRequest } from './translation-provider.js';

export function installTranslation(api) {
  // The menu/command grants activeTab; opening settings never reads a page.
  const open = tab => {
    if (!Number.isInteger(tab?.id) || tab.incognito) return;
    void api.windows.create({ url: api.runtime.getURL(`translation.html?tab=${tab.id}`), type: 'popup', width: 480, height: 650 }).catch(() => {});
  };
  api.runtime.onInstalled?.addListener(() => {
    api.contextMenus?.remove('breezer-translate', () => {
      void api.runtime.lastError;
      api.contextMenus.create({ id: 'breezer-translate', title: 'Translate page…', contexts: ['page'], documentUrlPatterns: ['http://*/*', 'https://*/*'] });
    });
  });
  api.contextMenus?.onClicked.addListener((info, tab) => { if (info.menuItemId === 'breezer-translate') open(tab); });
  api.commands?.onCommand.addListener(command => {
    if (command === 'translate-page') void api.tabs.query({ active: true, lastFocusedWindow: true }).then(tabs => open(tabs[0]));
  });
  api.runtime.onConnect.addListener(ui => {
    if (ui.name !== 'breezer-translation-ui' || ui.sender?.id !== api.runtime.id || ui.sender?.tab?.incognito) return;
    let pageURL;
    try { pageURL = new URL(ui.sender.url); } catch { return; }
    const senderURL = new URL(pageURL); senderURL.search = ''; senderURL.hash = '';
    if (senderURL.href !== api.runtime.getURL('translation.html')) return;
    const tabId = Number(pageURL.searchParams.get('tab'));
    if (!Number.isInteger(tabId) || tabId < 0) return;
    let content, controller, prefs, languages, tabURL, closed = false, running = false, inFlight = null;
    let generation = 0;
    const post = message => { if (!closed) { try { ui.postMessage(message); } catch {} } };
    const stop = () => { generation++; running = false; controller?.abort(); };
    const error = message => post({ type: 'status', state: 'error', message });
    const init = (async () => {
      const tab = await api.tabs.get(tabId);
      if (tab.incognito || !/^https?:\/\//.test(tab.url)) throw new Error('Only regular HTTP and HTTPS pages can be translated. PDFs and browser pages are unsupported.');
      tabURL = tab.url;
      prefs = translationPreferences((await api.storage.local.get(TRANSLATION_KEY))[TRANSLATION_KEY]);
      post({ type: 'init', title: tab.title, origin: new URL(tabURL).origin, prefs: { ...prefs, apiKey: undefined }, provider: PROVIDERS[prefs.provider].name });
      const injected = await api.scripting.executeScript({ target: { tabId }, world: 'ISOLATED', files: ['translation-content.js'] });
      if (closed) return;
      content = api.tabs.connect(tabId, { name: 'breezer-translation-page', documentId: injected[0].documentId });
      content.onMessage.addListener(message => {
        if (message.type === 'status') {
          if (['navigation', 'error'].includes(message.state)) stop();
          if (message.state === 'done' && !prefs.dynamic) running = false;
          post(message); return;
        }
        if (message.type !== 'batch' || !running || inFlight) return;
        const run = generation;
        const signal = controller.signal;
        inFlight = (async () => {
          const tab = await api.tabs.get(tabId);
          if (tab.url !== tabURL) throw new Error('Page changed. Open Translate page again.');
          if (run !== generation) return;
          const texts = await providerRequest(prefs, 'translate', { texts: message.texts, source: prefs.source, target: prefs.target, signal });
          if (run === generation) content.postMessage({ id: message.id, texts });
        })().catch(failure => {
          try { content.postMessage({ id: message.id, error: failure.message }); } catch {}
          if (run === generation) { stop(); error(failure.message); }
        }).finally(() => { inFlight = null; });
      });
      content.onDisconnect.addListener(() => { void api.runtime.lastError; stop(); error('Page connection closed. Open Translate page again after navigation.'); });
    })().catch(failure => post({ type: 'status', state: 'error', unavailable: true, message: `${failure.message} Use the page context menu or translation shortcut to grant access.` }));
    let commands = Promise.resolve();
    ui.onMessage.addListener(message => {
      if (message.type === 'ping') return;
      // Abort immediately even when language discovery or a storage write is pending.
      if (message.type === 'restore' || message.type === 'cancel') { stop(); content?.postMessage({ type: message.type }); return; }
      const requestedGeneration = generation;
      commands = commands.then(async () => {
        await init;
        if (closed || !prefs || !content || requestedGeneration !== generation) return;
        if (message.type === 'languages') {
          if (!await api.permissions.contains({ origins: [PROVIDERS[prefs.provider].origin] })) throw new Error('Allow the translation provider connection first.');
          languages = await providerRequest(prefs, 'languages');
          post({ type: 'languages', languages }); return;
        }
        if (message.type !== 'start' || running) return;
        if (inFlight) await inFlight;
        if (closed || requestedGeneration !== generation) return;
        if (message.consent !== true) throw new Error('Confirm text sharing before translating.');
        if (!languages) throw new Error('Check provider languages before translating.');
        const source = message.source, target = message.target;
        if (!languages.some(l => l.code === target) || (source !== 'auto' && !languages.some(l => l.code === source && l.targets.includes(target))) || source === target) throw new Error('Choose a supported source and target language.');
        const tab = await api.tabs.get(tabId);
        if (tab.url !== tabURL) throw new Error('Page changed. Open Translate page again.');
        prefs = { ...prefs, source, target, dynamic: message.dynamic === true };
        const run = generation;
        await api.storage.local.set({ [TRANSLATION_KEY]: prefs });
        if (closed || run !== generation) return;
        controller = new AbortController(); generation++; running = true;
        content.postMessage({ type: 'start', dynamic: prefs.dynamic });
        post({ type: 'status', state: 'loading', total: 0, message: 'Translating page…' });
      }).catch(failure => error(failure.message));
    });
    ui.onDisconnect.addListener(() => { closed = true; stop(); content?.disconnect(); });
  });
}
