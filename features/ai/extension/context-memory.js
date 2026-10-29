// Hostname-only aggregates. This module never reads a document or calls a provider on an event.
export const CONTEXT_KEY = 'breezer.ai.context.v1';
export const RETENTION_DAYS = 7;
const DAY = 86_400_000;
const SLOT = 30 * 60_000;
const HOUR = 60 * 60_000;
const MAX_SITES = 20;
const sensitive = /(?:auth|login|log-in|signin|sign-in|sso|oauth|password|secret|token|account|mail|bank|payment|checkout|wallet|health|medical|patient|therapy|adult|porn)/i;
const empty = () => ({ version: 1, enabled: false, providerConsent: false, sites: [], buckets: [], lastSummary: null });
const dayNumber = now => Math.floor(now / DAY);

export function safeSite(value) {
  if (typeof value !== 'string' || value.length > 253) return null;
  const site = value.trim().toLowerCase();
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(site)
      || /\.(?:local|localhost|internal|test|onion|invalid)$/.test(site) || sensitive.test(site)) return null;
  return site;
}

function observedSite(tab) {
  if (tab?.active !== true || tab.incognito !== false || typeof tab.url !== 'string' || tab.url.length > 8192) return null;
  try {
    const url = new URL(tab.url);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || sensitive.test(decodeURIComponent(url.pathname))) return null;
    return safeSite(url.hostname);
  } catch { return null; }
}

function normalize(value, now) {
  const state = empty();
  if (value?.version !== 1 || value.enabled !== true || !Array.isArray(value.sites)) return state;
  state.sites = [...new Set(value.sites.slice(0, MAX_SITES).map(safeSite).filter(Boolean))];
  if (!state.sites.length) return state;
  state.enabled = true;
  state.providerConsent = value.providerConsent === true;
  const today = dayNumber(now), seen = new Set();
  for (const bucket of Array.isArray(value.buckets) ? value.buckets.slice(0, MAX_SITES * RETENTION_DAYS) : []) {
    if (!state.sites.includes(bucket?.site) || !Number.isInteger(bucket.day) || bucket.day > today || bucket.day <= today - RETENTION_DAYS
        || !Number.isInteger(bucket.observations) || bucket.observations < 1 || bucket.observations > 48
        || !Number.isInteger(bucket.lastSlot) || bucket.lastSlot < bucket.day * 48 || bucket.lastSlot >= (bucket.day + 1) * 48
        || bucket.lastSlot > Math.floor(now / SLOT)) continue;
    const key = `${bucket.site}:${bucket.day}`;
    if (seen.has(key)) continue;
    seen.add(key);
    state.buckets.push({ site: bucket.site, day: bucket.day, observations: bucket.observations, lastSlot: bucket.lastSlot });
  }
  const last = value.lastSummary;
  if (last && Number.isFinite(last.at) && last.at <= now && last.at > now - RETENTION_DAYS * DAY
      && typeof last.fingerprint === 'string' && /^[a-f0-9]{64}$/.test(last.fingerprint)) state.lastSummary = { at: last.at, fingerprint: last.fingerprint };
  return state;
}

function habits(state) {
  const rows = new Map();
  for (const bucket of state.buckets) {
    const row = rows.get(bucket.site) || { site: bucket.site, observations: 0, days: 0 };
    row.observations += bucket.observations; row.days++;
    rows.set(bucket.site, row);
  }
  return [...rows.values()].sort((a, b) => b.observations - a.observations || a.site.localeCompare(b.site));
}

export class ContextMemory {
  #queue = Promise.resolve();
  #epoch = 0;
  #requests = new Set();
  constructor(storage, { now = Date.now } = {}) { this.storage = storage; this.now = now; }
  #serial(work) {
    const result = this.#queue.then(work);
    this.#queue = result.catch(() => {});
    return result;
  }
  async #read() {
    const raw = (await this.storage.get(CONTEXT_KEY))[CONTEXT_KEY];
    const state = normalize(raw, this.now());
    if (raw !== undefined && JSON.stringify(raw) !== JSON.stringify(state)) await this.#write(state);
    return state;
  }
  #write(state) { return this.storage.set({ [CONTEXT_KEY]: state }); }
  cancel() {
    this.#epoch++;
    for (const controller of this.#requests) controller.abort();
  }
  async configure({ enabled, sites } = {}) {
    if (typeof enabled !== 'boolean') throw new Error('Choose whether to enable local context.');
    let selected = [];
    if (enabled) {
      if (!Array.isArray(sites) || !sites.length || sites.length > MAX_SITES) throw new Error('Choose between 1 and 20 sites to remember.');
      selected = [...new Set(sites.map(safeSite))];
      if (selected.includes(null)) throw new Error('Use public site names only. Private and sensitive sites cannot be remembered.');
    }
    this.cancel();
    await this.#serial(async () => {
      const state = await this.#read();
      // Changing scope revokes upload consent and removes data from deselected sites.
      await this.#write(enabled ? { ...state, enabled: true, sites: selected, providerConsent: false,
        buckets: state.buckets.filter(bucket => selected.includes(bucket.site)), lastSummary: null } : empty());
    });
    return this.view();
  }
  async setProviderConsent(consent) {
    if (typeof consent !== 'boolean') throw new Error('Choose whether to allow provider summaries.');
    this.cancel();
    await this.#serial(async () => {
      const state = await this.#read();
      if (consent && !state.enabled) throw new Error('Enable local context first.');
      await this.#write({ ...state, providerConsent: consent });
    });
    return this.view();
  }
  async clear() {
    this.cancel();
    await this.#serial(async () => { const state = await this.#read(); await this.#write({ ...state, buckets: [], lastSummary: null, providerConsent: false }); });
    return this.view();
  }
  async observe(tab, { isPermitted = () => false } = {}) {
    const site = observedSite(tab), epoch = this.#epoch;
    if (!site) return false;
    return this.#serial(async () => {
      const state = await this.#read();
      if (!state.enabled || !state.sites.includes(site) || epoch !== this.#epoch || await isPermitted(tab) !== true) return false;
      const now = this.now(), day = dayNumber(now), slot = Math.floor(now / SLOT);
      const bucket = state.buckets.find(row => row.site === site && row.day === day);
      if (bucket?.lastSlot >= slot || bucket?.observations >= 48) return false;
      if (epoch !== this.#epoch || await isPermitted(tab) !== true || epoch !== this.#epoch) return false;
      if (bucket) { bucket.observations++; bucket.lastSlot = slot; }
      else state.buckets.push({ site, day, observations: 1, lastSlot: slot });
      await this.#write(state);
      return epoch === this.#epoch;
    });
  }
  view() {
    return this.#serial(async () => {
      const state = await this.#read(), rows = habits(state);
      return { enabled: state.enabled, providerConsent: state.providerConsent, sites: [...state.sites], retentionDays: RETENTION_DAYS, habits: rows,
        suggestions: rows.filter(row => row.observations >= 3).slice(0, 3).map(row => `Possible preference: you may find a shortcut to ${row.site} useful. Based on ${row.observations} activity samples across ${row.days} day(s); this is an inference, not a saved preference.`) };
    });
  }
  async summaryPreview() {
    const state = await this.view();
    return { version: 1, retentionDays: RETENTION_DAYS, sites: state.habits };
  }
  async summarize(send, { signal } = {}) {
    const epoch = this.#epoch, controller = new AbortController();
    let onStopped;
    const abort = () => controller.abort();
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    this.#requests.add(controller);
    const check = () => { if (controller.signal.aborted || epoch !== this.#epoch) throw new Error('Context summary cancelled.'); };
    try {
      const request = await this.#serial(async () => {
        check();
        const state = await this.#read();
        check();
        if (!state.enabled || !state.providerConsent) throw new Error('Enable local context and separately consent to provider summaries first.');
        const rows = habits(state);
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(rows)));
        const fingerprint = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
        check();
        if (rows.reduce((sum, row) => sum + row.observations, 0) < 3) throw new Error('Collect at least 3 activity samples before requesting a summary.');
        if (state.lastSummary && this.now() - state.lastSummary.at < HOUR) throw new Error('Wait an hour before requesting another summary.');
        if (state.lastSummary?.fingerprint === fingerprint) throw new Error('No activity has changed since the last summary request.');
        await this.#write({ ...state, lastSummary: { at: this.now(), fingerprint } });
        check();
        return { type: 'context-summary', consent: true, model: 'gpt-6-luna', payload: { version: 1, retentionDays: RETENTION_DAYS, sites: rows } };
      });
      check();
      const stopped = new Promise((_, reject) => {
        onStopped = () => reject(new Error('Context summary cancelled.'));
        controller.signal.addEventListener('abort', onStopped, { once: true });
      });
      const result = await Promise.race([send(request, { signal: controller.signal }), stopped]);
      check();
      return result;
    } finally {
      signal?.removeEventListener('abort', abort);
      if (onStopped) controller.signal.removeEventListener('abort', onStopped);
      this.#requests.delete(controller);
    }
  }
}
