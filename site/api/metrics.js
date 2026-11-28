import { aggregateUsage, isDashboardHost } from '../lib/metrics.js';
import { usageReports } from '../lib/storage.js';

// Vercel shares outbound IPs, so unauthenticated GitHub calls hit the 60/hour
// limit. Use a token when configured, bound the whole read well inside the
// function limit and reuse a recent result on this instance.
const GITHUB_BUDGET_MS = 25_000;
const RELEASE_CACHE_MS = 5 * 60_000;
const RELEASE_STALE_MS = 60 * 60_000;

export async function releaseDownloads(fetcher = fetch, { token = process.env.GITHUB_TOKEN, budgetMs = GITHUB_BUDGET_MS } = {}) {
  const deadline = AbortSignal.timeout(budgetMs);
  const headers = { Accept: 'application/vnd.github+json', 'User-Agent': 'Breezer-dashboard', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const releases = [];
  for (let page = 1; ; page++) {
    deadline.throwIfAborted();
    const result = await fetcher(`https://api.github.com/repos/etphli/breezer/releases?per_page=100&page=${page}`, {
      headers, signal: AbortSignal.any([deadline, AbortSignal.timeout(15_000)]),
    });
    if (!result.ok) throw new Error('GitHub download counts unavailable');
    const batch = await result.json();
    releases.push(...batch.filter(release => !release.draft));
    if (batch.length < 100) break;
    if (page >= 20) throw new Error('Release history exceeds dashboard limit');
  }
  return releases.map(release => ({ version: release.tag_name, downloads: release.assets.filter(asset => /\.dmg$/i.test(asset.name) || /^Breezer-Windows-x64(-Setup\.exe|\.zip)$/.test(asset.name)).reduce((sum, asset) => sum + asset.download_count, 0) }));
}

// Concurrent requests share one read. A failed read falls back to a result
// under an hour old instead of failing the whole dashboard.
export function createReleaseCache({ fetcher, now = Date.now, ttlMs = RELEASE_CACHE_MS, staleMs = RELEASE_STALE_MS, ...options } = {}) {
  let saved = null, pending = null;
  return async () => {
    if (saved && now() - saved.at < ttlMs) return saved.value;
    pending ||= releaseDownloads(fetcher, options)
      .then(value => { saved = { at: now(), value }; return value; })
      .catch(error => { if (saved && now() - saved.at < staleMs) return saved.value; throw error; })
      .finally(() => { pending = null; });
    return pending;
  };
}
const cachedReleaseDownloads = createReleaseCache();

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!isDashboardHost(request)) return response.status(404).end();
  if (request.method !== 'GET') return response.status(405).end();
  try {
    const [reports, releases] = await Promise.all([usageReports(), cachedReleaseDownloads()]);
    response.status(200).json({ ...aggregateUsage(reports), downloads: releases.reduce((sum, release) => sum + release.downloads, 0), releases, updatedAt: new Date().toISOString() });
  } catch { response.status(503).json({ error: 'Metrics could not be loaded. Try refreshing shortly.' }); }
}
