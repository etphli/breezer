import { RELEASE_PAGE_VERSION } from './release-info.js';
export const RELEASE_SEEN_KEY = 'breezer.releaseNotesSeen';

export function installReleaseNotes(api) {
  if (!api?.runtime?.getURL || !api?.windows?.getAll || !api?.tabs?.create || !api?.storage?.local) return;
  const url = api.runtime.getURL('whats-new.html');
  let pending;
  async function show() {
    if (api.extension?.inIncognitoContext) return;
    const seen = (await api.storage.local.get(RELEASE_SEEN_KEY))[RELEASE_SEEN_KEY];
    if (typeof seen === 'string' && seen.replace(/\.\d+$/, '.0') === RELEASE_PAGE_VERSION) return;
    const windows = await api.windows.getAll({ windowTypes: ['normal'] });
    const window = windows.find(value => !value.incognito && value.type === 'normal');
    if (!window) return;
    const tabs = await api.tabs.query({ url });
    if (!tabs.some(tab => !tab.incognito)) await api.tabs.create({ windowId: window.id, url, active: true });
    await api.storage.local.set({ [RELEASE_SEEN_KEY]: RELEASE_PAGE_VERSION });
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
