import { describe, expect, it } from 'vitest';
import { buildAnalyticsHistory } from './analytics-history.js';

describe('buildAnalyticsHistory', () => {
  it('builds daily points and aggregates spec/approval events', () => {
    const response = buildAnalyticsHistory({
      windowDays: 3,
      now: new Date('2026-02-27T12:00:00Z'),
      specs: [
        {
          createdAt: '2026-02-26T10:00:00Z',
          lastModified: '2026-02-27T08:00:00Z',
        },
      ],
      archivedSpecs: [
        {
          createdAt: '2026-02-25T09:00:00Z',
          lastModified: '2026-02-26T11:00:00Z',
        },
      ],
      approvals: [
        {
          createdAt: '2026-02-26T01:00:00Z',
          respondedAt: '2026-02-27T02:00:00Z',
        },
        {
          createdAt: '2026-02-27T03:00:00Z',
        },
      ],
    });

    expect(response.startDate).toBe('2026-02-25');
    expect(response.endDate).toBe('2026-02-27');
    expect(response.points).toHaveLength(3);
    expect(response.points).toEqual([
      {
        date: '2026-02-25',
        specsCreated: 1,
        specsModified: 0,
        approvalsCreated: 0,
        approvalsResolved: 0,
      },
      {
        date: '2026-02-26',
        specsCreated: 1,
        specsModified: 1,
        approvalsCreated: 1,
        approvalsResolved: 0,
      },
      {
        date: '2026-02-27',
        specsCreated: 0,
        specsModified: 1,
        approvalsCreated: 1,
        approvalsResolved: 1,
      },
    ]);
    expect(response.totals).toEqual({
      specsCreated: 2,
      specsModified: 2,
      approvalsCreated: 2,
      approvalsResolved: 1,
    });
  });

  it('ignores invalid timestamps and out-of-window events', () => {
    const response = buildAnalyticsHistory({
      windowDays: 2,
      now: new Date('2026-02-27T12:00:00Z'),
      specs: [
        { createdAt: 'not-a-date', lastModified: '2026-02-20T10:00:00Z' },
      ],
      archivedSpecs: [],
      approvals: [
        { createdAt: '2026-02-28T00:00:00Z', respondedAt: 'still-bad' },
      ],
    });

    expect(response.points).toEqual([
      {
        date: '2026-02-26',
        specsCreated: 0,
        specsModified: 0,
        approvalsCreated: 0,
        approvalsResolved: 0,
      },
      {
        date: '2026-02-27',
        specsCreated: 0,
        specsModified: 0,
        approvalsCreated: 0,
        approvalsResolved: 0,
      },
    ]);
  });

  it('clamps unsupported window sizes', () => {
    const tiny = buildAnalyticsHistory({
      windowDays: 0,
      now: new Date('2026-02-27T12:00:00Z'),
      specs: [],
      archivedSpecs: [],
      approvals: [],
    });
    const huge = buildAnalyticsHistory({
      windowDays: 9999,
      now: new Date('2026-02-27T12:00:00Z'),
      specs: [],
      archivedSpecs: [],
      approvals: [],
    });

    expect(tiny.windowDays).toBe(1);
    expect(tiny.points).toHaveLength(1);
    expect(huge.windowDays).toBe(365);
    expect(huge.points).toHaveLength(365);
  });
});
