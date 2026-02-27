import { afterEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  appendTaskTransitionEvent,
  getTaskEventsFilePath,
  readTaskTransitionEvents,
} from './analytics-task-events.js';

const tempDirs: string[] = [];

async function createTempProjectPath(): Promise<string> {
  const directory = await fs.mkdtemp(join(tmpdir(), 'analytics-task-events-'));
  tempDirs.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })));
});

describe('analytics task events', () => {
  it('appends and reads transition events', async () => {
    const projectPath = await createTempProjectPath();

    await appendTaskTransitionEvent(projectPath, {
      timestamp: '2026-02-27T10:00:00Z',
      specName: 'analytics-spec',
      taskId: '1',
      previousStatus: 'pending',
      nextStatus: 'in-progress',
      summaryAfter: {
        total: 4,
        completed: 1,
        pending: 2,
      },
    });

    await appendTaskTransitionEvent(projectPath, {
      timestamp: '2026-02-27T11:00:00Z',
      specName: 'analytics-spec',
      taskId: '1',
      previousStatus: 'in-progress',
      nextStatus: 'completed',
      summaryAfter: {
        total: 4,
        completed: 2,
        pending: 1,
      },
    });

    const events = await readTaskTransitionEvents(projectPath);
    expect(events).toHaveLength(2);
    expect(events[0].nextStatus).toBe('in-progress');
    expect(events[1].nextStatus).toBe('completed');
  });

  it('skips malformed lines and malformed JSON entries', async () => {
    const projectPath = await createTempProjectPath();
    const filePath = getTaskEventsFilePath(projectPath);
    await fs.mkdir(join(projectPath, '.spec-context', 'analytics'), { recursive: true });
    await fs.writeFile(
      filePath,
      [
        '{"timestamp":"2026-02-27T10:00:00Z","specName":"spec-a","taskId":"1","previousStatus":"pending","nextStatus":"completed","summaryAfter":{"total":1,"completed":1,"pending":0}}',
        '{"malformed":true}',
        '{this is not json}',
        '',
      ].join('\n'),
      'utf8'
    );

    const events = await readTaskTransitionEvents(projectPath);
    expect(events).toHaveLength(1);
    expect(events[0].specName).toBe('spec-a');
  });
});
