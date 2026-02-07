import { DashboardSessionManager } from './dashboard-session.js';
import { resolveDashboardUrl, type ResolveDashboardUrlOptions } from './dashboard-url.js';

const dashboardSessionReader = new DashboardSessionManager();

export async function resolveDashboardUrlForNode(
  options: Omit<ResolveDashboardUrlOptions, 'sessionReader'> = {}
): Promise<string> {
  return resolveDashboardUrl({
    ...options,
    sessionReader: dashboardSessionReader,
  });
}
