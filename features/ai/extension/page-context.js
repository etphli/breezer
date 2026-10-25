// This function runs in Chrome's isolated world, never in the page's JavaScript world.
export function pageContext(operation, args = {}) {
  const key = '__breezerAIContext';
  const token = () => crypto.randomUUID?.() || [...crypto.getRandomValues(new Uint32Array(4))].map(value => value.toString(16)).join('-');
  const state = globalThis[key] ||= { documentId: token(), targets: new Map(), stoppedSessions: new Set() };
  const sensitive = el => el.matches('input[type="password"],input[type="hidden"],[autocomplete*="password"],[autocomplete*="cc-"],[autocomplete="one-time-code"]') || /passw|secret|token|credit.?card|card.?number|cvv|cvc|otp/i.test(`${el.getAttribute('name') || ''} ${el.id || ''}`);
  const visible = el => {
    const rect = el.getBoundingClientRect();
    const style = getComputedStyle(el);
    return el.isConnected && rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none' && Number(style.opacity) !== 0 && (!el.checkVisibility || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
  };
  const removeOverlay = () => {
    state.overlay?.remove();
    state.mask?.remove();
    document.removeEventListener('keydown', state.escape, true);
    state.overlay = state.pointer = state.escape = state.sessionId = undefined;
  };
  if (operation === 'screenshot-mask-stop') {
    state.mask?.remove();
    state.mask = undefined;
    return { ok: true };
  }
  if (operation === 'screenshot-mask') {
    state.mask?.remove();
    const host = document.createElement('div');
    host.dataset.breezerAi = 'redaction';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483646;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    for (const el of document.querySelectorAll('input,textarea,[contenteditable="true"]')) {
      if (!sensitive(el) || !visible(el)) continue;
      const rect = el.getBoundingClientRect();
      const mask = document.createElement('div');
      mask.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;background:#172033;border-radius:3px`;
      shadow.append(mask);
    }
    state.mask = host;
    document.documentElement.append(host);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ ok: true }), 250);
      requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve({ ok: true }); }));
    });
  }
  if (operation === 'overlay-stop') {
    state.stoppedSessions.add(args.sessionId);
    if (state.stoppedSessions.size > 30) state.stoppedSessions.delete(state.stoppedSessions.values().next().value);
    if (globalThis.__breezerAIBoot?.sessionId === args.sessionId) {
      globalThis.__breezerAIBoot.observer?.disconnect();
      globalThis.__breezerAIBoot = undefined;
    }
    if (!args.sessionId || state.sessionId === args.sessionId) removeOverlay();
    return { ok: true };
  }
  if (operation === 'overlay-start') {
    if (state.stoppedSessions.has(args.sessionId)) throw new Error('Browser control stopped.');
    removeOverlay();
    const host = document.createElement('div');
    host.dataset.breezerAi = 'control';
    host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none';
    const shadow = host.attachShadow({ mode: 'closed' });
    shadow.innerHTML = `<style>:host{all:initial} .edge{position:fixed;inset:0;border:3px solid #48a7ff;box-shadow:inset 0 0 24px #268cff9c,0 0 20px #268cff;pointer-events:none}.status{position:fixed;top:14px;left:50%;transform:translateX(-50%);display:flex;gap:16px;align-items:center;padding:10px 14px;border-radius:12px;background:#092549;color:white;font:13px system-ui;box-shadow:0 4px 20px #0005;pointer-events:auto}button{background:#fff;color:#092549;border:0;border-radius:7px;padding:6px 12px;font:600 12px system-ui;cursor:pointer}.pointer{position:fixed;top:64px;left:24px;color:#fff;background:#087dff;padding:6px 9px;border:2px solid white;border-radius:3px 12px 12px 12px;box-shadow:0 2px 8px #0005;font:600 12px system-ui;pointer-events:none;transition:left .12s,top .12s}@media(prefers-reduced-motion:reduce){.pointer{transition:none}}</style><div class="edge"></div><div class="status" role="status"><span>Taking action · Esc to stop</span><button type="button">Stop</button></div><div class="pointer">↖ AI</div>`;
    const stop = () => {
      const sessionId = state.sessionId;
      removeOverlay();
      if (typeof globalThis.__breezerAIStop === 'function') globalThis.__breezerAIStop(JSON.stringify({ sessionId }));
      else chrome.runtime.sendMessage({ type: 'stop-control', sessionId }).catch(() => {});
    };
    shadow.querySelector('button').addEventListener('click', stop);
    state.escape = event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopImmediatePropagation(); stop(); }
    };
    state.overlay = host;
    state.pointer = shadow.querySelector('.pointer');
    state.sessionId = args.sessionId;
    document.addEventListener('keydown', state.escape, true);
    document.documentElement.append(host);
    return { ok: true };
  }
  if (operation === 'pointer') {
    if (state.sessionId !== args.sessionId || !state.pointer || !state.overlay?.isConnected || !visible(state.overlay)) throw new Error('The browser control indicator was removed. Browser control stopped.');
    state.pointer.style.left = `${args.x + 8}px`;
    state.pointer.style.top = `${args.y + 8}px`;
    return { ok: true };
  }
  if (operation === 'control-check') {
    if (state.sessionId !== args.sessionId || !state.overlay?.isConnected || !visible(state.overlay)) throw new Error('The browser control indicator was removed. Browser control stopped.');
    return { ok: true };
  }
  if (operation === 'snapshot') {
    state.targets.clear();
    const snapshotId = token();
    const elements = [];
    const candidates = document.querySelectorAll('a[href],button,input,textarea,select,[role="button"],[role="link"],[contenteditable="true"],[tabindex]');
    for (const el of candidates) {
      if (elements.length >= 180) break;
      if (!visible(el) || sensitive(el) || el.closest('[data-breezer-ai]')) continue;
      const rect = el.getBoundingClientRect();
      if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= innerHeight || rect.left >= innerWidth) continue;
      const id = `${state.documentId}:${snapshotId}:${elements.length + 1}`;
      state.targets.set(id, el);
      const label = el.getAttribute('aria-label') || el.labels?.[0]?.innerText || el.getAttribute('placeholder') || (el.matches('input,textarea,[contenteditable="true"]') ? '' : el.innerText) || el.getAttribute('title') || '';
      elements.push({ id, tag: el.tagName.toLowerCase(), role: el.getAttribute('role') || el.tagName.toLowerCase(), label: label.slice(0, 180), type: el.getAttribute('type') || undefined, x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) });
    }
    const walker = document.createTreeWalker(document.body || document.documentElement, NodeFilter.SHOW_TEXT);
    const text = [];
    let length = 0;
    let nodes = 0;
    while (walker.nextNode() && length < 18000 && nodes++ < 20000) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest('script,style,noscript,input,textarea,select,[contenteditable],[data-breezer-ai],[hidden],[aria-hidden="true"]') || !visible(parent)) continue;
      const value = walker.currentNode.textContent.replace(/\s+/g, ' ').trim();
      if (value) { text.push(value); length += value.length; }
    }
    return { url: location.href, title: document.title, text: text.join(' ').slice(0, 18000), viewport: { width: innerWidth, height: innerHeight }, elements };
  }
  if (operation === 'resolve') {
    const el = state.targets.get(args.elementId);
    if (!el || !visible(el)) throw new Error('This element changed. Take a new snapshot.');
    if (sensitive(el)) throw new Error('Breezer cannot enter passwords or secret fields.');
    if (args.typing && !(el.matches('input:not([readonly]):not([disabled]),textarea:not([readonly]):not([disabled]),[contenteditable="true"]'))) throw new Error('Choose an editable field.');
    const rect = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    const hit = document.elementFromPoint(x, y);
    if (!(hit === el || el.contains(hit))) throw new Error('This element is covered or outside the visible page.');
    return { x, y };
  }
  if (operation === 'check-focus' || operation === 'select-content') {
    if (document.activeElement && sensitive(document.activeElement)) throw new Error('Breezer cannot enter passwords or secret fields.');
    if (args.elementId) {
      const target = state.targets.get(args.elementId);
      if (!target || !visible(target) || !(document.activeElement === target || target.contains(document.activeElement))) throw new Error('The selected field lost focus. Take a new snapshot.');
      if (sensitive(target)) throw new Error('Breezer cannot enter passwords or secret fields.');
      if (operation === 'select-content') {
        if (target.matches('input,textarea')) {
          target.select();
          if (target.value && target.selectionStart === null) throw new Error('This input type does not allow replacing its text.');
        } else if (target.isContentEditable) {
          const range = document.createRange();
          range.selectNodeContents(target);
          const selection = getSelection();
          selection.removeAllRanges();
          selection.addRange(range);
        } else throw new Error('Choose an editable field.');
      }
    }
    return { ok: true };
  }
  throw new Error('Unsupported page operation.');
}
