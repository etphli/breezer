import { dashboardPage } from '../lib/dashboard-page.js';
import { DASHBOARD_HOST, isDashboardHost } from '../lib/metrics.js';

export default function handler(request, response) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Robots-Tag', 'noindex, nofollow');
  if (!isDashboardHost(request)) return response.redirect(303, `https://${DASHBOARD_HOST}/dashboard`);
  if (request.method !== 'GET') return response.status(405).end();
  response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'");
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.status(200).send(dashboardPage);
}
