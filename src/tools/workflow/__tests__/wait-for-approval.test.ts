import { describe, it, expect, vi } from 'vitest';
import {
  createWaitForApprovalHandler,
  type WaitForApprovalDependencies
} from '../wait-for-approval.js';

type FetchResponse = {
  ok: boolean;
  statusText: string;
  json: () => Promise<unknown>;
};

function createResponse(data: unknown, ok = true, statusText = 'OK'): FetchResponse {
  return {
    ok,
    statusText,
    json: async () => data,
  };
}

function createDependencies(fetchJson: WaitForApprovalDependencies['fetchJson']): WaitForApprovalDependencies {
  return {
    validateProjectPath: async (projectPath: string) => projectPath,
    translateProjectPath: (projectPath: string) => projectPath,
    resolveDashboardUrl: async () => 'http://localhost:3000',
    fetchJson,
    createAbortController: () => new AbortController(),
    createTimeout: (callback: () => void, timeoutMs: number) => setTimeout(callback, timeoutMs),
    clearTimeout: (timeout: ReturnType<typeof setTimeout>) => clearTimeout(timeout),
    buildApprovalDeeplink: (dashboardUrl: string, approvalId: string, projectId?: string) => {
      const base = dashboardUrl.replace(/\/+$/, '');
      const params = new URLSearchParams({ id: approvalId });
      if (projectId) {
        params.set('projectId', projectId);
      }
      return `${base}/#/approvals?${params.toString()}`;
    },
  };
}

describe('waitForApprovalHandler', () => {
  it('returns an error when approvalId is missing', async () => {
    const handler = createWaitForApprovalHandler(createDependencies(async () => createResponse([])));

    const result = await handler(
      { approvalId: '' },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/approvalId is required/i);
  });

  it('returns an error when dashboard is unavailable', async () => {
    const fetchJson = vi.fn(async () => createResponse({ error: 'nope' }, false, 'Bad'));
    const handler = createWaitForApprovalHandler(createDependencies(fetchJson));

    const result = await handler(
      { approvalId: 'abc', projectPath: '/tmp/project' },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Dashboard not available/i);
    expect(fetchJson).toHaveBeenCalledWith(
      'http://localhost:3000/api/projects/list',
      expect.any(Object)
    );
  });

  it('returns timeout result when wait endpoint reports timeout', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects/list')) {
        return createResponse([{ projectId: 'p1', projectPath: '/tmp/project', projectName: 'Test' }]);
      }
      return createResponse({ timeout: true, status: 'pending' });
    });
    const handler = createWaitForApprovalHandler(createDependencies(fetchJson));

    const result = await handler(
      { approvalId: 'abc', projectPath: '/tmp/project', timeoutMs: 1000 },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Timeout waiting for approval/i);
    expect(result.data?.timeout).toBe(true);
  });

  it('returns approved result when dashboard resolves approval', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects/list')) {
        return createResponse([{ projectId: 'p1', projectPath: '/tmp/project', projectName: 'Test' }]);
      }
      return createResponse({
        resolved: true,
        status: 'approved',
        response: 'Looks good',
        autoDeleted: true,
        respondedAt: '2024-01-01T00:00:00.000Z',
      });
    });
    const handler = createWaitForApprovalHandler(createDependencies(fetchJson));

    const result = await handler(
      { approvalId: 'abc', projectPath: '/tmp/project' },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('approved');
    expect(result.data?.canProceed).toBe(true);
  });

  it('auto-registers project before waiting when dashboard has no project entry', async () => {
    const fetchJson = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects/list')) {
        return createResponse([]);
      }
      if (url.endsWith('/api/projects/add')) {
        return createResponse({ projectId: 'p-registered', success: true });
      }
      if (url.includes('/api/projects/p-registered/approvals/abc/wait')) {
        return createResponse({
          resolved: true,
          status: 'approved',
          response: 'Looks good',
          autoDeleted: true,
          respondedAt: '2024-01-01T00:00:00.000Z',
        });
      }
      throw new Error(`Unexpected URL: ${url}`);
    });
    const handler = createWaitForApprovalHandler(createDependencies(fetchJson));

    const result = await handler(
      { approvalId: 'abc', projectPath: '/tmp/project' },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('approved');
    expect(fetchJson).toHaveBeenCalledWith(
      'http://localhost:3000/api/projects/add',
      expect.objectContaining({ method: 'POST' })
    );
  });
});
