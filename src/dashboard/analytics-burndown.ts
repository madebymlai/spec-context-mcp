import type { TaskTransitionEvent, TaskSummarySnapshot } from './analytics-task-events.js';
import { parseTimestamp, resolveAnalyticsWindow, toUtcDayKey, type AnalyticsResponseBase } from './analytics-time-window.js';

interface BurndownPoint {
  date: string;
  totalTasks: number;
  completedTasks: number;
  remainingTasks: number;
}

export interface BurndownResponse extends AnalyticsResponseBase {
  points: BurndownPoint[];
}

interface ParsedEvent {
  event: TaskTransitionEvent;
  timestamp: Date;
  dayKey: string;
}

function cloneSummary(summary: TaskSummarySnapshot): TaskSummarySnapshot {
  return {
    total: summary.total,
    completed: summary.completed,
    pending: summary.pending,
  };
}

export function buildBurndownAnalytics(input: {
  events: ReadonlyArray<TaskTransitionEvent>;
  windowDays?: number;
  now?: Date;
}): BurndownResponse {
  const window = resolveAnalyticsWindow(input.windowDays, input.now);
  const points: BurndownPoint[] = window.dayKeys.map((date) => ({
    date,
    totalTasks: 0,
    completedTasks: 0,
    remainingTasks: 0,
  }));

  const parsedEvents: ParsedEvent[] = [];
  const dataCoverage: string[] = [];
  let partialData = false;

  for (const event of input.events) {
    const timestamp = parseTimestamp(event.timestamp);
    if (!timestamp) {
      partialData = true;
      dataCoverage.push('Some task transition events have invalid timestamps.');
      continue;
    }
    parsedEvents.push({
      event,
      timestamp,
      dayKey: toUtcDayKey(timestamp),
    });
  }

  parsedEvents.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());

  if (parsedEvents.length === 0) {
    return {
      windowDays: window.windowDays,
      startDate: window.startDate,
      endDate: window.endDate,
      partialData: true,
      dataCoverage: ['Task transition history is empty; burndown data will populate after task status changes.'],
      points,
    };
  }

  const startBoundary = window.startDate;
  const initialStateBySpec = new Map<string, TaskSummarySnapshot>();
  const seenInRangeWithoutBaseline = new Set<string>();

  for (const parsed of parsedEvents) {
    if (parsed.dayKey >= startBoundary) {
      continue;
    }
    initialStateBySpec.set(parsed.event.specName, cloneSummary(parsed.event.summaryAfter));
  }

  const eventsInWindow = parsedEvents.filter(
    (parsed) => parsed.dayKey >= window.startDate && parsed.dayKey <= window.endDate
  );

  for (const parsed of eventsInWindow) {
    if (!initialStateBySpec.has(parsed.event.specName)) {
      seenInRangeWithoutBaseline.add(parsed.event.specName);
    }
  }

  if (seenInRangeWithoutBaseline.size > 0) {
    partialData = true;
    dataCoverage.push('Some specs have no pre-window baseline; burndown uses first in-window observation for those specs.');
  }

  const currentStateBySpec = new Map<string, TaskSummarySnapshot>();
  for (const [specName, summary] of initialStateBySpec.entries()) {
    currentStateBySpec.set(specName, cloneSummary(summary));
  }

  let eventIndex = 0;
  for (const point of points) {
    const dayEnd = new Date(`${point.date}T23:59:59.999Z`).getTime();
    while (eventIndex < eventsInWindow.length) {
      const parsed = eventsInWindow[eventIndex];
      if (parsed.timestamp.getTime() > dayEnd) {
        break;
      }

      currentStateBySpec.set(parsed.event.specName, cloneSummary(parsed.event.summaryAfter));
      eventIndex += 1;
    }

    let totalTasks = 0;
    let completedTasks = 0;
    for (const summary of currentStateBySpec.values()) {
      totalTasks += summary.total;
      completedTasks += summary.completed;
    }

    point.totalTasks = totalTasks;
    point.completedTasks = completedTasks;
    point.remainingTasks = Math.max(0, totalTasks - completedTasks);
  }

  return {
    windowDays: window.windowDays,
    startDate: window.startDate,
    endDate: window.endDate,
    partialData,
    dataCoverage: Array.from(new Set(dataCoverage)),
    points,
  };
}
