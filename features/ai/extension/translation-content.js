// Injected on an explicit activeTab grant, in the extension's isolated world.
(() => {
  if (globalThis.__breezerTranslation) return;
  globalThis.__breezerTranslation = true;
  let originals = new WeakMap();
  const translatedNodes = new Set();
  const excluded = 'script,style,noscript,template,pre,code,kbd,samp,input,textarea,select,button,svg,math,canvas,video,audio,[contenteditable]:not([contenteditable="false"]),[translate="no"],.notranslate,[hidden],[aria-hidden="true"]';
  let port, observer, timer, navigationTimer, cancelWait, walker;
  let active = false, busy = false, epoch = 0, url = location.href, total = 0, skipped = 0, characters = 0, outputCharacters = 0;
  let dynamic = false;
  const post = message => { try { port?.postMessage(message); } catch { stop(); } };
  const allowed = node => {
    const parent = node.parentElement;
    return node.isConnected && parent && !parent.closest(excluded) && parent.getClientRects().length > 0 && getComputedStyle(parent).visibility === 'visible' && /\p{L}/u.test(node.data);
  };
  function stop() {
    active = false; busy = false; epoch++;
    cancelWait?.(); cancelWait = null; walker = null;
    observer?.disconnect(); clearTimeout(timer);
  }
  function restore() {
    stop();
    for (const reference of translatedNodes) {
      const node = reference.deref(), record = node && originals.get(node);
      if (node?.isConnected && record && node.data === record.translated) node.data = record.original;
    }
    originals = new WeakMap(); translatedNodes.clear(); total = 0; skipped = 0; characters = 0; outputCharacters = 0;
  }
  function checkNavigation() {
    if (location.href === url) return false;
    restore(); url = location.href;
    post({ type: 'status', state: 'navigation', total: 0, message: 'Page changed. Open Translate page again to translate this page.' });
    return true;
  }
  function schedule() {
    clearTimeout(timer);
    if (active && !busy) timer = setTimeout(scan, 200);
  }
  function scan() {
    if (!active || busy || checkNavigation()) return;
    walker ||= document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const nodes = []; let size = 0, node;
    while ((node = walker.nextNode())) {
      const record = originals.get(node);
      if ((record && node.data === record.translated) || !allowed(node)) continue;
      // Oversized nodes are split by code point into bounded batches below.
      if (total >= 50000 || node.data.length > 100000 || characters + size + node.data.length > 1000000) { skipped++; continue; }
      if (nodes.length === 32 || (nodes.length && size + Math.min(node.data.length, 3500) > 4000)) { walker.currentNode = node.previousSibling || node.parentNode; break; }
      nodes.push(node); size += node.data.length;
    }
    for (const reference of translatedNodes) {
      const node = reference.deref();
      if (!node?.isConnected) { if (node) originals.delete(node); translatedNodes.delete(reference); }
    }
    if (!nodes.length) {
      post({ type: 'status', state: 'done', total, skipped, message: total ? (dynamic ? 'Translated. Watching for new text on this page.' : 'Page translated.') : 'No supported text found. PDFs, frames, editors, hidden text and code are excluded.' });
      if (!dynamic) stop();
      return;
    }
    busy = true;
    // Count attempted input even if a page edits nodes before responses arrive.
    characters += nodes.reduce((count, node) => count + node.data.length, 0);
    const run = epoch;
    const pending = nodes.map(node => ({ node, original: node.data, parts: [] }));
    // One batch is in flight at a time. Long text nodes retain their identity.
    const translate = async () => {
      for (const item of pending) {
        item.chunks = [];
        let remaining = item.original;
        while (remaining.length > 3500) {
          let boundary = Math.max(remaining.lastIndexOf('\n', 3499), remaining.lastIndexOf(' ', 3499));
          boundary = boundary >= 1750 ? boundary + 1 : 3500;
          if (/[\uD800-\uDBFF]/u.test(remaining[boundary - 1])) boundary--;
          item.chunks.push(remaining.slice(0, boundary)); remaining = remaining.slice(boundary);
        }
        if (remaining) item.chunks.push(remaining);
      }
      const queue = pending.flatMap(item => item.chunks.map(chunk => {
        const text = chunk.trim();
        const prefix = chunk.match(/^\s*/u)[0], suffix = text ? chunk.match(/\s*$/u)[0] : '';
        const index = item.parts.length; item.parts.push(text ? null : chunk);
        return { item, index, text, prefix, suffix };
      })).filter(part => part.text);
      while (queue.length && active && run === epoch) {
        const batch = []; let length = 0;
        while (queue.length && batch.length < 32 && length + queue[0].text.length <= 4000) { const part = queue.shift(); batch.push(part); length += part.text.length; }
        const values = await new Promise((resolve, reject) => {
          const id = crypto.randomUUID();
          const listener = message => {
            if (message.id !== id) return;
            port.onMessage.removeListener(listener); cancelWait = null;
            message.error ? reject(new Error(message.error)) : resolve(message.texts);
          };
          port.onMessage.addListener(listener);
          cancelWait = () => { port?.onMessage.removeListener(listener); reject(new Error('Translation cancelled.')); };
          post({ type: 'batch', id, texts: batch.map(part => part.text) });
        });
        if (!active || run !== epoch || checkNavigation()) return;
        if (!Array.isArray(values) || values.length !== batch.length || values.some(t => typeof t !== 'string')) throw new Error('Invalid translation batch.');
        batch.forEach((part, i) => { part.item.parts[part.index] = part.prefix + values[i] + part.suffix; });
      }
      if (!active || run !== epoch) return;
      observer?.disconnect();
      for (const { node, original, parts } of pending) {
        if (!allowed(node) || node.data !== original) continue;
        const translated = parts.join('');
        if (outputCharacters + translated.length > 4000000) throw new Error('Translation text limit reached. Restore the original or translate a shorter page.');
        outputCharacters += translated.length;
        if (!originals.has(node)) translatedNodes.add(new WeakRef(node));
        originals.set(node, { original, translated }); node.data = translated; total++;
      }
      observe(); busy = false;
      post({ type: 'status', state: 'loading', total, message: `Translated ${total} text sections…` });
      schedule();
    };
    void translate().catch(error => {
      if (run !== epoch) return;
      stop(); post({ type: 'status', state: 'error', total, message: error.message });
    });
  }
  function observe() {
    if (!dynamic || !active) return;
    observer ||= new MutationObserver(() => { walker = null; schedule(); });
    observer.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['hidden', 'class', 'style', 'translate', 'contenteditable', 'aria-hidden'] });
  }
  chrome.runtime.onConnect.addListener(connection => {
    if (connection.name !== 'breezer-translation-page') return;
    stop(); port?.disconnect(); port = connection;
    if (location.href !== url) { restore(); url = location.href; }
    clearInterval(navigationTimer); navigationTimer = setInterval(checkNavigation, 250);
    post({ type: 'status', state: translatedNodes.size ? 'paused' : 'ready', total, message: translatedNodes.size ? 'Translated text remains on this page. Restore original or translate again.' : 'Ready to translate.' });
    port.onMessage.addListener(message => {
      if (message.type === 'restore') { restore(); post({ type: 'status', state: 'ready', total, message: 'Original text restored.' }); }
      if (message.type === 'cancel') { stop(); post({ type: 'status', state: 'cancelled', total, message: 'Stopped. Translated text remains until you restore the original.' }); }
      if (message.type === 'start') {
        if (!['text/html', 'application/xhtml+xml'].includes(document.contentType)) { post({ type: 'status', state: 'error', message: 'Only HTML pages are supported. PDFs and other documents cannot be translated.' }); return; }
        restore(); url = location.href; active = true; dynamic = message.dynamic === true;
        observe(); schedule();
      }
    });
    port.onDisconnect.addListener(() => { if (port === connection) { stop(); clearInterval(navigationTimer); port = null; } });
  });
  addEventListener('pagehide', () => { restore(); clearInterval(navigationTimer); });
  addEventListener('popstate', checkNavigation);
  addEventListener('hashchange', checkNavigation);
})();
