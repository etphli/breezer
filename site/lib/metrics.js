export const DASHBOARD_HOST = 'breezer-ethans-project.vercel.app';
export const PUBLIC_HOST = 'breezer-browser.vercel.app';

export function isDashboardHost(request) {
  // Vercel enforces Authentication on this team alias before invoking functions.
  // Do not trust x-forwarded-host or accept other aliases as authenticated.
  return request.headers.host === DASHBOARD_HOST;
}

export function validateUsage(input, now = new Date()) {
  if (!input || Object.keys(input).sort().join(',') !== 'days,id,month') throw new Error('Invalid report');
  if (typeof input.id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(input.id)) throw new Error('Invalid identifier');
  const current = now.toISOString().slice(0, 7);
  const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  if (![current, previous].includes(input.month)) throw new Error('Report outside retention window');
  if (!input.days || Array.isArray(input.days) || typeof input.days !== 'object') throw new Error('Invalid days');
  const entries = Object.entries(input.days);
  if (!entries.length || entries.length > 31) throw new Error('Invalid day count');
  for (const [day, seconds] of entries) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !day.startsWith(input.month + '-')
      || !Number.isFinite(Date.parse(day)) || new Date(day).toISOString().slice(0, 10) !== day
      || day > now.toISOString().slice(0, 10) || !Number.isSafeInteger(seconds) || seconds < 0 || seconds > 86400) throw new Error('Invalid day');
  }
  return { month: input.month, id: input.id, days: Object.fromEntries(entries) };
}

export function mergeDays(previous = {}, incoming) {
  const days = { ...previous };
  for (const [day, seconds] of Object.entries(incoming)) days[day] = Math.max(days[day] ?? 0, seconds);
  return days;
}

export function aggregateUsage(reports, now = new Date()) {
  const end = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 29)).toISOString().slice(0, 10);
  const series = [];
  for (let t = Date.parse(start); t <= Date.parse(end); t += 86400_000) series.push({ day: new Date(t).toISOString().slice(0, 10), users: 0, seconds: 0 });
  const byDay = new Map(series.map(row => [row.day, row]));
  const monthly = new Set();
  for (const report of reports) {
    for (const [day, seconds] of Object.entries(report.days)) {
      if (day.startsWith(end.slice(0, 7)) && day <= end) monthly.add(report.id);
      const row = byDay.get(day);
      if (!row) continue;
      row.users++;
      row.seconds += seconds;
      // A monthly rotating identifier cannot deduplicate people across months.
    }
  }
  return { start, end, mau: monthly.size, month: end.slice(0, 7), seconds: series.reduce((sum, row) => sum + row.seconds, 0), series };
}
