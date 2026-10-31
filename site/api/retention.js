import { timingSafeEqual } from 'node:crypto';
import { pruneReports } from '../lib/storage.js';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  const expected = `Bearer ${process.env.CRON_SECRET || ''}`;
  const actual = request.headers.authorization || '';
  const expectedBytes = Buffer.from(expected), actualBytes = Buffer.from(actual);
  if (!process.env.CRON_SECRET || actualBytes.length !== expectedBytes.length || !timingSafeEqual(actualBytes, expectedBytes)) return response.status(401).end();
  if (request.method !== 'GET') return response.status(405).end();
  try { response.status(200).json({ deleted: await pruneReports() }); }
  catch { response.status(503).json({ error: 'Retention cleanup failed' }); }
}
