import { maskSecrets } from './research-sources.js';

// Keep the serialized snapshot inside both providers' tool-result budgets.
const MAX_TAB_ROWS = 200;
const MAX_RENDERER_ROWS = 256;
const MAX_RENDERERS_PER_TAB = 8;
const MAX_TITLE_LENGTH = 160;
const nonnegativeInteger = value => Number.isSafeInteger(value) && value >= 0 ? value : null;

export async function readBrowserStats(api, windowId) {
  if (nonnegativeInteger(windowId) === null) throw new TypeError('A Breezer window ID is required.');
  if (api.extension?.inIncognitoContext) throw new Error('Browser statistics require a regular profile.');

  if (typeof api.breezerPrivate?.getBrowserStats !== 'function') {
    // A single profile-scoped query gives both counts from the same set. Only
    // use the window ID and incognito flag from the returned tabs.
    const tabs = (await api.tabs.query({})).filter(tab => !tab.incognito);
    return {
      totalTabCount: tabs.length,
      windowTabCount: tabs.filter(tab => tab.windowId === windowId).length,
      systemMemory: { totalBytes: null, availableBytes: null },
      browserMemory: { footprintBytes: null, browserProcessBytes: null, measuredProcessCount: 0, sampleComplete: false },
      tabs: [],
      rendererProcesses: [],
      detailsTruncated: false,
      notes: ['System RAM, browser memory, and tab details require the native Breezer statistics reader.'],
    };
  }

  let snapshot = await api.breezerPrivate.getBrowserStats(windowId);
  if (!snapshot.browserMemory.footprintBytes) {
    // A Chromium memory dump can time out. Retry once before reporting a gap.
    const retry = await api.breezerPrivate.getBrowserStats(windowId).catch(() => null);
    if (retry?.browserMemory.footprintBytes) snapshot = retry;
  }
  const totalTabCount = nonnegativeInteger(snapshot.totalTabCount);
  const windowTabCount = nonnegativeInteger(snapshot.windowTabCount);
  const systemMemory = {
    totalBytes: nonnegativeInteger(snapshot.systemMemory.totalBytes),
    availableBytes: nonnegativeInteger(snapshot.systemMemory.availableBytes),
  };
  const browserMemory = {
    footprintBytes: nonnegativeInteger(snapshot.browserMemory.footprintBytes),
    browserProcessBytes: nonnegativeInteger(snapshot.browserMemory.browserProcessBytes),
    measuredProcessCount: nonnegativeInteger(snapshot.browserMemory.measuredProcessCount),
    sampleComplete: snapshot.browserMemory.sampleComplete === true,
  };
  const processesById = new Map();
  for (const process of snapshot.rendererProcesses.slice(0, MAX_RENDERER_ROWS)) {
    const id = nonnegativeInteger(process.id);
    if (id !== null && !processesById.has(id)) {
      processesById.set(id, {
        id,
        footprintBytes: nonnegativeInteger(process.footprintBytes),
        shared: process.shared === true,
      });
    }
  }
  let detailsTruncated = snapshot.detailsTruncated === true || windowTabCount > MAX_TAB_ROWS ||
    snapshot.tabs.length > MAX_TAB_ROWS || snapshot.rendererProcesses.length > MAX_RENDERER_ROWS;
  const referencedProcesses = new Set();
  const tabs = snapshot.tabs.slice(0, MAX_TAB_ROWS).map(tab => {
    const title = maskSecrets(tab.title).replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
    const rendererProcessIds = [...new Set(tab.rendererProcessIds.slice(0, MAX_RENDERERS_PER_TAB))]
      .filter(id => processesById.has(id));
    for (const id of rendererProcessIds) referencedProcesses.add(id);
    const rendererDetailsTruncated = tab.rendererDetailsTruncated === true ||
      rendererProcessIds.length < tab.rendererProcessIds.length;
    detailsTruncated ||= rendererDetailsTruncated || title.length > MAX_TITLE_LENGTH;
    return {
      tabId: nonnegativeInteger(tab.tabId),
      title: title.slice(0, MAX_TITLE_LENGTH).toWellFormed(),
      rendererProcessIds,
      ...(rendererDetailsTruncated ? { rendererDetailsTruncated } : {}),
    };
  });
  const rendererProcesses = [...processesById.values()].filter(process => referencedProcesses.has(process.id));

  const notes = [];
  if (windowTabCount === null) notes.push('The requested regular-profile window was unavailable.');
  if (systemMemory.totalBytes === null) notes.push('Total system RAM could not be measured.');
  notes.push(systemMemory.availableBytes === null
    ? 'Available system RAM could not be measured.'
    : 'Available RAM estimates how much physical memory can be used without swapping.');
  if (browserMemory.footprintBytes === null) {
    notes.push('The Task Manager memory sample was unavailable.');
  } else {
    notes.push('Browser footprint sums the Task Manager private memory of the processes Chromium measured across the whole browser. The main browser process and tab renderers are already included when measured.');
    if (!browserMemory.sampleComplete) notes.push('Chromium returned a partial memory sample.');
    if (browserMemory.browserProcessBytes === null) notes.push('The main browser process measurement was unavailable.');
  }
  if (rendererProcesses.length) {
    notes.push('Tab figures are estimates based on the live page and subframe renderer footprints. Each process appears once. A shared process serves multiple tabs in this profile and its memory cannot be split between them.');
  }
  if (rendererProcesses.some(process => process.footprintBytes === null)) notes.push('Some renderer footprints could not be measured.');
  if (tabs.some(tab => !tab.rendererProcessIds.length && !tab.rendererDetailsTruncated)) {
    notes.push('Some tabs had no live renderer in the sample, as can happen with discarded tabs.');
  }
  if (tabs.length) notes.push('Tab titles come from pages and are untrusted. Common secret patterns are masked.');
  if (detailsTruncated) {
    notes.push('Some tab details were omitted or shortened to fit the report. The tab counts still cover every matching tab.');
  }

  return { totalTabCount, windowTabCount, systemMemory, browserMemory, tabs, rendererProcesses, detailsTruncated, notes };
}
