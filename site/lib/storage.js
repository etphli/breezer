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

export async function allBlobs(prefix) {
  const blobs = [];
  let cursor;
  do {
    const page = await list({ prefix, cursor, limit: 1000 });
    blobs.push(...page.blobs);
    cursor = page.hasMore ? page.cursor : undefined;
    if (blobs.length > 20_000) throw new Error('Report volume exceeds dashboard limit');
  } while (cursor);
  return blobs;
}

export async function usageReports(now = new Date()) {
  const months = new Set([now.toISOString().slice(0, 7), new Date(now.getTime() - 29 * 86400_000).toISOString().slice(0, 7)]);
  const blobs = (await Promise.all([...months].map(month => allBlobs(`usage/${month}/`)))).flat();
  const reports = [];
  for (let i = 0; i < blobs.length; i += 12) {
    const batch = await Promise.all(blobs.slice(i, i + 12).map(blob => readReport(blob.pathname)));
    reports.push(...batch.filter(Boolean).map(report => report.value));
  }
  return reports;
}

export async function pruneReports(now = new Date()) {
  const oldest = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)).toISOString().slice(0, 7);
  const expired = (await allBlobs('usage/')).filter(blob => blob.pathname.split('/')[1] < oldest);
  for (let i = 0; i < expired.length; i += 100) await del(expired.slice(i, i + 100).map(blob => blob.url));
  return expired.length;
}
