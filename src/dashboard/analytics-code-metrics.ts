import { execFile } from 'child_process';
import { promisify } from 'util';
import { resolveAnalyticsWindow, type AnalyticsResponseBase } from './analytics-time-window.js';

const execFileAsync = promisify(execFile);

export interface CodeMetricsPoint {
  date: string;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
}

export interface CodeMetricsResponse extends AnalyticsResponseBase {
  source: 'git' | 'unavailable';
  points: CodeMetricsPoint[];
  totals: {
    linesAdded: number;
    linesDeleted: number;
    filesChanged: number;
  };
}

function createZeroPoints(dayKeys: string[]): CodeMetricsPoint[] {
  return dayKeys.map((date) => ({
    date,
    linesAdded: 0,
    linesDeleted: 0,
    filesChanged: 0,
  }));
}

function isGitRepositoryError(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return false;
  }
  const message = 'stderr' in error && typeof (error as { stderr?: unknown }).stderr === 'string'
    ? ((error as { stderr: string }).stderr || '').toLowerCase()
    : '';
  return message.includes('not a git repository');
}

export async function buildCodeMetrics(input: {
  projectPath: string;
  windowDays?: number;
  now?: Date;
}): Promise<CodeMetricsResponse> {
  const window = resolveAnalyticsWindow(input.windowDays, input.now);
  const points = createZeroPoints(window.dayKeys);
  const pointsByDate = new Map(points.map((point) => [point.date, point]));

  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: input.projectPath });
  } catch (error) {
    if (isGitRepositoryError(error) || (typeof error === 'object' && error !== null && 'code' in error)) {
      return {
        windowDays: window.windowDays,
        startDate: window.startDate,
        endDate: window.endDate,
        source: 'unavailable',
        partialData: true,
        dataCoverage: ['Git repository data is unavailable for this project path.'],
        points,
        totals: {
          linesAdded: 0,
          linesDeleted: 0,
          filesChanged: 0,
        },
      };
    }
    throw error;
  }

  const since = `${window.startDate}T00:00:00Z`;
  const until = `${window.endDate}T23:59:59Z`;

  const { stdout } = await execFileAsync(
    'git',
    [
      'log',
      '--since',
      since,
      '--until',
      until,
      '--numstat',
      '--date=short',
      '--pretty=format:__DATE__%ad',
    ],
    { cwd: input.projectPath }
  );

  let currentDate: string | null = null;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) {
      continue;
    }

    if (line.startsWith('__DATE__')) {
      currentDate = line.slice('__DATE__'.length).trim();
      continue;
    }

    if (!currentDate) {
      continue;
    }

    const point = pointsByDate.get(currentDate);
    if (!point) {
      continue;
    }

    const match = line.match(/^(\d+|-)\t(\d+|-)\t/);
    if (!match) {
      continue;
    }

    const linesAdded = match[1] === '-' ? 0 : Number(match[1]);
    const linesDeleted = match[2] === '-' ? 0 : Number(match[2]);

    point.linesAdded += linesAdded;
    point.linesDeleted += linesDeleted;
    point.filesChanged += 1;
  }

  const totals = points.reduce(
    (aggregate, point) => ({
      linesAdded: aggregate.linesAdded + point.linesAdded,
      linesDeleted: aggregate.linesDeleted + point.linesDeleted,
      filesChanged: aggregate.filesChanged + point.filesChanged,
    }),
    {
      linesAdded: 0,
      linesDeleted: 0,
      filesChanged: 0,
    }
  );

  return {
    windowDays: window.windowDays,
    startDate: window.startDate,
    endDate: window.endDate,
    source: 'git',
    partialData: false,
    dataCoverage: [],
    points,
    totals,
  };
}
