import { findDashboardProjectByPath, type DashboardProject } from './dashboard-project-resolver.js';

type DashboardResponse = {
  ok: boolean;
  json(): Promise<unknown>;
};

export type DashboardFetch = (
  url: string,
  init?: RequestInit
) => Promise<DashboardResponse>;

export type DashboardProjectResolution =
  | { kind: 'resolved'; projectId: string }
  | { kind: 'dashboard-unavailable' }
  | { kind: 'project-unregistered' };

function isDashboardRequestUnavailable(error: unknown): boolean {
  if (error instanceof DOMException && error.name === 'AbortError') {
    return true;
  }
  return error instanceof TypeError;
}

function parseDashboardProjectId(payload: unknown): string | null {
  if (typeof payload !== 'object' || payload === null || !('projectId' in payload)) {
    return null;
  }
  const maybeProjectId = (payload as { projectId?: unknown }).projectId;
  return typeof maybeProjectId === 'string' && maybeProjectId.length > 0 ? maybeProjectId : null;
}

async function listDashboardProjects(
  dashboardUrl: string,
  fetchDashboard: DashboardFetch,
  timeoutMs: number = 750
): Promise<DashboardProject[] | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const projectsResponse = await fetchDashboard(`${dashboardUrl}/api/projects/list`, { signal: controller.signal });
    if (!projectsResponse.ok) {
      return null;
    }

    const payload = await projectsResponse.json();
    if (!Array.isArray(payload)) {
      return null;
    }

    return payload as DashboardProject[];
  } catch (error) {
    if (isDashboardRequestUnavailable(error)) {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function registerProjectWithDashboard(
  dashboardUrl: string,
  projectPath: string,
  fetchDashboard: DashboardFetch,
  timeoutMs: number = 1200
): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchDashboard(`${dashboardUrl}/api/projects/add`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ projectPath }),
      signal: controller.signal,
    });
    if (!response.ok) {
      return null;
    }
    const payload = await response.json();
    return parseDashboardProjectId(payload);
  } catch (error) {
    if (isDashboardRequestUnavailable(error)) {
      return null;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function resolveDashboardProject(
  dashboardUrl: string | undefined,
  validatedProjectPath: string,
  translatedProjectPath: string,
  fetchDashboard: DashboardFetch
): Promise<DashboardProjectResolution> {
  if (!dashboardUrl) {
    return { kind: 'dashboard-unavailable' };
  }

  const projects = await listDashboardProjects(dashboardUrl, fetchDashboard);
  if (!projects) {
    return { kind: 'dashboard-unavailable' };
  }

  const existingProject = findDashboardProjectByPath(projects, validatedProjectPath, translatedProjectPath);
  if (existingProject) {
    return { kind: 'resolved', projectId: existingProject.projectId };
  }

  const registrationPaths = [validatedProjectPath];
  if (translatedProjectPath !== validatedProjectPath) {
    registrationPaths.push(translatedProjectPath);
  }

  for (const projectPath of registrationPaths) {
    const projectId = await registerProjectWithDashboard(dashboardUrl, projectPath, fetchDashboard);
    if (projectId) {
      return { kind: 'resolved', projectId };
    }
  }

  const refreshedProjects = await listDashboardProjects(dashboardUrl, fetchDashboard);
  if (!refreshedProjects) {
    return { kind: 'dashboard-unavailable' };
  }

  const refreshedProject = findDashboardProjectByPath(refreshedProjects, validatedProjectPath, translatedProjectPath);
  if (!refreshedProject) {
    return { kind: 'project-unregistered' };
  }
  return { kind: 'resolved', projectId: refreshedProject.projectId };
}

export async function resolveDashboardProjectId(
  dashboardUrl: string | undefined,
  validatedProjectPath: string,
  translatedProjectPath: string,
  fetchDashboard: DashboardFetch
): Promise<string | null> {
  const resolution = await resolveDashboardProject(
    dashboardUrl,
    validatedProjectPath,
    translatedProjectPath,
    fetchDashboard
  );
  if (resolution.kind !== 'resolved') {
    return null;
  }
  return resolution.projectId;
}
