import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { buildCodeMetrics } from './analytics-code-metrics.js';

const tempDirs: string[] = [];

async function createTempDirectory(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'analytics-code-metrics-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('buildCodeMetrics', () => {
  it('returns unavailable source for non-git directories', async () => {
    const projectPath = await createTempDirectory();
    const response = await buildCodeMetrics({
      projectPath,
      windowDays: 7,
      now: new Date('2026-02-27T12:00:00Z'),
    });

    expect(response.source).toBe('unavailable');
    expect(response.partialData).toBe(true);
    expect(response.points).toHaveLength(7);
    expect(response.totals).toEqual({
      linesAdded: 0,
      linesDeleted: 0,
      filesChanged: 0,
    });
  });
});
