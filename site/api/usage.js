import { validateUsage } from '../lib/metrics.js';
import { storeReport } from '../lib/storage.js';

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).end();
  if (!request.headers['content-type']?.startsWith('application/json')) return response.status(415).end();
  if (Number(request.headers['content-length']) > 4096) return response.status(413).end();
  let report;
  try {
    const body = typeof request.body === 'string' ? JSON.parse(request.body) : request.body;
    if (JSON.stringify(body).length > 4096) return response.status(413).end();
    report = validateUsage(body);
  } catch { return response.status(400).json({ error: 'Invalid usage report' }); }
  try { await storeReport(report); return response.status(204).end(); }
  catch (error) { return response.status(error.status || 503).json({ error: 'Report not accepted; retry later' }); }
}
