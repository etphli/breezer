import { CONTEXT_KEY } from './context-memory.js';

export function createContextClient(api = globalThis.chrome) {
  const pending = new Map(), listeners = new Set();
  let sequence = 0, closed = false, port = null;
  const failPending = () => {
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(new Error('Context settings connection closed. Try again.')); }
    pending.clear();
  };
  const connect = () => {
    if (port) return port;
    const connection = api.runtime.connect({ name: 'breezer-context-settings' });
    port = connection;
    connection.onMessage.addListener(message => {
      if (closed || port !== connection) return;
      if (message?.type === 'context-changed') { for (const listener of listeners) listener(); return; }
      const entry = pending.get(message?.id);
      if (!entry) return;
      clearTimeout(entry.timer); pending.delete(message.id);
      if (message.ok === true) entry.resolve(message.value);
      else entry.reject(new Error(typeof message.error === 'string' ? message.error : 'Could not update context settings.'));
    });
    connection.onDisconnect.addListener(() => {
      void api.runtime.lastError;
      if (port !== connection) return;
      port = null;
      failPending();
    });
    return connection;
  };
  const changed = (changes, area) => {
    if (closed || port || area !== 'local' || !Object.hasOwn(changes, CONTEXT_KEY)) return;
    for (const listener of listeners) listener();
  };
  api.storage.onChanged.addListener(changed);
  return {
    request(type, fields = {}) {
      if (closed) return Promise.reject(new Error('Context settings connection closed.'));
      const id = `context_ui_${++sequence}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('Context settings request timed out. Try again.')); }, 65_000);
        pending.set(id, { resolve, reject, timer });
        try { connect().postMessage({ ...fields, type, id }); }
        catch {
          const connection = port; port = null;
          try { connection?.disconnect(); } catch {}
          failPending();
        }
      });
    },
    onChange(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { closed = true; failPending(); listeners.clear(); api.storage.onChanged.removeListener(changed); port?.disconnect(); port = null; },
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
  section.setAttribute('aria-label', 'Activity memory');
  const note = text => el('p', text, 'section-note');
  section.append(el('h2', 'Activity memory'),
    note('Remember visits to selected sites on this device for seven days.'),
  );
  const localGroup = el('div', '', 'setting-group');
  const localActions = el('div', '', 'context-actions');
  const saveActions = el('div', '', 'setting-actions');
  const maintenanceActions = el('div', '', 'setting-actions');
  localActions.append(saveActions, maintenanceActions);
  const summarySection = el('section', '', 'settings-section context-settings');
  const summaryGroup = el('div', '', 'setting-group context-summary');
  summarySection.append(el('h2', 'Activity summary'),
    note('OpenAI receives these site names and counts through Codex only when you choose Summarize.'), summaryGroup);
  const check = (text, key, parent = localGroup) => {
    const label = el('label', '', 'setting-row');
    const input = el('input', '', 'toggle'); input.type = 'checkbox'; input.checked = false; input.dataset.contextControl = key;
    label.append(el('span', text, 'setting-label'), input); parent.append(label);
    return input;
  };
  const enabled = check('Remember selected sites', 'enabled');
  const sitesLabel = el('label', 'Sites', 'setting-field');
  const sites = el('textarea'); sites.rows = 2; sites.placeholder = 'docs.example.org'; sites.spellcheck = false;
  sitesLabel.append(sites, el('small', 'One site per line, up to 20. Subdomains count separately.', 'field-note'));
  localGroup.append(sitesLabel);
  const details = el('details', '', 'setting-details');
  details.append(el('summary', 'What is remembered'),
    note('Only sites you choose and grant page access to. Site names and daily counts are stored for seven calendar days, sampled at most once per site per half hour. No titles, page text, forms, passwords, URL paths or query strings. Private browsing and known sensitive sites are excluded.'),
    note('Older activity is erased next time Breezer checks context. Suggestions are uncertain inferences, not saved preferences.'),
  );
  section.append(localGroup, localActions, details);
  const button = (text, action, parent = localActions, className = 'button') => {
    const node = el('button', text, className); node.type = 'button';
    node.addEventListener('click', action, { signal: events.signal });
    parent.append(node); return node;
  };
  const error = el('p', '', 'field-error'); error.setAttribute('role', 'alert'); error.hidden = true;
  const status = el('p', '', 'sr-only'); status.setAttribute('role', 'status');
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
    catch (failure) { if (!disposed) { error.textContent = failure instanceof TypeError ? 'Activity settings could not load. Reopen Settings to try again.' : failure.message; error.hidden = false; } }
  };
  button('Save choices', () => run(async () => {
    await client.request('configure', { enabled: enabled.checked, sites: sites.value.split(/[\n,]+/).map(value => value.trim()).filter(Boolean) });
    await refresh();
  }), saveActions, 'button primary');
  const disable = button('Disable and erase', () => run(async () => { output.textContent = ''; await client.request('configure', { enabled: false }); await refresh(); }), maintenanceActions, 'button danger');
  const clear = button('Clear activity', () => run(async () => { output.textContent = ''; await client.request('clear'); await refresh(); }), maintenanceActions, 'button danger');
  const empty = el('p', 'No activity recorded.', 'empty-state');
  summaryGroup.append(table, empty, suggestions);
  const consent = check('Allow OpenAI summaries', 'consent', summaryGroup);
  consent.addEventListener('change', () => run(async () => { output.textContent = ''; await client.request('consent', { consent: consent.checked }); await refresh(); }), { signal: events.signal });
  const summaryActions = el('div', '', 'setting-actions');
  summaryGroup.append(summaryActions);
  const summarize = button('Summarize with GPT-6 Luna', () => run(async () => {
    if (summarizing) return;
    summarizing = true; summarize.disabled = true; stop.hidden = false; output.textContent = '';
    try {
      const result = await client.request('summarize');
      if (!disposed) output.textContent = result.localOnly ? result.notice : result.text;
    } finally { summarizing = false; stop.hidden = true; if (!disposed) await refresh(false); }
  }), summaryActions, 'button primary');
  const stop = button('Stop summary', () => run(async () => { output.textContent = ''; await client.request('cancel'); }), summaryActions); stop.hidden = true;
  const summaryDetails = el('details', '', 'setting-details');
  summaryDetails.append(el('summary', 'Summary limits and privacy'), note('At least three samples are needed. One request per hour when activity changes. GPT-6 Luna uses your Codex plan allowance. Nothing is added to ordinary chats. If Luna is unavailable, local suggestions remain. Clearing local activity cannot recall data already sent to OpenAI.'));
  summaryGroup.append(output);
  summarySection.append(summaryDetails);
  section.append(status, error);
  container.replaceChildren(section, summarySection);
  async function refresh(clearOutput = true) {
    const current = ++revision;
    const state = await client.request('view');
    if (disposed || revision !== current) return;
    summarySection.hidden = !state.enabled && !state.habits.length;
    enabled.checked = state.enabled; consent.checked = state.providerConsent;
    consent.disabled = !state.enabled;
    sites.value = state.sites.join('\n');
    disable.disabled = !state.enabled && !state.habits.length;
    clear.disabled = !state.habits.length;
    summarize.disabled = summarizing || !state.enabled || !state.providerConsent;
    status.textContent = state.enabled ? 'Local context is on. Provider summaries run only when you request one.' : 'Local context is off. No browsing activity is being remembered.';
    if (clearOutput) output.textContent = '';
    body.replaceChildren();
    for (const row of state.habits) {
      const tr = el('tr');
      for (const value of [row.site, row.observations, row.days]) tr.append(el('td', String(value)));
      body.append(tr);
    }
    table.hidden = !state.habits.length;
    empty.hidden = Boolean(state.habits.length);
    suggestions.replaceChildren(...state.suggestions.map(text => el('li', text)));
  }
  const unsubscribe = client.onChange(() => { void run(() => refresh()); });
  const ready = run(() => refresh());
  return { ready, dispose() { disposed = true; events.abort(); unsubscribe(); client.dispose(); section.remove(); summarySection.remove(); } };
}
