import { get, put, list, del, BlobPreconditionFailedError } from '@vercel/blob';
import { mergeDays } from './metrics.js';

export async function readReport(path) {
  const result = await get(path, { access: 'private', useCache: false });
  if (!result) return null;
  return { value: await new Response(result.stream).json(), etag: result.blob.etag };
}

export async function storeReport(report) {
  const path = `usage/${report.month}/${report.id}.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const prior = await readReport(path);
    const days = mergeDays(prior?.value.days, report.days);
    if (prior && JSON.stringify(days) === JSON.stringify(prior.value.days)) return;
    if (prior && Date.now() - Date.parse(prior.value.updatedAt) < 60_000) {
      const error = new Error('Report too frequent'); error.status = 429; throw error;
    }
    try {
      await put(path, JSON.stringify({ ...report, days, updatedAt: new Date().toISOString() }), {
        access: 'private', addRandomSuffix: false, contentType: 'application/json',
        ...(prior ? { ifMatch: prior.etag } : { allowOverwrite: false }),
      });
      return;
    } catch (error) {
      if (!(error instanceof BlobPreconditionFailedError) && !/already exists/i.test(error.message)) throw error;
    }
  }
  const error = new Error('Concurrent update; retry later'); error.status = 409; throw error;
}

export async function allBlobs(prefix, maxBlobs = 20_000) {
  const blobs = [];
  let cursor;
  do {
    const limit = Math.min(1000, maxBlobs - blobs.length);
    const page = await list({ prefix, cursor, limit });
    blobs.push(...page.blobs.slice(0, limit));
    if (blobs.length === maxBlobs) return { blobs, truncated: page.hasMore || page.blobs.length > limit };
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  return { blobs, truncated: false };
}

// Leave headroom under the 60-second function limit for listing and the GitHub request.
export async function usageReports(now = new Date(), readBudgetMs = 40_000) {
  const started = performance.now();
  // List every UTC month from the 30-day window start through now; a short February can sit between them.
  const months = [];
  const start = new Date(now.getTime() - 29 * 86400_000);
  for (let year = start.getUTCFullYear(), month = start.getUTCMonth();
    year * 12 + month <= now.getUTCFullYear() * 12 + now.getUTCMonth(); month++) {
    months.push(new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 7));
  }
  const listings = await Promise.all(months.map(month => allBlobs(`usage/${month}/`)));
  const blobs = listings.flatMap(listing => listing.blobs);
  const reports = [];
  let truncated = listings.some(listing => listing.truncated);
  for (let i = 0; i < blobs.length; i += 12) {
    if (performance.now() - started > readBudgetMs) { truncated = true; break; }
    const batch = await Promise.all(blobs.slice(i, i + 12).map(blob => readReport(blob.pathname)));
    reports.push(...batch.filter(Boolean).map(report => report.value));
  }
  return { reports, truncated };
}

export async function pruneReports(now = new Date()) {
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  // Retention must see every report so cleanup still works when volume exceeds the dashboard cap.
  const { blobs } = await allBlobs('usage/', Infinity);
  const expired = blobs.filter(blob => blob.pathname.split('/')[1] < oldest);
  for (let i = 0; i < expired.length; i += 100) await del(expired.slice(i, i + 100).map(blob => blob.url));
  return expired.length;
}
