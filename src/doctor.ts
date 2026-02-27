import { resolveDashboardUrlForNode } from './core/workflow/node-dashboard-url-default.js';
import { DEFAULT_DASHBOARD_URL } from './core/workflow/constants.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  details: string;
  hint?: string;
}

function formatStatus(status: 'ok' | 'warn' | 'fail'): string {
  switch (status) {
    case 'ok':
      return 'OK';
    case 'warn':
      return 'WARN';
    case 'fail':
      return 'FAIL';
  }
}

export async function runDoctor(): Promise<number> {
  const results: CheckResult[] = [];

  if (!process.env.OPENROUTER_API_KEY) {
    results.push({
      name: 'Dashboard AI Review',
      status: 'warn',
      details: 'OPENROUTER_API_KEY not set (AI review disabled).',
    });
  } else {
    results.push({
      name: 'Dashboard AI Review',
      status: 'ok',
      details: 'OPENROUTER_API_KEY is set.',
    });
  }

  const dashboardUrl = await resolveDashboardUrlForNode({ defaultUrl: DEFAULT_DASHBOARD_URL });
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    const response = await fetch(`${dashboardUrl}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      results.push({
        name: 'Dashboard',
        status: 'ok',
        details: `Dashboard reachable at ${dashboardUrl}.`,
      });
    } else {
      results.push({
        name: 'Dashboard',
        status: 'warn',
        details: `Dashboard responded with ${response.status} at ${dashboardUrl}.`,
        hint: 'Start with spec-context-dashboard if needed.',
      });
    }
  } catch (error) {
    const isDefault = dashboardUrl === DEFAULT_DASHBOARD_URL;
    results.push({
      name: 'Dashboard',
      status: isDefault ? 'warn' : 'fail',
      details: `Dashboard not reachable at ${dashboardUrl}: ${String(error)}`,
      hint: 'Start with spec-context-dashboard or update DASHBOARD_URL.',
    });
  }

  const failures = results.filter((r) => r.status === 'fail');
  const warnings = results.filter((r) => r.status === 'warn');

  console.error('Spec Context Doctor');
  console.error('--------------------');
  for (const result of results) {
    const line = `[${formatStatus(result.status)}] ${result.name}: ${result.details}`;
    console.error(line);
    if (result.hint) {
      console.error(`       Hint: ${result.hint}`);
    }
  }

  console.error('');
  if (failures.length > 0) {
    console.error(`Status: FAIL (${failures.length} failure${failures.length > 1 ? 's' : ''}, ${warnings.length} warning${warnings.length !== 1 ? 's' : ''})`);
    return 1;
  }

  if (warnings.length > 0) {
    console.error(`Status: WARN (${warnings.length} warning${warnings.length > 1 ? 's' : ''})`);
    return 0;
  }

  console.error('Status: OK');
  return 0;
}
