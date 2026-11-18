// Extend the real main panel fixture without replacing its UI/provider behavior.
export function installPanelAreaEvents() {
  for (const name of ['local', 'session']) {
    const area = window.chrome.storage[name], listeners = new Set(), set = area.set;
    area.onChanged = { addListener: fn => listeners.add(fn), removeListener: fn => listeners.delete(fn) };
    area.set = async items => {
      const previous = await area.get(Object.keys(items));
      await set(items);
      const changes = Object.fromEntries(Object.entries(items).map(([key, newValue]) => [key, { oldValue: previous[key], newValue }]));
      for (const listener of listeners) listener(structuredClone(changes));
    };
  }
}
