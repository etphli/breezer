// The dashboard toggle for builds without the native Organato helper.
export const DASHBOARD_ENABLED_KEY = 'breezer.dashboard.enabled';

export async function readDashboardPreference(api) {
  const saved = await api.storage.local.get(DASHBOARD_ENABLED_KEY);
  return saved?.[DASHBOARD_ENABLED_KEY] !== false;
}
