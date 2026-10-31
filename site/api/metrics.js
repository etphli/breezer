import { aggregateUsage, isDashboardHost } from '../lib/metrics.js';
import { usageReports } from '../lib/storage.js';

export async function releaseDownloads(fetcher = fetch) {
  const releases = [];
  for (let page = 1; ; page++) {
    const result = await fetcher(`https://api.github.com/repos/etphli/breezer/releases?per_page=100&page=${page}`, {
      headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'Breezer-dashboard' }, signal: AbortSignal.timeout(15_000),
    });
    if (!result.ok) throw new Error('GitHub download counts unavailable');
    const batch = await result.json();
    releases.push(...batch.filter(release => !release.draft));
    if (batch.length < 100) break;
    if (page >= 20) throw new Error('Release history exceeds dashboard limit');
  }
  return releases.map(release => ({ version: release.tag_name, downloads: release.assets.filter(asset => /\.dmg$/i.test(asset.name)).reduce((sum, asset) => sum + asset.download_count, 0) }));
}

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!isDashboardHost(request)) return response.status(404).end();
  if (request.method !== 'GET') return response.status(405).end();
  try {
    const [reports, releases] = await Promise.all([usageReports(), releaseDownloads()]);
    response.status(200).json({ ...aggregateUsage(reports), downloads: releases.reduce((sum, release) => sum + release.downloads, 0), releases, updatedAt: new Date().toISOString() });
  } catch { response.status(503).json({ error: 'Metrics could not be loaded. Try refreshing shortly.' }); }
}
