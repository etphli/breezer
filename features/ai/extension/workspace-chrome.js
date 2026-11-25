import { HAS_APP_UPDATER, PLATFORM } from './platform.js';
import { RELEASE_VERSION } from './release-info.js';
import { localStorageChanges } from './storage-events.js';
import { parseRoute } from './workspace-store.js';

const GITHUB_RELEASES = 'https://github.com/etphli/breezer/releases';
const INSTALLER = 'Breezer-Windows-x64-Setup.exe';
const EXPERIMENTS = 'breezerExperiments';

function parts(version) {
  return typeof version === 'string' && /^(0|[1-9]\d{0,5})(\.(0|[1-9]\d{0,5})){2}$/.test(version)
    ? version.split('.').map(Number)
    : null;
}

export function windowsUpdate(release, installedVersion = RELEASE_VERSION) {
  if (release?.draft !== false || release?.prerelease !== false) return null;
  const version = typeof release.tag_name === 'string' && release.tag_name.startsWith('v') ? release.tag_name.slice(1) : '';
  const next = parts(version), current = parts(installedVersion);
  if (!next || !current) return null;
  const difference = next.map((value, index) => value - current[index]).find(value => value !== 0);
  if (!difference || difference < 0 || !Array.isArray(release.assets)) return null;
  const download = `${GITHUB_RELEASES}/download/v${version}/${INSTALLER}`;
  const asset = (name, url) => release.assets.find(item => item?.name === name
    && item.state === 'uploaded' && Number.isSafeInteger(item.size) && item.size > 0
    && item.browser_download_url === url);
  const installer = asset(INSTALLER, download);
  const checksum = asset(`${INSTALLER}.sha256`, `${download}.sha256`);
  return installer && typeof installer.digest === 'string' && /^sha256:[a-f0-9]{64}$/i.test(installer.digest) && checksum
    ? { version, download }
    : null;
}

function mountExperiments(api, sidebar) {
  if (!api.storage?.local) return;
  const button = sidebar.querySelector('#sidebar-address');
  const canFocus = typeof api.breezerPrivate?.focusLocationBar === 'function';
  const render = value => {
    button.hidden = !canFocus || value?.sidebarSearch !== true;
    sidebar.toggleAttribute('data-glass', value?.glass === true);
  };
  const events = localStorageChanges(api);
  let changed = false;
  const refresh = changes => {
    if (!Object.hasOwn(changes, EXPERIMENTS)) return;
    changed = true;
    render(changes[EXPERIMENTS].newValue);
  };
  events?.addListener(refresh);
  void api.storage.local.get(EXPERIMENTS).then(values => {
    if (!changed) render(values[EXPERIMENTS]);
  }).catch(() => {});
  button.addEventListener('click', () => {
    if (!button.hidden) api.breezerPrivate.focusLocationBar(() => { void api.runtime.lastError; });
  });
  addEventListener('pagehide', () => events?.removeListener(refresh), { once: true });
}

async function checkWindowsUpdate(container) {
  try {
    const response = await fetch('https://api.github.com/repos/etphli/breezer/releases/latest', {
      credentials: 'omit', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) return;
    const update = windowsUpdate(await response.json());
    if (!update) return;
    const status = container.querySelector('#sidebar-update-status');
    const link = container.querySelector('#sidebar-update-download');
    status.textContent = 'Update available';
    link.href = update.download;
    link.setAttribute('aria-label', `Download Breezer ${update.version}`);
    link.hidden = false;
    container.hidden = false;
  } catch {
    // The release page remains accessible without a background update check.
  }
}

function mountSidebarChrome() {
  const api = globalThis.chrome;
  if (!api?.runtime || api.extension?.inIncognitoContext || location.hash.startsWith('#/welcome')
      || parseRoute(location.hash).view !== 'sidebar') return;
  const sidebar = document.getElementById('sidebar');
  const update = sidebar.querySelector('#sidebar-update');
  mountExperiments(api, sidebar);

  let started = false;
  const check = async () => {
    if (started || sidebar.hidden || document.visibilityState === 'hidden') return;
    started = true;
    ready.disconnect();
    document.removeEventListener('visibilitychange', check);
    if (HAS_APP_UPDATER && typeof api.runtime.connect === 'function') {
      const { mountUpdates } = await import('./settings.js');
      mountUpdates(api, { sidebar: true });
    } else if (PLATFORM === 'windows') {
      await checkWindowsUpdate(update);
    }
  };
  const ready = new MutationObserver(() => void check());
  ready.observe(sidebar, { attributes: true, attributeFilter: ['hidden'] });
  document.addEventListener('visibilitychange', check);
  addEventListener('pagehide', () => {
    ready.disconnect();
    document.removeEventListener('visibilitychange', check);
  }, { once: true });
  void check();
}

if (typeof document !== 'undefined') mountSidebarChrome();
