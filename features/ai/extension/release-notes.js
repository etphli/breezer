import { RELEASE_PAGE_VERSION } from './release-info.js';
import { SETUP_KEY, SETUP_PATH } from './setup-state.js';
export const RELEASE_SEEN_KEY = 'breezer.releaseNotesSeen';
// Saved by earlier versions; any of these means the profile has been used before.
const EARLIER_USE_KEYS = ['settings.onboarding.v1', 'breezerProfile'];

// A brand-new profile gets the setup guide instead of the release notes. Its notes
// version is recorded at the same time, so the notes page doesn't follow later.
export function installReleaseNotes(api) {
  if (!api?.runtime?.getURL || !api?.windows?.getAll || !api?.tabs?.create || !api?.storage?.local) return;
  const notesUrl = api.runtime.getURL('whats-new.html');
  const setupUrl = api.runtime.getURL(SETUP_PATH);
  let pending;
  async function show() {
    if (api.extension?.inIncognitoContext) return;
    const saved = await api.storage.local.get([RELEASE_SEEN_KEY, SETUP_KEY, ...EARLIER_USE_KEYS]);
    const seen = saved[RELEASE_SEEN_KEY];
    if (typeof seen === 'string' && seen.replace(/\.\d+$/, '.0') === RELEASE_PAGE_VERSION) return;
    const firstRun = seen === undefined && saved[SETUP_KEY] === undefined && EARLIER_USE_KEYS.every(key => saved[key] === undefined);
    const windows = await api.windows.getAll({ windowTypes: ['normal'] });
    const window = windows.find(value => !value.incognito && value.type === 'normal');
    if (!window) return;
    const url = firstRun ? setupUrl : notesUrl;
    const tabs = await api.tabs.query({ url: url.split('#')[0] });
    if (!tabs.some(tab => !tab.incognito && (!firstRun || tab.url === setupUrl))) await api.tabs.create({ windowId: window.id, url, active: true });
    await api.storage.local.set(firstRun
      ? { [RELEASE_SEEN_KEY]: RELEASE_PAGE_VERSION, [SETUP_KEY]: { step: 'welcome', completed: false } }
      : { [RELEASE_SEEN_KEY]: RELEASE_PAGE_VERSION });
  }
  const check = () => {
    if (!pending) pending = show().catch(() => {}).finally(() => { pending = null; });
    return pending;
  };
  api.runtime.onStartup?.addListener(check);
  api.runtime.onInstalled?.addListener(check);
  api.windows.onCreated?.addListener(check);
  void check();
  return { check };
}
