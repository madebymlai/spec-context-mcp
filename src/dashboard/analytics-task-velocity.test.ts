import { describe, expect, it } from 'vitest';
import { buildTaskVelocityAnalytics } from './analytics-task-velocity.js';

describe('buildTaskVelocityAnalytics', () => {
  it('aggregates completed task transitions by day', () => {
    const response = buildTaskVelocityAnalytics({
      windowDays: 3,
      now: new Date('2026-02-27T12:00:00Z'),
      events: [
        {
          timestamp: '2026-02-25T03:00:00Z',
          specName: 'spec-a',
          taskId: '1',
          previousStatus: 'pending',
          nextStatus: 'completed',
          summaryAfter: { total: 2, completed: 1, pending: 1 },
        },
        {
          timestamp: '2026-02-26T09:00:00Z',
          specName: 'spec-a',
          taskId: '2',
          previousStatus: 'in-progress',
          nextStatus: 'completed',
          summaryAfter: { total: 2, completed: 2, pending: 0 },
        },
        {
          timestamp: '2026-02-26T11:00:00Z',
          specName: 'spec-a',
          taskId: '2',
          previousStatus: 'completed',
          nextStatus: 'in-progress',
          summaryAfter: { total: 2, completed: 1, pending: 1 },
        },
      ],
    });

    expect(response.points).toEqual([
      { date: '2026-02-25', completedTasks: 1 },
      { date: '2026-02-26', completedTasks: 1 },
      { date: '2026-02-27', completedTasks: 0 },
    ]);
    expect(response.totals.completedTasks).toBe(2);
    expect(response.partialData).toBe(false);
  });

  it('marks partial data when there is no task history', () => {
    const response = buildTaskVelocityAnalytics({
      windowDays: 2,
      now: new Date('2026-02-27T12:00:00Z'),
      events: [],
    });

    expect(response.partialData).toBe(true);
    expect(response.dataCoverage.length).toBeGreaterThan(0);
  });
});
