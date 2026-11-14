import { isDeepStrictEqual } from 'node:util';

export function event() {
  const listeners = new Set(), removed = [];
  return { listeners, removed, addListener(fn) { listeners.add(fn); },
    removeListener(fn) { removed.push(fn); listeners.delete(fn); },
    fire(...args) { for (const fn of [...listeners]) fn(...args); } };
}

// A queued extension-wide bus. An area event receives one argument; the general
// event receives two. Registration is per context, as in extension documents.
export function storageBus(initial = {}) {
  const data = Object.fromEntries(['local','session','sync','managed'].map(area => [area, structuredClone(initial[area] || {})]));
  const contexts = [], queue = [], writes = [], deliveries = [], failures = [];
  let dispatches = 0;
  function enqueue(area, changes) {
    if (!Object.keys(changes).length) return;
    queue.push(() => {
      for (const kind of ['area','general']) {
        const recipients = contexts.filter(c => (kind === 'area' ? c.storage[area].onChanged : c.storage.onChanged).listeners.size);
        if (!recipients.length) continue;
        dispatches++;
        for (const c of recipients) {
          const ev = kind === 'area' ? c.storage[area].onChanged : c.storage.onChanged;
          const args = kind === 'area' ? [structuredClone(changes)] : [structuredClone(changes),area];
          deliveries.push({ context:c.name, area, kind, calls:ev.listeners.size, argc:args.length });
          ev.fire(...args);
        }
      }
    });
  }
  const context = name => {
    const storage = { onChanged:event() };
    for (const area of Object.keys(data)) storage[area] = {
      data:data[area], onChanged:event(),
      async get(keys) {
        const list = keys == null ? Object.keys(data[area]) : typeof keys === 'object' && !Array.isArray(keys) ? Object.keys(keys) : [keys].flat();
        return Object.fromEntries(list.filter(k => k in data[area]).map(k => [k,structuredClone(data[area][k])]));
      },
      async set(values) {
        writes.push({context:name,area,values:structuredClone(values)});
        const failure = failures.shift(); if (failure) throw new Error(failure);
        const changes={};
        for (const [key,value] of Object.entries(values)) {
          if (!isDeepStrictEqual(data[area][key],value)) changes[key]={...(key in data[area] ? {oldValue:structuredClone(data[area][key])}:{}),newValue:structuredClone(value)};
          data[area][key]=structuredClone(value);
        }
        enqueue(area,changes);
      },
      async remove(key) { const changes={}; for (const k of [key].flat()) if (k in data[area]) { changes[k]={oldValue:structuredClone(data[area][k])}; delete data[area][k]; } enqueue(area,changes); },
    };
    contexts.push({name,storage}); return storage;
  };
  return {data,context,contexts,writes,deliveries,failures,
    async flush() { let n=0; while (queue.length) { if (++n>1000) throw new Error('unbounded fake bus'); queue.shift()(); for (let i=0;i<20;i++) await Promise.resolve(); } },
    stats() { return {dispatches,deliveries:deliveries.length,calls:deliveries.reduce((n,d)=>n+d.calls,0)}; },
    reset() { dispatches=0;deliveries.length=0;writes.length=0; },
  };
}
