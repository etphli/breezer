// The native bridge exchanges workspace metadata only. Passwords and vault keys
// never pass through this worker, extension messages, AI prompts or storage.
import { APPEARANCE_REV_KEY, LOCK_NAME, STORE_KEY, DEFAULT_APPEARANCE, defaultStore, normalizeStore, normalizeAppearance } from './workspace-store.js';
import { emptySyncModel, projectWorkspace, recordWorkspaceChanges, mergeSyncModels, materializeWorkspace, serializeSyncModel, validateSyncModel, syncModelValues, recoveredSpace } from './workspace-sync-model.js';

export const SYNC_LOCAL_KEY = 'workspace.sync.local.v1';
export const SYNC_STATE_KEY = 'workspace.sync.state.v1';
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function decode(value) {
  if (value === '') return emptySyncModel();
  return validateSyncModel(JSON.parse(value));
}

export class WorkspaceSync {
  constructor({ storage, locks, bridge, makeClientId = () => crypto.randomUUID().replaceAll('-', '') }) {
    this.storage = storage;
    this.locks = locks;
    this.bridge = bridge;
    this.makeClientId = makeClientId;
  }

  async state(value) {
    try {
      const previous = await this.storage.local.get(SYNC_STATE_KEY);
      if (!same(previous[SYNC_STATE_KEY], value)) await this.storage.local.set({ [SYNC_STATE_KEY]: value });
    } catch { /* Return the failure even if local storage cannot persist status. */ }
    return value;
  }

  async cycle() {
    try {
      return await this.locks.request(LOCK_NAME, () => this.reconcile());
    } catch (error) {
      // The error state contains no native payloads, recovery keys or model data.
      return this.state({ phase: 'error', message: error instanceof SyntaxError ? 'Invalid remote workspace data. Local data is preserved.' : error.message || 'Workspace sync failed. Local data is preserved.' });
    }
  }

  async repair({ removeSpace, moveFavorite }) {
    await this.locks.request(LOCK_NAME, async () => {
      const saved = await this.storage.local.get(SYNC_LOCAL_KEY);
      const local = saved[SYNC_LOCAL_KEY];
      if (!local || local.version !== 1) throw new Error('No local workspace recovery data is available.');
      const before = syncModelValues(local.model);
      const after = structuredClone(before);
      const spaces = Object.keys(after).filter(key => key.startsWith('space/') && after[key].alive === true)
        .sort((a, b) => (after[a].index || 0) - (after[b].index || 0) || (a < b ? -1 : a > b ? 1 : 0));
      if (removeSpace) {
        const key = `space/${removeSpace}`;
        if (!spaces.includes(key) || spaces.length < 2) throw new Error('Keep at least one synced space.');
        delete after[key];
      } else if (moveFavorite) {
        const key = `entry/${moveFavorite}`;
        if (after[key]?.parent !== 'favorites') throw new Error('That synced favorite no longer exists.');
        if (!spaces.length) {
          const recovered = recoveredSpace(local.model);
          const parent = `space/${recovered.id}`;
          after[parent] = { alive: true, name: recovered.name, tone: recovered.tone, index: 0 };
          spaces.push(parent);
        }
        after[key].parent = spaces[0];
      } else throw new Error('Choose a synced space or favorite to recover.');
      local.model = recordWorkspaceChanges(local.model, before, after, local.clientId);
      await this.storage.local.set({ [SYNC_LOCAL_KEY]: local });
    });
    return this.cycle();
  }

  async reconcile() {
    let remote = await this.bridge.read();
    const nativeHealth = remote.nativeError ? { nativeError: true, nativeMessage: remote.nativeMessage || 'Native sync needs attention. Open native setup.' } : {};
    if (!remote.configured) return this.state({ phase: 'disabled', ...nativeHealth });
    if (!remote.workspaceEnabled) return this.state({ phase: 'workspaceOff', ...nativeHealth });
    if (typeof remote.providerId !== 'string' || !remote.providerId || typeof remote.vaultId !== 'string' || !remote.vaultId || typeof remote.model !== 'string') throw new Error('Native workspace sync state is invalid.');
    const values = await this.storage.local.get([STORE_KEY, SYNC_LOCAL_KEY]);
    const store = normalizeStore(values[STORE_KEY]);
    const appearance = normalizeAppearance(await this.bridge.getAppearance());
    const current = projectWorkspace(store, appearance);
    let local = values[SYNC_LOCAL_KEY];
    if (!local || local.providerId !== remote.providerId || local.vaultId !== remote.vaultId) {
      // Joining another vault intentionally merges this profile's current saved
      // workspace, but never carries the previous vault's deletion records.
      // Existing remote values win over untouched first-run defaults. Saved
      // local customizations still become edits and merge by persistent ID.
      const defaults = projectWorkspace(defaultStore(), DEFAULT_APPEARANCE);
      const baseline = Object.fromEntries(Object.entries(defaults).filter(([key]) => key in current));
      local = { version: 1, providerId: remote.providerId, vaultId: remote.vaultId, clientId: this.makeClientId(), model: decode(remote.model), baseline };
    }
    if (local.version !== 1 || !local.baseline || typeof local.baseline !== 'object') throw new Error('Local sync recovery data is invalid. Local data is preserved.');
    local = { ...local, model: recordWorkspaceChanges(local.model, local.baseline, current, local.clientId), baseline: current };
    // Capture before attempting transport. A crash, disconnect or provider
    // failure cannot erase edits that have not reached the remote preference.
    await this.storage.local.set({ [SYNC_LOCAL_KEY]: local });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      local.model = mergeSyncModels(local.model, decode(remote.model));
      await this.storage.local.set({ [SYNC_LOCAL_KEY]: local });
      const applied = materializeWorkspace(local.model, store);
      const model = serializeSyncModel(local.model);
      if (model !== remote.model) {
        const result = await this.bridge.exchange({ providerId: local.providerId, vaultId: local.vaultId, expectedModel: remote.model, model });
        if (!result.configured || !result.workspaceEnabled || result.providerId !== local.providerId || result.vaultId !== local.vaultId) throw new Error('Sync was disconnected or changed vaults. Local data is preserved.');
        if (result.model !== model) {
          remote = result;
          continue;
        }
      }
      const patch = Object.fromEntries(Object.entries(applied.appearance).filter(([field, value]) => appearance[field] !== value));
      let nextAppearance = appearance;
      let appearanceError;
      if (Object.keys(patch).length) {
        try { nextAppearance = normalizeAppearance(await this.bridge.setAppearance(patch)); }
        catch (error) { appearanceError = error.message || 'Native appearance settings could not be changed.'; }
      }
      const changed = !same(projectWorkspace(store), projectWorkspace(applied.store));
      applied.store.rev = store.rev + (changed ? 1 : 0);
      local.baseline = projectWorkspace(applied.store, nextAppearance);
      const writes = { [SYNC_LOCAL_KEY]: local };
      if (changed) writes[STORE_KEY] = applied.store;
      await this.storage.local.set(writes);
      if (Object.keys(patch).length) await this.storage.session.set({ [APPEARANCE_REV_KEY]: Date.now() });
      if (appearanceError) return this.state({ phase: 'appearanceBlocked', message: `Saved spaces were updated locally. Appearance remains unchanged: ${appearanceError}`, ...nativeHealth });
      return this.state({ phase: 'reconciled', vaultId: local.vaultId, ...nativeHealth });
    }
    throw new Error('Workspace changed repeatedly during sync. Local data is preserved; retry shortly.');
  }
}

export function workspaceSyncForApi(api) {
  const native = api.breezerPrivate;
  if (typeof native?.readWorkspaceSync !== 'function' || typeof native?.exchangeWorkspaceSync !== 'function' || !globalThis.navigator?.locks) return null;
  const invoke = (method, args = []) => new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value, error) => {
      if (settled) return;
      settled = true; clearTimeout(timeout);
      error ? reject(new Error(error.message || String(error))) : resolve(value);
    };
    const timeout = setTimeout(() => finish(null, new Error('Native workspace sync did not respond. Local data is preserved.')), 5000);
    try {
      const promise = native[method](...args, value => finish(value, api.runtime?.lastError));
      if (promise?.then) promise.then(value => finish(value), error => finish(null, error));
    } catch (error) { finish(null, error); }
  });
  return new WorkspaceSync({ storage: api.storage, locks: navigator.locks, bridge: {
    read: () => invoke('readWorkspaceSync'),
    exchange: request => invoke('exchangeWorkspaceSync', [request]),
    getAppearance: () => invoke('getAppearance'),
    setAppearance: patch => invoke('setAppearance', [patch]),
  } });
}

export function installWorkspaceSync(api) {
  const sync = workspaceSyncForApi(api);
  if (!sync) return { dispose() {} };
  const native = api.breezerPrivate;
  let disposed = false, running = false, dirty = false, timer;
  const drain = async () => {
    if (running || disposed) return;
    running = true;
    try { while (dirty && !disposed) {
      dirty = false;
      const result = await sync.cycle();
      if (result.phase === 'disabled') await api.alarms?.clear(alarmName);
      else await api.alarms?.create(alarmName, { periodInMinutes: 0.5 });
    } }
    finally { running = false; }
  };
  const schedule = () => {
    if (disposed) return;
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(() => { void drain(); }, 250);
  };
  const changed = (changes, area) => {
    if (area === 'local' && changes[STORE_KEY] || area === 'session' && changes[APPEARANCE_REV_KEY]) schedule();
  };
  const alarmName = 'breezer.workspace.sync';
  const alarm = value => { if (value.name === alarmName) schedule(); };
  api.storage.onChanged?.addListener(changed);
  api.alarms?.onAlarm?.addListener(alarm);
  native.onSyncStateChanged?.addListener(schedule);
  schedule();
  return { dispose() {
    disposed = true; clearTimeout(timer);
    api.storage.onChanged?.removeListener(changed);
    api.alarms?.onAlarm?.removeListener(alarm);
    native.onSyncStateChanged?.removeListener(schedule);
    void api.alarms?.clear(alarmName);
  } };
}
