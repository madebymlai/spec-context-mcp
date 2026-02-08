import { DashboardSessionManager } from './dashboard-session.js';
import { createResolveDashboardUrlForNode } from './node-dashboard-url.js';

const dashboardSessionReader = new DashboardSessionManager();

export const resolveDashboardUrlForNode = createResolveDashboardUrlForNode(dashboardSessionReader);
