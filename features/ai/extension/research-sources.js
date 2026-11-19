export const MAX_RESEARCH_SOURCES = 6;
export const maskSecrets = text => String(text || '')
  .replace(/-----BEGIN[^\n]*PRIVATE KEY-----[\s\S]*/g, '[redacted key]')
  .replace(/\b(?:sk-[\w-]{12,}|gh[pousr]_[\w]{12,}|github_pat_[\w]{12,}|AKIA[A-Z0-9]{16}|eyJ[\w-]+\.[\w-]+\.[\w-]+)\b/g, '[redacted]')
  .replace(/\b(password|secret|token|api[_ -]?key|authorization)\s*[:=]\s*\S+/gi, '$1: [redacted]');
export function sourceURL(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('Only ordinary HTTP(S) pages can be sources.');
  url.search = ''; url.hash = '';
  return maskSecrets(url.href).slice(0, 4096);
}

// A selection stores document identities, never page text or persistent grants.
export class ResearchSources {
  constructor({ api, root, onChange, onRevoke }) {
    this.api = api; this.root = root; this.onChange = onChange; this.onRevoke = onRevoke;
    this.selected = new Map(); this.revision = 0; this.busy = false;
    this.dialog = root.querySelector('#research-dialog');
    this.list = root.querySelector('#research-options');
    this.scrollHint = root.querySelector('#research-scroll');
    this.list.addEventListener('scroll', () => this.updateScrollHint(), { passive: true });
    new ResizeObserver(() => this.updateScrollHint()).observe(this.list);
    root.querySelector('#research-open').addEventListener('click', () => this.open());
    root.querySelector('#research-close').addEventListener('click', () => this.dialog.close());
    root.querySelector('#research-clear').addEventListener('click', () => this.clear());
    this.render();
  }
  get size() { return this.selected.size; }
  updateScrollHint() {
    const { scrollTop, clientHeight, scrollHeight } = this.list;
    this.scrollHint.hidden = !this.dialog.open || scrollHeight - clientHeight - scrollTop <= 2;
  }
  setBusy(value) { this.busy = value; this.render(); if (value) this.dialog.close(); }
  clear(reason, reportRevocation = true) {
    const revoke = this.busy && this.size > 0;
    this.revision++; this.selected.clear(); this.render(); this.onChange();
    if (reportRevocation && (reason || revoke)) this.onRevoke(reason || 'Sources cleared. Response stopped.');
  }
  invalidate(tabId, reason, reportRevocation) {
    if (!this.size) return;
    if (tabId === undefined || this.selected.has(tabId)) {
      const source = this.selected.get(tabId);
      this.clear(source ? `${maskSecrets(source.title)}: ${reason}` : reason, reportRevocation);
    }
  }
  markUnavailable(sources) {
    for (const source of sources) {
      const tab = this.selected.get(source.tabId);
      if (tab && tab.documentId === source.documentId) tab.unavailable = source.status !== 'available';
    }
    this.render();
  }
  render() {
    this.root.querySelector('#research-limit').textContent = `${this.size} selected · Limit ${MAX_RESEARCH_SOURCES}`;
    this.root.querySelector('#research-open').disabled = this.busy;
    this.root.querySelector('#research-clear').hidden = !this.size;
    for (const input of this.root.querySelectorAll('#research-options input[data-tab-id]')) {
      input.checked = this.selected.has(Number(input.dataset.tabId));
      input.disabled = input.dataset.loading === 'true' || (!input.checked && this.size >= MAX_RESEARCH_SOURCES);
    }
    const chips = this.root.querySelector('#research-chips'); chips.replaceChildren();
    [...this.selected.values()].forEach((tab, index) => {
      const chip = document.createElement('button'); chip.type = 'button'; chip.className = 'research-chip';
      const title = maskSecrets(tab.title || new URL(tab.url).hostname);
      chip.toggleAttribute('data-unavailable', Boolean(tab.unavailable));
      chip.textContent = `${index + 1} · ${title}${tab.unavailable ? ' · Unavailable' : ''}`;
      chip.title = `Remove source: ${sourceURL(tab.url)}`;
      chip.setAttribute('aria-label', `Remove source ${index + 1}: ${title}${tab.unavailable ? ', unavailable' : ''}`);
      chip.addEventListener('click', () => { this.selected.delete(tab.tabId); this.revision++; this.render(); this.onChange(); if (this.busy) this.onRevoke('Source removed. Response stopped.'); this.root.querySelector('#research-open').focus(); });
      chips.append(chip);
    });
  }
  async open() {
    if (this.busy || this.dialog.open) return;
    this.dialog.showModal();
    const list = this.list;
    list.textContent = 'Loading tabs…';
    try {
      if (!this.api.breezerPrivate?.getResearchTabs) throw new Error('Selected-tab research needs a Breezer build with the native text reader.');
      const tabs = await this.api.breezerPrivate.getResearchTabs();
      if (!this.dialog.open) return;
      list.replaceChildren();
      const availableIds = new Set(tabs.map(tab => tab.tabId));
      const unavailable = [...this.selected.values()].filter(tab => !availableIds.has(tab.tabId));
      if (!tabs.length && !unavailable.length) list.textContent = 'Open an ordinary web page in this window to use it as a source.';
      for (const tab of [...tabs, ...unavailable]) {
        const unavailable = !availableIds.has(tab.tabId) || this.selected.get(tab.tabId)?.unavailable;
        const label = document.createElement('label'); label.className = 'research-option';
        const input = document.createElement('input'); input.type = 'checkbox'; input.dataset.tabId = String(tab.tabId); input.checked = this.selected.has(tab.tabId); input.disabled = tab.loading;
        input.dataset.loading = String(Boolean(tab.loading));
        const text = document.createElement('span');
        const title = document.createElement('strong'); title.textContent = maskSecrets(tab.title || new URL(tab.url).hostname);
        const url = document.createElement('small'); url.textContent = unavailable
          ? 'Unavailable. Uncheck to remove.'
          : `${sourceURL(tab.url)}${tab.loading ? ' · Loading, try again when ready' : ''}`;
        text.append(title, url); label.append(input, text); list.append(label);
        input.addEventListener('change', () => {
          if (input.checked && this.size >= MAX_RESEARCH_SOURCES) { input.checked = false; this.root.querySelector('#research-limit').textContent = `Choose up to six tabs. ${this.size} selected.`; return; }
          if (input.checked) this.selected.set(tab.tabId, { ...tab }); else this.selected.delete(tab.tabId);
          this.revision++; this.render(); this.onChange();
        });
      }
      this.render();
    } catch (error) { list.textContent = error.message; }
    this.updateScrollHint();
  }
  // Invoke all native reads in the send gesture's stack. No await before these
  // calls: native rejects reads from passive tab events or provider tools.
  capture() {
    const revision = this.revision;
    const selected = [...this.selected.values()];
    return Promise.all(selected.map((tab, index) => {
      const metadata = { sourceId: `S${index + 1}`, title: maskSecrets(tab.title).slice(0, 500), url: sourceURL(tab.url), tabId: tab.tabId, documentId: tab.documentId, expectedUrl: tab.url };
      let read;
      try { read = this.api.breezerPrivate.readResearchTab(tab.tabId, tab.documentId, tab.url); }
      catch (error) { read = Promise.reject(error); }
      return Promise.resolve(read).then(page => {
        const text = maskSecrets(page.text).slice(0, 24000);
        return { ...metadata, status: 'available', text, truncated: page.truncated === true, capturedCharacters: text.length };
      },
        error => ({ ...metadata, status: 'unavailable', error: String(error.message || error).slice(0, 500) }));
    })).then(sources => {
      if (revision !== this.revision) throw new Error('Source selection changed. Select sources and send again.');
      return sources;
    });
  }
}
