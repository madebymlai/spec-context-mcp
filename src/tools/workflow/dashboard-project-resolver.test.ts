import { describe, expect, it } from 'vitest';
import {
  findDashboardProjectByPath,
  getProjectBaseName,
  type DashboardProject
} from './dashboard-project-resolver.js';

describe('dashboard-project-resolver', () => {
  it('matches by translated and validated path first', () => {
    const projects: DashboardProject[] = [
      { projectId: 'a', projectPath: '/other/path', projectName: 'other' },
      { projectId: 'b', projectPath: '/workspace/app', projectName: 'app' },
    ];

    const resolved = findDashboardProjectByPath(
      projects,
      '/workspace/app',
      '/workspace/app'
    );

    expect(resolved?.projectId).toBe('b');
  });

  it('matches by base name when dashboard path differs by prefix', () => {
    const projects: DashboardProject[] = [
      { projectId: 'p1', projectPath: '/host/mount/my-project', projectName: 'my-project' },
    ];

    const resolved = findDashboardProjectByPath(
      projects,
      '/container/workspaces/my-project',
      '/container/workspaces/my-project'
    );

    expect(resolved?.projectId).toBe('p1');
  });

  it('throws when project path has no basename', () => {
    expect(() => getProjectBaseName('/')).toThrow(/Cannot resolve project base name/);
  });
});
