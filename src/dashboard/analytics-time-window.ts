export interface AnalyticsWindowSummary {
  windowDays: number;
  startDate: string;
  endDate: string;
}

export interface AnalyticsResponseBase extends AnalyticsWindowSummary {
  partialData: boolean;
  dataCoverage: string[];
}

export interface AnalyticsWindow extends AnalyticsWindowSummary {
  startUtc: Date;
  endUtc: Date;
  dayKeys: string[];
}

export function toUtcDayKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

export function parseTimestamp(rawTimestamp: string | undefined): Date | null {
  if (!rawTimestamp) {
    return null;
  }
  const parsed = new Date(rawTimestamp);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }
  return parsed;
}

export function normalizeWindowDays(rawDays: number | undefined): number {
  if (!Number.isFinite(rawDays)) {
    return 30;
  }
  return Math.min(365, Math.max(1, Math.floor(rawDays as number)));
}

export function resolveAnalyticsWindow(rawWindowDays?: number, now: Date = new Date()): AnalyticsWindow {
  const windowDays = normalizeWindowDays(rawWindowDays);
  const endUtc = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const startUtc = new Date(endUtc);
  startUtc.setUTCDate(startUtc.getUTCDate() - (windowDays - 1));

  const dayKeys: string[] = [];
  for (let day = 0; day < windowDays; day += 1) {
    const cursor = new Date(startUtc);
    cursor.setUTCDate(cursor.getUTCDate() + day);
    dayKeys.push(toUtcDayKey(cursor));
  }

  return {
    windowDays,
    startDate: toUtcDayKey(startUtc),
    endDate: toUtcDayKey(endUtc),
    startUtc,
    endUtc,
    dayKeys,
  };
}

export function createResponseBase(
  rawWindowDays: number | undefined,
  now?: Date
): AnalyticsResponseBase {
  const window = resolveAnalyticsWindow(rawWindowDays, now);
  return {
    windowDays: window.windowDays,
    startDate: window.startDate,
    endDate: window.endDate,
    partialData: false,
    dataCoverage: [],
  };
}
