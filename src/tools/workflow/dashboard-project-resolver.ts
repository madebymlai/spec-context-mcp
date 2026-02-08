export interface DashboardProject {
  projectId: string;
  projectPath?: string;
  projectName: string;
}

function toPathSegments(projectPath: string): string[] {
  return projectPath
    .split(/[/\\]/)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
}

export function getProjectBaseName(projectPath: string): string {
  const segments = toPathSegments(projectPath);
  if (segments.length === 0) {
    throw new Error(`Cannot resolve project base name from path: ${projectPath}`);
  }
  return segments[segments.length - 1];
}

function pathMatchesBaseName(candidatePath: string, projectBaseName: string): boolean {
  const normalized = candidatePath.replace(/\\/g, '/');
  return normalized === projectBaseName || normalized.endsWith(`/${projectBaseName}`);
}

export function findDashboardProjectByPath(
  projects: DashboardProject[],
  validatedProjectPath: string,
  translatedProjectPath: string
): DashboardProject | null {
  const projectBaseName = getProjectBaseName(validatedProjectPath);

  for (const project of projects) {
    if (!project.projectPath) {
      continue;
    }
    if (
      project.projectPath === translatedProjectPath
      || project.projectPath === validatedProjectPath
      || pathMatchesBaseName(project.projectPath, projectBaseName)
    ) {
      return project;
    }
  }

  return null;
}
