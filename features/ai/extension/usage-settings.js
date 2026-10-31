import { USAGE_ENABLED } from './usage.js';

export async function mountUsageSettings({ api, container }) {
  const el = (tag, text, attrs = {}) => {
    const node = document.createElement(tag);
    node.textContent = text;
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    return node;
  };
  const section = el('section', '', { class: 'settings-section', 'aria-labelledby': 'usage-heading' });
  const row = el('div', '', { class: 'setting-row' });
  const label = el('label', 'Share basic usage statistics', { class: 'setting-label', for: 'usage-enabled' });
  label.append(el('small', 'Help measure active users and time spent in Breezer. Enabled by default. No browsing history, URLs, page contents, passwords, or AI conversations are sent.'));
  row.append(label, el('input', '', { id: 'usage-enabled', class: 'toggle', type: 'checkbox', disabled: '' }));
  const policy = el('p', 'GitHub separately counts installer downloads. ', { class: 'section-note' });
  policy.append(el('a', 'Read the privacy policy', { href: 'https://breezer-browser.vercel.app/privacy-policy', target: '_blank', rel: 'noreferrer' }));
  section.append(el('h2', 'Privacy and usage', { id: 'usage-heading' }), row,
    el('p', 'A random identifier changes each month. Time counts only while a regular Breezer window is focused and your computer is active. Turning this off stops future reporting and clears the local counter. Reports already received expire within 63 days.', { class: 'section-note' }),
    policy, el('p', '', { class: 'field-note', role: 'status', id: 'usage-status' }));
  container.append(section);
  const control = container.querySelector('#usage-enabled');
  const status = container.querySelector('#usage-status');
  try {
    control.checked = (await api.storage.local.get(USAGE_ENABLED))[USAGE_ENABLED] !== false;
    control.disabled = false;
  } catch { status.textContent = 'Could not read your privacy setting. Reopen Settings to try again.'; return; }
  control.addEventListener('change', async () => {
    const next = control.checked;
    control.disabled = true;
    try {
      await api.storage.local.set({ [USAGE_ENABLED]: next });
      status.textContent = next ? 'Basic usage reporting is on.' : 'Usage reporting is off. No further reports will be sent.';
    } catch { control.checked = !next; status.textContent = 'Could not save your choice. Please try again.'; }
    finally { control.disabled = false; }
  });
}
