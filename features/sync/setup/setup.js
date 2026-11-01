// Runs only in browser-owned chrome://breezer-sync. Recovery keys never enter
// the component extension, provider requests, its storage or AI messages.
const $ = id => document.getElementById(id);
let serial = 0, busy = false;
const pending = new Map();
const sections = ['choose', 'vaults', 'recovery', 'connected', 'invalid'];
function show(section) { for (const id of sections) $(id).hidden = id !== section; $('cancel').hidden = !['vaults', 'recovery'].includes(section); }
function controls() {
  for (const node of document.querySelectorAll('button,select,input,textarea')) node.disabled = busy;
  $('confirm-key').disabled = busy || !$('saved-key').checked;
  $('cancel').disabled = false;
}
function clearKeys() { $('join-key').value = ''; $('recovery-key').value = ''; $('saved-key').checked = false; }
globalThis.breezerSyncReply = (id, result) => {
  const request = pending.get(id); if (!request) return;
  if (result.progress) { $('status').textContent = result.progress; return; }
  pending.delete(id);
  result.error ? request.reject(new Error(result.error)) : request.resolve(result);
};
const send = (action, values = {}) => new Promise((resolve, reject) => {
  const id = String(++serial); pending.set(id, { resolve, reject });
  if (typeof globalThis.chrome?.send !== 'function') { pending.delete(id); reject(new Error('Native Breezer sync is unavailable in this page.')); return; }
  chrome.send('breezerSync', [id, action, values]);
});
async function run(action, values = {}) {
  if (busy && action !== 'cancel') return;
  busy = true;
  if (action === 'provider') $('cancel').hidden = false;
  controls(); if (action !== 'status') $('error').hidden = true;
  let focusTarget;
  try {
    const response = await send(action, values);
    if (response.status) renderStatus(response.status);
    if (response.vaults) {
      $('vault').replaceChildren(...response.vaults.map(vault => new Option(vault.displayName, vault.vaultUuid)));
      $('join').hidden = !response.vaults.length;
      $('status').textContent = 'Provider ready. Choose or create a vault.';
      show('vaults'); focusTarget = response.vaults.length ? $('vault') : $('vault-name');
    }
    if (response.recoveryKey) { clearKeys(); $('recovery-key').value = response.recoveryKey; $('status').textContent = 'Vault prepared. Save the recovery key to connect.'; show('recovery'); focusTarget = $('recovery-key'); }
    if (action === 'cancel' || response.status?.configured) clearKeys();
  } catch (error) { $('error').textContent = error.message; $('error').hidden = false; }
  finally { busy = false; controls(); focusTarget?.focus(); }
}
function renderStatus(status) {
  const message = !status.configured ? 'Sync is off for this profile.'
    : status.hasError ? 'Sync needs attention. Your local data is preserved.'
      : !status.active ? 'Connected. Sync is currently inactive. Check the provider and browser policy.'
        : status.initialSyncComplete ? 'Connected. Initial download has completed.' : 'Connected. Waiting for initial sync.';
  if ($('status').textContent !== message) $('status').textContent = message;
  if (!status.errorMessage) $('error').hidden = true;
  if (status.invalidConfiguration) { $('error').textContent = status.errorMessage; $('error').hidden = false; show('invalid'); return; }
  if (status.configured) {
    $('connected-provider').textContent = status.providerName || status.providerId;
    $('spaces-status').textContent = status.spacesEnabled ? status.spacesActive ? 'Active' : 'Selected, waiting or restricted' : 'Off';
    $('passwords-status').textContent = status.passwordsEnabled ? status.passwordsActive ? 'Active' : 'Selected, waiting or restricted' : 'Off';
    if (status.errorMessage) { $('error').textContent = status.errorMessage; $('error').hidden = false; }
    $('last-success').textContent = status.lastSuccess > 0 ? new Date(status.lastSuccess).toLocaleString() : 'Not yet confirmed';
    show('connected');
  } else {
    $('provider').replaceChildren(...status.providers.map(provider => new Option(provider.name, provider.id)));
    $('no-providers').hidden = Boolean(status.providers.length);
    $('select-provider').hidden = !status.providers.length;
    show('choose');
  }
}
const choices = () => ({ spaces: $('spaces').checked, passwords: $('passwords').checked });
$('select-provider').onclick = () => run('provider', { providerId: $('provider').value });
$('create').onclick = () => run('create', { displayName: $('vault-name').value.trim(), ...choices() });
$('join').onclick = () => { const recoveryKey = $('join-key').value.trim(); $('join-key').value = ''; void run('join', { vaultId: $('vault').value, recoveryKey, ...choices() }); };
$('saved-key').onchange = controls;
$('confirm-key').onclick = () => run('confirm', { saved: $('saved-key').checked });
$('retry').onclick = () => run('retry');
$('disconnect').onclick = () => { if (confirm('Disconnect this profile? Saved spaces and local passwords stay on this device. The remote vault is kept.')) void run('disconnect'); };
$('reset-configuration').onclick = () => { if (confirm('Disconnect the saved sync configuration? Local saved data and the remote vault are kept.')) void run('disconnect'); };
$('cancel').onclick = () => { clearKeys(); void run('cancel'); };
const refresh = setInterval(() => { if (!busy && !$('connected').hidden) void run('status'); }, 5000);
addEventListener('pagehide', () => { clearKeys(); clearInterval(refresh); });
void run('status');
