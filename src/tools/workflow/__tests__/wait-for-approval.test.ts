import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  validateProjectPath: vi.fn(async (value: string) => value),
  translatePath: vi.fn((value: string) => value),
  resolveDashboardUrl: vi.fn(async () => 'http://localhost:3000'),
  buildApprovalDeeplink: vi.fn((dashboardUrl: string, approvalId: string, projectId?: string) => {
    const base = (dashboardUrl || '').replace(/\/+$/, '');
    const params = new URLSearchParams({ id: approvalId });
    if (projectId) params.set('projectId', projectId);
    return `${base}/#/approvals?${params.toString()}`;
  }),
}));

type FetchResponse = {
  ok: boolean;
  statusText?: string;
  json: () => Promise<any>;
};

const createResponse = (data: any, ok = true, statusText = 'OK'): FetchResponse => ({
  ok,
  statusText,
  json: async () => data,
});

vi.mock('../../../core/workflow/path-utils.js', () => ({
  validateProjectPath: mocks.validateProjectPath,
  PathUtils: { translatePath: mocks.translatePath },
}));

vi.mock('../../../core/workflow/dashboard-url.js', () => ({
  resolveDashboardUrl: mocks.resolveDashboardUrl,
  buildApprovalDeeplink: mocks.buildApprovalDeeplink,
}));

import { waitForApprovalHandler } from '../wait-for-approval.js';

describe('waitForApprovalHandler', () => {
  beforeEach(() => {
    mocks.validateProjectPath.mockClear();
    mocks.translatePath.mockClear();
    mocks.resolveDashboardUrl.mockClear();
    mocks.buildApprovalDeeplink.mockClear();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns an error when approvalId is missing', async () => {
    const result = await waitForApprovalHandler(
      { approvalId: '' },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/approvalId is required/i);
  });

  it('returns an error when dashboard is unavailable', async () => {
    const fetchMock = vi.fn(async () => createResponse({ error: 'nope' }, false, 'Bad'));
    vi.stubGlobal('fetch', fetchMock as any);

    const result = await waitForApprovalHandler(
      { approvalId: 'abc', projectPath: '/tmp/project' },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Dashboard not available/i);
    expect(fetchMock).toHaveBeenCalledWith('http://localhost:3000/api/projects/list');
  });

  it('returns timeout result when wait endpoint reports timeout', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/projects/list')) {
        return createResponse([{ projectId: 'p1', projectPath: '/tmp/project', projectName: 'Test' }]);
      }
      return createResponse({ timeout: true, status: 'pending' });
    });
    vi.stubGlobal('fetch', fetchMock as any);

    const result = await waitForApprovalHandler(
      { approvalId: 'abc', projectPath: '/tmp/project', timeoutMs: 1000 },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Timeout waiting for approval/i);
    expect(result.data?.timeout).toBe(true);
  });

  it('returns approved result when dashboard resolves approval', async () => {
    const fetchMock = vi.fn(async (url: string) => {
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
    vi.stubGlobal('fetch', fetchMock as any);

    const result = await waitForApprovalHandler(
      { approvalId: 'abc', projectPath: '/tmp/project' },
      { projectPath: '/tmp/project' }
    );

    expect(result.success).toBe(true);
    expect(result.data?.status).toBe('approved');
    expect(result.data?.canProceed).toBe(true);
  });
});
