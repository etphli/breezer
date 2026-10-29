// Breezer "What's new" page. It reads only the release version and closes its
// own tab on Continue browsing. It stores nothing and sends nothing.

const api = globalThis.chrome;

// Names a release version, or nothing when it is missing or malformed.
export function releaseName(version) {
  return typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version) ? `Breezer ${version}` : 'Breezer';
}

// Closes this tab, falling back to window.close() outside a tab or on failure.
export async function continueBrowsing({ tabs = api?.tabs, close = () => window.close() } = {}) {
  try {
    const current = await tabs?.getCurrent?.();
    if (current?.id != null) {
      await tabs.remove(current.id);
      return 'tab';
    }
  } catch { /* fall back below */ }
  close();
  return 'window';
}

async function showRelease() {
  let version = null;
  try { ({ RELEASE_VERSION: version } = await import('./release-info.js')); } catch { /* keep the generic name */ }
  const name = releaseName(version);
  document.getElementById('release-name').textContent = name;
  document.title = `What's new in ${name}`;
  document.documentElement.dataset.version = name === 'Breezer' ? '' : version;
}

if (typeof document !== 'undefined') {
  for (const button of document.querySelectorAll('[data-action="continue"]')) {
    button.addEventListener('click', async () => {
      button.disabled = true;
      await continueBrowsing();
      // Still here: the browser refused to close this page.
      setTimeout(() => {
        button.disabled = false;
        document.getElementById('close-hint').hidden = false;
      }, 300);
    });
  }

  await showRelease();
  document.documentElement.dataset.ready = 'true';
}
