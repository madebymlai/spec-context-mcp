import type { TaskTransitionEvent } from './analytics-task-events.js';
import { parseTimestamp, resolveAnalyticsWindow, toUtcDayKey, type AnalyticsResponseBase } from './analytics-time-window.js';

interface SpecLike {
  name: string;
  createdAt?: string;
}

interface ParsedEvent {
  event: TaskTransitionEvent;
  timestamp: Date;
  dayKey: string;
}

export interface CycleTimeSummary {
  count: number;
  avgMs: number | null;
  medianMs: number | null;
  p90Ms?: number | null;
}

export interface CycleTimeResponse extends AnalyticsResponseBase {
  taskCycle: CycleTimeSummary;
  specCycle: CycleTimeSummary;
}

function computeAverage(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function computeMedian(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return Math.round((sorted[middle - 1] + sorted[middle]) / 2);
  }
  return sorted[middle];
}

function computePercentile(values: number[], percentile: number): number | null {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.ceil((percentile / 100) * sorted.length) - 1;
  const boundedIndex = Math.max(0, Math.min(sorted.length - 1, index));
  return sorted[boundedIndex];
}

export function buildCycleTimeAnalytics(input: {
  events: ReadonlyArray<TaskTransitionEvent>;
  specs: ReadonlyArray<SpecLike>;
  archivedSpecs: ReadonlyArray<SpecLike>;
  windowDays?: number;
  now?: Date;
}): CycleTimeResponse {
  const window = resolveAnalyticsWindow(input.windowDays, input.now);
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

  const taskEventsById = new Map<string, ParsedEvent[]>();
  for (const parsed of parsedEvents) {
    const key = `${parsed.event.specName}::${parsed.event.taskId}`;
    if (!taskEventsById.has(key)) {
      taskEventsById.set(key, []);
    }
    taskEventsById.get(key)!.push(parsed);
  }

  const taskDurations: number[] = [];
  let completedWithoutStart = 0;

  for (const events of taskEventsById.values()) {
    const inProgressTimestamp = events.find((entry) => entry.event.nextStatus === 'in-progress')?.timestamp;
    const completedEntry = events.find(
      (entry) => entry.event.nextStatus === 'completed' && (!inProgressTimestamp || entry.timestamp >= inProgressTimestamp)
    );

    if (!completedEntry) {
      continue;
    }

    if (completedEntry.dayKey < window.startDate || completedEntry.dayKey > window.endDate) {
      continue;
    }

    if (!inProgressTimestamp) {
      completedWithoutStart += 1;
      continue;
    }

    const duration = completedEntry.timestamp.getTime() - inProgressTimestamp.getTime();
    if (duration >= 0) {
      taskDurations.push(duration);
    }
  }

  if (completedWithoutStart > 0) {
    partialData = true;
    dataCoverage.push('Some completed tasks had no recorded in-progress transition and were excluded from cycle time.');
  }

  const uniqueSpecs = new Map<string, SpecLike>();
  for (const spec of [...input.specs, ...input.archivedSpecs]) {
    if (!uniqueSpecs.has(spec.name)) {
      uniqueSpecs.set(spec.name, spec);
    }
  }

  const firstDoneBySpec = new Map<string, ParsedEvent>();
  for (const parsed of parsedEvents) {
    if (parsed.event.summaryAfter.total <= 0) {
      continue;
    }
    if (parsed.event.summaryAfter.completed !== parsed.event.summaryAfter.total) {
      continue;
    }

    const previous = firstDoneBySpec.get(parsed.event.specName);
    if (!previous || parsed.timestamp < previous.timestamp) {
      firstDoneBySpec.set(parsed.event.specName, parsed);
    }
  }

  const specDurations: number[] = [];
  for (const [specName, doneEvent] of firstDoneBySpec.entries()) {
    if (doneEvent.dayKey < window.startDate || doneEvent.dayKey > window.endDate) {
      continue;
    }

    const spec = uniqueSpecs.get(specName);
    if (!spec) {
      partialData = true;
      dataCoverage.push('Some spec completion events do not map to current or archived specs.');
      continue;
    }

    const createdAt = parseTimestamp(spec.createdAt);
    if (!createdAt) {
      partialData = true;
      dataCoverage.push('Some specs are missing valid createdAt timestamps.');
      continue;
    }

    const duration = doneEvent.timestamp.getTime() - createdAt.getTime();
    if (duration >= 0) {
      specDurations.push(duration);
    }
  }

  if (input.events.length === 0) {
    partialData = true;
    dataCoverage.push('Task transition history is empty; cycle time will populate as tasks move through statuses.');
  }

  return {
    windowDays: window.windowDays,
    startDate: window.startDate,
    endDate: window.endDate,
    partialData,
    dataCoverage: Array.from(new Set(dataCoverage)),
    taskCycle: {
      count: taskDurations.length,
      avgMs: computeAverage(taskDurations),
      medianMs: computeMedian(taskDurations),
      p90Ms: computePercentile(taskDurations, 90),
    },
    specCycle: {
      count: specDurations.length,
      avgMs: computeAverage(specDurations),
      medianMs: computeMedian(specDurations),
    },
  };
}
