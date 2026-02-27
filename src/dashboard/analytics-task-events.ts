import { promises as fs } from 'fs';
import { dirname, join } from 'path';
import { PathUtils } from '../core/workflow/path-utils.js';
import { parseTimestamp } from './analytics-time-window.js';

export type TaskTransitionStatus = 'pending' | 'in-progress' | 'completed';

export interface TaskSummarySnapshot {
  total: number;
  completed: number;
  pending: number;
}

export interface TaskTransitionEvent {
  timestamp: string;
  specName: string;
  taskId: string;
  previousStatus: TaskTransitionStatus;
  nextStatus: TaskTransitionStatus;
  summaryAfter: TaskSummarySnapshot;
}

function isTaskTransitionStatus(value: unknown): value is TaskTransitionStatus {
  return value === 'pending' || value === 'in-progress' || value === 'completed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return null;
  }
  return value;
}

function isTaskSummarySnapshot(value: unknown): value is TaskSummarySnapshot {
  if (!isRecord(value)) {
    return false;
  }

  const total = toFiniteNumber(value.total);
  const completed = toFiniteNumber(value.completed);
  const pending = toFiniteNumber(value.pending);
  if (total === null || completed === null || pending === null) {
    return false;
  }
  return total >= 0 && completed >= 0 && pending >= 0;
}

function parseTaskTransitionEvent(value: unknown): TaskTransitionEvent | null {
  if (!isRecord(value)) {
    return null;
  }

  const {
    timestamp,
    specName,
    taskId,
    previousStatus,
    nextStatus,
    summaryAfter,
  } = value;

  if (typeof timestamp !== 'string' || !parseTimestamp(timestamp)) {
    return null;
  }
  if (typeof specName !== 'string' || specName.length === 0) {
    return null;
  }
  if (typeof taskId !== 'string' || taskId.length === 0) {
    return null;
  }
  if (!isTaskTransitionStatus(previousStatus) || !isTaskTransitionStatus(nextStatus)) {
    return null;
  }
  if (!isTaskSummarySnapshot(summaryAfter)) {
    return null;
  }

  return {
    timestamp,
    specName,
    taskId,
    previousStatus,
    nextStatus,
    summaryAfter,
  };
}

export function getTaskEventsFilePath(projectPath: string): string {
  return join(PathUtils.getWorkflowRoot(projectPath), 'analytics', 'task-events.jsonl');
}

export async function appendTaskTransitionEvent(
  projectPath: string,
  event: TaskTransitionEvent
): Promise<void> {
  const filePath = getTaskEventsFilePath(projectPath);
  await fs.mkdir(dirname(filePath), { recursive: true });

  let separator = '';
  try {
    const existing = await fs.readFile(filePath, 'utf8');
    if (existing.length > 0 && !existing.endsWith('\n')) {
      separator = '\n';
    }
  } catch (error: unknown) {
    if (!(typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT')) {
      throw error;
    }
  }

  await fs.appendFile(filePath, `${separator}${JSON.stringify(event)}\n`, 'utf8');
}

export async function readTaskTransitionEvents(projectPath: string): Promise<TaskTransitionEvent[]> {
  const filePath = getTaskEventsFilePath(projectPath);

  let content: string;
  try {
    content = await fs.readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (typeof error === 'object' && error !== null && 'code' in error && (error as { code?: string }).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  const events: TaskTransitionEvent[] = [];
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      const event = parseTaskTransitionEvent(parsed);
      if (event) {
        events.push(event);
      }
    } catch {
      // Skip malformed lines. Analytics storage is best-effort and append-only.
    }
  }

  events.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return events;
}
