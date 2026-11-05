import { PROVIDERS, TRANSLATION_KEY, translationPreferences } from './translation-provider.js';

export async function mountTranslationSettings({ container, api }) {
  if (!container) return { dispose() {} };
  const doc = container.ownerDocument;
  const el = (tag, text, attrs = {}) => {
    const node = doc.createElement(tag); node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const section = el('section', '', { class: 'settings-section', 'aria-labelledby': 'translation-heading' });
  const provider = el('select', '', { id: 'translation-provider' });
  for (const [id, value] of Object.entries(PROVIDERS)) provider.append(el('option', value.name, { value: id }));
  const key = el('input', '', { id: 'translation-key', type: 'password', autocomplete: 'off', placeholder: 'Leave blank to keep saved key' });
  const clear = el('button', 'Remove saved key', { id: 'translation-clear-key', type: 'button', class: 'button danger' });
  const save = el('button', 'Save translation settings', { type: 'button', class: 'button primary' });
  const status = el('p', '', { class: 'field-note', role: 'status' });
  const group = el('div', '', { class: 'setting-group' });
  const row = (text, id, control, help) => {
    const line = el('div', '', { class: 'setting-row' });
    const isAction = control.tagName === 'BUTTON';
    const label = el(isAction ? 'div' : 'label', text, { class: 'setting-label', ...(isAction ? {} : { for: id }) });
    const hint = help ? el('small', help) : null;
    if (hint) label.append(hint);
    line.append(label, control); group.append(line);
    return hint;
  };
  const providerHint = row('Translation provider', 'translation-provider', provider, 'Choose a translation provider.');
  providerHint.id = 'translation-provider-help';
  provider.setAttribute('aria-describedby', providerHint.id);
  row('Provider API key', 'translation-key', key, 'Stored on this device. Switching providers clears the key field.');
  row('Saved API key', 'translation-clear-key', clear, 'Remove the key from this device.');
  const guide = el('p', '', { class: 'section-note' });
  guide.append(el('a', 'LibreTranslate setup guide', { href: 'https://github.com/etphli/breezer/blob/main/docs/translation.md', target: '_blank', rel: 'noreferrer' }));
  const details = el('details', '', { class: 'setting-details' });
  details.append(el('summary', 'Sharing and privacy'),
    el('p', 'Right-click a page and choose Translate page. Choose languages, translate and restore the original in the translation window. A keyboard shortcut can be set in Browser settings.'),
    el('p', 'Local mode needs your LibreTranslate server at http://localhost:5000. Hosted mode requires your own LibreTranslate.com API key and sends page text there. Breezer does not provide a paid account or use your AI account.'),
    el('p', 'Each translation needs your confirmation. Visible page text, including private text you can read, goes to the chosen server. Form fields, editors, code and frames are excluded. No page URL, cookies or browser credentials are included. Your provider can see your IP address. A local server may have its own connections or logging.'));
  const actions = el('div', '', { class: 'setting-actions context-save' }); actions.append(save, status);
  group.append(actions);
  section.append(el('h2', 'Page translation', { id: 'translation-heading' }),
    el('p', 'Translate from a page’s right-click menu. Nothing is translated automatically.', { class: 'section-note' }),
    group, guide, details);
  container.append(section);
  let prefs;
  try {
    prefs = translationPreferences((await api.storage.local.get(TRANSLATION_KEY))[TRANSLATION_KEY]);
    provider.value = prefs.provider; status.textContent = prefs.apiKey ? 'An API key is saved on this device.' : 'No API key saved.';
  } catch { save.disabled = true; status.textContent = 'Could not read translation settings. Reopen Settings to retry.'; }
  const updateProviderHelp = () => {
    providerHint.textContent = provider.value === 'hosted'
      ? 'Use your own LibreTranslate.com API key. Page text will be shared with that service.'
      : 'Start LibreTranslate at http://localhost:5000. Add a key if needed.';
    key.placeholder = provider.value === prefs?.provider && prefs.apiKey ? 'Leave blank to keep saved key' : 'API key, if required';
    clear.closest('.setting-row').hidden = !prefs?.apiKey || provider.value !== prefs.provider;
  };
  updateProviderHelp();
  const events = new AbortController();
  provider.addEventListener('change', () => {
    key.value = '';
    updateProviderHelp();
    if (prefs) status.textContent = provider.value !== prefs.provider ? 'Save to use this provider.'
      : prefs.apiKey ? 'An API key is saved on this device.' : 'No API key saved.';
  }, { signal: events.signal });
  clear.addEventListener('click', async () => {
    clear.disabled = save.disabled = true;
    try {
      const next = { ...prefs, apiKey: '' };
      await api.storage.local.set({ [TRANSLATION_KEY]: next }); prefs = next;
      updateProviderHelp();
      status.textContent = 'Saved API key removed.';
    } catch { status.textContent = 'Could not remove the saved key. Try again.'; }
    finally { clear.disabled = save.disabled = false; }
  }, { signal: events.signal });
  save.addEventListener('click', async () => {
    clear.disabled = save.disabled = true;
    try {
      // A provider change never carries a credential to another server.
      const next = { ...prefs, provider: provider.value, apiKey: key.value || (prefs.provider === provider.value ? prefs.apiKey : '') };
      await api.storage.local.set({ [TRANSLATION_KEY]: next }); prefs = next;
      key.value = '';
      updateProviderHelp();
      status.textContent = 'Saved. Reopen the translation window to use these settings.';
    } catch { status.textContent = 'Could not save translation settings. Try again.'; }
    finally { clear.disabled = save.disabled = false; }
  }, { signal: events.signal });
  return { dispose() { events.abort(); key.value = ''; section.remove(); } };
}
