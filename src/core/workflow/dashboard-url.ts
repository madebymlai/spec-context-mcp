import { DEFAULT_DASHBOARD_URL } from './constants.js';

export interface DashboardSessionReader {
  getDashboardSession(): Promise<{ url: string } | null>;
}

export interface ResolveDashboardUrlOptions {
  defaultUrl?: string;
  sessionReader?: DashboardSessionReader;
}

export async function resolveDashboardUrl(
  options: ResolveDashboardUrlOptions = {}
): Promise<string> {
  const defaultUrl = options.defaultUrl ?? DEFAULT_DASHBOARD_URL;
  const envUrl = (process.env.DASHBOARD_URL || '').trim();
  const sessionReader = options.sessionReader;

  // Treat a non-default env URL as an explicit override.
  if (envUrl && envUrl !== defaultUrl) {
    return envUrl;
  }

  if (sessionReader) {
    const session = await sessionReader.getDashboardSession();
    if (session?.url) {
      return session.url;
    }
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
  const base = dashboardUrl.replace(/\/+$/, '');
  const params = new URLSearchParams({ id: approvalId });
  if (projectId) {
    params.set('projectId', projectId);
  }
  return `${base}/#/approvals?${params.toString()}`;
}
