import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { MultiProjectDashboardServer } from './multi-server.js';
import { SPEC_WORKFLOW_HOME_ENV } from '../core/workflow/global-dir.js';
import { readTaskTransitionEvents } from './analytics-task-events.js';

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

function isoDaysAgo(daysAgo: number, hourUtc: number = 12): string {
  const date = new Date();
  date.setUTCHours(hourUtc, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return date.toISOString();
}

async function createTempProjectWithAnalyticsData(): Promise<string> {
  const projectPath = await fs.mkdtemp(join(tmpdir(), 'analytics-advanced-project-'));

  const specDir = join(projectPath, '.spec-context', 'specs', 'history-spec');
  await fs.mkdir(specDir, { recursive: true });
  await fs.writeFile(
    join(specDir, 'tasks.md'),
    `# Tasks\n\n- [ ] 1. First task\n- [ ] 2. Second task\n`,
    'utf8'
  );

  const approvalsDir = join(projectPath, '.spec-context', 'approvals', 'history-spec');
  await fs.mkdir(approvalsDir, { recursive: true });
  await fs.writeFile(
    join(approvalsDir, 'approval-1.json'),
    JSON.stringify(
      {
        id: 'approval-1',
        title: 'Review Tasks',
        filePath: '.spec-context/specs/history-spec/tasks.md',
        type: 'document',
        status: 'approved',
        createdAt: isoDaysAgo(2, 9),
        respondedAt: isoDaysAgo(1, 9),
        category: 'spec',
        categoryName: 'history-spec',
      },
      null,
      2
    ),
    'utf8'
  );
  await fs.writeFile(
    join(approvalsDir, 'approval-2.json'),
    JSON.stringify(
      {
        id: 'approval-2',
        title: 'Review Follow-up',
        filePath: '.spec-context/specs/history-spec/tasks.md',
        type: 'document',
        status: 'rejected',
        createdAt: isoDaysAgo(1, 9),
        respondedAt: isoDaysAgo(0, 9),
        category: 'spec',
        categoryName: 'history-spec',
      },
      null,
      2
    ),
    'utf8'
  );

  const analyticsDir = join(projectPath, '.spec-context', 'analytics');
  await fs.mkdir(analyticsDir, { recursive: true });
  await fs.writeFile(
    join(analyticsDir, 'task-events.jsonl'),
    [
      {
        timestamp: isoDaysAgo(2, 10),
        specName: 'history-spec',
        taskId: '1',
        previousStatus: 'pending',
        nextStatus: 'in-progress',
        summaryAfter: { total: 2, completed: 0, pending: 1 },
      },
      {
        timestamp: isoDaysAgo(1, 10),
        specName: 'history-spec',
        taskId: '1',
        previousStatus: 'in-progress',
        nextStatus: 'completed',
        summaryAfter: { total: 2, completed: 1, pending: 1 },
      },
      {
        timestamp: isoDaysAgo(0, 10),
        specName: 'history-spec',
        taskId: '2',
        previousStatus: 'pending',
        nextStatus: 'completed',
        summaryAfter: { total: 2, completed: 2, pending: 0 },
      },
    ]
      .map((event) => JSON.stringify(event))
      .join('\n'),
    'utf8'
  );

  return projectPath;
}

describe('MultiProjectDashboardServer advanced analytics routes', () => {
  const originalEnv = process.env;
  let workflowHomeDir: string;
  const activeApps: FastifyInstance[] = [];
  const tempProjectDirs: string[] = [];

  beforeEach(async () => {
    process.env = { ...originalEnv };
    workflowHomeDir = join(tmpdir(), `spec-context-analytics-advanced-${Date.now()}-${Math.random()}`);
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

  it('returns expected response shapes for advanced analytics endpoints', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const projectPath = await createTempProjectWithAnalyticsData();
    tempProjectDirs.push(projectPath);

    const register = await app.inject({
      method: 'POST',
      url: '/api/projects/add',
      payload: { projectPath },
    });
    expect(register.statusCode).toBe(200);
    const projectId = register.json<{ projectId: string }>().projectId;

    const taskVelocity = await app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/analytics/task-velocity?days=14`,
    });
    expect(taskVelocity.statusCode).toBe(200);
    expect(taskVelocity.json()).toEqual(
      expect.objectContaining({
        windowDays: 14,
        startDate: expect.any(String),
        endDate: expect.any(String),
        points: expect.any(Array),
        totals: expect.any(Object),
        partialData: expect.any(Boolean),
      })
    );

    const approvalMetrics = await app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/analytics/approval-metrics?days=14`,
    });
    expect(approvalMetrics.statusCode).toBe(200);
    expect(approvalMetrics.json()).toEqual(
      expect.objectContaining({
        windowDays: 14,
        countsByStatus: expect.any(Object),
        resolvedCount: expect.any(Number),
        rejectionRate: expect.any(Number),
        dailyLatency: expect.any(Array),
      })
    );

    const codeMetrics = await app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/analytics/code-metrics?days=14`,
    });
    expect(codeMetrics.statusCode).toBe(200);
    expect(codeMetrics.json()).toEqual(
      expect.objectContaining({
        windowDays: 14,
        source: expect.any(String),
        points: expect.any(Array),
        totals: expect.any(Object),
      })
    );

    const cycleTime = await app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/analytics/cycle-time?days=14`,
    });
    expect(cycleTime.statusCode).toBe(200);
    expect(cycleTime.json()).toEqual(
      expect.objectContaining({
        windowDays: 14,
        taskCycle: expect.any(Object),
        specCycle: expect.any(Object),
      })
    );

    const burndown = await app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/analytics/burndown?days=14`,
    });
    expect(burndown.statusCode).toBe(200);
    expect(burndown.json()).toEqual(
      expect.objectContaining({
        windowDays: 14,
        points: expect.any(Array),
      })
    );
  });

  it('records a task transition event when updating task status', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const projectPath = await createTempProjectWithAnalyticsData();
    tempProjectDirs.push(projectPath);

    const register = await app.inject({
      method: 'POST',
      url: '/api/projects/add',
      payload: { projectPath },
    });
    const projectId = register.json<{ projectId: string }>().projectId;

    const beforeEvents = await readTaskTransitionEvents(projectPath);

    const updateResponse = await app.inject({
      method: 'PUT',
      url: `/api/projects/${encodeURIComponent(projectId)}/specs/history-spec/tasks/1/status`,
      payload: { status: 'in-progress' },
    });
    expect(updateResponse.statusCode).toBe(200);

    const afterEvents = await readTaskTransitionEvents(projectPath);
    expect(afterEvents.length).toBe(beforeEvents.length + 1);

    const newest = afterEvents[afterEvents.length - 1];
    expect(newest.specName).toBe('history-spec');
    expect(newest.taskId).toBe('1');
    expect(newest.nextStatus).toBe('in-progress');
  });

  it('clamps invalid days and returns 404 for unknown project', async () => {
    const { app } = createTestServer();
    activeApps.push(app);

    const projectPath = await createTempProjectWithAnalyticsData();
    tempProjectDirs.push(projectPath);

    const register = await app.inject({
      method: 'POST',
      url: '/api/projects/add',
      payload: { projectPath },
    });
    const projectId = register.json<{ projectId: string }>().projectId;

    const clamped = await app.inject({
      method: 'GET',
      url: `/api/projects/${encodeURIComponent(projectId)}/analytics/task-velocity?days=-99`,
    });
    expect(clamped.statusCode).toBe(200);
    expect(clamped.json<{ windowDays: number }>().windowDays).toBe(1);

    const missing = await app.inject({
      method: 'GET',
      url: '/api/projects/missing/analytics/burndown',
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toEqual({ error: 'Project not found' });
  });
});
