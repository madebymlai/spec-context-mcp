import type { TaskTransitionEvent } from './analytics-task-events.js';
import { parseTimestamp, resolveAnalyticsWindow, toUtcDayKey, type AnalyticsResponseBase } from './analytics-time-window.js';

export interface TaskVelocityPoint {
  date: string;
  completedTasks: number;
}

export interface TaskVelocityResponse extends AnalyticsResponseBase {
  points: TaskVelocityPoint[];
  totals: {
    completedTasks: number;
  };
}

export function buildTaskVelocityAnalytics(input: {
  events: ReadonlyArray<TaskTransitionEvent>;
  windowDays?: number;
  now?: Date;
}): TaskVelocityResponse {
  const window = resolveAnalyticsWindow(input.windowDays, input.now);
  const points: TaskVelocityPoint[] = window.dayKeys.map((date) => ({ date, completedTasks: 0 }));
  const pointsByDate = new Map(points.map((point) => [point.date, point]));

  for (const event of input.events) {
    if (event.nextStatus !== 'completed') {
      continue;
    }

    const parsedTimestamp = parseTimestamp(event.timestamp);
    if (!parsedTimestamp) {
      continue;
    }

    const dayKey = toUtcDayKey(parsedTimestamp);
    const point = pointsByDate.get(dayKey);
    if (point) {
      point.completedTasks += 1;
    }
  }

  const totals = points.reduce(
    (aggregate, point) => ({
      completedTasks: aggregate.completedTasks + point.completedTasks,
    }),
    { completedTasks: 0 }
  );

  const dataCoverage: string[] = [];
  let partialData = false;

  if (input.events.length === 0) {
    partialData = true;
    dataCoverage.push('Task transition history is empty; velocity will become accurate as new status updates are recorded.');
  } else {
    const firstEvent = input.events
      .map((event) => parseTimestamp(event.timestamp))
      .filter((value): value is Date => value !== null)
      .sort((a, b) => a.getTime() - b.getTime())[0];

    if (firstEvent) {
      const firstEventDay = toUtcDayKey(firstEvent);
      if (firstEventDay > window.startDate) {
        partialData = true;
        dataCoverage.push('Task history starts after the requested window start date.');
      }
    }
  }

  return {
    windowDays: window.windowDays,
    startDate: window.startDate,
    endDate: window.endDate,
    partialData,
    dataCoverage,
    points,
    totals,
  };
}
