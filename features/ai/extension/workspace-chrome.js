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

// Show the committed address. On focus, expose the full URL for editing.
export function sidebarAddress(tab, ownOrigin = '') {
  let url;
  try { url = new URL(tab?.url); } catch { return null; }
  if (/^(about:blank|chrome:\/\/(newtab|new-tab-page))(\/|$)/.test(url.href) ||
      (url.href.startsWith(`${ownOrigin}/`) && url.pathname === '/newtab.html')) return null;
  url.username = '';
  url.password = '';
  const value = url.href;
  if (url.href.startsWith(`${ownOrigin}/`)) {
    const settings = url.pathname === '/workspace.html' && url.hash.startsWith('#/settings');
    return { value, label: settings ? 'Breezer Settings' : tab.title || 'Breezer' };
  }
  const originOnly = url.pathname === '/' && !url.search && !url.hash;
  return { value, label: (originOnly ? value.slice(0, -1) : value).replace(/^https:\/\//, '') };
}

function mountAddress(api, sidebar, installAddressSuggestions) {
  const form = sidebar.querySelector('#sidebar-address-form');
  const input = form.querySelector('input');
  const display = form.querySelector('.sidebar-address-display');
  const list = form.querySelector('#sidebar-address-suggestions');
  const error = form.querySelector('#sidebar-address-error');
  const own = api.runtime.getURL('').replace(/\/$/, '');
  const { windowId } = parseRoute(location.hash);
  let on = false, version = 0, selectedId, address;

  const reset = () => {
    input.value = address?.value ?? '';
    input.setSelectionRange(0, 0);
    display.textContent = address?.label ?? '';
    form.title = address?.label ?? '';
    error.hidden = true;
  };
  const paint = tab => {
    const changedTab = tab?.id !== selectedId;
    selectedId = tab?.id;
    address = sidebarAddress(tab, own);
    if (changedTab) suggestions.close();
    if (changedTab || document.activeElement !== input) reset();
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
  const onActivated = info => {
    if (!here(info.windowId)) return;
    paint(undefined);
    void refresh();
  };
  const onUpdated = (_id, change, tab) => {
    if (!tab?.active || !here(tab.windowId) || !('url' in change || 'title' in change)) return;
    ++version;
    paint(tab);
  };
  const onReplaced = (_addedId, removedId) => {
    if (removedId !== selectedId) return;
    paint(undefined);
    void refresh();
  };

  async function open() {
    if (!input.value.trim() || selectedId === undefined) return;
    try {
      await suggestions.open({ tabId: selectedId });
      input.blur();
    } catch {
      if (on && document.activeElement === input) error.hidden = false;
    }
  }
  const suggestions = installAddressSuggestions({
    api, root: document, input, list,
    isActive: () => on && document.activeElement === input,
    onOpen: () => void open(),
    onCount: count => input.setAttribute('aria-expanded', String(Boolean(count))),
  });
  form.addEventListener('submit', event => { event.preventDefault(); void open(); });
  input.addEventListener('focus', () => { reset(); input.select(); });
  input.addEventListener('blur', () => { suggestions.close(); reset(); });
  input.addEventListener('input', () => { error.hidden = true; });
  input.addEventListener('keydown', event => {
    if (event.isComposing) return;
    if (suggestions.key(event.key)) event.preventDefault();
    else if (event.key === 'Escape') {
      event.preventDefault();
      input.blur();
    }
  });
  document.addEventListener('breezer-focus-sidebar-address', () => {
    if (on && input.getClientRects().length) {
      input.focus();
      input.select();
    }
  });

  return show => {
    if (show === on) return;
    on = show;
    const call = on ? 'addListener' : 'removeListener';
    api.tabs.onActivated[call](onActivated);
    api.tabs.onUpdated[call](onUpdated);
    api.tabs.onReplaced?.[call]?.(onReplaced);
    if (on) void refresh();
    else {
      ++version;
      input.blur();
    }
  };
}

function mountExperiments(api, sidebar) {
  if (!api.storage?.local) return;
  const row = sidebar.querySelector('#sidebar-address-row');
  const bridge = api.breezerPrivate;
  const canEdit = typeof bridge?.queryOmnibox === 'function' && typeof bridge?.openOmnibox === 'function';
  let followAddress, addressEnabled;
  const render = value => {
    const experiments = normalizeExperiments(value);
    addressEnabled = canEdit && experiments.sidebarSearch;
    if (addressEnabled && !followAddress) {
      void import('./newtab.js').then(({ installAddressSuggestions }) => {
        followAddress ??= mountAddress(api, sidebar, installAddressSuggestions);
        row.hidden = !addressEnabled;
        followAddress(addressEnabled);
      });
    } else {
      followAddress?.(addressEnabled);
      row.hidden = !addressEnabled;
    }
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
