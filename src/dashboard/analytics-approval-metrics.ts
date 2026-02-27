import { parseTimestamp, resolveAnalyticsWindow, toUtcDayKey, type AnalyticsResponseBase } from './analytics-time-window.js';

interface ApprovalLike {
  status?: string;
  createdAt?: string;
  respondedAt?: string;
}

interface DailyLatencyPoint {
  date: string;
  count: number;
  avgResolutionMs: number | null;
}

export interface ApprovalMetricsResponse extends AnalyticsResponseBase {
  countsByStatus: {
    pending: number;
    approved: number;
    rejected: number;
    needsRevision: number;
  };
  resolvedCount: number;
  rejectionRate: number | null;
  avgResolutionMs: number | null;
  medianResolutionMs: number | null;
  dailyLatency: DailyLatencyPoint[];
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

function computeAverage(values: number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

export function buildApprovalMetrics(input: {
  approvals: ReadonlyArray<ApprovalLike>;
  windowDays?: number;
  now?: Date;
}): ApprovalMetricsResponse {
  const window = resolveAnalyticsWindow(input.windowDays, input.now);

  const dailyLatency: DailyLatencyPoint[] = window.dayKeys.map((date) => ({
    date,
    count: 0,
    avgResolutionMs: null,
  }));
  const dailyDurationsByDate = new Map<string, number[]>();

  const countsByStatus = {
    pending: 0,
    approved: 0,
    rejected: 0,
    needsRevision: 0,
  };

  const resolutionDurations: number[] = [];
  let resolvedCount = 0;
  let resolvedRejectedCount = 0;
  const dataCoverage: string[] = [];
  let partialData = false;

  for (const approval of input.approvals) {
    const createdAt = parseTimestamp(approval.createdAt);
    if (approval.createdAt && !createdAt) {
      partialData = true;
      dataCoverage.push('Some approval records have invalid createdAt timestamps.');
      continue;
    }

    const createdDay = createdAt ? toUtcDayKey(createdAt) : null;
    if (createdDay && createdDay >= window.startDate && createdDay <= window.endDate) {
      if (approval.status === 'pending') {
        countsByStatus.pending += 1;
      } else if (approval.status === 'approved') {
        countsByStatus.approved += 1;
      } else if (approval.status === 'rejected') {
        countsByStatus.rejected += 1;
      } else if (approval.status === 'needs-revision') {
        countsByStatus.needsRevision += 1;
      }
    }

    const respondedAt = parseTimestamp(approval.respondedAt);
    if (approval.respondedAt && !respondedAt) {
      partialData = true;
      dataCoverage.push('Some approval records have invalid respondedAt timestamps.');
      continue;
    }

    if (!respondedAt || !createdAt || approval.status === 'pending') {
      continue;
    }

    const respondedDay = toUtcDayKey(respondedAt);
    if (respondedDay < window.startDate || respondedDay > window.endDate) {
      continue;
    }

    const duration = respondedAt.getTime() - createdAt.getTime();
    if (duration < 0) {
      partialData = true;
      dataCoverage.push('Some approvals have respondedAt earlier than createdAt and were excluded.');
      continue;
    }

    resolvedCount += 1;
    resolutionDurations.push(duration);
    if (approval.status === 'rejected') {
      resolvedRejectedCount += 1;
    }

    if (!dailyDurationsByDate.has(respondedDay)) {
      dailyDurationsByDate.set(respondedDay, []);
    }
    dailyDurationsByDate.get(respondedDay)!.push(duration);
  }

  for (const point of dailyLatency) {
    const durations = dailyDurationsByDate.get(point.date) ?? [];
    point.count = durations.length;
    point.avgResolutionMs = computeAverage(durations);
  }

  return {
    windowDays: window.windowDays,
    startDate: window.startDate,
    endDate: window.endDate,
    partialData,
    dataCoverage: Array.from(new Set(dataCoverage)),
    countsByStatus,
    resolvedCount,
    rejectionRate: resolvedCount > 0 ? resolvedRejectedCount / resolvedCount : null,
    avgResolutionMs: computeAverage(resolutionDurations),
    medianResolutionMs: computeMedian(resolutionDurations),
    dailyLatency,
  };
}
