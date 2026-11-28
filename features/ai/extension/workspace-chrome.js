import { HAS_APP_UPDATER, PLATFORM } from './platform.js';
import { RELEASE_VERSION } from './release-info.js';
import { localStorageChanges } from './storage-events.js';
import { parseRoute } from './workspace-store.js';
import { normalizeExperiments } from './experiments.js';

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

// What the sidebar shows for a page. Only a committed address is ever shown,
// and the site stays separate from the path so it survives truncation.
export function sidebarAddress(tab, ownOrigin = '') {
  const url = typeof tab?.url === 'string' ? tab.url : '';
  if (!url || /^(about:blank|chrome:\/\/(newtab|new-tab-page))(\/|$)/.test(url)) return null;
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (ownOrigin && url.startsWith(`${ownOrigin}/`)) {
    if (parsed.pathname === '/newtab.html') return null;
    const settings = parsed.pathname === '/workspace.html' && parsed.hash.startsWith('#/settings');
    return { site: settings ? 'Breezer Settings' : tab.title || 'Breezer', path: '' };
  }
  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`.slice(0, 2048);
  if (/^https?:$/.test(parsed.protocol)) {
    const scheme = parsed.protocol === 'http:' ? 'http://' : '';
    return { site: scheme + parsed.host.replace(/^www\./, ''), path: path === '/' ? '' : path };
  }
  return parsed.host
    ? { site: `${parsed.protocol}//${parsed.host}`, path: path === '/' ? '' : path }
    : { site: parsed.protocol, path };
}

// Follows the selected tab of this window while the address is shown.
function mountAddress(api, button) {
  const hint = button.querySelector('.sidebar-address-hint');
  const label = button.querySelector('.sidebar-address-url');
  const site = label.querySelector('bdi');
  const path = label.querySelector('.sidebar-address-path');
  const own = api.runtime.getURL('').replace(/\/$/, '');
  const { windowId } = parseRoute(location.hash);
  let on = false, version = 0;

  const paint = tab => {
    const address = sidebarAddress(tab, own);
    hint.hidden = Boolean(address);
    label.hidden = !address;
    site.textContent = address?.site ?? '';
    path.textContent = address?.path ?? '';
    const text = address ? address.site + address.path : '';
    button.title = text;
    button.setAttribute('aria-label', text ? `Open the address bar, ${text}` : 'Open the address bar');
  };
  const refresh = async () => {
    const current = ++version;
    try {
      const [tab] = await api.tabs.query(windowId === null ? { active: true, currentWindow: true } : { active: true, windowId });
      if (on && current === version) paint(tab);
    } catch {
      // The window is closing.
    }
  };
  const here = id => windowId === null || id === windowId;
  const onActivated = info => { if (here(info.windowId)) void refresh(); };
  const onUpdated = (_id, change, tab) => {
    if (!tab?.active || !here(tab.windowId) || !('url' in change || 'title' in change)) return;
    ++version;
    paint(tab);
  };
  const onReplaced = () => void refresh();
  return show => {
    if (show === on) return;
    on = show;
    const call = on ? 'addListener' : 'removeListener';
    api.tabs.onActivated[call](onActivated);
    api.tabs.onUpdated[call](onUpdated);
    api.tabs.onReplaced?.[call]?.(onReplaced);
    if (on) void refresh(); else ++version;
  };
}

function mountExperiments(api, sidebar) {
  if (!api.storage?.local) return;
  const row = sidebar.querySelector('#sidebar-address-row');
  const button = sidebar.querySelector('#sidebar-address');
  const followAddress = mountAddress(api, button);
  const canFocus = typeof api.breezerPrivate?.focusLocationBar === 'function';
  const render = value => {
    const experiments = normalizeExperiments(value);
    row.hidden = !canFocus || !experiments.sidebarSearch;
    followAddress(!row.hidden);
    sidebar.toggleAttribute('data-glass', experiments.glass);
    sidebar.style.setProperty('--glass-opacity', `${experiments.glassOpacity}%`);
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
    if (!row.hidden) api.breezerPrivate.focusLocationBar(() => { void api.runtime.lastError; });
  });
  const openExtensionsPage = () => void Promise.resolve(api.tabs.create({ url: 'chrome://extensions/' })).catch(() => {});
  sidebar.querySelector('#sidebar-extensions').addEventListener('click', () => {
    if (typeof api.breezerPrivate.showExtensionsMenu !== 'function') { openExtensionsPage(); return; }
    // The menu is unavailable while its toolbar button is turned off.
    api.breezerPrivate.showExtensionsMenu(() => { if (api.runtime.lastError) openExtensionsPage(); });
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
