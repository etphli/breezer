import { validateUsage } from '../lib/metrics.js';
import { storeReport } from '../lib/storage.js';

const maxReportBytes = 4096;

export default async function handler(request, response) {
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'POST') return response.status(405).end();
  if (!request.headers['content-type']?.startsWith('application/json')) return response.status(415).end();
  if (Number(request.headers['content-length']) > maxReportBytes) return response.status(413).end();
  let report;
  try {
    const rawBody = typeof request.body === 'string';
    const json = rawBody ? request.body : JSON.stringify(request.body);
    if (json && (json.length > maxReportBytes || Buffer.byteLength(json) > maxReportBytes)) return response.status(413).end();
    const body = rawBody ? JSON.parse(json) : request.body;
    report = validateUsage(body);
  } catch { return response.status(400).json({ error: 'Invalid usage report' }); }
  try { await storeReport(report); return response.status(204).end(); }
  catch (error) { return response.status(error.status || 503).json({ error: 'Report not accepted; retry later' }); }
}
