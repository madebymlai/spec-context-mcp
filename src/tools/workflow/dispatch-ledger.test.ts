import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  applyOutcomeToTaskLedger,
  buildLedgerTaskPrompt,
  extractProgressLedger,
  isProgressLedgerStale,
  progressLedgerFromFacts,
  progressLedgerToFacts,
  resolveTasksFilePath,
  taskLedgerFromFacts,
  taskLedgerToFacts,
} from './dispatch-ledger.js';

const TASKS_CONTENT = `# Tasks\n\n- [x] 1. Completed setup\n- [-] 1.2 Implement ledger support\n  - _Requirements: 1, 2_\n  - _Prompt: Role: TypeScript Developer | Task: Build ledger context_\n- [ ] 2. Follow-up task\n`;

async function createTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dispatch-ledger-test-'));
}

async function writeTasks(projectPath: string, specName: string, content = TASKS_CONTENT): Promise<string> {
  const sourcePath = resolveTasksFilePath(projectPath, specName);
  const dirPath = join(projectPath, '.spec-context', 'specs', specName);
  await mkdir(dirPath, { recursive: true });
  await writeFile(sourcePath, content, 'utf8');
  return sourcePath;
}

describe('dispatch-ledger', () => {
  it('extracts progress ledger with totals and active task details', async () => {
    const projectPath = await createTempProject();
    try {
      const sourcePath = await writeTasks(projectPath, 'spec-a');
      const ledger = await extractProgressLedger({
        specName: 'spec-a',
        taskId: '1.2',
        sourcePath,
      });

      expect(ledger.totals.total).toBe(3);
      expect(ledger.totals.completed).toBe(1);
      expect(ledger.totals.inProgress).toBe(1);
      expect(ledger.activeTaskId).toBe('1.2');
      expect(ledger.currentTask?.id).toBe('1.2');
      expect(ledger.currentTask?.prompt).toContain('Build ledger context');

      const roundTrip = progressLedgerFromFacts(progressLedgerToFacts(ledger));
      expect(roundTrip?.sourceFingerprint.hash).toBe(ledger.sourceFingerprint.hash);
      expect(roundTrip?.currentTask?.id).toBe('1.2');
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('surfaces typed error for missing tasks.md', async () => {
    const projectPath = await createTempProject();
    try {
      const sourcePath = resolveTasksFilePath(projectPath, 'missing-spec');
      await expect(extractProgressLedger({
        specName: 'missing-spec',
        taskId: '1',
        sourcePath,
      })).rejects.toMatchObject({
        code: 'progress_ledger_missing_tasks',
      });
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('detects stale progress ledger on source change', async () => {
    const projectPath = await createTempProject();
    try {
      const sourcePath = await writeTasks(projectPath, 'spec-b');
      const ledger = await extractProgressLedger({
        specName: 'spec-b',
        taskId: '1.2',
        sourcePath,
      });
      expect(await isProgressLedgerStale(ledger)).toBe(false);

      await writeFile(sourcePath, TASKS_CONTENT.replace('[ ] 2.', '[-] 2.'), 'utf8');
      expect(await isProgressLedgerStale(ledger)).toBe(true);
    } finally {
      await rm(projectPath, { recursive: true, force: true });
    }
  });

  it('updates stalled state and replan hint deterministically', () => {
    const baseline = taskLedgerFromFacts({
      runId: 'run-1',
      taskId: '1.2',
      facts: [],
      stalledThreshold: 2,
    });

    const blockedOnce = applyOutcomeToTaskLedger(baseline, {
      role: 'implementer',
      status: 'blocked',
      summary: 'Missing dependency',
      followUpActions: ['Wait for API token'],
    });
    expect(blockedOnce.stalled.consecutiveNonProgress).toBe(1);
    expect(blockedOnce.stalled.flagged).toBe(false);

    const blockedTwice = applyOutcomeToTaskLedger(blockedOnce, {
      role: 'reviewer',
      assessment: 'blocked',
      issues: [{ severity: 'important', message: 'Cannot verify' }],
      requiredFixes: ['Resolve dependency'],
    });
    expect(blockedTwice.stalled.consecutiveNonProgress).toBe(2);
    expect(blockedTwice.stalled.flagged).toBe(true);
    expect(blockedTwice.replanHint).toContain('Stalled after 2');

    const recovered = applyOutcomeToTaskLedger(blockedTwice, {
      role: 'implementer',
      status: 'completed',
      summary: 'Dependency resolved',
      followUpActions: [],
    });
    expect(recovered.stalled.consecutiveNonProgress).toBe(0);
    expect(recovered.stalled.flagged).toBe(false);
    expect(recovered.replanHint).toBeUndefined();

    const facts = taskLedgerToFacts(recovered);
    const rehydrated = taskLedgerFromFacts({
      runId: 'run-1',
      taskId: '1.2',
      facts,
      stalledThreshold: 2,
    });
    expect(rehydrated.summary).toBe('Dependency resolved');
  });

  it('requires current task prompt for strict ledger prompt building', () => {
    const result = buildLedgerTaskPrompt({
      specName: 'spec-c',
      taskId: '1',
      sourcePath: '/tmp/tasks.md',
      sourceFingerprint: { mtimeMs: 1, hash: 'abc' },
      totals: { total: 1, completed: 0, inProgress: 0, pending: 1 },
      activeTaskId: '1',
      currentTask: {
        id: '1',
        description: 'No prompt task',
        status: 'pending',
      },
    });

    expect(result.missing).toContain('missing_task_prompt');
  });
});
