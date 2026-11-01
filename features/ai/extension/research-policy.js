import { MAX_RESEARCH_SOURCES, maskSecrets, sourceURL } from './research-sources.js';

export function researchSelection(sources) {
  if (!Array.isArray(sources) || !sources.length || sources.length > MAX_RESEARCH_SOURCES) throw new Error('Choose one to six source tabs.');
  const ids = new Set();
  return sources.map(source => {
    if (!Number.isInteger(source.tabId) || ids.has(source.tabId) || typeof source.documentId !== 'string' || source.documentId.length > 100 || typeof source.expectedUrl !== 'string' || source.expectedUrl.length > 10000) throw new Error('Invalid source selection.');
    ids.add(source.tabId); sourceURL(source.expectedUrl);
    return { tabId: source.tabId, documentId: source.documentId, expectedUrl: source.expectedUrl };
  });
}

export async function prepareResearch(api, sources, draft, windowId) {
  const selection = researchSelection(sources);
  if (!draft || draft.invalidated || JSON.stringify(selection) !== JSON.stringify(draft.selection)) throw new Error('Source selection expired. Select tabs and send again.');
  return Promise.all(sources.map(async (source, index) => {
    // Internal tab/document identity never goes to the provider.
    const clean = { sourceId: `S${index + 1}`, title: maskSecrets(source.title).slice(0, 500), url: sourceURL(source.expectedUrl) };
    try {
      const tab = await api.tabs.get(source.tabId);
      if (tab.incognito || tab.windowId !== windowId || tab.url !== source.expectedUrl || tab.status === 'loading') throw new Error('Source closed, moved, loading or navigated. Select it again.');
      if (source.status !== 'available') throw new Error(String(source.error || 'Source text is unavailable.'));
      if (typeof source.text !== 'string' || source.text.length > 24000 || typeof source.truncated !== 'boolean') throw new Error('Invalid source text.');
      const text = maskSecrets(source.text);
      return { ...clean, status: 'available', text, truncated: source.truncated, capturedCharacters: text.length };
    } catch (error) { return { ...clean, status: 'unavailable', error: String(error.message).slice(0, 500) }; }
  }));
}
