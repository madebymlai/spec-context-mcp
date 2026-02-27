export interface AnalyticsHistoryPoint {
  date: string;
  specsCreated: number;
  specsModified: number;
  approvalsCreated: number;
  approvalsResolved: number;
}

export interface AnalyticsHistoryTotals {
  specsCreated: number;
  specsModified: number;
  approvalsCreated: number;
  approvalsResolved: number;
}

export interface AnalyticsHistoryResponse {
  windowDays: number;
  startDate: string;
  endDate: string;
  points: AnalyticsHistoryPoint[];
  totals: AnalyticsHistoryTotals;
}

interface HasSpecTimestamps {
  createdAt?: string;
  lastModified?: string;
}

interface HasApprovalTimestamps {
  createdAt?: string;
  respondedAt?: string;
}

function toUtcDayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function normalizeWindowDays(rawDays: number | undefined): number {
  if (!Number.isFinite(rawDays)) {
    return 30;
  }
  return Math.min(365, Math.max(1, Math.floor(rawDays as number)));
}

function parseDayKey(rawTimestamp: string | undefined): string | null {
  if (!rawTimestamp) {
    return null;
  }
  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return toUtcDayKey(parsed);
}

function incrementPoint(
  pointsByDate: Map<string, AnalyticsHistoryPoint>,
  dayKey: string | null,
  field: keyof Omit<AnalyticsHistoryPoint, 'date'>
): void {
  if (!dayKey) {
    return;
  }
  const point = pointsByDate.get(dayKey);
  if (!point) {
    return;
  }
  point[field] += 1;
}

export function buildAnalyticsHistory(input: {
  specs: ReadonlyArray<HasSpecTimestamps>;
  archivedSpecs: ReadonlyArray<HasSpecTimestamps>;
  approvals: ReadonlyArray<HasApprovalTimestamps>;
  windowDays?: number;
  now?: Date;
}): AnalyticsHistoryResponse {
  const windowDays = normalizeWindowDays(input.windowDays);
  const now = input.now ?? new Date();
  const todayUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startUtc = new Date(todayUtc);
  startUtc.setUTCDate(startUtc.getUTCDate() - (windowDays - 1));

  const points: AnalyticsHistoryPoint[] = [];
  const pointsByDate = new Map<string, AnalyticsHistoryPoint>();
  for (let day = 0; day < windowDays; day += 1) {
    const cursor = new Date(startUtc);
    cursor.setUTCDate(cursor.getUTCDate() + day);
    const key = toUtcDayKey(cursor);
    const point: AnalyticsHistoryPoint = {
      date: key,
      specsCreated: 0,
      specsModified: 0,
      approvalsCreated: 0,
      approvalsResolved: 0,
    };
    points.push(point);
    pointsByDate.set(key, point);
  }

  for (const spec of [...input.specs, ...input.archivedSpecs]) {
    incrementPoint(pointsByDate, parseDayKey(spec.createdAt), 'specsCreated');
    incrementPoint(pointsByDate, parseDayKey(spec.lastModified), 'specsModified');
  }

  for (const approval of input.approvals) {
    incrementPoint(pointsByDate, parseDayKey(approval.createdAt), 'approvalsCreated');
    incrementPoint(pointsByDate, parseDayKey(approval.respondedAt), 'approvalsResolved');
  }

  const totals = points.reduce<AnalyticsHistoryTotals>(
    (aggregate, point) => ({
      specsCreated: aggregate.specsCreated + point.specsCreated,
      specsModified: aggregate.specsModified + point.specsModified,
      approvalsCreated: aggregate.approvalsCreated + point.approvalsCreated,
      approvalsResolved: aggregate.approvalsResolved + point.approvalsResolved,
    }),
    {
      specsCreated: 0,
      specsModified: 0,
      approvalsCreated: 0,
      approvalsResolved: 0,
    }
  );

  return {
    windowDays,
    startDate: toUtcDayKey(startUtc),
    endDate: toUtcDayKey(todayUtc),
    points,
    totals,
  };
}
