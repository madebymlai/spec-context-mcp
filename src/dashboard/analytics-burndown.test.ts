import { describe, expect, it } from 'vitest';
import { buildBurndownAnalytics } from './analytics-burndown.js';

describe('buildBurndownAnalytics', () => {
  it('replays known summaries into daily burndown points', () => {
    const response = buildBurndownAnalytics({
      windowDays: 3,
      now: new Date('2026-02-27T12:00:00Z'),
      events: [
        {
          timestamp: '2026-02-24T23:00:00Z',
          specName: 'spec-a',
          taskId: 'seed',
          previousStatus: 'pending',
          nextStatus: 'in-progress',
          summaryAfter: { total: 3, completed: 0, pending: 2 },
        },
        {
          timestamp: '2026-02-25T03:00:00Z',
          specName: 'spec-a',
          taskId: '1',
          previousStatus: 'in-progress',
          nextStatus: 'completed',
          summaryAfter: { total: 3, completed: 1, pending: 1 },
        },
        {
          timestamp: '2026-02-27T03:00:00Z',
          specName: 'spec-a',
          taskId: '2',
          previousStatus: 'in-progress',
          nextStatus: 'completed',
          summaryAfter: { total: 3, completed: 2, pending: 0 },
        },
      ],
    });

    expect(response.points).toEqual([
      { date: '2026-02-25', totalTasks: 3, completedTasks: 1, remainingTasks: 2 },
      { date: '2026-02-26', totalTasks: 3, completedTasks: 1, remainingTasks: 2 },
      { date: '2026-02-27', totalTasks: 3, completedTasks: 2, remainingTasks: 1 },
    ]);
    expect(response.partialData).toBe(false);
  });

  it('returns partial data when history is empty', () => {
    const response = buildBurndownAnalytics({
      windowDays: 2,
      now: new Date('2026-02-27T12:00:00Z'),
      events: [],
    });

    expect(response.partialData).toBe(true);
    expect(response.points).toHaveLength(2);
  });
});
