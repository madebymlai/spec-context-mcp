import { describe, expect, it } from 'vitest';
import { buildApprovalMetrics } from './analytics-approval-metrics.js';

describe('buildApprovalMetrics', () => {
  it('computes status counts, rejection rate, and latency stats', () => {
    const response = buildApprovalMetrics({
      windowDays: 3,
      now: new Date('2026-02-27T12:00:00Z'),
      approvals: [
        {
          status: 'approved',
          createdAt: '2026-02-25T10:00:00Z',
          respondedAt: '2026-02-26T10:00:00Z',
        },
        {
          status: 'rejected',
          createdAt: '2026-02-26T10:00:00Z',
          respondedAt: '2026-02-27T10:00:00Z',
        },
        {
          status: 'pending',
          createdAt: '2026-02-27T10:00:00Z',
        },
        {
          status: 'needs-revision',
          createdAt: '2026-02-27T11:00:00Z',
          respondedAt: '2026-02-27T11:30:00Z',
        },
      ],
    });

    expect(response.countsByStatus).toEqual({
      pending: 1,
      approved: 1,
      rejected: 1,
      needsRevision: 1,
    });
    expect(response.resolvedCount).toBe(3);
    expect(response.rejectionRate).toBeCloseTo(1 / 3, 6);
    expect(response.avgResolutionMs).toBeGreaterThan(0);
    expect(response.medianResolutionMs).toBeGreaterThan(0);
    expect(response.dailyLatency).toHaveLength(3);
  });

  it('returns null latency metrics when no resolved approvals are in range', () => {
    const response = buildApprovalMetrics({
      windowDays: 2,
      now: new Date('2026-02-27T12:00:00Z'),
      approvals: [
        {
          status: 'pending',
          createdAt: '2026-02-27T10:00:00Z',
        },
      ],
    });

    expect(response.resolvedCount).toBe(0);
    expect(response.rejectionRate).toBeNull();
    expect(response.avgResolutionMs).toBeNull();
    expect(response.medianResolutionMs).toBeNull();
  });
});
