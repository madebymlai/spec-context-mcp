import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import {
  applyOutcomeToTaskLedger,
  buildFailureEvidence,
  buildLedgerDeltaPacket,
  buildLedgerTaskPrompt,
  buildResumptionPrompt,
  extractProgressLedger,
  isProgressLedgerStale,
  progressLedgerFromFacts,
  progressLedgerToFacts,
  resolveTasksFilePath,
  taskLedgerFromFacts,
  taskLedgerToFacts,
} from './dispatch-ledger.js';
import type { TaskLedger } from './dispatch-ledger.js';

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
      reviewLoopThreshold: 2,
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
      reviewLoopThreshold: 2,
    });
    expect(rehydrated.summary).toBe('Dependency resolved');
  });

  it('flags review loop when identical needs_changes repeats', () => {
    const baseline = taskLedgerFromFacts({
      runId: 'run-2',
      taskId: '1.3',
      facts: [],
      stalledThreshold: 2,
      reviewLoopThreshold: 2,
    });

    const firstNeedsChanges = applyOutcomeToTaskLedger(baseline, {
      role: 'reviewer',
      assessment: 'needs_changes',
      issues: [{ severity: 'important', message: 'Missing test coverage', file: 'src/a.ts' }],
      requiredFixes: ['Add tests for edge path'],
    });
    expect(firstNeedsChanges.reviewLoop.consecutiveSameNeedsChanges).toBe(1);
    expect(firstNeedsChanges.reviewLoop.flagged).toBe(false);
    expect(firstNeedsChanges.reviewLoop.lastNeedsChangesFingerprint).toBeTruthy();

    const repeatedNeedsChanges = applyOutcomeToTaskLedger(firstNeedsChanges, {
      role: 'reviewer',
      assessment: 'needs_changes',
      issues: [{ severity: 'important', message: 'Missing test coverage', file: 'src/a.ts' }],
      requiredFixes: ['Add tests for edge path'],
    });
    expect(repeatedNeedsChanges.reviewLoop.consecutiveSameNeedsChanges).toBe(2);
    expect(repeatedNeedsChanges.reviewLoop.flagged).toBe(true);
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

  describe('buildFailureEvidence', () => {
    function makeTaskLedger(overrides: Partial<TaskLedger> = {}): TaskLedger {
      return {
        runId: 'run-1',
        taskId: '1',
        planVersion: 1,
        reviewerIssues: [],
        blockers: [],
        requiredFixes: [],
        stalled: { consecutiveNonProgress: 0, threshold: 3, flagged: false },
        reviewLoop: { consecutiveSameNeedsChanges: 0, threshold: 3, flagged: false },
        ...overrides,
      };
    }

    it('returns null when assessment is approved', () => {
      expect(buildFailureEvidence(makeTaskLedger({ reviewerAssessment: 'approved' }))).toBeNull();
    });

    it('returns null when assessment is absent', () => {
      expect(buildFailureEvidence(makeTaskLedger())).toBeNull();
    });

    it('includes summary when present', () => {
      const result = buildFailureEvidence(makeTaskLedger({
        reviewerAssessment: 'needs_changes',
        summary: 'Tried approach A',
      }));
      expect(result).toContain('Previous attempt summary:');
      expect(result).toContain('Tried approach A');
    });

    it('formats issues with severity and file', () => {
      const result = buildFailureEvidence(makeTaskLedger({
        reviewerAssessment: 'needs_changes',
        reviewerIssues: [
          { severity: 'critical', message: 'Missing validation', file: 'src/api.ts' },
          { severity: 'minor', message: 'Style issue' },
        ],
      }));
      expect(result).toContain('[critical] src/api.ts: Missing validation');
      expect(result).toContain('[minor] Style issue');
    });

    it('includes required fixes', () => {
      const result = buildFailureEvidence(makeTaskLedger({
        reviewerAssessment: 'blocked',
        requiredFixes: ['Add tests', 'Fix linting'],
      }));
      expect(result).toContain('Required fixes:');
      expect(result).toContain('Add tests');
      expect(result).toContain('Fix linting');
    });

    it('includes blockers as constraints', () => {
      const result = buildFailureEvidence(makeTaskLedger({
        reviewerAssessment: 'blocked',
        blockers: ['API unavailable'],
      }));
      expect(result).toContain('Constraints/blockers:');
      expect(result).toContain('API unavailable');
    });

    it('handles empty issues/fixes/blockers gracefully', () => {
      const result = buildFailureEvidence(makeTaskLedger({
        reviewerAssessment: 'needs_changes',
        summary: 'Attempted fix',
      }));
      expect(result).toContain('Previous attempt summary:');
      expect(result).not.toContain('Rejection reasons:');
      expect(result).not.toContain('Required fixes:');
      expect(result).not.toContain('Constraints/blockers:');
    });
  });

  describe('buildLedgerDeltaPacket', () => {
    function makeTaskLedger(overrides: Partial<TaskLedger> = {}): TaskLedger {
      return {
        runId: 'run-1',
        taskId: '1',
        planVersion: 1,
        summary: 'test summary',
        reviewerIssues: [],
        blockers: [],
        requiredFixes: [],
        stalled: { consecutiveNonProgress: 0, threshold: 3, flagged: false },
        reviewLoop: { consecutiveSameNeedsChanges: 0, threshold: 3, flagged: false },
        ...overrides,
      };
    }

    const baseArgs = {
      taskId: '1',
      guideMode: 'full' as const,
      guideCacheKey: 'impl:run-1',
      progressLedger: {
        specName: 'test',
        taskId: '1',
        sourcePath: '/tmp/tasks.md',
        sourceFingerprint: { mtimeMs: 1, hash: 'abc' },
        totals: { total: 1, completed: 0, inProgress: 1, pending: 0 },
        activeTaskId: '1',
      },
    };

    it('includes full reviewer issues array instead of count', () => {
      const issues = [
        { severity: 'critical' as const, message: 'Missing validation', file: 'src/api.ts' },
        { severity: 'minor' as const, message: 'Style issue' },
      ];
      const packet = buildLedgerDeltaPacket({
        ...baseArgs,
        taskLedger: makeTaskLedger({ reviewerIssues: issues }),
      });
      expect(packet.ledger_reviewer_issues).toEqual(issues);
      expect(packet).not.toHaveProperty('ledger_reviewer_issue_count');
    });

    it('includes failure evidence when reviewer rejected', () => {
      const packet = buildLedgerDeltaPacket({
        ...baseArgs,
        taskLedger: makeTaskLedger({
          reviewerAssessment: 'needs_changes',
          summary: 'Tried approach A',
          reviewerIssues: [{ severity: 'important', message: 'Wrong approach' }],
        }),
      });
      expect(packet.ledger_failure_evidence).toContain('Previous attempt summary:');
      expect(packet.ledger_failure_evidence).toContain('Wrong approach');
    });

    it('failure evidence is null on first attempt', () => {
      const packet = buildLedgerDeltaPacket({
        ...baseArgs,
        taskLedger: makeTaskLedger(),
      });
      expect(packet.ledger_failure_evidence).toBeNull();
    });
  });

  describe('buildLedgerTaskPrompt retry framing', () => {
    function makeTaskLedger(overrides: Partial<TaskLedger> = {}): TaskLedger {
      return {
        runId: 'run-1',
        taskId: '1',
        planVersion: 1,
        reviewerIssues: [],
        blockers: [],
        requiredFixes: [],
        stalled: { consecutiveNonProgress: 0, threshold: 3, flagged: false },
        reviewLoop: { consecutiveSameNeedsChanges: 0, threshold: 3, flagged: false },
        ...overrides,
      };
    }

    const progressLedger = {
      specName: 'test',
      taskId: '1',
      sourcePath: '/tmp/tasks.md',
      sourceFingerprint: { mtimeMs: 1, hash: 'abc' },
      totals: { total: 1, completed: 0, inProgress: 1, pending: 0 },
      activeTaskId: '1',
      currentTask: {
        id: '1',
        description: 'Test task',
        status: 'in-progress' as const,
        prompt: 'Do the thing',
      },
    };

    it('no retry framing when taskLedger not provided (backward compat)', () => {
      const result = buildLedgerTaskPrompt(progressLedger);
      expect(result.prompt).not.toContain('Retry guidance');
    });

    it('no retry framing when planVersion is 1', () => {
      const result = buildLedgerTaskPrompt(progressLedger, makeTaskLedger({ planVersion: 1 }));
      expect(result.prompt).not.toContain('Retry guidance');
    });

    it('includes focus-on-feedback framing at planVersion 2', () => {
      const result = buildLedgerTaskPrompt(progressLedger, makeTaskLedger({ planVersion: 2 }));
      expect(result.prompt).toContain('Retry guidance');
      expect(result.prompt).toContain('second attempt');
      expect(result.prompt).toContain('reviewer feedback');
    });

    it('includes different-approach framing at planVersion 3+', () => {
      const result = buildLedgerTaskPrompt(progressLedger, makeTaskLedger({ planVersion: 3 }));
      expect(result.prompt).toContain('Retry guidance');
      expect(result.prompt).toContain('fundamentally different approach');

      const result4 = buildLedgerTaskPrompt(progressLedger, makeTaskLedger({ planVersion: 4 }));
      expect(result4.prompt).toContain('attempt #4');
    });
  });

  describe('buildResumptionPrompt', () => {
    function makeTaskLedger(overrides: Partial<TaskLedger> = {}): TaskLedger {
      return {
        runId: 'spec:2',
        taskId: '2',
        planVersion: 1,
        reviewerIssues: [],
        blockers: [],
        requiredFixes: [],
        stalled: { consecutiveNonProgress: 0, threshold: 3, flagged: false },
        reviewLoop: { consecutiveSameNeedsChanges: 0, threshold: 3, flagged: false },
        ...overrides,
      };
    }

    const snapshotProgressLedger = {
      specName: 'session-resumption-protocol',
      taskId: '2',
      sourcePath: '/tmp/tasks.md',
      sourceFingerprint: { mtimeMs: 1, hash: 'snapshot-hash' },
      totals: { total: 4, completed: 1, inProgress: 1, pending: 2 },
      activeTaskId: '2',
      currentTask: {
        id: '2',
        description: 'Add buildResumptionPrompt function with tests',
        status: 'in-progress' as const,
      },
    };

    it('includes task progress, last outcome, and approved next action for fresh ledgers', () => {
      const prompt = buildResumptionPrompt({
        taskLedger: makeTaskLedger({
          reviewerAssessment: 'approved',
          summary: 'Implementation accepted by reviewer',
        }),
        snapshotProgressLedger,
        freshProgressLedger: {
          ...snapshotProgressLedger,
          sourceFingerprint: { ...snapshotProgressLedger.sourceFingerprint },
        },
        snapshotStatus: 'done',
      });

      expect(prompt).toContain('Task progress:');
      expect(prompt).toContain('1 of 4 completed');
      expect(prompt).toContain('Current task: 2 - Add buildResumptionPrompt function with tests');
      expect(prompt).toContain('Last outcome:');
      expect(prompt).toContain('Assessment: approved');
      expect(prompt).toContain('Summary: Implementation accepted by reviewer');
      expect(prompt).toContain('Suggested next action:');
      expect(prompt).toContain('dispatch implementer for next task');
      expect(prompt).not.toContain('Reviewer feedback:');
      expect(prompt).not.toContain('Staleness warning:');
    });

    it('includes reviewer feedback and remediation guidance for needs_changes', () => {
      const prompt = buildResumptionPrompt({
        taskLedger: makeTaskLedger({
          reviewerAssessment: 'needs_changes',
          reviewerIssues: [
            { severity: 'critical', file: 'src/tools/workflow/dispatch-runtime.ts', message: 'Missing parser branch' },
            { severity: 'minor', message: 'Tighten assertion text' },
          ],
          requiredFixes: ['Add parser coverage', 'Update assertion text'],
        }),
        snapshotProgressLedger,
        freshProgressLedger: {
          ...snapshotProgressLedger,
          sourceFingerprint: { ...snapshotProgressLedger.sourceFingerprint },
        },
        snapshotStatus: 'running',
      });

      expect(prompt).toContain('Reviewer feedback:');
      expect(prompt).toContain('[critical] src/tools/workflow/dispatch-runtime.ts: Missing parser branch');
      expect(prompt).toContain('[minor] Tighten assertion text');
      expect(prompt).toContain('Required fixes:');
      expect(prompt).toContain('Add parser coverage');
      expect(prompt).toContain('Update assertion text');
      expect(prompt).toContain('dispatch implementer to address feedback');
    });

    it('includes blocked action guidance and blocker details', () => {
      const prompt = buildResumptionPrompt({
        taskLedger: makeTaskLedger({
          reviewerAssessment: 'blocked',
          summary: 'Blocked by unavailable integration test fixture',
          blockers: ['Integration fixture unavailable'],
          reviewerIssues: [{ severity: 'important', message: 'Cannot validate resume_run flow' }],
          requiredFixes: ['Provide deterministic fixture'],
        }),
        snapshotProgressLedger,
        freshProgressLedger: {
          ...snapshotProgressLedger,
          sourceFingerprint: { ...snapshotProgressLedger.sourceFingerprint },
        },
        snapshotStatus: 'blocked',
      });

      expect(prompt).toContain('Reviewer feedback:');
      expect(prompt).toContain('[important] Cannot validate resume_run flow');
      expect(prompt).toContain('Suggested next action:');
      expect(prompt).toContain('blocked - resolve blockers');
      expect(prompt).toContain('Integration fixture unavailable');
      expect(prompt).toContain('Snapshot status: blocked');
    });

    it('includes staleness warning when tasks fingerprint hash changed', () => {
      const prompt = buildResumptionPrompt({
        taskLedger: makeTaskLedger({ reviewerAssessment: 'approved' }),
        snapshotProgressLedger,
        freshProgressLedger: {
          ...snapshotProgressLedger,
          sourceFingerprint: { mtimeMs: 2, hash: 'fresh-hash' },
        },
        snapshotStatus: 'running',
      });

      expect(prompt).toContain('Staleness warning:');
      expect(prompt).toContain('tasks.md has changed since last session');
    });

    it('omits empty sections for partial state', () => {
      const prompt = buildResumptionPrompt({
        taskLedger: makeTaskLedger(),
        snapshotProgressLedger: {
          ...snapshotProgressLedger,
          currentTask: undefined,
        },
        freshProgressLedger: {
          ...snapshotProgressLedger,
          currentTask: undefined,
          sourceFingerprint: { ...snapshotProgressLedger.sourceFingerprint },
        },
        snapshotStatus: 'running',
      });

      expect(prompt).toBe('');
    });
  });
});
