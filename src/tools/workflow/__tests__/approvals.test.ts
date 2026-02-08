import { describe, it, expect, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  translatePath: vi.fn((value: string) => value),
  validateProjectPath: vi.fn(async (value: string) => value),
  approvalStorageStart: vi.fn(),
  approvalStorageStop: vi.fn(),
  approvalStorageGetAllPending: vi.fn(async () => []),
  approvalStorageCreate: vi.fn(async () => 'approval-123'),
  approvalStorageGetApproval: vi.fn(async () => null),
  approvalStorageDeleteApproval: vi.fn(async () => false),
}));

vi.mock('../../../core/workflow/path-utils-node.js', () => ({
  validateProjectPath: mocks.validateProjectPath,
}));

vi.mock('../../../core/workflow/path-utils.js', () => ({
  PathUtils: { translatePath: mocks.translatePath },
}));

vi.mock('fs/promises', () => ({
  readFile: vi.fn(async () => '- [ ] 1.1 Example\n\n_Prompt: ok_')
}));

vi.mock('../../../core/workflow/task-validator.js', () => ({
  validateTasksMarkdown: vi.fn(() => ({ valid: true, errors: [], warnings: [], summary: '' })),
  formatValidationErrors: vi.fn(() => []),
}));

import { createApprovalsHandler } from '../approvals.js';

const approvalStoreFactory = {
  create: vi.fn(() => ({
    start: mocks.approvalStorageStart,
    stop: mocks.approvalStorageStop,
    getAllPendingApprovals: mocks.approvalStorageGetAllPending,
    createApproval: mocks.approvalStorageCreate,
    getApproval: mocks.approvalStorageGetApproval,
    deleteApproval: mocks.approvalStorageDeleteApproval,
  })),
};

const approvalsHandler = createApprovalsHandler(approvalStoreFactory as any);

describe('approvalsHandler', () => {
  it('returns validation error when request fields are missing', async () => {
    const result = await approvalsHandler({ action: 'request' } as any, { projectPath: '' });
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Missing required fields/i);
  });

  it('returns validation error when projectPath is missing for status', async () => {
    const result = await approvalsHandler(
      { action: 'status', approvalId: 'approval-123' } as any,
      { projectPath: '' }
    );
    expect(result.success).toBe(false);
    expect(result.message).toMatch(/Project path is required/i);
  });

  it('creates a new approval request', async () => {
    const result = await approvalsHandler({
      action: 'request',
      title: 'Review',
      filePath: '.spec-context/specs/test/requirements.md',
      type: 'document',
      category: 'spec',
      categoryName: 'test',
      projectPath: '/tmp/project'
    } as any, { projectPath: '/tmp/project', dashboardUrl: 'http://localhost:3000' });

    expect(result.success).toBe(true);
    expect(result.data?.approvalId).toBe('approval-123');
    expect(mocks.approvalStorageCreate).toHaveBeenCalled();
  });
});
