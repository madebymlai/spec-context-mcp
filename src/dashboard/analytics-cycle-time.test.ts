import { describe, expect, it } from 'vitest';
import { buildCycleTimeAnalytics } from './analytics-cycle-time.js';

describe('buildCycleTimeAnalytics', () => {
  it('computes task and spec cycle summaries from transition events', () => {
    const response = buildCycleTimeAnalytics({
      windowDays: 2,
      now: new Date('2026-02-27T12:00:00Z'),
      specs: [
        {
          name: 'spec-a',
          createdAt: '2026-02-25T00:00:00Z',
        },
      ],
      archivedSpecs: [],
      events: [
        {
          timestamp: '2026-02-27T01:00:00Z',
          specName: 'spec-a',
          taskId: '1',
          previousStatus: 'pending',
          nextStatus: 'in-progress',
          summaryAfter: { total: 2, completed: 0, pending: 1 },
        },
        {
          timestamp: '2026-02-27T03:00:00Z',
          specName: 'spec-a',
          taskId: '1',
          previousStatus: 'in-progress',
          nextStatus: 'completed',
          summaryAfter: { total: 2, completed: 1, pending: 1 },
        },
        {
          timestamp: '2026-02-27T06:00:00Z',
          specName: 'spec-a',
          taskId: '2',
          previousStatus: 'in-progress',
          nextStatus: 'completed',
          summaryAfter: { total: 2, completed: 2, pending: 0 },
        },
      ],
    });

    expect(response.taskCycle.count).toBe(1);
    expect(response.taskCycle.avgMs).toBe(2 * 60 * 60 * 1000);
    expect(response.specCycle.count).toBe(1);
    expect(response.specCycle.avgMs).not.toBeNull();
    expect(response.partialData).toBe(true);
  });

  it('marks partial when task transition history is empty', () => {
    const response = buildCycleTimeAnalytics({
      windowDays: 7,
      now: new Date('2026-02-27T12:00:00Z'),
      specs: [],
      archivedSpecs: [],
      events: [],
    });

    expect(response.partialData).toBe(true);
    expect(response.taskCycle.count).toBe(0);
    expect(response.specCycle.count).toBe(0);
  });
});
