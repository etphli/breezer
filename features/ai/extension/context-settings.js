export function createContextClient(api = globalThis.chrome) {
  const port = api.runtime.connect({ name: 'breezer-context-settings' });
  const pending = new Map(), listeners = new Set();
  let sequence = 0, closed = false;
  const close = () => {
    closed = true;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Context settings connection closed. Reopen Settings.')); }
    pending.clear();
  };
  port.onMessage.addListener(message => {
    if (closed) return;
    if (message?.type === 'context-changed') { for (const listener of listeners) listener(); return; }
    const entry = pending.get(message?.id);
    if (!entry) return;
    clearTimeout(entry.timer); pending.delete(message.id);
    if (message.ok === true) entry.resolve(message.value);
    else entry.reject(new Error(typeof message.error === 'string' ? message.error : 'Could not update context settings.'));
  });
  port.onDisconnect.addListener(() => { void api.runtime.lastError; close(); });
  return {
    request(type, fields = {}) {
      if (closed) return Promise.reject(new Error('Context settings connection closed. Reopen Settings.'));
      const id = `context_ui_${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Context settings request timed out. Reopen Settings.')); }, 65_000);
        pending.set(id, { resolve, reject, timer });
        try { port.postMessage({ ...fields, type, id }); }
        catch { clearTimeout(timer); pending.delete(id); reject(new Error('Context settings connection closed. Reopen Settings.')); }
      });
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { close(); listeners.clear(); port.disconnect(); },
  };
}

// Uses the existing settings typography and controls. No browsing starts on mount.
export function mountContextSettings({ container, api = globalThis.chrome, client = createContextClient(api) }) {
  const doc = container.ownerDocument, events = new AbortController();
  let disposed = false, revision = 0, summarizing = false;
  const el = (tag, text = '', className = '') => {
    const node = doc.createElement(tag); node.textContent = text;
    if (className) node.className = className;
    return node;
  };
  const section = el('section', '', 'settings-section context-settings');
  section.setAttribute('aria-label', 'Context and habits');
  const note = text => el('p', text, 'section-note');
  section.append(el('h2', 'Context and habits'),
    note('Off by default. Remember activity only on the public sites you choose and grant page access to with the AI toolbar button or keyboard shortcut.'),
    note('Stored on this device: site names and daily activity counts for seven calendar days. Older activity is erased next time Breezer checks context. No titles, page text, forms, passwords, URL paths or query strings. Private browsing and known sensitive sites are excluded.'),
    note('Activity is sampled at most once per site per half hour. Suggestions are uncertain inferences, not saved preferences. Nothing is added to ordinary AI chats.'),
  );
  const check = (text, key) => {
    const label = el('label', '', 'setting-row');
    const input = el('input'); input.type = 'checkbox'; input.checked = false; input.dataset.contextControl = key;
    label.append(el('span', text, 'setting-label'), input); section.append(label);
    return input;
  };
  const enabled = check('Remember activity on the sites I choose', 'enabled');
  const sitesLabel = el('label', 'Sites to remember, one exact hostname per line. Up to 20 sites. Subdomains are separate.');
  const sites = el('textarea'); sites.rows = 4; sites.placeholder = 'docs.example.org'; sites.spellcheck = false;
  sitesLabel.append(sites); section.append(sitesLabel);
  const button = (text, action) => {
    const node = el('button', text, 'text-button'); node.type = 'button';
    node.addEventListener('click', action, { signal: events.signal });
    section.append(node); return node;
  };
  const error = el('p', '', 'field-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const status = el('p', '', 'section-note'); status.setAttribute('role', 'status');
  const table = el('table');
  const caption = el('caption', 'Stored activity and provider preview'); table.append(caption);
  const head = el('thead'), headings = el('tr');
  for (const title of ['Site', 'Activity samples', 'Days']) { const cell = el('th', title); cell.setAttribute('scope', 'col'); headings.append(cell); }
  head.append(headings); table.append(head);
  const body = el('tbody'); table.append(body);
  const suggestions = el('ul');
  const output = el('p'); output.setAttribute('aria-live', 'polite'); output.dataset.contextSummary = '';
  const run = async work => {
    if (disposed) return;
    error.hidden = true;
    try { await work(); }
    catch (failure) { if (!disposed) { error.textContent = failure.message; error.hidden = false; } }
  };
  button('Save local context choices', () => run(async () => {
    await client.request('configure', { enabled: enabled.checked, sites: sites.value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean) });
    await refresh();
  }));
  button('Disable and erase', () => run(async () => { output.textContent = ''; await client.request('configure', { enabled: false }); await refresh(); }));
  button('Clear learned activity', () => run(async () => { output.textContent = ''; await client.request('clear'); await refresh(); }));
  section.append(table, suggestions,
    note('Provider summaries are separate. OpenAI receives the site names and counts shown above through your signed-in Codex account. Requests may use your plan allowance. Send only information you are comfortable sharing. Previously sent data cannot be recalled by clearing local activity.'),
  );
  const consent = check('Allow these browsing aggregates to be sent to OpenAI only when I click Summarize with Luna', 'consent');
  consent.addEventListener('change', () => run(async () => { output.textContent = ''; await client.request('consent', { consent: consent.checked }); await refresh(); }), { signal: events.signal });
  const summarize = button('Summarize with Luna', () => run(async () => {
    if (summarizing) return;
    summarizing = true; summarize.disabled = true; output.textContent = '';
    try {
      const result = await client.request('summarize');
      if (!disposed) output.textContent = result.localOnly ? result.notice : result.text;
    } finally { summarizing = false; if (!disposed) await refresh(false); }
  }));
  button('Stop summary', () => run(async () => { output.textContent = ''; await client.request('cancel'); }));
  section.append(note('At least three activity samples are needed. One manual request per hour, when activity has changed. GPT-6 Luna uses Standard speed and light reasoning when supported. If Luna is unavailable, local suggestions remain available.'), output, status, error);
  container.replaceChildren(section);
  async function refresh(clearOutput = true) {
    const current = ++revision;
    const state = await client.request('view');
    if (disposed || revision !== current) return;
    enabled.checked = state.enabled; consent.checked = state.providerConsent;
    consent.disabled = !state.enabled;
    sites.value = state.sites.join('\n');
    summarize.disabled = summarizing || !state.enabled || !state.providerConsent;
    status.textContent = state.enabled ? 'Local context is on. Provider summaries run only when you request one.' : 'Local context is off. No browsing activity is being remembered.';
    if (clearOutput) output.textContent = '';
    body.replaceChildren();
    for (const row of state.habits) {
      const tr = el('tr');
      for (const value of [row.site, row.observations, row.days]) tr.append(el('td', String(value)));
      body.append(tr);
    }
    if (!state.habits.length) { const tr = el('tr'), td = el('td', 'No learned activity. Enable local context, choose a site, then grant page access there.'); td.setAttribute('colspan', '3'); tr.append(td); body.append(tr); }
    suggestions.replaceChildren(...state.suggestions.map(text => el('li', text)));
  }
  const unsubscribe = client.onChange(() => { void run(() => refresh()); });
  const ready = run(() => refresh());
  return { ready, dispose() { disposed = true; events.abort(); unsubscribe(); client.dispose(); section.remove(); } };
}
