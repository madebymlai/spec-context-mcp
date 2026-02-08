import {
  resolveDashboardUrl,
  type DashboardSessionReader,
  type ResolveDashboardUrlOptions,
} from './dashboard-url.js';

type ResolveDashboardUrlForNode = (
  options?: Omit<ResolveDashboardUrlOptions, 'sessionReader'>
) => Promise<string>;

export function createResolveDashboardUrlForNode(sessionReader: DashboardSessionReader): ResolveDashboardUrlForNode {
  return async (options: Omit<ResolveDashboardUrlOptions, 'sessionReader'> = {}): Promise<string> => {
    return resolveDashboardUrl({
      ...options,
      sessionReader,
    });
  };
}
