export const USAGE_ENABLED = 'breezer.usage.enabled';
export const USAGE_STATE = 'breezer.usage.month';
export const USAGE_ALARM = 'breezer-usage';
const ENDPOINT = 'https://breezer-browser.vercel.app/api/usage';

export function advanceUsage(previous, now, active, uuid = () => crypto.randomUUID()) {
  const day = new Date(now).toISOString().slice(0, 10);
  const month = day.slice(0, 7);
  const state = previous?.month === month ? structuredClone(previous)
    : { month, id: uuid(), days: {}, sampledAt: now, active: false, sentAt: 0 };
  const elapsed = (now - state.sampledAt) / 1000;
  if (active) {
    state.days[day] ??= 0;
    // Never count sleep, suspended workers, background windows, or midnight twice.
    if (state.active && elapsed > 0 && elapsed <= 90) {
      const midnight = Date.parse(`${day}T00:00:00Z`);
      state.days[day] += Math.floor(Math.min(elapsed, (now - midnight) / 1000));
    }
  }
  state.active = active;
  state.sampledAt = now;
  return state;
}

export function installUsage(api, { now = Date.now, send = fetch } = {}) {
  if (!api.alarms || !api.idle || !api.storage?.local) return;
  let queue = Promise.resolve(), request;
  const enqueue = task => { queue = queue.then(task).catch(() => {}); return queue; };
  const enabled = async () => (await api.storage.local.get(USAGE_ENABLED))[USAGE_ENABLED] !== false;
  const sample = async () => {
    if (!await enabled()) return;
    const [windows, idle, stored] = await Promise.all([
      api.windows.getAll({ windowTypes: ['normal'], populate: false }),
      api.idle.queryState(60), api.storage.local.get(USAGE_STATE),
    ]);
    const active = idle === 'active' && windows.some(window => window.focused && !window.incognito);
    const state = advanceUsage(stored[USAGE_STATE], now(), active);
    if (!await enabled()) return;
    await api.storage.local.set({ [USAGE_STATE]: state });
    if (!active || !Object.keys(state.days).length || (state.sentAt && now() - state.sentAt < 30 * 60_000)) return;
    request = new AbortController();
    const timer = setTimeout(() => request?.abort(), 10_000);
    try {
      if (!await enabled()) return;
      const response = await send(ENDPOINT, {
        method: 'POST', credentials: 'omit', cache: 'no-store', referrerPolicy: 'no-referrer',
        headers: { 'Content-Type': 'application/json' }, signal: request.signal,
        body: JSON.stringify({ month: state.month, id: state.id, days: state.days }),
      });
      if (response.ok && await enabled()) {
        state.sentAt = now();
        await api.storage.local.set({ [USAGE_STATE]: state });
      }
    } finally { clearTimeout(timer); request = null; }
  };
  const configure = async () => {
    if (await enabled()) {
      await api.alarms.create(USAGE_ALARM, { periodInMinutes: 1 });
      await sample();
    } else {
      await api.alarms.clear(USAGE_ALARM);
      await api.storage.local.remove(USAGE_STATE);
    }
  };
  api.alarms.onAlarm.addListener(alarm => { if (alarm.name === USAGE_ALARM) void enqueue(sample); });
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes[USAGE_ENABLED]) return;
    if (changes[USAGE_ENABLED].newValue === false) request?.abort();
    void enqueue(configure);
  });
  void enqueue(configure);
  return { settled: () => queue };
}
