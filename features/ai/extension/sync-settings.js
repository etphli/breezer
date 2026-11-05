import { SYNC_STATE_KEY, SYNC_LOCAL_KEY, workspaceSyncForApi } from './workspace-sync.js';
import { syncModelValues } from './workspace-sync-model.js';

// Settings displays workspace queue state only. Provider connection health,
// native password selection, vault keys and recovery stay in browser-owned UI.
export function mountSyncSettings({ container, api }) {
  let disposed = false, opening = false, repairing = false, recoveryRevision = 0, lastState;
  const section = document.createElement('section'); section.className = 'settings-section';
  const title = document.createElement('h2'); title.textContent = 'Devices and data';
  const group = document.createElement('div'); group.className = 'setting-group';
  const row = document.createElement('div'); row.className = 'setting-row';
  row.dataset.searchTerms = 'encrypted spaces folders pins favorites passwords credentials provider recovery key disconnect';
  const label = document.createElement('div'); label.className = 'setting-label';
  const heading = document.createElement('span'); heading.textContent = 'Encrypted sync';
  const description = document.createElement('small'); description.textContent = 'Sync saved spaces, favorites and passwords across your devices.';
  label.append(heading, description);
  const button = document.createElement('button'); button.type = 'button'; button.className = 'button'; button.textContent = 'Set up or manage sync';
  const available = typeof api.breezerPrivate?.readWorkspaceSync === 'function';
  button.disabled = !available;
  if (!available) { heading.textContent = 'Sync unavailable'; description.textContent = 'Sync is not available in this version. Saved data stays on this device. Check General for updates.'; }
  row.append(label, button); group.append(row);
  const state = document.createElement('p'); state.setAttribute('role', 'status'); state.className = 'field-note';
  const note = document.createElement('details'); note.className = 'setting-details';
  const scopeTitle = document.createElement('summary'); scopeTitle.textContent = 'What syncs';
  const scope = document.createElement('p'); scope.textContent = 'Live tabs, windows, AI conversations and AI memory stay local. Platform passkeys are managed by Touch ID or Apple Passwords. Provider, vault, password selection and recovery are managed in browser settings.';
  note.append(scopeTitle, scope);
  const review = document.createElement('details'); review.hidden = true;
  const summary = document.createElement('summary'); summary.textContent = 'Resolve workspace limits';
  const explanation = document.createElement('p'); explanation.textContent = 'Concurrent edits can exceed this profile\'s space or favorite limit. Removing a synced space keeps its saved pins in the first remaining space. Moving a favorite keeps it as a saved pin. These choices sync to your other profiles.';
  const recoveryRows = document.createElement('div'); recoveryRows.className = 'setting-group';
  review.append(summary, explanation, recoveryRows);
  async function renderRecovery(value) {
    const revision = ++recoveryRevision;
    review.hidden = value?.phase !== 'error' || !/exceed (9 spaces|12 favorites)/.test(value.message || '');
    if (review.hidden) return;
    try {
      const saved = await api.storage.local.get(SYNC_LOCAL_KEY);
      if (disposed || revision !== recoveryRevision) return;
      const values = syncModelValues(saved[SYNC_LOCAL_KEY].model);
      recoveryRows.replaceChildren();
      const spaces = Object.entries(values).filter(([key, record]) => key.startsWith('space/') && record.alive === true);
      const favorites = Object.entries(values).filter(([key, record]) => key.startsWith('entry/') && record.alive === true && record.parent === 'favorites');
      const addChoice = (name, action, patch) => {
        const row = document.createElement('div'); row.className = 'setting-row';
        const label = document.createElement('div'); label.className = 'setting-label';
        const span = document.createElement('span'); span.textContent = name; label.append(span);
        const choice = document.createElement('button'); choice.type = 'button'; choice.className = 'button'; choice.textContent = action; choice.disabled = repairing || !available;
        choice.onclick = async () => {
          if (repairing || disposed || !confirm(`${action}: ${name}? Saved pages are kept. This change syncs to your other profiles.`)) return;
          const sync = workspaceSyncForApi(api); if (!sync) return;
          repairing = true;
          for (const button of recoveryRows.querySelectorAll('button')) button.disabled = true;
          try { render(await sync.repair(patch)); }
          catch (error) { if (!disposed) state.textContent = error.message || 'Could not save this recovery choice.'; }
          finally { repairing = false; if (!disposed) void renderRecovery(lastState); }
        };
        row.append(label, choice); recoveryRows.append(row);
      };
      if (spaces.length > 9) for (const [key, space] of spaces.slice(0, 50)) addChoice(space.name, 'Remove space, keep pins', { removeSpace: key.slice(6) });
      if (favorites.length > 12) for (const [key, entry] of favorites.slice(0, 50)) addChoice(entry.title || 'Saved favorite', 'Move favorite to a space', { moveFavorite: key.slice(6) });
    } catch { if (!disposed) recoveryRows.textContent = 'Recovery data could not be read. Your local saved workspace is preserved.'; }
  }
  section.append(title, group, state, note, review); container.replaceChildren(section);
  const render = value => {
    if (disposed) return;
    lastState = value;
    state.textContent = !available ? ''
      : ['error', 'appearanceBlocked'].includes(value?.phase) ? value.message
        : value?.nativeError ? value.nativeMessage
        : ['disabled', 'workspaceOff'].includes(value?.phase) ? 'Saved workspace sync is off. Open Sync settings to review password sync and your connection.'
          : value?.phase === 'reconciled' ? 'Saved workspace changes are queued. Open Sync settings to check the connection and download status.'
            : 'Sync is optional. Open Sync settings to review this profile\'s connection.';
    void renderRecovery(value);
  };
  render();
  void api.storage.local.get(SYNC_STATE_KEY).then(values => render(values[SYNC_STATE_KEY]), () => render());
  const changed = (changes, area) => { if (area === 'local' && changes[SYNC_STATE_KEY]) render(changes[SYNC_STATE_KEY].newValue); };
  api.storage.onChanged?.addListener(changed);
  button.addEventListener('click', async () => {
    if (!available || disposed || opening) return;
    opening = true; button.disabled = true;
    try { await api.tabs.create({ url: 'chrome://breezer-sync/' }); }
    catch { if (!disposed) state.textContent = 'Could not open Sync settings. Try again.'; }
    finally { opening = false; if (!disposed) button.disabled = false; }
  });
  return { dispose() { disposed = true; api.storage.onChanged?.removeListener?.(changed); } };
}
