// Persistent workspace merge rules. Transport and credential handling stay native.
import { defaultStore, normalizeStore, normalizeAppearance, validateAppearancePatch, MAX_SPACES, MAX_FAVORITES } from './workspace-store.js';

export const SYNC_MODEL_VERSION = 1;
export const MAX_SYNC_BYTES = 1024 * 1024;
const MAX_RECORDS = 12000;
const clientPattern = /^[a-zA-Z0-9_-]{8,64}$/;
const fields = new Set(['alive', 'name', 'tone', 'url', 'title', 'customTitle', 'parent', 'index', 'newTabPosition', 'closeButton', 'appearance']);
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const compare = (a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0);

export function emptySyncModel() { return { version: SYNC_MODEL_VERSION, records: {} }; }

// Only these fields can cross the native workspace boundary. In particular this
// never traverses workspace.members.v1, tab IDs, window IDs, AI state or secrets.
export function projectWorkspace(rawStore, rawAppearance) {
  const store = normalizeStore(rawStore);
  const entities = {};
  const node = (value, parent, index) => {
    const key = `${value.kind === 'folder' ? 'folder' : 'entry'}/${value.id}`;
    if (value.kind === 'folder') {
      entities[key] = { alive: true, name: value.name, parent, index };
      value.children.forEach((child, at) => node(child, key, at));
    } else {
      entities[key] = { alive: true, url: value.url, title: value.title, customTitle: value.customTitle || '', parent, index };
    }
  };
  store.spaces.forEach((space, index) => {
    const key = `space/${space.id}`;
    entities[key] = { alive: true, name: space.name, tone: space.tone, index };
    space.pinned.forEach((item, at) => node(item, key, at));
  });
  store.favorites.forEach((item, at) => node(item, 'favorites', at));
  entities.preferences = { ...store.prefs };
  if (rawAppearance) {
    for (const [key, value] of Object.entries(normalizeAppearance(rawAppearance))) {
      // showBookmarks is a compatibility alias of bookmarkBarMode.
      if (key !== 'showBookmarks') entities[`appearance/${key}`] = { appearance: value };
    }
  }
  return entities;
}

function validField(key, field, value) {
  if (!fields.has(field)) return false;
  if (key.startsWith('appearance/')) {
    if (field !== 'appearance' || key === 'appearance/showBookmarks') return false;
    try { validateAppearancePatch({ [key.slice(11)]: value }); return true; } catch { return false; }
  }
  if (key === 'preferences') return field === 'newTabPosition' ? ['top', 'bottom'].includes(value) : field === 'closeButton' && ['always', 'hover'].includes(value);
  const [kind] = key.split('/');
  if (field === 'alive') return typeof value === 'boolean';
  if (field === 'index') return Number.isInteger(value) && value >= 0 && value < MAX_RECORDS;
  if (field === 'name') return kind !== 'entry' && typeof value === 'string' && value.length > 0 && value.length <= (kind === 'space' ? 60 : 80);
  if (field === 'tone') return kind === 'space' && ['mint', 'tide', 'dusk', 'rose', 'pollen', 'graphite'].includes(value);
  if (field === 'parent') return kind !== 'space' && typeof value === 'string' && (value === 'favorites' && kind === 'entry' || /^(space|folder)\/[a-zA-Z0-9_-]{1,64}$/.test(value) && !(kind === 'folder' && value.startsWith('folder/')));
  if (field === 'url') return kind === 'entry' && typeof value === 'string' && /^(https?|chrome|chrome-extension|file|about):/i.test(value) && value.length <= 8192;
  return kind === 'entry' && ['title', 'customTitle'].includes(field) && typeof value === 'string' && value.length <= 200;
}

export function validateSyncModel(model) {
  if (!model || model.version !== SYNC_MODEL_VERSION || !model.records || typeof model.records !== 'object' || Array.isArray(model.records)) throw new Error('Unsupported workspace sync data.');
  const serialized = JSON.stringify(model);
  const units = serialized === undefined ? 0 : serialized.length;
  // UTF-8 uses between one and three bytes per UTF-16 code unit. Encode only
  // when these bounds straddle the limit; encode(undefined) was empty too.
  if (units > MAX_SYNC_BYTES || units * 3 > MAX_SYNC_BYTES && new TextEncoder().encode(serialized).length > MAX_SYNC_BYTES) throw new Error('Workspace sync has reached its storage limit. Local data is preserved.');
  const records = Object.entries(model.records);
  if (records.length > MAX_RECORDS) throw new Error('Workspace sync has too many records.');
  const identities = new Set();
  for (const [key, record] of records) {
    if (!(key === 'preferences' || /^appearance\/[a-zA-Z]+$/.test(key) || /^(space|entry|folder)\/[a-zA-Z0-9_-]{1,64}$/.test(key))) throw new Error('Invalid workspace identity.');
    if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length > 12) throw new Error('Invalid workspace record.');
    for (const [field, register] of Object.entries(record)) {
      if (!Array.isArray(register) || register.length !== 3 || !Number.isSafeInteger(register[0]) || register[0] < 1 || !clientPattern.test(register[1]) || !validField(key, field, register[2])) throw new Error('Invalid workspace sync field.');
    }
    if (key.startsWith('appearance/') && !record.appearance || key === 'preferences' && (!record.newTabPosition || !record.closeButton)) throw new Error('Incomplete synced preferences. Local data is preserved.');
    const kind = key.split('/')[0];
    if (['space', 'folder', 'entry'].includes(kind)) {
      if (!record.alive) throw new Error('Incomplete synced identity. Local data is preserved.');
      if (record.alive[2]) {
        const required = kind === 'space' ? ['name', 'tone', 'index'] : kind === 'folder' ? ['name', 'parent', 'index'] : ['url', 'title', 'parent', 'index'];
        if (required.some(field => !record[field])) throw new Error('Incomplete synced record. Local data is preserved.');
        const id = key.slice(kind.length + 1);
        if (identities.has(id)) throw new Error('Conflicting synced identities. Local data is preserved.');
        identities.add(id);
      }
    }

  }
  return model;
}

// Per-field logical clocks avoid wall-clock skew. Deletions are permanent for an
// identity; a concurrent rename/move can never bring a removed item back.
export function mergeSyncModels(left, right) {
  validateSyncModel(left); validateSyncModel(right);
  const result = structuredClone(left);
  for (const [key, incoming] of Object.entries(right.records)) {
    const record = result.records[key] ||= {};
    for (const [field, value] of Object.entries(incoming)) {
      const old = record[field];
      if (field === 'alive' && old?.[2] === false && value[2] !== false) continue;
      if (!old || field === 'alive' && value[2] === false && old[2] !== false || compare(value, old) > 0) record[field] = structuredClone(value);
      else if (compare(value, old) === 0 && !equal(value, old)) throw new Error('Conflicting workspace clock. Local data is preserved.');
    }
  }
  return validateSyncModel(result);
}

export function recordWorkspaceChanges(model, before, after, client) {
  validateSyncModel(model);
  if (!clientPattern.test(client)) throw new Error('Invalid sync client identity.');
  const result = structuredClone(model);
  let clock = 0;
  for (const record of Object.values(model.records)) {
    for (const register of Object.values(record)) clock = Math.max(clock, register[0]);
  }
  const write = (key, field, value) => {
    if (clock >= Number.MAX_SAFE_INTEGER) throw new Error('Workspace sync clock is exhausted.');
    (result.records[key] ||= {})[field] = [++clock, client, value];
  };
  for (const [key, values] of Object.entries(after)) {
    if (result.records[key]?.alive?.[2] === false) continue;
    for (const [field, value] of Object.entries(values)) {
      if (!result.records[key]?.[field] || !before[key] || !equal(before[key][field], value)) write(key, field, value);
    }
  }
  for (const key of Object.keys(before)) {
    if (!(key in after) && /^(space|folder|entry)\//.test(key)) write(key, 'alive', false);
  }
  return validateSyncModel(result);
}

export function syncModelValues(model) {
  validateSyncModel(model);
  const values = {};
  for (const [key, record] of Object.entries(model.records)) {
    if (record.alive?.[2] === false) continue;
    values[key] = Object.fromEntries(Object.entries(record).map(([field, register]) => [field, register[2]]));
  }
  return values;
}

export function recoveredSpace(model) {
  let id = 'space-default';
  for (let index = 1; model.records[`space/${id}`]?.alive?.[2] === false || model.records[`entry/${id}`]?.alive?.[2] === true || model.records[`folder/${id}`]?.alive?.[2] === true; index += 1) id = `space-recovery-${index}`;
  return { ...defaultStore().spaces[0], id };
}

export function materializeWorkspace(model, localStore = defaultStore()) {
  validateSyncModel(model);
  const values = syncModelValues(model);
  const ordered = (prefix) => Object.entries(values).filter(([key, value]) => key.startsWith(prefix) && value.alive === true).sort(([ak, a], [bk, b]) => (a.index || 0) - (b.index || 0) || (ak < bk ? -1 : 1));
  const spaces = ordered('space/').map(([key, s]) => ({ id: key.slice(6), name: s.name || 'Space', tone: s.tone || 'mint', pinned: [] }));
  if (spaces.length > MAX_SPACES) throw new Error(`Synced workspaces exceed ${MAX_SPACES} spaces. Local data is preserved.`);
  // Concurrent removal of the final spaces cannot strand the surviving pins.
  if (!spaces.length) spaces.push(recoveredSpace(model));
  const bySpace = new Map(spaces.map(s => [`space/${s.id}`, s]));
  const orderedFolders = ordered('folder/');
  const localExpansion = new Map();
  if (orderedFolders.length) {
    const folderIds = orderedFolders.map(([key]) => key.slice(7));
    for (const space of localStore.spaces) {
      const remaining = new Set(folderIds);
      for (const node of space.pinned) {
        if (node.kind === 'folder' && remaining.delete(node.id)) localExpansion.set(node.id, node.open);
        if (!remaining.size) break;
      }
    }
  }
  const folders = new Map();
  for (const [key, folder] of orderedFolders) {
    const node = { kind: 'folder', id: key.slice(7), name: folder.name || 'Folder', open: true, children: [] };
    // Expansion is device-local, even when a folder is renamed remotely.
    if (localExpansion.has(node.id)) node.open = localExpansion.get(node.id);
    folders.set(key, node);
    (bySpace.get(folder.parent) || spaces[0]).pinned.push(node);
  }
  const favorites = [];
  for (const [key, entry] of ordered('entry/')) {
    if (!entry.url) throw new Error('Incomplete synced pin. Local data is preserved.');
    const node = { kind: 'entry', id: key.slice(6), url: entry.url, title: entry.title || entry.url };
    if (entry.customTitle) node.customTitle = entry.customTitle;
    if (entry.parent === 'favorites') favorites.push(node);
    else if (folders.has(entry.parent)) folders.get(entry.parent).children.push(node);
    else (bySpace.get(entry.parent) || spaces[0]).pinned.push(node);
  }
  if (favorites.length > MAX_FAVORITES) throw new Error(`Synced workspaces exceed ${MAX_FAVORITES} favorites. Local data is preserved.`);
  // Sort folders and pins together using their position registers.
  for (const space of spaces) space.pinned.sort((a, b) => {
    const ak = `${a.kind === 'folder' ? 'folder' : 'entry'}/${a.id}`;
    const bk = `${b.kind === 'folder' ? 'folder' : 'entry'}/${b.id}`;
    return (values[ak]?.index || 0) - (values[bk]?.index || 0) || (ak < bk ? -1 : 1);
  });
  const appearance = {};
  for (const [key, value] of Object.entries(values)) if (key.startsWith('appearance/')) appearance[key.slice(11)] = value.appearance;
  return { store: normalizeStore({ version: 1, rev: localStore.rev, spaces, favorites, prefs: values.preferences || localStore.prefs }), appearance };
}

// Stable serialization avoids republishing equivalent maps after opposite merge
// orders, which would otherwise keep waking both clients indefinitely.
export function serializeSyncModel(model) {
  validateSyncModel(model);
  const records = {};
  for (const key of Object.keys(model.records).sort()) {
    records[key] = Object.fromEntries(Object.entries(model.records[key]).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
  }
  return JSON.stringify({ version: SYNC_MODEL_VERSION, records });
}
