import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MultiProjectDashboardServer } from './multi-server.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';

interface TestServerContext {
  app: FastifyInstance;
}

function createTestServer(): TestServerContext {
  const server = new MultiProjectDashboardServer();
  const instance = server as unknown as {
    app: FastifyInstance;
    registerApiRoutes: () => void;
  };
  instance.registerApiRoutes();
  return { app: instance.app };
}

async function createTempProjectWithSpec(): Promise<string> {
  const projectPath = await fs.mkdtemp(join(tmpdir(), 'analytics-history-project-'));
  const specDir = join(projectPath, '.spec-context', 'specs', 'history-spec');
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    join(specDir, 'tasks.md'),
    `# Tasks

- [x] 1. Historical trend fixture
  - _Requirements: 1_
  - _Prompt: Build fixture for analytics history endpoint_`,
    'utf8'
  );
  return projectPath;
}

describe('MultiProjectDashboardServer analytics history route', () => {
  const originalEnv = process.env;
  let workflowHomeDir: string;
  const activeApps: FastifyInstance[] = [];
  const tempProjectDirs: string[] = [];

  beforeEach(async () => {
    process.env = { ...originalEnv };
    workflowHomeDir = join(tmpdir(), `spec-context-analytics-history-${Date.now()}-${Math.random()}`);
    process.env[SPEC_WORKFLOW_HOME_ENV] = workflowHomeDir;
    await fs.mkdir(workflowHomeDir, { recursive: true });
  });

  afterEach(async () => {
    while (activeApps.length > 0) {
      const app = activeApps.pop();
      if (app) {
        await app.close();
      }
    }
    await Promise.all(tempProjectDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
    process.env = originalEnv;
    await fs.rm(workflowHomeDir, { recursive: true, force: true });
  });

  it('returns historical analytics points for a registered project', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const projectPath = await createTempProjectWithSpec();
    tempProjectDirs.push(projectPath);

    const register = await app.inject({
      method: 'POST',
      url: '/api/projects/add',
      payload: { projectPath },
    });
    expect(register.statusCode).toBe(200);
    const projectId = register.json<{ projectId: string }>().projectId;

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/analytics/history?days=14`,
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json<{
      windowDays: number;
      points: Array<{
        date: string;
        specsCreated: number;
        specsModified: number;
        approvalsCreated: number;
        approvalsResolved: number;
      }>;
      totals: Record<string, number>;
    }>();

    expect(payload.windowDays).toBe(14);
    expect(payload.points).toHaveLength(14);
    expect(payload.points[0]).toEqual(
      expect.objectContaining({
        date: expect.any(String),
        specsCreated: expect.any(Number),
        specsModified: expect.any(Number),
        approvalsCreated: expect.any(Number),
        approvalsResolved: expect.any(Number),
      })
    );
    expect(payload.totals).toEqual(
      expect.objectContaining({
        specsCreated: expect.any(Number),
        specsModified: expect.any(Number),
        approvalsCreated: expect.any(Number),
        approvalsResolved: expect.any(Number),
      })
    );
  });

  it('clamps invalid window query values', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const projectPath = await createTempProjectWithSpec();
    tempProjectDirs.push(projectPath);

    const register = await app.inject({
      method: 'POST',
      url: '/api/projects/add',
      payload: { projectPath },
    });
    const projectId = register.json<{ projectId: string }>().projectId;

    const response = await app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/analytics/history?days=-10`,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ windowDays: number }>().windowDays).toBe(1);
  });

  it('returns 404 for unknown project', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/projects/missing/analytics/history',
    });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toEqual({ error: 'Project not found' });
  });
});
