import { DashboardSessionManager } from './dashboard-session.js';
import { DEFAULT_DASHBOARD_URL } from './constants.js';

export interface ResolveDashboardUrlOptions {
  defaultUrl?: string;
}

export async function resolveDashboardUrl(
  options: ResolveDashboardUrlOptions = {}
): Promise<string> {
  const defaultUrl = options.defaultUrl || DEFAULT_DASHBOARD_URL;
  const envUrl = (process.env.DASHBOARD_URL || '').trim();

  // Treat a non-default env URL as an explicit override.
  if (envUrl && envUrl !== defaultUrl) {
    return envUrl;
  }

  try {
    const session = await new DashboardSessionManager().getDashboardSession();
    if (session?.url) {
      return session.url;
    }
  } catch {
    // Ignore session lookup errors and fall back.
  }

  if (envUrl) {
    return envUrl;
  }

  return defaultUrl;
}

/**
 * Build a deep link into the dashboard SPA (HashRouter).
 * Example: http://localhost:5000/#/approvals?id=abc&projectId=xyz
 */
export function buildApprovalDeeplink(dashboardUrl: string, approvalId: string, projectId?: string): string {
  const base = (dashboardUrl || '').replace(/\/+$/, '');
  const params = new URLSearchParams({ id: approvalId });
  if (projectId) {
    params.set('projectId', projectId);
  }
  return `${base}/#/approvals?${params.toString()}`;
}
