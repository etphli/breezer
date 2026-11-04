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
  const clear = el('input', '', { id: 'translation-clear-key', type: 'checkbox' });
  const save = el('button', 'Save translation settings', { type: 'button', class: 'button primary' });
  const status = el('p', '', { class: 'field-note', role: 'status' });
  const group = el('div', '', { class: 'setting-group' });
  const row = (text, id, control, help) => {
    const line = el('div', '', { class: 'setting-row' });
    const label = el('label', text, { class: 'setting-label', for: id });
    if (help) label.append(el('small', help));
    line.append(label, control); group.append(line);
  };
  row('Translation provider', 'translation-provider', provider, 'Local needs localhost:5000. Hosted uses LibreTranslate.com.');
  row('Provider API key', 'translation-key', key, 'Stored on this device. Leave blank to keep it.');
  row('Remove saved API key', 'translation-clear-key', clear);
  const guide = el('p', '', { class: 'section-note' });
  guide.append(el('a', 'Translation setup and supported content', { href: 'https://github.com/etphli/breezer/blob/main/docs/translation.md', target: '_blank', rel: 'noreferrer' }));
  const details = el('details', '', { class: 'setting-details' });
  details.append(el('summary', 'Setup and privacy'),
    el('p', 'Right-click a page and choose Translate page. Choose languages, translate and restore the original in the translation window. A keyboard shortcut can be set in Browser settings.'),
    el('p', 'Local mode needs your LibreTranslate server at http://localhost:5000. Hosted mode requires your own LibreTranslate.com API key and sends page text there. Breezer does not provide a paid account or use your AI account.'),
    el('p', 'Each translation needs your confirmation. Visible page text, including private text you can read, goes to the chosen server. Form fields, editors, code and frames are excluded. No page URL, cookies or browser credentials are included. Your provider can see your IP address. A local server may have its own connections or logging.'), guide);
  const actions = el('div', '', { class: 'setting-actions' }); actions.append(save);
  section.append(el('h2', 'Page translation', { id: 'translation-heading' }),
    el('p', 'Translate from a page’s right-click menu. Nothing is translated automatically.', { class: 'section-note' }),
    group, actions, status, details);
  container.append(section);
  let prefs;
  try {
    prefs = translationPreferences((await api.storage.local.get(TRANSLATION_KEY))[TRANSLATION_KEY]);
    provider.value = prefs.provider; status.textContent = prefs.apiKey ? 'An API key is saved on this device.' : 'No API key saved. Local servers usually do not need one.';
  } catch { save.disabled = true; status.textContent = 'Could not read translation settings. Reopen Settings to retry.'; }
  const events = new AbortController();
  save.addEventListener('click', async () => {
    save.disabled = true;
    try {
      // A provider change never carries a credential to another server.
      const next = { ...prefs, provider: provider.value, apiKey: clear.checked ? '' : (key.value || (prefs.provider === provider.value ? prefs.apiKey : '')) };
      await api.storage.local.set({ [TRANSLATION_KEY]: next }); prefs = next;
      key.value = ''; clear.checked = false;
      status.textContent = 'Saved. Reopen the translation window to use these settings.';
    } catch { status.textContent = 'Could not save translation settings. Try again.'; }
    finally { save.disabled = false; }
  }, { signal: events.signal });
  return { dispose() { events.abort(); key.value = ''; section.remove(); } };
}
